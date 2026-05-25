#!/usr/bin/env bun

import { appendJournal, readRun, writeRun } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/set-concurrency.ts --run-id ID --concurrency N

Updates run.json with the desired soft concurrency. A live-aware coordinator
notices this value during its polling launch loop. Ramp-up happens on the next
poll if there is pending work. Ramp-down happens by attrition: no workers are
killed, but no new workers are launched while active workers are at or above
the target.

Use pause.ts when you want zero new launches with an explicit operational stop.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const rawConcurrency = arg("--concurrency");
if (rawConcurrency === undefined) throw new Error("--concurrency is required");
const concurrency = Number(rawConcurrency);
if (!Number.isInteger(concurrency) || concurrency < 0) {
  throw new Error("--concurrency must be a non-negative integer");
}

const run = readRun(runId);
run.concurrency = concurrency;
writeRun(run);
appendJournal(runId, {
  type: "concurrency-set",
  concurrency,
  mode: "soft",
});

console.log(`concurrency=${concurrency}`);
console.log("mode=soft");
console.log("effect=soft-update");
console.log("running_coordinator=will_notice_on_next_poll_or_worker_completion_if_using_live-concurrency code");
