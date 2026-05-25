#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appendJournal, readJson, readRun, repoRoot, runPath, writeJson } from "./lib";
import { validatePlan } from "./validate-plan";

type PlanRecord = {
  chunkId: string;
  planPath: string;
  plan: any;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function markdownList(items: any[], render: (item: any) => string): string {
  return items.length ? items.map(render).join("\n\n") : "_None._";
}

function jiraUniverse(cutoff: string): string[] {
  const sql = `
SELECT i.key
FROM issues i
WHERE json_extract(i.data, '$.updated_at') >= '${cutoff.replaceAll("'", "''")}'
  AND EXISTS (
    SELECT 1 FROM json_each(i.data, '$.specification') s
    WHERE s.value = 'FHIR-core'
  )
ORDER BY i.key`;
  const out = runSqlJson(sql);
  return JSON.parse(out || "[]").map((row: any) => row.key).filter(Boolean);
}

function runSqlJson(sql: string): string {
  const proc = spawnSync("sqlite3", ["-json", "jira/data.db"], {
    cwd: repoRoot,
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
  });
  if (proc.status !== 0) {
    throw new Error([
      "sqlite3 failed",
      `exit=${proc.status}`,
      proc.stderr.trim(),
    ].filter(Boolean).join("\n"));
  }
  return proc.stdout;
}

function doneChunkIds(root: string): string[] {
  const dir = path.join(root, "chunks/done");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/, "")).sort();
}

function readPlans(runId: string): PlanRecord[] {
  const root = runPath(runId);
  const records: PlanRecord[] = [];
  for (const chunkId of doneChunkIds(root)) {
    const planPath = path.join(root, "chunks", chunkId, "plan.json");
    if (!existsSync(planPath)) continue;
    records.push({ chunkId, planPath, plan: readJson<any>(planPath) });
  }
  return records;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/reconcile-discovery.ts --run-id ID [--cutoff YYYY-MM-DD]

Validates completed discovery plans, computes coverage against Jira FHIR-core
issues updated since cutoff, and writes aggregate reports under autofhir/runs/<run>/reports.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const run = readRun(runId);
if (run.workflow !== "discovery") throw new Error(`run ${runId} is workflow=${run.workflow ?? "(unset)"}; expected discovery`);
const root = runPath(runId);
const reportsDir = path.join(root, "reports");
mkdirSync(reportsDir, { recursive: true });

const rosterPath = path.join(root, "chunks.json");
const roster = existsSync(rosterPath) ? readJson<any>(rosterPath) : {};
const cutoff = arg("--cutoff") ?? roster.cutoffDate ?? "2018-12-27";
const plans = readPlans(runId);

const validationResults = plans.map((record) => ({
  chunkId: record.chunkId,
  ...validatePlan({ runId, chunkId: record.chunkId, planPath: record.planPath, writeResult: true }),
}));
const invalid = validationResults.filter((result) => !result.ok);

const mentioned = sortedUnique(plans.flatMap((record) => record.plan.mentioned_keys ?? []));
const universe = jiraUniverse(cutoff);
const mentionedSet = new Set(mentioned);
const untouched = universe.filter((key) => !mentionedSet.has(key));

const drift = plans.flatMap((record) => (record.plan.drift ?? []).map((entry: any) => ({ ...entry, chunk_id: record.chunkId })));
const readyToApply = plans.flatMap((record) => (record.plan.ready_to_apply ?? []).map((entry: any) => ({ ...entry, chunk_id: record.chunkId })));
const openRecommendations = plans.flatMap((record) => (record.plan.open_recommendations ?? []).map((entry: any) => ({ ...entry, chunk_id: record.chunkId })));
const newProblems = plans.flatMap((record) => (record.plan.new_problems ?? []).map((entry: any) => ({ ...entry, chunk_id: record.chunkId })));
const unclear = plans.flatMap((record) => (record.plan.unclear ?? []).map((entry: any) => ({ ...entry, chunk_id: record.chunkId })));

const mentionedCte = mentioned.length
  ? `mentioned(key) AS (VALUES ${mentioned.map((key) => `('${key.replaceAll("'", "''")}')`).join(",")}),`
  : "";
const mentionedFilter = mentioned.length
  ? "AND i.key NOT IN (SELECT key FROM mentioned)"
  : "";
const untouchedByWgSql = `
WITH ${mentionedCte}
base AS (
  SELECT i.key, i.data
  FROM issues i
  WHERE json_extract(i.data, '$.updated_at') >= '${cutoff.replaceAll("'", "''")}'
    AND EXISTS (
      SELECT 1 FROM json_each(i.data, '$.specification') s
      WHERE s.value = 'FHIR-core'
    )
  ${mentionedFilter}
)
SELECT coalesce(wg.value, '(none)') AS wg, json_group_array(base.key) AS keys, count(*) AS n
FROM base
LEFT JOIN json_each(base.data, '$.work_group') wg
GROUP BY coalesce(wg.value, '(none)')
ORDER BY n DESC, wg`;
const untouchedByWg = JSON.parse(runSqlJson(untouchedByWgSql) || "[]")
  .map((row: any) => ({ wg: row.wg, keys: JSON.parse(row.keys ?? "[]"), count: row.n }));

writeJson(path.join(reportsDir, "validation.json"), validationResults);
writeJson(path.join(reportsDir, "coverage.json"), {
  schemaVersion: "1.0",
  runId,
  cutoff,
  planCount: plans.length,
  invalidPlanCount: invalid.length,
  universeCount: universe.length,
  mentionedCount: mentioned.length,
  untouchedCount: untouched.length,
  untouchedByWg,
});
writeJson(path.join(reportsDir, "untouched.json"), { cutoff, keys: untouched, byWorkGroup: untouchedByWg });
writeJson(path.join(reportsDir, "apply-queue.json"), readyToApply);
writeJson(path.join(reportsDir, "drift.json"), drift);
writeJson(path.join(reportsDir, "new-problems.json"), newProblems);
writeJson(path.join(reportsDir, "unclear.json"), unclear);

writeFileSync(path.join(reportsDir, "drift.md"), `# Applied / published drift\n\n${markdownList(drift, (entry) => `## ${entry.key ?? "(new)"} ${entry.title ?? ""}\n\n- Chunk: ${entry.chunk_id}\n- Severity: ${entry.severity ?? "(unspecified)"}\n- Evidence: ${Array.isArray(entry.evidence) ? entry.evidence.join(", ") : entry.evidence_path ?? "(missing)"}\n\n${entry.fix_sketch ?? entry.current_state ?? ""}`)}\n`);
writeFileSync(path.join(reportsDir, "open-recommendations.md"), `# Open recommendations\n\n${markdownList(openRecommendations, (entry) => `## ${entry.key} ${entry.title ?? ""}\n\n- Chunk: ${entry.chunk_id}\n- State: ${entry.state ?? "(unspecified)"}\n\n${entry.recommendation ?? ""}`)}\n`);
writeFileSync(path.join(reportsDir, "new-problems.md"), `# New problems discovered\n\n${markdownList(newProblems, (entry) => `## ${entry.title ?? "(untitled)"}\n\n- Chunk: ${entry.chunk_id}\n- Where: ${entry.where ?? "(unspecified)"}\n\n${entry.problem ?? ""}\n\nSuggested fix: ${entry.suggested_fix ?? "(none)"}\n\nDedup check: ${entry.dedup_check ?? "(missing)"}`)}\n`);

const followupDir = path.join(root, "reconciliation");
mkdirSync(followupDir, { recursive: true });
writeJson(path.join(followupDir, "untouched-followup-queue.json"), untouchedByWg.map((entry: any) => ({ chunkId: `untouched--${String(entry.wg).replace(/[^A-Za-z0-9._-]+/g, "-")}`, wg: entry.wg, keys: entry.keys })));

appendJournal(runId, {
  type: "discovery-reconciled",
  planCount: plans.length,
  invalidPlanCount: invalid.length,
  universeCount: universe.length,
  mentionedCount: mentioned.length,
  untouchedCount: untouched.length,
});

console.log(`run_id=${runId}`);
console.log(`plans=${plans.length}`);
console.log(`invalid_plans=${invalid.length}`);
console.log(`universe=${universe.length}`);
console.log(`mentioned=${mentioned.length}`);
console.log(`untouched=${untouched.length}`);
console.log(`reports=${reportsDir}`);
process.exit(invalid.length ? 1 : 0);
