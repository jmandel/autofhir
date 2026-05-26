#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { autofhirRoot, readJson, readRun, repoRoot, runPath, sanitizeId } from "./lib";

type AuditChunk = {
  chunkId: string;
  issueKey: string;
  sourceRunId: string;
  sourceContextPath: string;
  sourceResultPath?: string;
  missingSourceResult?: boolean;
  commitPatchPath?: string;
  sourcePaths?: string[];
  commit: {
    sha: string;
    body?: string;
    previous_issue_commits?: unknown[];
    [key: string]: unknown;
  };
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

function truncateHuge(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= maxBytes) return value;
  const kept = value.slice(0, maxBytes);
  return `${kept}\n\n[TRUNCATED: original content was ${bytes} bytes; inspect the referenced file or run git show for the full content.]\n`;
}

type FhirIniEntry = {
  section: string;
  lineNo: number;
  raw: string;
  active: boolean;
  key?: string;
  value?: string;
};

function normalizePathish(value: string): string {
  let normalized = value.replaceAll("\\", "/").trim();
  const sourceIndex = normalized.indexOf("/source/");
  if (sourceIndex >= 0) normalized = normalized.slice(sourceIndex + 1);
  normalized = normalized.replace(/^\.\//, "").replace(/^\/+/, "");
  return normalized.toLowerCase();
}

function parseFhirIni(iniText: string): FhirIniEntry[] {
  let section = "";
  const entries: FhirIniEntry[] = [];
  iniText.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    const sectionMatch = trimmed.match(/^;?\[([^\]]+)\]/);
    if (sectionMatch && !trimmed.startsWith(";")) {
      section = sectionMatch[1] ?? "";
      return;
    }
    if (!trimmed || trimmed.startsWith("#")) return;
    const active = !trimmed.startsWith(";");
    const content = active ? trimmed : trimmed.replace(/^;+/, "").trim();
    if (!content || content.startsWith("[") || content.startsWith("**")) return;
    const eq = content.indexOf("=");
    entries.push({
      section,
      lineNo: index + 1,
      raw,
      active,
      key: eq >= 0 ? content.slice(0, eq).trim() : content.trim(),
      value: eq >= 0 ? content.slice(eq + 1).trim() : undefined,
    });
  });
  return entries;
}

function entryLabel(entry: FhirIniEntry): string {
  const status = entry.active ? "active" : "commented";
  return `line ${entry.lineNo} [${entry.section}] ${status}: ${entry.raw.trim()}`;
}

function matchingEntries(entries: FhirIniEntry[], variants: Set<string>, section?: string): FhirIniEntry[] {
  return entries.filter((entry) => {
    if (section && entry.section !== section) return false;
    const raw = normalizePathish(entry.raw.replace(/^;+/, ""));
    const value = normalizePathish(entry.value ?? "");
    return [...variants].some((variant) => variant && (raw.includes(variant) || value.includes(variant)));
  });
}

function buildScopeHints(worktree: string, sourcePaths: string[]): string {
  const iniPath = path.join(worktree, "source", "fhir.ini");
  if (!existsSync(iniPath)) return `- Unable to read ${iniPath}; inspect source/fhir.ini manually before treating obscure profiles/pages as live build inputs.`;

  const entries = parseFhirIni(readFileSync(iniPath, "utf8"));
  const uniquePaths = [...new Set(sourcePaths)].sort();
  if (uniquePaths.length === 0) return "- No likely source paths were precomputed; inspect source/fhir.ini and current source references manually.";

  return uniquePaths.map((sourcePath) => {
    const normalized = normalizePathish(sourcePath);
    const withoutSource = normalized.startsWith("source/") ? normalized.slice("source/".length) : normalized;
    const basename = path.basename(normalized);
    const variants = new Set([normalized, withoutSource]);
    if (basename && basename.length > 8) variants.add(basename);

    const exactMatches = matchingEntries(entries, variants);
    const activeMatches = exactMatches.filter((entry) => entry.active);
    const commentedMatches = exactMatches.filter((entry) => !entry.active);

    const folder = normalized.match(/^source\/([^/]+)/)?.[1]?.toLowerCase();
    const activeResource = folder
      ? entries.find((entry) => entry.active && entry.section === "resources" && entry.key?.toLowerCase() === folder)
      : undefined;
    const commentedResource = folder
      ? entries.find((entry) => !entry.active && entry.section === "resources" && entry.key?.toLowerCase() === folder)
      : undefined;
    const activeWorkgroup = folder
      ? entries.find((entry) => entry.active && entry.section === "workgroups" && entry.key?.toLowerCase() === folder)
      : undefined;
    const activeProfile = activeMatches.find((entry) => entry.section === "profiles");
    const commentedProfile = commentedMatches.find((entry) => entry.section === "profiles");

    const lines = [`- ${sourcePath}`];
    const activeIndicators = [
      activeResource ? entryLabel(activeResource) : undefined,
      activeWorkgroup ? entryLabel(activeWorkgroup) : undefined,
      activeProfile ? entryLabel(activeProfile) : undefined,
      ...activeMatches.filter((entry) => entry !== activeResource && entry !== activeWorkgroup && entry !== activeProfile).slice(0, 4).map(entryLabel),
    ].filter((line): line is string => Boolean(line));
    const inactiveIndicators = [
      commentedResource ? entryLabel(commentedResource) : undefined,
      commentedProfile ? entryLabel(commentedProfile) : undefined,
      ...commentedMatches.filter((entry) => entry !== commentedResource && entry !== commentedProfile).slice(0, 4).map(entryLabel),
    ].filter((line): line is string => Boolean(line));

    if (activeIndicators.length) lines.push(`  - Active fhir.ini indicators: ${activeIndicators.join(" | ")}`);
    if (inactiveIndicators.length) lines.push(`  - Commented/inactive fhir.ini indicators: ${inactiveIndicators.join(" | ")}`);
    if (normalized.startsWith("source/profiles/") && commentedProfile && !activeProfile) {
      lines.push("  - Scope warning: this profile path appears only in a commented [profiles] entry; treat edits as likely out-of-build unless another active reference proves otherwise.");
    } else if (!activeIndicators.length) {
      lines.push("  - Scope warning: no active fhir.ini indicator was found for this path; verify with source references before keeping edits to obscure profiles, generated artifacts, or standalone pages.");
    }
    return lines.join("\n");
  }).join("\n");
}

export function renderIssueFixupAuditPrompt(options: {
  runId: string;
  chunkId: string;
  chunkPath: string;
  worktree: string;
  resultPath: string;
  force?: boolean;
}): string {
  const run = readRun(options.runId);
  const chunk = readJson<AuditChunk>(options.chunkPath);
  const issueKey = chunk.issueKey ?? chunk.chunkId;
  if (!issueKey) throw new Error(`chunk has no issueKey: ${options.chunkPath}`);

  const promptPath = path.join(runPath(options.runId), "prompts", `${options.chunkId}.md`);
  if (existsSync(promptPath) && !options.force) throw new Error(`prompt already exists: ${promptPath}`);
  mkdirSync(path.dirname(promptPath), { recursive: true });

  const contextPath = path.resolve(repoRoot, chunk.sourceContextPath);
  const context = readJson<any>(contextPath);
  const contextDir = path.dirname(contextPath);
  const sourceResultPath = chunk.sourceResultPath ? path.resolve(repoRoot, chunk.sourceResultPath) : "";
  const sourceResult = sourceResultPath && existsSync(sourceResultPath)
    ? readJson<any>(sourceResultPath)
    : {
      warning: "No original issue-fixup result JSON was available for this generated commit. Audit from the baked issue context, generated commit, patch, and any additional searches.",
      missing_source_result: true,
    };
  const template = readFileSync(path.join(autofhirRoot, "issue-fixup-audit/issue-fixup-audit-agent-prompt.template.md"), "utf8");
  const pipelineBody = stripH1(readFileSync(path.join(autofhirRoot, "issue-fixup-audit/issue-fixup-audit-pipeline.md"), "utf8"));
  const communityBody = communitySearchBody(readFileSync(path.join(repoRoot, "SKILL.md"), "utf8"));

  const sourcePaths = [
    ...(Array.isArray(context.source_paths) ? context.source_paths : []),
    ...(Array.isArray(sourceResult?.decision?.source_changes) ? [] : []),
    ...(Array.isArray(chunk.sourcePaths) ? chunk.sourcePaths : []),
    ...(Array.isArray(chunk.commit.files) ? chunk.commit.files.filter((file): file is string => typeof file === "string") : []),
  ];
  const sourcePathText = [...new Set(sourcePaths)].sort().map((sourcePath) => `- ${sourcePath}`).join("\n") || "- none precomputed; search the relevant source tree from the issue evidence";

  const patchPath = chunk.commitPatchPath ? path.resolve(repoRoot, chunk.commitPatchPath) : "";
  const patchBody = patchPath && existsSync(patchPath)
    ? readFileSync(patchPath, "utf8")
    : "(no embedded patch file was found; run git show in the inspection worktree)";
  const previousCommits = JSON.stringify(chunk.commit.previous_issue_commits ?? [], null, 2);
  const commitJson = JSON.stringify(chunk.commit, null, 2);

  const replacements: Record<string, string> = {
    REPO_ROOT: repoRoot,
    SPEC_CHECKOUT_ROOT: run.fhirRepo ?? "/home/jmandel/work/fhir",
    SPEC_COMMIT_PINNED: run.baseSha ?? context.specCommit ?? "(unknown)",
    RUN_ID: options.runId,
    SOURCE_RUN_ID: chunk.sourceRunId,
    CHUNK_ID: options.chunkId,
    ISSUE_KEY: issueKey,
    COMMIT_SHA: chunk.commit.sha,
    COMBINED_BRANCH: run.combinedBranch,
    WORKTREE: options.worktree,
    RESULT_PATH: options.resultPath,
    PROMPT_PATH: promptPath,
    PIPELINE_BODY: pipelineBody,
    COMMUNITY_SEARCH_BODY: communityBody,
    CONTEXT_JSON: JSON.stringify(context, null, 2),
    SOURCE_RESULT_JSON: JSON.stringify(sourceResult, null, 2),
    JIRA_SNAPSHOTS: readJiraSnapshots(contextDir),
    ZULIP_SNAPSHOTS: readZulipSnapshots(contextDir, context),
    CONFLUENCE_SNAPSHOTS: readConfluenceSnapshots(contextDir),
    SOURCE_PATHS: sourcePathText,
    BUILD_SCOPE_HINTS: buildScopeHints(options.worktree, [...new Set(sourcePaths)]),
    COMMIT_JSON: truncateHuge(commitJson, 250_000),
    PREVIOUS_ISSUE_COMMITS: truncateHuge(previousCommits, 150_000),
    COMMIT_PATCH: truncateHuge(patchBody, 500_000),
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
    console.log(`Usage: bun autofhir/scripts/render-issue-fixup-audit-prompt.ts --run-id ID --chunk-id FHIR-XXXXX --chunk-file path --worktree path --result path [--force]`);
    process.exit(0);
  }
  const runId = arg("--run-id") ?? process.env.RUN_ID;
  const chunkId = arg("--chunk-id") ?? process.env.CHUNK_ID;
  const chunkPath = arg("--chunk-file") ?? arg("--selection");
  const worktree = arg("--worktree") ?? "";
  const resultPath = arg("--result") ?? "";
  if (!runId) throw new Error("--run-id is required");
  if (!chunkId) throw new Error("--chunk-id is required");
  if (!chunkPath) throw new Error("--chunk-file/--selection is required");
  if (!worktree) throw new Error("--worktree is required");
  if (!resultPath) throw new Error("--result is required");
  console.log(renderIssueFixupAuditPrompt({
    runId,
    chunkId,
    chunkPath: path.resolve(repoRoot, chunkPath),
    worktree,
    resultPath,
    force: process.argv.includes("--force"),
  }));
}
