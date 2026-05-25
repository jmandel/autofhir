#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { repoRoot, runPath } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/refresh-issue-mapping-viewer.ts --run-id ID [--interval-sec N]

Refreshes the issue-mapping HTML/JSON report in a loop. Normally launched with
start-review-refresh.ts so it is detached from the invoking shell.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const intervalSec = Math.max(5, Number(arg("--interval-sec") ?? process.env.REFRESH_INTERVAL_SEC ?? "120"));
const root = runPath(runId);

while (existsSync(root)) {
  const startedAt = new Date().toISOString();
  console.log(`${startedAt} refreshing ${runId}`);
  const proc = spawnSync("bun", ["autofhir/scripts/export-issue-mapping-viewer.ts", "--run-id", runId], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (proc.stdout) process.stdout.write(proc.stdout);
  if (proc.stderr) process.stderr.write(proc.stderr);
  console.log(`${new Date().toISOString()} refresh_exit=${proc.status ?? 1}`);
  Bun.sleepSync(intervalSec * 1000);
}

console.log(`${new Date().toISOString()} run dir missing; exiting`);
