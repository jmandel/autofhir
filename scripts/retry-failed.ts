#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  appendJournal,
  chunkFile,
  ensureRunDirs,
  moveChunk,
  readJson,
  runPath,
  setStatus,
  writeJson,
} from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function args(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1]);
  }
  return values;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/retry-failed.ts --run-id ID [--chunk CHUNK_ID ...] [--include-blocked] [--yes]
       bun autofhir/scripts/retry-failed.ts --run-id ID --include-running [--chunk CHUNK_ID ...] [--yes]

Requeues failed chunks for a fresh Copilot retry. Previous failed worktrees,
branches, logs, and result JSON are preserved and recorded under
autofhir/runs/<run-id>/retries/<chunk>.json so the retry prompt can inspect
them as evidence without continuing from stale state. Use --include-running
only after the coordinator has stopped and those running chunks are stale.

Without --yes this is a dry run.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

ensureRunDirs(runId);
const root = runPath(runId);
const yes = process.argv.includes("--yes");
const includeBlocked = process.argv.includes("--include-blocked");
const includeRunning = process.argv.includes("--include-running");
const selected = new Set(args("--chunk"));
const states = [
  "failed",
  ...(includeBlocked ? ["blocked"] : []),
  ...(includeRunning ? ["running"] : []),
];

function statusValues(chunkId: string): Record<string, string> {
  const file = path.join(root, "status", `${chunkId}.status`);
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    values[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return values;
}

function retryInfoPath(chunkId: string): string {
  return path.join(root, "retries", `${chunkId}.json`);
}

function nextRetryAttempt(chunkId: string): number {
  const file = retryInfoPath(chunkId);
  if (!existsSync(file)) return 1;
  const current = readJson<any>(file);
  return Number(current.retryAttempt ?? 0) + 1;
}

type Candidate = {
  chunkId: string;
  state: string;
};

const candidates: Candidate[] = [];
for (const state of states) {
  const dir = path.join(root, "chunks", state);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const chunkId = path.basename(file, ".json");
    if (selected.size > 0 && !selected.has(chunkId)) continue;
    candidates.push({ chunkId, state });
  }
}

if (candidates.length === 0) {
  console.log("requeued=0");
  process.exit(0);
}

mkdirSync(path.join(root, "retries"), { recursive: true });

for (const candidate of candidates) {
  const pendingPath = chunkFile(runId, "pending", candidate.chunkId);
  const runningPath = chunkFile(runId, "running", candidate.chunkId);
  if (existsSync(pendingPath) || (candidate.state !== "running" && existsSync(runningPath))) {
    console.log(`skip ${candidate.chunkId}: already pending or running`);
    continue;
  }

  const status = statusValues(candidate.chunkId);
  const retryAttempt = nextRetryAttempt(candidate.chunkId);
  const info = {
    schemaVersion: "1.0",
    runId,
    chunkId: candidate.chunkId,
    retryAttempt,
    queuedAt: new Date().toISOString(),
    previousState: candidate.state,
    previous: {
      branch: status.branch,
      worktree: status.worktree,
      chunk_json: status.chunk_json,
      result: status.result,
      prompt: status.prompt,
      stdout: status.stdout,
      stderr: status.stderr,
      copilot_log_dir: status.copilot_log_dir,
      exit_code: status.exit_code,
      finished_at: status.finished_at,
      status: status.status,
      error: status.error,
    },
  };

  if (!yes) {
    console.log(`would_requeue ${candidate.chunkId} from=${candidate.state} retry_attempt=${retryAttempt}`);
    continue;
  }

  writeJson(retryInfoPath(candidate.chunkId), info);
  moveChunk(runId, candidate.chunkId, candidate.state, "pending");
  setStatus(runId, candidate.chunkId, {
    status: "pending-retry",
    retry_attempt: retryAttempt,
    queued_at: info.queuedAt,
  });
  appendJournal(runId, {
    type: "chunk-retry-queued",
    chunkId: candidate.chunkId,
    status: "pending-retry",
    retryAttempt,
    summary: `Requeued ${candidate.state} chunk for a fresh worker retry`,
  });
  console.log(`requeued ${candidate.chunkId} from=${candidate.state} retry_attempt=${retryAttempt}`);
}

const paused = path.join(root, "PAUSED");
if (yes && existsSync(paused)) {
  console.log(`paused=true`);
  console.log(`remove ${paused} before restarting the coordinator when ready`);
}
