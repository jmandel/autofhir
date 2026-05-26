#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  original_subject?: string;
  original_body?: string;
  fixup_status?: string;
  fixup_decision_status?: string;
  fixup_result_path?: string;
  audit_decision?: string;
  audit_confidence?: "high" | "medium" | "low";
  audit_reasoning?: string;
  audit_recommended_next_step?: string;
  audit_source_tweaks_needed?: string[];
  audit_result_path?: string;
  github_commit_url?: string;
  previous_issue_commits?: PreviousIssueCommit[];
  previous_issue_commits_omitted?: number;
  result_path?: string;
  wg?: string;
  wg_label?: string;
  wg_confidence?: "high" | "medium" | "low";
  wg_evidence?: WgEvidence[];
  files: string[];
  stat: string;
  patch: string;
  patch_url?: string;
  patch_bytes?: number;
  patch_truncated?: boolean;
  omitted_patch_files?: { file: string; reason: string }[];
};

type PreviousIssueCommit = {
  sha: string;
  short_sha: string;
  authored_at: string;
  author: string;
  subject: string;
  github_commit_url: string;
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
  return `Usage: bun autofhir/scripts/export-issue-fixup-diff-viewer.ts --run-id ID [--audit-run-id ID] [--out-dir DIR] [--max-patch-bytes N] [--max-file-diff-lines N] [--max-line-chars N]

Builds:
  autofhir/runs/<run-id>/review/issue-fixup-diff-report.json
  autofhir/runs/<run-id>/review/issue-fixup-diff-viewer.html
  autofhir/runs/<run-id>/review/index.html

The generated index.html loads a built React/Zustand review app plus the
JSON report for the run's combined branch.`;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const auditRunId = arg("--audit-run-id") ?? process.env.AUDIT_RUN_ID;

const maxPatchBytes = Number(arg("--max-patch-bytes") ?? "2500000");
const maxFileDiffLines = Number(arg("--max-file-diff-lines") ?? "25000");
const maxLineChars = Number(arg("--max-line-chars") ?? "50000");

const run = readRun(runId);
if (!run.fhirRepo) throw new Error(`run ${runId} has no fhirRepo`);
if (!run.combinedBranch) throw new Error(`run ${runId} has no combinedBranch`);
const auditRun = auditRunId ? readRun(auditRunId) : undefined;
if (auditRun && auditRun.workflow !== "issue-fixup-audit") throw new Error(`audit run ${auditRunId} is workflow=${auditRun.workflow ?? "(unset)"}`);
const branchRun = auditRun ?? run;
if (!branchRun.fhirRepo) throw new Error(`branch run ${branchRun.runId} has no fhirRepo`);
if (!branchRun.combinedBranch) throw new Error(`branch run ${branchRun.runId} has no combinedBranch`);
const artifactRunId = auditRunId ?? runId;

const root = runPath(runId);
const artifactRoot = runPath(artifactRunId);
const outDir = path.resolve(arg("--out-dir") ?? path.join(artifactRoot, "review"));
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

function auditResultFor(issueKey: string | undefined): any | undefined {
  if (!issueKey || !auditRunId) return undefined;
  const file = path.join(runPath(auditRunId), "results", `${issueKey}.json`);
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
  const file = path.join(branchRun.fhirRepo!, "source", "fhir.ini");
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

function truncatePatchLines(patch: string): { patch: string; truncatedLineCount: number } {
  let truncatedLineCount = 0;
  const lines = patch.split("\n").map((line) => {
    if (line.length <= maxLineChars) return line;
    truncatedLineCount++;
    const marker = ` ... [AUTOFHIR: embedded diff line truncated from ${line.length} chars at ${maxLineChars}; use the GitHub full diff link for complete content.]`;
    const keepChars = Math.max(0, maxLineChars - marker.length);
    return `${line.slice(0, keepChars)}${marker}`;
  });
  return { patch: lines.join("\n"), truncatedLineCount };
}

function patchForCommit(sha: string, files: string[]): Pick<CommitReport, "patch" | "patch_truncated" | "omitted_patch_files"> {
  const numstat = runCommand(["git", "show", "--format=", "--numstat", "--find-renames", "--find-copies", sha], { cwd: branchRun.fhirRepo });
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
    const rawPatch = runCommandBig([
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
    ], { cwd: branchRun.fhirRepo, allowFailure: true, maxBuffer: 32 * 1024 * 1024 });
    const { patch, truncatedLineCount } = truncatePatchLines(rawPatch);
    if (truncatedLineCount) {
      omitted.push({ file, reason: `truncated ${truncatedLineCount} embedded diff line(s) longer than ${maxLineChars} chars` });
      truncated = true;
    }
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
  if (branchRun.baseSha) return branchRun.baseSha;
  if (branchRun.baseRef) return runCommand(["git", "merge-base", branchRun.baseRef, branchRun.combinedBranch], { cwd: branchRun.fhirRepo! }).trim();
  return runCommand(["git", "merge-base", "master", branchRun.combinedBranch], { cwd: branchRun.fhirRepo! }).trim();
}

const base = baseRef();
const head = runCommand(["git", "rev-parse", branchRun.combinedBranch], { cwd: branchRun.fhirRepo }).trim();
const shas = runCommand(["git", "rev-list", "--reverse", `${base}..${branchRun.combinedBranch}`], { cwd: branchRun.fhirRepo })
  .split(/\r?\n/)
  .filter(Boolean);
const githubRepo = "jmandel/autofhir";
const upstreamGithubRepo = "HL7/fhir";
const githubTreeUrl = `https://github.com/${githubRepo}/tree/${artifactRunId}`;
const githubCompareUrl = `https://github.com/${githubRepo}/compare/${base}...${head}`;
const reviewArtifactBranch = `review-${artifactRunId}`;
const reviewArtifactDir = artifactRunId;
const reviewRawBaseUrl = `https://raw.githubusercontent.com/${githubRepo}/${reviewArtifactBranch}/${reviewArtifactDir}/`;
const reviewGithubTreeUrl = `https://github.com/${githubRepo}/tree/${reviewArtifactBranch}/${reviewArtifactDir}`;
const reviewPagesUrl = `https://jmandel.github.io/autofhir/${reviewArtifactDir}/`;
const sourceRunId = run.chunkSource?.kind === "issue-mapping-not-fully-applied" ? run.chunkSource.path : undefined;
const sourceIssueMappingReportPath = sourceRunId
  ? path.join(runPath(sourceRunId), "review", "issue-mapping-report.json")
  : undefined;
const sourceIssueMappingReportGzipName = "source-issue-mapping-report.json.gz";
const sourceIssueMappingReportGzipPath = path.join(outDir, sourceIssueMappingReportGzipName);
const sourceIssueFixupReviewReportPath = auditRunId
  ? path.join(root, "review", "issue-fixup-diff-report.json")
  : undefined;
const sourceIssueFixupReviewReportGzipName = "source-issue-fixup-review-report.json.gz";
const sourceIssueFixupReviewReportGzipPath = path.join(outDir, sourceIssueFixupReviewReportGzipName);

function writeGzipIfNeeded(source: string, dest: string): void {
  if (!existsSync(source)) return;
  const sourceStat = statSync(source);
  const destFresh = existsSync(dest) && statSync(dest).mtimeMs >= sourceStat.mtimeMs;
  if (destFresh) return;
  writeFileSync(dest, gzipSync(readFileSync(source)));
}

if (sourceIssueMappingReportPath) writeGzipIfNeeded(sourceIssueMappingReportPath, sourceIssueMappingReportGzipPath);
if (sourceIssueFixupReviewReportPath) writeGzipIfNeeded(sourceIssueFixupReviewReportPath, sourceIssueFixupReviewReportGzipPath);

const commitInputs = shas.map((sha, index) => {
  const meta = zsplit(runCommand([
    "git",
    "show",
    "-s",
    "--format=%H%x00%h%x00%an%x00%ai%x00%s%x00%B",
    sha,
  ], { cwd: branchRun.fhirRepo }));
  const [fullSha, shortSha, author, authoredAt, subject, body = ""] = meta;
  const commitMessage = parsedCommitMessage(subject, body);
  const issueKey = issueKeyFor(body, subject);
  return { index, sha, fullSha, shortSha, author, authoredAt, subject, body, commitMessage, issueKey };
});

const previousIssueCommitsByKey = previousIssueCommits(base, new Set(commitInputs.map((commit) => commit.issueKey).filter(Boolean) as string[]));

const commits: CommitReport[] = commitInputs.flatMap(({ index, sha, fullSha, shortSha, author, authoredAt, subject, body, commitMessage, issueKey }) => {
  const result = resultFor(issueKey);
  const auditResult = auditResultFor(issueKey);
  if (auditRunId && !auditResult) return [];
  const resultPath = issueKey && existsSync(path.join(root, "results", `${issueKey}.json`))
    ? path.relative(root, path.join(root, "results", `${issueKey}.json`))
    : undefined;
  const auditResultPath = auditRunId && issueKey && existsSync(path.join(runPath(auditRunId), "results", `${issueKey}.json`))
    ? path.relative(artifactRoot, path.join(runPath(auditRunId), "results", `${issueKey}.json`))
    : undefined;
  const displayBody = auditResult?.replacement_commit_message ?? body;
  const displaySubject = auditResult?.replacement_commit_message?.split(/\r?\n/, 1)[0]?.trim() || subject;
  const displayCommitMessage = auditResult ? parsedCommitMessage(displaySubject, displayBody) : commitMessage;
  const files = runCommand(["git", "show", "--format=", "--name-only", sha], { cwd: branchRun.fhirRepo })
    .split(/\r?\n/)
    .filter(Boolean);
  const stat = runCommand(["git", "show", "--format=", "--stat", "--find-renames", sha], { cwd: branchRun.fhirRepo });
  const patch = patchForCommit(sha, files);
  const wg = inferCommitWg(issueKey, files);
  const previous = issueKey ? previousIssueCommitsByKey.get(issueKey) ?? [] : [];
  const previousFields = previous.length ? {
    previous_issue_commits: previous.slice(0, 25),
    previous_issue_commits_omitted: Math.max(0, previous.length - 25),
  } : {};
  return [{
    sequence: index,
    sha: fullSha,
    short_sha: shortSha,
    author,
    authored_at: authoredAt,
    subject: displaySubject,
    body: displayBody,
    original_subject: auditResult ? subject : undefined,
    original_body: auditResult ? body : undefined,
    issue_key: issueKey,
    status: auditResult?.decision ?? result?.status,
    decision_status: auditResult?.decision ?? result?.decision?.status,
    fixup_status: result?.status,
    fixup_decision_status: result?.decision?.status,
    commit_summary: displayCommitMessage.summary,
    commit_context: displayCommitMessage.context,
    summary: auditResult?.reasoning ?? result?.decision?.summary,
    recommendation: auditResult?.recommended_next_step ?? result?.decision?.recommendation,
    fixup_result_path: resultPath,
    audit_decision: auditResult?.decision,
    audit_confidence: auditResult?.confidence,
    audit_reasoning: auditResult?.reasoning,
    audit_recommended_next_step: auditResult?.recommended_next_step,
    audit_source_tweaks_needed: auditResult?.source_tweaks_needed,
    audit_result_path: auditResultPath,
    github_commit_url: `https://github.com/${githubRepo}/commit/${fullSha}`,
    ...previousFields,
    result_path: auditResultPath ?? resultPath,
    ...wg,
    files,
    stat,
    ...patch,
  }];
});

function countBy(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function previousIssueCommits(ref: string, issueKeys: Set<string>): Map<string, PreviousIssueCommit[]> {
  const byKey = new Map<string, PreviousIssueCommit[]>();
  if (!issueKeys.size) return byKey;
  const output = runCommandBig([
    "git",
    "log",
    "--extended-regexp",
    "--regexp-ignore-case",
    "--grep=FHIR-[0-9]+",
    "--format=%H%x00%h%x00%ai%x00%an%x00%s%x00%B%x1e",
    ref,
  ], { cwd: branchRun.fhirRepo, allowFailure: true, maxBuffer: 256 * 1024 * 1024 });
  const seen = new Set<string>();
  for (const record of output.split("\x1e")) {
    if (!record.trim()) continue;
    const [sha, shortSha, authoredAt, author, subject, body = ""] = record.replace(/^\n/, "").split("\0");
    if (!sha || !shortSha) continue;
    const mentioned = new Set((`${subject}\n${body}`.match(/\bFHIR-\d+\b/gi) ?? []).map((key) => key.toUpperCase()));
    for (const key of mentioned) {
      if (!issueKeys.has(key)) continue;
      const dedupe = `${key}:${sha}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const commits = byKey.get(key) ?? [];
      commits.push({
        sha,
        short_sha: shortSha,
        authored_at: authoredAt,
        author,
        subject,
        github_commit_url: `https://github.com/${upstreamGithubRepo}/commit/${sha}`,
      });
      byKey.set(key, commits);
    }
  }
  return byKey;
}

const report = {
  schema_version: auditRunId ? "issue-fixup-audit-review-v1" : "issue-fixup-diff-review-v1",
  generated_at: new Date().toISOString(),
  run: {
    run_id: artifactRunId,
    status: auditRun?.status ?? run.status,
    description: auditRun?.description ?? run.description,
    fhir_repo: branchRun.fhirRepo,
    base,
    head,
    combined_branch: branchRun.combinedBranch,
    github_repo: githubRepo,
    github_tree_url: githubTreeUrl,
    github_compare_url: githubCompareUrl,
    review_artifact_branch: reviewArtifactBranch,
    review_artifact_dir: reviewArtifactDir,
    review_raw_base_url: reviewRawBaseUrl,
    review_github_tree_url: reviewGithubTreeUrl,
    review_pages_url: reviewPagesUrl,
    source_run_id: sourceRunId,
    source_issue_fixup_run_id: auditRunId ? runId : undefined,
    audit_run_id: auditRunId,
    artifacts: {
      fixup_review_json: "issue-fixup-diff-report.json",
      fixup_review_json_gzip: "issue-fixup-diff-report.json.gz",
      fixup_review_full_json_gzip: "issue-fixup-diff-report-full.json.gz",
      fixup_patch_dir: "patches/",
      source_issue_mapping_json_gzip: existsSync(sourceIssueMappingReportGzipPath) ? sourceIssueMappingReportGzipName : undefined,
      source_issue_mapping_json_source_path: sourceIssueMappingReportPath,
      source_issue_fixup_review_json_gzip: existsSync(sourceIssueFixupReviewReportGzipPath) ? sourceIssueFixupReviewReportGzipName : undefined,
      source_issue_fixup_review_json_source_path: sourceIssueFixupReviewReportPath,
    },
    max_patch_bytes: maxPatchBytes,
    max_file_diff_lines: maxFileDiffLines,
    max_line_chars: maxLineChars,
  },
  counts: {
    commits: commits.length,
    with_issue_key: commits.filter((commit) => commit.issue_key).length,
    with_result: commits.filter((commit) => commit.result_path).length,
    fixed: commits.filter((commit) => commit.status === "fixed").length,
    no_change: commits.filter((commit) => commit.status === "no-change").length,
    ambiguous: commits.filter((commit) => commit.status === "ambiguous").length,
    by_status: countBy(commits.map((commit) => commit.status ?? commit.decision_status ?? "none")),
    by_audit_decision: countBy(commits.map((commit) => commit.audit_decision ?? "none")),
    by_wg: countBy(commits.map((commit) => commit.wg ?? "unknown")),
  },
  commits,
};

const reportPath = path.join(outDir, "issue-fixup-diff-report.json");
const fullReportGzipPath = path.join(outDir, "issue-fixup-diff-report-full.json.gz");
const htmlPath = path.join(outDir, "issue-fixup-diff-viewer.html");
const indexPath = path.join(outDir, "index.html");
const patchDir = path.join(outDir, "patches");
rmSync(patchDir, { recursive: true, force: true });
mkdirSync(patchDir, { recursive: true });
for (const commit of commits) {
  writeFileSync(path.join(patchDir, `${commit.sha}.patch`), commit.patch || "(empty commit; no source diff)\n");
}
const patchUrlFor = (sha: string) => `${reviewRawBaseUrl}patches/${sha}.patch`;
const fullReport = {
  ...report,
  commits: commits.map((commit) => ({
    ...commit,
    patch_url: patchUrlFor(commit.sha),
    patch_bytes: Buffer.byteLength(commit.patch || "", "utf8"),
  })),
};
const webReport = {
  ...report,
  commits: commits.map(({
    patch: _patch,
    original_subject: _originalSubject,
    original_body: _originalBody,
    audit_reasoning: _auditReasoning,
    audit_recommended_next_step: _auditRecommendedNextStep,
    ...commit
  }) => ({
    ...commit,
    patch_url: patchUrlFor(commit.sha),
    patch_bytes: Buffer.byteLength(_patch || "", "utf8"),
  })),
};
writeFileSync(fullReportGzipPath, gzipSync(`${JSON.stringify(fullReport, null, 2)}\n`));
writeFileSync(reportPath, `${JSON.stringify(webReport, null, 2)}\n`);
writeFileSync(`${reportPath}.gz`, gzipSync(readFileSync(reportPath)));
const appJsPath = path.join(outDir, "review-app.js");
const appCssPath = path.join(outDir, "review-app.css");
const build = spawnSync("bun", [
  "build",
  path.join(repoRoot, "autofhir/web/review-app/src/main.tsx"),
  "--target=browser",
  "--production",
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
const pageTitle = auditRunId ? "AutoFHIR Issue Fixup Audit Review" : "AutoFHIR Issue Fixup Diffs";
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle}</title>
<link rel="stylesheet" href="review-app.css">
</head>
<body>
<div id="root"><div class="empty">Loading review app.</div></div>
<script>window.__AUTOFHIR_REPORT_URL__ = ${JSON.stringify(`${reviewRawBaseUrl}issue-fixup-diff-report.json`)};</script>
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
