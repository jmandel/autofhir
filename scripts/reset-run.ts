#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appendJournal, chunkFile, readRun, removeIfExists, runCommand, runPath, sanitizeId, writeRun } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/reset-run.ts --run-id ID --yes

Rolls back this run's local combined branch ref to the recorded base SHA, removes
per-chunk worktrees/branches for the run, clears transient status/log/result
state, and moves all chunks back to pending.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
if (!process.argv.includes("--yes")) throw new Error("Refusing reset without --yes");

const run = readRun(runId);
if (!run.fhirRepo || !run.baseSha) throw new Error("Run is not initialized; no base SHA to reset to.");
const root = runPath(runId);
const pidFile = path.join(root, "coordinator.pid");
if (existsSync(pidFile)) {
  const trimmed = readFileSync(pidFile, "utf8").trim();
  if (/^\d+$/.test(trimmed) && spawnSync("kill", ["-0", trimmed]).status === 0) {
    throw new Error(`Coordinator is still running with pid ${trimmed}`);
  }
}

if (run.combinedWorktree && existsSync(run.combinedWorktree)) {
  runCommand(["git", "worktree", "remove", "-f", run.combinedWorktree], { cwd: run.fhirRepo, allowFailure: true });
}
runCommand(["git", "branch", "-f", run.combinedBranch, run.baseSha], { cwd: run.fhirRepo });

for (const group of ["tasks", "integration", "inspect"]) {
  const groupRoot = path.join(root, "worktrees", group);
  if (!existsSync(groupRoot)) continue;
  for (const name of readdirSync(groupRoot)) {
    const wt = path.join(groupRoot, name);
    runCommand(["git", "worktree", "remove", "-f", wt], { cwd: run.fhirRepo, allowFailure: true });
  }
  rmSync(groupRoot, { recursive: true, force: true });
  mkdirSync(groupRoot, { recursive: true });
}
const branchPrefix = `autofhir/${sanitizeId(runId)}/`;
const branches = runCommand(["git", "branch", "--format=%(refname:short)"], { cwd: run.fhirRepo })
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s.startsWith(branchPrefix));
for (const branch of branches) {
  runCommand(["git", "branch", "-D", branch], { cwd: run.fhirRepo, allowFailure: true });
}

for (const state of ["running", "done", "skipped", "failed", "blocked"]) {
  const dir = path.join(root, "chunks", state);
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const id = path.basename(file, ".json");
    const dest = chunkFile(runId, "pending", id);
    removeIfExists(dest);
    renameSync(path.join(dir, file), dest);
  }
}

for (const dir of ["status", "stdout", "stderr", "copilot-logs", "results", "prompts"]) {
  rmSync(path.join(root, dir), { recursive: true, force: true });
  mkdirSync(path.join(root, dir), { recursive: true });
}
removeIfExists(path.join(root, "PAUSED"));

run.status = "reset";
writeRun(run);
appendJournal(runId, { type: "run-reset", baseSha: run.baseSha });

console.log(`reset=true`);
console.log(`run_id=${runId}`);
console.log(`base_sha=${run.baseSha}`);
