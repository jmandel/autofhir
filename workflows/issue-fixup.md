# Issue Fixup Workflow

Issue fixup is the follow-on workflow for issue-mapping rows assessed as `not-fully-applied`. It creates one queued item per Jira key, gives the worker precomputed context from prior mapping observations and snapshots, and requires exactly one combined-branch commit per issue.

Use it when the question is no longer "is this issue relevant?" but "does current source need a correction, and if so what edit is justified?"

## Prepare

```bash
bun autofhir/scripts/prepare-issue-fixup-run.ts \
  --run-id issue-fixup-smoke \
  --source-run issue-mapping-full-post-r4-created-newest-v1 \
  --fhir-repo /home/jmandel/work/fhir \
  --base-ref master \
  --limit 20
```

By default, preparation scans all issue-mapping runs with `issue-observations/all.ndjson` if no `--source-run` is supplied. It selects every issue that was assessed as `not-fully-applied` in at least one observation. Use `--source-run` or `--source-runs` to constrain the input, and `--no-snapshots` only for fast dry scaffolding.

Preparation writes:

- `candidate-pool/issues.tsv`
- `candidate-pool/issues.json`
- `contexts/<FHIR-key>/context.json`
- best-effort `contexts/<FHIR-key>/jira/*.md`, `zulip/*.md`, and `confluence/*.md`
- `chunks/pending/<FHIR-key>.json`
- `run.json` with `workflow: "issue-fixup"`

It also initializes the local combined branch from `--base-ref` if it does not already exist.

## Run

```bash
bun autofhir/scripts/start.ts --run-id issue-fixup-smoke --concurrency 4
bun autofhir/scripts/monitor.ts --run-id issue-fixup-smoke --tick --interval-sec 120
```

The coordinator renders a fresh prompt for each issue at launch time, creates a private worktree/branch from the combined branch, and gives the worker the context plus publishing recipe.

Each successful worker must publish one commit containing:

```text
Issue-Fixup-Key: FHIR-XXXXX
```

This applies to both real fixes and empty no-op audit commits.

## Output

Each issue writes:

- `results/<FHIR-key>.json`
- `status/<FHIR-key>.status`
- `stdout/<FHIR-key>.jsonl`
- `stderr/<FHIR-key>.log`
- `copilot-logs/<FHIR-key>/...`

The result schema is documented in `autofhir/issue-fixup/issue-fixup-pipeline.md`.

## Recovery

Use the generic recovery path:

```bash
bun autofhir/scripts/recover-run.ts --run-id issue-fixup-smoke --include-failed
bun autofhir/scripts/recover-run.ts --run-id issue-fixup-smoke --include-failed --yes
bun autofhir/scripts/start.ts --run-id issue-fixup-smoke
```

Recovery validates stranded result JSON and confirms the combined branch contains `Issue-Fixup-Key: <issue>`. Failed or interrupted items can be requeued with retry metadata, so the next worker can inspect prior work without duplicating a published audit commit.
