#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readRun, runCommand, runPath, writeJson } from "./lib";

type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  resultPath: string;
  status?: string;
  commitSha?: string;
};

const statuses = new Set(["fixed", "no-change", "ambiguous", "blocked"]);
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

function commitInCombined(runId: string, issueKey: string): string | undefined {
  const run = readRun(runId);
  if (!run.fhirRepo || !run.combinedBranch) return undefined;
  const output = runCommand([
    "git",
    "log",
    "--fixed-strings",
    `--grep=Issue-Fixup-Key: ${issueKey}`,
    "--format=%H",
    "-n",
    "1",
    run.combinedBranch,
  ], { cwd: run.fhirRepo, allowFailure: true }).trim();
  return output || undefined;
}

function validateCommitPatch(runId: string, commitSha: string, errors: string[], warnings: string[]): void {
  const run = readRun(runId);
  if (!run.fhirRepo) {
    warnings.push("cannot run commit patch checks because run.fhirRepo is missing");
    return;
  }
  const output = runCommand([
    "git",
    "-c",
    "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol",
    "show",
    "--check",
    "--pretty=format:",
    commitSha,
  ], { cwd: run.fhirRepo, allowFailure: true });
  if (output.trim().length > 0) {
    errors.push(`commit ${commitSha} failed CRLF-aware git show --check: ${output.trim()}`);
  }
}

function validateCommitMessageShape(runId: string, commitSha: string, issueKey: string, warnings: string[]): void {
  const run = readRun(runId);
  if (!run.fhirRepo) {
    warnings.push("cannot run commit message checks because run.fhirRepo is missing");
    return;
  }
  const message = runCommand([
    "git",
    "show",
    "-s",
    "--format=%B",
    commitSha,
  ], { cwd: run.fhirRepo, allowFailure: true });
  const required = [
    "Issue request:",
    "Initial application:",
    "Additional context:",
    "AutoFHIR fixup:",
    "Recommendation:",
    `Issue-Fixup-Key: ${issueKey}`,
    "Issue-Fixup-Decision:",
    "<evidence>",
    "</evidence>",
    "<evidence-manifest>",
    "</evidence-manifest>",
  ];
  for (const needle of required) {
    if (!message.includes(needle)) warnings.push(`commit message missing ${needle}`);
  }
}

function validateDecision(decision: any, issueKey: string, errors: string[], warnings: string[]): void {
  if (!decision || typeof decision !== "object") {
    errors.push("decision must be an object");
    return;
  }
  if (decision.issue_key !== issueKey) errors.push(`decision.issue_key must be ${issueKey}`);
  if (!statuses.has(decision.status)) errors.push("decision.status is invalid");
  if (!isString(decision.summary)) errors.push("decision.summary is required");
  if (!isString(decision.reasoning)) errors.push("decision.reasoning is required");
  if (!isString(decision.recommendation)) errors.push("decision.recommendation is required");
  if (!stringArray(decision.source_changes)) errors.push("decision.source_changes must be a string array");
  if (!stringArray(decision.checks)) errors.push("decision.checks must be a string array");
  if (!confidences.has(decision.confidence)) errors.push("decision.confidence is invalid");
  if (!Array.isArray(decision.related_jiras)) {
    errors.push("decision.related_jiras must be an array");
  } else {
    decision.related_jiras.forEach((row: any, index: number) => {
      const prefix = `decision.related_jiras[${index}]`;
      if (!row || typeof row !== "object") return errors.push(`${prefix} must be an object`);
      if (!isJiraKey(row.key)) errors.push(`${prefix}.key must be a Jira key such as FHIR-XXXXX or UP-XXXXX`);
      if (!relationships.has(row.relationship)) errors.push(`${prefix}.relationship is invalid`);
      if (!isString(row.note)) errors.push(`${prefix}.note is required`);
    });
  }
  if (!Array.isArray(decision.evidence_items) || decision.evidence_items.length === 0) {
    errors.push("decision.evidence_items must be a non-empty array");
  } else {
    const ids = new Set<string>();
    decision.evidence_items.forEach((row: any, index: number) => {
      const prefix = `decision.evidence_items[${index}]`;
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
      if (row.ref !== undefined && (!row.ref || typeof row.ref !== "object" || Array.isArray(row.ref))) {
        errors.push(`${prefix}.ref must be an object when present`);
      }
    });
  }
}

export function validateIssueFixupResult(options: {
  runId?: string;
  issueKey?: string;
  chunkId?: string;
  resultPath?: string;
  writeResult?: boolean;
}): ValidationResult {
  const resultPath = options.resultPath
    ? path.resolve(options.resultPath)
    : path.join(runPath(options.runId ?? ""), "results", `${options.chunkId ?? options.issueKey}.json`);
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
  const issueKey = options.issueKey ?? parsed.issue_key;
  const chunkId = options.chunkId ?? parsed.chunk_id ?? issueKey;

  if (parsed.schema_version !== "issue-fixup-result-v1") errors.push("schema_version must be issue-fixup-result-v1");
  if (!isString(runId)) errors.push("run_id is required");
  if (parsed.run_id !== runId) errors.push(`run_id must be ${runId}`);
  if (!isKey(issueKey)) errors.push("issue_key must be FHIR-XXXXX");
  if (parsed.issue_key !== issueKey) errors.push(`issue_key must be ${issueKey}`);
  if (parsed.chunk_id !== chunkId) errors.push(`chunk_id must be ${chunkId}`);
  if (!statuses.has(parsed.status)) errors.push("status is invalid");
  if (!isString(parsed.branch)) errors.push("branch is required");

  validateDecision(parsed.decision, issueKey, errors, warnings);
  if (parsed.decision?.status !== undefined && parsed.status !== parsed.decision.status) {
    errors.push("status must match decision.status");
  }

  if (!Array.isArray(parsed.journal_entries) || parsed.journal_entries.length === 0) {
    errors.push("journal_entries must be a non-empty array");
  } else {
    parsed.journal_entries.forEach((row: any, index: number) => {
      const prefix = `journal_entries[${index}]`;
      if (!row || typeof row !== "object") return errors.push(`${prefix} must be an object`);
      if (row.issue_key !== issueKey) errors.push(`${prefix}.issue_key must be ${issueKey}`);
      if (!statuses.has(row.decision)) errors.push(`${prefix}.decision is invalid`);
      if (!isString(row.summary)) errors.push(`${prefix}.summary is required`);
      if (!isString(row.reason)) errors.push(`${prefix}.reason is required`);
    });
  }

  let commitSha: string | undefined;
  if (parsed.status !== "blocked") {
    if (!parsed.commit || typeof parsed.commit !== "object") {
      errors.push("commit is required unless status is blocked");
    } else {
      if (!/^[0-9a-f]{7,40}$/i.test(String(parsed.commit.sha ?? ""))) errors.push("commit.sha must be a git sha");
      if (!isString(parsed.commit.subject)) errors.push("commit.subject is required");
      if (typeof parsed.commit.empty !== "boolean") errors.push("commit.empty must be boolean");
    }
    if (isString(runId) && isKey(issueKey)) {
      commitSha = commitInCombined(runId, issueKey);
      if (!commitSha) errors.push(`combined branch has no Issue-Fixup-Key commit for ${issueKey}`);
      if (commitSha && parsed.commit?.sha && !String(commitSha).startsWith(String(parsed.commit.sha)) && !String(parsed.commit.sha).startsWith(commitSha)) {
        warnings.push(`reported commit ${parsed.commit.sha} differs from combined history commit ${commitSha}`);
      }
      if (commitSha) validateCommitPatch(runId, commitSha, errors, warnings);
      if (commitSha) validateCommitMessageShape(runId, commitSha, issueKey, warnings);
    }
  }

  const result: ValidationResult = {
    ok: errors.length === 0,
    errors,
    warnings,
    resultPath,
    status: parsed.status,
    commitSha,
  };
  if (options.writeResult) writeJson(validationOutputPath(resultPath), result);
  return result;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`Usage: bun autofhir/scripts/validate-issue-fixup-result.ts --run-id ID --issue-key FHIR-XXXXX [--chunk-id FHIR-XXXXX] [--result PATH] [--json] [--write-result]`);
    process.exit(0);
  }
  const runId = arg("--run-id") ?? process.env.RUN_ID;
  const issueKey = arg("--issue-key") ?? process.env.ISSUE_KEY;
  const chunkId = arg("--chunk-id") ?? issueKey;
  const resultPath = arg("--result");
  if (!resultPath && (!runId || !issueKey)) throw new Error("pass --result or both --run-id and --issue-key");
  const result = validateIssueFixupResult({
    runId,
    issueKey,
    chunkId,
    resultPath,
    writeResult: process.argv.includes("--write-result"),
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ok=${result.ok}`);
    console.log(`result=${result.resultPath}`);
    if (result.status) console.log(`status=${result.status}`);
    if (result.commitSha) console.log(`commit=${result.commitSha}`);
    for (const warning of result.warnings) console.log(`warning=${warning}`);
    for (const error of result.errors) console.log(`error=${error}`);
  }
  process.exit(result.ok ? 0 : 1);
}
