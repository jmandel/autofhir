#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(): string {
  return `Usage: bun autofhir/scripts/backfill-issue-reconcile-report-links.ts --report FILE [--run-id ID] [--github-repo OWNER/REPO] [--pages-base-url URL] [--gzip FILE]

Repairs the GitHub link fields in a published issue-reconcile review report so the
deployed review app resolves them on github.com, using only data already present in
the report (every commit's SHA) plus the run id. This is the GitHub-only counterpart
to export-issue-reconcile-viewer.ts for runs whose local runs/<id>/ inputs are no
longer available.

It fills, without overwriting any non-empty existing value:
  - run.github_repo            = OWNER/REPO
  - run.github_tree_url        = https://github.com/OWNER/REPO/tree/<run-id>           (orphan source branch with one commit per decided issue)
  - run.github_compare_url     = https://github.com/OWNER/REPO/compare/<base>...<head>
  - run.review_pages_url       = <pages-base-url>/<run-id>/
  - run.review_github_tree_url = https://github.com/OWNER/REPO/tree/pages-<run-id>/<run-id>
  - commit.github_commit_url   = https://github.com/OWNER/REPO/commit/<sha>            (for every commit and nested previous_issue_commits)

The report is rewritten in place (pretty-printed) and the gzip companion is
regenerated so the two stay in sync.`;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}

const reportPath = arg("--report");
if (!reportPath) throw new Error("--report FILE is required");
if (!existsSync(reportPath)) throw new Error(`report not found: ${reportPath}`);

const githubRepo = arg("--github-repo") ?? "jmandel/autofhir";
const githubRepoUrl = `https://github.com/${githubRepo}`;
const pagesBaseUrlInput = arg("--pages-base-url") ?? "https://joshuamandel.com/autofhir/";
const pagesBaseUrl = pagesBaseUrlInput.endsWith("/") ? pagesBaseUrlInput : `${pagesBaseUrlInput}/`;
const gzipPath = arg("--gzip") ?? `${reportPath}.gz`;

type Commit = {
  sha?: string;
  github_commit_url?: string;
  previous_issue_commits?: Commit[];
  [key: string]: unknown;
};
type Report = {
  run_id?: string;
  base_sha?: string;
  combined_head?: string;
  run?: {
    run_id?: string;
    base?: string;
    head?: string;
    github_repo?: string;
    github_tree_url?: string;
    github_compare_url?: string;
    review_pages_url?: string;
    review_github_tree_url?: string;
    [key: string]: unknown;
  };
  commits?: Commit[];
  items?: Commit[];
  [key: string]: unknown;
};

const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
report.run = report.run ?? {};

const runId = arg("--run-id") ?? report.run.run_id ?? report.run_id;
if (!runId) throw new Error("--run-id is required (and not present in the report)");

const commitUrl = (sha: string | undefined): string | undefined => (sha ? `${githubRepoUrl}/commit/${sha}` : undefined);
function setIfEmpty<T extends Record<string, unknown>>(target: T, key: keyof T, value: string | undefined): void {
  if (value === undefined) return;
  const current = target[key];
  if (current === undefined || current === null || current === "") target[key] = value as T[keyof T];
}

const base = report.run.base ?? report.base_sha;
const head = report.run.head ?? report.combined_head;

setIfEmpty(report.run, "run_id", runId);
setIfEmpty(report.run, "github_repo", githubRepo);
setIfEmpty(report.run, "github_tree_url", `${githubRepoUrl}/tree/${runId}`);
setIfEmpty(
  report.run,
  "github_compare_url",
  base && head ? `${githubRepoUrl}/compare/${base}...${head}` : undefined,
);
setIfEmpty(report.run, "review_pages_url", new URL(`${runId}/`, pagesBaseUrl).href);
setIfEmpty(report.run, "review_github_tree_url", `${githubRepoUrl}/tree/pages-${runId}/${runId}`);

let commitLinks = 0;
function backfillCommit(commit: Commit): void {
  const url = commitUrl(commit.sha);
  if (url && (commit.github_commit_url === undefined || commit.github_commit_url === null || commit.github_commit_url === "")) {
    commit.github_commit_url = url;
    commitLinks += 1;
  }
  for (const prior of commit.previous_issue_commits ?? []) backfillCommit(prior);
}

for (const commit of report.commits ?? []) backfillCommit(commit);
for (const item of report.items ?? []) backfillCommit(item);

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
// Match export-issue-reconcile-viewer.ts: the .json is pretty-printed for diffability
// while the .gz stores the compact form. Both encode identical parsed content.
writeFileSync(gzipPath, gzipSync(JSON.stringify(report)));

console.log(`report=${path.resolve(reportPath)}`);
console.log(`gzip=${path.resolve(gzipPath)}`);
console.log(`run_id=${runId}`);
console.log(`github_repo=${githubRepo}`);
console.log(`github_tree_url=${report.run.github_tree_url}`);
console.log(`github_compare_url=${report.run.github_compare_url}`);
console.log(`review_pages_url=${report.run.review_pages_url}`);
console.log(`review_github_tree_url=${report.run.review_github_tree_url}`);
console.log(`commit_links_filled=${commitLinks}`);
