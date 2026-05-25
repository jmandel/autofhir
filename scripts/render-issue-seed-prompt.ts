#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { autofhirRoot, readJson, readRun, repoRoot, runCommand, runPath } from "./lib";

type CandidateIssue = {
  key: string;
  summary: string;
  status: string;
  resolution?: string;
  status_category?: string;
  work_groups: string[];
  related_pages: string[];
  related_artifacts: string[];
  updated_at: string;
  partition_id: string;
};

type SeedManifest = {
  run_id: string;
  seed_key: string;
  partition_id: string;
  cutoff_date?: string;
  spec_commit?: string;
  candidate: CandidateIssue;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function stripH1(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.startsWith("# ")) lines.shift();
  if (lines[0] === "") lines.shift();
  return lines.join("\n").trim();
}

function communitySearchBody(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.startsWith("# ")) lines.shift();
  if (lines[0] === "") lines.shift();

  const kept: string[] = [];
  let skippingSetup = false;
  for (const line of lines) {
    if (line.startsWith("## Setup")) {
      skippingSetup = true;
      continue;
    }
    if (skippingSetup && line.startsWith("## ")) skippingSetup = false;
    if (!skippingSetup) kept.push(line);
  }
  return kept.join("\n").trim();
}

function escapeXmlText(value: string): string {
  return value.replaceAll("</seed_jira_snapshot>", "<\\/seed_jira_snapshot>");
}

export function renderIssueSeedPrompt(options: {
  runId: string;
  seedKey: string;
  seedPath: string;
  force?: boolean;
}): string {
  const run = readRun(options.runId);
  const seed = readJson<SeedManifest>(options.seedPath);
  if (seed.seed_key !== options.seedKey) throw new Error(`seed file is ${seed.seed_key}, expected ${options.seedKey}`);

  const seedDir = path.join(runPath(options.runId), "seed-runs", options.seedKey);
  const promptPath = path.join(seedDir, "prompt.md");
  const outputPath = path.join(seedDir, "result.json");
  if (existsSync(promptPath) && !options.force) {
    throw new Error(`prompt already exists: ${promptPath}. Pass --force to overwrite.`);
  }
  mkdirSync(seedDir, { recursive: true });

  const template = readFileSync(path.join(autofhirRoot, "issue-mapping/seed-agent-prompt.template.md"), "utf8");
  const pipelineBody = stripH1(readFileSync(path.join(autofhirRoot, "issue-mapping/issue-mapping-pipeline.md"), "utf8"));
  const searchGuide = communitySearchBody(readFileSync(path.join(repoRoot, "SKILL.md"), "utf8"));
  const snapshot = runCommand(["bun", "jira/search.ts", "snapshot", options.seedKey], { cwd: repoRoot, allowFailure: true }).trim();

  const replacements: Record<string, string> = {
    REPO_ROOT: repoRoot,
    SPEC_CHECKOUT_ROOT: run.fhirRepo ?? "/home/jmandel/work/fhir",
    SPEC_COMMIT_PINNED: seed.spec_commit ?? run.baseSha ?? "(unknown)",
    RUN_ID: options.runId,
    SEED_KEY: options.seedKey,
    SEED_DIR: seedDir,
    OUTPUT_PATH: outputPath,
    PROMPT_PATH: promptPath,
    CUTOFF_DATE: seed.cutoff_date ?? "2018-12-27",
    SEED_JIRA_SNAPSHOT: escapeXmlText(snapshot || `Snapshot command returned no content for ${options.seedKey}. Run bun jira/search.ts snapshot ${options.seedKey}.`),
    PIPELINE_BODY: pipelineBody,
    COMMUNITY_SEARCH_BODY: searchGuide,
  };

  const rendered = template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (match, key) => replacements[key] ?? match);
  const missingTemplatePlaceholders = Object.keys(replacements)
    .filter((key) => template.includes(`{{${key}}}`) && rendered.includes(`{{${key}}}`));
  if (missingTemplatePlaceholders.length > 0) {
    throw new Error(`unresolved template placeholders in rendered prompt: ${missingTemplatePlaceholders.join(", ")}`);
  }

  writeFileSync(promptPath, rendered.endsWith("\n") ? rendered : `${rendered}\n`);
  return promptPath;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`Usage: bun autofhir/scripts/render-issue-seed-prompt.ts --run-id ID --seed-key FHIR-XXXXX --seed path/to/seed.json [--force]`);
    process.exit(0);
  }
  const runId = arg("--run-id") ?? process.env.RUN_ID;
  const seedKey = arg("--seed-key") ?? arg("--seed") ?? process.env.SEED_KEY;
  const seedPath = arg("--seed-file") ?? arg("--selection");
  if (!runId) throw new Error("--run-id or RUN_ID is required");
  if (!seedKey) throw new Error("--seed-key or SEED_KEY is required");
  if (!seedPath) throw new Error("--seed-file/--selection is required");

  const promptPath = renderIssueSeedPrompt({
    runId,
    seedKey,
    seedPath: path.resolve(repoRoot, seedPath),
    force: process.argv.includes("--force"),
  });
  console.log(promptPath);
}
