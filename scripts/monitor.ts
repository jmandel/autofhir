#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readRun, runCommand, runPath, pidIsAlive } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/monitor.ts --run-id ID [--interval-sec N] [--once] [--tick]

Prints a compact run summary immediately, then waits for coordinator exit while
printing periodic heartbeat summaries.

Use --tick for Codex chat coordination: run it as a foreground tool call. The
command exits after the first event or interval heartbeat, causing the tool
session to complete and surface output without manual polling.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const intervalSec = Math.max(5, Number(arg("--interval-sec") ?? process.env.MONITOR_INTERVAL_SEC ?? "120"));
const once = process.argv.includes("--once");
const tick = process.argv.includes("--tick");
const root = runPath(runId);

function queueRoot(): string {
  const run = readRun(runId);
  return run.workflow === "issue-mapping" ? "seeds" : "chunks";
}

function countQueue(state: string): number {
  const dir = path.join(root, queueRoot(), state);
  if (!existsSync(dir)) return 0;
  return Array.from(new Bun.Glob("*.json").scanSync({ cwd: dir })).length;
}

function coordinatorPid(): string | undefined {
  const file = path.join(root, "coordinator.pid");
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8").trim();
}

function summary(): string {
  const run = readRun(runId);
  const pid = coordinatorPid();
  const live = pid ? pidIsAlive(pid) : false;
  const counts = ["pending", "running", "done", "skipped", "failed", "blocked"]
    .map((state) => `${state}=${countQueue(state)}`)
    .join(" ");
  const journal = path.join(root, "journal.ndjson");
  const last = existsSync(journal)
    ? readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).at(-1)
    : undefined;
  const lastEntry = last ? JSON.parse(last) : undefined;
  return [
    `at=${new Date().toISOString()}`,
    `run=${runId}`,
    `status=${run.status}`,
    `coordinator=${live ? "running" : "not-running"}${pid ? `:${pid}` : ""}`,
    counts,
    lastEntry ? `last=${lastEntry.type}${lastEntry.chunkId || lastEntry.seedKey ? `/${lastEntry.chunkId ?? lastEntry.seedKey}` : ""}${lastEntry.status ? `/${lastEntry.status}` : ""}` : "last=none",
  ].join(" ");
}

function combinedHead(): string | undefined {
  const run = readRun(runId);
  if (!run.fhirRepo || !run.combinedBranch) return undefined;
  return runCommand(["git", "--no-pager", "log", "--oneline", "-1", run.combinedBranch], {
    cwd: run.fhirRepo,
    allowFailure: true,
  }).trim() || undefined;
}

function lastJournalToken(): string {
  const journal = path.join(root, "journal.ndjson");
  if (!existsSync(journal)) return "none";
  const text = readFileSync(journal, "utf8");
  const lines = text.trim().split("\n").filter(Boolean);
  return `${lines.length}:${lines.at(-1) ?? ""}`;
}

function stateToken(): string {
  const head = combinedHead() ?? "no-head";
  const journal = lastJournalToken();
  const counts = ["pending", "running", "done", "skipped", "failed", "blocked"]
    .map((state) => `${state}=${countQueue(state)}`)
    .join(",");
  const pid = coordinatorPid();
  const live = pid ? pidIsAlive(pid) : false;
  return [head, journal, counts, live ? "live" : "dead"].join("|");
}

console.log(`monitor-start ${summary()}`);
const head = combinedHead();
if (head) console.log(`monitor-head ${head}`);

if (once) process.exit(0);

if (tick) {
  const start = Date.now();
  const initialToken = stateToken();
  while (Date.now() - start < intervalSec * 1000) {
    const pid = coordinatorPid();
    if (!pid || !pidIsAlive(pid)) {
      console.log(`monitor-exit ${summary()}`);
      const finalHead = combinedHead();
      if (finalHead) console.log(`monitor-head ${finalHead}`);
      process.exit(0);
    }
    const currentToken = stateToken();
    if (currentToken !== initialToken) {
      console.log(`monitor-event ${summary()}`);
      const eventHead = combinedHead();
      if (eventHead) console.log(`monitor-head ${eventHead}`);
      process.exit(0);
    }
    await Bun.sleep(1000);
  }
  console.log(`monitor-heartbeat ${summary()}`);
  const heartbeatHead = combinedHead();
  if (heartbeatHead) console.log(`monitor-head ${heartbeatHead}`);
  process.exit(0);
}

while (true) {
  const pid = coordinatorPid();
  if (!pid || !pidIsAlive(pid)) break;
  await Bun.sleep(intervalSec * 1000);
  console.log(`monitor-heartbeat ${summary()}`);
}

console.log(`monitor-exit ${summary()}`);
const finalHead = combinedHead();
if (finalHead) console.log(`monitor-head ${finalHead}`);
