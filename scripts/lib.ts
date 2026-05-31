import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const standaloneRoot = path.resolve(import.meta.dir, "..");
const nestedRepoRoot = path.resolve(import.meta.dir, "../..");
export const autofhirRoot = existsSync(path.join(standaloneRoot, "package.json")) && existsSync(path.join(standaloneRoot, "scripts", "lib.ts"))
  ? standaloneRoot
  : path.join(nestedRepoRoot, "autofhir");
export const repoRoot = autofhirRoot === standaloneRoot ? standaloneRoot : nestedRepoRoot;
export const runsRoot = path.join(autofhirRoot, "runs");

export type RunManifest = {
  schemaVersion: "1.0";
  runId: string;
  createdAt: string;
  description: string;
  workflow?: string;
  chunkSource: {
    kind: string;
    path: string;
  };
  chunkCount: number;
  baseRef?: string;
  baseSha?: string;
  fhirRepo?: string;
  combinedBranch: string;
  combinedWorktree?: string;
  concurrency?: number;
  status: "prepared" | "initialized" | "running" | "paused" | "complete" | "reset";
};

export type ChunkManifest = {
  schemaVersion: "1.0";
  runId: string;
  chunkId: string;
  title: string;
  sourceKind: string;
  changeChunkReportPath: string;
  workflow?: string;
  wg?: string;
  wgSourceCode?: string;
  sourcePaths?: string[];
  siblingChunks?: string[];
  specCommit?: string;
  cutoffDate?: string;
  specReference?: string;
  expectedTicketPoolSize?: number;
  mappingNotes?: string[];
  pageLabel?: string;
  actionFilePath?: string;
  researchFilePath?: string;
  findingCount?: number;
  findingIds?: string[];
  findings?: {
    id: string;
    title?: string;
    kind?: string;
    priority?: string;
    category?: string;
    status?: string;
    problem?: string;
    whyItMatters?: string;
    recommendedNextStep?: string;
    jiraIdsMentioned?: string[];
    sourceLocations?: {
      filePath?: string;
      lineRange?: {
        start?: number;
        end?: number;
      };
    }[];
  }[];
};

export function runPath(runId: string): string {
  return path.join(runsRoot, runId);
}

export function manifestPath(runId: string): string {
  return path.join(runPath(runId), "run.json");
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readRun(runId: string): RunManifest {
  return readJson<RunManifest>(manifestPath(runId));
}

export function writeRun(run: RunManifest): void {
  writeJson(manifestPath(run.runId), run);
}

export function ensureRunDirs(runId: string): void {
  const root = runPath(runId);
  for (const dir of [
    "chunks/pending",
    "chunks/running",
    "chunks/done",
    "chunks/skipped",
    "chunks/failed",
    "chunks/blocked",
    "status",
    "stdout",
    "stderr",
    "copilot-logs",
    "results",
    "reports",
    "prompts",
    "retries",
    "worktrees/tasks",
    "worktrees/integration",
    "worktrees/inspect",
    "archive",
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
}

export function runCommand(args: string[], options: { cwd?: string; allowFailure?: boolean } = {}): string {
  const proc = spawnSync(args[0], args.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (proc.status !== 0 && !options.allowFailure) {
    throw new Error([
      `command failed: ${args.join(" ")}`,
      `cwd=${options.cwd ?? process.cwd()}`,
      `exit=${proc.status}`,
      proc.stdout?.trim(),
      proc.stderr?.trim(),
    ].filter(Boolean).join("\n"));
  }
  return proc.stdout ?? "";
}

export function startDetached(args: string[], stdoutFile: string, stderrFile: string, cwd = repoRoot): number {
  mkdirSync(path.dirname(stdoutFile), { recursive: true });
  mkdirSync(path.dirname(stderrFile), { recursive: true });
  const out = openSync(stdoutFile, "a");
  const err = openSync(stderrFile, "a");
  const proc = spawn(args[0], args.slice(1), {
    cwd,
    detached: true,
    stdio: ["ignore", out, err],
  });
  proc.unref();
  closeSync(out);
  closeSync(err);
  return proc.pid ?? 0;
}

export function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function chunkFile(runId: string, state: string, chunkId: string): string {
  return path.join(runPath(runId), "chunks", state, `${chunkId}.json`);
}

export function moveChunk(runId: string, chunkId: string, from: string, to: string): string {
  const source = chunkFile(runId, from, chunkId);
  const dest = chunkFile(runId, to, chunkId);
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(source, dest);
  return dest;
}

export function appendJournal(runId: string, entry: Record<string, unknown>): void {
  const file = path.join(runPath(runId), "journal.ndjson");
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export function setStatus(runId: string, chunkId: string, fields: Record<string, string | number | undefined>): void {
  const file = path.join(runPath(runId), "status", `${chunkId}.status`);
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  appendFileSync(file, `${lines.join("\n")}\n`);
}

export function rewriteStatus(runId: string, chunkId: string, fields: Record<string, string | number | undefined>): void {
  const file = path.join(runPath(runId), "status", `${chunkId}.status`);
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  writeFileSync(file, `${lines.join("\n")}\n`);
}

export function pauseRun(runId: string, reason: string): void {
  const root = runPath(runId);
  writeFileSync(path.join(root, "PAUSED"), `paused_at=${new Date().toISOString()}\nreason=${reason}\n`);
  const run = readRun(runId);
  run.status = "paused";
  writeRun(run);
  notify("AutofHIR paused", `${runId}: ${reason}`);
  appendJournal(runId, { type: "run-paused", reason });
}

export function notify(title: string, body: string): void {
  const candidates: string[][] = [
    ["notify-send", title, body],
    ["terminal-notifier", "-title", title, "-message", body],
    ["osascript", "-e", `display notification "${body.replaceAll('"', '\\"')}" with title "${title.replaceAll('"', '\\"')}"`],
  ];
  for (const cmd of candidates) {
    const exists = spawnSync("bash", ["-lc", `command -v ${cmd[0]}`], { stdio: "ignore" }).status === 0;
    if (!exists) continue;
    spawnSync(cmd[0], cmd.slice(1), { stdio: "ignore" });
    return;
  }
}

export function removeIfExists(target: string): void {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

export function pidIsAlive(pid: string | number): boolean {
  const value = String(pid).trim();
  return /^\d+$/.test(value) && spawnSync("kill", ["-0", value], { stdio: "ignore" }).status === 0;
}
