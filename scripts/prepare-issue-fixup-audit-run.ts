#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  RunManifest,
  appendJournal,
  ensureRunDirs,
  readJson,
  repoRoot,
  runPath,
  sanitizeId,
  writeJson,
  writeRun,
} from "./lib";

type ReviewCommit = {
  sha: string;
  short_sha?: string;
  subject?: string;
  body?: string;
  issue_key?: string;
  status?: string;
  decision_status?: string;
  summary?: string;
  recommendation?: string;
  files?: string[];
  stat?: string;
  patch_url?: string;
  patch_truncated?: boolean;
  patch_bytes?: number;
  previous_issue_commits?: unknown[];
  previous_issue_commits_omitted?: number;
  result_path?: string;
  wg?: string;
  wg_label?: string;
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
  console.log(`Usage: bun autofhir/scripts/prepare-issue-fixup-audit-run.ts --run-id ID --source-run ISSUE_FIXUP_RUN [--issue-key FHIR-XXXXX ...] [--issue-keys A,B] [--limit N] [--concurrency N]

Builds a read-only audit run from an existing issue-fixup review report. Each queued item audits one generated issue-fixup commit and produces JSON only.`);
  process.exit(0);
}

const now = new Date();
const runId = sanitizeId(arg("--run-id") ?? process.env.RUN_ID ?? `issue-fixup-audit-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}`);
const sourceRunId = arg("--source-run") ?? process.env.SOURCE_RUN_ID ?? "issue-fixup-full-not-fully-applied-v1";
const description = arg("--description") ?? process.env.RUN_DESCRIPTION ?? `Audit generated issue-fixup commits from ${sourceRunId}`;
const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
const concurrency = arg("--concurrency") ? Number(arg("--concurrency")) : (process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined);
const requestedIssueKeys = [
  ...args("--issue-key"),
  ...(arg("--issue-keys") ?? "").split(",").map((value) => value.trim()).filter(Boolean),
];

if (existsSync(runPath(runId))) throw new Error(`run already exists: ${runPath(runId)}`);
if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer");
if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 0)) throw new Error("--concurrency must be a non-negative integer");

const sourceRoot = runPath(sourceRunId);
const sourceRun = readJson<RunManifest>(path.join(sourceRoot, "run.json"));
if (sourceRun.workflow !== "issue-fixup") throw new Error(`source run ${sourceRunId} is workflow=${sourceRun.workflow ?? "(unset)"}; expected issue-fixup`);
if (!sourceRun.fhirRepo || !sourceRun.combinedBranch || !sourceRun.baseSha) throw new Error("source run is missing fhirRepo/combinedBranch/baseSha");

const reportPath = path.join(sourceRoot, "review/issue-fixup-diff-report.json");
if (!existsSync(reportPath)) throw new Error(`source run has no review report: ${reportPath}`);
const report = readJson<{ commits: ReviewCommit[] }>(reportPath);

let commits = report.commits.filter((commit) => commit.issue_key && /^FHIR-\d+$/.test(commit.issue_key) && /^[0-9a-f]{7,40}$/i.test(commit.sha));
if (requestedIssueKeys.length > 0) {
  const requested = new Set(requestedIssueKeys);
  commits = commits.filter((commit) => requested.has(commit.issue_key!));
  const found = new Set(commits.map((commit) => commit.issue_key));
  const missing = requestedIssueKeys.filter((key) => !found.has(key));
  if (missing.length > 0) throw new Error(`requested issue keys not found in source review report: ${missing.join(", ")}`);
}
if (limit !== undefined) commits = commits.slice(0, limit);

ensureRunDirs(runId);
const root = runPath(runId);
mkdirSync(path.join(root, "candidate-pool"), { recursive: true });

const candidates: unknown[] = [];
for (const commit of commits) {
  const issueKey = commit.issue_key!;
  const contextPath = path.join(sourceRoot, "contexts", issueKey, "context.json");
  const sourceResultPath = commit.result_path ? path.join(sourceRoot, commit.result_path) : path.join(sourceRoot, "results", `${issueKey}.json`);
  const sourcePromptPath = path.join(sourceRoot, "prompts", `${issueKey}.md`);
  const patchPath = commit.patch_url ? path.join(sourceRoot, "review", commit.patch_url) : path.join(sourceRoot, "review", "patches", `${commit.sha}.patch`);
  if (!existsSync(contextPath)) throw new Error(`missing source context for ${issueKey}: ${contextPath}`);
  if (!existsSync(sourceResultPath)) throw new Error(`missing source result for ${issueKey}: ${sourceResultPath}`);

  const chunk = {
    schemaVersion: "1.0",
    runId,
    chunkId: issueKey,
    workflow: "issue-fixup-audit",
    title: `Issue fixup audit for ${issueKey}`,
    sourceKind: "issue-fixup-commit",
    issueKey,
    sourceRunId,
    sourceContextPath: path.relative(repoRoot, contextPath),
    sourceResultPath: path.relative(repoRoot, sourceResultPath),
    sourcePromptPath: existsSync(sourcePromptPath) ? path.relative(repoRoot, sourcePromptPath) : undefined,
    sourceReviewReportPath: path.relative(repoRoot, reportPath),
    commitPatchPath: existsSync(patchPath) ? path.relative(repoRoot, patchPath) : undefined,
    sourcePaths: [...new Set([...(commit.files ?? [])])].sort(),
    commit: {
      sha: commit.sha,
      short_sha: commit.short_sha,
      subject: commit.subject,
      body: commit.body,
      status: commit.status,
      decision_status: commit.decision_status,
      summary: commit.summary,
      recommendation: commit.recommendation,
      files: commit.files ?? [],
      stat: commit.stat,
      patch_url: commit.patch_url,
      patch_truncated: commit.patch_truncated,
      patch_bytes: commit.patch_bytes,
      previous_issue_commits: commit.previous_issue_commits ?? [],
      previous_issue_commits_omitted: commit.previous_issue_commits_omitted ?? 0,
      wg: commit.wg,
      wg_label: commit.wg_label,
    },
    specCommit: sourceRun.baseSha,
  };
  writeJson(path.join(root, "chunks/pending", `${issueKey}.json`), chunk);
  candidates.push({
    issue_key: issueKey,
    commit_sha: commit.sha,
    status: commit.status,
    files: commit.files ?? [],
    context_path: path.relative(root, contextPath),
    result_path: path.relative(root, sourceResultPath),
    patch_path: existsSync(patchPath) ? path.relative(root, patchPath) : undefined,
  });
}

writeJson(path.join(root, "candidate-pool/issues.json"), {
  schema_version: "issue-fixup-audit-candidate-pool-v1",
  run_id: runId,
  source_run_id: sourceRunId,
  selected_issue_count: commits.length,
  candidates,
});
writeFileSync(path.join(root, "candidate-pool/issues.tsv"), [
  "issue_key\tcommit_sha\tstatus\tfiles\tcontext_path\tresult_path\tpatch_path",
  ...candidates.map((candidate: any) => [
    candidate.issue_key,
    candidate.commit_sha,
    candidate.status,
    candidate.files.join(","),
    candidate.context_path,
    candidate.result_path,
    candidate.patch_path ?? "",
  ].map((value) => String(value).replace(/\t/g, " ")).join("\t")),
].join("\n") + "\n");

const run: RunManifest = {
  schemaVersion: "1.0",
  runId,
  createdAt: now.toISOString(),
  description,
  workflow: "issue-fixup-audit",
  chunkSource: {
    kind: "issue-fixup-review-report",
    path: path.relative(repoRoot, reportPath),
  },
  chunkCount: commits.length,
  fhirRepo: sourceRun.fhirRepo,
  baseRef: sourceRun.baseRef,
  baseSha: sourceRun.baseSha,
  combinedBranch: sourceRun.combinedBranch,
  concurrency,
  status: "initialized",
};
writeRun(run);
appendJournal(runId, {
  type: "issue-fixup-audit-run-prepared",
  sourceRunId,
  requestedIssueKeys,
  selectedIssueCount: commits.length,
  concurrency,
  combinedBranch: sourceRun.combinedBranch,
});

console.log(`run_id=${runId}`);
console.log("workflow=issue-fixup-audit");
console.log(`source_run_id=${sourceRunId}`);
if (requestedIssueKeys.length > 0) console.log(`requested_issue_keys=${requestedIssueKeys.join(",")}`);
console.log(`selected_issue_count=${commits.length}`);
console.log(`candidate_pool=${path.join(root, "candidate-pool/issues.tsv")}`);
console.log(`combined_branch=${sourceRun.combinedBranch}`);
console.log(`run_dir=${root}`);
