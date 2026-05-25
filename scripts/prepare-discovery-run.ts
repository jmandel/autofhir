#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  ChunkManifest,
  RunManifest,
  appendJournal,
  ensureRunDirs,
  repoRoot,
  runCommand,
  runPath,
  sanitizeId,
  writeJson,
  writeRun,
} from "./lib";

type OverlayEntry = string | {
  wg?: string;
  group?: string;
  chunkId?: string;
  title?: string;
  note?: string;
};

type ChunkDraft = {
  chunkId: string;
  title: string;
  wg: string;
  wgSourceCode: string;
  group: string;
  sourcePaths: Set<string>;
  mappingNotes: string[];
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/prepare-discovery-run.ts --run-id ID [--fhir-repo DIR] [--overlay FILE] [--cutoff YYYY-MM-DD] [--spec-reference current|published]

Builds a read-only discovery/planning run from the FHIR source checkout on disk.
It parses source/fhir.ini, applies an optional page-to-WG overlay, scans source/,
forms coherent source chunks, freezes chunks.json, and writes pending chunk
manifests under autofhir/runs/<run-id>/chunks/pending/.`);
  process.exit(0);
}

const now = new Date();
const defaultRunId = `discovery-${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
const runId = sanitizeId(arg("--run-id") ?? process.env.RUN_ID ?? defaultRunId);
const fhirRepo = path.resolve(arg("--fhir-repo") ?? process.env.FHIR_REPO ?? "/home/jmandel/work/fhir");
const sourceDir = path.join(fhirRepo, "source");
const overlayPath = path.resolve(arg("--overlay") ?? process.env.WG_SOURCE_MAP ?? path.join(repoRoot, "autofhir/meta/wg-source-map.json"));
const cutoffDate = arg("--cutoff") ?? process.env.CUTOFF_DATE ?? "2018-12-27";
const specReference = arg("--spec-reference") ?? process.env.SPEC_REFERENCE ?? "current";
const description = arg("--description") ?? process.env.RUN_DESCRIPTION ?? `Discover FHIR source/Jira work chunks from ${fhirRepo}`;

if (existsSync(runPath(runId))) throw new Error(`run already exists: ${runId}`);
if (!existsSync(sourceDir)) throw new Error(`FHIR source dir not found: ${sourceDir}`);

const specCommit = runCommand(["git", "rev-parse", "HEAD"], { cwd: fhirRepo }).trim();
const fhirIni = path.join(sourceDir, "fhir.ini");
if (!existsSync(fhirIni)) throw new Error(`fhir.ini not found: ${fhirIni}`);

function parseWorkgroups(file: string): Map<string, string> {
  const map = new Map<string, string>();
  let inSection = false;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line.toLowerCase() === "[workgroups]";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().toLowerCase();
    if (key && value) map.set(key, value);
  }
  return map;
}

function readOverlay(file: string): Map<string, OverlayEntry> {
  if (!existsSync(file)) return new Map();
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const pages = parsed.pages ?? parsed;
  const map = new Map<string, OverlayEntry>();
  for (const [key, value] of Object.entries(pages)) map.set(key.toLowerCase(), value as OverlayEntry);
  return map;
}

function jiraWg(code: string): string {
  return code === "fhir" ? "fhir-i" : code;
}

function sourceRel(name: string): string {
  return `source/${name}`;
}

function withoutHtml(file: string): string {
  return file.replace(/\.html$/i, "");
}

function pageTopic(file: string): string {
  const base = withoutHtml(file).replace(/\.svg$/i, "");
  return base.split("-")[0].toLowerCase();
}

function inferPageWg(topic: string, workgroups: Map<string, string>): { wg: string; sourceCode: string; note: string } {
  const direct = workgroups.get(topic);
  if (direct) return { wg: jiraWg(direct), sourceCode: direct, note: `matched fhir.ini key ${topic}` };

  const rules: [RegExp, string, string][] = [
    [/^(clinicalreasoning|library|measure|plandefinition|activitydefinition|questionnaire|questionnaireresponse)/, "cds", "clinical reasoning/CDS heuristic"],
    [/^(codesystem|valueset|conceptmap|terminology|bindings|identifier|namingsystem)/, "vocab", "terminology heuristic"],
    [/^(medication|dosage|pharmacy)/, "phx", "medication/pharmacy heuristic"],
    [/^(financial|claim|coverage|payment|invoice|account|remittance|insurance)/, "fm", "financial heuristic"],
    [/^(administration|patient|person|practitioner|organization|location|encounter|episodeofcare|schedule|slot|appointment|healthcareservice)/, "pa", "patient administration heuristic"],
    [/^(diagnostics|observation|specimen|device|biologically|nutrition|service|transport)/, "oo", "orders/observations heuristic"],
    [/^(messaging|message|exchanging)/, "inm", "infrastructure messaging heuristic"],
    [/^(documents|cda|composition|clinicalsummary)/, "sd", "structured documents heuristic"],
    [/^(security|auditevent|provenance|consent)/, "sec", "security heuristic"],
    [/^(genomics|molecular)/, "cg", "genomics heuristic"],
    [/^(medication-definition|regulated|medicinal|manufactured|packaged|ingredient|substance|marketingstatus)/, "brr", "biomedical research/regulation heuristic"],
    [/^(foundation|conformance|datatypes|elementdefinition|extension|extensibility|narrative|formats|json|xml|rdf|ttl|http|search|async|comparison|diff|documentation|fhirpath|mapping|graphql|modules|downloads|history|license|credits|index|help|glossary|best|change|lifecycle|logical|managing|ns|operations?)/, "fhir", "FHIR infrastructure heuristic"],
  ];
  for (const [regex, code, note] of rules) {
    if (regex.test(topic)) return { wg: jiraWg(code), sourceCode: code, note };
  }
  return { wg: "fhir-i", sourceCode: "fhir", note: "fallback to fhir-i; add wg-source-map.json entry if wrong" };
}

function structureDefinitionName(dirName: string): string {
  const dir = path.join(sourceDir, dirName);
  if (!existsSync(dir)) return dirName;
  const hit = readdirSync(dir).find((file) => /^structuredefinition-.+\.xml$/i.test(file));
  if (!hit) return dirName;
  return hit.replace(/^structuredefinition-/i, "").replace(/\.xml$/i, "");
}

function addChunk(chunks: Map<string, ChunkDraft>, draft: Omit<ChunkDraft, "sourcePaths" | "mappingNotes">): ChunkDraft {
  const existing = chunks.get(draft.chunkId);
  if (existing) return existing;
  const chunk: ChunkDraft = {
    ...draft,
    sourcePaths: new Set(),
    mappingNotes: [],
  };
  chunks.set(chunk.chunkId, chunk);
  return chunk;
}

const workgroups = parseWorkgroups(fhirIni);
const overlay = readOverlay(overlayPath);
const chunks = new Map<string, ChunkDraft>();
const unassigned: string[] = [];

ensureRunDirs(runId);
mkdirSync(runPath(runId), { recursive: true });

const topLevel = readdirSync(sourceDir).sort();
const dirs = topLevel.filter((name) => statSync(path.join(sourceDir, name)).isDirectory());
const files = topLevel.filter((name) => statSync(path.join(sourceDir, name)).isFile());

const resourceChunkIds = new Map<string, string>();
for (const dir of dirs) {
  let wgSourceCode = workgroups.get(dir.toLowerCase());
  let wg: string;
  let mappingNote: string;
  if (wgSourceCode) {
    wg = jiraWg(wgSourceCode);
    mappingNote = `resource folder mapped from fhir.ini [workgroups]: ${dir}=${wgSourceCode}`;
  } else {
    const inferred = inferPageWg(dir.toLowerCase(), workgroups);
    wgSourceCode = inferred.sourceCode;
    wg = inferred.wg;
    mappingNote = `directory mapped by ${inferred.note}; add fhir.ini or wg-source-map.json entry if wrong`;
  }
  const resourceName = structureDefinitionName(dir);
  const chunkId = sanitizeId(`${wg}--${dir}`);
  const chunk = addChunk(chunks, {
    chunkId,
    title: `${resourceName} discovery chunk`,
    wg,
    wgSourceCode,
    group: dir,
  });
  chunk.sourcePaths.add(sourceRel(`${dir}/`));
  chunk.mappingNotes.push(mappingNote);
  resourceChunkIds.set(dir.toLowerCase(), chunkId);
}

const htmlFiles = files.filter((name) => name.toLowerCase().endsWith(".html"));
for (const file of htmlFiles) {
  const key = file.toLowerCase();
  const topic = pageTopic(file);
  const entry = overlay.get(key) ?? overlay.get(withoutHtml(file).toLowerCase());

  let wg: string;
  let wgSourceCode: string;
  let group = topic;
  let chunkId: string | undefined;
  let title: string | undefined;
  const notes: string[] = [];

  if (typeof entry === "string") {
    wgSourceCode = entry.toLowerCase();
    wg = jiraWg(wgSourceCode);
    notes.push(`page mapped by overlay: ${file}=${entry}`);
  } else if (entry) {
    wgSourceCode = (entry.wg ?? "fhir").toLowerCase();
    wg = jiraWg(wgSourceCode);
    group = entry.group ?? group;
    chunkId = entry.chunkId;
    title = entry.title;
    if (entry.note) notes.push(entry.note);
    notes.push(`page mapped by overlay: ${file}`);
  } else {
    const inferred = inferPageWg(topic, workgroups);
    wg = inferred.wg;
    wgSourceCode = inferred.sourceCode;
    notes.push(`page mapped by ${inferred.note}`);
  }

  const resourceChunk = resourceChunkIds.get(topic);
  if (!chunkId && resourceChunk && (!entry || (typeof entry !== "string" && !entry.group && !entry.chunkId))) {
    chunkId = resourceChunk;
  }
  chunkId = sanitizeId(chunkId ?? `${wg}--${group}`);
  const chunk = addChunk(chunks, {
    chunkId,
    title: title ?? `${group} discovery chunk`,
    wg,
    wgSourceCode,
    group,
  });
  chunk.sourcePaths.add(sourceRel(file));
  chunk.mappingNotes.push(...notes);
}

const rootFiles = files.filter((name) => !name.toLowerCase().endsWith(".html"));
if (rootFiles.length) {
  const chunk = addChunk(chunks, {
    chunkId: "fhir-i--source-root",
    title: "source root support files discovery chunk",
    wg: "fhir-i",
    wgSourceCode: "fhir",
    group: "source-root",
  });
  for (const file of rootFiles) {
    chunk.sourcePaths.add(sourceRel(file));
  }
  chunk.mappingNotes.push("top-level non-HTML source files assigned to fhir-i source-root chunk");
}

const chunkList: ChunkManifest[] = [...chunks.values()]
  .sort((a, b) => a.chunkId.localeCompare(b.chunkId))
  .map((chunk) => ({
    schemaVersion: "1.0",
    runId,
    chunkId: chunk.chunkId,
    title: chunk.title,
    workflow: "discovery",
    sourceKind: "fhir-source-discovery",
    changeChunkReportPath: "",
    wg: chunk.wg,
    wgSourceCode: chunk.wgSourceCode,
    sourcePaths: [...chunk.sourcePaths].sort(),
    siblingChunks: [],
    specCommit,
    cutoffDate,
    specReference,
    mappingNotes: [...new Set(chunk.mappingNotes)].sort(),
  }));

const byWg = new Map<string, string[]>();
for (const chunk of chunkList) {
  const list = byWg.get(chunk.wg ?? "") ?? [];
  list.push(chunk.chunkId);
  byWg.set(chunk.wg ?? "", list);
}
for (const chunk of chunkList) {
  chunk.siblingChunks = (byWg.get(chunk.wg ?? "") ?? []).filter((id) => id !== chunk.chunkId).sort();
}

writeJson(path.join(runPath(runId), "chunks.json"), {
  schemaVersion: "1.0",
  workflow: "discovery",
  runId,
  fhirRepo,
  sourceDir,
  specCommit,
  cutoffDate,
  specReference,
  overlayPath: existsSync(overlayPath) ? path.relative(repoRoot, overlayPath) : null,
  chunkCount: chunkList.length,
  unassignedSourcePaths: unassigned,
  chunks: chunkList,
});

for (const chunk of chunkList) {
  writeJson(path.join(runPath(runId), "chunks/pending", `${chunk.chunkId}.json`), chunk);
}

const run: RunManifest = {
  schemaVersion: "1.0",
  runId,
  createdAt: now.toISOString(),
  description,
  workflow: "discovery",
  chunkSource: {
    kind: "fhir-source-discovery",
    path: fhirRepo,
  },
  chunkCount: chunkList.length,
  fhirRepo,
  baseRef: "HEAD",
  baseSha: specCommit,
  combinedBranch: process.env.COMBINED_BRANCH ?? `robo-spec-combined-${runId}`,
  status: "prepared",
};
writeRun(run);
appendJournal(runId, {
  type: "run-prepared",
  workflow: "discovery",
  chunkCount: chunkList.length,
  specCommit,
  unassignedSourcePathCount: unassigned.length,
});

console.log(`run_id=${runId}`);
console.log(`workflow=discovery`);
console.log(`spec_commit=${specCommit}`);
console.log(`chunk_count=${chunkList.length}`);
console.log(`unassigned_source_paths=${unassigned.length}`);
console.log(`run_dir=${runPath(runId)}`);
if (unassigned.length) {
  console.log(`unassigned_report=${path.join(runPath(runId), "chunks.json")}`);
}
