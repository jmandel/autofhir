#!/usr/bin/env bun

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

type FixupContext = {
  schema_version: "issue-fixup-context-v1";
  run_id: string;
  issue_key: string;
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
  console.log(`Usage: bun autofhir/scripts/prepare-issue-fixup-run.ts --run-id ID [--source-run ID ...] [--source-runs A,B] [--issue-key FHIR-XXXXX ...] [--issue-keys A,B] [--include-explicit-non-misapplied] [--fhir-repo DIR] [--base-ref REF] [--limit N] [--no-snapshots]

Builds an issue-fixup run from issue-mapping observations. Each issue that was
ever assessed as not-fully-applied becomes one queued fixup item. The context
generator gathers all observations for that issue, likely source paths, related
Jira keys, and best-effort Jira/Zulip/Confluence snapshots.`);
  process.exit(0);
}

const now = new Date();
const runId = sanitizeId(arg("--run-id") ?? process.env.RUN_ID ?? `issue-fixup-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}`);
const fhirRepo = path.resolve(arg("--fhir-repo") ?? process.env.FHIR_REPO ?? "/home/jmandel/work/fhir");
const baseRef = arg("--base-ref") ?? process.env.BASE_REF ?? "master";
const description = arg("--description") ?? process.env.RUN_DESCRIPTION ?? "Fix or audit issue-mapping issues assessed as not fully applied";
const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
const maxRelatedJiras = Number(arg("--max-related-jiras") ?? process.env.MAX_RELATED_JIRAS ?? "20");
const noSnapshots = process.argv.includes("--no-snapshots") || process.env.NO_SNAPSHOTS === "1";
const combinedBranch = arg("--combined-branch") ?? process.env.COMBINED_BRANCH ?? `robo-spec-combined-${runId}`;
const includeExplicitNonMisapplied = process.argv.includes("--include-explicit-non-misapplied") || process.env.INCLUDE_EXPLICIT_NON_MISAPPLIED === "1";
const requestedIssueKeys = [
  ...args("--issue-key"),
  ...(arg("--issue-keys") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
];

if (existsSync(runPath(runId))) throw new Error(`run already exists: ${runPath(runId)}`);
if (!existsSync(fhirRepo)) throw new Error(`FHIR checkout not found: ${fhirRepo}`);
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");
if (!Number.isInteger(maxRelatedJiras) || maxRelatedJiras < 1) throw new Error("--max-related-jiras must be a positive integer");

function sourceRunIds(): string[] {
  const explicit = [
    ...args("--source-run"),
    ...(arg("--source-runs") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  ];
  if (explicit.length > 0) return [...new Set(explicit)].sort();
  const runsDir = path.join(repoRoot, "autofhir/runs");
  return readdirSync(runsDir)
    .filter((name) => existsSync(path.join(runsDir, name, "issue-observations", "all.ndjson")))
    .sort();
}

function readObservations(sourceRun: string): IssueObservation[] {
  const file = path.join(repoRoot, "autofhir/runs", sourceRun, "issue-observations", "all.ndjson");
  if (!existsSync(file)) throw new Error(`source run has no issue observations: ${sourceRun}`);
  const rows: IssueObservation[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as IssueObservation;
      if (parsed.issue_key && parsed.decision) rows.push(parsed);
    } catch {
      // Ignore malformed historical lines; this script only consumes valid observations.
    }
  }
  return rows;
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
    for (const prior of decision.prior_decisions ?? []) {
      if (typeof prior?.locator === "string") addJiraKeysFromText(keys, prior.locator);
    }
    addJiraKeysFromText(keys, decision.reasoning);
    addJiraKeysFromText(keys, decision.recommendation);
    addJiraKeysFromText(keys, decision.evidence);
  }
  const all = [...keys];
  return [
    issueKey,
    ...all.filter((key) => key !== issueKey).sort(),
  ].slice(0, maxRelatedJiras);
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

const sourceRuns = sourceRunIds();
if (sourceRuns.length === 0) throw new Error("no issue-mapping source runs found");

const allByIssue = new Map<string, IssueObservation[]>();
for (const sourceRun of sourceRuns) {
  for (const observation of readObservations(sourceRun)) {
    const key = observation.issue_key;
    if (!key) continue;
    const bucket = allByIssue.get(key) ?? [];
    bucket.push(observation);
    allByIssue.set(key, bucket);
  }
}

const selectedIssueKeys = requestedIssueKeys.length > 0
  ? [...new Set(requestedIssueKeys)].filter((key) => {
    const observations = allByIssue.get(key) ?? [];
    if (includeExplicitNonMisapplied) return observations.length > 0;
    return observations.some((observation) => observation.decision?.assessment === "not-fully-applied");
  })
  : [...allByIssue.entries()]
    .filter(([, observations]) => observations.some((observation) => observation.decision?.assessment === "not-fully-applied"))
    .map(([key]) => key)
    .sort((a, b) => Number(b.replace("FHIR-", "")) - Number(a.replace("FHIR-", "")) || a.localeCompare(b))
    .slice(0, limit);

if (requestedIssueKeys.length > 0) {
  const missing = [...new Set(requestedIssueKeys)].filter((key) => !selectedIssueKeys.includes(key));
  if (missing.length > 0) {
    const reason = includeExplicitNonMisapplied
      ? "requested issue keys not found in source observations"
      : "requested issue keys not found with a not-fully-applied observation";
    throw new Error(`${reason}: ${missing.join(", ")}`);
  }
}

ensureRunDirs(runId);
const root = runPath(runId);
for (const dir of ["contexts", "candidate-pool"]) mkdirSync(path.join(root, dir), { recursive: true });

const baseSha = runCommand(["git", "rev-parse", baseRef], { cwd: fhirRepo }).trim();
if (!runCommand(["git", "rev-parse", "--verify", "--quiet", combinedBranch], { cwd: fhirRepo, allowFailure: true }).trim()) {
  runCommand(["git", "branch", combinedBranch, baseSha], { cwd: fhirRepo });
}

const candidates: any[] = [];
for (const issueKey of selectedIssueKeys) {
  const issueDir = path.join(root, "contexts", issueKey);
  const jiraDir = path.join(issueDir, "jira");
  const zulipDir = path.join(issueDir, "zulip");
  const confluenceDir = path.join(issueDir, "confluence");
  mkdirSync(jiraDir, { recursive: true });
  mkdirSync(zulipDir, { recursive: true });
  mkdirSync(confluenceDir, { recursive: true });

  const observations = allByIssue.get(issueKey) ?? [];
  const relatedJiras = collectRelatedJiras(issueKey, observations);
  const sourcePaths = collectSourcePaths(observations);
  const targetChunks = collectTargetChunks(observations);
  const zulipRefs = collectZulipRefs(observations);
  const confluenceRefs = collectConfluenceRefs(observations);

  const snapshotPaths: FixupContext["snapshot_paths"] = { jira: {}, zulip: {}, confluence: {} };
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

  const context: FixupContext = {
    schema_version: "issue-fixup-context-v1",
    run_id: runId,
    issue_key: issueKey,
    source_runs: sourceRuns,
    selected_because: "At least one issue-mapping observation assessed this issue as not-fully-applied.",
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

  const chunk = {
    schemaVersion: "1.0",
    runId,
    chunkId: issueKey,
    workflow: "issue-fixup",
    title: `Issue fixup for ${issueKey}`,
    sourceKind: "issue-mapping-not-fully-applied",
    issueKey,
    contextPath: path.relative(repoRoot, contextPath),
    sourceRuns,
    sourcePaths,
    targetChunks,
    relatedJiraKeys: relatedJiras,
    specCommit: baseSha,
  };
  writeJson(path.join(root, "chunks/pending", `${issueKey}.json`), chunk);
  candidates.push({
    issue_key: issueKey,
    observation_count: observations.length,
    related_jira_count: relatedJiras.length,
    source_paths: sourcePaths,
    target_chunks: targetChunks,
    context_path: path.relative(root, contextPath),
  });
}

writeJson(path.join(root, "candidate-pool/issues.json"), {
  schema_version: "issue-fixup-candidate-pool-v1",
  run_id: runId,
  source_runs: sourceRuns,
  selected_issue_count: selectedIssueKeys.length,
  candidates,
});
writeFileSync(path.join(root, "candidate-pool/issues.tsv"), [
  "issue_key\tobservation_count\trelated_jira_count\ttarget_chunks\tsource_paths\tcontext_path",
  ...candidates.map((candidate) => [
    candidate.issue_key,
    candidate.observation_count,
    candidate.related_jira_count,
    candidate.target_chunks.join(","),
    candidate.source_paths.join(","),
    candidate.context_path,
  ].map((value) => String(value).replace(/\t/g, " ")).join("\t")),
].join("\n") + "\n");

const run: RunManifest = {
  schemaVersion: "1.0",
  runId,
  createdAt: now.toISOString(),
  description,
  workflow: "issue-fixup",
  chunkSource: {
    kind: "issue-mapping-not-fully-applied",
    path: sourceRuns.join(","),
  },
  chunkCount: selectedIssueKeys.length,
  fhirRepo,
  baseRef,
  baseSha,
  combinedBranch,
  status: "initialized",
};
writeRun(run);
appendJournal(runId, {
  type: "issue-fixup-run-prepared",
  sourceRuns,
  requestedIssueKeys,
  selectedIssueCount: selectedIssueKeys.length,
  noSnapshots,
  includeExplicitNonMisapplied,
  maxRelatedJiras,
  baseRef,
  baseSha,
  combinedBranch,
});

console.log(`run_id=${runId}`);
console.log("workflow=issue-fixup");
console.log(`source_runs=${sourceRuns.join(",")}`);
if (requestedIssueKeys.length > 0) console.log(`requested_issue_keys=${requestedIssueKeys.join(",")}`);
console.log(`selected_issue_count=${selectedIssueKeys.length}`);
console.log(`include_explicit_non_misapplied=${includeExplicitNonMisapplied}`);
console.log(`candidate_pool=${path.join(root, "candidate-pool/issues.tsv")}`);
console.log(`combined_branch=${combinedBranch}`);
console.log(`run_dir=${root}`);
