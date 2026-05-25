#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runPath, writeJson } from "./lib";

type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  resultPath: string;
  decidedIssueCount: number;
  targetChunkCount: number;
};

const trackerStates = new Set(["not-resolved", "resolved-change-required", "applied-or-published", "resolved-no-change", "unknown"]);
const assessments = new Set([
  "out-of-scope",
  "fully-applied",
  "not-fully-applied",
  "ready-to-apply",
  "not-ready-to-apply",
  "resolved-no-change",
  "needs-follow-up",
  "unclear",
]);
const nextSteps = new Set(["none", "apply", "review", "file-jira", "needs-human-decision", "close-duplicate"]);
const confidences = new Set(["high", "medium", "low"]);
const roles = new Set(["seed", "related"]);
const relationships = new Set([
  "duplicate",
  "depends-on",
  "supersedes",
  "superseded-by",
  "same-change-family",
  "background",
  "possible-follow-up",
  "unclear",
]);
const evidenceKinds = new Set(["jira", "zulip", "confluence", "source", "git", "published-spec", "command", "web"]);
const priorDecisionSources = new Set(["jira", "zulip", "confluence", "git", "published-spec"]);
const priorDecisionRelationships = new Set([
  "supports-current-state",
  "conflicts-with-seed",
  "supersedes-seed",
  "seed-refines-prior-decision",
  "background",
]);
const optionRecommendations = new Set(["preferred", "acceptable", "not-recommended", "unknown"]);
const evidenceRefFields = new Set([
  "jira_key",
  "confluence_page_id",
  "zulip_stream",
  "zulip_topic",
  "zulip_message_id",
  "github_repo",
  "github_pr",
  "git_commit",
  "source_path",
  "line_start",
  "line_end",
  "package_id",
  "package_version",
  "command",
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

function validateRelated(value: unknown, prefix: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${prefix}.related_jiras must be an array`);
    return;
  }
  value.forEach((item, index) => {
    const p = `${prefix}.related_jiras[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${p} must be an object`);
      return;
    }
    const row = item as any;
    if (!isJiraKey(row.key)) errors.push(`${p}.key must be a Jira-style key such as FHIR-XXXXX or UP-XXXXX`);
    if (!relationships.has(row.relationship)) errors.push(`${p}.relationship is invalid`);
    if (!isString(row.note)) errors.push(`${p}.note is required`);
  });
}

function validateProposed(value: unknown, prefix: string, errors: string[]): void {
  if (!value || typeof value !== "object") {
    errors.push(`${prefix}.proposed_jira is required`);
    return;
  }
  const proposed = value as any;
  for (const field of ["title", "problem", "where", "suggested_fix", "dedup_check"]) {
    if (!isString(proposed[field])) errors.push(`${prefix}.proposed_jira.${field} is required`);
  }
}

function validateEvidenceItems(value: unknown, prefix: string, errors: string[]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${prefix}.evidence_items must be a non-empty array`);
    return ids;
  }
  value.forEach((item, index) => {
    const p = `${prefix}.evidence_items[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${p} must be an object`);
      return;
    }
    const row = item as any;
    if (!isString(row.id)) {
      errors.push(`${p}.id is required`);
    } else if (ids.has(row.id)) {
      errors.push(`${p}.id duplicate ${row.id}`);
    } else {
      ids.add(row.id);
    }
    if (!evidenceKinds.has(row.kind)) errors.push(`${p}.kind is invalid`);
    if (!isString(row.locator)) errors.push(`${p}.locator is required`);
    if (row.url !== undefined && typeof row.url !== "string") errors.push(`${p}.url must be a string when present`);
    if (row.ref !== undefined) {
      if (!row.ref || typeof row.ref !== "object" || Array.isArray(row.ref)) {
        errors.push(`${p}.ref must be an object when present`);
      } else {
        for (const [key, refValue] of Object.entries(row.ref)) {
          if (!evidenceRefFields.has(key)) errors.push(`${p}.ref.${key} is not a known evidence ref field`);
          if (typeof refValue !== "string" && typeof refValue !== "number") {
            errors.push(`${p}.ref.${key} must be a string or number`);
          }
        }
      }
    }
    if (!isString(row.summary)) errors.push(`${p}.summary is required`);
    if (!Array.isArray(row.supports) || row.supports.length === 0 || !row.supports.every(isString)) {
      errors.push(`${p}.supports must be a non-empty string array`);
    }
  });
  return ids;
}

function validateEvidenceRefs(value: unknown, prefix: string, evidenceIds: Set<string>, errors: string[]): void {
  if (!Array.isArray(value) || !value.every(isString)) {
    errors.push(`${prefix} must be a string array`);
    return;
  }
  for (const ref of value) {
    if (!evidenceIds.has(ref)) errors.push(`${prefix} references unknown evidence id ${ref}`);
  }
}

function validatePriorDecisions(value: unknown, prefix: string, evidenceIds: Set<string>, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${prefix}.prior_decisions must be an array`);
    return;
  }
  const ids = new Set<string>();
  value.forEach((item, index) => {
    const p = `${prefix}.prior_decisions[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${p} must be an object`);
      return;
    }
    const row = item as any;
    if (!isString(row.id)) {
      errors.push(`${p}.id is required`);
    } else if (ids.has(row.id)) {
      errors.push(`${p}.id duplicate ${row.id}`);
    } else {
      ids.add(row.id);
    }
    if (!priorDecisionSources.has(row.source)) errors.push(`${p}.source is invalid`);
    if (!isString(row.locator)) errors.push(`${p}.locator is required`);
    if (row.url !== undefined && typeof row.url !== "string") errors.push(`${p}.url must be a string when present`);
    if (!isString(row.decision_summary)) errors.push(`${p}.decision_summary is required`);
    if (!priorDecisionRelationships.has(row.relationship)) errors.push(`${p}.relationship is invalid`);
    validateEvidenceRefs(row.evidence_refs, `${p}.evidence_refs`, evidenceIds, errors);
  });
}

function validateResolutionOptions(value: unknown, prefix: string, evidenceIds: Set<string>, errors: string[]): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) {
    errors.push(`${prefix}.recommended_resolution_options must be an array`);
    return ids;
  }
  value.forEach((item, index) => {
    const p = `${prefix}.recommended_resolution_options[${index}]`;
    if (!item || typeof item !== "object") {
      errors.push(`${p} must be an object`);
      return;
    }
    const row = item as any;
    if (!isString(row.id)) {
      errors.push(`${p}.id is required`);
    } else if (ids.has(row.id)) {
      errors.push(`${p}.id duplicate ${row.id}`);
    } else {
      ids.add(row.id);
    }
    if (!isString(row.label)) errors.push(`${p}.label is required`);
    if (!isString(row.summary)) errors.push(`${p}.summary is required`);
    if (!optionRecommendations.has(row.recommendation)) errors.push(`${p}.recommendation is invalid`);
    if (!Array.isArray(row.pros) || !row.pros.every(isString)) errors.push(`${p}.pros must be a string array`);
    if (!Array.isArray(row.cons) || !row.cons.every(isString)) errors.push(`${p}.cons must be a string array`);
    if (!nextSteps.has(row.next_step)) errors.push(`${p}.next_step is invalid`);
    if (!Array.isArray(row.source_changes) || !row.source_changes.every(isString)) errors.push(`${p}.source_changes must be a string array`);
    validateEvidenceRefs(row.evidence_refs, `${p}.evidence_refs`, evidenceIds, errors);
  });
  return ids;
}

function validateDecision(
  decision: any,
  prefix: string,
  seedKey: string,
  expectedRole: "seed" | "related",
  exploredSnapshots: Set<string>,
  errors: string[],
  warnings: string[],
): string[] {
  if (!decision || typeof decision !== "object") {
    errors.push(`${prefix} must be an object`);
    return [];
  }
  if (!isKey(decision.key)) errors.push(`${prefix}.key must be FHIR-XXXXX`);
  if (expectedRole === "seed" && decision.key !== seedKey) errors.push(`${prefix}.key must equal seed_key ${seedKey}`);
  if (decision.role !== expectedRole) errors.push(`${prefix}.role must be ${expectedRole}`);
  if (!trackerStates.has(decision.tracker_state)) errors.push(`${prefix}.tracker_state is invalid`);
  if (!assessments.has(decision.assessment)) errors.push(`${prefix}.assessment is invalid`);
  if (!nextSteps.has(decision.next_step)) errors.push(`${prefix}.next_step is invalid`);
  if (!confidences.has(decision.confidence)) errors.push(`${prefix}.confidence is invalid`);
  if (!isString(decision.summary)) errors.push(`${prefix}.summary is required`);
  if (!isString(decision.reasoning)) errors.push(`${prefix}.reasoning is required`);
  if (!isString(decision.recommendation)) errors.push(`${prefix}.recommendation is required`);
  if (!Array.isArray(decision.evidence) || decision.evidence.length === 0 || !decision.evidence.every(isString)) {
    errors.push(`${prefix}.evidence must be a non-empty string array`);
  }
  const evidenceIds = validateEvidenceItems(decision.evidence_items, prefix, errors);
  if (!stringArray(decision.target_chunks)) errors.push(`${prefix}.target_chunks must be a string array`);
  if (Array.isArray(decision.target_chunks)) {
    for (const chunk of decision.target_chunks) {
      if (typeof chunk === "string" && chunk.includes("::")) {
        errors.push(`${prefix}.target_chunks must use chunk ids like wg--topic, not scheduler partitions like ${chunk}`);
      }
    }
  }
  if (!stringArray(decision.source_paths)) errors.push(`${prefix}.source_paths must be a string array`);
  validateRelated(decision.related_jiras, prefix, errors);
  validatePriorDecisions(decision.prior_decisions, prefix, evidenceIds, errors);
  if (!stringArray(decision.decision_questions)) errors.push(`${prefix}.decision_questions must be a string array`);
  const optionIds = validateResolutionOptions(decision.recommended_resolution_options, prefix, evidenceIds, errors);
  if (decision.preferred_option_id !== undefined) {
    if (!isString(decision.preferred_option_id)) {
      errors.push(`${prefix}.preferred_option_id must be a string when present`);
    } else if (!optionIds.has(decision.preferred_option_id)) {
      errors.push(`${prefix}.preferred_option_id references unknown option ${decision.preferred_option_id}`);
    }
  }

  if (expectedRole === "related") {
    if (isKey(decision.key) && !exploredSnapshots.has(decision.key)) errors.push(`${prefix} must cite a Jira snapshot in explored.jira_snapshots_read`);
  }
  if (decision.assessment === "ready-to-apply" && !isString(decision.edit_plan)) errors.push(`${prefix}.edit_plan is required for ready-to-apply`);
  if (["not-ready-to-apply", "unclear"].includes(decision.assessment) || ["needs-human-decision", "close-duplicate"].includes(decision.next_step)) {
    if (!isString(decision.blocker)) errors.push(`${prefix}.blocker is required for not-ready/unclear/human-decision`);
    if (!Array.isArray(decision.decision_questions) || decision.decision_questions.length === 0) {
      errors.push(`${prefix}.decision_questions is required for not-ready/unclear/human-decision`);
    }
    if (!Array.isArray(decision.recommended_resolution_options) || decision.recommended_resolution_options.length === 0) {
      errors.push(`${prefix}.recommended_resolution_options is required for not-ready/unclear/human-decision`);
    }
  }
  if (decision.assessment === "needs-follow-up" || decision.next_step === "file-jira") {
    validateProposed(decision.proposed_jira, prefix, errors);
  }
  if (decision.assessment === "fully-applied" && decision.next_step !== "none") errors.push(`${prefix}.next_step must be none for fully-applied`);
  if (decision.assessment === "out-of-scope" && decision.next_step !== "none") errors.push(`${prefix}.next_step must be none for out-of-scope`);
  if (decision.assessment === "ready-to-apply" && decision.next_step !== "apply") errors.push(`${prefix}.next_step must be apply for ready-to-apply`);
  if (decision.next_step === "close-duplicate") {
    const related = Array.isArray(decision.related_jiras) ? decision.related_jiras : [];
    if (!related.some((item: any) => item?.relationship === "duplicate" || item?.relationship === "superseded-by")) {
      errors.push(`${prefix}.related_jiras must include a duplicate or superseded-by relationship for close-duplicate`);
    }
  }

  return Array.isArray(decision.target_chunks) ? decision.target_chunks.filter((item: unknown): item is string => typeof item === "string") : [];
}

export function validateIssueMappingResult(options: {
  runId?: string;
  seedKey?: string;
  resultPath?: string;
  writeResult?: boolean;
}): ValidationResult {
  const resultPath = options.resultPath
    ? path.resolve(options.resultPath)
    : path.join(runPath(options.runId ?? ""), "seed-runs", options.seedKey ?? "", "result.json");
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(resultPath)) {
    const result = { ok: false, errors: [`missing result file: ${resultPath}`], warnings, resultPath, decidedIssueCount: 0, targetChunkCount: 0 };
    if (options.writeResult) writeJson(path.join(path.dirname(resultPath), "validation.json"), result);
    return result;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch (error) {
    const result = { ok: false, errors: [`result is invalid JSON: ${String(error)}`], warnings, resultPath, decidedIssueCount: 0, targetChunkCount: 0 };
    if (options.writeResult) writeJson(path.join(path.dirname(resultPath), "validation.json"), result);
    return result;
  }

  const seedKey = options.seedKey ?? parsed.seed_key;
  if (!isKey(seedKey)) errors.push("seed_key must be FHIR-XXXXX");
  if (parsed.schema_version !== "issue-mapping-seed-v2") errors.push("schema_version must be issue-mapping-seed-v2");
  if (parsed.seed_key !== seedKey) errors.push(`result seed_key must be ${seedKey}`);

  const explored = parsed.explored;
  if (!explored || typeof explored !== "object") {
    errors.push("explored is required");
  }
  const snapshotKeys = new Set<string>();
  for (const field of ["jira_snapshots_read", "zulip_threads_read", "confluence_pages_read", "source_paths_inspected", "git_queries_run"]) {
    const value = explored?.[field];
    if (!stringArray(value)) {
      errors.push(`explored.${field} must be a string array`);
    } else if (field === "jira_snapshots_read") {
      for (const item of value) if (/^FHIR-\d+$/.test(item)) snapshotKeys.add(item);
    }
  }
  if (isKey(seedKey) && !snapshotKeys.has(seedKey)) errors.push("explored.jira_snapshots_read must include the seed key");

  const targetChunks: string[] = [];
  if (!Array.isArray(parsed.issues) || parsed.issues.length === 0) {
    errors.push("issues must be a non-empty array");
  } else {
    let seedDecisionCount = 0;
    parsed.issues.forEach((decision: any, index: number) => {
      if (decision?.role === "seed") seedDecisionCount += 1;
      const expectedRole = decision?.role === "seed" ? "seed" : "related";
      targetChunks.push(...validateDecision(decision, `issues[${index}]`, seedKey, expectedRole, snapshotKeys, errors, warnings));
    });
    if (seedDecisionCount !== 1) errors.push("issues must contain exactly one decision with role=seed");
  }

  if (!Array.isArray(parsed.related_but_not_decided)) {
    errors.push("related_but_not_decided must be an array");
  } else {
    parsed.related_but_not_decided.forEach((item: any, index: number) => {
      const prefix = `related_but_not_decided[${index}]`;
      if (!item || typeof item !== "object") {
        errors.push(`${prefix} must be an object`);
        return;
      }
      if (!isJiraKey(item.key)) errors.push(`${prefix}.key must be a Jira-style key such as FHIR-XXXXX or UP-XXXXX`);
      if (!relationships.has(item.relationship)) errors.push(`${prefix}.relationship is invalid`);
      if (!isString(item.note)) errors.push(`${prefix}.note is required`);
    });
  }

  const decidedIssueCount = Array.isArray(parsed.issues) ? parsed.issues.length : 0;
  const result: ValidationResult = {
    ok: errors.length === 0,
    errors,
    warnings,
    resultPath,
    decidedIssueCount,
    targetChunkCount: new Set(targetChunks.filter(Boolean)).size,
  };
  if (options.writeResult) writeJson(path.join(path.dirname(resultPath), "validation.json"), result);
  return result;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`Usage: bun autofhir/scripts/validate-issue-mapping-result.ts --run-id ID --seed-key FHIR-XXXXX [--result PATH] [--json] [--write-result]`);
    process.exit(0);
  }
  const runId = arg("--run-id") ?? process.env.RUN_ID;
  const seedKey = arg("--seed-key") ?? process.env.SEED_KEY;
  const resultPath = arg("--result");
  if (!resultPath && (!runId || !seedKey)) throw new Error("pass --result or both --run-id and --seed-key");
  const result = validateIssueMappingResult({
    runId,
    seedKey,
    resultPath,
    writeResult: process.argv.includes("--write-result"),
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ok=${result.ok}`);
    console.log(`result=${result.resultPath}`);
    console.log(`decided_issues=${result.decidedIssueCount}`);
    console.log(`target_chunks=${result.targetChunkCount}`);
    for (const warning of result.warnings) console.log(`warning=${warning}`);
    for (const error of result.errors) console.log(`error=${error}`);
  }
  process.exit(result.ok ? 0 : 1);
}
