#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { ChunkManifest, appendJournal, readJson, readRun, runPath, writeJson } from "./lib";
import { renderChunkPrompt } from "./render-chunk-prompt";

type DiscoveryRoster = {
  chunks?: ChunkManifest[];
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/render-discovery-prompts.ts --run-id ID [--chunk CHUNK_ID] [--state pending|running|done|skipped|failed|blocked|all] [--force]

Renders complete discovery worker prompts from the run-local chunks.json roster
by calling render-chunk-prompt.ts for each selected chunk.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const selectedChunk = arg("--chunk");
const state = arg("--state") ?? "pending";
const force = process.argv.includes("--force");
const root = runPath(runId);
const run = readRun(runId);
if (run.workflow && run.workflow !== "discovery") {
  throw new Error(`run ${runId} is workflow=${run.workflow}; expected discovery`);
}

const rosterPath = path.join(root, "chunks.json");
if (!existsSync(rosterPath)) throw new Error(`discovery roster not found: ${rosterPath}`);
const roster = readJson<DiscoveryRoster>(rosterPath);
const rosterChunks = new Map((roster.chunks ?? []).map((chunk) => [chunk.chunkId, chunk]));

function stateChunks(): { chunk: ChunkManifest; selectionPath: string }[] {
  if (state === "all") {
    return [...rosterChunks.values()].map((chunk) => {
      const selectionPath = path.join(root, "chunks", chunk.chunkId, "selection.json");
      mkdirSync(path.dirname(selectionPath), { recursive: true });
      writeJson(selectionPath, chunk);
      return { chunk, selectionPath };
    });
  }
  const dir = path.join(root, "chunks", state);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const selectionPath = path.join(dir, file);
      const chunk = readJson<ChunkManifest>(selectionPath);
      return { chunk: rosterChunks.get(chunk.chunkId) ?? chunk, selectionPath };
    });
}

const chunks = stateChunks().filter((item) => !selectedChunk || item.chunk.chunkId === selectedChunk);
if (selectedChunk && chunks.length === 0) throw new Error(`chunk not found in state=${state}: ${selectedChunk}`);

const rendered: { chunkId: string; promptPath: string }[] = [];
for (const item of chunks) {
  const promptPath = renderChunkPrompt({
    runId,
    chunkId: item.chunk.chunkId,
    selectionPath: item.selectionPath,
    force,
  });
  rendered.push({ chunkId: item.chunk.chunkId, promptPath });
}

appendJournal(runId, {
  type: "discovery-prompts-rendered",
  count: rendered.length,
  state,
  chunkId: selectedChunk,
});

console.log(`run_id=${runId}`);
console.log(`rendered=${rendered.length}`);
for (const item of rendered.slice(0, 20)) {
  console.log(`${item.chunkId}\tprompt=${item.promptPath}`);
}
if (rendered.length > 20) console.log(`... ${rendered.length - 20} more`);
