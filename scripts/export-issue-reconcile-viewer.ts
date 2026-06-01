#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { readJson, readRun, repoRoot, runCommand, runPath } from "./lib";

type IssueResult = {
  issue_key: string;
  role: "seed" | "opportunistic";
  status: "fixed" | "no-change" | "human-review" | "external-repo" | "blocked";
  commit?: { sha: string; subject: string; empty: boolean };
  summary: string;
  issue_request: string;
  initial_application: string;
  additional_context: string;
  reconciliation: string;
  recommendation: string;
  source_changes: string[];
  related_jiras: { key: string; relationship: string; note: string }[];
  evidence_items: { id: string; kind: string; locator: string; url?: string; ref?: Record<string, string | number>; summary: string; supports: string[] }[];
  checks: string[];
  confidence: "high" | "medium" | "low";
};

type ResultFile = {
  schema_version: "issue-reconcile-result-v1";
  run_id: string;
  seed_key: string;
  status: "complete" | "blocked";
  branch: string;
  issue_results: IssueResult[];
  related_not_decided: { key: string; reason: string }[];
  journal_entries: unknown[];
  notes?: string[];
};

type ReportItem = IssueResult & {
  seed_key: string;
  seed_decisions: { issue_key: string; role: string; status: string; commit_sha?: string; summary: string }[];
  result_path: string;
  commit_sha?: string;
  short_sha?: string;
  commit_subject?: string;
  commit_body?: string;
  commit_author?: string;
  commit_date?: string;
  github_commit_url?: string;
  branch_index?: number;
  anchor: string;
  files: string[];
  stat: string;
  patch: string;
  patch_truncated?: boolean;
};

type SideFileCommit = {
  sequence: number;
  review_id: string;
  sha: string;
  commit_sha?: string;
  short_sha?: string;
  author?: string;
  authored_at?: string;
  subject: string;
  body_url?: string;
  issue_key: string;
  seed_key: string;
  seed_decisions: ReportItem["seed_decisions"];
  role: string;
  status: string;
  decision_status: string;
  summary: string;
  recommendation: string;
  result_path: string;
  github_commit_url?: string;
  files: string[];
  stat: string;
  patch_url?: string;
  patch_truncated?: boolean;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function truncateLongLines(value: string, maxLineChars: number): { text: string; truncated: boolean } {
  let truncated = false;
  const text = value.split("\n").map((line) => {
    if (line.length <= maxLineChars) return line;
    truncated = true;
    return `${line.slice(0, maxLineChars)} ... [line truncated; original length ${line.length} chars]`;
  }).join("\n");
  return { text, truncated };
}

function usage(): string {
  return `Usage: bun autofhir/scripts/export-issue-reconcile-viewer.ts --run-id ID [--out-dir DIR] [--max-patch-bytes N] [--max-line-chars N] [--github-repo OWNER/REPO] [--upstream-github-repo OWNER/REPO] [--self-contained-pages] [--pages-base-url URL] [--commit-map FILE]

The generated web UI links each issue card to its commit in the orphan FHIR
source branch (refs/heads/<run-id>) on jmandel/autofhir, and links the run to
the run-specific artifacts branch (refs/heads/pages-<run-id>/<run-id>) that
holds the gzipped report and other downloadable context.

With --self-contained-pages, the gzip/artifact links resolve relative to the
deployed Pages folder instead of the artifacts branch on github.com.

With --commit-map FILE, commit SHAs read from the local combined branch are
translated to the SHAs that exist on the published orphan source branch so that
"GitHub commit" links, anchors, and the branch-diff range resolve on github.com.
The file is written by publish-issue-reconcile-review.ts and has the shape
{ "base_sha": "<orphan root>", "head_sha": "<orphan head>", "map": { "<combined sha>": "<orphan sha>" } }.`;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const maxPatchBytes = Number(arg("--max-patch-bytes") ?? "2500000");
const maxLineChars = Number(arg("--max-line-chars") ?? "50000");
const githubRepo = arg("--github-repo") ?? "jmandel/autofhir";
const selfContainedPages = flag("--self-contained-pages");
const pagesBaseUrl = arg("--pages-base-url") ?? "https://joshuamandel.com/autofhir/";
type CommitMap = { base_sha?: string; head_sha?: string; map: Record<string, string> };
const commitMapPath = arg("--commit-map");
const commitMap: CommitMap | undefined = commitMapPath ? readJson<CommitMap>(commitMapPath) : undefined;
function publishedSha(sha: string | undefined): string | undefined {
  if (!sha) return undefined;
  return commitMap?.map?.[sha] ?? sha;
}
const run = readRun(runId);
if (run.workflow !== "issue-reconcile") throw new Error(`run ${runId} is workflow=${run.workflow ?? "(unset)"}; expected issue-reconcile`);
if (!run.fhirRepo) throw new Error(`run ${runId} has no fhirRepo`);
if (!run.combinedBranch) throw new Error(`run ${runId} has no combinedBranch`);

const root = runPath(runId);
const outDir = path.resolve(arg("--out-dir") ?? path.join(root, "review"));
mkdirSync(outDir, { recursive: true });

const reportJsonName = "issue-reconcile-report.json";
const reportGzipName = "issue-reconcile-report.json.gz";
const textBundleName = "review-text-bundle.json";
const textBundleGzipName = "review-text-bundle.json.gz";
const sourceBranch = runId;
const artifactBranch = `pages-${runId}`;
const artifactDir = runId;
const githubRepoUrl = `https://github.com/${githubRepo}`;
const sourceBranchTreeUrl = `${githubRepoUrl}/tree/${sourceBranch}`;
const artifactBranchTreeUrl = `${githubRepoUrl}/tree/${artifactBranch}/${artifactDir}`;
const artifactRawBaseUrl = selfContainedPages
  ? ""
  : `https://raw.githubusercontent.com/${githubRepo}/${artifactBranch}/${artifactDir}/`;
const pagesUrl = new URL(`${artifactDir}/`, pagesBaseUrl.endsWith("/") ? pagesBaseUrl : `${pagesBaseUrl}/`).href;
function artifactUrl(name: string): string {
  return artifactRawBaseUrl ? `${artifactRawBaseUrl}${name}` : new URL(name, pagesUrl).href;
}
function commitUrl(sha: string | undefined): string | undefined {
  return sha ? `${githubRepoUrl}/commit/${sha}` : undefined;
}

function commitInfo(sha: string | undefined): Pick<ReportItem, "commit_sha" | "short_sha" | "commit_subject" | "commit_body" | "commit_author" | "commit_date" | "files" | "stat" | "patch" | "patch_truncated"> {
  if (!sha) return { files: [], stat: "", patch: "" };
  const format = "%H%x00%h%x00%an%x00%ai%x00%s%x00%B";
  const raw = runCommand(["git", "show", "-s", `--format=${format}`, sha], { cwd: run.fhirRepo!, allowFailure: true });
  const [full, short, author, date, subject, ...bodyParts] = raw.split("\0");
  const body = bodyParts.join("\0").trim();
  const stat = runCommand(["git", "show", "--stat", "--pretty=format:", sha], { cwd: run.fhirRepo!, allowFailure: true }).trim();
  const files = runCommand(["git", "diff-tree", "--no-commit-id", "--name-only", "-r", sha], { cwd: run.fhirRepo!, allowFailure: true })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fullPatch = runCommand(["git", "show", "--patch", "--pretty=format:", "--find-renames", sha], { cwd: run.fhirRepo!, allowFailure: true });
  const byteLength = Buffer.byteLength(fullPatch, "utf8");
  const capped = byteLength > maxPatchBytes
    ? `${fullPatch.slice(0, maxPatchBytes)}\n\n[patch truncated at ${maxPatchBytes} bytes; original size ${byteLength} bytes]\n`
    : fullPatch;
  const lineCapped = truncateLongLines(capped, maxLineChars);
  return {
    commit_sha: full || sha,
    short_sha: short || sha.slice(0, 10),
    commit_subject: subject || "",
    commit_body: body,
    commit_author: author || "",
    commit_date: date || "",
    files,
    stat,
    patch: lineCapped.text,
    patch_truncated: byteLength > maxPatchBytes || lineCapped.truncated,
  };
}

const resultFiles = readdirSync(path.join(root, "results"))
  .filter((file) => file.endsWith(".json") && !file.endsWith(".validation.json"))
  .sort();
const commitOrder = new Map(
  runCommand(["git", "log", "--reverse", "--format=%H", run.combinedBranch, `^${run.baseSha}`], { cwd: run.fhirRepo, allowFailure: true })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((sha, index) => [sha, index] as const),
);
const items: ReportItem[] = [];
for (const file of resultFiles) {
  const fullPath = path.join(root, "results", file);
  const result = readJson<ResultFile>(fullPath);
  const seedDecisions = (result.issue_results ?? []).map((issue) => ({
    issue_key: issue.issue_key,
    role: issue.role,
    status: issue.status,
    commit_sha: publishedSha(issue.commit?.sha),
    summary: issue.summary,
  }));
  for (const issue of result.issue_results ?? []) {
    const info = commitInfo(issue.commit?.sha);
    const branchIndex = info.commit_sha ? commitOrder.get(info.commit_sha) : undefined;
    const mappedSha = publishedSha(info.commit_sha);
    const anchorIndex = branchIndex !== undefined ? String(branchIndex + 1).padStart(5, "0") : "xxxxx";
    const anchor = mappedSha
      ? `commit-${anchorIndex}-${mappedSha}-${issue.issue_key}`
      : `commit-no-commit-${issue.issue_key}`;
    items.push({
      seed_key: result.seed_key,
      seed_decisions: seedDecisions,
      result_path: path.relative(root, fullPath),
      ...issue,
      ...info,
      commit_sha: mappedSha ?? info.commit_sha,
      short_sha: mappedSha ? mappedSha.slice(0, 10) : info.short_sha,
      branch_index: branchIndex,
      github_commit_url: commitUrl(mappedSha),
      anchor,
    });
  }
}

items.sort((a, b) => {
  // branch_index is the commit's position on the combined branch (set above from
  // commitOrder); sort by it so cards follow branch order even after SHA mapping.
  const aOrder = a.branch_index ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.branch_index ?? Number.MAX_SAFE_INTEGER;
  return aOrder - bOrder || a.seed_key.localeCompare(b.seed_key) || a.issue_key.localeCompare(b.issue_key);
});

const combinedHead = commitMap?.head_sha ?? runCommand(["git", "rev-parse", run.combinedBranch], { cwd: run.fhirRepo }).trim();
const displayBaseSha = commitMap?.base_sha ?? run.baseSha ?? "";

function sideFileName(index: number, issueKey: string, shortSha: string | undefined, extension: string): string {
  const seq = String(index + 1).padStart(5, "0");
  const cleanKey = issueKey.replace(/[^A-Za-z0-9_.-]/g, "_");
  const cleanSha = (shortSha || "no-commit").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 16);
  return `${seq}-${cleanKey}-${cleanSha}.${extension}`;
}

const detailsDir = path.join(outDir, "details");
rmSync(detailsDir, { recursive: true, force: true });
rmSync(path.join(outDir, "messages"), { recursive: true, force: true });
rmSync(path.join(outDir, "patches"), { recursive: true, force: true });

const textBundle: { schema_version: string; generated_at: string; assets: Record<string, string> } = {
  schema_version: "autofhir-review-text-bundle-v1",
  generated_at: new Date().toISOString(),
  assets: {},
};

const compactCommits: SideFileCommit[] = items.map((item, index) => {
  const messageName = sideFileName(index, item.issue_key, item.short_sha, "txt");
  const patchName = sideFileName(index, item.issue_key, item.short_sha, "patch");
  const bodyUrl = item.commit_body ? `messages/${messageName}` : undefined;
  const patchUrl = item.patch ? `patches/${patchName}` : undefined;
  if (bodyUrl) textBundle.assets[bodyUrl] = item.commit_body;
  if (patchUrl) textBundle.assets[patchUrl] = item.patch;
  return {
    sequence: index + 1,
    review_id: item.anchor.replace(/^commit-/, ""),
    sha: item.anchor.replace(/^commit-/, ""),
    commit_sha: item.commit_sha,
    short_sha: item.short_sha,
    author: item.commit_author,
    authored_at: item.commit_date,
    subject: item.commit_subject || `${item.issue_key}: ${item.summary}`,
    body_url: bodyUrl,
    issue_key: item.issue_key,
    seed_key: item.seed_key,
    seed_decisions: item.seed_decisions,
    role: item.role,
    status: item.status,
    decision_status: item.status,
    summary: item.summary,
    recommendation: item.recommendation,
    result_path: item.result_path,
    github_commit_url: item.github_commit_url,
    files: item.files,
    stat: item.stat,
    patch_url: patchUrl,
    patch_truncated: item.patch_truncated,
  };
});

const report = {
  schema_version: "issue-reconcile-review-report-v1",
  run_id: runId,
  workflow: run.workflow,
  generated_at: new Date().toISOString(),
  fhir_repo: run.fhirRepo,
  base_ref: run.baseRef,
  base_sha: displayBaseSha,
  combined_branch: run.combinedBranch,
  combined_head: combinedHead,
  github_repo: githubRepo,
  source_branch: sourceBranch,
  source_branch_tree_url: sourceBranchTreeUrl,
  github_compare_url: `${githubRepoUrl}/compare/${displayBaseSha}...${combinedHead}`,
  artifact_branch: artifactBranch,
  artifact_branch_tree_url: artifactBranchTreeUrl,
  artifacts: {
    report_json: artifactUrl(reportJsonName),
    report_json_gzip: artifactUrl(reportGzipName),
    review_html: artifactUrl("index.html"),
  },
  run: {
    run_id: runId,
    fhir_repo: run.fhirRepo,
    base: displayBaseSha,
    head: combinedHead,
    combined_branch: run.combinedBranch,
    github_repo: githubRepo,
    github_tree_url: sourceBranchTreeUrl,
    github_compare_url: `${githubRepoUrl}/compare/${displayBaseSha}...${combinedHead}`,
    review_pages_url: pagesUrl,
    review_github_tree_url: artifactBranchTreeUrl,
    review_raw_base_url: artifactRawBaseUrl,
    artifacts: {
      fixup_review_json: reportJsonName,
      fixup_review_json_gzip: reportGzipName,
      text_bundle_gzip: textBundleGzipName,
      fixup_patch_dir: "patches/",
    },
  },
  counts: {
    commits: items.length,
    with_result: items.length,
  },
  commits: compactCommits,
  item_count: items.length,
  seed_count: resultFiles.length,
};

writeFileSync(path.join(outDir, reportJsonName), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(outDir, reportGzipName), gzipSync(JSON.stringify(report)));
writeFileSync(path.join(outDir, textBundleName), `${JSON.stringify(textBundle)}\n`);
writeFileSync(path.join(outDir, textBundleGzipName), gzipSync(JSON.stringify(textBundle)));

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AutoFHIR Issue Reconcile Review - ${escapeHtml(runId)}</title>
  <link rel="stylesheet" href="review-app.css">
  <script>
    window.__AUTOFHIR_REPORT_URL__ = "issue-reconcile-report.json.gz";
    window.__AUTOFHIR_TEXT_BUNDLE_URL__ = "review-text-bundle.json.gz";
  </script>
  <script type="module" src="review-app.js"></script>
</head>
<body>
  <div id="root"></div>
</body>
</html>
`;

writeFileSync(path.join(outDir, "index.html"), html);
console.log(`run_id=${runId}`);
console.log(`items=${items.length}`);
console.log(`seeds=${resultFiles.length}`);
console.log(`source_branch=${sourceBranchTreeUrl}`);
console.log(`artifact_branch=${artifactBranchTreeUrl}`);
console.log(`report=${path.join(outDir, reportJsonName)}`);
console.log(`html=${path.join(outDir, "index.html")}`);
