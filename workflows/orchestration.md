# AutofHIR orchestration

AutofHIR runs one generic orchestration model for different FHIR automation workflows. A workflow supplies the chunk generator, worker prompt, result schema, validators, and completion/reconciliation steps. The shared engine supplies durable run state, bounded Copilot CLI execution, pause/resume, soft concurrency, retry, monitoring, and journaling.

## Shared model

A run is the total workset being attempted. Chunks are independently launchable units inside that run. The run owns a frozen chunk roster, worker artifacts, result files, a journal, and any workflow-specific reports under `autofhir/runs/<run-id>/`.

The generic engine should keep these responsibilities workflow-neutral:

- Create and validate `run.json`.
- Freeze the chunk roster at run start.
- Move chunks through queued/running/done/skipped/failed/blocked states.
- Launch Copilot CLI workers with rendered prompts.
- Enforce concurrency from `run.json`, with soft live updates.
- Respect `PAUSED`: active workers drain, no new workers launch.
- Append coordinator events to `journal.ndjson`.
- Preserve failed attempts and pass retry context to later workers.
- Provide `status.ts`, `monitor.ts --tick`, `pause.ts`, `resume.ts`, `set-concurrency.ts`, and workflow-aware recovery commands.

Workflow code owns the parts that differ:

- How chunks are discovered.
- What files workers may read or edit.
- What output contract workers must produce.
- How result JSON is validated.
- Whether chunks publish commits, write plans, or only report findings.
- What reconciliation/aggregation happens after the first pass.

## Monitoring contract

Codex-visible monitoring is done with one-shot foreground ticks:

```bash
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

The tick exits on the first interesting event, coordinator exit, or heartbeat timeout. While actively coordinating a run, relaunch the tick after each return. Desktop notifications are best-effort human notifications only; they are not a reliable Codex callback.

## Recovery and retry contract

Use the generic recovery command after a coordinator stop, machine restart, or before retrying failed work:

```bash
bun autofhir/scripts/recover-run.ts --run-id <run-id> --include-failed
bun autofhir/scripts/recover-run.ts --run-id <run-id> --include-failed --yes
bun autofhir/scripts/start.ts --run-id <run-id>
```

The command dry-runs by default. With `--yes`, it refuses to mutate state if the recorded coordinator pid is still live unless `--allow-live` is explicitly passed.

Recovery is adapter-driven:

- `running` item with a valid result: finalize through the workflow adapter.
- `running` item without a valid result: move back to `pending`.
- `failed` item: requeue only when `--include-failed` is passed.
- `blocked` item: requeue only when `--include-blocked` is passed.

Retries start fresh from current run state. Preserved failed branches, worktrees, logs, and result files are evidence, not the default editing base. Worker prompts must explicitly tell retries to inspect prior artifacts and also inspect durable run state so already-completed work is recorded as already applied rather than duplicated.

## Workflow docs

- `workflows/apply.md` describes the spec-edit application workflow, where workers make one commit per fixed finding and publish locally into the combined branch.
- `workflows/discovery.md` describes the read-only discovery/planning workflow, where workers analyze current FHIR source plus Jira history and produce append-only `review/issues.ndjson` outputs for downstream application runs.
- `workflows/issue-mapping.md` describes the Jira-first issue mapping workflow, where workers adjudicate one seed issue and may add closely related issue observations.
- `workflows/issue-fixup.md` describes the issue-fixup workflow, where workers process issue-mapping rows assessed as not fully applied and publish one fix or audit commit per Jira issue.
