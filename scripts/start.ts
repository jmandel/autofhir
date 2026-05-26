#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readRun, runPath, startDetached, writeRun } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/start.ts --run-id ID [--concurrency N]

Starts the coordinator in the background and returns immediately.

Codex coordination note: after this returns, launch monitor.ts in a separate
exec session with a short yield so Codex receives completion/heartbeat output:

  bun autofhir/scripts/monitor.ts --run-id ID --interval-sec 120

If a coordinator dies or the machine restarts, use recover-run.ts to finalize
valid stranded running items and requeue interrupted/failed items before
starting again.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const run = readRun(runId);
const concurrency = arg("--concurrency");
if (concurrency !== undefined) {
  const n = Number(concurrency);
  if (!Number.isInteger(n) || n < 0) throw new Error("--concurrency must be a non-negative integer");
  run.concurrency = n;
  writeRun(run);
}
const root = runPath(runId);
mkdirSync(root, { recursive: true });
const pidFile = path.join(root, "coordinator.pid");
const stdoutFile = path.join(root, "coordinator.log");
const stderrFile = path.join(root, "coordinator.err");

if (existsSync(pidFile)) {
  const oldPid = readFileSync(pidFile, "utf8").trim();
  if (/^\d+$/.test(oldPid) && spawnSync("kill", ["-0", oldPid]).status === 0) {
    console.log(`coordinator_already_running=true`);
    console.log(`pid=${oldPid}`);
    console.log(`log=${stdoutFile}`);
    process.exit(0);
  }
}

const coordinatorScript = run.workflow === "issue-mapping"
  ? "autofhir/scripts/issue-mapping-coordinator.ts"
  : run.workflow === "discovery"
    ? "autofhir/scripts/discovery-coordinator.ts"
    : run.workflow === "issue-fixup"
      ? "autofhir/scripts/issue-fixup-coordinator.ts"
      : run.workflow === "issue-fixup-audit"
        ? "autofhir/scripts/issue-fixup-audit-coordinator.ts"
        : "autofhir/scripts/coordinator.ts";
const pid = startDetached(["bun", coordinatorScript, "--run-id", runId], stdoutFile, stderrFile);
writeFileSync(pidFile, `${pid}\n`);
console.log("started=true");
console.log(`pid=${pid}`);
console.log(`coordinator_script=${coordinatorScript}`);
console.log(`log=${stdoutFile}`);
console.log(`stderr=${stderrFile}`);
console.log(`concurrency=${concurrency ?? run.concurrency ?? process.env.CONCURRENCY ?? "12"}`);
console.log(`monitor_command=bun autofhir/scripts/monitor.ts --run-id ${runId} --interval-sec ${process.env.MONITOR_INTERVAL_SEC ?? "120"}`);
