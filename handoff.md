# AutoFHIR Handoff: Issue Reconcile v2

This handoff is for a new Codex session on a new machine. The goal is to prepare, but not automatically launch, the successor to `issue-reconcile-full-clean-balanced-v1`.

## Orientation Reading

Before running commands, read these files in this order:

1. Parent project overview: `../SKILL.md`, then `../README.md`
2. AutoFHIR operator overview: `SKILL.md`, then `README.md`
3. Shared run mechanics: `workflows/orchestration.md`
4. Issue-reconcile workflow: `issue-reconcile/issue-reconcile-pipeline.md`
5. Worker prompt template: `issue-reconcile/issue-reconcile-agent-prompt.template.md`
6. Current scripts involved in this run:
   - `scripts/prepare-issue-reconcile-run.ts`
   - `scripts/render-issue-reconcile-prompt.ts`
   - `scripts/issue-reconcile-coordinator.ts`
   - `scripts/recover-run.ts`
   - `scripts/cleanup-run-space.ts`
   - `scripts/start.ts`
   - `scripts/monitor.ts`

The parent project supplies the Jira, Zulip, Confluence, and spec search tools. AutoFHIR supplies run orchestration, prompt generation, validation, recovery, and review exports.

## What Changed Before This Handoff

The previous run, `issue-reconcile-full-clean-balanced-v1`, was intentionally stopped. Its queue was recovered so there are no stale `running` or `failed` chunks. Completed issue-level decisions were analyzed, and issues that were reviewed and determined correctly applied are now frozen in:

- `run-inputs/issue-reconcile-full-clean-balanced-v2/exclude-correctly-applied.txt`
- `run-inputs/issue-reconcile-full-clean-balanced-v2/exclude-correctly-applied.json`

The original v1 candidate seed roster is also frozen in:

- `run-inputs/issue-reconcile-full-clean-balanced-v2/v1-candidate-seeds.txt`
- `run-inputs/issue-reconcile-full-clean-balanced-v2/manifest.json`

The v2 run should use the frozen v1 seed list and subtract the correctly-applied exclusion list. This avoids drifting if the local Jira DB has changed since v1 was prepared.

Current counts from `manifest.json`:

- v1 candidate seeds: 12,766
- correctly-applied exclusions: 1,647
- expected v2 upper bound: 11,119

The issue-reconcile prompt and operating manual now also tell workers to search the FHIR Extension Pack checkout when older core issues mention extensions that may have moved out of core.

## Machine Setup

Install Bun first if needed.

Set up the parent project:

```bash
mkdir -p ~/hobby
git clone git@github.com:jmandel/fhir-community-search.git ~/hobby/fhir-community-search
cd ~/hobby/fhir-community-search
bun install
```

Make sure the community DBs exist. If they are absent, use the parent project setup instructions in `../SKILL.md` to download:

```bash
test -f jira/data.db
test -f zulip/data.db
test -f confluence/data.db
```

Set up AutoFHIR inside the parent checkout:

```bash
cd ~/hobby/fhir-community-search
git clone git@github.com:jmandel/autofhir.git autofhir
cd autofhir
bun install
```

Set up the FHIR core checkout. The run uses this repo for source edits and combined branches:

```bash
mkdir -p ~/work
git clone https://github.com/HL7/fhir.git ~/work/fhir
git -C ~/work/fhir remote rename origin upstream 2>/dev/null || true
git -C ~/work/fhir remote set-url upstream https://github.com/HL7/fhir.git
git -C ~/work/fhir remote set-url --push upstream DISABLED
git -C ~/work/fhir fetch --prune upstream
git -C ~/work/fhir checkout -B master upstream/master
```

Set up the FHIR Extension Pack checkout. Workers use this as read-only evidence when extension definitions moved out of core:

```bash
git clone https://github.com/HL7/fhir-extensions.git ~/work/fhir-extensions
git -C ~/work/fhir-extensions remote set-url --push origin DISABLED
git -C ~/work/fhir-extensions fetch --prune origin
git -C ~/work/fhir-extensions checkout -B master origin/master
```

If a different path is used, set:

```bash
export FHIR_EXTENSIONS_REPO=/path/to/fhir-extensions
```

## Prepare The v2 Run

From the parent checkout:

```bash
cd ~/hobby/fhir-community-search

bun autofhir/scripts/prepare-issue-reconcile-run.ts \
  --run-id issue-reconcile-full-clean-balanced-v2 \
  --fhir-repo ~/work/fhir \
  --base-ref master \
  --cutoff 2018-12-27 \
  --order created-newest \
  --issue-keys-file autofhir/run-inputs/issue-reconcile-full-clean-balanced-v2/v1-candidate-seeds.txt \
  --exclude-issues-file autofhir/run-inputs/issue-reconcile-full-clean-balanced-v2/exclude-correctly-applied.txt \
  --description "Successor issue-reconcile run over v1 Applied/Published FHIR-core seed pool, excluding issues v1 already reviewed as correctly applied"
```

Do not start the run until the human operator asks. Preparing the run creates `autofhir/runs/issue-reconcile-full-clean-balanced-v2`, snapshots contexts, and creates the combined branch. It does not launch workers.

After prepare, sanity-check:

```bash
bun autofhir/scripts/status.ts --run-id issue-reconcile-full-clean-balanced-v2
for d in pending running done skipped failed blocked; do
  printf '%-8s ' "$d"
  find "autofhir/runs/issue-reconcile-full-clean-balanced-v2/chunks/$d" -maxdepth 1 -type f -name '*.json' | wc -l
done
jq '{candidate_count, source_candidate_count, eligible_candidate_count, excluded_selected_candidate_count}' \
  autofhir/runs/issue-reconcile-full-clean-balanced-v2/candidate-pool/issues.json
```

Expected:

- `running`, `done`, `failed`, and `blocked` should be `0`
- `pending` should be about `11,119`
- `excluded_selected_candidate_count` should be `1,647`

## Launch Later

Only launch when explicitly asked:

```bash
bun autofhir/scripts/start.ts --run-id issue-reconcile-full-clean-balanced-v2 --concurrency 32
bun autofhir/scripts/start-watch-run-space.ts --run-id issue-reconcile-full-clean-balanced-v2 --max-percent 92
bun autofhir/scripts/monitor.ts --run-id issue-reconcile-full-clean-balanced-v2 --interval-sec 120 --tick
```

Keep relaunching the one-shot monitor tick while actively supervising. Do not leave old background monitors accumulating.

## Shutdown And Recovery Pattern

To pause future launches:

```bash
bun autofhir/scripts/pause.ts --run-id issue-reconcile-full-clean-balanced-v2 --reason "operator pause"
```

If the coordinator or machine dies, recover before restarting:

```bash
bun autofhir/scripts/recover-run.ts --run-id issue-reconcile-full-clean-balanced-v2 --include-failed
bun autofhir/scripts/recover-run.ts --run-id issue-reconcile-full-clean-balanced-v2 --include-failed --yes
```

Clean stale worktrees after a stop:

```bash
bun autofhir/scripts/cleanup-run-space.ts --run-id issue-reconcile-full-clean-balanced-v2
bun autofhir/scripts/cleanup-run-space.ts --run-id issue-reconcile-full-clean-balanced-v2 --apply
```

The cleanup command is dry-run by default. With `--apply`, it removes only stale AutoFHIR task/integration worktrees and temp publish checkouts, then prunes git worktree metadata.
