#!/usr/bin/env bun

import { existsSync } from "node:fs";
import path from "node:path";
import { repoRoot, runCommand } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): string {
  return `Usage: bun autofhir/scripts/deploy-review-pages-site.ts [--registry review-runs.json] [--wait]

Dispatches the main-branch Deploy Review Site workflow. The workflow builds the
site from review-runs.json plus the configured artifact branches, uploads a
GitHub Pages artifact, and deploys it. No gh-pages or staging branch is used.`;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}

const githubRepo = "jmandel/autofhir";
const workflowName = "Deploy Review Site";
const registry = arg("--registry") ?? "review-runs.json";
if (!existsSync(path.resolve(registry))) throw new Error(`registry not found: ${registry}`);
const wait = flag("--wait");
const before = new Date(Date.now() - 5000).toISOString();

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
  `registry=${registry}`,
], { cwd: repoRoot });

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
}

console.log("pages_url=https://joshuamandel.com/autofhir/");
