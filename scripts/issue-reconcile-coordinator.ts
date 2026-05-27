#!/usr/bin/env bun

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  appendJournal,
  ensureRunDirs,
  moveChunk,
  notify,
  pauseRun,
  readJson,
  readRun,
  removeIfExists,
  rewriteStatus,
  runCommand,
  runPath,
  sanitizeId,
  setStatus,
  writeRun,
} from "./lib";
import { renderIssueReconcilePrompt } from "./render-issue-reconcile-prompt";
import { validateIssueReconcileResult } from "./validate-issue-reconcile-result";

type IssueReconcileManifest = {
  chunkId: string;
  seedKey?: string;
  issueKey?: string;
  contextPath?: string;
  candidate?: {
    key?: string;
    created_at?: string;
    updated_at?: string;
    partition_id?: string;
    work_groups?: string[];
    related_pages?: string[];
    related_artifacts?: string[];
  };
};

type SeedScheduleMeta = {
  seedKey: string;
  partitionId: string;
  workGroup: string;
  createdAt: string;
  updatedAt: string;
};

type PendingEntry = SeedScheduleMeta & {
  file: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/issue-reconcile-coordinator.ts --run-id ID

Runs issue-reconcile workers. Normally start through start.ts.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const model = process.env.MODEL ?? "gpt-5.5";
const reasoningEffort = process.env.REASONING_EFFORT ?? "xhigh";
const jobTimeout = process.env.JOB_TIMEOUT;
const maxAutopilotContinues = process.env.MAX_AUTOPILOT_CONTINUES;
const coordinatorPollMs = Math.max(1000, Number(process.env.COORDINATOR_POLL_MS ?? "5000"));
const root = runPath(runId);

ensureRunDirs(runId);
let run = readRun(runId);
if (run.workflow !== "issue-reconcile") throw new Error(`run ${runId} is workflow=${run.workflow ?? "(unset)"}; expected issue-reconcile`);
if (!run.fhirRepo || !run.baseSha) throw new Error("run is missing fhirRepo/baseSha; prepare the run first");

const envConcurrency = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined;
function desiredConcurrency(): number {
  if (envConcurrency !== undefined) return envConcurrency;
  return Number(readRun(runId).concurrency ?? "12");
}

run.status = "running";
writeRun(run);
appendJournal(runId, { type: "issue-reconcile-coordinator-started", concurrency: desiredConcurrency() });
notify("AutoFHIR issue reconcile started", `${runId} concurrency=${desiredConcurrency()}`);

function defaultScheduleMeta(seedKey: string): SeedScheduleMeta {
  return {
    seedKey,
    partitionId: "unknown::general",
    workGroup: "unknown",
    createdAt: "",
    updatedAt: "",
  };
}

function scheduleMetaFromManifest(manifest: IssueReconcileManifest, fallbackSeedKey: string): SeedScheduleMeta {
  const seedKey = manifest.seedKey ?? manifest.issueKey ?? manifest.chunkId ?? fallbackSeedKey;
  const workGroup = manifest.candidate?.work_groups?.find(Boolean) ?? "unknown";
  const artifact =
    manifest.candidate?.partition_id ??
    `${workGroup}::${manifest.candidate?.related_pages?.find(Boolean) ?? manifest.candidate?.related_artifacts?.find(Boolean) ?? "general"}`;
  return {
    seedKey,
    partitionId: artifact || "unknown::general",
    workGroup,
    createdAt: manifest.candidate?.created_at ?? "",
    updatedAt: manifest.candidate?.updated_at ?? "",
  };
}

function readSeedMetaFromCandidatePool(): Map<string, SeedScheduleMeta> {
  const file = path.join(root, "candidate-pool/issues.json");
  if (!existsSync(file)) return new Map();
  try {
    const parsed = readJson<any>(file);
    const rows = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    return new Map(rows
      .filter((row: any) => typeof row?.key === "string")
      .map((row: any) => [row.key, {
        seedKey: row.key,
        partitionId: typeof row.partition_id === "string" && row.partition_id ? row.partition_id : `${row.work_groups?.[0] ?? "unknown"}::general`,
        workGroup: Array.isArray(row.work_groups) && row.work_groups[0] ? row.work_groups[0] : "unknown",
        createdAt: typeof row.created_at === "string" ? row.created_at : "",
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
      } as SeedScheduleMeta]));
  } catch {
    return new Map();
  }
}

const seedScheduleMeta = readSeedMetaFromCandidatePool();

function scheduleMetaForPendingFile(file: string): SeedScheduleMeta {
  const seedKey = path.basename(file, ".json");
  const fromPool = seedScheduleMeta.get(seedKey);
  if (fromPool) return fromPool;
  try {
    return scheduleMetaFromManifest(readJson<IssueReconcileManifest>(file), seedKey);
  } catch {
    return defaultScheduleMeta(seedKey);
  }
}

function compareNewestCreated(a: SeedScheduleMeta, b: SeedScheduleMeta): number {
  return b.createdAt.localeCompare(a.createdAt) ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    Number(b.seedKey.replace("FHIR-", "")) - Number(a.seedKey.replace("FHIR-", "")) ||
    a.seedKey.localeCompare(b.seedKey);
}

function pendingEntries(activeMeta: Iterable<SeedScheduleMeta>): PendingEntry[] {
  const dir = path.join(root, "chunks/pending");
  const partitionCounts = new Map<string, number>();
  const workGroupCounts = new Map<string, number>();
  for (const meta of activeMeta) {
    partitionCounts.set(meta.partitionId, (partitionCounts.get(meta.partitionId) ?? 0) + 1);
    workGroupCounts.set(meta.workGroup, (workGroupCounts.get(meta.workGroup) ?? 0) + 1);
  }

  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const fullPath = path.join(dir, file);
      return { ...scheduleMetaForPendingFile(fullPath), file: fullPath };
    })
    .sort((a, b) => {
      const aPartitionActive = partitionCounts.get(a.partitionId) ?? 0;
      const bPartitionActive = partitionCounts.get(b.partitionId) ?? 0;
      if (aPartitionActive !== bPartitionActive) return aPartitionActive - bPartitionActive;

      const aWorkGroupActive = workGroupCounts.get(a.workGroup) ?? 0;
      const bWorkGroupActive = workGroupCounts.get(b.workGroup) ?? 0;
      if (aWorkGroupActive !== bWorkGroupActive) return aWorkGroupActive - bWorkGroupActive;

      return compareNewestCreated(a, b);
    });
}

function nextPending(activeMeta: Iterable<SeedScheduleMeta>): PendingEntry | undefined {
  return pendingEntries(activeMeta)[0];
}

function stateCount(state: string): number {
  const dir = path.join(root, "chunks", state);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((file) => file.endsWith(".json")).length;
}

function branchName(seedKey: string): string {
  return `autofhir/${sanitizeId(runId)}/reconcile-${sanitizeId(seedKey)}`;
}

function retryBranchName(seedKey: string, retryAttempt: number): string {
  return `autofhir/${sanitizeId(runId)}/reconcile-${sanitizeId(seedKey)}-retry-${retryAttempt}`;
}

function resultPath(seedKey: string): string {
  return path.join(root, "results", `${seedKey}.json`);
}

function validationPathForResult(result: string): string {
  const parsed = path.parse(result);
  return path.join(parsed.dir, `${parsed.name}.validation.json`);
}

function retryInfoPath(seedKey: string): string {
  return path.join(root, "retries", `${seedKey}.json`);
}

function readRetryAttempt(seedKey: string): number {
  const file = retryInfoPath(seedKey);
  if (!existsSync(file)) return 0;
  try {
    return Number(readJson<any>(file).retryAttempt ?? 0);
  } catch {
    return 0;
  }
}

function issueReconcileInCombined(issueKey: string): string | undefined {
  const output = runCommand([
    "git",
    "log",
    "--fixed-strings",
    `--grep=Issue-Reconcile-Key: ${issueKey}`,
    "--format=%H %s",
    "-n",
    "1",
    run.combinedBranch,
  ], { cwd: run.fhirRepo!, allowFailure: true }).trim();
  return output || undefined;
}

function cleanupSuccessfulSeed(seedKey: string, worktree: string, branch: string): void {
  if (process.env.AUTOFHIR_KEEP_WORKTREES === "1") return;
  runCommand(["git", "worktree", "remove", "-f", worktree], { cwd: run.fhirRepo!, allowFailure: true });
  removeIfExists(worktree);
  runCommand(["git", "branch", "-D", branch], { cwd: run.fhirRepo!, allowFailure: true });
  const integrationPrefix = `autofhir/${sanitizeId(runId)}/integrate-${sanitizeId(seedKey)}-`;
  const branches = runCommand(["git", "for-each-ref", "--format=%(refname:short)", `refs/heads/${integrationPrefix}`], {
    cwd: run.fhirRepo!,
    allowFailure: true,
  }).trim().split("\n").filter(Boolean);
  for (const integrationBranch of branches) {
    runCommand(["git", "branch", "-D", integrationBranch], { cwd: run.fhirRepo!, allowFailure: true });
  }
  const integrationRoot = path.join(root, "worktrees/integration");
  const worktreeList = runCommand(["git", "worktree", "list", "--porcelain"], { cwd: run.fhirRepo!, allowFailure: true });
  for (const block of worktreeList.split("\n\n").filter(Boolean)) {
    const line = block.split("\n").find((item) => item.startsWith("worktree "));
    const wt = line?.slice("worktree ".length);
    if (wt?.startsWith(path.join(integrationRoot, seedKey))) {
      runCommand(["git", "worktree", "remove", "-f", wt], { cwd: run.fhirRepo!, allowFailure: true });
      removeIfExists(wt);
    }
  }
}

async function runCopilot(promptPath: string, cwd: string, stdoutFile: string, stderrFile: string, logDir: string): Promise<number> {
  mkdirSync(logDir, { recursive: true });
  const cmd = [
    "copilot",
    "--model", model,
    "--reasoning-effort", reasoningEffort,
    "--enable-reasoning-summaries",
    "--output-format", "json",
    "--stream", "on",
    "--log-dir", logDir,
    "--log-level", "all",
    "--yolo",
    "--no-ask-user",
    "--silent",
  ];
  if (maxAutopilotContinues) cmd.push("--max-autopilot-continues", maxAutopilotContinues);
  const finalCmd = jobTimeout && !["0", "none", "unlimited"].includes(jobTimeout)
    ? ["timeout", jobTimeout, ...cmd]
    : cmd;
  const stdout = createWriteStream(stdoutFile, { flags: "a" });
  const stderr = createWriteStream(stderrFile, { flags: "a" });
  const proc = spawn(finalCmd[0], finalCmd.slice(1), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin?.end(readFileSync(promptPath, "utf8"));
  proc.stdout?.pipe(stdout);
  proc.stderr?.pipe(stderr);
  return await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => {
      stdout.end();
      stderr.end();
      resolve(code ?? 1);
    });
  });
}

async function runOne(pendingPath: string): Promise<void> {
  const chunkId = path.basename(pendingPath, ".json");
  const runningPath = moveChunk(runId, chunkId, "pending", "running");
  const chunk = readJson<IssueReconcileManifest>(runningPath);
  const seedKey = chunk.seedKey ?? chunk.issueKey ?? chunk.chunkId ?? chunkId;
  const retryAttempt = readRetryAttempt(seedKey);
  const retrySuffix = retryAttempt > 0 ? `-retry-${retryAttempt}` : "";
  const branch = retryAttempt > 0 ? retryBranchName(seedKey, retryAttempt) : branchName(seedKey);
  const worktree = path.join(root, "worktrees/tasks", `${seedKey}${retrySuffix}`);
  const result = resultPath(seedKey);
  const stdoutFile = path.join(root, "stdout", `${seedKey}.jsonl`);
  const stderrFile = path.join(root, "stderr", `${seedKey}.log`);
  const logDir = path.join(root, "copilot-logs", seedKey);

  rewriteStatus(runId, seedKey, {
    chunk: seedKey,
    seed_key: seedKey,
    status: "running",
    started_at: new Date().toISOString(),
    retry_attempt: retryAttempt || undefined,
    branch,
    worktree,
    chunk_json: runningPath,
    result,
  });

  try {
    const existing = issueReconcileInCombined(seedKey);
    if (existing) {
      removeIfExists(validationPathForResult(result));
      setStatus(runId, seedKey, { status: "skipped", finished_at: new Date().toISOString(), existing_commit: existing });
      appendJournal(runId, { type: "issue-reconcile-skipped", seedKey, status: "skipped", summary: `Issue-Reconcile-Key already present: ${existing}` });
      moveChunk(runId, seedKey, "running", "skipped");
      return;
    }

    runCommand(["git", "worktree", "remove", "-f", worktree], { cwd: run.fhirRepo!, allowFailure: true });
    removeIfExists(worktree);
    runCommand(["git", "branch", "-D", branch], { cwd: run.fhirRepo!, allowFailure: true });
    runCommand(["git", "worktree", "add", "-b", branch, worktree, run.combinedBranch], { cwd: run.fhirRepo! });

    const oldPrompt = path.join(root, "prompts", `${seedKey}.md`);
    if (existsSync(oldPrompt)) renameSync(oldPrompt, path.join(root, "prompts", `${seedKey}.stale-${Date.now()}.md`));
    const promptPath = renderIssueReconcilePrompt({
      runId,
      chunkId: seedKey,
      chunkPath: runningPath,
      worktree,
      branch,
      resultPath: result,
      force: true,
    });
    setStatus(runId, seedKey, { prompt: promptPath, stdout: stdoutFile, stderr: stderrFile, copilot_log_dir: logDir });
    appendJournal(runId, { type: "issue-reconcile-launched", seedKey, prompt: promptPath });

    const rc = await runCopilot(promptPath, worktree, stdoutFile, stderrFile, logDir);
    setStatus(runId, seedKey, { exit_code: rc, finished_at: new Date().toISOString() });

    const validation = validateIssueReconcileResult({ runId, seedKey, chunkId: seedKey, resultPath: result, writeResult: true });
    if (!validation.ok) {
      setStatus(runId, seedKey, { status: rc === 124 ? "timeout" : "failed", validation_errors: validation.errors.join("; ") });
      appendJournal(runId, {
        type: "issue-reconcile-failed",
        seedKey,
        status: "failed",
        summary: `exit=${rc}; validation=${validation.errors.join("; ")}`,
      });
      moveChunk(runId, seedKey, "running", "failed");
      notify("AutoFHIR issue reconcile failed", `${runId}/${seedKey}`);
      return;
    }

    const parsed = readJson<any>(result);
    for (const entry of parsed.journal_entries ?? []) {
      appendJournal(runId, { type: "issue-reconcile-decision", seedKey, ...entry });
    }
    for (const issueResult of parsed.issue_results ?? []) {
      appendJournal(runId, {
        type: "issue-reconcile-issue",
        seedKey,
        issueKey: issueResult.issue_key,
        role: issueResult.role,
        status: issueResult.status,
        summary: issueResult.summary,
        commit: validation.commitShas?.[issueResult.issue_key],
      });
    }

    if (parsed.status === "blocked") {
      setStatus(runId, seedKey, { status: "blocked" });
      appendJournal(runId, { type: "issue-reconcile-blocked", seedKey, status: "blocked", summary: parsed.issue_results?.[0]?.summary ?? parsed.status });
      moveChunk(runId, seedKey, "running", "blocked");
      notify("AutoFHIR issue reconcile blocked", `${runId}/${seedKey}`);
      return;
    }

    setStatus(runId, seedKey, {
      status: "complete",
      issue_count: validation.issueCount,
      commits: Object.values(validation.commitShas ?? {}).join(","),
    });
    appendJournal(runId, {
      type: "issue-reconcile-integrated",
      seedKey,
      status: parsed.status,
      issueCount: validation.issueCount,
      commits: validation.commitShas,
    });
    moveChunk(runId, seedKey, "running", "done");
    cleanupSuccessfulSeed(seedKey, worktree, branch);
  } catch (error: any) {
    setStatus(runId, seedKey, { status: "failed", error: String(error?.message ?? error), finished_at: new Date().toISOString() });
    appendJournal(runId, { type: "issue-reconcile-failed", seedKey, status: "failed", summary: String(error?.message ?? error) });
    const runningFile = path.join(root, "chunks/running", `${seedKey}.json`);
    if (existsSync(runningFile)) moveChunk(runId, seedKey, "running", "failed");
    notify("AutoFHIR issue reconcile failed", `${runId}/${seedKey}`);
  }
}

if (runCommand(["bash", "-lc", "command -v copilot"], { allowFailure: true }).trim() === "") {
  pauseRun(runId, "copilot CLI not found in PATH");
  process.exit(1);
}

const active = new Set<Promise<void>>();
const activeMeta = new Map<Promise<void>, SeedScheduleMeta>();
let launched = 0;
while (!existsSync(path.join(root, "PAUSED"))) {
  run = readRun(runId);
  if (run.status !== "running") {
    run.status = "running";
    writeRun(run);
  }
  const concurrency = desiredConcurrency();
  while (active.size < concurrency) {
    const next = nextPending(activeMeta.values());
    if (!next) break;
    const promise = runOne(next.file).finally(() => {
      active.delete(promise);
      activeMeta.delete(promise);
    });
    active.add(promise);
    activeMeta.set(promise, next);
    launched += 1;
    console.log(`${new Date().toISOString()} launched ${next.seedKey} partition=${next.partitionId} wg=${next.workGroup} active=${active.size} concurrency=${concurrency} launched=${launched}`);
  }
  if (active.size === 0) {
    if (pendingEntries([]).length === 0) break;
    await Bun.sleep(coordinatorPollMs);
    continue;
  }
  await Promise.race([...active, Bun.sleep(coordinatorPollMs)]);
}
if (active.size > 0) await Promise.allSettled(active);

run = readRun(runId);
if (run.status !== "paused") {
  run.status = pendingEntries([]).length === 0 ? "complete" : run.status;
  writeRun(run);
}
appendJournal(runId, {
  type: "issue-reconcile-coordinator-finished",
  launched,
  pending: stateCount("pending"),
  done: stateCount("done"),
  skipped: stateCount("skipped"),
  failed: stateCount("failed"),
  blocked: stateCount("blocked"),
});
notify("AutoFHIR issue reconcile finished", `${runId} launched=${launched} failed=${stateCount("failed")}`);
