#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runPath, startDetached } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/start-watch-run-space.ts --run-id ID [--interval-sec 120]

Starts watch-run-space.sh detached. The watchdog logs run counts, disk usage,
and conservative worktree/branch cleanup output under the run directory.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const interval = arg("--interval-sec") ?? process.env.WATCH_INTERVAL_SEC ?? "120";
const root = runPath(runId);
mkdirSync(root, { recursive: true });

const pidFile = path.join(root, "watchdog.pid");
const stdoutFile = path.join(root, "watchdog.log");
const stderrFile = path.join(root, "watchdog.err");

if (existsSync(pidFile)) {
  const oldPid = readFileSync(pidFile, "utf8").trim();
  if (/^\d+$/.test(oldPid) && spawnSync("kill", ["-0", oldPid]).status === 0) {
    console.log("watchdog_already_running=true");
    console.log(`pid=${oldPid}`);
    console.log(`log=${stdoutFile}`);
    console.log(`stderr=${stderrFile}`);
    process.exit(0);
  }
}

const pid = startDetached(["bash", "autofhir/scripts/watch-run-space.sh", runId, interval], stdoutFile, stderrFile);
writeFileSync(pidFile, `${pid}\n`);
console.log("watchdog_started=true");
console.log(`pid=${pid}`);
console.log(`log=${stdoutFile}`);
console.log(`stderr=${stderrFile}`);
console.log(`interval_sec=${interval}`);
