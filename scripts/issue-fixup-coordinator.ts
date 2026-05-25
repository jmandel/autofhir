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
  repoRoot,
  rewriteStatus,
  runCommand,
  runPath,
  sanitizeId,
  setStatus,
  writeRun,
} from "./lib";
import { renderIssueFixupPrompt } from "./render-issue-fixup-prompt";
import { validateIssueFixupResult } from "./validate-issue-fixup-result";

type IssueFixupManifest = {
  chunkId: string;
  issueKey: string;
  contextPath?: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/issue-fixup-coordinator.ts --run-id ID

Runs issue-fixup workers. Normally start through start.ts.`);
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
if (run.workflow !== "issue-fixup") throw new Error(`run ${runId} is workflow=${run.workflow ?? "(unset)"}; expected issue-fixup`);
if (!run.fhirRepo || !run.baseSha) throw new Error("run is missing fhirRepo/baseSha; prepare the run first");

const envConcurrency = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined;
function desiredConcurrency(): number {
  if (envConcurrency !== undefined) return envConcurrency;
  return Number(readRun(runId).concurrency ?? "12");
}

run.status = "running";
writeRun(run);
appendJournal(runId, { type: "issue-fixup-coordinator-started", concurrency: desiredConcurrency() });
notify("AutofHIR issue fixup started", `${runId} concurrency=${desiredConcurrency()}`);

function pendingFiles(): string[] {
  const dir = path.join(root, "chunks/pending");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort((a, b) => {
      const aKey = a.replace(/\.json$/, "");
      const bKey = b.replace(/\.json$/, "");
      return Number(bKey.replace("FHIR-", "")) - Number(aKey.replace("FHIR-", "")) || aKey.localeCompare(bKey);
    })
    .map((file) => path.join(dir, file));
}

function stateCount(state: string): number {
  const dir = path.join(root, "chunks", state);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((file) => file.endsWith(".json")).length;
}

function branchName(issueKey: string): string {
  return `autofhir/${sanitizeId(runId)}/fixup-${sanitizeId(issueKey)}`;
}

function retryBranchName(issueKey: string, retryAttempt: number): string {
  return `autofhir/${sanitizeId(runId)}/fixup-${sanitizeId(issueKey)}-retry-${retryAttempt}`;
}

function resultPath(issueKey: string): string {
  return path.join(root, "results", `${issueKey}.json`);
}

function validationPathForResult(result: string): string {
  const parsed = path.parse(result);
  return path.join(parsed.dir, `${parsed.name}.validation.json`);
}

function retryInfoPath(issueKey: string): string {
  return path.join(root, "retries", `${issueKey}.json`);
}

function readRetryAttempt(issueKey: string): number {
  const file = retryInfoPath(issueKey);
  if (!existsSync(file)) return 0;
  try {
    return Number(readJson<any>(file).retryAttempt ?? 0);
  } catch {
    return 0;
  }
}

function issueFixupInCombined(issueKey: string): string | undefined {
  const output = runCommand([
    "git",
    "log",
    "--fixed-strings",
    `--grep=Issue-Fixup-Key: ${issueKey}`,
    "--format=%H %s",
    "-n",
    "1",
    run.combinedBranch,
  ], { cwd: run.fhirRepo!, allowFailure: true }).trim();
  return output || undefined;
}

function cleanupSuccessfulIssue(issueKey: string, worktree: string, branch: string): void {
  if (process.env.AUTOFHIR_KEEP_WORKTREES === "1") return;
  runCommand(["git", "worktree", "remove", "-f", worktree], { cwd: run.fhirRepo!, allowFailure: true });
  removeIfExists(worktree);
  runCommand(["git", "branch", "-D", branch], { cwd: run.fhirRepo!, allowFailure: true });
  const integrationPrefix = `autofhir/${sanitizeId(runId)}/integrate-${sanitizeId(issueKey)}-`;
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
    if (wt?.startsWith(path.join(integrationRoot, issueKey))) {
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
  const chunk = readJson<IssueFixupManifest>(runningPath);
  const issueKey = chunk.issueKey ?? chunk.chunkId ?? chunkId;
  const retryAttempt = readRetryAttempt(issueKey);
  const retrySuffix = retryAttempt > 0 ? `-retry-${retryAttempt}` : "";
  const branch = retryAttempt > 0 ? retryBranchName(issueKey, retryAttempt) : branchName(issueKey);
  const worktree = path.join(root, "worktrees/tasks", `${issueKey}${retrySuffix}`);
  const result = resultPath(issueKey);
  const stdoutFile = path.join(root, "stdout", `${issueKey}.jsonl`);
  const stderrFile = path.join(root, "stderr", `${issueKey}.log`);
  const logDir = path.join(root, "copilot-logs", issueKey);

  rewriteStatus(runId, issueKey, {
    chunk: issueKey,
    issue_key: issueKey,
    status: "running",
    started_at: new Date().toISOString(),
    retry_attempt: retryAttempt || undefined,
    branch,
    worktree,
    chunk_json: runningPath,
    result,
  });

  try {
    const existing = issueFixupInCombined(issueKey);
    if (existing) {
      removeIfExists(validationPathForResult(result));
      setStatus(runId, issueKey, { status: "skipped", finished_at: new Date().toISOString(), existing_commit: existing });
      appendJournal(runId, { type: "issue-fixup-skipped", issueKey, status: "skipped", summary: `Issue-Fixup-Key already present: ${existing}` });
      moveChunk(runId, issueKey, "running", "skipped");
      return;
    }

    runCommand(["git", "worktree", "remove", "-f", worktree], { cwd: run.fhirRepo!, allowFailure: true });
    removeIfExists(worktree);
    runCommand(["git", "branch", "-D", branch], { cwd: run.fhirRepo!, allowFailure: true });
    runCommand(["git", "worktree", "add", "-b", branch, worktree, run.combinedBranch], { cwd: run.fhirRepo! });

    const oldPrompt = path.join(root, "prompts", `${issueKey}.md`);
    if (existsSync(oldPrompt)) renameSync(oldPrompt, path.join(root, "prompts", `${issueKey}.stale-${Date.now()}.md`));
    const promptPath = renderIssueFixupPrompt({
      runId,
      chunkId: issueKey,
      chunkPath: runningPath,
      worktree,
      branch,
      resultPath: result,
      force: true,
    });
    setStatus(runId, issueKey, { prompt: promptPath, stdout: stdoutFile, stderr: stderrFile, copilot_log_dir: logDir });
    appendJournal(runId, { type: "issue-fixup-launched", issueKey, prompt: promptPath });

    const rc = await runCopilot(promptPath, worktree, stdoutFile, stderrFile, logDir);
    setStatus(runId, issueKey, { exit_code: rc, finished_at: new Date().toISOString() });

    const validation = validateIssueFixupResult({ runId, issueKey, chunkId: issueKey, resultPath: result, writeResult: true });
    if (!validation.ok) {
      setStatus(runId, issueKey, { status: rc === 124 ? "timeout" : "failed", validation_errors: validation.errors.join("; ") });
      appendJournal(runId, {
        type: "issue-fixup-failed",
        issueKey,
        status: "failed",
        summary: `exit=${rc}; validation=${validation.errors.join("; ")}`,
      });
      moveChunk(runId, issueKey, "running", "failed");
      notify("AutofHIR issue fixup failed", `${runId}/${issueKey}`);
      return;
    }

    const parsed = readJson<any>(result);
    for (const entry of parsed.journal_entries ?? []) {
      appendJournal(runId, { type: "issue-fixup-decision", issueKey, ...entry });
    }

    if (parsed.status === "blocked") {
      setStatus(runId, issueKey, { status: "blocked" });
      appendJournal(runId, { type: "issue-fixup-blocked", issueKey, status: "blocked", summary: parsed.decision?.summary ?? parsed.status });
      moveChunk(runId, issueKey, "running", "blocked");
      notify("AutofHIR issue fixup blocked", `${runId}/${issueKey}`);
      return;
    }

    setStatus(runId, issueKey, { status: "complete", commit: validation.commitSha });
    appendJournal(runId, { type: "issue-fixup-integrated", issueKey, status: parsed.status, summary: parsed.decision?.summary ?? parsed.status, commit: validation.commitSha });
    moveChunk(runId, issueKey, "running", "done");
    cleanupSuccessfulIssue(issueKey, worktree, branch);
  } catch (error: any) {
    setStatus(runId, issueKey, { status: "failed", error: String(error?.message ?? error), finished_at: new Date().toISOString() });
    appendJournal(runId, { type: "issue-fixup-failed", issueKey, status: "failed", summary: String(error?.message ?? error) });
    const runningFile = path.join(root, "chunks/running", `${issueKey}.json`);
    if (existsSync(runningFile)) moveChunk(runId, issueKey, "running", "failed");
    notify("AutofHIR issue fixup failed", `${runId}/${issueKey}`);
  }
}

if (runCommand(["bash", "-lc", "command -v copilot"], { allowFailure: true }).trim() === "") {
  pauseRun(runId, "copilot CLI not found in PATH");
  process.exit(1);
}

const active = new Set<Promise<void>>();
let launched = 0;
while (!existsSync(path.join(root, "PAUSED"))) {
  run = readRun(runId);
  if (run.status !== "running") {
    run.status = "running";
    writeRun(run);
  }
  const concurrency = desiredConcurrency();
  while (active.size < concurrency) {
    const next = pendingFiles()[0];
    if (!next) break;
    const promise = runOne(next).finally(() => active.delete(promise));
    active.add(promise);
    launched += 1;
    console.log(`${new Date().toISOString()} launched ${path.basename(next, ".json")} active=${active.size} concurrency=${concurrency} launched=${launched}`);
  }
  if (active.size === 0) {
    if (pendingFiles().length === 0) break;
    await Bun.sleep(coordinatorPollMs);
    continue;
  }
  await Promise.race([...active, Bun.sleep(coordinatorPollMs)]);
}
if (active.size > 0) await Promise.allSettled(active);

run = readRun(runId);
if (run.status !== "paused") {
  run.status = pendingFiles().length === 0 ? "complete" : run.status;
  writeRun(run);
}
appendJournal(runId, {
  type: "issue-fixup-coordinator-finished",
  launched,
  pending: stateCount("pending"),
  done: stateCount("done"),
  skipped: stateCount("skipped"),
  failed: stateCount("failed"),
  blocked: stateCount("blocked"),
});
notify("AutofHIR issue fixup finished", `${runId} launched=${launched} failed=${stateCount("failed")}`);
