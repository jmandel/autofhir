#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { runPath, writeJson } from "./lib";

type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  planPath: string;
  mentionedCount: number;
  reviewedInScopeCount: number;
  candidateTsvCount?: number;
  reviewedCandidateCount?: number;
  proposedJiraCount?: number;
};

const trackerStates = new Set(["applied_or_published", "resolved_change_required", "resolved_no_change", "not_resolved", "unknown"]);
const scopes = new Set(["in-scope", "context-only", "out-of-scope", "unclear"]);
const candidateNextSteps = new Set(["none", "apply", "review"]);
const assessments = new Set([
  "out-of-scope",
  "unclear",
  "fully-applied",
  "not-fully-applied",
  "superseded-after-application",
  "ready-to-apply",
  "not-ready-to-apply",
  "no-change-still-makes-sense",
  "context-for-other-work",
  "needs-resolution",
  "monitor",
  "not-actionable",
]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameSet(a: string[], b: string[]): boolean {
  const aa = sortedUnique(a);
  const bb = sortedUnique(b);
  return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
}

function diff(left: string[], right: string[]): string[] {
  const r = new Set(right);
  return sortedUnique(left).filter((value) => !r.has(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function candidateKeysFromTsv(file: string): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const keys: string[] = [];
  for (const line of lines) {
    const first = line.split("\t")[0]?.trim();
    if (!first || first.toLowerCase() === "key") continue;
    if (/^FHIR-\d+$/.test(first)) keys.push(first);
  }
  return sortedUnique(keys);
}

function reviewRecords(file: string): {
  candidateKeys: string[];
  mentionedKeys: string[];
  proposedJiraCount: number;
  errors: string[];
} {
  if (!existsSync(file)) return { candidateKeys: [], mentionedKeys: [], proposedJiraCount: 0, errors: [`missing review file: ${file}`] };
  const candidateKeys: string[] = [];
  const mentionedKeys: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let proposedJiraCount = 0;

  readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const prefix = `review/issues.ndjson line ${index + 1}`;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch (error) {
      errors.push(`${prefix} is invalid JSON: ${String(error)}`);
      return;
    }

    if (record.record_type === "proposed-jira") {
      proposedJiraCount += 1;
      if (record.key !== undefined && record.key !== null) errors.push(`${prefix} proposed-jira must not have a FHIR key`);
      if (record.next_step !== "file-jira") errors.push(`${prefix} proposed-jira next_step must be file-jira`);
      if (!isNonEmptyString(record.summary)) errors.push(`${prefix} proposed-jira missing summary`);
      const proposed = record.proposed_jira;
      if (!proposed || typeof proposed !== "object") {
        errors.push(`${prefix} proposed-jira missing proposed_jira object`);
      } else {
        for (const field of ["title", "problem", "where", "suggested_fix", "dedup_check"] as const) {
          if (!isNonEmptyString(proposed[field])) errors.push(`${prefix} proposed_jira.${field} must be a non-empty string`);
        }
        if (!Array.isArray(proposed.source_evidence) || proposed.source_evidence.length === 0) {
          errors.push(`${prefix} proposed_jira.source_evidence must be a non-empty array`);
        }
      }
      return;
    }

    if (record.record_type !== "jira-candidate") {
      errors.push(`${prefix} record_type must be jira-candidate or proposed-jira`);
      return;
    }
    if (!/^FHIR-\d+$/.test(record.key ?? "")) {
      errors.push(`${prefix} missing FHIR key`);
      return;
    }
    if (seen.has(record.key)) errors.push(`review/issues.ndjson duplicate key: ${record.key}`);
    seen.add(record.key);

    if (!trackerStates.has(record.tracker_state)) errors.push(`${prefix} invalid tracker_state for ${record.key}`);
    if (!scopes.has(record.scope)) errors.push(`${prefix} invalid scope for ${record.key}`);
    if (!assessments.has(record.assessment)) errors.push(`${prefix} invalid assessment for ${record.key}`);
    if (!candidateNextSteps.has(record.next_step)) errors.push(`${prefix} invalid next_step for ${record.key}`);
    if (!isNonEmptyString(record.summary)) errors.push(`${prefix} missing summary for ${record.key}`);
    if (typeof record.snapshot_read !== "boolean") errors.push(`${prefix} snapshot_read must be boolean for ${record.key}`);

    candidateKeys.push(record.key);

    if (record.scope === "out-of-scope") {
      if (record.next_step !== "none") errors.push(`${prefix} out-of-scope record ${record.key} must use next_step none`);
      if (record.assessment !== "out-of-scope") errors.push(`${prefix} out-of-scope record ${record.key} must use assessment out-of-scope`);
      if (!isNonEmptyString(record.out_of_scope_reason)) errors.push(`${prefix} out-of-scope record ${record.key} missing out_of_scope_reason`);
      return;
    }

    mentionedKeys.push(record.key);

    if (record.snapshot_read !== true) {
      errors.push(`${prefix} non-out-of-scope record ${record.key} must have snapshot_read true`);
    }

    if (record.scope === "unclear" || record.tracker_state === "unknown") {
      if (record.scope !== "unclear") errors.push(`${prefix} tracker_state unknown requires scope unclear for ${record.key}`);
      if (record.next_step !== "review") errors.push(`${prefix} unclear record ${record.key} must use next_step review`);
      if (record.assessment !== "unclear") errors.push(`${prefix} unclear record ${record.key} must use assessment unclear`);
      if (!isNonEmptyString(record.question)) errors.push(`${prefix} unclear record ${record.key} missing question`);
      return;
    }

    if (record.tracker_state === "applied_or_published" && record.assessment === "fully-applied") {
      if (record.next_step !== "none") errors.push(`${prefix} fully-applied record ${record.key} must use next_step none`);
      if (!isNonEmptyString(record.applied_change)) errors.push(`${prefix} fully-applied record ${record.key} missing applied_change`);
      if (!Array.isArray(record.evidence) || record.evidence.length === 0) errors.push(`${prefix} fully-applied record ${record.key} missing evidence`);
      if (!Array.isArray(record.evidence) || !record.evidence.some((item: unknown) => typeof item === "string" && /^source\/[^:]+:\d+/.test(item))) {
        errors.push(`${prefix} fully-applied record ${record.key} must cite current source file:line evidence`);
      }
    }
    if (record.tracker_state === "applied_or_published" && ["not-fully-applied", "superseded-after-application"].includes(record.assessment)) {
      if (!["apply", "review"].includes(record.next_step)) errors.push(`${prefix} drift record ${record.key} has incompatible next_step`);
      if (!isNonEmptyString(record.intended_change)) errors.push(`${prefix} drift record ${record.key} missing intended_change`);
      if (!isNonEmptyString(record.current_state)) errors.push(`${prefix} drift record ${record.key} missing current_state`);
      if (!isNonEmptyString(record.drift_reason)) errors.push(`${prefix} drift record ${record.key} missing drift_reason`);
      if (!Array.isArray(record.evidence) || record.evidence.length === 0) errors.push(`${prefix} drift record ${record.key} missing evidence`);
    }
    if (record.tracker_state === "resolved_change_required" && record.assessment === "ready-to-apply") {
      if (record.next_step !== "apply") errors.push(`${prefix} ready-to-apply record ${record.key} must use next_step apply`);
      if (!isNonEmptyString(record.resolution_summary)) errors.push(`${prefix} ready-to-apply record ${record.key} missing resolution_summary`);
      if (!isNonEmptyString(record.edit_plan)) errors.push(`${prefix} ready-to-apply record ${record.key} missing edit_plan`);
      if (!Array.isArray(record.evidence) || record.evidence.length === 0) errors.push(`${prefix} ready-to-apply record ${record.key} missing evidence`);
    }
    if (record.tracker_state === "resolved_change_required" && record.assessment === "not-ready-to-apply") {
      if (!["review", "none"].includes(record.next_step)) errors.push(`${prefix} not-ready record ${record.key} has incompatible next_step`);
      if (!isNonEmptyString(record.blocker)) errors.push(`${prefix} not-ready record ${record.key} missing blocker`);
      if (!isNonEmptyString(record.what_is_missing)) errors.push(`${prefix} not-ready record ${record.key} missing what_is_missing`);
      if (!isNonEmptyString(record.recommendation)) errors.push(`${prefix} not-ready record ${record.key} missing recommendation`);
    }
    if (record.tracker_state === "resolved_no_change") {
      if (record.next_step !== "none") errors.push(`${prefix} resolved-no-change record ${record.key} must use next_step none`);
      if (!isNonEmptyString(record.rationale)) errors.push(`${prefix} resolved-no-change record ${record.key} missing rationale`);
    }
    if (record.tracker_state === "not_resolved") {
      if (!["review", "none"].includes(record.next_step)) errors.push(`${prefix} not-resolved record ${record.key} has incompatible next_step`);
      if (!isNonEmptyString(record.discussion_state)) errors.push(`${prefix} not-resolved record ${record.key} missing discussion_state`);
      if (!isNonEmptyString(record.recommendation)) errors.push(`${prefix} not-resolved record ${record.key} missing recommendation`);
    }
  });

  return {
    candidateKeys: sortedUnique(candidateKeys),
    mentionedKeys: sortedUnique(mentionedKeys),
    proposedJiraCount,
    errors,
  };
}

function resolveChunkDir(options: { runId?: string; chunkId?: string; planPath?: string }): string {
  if (!options.planPath) return path.join(runPath(options.runId ?? ""), "chunks", options.chunkId ?? "");
  const resolved = path.resolve(options.planPath);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) return resolved;
  if (path.basename(resolved) === "issues.ndjson" && path.basename(path.dirname(resolved)) === "review") {
    return path.dirname(path.dirname(resolved));
  }
  return path.dirname(resolved);
}

export function validatePlan(options: { runId?: string; chunkId?: string; planPath?: string; writeResult?: boolean }): ValidationResult {
  const chunkDir = resolveChunkDir(options);
  const reviewPath = path.join(chunkDir, "review", "issues.ndjson");
  const errors: string[] = [];
  const warnings: string[] = [];

  const candidateKeys = candidateKeysFromTsv(path.join(chunkDir, "candidates.tsv"));
  if (candidateKeys.length === 0) warnings.push("candidates.tsv missing or empty; candidate coverage cannot be checked");

  const review = reviewRecords(reviewPath);
  errors.push(...review.errors);
  if (candidateKeys.length && !sameSet(review.candidateKeys, candidateKeys)) {
    errors.push(`review/issues.ndjson does not cover candidates.tsv: missing_from_review=${diff(candidateKeys, review.candidateKeys).join(",") || "(none)"} extra_in_review=${diff(review.candidateKeys, candidateKeys).join(",") || "(none)"}`);
  }

  const result: ValidationResult = {
    ok: errors.length === 0,
    errors,
    warnings,
    planPath: reviewPath,
    mentionedCount: review.mentionedKeys.length,
    reviewedInScopeCount: review.mentionedKeys.length,
    candidateTsvCount: candidateKeys.length || undefined,
    reviewedCandidateCount: review.candidateKeys.length || undefined,
    proposedJiraCount: review.proposedJiraCount || undefined,
  };
  if (options.writeResult) writeJson(path.join(chunkDir, "validation.json"), result);
  return result;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`Usage: bun autofhir/scripts/validate-plan.ts [--run-id ID --chunk-id CHUNK] [--chunk-dir DIR] [--json] [--write-result]

Validates discovery output in review/issues.ndjson. The historical script name is
kept so existing coordinator code can continue importing validatePlan().`);
    process.exit(0);
  }
  const runId = arg("--run-id") ?? process.env.RUN_ID;
  const chunkId = arg("--chunk-id") ?? arg("--chunk") ?? process.env.CHUNK_ID;
  const chunkDir = arg("--chunk-dir");
  if (!chunkDir && (!runId || !chunkId)) throw new Error("pass --chunk-dir or both --run-id and --chunk-id");

  const result = validatePlan({
    runId,
    chunkId,
    planPath: chunkDir ? path.resolve(chunkDir) : undefined,
    writeResult: process.argv.includes("--write-result"),
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`ok=${result.ok}`);
    console.log(`review=${result.planPath}`);
    console.log(`mentioned=${result.mentionedCount}`);
    if (result.candidateTsvCount !== undefined) console.log(`candidates_tsv=${result.candidateTsvCount}`);
    if (result.reviewedCandidateCount !== undefined) console.log(`reviewed_candidates=${result.reviewedCandidateCount}`);
    if (result.proposedJiraCount !== undefined) console.log(`proposed_jira=${result.proposedJiraCount}`);
    for (const warning of result.warnings) console.log(`warning=${warning}`);
    for (const error of result.errors) console.log(`error=${error}`);
  }
  process.exit(result.ok ? 0 : 1);
}
