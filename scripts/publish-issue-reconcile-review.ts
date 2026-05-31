#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { autofhirRoot, readRun, repoRoot, runCommand, runPath } from "./lib";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

if (flag("-h") || flag("--help")) {
  console.log(`Usage: bun autofhir/scripts/publish-issue-reconcile-review.ts --run-id ID [--skip-export] [--skip-source-branch] [--skip-artifact-branch] [--deploy-pages]

Publishes an issue-reconcile review snapshot to jmandel/autofhir so the rendered
review app, its commit links, and its agent instructions resolve on github.com:
  - rebuilds the run's decided commits as an orphan FHIR source branch and
    pushes it to refs/heads/<run-id> (one commit per Issue-Reconcile-Key on top
    of a single base-snapshot root, so HL7/fhir history is not pushed)
  - re-exports the review viewer with a commit map so each issue card links to
    the matching commit on the orphan branch
  - force-pushes the review app, JSON report, and gzip to
    refs/heads/pages-<run-id>/<run-id>/

The orphan branch reuses each decided commit's exact tree, so its per-commit
diffs on github.com match the local combined branch.

With --deploy-pages, dispatches the main-branch GitHub Pages workflow. The
workflow rebuilds the web app from main, reads review-runs.json, fetches
artifact branches, uploads a Pages artifact, and deploys it.`);
  process.exit(0);
}

const runIdArg = arg("--run-id") ?? process.env.RUN_ID;
if (!runIdArg) throw new Error("--run-id or RUN_ID is required");
const runId: string = runIdArg;

const run = readRun(runId);
if (run.workflow !== "issue-reconcile") throw new Error(`run ${runId} is workflow=${run.workflow ?? "(unset)"}; expected issue-reconcile`);
if (!run.fhirRepo) throw new Error(`run ${runId} has no fhirRepo`);
if (!run.combinedBranch) throw new Error(`run ${runId} has no combinedBranch`);
if (!run.baseSha) throw new Error(`run ${runId} has no baseSha`);

const fhirRepo = run.fhirRepo;
const combinedBranch = run.combinedBranch;
const baseSha = run.baseSha;
const githubRepo = "jmandel/autofhir";
const repoUrl = process.env.AUTOFHIR_PUBLISH_REPO_URL ?? `https://github.com/${githubRepo}.git`;
const sourceBranch = runId;
const artifactBranch = `pages-${runId}`;
const root = runPath(runId);
const reviewDir = path.join(root, "review");
const commitMapPath = path.join(reviewDir, "commit-map.json");

const NUL = "\u0000";

function git(args: string[], options: { cwd: string; input?: string; env?: Record<string, string>; allowFailure?: boolean }): string {
  const proc = spawnSync("git", args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: 1024 * 1024 * 256,
  });
  if (proc.status !== 0 && !options.allowFailure) {
    throw new Error([
      `git ${args.join(" ")} failed`,
      `cwd=${options.cwd}`,
      `exit=${proc.status}`,
      proc.stdout?.trim(),
      proc.stderr?.trim(),
    ].filter(Boolean).join("\n"));
  }
  return proc.stdout ?? "";
}

function commitIdentityEnv(sha: string, includeBody: boolean): { env: Record<string, string>; message: string } {
  const format = includeBody
    ? "%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B"
    : "%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI";
  const raw = git(["show", "-s", `--format=${format}`, sha], { cwd: fhirRepo });
  const [an, ae, ad, cn, ce, cd, ...bodyParts] = raw.split(NUL);
  const env = {
    GIT_AUTHOR_NAME: an,
    GIT_AUTHOR_EMAIL: ae,
    GIT_AUTHOR_DATE: ad,
    GIT_COMMITTER_NAME: cn,
    GIT_COMMITTER_EMAIL: ce,
    GIT_COMMITTER_DATE: cd,
  };
  return { env, message: includeBody ? bodyParts.join(NUL) : "" };
}

function buildOrphanBranch(): { rootSha: string; headSha: string; map: Record<string, string> } {
  const baseTree = git(["rev-parse", `${baseSha}^{tree}`], { cwd: fhirRepo }).trim();
  const baseIdentity = commitIdentityEnv(baseSha, false);
  const rootMessage = `Base snapshot for ${runId}\n\nOrphan root capturing ${run.baseRef ?? "base"} @ ${baseSha}.\n`;
  const rootSha = git(["commit-tree", baseTree], { cwd: fhirRepo, input: rootMessage, env: baseIdentity.env }).trim();

  const decided = git(["rev-list", "--reverse", combinedBranch, `^${baseSha}`], { cwd: fhirRepo })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const map: Record<string, string> = {};
  let parent = rootSha;
  for (const sha of decided) {
    const tree = git(["rev-parse", `${sha}^{tree}`], { cwd: fhirRepo }).trim();
    const { env, message } = commitIdentityEnv(sha, true);
    const newSha = git(["commit-tree", tree, "-p", parent], { cwd: fhirRepo, input: message, env }).trim();
    map[sha] = newSha;
    parent = newSha;
  }

  git(["branch", "-f", sourceBranch, parent], { cwd: fhirRepo });
  return { rootSha, headSha: parent, map };
}

function pushSourceBranch(headSha: string): void {
  const remoteRef = `refs/heads/${sourceBranch}`;
  const remoteSha = git(["ls-remote", repoUrl, remoteRef], { cwd: fhirRepo, allowFailure: true }).trim().split(/\s+/)[0];
  const leaseArgs = remoteSha ? [`--force-with-lease=${remoteRef}:${remoteSha}`] : ["--force"];
  git(["push", ...leaseArgs, repoUrl, `${headSha}:${remoteRef}`], { cwd: fhirRepo });
  console.log(`source_branch=https://github.com/${githubRepo}/tree/${sourceBranch}`);
}

function pushArtifactBranch(): void {
  const artifactFiles = [
    "index.html",
    "issue-reconcile-report.json",
    "issue-reconcile-report.json.gz",
  ];
  for (const name of artifactFiles) {
    if (!existsSync(path.join(reviewDir, name))) {
      throw new Error(`missing required review artifact: ${path.join(reviewDir, name)} (run the export first)`);
    }
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "autofhir-reconcile-publish-"));
  try {
    git(["init"], { cwd: tmp });
    git(["config", "user.name", "AutoFHIR"], { cwd: tmp });
    git(["config", "user.email", "autofhir@example.invalid"], { cwd: tmp });
    git(["remote", "add", "origin", repoUrl], { cwd: tmp });
    const remoteRef = `refs/heads/${artifactBranch}`;
    git(["checkout", "--orphan", artifactBranch], { cwd: tmp });
    const dest = path.join(tmp, runId);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    for (const name of artifactFiles) {
      cpSync(path.join(reviewDir, name), path.join(dest, name));
    }
    writeFileSync(path.join(tmp, ".nojekyll"), "");
    git(["add", "."], { cwd: tmp });
    git(["commit", "--quiet", "-m", `Publish ${runId} issue-reconcile review artifacts`], { cwd: tmp });
    git(["push", "--force", "origin", `HEAD:${remoteRef}`], { cwd: tmp });
    console.log(`artifact_branch=https://github.com/${githubRepo}/tree/${artifactBranch}/${runId}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function deployPages(): void {
  const siteDir = mkdtempSync(path.join(tmpdir(), "autofhir-reconcile-site-"));
  try {
    runCommand(["bun", path.join(autofhirRoot, "scripts/build-review-pages-site.ts"), "--out-dir", siteDir, "--registry", path.join(autofhirRoot, "review-runs.json"), "--fetch-artifacts"], { cwd: repoRoot });
    runCommand(["bun", path.join(autofhirRoot, "scripts/deploy-review-pages-site.ts"), "--registry", path.join(autofhirRoot, "review-runs.json"), "--wait"], { cwd: repoRoot });
  } finally {
    rmSync(siteDir, { recursive: true, force: true });
  }
  console.log("pages_url=https://joshuamandel.com/autofhir/");
}

if (!flag("--skip-source-branch")) {
  const { rootSha, headSha, map } = buildOrphanBranch();
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(commitMapPath, `${JSON.stringify({ base_sha: rootSha, head_sha: headSha, map }, null, 2)}\n`);
  console.log(`commit_map=${commitMapPath}`);
  console.log(`orphan_commits=${Object.keys(map).length}`);
} else if (!existsSync(commitMapPath)) {
  throw new Error(`--skip-source-branch given but ${commitMapPath} is missing; build the source branch first`);
}

if (!flag("--skip-export")) {
  runCommand([
    "bun",
    path.join(autofhirRoot, "scripts/export-issue-reconcile-viewer.ts"),
    "--run-id",
    runId,
    "--commit-map",
    commitMapPath,
  ], { cwd: repoRoot });
}

if (!flag("--skip-source-branch")) {
  const headSha = git(["rev-parse", sourceBranch], { cwd: fhirRepo }).trim();
  pushSourceBranch(headSha);
}

if (!flag("--skip-artifact-branch")) {
  pushArtifactBranch();
}

if (flag("--deploy-pages")) {
  deployPages();
}
