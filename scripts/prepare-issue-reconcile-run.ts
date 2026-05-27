#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

type IssueObservation = {
  schema_version?: string;
  run_id?: string;
  observation_id?: string;
  seed_key?: string;
  issue_key?: string;
  role?: string;
  decision?: any;
  result_path?: string;
  created_at?: string;
};

type ReconcileContext = {
  schema_version: "issue-reconcile-context-v1";
  run_id: string;
  seed_key: string;
  candidate: CandidateIssue;
  seed_scope: "applied-published" | "applied-published-resolved-change-required" | "unrestricted";
  source_runs: string[];
  selected_because: string;
  observations: IssueObservation[];
  related_jira_keys: string[];
  source_paths: string[];
  target_chunks: string[];
  zulip_refs: { stream: string; topic: string; message_id?: string | number }[];
  confluence_refs: { page_id: string | number; locator?: string }[];
  snapshot_paths: {
    jira: Record<string, string>;
    zulip: Record<string, string>;
    confluence: Record<string, string>;
  };
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function args(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1]);
  }
  return values;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/prepare-issue-reconcile-run.ts --run-id ID [--fhir-repo DIR] [--base-ref REF] [--cutoff YYYY-MM-DD] [--limit N] [--order newest|oldest|created-newest|created-oldest|random|stratified-random] [--random-seed TEXT] [--issue-key FHIR-XXXXX ...] [--issue-keys-file FILE ...] [--work-group WG ...] [--exclude-issue FHIR-XXXXX ...] [--exclude-issues-file FILE ...] [--allow-prior-observations --source-run ID ...] [--include-resolved-change-required] [--include-unresolved] [--include-duplicates] [--include-resolved-no-change] [--no-snapshots]

Builds a discovery-with-autofix issue reconciliation run. Each seed starts from
one filtered FHIR-core Jira issue. By default, seeds are limited to Jira
workflow statuses Applied and Published. Use --include-resolved-change-required
only for an explicitly broader experiment. Prior issue-mapping observations are
excluded by default; --source-run requires --allow-prior-observations. The
worker may decide tightly related issues discovered during its investigation and
publish one commit per issue.

--issue-keys-file and --exclude-issues-file accept one Jira key per line,
whitespace/comma-separated keys, and # comments. Include filters are applied in
the Jira query. Exclusions are applied after the Jira status/work-group filters
and before ordering/limit.`);
  process.exit(0);
}

const now = new Date();
const runId = sanitizeId(arg("--run-id") ?? process.env.RUN_ID ?? `issue-reconcile-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}`);
const fhirRepo = path.resolve(arg("--fhir-repo") ?? process.env.FHIR_REPO ?? "/home/jmandel/work/fhir");
const baseRef = arg("--base-ref") ?? process.env.BASE_REF ?? "master";
const cutoffDate = arg("--cutoff") ?? process.env.CUTOFF_DATE ?? "2018-12-27";
const description = arg("--description") ?? process.env.RUN_DESCRIPTION ?? `Reconcile FHIR-core Jira issues against ${fhirRepo}`;
const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
const order = arg("--order") ?? process.env.ISSUE_ORDER ?? "random";
const randomSeed = arg("--random-seed") ?? process.env.RANDOM_SEED ?? runId;
const includeResolvedChangeRequired = process.argv.includes("--include-resolved-change-required") || process.env.INCLUDE_RESOLVED_CHANGE_REQUIRED === "1";
const includeUnresolved = process.argv.includes("--include-unresolved") || process.env.INCLUDE_UNRESOLVED === "1";
const includeDuplicates = process.argv.includes("--include-duplicates") || process.env.INCLUDE_DUPLICATES === "1";
const includeResolvedNoChange = process.argv.includes("--include-resolved-no-change") || process.env.INCLUDE_RESOLVED_NO_CHANGE === "1";
const noSnapshots = process.argv.includes("--no-snapshots") || process.env.NO_SNAPSHOTS === "1";
const allowPriorObservations = process.argv.includes("--allow-prior-observations") || process.env.ALLOW_PRIOR_OBSERVATIONS === "1";
const maxRelatedJiras = Number(arg("--max-related-jiras") ?? process.env.MAX_RELATED_JIRAS ?? "20");
const jiraDb = path.resolve(arg("--jira-db") ?? process.env.FHIR_JIRA_DB ?? path.join(repoRoot, "jira/data.db"));
const combinedBranch = arg("--combined-branch") ?? process.env.COMBINED_BRANCH ?? `robo-spec-combined-${runId}`;
const requestedIssueKeyFiles = [
  ...args("--issue-keys-file"),
  ...(arg("--issue-keys-files") ?? process.env.ISSUE_KEYS_FILES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ...(process.env.ISSUE_KEYS_FILE ? [process.env.ISSUE_KEYS_FILE] : []),
].map((file) => path.resolve(file));
const requestedIssueKeys = [...new Set([
  ...args("--issue-key"),
  ...(arg("--issue-keys") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ...requestedIssueKeyFiles.flatMap((file) => {
    if (!existsSync(file)) throw new Error(`issue keys file not found: ${file}`);
    return parseIssueKeysFromText(readFileSync(file, "utf8"), file);
  }),
])];
const requestedExcludeIssueKeys = [...new Set([
  ...args("--exclude-issue"),
  ...args("--exclude-issue-key"),
  ...(arg("--exclude-issues") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ...(arg("--exclude-issue-keys") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
])];
const excludeIssueFiles = [
  ...args("--exclude-issues-file"),
  ...(arg("--exclude-issues-files") ?? process.env.EXCLUDE_ISSUES_FILES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ...(process.env.EXCLUDE_ISSUES_FILE ? [process.env.EXCLUDE_ISSUES_FILE] : []),
].map((file) => path.resolve(file));
const requestedWorkGroups = [
  ...args("--work-group"),
  ...(arg("--work-groups") ?? process.env.WORK_GROUPS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
].map((value) => value.toLowerCase());
const sourceRuns = [
  ...args("--source-run"),
  ...(arg("--source-runs") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
].filter(Boolean);
if (sourceRuns.length > 0 && !allowPriorObservations) {
  throw new Error("--source-run is disabled by default for issue-reconcile; pass --allow-prior-observations only for explicit comparison/triage-seeded experiments");
}

if (existsSync(runPath(runId))) throw new Error(`run already exists: ${runPath(runId)}`);
if (!existsSync(fhirRepo)) throw new Error(`FHIR checkout not found: ${fhirRepo}`);
if (!existsSync(jiraDb)) throw new Error(`Jira DB not found: ${jiraDb}`);
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");
if (!Number.isInteger(maxRelatedJiras) || maxRelatedJiras < 1) throw new Error("--max-related-jiras must be a positive integer");
if (!["newest", "oldest", "created-newest", "created-oldest", "random", "stratified-random"].includes(order)) {
  throw new Error("--order must be newest, oldest, created-newest, created-oldest, random, or stratified-random");
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function parseIssueKeysFromText(text: string, source: string): string[] {
  const keys: string[] = [];
  const invalid = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    for (const token of line.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean)) {
      if (/^FHIR-\d+$/.test(token)) {
        keys.push(token);
      } else {
        invalid.add(token);
      }
    }
  }
  if (invalid.size > 0) throw new Error(`invalid issue key(s) in ${source}: ${[...invalid].join(", ")}`);
  return keys;
}

function readExcludedIssueKeys(): Set<string> {
  const excluded = new Set<string>();
  for (const key of requestedExcludeIssueKeys) {
    if (!/^FHIR-\d+$/.test(key)) throw new Error(`invalid --exclude-issue key: ${key}`);
    excluded.add(key);
  }
  for (const file of excludeIssueFiles) {
    if (!existsSync(file)) throw new Error(`exclude issue file not found: ${file}`);
    for (const key of parseIssueKeysFromText(readFileSync(file, "utf8"), file)) excluded.add(key);
  }
  return excluded;
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

function orderCandidates(allCandidates: CandidateIssue[]): CandidateIssue[] {
  const compareUpdatedAsc = (a: CandidateIssue, b: CandidateIssue) => a.updated_at.localeCompare(b.updated_at) || a.key.localeCompare(b.key);
  const compareUpdatedDesc = (a: CandidateIssue, b: CandidateIssue) => b.updated_at.localeCompare(a.updated_at) || a.key.localeCompare(b.key);
  const compareCreatedAsc = (a: CandidateIssue, b: CandidateIssue) => a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key);
  const compareCreatedDesc = (a: CandidateIssue, b: CandidateIssue) => b.created_at.localeCompare(a.created_at) || a.key.localeCompare(b.key);
  if (order === "newest") return allCandidates.sort(compareUpdatedDesc).slice(0, limit);
  if (order === "oldest") return allCandidates.sort(compareUpdatedAsc).slice(0, limit);
  if (order === "created-newest") return allCandidates.sort(compareCreatedDesc).slice(0, limit);
  if (order === "created-oldest") return allCandidates.sort(compareCreatedAsc).slice(0, limit);
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

function readObservations(sourceRun: string): IssueObservation[] {
  const file = path.join(repoRoot, "autofhir/runs", sourceRun, "issue-observations", "all.ndjson");
  if (!existsSync(file)) return [];
  const rows: IssueObservation[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as IssueObservation;
      if (parsed.issue_key && parsed.decision) rows.push(parsed);
    } catch {
      // Historical malformed lines are not useful for prompt context.
    }
  }
  return rows;
}

function collectObservationsByIssue(): Map<string, IssueObservation[]> {
  const byIssue = new Map<string, IssueObservation[]>();
  for (const sourceRun of sourceRuns) {
    for (const observation of readObservations(sourceRun)) {
      const key = observation.issue_key;
      if (!key) continue;
      const bucket = byIssue.get(key) ?? [];
      bucket.push(observation);
      byIssue.set(key, bucket);
    }
  }
  return byIssue;
}

function addJiraKeysFromText(keys: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\bFHIR-\d+\b/g)) keys.add(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addJiraKeysFromText(keys, item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) addJiraKeysFromText(keys, item);
  }
}

function collectRelatedJiras(issueKey: string, observations: IssueObservation[]): string[] {
  const keys = new Set<string>([issueKey]);
  for (const observation of observations) {
    const decision = observation.decision ?? {};
    if (decision.key && /^FHIR-\d+$/.test(decision.key)) keys.add(decision.key);
    for (const related of decision.related_jiras ?? []) {
      if (related?.key && /^FHIR-\d+$/.test(related.key)) keys.add(related.key);
    }
    for (const evidence of decision.evidence_items ?? []) {
      const key = evidence?.ref?.jira_key;
      if (key && /^FHIR-\d+$/.test(String(key))) keys.add(String(key));
    }
    addJiraKeysFromText(keys, decision.reasoning);
    addJiraKeysFromText(keys, decision.recommendation);
    addJiraKeysFromText(keys, decision.evidence);
  }
  return [issueKey, ...[...keys].filter((key) => key !== issueKey).sort()].slice(0, maxRelatedJiras);
}

function collectSourcePaths(observations: IssueObservation[]): string[] {
  const paths = new Set<string>();
  for (const observation of observations) {
    const decision = observation.decision ?? {};
    for (const sourcePath of decision.source_paths ?? []) {
      if (typeof sourcePath === "string" && sourcePath.length > 0) paths.add(sourcePath);
    }
    for (const evidence of decision.evidence_items ?? []) {
      const sourcePath = evidence?.ref?.source_path;
      if (typeof sourcePath === "string" && sourcePath.length > 0) paths.add(sourcePath);
    }
  }
  return [...paths].sort();
}

function collectTargetChunks(observations: IssueObservation[]): string[] {
  const chunks = new Set<string>();
  for (const observation of observations) {
    for (const chunk of observation.decision?.target_chunks ?? []) {
      if (typeof chunk === "string" && chunk.length > 0) chunks.add(chunk);
    }
  }
  return [...chunks].sort();
}

function collectZulipRefs(observations: IssueObservation[]): { stream: string; topic: string; message_id?: string | number }[] {
  const seen = new Set<string>();
  const refs: { stream: string; topic: string; message_id?: string | number }[] = [];
  for (const observation of observations) {
    for (const evidence of observation.decision?.evidence_items ?? []) {
      const ref = evidence?.ref;
      const stream = ref?.zulip_stream;
      const topic = ref?.zulip_topic;
      if (!stream || !topic) continue;
      const key = `${stream}\t${topic}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ stream: String(stream), topic: String(topic), message_id: ref.zulip_message_id });
    }
  }
  return refs;
}

function collectConfluenceRefs(observations: IssueObservation[]): { page_id: string | number; locator?: string }[] {
  const seen = new Set<string>();
  const refs: { page_id: string | number; locator?: string }[] = [];
  for (const observation of observations) {
    for (const evidence of observation.decision?.evidence_items ?? []) {
      const ref = evidence?.ref;
      const pageId = ref?.confluence_page_id;
      if (!pageId) continue;
      const key = String(pageId);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ page_id: pageId, locator: evidence.locator });
    }
  }
  return refs;
}

function snapshot(file: string, command: string[], cwd = repoRoot): string {
  if (existsSync(file)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const output = runCommand(command, { cwd, allowFailure: true });
  writeFileSync(file, output.trim() ? output : `Snapshot command returned no content.\nCommand: ${command.join(" ")}\n`);
  return file;
}

const db = new Database(jiraDb, { readonly: true });
const statusFilter = includeUnresolved
  ? ""
  : includeResolvedChangeRequired
    ? "AND json_extract(i.data, '$.status') IN ('Resolved - change required', 'Applied', 'Published')"
    : "AND json_extract(i.data, '$.status') IN ('Applied', 'Published')";
const filters = [
  statusFilter,
  includeResolvedNoChange ? "" : "AND json_extract(i.data, '$.status') != 'Resolved - No Change'",
  includeDuplicates ? "" : "AND json_extract(i.data, '$.status') != 'Duplicate' AND COALESCE(json_extract(i.data, '$.resolution'), '') != 'Duplicate'",
].filter(Boolean).join("\n    ");
const requestedFilter = requestedIssueKeys.length > 0
  ? `AND json_extract(i.data, '$.key') IN (${requestedIssueKeys.map((_, i) => `$key${i}`).join(", ")})`
  : "";
const workGroupFilter = requestedWorkGroups.length > 0
  ? `AND EXISTS (
    SELECT 1
    FROM json_each(i.data, '$.work_group') wg
    WHERE lower(wg.value) IN (${requestedWorkGroups.map((_, i) => `$wg${i}`).join(", ")})
  )`
  : "";
const params: Record<string, string> = { $cutoff: cutoffDate };
requestedIssueKeys.forEach((key, i) => params[`$key${i}`] = key);
requestedWorkGroups.forEach((wg, i) => params[`$wg${i}`] = wg);
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
    ${requestedFilter}
    ${workGroupFilter}
`).all(params) as { data: string }[];
db.close();

const excludedIssueKeys = readExcludedIssueKeys();
const allCandidates = rows.map(parseIssue);
const excludedSelectedCandidates = allCandidates.filter((candidate) => excludedIssueKeys.has(candidate.key));
const eligibleCandidates = excludedIssueKeys.size > 0
  ? allCandidates.filter((candidate) => !excludedIssueKeys.has(candidate.key))
  : allCandidates;
const candidates = orderCandidates(eligibleCandidates);
const missing = requestedIssueKeys.filter((key) => !candidates.some((candidate) => candidate.key === key));
if (missing.length > 0) {
  const missingNotExcluded = missing.filter((key) => !excludedIssueKeys.has(key));
  if (missingNotExcluded.length > 0) {
    throw new Error(`requested issue keys were not selected by the current filters: ${missingNotExcluded.join(", ")}`);
  }
}

ensureRunDirs(runId);
const root = runPath(runId);
for (const dir of ["contexts", "candidate-pool"]) mkdirSync(path.join(root, dir), { recursive: true });

const baseSha = runCommand(["git", "rev-parse", baseRef], { cwd: fhirRepo }).trim();
if (!runCommand(["git", "rev-parse", "--verify", "--quiet", combinedBranch], { cwd: fhirRepo, allowFailure: true }).trim()) {
  runCommand(["git", "branch", combinedBranch, baseSha], { cwd: fhirRepo });
}

const observationsByIssue = collectObservationsByIssue();
const candidateRows: any[] = [];
for (const candidate of candidates) {
  const seedKey = candidate.key;
  const issueDir = path.join(root, "contexts", seedKey);
  const jiraDir = path.join(issueDir, "jira");
  const zulipDir = path.join(issueDir, "zulip");
  const confluenceDir = path.join(issueDir, "confluence");
  mkdirSync(jiraDir, { recursive: true });
  mkdirSync(zulipDir, { recursive: true });
  mkdirSync(confluenceDir, { recursive: true });

  const observations = observationsByIssue.get(seedKey) ?? [];
  const relatedJiras = collectRelatedJiras(seedKey, observations);
  const sourcePaths = collectSourcePaths(observations);
  const targetChunks = collectTargetChunks(observations);
  const zulipRefs = collectZulipRefs(observations);
  const confluenceRefs = collectConfluenceRefs(observations);
  const snapshotPaths: ReconcileContext["snapshot_paths"] = { jira: {}, zulip: {}, confluence: {} };

  if (!noSnapshots) {
    for (const key of relatedJiras) {
      const file = path.join(jiraDir, `${key}.md`);
      snapshotPaths.jira[key] = path.relative(root, snapshot(file, ["bun", "jira/search.ts", "snapshot", key]));
    }
    for (const ref of zulipRefs) {
      const id = sanitizeId(`${ref.stream}--${ref.topic}`);
      const file = path.join(zulipDir, `${id}.md`);
      snapshotPaths.zulip[id] = path.relative(root, snapshot(file, ["bun", "zulip/search.ts", "snapshot", ref.stream, ref.topic]));
    }
    for (const ref of confluenceRefs) {
      const id = String(ref.page_id);
      const file = path.join(confluenceDir, `${id}.md`);
      snapshotPaths.confluence[id] = path.relative(root, snapshot(file, ["bun", "confluence/search.ts", "snapshot", id]));
    }
  }

  const context: ReconcileContext = {
    schema_version: "issue-reconcile-context-v1",
    run_id: runId,
    seed_key: seedKey,
    candidate,
    seed_scope: includeUnresolved
      ? "unrestricted"
      : includeResolvedChangeRequired
        ? "applied-published-resolved-change-required"
        : "applied-published",
    source_runs: sourceRuns,
    selected_because: includeResolvedChangeRequired
      ? "FHIR-core issue updated after cutoff and in the explicitly broad Applied/Published/Resolved-change-required seed pool."
      : "FHIR-core issue updated after cutoff and in the default Applied/Published Jira workflow seed pool.",
    observations,
    related_jira_keys: relatedJiras,
    source_paths: sourcePaths,
    target_chunks: targetChunks,
    zulip_refs: zulipRefs,
    confluence_refs: confluenceRefs,
    snapshot_paths: snapshotPaths,
  };
  const contextPath = path.join(issueDir, "context.json");
  writeJson(contextPath, context);

  writeJson(path.join(root, "chunks/pending", `${seedKey}.json`), {
    schemaVersion: "1.0",
    runId,
    chunkId: seedKey,
    workflow: "issue-reconcile",
    title: `Issue reconcile seed ${seedKey}`,
    sourceKind: includeResolvedChangeRequired ? "jira-applied-published-resolved-change-required-seed" : "jira-applied-published-seed",
    seedKey,
    issueKey: seedKey,
    contextPath: path.relative(repoRoot, contextPath),
    sourceRuns,
    sourcePaths,
    targetChunks,
    relatedJiraKeys: relatedJiras,
    specCommit: baseSha,
    candidate,
  });

  candidateRows.push({
    key: seedKey,
    summary: candidate.summary,
    status: candidate.status,
    resolution: candidate.resolution ?? "",
    work_groups: candidate.work_groups,
    related_pages: candidate.related_pages,
    related_artifacts: candidate.related_artifacts,
    updated_at: candidate.updated_at,
    created_at: candidate.created_at,
    partition_id: candidate.partition_id,
    observation_count: observations.length,
    related_jira_count: relatedJiras.length,
    source_paths: sourcePaths,
    context_path: path.relative(root, contextPath),
  });
}

writeJson(path.join(root, "candidate-pool/issues.json"), {
  schema_version: "issue-reconcile-candidate-pool-v1",
  run_id: runId,
  cutoff_date: cutoffDate,
  order,
  include_unresolved: includeUnresolved,
  include_resolved_change_required: includeResolvedChangeRequired,
  include_duplicates: includeDuplicates,
  include_resolved_no_change: includeResolvedNoChange,
  work_groups_filter: requestedWorkGroups,
  issue_key_files: requestedIssueKeyFiles.map((file) => path.relative(repoRoot, file)),
  exclude_issue_files: excludeIssueFiles.map((file) => path.relative(repoRoot, file)),
  excluded_issue_count: excludedIssueKeys.size,
  excluded_selected_candidate_count: excludedSelectedCandidates.length,
  excluded_selected_issue_keys: excludedSelectedCandidates.map((candidate) => candidate.key).sort(),
  random_seed: ["random", "stratified-random"].includes(order) ? randomSeed : undefined,
  source_candidate_count: allCandidates.length,
  eligible_candidate_count: eligibleCandidates.length,
  candidate_count: candidates.length,
  candidates: candidateRows,
});

writeFileSync(path.join(root, "candidate-pool/issues.tsv"), [
  "key\tsummary\tstatus\tresolution\twork_groups\trelated_pages\trelated_artifacts\tupdated_at\tcreated_at\tpartition_id\tobservation_count\trelated_jira_count\tsource_paths\tcontext_path",
  ...candidateRows.map((candidate) => [
    candidate.key,
    candidate.summary.replace(/\s+/g, " "),
    candidate.status,
    candidate.resolution,
    candidate.work_groups.join(","),
    candidate.related_pages.join(","),
    candidate.related_artifacts.join(","),
    candidate.updated_at,
    candidate.created_at,
    candidate.partition_id,
    candidate.observation_count,
    candidate.related_jira_count,
    candidate.source_paths.join(","),
    candidate.context_path,
  ].map((value) => String(value).replace(/\t/g, " ")).join("\t")),
].join("\n") + "\n");

const run: RunManifest = {
  schemaVersion: "1.0",
  runId,
  createdAt: now.toISOString(),
  description,
  workflow: "issue-reconcile",
  chunkSource: {
    kind: includeResolvedChangeRequired ? "jira-applied-published-resolved-change-required-candidate-pool" : "jira-applied-published-candidate-pool",
    path: jiraDb,
  },
  chunkCount: candidates.length,
  fhirRepo,
  baseRef,
  baseSha,
  combinedBranch,
  status: "initialized",
};
writeRun(run);
appendJournal(runId, {
  type: "issue-reconcile-run-prepared",
  candidateCount: candidates.length,
  sourceCandidateCount: allCandidates.length,
  eligibleCandidateCount: eligibleCandidates.length,
  excludedIssueCount: excludedIssueKeys.size,
  excludedSelectedCandidateCount: excludedSelectedCandidates.length,
  requestedIssueKeyFiles,
  excludeIssueFiles,
  requestedIssueKeys,
  requestedWorkGroups,
  sourceRuns,
  cutoffDate,
  order,
  randomSeed: ["random", "stratified-random"].includes(order) ? randomSeed : undefined,
  includeResolvedChangeRequired,
  includeUnresolved,
  includeDuplicates,
  includeResolvedNoChange,
  noSnapshots,
  maxRelatedJiras,
  baseRef,
  baseSha,
  combinedBranch,
});

console.log(`run_id=${runId}`);
console.log("workflow=issue-reconcile");
console.log(`candidate_count=${candidates.length}`);
console.log(`source_candidate_count=${allCandidates.length}`);
console.log(`eligible_candidate_count=${eligibleCandidates.length}`);
console.log(`excluded_issue_count=${excludedIssueKeys.size}`);
console.log(`excluded_selected_candidate_count=${excludedSelectedCandidates.length}`);
console.log(`order=${order}`);
console.log(`cutoff=${cutoffDate}`);
console.log(`include_resolved_change_required=${includeResolvedChangeRequired}`);
console.log(`include_unresolved=${includeUnresolved}`);
console.log(`include_duplicates=${includeDuplicates}`);
console.log(`include_resolved_no_change=${includeResolvedNoChange}`);
if (requestedWorkGroups.length > 0) console.log(`work_groups=${requestedWorkGroups.join(",")}`);
if (requestedIssueKeyFiles.length > 0) console.log(`issue_key_files=${requestedIssueKeyFiles.join(",")}`);
if (excludeIssueFiles.length > 0) console.log(`exclude_issue_files=${excludeIssueFiles.join(",")}`);
if (sourceRuns.length > 0) console.log(`source_runs=${sourceRuns.join(",")}`);
console.log(`candidate_pool=${path.join(root, "candidate-pool/issues.tsv")}`);
console.log(`combined_branch=${combinedBranch}`);
console.log(`run_dir=${root}`);
