#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildScopeHints } from "./build-scope-hints";
import { autofhirRoot, readJson, readRun, repoRoot, runPath, sanitizeId } from "./lib";

type IssueFixupManifest = {
  runId: string;
  chunkId: string;
  issueKey: string;
  contextPath: string;
  sourcePaths?: string[];
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

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function evidenceBlock(attrs: Record<string, string>, body: string): string {
  const attrText = Object.entries(attrs).map(([key, value]) => `${key}="${escapeAttr(value)}"`).join(" ");
  return `<evidence ${attrText}>\n${body.trim() || "(empty snapshot)"}\n</evidence>`;
}

function readJiraSnapshots(contextDir: string): string {
  const dir = path.join(contextDir, "jira");
  if (!existsSync(dir)) return "(none)";
  const parts: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
    const key = path.basename(file, ".md");
    const fullPath = path.join(dir, file);
    parts.push(evidenceBlock({
      kind: "jira",
      command: `bun run jira:search snapshot ${key}`,
      file: path.relative(repoRoot, fullPath),
    }, readFileSync(fullPath, "utf8")));
  }
  return parts.length ? parts.join("\n\n") : "(none)";
}

function readZulipSnapshots(contextDir: string, context: any): string {
  const dir = path.join(contextDir, "zulip");
  if (!existsSync(dir)) return "(none)";
  const refs = new Map<string, { stream: string; topic: string }>();
  for (const ref of context.zulip_refs ?? []) {
    if (ref?.stream && ref?.topic) refs.set(sanitizeId(`${ref.stream}--${ref.topic}`), { stream: String(ref.stream), topic: String(ref.topic) });
  }
  const parts: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
    const id = path.basename(file, ".md");
    const ref = refs.get(id);
    const command = ref
      ? `bun run zulip:search snapshot ${shellQuote(ref.stream)} ${shellQuote(ref.topic)}`
      : `bun run zulip:search snapshot <stream> <topic> # cached file ${file}`;
    const fullPath = path.join(dir, file);
    parts.push(evidenceBlock({
      kind: "zulip",
      command,
      file: path.relative(repoRoot, fullPath),
    }, readFileSync(fullPath, "utf8")));
  }
  return parts.length ? parts.join("\n\n") : "(none)";
}

function readConfluenceSnapshots(contextDir: string): string {
  const dir = path.join(contextDir, "confluence");
  if (!existsSync(dir)) return "(none)";
  const parts: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
    const pageId = path.basename(file, ".md");
    const fullPath = path.join(dir, file);
    parts.push(evidenceBlock({
      kind: "confluence",
      command: `bun run confluence:search snapshot ${pageId}`,
      file: path.relative(repoRoot, fullPath),
    }, readFileSync(fullPath, "utf8")));
  }
  return parts.length ? parts.join("\n\n") : "(none)";
}

export function renderIssueFixupPrompt(options: {
  runId: string;
  chunkId: string;
  chunkPath: string;
  worktree: string;
  branch: string;
  resultPath: string;
  force?: boolean;
}): string {
  const run = readRun(options.runId);
  const chunk = readJson<IssueFixupManifest>(options.chunkPath);
  const issueKey = chunk.issueKey ?? chunk.chunkId;
  if (!issueKey) throw new Error(`chunk has no issueKey: ${options.chunkPath}`);

  const promptPath = path.join(runPath(options.runId), "prompts", `${options.chunkId}.md`);
  if (existsSync(promptPath) && !options.force) throw new Error(`prompt already exists: ${promptPath}`);
  mkdirSync(path.dirname(promptPath), { recursive: true });

  const contextPath = path.resolve(repoRoot, chunk.contextPath);
  const context = readJson<any>(contextPath);
  const contextDir = path.dirname(contextPath);
  const retryPath = path.join(runPath(options.runId), "retries", `${issueKey}.json`);
  const retryContext = existsSync(retryPath)
    ? readFileSync(retryPath, "utf8")
    : "No retry metadata exists for this issue.";
  const template = readFileSync(path.join(autofhirRoot, "issue-fixup/issue-fixup-agent-prompt.template.md"), "utf8");
  const pipelineBody = stripH1(readFileSync(path.join(autofhirRoot, "issue-fixup/issue-fixup-pipeline.md"), "utf8"));
  const communityBody = communitySearchBody(readFileSync(path.join(repoRoot, "SKILL.md"), "utf8"));

  const sourcePaths = [
    ...(Array.isArray(context.source_paths) ? context.source_paths : []),
    ...(Array.isArray(chunk.sourcePaths) ? chunk.sourcePaths : []),
  ];
  const sourcePathText = [...new Set(sourcePaths)].sort().map((sourcePath) => `- ${sourcePath}`).join("\n") || "- none precomputed; search the relevant source tree from the issue evidence";
  const integrationRoot = path.join(runPath(options.runId), "worktrees/integration", options.chunkId);

  const replacements: Record<string, string> = {
    REPO_ROOT: repoRoot,
    SPEC_CHECKOUT_ROOT: run.fhirRepo ?? "/home/jmandel/work/fhir",
    SPEC_COMMIT_PINNED: run.baseSha ?? context.specCommit ?? "(unknown)",
    RUN_ID: options.runId,
    CHUNK_ID: options.chunkId,
    ISSUE_KEY: issueKey,
    BRANCH: options.branch,
    WORKTREE: options.worktree,
    COMBINED_BRANCH: run.combinedBranch,
    RESULT_PATH: options.resultPath,
    PROMPT_PATH: promptPath,
    INTEGRATION_ROOT: integrationRoot,
    PIPELINE_BODY: pipelineBody,
    COMMUNITY_SEARCH_BODY: communityBody,
    CONTEXT_JSON: JSON.stringify(context, null, 2),
    RETRY_CONTEXT: retryContext,
    JIRA_SNAPSHOTS: readJiraSnapshots(contextDir),
    ZULIP_SNAPSHOTS: readZulipSnapshots(contextDir, context),
    CONFLUENCE_SNAPSHOTS: readConfluenceSnapshots(contextDir),
    SOURCE_PATHS: sourcePathText,
    BUILD_SCOPE_HINTS: buildScopeHints(options.worktree, [...new Set(sourcePaths)]),
  };

  const templatePlaceholders = [...template.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)].map((match) => match[1]);
  const unknownPlaceholders = templatePlaceholders.filter((key) => replacements[key] === undefined);
  if (unknownPlaceholders.length > 0) {
    throw new Error(`unresolved prompt placeholders: ${[...new Set(unknownPlaceholders)].map((key) => `{{${key}}}`).join(", ")}`);
  }
  const rendered = template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_match, key) => replacements[key]);
  writeFileSync(promptPath, rendered.endsWith("\n") ? rendered : `${rendered}\n`);
  return promptPath;
}

if (import.meta.main) {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`Usage: bun autofhir/scripts/render-issue-fixup-prompt.ts --run-id ID --chunk-id FHIR-XXXXX --chunk-file path --worktree path --branch name --result path [--force]`);
    process.exit(0);
  }
  const runId = arg("--run-id") ?? process.env.RUN_ID;
  const chunkId = arg("--chunk-id") ?? process.env.CHUNK_ID;
  const chunkPath = arg("--chunk-file") ?? arg("--selection");
  const worktree = arg("--worktree") ?? "";
  const branch = arg("--branch") ?? "";
  const resultPath = arg("--result") ?? "";
  if (!runId) throw new Error("--run-id is required");
  if (!chunkId) throw new Error("--chunk-id is required");
  if (!chunkPath) throw new Error("--chunk-file/--selection is required");
  if (!worktree) throw new Error("--worktree is required");
  if (!branch) throw new Error("--branch is required");
  if (!resultPath) throw new Error("--result is required");
  console.log(renderIssueFixupPrompt({
    runId,
    chunkId,
    chunkPath: path.resolve(repoRoot, chunkPath),
    worktree,
    branch,
    resultPath,
    force: process.argv.includes("--force"),
  }));
}
