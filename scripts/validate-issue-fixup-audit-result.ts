#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readJson, runPath, writeJson } from "./lib";

type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  resultPath: string;
  decision?: string;
};

const decisions = new Set(["keep", "tweak", "drop", "human-review"]);
const confidences = new Set(["high", "medium", "low"]);
const evidenceKinds = new Set(["jira", "zulip", "confluence", "source", "git", "published-spec", "command", "web"]);
const relationships = new Set([
  "duplicate",
  "supersedes",
  "superseded-by",
  "same-change-family",
  "supporting-decision",
  "conflicting-decision",
  "background",
  "later-change",
  "unclear",
]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && /^FHIR-\d+$/.test(value);
}

function isJiraKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9]+-\d+$/.test(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validationOutputPath(resultPath: string): string {
  const parsed = path.parse(resultPath);
  return path.join(parsed.dir, `${parsed.name}.validation.json`);
}

function validateEvidenceItems(value: unknown, errors: string[], warnings: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("evidence_items must be a non-empty array");
    return;
  }
  const ids = new Set<string>();
  value.forEach((row: any, index) => {
    const prefix = `evidence_items[${index}]`;
    if (!row || typeof row !== "object") return errors.push(`${prefix} must be an object`);
    if (!isString(row.id)) errors.push(`${prefix}.id is required`);
    if (isString(row.id) && ids.has(row.id)) errors.push(`${prefix}.id duplicate ${row.id}`);
    if (isString(row.id)) ids.add(row.id);
    if (!evidenceKinds.has(row.kind)) errors.push(`${prefix}.kind is invalid`);
    if (!isString(row.locator)) errors.push(`${prefix}.locator is required`);
    if (row.url !== undefined && typeof row.url !== "string") errors.push(`${prefix}.url must be a string`);
    if (row.snapshot_path !== undefined && typeof row.snapshot_path !== "string") errors.push(`${prefix}.snapshot_path must be a string`);
    if (row.command !== undefined && typeof row.command !== "string") errors.push(`${prefix}.command must be a string`);
    if (row.query !== undefined && typeof row.query !== "string") errors.push(`${prefix}.query must be a string`);
    if (row.result_count !== undefined && typeof row.result_count !== "number") errors.push(`${prefix}.result_count must be a number`);
    if (!isString(row.summary)) errors.push(`${prefix}.summary is required`);
    if (!isString(row.learned)) warnings.push(`${prefix}.learned should explain what this evidence proves or rules out`);
    if (!Array.isArray(row.supports) || !row.supports.every(isString)) errors.push(`${prefix}.supports must be a string array`);
    if (row.ref !== undefined && (!row.ref || typeof row.ref !== "object" || Array.isArray(row.ref))) errors.push(`${prefix}.ref must be an object when present`);
  });
}

function validateRelatedJiras(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("related_jiras must be an array");
    return;
  }
  value.forEach((row: any, index) => {
    const prefix = `related_jiras[${index}]`;
    if (!row || typeof row !== "object") return errors.push(`${prefix} must be an object`);
    if (!isJiraKey(row.key)) errors.push(`${prefix}.key must be a Jira key such as FHIR-XXXXX or UP-XXXXX`);
    if (!relationships.has(row.relationship)) errors.push(`${prefix}.relationship is invalid`);
    if (!isString(row.note)) errors.push(`${prefix}.note is required`);
  });
}

function validateReplacementMessage(message: unknown, issueKey: string, errors: string[], warnings: string[]): void {
  if (!isString(message)) {
    errors.push("replacement_commit_message is required");
    return;
  }
  const required = [
    `${issueKey}:`,
    "Issue request:",
    "Initial application:",
    "Additional context:",
    "AutoFHIR fixup:",
    "Recommendation:",
    "AutofHIR-Run:",
    `Issue-Fixup-Key: ${issueKey}`,
    "Issue-Fixup-Decision:",
    "<related-jiras>",
    "</related-jiras>",
    "<evidence>",
    "</evidence>",
  ];
  for (const needle of required) {
    if (!message.includes(needle)) errors.push(`replacement_commit_message missing ${needle}`);
  }
  for (const needle of ["<evidence-manifest>", "</evidence-manifest>"]) {
    if (!message.includes(needle)) warnings.push(`replacement_commit_message missing ${needle}`);
  }
  if (message.includes("Complicating context:")) errors.push("replacement_commit_message must use Additional context, not Complicating context");
  if (/message-rewrite-/i.test(message)) errors.push("replacement_commit_message must not use message-rewrite-prefixed decisions");
  if (message.length < 800) warnings.push("replacement_commit_message is short; make sure it has enough context for later review");
}

export function validateIssueFixupAuditResult(options: {
  runId?: string;
  issueKey?: string;
  commitSha?: string;
  chunkPath?: string;
  resultPath?: string;
  writeResult?: boolean;
}): ValidationResult {
  const chunk = options.chunkPath && existsSync(options.chunkPath) ? readJson<any>(options.chunkPath) : undefined;
  const resultPath = options.resultPath
    ? path.resolve(options.resultPath)
    : path.join(runPath(options.runId ?? ""), "results", `${options.issueKey ?? chunk?.issueKey}.json`);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(resultPath)) {
    const result = { ok: false, errors: [`missing result file: ${resultPath}`], warnings, resultPath };
    if (options.writeResult) writeJson(validationOutputPath(resultPath), result);
    return result;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch (error) {
    const result = { ok: false, errors: [`result is invalid JSON: ${String(error)}`], warnings, resultPath };
    if (options.writeResult) writeJson(validationOutputPath(resultPath), result);
    return result;
  }

  const runId = options.runId ?? parsed.run_id;
  const issueKey = options.issueKey ?? parsed.issue_key ?? chunk?.issueKey;
  const commitSha = options.commitSha ?? parsed.commit_sha ?? chunk?.commit?.sha;
  const sourceRunId = chunk?.sourceRunId ?? parsed.source_run_id;

  if (parsed.schema_version !== "issue-fixup-audit-v1") errors.push("schema_version must be issue-fixup-audit-v1");
  if (!isString(runId)) errors.push("run_id is required");
  if (parsed.run_id !== runId) errors.push(`run_id must be ${runId}`);
  if (!isString(sourceRunId)) errors.push("source_run_id is required");
  if (parsed.source_run_id !== sourceRunId) errors.push(`source_run_id must be ${sourceRunId}`);
  if (!isKey(issueKey)) errors.push("issue_key must be FHIR-XXXXX");
  if (parsed.issue_key !== issueKey) errors.push(`issue_key must be ${issueKey}`);
  if (!/^[0-9a-f]{7,40}$/i.test(String(commitSha ?? ""))) errors.push("commit_sha must be a git sha");
  if (parsed.commit_sha !== commitSha) errors.push(`commit_sha must be ${commitSha}`);
  if (!decisions.has(parsed.decision)) errors.push("decision must be keep, tweak, drop, or human-review");
  if (!isString(parsed.reasoning)) errors.push("reasoning is required");
  if (!isString(parsed.recommended_next_step)) errors.push("recommended_next_step is required");
  if (!stringArray(parsed.source_tweaks_needed)) errors.push("source_tweaks_needed must be a string array");
  if (!confidences.has(parsed.confidence)) errors.push("confidence is invalid");

  if (isKey(issueKey)) validateReplacementMessage(parsed.replacement_commit_message, issueKey, errors, warnings);
  validateEvidenceItems(parsed.evidence_items, errors, warnings);
  validateRelatedJiras(parsed.related_jiras, errors);

  const result: ValidationResult = {
    ok: errors.length === 0,
    errors,
    warnings,
    resultPath,
    decision: parsed.decision,
  };
  if (options.writeResult) writeJson(validationOutputPath(resultPath), result);
  return result;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`Usage: bun autofhir/scripts/validate-issue-fixup-audit-result.ts --run-id ID --issue-key FHIR-XXXXX [--commit-sha SHA] [--chunk-file path] [--result PATH] [--json] [--write-result]`);
    process.exit(0);
  }
  const result = validateIssueFixupAuditResult({
    runId: arg("--run-id") ?? process.env.RUN_ID,
    issueKey: arg("--issue-key") ?? process.env.ISSUE_KEY,
    commitSha: arg("--commit-sha") ?? process.env.COMMIT_SHA,
    chunkPath: arg("--chunk-file"),
    resultPath: arg("--result"),
    writeResult: process.argv.includes("--write-result"),
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ok=${result.ok}`);
    console.log(`result=${result.resultPath}`);
    if (result.decision) console.log(`decision=${result.decision}`);
    for (const warning of result.warnings) console.log(`warning=${warning}`);
    for (const error of result.errors) console.log(`error=${error}`);
  }
  process.exit(result.ok ? 0 : 1);
}
