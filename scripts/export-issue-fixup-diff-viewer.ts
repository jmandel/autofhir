#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { readJson, readRun, repoRoot, runCommand, runPath } from "./lib";

type CommitReport = {
  sequence: number;
  sha: string;
  short_sha: string;
  author: string;
  authored_at: string;
  subject: string;
  body: string;
  issue_key?: string;
  status?: string;
  decision_status?: string;
  commit_summary?: string;
  commit_context?: string;
  summary?: string;
  recommendation?: string;
  github_commit_url?: string;
  result_path?: string;
  wg?: string;
  wg_label?: string;
  wg_confidence?: "high" | "medium" | "low";
  wg_evidence?: WgEvidence[];
  files: string[];
  stat: string;
  patch: string;
  patch_truncated?: boolean;
  omitted_patch_files?: { file: string; reason: string }[];
};

type WgEvidence = {
  wg: string;
  label: string;
  score: number;
  reasons: string[];
  files: string[];
};

type WgInference = Pick<CommitReport, "wg" | "wg_label" | "wg_confidence" | "wg_evidence">;

const wgNames: Record<string, string> = {
  "brr": "Biomedical Research and Regulation",
  "cbcc": "Community Based Collaborative Care",
  "cds": "Clinical Decision Support",
  "cg": "Clinical Genomics",
  "cqi": "Clinical Quality Information",
  "dev": "Health Care Devices",
  "fhir-i": "FHIR Infrastructure",
  "fm": "Financial Management",
  "ii": "Imaging Integration",
  "inm": "Infrastructure and Messaging",
  "oo": "Orders and Observations",
  "pa": "Patient Administration",
  "pc": "Patient Care",
  "pher": "Public Health",
  "phx": "Pharmacy",
  "sd": "Structured Documents",
  "sec": "Security",
  "vocab": "Vocabulary",
  "unknown": "Unknown",
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(): string {
  return `Usage: bun autofhir/scripts/export-issue-fixup-diff-viewer.ts --run-id ID [--out-dir DIR] [--max-patch-bytes N] [--max-file-diff-lines N]

Builds:
  autofhir/runs/<run-id>/review/issue-fixup-diff-report.json
  autofhir/runs/<run-id>/review/issue-fixup-diff-viewer.html
  autofhir/runs/<run-id>/review/index.html

The HTML is standalone and embeds commit metadata, result JSON summaries, and
colored unified diffs for the run's combined branch.`;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const maxPatchBytes = Number(arg("--max-patch-bytes") ?? "2500000");
const maxFileDiffLines = Number(arg("--max-file-diff-lines") ?? "25000");

const run = readRun(runId);
if (!run.fhirRepo) throw new Error(`run ${runId} has no fhirRepo`);
if (!run.combinedBranch) throw new Error(`run ${runId} has no combinedBranch`);

const root = runPath(runId);
const outDir = path.resolve(arg("--out-dir") ?? path.join(root, "review"));
mkdirSync(outDir, { recursive: true });

function zsplit(value: string): string[] {
  return value.replace(/\n$/, "").split("\0");
}

function issueKeyFor(body: string, subject: string): string | undefined {
  const trailer = body.match(/^Issue-Fixup-Key:\s*(FHIR-\d+)\s*$/m);
  if (trailer) return trailer[1];
  const subjectKey = subject.match(/\bFHIR-\d+\b/);
  return subjectKey?.[0];
}

function parsedCommitMessage(subject: string, body: string): { summary: string; context: string } {
  let text = body.replace(/\r\n/g, "\n").trim();
  const lines = text.split("\n");
  if (lines[0]?.trim() === subject.trim()) {
    text = lines.slice(1).join("\n").trim();
  }
  const stopPatterns = [
    /\nAutofHIR-Run:/,
    /\nIssue-Fixup-Key:/,
    /\n<related-jiras>/,
    /\n<evidence>/,
  ];
  const stopIndexes = stopPatterns
    .map((pattern) => {
      const match = text.match(pattern);
      return match?.index;
    })
    .filter((index): index is number => index !== undefined && index >= 0);
  const narrative = text.slice(0, stopIndexes.length ? Math.min(...stopIndexes) : text.length).trim();
  const paragraphs = narrative
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return {
    summary: paragraphs[0] ?? subject,
    context: paragraphs.slice(1).join("\n\n"),
  };
}

function resultFor(issueKey: string | undefined): any | undefined {
  if (!issueKey) return undefined;
  const file = path.join(root, "results", `${issueKey}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return readJson<any>(file);
  } catch {
    return undefined;
  }
}

function chunkFor(issueKey: string | undefined): any | undefined {
  if (!issueKey) return undefined;
  for (const state of ["done", "skipped", "blocked", "failed", "running", "pending"]) {
    const file = path.join(root, "chunks", state, `${issueKey}.json`);
    if (!existsSync(file)) continue;
    try {
      return readJson<any>(file);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseWorkgroups(file: string): Map<string, string> {
  const map = new Map<string, string>();
  let inSection = false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line.toLowerCase() === "[workgroups]";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().toLowerCase();
    if (key && value) map.set(key, value);
  }
  return map;
}

function jiraWg(code: string): string {
  const clean = code.toLowerCase();
  return clean === "fhir" ? "fhir-i" : clean;
}

function withoutHtml(file: string): string {
  return file.replace(/\.html$/i, "");
}

function pageTopic(file: string): string {
  const base = withoutHtml(path.basename(file)).replace(/\.svg$/i, "");
  return base.split("-")[0].toLowerCase();
}

function inferPageWg(topic: string, workgroups: Map<string, string>): { wg: string; note: string } {
  const direct = workgroups.get(topic);
  if (direct) return { wg: jiraWg(direct), note: `fhir.ini [workgroups] ${topic}=${direct}` };

  const rules: [RegExp, string, string][] = [
    [/^(clinicalreasoning|library|measure|plandefinition|activitydefinition|questionnaire|questionnaireresponse)/, "cds", "clinical reasoning/CDS heuristic"],
    [/^(codesystem|valueset|conceptmap|terminology|bindings|identifier|namingsystem)/, "vocab", "terminology heuristic"],
    [/^(medication|dosage|pharmacy)/, "phx", "medication/pharmacy heuristic"],
    [/^(financial|claim|coverage|payment|invoice|account|remittance|insurance)/, "fm", "financial heuristic"],
    [/^(administration|patient|person|practitioner|organization|location|encounter|episodeofcare|schedule|slot|appointment|healthcareservice)/, "pa", "patient administration heuristic"],
    [/^(diagnostics|observation|specimen|device|biologically|nutrition|service|transport)/, "oo", "orders/observations heuristic"],
    [/^(messaging|message|exchanging)/, "inm", "infrastructure messaging heuristic"],
    [/^(documents|cda|composition|clinicalsummary)/, "sd", "structured documents heuristic"],
    [/^(security|auditevent|provenance|consent)/, "sec", "security heuristic"],
    [/^(genomics|molecular)/, "cg", "genomics heuristic"],
    [/^(medication-definition|regulated|medicinal|manufactured|packaged|ingredient|substance|marketingstatus)/, "brr", "biomedical research/regulation heuristic"],
    [/^(foundation|conformance|datatypes|elementdefinition|extension|extensibility|narrative|formats|json|xml|rdf|ttl|http|search|async|comparison|diff|documentation|fhirpath|mapping|graphql|modules|downloads|history|license|credits|index|help|glossary|best|change|lifecycle|logical|managing|ns|operations?)/, "fhir", "FHIR infrastructure heuristic"],
  ];
  for (const [regex, code, note] of rules) {
    if (regex.test(topic)) return { wg: jiraWg(code), note };
  }
  return { wg: "unknown", note: `no workgroup rule matched topic ${topic}` };
}

function fileTopic(file: string, workgroups: Map<string, string>): { topic?: string; wg?: string; note?: string } {
  const clean = file.replace(/\\/g, "/").replace(/^[ab]\//, "");
  const parts = clean.split("/");
  const sourceIndex = parts.indexOf("source");
  if (sourceIndex >= 0) {
    const first = parts[sourceIndex + 1];
    if (!first) return {};
    const topic = parts[sourceIndex + 2] ? first.toLowerCase() : pageTopic(first);
    const inferred = inferPageWg(topic, workgroups);
    return { topic, wg: inferred.wg, note: inferred.note };
  }

  const basename = path.basename(clean).toLowerCase();
  const direct = [...workgroups.keys()].sort((a, b) => b.length - a.length).find((key) => basename.includes(key));
  if (direct) {
    const inferred = inferPageWg(direct, workgroups);
    return { topic: direct, wg: inferred.wg, note: `filename contains ${direct}; ${inferred.note}` };
  }
  return {};
}

const workgroups = (() => {
  const file = path.join(run.fhirRepo!, "source", "fhir.ini");
  return existsSync(file) ? parseWorkgroups(file) : new Map<string, string>();
})();

function inferCommitWg(issueKey: string | undefined, files: string[]): WgInference {
  const votes = new Map<string, { score: number; reasons: Set<string>; files: Set<string> }>();
  function add(wg: string | undefined, score: number, reason: string, file?: string): void {
    if (!wg) return;
    const clean = jiraWg(wg);
    const entry = votes.get(clean) ?? { score: 0, reasons: new Set(), files: new Set() };
    entry.score += score;
    entry.reasons.add(reason);
    if (file) entry.files.add(file);
    votes.set(clean, entry);
  }

  for (const file of files) {
    const inferred = fileTopic(file, workgroups);
    add(inferred.wg, 3, inferred.note ? `changed file: ${inferred.note}` : "changed file path", file);
  }

  const chunk = chunkFor(issueKey);
  for (const targetChunk of chunk?.targetChunks ?? []) {
    const match = String(targetChunk).match(/^([a-z0-9-]+)--/i);
    add(match?.[1], 2, `issue target chunk ${targetChunk}`);
  }
  for (const sourcePath of chunk?.sourcePaths ?? []) {
    const inferred = fileTopic(String(sourcePath), workgroups);
    add(inferred.wg, 1, inferred.note ? `issue source path: ${inferred.note}` : "issue source path", String(sourcePath));
  }
  add(chunk?.wg, 1, "issue chunk wg field");
  add(chunk?.wgSourceCode, 1, "issue chunk wgSourceCode field");

  if (!votes.size) {
    return { wg: "unknown", wg_label: wgNames.unknown, wg_confidence: "low", wg_evidence: [] };
  }

  const evidence = [...votes.entries()]
    .map(([wg, entry]) => ({
      wg,
      label: wgNames[wg] ?? wg,
      score: entry.score,
      reasons: [...entry.reasons].sort(),
      files: [...entry.files].sort(),
    }))
    .sort((a, b) => b.score - a.score || a.wg.localeCompare(b.wg));
  const top = evidence[0];
  const second = evidence[1];
  const confidence: "high" | "medium" | "low" =
    !second || top.score >= second.score + 3 ? "high" :
    top.score > second.score ? "medium" :
    "low";
  return {
    wg: top.wg,
    wg_label: top.label,
    wg_confidence: confidence,
    wg_evidence: evidence.slice(0, 5),
  };
}

function runCommandBig(args: string[], options: { cwd?: string; allowFailure?: boolean; maxBuffer?: number } = {}): string {
  const proc = spawnSync(args[0], args.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (proc.status !== 0 && !options.allowFailure) {
    throw new Error([
      `command failed: ${args.join(" ")}`,
      `cwd=${options.cwd ?? process.cwd()}`,
      `exit=${proc.status}`,
      proc.stderr?.trim(),
    ].filter(Boolean).join("\n"));
  }
  return proc.stdout ?? "";
}

function patchForCommit(sha: string, files: string[]): Pick<CommitReport, "patch" | "patch_truncated" | "omitted_patch_files"> {
  const numstat = runCommand(["git", "show", "--format=", "--numstat", "--find-renames", "--find-copies", sha], { cwd: run.fhirRepo });
  const changedLinesByPath = new Map<string, number>();
  for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? Number.POSITIVE_INFINITY : Number(parts[0] || 0);
    const deleted = parts[1] === "-" ? Number.POSITIVE_INFINITY : Number(parts[1] || 0);
    changedLinesByPath.set(parts.slice(2).join("\t"), added + deleted);
  }

  const omitted: { file: string; reason: string }[] = [];
  const patches: string[] = [];
  let remaining = maxPatchBytes;
  let truncated = false;

  for (const file of files) {
    const changedLines = changedLinesByPath.get(file);
    if (changedLines !== undefined && changedLines > maxFileDiffLines) {
      omitted.push({ file, reason: `omitted from embedded view: ${changedLines} changed lines exceeds ${maxFileDiffLines}` });
      continue;
    }
    if (remaining <= 0) {
      omitted.push({ file, reason: `omitted from embedded view: commit patch exceeded ${maxPatchBytes} bytes` });
      truncated = true;
      continue;
    }
    const patch = runCommandBig([
      "git",
      "show",
      "--format=",
      "--patch",
      "--find-renames",
      "--find-copies",
      "--no-ext-diff",
      "--unified=3",
      sha,
      "--",
      file,
    ], { cwd: run.fhirRepo, allowFailure: true, maxBuffer: 32 * 1024 * 1024 });
    if (!patch.trim()) continue;
    if (patch.length > remaining) {
      patches.push(`${patch.slice(0, remaining)}\n\n[EMBEDDED DIFF TRUNCATED: commit patch exceeded ${maxPatchBytes} bytes. Use the GitHub full diff link for complete content.]\n`);
      omitted.push({ file, reason: `truncated in embedded view: commit patch exceeded ${maxPatchBytes} bytes` });
      truncated = true;
      remaining = 0;
      continue;
    }
    patches.push(patch);
    remaining -= patch.length;
  }

  if (omitted.length) {
    patches.push([
      "diff --git a/.autofhir-omitted-diffs b/.autofhir-omitted-diffs",
      "--- a/.autofhir-omitted-diffs",
      "+++ b/.autofhir-omitted-diffs",
      "@@ omitted large per-file diffs @@",
      ...omitted.map((item) => ` ${item.file}: ${item.reason}`),
      "",
    ].join("\n"));
  }

  return {
    patch: patches.join("\n"),
    patch_truncated: truncated || omitted.length > 0,
    omitted_patch_files: omitted.length ? omitted : undefined,
  };
}

function baseRef(): string {
  if (run.baseSha) return run.baseSha;
  if (run.baseRef) return runCommand(["git", "merge-base", run.baseRef, run.combinedBranch], { cwd: run.fhirRepo! }).trim();
  return runCommand(["git", "merge-base", "master", run.combinedBranch], { cwd: run.fhirRepo! }).trim();
}

const base = baseRef();
const head = runCommand(["git", "rev-parse", run.combinedBranch], { cwd: run.fhirRepo }).trim();
const shas = runCommand(["git", "rev-list", "--reverse", `${base}..${run.combinedBranch}`], { cwd: run.fhirRepo })
  .split(/\r?\n/)
  .filter(Boolean);
const githubRepo = "jmandel/autofhir";
const githubTreeUrl = `https://github.com/${githubRepo}/tree/${runId}`;
const githubCompareUrl = `https://github.com/${githubRepo}/compare/${base}...${head}`;
const reviewArtifactBranch = `review-${runId}`;
const reviewArtifactDir = runId;
const reviewRawBaseUrl = `https://raw.githubusercontent.com/${githubRepo}/${reviewArtifactBranch}/${reviewArtifactDir}/`;
const reviewGithubTreeUrl = `https://github.com/${githubRepo}/tree/${reviewArtifactBranch}/${reviewArtifactDir}`;
const reviewPagesUrl = `https://jmandel.github.io/autofhir/${reviewArtifactDir}/`;
const sourceRunId = run.chunkSource?.kind === "issue-mapping-not-fully-applied" ? run.chunkSource.path : undefined;
const sourceIssueMappingReportPath = sourceRunId
  ? path.join(runPath(sourceRunId), "review", "issue-mapping-report.json")
  : undefined;
const sourceIssueMappingReportGzipName = "source-issue-mapping-report.json.gz";
const sourceIssueMappingReportGzipPath = path.join(outDir, sourceIssueMappingReportGzipName);

function writeGzipIfNeeded(source: string, dest: string): void {
  if (!existsSync(source)) return;
  const sourceStat = statSync(source);
  const destFresh = existsSync(dest) && statSync(dest).mtimeMs >= sourceStat.mtimeMs;
  if (destFresh) return;
  writeFileSync(dest, gzipSync(readFileSync(source)));
}

if (sourceIssueMappingReportPath) writeGzipIfNeeded(sourceIssueMappingReportPath, sourceIssueMappingReportGzipPath);

const commits: CommitReport[] = shas.map((sha, index) => {
  const meta = zsplit(runCommand([
    "git",
    "show",
    "-s",
    "--format=%H%x00%h%x00%an%x00%ai%x00%s%x00%B",
    sha,
  ], { cwd: run.fhirRepo }));
  const [fullSha, shortSha, author, authoredAt, subject, body = ""] = meta;
  const commitMessage = parsedCommitMessage(subject, body);
  const issueKey = issueKeyFor(body, subject);
  const result = resultFor(issueKey);
  const resultPath = issueKey && existsSync(path.join(root, "results", `${issueKey}.json`))
    ? path.relative(root, path.join(root, "results", `${issueKey}.json`))
    : undefined;
  const files = runCommand(["git", "show", "--format=", "--name-only", sha], { cwd: run.fhirRepo })
    .split(/\r?\n/)
    .filter(Boolean);
  const stat = runCommand(["git", "show", "--format=", "--stat", "--find-renames", sha], { cwd: run.fhirRepo });
  const patch = patchForCommit(sha, files);
  const wg = inferCommitWg(issueKey, files);
  return {
    sequence: index,
    sha: fullSha,
    short_sha: shortSha,
    author,
    authored_at: authoredAt,
    subject,
    body,
    issue_key: issueKey,
    status: result?.status,
    decision_status: result?.decision?.status,
    commit_summary: commitMessage.summary,
    commit_context: commitMessage.context,
    summary: result?.decision?.summary,
    recommendation: result?.decision?.recommendation,
    github_commit_url: `https://github.com/${githubRepo}/commit/${fullSha}`,
    result_path: resultPath,
    ...wg,
    files,
    stat,
    ...patch,
  };
});

function countBy(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

const report = {
  schema_version: "issue-fixup-diff-review-v1",
  generated_at: new Date().toISOString(),
  run: {
    run_id: runId,
    status: run.status,
    description: run.description,
    fhir_repo: run.fhirRepo,
    base,
    head,
    combined_branch: run.combinedBranch,
    github_repo: githubRepo,
    github_tree_url: githubTreeUrl,
    github_compare_url: githubCompareUrl,
    review_artifact_branch: reviewArtifactBranch,
    review_artifact_dir: reviewArtifactDir,
    review_raw_base_url: reviewRawBaseUrl,
    review_github_tree_url: reviewGithubTreeUrl,
    review_pages_url: reviewPagesUrl,
    source_run_id: sourceRunId,
    artifacts: {
      fixup_review_json: "issue-fixup-diff-report.json",
      fixup_review_json_gzip: "issue-fixup-diff-report.json.gz",
      source_issue_mapping_json_gzip: existsSync(sourceIssueMappingReportGzipPath) ? sourceIssueMappingReportGzipName : undefined,
      source_issue_mapping_json_source_path: sourceIssueMappingReportPath,
    },
    max_patch_bytes: maxPatchBytes,
    max_file_diff_lines: maxFileDiffLines,
  },
  counts: {
    commits: commits.length,
    with_issue_key: commits.filter((commit) => commit.issue_key).length,
    with_result: commits.filter((commit) => commit.result_path).length,
    fixed: commits.filter((commit) => commit.status === "fixed").length,
    no_change: commits.filter((commit) => commit.status === "no-change").length,
    ambiguous: commits.filter((commit) => commit.status === "ambiguous").length,
    by_status: countBy(commits.map((commit) => commit.status ?? commit.decision_status ?? "none")),
    by_wg: countBy(commits.map((commit) => commit.wg ?? "unknown")),
  },
  commits,
};

function scriptEscape(value: string): string {
  return value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function viewerHtml(data: typeof report): string {
  const json = scriptEscape(JSON.stringify(data));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoFHIR Issue Fixup Diffs</title>
<style>
:root { color-scheme: light; --bg:#f5f7fa; --panel:#fff; --line:#d5dbe3; --text:#17212b; --muted:#5f6f80; --blue:#1f6feb; --green:#176f3d; --red:#b42318; --yellow:#8a5a00; }
* { box-sizing: border-box; }
html, body { height:100%; overflow:hidden; }
body { margin:0; display:grid; grid-template-rows:auto auto auto minmax(0, 1fr); font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif; color:var(--text); background:var(--bg); }
header { min-width:0; background:var(--panel); border-bottom:1px solid var(--line); padding:14px 18px; }
h1 { margin:0 0 6px; font-size:20px; }
.meta { display:flex; flex-wrap:wrap; gap:8px 16px; color:var(--muted); }
.controls { min-width:0; display:grid; grid-template-columns:170px 180px minmax(240px,1fr) 190px 150px; gap:10px; padding:10px 18px; background:#eef2f6; border-bottom:1px solid var(--line); }
.reviewbar { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 18px; background:#fff; border-bottom:1px solid var(--line); }
.reviewbar .buttons { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
input, select, textarea, button { font:inherit; }
input, select, textarea { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--text); }
textarea { min-height:64px; resize:vertical; }
button { border:1px solid #aeb9c6; border-radius:6px; padding:7px 10px; background:#fff; color:#17212b; cursor:pointer; }
button:hover { background:#f1f5f9; }
button.primary { background:#1f6feb; color:#fff; border-color:#1f6feb; }
button.copied { background:#176f3d; color:#fff; border-color:#176f3d; }
.button-link { display:inline-block; border:1px solid #aeb9c6; border-radius:6px; padding:7px 10px; background:#fff; color:#17212b; text-decoration:none; }
.button-link.primary { background:#1f6feb; color:#fff; border-color:#1f6feb; }
main { min-width:0; min-height:0; display:grid; grid-template-columns:minmax(360px, 32%) minmax(0, 1fr); overflow:hidden; }
.list { min-height:0; border-right:1px solid var(--line); overflow:auto; background:var(--panel); }
.detail { min-height:0; overflow:auto; padding:16px 18px 40px; background:#f7f9fb; scroll-behavior:auto; }
.row { padding:11px 13px; border-bottom:1px solid var(--line); cursor:pointer; border-left:4px solid transparent; }
.row:hover, .row.active { background:#eaf2ff; }
.row.active { border-left-color:var(--blue); }
.group-header { position:sticky; top:0; z-index:1; padding:7px 13px; border-bottom:1px solid var(--line); background:#f1f5f9; color:#4d5d6c; font-size:12px; font-weight:750; text-transform:uppercase; letter-spacing:.04em; }
.detail-group { margin:0 0 10px; padding:8px 10px; border:1px solid var(--line); border-radius:6px; background:#edf2f7; color:#4d5d6c; font-weight:750; }
.row-title { font-weight:650; margin-bottom:5px; }
.row-summary { color:#263340; margin-bottom:7px; }
.chips { display:flex; flex-wrap:wrap; gap:5px; }
.chip { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 7px; font-size:12px; color:var(--muted); background:#fff; }
.fixed { border-color:#9bd4b3; color:var(--green); }
.no-change { border-color:#b7c7d9; color:#365a7e; }
.ambiguous { border-color:#e8c46a; color:var(--yellow); }
.blocked { border-color:#efaaa3; color:var(--red); }
.approve { border-color:#9bd4b3; color:var(--green); }
.reject { border-color:#efaaa3; color:var(--red); }
.defer { border-color:#e8c46a; color:var(--yellow); }
.undecided { border-color:#d5dbe3; color:#5f6f80; }
a { color:var(--blue); text-decoration:none; }
a:hover { text-decoration:underline; }
.full-link { display:inline-block; margin-left:8px; border:1px solid #8bb8ff; border-radius:6px; padding:4px 8px; background:#eaf2ff; color:#084594; font-size:13px; font-weight:650; }
.commit-card { background:#fff; border:1px solid var(--line); border-radius:8px; margin:0 0 18px; overflow:hidden; }
.commit-card.active { border-color:#8bb8ff; box-shadow:0 0 0 2px #dbeafe; }
.card-head { padding:14px 16px; border-bottom:1px solid var(--line); background:#fff; }
.card-head h2 { margin:0 0 8px; font-size:18px; }
.card-meta { display:flex; flex-wrap:wrap; gap:8px 14px; color:var(--muted); margin-top:8px; }
.decision-grid { display:grid; grid-template-columns:300px 1fr; gap:10px; margin-top:12px; }
.decision-actions { display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; }
.decision-button { font-weight:650; }
.decision-button.approve.active { border-color:#176f3d; background:#e6ffed; color:#176f3d; }
.decision-button.reject.active { border-color:#b42318; background:#ffebe9; color:#82071e; }
.decision-button.defer.active { border-color:#8a5a00; background:#fff8db; color:#8a5a00; }
.card-body { padding:14px 16px 18px; }
.section { margin:0 0 16px; }
.section h3 { margin:0 0 8px; font-size:15px; border-bottom:1px solid var(--line); padding-bottom:4px; }
pre { margin:0; overflow:auto; white-space:pre; tab-size:2; }
.commit-message { white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
.review-text { white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.box { border:1px solid var(--line); border-radius:6px; background:#f7f9fb; padding:10px; }
.files { columns:2; column-gap:22px; }
.diff { border:1px solid var(--line); border-radius:6px; background:#fff; overflow-y:auto; overflow-x:hidden; padding:10px; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
.empty { padding:30px; color:var(--muted); }
.render-progress { position:sticky; top:0; z-index:3; border:1px solid #8bb8ff; background:#eaf2ff; color:#084594; border-radius:6px; padding:10px; margin:0 0 12px; font-weight:650; }
.notice { border:1px solid #e8c46a; background:#fff8db; color:#5f4300; border-radius:6px; padding:10px; }
.notice.critical { border-color:#d1242f; background:#fff1f1; color:#82071e; font-weight:650; }
.help { color:var(--muted); font-size:13px; }
@media (max-width: 1050px) { .controls { grid-template-columns:1fr 1fr; } .reviewbar { align-items:flex-start; flex-direction:column; } main { grid-template-columns:1fr; grid-template-rows:minmax(140px, 34%) minmax(0, 1fr); } .list { border-right:0; border-bottom:1px solid var(--line); } .decision-grid { grid-template-columns:1fr; } .files { columns:1; } }
</style>
</head>
<body>
<header>
  <h1>AutoFHIR Issue Fixup Diffs</h1>
  <div class="meta" id="meta"></div>
</header>
<div class="controls">
  <select id="status"><option value="">All results</option></select>
  <select id="wg"><option value="">All work groups</option></select>
  <select id="file"><option value="">All changed files</option></select>
  <select id="reviewDecision"><option value="">All review choices</option></select>
  <select id="sort"><option value="wg">Group by work group</option><option value="branch">Commit order</option></select>
</div>
<div class="reviewbar">
  <div><div id="reviewCounts"></div><div class="help">Shortcuts: <strong>A</strong> approve, <strong>R</strong> reject, <strong>D</strong> defer, <strong>J/K</strong> next/previous, <strong>C</strong> copy review plan.</div></div>
  <div class="buttons">
    <a id="fullBranchDiff" class="button-link primary" target="_blank" rel="noreferrer" href="#">Full Branch Diff on GitHub</a>
    <button id="copyReviewPlan" class="primary">Copy Review Plan</button>
    <button id="clearVisible">Clear Visible Review State</button>
  </div>
</div>
<main>
  <div class="list" id="list"></div>
  <div class="detail" id="detail"><div class="empty">Loading commits.</div></div>
</main>
<script id="report-data" type="application/json">${json}</script>
<script>
const report = JSON.parse(document.getElementById('report-data').textContent);
const statusSel = document.getElementById('status');
const wgSel = document.getElementById('wg');
const fileSel = document.getElementById('file');
const reviewDecisionSel = document.getElementById('reviewDecision');
const sortSel = document.getElementById('sort');
const list = document.getElementById('list');
const detail = document.getElementById('detail');
const reviewCounts = document.getElementById('reviewCounts');
let selected = null;
let observer = null;
let detailRenderToken = 0;
const storageKey = 'issue-fixup-review:' + report.run.run_id;
const reviewOptions = [
  ['undecided', 'Undecided'],
  ['approve', 'Approve'],
  ['reject', 'Reject'],
  ['defer', 'Defer']
];
let reviewState = loadReviewState();

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function chip(value) { return value ? '<span class="chip ' + esc(value) + '">' + esc(value) + '</span>' : ''; }
function outcomeLabel(value) {
  return ({
    'fixed': 'Source change made',
    'no-change': 'No source change needed',
    'ambiguous': 'Needs human review',
    'blocked': 'Blocked',
    'none': 'Missing review data'
  })[value || 'none'] || value;
}
function outcomeChip(value) {
  return value ? '<span class="chip ' + esc(value) + '" title="' + esc(outcomeLabel(value)) + '">' + esc(value) + '</span>' : '';
}
function issueLink(key) { return /^FHIR-\\d+$/.test(key || '') ? '<a href="https://jira.hl7.org/browse/' + esc(key) + '">' + esc(key) + '</a>' : esc(key || ''); }
function commitLink(c, label) { return c.github_commit_url ? '<a class="full-link" target="_blank" rel="noreferrer" href="' + esc(c.github_commit_url) + '">' + esc(label) + '</a>' : ''; }
function uniq(values) { return [...new Set(values.filter(Boolean))].sort(); }
function wgName(c) { return c.wg_label || c.wg || 'Unknown'; }
function wgCode(c) { return c.wg || 'unknown'; }
function wgTitle(c) { return wgCode(c) + ' · ' + wgName(c); }
function statusValue(c) { return c.status || c.decision_status || 'none'; }
const allStatuses = uniq(report.commits.map(statusValue));
const allWgs = uniq(report.commits.map(c => wgCode(c))).sort((a, b) => {
  const ac = report.commits.find(c => wgCode(c) === a);
  const bc = report.commits.find(c => wgCode(c) === b);
  return wgName(ac || {}).localeCompare(wgName(bc || {})) || a.localeCompare(b);
});
const allFiles = uniq(report.commits.flatMap(c => c.files || []));
const allReviewValues = reviewOptions.map(([value]) => value);
document.getElementById('fullBranchDiff').href = report.run.github_compare_url || '#';

document.getElementById('meta').innerHTML = [
  'Run: ' + esc(report.run.run_id),
  'Branch: ' + esc(report.run.combined_branch),
  'Commits: ' + report.counts.commits,
  'With results: ' + report.counts.with_result,
  'WGs: ' + Object.keys(report.counts.by_wg || {}).length,
  'Embedded diff caps: ' + Math.round(report.run.max_patch_bytes / 1000) + 'KB/commit and ' + report.run.max_file_diff_lines + ' changed lines/file',
  'Generated: ' + esc(report.generated_at)
].map(x => '<span>' + x + '</span>').join('');

function loadReviewState() {
  try { return JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; }
  catch { return {}; }
}
function saveReviewState() {
  localStorage.setItem(storageKey, JSON.stringify(reviewState));
  renderCounts();
}
function stateFor(sha) {
  if (!reviewState[sha]) reviewState[sha] = { decision: 'undecided', note: '' };
  if (reviewState[sha].decision === 'pick') reviewState[sha].decision = 'approve';
  if (reviewState[sha].decision === 'drop') reviewState[sha].decision = 'reject';
  if (reviewState[sha].decision === 'needs-revision' || reviewState[sha].decision === 'needs-human-review' || reviewState[sha].decision === 'hold-for-later') reviewState[sha].decision = 'defer';
  return reviewState[sha];
}
function decisionLabel(value) {
  return (reviewOptions.find(([v]) => v === value) || ['', value || ''])[1];
}
function selectedDecisionValue(c) {
  return stateFor(c.sha).decision || 'undecided';
}
function renderCounts() {
  const counts = { undecided: 0, approve: 0, reject: 0, defer: 0 };
  for (const c of report.commits) counts[selectedDecisionValue(c)] = (counts[selectedDecisionValue(c)] || 0) + 1;
  reviewCounts.innerHTML = [
    'Your review:',
    'approve ' + counts.approve,
    'reject ' + counts.reject,
    'defer ' + counts.defer,
    'undecided ' + counts.undecided
  ].map(esc).join(' · ');
}
function displaySummary(c) {
  return c.commit_summary || c.summary || '';
}
function ordered(rows) {
  const copy = rows.slice();
  if (sortSel.value === 'wg') {
    copy.sort((a, b) =>
      wgName(a).localeCompare(wgName(b)) ||
      wgCode(a).localeCompare(wgCode(b)) ||
      (a.sequence ?? 0) - (b.sequence ?? 0)
    );
  } else {
    copy.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  }
  return copy;
}
function passesFilters(c, ignore) {
  return (ignore === 'status' || !statusSel.value || statusValue(c) === statusSel.value) &&
    (ignore === 'wg' || !wgSel.value || wgCode(c) === wgSel.value) &&
    (ignore === 'file' || !fileSel.value || (c.files || []).includes(fileSel.value)) &&
    (ignore === 'reviewDecision' || !reviewDecisionSel.value || selectedDecisionValue(c) === reviewDecisionSel.value);
}
function countFacet(rows, valuesFor) {
  const counts = new Map();
  for (const c of rows) {
    for (const value of valuesFor(c)) counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}
function setSelectOptions(sel, allLabel, values, counts, labelFor, allCount) {
  const current = sel.value;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = allLabel + ' (' + allCount + ')';
  sel.appendChild(all);
  const visible = values.filter(value => (counts.get(value) || 0) > 0 || value === current);
  for (const value of visible) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labelFor(value) + ' (' + (counts.get(value) || 0) + ')';
    sel.appendChild(option);
  }
  sel.value = visible.includes(current) ? current : '';
}
function updateFilterOptions() {
  const statusRows = report.commits.filter(c => passesFilters(c, 'status'));
  setSelectOptions(statusSel, 'All results', allStatuses, countFacet(statusRows, c => [statusValue(c)]), outcomeLabel, statusRows.length);

  const wgRows = report.commits.filter(c => passesFilters(c, 'wg'));
  setSelectOptions(wgSel, 'All work groups', allWgs, countFacet(wgRows, c => [wgCode(c)]), value => {
    const sample = report.commits.find(c => wgCode(c) === value) || {};
    return value + ' · ' + wgName(sample);
  }, wgRows.length);

  const fileRows = report.commits.filter(c => passesFilters(c, 'file'));
  setSelectOptions(fileSel, 'All changed files', allFiles, countFacet(fileRows, c => c.files || []), value => value, fileRows.length);

  const reviewRows = report.commits.filter(c => passesFilters(c, 'reviewDecision'));
  setSelectOptions(reviewDecisionSel, 'All review choices', allReviewValues, countFacet(reviewRows, c => [selectedDecisionValue(c)]), decisionLabel, reviewRows.length);
}
function filtered() {
  return ordered(report.commits.filter(c => passesFilters(c, null)));
}
function renderList() {
  const rows = filtered();
  let lastGroup = null;
  list.innerHTML = rows.length ? rows.map(c => {
    const decision = selectedDecisionValue(c);
    const header = sortSel.value === 'wg' && wgTitle(c) !== lastGroup
      ? (lastGroup = wgTitle(c), '<div class="group-header">' + esc(wgTitle(c)) + '</div>')
      : '';
    return header + '<div class="row ' + (c.sha === selected ? 'active' : '') + '" data-sha="' + esc(c.sha) + '">' +
      '<div class="row-title">' + esc(c.short_sha) + ' ' + esc(c.subject) + '</div>' +
      '<div class="row-summary">' + esc(displaySummary(c)) + '</div>' +
      '<div class="chips">' + chip(c.issue_key) + outcomeChip(c.status || c.decision_status) + chip(wgCode(c)) + '<span class="chip ' + esc(decision) + '">' + esc(decisionLabel(decision)) + '</span>' + chip((c.files || []).length + ' files') + '</div>' +
    '</div>';
  }).join('') : '<div class="empty">No commits match.</div>';
}
function diffHtml(patch) {
  return esc(patch || '');
}
function reviewSelectHtml(c) {
  const current = selectedDecisionValue(c);
  return '<div class="decision-actions" data-sha="' + esc(c.sha) + '">' +
    reviewOptions.filter(([value]) => value !== 'undecided').map(([value, label]) =>
      '<button type="button" class="decision-button ' + esc(value) + (value === current ? ' active' : '') + '" data-sha="' + esc(c.sha) + '" data-review="' + esc(value) + '">' + esc(label) + '</button>'
    ).join('') +
    '</div>';
}
function resultJsonContextHtml(c) {
  if (!c.summary && !c.recommendation) return '';
  const summary = c.summary ? '<div><strong>Summary</strong><div class="box">' + esc(c.summary) + '</div></div>' : '';
  const recommendation = c.recommendation ? '<div style="margin-top:10px"><strong>Recommendation</strong><div class="box">' + esc(c.recommendation) + '</div></div>' : '';
  return '<details class="section"><summary><strong>Agent Assessment</strong></summary>' + summary + recommendation + '</details>';
}
function wgInferenceHtml(c) {
  const evidence = c.wg_evidence || [];
  if (!evidence.length) return '<div class="section"><h3>Likely Owning Work Group</h3><div class="box">' + esc(wgTitle(c)) + ' · confidence ' + esc(c.wg_confidence || 'low') + '</div></div>';
  return '<details class="section"><summary><strong>Likely Owning Work Group</strong>: ' + esc(wgTitle(c)) + ' · confidence ' + esc(c.wg_confidence || 'low') + '</summary><div class="box">' +
    evidence.map(item =>
      '<p><strong>' + esc(item.wg + ' · ' + item.label) + '</strong> score ' + esc(item.score) + '<br>' +
      esc((item.reasons || []).join('; ')) +
      ((item.files || []).length ? '<br><span class="help">' + esc((item.files || []).slice(0, 10).join(', ')) + ((item.files || []).length > 10 ? ' ...' : '') + '</span>' : '') +
      '</p>'
    ).join('') +
    '</div></details>';
}
function commitCard(c) {
  const state = stateFor(c.sha);
  const decision = selectedDecisionValue(c);
  const omitted = (c.omitted_patch_files || []).length
    ? '<div class="section"><div class="notice critical">Embedded diff is incomplete for this commit. Some very large file diffs were omitted or truncated here; use the GitHub full diff link for complete content.<br>' + (c.omitted_patch_files || []).map(item => esc(item.file + ': ' + item.reason)).join('<br>') + '</div></div>'
    : '';
  const reviewText = [
    'Jira Issue: ' + (c.issue_key || '(none)'),
    'Result: ' + outcomeLabel(c.status || c.decision_status || 'none'),
    'Work Group: ' + wgTitle(c),
    'Author: ' + c.author,
    'Authored: ' + c.authored_at,
    'SHA: ' + c.sha,
    c.result_path ? 'Agent report: ' + c.result_path : 'Agent report: none',
    '',
    'WHAT CHANGED',
    displaySummary(c) || '(no summary)',
    c.commit_context || '',
    '',
    c.summary ? 'AGENT SUMMARY\\n' + c.summary + '\\n' : '',
    c.recommendation ? 'AGENT RECOMMENDATION\\n' + c.recommendation + '\\n' : '',
    'FILES',
    ...(c.files || ['(none)']),
    '',
    'COMMIT MESSAGE',
    c.body || '',
    '',
    'STAT',
    c.stat || '',
    '',
    'DIFF',
    c.patch || '(empty commit; no source diff)',
  ].filter(value => value !== undefined).join('\\n');
  return '<article class="commit-card ' + (c.sha === selected ? 'active' : '') + '" id="commit-' + esc(c.sha) + '" data-sha="' + esc(c.sha) + '">' +
    '<div class="card-head">' +
      '<h2>' + esc(c.short_sha) + ' ' + esc(c.subject) + commitLink(c, c.patch_truncated ? 'Full diff on GitHub (required)' : 'Full diff on GitHub') + '</h2>' +
      '<div class="chips">' + chip(c.issue_key) + outcomeChip(c.status || c.decision_status) + chip(wgCode(c)) + '<span class="chip review-chip ' + esc(decision) + '">' + esc(decisionLabel(decision)) + '</span>' + chip((c.files || []).length + ' files') + (c.patch_truncated ? chip('embedded diff incomplete') : '') + '</div>' +
      '<div class="card-meta"><span>Author: ' + esc(c.author) + '</span><span>Authored: ' + esc(c.authored_at) + '</span><span>WG: ' + esc(wgTitle(c)) + '</span><span>SHA: ' + esc(c.sha) + '</span></div>' +
      '<div class="decision-grid"><div>' + reviewSelectHtml(c) + '</div><textarea class="decision-note" data-sha="' + esc(c.sha) + '" placeholder="Optional review note for later apply/exclude context">' + esc(state.note || '') + '</textarea></div>' +
    '</div>' +
    '<div class="card-body">' +
      '<div class="section"><p>' + issueLink(c.issue_key) + (c.result_path ? ' · <code>' + esc(c.result_path) + '</code>' : ' · no agent report') + '</p></div>' +
      omitted +
      '<pre class="box review-text">' + esc(reviewText) + '</pre>' +
    '</div>' +
  '</article>';
}
function renderDetail() {
  const token = ++detailRenderToken;
  const rows = filtered();
  if (!rows.length) { detail.innerHTML = '<div class="empty">No commits match.</div>'; return; }
  if (!rows.some(c => c.sha === selected)) selected = rows[0].sha;
  if (observer) observer.disconnect();
  observer = null;
  const progressId = 'render-progress-' + token;
  detail.innerHTML = '<div class="render-progress" id="' + progressId + '">Rendering searchable diffs 0/' + rows.length + '</div>';
  let index = 0;
  let lastGroup = null;
  const appendBatch = () => {
    if (token !== detailRenderToken) return;
    const parts = [];
    const end = Math.min(rows.length, index + 12);
    for (; index < end; index++) {
      const c = rows[index];
      const header = sortSel.value === 'wg' && wgTitle(c) !== lastGroup
        ? (lastGroup = wgTitle(c), '<div class="detail-group">' + esc(wgTitle(c)) + '</div>')
        : '';
      parts.push(header + commitCard(c));
    }
    const wrapper = document.createElement('div');
    wrapper.innerHTML = parts.join('');
    const fragment = document.createDocumentFragment();
    while (wrapper.firstChild) fragment.appendChild(wrapper.firstChild);
    detail.appendChild(fragment);
    const progress = document.getElementById(progressId);
    if (index < rows.length) {
      if (progress) progress.textContent = 'Rendering searchable diffs ' + index + '/' + rows.length;
      setTimeout(appendBatch, 0);
    } else {
      if (progress) progress.remove();
      installObserver();
      updateActive(selected, true);
    }
  };
  setTimeout(appendBatch, 0);
}
function updateActive(sha, scrollSidebar) {
  selected = sha;
  for (const el of document.querySelectorAll('.row, .commit-card')) el.classList.toggle('active', el.dataset.sha === sha);
  if (scrollSidebar) {
    const row = list.querySelector('[data-sha="' + CSS.escape(sha) + '"]');
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }
}
function installObserver() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    const visible = entries.filter(e => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) updateActive(visible.target.dataset.sha, true);
  }, { root: detail, threshold: [0.2, 0.55, 0.9] });
  for (const card of detail.querySelectorAll('.commit-card')) observer.observe(card);
}
function decisionPayload(rows) {
  return {
    schema_version: 'issue-fixup-review-decisions-v1',
    run_id: report.run.run_id,
    combined_branch: report.run.combined_branch,
    base: report.run.base,
    head: report.run.head,
    copied_at: new Date().toISOString(),
    decisions: rows.map(c => ({
      issue_key: c.issue_key || null,
      sha: c.sha,
      short_sha: c.short_sha,
      subject: c.subject,
      result_status: c.status || c.decision_status || null,
      wg: c.wg || null,
      wg_label: c.wg_label || null,
      wg_confidence: c.wg_confidence || null,
      review_decision: selectedDecisionValue(c),
      review_decision_label: decisionLabel(selectedDecisionValue(c)),
      review_note: stateFor(c.sha).note || '',
      github_commit_url: c.github_commit_url || null,
      files: c.files || []
    }))
  };
}
function reviewedRows() {
  return report.commits.filter(c => selectedDecisionValue(c) !== 'undecided' || (stateFor(c.sha).note || '').trim());
}
async function copyText(value) {
  try { await navigator.clipboard.writeText(value); }
  catch {
    const box = document.createElement('textarea');
    box.value = value;
    document.body.appendChild(box);
    box.select();
    document.execCommand('copy');
    box.remove();
  }
}
async function copyWithFeedback(button, value) {
  await copyText(value);
  if (!button) return;
  const original = button.dataset.originalText || button.textContent;
  button.dataset.originalText = original;
  button.textContent = 'Copied';
  button.classList.add('copied');
  if (button.copyTimer) clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => {
    button.textContent = button.dataset.originalText || original;
    button.classList.remove('copied');
  }, 1200);
}
function reviewPlan() {
  const rows = reviewedRows();
  const payload = decisionPayload(rows);
  const approve = rows.filter(c => selectedDecisionValue(c) === 'approve');
  const reject = rows.filter(c => selectedDecisionValue(c) === 'reject');
  const defer = rows.filter(c => selectedDecisionValue(c) === 'defer');
  const lineFor = c => '- ' + c.sha + ' ' + (c.issue_key || '') + ' ' + c.subject + (stateFor(c.sha).note ? '\\n  Reviewer note: ' + stateFor(c.sha).note : '');
  const artifactUrl = name => name ? new URL(name, report.run.review_raw_base_url || location.href).href : '(not available)';
  const artifacts = report.run.artifacts || {};
  return [
    '# AutoFHIR Review Plan',
    '',
    'This whole file can be saved as prompt.md and given to an agent. The agent should use it as the review plan for deciding which commits from the AutoFHIR reconciliation branch to keep, drop, or defer.',
    '',
    'Branch location:',
    '- Local FHIR repository: ' + (report.run.fhir_repo || '(unknown)'),
    '- Local branch: ' + report.run.combined_branch,
    '- Base commit: ' + report.run.base,
    '- Current head: ' + report.run.head,
    '- GitHub compare: ' + (report.run.github_compare_url || '(not available)'),
    '- GitHub branch tree: ' + (report.run.github_tree_url || '(not available)'),
    '- Review app on GitHub Pages: ' + (report.run.review_pages_url || '(not available)'),
    '- Review app and artifact folder: ' + (report.run.review_github_tree_url || '(not available)'),
    '',
    'Downloadable context artifacts:',
    '- Full source discovery/issue-mapping JSON used as the input to this fixup run: ' + artifactUrl(artifacts.source_issue_mapping_json_gzip),
    '- Full fixup review JSON emitted by this run, which is the data this viewer is built from: ' + artifactUrl(artifacts.fixup_review_json),
    '- Gzipped fixup review JSON, if a smaller download is preferred: ' + artifactUrl(artifacts.fixup_review_json_gzip),
    '- Standalone review HTML: ' + artifactUrl('index.html'),
    '- Source run id: ' + (report.run.source_run_id || '(unknown)'),
    '',
    'How to apply:',
    '1. Start from the base commit above, or from the target branch that already contains that base.',
    '2. Cherry-pick the commits listed under KEEP in the order shown below.',
    '3. Do not apply commits listed under DROP.',
    '4. Treat DEFER as unresolved review work: inspect the note and original commit before deciding whether to apply it later.',
    '5. Resolve conflicts by preserving the reviewed intent, then run the normal FHIR build/tests appropriate for the touched files.',
    '',
    'Decision counts:',
    '- KEEP: ' + approve.length,
    '- DROP: ' + reject.length,
    '- DEFER: ' + defer.length,
    '- Reviewed rows with notes or decisions: ' + rows.length,
    '',
    '## KEEP',
    ...(approve.length ? approve.map(lineFor) : ['(none)']),
    '',
    '## DROP',
    ...(reject.length ? reject.map(lineFor) : ['(none)']),
    '',
    '## DEFER',
    ...(defer.length ? defer.map(lineFor) : ['(none)']),
    '',
    '## Structured Decisions',
    '',
    'The JSON below is the machine-readable copy of the same review plan.',
    '',
    'BEGIN STRUCTURED JSON',
    JSON.stringify(payload, null, 2),
    'END STRUCTURED JSON'
  ].join('\\n');
}
function rerender() {
  updateFilterOptions();
  renderList();
  renderDetail();
  renderCounts();
}
list.addEventListener('click', (event) => {
  const row = event.target.closest('.row');
  if (!row) return;
  selected = row.dataset.sha;
  updateActive(selected, false);
  const card = document.getElementById('commit-' + selected);
  if (card) card.scrollIntoView({ block: 'start', behavior: 'auto' });
});
function setReviewDecision(sha, decision) {
  stateFor(sha).decision = decision;
  saveReviewState();
  rerender();
}
detail.addEventListener('click', (event) => {
  const btn = event.target.closest('.decision-button');
  if (!btn) return;
  setReviewDecision(btn.dataset.sha, btn.dataset.review);
});
detail.addEventListener('input', (event) => {
  const note = event.target.closest('.decision-note');
  if (!note) return;
  stateFor(note.dataset.sha).note = note.value;
  saveReviewState();
});
document.getElementById('copyReviewPlan').addEventListener('click', (event) => copyWithFeedback(event.currentTarget, reviewPlan()));
document.getElementById('clearVisible').addEventListener('click', () => {
  if (!confirm('Clear review decisions and notes for visible commits?')) return;
  for (const c of filtered()) delete reviewState[c.sha];
  saveReviewState();
  rerender();
});
for (const el of [statusSel, wgSel, fileSel, reviewDecisionSel, sortSel]) el.addEventListener('input', rerender);
function visibleRows() { return filtered(); }
function goRelative(delta) {
  const rows = visibleRows();
  if (!rows.length) return;
  const index = Math.max(0, rows.findIndex(c => c.sha === selected));
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
  selected = next.sha;
  updateActive(selected, true);
  const card = document.getElementById('commit-' + selected);
  if (card) card.scrollIntoView({ block: 'start', behavior: 'auto' });
}
document.addEventListener('keydown', (event) => {
  const tag = document.activeElement?.tagName;
  const editing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (editing && event.key !== 'Escape') return;
  if (event.key === 'Escape' && editing) { document.activeElement.blur(); return; }
  if (!selected) return;
  const key = event.key.toLowerCase();
  if (key === 'a') { event.preventDefault(); setReviewDecision(selected, 'approve'); }
  else if (key === 'r') { event.preventDefault(); setReviewDecision(selected, 'reject'); }
  else if (key === 'd' || key === 'h') { event.preventDefault(); setReviewDecision(selected, 'defer'); }
  else if (key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); goRelative(1); }
  else if (key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); goRelative(-1); }
  else if (key === 'c') { event.preventDefault(); copyWithFeedback(document.getElementById('copyReviewPlan'), reviewPlan()); }
});
rerender();
</script>
</body>
</html>`;
}

const reportPath = path.join(outDir, "issue-fixup-diff-report.json");
const htmlPath = path.join(outDir, "issue-fixup-diff-viewer.html");
const indexPath = path.join(outDir, "index.html");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${reportPath}.gz`, gzipSync(readFileSync(reportPath)));
const appJsPath = path.join(outDir, "review-app.js");
const appCssPath = path.join(outDir, "review-app.css");
const build = spawnSync("bun", [
  "build",
  path.join(repoRoot, "autofhir/web/review-app/src/main.tsx"),
  "--target=browser",
  "--minify",
  "--outfile",
  appJsPath,
], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (build.status !== 0) {
  throw new Error([
    "failed to build review app",
    build.stdout?.trim(),
    build.stderr?.trim(),
  ].filter(Boolean).join("\n"));
}
writeFileSync(appCssPath, readFileSync(path.join(repoRoot, "autofhir/web/review-app/src/styles.css")));
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutoFHIR Issue Fixup Diffs</title>
<link rel="stylesheet" href="review-app.css">
</head>
<body>
<div id="root"><div class="empty">Loading review app.</div></div>
<script>window.__AUTOFHIR_REPORT_URL__ = "issue-fixup-diff-report.json";</script>
<script type="module" src="review-app.js"></script>
</body>
</html>`;
writeFileSync(htmlPath, html);
writeFileSync(indexPath, html);
writeFileSync(path.join(outDir, ".nojekyll"), "");

console.log(`report=${reportPath}`);
console.log(`html=${htmlPath}`);
console.log(`index=${indexPath}`);
console.log(`commits=${commits.length}`);
console.log(`base=${base}`);
console.log(`head=${head}`);
