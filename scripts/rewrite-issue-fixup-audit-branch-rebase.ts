#!/usr/bin/env bun

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appendJournal, readJson, readRun, repoRoot, runPath, writeJson, writeRun } from "./lib";

type ReviewCommit = {
  sha: string;
  issue_key?: string;
  files?: string[];
};

type AuditResult = {
  decision?: string;
  replacement_commit_message?: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  throw new Error(message);
}

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}) {
  const proc = spawnSync(args[0], args.slice(1), {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (proc.status !== 0 && !options.allowFailure) {
    throw new Error([
      `command failed: ${args.join(" ")}`,
      `cwd=${options.cwd ?? process.cwd()}`,
      `exit=${proc.status}`,
      proc.stdout?.trim(),
      proc.stderr?.trim(),
    ].filter(Boolean).join("\n"));
  }
  return { status: proc.status ?? 0, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function isSvgOnly(files: string[]) {
  return files.length > 0 && files.every((file) => /\.svg$/i.test(file));
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/rewrite-issue-fixup-audit-branch-rebase.ts --run-id AUDIT_RUN --source-run ISSUE_FIXUP_RUN [--output-branch BRANCH]

Creates a pruned post-audit branch from the pre-audit issue-fixup branch using one interactive rebase:
- keep only audit decision=keep
- keep only commits with source changes
- drop commits that only touch SVG files
- replace kept commit messages with audit replacement_commit_message`);
  process.exit(0);
}

const auditRunId = arg("--run-id") ?? process.env.RUN_ID ?? fail("--run-id is required");
const sourceRunId = arg("--source-run") ?? process.env.SOURCE_RUN_ID ?? "issue-fixup-full-not-fully-applied-v1";
const outputBranch = arg("--output-branch") ?? process.env.OUTPUT_BRANCH ?? `robo-spec-combined-${auditRunId}`;

const auditRun = readRun(auditRunId);
if (auditRun.workflow !== "issue-fixup-audit") fail(`run ${auditRunId} is workflow=${auditRun.workflow ?? "(unset)"}; expected issue-fixup-audit`);
const sourceRun = readRun(sourceRunId);
if (sourceRun.workflow !== "issue-fixup") fail(`source run ${sourceRunId} is workflow=${sourceRun.workflow ?? "(unset)"}; expected issue-fixup`);
if (!sourceRun.fhirRepo || !sourceRun.combinedBranch || !sourceRun.baseSha) fail(`source run ${sourceRunId} is missing fhirRepo/combinedBranch/baseSha`);

const trackedStatus = run(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: sourceRun.fhirRepo }).stdout.trim();
if (trackedStatus) fail(`FHIR repo has tracked local changes; refusing to rewrite branch:\n${trackedStatus}`);

const sourceReportPath = path.join(runPath(sourceRunId), "review", "issue-fixup-diff-report.json");
const sourceReport = readJson<{ commits: ReviewCommit[] }>(sourceReportPath);
const root = runPath(auditRunId);
const supportDir = path.join(root, "worktrees", "rebase-support");
const worktree = path.join(root, "worktrees", "pruned-rebase");
const legacyWorktree = path.join(root, "worktrees", "pruned-branch");
const actionsPath = path.join(supportDir, "actions.tsv");
const messagesDir = path.join(supportDir, "messages");
const sequenceEditorPath = path.join(supportDir, "sequence-editor.cjs");
const messageEditorPath = path.join(supportDir, "message-editor.cjs");
const reportPath = path.join(root, "reports", "pruned-branch.json");

rmSync(supportDir, { recursive: true, force: true });
mkdirSync(messagesDir, { recursive: true });
mkdirSync(path.dirname(reportPath), { recursive: true });

const actions: {
  sha: string;
  issueKey: string;
  action: "reword" | "drop";
  reason: string;
  files: string[];
}[] = [];
const selected: typeof actions = [];
const skipped: Record<string, number> = {};

for (const commit of sourceReport.commits) {
  const issueKey = commit.issue_key;
  const files = commit.files ?? [];
  let action: "reword" | "drop" = "drop";
  let reason = "not-selected";
  if (!issueKey) {
    reason = "missing-issue-key";
  } else {
    const auditPath = path.join(runPath(auditRunId), "results", `${issueKey}.json`);
    if (!existsSync(auditPath)) {
      reason = "missing-audit-result";
    } else {
      const audit = readJson<AuditResult>(auditPath);
      if (audit.decision !== "keep") {
        reason = `audit-${audit.decision ?? "none"}`;
      } else if (files.length === 0) {
        reason = "no-source-change";
      } else if (isSvgOnly(files)) {
        reason = "svg-only";
      } else if (!audit.replacement_commit_message?.trim()) {
        fail(`audit result ${issueKey} is missing replacement_commit_message`);
      } else {
        action = "reword";
        reason = "audit-keep-source-changing";
        writeFileSync(path.join(messagesDir, `${commit.sha}.txt`), audit.replacement_commit_message.trimEnd() + "\n");
        writeFileSync(path.join(messagesDir, `${issueKey}.txt`), audit.replacement_commit_message.trimEnd() + "\n");
      }
    }
  }
  const row = { sha: commit.sha, issueKey: issueKey ?? "", action, reason, files };
  actions.push(row);
  if (action === "reword") selected.push(row);
  else skipped[reason] = (skipped[reason] ?? 0) + 1;
}

writeFileSync(actionsPath, [
  "sha\taction\tissue_key\treason\tfiles",
  ...actions.map((row) => [row.sha, row.action, row.issueKey, row.reason, row.files.join(",")].join("\t")),
].join("\n") + "\n");

writeFileSync(sequenceEditorPath, `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const todoPath = process.argv[2];
const actions = new Map();
for (const line of readFileSync(${JSON.stringify(actionsPath)}, "utf8").trim().split(/\\n/).slice(1)) {
  const [sha, action] = line.split("\\t");
  actions.set(sha, action);
}
const out = [];
for (const line of readFileSync(todoPath, "utf8").split(/\\n/)) {
  if (!line || line.startsWith("#")) { out.push(line); continue; }
  const match = line.match(/^(pick|reword|edit|squash|fixup|exec|break|drop|label|reset|merge)\\s+([^\\s]+)(.*)$/);
  if (!match) { out.push(line); continue; }
  const [, , shortSha, rest] = match;
  let fullSha = shortSha;
  try { fullSha = execFileSync("git", ["rev-parse", shortSha], { encoding: "utf8" }).trim(); } catch {}
  const action = actions.get(fullSha) || "drop";
  out.push(action + " " + fullSha + rest);
}
writeFileSync(todoPath, out.join("\\n"));
`);
chmodSync(sequenceEditorPath, 0o755);

writeFileSync(messageEditorPath, `#!/usr/bin/env bun
import { copyFileSync, existsSync, readFileSync } from "node:fs";
const messagePath = process.argv[2];
const currentMessage = readFileSync(messagePath, "utf8");
const issueKey = currentMessage.match(/\\bFHIR-\\d+\\b/)?.[0];
if (!issueKey) {
  throw new Error("could not infer issue key from commit message");
}
const messageFile = ${JSON.stringify(messagesDir)} + "/" + issueKey + ".txt";
if (!existsSync(messageFile)) {
  throw new Error("missing replacement commit message for " + issueKey);
}
copyFileSync(messageFile, messagePath);
`);
chmodSync(messageEditorPath, 0o755);

run(["git", "worktree", "remove", "--force", worktree], { cwd: sourceRun.fhirRepo, allowFailure: true });
run(["git", "worktree", "remove", "--force", legacyWorktree], { cwd: sourceRun.fhirRepo, allowFailure: true });
rmSync(worktree, { recursive: true, force: true });
rmSync(legacyWorktree, { recursive: true, force: true });
run(["git", "branch", "-f", outputBranch, sourceRun.combinedBranch], { cwd: sourceRun.fhirRepo });
run(["git", "worktree", "add", "-f", "-B", outputBranch, worktree, outputBranch], { cwd: sourceRun.fhirRepo });

const env = {
  GIT_SEQUENCE_EDITOR: sequenceEditorPath,
  GIT_EDITOR: messageEditorPath,
  GIT_MERGE_AUTOEDIT: "no",
};

const rebase = run([
  "git",
  "-c",
  "gc.auto=0",
  "-c",
  "advice.detachedHead=false",
  "rebase",
  "--quiet",
  "-i",
  "--empty=drop",
  "--reapply-cherry-picks",
  "-X",
  "theirs",
  sourceRun.baseSha,
], { cwd: worktree, env, allowFailure: true });

if (rebase.status !== 0) {
  const status = run(["git", "status", "--short"], { cwd: worktree, allowFailure: true }).stdout;
  writeJson(reportPath, {
    schema_version: "issue-fixup-audit-pruned-branch-v1",
    run_id: auditRunId,
    source_run_id: sourceRunId,
    output_branch: outputBranch,
    base: sourceRun.baseSha,
    selected_count: selected.length,
    status: "failed",
    skipped,
    rebase_stdout: rebase.stdout,
    rebase_stderr: rebase.stderr,
    git_status: status,
  });
  throw new Error([
    `rebase rewrite failed`,
    rebase.stdout.trim(),
    rebase.stderr.trim(),
    status.trim(),
    `report=${reportPath}`,
  ].filter(Boolean).join("\n"));
}

const head = run(["git", "rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
const rewrittenLines = run(["git", "rev-list", "--reverse", `${sourceRun.baseSha}..HEAD`], { cwd: worktree }).stdout.trim().split(/\r?\n/).filter(Boolean);

auditRun.fhirRepo = sourceRun.fhirRepo;
auditRun.baseRef = sourceRun.baseRef;
auditRun.baseSha = sourceRun.baseSha;
auditRun.combinedBranch = outputBranch;
auditRun.status = "complete";
writeRun(auditRun);

const report = {
  schema_version: "issue-fixup-audit-pruned-branch-v1",
  run_id: auditRunId,
  source_run_id: sourceRunId,
  output_branch: outputBranch,
  base: sourceRun.baseSha,
  head,
  selected_count: selected.length,
  rewritten_count: rewrittenLines.length,
  skipped,
  selected: selected.map((row, index) => ({
    issue_key: row.issueKey,
    source_sha: row.sha,
    new_sha: rewrittenLines[index] ?? null,
    files: row.files,
  })),
};
writeJson(reportPath, report);
appendJournal(auditRunId, {
  type: "issue-fixup-audit-branch-rewritten-via-rebase",
  sourceRunId,
  outputBranch,
  base: sourceRun.baseSha,
  head,
  selectedCount: selected.length,
  rewrittenCount: rewrittenLines.length,
  skipped,
});

console.log(`run_id=${auditRunId}`);
console.log(`source_run_id=${sourceRunId}`);
console.log(`output_branch=${outputBranch}`);
console.log(`base=${sourceRun.baseSha}`);
console.log(`head=${head}`);
console.log(`selected=${selected.length}`);
console.log(`rewritten=${rewrittenLines.length}`);
console.log(`report=${reportPath}`);
