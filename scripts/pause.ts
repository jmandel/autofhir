#!/usr/bin/env bun

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { appendJournal, readRun, runPath, writeRun } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/pause.ts --run-id ID [--reason TEXT]

Creates the run PAUSED marker and records the reason in run.json/journal.
Running workers are not killed; the coordinator stops launching new work and
exits after active workers drain. For immediate network stop, terminate the
chosen worker processes manually and later requeue stale running chunks.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const reason = arg("--reason") ?? "manual pause";
const root = runPath(runId);
const paused = path.join(root, "PAUSED");

if (existsSync(paused)) {
  console.log("paused=true");
  console.log(`file=${paused}`);
  process.exit(0);
}

writeFileSync(paused, `paused_at=${new Date().toISOString()}\nreason=${reason}\n`);
const run = readRun(runId);
run.status = "paused";
writeRun(run);
appendJournal(runId, { type: "run-paused", reason });

console.log("paused=true");
console.log(`reason=${reason}`);
console.log(`file=${paused}`);
