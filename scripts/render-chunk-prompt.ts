#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ChunkManifest, autofhirRoot, readJson, readRun, repoRoot, runPath } from "./lib";

const wgNames: Record<string, string> = {
  "brr": "Biomedical Research and Regulation",
  "cbcc": "Community Based Collaborative Care",
  "cds": "Clinical Decision Support",
  "cg": "Clinical Genomics",
  "cqi": "Clinical Quality Information",
  "dev": "Health Care Devices",
  "fhir-i": "FHIR Infrastructure",
  "fm": "Financial Management",
  "ii": "Imaging Integration",
  "inm": "Infrastructure and Messaging",
  "oo": "Orders and Observations",
  "pa": "Patient Administration",
  "pc": "Patient Care",
  "pher": "Public Health",
  "phx": "Pharmacy",
  "sd": "Structured Documents",
  "sec": "Security",
  "vocab": "Vocabulary",
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function list(values: string[] | undefined): string {
  const clean = [...new Set(values ?? [])].filter(Boolean).sort();
  return clean.length ? clean.map((value) => `\`${value}\``).join(", ") : "(none)";
}

function pipelineBody(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.startsWith("# ")) lines.shift();
  if (lines[0] === "") lines.shift();
  return lines
    .filter((line) => !line.startsWith("If you are an analysis agent:"))
    .filter((line) => !line.startsWith("If you are implementing dispatcher behavior:"))
    .join("\n")
    .trim();
}

function communitySearchBody(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.startsWith("# ")) lines.shift();
  if (lines[0] === "") lines.shift();

  const withoutSetup: string[] = [];
  let skippingSetup = false;
  for (const line of lines) {
    if (line.startsWith("## Setup")) {
      skippingSetup = true;
      continue;
    }
    if (skippingSetup && line.startsWith("## ")) {
      skippingSetup = false;
    }
    if (!skippingSetup) withoutSetup.push(line);
  }

  return withoutSetup.join("\n").trim();
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function sourceSnapshotMaxBytes(): number {
  const raw = process.env.SOURCE_SNAPSHOT_MAX_BYTES;
  if (!raw) return 500_000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("SOURCE_SNAPSHOT_MAX_BYTES must be a non-negative number");
  return value;
}

function sourceFilesForPath(specRoot: string, sourcePath: string): string[] {
  const absolute = path.resolve(specRoot, sourcePath);
  const root = path.resolve(specRoot);
  if (!absolute.startsWith(root + path.sep) && absolute !== root) {
    throw new Error(`source path escapes spec checkout: ${sourcePath}`);
  }
  if (!existsSync(absolute)) return [sourcePath];
  const stat = statSync(absolute);
  if (stat.isFile()) return [sourcePath];
  if (!stat.isDirectory()) return [sourcePath];

  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = path.join(dir, entry);
      const childStat = statSync(abs);
      if (childStat.isDirectory()) {
        visit(abs);
      } else if (childStat.isFile()) {
        files.push(path.relative(root, abs));
      }
    }
  };
  visit(absolute);
  return files.sort();
}

function sourceSnapshotBody(specRoot: string, sourcePaths: string[] | undefined): string {
  const paths = [...new Set((sourcePaths ?? []).filter(Boolean).flatMap((sourcePath) => sourceFilesForPath(specRoot, sourcePath)))].sort();
  if (paths.length === 0) return "<source_files none=\"true\" />";

  const maxBytes = sourceSnapshotMaxBytes();
  let usedBytes = 0;

  return paths.map((sourcePath) => {
    const absolute = path.resolve(specRoot, sourcePath);
    if (!absolute.startsWith(path.resolve(specRoot) + path.sep) && absolute !== path.resolve(specRoot)) {
      throw new Error(`source path escapes spec checkout: ${sourcePath}`);
    }
    if (!existsSync(absolute)) {
      return `<source_file path="${escapeAttr(sourcePath)}" missing="true" />`;
    }
    const stat = statSync(absolute);
    if (!stat.isFile()) {
      return `<source_file path="${escapeAttr(sourcePath)}" unsupported_file_type="true" />`;
    }
    const bytes = readFileSync(absolute);
    if (looksBinary(bytes)) {
      return `<source_file path="${escapeAttr(sourcePath)}" binary="true">Binary file omitted from prompt snapshot. Inspect it directly in the FHIR spec checkout if needed.</source_file>`;
    }
    if (usedBytes + bytes.length > maxBytes) {
      return `<source_file path="${escapeAttr(sourcePath)}" omitted_due_to_prompt_budget="true" bytes="${bytes.length}">Source text omitted from prompt snapshot because the chunk exceeded SOURCE_SNAPSHOT_MAX_BYTES=${maxBytes}. Inspect this file directly in the FHIR spec checkout when needed.</source_file>`;
    }
    usedBytes += bytes.length;
    const text = bytes.toString("utf8");
    return [
      `<source_file path="${escapeAttr(sourcePath)}">`,
      text,
      `</source_file>`,
    ].join("\n");
  }).join("\n\n");
}

export function renderChunkPrompt(options: {
  runId: string;
  chunkId: string;
  selectionPath: string;
  force?: boolean;
}): string {
  const run = readRun(options.runId);
  const selection = readJson<ChunkManifest>(options.selectionPath);
  const chunkId = options.chunkId || selection.chunkId;
  if (selection.chunkId && selection.chunkId !== chunkId) {
    throw new Error(`selection chunkId ${selection.chunkId} does not match --chunk-id ${chunkId}`);
  }

  const templatePath = path.join(autofhirRoot, "discovery/chunk-agent-prompt.template.md");
  const pipelinePath = path.join(autofhirRoot, "discovery/analysis-pipeline.md");
  const communitySearchPath = path.join(repoRoot, "SKILL.md");
  const template = readFileSync(templatePath, "utf8");
  const body = pipelineBody(readFileSync(pipelinePath, "utf8"));
  const searchGuide = communitySearchBody(readFileSync(communitySearchPath, "utf8"));
  const specRoot = run.fhirRepo ?? "/home/jmandel/work/fhir";
  const sourceSnapshot = sourceSnapshotBody(specRoot, selection.sourcePaths);
  const snapshotMaxBytes = String(sourceSnapshotMaxBytes());

  const chunkDir = path.join(runPath(options.runId), "chunks", chunkId);
  const promptPath = path.join(chunkDir, "prompt.md");
  if (existsSync(promptPath) && !options.force) {
    throw new Error(`prompt already exists: ${promptPath}. Pass --force to overwrite.`);
  }
  mkdirSync(chunkDir, { recursive: true });

  const specCommit = selection.specCommit ?? run.baseSha ?? "(unknown)";
  const replacements: Record<string, string> = {
    RUN_ID: options.runId,
    CHUNK_ID: chunkId,
    CHUNK_DIR: chunkDir,
    PROMPT_PATH: promptPath,
    CHUNK_NAME: selection.title ?? chunkId,
    WG: selection.wg ?? "(unknown)",
    WG_NAME: wgNames[selection.wg ?? ""] ?? selection.wg ?? "(unknown)",
    SOURCE_PATHS: list(selection.sourcePaths),
    CUTOFF_DATE: selection.cutoffDate ?? "2018-12-27",
    SPEC_REFERENCE: selection.specReference ?? "current",
    SPEC_CHECKOUT_ROOT: specRoot,
    SPEC_COMMIT_PINNED: specCommit,
    SOURCE_SNAPSHOT_MAX_BYTES: snapshotMaxBytes,
    SOURCE_SNAPSHOT_BODY: sourceSnapshot,
    PIPELINE_BODY: body,
    COMMUNITY_SEARCH_BODY: searchGuide,
  };

  const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => replacements[key] ?? match);
  const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (unresolved) throw new Error(`unresolved placeholders in rendered prompt: ${[...new Set(unresolved)].join(", ")}`);

  writeFileSync(promptPath, rendered.endsWith("\n") ? rendered : `${rendered}\n`);
  return promptPath;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`Usage: bun autofhir/scripts/render-chunk-prompt.ts --run-id ID --chunk-id CHUNK_ID --selection path/to/selection.json [--force]

Renders one self-contained discovery chunk prompt to:
  autofhir/runs/<run-id>/chunks/<chunk-id>/prompt.md

The renderer inlines autofhir/discovery/analysis-pipeline.md into the thin
autofhir/discovery/chunk-agent-prompt.template.md wrapper, and also inlines the
operational command guide from the repository root SKILL.md.`);
    process.exit(0);
  }

  const runId = arg("--run-id") ?? process.env.RUN_ID;
  const chunkId = arg("--chunk-id") ?? arg("--chunk") ?? process.env.CHUNK_ID;
  const selectionPath = arg("--selection");
  if (!runId) throw new Error("--run-id or RUN_ID is required");
  if (!chunkId) throw new Error("--chunk-id or CHUNK_ID is required");
  if (!selectionPath) throw new Error("--selection is required");

  const promptPath = renderChunkPrompt({
    runId,
    chunkId,
    selectionPath: path.resolve(repoRoot, selectionPath),
    force: process.argv.includes("--force"),
  });
  console.log(promptPath);
}
