#!/usr/bin/env bun

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { appendJournal, readJson, runPath } from "./lib";
import { renderIssueSeedPrompt } from "./render-issue-seed-prompt";

type SeedManifest = {
  seed_key: string;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/render-issue-mapping-prompts.ts --run-id ID [--seed-key FHIR-XXXXX] [--state pending|running|done|failed|blocked] [--force]

Renders issue-mapping seed prompts without launching Copilot.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");
const selectedSeed = arg("--seed-key") ?? process.env.SEED_KEY;
const state = arg("--state") ?? "pending";
const force = process.argv.includes("--force");
const root = runPath(runId);
const dir = path.join(root, "seeds", state);
if (!existsSync(dir)) throw new Error(`seed state directory not found: ${dir}`);

const seeds = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => {
    const seedPath = path.join(dir, file);
    const seed = readJson<SeedManifest>(seedPath);
    return { seed, seedPath };
  })
  .filter((item) => !selectedSeed || item.seed.seed_key === selectedSeed);

if (selectedSeed && seeds.length === 0) throw new Error(`seed not found in ${state}: ${selectedSeed}`);

const rendered = seeds.map((item) => ({
  seedKey: item.seed.seed_key,
  promptPath: renderIssueSeedPrompt({
    runId,
    seedKey: item.seed.seed_key,
    seedPath: item.seedPath,
    force,
  }),
}));

appendJournal(runId, {
  type: "issue-mapping-prompts-rendered",
  count: rendered.length,
  state,
  seedKey: selectedSeed,
});

console.log(`run_id=${runId}`);
console.log(`rendered=${rendered.length}`);
for (const item of rendered.slice(0, 20)) {
  console.log(`${item.seedKey}\tprompt=${item.promptPath}`);
}
if (rendered.length > 20) console.log(`... ${rendered.length - 20} more`);
