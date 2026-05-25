# Apply workflow

The apply workflow uses the shared AutofHIR engine to farm out concrete spec edits. A chunk is a change report. In the current R6 abstraction run, each chunk comes from one abstraction JSON file and contains zero or more findings.

## Chunk contract

Each chunk manifest is an index, not the full evidence package. It should include:

- `chunkId`
- durable report paths under the run directory
- source action/research files
- `findings[]` with finding id, title/problem/recommendation, and mentioned Jira hints

The worker determines which findings are actually fixed, skipped, blocked, or already applied.

## Worker commit rules

Workers create one commit per fixed finding. Do not squash a whole chunk into one commit. The combined branch must remain linear; worker commits are replayed/rebased so they land as ordinary local commits.

Each commit message must include:

- `Finding-ID: <finding-id>`
- `<addressed-jiras>` only for Jira trackers this commit actually implements, completes, or directly verifies
- `No addressed Jira:` plus `<proposed-jira>` when no existing Jira is addressed
- `<evidence>` with durable, explanatory evidence, not a raw path list

Jiras mentioned in a finding are investigation hints. They may be addressed, supporting background, conflicting decisions, related open work, or context only. Only addressed Jiras go in the commit message's addressed-Jira block. Other relevant Jiras may go in result JSON as:

```json
{
  "otherRelatedJiras": [
    {
      "id": "FHIR-12345",
      "relation": "supporting-decision|conflicting-decision|context-only|related-open-work",
      "description": "Brief explanation of how this Jira relates."
    }
  ]
}
```

Do not add Copilot coauthor trailers.

## Local integration

The pipeline is local-only. Workers must not push to remotes.

Workers start from the latest combined branch when launched, work on a private local worktree/branch, then publish by rebasing/replaying their finding commits onto the latest combined branch and advancing the local combined ref with a non-checkout fast-forward update. If another worker wins the race, the worker rebases again and retries. Merge conflicts are resolved inside the worker's private worktree.

## Idempotency

`Finding-ID` is the idempotency key. Before editing, and again before publishing, workers inspect combined branch history for the finding ids in their chunk. Existing finding commits are recorded as `already-applied` or `skipped` rather than duplicated.

## Result contract

Workers write a result JSON under `autofhir/runs/<run-id>/results/<chunk>.json`. The result must include outcome, per-finding decisions, addressed Jira IDs, proposed Jira blocks, related Jira notes when useful, and journal entries for the coordinator to append.

Failed and blocked chunks preserve worktrees/logs for retry. Successful and skipped chunks are cleaned up unless `AUTOFHIR_KEEP_WORKTREES=1`.

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

For apply runs, recovery validates a stranded result JSON and verifies fixed finding IDs are present in combined-branch history before finalizing. Interrupted running chunks are requeued. Failed chunks are requeued only with `--include-failed`, and recovery records retry metadata under `autofhir/runs/<run-id>/retries/<chunk>.json` so the next worker can inspect prior branch/worktree/log/result context.
