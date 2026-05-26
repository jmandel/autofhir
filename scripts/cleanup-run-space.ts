#!/usr/bin/env bun

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { readRun, runCommand, runPath, sanitizeId } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): string {
  return `Usage: bun autofhir/scripts/cleanup-run-space.ts --run-id ID [--apply] [--include-agent-logs]

Conservatively reclaims AutoFHIR disk space for a live or completed run.

Dry-run by default. With --apply, removes:
  - stale unregistered run worktree directories under worktrees/tasks,
    worktrees/integration, and worktrees/inspect
  - registered run worktrees whose issue/chunk is no longer running
  - stale autofhir/<run-id> worker/integration branches for non-running issues
  - old /tmp/autofhir-review-publish-* directories
  - with --include-agent-logs, per-item copilot logs, stdout, and stderr
    for non-running issues/chunks/seeds

It never removes worktrees for currently running issues.`;
}

if (flag("-h") || flag("--help")) {
  console.log(usage());
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const apply = flag("--apply");
const includeAgentLogs = flag("--include-agent-logs");
const run = readRun(runId);
const root = runPath(runId);
if (!run.fhirRepo) throw new Error(`run ${runId} has no fhirRepo`);

type Candidate = {
  kind: string;
  path: string;
  issueKey?: string;
  registered?: boolean;
  branch?: string;
  bytes: number;
  reason: string;
};

function issueKeyFromName(name: string): string | undefined {
  return name.match(/FHIR-\d+/)?.[0];
}

function listJsonKeys(dir: string): Set<string> {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, "")));
}

function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

function dirSizeBytes(target: string): number {
  if (!existsSync(target)) return 0;
  const out = runCommand(["du", "-sk", target], { allowFailure: true }).trim();
  const kb = Number(out.split(/\s+/)[0] || "0");
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`;
}

function gitWorktrees(): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  const text = runCommand(["git", "worktree", "list", "--porcelain"], { cwd: run.fhirRepo!, allowFailure: true });
  for (const block of text.split("\n\n").filter(Boolean)) {
    const lines = block.split("\n");
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!worktree) continue;
    const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
    result.set(path.resolve(worktree), branchLine?.slice("branch refs/heads/".length));
  }
  return result;
}

const running = listJsonKeys(path.join(root, "chunks/running"));
for (const key of listJsonKeys(path.join(root, "seeds/running"))) running.add(key);
const worktrees = gitWorktrees();
const candidates: Candidate[] = [];
const retained: Candidate[] = [];

for (const group of ["tasks", "integration", "inspect"]) {
  for (const dir of listDirs(path.join(root, "worktrees", group))) {
    const name = path.basename(dir);
    const issueKey = issueKeyFromName(name);
    const resolved = path.resolve(dir);
    const branch = worktrees.get(resolved);
    const registered = worktrees.has(resolved);
    const entry: Candidate = {
      kind: `worktree/${group}`,
      path: dir,
      issueKey,
      registered,
      branch,
      bytes: dirSizeBytes(dir),
      reason: registered ? "registered git worktree" : "unregistered directory",
    };
    if (issueKey && running.has(issueKey)) {
      retained.push({ ...entry, reason: "issue is currently running" });
    } else {
      candidates.push({
        ...entry,
        reason: registered
          ? "registered worktree for issue that is not running"
          : "unregistered worktree directory for issue that is not running",
      });
    }
  }
}

const branchPrefix = `autofhir/${sanitizeId(runId)}/`;
const branches = runCommand(["git", "branch", "--format=%(refname:short)"], { cwd: run.fhirRepo, allowFailure: true })
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith(branchPrefix));
const removableBranches = branches.filter((branch) => {
  const issueKey = issueKeyFromName(branch);
  return !issueKey || !running.has(issueKey);
});

if (includeAgentLogs) {
  for (const dir of listDirs(path.join(root, "copilot-logs"))) {
    const issueKey = issueKeyFromName(path.basename(dir));
    const entry: Candidate = {
      kind: "agent/copilot-logs",
      path: dir,
      issueKey,
      bytes: dirSizeBytes(dir),
      reason: "per-worker Copilot execution logs",
    };
    if (issueKey && running.has(issueKey)) retained.push({ ...entry, reason: "issue is currently running" });
    else candidates.push(entry);
  }

  for (const group of ["stdout", "stderr"]) {
    const dir = path.join(root, group);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const fullPath = path.join(dir, file);
      try {
        if (!statSync(fullPath).isFile()) continue;
      } catch {
        continue;
      }
      const issueKey = issueKeyFromName(file);
      const entry: Candidate = {
        kind: `agent/${group}`,
        path: fullPath,
        issueKey,
        bytes: dirSizeBytes(fullPath),
        reason: `per-worker ${group} stream`,
      };
      if (issueKey && running.has(issueKey)) retained.push({ ...entry, reason: "issue is currently running" });
      else candidates.push(entry);
    }
  }
}

for (const dir of listDirs(tmpdir())) {
  const name = path.basename(dir);
  if (!name.startsWith("autofhir-review-publish-")) continue;
  candidates.push({
    kind: "tmp/publish",
    path: dir,
    bytes: dirSizeBytes(dir),
    reason: "temporary review publish checkout",
  });
}

let reclaimed = 0;
for (const candidate of candidates) {
  reclaimed += candidate.bytes;
  const label = apply ? "remove" : "would_remove";
  console.log(`${label} kind=${candidate.kind} size=${formatBytes(candidate.bytes)} path=${candidate.path} reason=${candidate.reason}`);
  if (!apply) continue;
  if (candidate.registered) {
    runCommand(["git", "worktree", "remove", "-f", candidate.path], { cwd: run.fhirRepo, allowFailure: true });
  }
  rmSync(candidate.path, { recursive: true, force: true });
}

for (const branch of removableBranches) {
  const label = apply ? "delete_branch" : "would_delete_branch";
  console.log(`${label} ${branch}`);
  if (apply) runCommand(["git", "branch", "-D", branch], { cwd: run.fhirRepo, allowFailure: true });
}

runCommand(["git", "worktree", "prune"], { cwd: run.fhirRepo, allowFailure: true });

const retainedBytes = retained.reduce((sum, item) => sum + item.bytes, 0);
console.log(`summary mode=${apply ? "apply" : "dry-run"} candidates=${candidates.length} reclaimable=${formatBytes(reclaimed)} retained_active=${retained.length} retained_active_size=${formatBytes(retainedBytes)} branches=${removableBranches.length}`);
if (!apply) console.log("pass --apply to remove the candidates above");
