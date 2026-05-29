#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const upstreamGithubRepo = arg("--upstream-github-repo") ?? "HL7/fhir";
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
  item_count: items.length,
  seed_count: resultFiles.length,
  items,
};

writeFileSync(path.join(outDir, reportJsonName), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(path.join(outDir, reportGzipName), gzipSync(JSON.stringify(report)));

function optionCounts(field: keyof ReportItem): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = String(item[field] ?? "");
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => `<option value="${escapeHtml(value)}">${escapeHtml(value || "(blank)")} (${count})</option>`).join("");
}

function linkifyText(value: string): string {
  return escapeHtml(value)
    .replace(/\b(FHIR-\d+)\b/g, '<a href="https://jira.hl7.org/browse/$1" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\b([0-9a-f]{12,40})\b/g, (_match, sha) => `<a href="https://github.com/${upstreamGithubRepo}/commit/${sha}" target="_blank" rel="noreferrer">${sha.slice(0, 12)}</a>`);
}

function renderList(values: string[]): string {
  if (!values.length) return '<p class="muted">None recorded.</p>';
  return `<ul>${values.map((value) => `<li>${linkifyText(value)}</li>`).join("")}</ul>`;
}

function renderIssueLinks(rows: { key: string; relationship: string; note: string }[]): string {
  if (!rows.length) return '<p class="muted">None recorded.</p>';
  return `<ul>${rows.map((row) => `<li><a href="https://jira.hl7.org/browse/${escapeHtml(row.key)}" target="_blank" rel="noreferrer">${escapeHtml(row.key)}</a> <span class="pill">${escapeHtml(row.relationship)}</span> ${linkifyText(row.note)}</li>`).join("")}</ul>`;
}

function renderEvidence(rows: ReportItem["evidence_items"]): string {
  if (!rows.length) return '<p class="muted">None recorded.</p>';
  return `<table><thead><tr><th>ID</th><th>Kind</th><th>Locator</th><th>Summary</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.kind)}</td><td>${row.url ? `<a href="${escapeHtml(row.url)}" target="_blank" rel="noreferrer">${escapeHtml(row.locator)}</a>` : escapeHtml(row.locator)}</td><td>${linkifyText(row.summary)}</td></tr>`).join("")}</tbody></table>`;
}

function renderPatch(patch: string): string {
  const rows = patch.split("\n").map((line) => {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : "";
    return `<div class="${cls}">${escapeHtml(line) || " "}</div>`;
  }).join("");
  return `<pre class="diff">${rows}</pre>`;
}

function renderCard(item: ReportItem): string {
  const anchor = item.anchor;
  const commitLink = item.github_commit_url
    ? `<a class="full-link" href="${escapeHtml(item.github_commit_url)}" target="_blank" rel="noreferrer">${item.patch_truncated ? "Full commit on GitHub (required)" : "Full commit on GitHub"}</a>`
    : "";
  return `<article class="card" id="${escapeHtml(anchor)}" data-sha="${escapeHtml(item.commit_sha ?? "")}" data-status="${escapeHtml(item.status)}" data-role="${escapeHtml(item.role)}" data-confidence="${escapeHtml(item.confidence)}">
    <header>
      <h2><a href="#${escapeHtml(anchor)}" class="anchor">#</a> ${escapeHtml(item.short_sha ?? "no-commit")} ${escapeHtml(item.issue_key)}: ${escapeHtml(item.commit_subject ?? item.summary)}</h2>
      <div class="meta">
        <a href="https://jira.hl7.org/browse/${escapeHtml(item.issue_key)}" target="_blank" rel="noreferrer">Jira ${escapeHtml(item.issue_key)}</a>
        ${item.github_commit_url ? `<a href="${escapeHtml(item.github_commit_url)}" target="_blank" rel="noreferrer">GitHub commit ${escapeHtml(item.short_sha ?? "")}</a>` : ""}
        <span class="pill ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
        <span class="pill">${escapeHtml(item.role)}</span>
        <span class="pill">${escapeHtml(item.confidence)}</span>
        <span class="pill">seed ${escapeHtml(item.seed_key)}</span>
        ${commitLink}
      </div>
    </header>
    <section>
      <h3>Commit Message</h3>
      <pre class="message">${linkifyText(item.commit_body ?? "")}</pre>
    </section>
    <section class="grid">
      <div><h3>Summary</h3><p>${linkifyText(item.summary)}</p></div>
      <div><h3>Recommendation</h3><p>${linkifyText(item.recommendation)}</p></div>
    </section>
    <details open><summary>Issue request</summary><p>${linkifyText(item.issue_request)}</p></details>
    <details open><summary>Initial application</summary><p>${linkifyText(item.initial_application)}</p></details>
    <details open><summary>Additional context</summary><p>${linkifyText(item.additional_context)}</p></details>
    <details open><summary>Reconciliation</summary><p>${linkifyText(item.reconciliation)}</p></details>
    <details><summary>Source changes</summary>${renderList(item.source_changes)}</details>
    <details><summary>Related Jiras</summary>${renderIssueLinks(item.related_jiras)}</details>
    <details><summary>Evidence</summary>${renderEvidence(item.evidence_items)}</details>
    <details><summary>Checks</summary>${renderList(item.checks)}</details>
    <details open><summary>Files and Stats</summary><pre>${escapeHtml(item.stat || "(empty commit)")}</pre>${renderList(item.files)}</details>
    <details open><summary>Diff${item.patch_truncated ? " (truncated)" : ""}</summary>${item.patch_truncated ? '<div class="notice">Patch or long lines were truncated in this embedded report. Use git locally for complete content.</div>' : ""}${renderPatch(item.patch || "(empty commit)")}</details>
  </article>`;
}

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AutoFHIR Issue Reconcile Review - ${escapeHtml(runId)}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, -apple-system, Segoe UI, sans-serif; color: #1d2733; background: #f3f6f9; }
    body { margin: 0; }
    header.top { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid #cad4df; padding: 18px 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .runmeta { display: flex; flex-wrap: wrap; gap: 16px; color: #526579; }
    details.agent { margin-top: 12px; border: 1px solid #cad4df; border-radius: 6px; padding: 8px 12px; background: #fbfdff; }
    details.agent summary { cursor: pointer; font-weight: 700; }
    details.agent ul { margin: 8px 0 0; }
    .filters { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 16px; align-items: center; }
    select, button { font: inherit; padding: 8px 10px; border: 1px solid #b9c7d5; border-radius: 6px; background: #fff; }
    main { max-width: 1500px; margin: 0 auto; padding: 20px; }
    .card { background: #fff; border: 1px solid #cdd7e2; border-radius: 8px; margin: 0 0 20px; padding: 18px; box-shadow: 0 1px 2px rgba(20,30,40,.04); }
    .card.hidden { display: none; }
    h2 { margin: 0 0 10px; font-size: 22px; }
    h3 { margin: 16px 0 8px; font-size: 15px; text-transform: uppercase; letter-spacing: .03em; color: #405166; }
    a { color: #0b63ce; }
    .anchor { text-decoration: none; color: #8997a8; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .pill { border: 1px solid #c6d2de; border-radius: 999px; padding: 2px 8px; font-size: 13px; background: #f8fafc; }
    .pill.fixed { background: #e8f7ee; border-color: #9ed3ae; color: #11612c; }
    .pill.no-change { background: #eef4ff; border-color: #adc7f8; color: #164f9f; }
    .pill.human-review { background: #fff5df; border-color: #e2bd6e; color: #744800; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 18px; }
    p, li { line-height: 1.45; }
    details { border-top: 1px solid #d8e0e8; margin-top: 14px; padding-top: 10px; }
    summary { cursor: pointer; font-weight: 700; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f7f9fb; border: 1px solid #d3dde7; border-radius: 6px; padding: 10px; }
    pre.message { font-size: 14px; line-height: 1.45; }
    pre.diff { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.35; padding: 0; overflow-wrap: anywhere; }
    pre.diff div { padding: 0 10px; min-height: 1.35em; white-space: pre-wrap; overflow-wrap: anywhere; }
    pre.diff .add { background: #e7f8ec; color: #135d2b; }
    pre.diff .del { background: #fde8e8; color: #981b1b; }
    pre.diff .hunk { background: #e8f1ff; color: #124d92; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #d8e0e8; padding: 6px; vertical-align: top; }
    .notice { background: #fff2cc; border: 1px solid #dfbf55; padding: 8px 10px; border-radius: 6px; margin: 8px 0; }
    .muted { color: #66778a; }
    @media (max-width: 700px) {
      header.top { position: static; padding: 14px; }
      main { padding: 12px; }
      .grid { grid-template-columns: 1fr; }
      h2 { font-size: 18px; }
    }
  </style>
</head>
<body>
  <header class="top">
    <h1>AutoFHIR Issue Reconcile Review</h1>
    <div class="runmeta">
      <span>Run: ${escapeHtml(runId)}</span>
      <span>Branch: <a href="${escapeHtml(sourceBranchTreeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(run.combinedBranch)}</a></span>
      <span>Base: ${escapeHtml(displayBaseSha)}</span>
      <span>Head: ${escapeHtml(report.combined_head.slice(0, 12))}</span>
      <span>Items: ${items.length}</span>
      <span>Seeds: ${resultFiles.length}</span>
      <a href="${escapeHtml(sourceBranchTreeUrl)}" target="_blank" rel="noreferrer">FHIR source branch</a>
      <a href="${escapeHtml(report.github_compare_url)}" target="_blank" rel="noreferrer">Full branch diff on GitHub</a>
      <a href="${escapeHtml(artifactBranchTreeUrl)}" target="_blank" rel="noreferrer">Run artifacts branch</a>
      <a href="${escapeHtml(report.artifacts.report_json_gzip)}" target="_blank" rel="noreferrer">Download report (gzip)</a>
    </div>
    <details class="agent">
      <summary>Source branch, downloadable artifacts, and agent instructions</summary>
      <p class="muted">Each issue card links to its commit in the orphan FHIR source branch on GitHub. Use "Copy Review Plan" to copy a prompt for an LLM agent that includes the portable branch and artifact links below.</p>
      <ul>
        <li>FHIR source branch (one commit per decided issue): <a href="${escapeHtml(sourceBranchTreeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(githubRepo)}/tree/${escapeHtml(sourceBranch)}</a></li>
        <li>Full branch diff: <a href="${escapeHtml(report.github_compare_url)}" target="_blank" rel="noreferrer">${escapeHtml(displayBaseSha)}...${escapeHtml(report.combined_head.slice(0, 12))}</a></li>
        <li>Run artifacts branch (review app, JSON, gzip): <a href="${escapeHtml(artifactBranchTreeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(githubRepo)}/tree/${escapeHtml(artifactBranch)}/${escapeHtml(artifactDir)}</a></li>
        <li>Report JSON: <a href="${escapeHtml(report.artifacts.report_json)}" target="_blank" rel="noreferrer">${escapeHtml(reportJsonName)}</a></li>
        <li>Report JSON (gzip): <a href="${escapeHtml(report.artifacts.report_json_gzip)}" target="_blank" rel="noreferrer">${escapeHtml(reportGzipName)}</a></li>
      </ul>
    </details>
    <div class="filters">
      <select id="status"><option value="">All statuses (${items.length})</option>${optionCounts("status")}</select>
      <select id="role"><option value="">All roles (${items.length})</option>${optionCounts("role")}</select>
      <select id="confidence"><option value="">All confidences (${items.length})</option>${optionCounts("confidence")}</select>
      <button id="copy">Copy Visible Summary</button>
      <button id="copyplan">Copy Review Plan</button>
      <span id="count" class="muted"></span>
    </div>
  </header>
  <main id="cards">
    ${items.map(renderCard).join("\n")}
  </main>
  <script>
    const AGENT_LINKS = ${JSON.stringify({
      run_id: runId,
      github_repo: githubRepo,
      source_branch_tree_url: sourceBranchTreeUrl,
      github_compare_url: report.github_compare_url,
      base: displayBaseSha,
      head: report.combined_head,
      artifact_branch_tree_url: artifactBranchTreeUrl,
      report_json: report.artifacts.report_json,
      report_json_gzip: report.artifacts.report_json_gzip,
      review_html: report.artifacts.review_html,
    })};
    const filters = ["status", "role", "confidence"];
    function applyFilters() {
      const values = Object.fromEntries(filters.map((id) => [id, document.getElementById(id).value]));
      let visible = 0;
      document.querySelectorAll(".card").forEach((card) => {
        const show = filters.every((id) => !values[id] || card.dataset[id] === values[id]);
        card.classList.toggle("hidden", !show);
        if (show) visible += 1;
      });
      document.getElementById("count").textContent = visible + " visible";
    }
    filters.forEach((id) => document.getElementById(id).addEventListener("change", applyFilters));
    function flash(button, label) {
      const old = button.textContent;
      button.textContent = label;
      setTimeout(() => button.textContent = old, 1200);
    }
    document.getElementById("copy").addEventListener("click", async () => {
      const rows = [...document.querySelectorAll(".card:not(.hidden)")].map((card) => {
        const h2 = card.querySelector("h2")?.innerText.trim() ?? "";
        const rec = card.querySelector(".grid div:nth-child(2) p")?.innerText.trim() ?? "";
        return h2 + "\\n" + rec;
      }).join("\\n\\n");
      await navigator.clipboard.writeText(rows);
      flash(document.getElementById("copy"), "Copied");
    });
    document.getElementById("copyplan").addEventListener("click", async () => {
      const items = [...document.querySelectorAll(".card:not(.hidden)")].map((card) => {
        const sha = card.dataset.sha || "";
        const h2 = card.querySelector("h2")?.innerText.trim() ?? "";
        const url = card.querySelector(".meta a[href*='/commit/']")?.getAttribute("href") || "";
        return "- " + h2 + (url ? "\\n  Commit: " + url : "");
      });
      const lines = [
        "# AutoFHIR Issue Reconcile Review Plan",
        "",
        "Give this file to an agent to review and apply the reconciliation commits.",
        "",
        "Portable branch and artifact locations:",
        "- GitHub repository: https://github.com/" + AGENT_LINKS.github_repo,
        "- FHIR source branch with one commit per decided issue: " + AGENT_LINKS.source_branch_tree_url,
        "- Base commit: " + AGENT_LINKS.base,
        "- Current head: " + AGENT_LINKS.head,
        "- Full branch diff on GitHub: " + AGENT_LINKS.github_compare_url,
        "- Run artifacts branch (review app, JSON, gzip): " + AGENT_LINKS.artifact_branch_tree_url,
        "- Report JSON: " + AGENT_LINKS.report_json,
        "- Report JSON (gzip, with embedded patches): " + AGENT_LINKS.report_json_gzip,
        "- Standalone review HTML: " + AGENT_LINKS.review_html,
        "",
        "Visible review items (" + items.length + "):",
        ...(items.length ? items : ["(none)"]),
        "",
      ];
      await navigator.clipboard.writeText(lines.join("\\n"));
      flash(document.getElementById("copyplan"), "Copied");
    });
    applyFilters();
  </script>
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
