#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ChunkManifest,
  RunManifest,
  appendJournal,
  ensureRunDirs,
  repoRoot,
  runPath,
  runsRoot,
  sanitizeId,
  writeJson,
  writeRun,
} from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/prepare-abstractions-run.ts [--run-id ID] [--abstractions-dir DIR] [--description TEXT]

Creates one generic AutofHIR run chunk per abstraction JSON file. This is a
specific chunk-source adapter; the coordinator itself only knows runs/chunks.`);
  process.exit(0);
}

const now = new Date();
const defaultRunId = `abstractions-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
const runId = sanitizeId(arg("--run-id") ?? process.env.RUN_ID ?? defaultRunId);
const abstractionsDir = path.resolve(arg("--abstractions-dir") ?? process.env.ABSTRACTIONS_DIR ?? path.join(repoRoot, "r6htmlpages/todo/abstractions"));
const description = arg("--description") ?? process.env.RUN_DESCRIPTION ?? `Apply FHIR spec changes from abstraction reports in ${path.relative(repoRoot, abstractionsDir)}`;

if (!existsSync(abstractionsDir)) {
  throw new Error(`abstractions dir not found: ${abstractionsDir}`);
}
if (existsSync(runPath(runId))) {
  throw new Error(`run already exists: ${runId}`);
}

ensureRunDirs(runId);
mkdirSync(runsRoot, { recursive: true });

const abstractionFiles = readdirSync(abstractionsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

let chunkCount = 0;
let skippedNoFindings = 0;
function jiraIdsIn(value: unknown): string[] {
  return [...new Set(JSON.stringify(value).match(/\bFHIR-\d+\b/g) ?? [])].sort();
}

for (const file of abstractionFiles) {
  const fullPath = path.join(abstractionsDir, file);
  const data = JSON.parse(readFileSync(fullPath, "utf8"));
  const review = data.pageReviews?.[0];
  const pageLabel = review?.pageLabel ?? file.replace(/\.json$/, "");
  const chunkId = sanitizeId(pageLabel);
  const findings = review?.findings ?? [];
  const findingIds = findings.map((f: any) => f.id).filter(Boolean);
  const reportPath = path.join(runPath(runId), "reports", `${chunkId}.json`);
  copyFileSync(fullPath, reportPath);
  if (findings.length === 0 || findingIds.length === 0) {
    skippedNoFindings++;
    appendJournal(runId, {
      type: "chunk-not-created",
      chunkId,
      status: "no-findings",
      source: path.relative(repoRoot, reportPath),
      summary: "abstraction report has no findings",
    });
    continue;
  }
  const chunk: ChunkManifest = {
    schemaVersion: "1.0",
    runId,
    chunkId,
    title: `${pageLabel} abstraction change chunk`,
    sourceKind: "r6htmlpages-abstraction-json",
    changeChunkReportPath: path.relative(repoRoot, reportPath),
    pageLabel,
    actionFilePath: review?.actionFilePath,
    researchFilePath: review?.researchFilePath,
    findingCount: review?.findingCount ?? findings.length,
    findingIds,
    findings: findings.map((finding: any) => ({
      id: finding.id,
      title: finding.title,
      kind: finding.kind,
      priority: finding.priority,
      category: finding.category,
      status: finding.status,
      problem: finding.narrative?.problem,
      whyItMatters: finding.narrative?.whyItMatters,
      recommendedNextStep: finding.narrative?.recommendedNextStep,
      jiraIdsMentioned: jiraIdsIn(finding),
      sourceLocations: finding.sourceLocations,
    })).filter((finding: any) => finding.id),
  };
  writeJson(path.join(runPath(runId), "chunks/pending", `${chunkId}.json`), chunk);
  chunkCount++;
}

const run: RunManifest = {
  schemaVersion: "1.0",
  runId,
  createdAt: now.toISOString(),
  description,
  chunkSource: {
    kind: "r6htmlpages-abstractions-directory",
    path: path.relative(repoRoot, abstractionsDir),
  },
  chunkCount,
  combinedBranch: process.env.COMBINED_BRANCH ?? `robo-spec-combined-${runId}`,
  status: "prepared",
};
writeRun(run);
appendJournal(runId, { type: "run-prepared", chunkCount, skippedNoFindings, source: run.chunkSource });

console.log(`run_id=${runId}`);
console.log(`chunk_count=${chunkCount}`);
console.log(`skipped_no_findings=${skippedNoFindings}`);
console.log(`run_dir=${runPath(runId)}`);
