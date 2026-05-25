#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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
  console.log(`Usage: bun autofhir/scripts/publish-issue-fixup-review.ts --run-id ID [--skip-export] [--skip-fhir-branch] [--skip-pages] [--configure-pages]

Publishes the issue-fixup review snapshot for a run to jmandel/autofhir:
  - pushes the FHIR reconciliation branch to refs/heads/<run-id>
  - pushes raw review artifacts to refs/heads/review-<run-id>/<run-id>/
  - pushes the rendered review app to refs/heads/gh-pages/<run-id>/

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

function requireFile(file: string): void {
  if (!existsSync(file)) throw new Error(`missing required review artifact: ${file}`);
}

function copyReviewArtifacts(destRoot: string, includeRootIndex: boolean): void {
  const dest = path.join(destRoot, runId);
  mkdirSync(dest, { recursive: true });
  for (const name of [
    "index.html",
    "issue-fixup-diff-viewer.html",
    "issue-fixup-diff-report.json",
    "issue-fixup-diff-report.json.gz",
    "review-app.js",
    "review-app.css",
  ]) {
    const source = path.join(reviewDir, name);
    requireFile(source);
    copyFileSync(source, path.join(dest, name));
  }
  const sourceIssueMapping = path.join(reviewDir, "source-issue-mapping-report.json.gz");
  if (existsSync(sourceIssueMapping)) {
    copyFileSync(sourceIssueMapping, path.join(dest, "source-issue-mapping-report.json.gz"));
  }
  writeFileSync(path.join(destRoot, ".nojekyll"), "");
  if (includeRootIndex) {
    writeFileSync(
      path.join(destRoot, "index.html"),
      [
        "<!doctype html>",
        '<meta charset="utf-8">',
        "<title>AutoFHIR Review Apps</title>",
        "<h1>AutoFHIR Review Apps</h1>",
        `<ul><li><a href="${runId}/">${runId}</a></li></ul>`,
        "",
      ].join("\n"),
    );
  }
}

function publishArtifactBranch(branch: string, includeRootIndex: boolean): void {
  const tmp = mkdtempSync(path.join(tmpdir(), "autofhir-review-publish-"));
  try {
    copyReviewArtifacts(tmp, includeRootIndex);
    runCommand(["git", "init", "-b", branch], { cwd: tmp });
    runCommand(["git", "config", "user.name", "AutoFHIR"], { cwd: tmp });
    runCommand(["git", "config", "user.email", "autofhir@example.invalid"], { cwd: tmp });
    runCommand(["git", "add", "."], { cwd: tmp });
    runCommand(["git", "commit", "-m", `Publish ${runId} review artifacts`], { cwd: tmp });
    runCommand(["git", "remote", "add", "origin", repoUrl], { cwd: tmp });
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
    runCommand(["bun", "autofhir/scripts/export-issue-fixup-diff-viewer.ts", "--run-id", runId], { cwd: repoRoot });
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
