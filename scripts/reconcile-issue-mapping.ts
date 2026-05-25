#!/usr/bin/env bun

import { existsSync, readFileSync, renameSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { appendJournal, readJson, rewriteStatus, runPath } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/reconcile-issue-mapping.ts --run-id ID [--yes]

Mechanically reconciles issue-mapping state. Currently skips pending seed jobs
when a high-confidence opportunistic observation for that Jira key already
exists.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const yes = process.argv.includes("--yes");
const root = runPath(runId);
const all = path.join(root, "issue-observations/all.ndjson");
if (!existsSync(all)) {
  console.log("observations=0");
  console.log("skippable=0");
  process.exit(0);
}

const skippable = new Map<string, { seedKey: string; observationId: string }>();
for (const line of readFileSync(all, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  const obs = JSON.parse(line);
  const decision = obs.decision;
  if (obs.role === "opportunistic" && decision?.confidence === "high" && obs.issue_key && obs.seed_key && obs.issue_key !== obs.seed_key) {
    skippable.set(obs.issue_key, { seedKey: obs.seed_key, observationId: obs.observation_id });
  }
}

let skipped = 0;
const pendingDir = path.join(root, "seeds/pending");
const skippedDir = path.join(root, "seeds/skipped");
mkdirSync(skippedDir, { recursive: true });
for (const [key, info] of [...skippable.entries()].sort()) {
  const pending = path.join(pendingDir, `${key}.json`);
  if (!existsSync(pending)) continue;
  const dest = path.join(skippedDir, `${key}.json`);
  console.log(`${yes ? "skip" : "would_skip"} ${key} decided_by_seed=${info.seedKey}`);
  if (!yes) continue;
  renameSync(pending, dest);
  rewriteStatus(runId, key, {
    state: "skipped",
    seed_key: key,
    ended_at: new Date().toISOString(),
    reason: "high-confidence opportunistic decision already recorded",
    decided_by_seed: info.seedKey,
  });
  appendJournal(runId, {
    type: "issue-mapping-seed-skipped",
    seedKey: key,
    status: "skipped",
    summary: `high-confidence opportunistic decision already recorded; decided_by_seed=${info.seedKey}`,
  });
  skipped += 1;
}

const counts = Object.fromEntries(["pending", "running", "done", "skipped", "failed", "blocked"].map((state) => {
  const dir = path.join(root, "seeds", state);
  return [state, existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".json")).length : 0];
}));

console.log(`observations=${readFileSync(all, "utf8").split(/\r?\n/).filter(Boolean).length}`);
console.log(`opportunistic_high_confidence=${skippable.size}`);
console.log(`skipped=${skipped}`);
console.log(JSON.stringify(counts));
