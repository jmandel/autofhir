---
name: autofhir
description: Coordinate external Copilot CLI agents over FHIR spec work, using durable run state, isolated worktrees, bounded concurrency, foreground tick monitoring, retry recovery, and workflow-specific chunk contracts.
---

# AutofHIR

Use this skill when asked to run or maintain an AutofHIR pipeline. AutofHIR manages a run, meaning the total body of work being attempted, split into restartable chunks. The shared engine provides durable state, bounded Copilot CLI execution, pause/resume, soft concurrency, retry recovery, and Codex-visible monitoring. Workflow adapters define what chunks mean and what workers produce.

## Checkout Assumption

For now, AutoFHIR is expected to be checked out as `autofhir/` inside a clone of `fhir-community-search`. Most commands below are intentionally written from the parent checkout, e.g. `bun autofhir/scripts/status.ts`. Run-specific state belongs under `autofhir/runs/` and should not be committed.

Current workflow docs:

- `workflows/orchestration.md` — shared run engine and monitoring/retry contracts.
- `workflows/apply.md` — spec-edit application runs. Workers make one commit per fixed finding and publish locally into a combined branch.
- `workflows/discovery.md` — read-only discovery/planning runs. Workers compute Jira/source plans from chunks generated from the FHIR checkout at run start.
- `workflows/issue-mapping.md` — Jira-first read-only mapping runs. Workers decide one seed Jira issue at a time and accumulate observations for downstream work-item generation.
- `workflows/issue-fixup.md` — follow-on source-fix/audit runs. Workers process issue-mapping rows assessed as not fully applied and publish one `Issue-Fixup-Key:` commit per Jira issue.
- `issue-fixup-audit/issue-fixup-audit-pipeline.md` — read-only second-pass audit of issue-fixup commits. Workers decide keep/tweak/drop/human-review and rewrite commit messages, with explicit checks for current build scope and semantic necessity.
- `issue-reconcile/issue-reconcile-pipeline.md` — discovery-with-autofix runs. Workers start from one `Applied`/`Published` Jira seed by default, explore the related source/community/history neighborhood, and may publish one `Issue-Reconcile-Key:` commit per decided issue.

Review app source:

- `scripts/export-issue-fixup-diff-viewer.ts` generates the standalone issue-fixup review app. The app is driven by issue-fixup outputs, not the original discovery rows. "What Changed" is parsed from the actual integrated commit message, while "Agent Assessment" comes from `runs/<run-id>/results/FHIR-XXXXX.json`.
- The app uses reviewer-facing labels such as "Source change made", "Needs human review", and "Likely Owning Work Group"; avoid exposing pipeline-internal names unless they are needed for debugging.
- The app's "Copy Review Plan" button should stay self-contained for external agents: include where the reconciliation branch can be found, what KEEP/DROP/DEFER mean, how to apply the selected commits, and links to download the full issue-mapping input JSON plus the full issue-fixup review JSON.
- Use `bun autofhir/scripts/publish-issue-fixup-review.ts --run-id <run-id>` to publish the current review snapshot to `jmandel/autofhir`. It updates the FHIR reconciliation branch, the raw review artifact branch, and the GitHub Pages review app.
- For issue-reconcile runs, use `bun autofhir/scripts/publish-issue-reconcile-review.ts --run-id <run-id>`. It rebuilds the run's decided commits as an orphan FHIR source branch pushed to `refs/heads/<run-id>` (one commit per `Issue-Reconcile-Key` on top of a single base snapshot, so HL7/fhir history is not pushed), re-exports the viewer with a commit map so each issue card links to the matching commit on that branch, and pushes the review app, JSON report, and gzip to `refs/heads/pages-<run-id>/<run-id>/`. Add `--deploy-pages` to also rebuild and dispatch the GitHub Pages deployment.

The rest of this file describes the currently implemented apply workflow.

To prepare a discovery/planning run from the FHIR checkout:

```bash
bun autofhir/scripts/prepare-discovery-run.ts --run-id <run-id> --fhir-repo /home/jmandel/work/fhir
```

This script parses `source/fhir.ini`, applies `autofhir/meta/wg-source-map.json` when present, scans source paths, forms coherent WG/topic chunks, and freezes the roster in `autofhir/runs/<run-id>/chunks.json`.

To render complete discovery worker prompts from that roster:

```bash
bun autofhir/scripts/render-discovery-prompts.ts --run-id <run-id>
```

For a single chunk:

```bash
bun autofhir/scripts/render-chunk-prompt.ts \
  --run-id <run-id> \
  --chunk-id <chunk-id> \
  --selection autofhir/runs/<run-id>/chunks/pending/<chunk-id>.json
```

The renderer writes the audit prompt to `autofhir/runs/<run-id>/chunks/<chunk-id>/prompt.md` and refuses to overwrite it unless `--force` is passed. It uses implementation-facing prompt/reference files under `autofhir/discovery/`, not the planning copies under `autofhir/meta/`.

To execute a discovery run:

```bash
bun autofhir/scripts/start.ts --run-id <run-id> --concurrency 12
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

For discovery runs, `start.ts` dispatches to `autofhir/scripts/discovery-coordinator.ts`. Completed chunks are accepted only if `validate-plan.ts` passes.

To reconcile and aggregate completed discovery plans:

```bash
bun autofhir/scripts/reconcile-discovery.ts --run-id <run-id>
```

To prepare an issue-mapping run from the local Jira DB:

```bash
bun autofhir/scripts/prepare-issue-mapping-run.ts \
  --run-id <run-id> \
  --fhir-repo /home/jmandel/work/fhir \
  --cutoff 2018-12-27
```

To render issue-mapping prompts:

```bash
bun autofhir/scripts/render-issue-mapping-prompts.ts --run-id <run-id>
```

To execute issue mapping:

```bash
bun autofhir/scripts/start.ts --run-id <run-id> --concurrency 12
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

For issue-mapping runs, `start.ts` dispatches to `autofhir/scripts/issue-mapping-coordinator.ts`. Valid seed decisions are accumulated under `autofhir/runs/<run-id>/issue-observations/`.

To prepare an issue-fixup run from prior issue-mapping observations:

```bash
bun autofhir/scripts/prepare-issue-fixup-run.ts \
  --run-id <run-id> \
  --source-run <issue-mapping-run-id> \
  --fhir-repo /home/jmandel/work/fhir \
  --base-ref master
```

To execute issue fixup:

```bash
bun autofhir/scripts/start.ts --run-id <run-id> --concurrency 4
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

For issue-fixup runs, `start.ts` dispatches to `autofhir/scripts/issue-fixup-coordinator.ts`. Each successful worker publishes exactly one combined-branch commit with `Issue-Fixup-Key: FHIR-XXXXX`, either a real source fix or an empty audit/no-op commit. Prompts include `source/fhir.ini` build-scope hints; workers should edit only active build inputs and should prefer no-op audit commits over optional editorial polish or changes to inactive/stale artifacts.

To prepare and run a second-pass issue-fixup audit:

```bash
bun autofhir/scripts/prepare-issue-fixup-audit-run.ts \
  --run-id <audit-run-id> \
  --source-run <issue-fixup-run-id>

bun autofhir/scripts/start.ts --run-id <audit-run-id> --concurrency 15
bun autofhir/scripts/monitor.ts --run-id <audit-run-id> --interval-sec 120 --tick
```

For issue-fixup audit runs, `start.ts` dispatches to `autofhir/scripts/issue-fixup-audit-coordinator.ts`. Prompts bake in the original issue context, fixup result, generated commit, previous issue-tagged commits, source patch, and `source/fhir.ini` build-scope hints. Audit workers must verify that touched files feed the current build and that source changes are needed for semantic correctness, not just optional clarification.

To prepare and run a discovery-with-autofix issue reconciliation spike:

```bash
bun autofhir/scripts/prepare-issue-reconcile-run.ts \
  --run-id <run-id> \
  --fhir-repo /home/jmandel/work/fhir \
  --base-ref master \
  --cutoff 2018-12-27 \
  --order random \
  --limit 35 \
  --source-run <optional-issue-mapping-run-id>

bun autofhir/scripts/start.ts --run-id <run-id> --concurrency 30
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

For issue-reconcile runs, `start.ts` dispatches to `autofhir/scripts/issue-reconcile-coordinator.ts`. Prompts include seed Jira snapshots, optional prior issue-mapping observations, the community search guide, build-scope hints, and explicit instructions for bounded exploration. Workers must decide the seed and may decide tightly related issues discovered during investigation, but each decided issue must get its own `Issue-Reconcile-Key: FHIR-XXXXX` commit and self-contained JSON result entry.

The default seed pool is Jira workflow status `Applied`/`Published` only. Add `--include-resolved-change-required` only for a deliberately broader experiment that may create source-changing work for WG-resolved-but-not-yet-applied issues.

Issue-reconcile prompts include a FHIR Extension Pack checkout for read-only evidence. The default is `/home/jmandel/work/fhir-extensions`; set `FHIR_EXTENSIONS_REPO` if the checkout lives elsewhere. When older core issues mention extensions, workers should search both core FHIR and the Extension Pack before concluding that core source is stale or incomplete.

## Core Rules

- Keep all coordinator state under `autofhir/`.
- Do not run the coordinator in the foreground during chat. Use `scripts/start.ts`, then immediately run `scripts/monitor.ts --tick` as a foreground blocking tool call so Codex gets heartbeat/event/completion output directly.
- Default concurrency is 12.
- Treat `autofhir/runs/<run-id>/PAUSED` as a hard stop: inspect and resolve before launching more work.
- Runs live under `autofhir/runs/<run-id>/`.
- Chunk rosters are run artifacts. Workflow-specific generators may compute them from abstraction reports, from the FHIR checkout, or from other inputs, but the frozen run roster is what workers receive.
- The abstraction-folder workflow is only one chunk-source adapter: one chunk per abstraction JSON file.
- Every fixed finding must be idempotent by its `Finding-ID`, such as `search-H-001`.
- Jira IDs are transparency/linkability metadata, not idempotency keys.
- Not every Jira mentioned in a finding is addressed by that finding. Workers must distinguish addressed Jiras from contextual/relevant Jiras.
- Only actually addressed Jira IDs belong in commit `Jira:` lines and `jiraIdsAddressed`.
- Non-addressed but relevant Jira IDs may be recorded in result JSON as `otherRelatedJiras: [{ id, relation, description }]`.
- Chunk manifests contain `findings[]` as a lightweight index with title/problem/recommendation and `jiraIdsMentioned`. Mentioned Jira IDs are context hints, not addressed-Jira claims.
- The pipeline is local-only. Do not push to remotes.
- The combined branch history must be linear. Worker branch history is cleaned/replayed so the combined branch gets one normal local commit per fixed finding.
- Commit messages must include:
  - `Finding-ID: <finding-id>`
  - `<addressed-jiras>` only for Jira trackers actually addressed by that finding commit
  - If no Jira is being addressed, a `No addressed Jira:` line plus a multiline `<proposed-jira>` block suitable for filing
  - A multiline `<evidence>` block explaining what each cited file, issue, page, or command establishes.
- Do not allow worker commits to add `Co-authored-by: Copilot ...` trailers.
- Successful and skipped chunks are cleaned up by default. Failed and blocked chunks keep their worktrees for inspection. Set `AUTOFHIR_KEEP_WORKTREES=1` to preserve successful worktrees too.
- Abstraction reports with zero findings are not queued as worker chunks. If a zero-finding chunk somehow exists, the coordinator marks it skipped without launching Copilot.
- Failed work items are retryable. Prefer `recover-run.ts --include-failed` after a stopped coordinator so the workflow adapter can preserve the right retry context and validate any stranded result before requeueing.

## Typical Workflow

From the `fhir-community-search` repository:

```bash
# 1. Prepare a durable run from abstraction change reports.
bun autofhir/scripts/prepare-abstractions-run.ts --run-id r6-abstractions

# 2. Initialize the run's local combined branch ref.
FHIR_REPO=/path/to/HL7/fhir bun autofhir/scripts/init-run.ts --run-id r6-abstractions --base-ref master

# 3. Start the coordinator in the background.
bun autofhir/scripts/start.ts --run-id r6-abstractions

# On slow or unreliable networks, persist a lower run concurrency.
bun autofhir/scripts/start.ts --run-id r6-abstractions --concurrency 2

# Pause cleanly; active workers drain and no new workers launch.
bun autofhir/scripts/pause.ts --run-id r6-abstractions --reason "poor network"

# Resume later, optionally starting the coordinator immediately.
bun autofhir/scripts/resume.ts --run-id r6-abstractions --start

# 4. Immediately start a one-shot monitor tick from Codex in the foreground
# and wait for it to return.
# It exits on the next run event, coordinator exit, or 2-minute heartbeat.
# Relaunch it after every monitor completion while actively coordinating.
bun autofhir/scripts/monitor.ts --run-id r6-abstractions --interval-sec 120 --tick

# 5. Check status whenever needed. This does not wait or sleep.
bun autofhir/scripts/status.ts --run-id r6-abstractions
```

To change concurrency during a live run:

```bash
# Soft: future live-aware coordinator polls run.json and ramps by attrition.
bun autofhir/scripts/set-concurrency.ts --run-id r6-abstractions --concurrency 2

# To stop launches entirely without killing workers, pause the run.
bun autofhir/scripts/pause.ts --run-id r6-abstractions --reason "pause launches"
```

To roll back all progress within a run:

```bash
bun autofhir/scripts/reset-run.ts --run-id r6-abstractions --yes
```

To recover after a coordinator stop or retry failed work items after inspection:

```bash
# Dry run first.
bun autofhir/scripts/recover-run.ts --run-id r6-abstractions --include-failed

# Requeue failed items and finalize/requeue stale running items.
bun autofhir/scripts/recover-run.ts --run-id r6-abstractions --include-failed --yes

# Then restart.
bun autofhir/scripts/start.ts --run-id r6-abstractions
```

## What Workers Are Told

Each Copilot worker prompt tells the agent to:

1. Read the root `SKILL.md` in this `fhir-community-search` repository before editing.
2. Read this `autofhir/SKILL.md`.
3. Read the chunk manifest, change chunk report, and referenced action/research files.
4. Start from the latest run combined branch state at the moment the worker begins.
5. Check commit history for `Finding-ID: <finding-id>` before doing work; this is the dedupe/idempotency key.
6. Investigate ambiguous changes using the local Jira, Zulip, Confluence, and spec tooling instead of guessing.
7. Make a focused spec change in its own FHIR worktree.
8. Publish the chunk locally by creating a temporary integration worktree from the latest combined head, replaying/rebasing its finding-level commits onto that head, resolving conflicts itself, and advancing the combined branch with local `git push . integration-branch:combined-branch`.
9. Retry if the local fast-forward push fails because another worker landed first.
10. Write a machine-readable result JSON for the coordinator, including `journalEntries`.
11. Use structured commit-message blocks: `<addressed-jiras>`, `<proposed-jira>`, and `<evidence>`. Evidence must be explanatory and durable, not just an opaque list of paths or commands.
12. Avoid Copilot coauthor trailers.
13. Cite durable run report paths under `autofhir/runs/<run-id>/reports/*.json`, not transient queue paths such as `chunks/running/*.json`.
14. On retry, inspect the preserved failed worktree/branch/logs, but start editing from the fresh retry worktree based on the latest combined branch. Treat existing `Finding-ID:` commits on the combined branch as already represented unless inspection proves otherwise, and record them as `already-applied` rather than duplicating them.

The chunk manifest is an index, not the full evidence package. `findings[].jiraIdsMentioned` tells workers what to investigate. The worker result decides `jiraIdsAddressed` and `otherRelatedJiras`.

## Coordinator Behavior

The coordinator:

- Moves chunk JSON files through `autofhir/runs/<run-id>/chunks/{pending,running,done,skipped,failed,blocked}`.
- Skips zero-finding chunks without launching a worker.
- Creates one branch/worktree per chunk from the current run combined branch.
- Runs Copilot with JSON streaming, per-task logs, no user prompts, and broad tool/path/URL permissions.
- Verifies completed chunks are present in combined history.
- Appends fixed/skipped/blocked decisions to `autofhir/runs/<run-id>/journal.ndjson`.
- Removes successful/skipped chunk task and integration worktrees plus their temporary branches unless `AUTOFHIR_KEEP_WORKTREES=1`.
- Preserves failed/blocked worktrees and branches for manual inspection.
- On retry, uses retry-specific branch/worktree names such as `autofhir/<run>/<chunk>-retry-1` and `worktrees/tasks/<chunk>-retry-1`, leaving the previous failed worktree and branch in place for inspection.
- Passes retry recovery context to the worker: prior branch/worktree/log/result paths plus combined-branch commits matching the chunk and each finding ID.
- Reads run-level concurrency from `run.json` in the launch loop. With live-concurrency code, `set-concurrency.ts` soft changes are noticed within the coordinator poll interval, default 5 seconds, or when a worker finishes. Downshifts happen by attrition; upshifts launch more work on the next poll. There is no framework hard-kill concurrency mode; use explicit manual intervention plus retry recovery if an immediate stop is needed.
- If a worker reports applied/partial but the combined history lacks the chunk metadata, it marks that chunk failed.
- If any unexpected invariant fails, it writes `autofhir/runs/<run-id>/PAUSED`, sends a best-effort desktop notification, and stops launching new tasks.

## Codex-Side Monitoring

AutofHIR has two separate monitoring channels:

- Desktop notifications: the coordinator sends best-effort OS notifications with `notify-send`, `terminal-notifier`, or `osascript`. These are useful for the human operator, but they do not automatically appear inside the Codex chat.
- Tool-call monitoring: `monitor.ts --tick` is the required Codex-visible monitor. During active coordination, launch it as a foreground `exec_command` with a long enough `yield_time_ms` for the tick to complete, typically a little longer than `--interval-sec`. This intentionally occupies Codex during the wait, but it means Codex actually receives the heartbeat/event/completion output as soon as the tick exits. Relaunch it after each tick while coordinating the run.

The expected Codex pattern is:

```bash
bun autofhir/scripts/start.ts --run-id <run-id>
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

When launching `monitor.ts --tick` from Codex during active coordination, prefer a blocking wait:

```bash
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

Use a tool timeout/yield slightly longer than the interval so the tick exits and returns output directly. This is the only reliable way for Codex to be notified without the user prompting. Do not start background monitor sessions during active coordination; they accumulate and require manual polling. Use short-yield background monitoring only if the user explicitly prioritizes chat responsiveness over immediate notification.

The tick monitor prints:

- `monitor-start ...` immediately, with run status, coordinator pid, chunk counts, and latest journal event.
- `monitor-event ...` when the journal, chunk counts, combined head, or coordinator liveness changes.
- `monitor-heartbeat ...` when the interval expires without another event.
- `monitor-exit ...` when the coordinator exits, followed by the combined branch head.

After any tick monitor completes, inspect its output. If it reports `monitor-exit`, immediately run:

```bash
bun autofhir/scripts/status.ts --run-id <run-id>
```

Then inspect failed/blocked chunks, journal entries, and combined-branch commits before deciding whether to resume, reset, retry chunks, or report completion.

If it reports `monitor-event` or `monitor-heartbeat` and the run is still active, briefly inspect status as needed and launch another `monitor.ts --tick` session. Do not rely on the old long-lived monitor mode for Codex coordination because output can accumulate without surfacing until explicitly polled.

## Important Paths

- `autofhir/runs/<run-id>/run.json`: run manifest and base SHA.
- `autofhir/runs/<run-id>/reports/*.json`: durable copies of chunk reports used for this run.
- `autofhir/runs/<run-id>/chunks/pending/*.json`: queue files.
- `autofhir/runs/<run-id>/seeds/pending/*.json`: issue-mapping queue files.
- `autofhir/runs/<run-id>/journal.ndjson`: shared append-only run journal.
- `autofhir/runs/<run-id>/status/*.status`: per-chunk coordinator status.
- `autofhir/runs/<run-id>/stdout/*.jsonl`: Copilot JSON output.
- `autofhir/runs/<run-id>/stderr/*.log`: Copilot stderr.
- `autofhir/runs/<run-id>/copilot-logs/<chunk>/`: Copilot detailed logs.
- `autofhir/runs/<run-id>/results/<chunk>.json`: worker result contract.
- `autofhir/runs/<run-id>/seed-runs/<key>/result.json`: issue-mapping worker result contract.
- `autofhir/runs/<run-id>/issue-observations/*.ndjson`: accumulated issue-mapping observations.
- `autofhir/runs/<run-id>/worktrees/tasks/<chunk>`: per-chunk FHIR worktrees.
- `autofhir/runs/<run-id>/worktrees/integration/<chunk>-<attempt>`: temporary worker-created integration worktrees.
- `autofhir/runs/<run-id>/worktrees/inspect/`: optional inspection worktrees only; not used for active combined integration.

## Restart And Recovery

The pipeline is intended to be rerunnable.

- `start.ts` refuses to start a second coordinator if the recorded PID is still alive.
- `start.ts --concurrency N` persists a run-level concurrency in `run.json`; the coordinator uses that value on restart unless `CONCURRENCY` is set in the environment.
- `set-concurrency.ts --concurrency N` updates the same run-level setting during a run. It is soft-only: workers are not killed.
- `pause.ts` and `resume.ts` are first-class pause controls. Pause creates `PAUSED` and journals the reason; resume removes it and can restart the coordinator with `--start`.
- If the machine restarts, the coordinator dies, or a run has stale `running` items, recover the durable queue before restarting:

```bash
# Dry run first. This is safe while a coordinator is still live.
bun autofhir/scripts/recover-run.ts --run-id <run-id> --include-failed

# Mutate only after confirming the coordinator is stopped.
bun autofhir/scripts/recover-run.ts --run-id <run-id> --include-failed --yes

# Restart with the workflow-aware starter.
bun autofhir/scripts/start.ts --run-id <run-id>
```

- `recover-run.ts` is workflow-aware:
  - issue mapping: `seeds/*`, validates `seed-runs/<key>/result.json`, accumulates `issue-observations`, and requeues failed seeds when requested.
  - discovery: `chunks/*`, validates `chunks/<chunk>/review/issues.ndjson`, and finalizes valid stranded discovery chunks.
  - apply runs: `chunks/*`, validates result JSON and combined-branch finding history when a stranded valid result exists, otherwise requeues stale running/failed chunks.
- Recovery finalizes `running` items with valid results, moves interrupted `running` items back to `pending`, retries `failed` items only with `--include-failed`, and retries `blocked` items only with `--include-blocked`.
- `recover-run.ts --yes` refuses to mutate if the recorded coordinator pid is still live unless `--allow-live` is explicitly passed.
- The old issue-mapping-specific command is only a compatibility wrapper: `bun autofhir/scripts/recover-issue-mapping.ts ...` calls `recover-run.ts`.
- For a first attempt, if all finding IDs in a chunk are already represented in combined history, the coordinator marks it skipped and journals the skip.
- For a retry attempt, the coordinator still launches a fresh worker even if all finding IDs are already represented, so the worker can verify them and write a complete result/journal with `already-applied` decisions.
- Failed or stale-running work should be recovered with `recover-run.ts`, not by manually moving files. For apply runs, the apply recovery adapter records retry metadata under `autofhir/runs/<run-id>/retries/<chunk>.json`.
- A retry worker starts in a fresh worktree from latest `robo-spec-combined`, with the preserved failed branch/worktree/logs supplied as evidence only. It should not continue editing the stale worktree by default.
- After fixing a paused condition and requeueing any failed chunks you want retried, run `resume.ts --start` or run `resume.ts` followed by `start.ts`.
- To roll back all run progress, use `reset-run.ts --run-id <id> --yes`; it resets the combined branch ref to `run.json.baseSha`, removes run worker/integration worktrees, clears transient logs/status/results, and requeues chunks.

## Environment

Common variables:

- `FHIR_REPO`: required by `init-run.ts`; stored in `run.json` for the coordinator.
- `BASE_REF`: base ref for creating `robo-spec-combined`; default `master`.
- `COMBINED_BRANCH`: optional when preparing the run; default `robo-spec-combined-<run-id>`.
- `CONCURRENCY`: default `12`.
- Run-level `concurrency` in `run.json`: set by `start.ts --concurrency N`; used when `CONCURRENCY` is not set.
- `MODEL`: default `gpt-5.5`.
- `REASONING_EFFORT`: default `xhigh`.
- `JOB_TIMEOUT`: optional timeout passed to each worker.
- `MAX_AUTOPILOT_CONTINUES`: optional Copilot autopilot limit.
- `COORDINATOR_POLL_MS`: live coordinator polling interval for seeing run-level changes such as concurrency; default `5000`.
