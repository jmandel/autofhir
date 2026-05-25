# Run orchestration plan

How a complete autofhir analysis run executes end-to-end with a fixed degree of parallelism. This is the dispatcher's runbook. Operates on the artifacts and contracts defined in `analysis-pipeline.md`, `agent-partitioning.md`, and `chunk-agent-prompt.template.md`.

The aim is **steady throughput**: keep N agents running at all times (default N=12), recover automatically from agent failures, drive every chunk to a passing `plan.json`, then drive `universe - global_mentioned` to zero via follow-up waves.

---

## Pipeline shape

```
Wave 0:  Build chunk roster        (mechanical, minutes, sequential)
              │
              ▼
Wave 1:  Per-chunk analysis        (LLM agents, parallel @ N, hours-days)
              │
              ▼
Wave 2:  Misroute application       (mechanical, minutes)
              │
              ▼
Wave 3:  Delta re-runs              (LLM, parallel @ N, only chunks affected by reroutes)
              │
              ▼
Wave 4:  Untouched reconciliation   (LLM, parallel @ N, one agent per WG with residual)
              │
              ▼
            Loop Wave 2..4 until untouched stable, then exit.
              │
              ▼
Wave 5:  Aggregate & report         (mechanical, minutes)
```

Waves 1, 3, 4 are the parallel LLM phases. Everything else is dispatcher code.

---

## Run-level state

All run state lives under `autofhir/runs/<run-id>/`:

```
autofhir/runs/<run-id>/
  run.json                       # config + status (current wave, started_at, ...)
  chunks.json                    # the roster from Wave 0
  PAUSED                         # presence-of-file = hard stop
  chunks/<chunk-id>/             # per-chunk artifacts (see analysis-pipeline.md)
    prompt.md                    # rendered prompt the agent received
    selection.json               # chunk descriptor as launched
    status.json                  # current status, agent-id, attempts, timings
    plan.json                    # populated when complete (validated)
    plan.md                      # ditto, human-readable
    ... (rest per analysis-pipeline.md)
  waves/
    wave-0-roster.log
    wave-1-status.json           # snapshot updated on each agent transition
    wave-2-reroutes.json
    wave-3-deltas.json
    wave-4-untouched/<wg>/...    # follow-up chunks (same shape as chunks/<chunk-id>/)
    wave-5-report.md             # final aggregate report
  reports/
    drift.md                     # §1 across all chunks, severity-sorted
    apply-queue.json             # §2 with dependency topo sort
    open-recommendations.md      # §3 grouped by WG
    new-problems.md              # §4 deduped across chunks
    coverage.json                # universe, mentioned, untouched, misrouted
  journal.ndjson                 # append-only event log: every state transition
```

### `run.json` schema

```json
{
  "run_id": "pilot-2",
  "started_at": "2026-05-21T18:00:00Z",
  "config": {
    "concurrency": 12,
    "spec_reference": "current",
    "cutoff": "2018-12-27",
    "spec_repo": "/home/jmandel/work/fhir",
    "spec_commit_pinned": "4db8a35f2e",
    "agent_model": "opus",
    "max_chunk_attempts": 3,
    "max_reroute_hops": 2,
    "max_reconciliation_loops": 3
  },
  "current_wave": "wave-1",
  "wave_history": ["wave-0", "wave-1"]
}
```

### Per-chunk `status.json` schema

```json
{
  "chunk_id": "fhir-i--bundle",
  "state": "queued|running|complete|failed|degraded",
  "attempts": 1,
  "max_attempts": 3,
  "agent_id": "ae6ed347b9184119c",
  "started_at": "2026-05-21T18:05:00Z",
  "ended_at": null,
  "validation": { "schema_ok": null, "mentioned_keys_invariant_ok": null, "errors": [] }
}
```

Chunk state machine:

```
queued → running → complete            (happy path)
queued → running → failed              (transient failure)
failed → queued                        (retry, attempts++)
running → degraded                     (agent self-marked, no retry, validation may still pass)
complete → reopened                    (Wave 3 delta re-run)
```

---

## Wave 0 — Build chunk roster

Dispatcher code, no LLMs. Sequential. Minutes.

Steps:

1. **Sanity-check inputs.** Verify `/home/jmandel/work/fhir` exists and is on master. Capture `git rev-parse HEAD` into `run.json.config.spec_commit_pinned`. The pinned SHA defines "current" for the whole run; do not let the dispatcher track moving master.
2. **Run `autofhir/scripts/prepare-discovery-run.ts`.** It parses `source/fhir.ini` `[workgroups]`, reads `autofhir/meta/wg-source-map.json` when present, enumerates top-level `source/` paths, forms WG/topic chunks, and writes the frozen run roster.
3. **Review mapping notes.** `fhir.ini` is authoritative when present. Current source folders absent from `fhir.ini` are assigned by conservative heuristics and annotated in `mappingNotes`; correct bad guesses in `wg-source-map.json`.
4. **Validate coverage.** Every top-level path under `source/` must land in exactly one chunk. Fail loudly on unclaimed or doubly-claimed paths.
5. **Sub-split heuristic.** For each candidate chunk, estimate `ticket_pool × ~3000 tokens + source_size_tokens`. If > 400k, attempt a one-level sub-split; if still too big, mark for manual partitioning and abort.
6. **Estimate ticket pool size per chunk** via SQL (anchors + WG-bounded NA/many). Inform sub-split.
7. **Write `chunks.json`** — the immutable run roster.
8. **Initialize each chunk's `status.json` to `queued`.**
9. **Append a `wave_started` event to `journal.ndjson`.**

Failure modes: missing fhir.ini, missing master branch, source path conflict, oversized chunk that can't auto-split. All are dispatcher-fatal — no point launching agents on a broken roster.

---

## Wave 1 — Per-chunk analysis (parallel @ N)

The main LLM work. Scheduler is a simple bounded worker pool.

### Scheduler loop

```
while there is any chunk in {queued, failed-with-attempts-remaining}:
  if PAUSED file exists: stop launching new chunks; continue status monitoring
  running = chunks where state == "running"
  if |running| >= concurrency:
    wait for a worker exit or coordinator poll tick; continue
  pick next chunk: state == "queued", smallest estimated_pool first
                   (small first surfaces signal quickly; reorder if you have other preferences)
  launch agent for that chunk in background:
    render prompt from chunk-agent-prompt.template.md + chunk descriptor
    write prompt.md and selection.json to chunks/<chunk-id>/
    spawn agent (e.g. claude-code Agent tool, model = run.json.config.agent_model)
    set status.json.state = "running", attempts++
    record agent_id
  on worker exit:
    if agent returned successfully:
      validate plan.json (schema + mentioned_keys invariant)
      if validation passed:
        set status.json.state = "complete"
        journal: chunk_complete
      else:
        if attempts < max_attempts:
          set status.json.state = "failed"  # retry path
          record validation errors
        else:
          set status.json.state = "failed"  # terminal
          journal: chunk_terminal_failure
    else:
      if attempts < max_attempts: set state = "failed"
      else: state = "failed" terminal
exit loop when no chunk is in queued or retriable-failed
```

### Launching agents

Use Copilot CLI child processes launched by the shared AutofHIR engine. The coordinator records stdout/stderr/result paths under the run directory and notices worker exits in its launch loop. Codex-visible monitoring comes from `monitor.ts --tick`, not from long-lived background terminal sessions.

### Pacing

The pool is bounded by `run.json.config.concurrency`. There's no rate limiting beyond that — agents are independent and their work is read-only.

### Retries

Transient retries are allowed up to `max_chunk_attempts` (default 3). A failed agent's previous artifacts are preserved in `chunks/<chunk-id>/attempts/<n>/` for forensics, and the next attempt starts fresh.

A chunk marked `degraded` by the agent itself (because a phase exceeded budget) is not retried — the agent completed and reported a partial result. The validation step accepts degraded chunks if `plan.json` parses and the `mentioned_keys` invariant holds.

### When Wave 1 ends

When every chunk is in `complete` or `failed (terminal)`. Failed terminals are surfaced in the wave summary and the run continues — Wave 2..4 will still build a meaningful coverage report; the gaps just won't be analyzed.

---

## Wave 2 — Misroute application

Dispatcher code, minutes. Sequential.

Steps:

1. Read every `chunks/<chunk-id>/plan.json`.
2. For each `misrouted` entry, validate `suggested_chunk` exists in `chunks.json`.
3. For each valid reroute, increment a per-ticket hop counter. If a ticket has already hopped `max_reroute_hops` times, send it to the human review queue and skip.
4. Apply the reroute: append to the suggested chunk's "deferred queue" file (`chunks/<suggested>/deferred-from-misroute.json`).
5. Compile the set of chunks that received reroutes — these need a delta re-run in Wave 3.

Wave 2 output is a list of `(chunk_id, set of newly-deferred ticket keys)`.

---

## Wave 3 — Delta re-runs (parallel @ N)

Same scheduler as Wave 1, but only for chunks that received reroutes. The agent prompt for these is identical except for an explicit instruction at the top:

> Delta re-run. Your previous `plan.json` is at `<path>`. You have N additional tickets to classify, listed in `deferred-from-misroute.json`. Update `plan.json` to include them; do not re-do work on tickets you already classified. Validate that `mentioned_keys` still includes everything in `issues.tsv` plus the new tickets.

This is the only place where an agent is allowed to mutate prior output. Validation is the same; if it fails, the delta is rejected and the original plan stays.

When Wave 3 ends, control loops back to Wave 2 (in case new misroutes were generated). Cap at `max_reconciliation_loops` (default 3) to prevent runaway.

---

## Wave 4 — Untouched reconciliation (parallel @ N)

When the misroute loop has stabilized, compute the untouched set:

```
universe = SELECT keys FROM jira/issues
           WHERE created_at >= cutoff
             AND in-scope FHIR-core spec
global_mentioned = ⋃ plan.json[i].mentioned_keys
untouched = universe - global_mentioned
```

Group `untouched` by `work_group`. For each WG with non-empty residual:

1. Create a follow-up chunk: `waves/wave-4-untouched/<wg>/` with the same layout as a regular chunk.
2. Render a variant of the chunk-agent prompt:
   - Source paths = the union of source paths owned by this WG (mechanically derived from `fhir.ini` + `wg-source-map.json`).
   - Ticket pool = exactly the residual `untouched` keys for this WG; no broad query phase.
   - Phase 2 in the prompt is replaced with "Read the provided ticket list. You do not need to construct queries; the candidate set is fixed."
   - Phase 5 (bulk review) and Phase 6 (synthesis) run normally.
3. Launch using the same scheduler at concurrency N.

When all WG residual chunks complete, validate, then loop back to Wave 2 once more (these chunks can also produce misroutes). Stop when:

- `untouched` empties, OR
- two consecutive reconciliation passes do not reduce `untouched`, OR
- `max_reconciliation_loops` exceeded.

Residual residual (tickets that nobody classifies) goes to the human review queue at the end of the run.

---

## Wave 5 — Aggregate & report

Dispatcher code, minutes. Sequential.

Compiles `reports/`:

- `drift.md` — every `applied_drift` entry from every chunk, severity-sorted, with chunk attribution. This is the canonical handoff to the autofhir worker pipeline.
- `apply-queue.json` — every `ready_to_apply` entry, topo-sorted by `dependencies`. Each entry sized to become one finding in the worker pipeline.
- `open-recommendations.md` — `open_recommendations` grouped by WG, with §3 tradeoff matrices preserved.
- `new-problems.md` — `new_problems` from all chunks, deduplicated by similarity of title+location, with chunk attribution.
- `coverage.json` — universe count, mentioned count, untouched count, misroute count, residual to human queue.

Also writes a one-page `wave-5-report.md` summary suitable for the human reviewer.

---

## Concurrency, monitoring, and recovery

### Maintaining parallelism

The scheduler is a closed feedback loop: it launches new agents as soon as old ones complete, up to `concurrency`. There's no rate limiting on agent launch beyond the pool size. Wave 1 throughput in steady state is `concurrency / mean_agent_wall_time`. The pilot ran ~6h for one chunk; with N=12 and ~250 chunks, expect Wave 1 to take ~5–7 days of wall-clock if no parallel speedup beyond the pool. (Pilot was an unusual case; smaller WGs will run much faster.)

### Notifications and monitoring

The coordinator sends best-effort desktop notifications for the human operator. Codex should not rely on those. During active coordination, run:

```bash
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

This one-shot foreground tick exits on the next run event, coordinator exit, or heartbeat timeout. Relaunch it after each return while actively supervising a run.

### Journal & resumability

`journal.ndjson` is the source of truth for run progress. Every state transition appends a line:

```json
{"t":"2026-05-21T18:05:01Z","event":"chunk_launched","chunk_id":"fhir-i--bundle","attempt":1,"agent_id":"..."}
{"t":"2026-05-21T18:11:03Z","event":"chunk_complete","chunk_id":"fhir-i--bundle","validation":"ok"}
{"t":"2026-05-21T18:11:04Z","event":"wave_progress","running":11,"queued":237,"complete":1}
```

On dispatcher restart: re-read `chunks/*/status.json` and `journal.ndjson`. Any chunk in `running` whose agent is no longer alive (process gone, no completion event) gets demoted to `failed` with the attempt counter unchanged (so retries don't double-count an orphan). Then resume the scheduler.

### PAUSED file

Creating `autofhir/runs/<run-id>/PAUSED` is a hard stop. The scheduler completes whatever's currently running but launches no new agents until the file is removed. Use for emergency stops, manual investigation, or rolling restarts of the dispatcher.

### Failure containment

A chunk that fails terminal does not block the run. The dispatcher logs it, surfaces it in the wave summary, and continues. Wave 5 reports list failed chunks explicitly so a human can re-launch them later (`autofhir/scripts/relaunch-chunk.ts <run-id> <chunk-id>`) without restarting the whole run.

### Cost containment

Each agent's prompt is bounded by the chunk descriptor; the agent decides its own depth of work within the analysis-pipeline budget. Hard cap per chunk: `max_chunk_attempts × per-attempt_token_budget`. Cap at the model layer if needed. The dispatcher does not need to enforce a hard token cap because the per-attempt time-box in `analysis-pipeline.md` already bounds work.

---

## Idempotency and re-running

Re-running a chunk:

1. Move its `chunks/<chunk-id>/` to `chunks/<chunk-id>/attempts/<n>/` (preserves forensics).
2. Reset `status.json.state = "queued"`, attempts = 0.
3. The scheduler picks it up on the next loop.

Re-running an entire wave: not directly supported. Re-do specific chunks instead. If a global re-do is needed, start a new run-id; runs are cheap to create.

Re-running with a new spec commit: bump `run.json.config.spec_commit_pinned`, set every chunk's state back to `queued`, and re-run. The pinned SHA is part of every chunk's prompt, so agents naturally re-verify against the new master.

---

## Bootstrap script outline

A single entrypoint `autofhir/scripts/run.ts <run-id> [--concurrency N] [--cutoff D] [--spec-reference current|published]` should:

1. Create `autofhir/runs/<run-id>/`.
2. Write `run.json` from CLI args + defaults.
3. Execute Wave 0 (build roster) inline.
4. Enter the scheduler loop for Wave 1.
5. Drive Waves 2..4 to fixpoint.
6. Execute Wave 5 and exit.

Long-running waves should run the coordinator in the background using `autofhir/scripts/start.ts` so the operator can issue control commands (`pause.ts`, `resume.ts`, `status.ts`, retry commands) from a separate session.

A companion `autofhir/scripts/monitor.ts --run-id <run-id> --tick` prints a Codex-visible one-shot status/event/heartbeat report. Read-only; never touches state.

---

## Open implementation items

These are not blockers for the agent-side prompts (which are now rewritten and runnable in single-chunk pilot mode), but are required for a full parallel run:

1. **`autofhir/meta/wg-source-map.json`** — page → WG overlay. Mechanical-with-spot-checks effort, ~1 hour. Without it, narrative-page chunks can't be created.
2. **Chunk sizing refinement for `prepare-discovery-run.ts`** — estimate Jira pool sizes and split oversized chunks before launch.
3. **`autofhir/scripts/validate-plan.ts`** — schema + `mentioned_keys` invariant. Called after every agent completes.
4. **`autofhir/scripts/scheduler.ts`** — the bounded worker pool, event listener, retry logic.
5. **`autofhir/scripts/reconcile.ts`** — Wave 2/4 logic (misroute apply, untouched compute, follow-up agent spawning).
6. **`autofhir/scripts/aggregate.ts`** — Wave 5 report generation.
7. **`autofhir/scripts/relaunch-chunk.ts`** — single-chunk replay for failed terminals.
8. **`autofhir/scripts/monitor.ts`** — live status viewer.

The pilot run (`autofhir/runs/pilot-1/topics/g2-code-systems/`) demonstrated the per-chunk analysis works end-to-end. The orchestration listed above is the infrastructure to run it at scale.
