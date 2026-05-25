#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readRun, runCommand, runPath, runsRoot } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/status.ts [--run-id ID]

Prints current run status, queue counts, recent journal entries, and combined
branch head. If --run-id is omitted, uses the lexically latest run directory.`);
  process.exit(0);
}

function latestRunId(): string | undefined {
  if (!existsSync(runsRoot)) return undefined;
  const dirs = readdirSync(runsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  return dirs.at(-1);
}

const runId = arg("--run-id") ?? process.env.RUN_ID ?? latestRunId();
if (!runId) throw new Error("No run found. Pass --run-id.");

const run = readRun(runId);
const root = runPath(runId);
console.log(`run_id=${runId}`);
console.log(`status=${run.status}`);
console.log(`description=${run.description}`);
console.log(`run_dir=${root}`);

const paused = path.join(root, "PAUSED");
console.log(`paused=${existsSync(paused)}`);
if (existsSync(paused)) {
  for (const line of readFileSync(paused, "utf8").trim().split("\n")) console.log(`  ${line}`);
}

const pidFile = path.join(root, "coordinator.pid");
if (existsSync(pidFile)) {
  const pid = readFileSync(pidFile, "utf8").trim();
  const live = /^\d+$/.test(pid) && spawnSync("kill", ["-0", pid]).status === 0;
  console.log(`coordinator=${live ? "running" : "not-running"} pid=${pid}`);
} else {
  console.log("coordinator=not-started");
}

const queueRoot = run.workflow === "issue-mapping" ? "seeds" : "chunks";
console.log(run.workflow === "issue-mapping" ? "seed_counts:" : "chunk_counts:");
for (const state of ["pending", "running", "done", "skipped", "failed", "blocked"]) {
  const dir = path.join(root, queueRoot, state);
  const n = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
  console.log(`  ${state}=${n}`);
}

console.log("recent_journal:");
const journal = path.join(root, "journal.ndjson");
if (existsSync(journal)) {
  const lines = readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).slice(-12);
  for (const line of lines) {
    const entry = JSON.parse(line);
    console.log(`  ${entry.at} ${entry.type} ${entry.chunkId ?? entry.seedKey ?? ""} ${entry.status ?? ""} ${entry.summary ?? entry.reason ?? ""}`);
  }
} else {
  console.log("  none");
}

if (run.fhirRepo && run.combinedBranch) {
  console.log("combined_head:");
  const log = runCommand(["git", "--no-pager", "log", "--oneline", "-5", run.combinedBranch], { cwd: run.fhirRepo, allowFailure: true }).trim();
  for (const line of log.split("\n").filter(Boolean)) console.log(`  ${line}`);
}
