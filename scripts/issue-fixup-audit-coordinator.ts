#!/usr/bin/env bun

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
import { renderIssueFixupAuditPrompt } from "./render-issue-fixup-audit-prompt";
import { validateIssueFixupAuditResult } from "./validate-issue-fixup-audit-result";

type AuditChunk = {
  chunkId: string;
  issueKey: string;
  commit: {
    sha: string;
  };
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/issue-fixup-audit-coordinator.ts --run-id ID

Runs read-only issue-fixup audit workers. Normally start through start.ts.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const model = process.env.MODEL ?? "gpt-5.5";
const reasoningEffort = process.env.REASONING_EFFORT ?? "xhigh";
const jobTimeout = process.env.JOB_TIMEOUT ?? "30m";
const maxAutopilotContinues = process.env.MAX_AUTOPILOT_CONTINUES;
const coordinatorPollMs = Math.max(1000, Number(process.env.COORDINATOR_POLL_MS ?? "5000"));
const root = runPath(runId);

ensureRunDirs(runId);
let run = readRun(runId);
if (run.workflow !== "issue-fixup-audit") throw new Error(`run ${runId} is workflow=${run.workflow ?? "(unset)"}; expected issue-fixup-audit`);
if (!run.fhirRepo || !run.combinedBranch) throw new Error("run is missing fhirRepo/combinedBranch; prepare the run first");

const envConcurrency = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined;
function desiredConcurrency(): number {
  if (envConcurrency !== undefined) return envConcurrency;
  return Number(readRun(runId).concurrency ?? "12");
}

run.status = "running";
writeRun(run);
appendJournal(runId, { type: "issue-fixup-audit-coordinator-started", concurrency: desiredConcurrency() });
notify("AutoFHIR issue fixup audit started", `${runId} concurrency=${desiredConcurrency()}`);

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

function resultPath(issueKey: string): string {
  return path.join(root, "results", `${issueKey}.json`);
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

function cleanupWorktree(worktree: string): void {
  if (process.env.AUTOFHIR_KEEP_WORKTREES === "1") return;
  runCommand(["git", "worktree", "remove", "-f", worktree], { cwd: run.fhirRepo!, allowFailure: true });
  removeIfExists(worktree);
}

async function runOne(pendingPath: string): Promise<void> {
  const chunkId = path.basename(pendingPath, ".json");
  const runningPath = moveChunk(runId, chunkId, "pending", "running");
  const chunk = readJson<AuditChunk>(runningPath);
  const issueKey = chunk.issueKey ?? chunk.chunkId ?? chunkId;
  const commitSha = chunk.commit.sha;
  const worktree = path.join(root, "worktrees/inspect", `${issueKey}-${sanitizeId(commitSha.slice(0, 12))}`);
  const result = resultPath(issueKey);
  const stdoutFile = path.join(root, "stdout", `${issueKey}.jsonl`);
  const stderrFile = path.join(root, "stderr", `${issueKey}.log`);
  const logDir = path.join(root, "copilot-logs", issueKey);

  rewriteStatus(runId, issueKey, {
    chunk: issueKey,
    issue_key: issueKey,
    commit_sha: commitSha,
    status: "running",
    started_at: new Date().toISOString(),
    worktree,
    chunk_json: runningPath,
    result,
  });

  try {
    runCommand(["git", "worktree", "remove", "-f", worktree], { cwd: run.fhirRepo!, allowFailure: true });
    removeIfExists(worktree);
    runCommand(["git", "worktree", "add", "--detach", worktree, run.combinedBranch], { cwd: run.fhirRepo! });

    const promptPath = renderIssueFixupAuditPrompt({
      runId,
      chunkId: issueKey,
      chunkPath: runningPath,
      worktree,
      resultPath: result,
      force: true,
    });
    setStatus(runId, issueKey, { prompt: promptPath, stdout: stdoutFile, stderr: stderrFile, copilot_log_dir: logDir });
    appendJournal(runId, { type: "issue-fixup-audit-launched", issueKey, commitSha, prompt: promptPath });

    const rc = await runCopilot(promptPath, worktree, stdoutFile, stderrFile, logDir);
    setStatus(runId, issueKey, { exit_code: rc, finished_at: new Date().toISOString() });

    const validation = validateIssueFixupAuditResult({ runId, issueKey, commitSha, chunkPath: runningPath, resultPath: result, writeResult: true });
    if (!validation.ok) {
      setStatus(runId, issueKey, { status: rc === 124 ? "timeout" : "failed", validation_errors: validation.errors.join("; ") });
      appendJournal(runId, {
        type: "issue-fixup-audit-failed",
        issueKey,
        commitSha,
        status: "failed",
        summary: `exit=${rc}; validation=${validation.errors.join("; ")}`,
      });
      moveChunk(runId, issueKey, "running", "failed");
      notify("AutoFHIR issue fixup audit failed", `${runId}/${issueKey}`);
      cleanupWorktree(worktree);
      return;
    }

    const parsed = readJson<any>(result);
    setStatus(runId, issueKey, { status: "complete", decision: parsed.decision });
    appendJournal(runId, {
      type: "issue-fixup-audit-complete",
      issueKey,
      commitSha,
      decision: parsed.decision,
      summary: parsed.recommended_next_step ?? parsed.reasoning,
    });
    moveChunk(runId, issueKey, "running", "done");
    cleanupWorktree(worktree);
  } catch (error: any) {
    setStatus(runId, issueKey, { status: "failed", error: String(error?.message ?? error), finished_at: new Date().toISOString() });
    appendJournal(runId, { type: "issue-fixup-audit-failed", issueKey, commitSha, status: "failed", summary: String(error?.message ?? error) });
    const runningFile = path.join(root, "chunks/running", `${issueKey}.json`);
    if (existsSync(runningFile)) moveChunk(runId, issueKey, "running", "failed");
    notify("AutoFHIR issue fixup audit failed", `${runId}/${issueKey}`);
    cleanupWorktree(worktree);
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
  type: "issue-fixup-audit-coordinator-finished",
  launched,
  pending: stateCount("pending"),
  done: stateCount("done"),
  skipped: stateCount("skipped"),
  failed: stateCount("failed"),
  blocked: stateCount("blocked"),
});
notify("AutoFHIR issue fixup audit finished", `${runId} launched=${launched} failed=${stateCount("failed")}`);
