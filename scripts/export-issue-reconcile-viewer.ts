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
  wg?: string;
  wg_label?: string;
  wg_confidence?: "high" | "medium" | "low";
  wg_evidence?: WgEvidence[];
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
  wg?: string;
  wg_label?: string;
  wg_confidence?: "high" | "medium" | "low";
  wg_evidence?: WgEvidence[];
};

type WgEvidence = {
  wg: string;
  label: string;
  score: number;
  reasons: string[];
  files: string[];
};

type WgInference = Pick<SideFileCommit, "wg" | "wg_label" | "wg_confidence" | "wg_evidence">;

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
  const aliases: Record<string, string> = {
    cgit: "cg",
    fhir: "fhir-i",
    pharm: "phx",
    security: "sec",
  };
  if (aliases[clean]) return aliases[clean];
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
    [/^(codesystem|valueset|conceptmap|terminology|terminologies|bindings|identifier|namingsystem)/, "vocab", "terminology heuristic"],
    [/^(medication|dosage|pharmacy)/, "phx", "medication/pharmacy heuristic"],
    [/^(financial|claim|coverage|payment|invoice|account|remittance|insurance)/, "fm", "financial heuristic"],
    [/^(administration|patient|person|practitioner|organization|location|encounter|episodeofcare|schedule|slot|appointment|healthcareservice)/, "pa", "patient administration heuristic"],
    [/^(diagnostics|observation|specimen|device|biologically|nutrition|service|transport)/, "oo", "orders/observations heuristic"],
    [/^(messaging|message|exchanging)/, "inm", "infrastructure messaging heuristic"],
    [/^(documents|cda|composition|clinicalsummary)/, "sd", "structured documents heuristic"],
    [/^(security|auditevent|provenance|consent)/, "sec", "security heuristic"],
    [/^(genomics|molecular)/, "cg", "genomics heuristic"],
    [/^(medication-definition|regulated|medicinal|manufactured|packaged|ingredient|substance|marketingstatus)/, "brr", "biomedical research/regulation heuristic"],
    [/^(supply|supplydelivery|supplyrequest)/, "oo", "supply resource heuristic"],
    [/^(foundation|conformance|datatypes|elementdefinition|definition|extension|extensibility|profiling|profile|defining|narrative|formats|json|xml|rdf|ttl|http|search|async|comparison|diff|documentation|fhirpath|fhirpatch|mapping|graphql|modules|downloads|history|license|credits|index|help|glossary|best|change|lifecycle|logical|managing|ns|operations?|resourceguide|resources?|references?|versions?|r[0-9]+maps|patterns?|overview|uml|types|resourcelist|compartments?|usecases?|workflow|request|exchange|signatures?|fhir\.ini|publish\.ini)/, "fhir", "FHIR infrastructure heuristic"],
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

  if (parts[0] === "tools" || clean === "publish.ini") {
    return { topic: parts[0], wg: "fhir-i", note: "FHIR infrastructure tooling heuristic" };
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

type CandidateIssue = {
  key: string;
  work_groups?: string[];
  partition_id?: string;
  source_paths?: string[];
  related_artifacts?: string[];
};

const issueCandidates = (() => {
  const file = path.join(root, "candidate-pool", "issues.json");
  const map = new Map<string, CandidateIssue>();
  if (!existsSync(file)) return map;
  const data = readJson<{ candidates?: CandidateIssue[] }>(file);
  for (const issue of data.candidates ?? []) {
    if (issue.key) map.set(issue.key.toUpperCase(), issue);
  }
  return map;
})();

const textWgRules: [RegExp, string, string][] = [
  [/\bBiomedical Research and Regulation\b|\bBRR\b/i, "brr", "text mentions BRR/Biomedical Research and Regulation"],
  [/\bCommunity Based Collaborative Care\b|\bCBCC\b/i, "cbcc", "text mentions CBCC/Community Based Collaborative Care"],
  [/\bClinical Decision Support\b|\bCDS\b/i, "cds", "text mentions CDS/Clinical Decision Support"],
  [/\bClinical Genomics\b|\bCG\b/i, "cg", "text mentions CG/Clinical Genomics"],
  [/\bClinical Quality Information\b|\bCQI\b/i, "cqi", "text mentions CQI/Clinical Quality Information"],
  [/\bHealth Care Devices\b|\bDevices?\b WG\b|\bDEV\b/i, "dev", "text mentions DEV/Devices"],
  [/\bFHIR Infrastructure\b|\bFHIR-I\b|\bFHIR issue\b/i, "fhir-i", "text mentions FHIR Infrastructure"],
  [/\bFinancial Management\b|\bFM issue\b|\bFM\b WG\b/i, "fm", "text mentions FM/Financial Management"],
  [/\bImaging Integration\b|\bII\b WG\b/i, "ii", "text mentions II/Imaging Integration"],
  [/\bInfrastructure and Messaging\b|\bINM\b/i, "inm", "text mentions INM/Infrastructure and Messaging"],
  [/\bOrders and Observations\b|\bOO issue\b|\bOO\b WG\b/i, "oo", "text mentions OO/Orders and Observations"],
  [/\bPatient Administration\b|\bPA issue\b|\bPA\b WG\b/i, "pa", "text mentions PA/Patient Administration"],
  [/\bPatient Care\b|\bPC issue\b|\bPC\b WG\b/i, "pc", "text mentions PC/Patient Care"],
  [/\bPublic Health\b|\bPHER\b/i, "pher", "text mentions PHER/Public Health"],
  [/\bPharmacy\b|\bPHX\b/i, "phx", "text mentions PHX/Pharmacy"],
  [/\bStructured Documents\b|\bSD\b WG\b/i, "sd", "text mentions SD/Structured Documents"],
  [/\bSecurity\b|\bSEC\b/i, "sec", "text mentions SEC/Security"],
  [/\bVocabulary\b|\bVocab\b/i, "vocab", "text mentions Vocabulary"],
];

function inferTextWgs(text: string): { wg: string; note: string }[] {
  if (!text) return [];
  return textWgRules
    .filter(([regex]) => regex.test(text))
    .map(([, wg, note]) => ({ wg: jiraWg(wg), note }));
}

function inferItemWg(issue: IssueResult, files: string[]): WgInference {
  const votes = new Map<string, { score: number; reasons: Set<string>; files: Set<string> }>();
  function add(wg: string | undefined, score: number, reason: string, file?: string): void {
    if (!wg) return;
    const clean = jiraWg(wg);
    if (clean === "unknown") return;
    const entry = votes.get(clean) ?? { score: 0, reasons: new Set(), files: new Set() };
    entry.score += score;
    entry.reasons.add(reason);
    if (file) entry.files.add(file);
    votes.set(clean, entry);
  }

  for (const file of files) {
    const inferred = fileTopic(file, workgroups);
    add(inferred.wg, 4, inferred.note ? `changed file: ${inferred.note}` : "changed file path", file);
  }
  for (const file of issue.source_changes ?? []) {
    const inferred = fileTopic(file, workgroups);
    add(inferred.wg, 3, inferred.note ? `reported source change: ${inferred.note}` : "reported source change", file);
  }

  const candidate = issueCandidates.get(issue.issue_key.toUpperCase());
  for (const wg of candidate?.work_groups ?? []) {
    add(wg, 2, `candidate-pool issue work_groups includes ${wg}`);
  }
  if (candidate?.partition_id) {
    const match = candidate.partition_id.match(/^([a-z0-9-]+)::/i);
    add(match?.[1], 1, `candidate-pool partition ${candidate.partition_id}`);
  }
  for (const file of candidate?.source_paths ?? []) {
    const inferred = fileTopic(file, workgroups);
    add(inferred.wg, 1, inferred.note ? `candidate-pool source path: ${inferred.note}` : "candidate-pool source path", file);
  }

  const evidenceText = (issue.evidence_items ?? [])
    .map((item) => [item.kind, item.locator, item.summary, item.url].filter(Boolean).join(" "))
    .join("\n");
  for (const inferred of inferTextWgs(evidenceText)) {
    add(inferred.wg, 2, `evidence text: ${inferred.note}`);
  }

  const narrativeText = [
    issue.summary,
    issue.issue_request,
    issue.initial_application,
    issue.additional_context,
    issue.reconciliation,
    issue.recommendation,
    ...(issue.related_jiras ?? []).map((jira) => `${jira.key} ${jira.relationship} ${jira.note}`),
  ].filter(Boolean).join("\n");
  for (const inferred of inferTextWgs(narrativeText)) {
    add(inferred.wg, 1, `result narrative: ${inferred.note}`);
  }

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
    const wg = inferItemWg(issue, info.files);
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
      ...wg,
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
    wg: item.wg,
    wg_label: item.wg_label,
    wg_confidence: item.wg_confidence,
    wg_evidence: item.wg_evidence,
    files: item.files,
    stat: item.stat,
    patch_url: patchUrl,
    patch_truncated: item.patch_truncated,
  };
});

function countBy(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

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
    by_status: countBy(compactCommits.map((commit) => commit.status ?? "none")),
    by_wg: countBy(compactCommits.map((commit) => commit.wg ?? "unknown")),
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
