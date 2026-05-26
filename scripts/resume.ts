#!/usr/bin/env bun

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { appendJournal, readRun, runPath, startDetached, writeRun } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/resume.ts --run-id ID [--start]

Removes the PAUSED marker, records a resume event, and optionally starts the
workflow coordinator in the background. If stale running items exist from a
stopped coordinator, recover them first with recover-run.ts.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const root = runPath(runId);
const paused = path.join(root, "PAUSED");

if (existsSync(paused)) rmSync(paused, { force: true });
const run = readRun(runId);
if (run.status === "paused") {
  run.status = "initialized";
  writeRun(run);
}
appendJournal(runId, { type: "run-resumed" });

console.log("paused=false");

if (process.argv.includes("--start")) {
  const coordinatorScript = run.workflow === "issue-mapping"
    ? "autofhir/scripts/issue-mapping-coordinator.ts"
    : run.workflow === "discovery"
      ? "autofhir/scripts/discovery-coordinator.ts"
      : run.workflow === "issue-fixup"
        ? "autofhir/scripts/issue-fixup-coordinator.ts"
        : run.workflow === "issue-fixup-audit"
          ? "autofhir/scripts/issue-fixup-audit-coordinator.ts"
          : "autofhir/scripts/coordinator.ts";
  const stdoutFile = path.join(root, "coordinator.log");
  const stderrFile = path.join(root, "coordinator.err");
  const pid = startDetached(["bun", coordinatorScript, "--run-id", runId], stdoutFile, stderrFile);
  await Bun.write(path.join(root, "coordinator.pid"), `${pid}\n`);
  console.log("started=true");
  console.log(`pid=${pid}`);
  console.log(`coordinator_script=${coordinatorScript}`);
  console.log(`log=${stdoutFile}`);
  console.log(`stderr=${stderrFile}`);
}
