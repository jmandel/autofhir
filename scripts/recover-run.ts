#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import {
  appendJournal,
  pidIsAlive,
  readJson,
  readRun,
  rewriteStatus,
  runPath,
  writeRun,
} from "./lib";
import { RecoveryAdapter, recoveryAdapterForWorkflow } from "./recovery-adapters";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function usage(): string {
  return `Usage: bun autofhir/scripts/recover-run.ts --run-id ID [--include-pending-valid] [--include-failed] [--include-blocked] [--yes]

Repairs durable AutofHIR queue state after an interrupted coordinator.

For any workflow:
  - pending item with valid result -> finalize through workflow adapter when --include-pending-valid is passed
  - stale running item with valid result -> finalize through workflow adapter
  - stale running item without valid result -> requeue to pending
  - failed/blocked item with retry flag -> requeue to pending

Dry-run by default. Pass --yes to mutate run state. With --yes, the command
refuses to run while the coordinator pid is live unless --allow-live is passed.`;
}

function itemFile(root: string, adapter: RecoveryAdapter, state: string, key: string): string {
  return path.join(root, adapter.itemRoot, state, `${key}.json`);
}

function itemKeys(root: string, adapter: RecoveryAdapter, state: string): string[] {
  const dir = path.join(root, adapter.itemRoot, state);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort();
}

function moveItem(root: string, adapter: RecoveryAdapter, key: string, from: string, to: string): void {
  const source = itemFile(root, adapter, from, key);
  const dest = itemFile(root, adapter, to, key);
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(source, dest);
}

function statusFields(adapter: RecoveryAdapter, key: string, state: string, reason?: string): Record<string, string> {
  const idField = adapter.itemRoot === "seeds" ? "seed_key" : "chunk_id";
  return {
    state,
    [idField]: key,
    ended_at: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
}

function counts(root: string, adapter: RecoveryAdapter): Record<string, number> {
  return Object.fromEntries(["pending", "running", "done", "skipped", "failed", "blocked"].map((state) => [state, itemKeys(root, adapter, state).length]));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (has(argv, "-h") || has(argv, "--help")) {
    console.log(usage());
    return;
  }

  const runId = arg(argv, "--run-id") ?? process.env.RUN_ID;
  if (!runId) throw new Error("--run-id or RUN_ID is required");
  const yes = has(argv, "--yes");
  const includePendingValid = has(argv, "--include-pending-valid");
  const includeFailed = has(argv, "--include-failed");
  const includeBlocked = has(argv, "--include-blocked");
  const allowLive = has(argv, "--allow-live");
  const root = runPath(runId);
  const run = readRun(runId);
  const adapter = recoveryAdapterForWorkflow(run.workflow);

  const pidFile = path.join(root, "coordinator.pid");
  const coordinatorPid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
  const coordinatorLive = coordinatorPid ? pidIsAlive(coordinatorPid) : false;
  if (yes && coordinatorLive && !allowLive) {
    throw new Error(`refusing to recover live run while coordinator pid=${coordinatorPid} is running; stop/pause it first, or pass --allow-live only if you know this is safe`);
  }
  if (coordinatorLive) {
    console.log(`warning=coordinator_running pid=${coordinatorPid}`);
  }

  for (const state of ["pending", "running", "done", "skipped", "failed", "blocked"]) {
    mkdirSync(path.join(root, adapter.itemRoot, state), { recursive: true });
  }

  let finalized = 0;
  let finalizedPending = 0;
  let finalizedRunning = 0;
  let requeuedRunning = 0;
  let requeuedFailed = 0;
  let requeuedBlocked = 0;

  if (includePendingValid) {
    for (const key of itemKeys(root, adapter, "pending")) {
      const file = itemFile(root, adapter, "pending", key);
      const manifest = readJson<any>(file);
      const actualKey = adapter.keyFromManifest(manifest, file) || key;
      const resultPath = adapter.resultPath(runId, actualKey);
      if (!existsSync(resultPath)) continue;
      const validation = adapter.validateResult({ runId, key: actualKey, resultPath, yes });
      if (!validation.ok) continue;
      const finalize = adapter.finalizeValidResult({ runId, key: actualKey, resultPath, validation, yes });
      console.log(`${yes ? "finalize_pending" : "would_finalize_pending"} ${actualKey} status=${finalize.status} ${finalize.summary}`);
      if (yes) {
        moveItem(root, adapter, actualKey, "pending", finalize.status);
      }
      finalized += 1;
      finalizedPending += 1;
    }
  }

  for (const key of itemKeys(root, adapter, "running")) {
    const file = itemFile(root, adapter, "running", key);
    const manifest = readJson<any>(file);
    const actualKey = adapter.keyFromManifest(manifest, file) || key;
    const resultPath = adapter.resultPath(runId, actualKey);
    const validation = adapter.validateResult({ runId, key: actualKey, resultPath, yes });
    if (existsSync(resultPath) && validation.ok) {
      const finalize = adapter.finalizeValidResult({ runId, key: actualKey, resultPath, validation, yes });
      console.log(`${yes ? "finalize" : "would_finalize"} ${actualKey} status=${finalize.status} ${finalize.summary}`);
      if (yes) {
        moveItem(root, adapter, actualKey, "running", finalize.status);
      }
      finalized += 1;
      finalizedRunning += 1;
    } else {
      console.log(`${yes ? "requeue_running" : "would_requeue_running"} ${actualKey} reason=${validation.summary}`);
      if (yes) {
        moveItem(root, adapter, actualKey, "running", "pending");
        rewriteStatus(runId, actualKey, statusFields(adapter, actualKey, "pending", "requeued stale running item after coordinator interruption"));
        appendJournal(runId, {
          type: `${run.workflow ?? "apply"}-${adapter.itemLabel}-requeued`,
          [adapter.itemLabel === "seed" ? "seedKey" : "chunkId"]: actualKey,
          from: "running",
          to: "pending",
          summary: "no valid result found after coordinator interruption",
        });
      }
      requeuedRunning += 1;
    }
  }

  const retryStates = [
    ...(includeFailed ? ["failed"] : []),
    ...(includeBlocked ? ["blocked"] : []),
  ];
  for (const state of retryStates) {
    for (const key of itemKeys(root, adapter, state)) {
      const file = itemFile(root, adapter, state, key);
      const manifest = readJson<any>(file);
      const actualKey = adapter.keyFromManifest(manifest, file) || key;
      const resultPath = adapter.resultPath(runId, actualKey);
      const validation = adapter.validateResult({ runId, key: actualKey, resultPath, yes });
      if (existsSync(resultPath) && validation.ok) {
        const finalize = adapter.finalizeValidResult({ runId, key: actualKey, resultPath, validation, yes });
        console.log(`${yes ? "finalize" : "would_finalize"} ${actualKey} status=${finalize.status} ${finalize.summary}`);
        if (yes) {
          moveItem(root, adapter, actualKey, state, finalize.status);
        }
        finalized += 1;
        continue;
      }
      console.log(`${yes ? `requeue_${state}` : `would_requeue_${state}`} ${actualKey}`);
      if (yes) {
        adapter.archiveBeforeRetry?.({ runId, key: actualKey, resultPath, state, yes });
        moveItem(root, adapter, actualKey, state, "pending");
        rewriteStatus(runId, actualKey, statusFields(adapter, actualKey, "pending", `requeued ${state} item for retry`));
        appendJournal(runId, {
          type: `${run.workflow ?? "apply"}-${adapter.itemLabel}-requeued`,
          [adapter.itemLabel === "seed" ? "seedKey" : "chunkId"]: actualKey,
          from: state,
          to: "pending",
          summary: `${state} ${adapter.itemLabel} requeued for retry`,
        });
      }
      if (state === "failed") requeuedFailed += 1;
      if (state === "blocked") requeuedBlocked += 1;
    }
  }

  if (yes && run.status === "complete" && counts(root, adapter).pending > 0) {
    const updated = readRun(runId);
    updated.status = "running";
    writeRun(updated);
  }

  console.log(`workflow=${run.workflow ?? "apply"}`);
  console.log(`item_root=${adapter.itemRoot}`);
  console.log(`coordinator_script=${adapter.coordinatorScript}`);
  console.log(`finalized_pending=${finalizedPending}`);
  console.log(`finalized_running=${finalizedRunning}`);
  console.log(`requeued_running=${requeuedRunning}`);
  console.log(`requeued_failed=${requeuedFailed}`);
  console.log(`requeued_blocked=${requeuedBlocked}`);
  console.log(JSON.stringify(counts(root, adapter)));
}

if (import.meta.main) {
  await main();
}
