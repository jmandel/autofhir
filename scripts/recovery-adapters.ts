import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import {
  ChunkManifest,
  appendJournal,
  readJson,
  readRun,
  rewriteStatus,
  runCommand,
  runPath,
  setStatus,
  writeJson,
} from "./lib";
import { validateIssueMappingResult } from "./validate-issue-mapping-result";
import { validateIssueFixupResult } from "./validate-issue-fixup-result";
import { validateIssueFixupAuditResult } from "./validate-issue-fixup-audit-result";
import { validateIssueReconcileResult } from "./validate-issue-reconcile-result";
import { validatePlan } from "./validate-plan";

export type RecoveryValidation = {
  ok: boolean;
  summary: string;
  errors?: string[];
  warnings?: string[];
  [key: string]: unknown;
};

export type RecoveryFinalizeResult = {
  status: "done" | "skipped" | "blocked";
  summary: string;
};

export type RecoveryAdapter = {
  workflow: string;
  itemRoot: "chunks" | "seeds";
  itemLabel: string;
  coordinatorScript: string;
  keyFromManifest(manifest: any, file: string): string;
  resultPath(runId: string, key: string): string;
  validateResult(options: { runId: string; key: string; resultPath: string; yes: boolean }): RecoveryValidation;
  finalizeValidResult(options: {
    runId: string;
    key: string;
    resultPath: string;
    validation: RecoveryValidation;
    yes: boolean;
  }): RecoveryFinalizeResult;
  archiveBeforeRetry?(options: { runId: string; key: string; resultPath: string; state: string; yes: boolean }): void;
};

function seedFile(runId: string, state: string, seedKey: string): string {
  return path.join(runPath(runId), "seeds", state, `${seedKey}.json`);
}

function moveSeed(runId: string, seedKey: string, from: string, to: string): void {
  const source = seedFile(runId, from, seedKey);
  const dest = seedFile(runId, to, seedKey);
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(source, dest);
}

function archiveIfExists(file: string, label: string): void {
  if (!existsSync(file)) return;
  const archived = path.join(path.dirname(file), `${path.basename(file)}.${label}-${Date.now()}`);
  renameSync(file, archived);
}

function statusValues(runId: string, key: string): Record<string, string> {
  const file = path.join(runPath(runId), "status", `${key}.status`);
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    values[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return values;
}

function existingObservationSeeds(runId: string): Set<string> {
  const seeds = new Set<string>();
  const all = path.join(runPath(runId), "issue-observations", "all.ndjson");
  if (!existsSync(all)) return seeds;
  for (const line of readFileSync(all, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obs = JSON.parse(line);
      if (typeof obs.seed_key === "string") seeds.add(obs.seed_key);
    } catch {
      // Leave malformed historical lines alone; result-level validation handles current output.
    }
  }
  return seeds;
}

function skipPendingIssueMappingSeed(runId: string, seedKey: string, reason: string, decidedBySeed: string, yes: boolean): boolean {
  const pendingPath = seedFile(runId, "pending", seedKey);
  if (!existsSync(pendingPath)) return false;
  if (!yes) return true;
  moveSeed(runId, seedKey, "pending", "skipped");
  rewriteStatus(runId, seedKey, {
    state: "skipped",
    seed_key: seedKey,
    ended_at: new Date().toISOString(),
    reason,
    decided_by_seed: decidedBySeed,
  });
  appendJournal(runId, {
    type: "issue-mapping-seed-skipped",
    seedKey,
    status: "skipped",
    summary: `${reason}; decided_by_seed=${decidedBySeed}`,
  });
  return true;
}

function accumulateIssueMappingObservations(runId: string, seedKey: string, resultPath: string, yes: boolean): { observations: number; skipped: number } {
  const result = readJson<any>(resultPath);
  const rows = Array.isArray(result.issues) ? result.issues : [];
  let observations = 0;
  let skipped = 0;
  for (const decision of rows) {
    if (!decision?.key) continue;
    const observation = {
      schema_version: "issue-observation-v1",
      run_id: runId,
      observation_id: `${seedKey}--${decision.key}--${Date.now()}--${observations}`,
      seed_key: seedKey,
      issue_key: decision.key,
      role: decision.role,
      decision,
      result_path: path.relative(runPath(runId), resultPath),
      created_at: new Date().toISOString(),
    };
    if (yes) {
      const root = runPath(runId);
      appendFileSync(path.join(root, "issue-observations", `${decision.key}.ndjson`), `${JSON.stringify(observation)}\n`);
      appendFileSync(path.join(root, "issue-observations", "all.ndjson"), `${JSON.stringify(observation)}\n`);
    }
    observations += 1;

    if (decision.role === "related" && decision.confidence === "high" && decision.key !== seedKey) {
      if (skipPendingIssueMappingSeed(runId, decision.key, "high-confidence related decision already recorded", seedKey, yes)) {
        skipped += 1;
      }
    }
  }
  return { observations, skipped };
}

function fixedFindingIdsFromResult(result: any): string[] {
  const ids = new Set<string>();
  for (const entry of result.journalEntries ?? []) {
    if (entry?.decision === "fixed" && entry.findingId) ids.add(entry.findingId);
  }
  return [...ids].sort();
}

function retryInfoPath(runId: string, key: string): string {
  return path.join(runPath(runId), "retries", `${key}.json`);
}

function nextRetryAttempt(runId: string, key: string): number {
  const file = retryInfoPath(runId, key);
  if (!existsSync(file)) return 1;
  const current = readJson<any>(file);
  return Number(current.retryAttempt ?? 0) + 1;
}

function combinedHistoryHasFinding(runId: string, findingId: string): boolean {
  const run = readRun(runId);
  if (!run.fhirRepo || !run.combinedBranch) return false;
  return Boolean(runCommand([
    "git",
    "log",
    "--fixed-strings",
    `--grep=Finding-ID: ${findingId}`,
    "--format=%H",
    "-n",
    "1",
    run.combinedBranch,
  ], {
    cwd: run.fhirRepo,
    allowFailure: true,
  }).trim());
}

function combinedHistoryHasIssueFixup(runId: string, issueKey: string): boolean {
  const run = readRun(runId);
  if (!run.fhirRepo || !run.combinedBranch) return false;
  return Boolean(runCommand([
    "git",
    "log",
    "--fixed-strings",
    `--grep=Issue-Fixup-Key: ${issueKey}`,
    "--format=%H",
    "-n",
    "1",
    run.combinedBranch,
  ], {
    cwd: run.fhirRepo,
    allowFailure: true,
  }).trim());
}

function combinedHistoryHasIssueReconcile(runId: string, issueKey: string): boolean {
  const run = readRun(runId);
  if (!run.fhirRepo || !run.combinedBranch) return false;
  return Boolean(runCommand([
    "git",
    "log",
    "--fixed-strings",
    `--grep=Issue-Reconcile-Key: ${issueKey}`,
    "--format=%H",
    "-n",
    "1",
    run.combinedBranch,
  ], {
    cwd: run.fhirRepo,
    allowFailure: true,
  }).trim());
}

export const issueMappingRecoveryAdapter: RecoveryAdapter = {
  workflow: "issue-mapping",
  itemRoot: "seeds",
  itemLabel: "seed",
  coordinatorScript: "autofhir/scripts/issue-mapping-coordinator.ts",
  keyFromManifest(manifest) {
    return manifest.seed_key;
  },
  resultPath(runId, key) {
    return path.join(runPath(runId), "seed-runs", key, "result.json");
  },
  validateResult({ runId, key, resultPath, yes }) {
    const validation = validateIssueMappingResult({ runId, seedKey: key, resultPath, writeResult: yes });
    return {
      ...validation,
      summary: validation.ok
        ? `valid result with ${validation.decidedIssueCount} decisions and ${validation.targetChunkCount} target chunks`
        : `invalid result: ${validation.errors.join("; ")}`,
    };
  },
  finalizeValidResult({ runId, key, resultPath, validation, yes }) {
    const observed = existingObservationSeeds(runId);
    const { observations, skipped } = observed.has(key)
      ? { observations: 0, skipped: 0 }
      : accumulateIssueMappingObservations(runId, key, resultPath, yes);
    if (yes) {
      rewriteStatus(runId, key, {
        state: "done",
        seed_key: key,
        ended_at: new Date().toISOString(),
        exit_warning: "recovered after coordinator interruption",
        decided_issues: Number(validation.decidedIssueCount ?? 0),
        decisions: observations,
        target_chunks: Number(validation.targetChunkCount ?? 0),
      });
      appendJournal(runId, {
        type: "issue-mapping-seed-recovered-complete",
        seedKey: key,
        status: "done",
        summary: `${validation.summary}; skipped_pending=${skipped}`,
      });
    }
    return {
      status: "done",
      summary: `observations=${observations} skipped_pending=${skipped}`,
    };
  },
  archiveBeforeRetry({ resultPath, yes }) {
    if (yes) archiveIfExists(resultPath, "failed");
  },
};

export const discoveryRecoveryAdapter: RecoveryAdapter = {
  workflow: "discovery",
  itemRoot: "chunks",
  itemLabel: "chunk",
  coordinatorScript: "autofhir/scripts/discovery-coordinator.ts",
  keyFromManifest(manifest, file) {
    return manifest.chunkId ?? path.basename(file, ".json");
  },
  resultPath(runId, key) {
    return path.join(runPath(runId), "chunks", key, "review", "issues.ndjson");
  },
  validateResult({ runId, key, yes }) {
    const validation = validatePlan({ runId, chunkId: key, writeResult: yes });
    return {
      ...validation,
      summary: validation.ok
        ? `valid discovery review with ${validation.reviewedCandidateCount ?? 0} reviewed candidates and ${validation.proposedJiraCount ?? 0} proposed Jira rows`
        : `invalid discovery review: ${validation.errors.join("; ")}`,
    };
  },
  finalizeValidResult({ runId, key, validation, yes }) {
    if (yes) {
      rewriteStatus(runId, key, {
        state: "done",
        chunk_id: key,
        ended_at: new Date().toISOString(),
        exit_warning: "recovered after coordinator interruption",
        mentioned_count: Number(validation.mentionedCount ?? 0),
        reviewed_candidates: Number(validation.reviewedCandidateCount ?? 0),
        proposed_jira: Number(validation.proposedJiraCount ?? 0),
      });
      appendJournal(runId, {
        type: "discovery-chunk-recovered-complete",
        chunkId: key,
        status: "done",
        summary: validation.summary,
      });
    }
    return { status: "done", summary: validation.summary };
  },
};

export const applyRecoveryAdapter: RecoveryAdapter = {
  workflow: "apply",
  itemRoot: "chunks",
  itemLabel: "chunk",
  coordinatorScript: "autofhir/scripts/coordinator.ts",
  keyFromManifest(manifest: ChunkManifest, file) {
    return manifest.chunkId ?? path.basename(file, ".json");
  },
  resultPath(runId, key) {
    return path.join(runPath(runId), "results", `${key}.json`);
  },
  validateResult({ runId, resultPath }) {
    if (!existsSync(resultPath)) {
      return { ok: false, summary: `missing result JSON: ${resultPath}`, errors: [`missing result JSON: ${resultPath}`] };
    }
    let result: any;
    try {
      result = readJson<any>(resultPath);
    } catch (error) {
      return { ok: false, summary: `invalid result JSON: ${String(error)}`, errors: [String(error)] };
    }
    if (result.status === "skipped" || result.status === "blocked") {
      return { ok: true, summary: `valid ${result.status} result`, resultStatus: result.status };
    }
    if (result.status !== "applied" && result.status !== "partial") {
      return { ok: false, summary: `unknown result status: ${result.status}`, errors: [`unknown result status: ${result.status}`] };
    }
    const missing = fixedFindingIdsFromResult(result).filter((findingId) => !combinedHistoryHasFinding(runId, findingId));
    if (missing.length) {
      return {
        ok: false,
        summary: `fixed findings missing from combined history: ${missing.join(", ")}`,
        errors: [`fixed findings missing from combined history: ${missing.join(", ")}`],
      };
    }
    return { ok: true, summary: `valid ${result.status} result with fixed findings present in combined history`, resultStatus: result.status };
  },
  finalizeValidResult({ runId, key, resultPath, validation, yes }) {
    const result = readJson<any>(resultPath);
    if (yes) {
      for (const entry of result.journalEntries ?? []) {
        appendJournal(runId, { type: "chunk-decision", chunkId: key, ...entry });
      }
    }
    if (result.status === "skipped") {
      if (yes) {
        setStatus(runId, key, { status: "skipped" });
        appendJournal(runId, { type: "chunk-skipped", chunkId: key, status: "skipped", summary: result.summary });
      }
      return { status: "skipped", summary: result.summary ?? validation.summary };
    }
    if (result.status === "blocked") {
      if (yes) {
        setStatus(runId, key, { status: "blocked" });
        appendJournal(runId, { type: "chunk-blocked", chunkId: key, status: "blocked", summary: result.summary });
      }
      return { status: "blocked", summary: result.summary ?? validation.summary };
    }
    if (yes) {
      setStatus(runId, key, { status: "complete" });
      appendJournal(runId, { type: "chunk-integrated", chunkId: key, status: "done", summary: result.summary });
    }
    return { status: "done", summary: result.summary ?? validation.summary };
  },
  archiveBeforeRetry({ runId, key, resultPath, state, yes }) {
    if (!yes) return;
    const status = statusValues(runId, key);
    const retryAttempt = nextRetryAttempt(runId, key);
    writeJson(retryInfoPath(runId, key), {
      schemaVersion: "1.0",
      runId,
      chunkId: key,
      retryAttempt,
      queuedAt: new Date().toISOString(),
      previousState: state,
      previous: {
        branch: status.branch,
        worktree: status.worktree,
        chunk_json: status.chunk_json,
        result: status.result ?? resultPath,
        prompt: status.prompt,
        stdout: status.stdout,
        stderr: status.stderr,
        copilot_log_dir: status.copilot_log_dir,
        exit_code: status.exit_code,
        finished_at: status.finished_at,
        status: status.status,
        error: status.error,
      },
    });
    archiveIfExists(resultPath, state);
  },
};

export const issueFixupRecoveryAdapter: RecoveryAdapter = {
  workflow: "issue-fixup",
  itemRoot: "chunks",
  itemLabel: "issue",
  coordinatorScript: "autofhir/scripts/issue-fixup-coordinator.ts",
  keyFromManifest(manifest, file) {
    return manifest.issueKey ?? manifest.chunkId ?? path.basename(file, ".json");
  },
  resultPath(runId, key) {
    return path.join(runPath(runId), "results", `${key}.json`);
  },
  validateResult({ runId, key, resultPath, yes }) {
    const validation = validateIssueFixupResult({ runId, issueKey: key, chunkId: key, resultPath, writeResult: yes });
    return {
      ...validation,
      summary: validation.ok
        ? `valid issue-fixup ${validation.status} result${validation.commitSha ? ` commit=${validation.commitSha}` : ""}`
        : `invalid issue-fixup result: ${validation.errors.join("; ")}`,
    };
  },
  finalizeValidResult({ runId, key, resultPath, validation, yes }) {
    const result = readJson<any>(resultPath);
    if (yes) {
      for (const entry of result.journal_entries ?? []) {
        appendJournal(runId, { type: "issue-fixup-decision", issueKey: key, ...entry });
      }
    }
    if (result.status === "blocked") {
      if (yes) {
        setStatus(runId, key, { status: "blocked" });
        appendJournal(runId, { type: "issue-fixup-blocked", issueKey: key, status: "blocked", summary: result.decision?.summary ?? result.status });
      }
      return { status: "blocked", summary: result.decision?.summary ?? validation.summary };
    }
    if (yes) {
      setStatus(runId, key, { status: "complete", recovered_commit_present: combinedHistoryHasIssueFixup(runId, key) ? "true" : "false" });
      appendJournal(runId, { type: "issue-fixup-integrated", issueKey: key, status: result.status, summary: result.decision?.summary ?? result.status });
    }
    return { status: "done", summary: result.decision?.summary ?? validation.summary };
  },
  archiveBeforeRetry({ runId, key, resultPath, state, yes }) {
    if (!yes) return;
    const status = statusValues(runId, key);
    const retryAttempt = nextRetryAttempt(runId, key);
    writeJson(retryInfoPath(runId, key), {
      schemaVersion: "1.0",
      runId,
      issueKey: key,
      chunkId: key,
      retryAttempt,
      queuedAt: new Date().toISOString(),
      previousState: state,
      previous: {
        branch: status.branch,
        worktree: status.worktree,
        chunk_json: status.chunk_json,
        result: status.result ?? resultPath,
        prompt: status.prompt,
        stdout: status.stdout,
        stderr: status.stderr,
        copilot_log_dir: status.copilot_log_dir,
        exit_code: status.exit_code,
        finished_at: status.finished_at,
        status: status.status,
        error: status.error,
      },
    });
    archiveIfExists(resultPath, state);
  },
};

export const issueFixupAuditRecoveryAdapter: RecoveryAdapter = {
  workflow: "issue-fixup-audit",
  itemRoot: "chunks",
  itemLabel: "issue",
  coordinatorScript: "autofhir/scripts/issue-fixup-audit-coordinator.ts",
  keyFromManifest(manifest, file) {
    return manifest.issueKey ?? manifest.chunkId ?? path.basename(file, ".json");
  },
  resultPath(runId, key) {
    return path.join(runPath(runId), "results", `${key}.json`);
  },
  validateResult({ runId, key, resultPath, yes }) {
    const chunkPath = path.join(runPath(runId), "chunks", "running", `${key}.json`);
    const fallbackChunkPath = path.join(runPath(runId), "chunks", "pending", `${key}.json`);
    const doneChunkPath = path.join(runPath(runId), "chunks", "done", `${key}.json`);
    const failedChunkPath = path.join(runPath(runId), "chunks", "failed", `${key}.json`);
    const validation = validateIssueFixupAuditResult({
      runId,
      issueKey: key,
      chunkPath: [chunkPath, fallbackChunkPath, doneChunkPath, failedChunkPath].find(existsSync),
      resultPath,
      writeResult: yes,
    });
    return {
      ...validation,
      summary: validation.ok
        ? `valid issue-fixup-audit ${validation.decision} result`
        : `invalid issue-fixup-audit result: ${validation.errors.join("; ")}`,
    };
  },
  finalizeValidResult({ runId, key, resultPath, validation, yes }) {
    const result = readJson<any>(resultPath);
    if (yes) {
      setStatus(runId, key, { status: "complete", decision: result.decision });
      appendJournal(runId, {
        type: "issue-fixup-audit-complete",
        issueKey: key,
        commitSha: result.commit_sha,
        decision: result.decision,
        summary: result.recommended_next_step ?? validation.summary,
      });
    }
    return { status: "done", summary: result.recommended_next_step ?? validation.summary };
  },
  archiveBeforeRetry({ runId, key, resultPath, state, yes }) {
    if (!yes) return;
    const status = statusValues(runId, key);
    const retryAttempt = nextRetryAttempt(runId, key);
    writeJson(retryInfoPath(runId, key), {
      schemaVersion: "1.0",
      runId,
      issueKey: key,
      chunkId: key,
      retryAttempt,
      queuedAt: new Date().toISOString(),
      previousState: state,
      previous: {
        worktree: status.worktree,
        chunk_json: status.chunk_json,
        result: status.result ?? resultPath,
        prompt: status.prompt,
        stdout: status.stdout,
        stderr: status.stderr,
        copilot_log_dir: status.copilot_log_dir,
        exit_code: status.exit_code,
        finished_at: status.finished_at,
        status: status.status,
        error: status.error,
      },
    });
    archiveIfExists(resultPath, state);
  },
};

export const issueReconcileRecoveryAdapter: RecoveryAdapter = {
  workflow: "issue-reconcile",
  itemRoot: "chunks",
  itemLabel: "seed",
  coordinatorScript: "autofhir/scripts/issue-reconcile-coordinator.ts",
  keyFromManifest(manifest, file) {
    return manifest.seedKey ?? manifest.issueKey ?? manifest.chunkId ?? path.basename(file, ".json");
  },
  resultPath(runId, key) {
    return path.join(runPath(runId), "results", `${key}.json`);
  },
  validateResult({ runId, key, resultPath, yes }) {
    const validation = validateIssueReconcileResult({ runId, seedKey: key, chunkId: key, resultPath, writeResult: yes });
    return {
      ...validation,
      summary: validation.ok
        ? `valid issue-reconcile ${validation.status} result with ${validation.issueCount ?? 0} issue decisions`
        : `invalid issue-reconcile result: ${validation.errors.join("; ")}`,
    };
  },
  finalizeValidResult({ runId, key, resultPath, validation, yes }) {
    const result = readJson<any>(resultPath);
    if (yes) {
      for (const entry of result.journal_entries ?? []) {
        appendJournal(runId, { type: "issue-reconcile-decision", seedKey: key, ...entry });
      }
      for (const issueResult of result.issue_results ?? []) {
        appendJournal(runId, {
          type: "issue-reconcile-issue",
          seedKey: key,
          issueKey: issueResult.issue_key,
          role: issueResult.role,
          status: issueResult.status,
          summary: issueResult.summary,
        });
      }
    }
    if (result.status === "blocked") {
      if (yes) {
        setStatus(runId, key, { status: "blocked" });
        appendJournal(runId, { type: "issue-reconcile-blocked", seedKey: key, status: "blocked", summary: result.issue_results?.[0]?.summary ?? result.status });
      }
      return { status: "blocked", summary: result.issue_results?.[0]?.summary ?? validation.summary };
    }
    if (yes) {
      setStatus(runId, key, { status: "complete", recovered_seed_commit_present: combinedHistoryHasIssueReconcile(runId, key) ? "true" : "false" });
      appendJournal(runId, { type: "issue-reconcile-integrated", seedKey: key, status: result.status, summary: `${result.issue_results?.length ?? 0} issue decisions` });
    }
    return { status: "done", summary: validation.summary };
  },
  archiveBeforeRetry({ runId, key, resultPath, state, yes }) {
    if (!yes) return;
    const status = statusValues(runId, key);
    const retryAttempt = nextRetryAttempt(runId, key);
    writeJson(retryInfoPath(runId, key), {
      schemaVersion: "1.0",
      runId,
      seedKey: key,
      issueKey: key,
      chunkId: key,
      retryAttempt,
      queuedAt: new Date().toISOString(),
      previousState: state,
      previous: {
        branch: status.branch,
        worktree: status.worktree,
        chunk_json: status.chunk_json,
        result: status.result ?? resultPath,
        prompt: status.prompt,
        stdout: status.stdout,
        stderr: status.stderr,
        copilot_log_dir: status.copilot_log_dir,
        exit_code: status.exit_code,
        finished_at: status.finished_at,
        status: status.status,
        error: status.error,
      },
    });
    archiveIfExists(resultPath, state);
  },
};

export function recoveryAdapterForWorkflow(workflow: string | undefined): RecoveryAdapter {
  if (workflow === "issue-mapping") return issueMappingRecoveryAdapter;
  if (workflow === "discovery") return discoveryRecoveryAdapter;
  if (workflow === "issue-fixup") return issueFixupRecoveryAdapter;
  if (workflow === "issue-fixup-audit") return issueFixupAuditRecoveryAdapter;
  if (workflow === "issue-reconcile") return issueReconcileRecoveryAdapter;
  return applyRecoveryAdapter;
}
