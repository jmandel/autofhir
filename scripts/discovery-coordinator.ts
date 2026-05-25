#!/usr/bin/env bun

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  ChunkManifest,
  appendJournal,
  chunkFile,
  ensureRunDirs,
  moveChunk,
  notify,
  pauseRun,
  readJson,
  readRun,
  repoRoot,
  rewriteStatus,
  runPath,
  setStatus,
  writeRun,
} from "./lib";
import { renderChunkPrompt } from "./render-chunk-prompt";
import { validatePlan } from "./validate-plan";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/discovery-coordinator.ts --run-id ID

Runs read-only discovery chunks. Normally start through start.ts.`);
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
if (run.workflow !== "discovery") throw new Error(`run ${runId} is workflow=${run.workflow ?? "(unset)"}; expected discovery`);

const envConcurrency = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined;
function desiredConcurrency(): number {
  if (envConcurrency !== undefined) return envConcurrency;
  return Number(readRun(runId).concurrency ?? "12");
}

run.status = "running";
writeRun(run);
appendJournal(runId, { type: "discovery-coordinator-started", concurrency: desiredConcurrency() });
notify("AutofHIR discovery started", `${runId} concurrency=${desiredConcurrency()}`);

function pendingFiles(): string[] {
  const dir = path.join(root, "chunks/pending");
  return readdirSync(dir).filter((file) => file.endsWith(".json")).sort().map((file) => path.join(dir, file));
}

function stateCount(state: string): number {
  const dir = path.join(root, "chunks", state);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((file) => file.endsWith(".json")).length;
}

async function runCopilot(promptPath: string, stdoutFile: string, stderrFile: string, logDir: string): Promise<number> {
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
    cwd: repoRoot,
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

async function launchChunk(pendingPath: string): Promise<void> {
  const original = readJson<ChunkManifest>(pendingPath);
  const chunkId = original.chunkId;
  const runningPath = moveChunk(runId, chunkId, "pending", "running");
  const chunkDir = path.join(root, "chunks", chunkId);
  const promptPath = path.join(chunkDir, "prompt.md");
  if (!existsSync(promptPath)) {
    renderChunkPrompt({ runId, chunkId, selectionPath: runningPath });
  }

  const stdoutFile = path.join(root, "stdout", `${chunkId}.jsonl`);
  const stderrFile = path.join(root, "stderr", `${chunkId}.log`);
  const logDir = path.join(root, "copilot-logs", chunkId);
  rewriteStatus(runId, chunkId, {
    state: "running",
    chunk_id: chunkId,
    started_at: new Date().toISOString(),
    prompt: promptPath,
    output_dir: chunkDir,
  });
  appendJournal(runId, { type: "discovery-chunk-launched", chunkId, prompt: promptPath });

  let exitCode = 1;
  try {
    exitCode = await runCopilot(promptPath, stdoutFile, stderrFile, logDir);
  } catch (error) {
    appendJournal(runId, { type: "discovery-chunk-error", chunkId, status: "failed", summary: String(error) });
  }

  const validation = validatePlan({ runId, chunkId, planPath: path.join(chunkDir, "review", "issues.ndjson"), writeResult: true });
  if (exitCode === 0 && validation.ok) {
    moveChunk(runId, chunkId, "running", "done");
    rewriteStatus(runId, chunkId, {
      state: "done",
      chunk_id: chunkId,
      ended_at: new Date().toISOString(),
      exit_code: exitCode,
      mentioned_count: validation.mentionedCount,
      reviewed_candidates: validation.reviewedCandidateCount,
      proposed_jira: validation.proposedJiraCount,
    });
    appendJournal(runId, {
      type: "discovery-chunk-complete",
      chunkId,
      status: "done",
      summary: `review valid with ${validation.reviewedCandidateCount ?? 0} candidates and ${validation.proposedJiraCount ?? 0} proposed Jira rows`,
    });
    return;
  }

  moveChunk(runId, chunkId, "running", "failed");
  setStatus(runId, chunkId, {
    state: "failed",
    ended_at: new Date().toISOString(),
    exit_code: exitCode,
  });
  appendJournal(runId, {
    type: "discovery-chunk-failed",
    chunkId,
    status: "failed",
    summary: [
      `exit=${exitCode}`,
      validation.errors.length ? `validation=${validation.errors.join("; ")}` : "validation=ok",
    ].join(" "),
  });
}

const active = new Set<Promise<void>>();
let stopping = false;

while (!stopping) {
  run = readRun(runId);
  if (existsSync(path.join(root, "PAUSED")) || run.status === "paused") {
    await Bun.sleep(coordinatorPollMs);
    continue;
  }

  const concurrency = desiredConcurrency();
  while (active.size < concurrency) {
    const next = pendingFiles()[0];
    if (!next) break;
    const promise = launchChunk(next)
      .catch((error) => {
        appendJournal(runId, { type: "discovery-worker-invariant-failed", status: "failed", summary: String(error) });
        pauseRun(runId, `discovery worker invariant failed: ${String(error)}`);
      })
      .finally(() => active.delete(promise));
    active.add(promise);
  }

  if (stateCount("pending") === 0 && active.size === 0 && stateCount("running") === 0) {
    stopping = true;
    break;
  }
  await Bun.sleep(active.size > 0 ? 1000 : coordinatorPollMs);
}

while (active.size > 0) {
  await Promise.race(active);
}

run = readRun(runId);
if (run.status !== "paused") {
  run.status = "complete";
  writeRun(run);
}
appendJournal(runId, {
  type: "discovery-coordinator-finished",
  pending: stateCount("pending"),
  done: stateCount("done"),
  failed: stateCount("failed"),
  blocked: stateCount("blocked"),
});
notify("AutofHIR discovery finished", `${runId} done=${stateCount("done")} failed=${stateCount("failed")}`);
