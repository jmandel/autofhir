#!/usr/bin/env bun

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  appendJournal,
  ensureRunDirs,
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
import { renderIssueSeedPrompt } from "./render-issue-seed-prompt";
import { validateIssueMappingResult } from "./validate-issue-mapping-result";

type SeedManifest = {
  seed_key: string;
  partition_id?: string;
};

type CandidatePool = {
  candidates?: {
    key: string;
  }[];
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/issue-mapping-coordinator.ts --run-id ID

Runs issue-mapping seed jobs. Normally start through start.ts.`);
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
for (const dir of ["seeds/pending", "seeds/running", "seeds/done", "seeds/failed", "seeds/blocked", "seed-runs", "issue-observations"]) {
  mkdirSync(path.join(root, dir), { recursive: true });
}

let run = readRun(runId);
if (run.workflow !== "issue-mapping") throw new Error(`run ${runId} is workflow=${run.workflow ?? "(unset)"}; expected issue-mapping`);

const envConcurrency = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined;
function desiredConcurrency(): number {
  if (envConcurrency !== undefined) return envConcurrency;
  return Number(readRun(runId).concurrency ?? "12");
}

run.status = "running";
writeRun(run);
appendJournal(runId, { type: "issue-mapping-coordinator-started", concurrency: desiredConcurrency() });
notify("AutofHIR issue mapping started", `${runId} concurrency=${desiredConcurrency()}`);

const candidateOrder = new Map<string, number>();
const candidatePoolPath = path.join(root, "candidate-pool/issues.json");
if (existsSync(candidatePoolPath)) {
  const pool = readJson<CandidatePool>(candidatePoolPath);
  (pool.candidates ?? []).forEach((candidate, index) => candidateOrder.set(candidate.key, index));
}

function seedFile(state: string, seedKey: string): string {
  return path.join(root, "seeds", state, `${seedKey}.json`);
}

function moveSeed(seedKey: string, from: string, to: string): string {
  const source = seedFile(from, seedKey);
  const dest = seedFile(to, seedKey);
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(source, dest);
  return dest;
}

function pendingFiles(): string[] {
  const dir = path.join(root, "seeds/pending");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort((a, b) => {
      const keyA = a.replace(/\.json$/, "");
      const keyB = b.replace(/\.json$/, "");
      return (candidateOrder.get(keyA) ?? Number.MAX_SAFE_INTEGER) - (candidateOrder.get(keyB) ?? Number.MAX_SAFE_INTEGER)
        || keyA.localeCompare(keyB);
    })
    .map((file) => path.join(dir, file));
}

function choosePending(activePartitions: Set<string>): string | undefined {
  const files = pendingFiles();
  if (files.length === 0) return undefined;
  for (const file of files) {
    const seed = readJson<SeedManifest>(file);
    const partition = seed.partition_id ?? "unknown::general";
    if (!activePartitions.has(partition)) return file;
  }
  return files[0];
}

function stateCount(state: string): number {
  const dir = path.join(root, "seeds", state);
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

function skipPendingSeed(seedKey: string, reason: string, decidedBySeed: string): boolean {
  const pendingPath = seedFile("pending", seedKey);
  if (!existsSync(pendingPath)) return false;
  moveSeed(seedKey, "pending", "skipped");
  rewriteStatus(runId, seedKey, {
    state: "skipped",
    seed_key: seedKey,
    ended_at: new Date().toISOString(),
    reason,
    decided_by_seed: decidedBySeed,
  });
  appendJournal(runId, {
    type: "issue-mapping-seed-skipped",
    seedKey,
    status: "skipped",
    summary: `${reason}; decided_by_seed=${decidedBySeed}`,
  });
  return true;
}

function accumulateObservations(seedKey: string, resultPath: string): { observationCount: number; skippedSeeds: number } {
  const result = readJson<any>(resultPath);
  const rows = Array.isArray(result.issues) ? result.issues : [];
  let observationCount = 0;
  let skippedSeeds = 0;
  for (const decision of rows) {
    if (!decision?.key) continue;
    const observation = {
      schema_version: "issue-observation-v1",
      run_id: runId,
      observation_id: `${seedKey}--${decision.key}--${Date.now()}--${observationCount}`,
      seed_key: seedKey,
      issue_key: decision.key,
      role: decision.role,
      decision,
      result_path: path.relative(root, resultPath),
      created_at: new Date().toISOString(),
    };
    appendFileSync(path.join(root, "issue-observations", `${decision.key}.ndjson`), `${JSON.stringify(observation)}\n`);
    appendFileSync(path.join(root, "issue-observations", "all.ndjson"), `${JSON.stringify(observation)}\n`);
    observationCount += 1;

    if (decision.role === "related" && decision.confidence === "high" && decision.key !== seedKey) {
      if (skipPendingSeed(decision.key, "high-confidence related decision already recorded", seedKey)) {
        skippedSeeds += 1;
      }
    }
  }
  return { observationCount, skippedSeeds };
}

async function launchSeed(pendingPath: string): Promise<void> {
  const seed = readJson<SeedManifest>(pendingPath);
  const seedKey = seed.seed_key;
  const runningPath = moveSeed(seedKey, "pending", "running");
  const seedDir = path.join(root, "seed-runs", seedKey);
  const promptPath = path.join(seedDir, "prompt.md");
  if (existsSync(promptPath)) {
    const stalePromptPath = path.join(seedDir, `prompt.stale-${Date.now()}.md`);
    renameSync(promptPath, stalePromptPath);
    appendJournal(runId, {
      type: "issue-mapping-prompt-archived",
      seedKey,
      prompt: promptPath,
      archived_prompt: stalePromptPath,
      summary: "archived existing prompt before launch so current prompt sources are re-rendered",
    });
  }
  renderIssueSeedPrompt({ runId, seedKey, seedPath: runningPath });

  const stdoutFile = path.join(root, "stdout", `${seedKey}.jsonl`);
  const stderrFile = path.join(root, "stderr", `${seedKey}.log`);
  const logDir = path.join(root, "copilot-logs", seedKey);
  rewriteStatus(runId, seedKey, {
    state: "running",
    seed_key: seedKey,
    partition_id: seed.partition_id,
    started_at: new Date().toISOString(),
    prompt: promptPath,
    output_dir: seedDir,
  });
  appendJournal(runId, { type: "issue-mapping-seed-launched", seedKey, prompt: promptPath });

  let exitCode = 1;
  try {
    exitCode = await runCopilot(promptPath, stdoutFile, stderrFile, logDir);
  } catch (error) {
    appendJournal(runId, { type: "issue-mapping-seed-error", seedKey, status: "failed", summary: String(error) });
  }

  const resultPath = path.join(seedDir, "result.json");
  const validation = validateIssueMappingResult({ runId, seedKey, resultPath, writeResult: true });
  if (validation.ok) {
    const { observationCount: decisionCount, skippedSeeds } = accumulateObservations(seedKey, resultPath);
    moveSeed(seedKey, "running", "done");
    rewriteStatus(runId, seedKey, {
      state: "done",
      seed_key: seedKey,
      ended_at: new Date().toISOString(),
      exit_code: exitCode,
      exit_warning: exitCode === 0 ? undefined : "copilot exited nonzero after producing a valid result",
      decided_issues: validation.decidedIssueCount,
      decisions: decisionCount,
      target_chunks: validation.targetChunkCount,
    });
    appendJournal(runId, {
      type: "issue-mapping-seed-complete",
      seedKey,
      status: "done",
      summary: [
        `valid result with ${validation.decidedIssueCount} decisions and ${validation.targetChunkCount} target chunks`,
        exitCode === 0 ? undefined : `exit_warning=nonzero(${exitCode})`,
        `skipped_pending=${skippedSeeds}`,
      ].filter(Boolean).join("; "),
    });
    return;
  }

  moveSeed(seedKey, "running", "failed");
  setStatus(runId, seedKey, {
    state: "failed",
    ended_at: new Date().toISOString(),
    exit_code: exitCode,
  });
  appendJournal(runId, {
    type: "issue-mapping-seed-failed",
    seedKey,
    status: "failed",
    summary: [
      `exit=${exitCode}`,
      validation.errors.length ? `validation=${validation.errors.join("; ")}` : "validation=ok",
    ].join(" "),
  });
}

const active = new Set<Promise<void>>();
const activePartitions = new Set<string>();
let stopping = false;

while (!stopping) {
  run = readRun(runId);
  if (existsSync(path.join(root, "PAUSED")) || run.status === "paused") {
    await Bun.sleep(coordinatorPollMs);
    continue;
  }
  if (run.status !== "running") {
    run.status = "running";
    writeRun(run);
  }

  const concurrency = desiredConcurrency();
  while (active.size < concurrency) {
    const next = choosePending(activePartitions);
    if (!next) break;
    const seed = readJson<SeedManifest>(next);
    const partition = seed.partition_id ?? "unknown::general";
    activePartitions.add(partition);
    const promise = launchSeed(next)
      .catch((error) => {
        appendJournal(runId, { type: "issue-mapping-worker-invariant-failed", status: "failed", summary: String(error) });
        pauseRun(runId, `issue-mapping worker invariant failed: ${String(error)}`);
      })
      .finally(() => {
        active.delete(promise);
        activePartitions.delete(partition);
      });
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
  type: "issue-mapping-coordinator-finished",
  pending: stateCount("pending"),
  done: stateCount("done"),
  failed: stateCount("failed"),
  blocked: stateCount("blocked"),
});
notify("AutofHIR issue mapping finished", `${runId} done=${stateCount("done")} failed=${stateCount("failed")}`);
