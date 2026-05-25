#!/usr/bin/env bun

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  ChunkManifest,
  appendJournal,
  chunkFile,
  ensureRunDirs,
  moveChunk,
  notify,
  pauseRun,
  readJson,
  readRun,
  removeIfExists,
  repoRoot,
  rewriteStatus,
  runCommand,
  runPath,
  sanitizeId,
  setStatus,
  writeJson,
  writeRun,
} from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/coordinator.ts --run-id ID

Runs the AutofHIR coordinator. Normally do not invoke this directly during chat;
use start.ts so it runs in the background and returns immediately.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const model = process.env.MODEL ?? "gpt-5.5";
const reasoningEffort = process.env.REASONING_EFFORT ?? "xhigh";
const jobTimeout = process.env.JOB_TIMEOUT;
const maxAutopilotContinues = process.env.MAX_AUTOPILOT_CONTINUES;
const coordinatorPollMs = Math.max(1000, Number(process.env.COORDINATOR_POLL_MS ?? "5000"));
const root = runPath(runId);

ensureRunDirs(runId);
let run = readRun(runId);
if (!run.fhirRepo || !run.baseSha) throw new Error("Run is not initialized. Run init-run.ts first.");
const envConcurrency = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : undefined;
function desiredConcurrency(): number {
  if (envConcurrency !== undefined) return envConcurrency;
  return Number(readRun(runId).concurrency ?? "12");
}

run.status = "running";
writeRun(run);
appendJournal(runId, { type: "coordinator-started", concurrency: desiredConcurrency() });
notify("AutofHIR started", `${runId} concurrency=${desiredConcurrency()}`);

function pendingFiles(): string[] {
  const dir = path.join(root, "chunks/pending");
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));
}

function branchName(chunkId: string): string {
  return `autofhir/${sanitizeId(runId)}/${sanitizeId(chunkId)}`;
}

function retryBranchName(chunkId: string, retryAttempt: number): string {
  return `autofhir/${sanitizeId(runId)}/${sanitizeId(chunkId)}-retry-${retryAttempt}`;
}

function integrationBranchPrefix(chunkId: string): string {
  return `autofhir/${sanitizeId(runId)}/integrate-${sanitizeId(chunkId)}-`;
}

function combinedHistoryHasNeedle(needle: string): boolean {
  return Boolean(runCommand(["git", "log", "--fixed-strings", `--grep=${needle}`, "--format=%H", "-n", "1", run.combinedBranch], {
    cwd: run.fhirRepo,
    allowFailure: true,
  }).trim());
}

function findingIsInCombinedHistory(findingId: string): boolean {
  return combinedHistoryHasNeedle(`Finding-ID: ${findingId}`);
}

function combinedCommitsForNeedle(needle: string, limit = 20): string[] {
  return runCommand([
    "git",
    "--no-pager",
    "log",
    "--fixed-strings",
    `--grep=${needle}`,
    "--format=%H%x09%s",
    `-${limit}`,
    run.combinedBranch,
  ], {
    cwd: run.fhirRepo,
    allowFailure: true,
  }).trim().split("\n").filter(Boolean);
}

type RetryInfo = {
  schemaVersion?: string;
  runId?: string;
  chunkId?: string;
  retryAttempt?: number;
  queuedAt?: string;
  previous?: Record<string, string | number | undefined>;
};

function retryInfoPath(chunkId: string): string {
  return path.join(root, "retries", `${chunkId}.json`);
}

function readRetryInfo(chunkId: string): RetryInfo | undefined {
  const file = retryInfoPath(chunkId);
  if (!existsSync(file)) return undefined;
  return readJson<RetryInfo>(file);
}

function chunkAllFindingsInHistory(chunk: ChunkManifest): boolean {
  const ids = chunk.findingIds ?? [];
  return ids.length > 0 && ids.every((id) => findingIsInCombinedHistory(id));
}

function fixedFindingIdsFromResult(result: any): string[] {
  const ids = new Set<string>();
  for (const entry of result.journalEntries ?? []) {
    if (entry?.decision === "fixed" && entry.findingId) ids.add(entry.findingId);
  }
  return [...ids].sort();
}

function cleanupSuccessfulChunk(chunkId: string, worktree: string, branch: string): void {
  if (process.env.AUTOFHIR_KEEP_WORKTREES === "1") return;
  const integrationDir = path.join(root, "worktrees/integration");
  const prefix = integrationBranchPrefix(chunkId);
  const worktreeList = runCommand(["git", "worktree", "list", "--porcelain"], { cwd: run.fhirRepo!, allowFailure: true });
  for (const block of worktreeList.split("\n\n").filter(Boolean)) {
    const worktreeLine = block.split("\n").find((line) => line.startsWith("worktree "));
    const wt = worktreeLine?.slice("worktree ".length);
    if (!wt) continue;
    if (wt === worktree || wt.startsWith(path.join(integrationDir, chunkId))) {
      runCommand(["git", "worktree", "remove", "-f", wt], { cwd: run.fhirRepo!, allowFailure: true });
      removeIfExists(wt);
    }
  }
  runCommand(["git", "branch", "-D", branch], { cwd: run.fhirRepo!, allowFailure: true });
  const branches = runCommand(["git", "for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`], {
    cwd: run.fhirRepo!,
    allowFailure: true,
  }).trim().split("\n").filter(Boolean);
  for (const b of branches) {
    runCommand(["git", "branch", "-D", b], { cwd: run.fhirRepo!, allowFailure: true });
  }
}

async function runCopilot(prompt: string, cwd: string, stdoutFile: string, stderrFile: string, logDir: string): Promise<number> {
  mkdirSync(logDir, { recursive: true });
  const cmd = [
    "copilot",
    "--model", model,
    "--reasoning-effort", reasoningEffort,
    "--enable-reasoning-summaries",
    "--output-format", "json",
    "--stream", "on",
    "--log-dir", logDir,
    "--log-level", "all",
    "--yolo",
    "--no-ask-user",
    "--silent",
  ];
  if (maxAutopilotContinues) cmd.push("--max-autopilot-continues", maxAutopilotContinues);
  const finalCmd = jobTimeout && !["0", "none", "unlimited"].includes(jobTimeout)
    ? ["timeout", jobTimeout, ...cmd]
    : cmd;
  const stdout = createWriteStream(stdoutFile, { flags: "a" });
  const stderr = createWriteStream(stderrFile, { flags: "a" });
  const proc = spawn(finalCmd[0], finalCmd.slice(1), {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin?.end(readFileSync(prompt, "utf8"));
  proc.stdout?.pipe(stdout);
  proc.stderr?.pipe(stderr);
  return await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => {
      stdout.end();
      stderr.end();
      resolve(code ?? 1);
    });
  });
}

function workerPrompt(
  chunk: ChunkManifest,
  chunkPath: string,
  worktree: string,
  branch: string,
  resultPath: string,
  retryInfo?: RetryInfo,
): string {
  const promptPath = path.join(root, "prompts", `${chunk.chunkId}.md`);
  const abstractionAbs = path.join(repoRoot, chunk.changeChunkReportPath);
  const actionAbs = chunk.actionFilePath ? path.join(repoRoot, "r6htmlpages", chunk.actionFilePath) : "";
  const researchAbs = chunk.researchFilePath ? path.join(repoRoot, "r6htmlpages", chunk.researchFilePath) : "";
  const integrationRoot = path.join(root, "worktrees/integration", chunk.chunkId);
  const integrationPrefix = integrationBranchPrefix(chunk.chunkId);
  const chunkHistory = combinedCommitsForNeedle(`Chunk-Id: ${chunk.chunkId}`);
  const findingHistory = (chunk.findingIds ?? []).map((findingId) => ({
    findingId,
    commits: combinedCommitsForNeedle(`Finding-ID: ${findingId}`, 10),
  }));
  const recoveryBlock = retryInfo ? `
## Retry Recovery Context

This is retry attempt ${retryInfo.retryAttempt ?? "unknown"} for this chunk after an earlier worker exited nonzero.

Previous worker artifacts are preserved for inspection only. Do not continue editing in the previous worktree by default; start from the fresh retry worktree listed above, based on the latest combined branch. Inspect the old worktree/branch/logs to understand what happened, and cherry-pick or adapt unpublished work only if it is still justified and not already represented on ${run.combinedBranch}.

Previous artifacts:

- Previous branch: ${retryInfo.previous?.branch ?? "(unknown)"}
- Previous worktree: ${retryInfo.previous?.worktree ?? "(unknown)"}
- Previous stdout: ${retryInfo.previous?.stdout ?? "(unknown)"}
- Previous stderr: ${retryInfo.previous?.stderr ?? "(unknown)"}
- Previous Copilot log dir: ${retryInfo.previous?.copilot_log_dir ?? "(unknown)"}
- Previous result JSON, if any: ${retryInfo.previous?.result ?? resultPath}
- Previous exit code: ${retryInfo.previous?.exit_code ?? "(unknown)"}

Combined-branch history already present for this chunk:

${chunkHistory.length ? chunkHistory.map((line) => `- ${line}`).join("\n") : "- none found"}

Combined-branch history by finding ID:

${findingHistory.map((entry) => [
  `- ${entry.findingId}:`,
  entry.commits.length ? entry.commits.map((line) => `  - ${line}`).join("\n") : "  - none found",
].join("\n")).join("\n")}

Recovery instructions:

- Treat any finding with a matching \`Finding-ID:\` commit on ${run.combinedBranch} as already represented unless inspection proves otherwise.
- Do not duplicate already represented changes. Verify them in the current source and report those findings as \`already-applied\` in result JSON.
- If the previous worker published commits but failed before writing a result, your primary job is to verify those commits and write the missing complete result JSON/journal decisions.
- If the previous worker left good unpublished edits, bring only the still-justified edits into your fresh retry worktree and publish them normally.
- Your final result JSON must cover every finding in this chunk, including fixed, already-applied, skipped, blocked, or no-action decisions.
` : "";
  writeFileSync(promptPath, `You are an external Copilot CLI worker applying one change chunk report to the FHIR specification.

## Required Reading

Read these before editing:

1. FHIR Community Research skill: ${path.join(repoRoot, "SKILL.md")}
2. AutofHIR skill: ${path.join(repoRoot, "autofhir/SKILL.md")}
3. Chunk manifest: ${chunkPath}
4. Change chunk report: ${abstractionAbs}
${actionAbs ? `5. Action report: ${actionAbs}` : ""}
${researchAbs ? `6. Research appendix: ${researchAbs}` : ""}

## Scope

- Run ID: ${runId}
- Chunk ID: ${chunk.chunkId}
- Chunk title: ${chunk.title}
- FHIR spec worktree: ${worktree}
- Worker branch: ${branch}
- Integration scratch worktree root: ${integrationRoot}
- FHIR repo: ${run.fhirRepo}
- Combined branch: ${run.combinedBranch}
- Result JSON path: ${resultPath}
${recoveryBlock}

Review the whole change chunk report. In this run, chunks happen to be one abstraction JSON file at a time, but treat that as a change report describing your responsibility, not as a framework assumption.

The chunk manifest contains a lightweight \`findings\` index. Treat \`findings[].jiraIdsMentioned\` as search/context hints only. They are not claims that the finding addresses those Jira trackers. Your job is to decide, finding by finding, which mentioned Jira IDs are actually addressed by the commit, which are merely contextual, and whether a new proposed Jira is needed.

## Idempotence

Before editing, scan git history in ${worktree} for:

- \`AutofHIR-Run: ${runId}\`
- \`Chunk-Id: ${chunk.chunkId}\`
- all listed finding IDs: ${(chunk.findingIds ?? []).join(", ") || "none"}

Use finding IDs as the idempotency keys. Jira IDs are for transparency and linkability, not dedupe, because some Jira IDs in the reports are only background evidence. If the relevant finding has already been made, do not duplicate it. Return \`status: "skipped"\` with a journal entry explaining the skip.

## Investigation

Do not guess at FHIR normative content. If a finding is ambiguous, contradicted by current source, contradicted by another issue, lacks justification, or appears obsolete, investigate using the local Jira/Zulip/Confluence/spec commands described in ${path.join(repoRoot, "SKILL.md")}. It is acceptable to apply some findings and skip or block others, but the result must explain each decision.

## Jira IDs Mentioned vs Addressed

For each finding you consider fixing, distinguish Jira IDs the finding actually addresses from Jira IDs mentioned only as context, history, related work, supporting decisions, or possible constraints. Not every Jira mentioned in the chunk/action/research files is being applied by the finding.

Only Jira IDs actually addressed by the finding go in final commit message addressed-Jira metadata and in result JSON \`jiraIdsAddressed\`. If useful, record other mentioned-but-not-addressed Jira IDs separately in \`otherRelatedJiras\` as a list of relationship objects. If a finding has no addressed Jira, include a structured proposed-Jira block in that finding's commit message.

## Commit Hygiene

Commit applied changes locally on your worker branch while you work. Your final published changes on the combined branch must be one clean commit per discrete finding that you actually fix. Do not combine unrelated findings from the same chunk into one final commit.

Each final finding commit must use this shape. Keep the trailer labels exactly as shown because the coordinator uses \`Finding-ID:\` for idempotency:

\`\`\`text
Short imperative subject

One or two paragraphs explaining the actual spec change and why it is correct.

No addressed Jira: <one sentence explaining why this commit uses a proposed Jira instead of an existing addressed tracker>

AutofHIR-Run: ${runId}
Chunk-Id: ${chunk.chunkId}
Finding-ID: <the one finding ID this commit fixes>

<addressed-jiras>
FHIR-XXXXX
FHIR-YYYYY
</addressed-jiras>

<proposed-jira>
<title>Title suitable for filing as a tracker</title>
<body>
Problem:
...

Impact:
...

Proposed resolution:
...
</body>
</proposed-jira>

<evidence>
- Finding: <finding id and stable chunk/report path>
- Source: <repo-relative changed file path(s) and relevant local anchors/line context>
- Community record: <Jira/Zulip/Confluence command or snapshot id, plus what it established>
- Verification: <command that was run and the relevant result>
</evidence>
\`\`\`

Rules for these fields:

- Keep \`AutofHIR-Run:\`, \`Chunk-Id:\`, and \`Finding-ID:\` as plain trailers outside XML-like blocks.
- Include \`<addressed-jiras>\` only when the commit actually addresses/resolves/applies existing Jira trackers. Do not include contextual Jira IDs there.
- Include \`No addressed Jira:\` and \`<proposed-jira>\` only when no existing Jira is being addressed by this finding. The \`No addressed Jira:\` line gives a consistent parseable reason; the proposed Jira body must be multiline and useful for filing, not a compressed one-line summary.
- Include \`<evidence>\` for every fixed finding. Evidence must explain what each item establishes. Avoid opaque lists of absolute temp paths or vague command names.
- Prefer repo-relative durable paths such as \`source/search.html\`, the durable copied report \`${path.relative(repoRoot, path.join(root, "reports", `${chunk.chunkId}.json`))}\`, issue IDs, page IDs, and exact commands with their relevant result.
- Do not cite transient chunk queue paths such as \`chunks/running/*.json\`, because the coordinator moves those files after completion.
- Do not add \`Co-authored-by: Copilot ...\` or any other Copilot coauthor trailer.

Important: both finding and external Jira IDs matter in commit messages, but they mean different things. \`Finding-ID\` is the stable AutofHIR idempotency key. The \`<addressed-jiras>\` block is transparency/linkability metadata and must include only tracker items this commit actually addresses. Jira IDs mentioned in the abstraction/research files may be background evidence only.

## Local-only Worker-led Integration

Do not push to any remote. All integration for this pipeline is local: local FHIR worktrees, local branches, and a local fast-forward update of \`${run.combinedBranch}\`.

You are responsible for publishing your chunk to the combined branch before exiting with \`status: "applied"\` or \`status: "partial"\`. Use Git itself as concurrency control. After your worker branch has the focused local commits you want, transform the work into final finding-level commits in a temporary integration worktree and then publish that branch.

The integration branch should contain:

- zero commits for findings you skip, block, or determine are already applied
- one final clean commit for each fixed finding
- no omnibus "whole chunk" commit unless the chunk truly contains one discrete issue

Use a retry loop shaped like this:

\`\`\`bash
set -euo pipefail
max_attempts=5
for attempt in $(seq 1 "$max_attempts"); do
  old_head=$(git -C "${run.fhirRepo}" rev-parse "${run.combinedBranch}")
  integration_branch="${integrationPrefix}$attempt"
  integration_worktree="${integrationRoot}-$attempt"

  git -C "${run.fhirRepo}" worktree remove -f "$integration_worktree" 2>/dev/null || true
  git -C "${run.fhirRepo}" branch -D "$integration_branch" 2>/dev/null || true
  git -C "${run.fhirRepo}" worktree add -b "$integration_branch" "$integration_worktree" "$old_head"

  git -C "$integration_worktree" cherry-pick "${run.combinedBranch}..${branch}" || true

  # If conflicts exist, resolve them in "$integration_worktree".
  # If conflict resolution requires a spec decision, stop and return "blocked".
  git -C "$integration_worktree" diff --name-only --diff-filter=U

  # Ensure the replayed history has one commit per fixed finding.
  # If your worker branch has draft commits, clean it up with rebase/reset before
  # publishing. Each final commit message must use the structured hygiene
  # template above and must name only Jira IDs actually addressed by that
  # finding commit.
  git -C "$integration_worktree" status --short
  new_head=$(git -C "$integration_worktree" rev-parse HEAD)

  # Local non-checkout fast-forward publish. This updates the local combined
  # branch ref without checking it out and rejects non-fast-forward updates.
  if git -C "${run.fhirRepo}" push . "$integration_branch:${run.combinedBranch}"; then
    break
  fi

  # Another worker landed first. Discard only this temporary integration
  # worktree/branch and retry from the new combined head.
  if [ "$attempt" = "$max_attempts" ]; then
    echo "CAS publish failed after $max_attempts attempts" >&2
    exit 2
  fi
done
\`\`\`

If a retry discovers the change is already represented in the combined history, do not duplicate it; return \`status: "skipped"\` or \`status: "partial"\` with journal entries explaining what happened.

## Shared Journal

Do not append directly to the journal file. Instead, include \`journalEntries\` in your result JSON. The coordinator appends them atomically to the run journal. Include an entry for every finding or page-level decision: fixed, skipped, blocked, unclear, unjustified, contradicted, already-applied, or no-action.

## Result JSON

Write ${resultPath}. It must parse as JSON and include:

\`\`\`json
{
  "status": "applied | partial | skipped | blocked",
  "runId": "${runId}",
  "chunkId": "${chunk.chunkId}",
  "branch": "${branch}",
  "commits": [
    {
      "sha": "<final combined finding commit sha>",
      "findingId": "<finding-id>",
      "jiraIdsAddressed": ["FHIR-..."],
      "otherRelatedJiras": [
        {
          "id": "FHIR-53565",
          "relation": "context-only",
          "description": "Discussed in the same work-group record as the addressed tracker, but this finding does not implement or close it."
        },
        {
          "id": "FHIR-57354",
          "relation": "possible-conflict",
          "description": "Later tracker may constrain the proposed wording; investigate before applying if it touches the same rule."
        }
      ],
      "proposedJira": {
        "title": "...",
        "body": "..."
      }
    }
  ],
  "integrationAttempts": 1,
  "summary": "...",
  "checks": ["..."],
  "journalEntries": [
    {
      "findingId": "...",
      "jiraIdsAddressed": ["FHIR-..."],
      "otherRelatedJiras": [
        {
          "id": "FHIR-53565",
          "relation": "context-only",
          "description": "Relevant background, but not addressed by this finding."
        }
      ],
      "decision": "fixed | skipped | blocked | already-applied | no-action",
      "summary": "...",
      "reason": "..."
    }
  ],
  "notes": ["..."]
}
\`\`\`

Before exiting, verify:

\`\`\`bash
git -C "${worktree}" status --short
git -C "${run.fhirRepo}" log --fixed-strings --grep="Finding-ID: <each fixed finding id>" --format=%H -n 1 "${run.combinedBranch}"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "${resultPath}"
\`\`\`
`);
  return promptPath;
}

async function runOne(pendingPath: string): Promise<void> {
  const chunkId = path.basename(pendingPath, ".json");
  const runningPath = moveChunk(runId, chunkId, "pending", "running");
  const chunk = readJson<ChunkManifest>(runningPath);
  const retryInfo = readRetryInfo(chunkId);
  const retryAttempt = Number(retryInfo?.retryAttempt ?? 0);
  const retrySuffix = retryAttempt > 0 ? `-retry-${retryAttempt}` : "";
  const branch = retryAttempt > 0 ? retryBranchName(chunkId, retryAttempt) : branchName(chunkId);
  const worktree = path.join(root, "worktrees/tasks", `${chunkId}${retrySuffix}`);
  const resultPath = path.join(root, "results", `${chunkId}.json`);
  const statusBase = {
    chunk: chunkId,
    status: "running",
    started_at: new Date().toISOString(),
    retry_attempt: retryAttempt || undefined,
    branch,
    worktree,
    chunk_json: runningPath,
    result: resultPath,
  };
  rewriteStatus(runId, chunkId, statusBase);

  try {
    if ((chunk.findingIds ?? []).length === 0 || (chunk.findings ?? []).length === 0) {
      setStatus(runId, chunkId, { status: "skipped", finished_at: new Date().toISOString() });
      appendJournal(runId, { type: "chunk-skipped", chunkId, status: "no-findings", summary: "chunk has no findings" });
      moveChunk(runId, chunkId, "running", "skipped");
      return;
    }

    if (!retryInfo && chunkAllFindingsInHistory(chunk)) {
      setStatus(runId, chunkId, { status: "skipped", finished_at: new Date().toISOString() });
      appendJournal(runId, { type: "chunk-skipped", chunkId, status: "skipped", summary: "already present in combined history" });
      moveChunk(runId, chunkId, "running", "skipped");
      return;
    }

    runCommand(["git", "worktree", "remove", "-f", worktree], { cwd: run.fhirRepo!, allowFailure: true });
    removeIfExists(worktree);
    runCommand(["git", "branch", "-D", branch], { cwd: run.fhirRepo!, allowFailure: true });
    runCommand(["git", "worktree", "add", "-b", branch, worktree, run.combinedBranch], { cwd: run.fhirRepo! });

    const prompt = workerPrompt(chunk, runningPath, worktree, branch, resultPath, retryInfo);
    setStatus(runId, chunkId, {
      prompt,
      stdout: path.join(root, "stdout", `${chunkId}.stdout.jsonl`),
      stderr: path.join(root, "stderr", `${chunkId}.stderr.log`),
      copilot_log_dir: path.join(root, "copilot-logs", chunkId),
    });
    const rc = await runCopilot(
      prompt,
      worktree,
      path.join(root, "stdout", `${chunkId}.stdout.jsonl`),
      path.join(root, "stderr", `${chunkId}.stderr.log`),
      path.join(root, "copilot-logs", chunkId),
    );
    setStatus(runId, chunkId, { exit_code: rc, finished_at: new Date().toISOString() });
    if (rc !== 0) {
      setStatus(runId, chunkId, { status: rc === 124 ? "timeout" : "failed" });
      appendJournal(runId, { type: "chunk-failed", chunkId, status: "retryable-failed", summary: `copilot exited ${rc}; recover/requeue with recover-run.ts after inspection or when resuming` });
      moveChunk(runId, chunkId, "running", "failed");
      notify("AutofHIR chunk failed", `${runId}/${chunkId}`);
      return;
    }

    if (!existsSync(resultPath)) throw new Error(`missing result JSON: ${resultPath}`);
    const result = readJson<any>(resultPath);
    for (const entry of result.journalEntries ?? []) {
      appendJournal(runId, { type: "chunk-decision", chunkId, ...entry });
    }

    if (result.status === "skipped") {
      setStatus(runId, chunkId, { status: "skipped" });
      appendJournal(runId, { type: "chunk-skipped", chunkId, status: "skipped", summary: result.summary });
      moveChunk(runId, chunkId, "running", "skipped");
      cleanupSuccessfulChunk(chunkId, worktree, branch);
      return;
    }
    if (result.status === "blocked") {
      setStatus(runId, chunkId, { status: "blocked" });
      appendJournal(runId, { type: "chunk-blocked", chunkId, status: "blocked", summary: result.summary });
      moveChunk(runId, chunkId, "running", "blocked");
      notify("AutofHIR chunk blocked", `${runId}/${chunkId}`);
      return;
    }
    if (result.status !== "applied" && result.status !== "partial") {
      throw new Error(`unknown result status: ${result.status}`);
    }
    const fixedFindingIds = fixedFindingIdsFromResult(result);
    const missingFixedFindings = fixedFindingIds.filter((id) => !findingIsInCombinedHistory(id));
    if (missingFixedFindings.length > 0) {
      throw new Error(`worker reported fixed findings missing from combined history: ${missingFixedFindings.join(", ")}`);
    }
    setStatus(runId, chunkId, { status: "complete" });
    appendJournal(runId, { type: "chunk-integrated", chunkId, status: "done", summary: result.summary });
    moveChunk(runId, chunkId, "running", "done");
    cleanupSuccessfulChunk(chunkId, worktree, branch);
  } catch (error: any) {
    setStatus(runId, chunkId, { status: "failed", error: String(error?.message ?? error), finished_at: new Date().toISOString() });
    appendJournal(runId, { type: "chunk-failed", chunkId, status: "failed", summary: String(error?.message ?? error) });
    if (existsSync(chunkFile(runId, "running", chunkId))) moveChunk(runId, chunkId, "running", "failed");
    notify("AutofHIR chunk failed", `${runId}/${chunkId}`);
  }
}

if (runCommand(["bash", "-lc", "command -v copilot"], { allowFailure: true }).trim() === "") {
  pauseRun(runId, "copilot CLI not found in PATH");
  process.exit(1);
}
const active = new Set<Promise<void>>();
let launched = 0;
while (!existsSync(path.join(root, "PAUSED"))) {
  const concurrency = desiredConcurrency();
  while (active.size < concurrency) {
    const next = pendingFiles()[0];
    if (!next) break;
    const p = runOne(next).finally(() => active.delete(p));
    active.add(p);
    launched++;
    console.log(`${new Date().toISOString()} launched ${path.basename(next, ".json")} active=${active.size} concurrency=${concurrency} launched=${launched}`);
  }
  if (active.size === 0) {
    if (pendingFiles().length === 0) break;
    await Bun.sleep(coordinatorPollMs);
    continue;
  }
  await Promise.race([...active, Bun.sleep(coordinatorPollMs)]);
}
if (active.size > 0) await Promise.allSettled(active);

run = readRun(runId);
if (run.status !== "paused") {
  run.status = pendingFiles().length === 0 ? "complete" : run.status;
  writeRun(run);
}
appendJournal(runId, { type: "coordinator-finished", launched, paused: existsSync(path.join(root, "PAUSED")) });
notify("AutofHIR finished", `${runId} launched=${launched}`);
