#!/usr/bin/env bun

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { repoRoot, runCommand } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): string {
  return `Usage: bun autofhir/scripts/deploy-review-pages-site.ts --site-dir DIR [--staging-branch BRANCH] [--wait] [--delete-staging-branch]

Pushes a complete static review site to a staging branch, switches GitHub Pages
to Actions-based deployment, and dispatches the Deploy Review Site workflow.
The live Pages site is deployed from the workflow artifact, not from the
staging branch. If --wait and --delete-staging-branch are both set, the staging
branch is deleted after the workflow completes successfully.`;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}

const siteDir = path.resolve(arg("--site-dir") ?? "");
if (!siteDir || !existsSync(path.join(siteDir, "index.html"))) throw new Error("--site-dir must point at a built review site containing index.html");

const githubRepo = "jmandel/autofhir";
const repoUrl = `https://github.com/${githubRepo}.git`;
const workflowName = "Deploy Review Site";
const stagingBranch = arg("--staging-branch") ?? "pages-artifact-staging";
const wait = flag("--wait");
const deleteStagingBranch = flag("--delete-staging-branch");
const before = new Date(Date.now() - 5000).toISOString();

const tmp = mkdtempSync(path.join(tmpdir(), "autofhir-pages-artifact-"));
try {
  runCommand(["git", "init"], { cwd: tmp });
  runCommand(["git", "config", "user.name", "AutoFHIR"], { cwd: tmp });
  runCommand(["git", "config", "user.email", "autofhir@example.invalid"], { cwd: tmp });
  runCommand(["git", "remote", "add", "origin", repoUrl], { cwd: tmp });
  runCommand(["git", "checkout", "-B", stagingBranch], { cwd: tmp });
  cpSync(siteDir, tmp, { recursive: true });
  runCommand(["git", "add", "."], { cwd: tmp });
  runCommand(["git", "commit", "-m", "Stage AutoFHIR review Pages artifact"], { cwd: tmp });
  runCommand(["git", "push", "--force", "origin", `HEAD:refs/heads/${stagingBranch}`], { cwd: tmp });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

runCommand(["gh", "api", "--method", "PUT", `repos/${githubRepo}/pages`, "-f", "build_type=workflow"], { cwd: repoRoot });
runCommand([
  "gh",
  "workflow",
  "run",
  "review-app.yml",
  "--repo",
  githubRepo,
  "--ref",
  "main",
  "-f",
  `site_ref=${stagingBranch}`,
  "-f",
  "site_path=.",
], { cwd: repoRoot });

console.log(`staging_branch=${stagingBranch}`);
console.log("pages_source=workflow");

if (wait) {
  let runId = "";
  for (let attempt = 0; attempt < 30 && !runId; attempt += 1) {
    const runs = JSON.parse(runCommand([
      "gh",
      "run",
      "list",
      "--repo",
      githubRepo,
      "--workflow",
      workflowName,
      "--event",
      "workflow_dispatch",
      "--limit",
      "10",
      "--json",
      "databaseId,createdAt,status,headBranch",
    ], { cwd: repoRoot })) as { databaseId: number; createdAt: string; status: string; headBranch: string }[];
    const match = runs
      .filter((run) => run.headBranch === "main" && run.createdAt >= before)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (match) runId = String(match.databaseId);
    else Bun.sleepSync(2000);
  }
  if (!runId) throw new Error("could not find dispatched Pages workflow run");
  console.log(`workflow_run=${runId}`);
  runCommand(["gh", "run", "watch", runId, "--repo", githubRepo, "--exit-status"], { cwd: repoRoot });
  if (deleteStagingBranch) {
    runCommand(["git", "push", repoUrl, `:refs/heads/${stagingBranch}`], { cwd: repoRoot });
    console.log(`deleted_staging_branch=${stagingBranch}`);
  }
}

console.log("pages_url=https://joshuamandel.com/autofhir/");
