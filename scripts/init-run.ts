#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { appendJournal, ensureRunDirs, readRun, runCommand, writeRun } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: FHIR_REPO=/path/to/HL7/fhir bun autofhir/scripts/init-run.ts --run-id ID [--base-ref REF]

Initializes a run's local combined branch ref. Use reset-run.ts for rollback.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const fhirRepo = arg("--fhir-repo") ?? process.env.FHIR_REPO;
if (!fhirRepo) throw new Error("--fhir-repo or FHIR_REPO is required");
if (!existsSync(fhirRepo)) throw new Error(`FHIR repo not found: ${fhirRepo}`);

const baseRef = arg("--base-ref") ?? process.env.BASE_REF ?? "master";
ensureRunDirs(runId);
const run = readRun(runId);
run.fhirRepo = fhirRepo;
run.baseRef = run.baseRef ?? baseRef;
run.baseSha = run.baseSha ?? runCommand(["git", "rev-parse", run.baseRef], { cwd: fhirRepo }).trim();

if (!runCommand(["git", "rev-parse", "--verify", "--quiet", run.combinedBranch], { cwd: fhirRepo, allowFailure: true }).trim()) {
  runCommand(["git", "branch", run.combinedBranch, run.baseSha], { cwd: fhirRepo });
}

run.status = "initialized";
writeRun(run);
appendJournal(runId, {
  type: "run-initialized",
  fhirRepo,
  baseRef: run.baseRef,
  baseSha: run.baseSha,
  combinedBranch: run.combinedBranch,
  integrationMode: "local-non-checkout-fast-forward",
});

console.log(`run_id=${runId}`);
console.log(`base_sha=${run.baseSha}`);
console.log(`combined_branch=${run.combinedBranch}`);
console.log("integration_mode=local-non-checkout-fast-forward");
