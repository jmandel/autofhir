#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pidIsAlive, runPath, startDetached } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/start-review-refresh.ts --run-id ID [--interval-sec N] [--kind issue-mapping|issue-fixup-diff]

Starts a detached background refresher for review report HTML/JSON.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const intervalSec = arg("--interval-sec") ?? process.env.REFRESH_INTERVAL_SEC ?? "120";
const kind = arg("--kind") ?? process.env.REFRESH_KIND ?? "issue-mapping";
const refreshScript = kind === "issue-fixup-diff"
  ? "autofhir/scripts/refresh-issue-fixup-diff-viewer.ts"
  : kind === "issue-mapping"
    ? "autofhir/scripts/refresh-issue-mapping-viewer.ts"
    : undefined;
if (!refreshScript) throw new Error(`unknown refresh kind: ${kind}`);

const root = runPath(runId);
if (!existsSync(root)) throw new Error(`run not found: ${runId}`);
mkdirSync(path.join(root, "review"), { recursive: true });

const suffix = kind === "issue-mapping" ? "review-refresh" : `review-refresh-${kind}`;
const pidFile = path.join(root, `${suffix}.pid`);
const stdoutFile = path.join(root, `${suffix}.log`);
const stderrFile = path.join(root, `${suffix}.err`);

if (existsSync(pidFile)) {
  const oldPid = readFileSync(pidFile, "utf8").trim();
  if (pidIsAlive(oldPid)) {
    console.log("refresh_already_running=true");
    console.log(`pid=${oldPid}`);
    console.log(`log=${stdoutFile}`);
    process.exit(0);
  }
}

const pid = startDetached([
  "bun",
  refreshScript,
  "--run-id",
  runId,
  "--interval-sec",
  intervalSec,
], stdoutFile, stderrFile);

writeFileSync(pidFile, `${pid}\n`);
console.log("started=true");
console.log(`pid=${pid}`);
console.log(`log=${stdoutFile}`);
console.log(`stderr=${stderrFile}`);
console.log(`interval_sec=${intervalSec}`);
console.log(`kind=${kind}`);
