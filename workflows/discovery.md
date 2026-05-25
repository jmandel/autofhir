# Discovery workflow

The discovery workflow uses the shared AutofHIR engine for read-only planning runs. It computes chunks from the FHIR spec checkout at run start, launches Copilot CLI workers to inspect current source and community history, then consumes their append-only `review/issues.ndjson` outputs.

## Run-start chunk discovery

Discovery chunks are computed at the start of each run from the FHIR source on disk, then frozen in `autofhir/runs/<run-id>/chunks.json`. Do not maintain a committed point-in-time chunk roster in `autofhir/meta/`.

The current generator is:

```bash
bun autofhir/scripts/prepare-discovery-run.ts --run-id <run-id> --fhir-repo /home/jmandel/work/fhir
```

It should:

1. Capture the pinned spec commit with `git -C <fhir-repo> rev-parse HEAD`.
2. Parse `<fhir-repo>/source/fhir.ini` `[workgroups]` for resource/folder WG ownership.
3. Read `autofhir/meta/wg-source-map.json` for narrative page ownership.
4. Enumerate top-level source paths and assign every path to exactly one chunk.
5. Estimate candidate Jira pool sizes to split oversized chunks once.
6. Write the frozen run roster and per-chunk status files.

The roster is a run artifact. A later run against a different FHIR commit may legitimately produce a different roster.

`source/fhir.ini` is authoritative for resources it lists. When current master contains source folders not listed there, the generator uses conservative filename/topic heuristics and records `mappingNotes`; fix wrong guesses in `wg-source-map.json` rather than in worker prompts.

## Prompt rendering

Discovery worker prompts are rendered from implementation files under `autofhir/discovery/`:

- `autofhir/discovery/chunk-agent-prompt.template.md`
- `autofhir/discovery/analysis-pipeline.md`
- `autofhir/discovery/jira-topic-scan.md`

The `autofhir/meta/` copies are retained as planning/design material. The pipeline should not render worker prompts from `meta/`.

Render prompts with:

```bash
bun autofhir/scripts/render-discovery-prompts.ts --run-id <run-id>
```

For one chunk, use:

```bash
bun autofhir/scripts/render-chunk-prompt.ts \
  --run-id <run-id> \
  --chunk-id <chunk-id> \
  --selection autofhir/runs/<run-id>/chunks/pending/<chunk-id>.json
```

The renderer fills source paths, WG names, cutoff date, spec reference, pinned spec commit, run id, chunk id, and output directory. Prompts are written to `autofhir/runs/<run-id>/chunks/<chunk-id>/prompt.md`. The prompt is self-contained for the operating manual: it inlines `analysis-pipeline.md`, while still pointing workers to root `SKILL.md` and `autofhir/discovery/jira-topic-scan.md`.

Note: current prompts intentionally do not include generated anchor or text hints. Agents derive search terms from owned source paths, current source content, git history, and Jira distinct-anchor queries.

## Execution

Start discovery runs through the shared start script:

```bash
bun autofhir/scripts/start.ts --run-id <run-id> --concurrency 12
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

For `workflow=discovery`, `start.ts` launches `autofhir/scripts/discovery-coordinator.ts`. The discovery coordinator:

- moves chunk manifests through `chunks/pending`, `chunks/running`, `chunks/done`, and `chunks/failed`
- renders `chunks/<chunk-id>/prompt.md` if it does not already exist
- launches Copilot CLI from the community-search repo root
- expects worker output in `chunks/<chunk-id>/review/issues.ndjson`
- validates the review stream before accepting the chunk

It is read-only with respect to the FHIR checkout. It does not create FHIR worktrees or commits.

## Recovery

If the coordinator stops with chunks still in `running`, or if failed chunks should be retried, use generic recovery:

```bash
# Dry run first.
bun autofhir/scripts/recover-run.ts --run-id <run-id> --include-failed

# Mutate only after confirming no coordinator is live.
bun autofhir/scripts/recover-run.ts --run-id <run-id> --include-failed --yes

# Restart.
bun autofhir/scripts/start.ts --run-id <run-id>
```

For discovery, recovery validates `chunks/<chunk>/review/issues.ndjson`; valid stranded chunks are finalized as done, interrupted running chunks are requeued, and failed chunks are requeued only with `--include-failed`.

## Validation

Validate a completed chunk with:

```bash
bun autofhir/scripts/validate-plan.ts --run-id <run-id> --chunk-id <chunk-id>
```

The validator checks `candidates.tsv` coverage and the append-only `review/issues.ndjson` stream. Every candidate key in `candidates.tsv` must have exactly one `jira-candidate` row. Candidate rows with `scope: "out-of-scope"` are audited but excluded from mentioned counts. Proposed no-existing-Jira findings are represented as `record_type: "proposed-jira"` rows.

## Reconciliation

After some or all chunks complete, run:

```bash
bun autofhir/scripts/reconcile-discovery.ts --run-id <run-id>
```

This writes aggregate reports under `autofhir/runs/<run-id>/reports/`:

- `validation.json`
- `coverage.json`
- `untouched.json`
- `drift.json` and `drift.md`
- `apply-queue.json`
- `open-recommendations.md`
- `new-problems.json` and `new-problems.md`
- `unclear.json`

It also writes follow-up descriptors under `autofhir/runs/<run-id>/reconciliation/`:

- `untouched-followup-queue.json`

## Chunk shape

A discovery chunk is:

- one owning work group
- exclusive source paths
- expected Jira pool size

Tickets are not exclusive. The same Jira can be surfaced by multiple chunks; reconciliation uses `mentioned_keys`, out-of-scope review records, and untouched-ticket follow-up to converge.

## Worker duties

Discovery workers are read-only. They do not stage, edit, or commit in the FHIR checkout.

Each worker must read:

1. root `SKILL.md` for Jira/Zulip/Confluence search mechanics
2. the inlined operating manual in its rendered `prompt.md`
3. `autofhir/discovery/jira-topic-scan.md` if it needs to refresh detailed query tactics after compaction

Workers use the FHIR checkout directly for current source. `spec:locate`/`spec:resolve` are for older release comparisons, not current master.

## Required source-history pass

At run start, the roster only knows current paths. A worker must inspect git history for every owned source path before finalizing its query strategy. The goal is to discover old filenames, moved pages, renamed elements, old terminology, and implementation commits that Jira comments may reference.

Useful commands:

```bash
git -C /home/jmandel/work/fhir log --follow --name-status -- source/<path>
git -C /home/jmandel/work/fhir log --all --name-only -- source/<path>
git -C /home/jmandel/work/fhir log --all -G '<distinctive old-or-new term>' -- source/<path>
git -C /home/jmandel/work/fhir blame source/<file>
```

Record findings in `spec-notes.md` and feed old names/terms into Phase 2 searches. When history points to a specific Jira, PR, or commit, include it in the ticket pool or explain why it is out of scope.

## Output and validation

Each worker writes the artifacts described in `autofhir/discovery/analysis-pipeline.md`. The primary output is `review/issues.ndjson`; there is no required `plan.md`, `plan.json`, `README.md`, or `review/notes.md`.

## Reconciliation and handoff

After first-pass chunks complete, workflow-specific reconciliation computes untouched Jira keys, launches follow-up chunks for residual WG pools, and aggregates:

- `drift.md`
- `apply-queue.json`
- `open-recommendations.md`
- `new-problems.md`
- `coverage.json`

`drift.md` and `apply-queue.json` become upstream inputs for the apply workflow.
