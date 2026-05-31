#!/usr/bin/env bun

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { autofhirRoot, repoRoot, runsRoot } from "./lib";

type ReviewRun = {
  run_id: string;
  kind?: "issue-reconcile" | "issue-fixup" | "issue-fixup-audit" | string;
  source_branch?: string;
  artifact_branch?: string;
  artifact_path?: string;
};

type Registry = {
  schema_version?: string;
  github_repo?: string;
  pages_base_url?: string;
  runs?: ReviewRun[];
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function args(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1]);
  }
  return values;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(): string {
  return `Usage: bun autofhir/scripts/build-review-pages-site.ts --out-dir DIR [--run-id ID ...]
       bun autofhir/scripts/build-review-pages-site.ts --out-dir DIR --registry review-runs.json [--fetch-artifacts]

Builds a self-contained GitHub Pages site.

Local mode copies existing autofhir/runs/<run-id>/review exports.
Registry mode reads run metadata from main, optionally fetches each artifact
branch, rebuilds the current review app bundle from main, and assembles the
deployable site without a gh-pages or staging branch.`;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}

const outDir = arg("--out-dir");
if (!outDir) throw new Error("--out-dir is required");

const registryPath = arg("--registry");
const fetchArtifacts = flag("--fetch-artifacts");
const githubRepo = arg("--github-repo");
const pagesBaseUrl = arg("--pages-base-url");

function runCommand(command: string[], options: { cwd?: string; env?: Record<string, string>; allowFailure?: boolean } = {}): string {
  const proc = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 128,
  });
  if (proc.status !== 0 && !options.allowFailure) {
    throw new Error([
      `command failed: ${command.join(" ")}`,
      `cwd=${options.cwd ?? process.cwd()}`,
      `exit=${proc.status}`,
      proc.stdout?.trim(),
      proc.stderr?.trim(),
    ].filter(Boolean).join("\n"));
  }
  return proc.stdout ?? "";
}

function copyIfExists(source: string, dest: string): void {
  if (!existsSync(source)) return;
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(source, dest);
}

function copyDirIfExists(source: string, dest: string): void {
  if (!existsSync(source)) return;
  rmSync(dest, { recursive: true, force: true });
  cpSync(source, dest, { recursive: true });
}

function writeRootIndex(runIds: string[]): void {
  writeFileSync(path.join(outDir, "index.html"), [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<title>AutoFHIR Review Apps</title>",
    "<h1>AutoFHIR Review Apps</h1>",
    "<ul>",
    ...runIds.map((runId) => `<li><a href="${runId}/">${runId}</a></li>`),
    "</ul>",
    "",
  ].join("\n"));
}

function buildCurrentReviewApp(tmp: string): { js: string; css: string } {
  const js = path.join(tmp, "review-app.js");
  const css = path.join(tmp, "review-app.css");
  runCommand([
    "bun",
    "build",
    path.join(autofhirRoot, "web/review-app/src/main.tsx"),
    "--target=browser",
    "--production",
    "--outfile",
    js,
  ], { cwd: repoRoot });
  copyFileSync(path.join(autofhirRoot, "web/review-app/src/styles.css"), css);
  return { js, css };
}

function authCloneArgs(repo: string, branch: string, dest: string): string[] {
  const token = process.env.GITHUB_TOKEN;
  const args = ["git"];
  if (token) args.push("-c", `http.https://github.com/.extraheader=AUTHORIZATION: bearer ${token}`);
  args.push("clone", "--depth=1", "--branch", branch, `https://github.com/${repo}.git`, dest);
  return args;
}

function backfillReportLinks(reportPath: string, run: ReviewRun, repo: string, baseUrl: string): void {
  if (!existsSync(reportPath)) return;
  runCommand([
    "bun",
    path.join(autofhirRoot, "scripts/backfill-issue-reconcile-report-links.ts"),
    "--report",
    reportPath,
    "--run-id",
    run.run_id,
    "--github-repo",
    repo,
    "--pages-base-url",
    baseUrl,
  ], { cwd: repoRoot });
}

function copyReviewExport(reviewDir: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of [
    ".nojekyll",
    "index.html",
    "issue-fixup-diff-viewer.html",
    "review-app.js",
    "review-app.css",
    "issue-fixup-diff-report.json",
    "issue-fixup-diff-report.json.gz",
    "issue-fixup-diff-report-full.json.gz",
    "issue-reconcile-report.json",
    "issue-reconcile-report.json.gz",
    "source-issue-mapping-report.json.gz",
    "source-issue-fixup-review-report.json.gz",
  ]) {
    copyIfExists(path.join(reviewDir, name), path.join(dest, name));
  }
  copyDirIfExists(path.join(reviewDir, "patches"), path.join(dest, "patches"));
  copyDirIfExists(path.join(reviewDir, "details"), path.join(dest, "details"));
  copyDirIfExists(path.join(reviewDir, "messages"), path.join(dest, "messages"));
}

function buildFromLocalRuns(): string[] {
  const explicitRunIds = args("--run-id");
  const runIds = explicitRunIds.length ? explicitRunIds : readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(runsRoot, entry.name, "review", "index.html")))
    .map((entry) => entry.name)
    .sort();

  if (!runIds.length) throw new Error("no review runs found");
  for (const runId of runIds) {
    copyReviewExport(path.join(runsRoot, runId, "review"), path.join(outDir, runId));
  }
  return runIds;
}

function buildFromRegistry(file: string): string[] {
  const registry = JSON.parse(readFileSync(file, "utf8")) as Registry;
  const runs = registry.runs ?? [];
  if (!runs.length) throw new Error(`registry has no runs: ${file}`);
  const repo = githubRepo ?? registry.github_repo ?? "jmandel/autofhir";
  const baseUrl = pagesBaseUrl ?? registry.pages_base_url ?? "https://joshuamandel.com/autofhir/";
  const tmp = mkdtempSync(path.join(tmpdir(), "autofhir-pages-build-"));
  try {
    const app = buildCurrentReviewApp(tmp);
    for (const run of runs) {
      const artifactBranch = run.artifact_branch ?? `pages-${run.run_id}`;
      const artifactPath = run.artifact_path ?? run.run_id;
      const reviewDir = fetchArtifacts
        ? path.join(tmp, "branches", run.run_id, artifactPath)
        : path.join(runsRoot, run.run_id, "review");
      if (fetchArtifacts) {
        const checkout = path.join(tmp, "branches", run.run_id);
        runCommand(authCloneArgs(repo, artifactBranch, checkout));
        if (!existsSync(reviewDir)) throw new Error(`artifact branch ${artifactBranch} has no ${artifactPath}/ directory`);
      }

      const dest = path.join(outDir, run.run_id);
      copyReviewExport(reviewDir, dest);
      copyFileSync(app.js, path.join(dest, "review-app.js"));
      copyFileSync(app.css, path.join(dest, "review-app.css"));
      backfillReportLinks(path.join(dest, "issue-reconcile-report.json"), run, repo, baseUrl);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return runs.map((run) => run.run_id);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, ".nojekyll"), "");

const runIds = registryPath ? buildFromRegistry(path.resolve(registryPath)) : buildFromLocalRuns();
writeRootIndex(runIds);

console.log(`site=${outDir}`);
console.log(`runs=${runIds.join(",")}`);
