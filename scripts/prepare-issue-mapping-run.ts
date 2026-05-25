#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  RunManifest,
  appendJournal,
  ensureRunDirs,
  repoRoot,
  runCommand,
  runPath,
  sanitizeId,
  writeJson,
  writeRun,
} from "./lib";

type CandidateIssue = {
  key: string;
  summary: string;
  status: string;
  resolution?: string;
  status_category?: string;
  issue_type?: string;
  work_groups: string[];
  related_pages: string[];
  related_artifacts: string[];
  raised_in_version: string[];
  applied_for_version: string[];
  updated_at: string;
  created_at: string;
  partition_id: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/prepare-issue-mapping-run.ts --run-id ID [--fhir-repo DIR] [--cutoff YYYY-MM-DD] [--limit N] [--order newest|oldest|created-newest|created-oldest|random|stratified-random] [--random-seed TEXT] [--exclude-resolved-no-change] [--exclude-unresolved] [--exclude-duplicates]

Builds an issue-centric AutofHIR run. The run starts from a global deduped Jira
candidate pool for FHIR-core issues updated after the cutoff, assigns scheduling
partitions, and queues one seed job per Jira key.

--exclude-unresolved is workflow-status based. It excludes Submitted, Triaged,
Waiting for Input, Deferred, and other non-final statuses even if Jira has a
draft Resolution value or Resolved timestamp.`);
  process.exit(0);
}

const now = new Date();
const defaultRunId = `issue-mapping-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
const runId = sanitizeId(arg("--run-id") ?? process.env.RUN_ID ?? defaultRunId);
const fhirRepo = path.resolve(arg("--fhir-repo") ?? process.env.FHIR_REPO ?? "/home/jmandel/work/fhir");
const cutoffDate = arg("--cutoff") ?? process.env.CUTOFF_DATE ?? "2018-12-27";
const description = arg("--description") ?? process.env.RUN_DESCRIPTION ?? `Map FHIR-core Jira issues to spec work from ${fhirRepo}`;
const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
const order = arg("--order") ?? process.env.ISSUE_ORDER ?? "newest";
const randomSeed = arg("--random-seed") ?? process.env.RANDOM_SEED ?? runId;
const excludeResolvedNoChange = process.argv.includes("--exclude-resolved-no-change") || process.env.EXCLUDE_RESOLVED_NO_CHANGE === "1";
const excludeUnresolved = process.argv.includes("--exclude-unresolved") || process.env.EXCLUDE_UNRESOLVED === "1";
const excludeDuplicates = process.argv.includes("--exclude-duplicates") || process.env.EXCLUDE_DUPLICATES === "1";
const jiraDb = path.resolve(arg("--jira-db") ?? process.env.FHIR_JIRA_DB ?? path.join(repoRoot, "jira/data.db"));

if (existsSync(runPath(runId))) throw new Error(`run already exists: ${runId}`);
if (!existsSync(fhirRepo)) throw new Error(`FHIR checkout not found: ${fhirRepo}`);
if (!existsSync(jiraDb)) throw new Error(`Jira DB not found: ${jiraDb}`);
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");
if (!["newest", "oldest", "created-newest", "created-oldest", "random", "stratified-random"].includes(order)) {
  throw new Error("--order must be newest, oldest, created-newest, created-oldest, random, or stratified-random");
}

const specCommit = runCommand(["git", "rev-parse", "HEAD"], { cwd: fhirRepo }).trim();

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function norm(value: string): string {
  return value.toLowerCase().replace(/^fhir-core-/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function choosePartition(issue: Omit<CandidateIssue, "partition_id">): string {
  const wg = issue.work_groups.find(Boolean) ?? "unknown";
  const page = issue.related_pages.map(norm).find(Boolean);
  const artifact = issue.related_artifacts.map(norm).find(Boolean);
  const topic = page ?? artifact ?? "general";
  return `${wg}::${topic}`;
}

function parseIssue(row: { data: string }): CandidateIssue {
  const data = JSON.parse(row.data);
  const draft = {
    key: data.key,
    summary: data.summary ?? "",
    status: data.status ?? "",
    resolution: data.resolution || undefined,
    status_category: data.status_category || undefined,
    issue_type: data.issue_type || undefined,
    work_groups: asArray(data.work_group).sort(),
    related_pages: asArray(data.related_pages).sort(),
    related_artifacts: asArray(data.related_artifacts).sort(),
    raised_in_version: asArray(data.raised_in_version).sort(),
    applied_for_version: asArray(data.applied_for_version).sort(),
    updated_at: data.updated_at ?? "",
    created_at: data.created_at ?? "",
  };
  return { ...draft, partition_id: choosePartition(draft) };
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function compareUpdatedAsc(a: CandidateIssue, b: CandidateIssue): number {
  return a.updated_at.localeCompare(b.updated_at) || a.key.localeCompare(b.key);
}

function compareUpdatedDesc(a: CandidateIssue, b: CandidateIssue): number {
  return b.updated_at.localeCompare(a.updated_at) || a.key.localeCompare(b.key);
}

function compareCreatedAsc(a: CandidateIssue, b: CandidateIssue): number {
  return a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key);
}

function compareCreatedDesc(a: CandidateIssue, b: CandidateIssue): number {
  return b.created_at.localeCompare(a.created_at) || a.key.localeCompare(b.key);
}

function orderCandidates(allCandidates: CandidateIssue[]): CandidateIssue[] {
  if (order === "newest") {
    return allCandidates.sort(compareUpdatedDesc).slice(0, limit);
  }
  if (order === "oldest") {
    return allCandidates.sort(compareUpdatedAsc).slice(0, limit);
  }
  if (order === "created-newest") {
    return allCandidates.sort(compareCreatedDesc).slice(0, limit);
  }
  if (order === "created-oldest") {
    return allCandidates.sort(compareCreatedAsc).slice(0, limit);
  }
  if (order === "random") {
    return allCandidates
      .sort((a, b) => stableHash(`${randomSeed}:${a.key}`) - stableHash(`${randomSeed}:${b.key}`) || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  const sorted = allCandidates.sort(compareUpdatedAsc);
  if (!limit || limit >= sorted.length) return sorted;
  const selected: CandidateIssue[] = [];
  for (let i = 0; i < limit; i++) {
    const start = Math.floor((i * sorted.length) / limit);
    const end = Math.max(start + 1, Math.floor(((i + 1) * sorted.length) / limit));
    const bucket = sorted.slice(start, end);
    const pick = stableHash(`${randomSeed}:bucket:${i}`) % bucket.length;
    selected.push(bucket[pick]);
  }
  return selected;
}

const db = new Database(jiraDb, { readonly: true });
const filters = [
  excludeResolvedNoChange ? "AND json_extract(i.data, '$.status') != 'Resolved - No Change'" : "",
  excludeUnresolved ? "AND json_extract(i.data, '$.status') IN ('Resolved - change required', 'Applied', 'Published', 'Resolved - No Change')" : "",
  excludeDuplicates ? "AND json_extract(i.data, '$.status') != 'Duplicate' AND COALESCE(json_extract(i.data, '$.resolution'), '') != 'Duplicate'" : "",
].filter(Boolean).join("\n    ");
const rows = db.query(`
  SELECT data
  FROM issues i
  WHERE EXISTS (
    SELECT 1
    FROM json_each(i.data, '$.specification') spec
    WHERE spec.value = 'FHIR-core'
  )
    AND COALESCE(json_extract(i.data, '$.updated_at'), '') >= $cutoff
    ${filters}
`).all({ $cutoff: cutoffDate }) as { data: string }[];
db.close();

const allCandidates = rows.map(parseIssue);
const candidates = orderCandidates(allCandidates);
ensureRunDirs(runId);
const root = runPath(runId);
for (const dir of [
  "candidate-pool",
  "seeds/pending",
  "seeds/running",
  "seeds/done",
  "seeds/failed",
  "seeds/blocked",
  "seed-runs",
  "issue-observations",
]) {
  mkdirSync(path.join(root, dir), { recursive: true });
}

writeJson(path.join(root, "candidate-pool/issues.json"), {
  schema_version: "issue-mapping-candidate-pool-v1",
  run_id: runId,
  cutoff_date: cutoffDate,
  order,
  exclude_resolved_no_change: excludeResolvedNoChange,
  exclude_unresolved: excludeUnresolved,
  exclude_duplicates: excludeDuplicates,
  random_seed: ["random", "stratified-random"].includes(order) ? randomSeed : undefined,
  source_candidate_count: allCandidates.length,
  candidate_count: candidates.length,
  candidates,
});

const header = [
  "key",
  "summary",
  "status",
  "resolution",
  "status_category",
  "work_groups",
  "related_pages",
  "related_artifacts",
  "updated_at",
  "partition_id",
];
const tsv = [
  header.join("\t"),
  ...candidates.map((issue) => [
    issue.key,
    issue.summary.replace(/\s+/g, " "),
    issue.status,
    issue.resolution ?? "",
    issue.status_category ?? "",
    issue.work_groups.join(","),
    issue.related_pages.join(","),
    issue.related_artifacts.join(","),
    issue.updated_at,
    issue.partition_id,
  ].map((value) => String(value).replace(/\t/g, " ")).join("\t")),
].join("\n");
writeFileSync(path.join(root, "candidate-pool/issues.tsv"), `${tsv}\n`);

for (const candidate of candidates) {
  writeJson(path.join(root, "seeds/pending", `${candidate.key}.json`), {
    schema_version: "issue-mapping-seed-v1",
    run_id: runId,
    seed_key: candidate.key,
    partition_id: candidate.partition_id,
    candidate,
    cutoff_date: cutoffDate,
    spec_commit: specCommit,
  });
}

const run: RunManifest = {
  schemaVersion: "1.0",
  runId,
  createdAt: now.toISOString(),
  description,
  workflow: "issue-mapping",
  chunkSource: {
    kind: "jira-global-candidate-pool",
    path: jiraDb,
  },
  chunkCount: candidates.length,
  fhirRepo,
  baseRef: "HEAD",
  baseSha: specCommit,
  combinedBranch: process.env.COMBINED_BRANCH ?? `robo-spec-combined-${runId}`,
  status: "prepared",
};
writeRun(run);
appendJournal(runId, {
  type: "issue-mapping-run-prepared",
  candidateCount: candidates.length,
  sourceCandidateCount: allCandidates.length,
  cutoffDate,
  order,
  excludeResolvedNoChange,
  excludeUnresolved,
  excludeDuplicates,
  randomSeed: ["random", "stratified-random"].includes(order) ? randomSeed : undefined,
  specCommit,
});

console.log(`run_id=${runId}`);
console.log(`workflow=issue-mapping`);
console.log(`spec_commit=${specCommit}`);
console.log(`order=${order}`);
console.log(`exclude_resolved_no_change=${excludeResolvedNoChange}`);
console.log(`exclude_unresolved=${excludeUnresolved}`);
console.log(`exclude_duplicates=${excludeDuplicates}`);
if (["random", "stratified-random"].includes(order)) console.log(`random_seed=${randomSeed}`);
console.log(`source_candidate_count=${allCandidates.length}`);
console.log(`candidate_count=${candidates.length}`);
console.log(`candidate_pool=${path.join(root, "candidate-pool/issues.tsv")}`);
console.log(`run_dir=${root}`);
