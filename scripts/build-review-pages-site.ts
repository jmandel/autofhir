#!/usr/bin/env bun

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runsRoot } from "./lib";

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

function usage(): string {
  return `Usage: bun autofhir/scripts/build-review-pages-site.ts --out-dir DIR [--run-id ID ...]

Builds one self-contained GitHub Pages site directory from local review exports.
Each selected run must already have autofhir/runs/<run-id>/review/index.html.
If --run-id is omitted, all local runs with review/index.html are included.`;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(usage());
  process.exit(0);
}

const outDir = arg("--out-dir");
if (!outDir) throw new Error("--out-dir is required");

const explicitRunIds = args("--run-id");
const runIds = explicitRunIds.length ? explicitRunIds : readdirSync(runsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(runsRoot, entry.name, "review", "index.html")))
  .map((entry) => entry.name)
  .sort();

if (!runIds.length) throw new Error("no review runs found");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, ".nojekyll"), "");

const warnings: string[] = [];
for (const runId of runIds) {
  const reviewDir = path.join(runsRoot, runId, "review");
  const indexPath = path.join(reviewDir, "index.html");
  if (!existsSync(indexPath)) throw new Error(`missing review index for ${runId}: ${indexPath}`);
  const html = readFileSync(indexPath, "utf8");
  if (html.includes("raw.githubusercontent.com")) {
    warnings.push(`${runId}: index.html still points at raw.githubusercontent.com; re-export with --self-contained-pages to avoid runtime artifact branches`);
  }
  const dest = path.join(outDir, runId);
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
    const source = path.join(reviewDir, name);
    if (existsSync(source)) copyFileSync(source, path.join(dest, name));
  }
  const patches = path.join(reviewDir, "patches");
  if (existsSync(patches)) cpSync(patches, path.join(dest, "patches"), { recursive: true });
}

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

for (const warning of warnings) console.warn(`warning: ${warning}`);
console.log(`site=${outDir}`);
console.log(`runs=${runIds.join(",")}`);
