# Issue Mapping Workflow

Issue mapping is a Jira-first read-only AutofHIR workflow. It is intended to replace large chunk-level adjudication with small seed issue runs.

## Shape

1. `prepare-issue-mapping-run.ts` builds one global FHIR-core Jira candidate pool.
2. The coordinator launches one seed worker per Jira issue.
3. Each worker decides the seed issue and may opportunistically decide closely related issues it actually researched.
4. The coordinator validates `result.json` and appends every valid decision as an issue observation.
5. Later reducer scripts can group observations by Jira issue, target chunk, source path, and next step to create downstream spec-work chunks.

## Prepare

```bash
bun autofhir/scripts/prepare-issue-mapping-run.ts \
  --run-id <run-id> \
  --fhir-repo /home/jmandel/work/fhir \
  --cutoff 2018-12-27
```

Useful canary:

```bash
bun autofhir/scripts/prepare-issue-mapping-run.ts \
  --run-id issue-map-canary \
  --fhir-repo /home/jmandel/work/fhir \
  --limit 5
```

The candidate pool is written to:

- `autofhir/runs/<run-id>/candidate-pool/issues.tsv`
- `autofhir/runs/<run-id>/candidate-pool/issues.json`

Seed queue files are written to `autofhir/runs/<run-id>/seeds/pending/`.

## Render Prompts

```bash
bun autofhir/scripts/render-issue-mapping-prompts.ts --run-id <run-id>
```

Single seed:

```bash
bun autofhir/scripts/render-issue-seed-prompt.ts \
  --run-id <run-id> \
  --seed-key FHIR-XXXXX \
  --seed-file autofhir/runs/<run-id>/seeds/pending/FHIR-XXXXX.json
```

Each prompt inlines:

- The seed Jira snapshot.
- The issue-mapping operating manual.
- The root FHIR community-search `SKILL.md` minus setup.

The prompt intentionally does not include guessed nearby candidate lists. Workers must discover related issues by using Jira links, exact phrase searches, artifact/page/WG searches, source history, Zulip, and Confluence.

## Execute

```bash
bun autofhir/scripts/start.ts --run-id <run-id> --concurrency 12
bun autofhir/scripts/monitor.ts --run-id <run-id> --interval-sec 120 --tick
```

For issue-mapping runs, `start.ts` dispatches to `issue-mapping-coordinator.ts`.

## Recovery

If the coordinator stops with seeds still in `running`, or if failed seeds should be retried, use generic recovery:

```bash
# Dry run first.
bun autofhir/scripts/recover-run.ts --run-id <run-id> --include-failed

# Mutate only after confirming no coordinator is live.
bun autofhir/scripts/recover-run.ts --run-id <run-id> --include-failed --yes

# Restart.
bun autofhir/scripts/start.ts --run-id <run-id>
```

For issue mapping, recovery finalizes stranded valid `seed-runs/<key>/result.json` files by accumulating their observations, requeues interrupted running seeds without valid results, and requeues failed seeds only when `--include-failed` is passed. Skipped seeds mean another seed already emitted a high-confidence related decision for that key; they are covered, not ignored.

## Validate One Result

```bash
bun autofhir/scripts/validate-issue-mapping-result.ts \
  --run-id <run-id> \
  --seed-key FHIR-XXXXX \
  --write-result
```

The required worker output is:

```text
autofhir/runs/<run-id>/seed-runs/FHIR-XXXXX/result.json
```

Validation errors are written beside it as `validation.json` when `--write-result` is used.

## Observation Accumulation

The coordinator treats every valid decision as an observation, not a canonical final truth.

Per issue:

```text
autofhir/runs/<run-id>/issue-observations/FHIR-XXXXX.ndjson
```

All observations:

```text
autofhir/runs/<run-id>/issue-observations/all.ndjson
```

Duplicate observations are expected and preserved. A later reducer can union target chunks/source paths and decide whether human review is needed.

## Worker Contract

The seed worker must:

- Decide the seed issue.
- Write exactly one JSON result.
- Explore broadly enough to understand the seed.
- Keep the work bounded.
- Avoid bulk classification.
- Only emit opportunistic decisions for related issues whose snapshots it read and understood.
- Use `related_but_not_decided` for background issues.

The worker may inspect current source and git history in the FHIR checkout, and may use Jira, Zulip, and Confluence when Jira/source evidence is ambiguous.
