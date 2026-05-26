#!/usr/bin/env bun

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { readRun, repoRoot, runCommand, runPath } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

if (flag("-h") || flag("--help")) {
  console.log(`Usage: bun autofhir/scripts/publish-issue-fixup-review.ts --run-id ID [--source-run-id FIXUP_RUN_ID] [--skip-export] [--skip-fhir-branch] [--skip-pages] [--configure-pages]

Publishes the issue-fixup review snapshot for a run to jmandel/autofhir:
  - pushes the FHIR reconciliation branch to refs/heads/<run-id>
  - pushes raw review artifacts to refs/heads/review-<run-id>/<run-id>/
  - pushes the rendered review app to refs/heads/gh-pages/<run-id>/

For issue-fixup-audit runs, --source-run-id is the original issue-fixup run.
If omitted, the script infers it from audit chunks.
Run export-issue-fixup-diff-viewer.ts first unless --skip-export is passed.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const githubRepo = "jmandel/autofhir";
const repoUrl = `https://github.com/${githubRepo}.git`;
const run = readRun(runId);
const root = runPath(runId);
const reviewDir = path.join(root, "review");
const reviewBranch = `review-${runId}`;
const fhirBranch = runId;
const pagesBranch = "gh-pages";
const exportLock = "/tmp/autofhir-review-export.lock";
const sourceRunId = arg("--source-run-id") ?? process.env.SOURCE_RUN_ID ?? inferSourceIssueFixupRunId();

function inferSourceIssueFixupRunId(): string | undefined {
  if (run.workflow !== "issue-fixup-audit") return undefined;
  const fromManifest = (run as any).sourceIssueFixupRunId;
  if (typeof fromManifest === "string" && fromManifest) return fromManifest;
  const chunksRoot = path.join(root, "chunks");
  for (const state of ["done", "pending", "failed", "running", "skipped"]) {
    const dir = path.join(chunksRoot, state);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const chunk = JSON.parse(readFileSync(path.join(dir, entry), "utf8"));
        if (typeof chunk.sourceRunId === "string" && chunk.sourceRunId) return chunk.sourceRunId;
      } catch {
        // Keep looking; a malformed chunk should not block publishing if another chunk has the source id.
      }
    }
  }
  return undefined;
}

function requireFile(file: string): void {
  if (!existsSync(file)) throw new Error(`missing required review artifact: ${file}`);
}

function copyReviewArtifacts(destRoot: string, includeRootIndex: boolean): void {
  const dest = path.join(destRoot, runId);
  mkdirSync(dest, { recursive: true });
  const requiredNames = [
    "index.html",
    "issue-fixup-diff-viewer.html",
    "issue-fixup-diff-report.json",
    "review-app.js",
    "review-app.css",
  ];
  const rawArtifactOnlyNames = [
    "issue-fixup-diff-report.json.gz",
    "issue-fixup-diff-report-full.json.gz",
  ];
  for (const name of includeRootIndex ? requiredNames : [...requiredNames, ...rawArtifactOnlyNames]) {
    const source = path.join(reviewDir, name);
    requireFile(source);
    copyFileSync(source, path.join(dest, name));
  }
  if (!includeRootIndex) {
    const sourceIssueMapping = path.join(reviewDir, "source-issue-mapping-report.json.gz");
    if (existsSync(sourceIssueMapping)) {
      copyFileSync(sourceIssueMapping, path.join(dest, "source-issue-mapping-report.json.gz"));
    }
    const sourceIssueFixupReview = path.join(reviewDir, "source-issue-fixup-review-report.json.gz");
    if (existsSync(sourceIssueFixupReview)) {
      copyFileSync(sourceIssueFixupReview, path.join(dest, "source-issue-fixup-review-report.json.gz"));
    }
    const patchDir = path.join(reviewDir, "patches");
    if (existsSync(patchDir)) {
      cpSync(patchDir, path.join(dest, "patches"), { recursive: true });
    }
  }
  writeFileSync(path.join(destRoot, ".nojekyll"), "");
  if (includeRootIndex) {
    const runDirs = readdirSync(destRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(destRoot, entry.name, "index.html")))
      .map((entry) => entry.name)
      .sort();
    writeFileSync(path.join(destRoot, "index.html"), [
      "<!doctype html>",
      '<meta charset="utf-8">',
      "<title>AutoFHIR Review Apps</title>",
      "<h1>AutoFHIR Review Apps</h1>",
      "<ul>",
      ...runDirs.map((name) => `<li><a href="${name}/">${name}</a></li>`),
      "</ul>",
      "",
    ].join("\n"));
  }
}

function publishArtifactBranch(branch: string, includeRootIndex: boolean): void {
  const tmp = mkdtempSync(path.join(tmpdir(), "autofhir-review-publish-"));
  try {
    runCommand(["git", "init"], { cwd: tmp });
    runCommand(["git", "config", "user.name", "AutoFHIR"], { cwd: tmp });
    runCommand(["git", "config", "user.email", "autofhir@example.invalid"], { cwd: tmp });
    runCommand(["git", "remote", "add", "origin", repoUrl], { cwd: tmp });
    const remoteRef = `refs/heads/${branch}`;
    const remoteSha = runCommand(["git", "ls-remote", repoUrl, remoteRef], { cwd: tmp, allowFailure: true }).trim().split(/\s+/)[0];
    if (remoteSha) {
      runCommand(["git", "fetch", "--depth=1", "origin", remoteRef], { cwd: tmp });
      runCommand(["git", "checkout", "-B", branch, "FETCH_HEAD"], { cwd: tmp });
    } else {
      runCommand(["git", "checkout", "-B", branch], { cwd: tmp });
    }
    rmSync(path.join(tmp, runId), { recursive: true, force: true });
    copyReviewArtifacts(tmp, includeRootIndex);
    runCommand(["git", "add", "."], { cwd: tmp });
    if (runCommand(["git", "diff", "--cached", "--quiet"], { cwd: tmp, allowFailure: true }) === "" && remoteSha) {
      const status = runCommand(["git", "diff", "--cached", "--name-only"], { cwd: tmp, allowFailure: true }).trim();
      if (!status) {
        console.log(`${branch}=unchanged`);
        return;
      }
    }
    runCommand(["git", "commit", "-m", `Publish ${runId} review artifacts`], { cwd: tmp });
    runCommand(["git", "push", "--force", "origin", `HEAD:refs/heads/${branch}`], { cwd: tmp });
    console.log(`${branch}=published`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (!flag("--skip-export")) {
  while (true) {
    try {
      mkdirSync(exportLock);
      break;
    } catch {
      console.log("waiting_for_export_lock");
      Bun.sleepSync(5000);
    }
  }
  try {
    const exportArgs = ["bun", "autofhir/scripts/export-issue-fixup-diff-viewer.ts"];
    if (run.workflow === "issue-fixup-audit") {
      if (!sourceRunId) throw new Error("issue-fixup-audit publish requires --source-run-id or audit chunks with sourceRunId");
      exportArgs.push("--run-id", sourceRunId, "--audit-run-id", runId);
    } else {
      exportArgs.push("--run-id", runId);
    }
    runCommand(exportArgs, { cwd: repoRoot });
  } finally {
    try {
      rmdirSync(exportLock);
    } catch {
      // Best-effort cleanup.
    }
  }
}

if (!flag("--skip-fhir-branch")) {
  if (!run.fhirRepo || !run.combinedBranch) throw new Error("run has no fhirRepo/combinedBranch to publish");
  const remoteRef = `refs/heads/${fhirBranch}`;
  const remoteSha = runCommand(["git", "ls-remote", repoUrl, remoteRef], { cwd: run.fhirRepo, allowFailure: true }).trim().split(/\s+/)[0];
  const leaseArgs = remoteSha ? [`--force-with-lease=${remoteRef}:${remoteSha}`] : [];
  runCommand([
    "git",
    "push",
    ...leaseArgs,
    repoUrl,
    `refs/heads/${run.combinedBranch}:${remoteRef}`,
  ], { cwd: run.fhirRepo });
  console.log(`fhir_branch=https://github.com/${githubRepo}/tree/${fhirBranch}`);
}

publishArtifactBranch(reviewBranch, false);

if (!flag("--skip-pages")) {
  publishArtifactBranch(pagesBranch, true);
  console.log(`pages_url=https://jmandel.github.io/autofhir/${runId}/`);
}

if (flag("--configure-pages")) {
  const payload = JSON.stringify({ source: { branch: pagesBranch, path: "/" } });
  const existing = runCommand(["gh", "api", `repos/${githubRepo}/pages`], { allowFailure: true }).trim();
  const method = existing ? "PUT" : "POST";
  if (existing) {
    runCommand(["bash", "-lc", `printf %s ${shQuote(payload)} | gh api --method ${method} repos/${githubRepo}/pages --input -`], { cwd: repoRoot });
  } else {
    runCommand(["bash", "-lc", `printf %s ${shQuote(payload)} | gh api --method ${method} repos/${githubRepo}/pages --input -`], { cwd: repoRoot });
  }
  console.log(`pages_source=${pagesBranch}/`);
}
