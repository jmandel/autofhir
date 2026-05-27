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
  issueCount?: number;
  commitShas?: Record<string, string>;
};

const topStatuses = new Set(["complete", "blocked"]);
const issueStatuses = new Set(["fixed", "no-change", "human-review", "external-repo", "blocked"]);
const issueRoles = new Set(["seed", "opportunistic"]);
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
    `--grep=Issue-Reconcile-Key: ${issueKey}`,
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
  const message = runCommand(["git", "show", "-s", "--format=%B", commitSha], { cwd: run.fhirRepo, allowFailure: true });
  const required = [
    "Issue request:",
    "Initial application:",
    "Additional context:",
    "AutoFHIR reconciliation:",
    "Recommendation:",
    `Issue-Reconcile-Key: ${issueKey}`,
    "Issue-Reconcile-Decision:",
    "<evidence>",
    "</evidence>",
    "<evidence-manifest>",
    "</evidence-manifest>",
  ];
  for (const needle of required) {
    if (!message.includes(needle)) warnings.push(`commit message missing ${needle}`);
  }
}

function validateEvidenceItems(value: unknown, prefix: string, errors: string[], warnings: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${prefix}.evidence_items must be a non-empty array`);
    return;
  }
  const ids = new Set<string>();
  value.forEach((row: any, index: number) => {
    const rowPrefix = `${prefix}.evidence_items[${index}]`;
    if (!row || typeof row !== "object") return errors.push(`${rowPrefix} must be an object`);
    if (!isString(row.id)) errors.push(`${rowPrefix}.id is required`);
    if (isString(row.id) && ids.has(row.id)) errors.push(`${rowPrefix}.id duplicate ${row.id}`);
    if (isString(row.id)) ids.add(row.id);
    if (!evidenceKinds.has(row.kind)) errors.push(`${rowPrefix}.kind is invalid`);
    if (!isString(row.locator)) errors.push(`${rowPrefix}.locator is required`);
    if (row.url !== undefined && typeof row.url !== "string") errors.push(`${rowPrefix}.url must be a string`);
    if (row.snapshot_path !== undefined && typeof row.snapshot_path !== "string") errors.push(`${rowPrefix}.snapshot_path must be a string`);
    if (row.command !== undefined && typeof row.command !== "string") errors.push(`${rowPrefix}.command must be a string`);
    if (row.query !== undefined && typeof row.query !== "string") errors.push(`${rowPrefix}.query must be a string`);
    if (row.result_count !== undefined && typeof row.result_count !== "number") errors.push(`${rowPrefix}.result_count must be a number`);
    if (!isString(row.summary)) errors.push(`${rowPrefix}.summary is required`);
    if (!isString(row.learned)) warnings.push(`${rowPrefix}.learned should explain what this evidence proves or rules out`);
    if (!Array.isArray(row.supports) || !row.supports.every(isString)) errors.push(`${rowPrefix}.supports must be a string array`);
    if (row.ref !== undefined && (!row.ref || typeof row.ref !== "object" || Array.isArray(row.ref))) {
      errors.push(`${rowPrefix}.ref must be an object when present`);
    }
  });
}

function validateRelatedJiras(value: unknown, prefix: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${prefix}.related_jiras must be an array`);
    return;
  }
  value.forEach((row: any, index: number) => {
    const rowPrefix = `${prefix}.related_jiras[${index}]`;
    if (!row || typeof row !== "object") return errors.push(`${rowPrefix} must be an object`);
    if (!isJiraKey(row.key)) errors.push(`${rowPrefix}.key must be a Jira key such as FHIR-XXXXX or UP-XXXXX`);
    if (!relationships.has(row.relationship)) errors.push(`${rowPrefix}.relationship is invalid`);
    if (!isString(row.note)) errors.push(`${rowPrefix}.note is required`);
  });
}

function validateIssueResult(row: any, index: number, seedKey: string, errors: string[], warnings: string[]): void {
  const prefix = `issue_results[${index}]`;
  if (!row || typeof row !== "object") {
    errors.push(`${prefix} must be an object`);
    return;
  }
  if (!isKey(row.issue_key)) errors.push(`${prefix}.issue_key must be FHIR-XXXXX`);
  if (!issueRoles.has(row.role)) errors.push(`${prefix}.role is invalid`);
  if (row.issue_key === seedKey && row.role !== "seed") errors.push(`${prefix}.role must be seed for ${seedKey}`);
  if (!issueStatuses.has(row.status)) errors.push(`${prefix}.status is invalid`);
  for (const field of ["summary", "issue_request", "initial_application", "additional_context", "reconciliation", "recommendation"]) {
    if (!isString(row[field])) errors.push(`${prefix}.${field} is required`);
  }
  if (!stringArray(row.source_changes)) errors.push(`${prefix}.source_changes must be a string array`);
  if (!stringArray(row.checks)) errors.push(`${prefix}.checks must be a string array`);
  if (!confidences.has(row.confidence)) errors.push(`${prefix}.confidence is invalid`);
  validateRelatedJiras(row.related_jiras, prefix, errors);
  validateEvidenceItems(row.evidence_items, prefix, errors, warnings);
  if (row.status !== "blocked") {
    if (!row.commit || typeof row.commit !== "object") {
      errors.push(`${prefix}.commit is required unless status is blocked`);
    } else {
      if (!/^[0-9a-f]{7,40}$/i.test(String(row.commit.sha ?? ""))) errors.push(`${prefix}.commit.sha must be a git sha`);
      if (!isString(row.commit.subject)) errors.push(`${prefix}.commit.subject is required`);
      if (typeof row.commit.empty !== "boolean") errors.push(`${prefix}.commit.empty must be boolean`);
    }
  }
}

export function validateIssueReconcileResult(options: {
  runId?: string;
  seedKey?: string;
  chunkId?: string;
  resultPath?: string;
  writeResult?: boolean;
}): ValidationResult {
  const resultPath = options.resultPath
    ? path.resolve(options.resultPath)
    : path.join(runPath(options.runId ?? ""), "results", `${options.chunkId ?? options.seedKey}.json`);
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
  const seedKey = options.seedKey ?? parsed.seed_key;
  const chunkId = options.chunkId ?? seedKey;

  if (parsed.schema_version !== "issue-reconcile-result-v1") errors.push("schema_version must be issue-reconcile-result-v1");
  if (!isString(runId)) errors.push("run_id is required");
  if (parsed.run_id !== runId) errors.push(`run_id must be ${runId}`);
  if (!isKey(seedKey)) errors.push("seed_key must be FHIR-XXXXX");
  if (parsed.seed_key !== seedKey) errors.push(`seed_key must be ${seedKey}`);
  if (!topStatuses.has(parsed.status)) errors.push("status must be complete or blocked");
  if (!isString(parsed.branch)) errors.push("branch is required");
  if (parsed.chunk_id !== undefined && parsed.chunk_id !== chunkId) warnings.push(`chunk_id is ignored for issue-reconcile and should be ${chunkId} when present`);

  if (!Array.isArray(parsed.issue_results) || parsed.issue_results.length === 0) {
    errors.push("issue_results must be a non-empty array");
  } else {
    const seen = new Set<string>();
    let seedSeen = false;
    parsed.issue_results.forEach((row: any, index: number) => {
      validateIssueResult(row, index, seedKey, errors, warnings);
      if (isKey(row?.issue_key)) {
        if (seen.has(row.issue_key)) errors.push(`issue_results has duplicate issue_key ${row.issue_key}`);
        seen.add(row.issue_key);
        if (row.issue_key === seedKey) seedSeen = true;
      }
    });
    if (!seedSeen) errors.push(`issue_results must include seed ${seedKey}`);
  }

  if (!Array.isArray(parsed.related_not_decided)) {
    errors.push("related_not_decided must be an array");
  } else {
    parsed.related_not_decided.forEach((row: any, index: number) => {
      const prefix = `related_not_decided[${index}]`;
      if (!row || typeof row !== "object") return errors.push(`${prefix} must be an object`);
      if (!isJiraKey(row.key)) errors.push(`${prefix}.key must be a Jira key`);
      if (!isString(row.reason)) errors.push(`${prefix}.reason is required`);
    });
  }

  if (!Array.isArray(parsed.journal_entries) || parsed.journal_entries.length === 0) {
    errors.push("journal_entries must be a non-empty array");
  } else {
    parsed.journal_entries.forEach((row: any, index: number) => {
      const prefix = `journal_entries[${index}]`;
      if (!row || typeof row !== "object") return errors.push(`${prefix} must be an object`);
      if (!isKey(row.issue_key)) errors.push(`${prefix}.issue_key must be FHIR-XXXXX`);
      if (!issueRoles.has(row.role)) errors.push(`${prefix}.role is invalid`);
      if (!issueStatuses.has(row.decision)) errors.push(`${prefix}.decision is invalid`);
      if (!isString(row.summary)) errors.push(`${prefix}.summary is required`);
      if (!isString(row.reason)) errors.push(`${prefix}.reason is required`);
    });
  }

  const commitShas: Record<string, string> = {};
  if (isString(runId) && Array.isArray(parsed.issue_results)) {
    for (const row of parsed.issue_results) {
      if (!isKey(row?.issue_key) || row.status === "blocked") continue;
      const commitSha = commitInCombined(runId, row.issue_key);
      if (!commitSha) {
        errors.push(`combined branch has no Issue-Reconcile-Key commit for ${row.issue_key}`);
        continue;
      }
      commitShas[row.issue_key] = commitSha;
      if (row.commit?.sha && !String(commitSha).startsWith(String(row.commit.sha)) && !String(row.commit.sha).startsWith(commitSha)) {
        warnings.push(`reported commit ${row.commit.sha} for ${row.issue_key} differs from combined history commit ${commitSha}`);
      }
      validateCommitPatch(runId, commitSha, errors, warnings);
      validateCommitMessageShape(runId, commitSha, row.issue_key, warnings);
    }
  }

  const result: ValidationResult = {
    ok: errors.length === 0,
    errors,
    warnings,
    resultPath,
    status: parsed.status,
    issueCount: Array.isArray(parsed.issue_results) ? parsed.issue_results.length : undefined,
    commitShas,
  };
  if (options.writeResult) writeJson(validationOutputPath(resultPath), result);
  return result;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`Usage: bun autofhir/scripts/validate-issue-reconcile-result.ts --run-id ID --seed-key FHIR-XXXXX [--chunk-id FHIR-XXXXX] [--result PATH] [--json] [--write-result]`);
    process.exit(0);
  }
  const runId = arg("--run-id") ?? process.env.RUN_ID;
  const seedKey = arg("--seed-key") ?? arg("--issue-key") ?? process.env.SEED_KEY;
  const chunkId = arg("--chunk-id") ?? seedKey;
  const resultPath = arg("--result");
  if (!resultPath && (!runId || !seedKey)) throw new Error("pass --result or both --run-id and --seed-key");
  const result = validateIssueReconcileResult({
    runId,
    seedKey,
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
    if (result.issueCount !== undefined) console.log(`issue_count=${result.issueCount}`);
    for (const [issueKey, sha] of Object.entries(result.commitShas ?? {})) console.log(`commit_${issueKey}=${sha}`);
    for (const warning of result.warnings) console.log(`warning=${warning}`);
    for (const error of result.errors) console.log(`error=${error}`);
  }
  process.exit(result.ok ? 0 : 1);
}
