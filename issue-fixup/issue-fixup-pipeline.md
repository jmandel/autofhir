# Issue Fixup Pipeline

This workflow starts from Jira issues that previous issue-mapping runs judged as `not-fully-applied`. Your task is narrower and more concrete than issue discovery: decide whether the current FHIR source really needs a correction for the assigned issue, then publish exactly one local commit for that issue.

## Goal

For the assigned seed issue:

1. Re-read the precomputed context in the prompt, including prior observations, Jira snapshots, and any related community evidence.
2. Inspect the current FHIR source and relevant git history.
3. Decide whether the issue was actually misapplied, incompletely applied, superseded, correctly applied after later changes, or too ambiguous to change automatically.
4. Publish one commit to the combined branch:
   - a real fix commit if source edits are needed
   - an empty no-op commit if no source edits are needed or the issue is ambiguous
5. Write the result JSON requested by the prompt.

The empty commit is intentional. It gives the combined branch a durable audit record for every issue processed by this workflow.

## How This Issue Got Here

The precomputed context comes from earlier issue-mapping runs. Those runs asked agents to evaluate Jira issues against the current source and record observations. They were useful triage, but they are not authoritative findings:

- an observation may be incomplete, overconfident, or wrong
- the same issue may appear once as a seed issue and elsewhere as a related issue
- multiple observations may agree, disagree, or emphasize different source locations
- an observation may call something `not-fully-applied` because it saw a wording mismatch, a stale generated artifact, an omitted related page, or a real semantic problem

Treat all prior observations as leads and evidence to evaluate. Your job is to get to the bottom of what really happened and decide whether the current source is correct in the totality of the evidence.

## Evidence Standard

Do not apply a fix just because an earlier mapping observation said `not-fully-applied`. Treat that observation as a lead.

Before committing, check the complete current story:

- the seed Jira issue and its real Jira workflow status
- any Jira issues referenced by the seed, related observations, git commits, Zulip threads, or Confluence minutes
- later Jira resolutions that may have reversed, refined, or superseded the seed
- commits that explicitly mention the seed issue
- commits that do not mention the seed but changed the same elements, pages, examples, terminology, or generated artifacts
- current source files and any other spec locations where the same rule or wording should apply
- module pages, resource pages, StructureDefinition source, search parameter bundles, examples, operation definitions, terminology files, and narrative pages as relevant

For applied or published issues, the central question is not whether the current source literally matches the original issue summary or resolution prose. The question is whether the current source is correct after considering the seed issue plus any later or related decisions. Slight wording differences, refactoring, renamed elements, or a different representation are fine when the meaning is preserved and implementers would understand the same rule.

Flag a problem only when there is an important semantic deviation that would lead to a different understanding of what the specification means, an obviously forgotten source location, or an inconsistency across related pages/resources/definitions. Do not spend the commit on tiny editorial differences unless they create real ambiguity, broken links, stale normative guidance, or divergent conformance expectations.

## Jira Workflow Status

HL7 Jira often contains draft resolution text before the issue is actually resolved. A `resolution` value such as `Persuasive` and a proposed resolution description do not by themselves mean the work group has made a final decision.

Use Jira workflow status as the primary signal:

- `Resolved - change required`, `Applied`, and `Published` are actionable decision states.
- `Resolved - No Change` records a no-change decision.
- `Submitted`, `Triaged`, `Waiting for Input`, `Deferred`, and similar non-final states are not final decisions even if resolution text is present.
- `Duplicate` issues are usually not independent work items. Follow the duplicate target when it is relevant.

## Decisions

Use one of these result statuses:

- `fixed`: you changed source and published a commit.
- `no-change`: you published an empty commit because the current source is already correct when the whole issue family is considered.
- `ambiguous`: you published an empty commit because the issue needs a human or work-group decision before source changes are safe.
- `blocked`: you could not complete the investigation, write the result, or publish a commit. This should be rare.

## Commit Message

Every successful issue-fixup item must leave exactly one commit on the combined branch with this trailer:

```text
Issue-Fixup-Key: FHIR-XXXXX
```

For source fixes, use a normal non-empty commit. For `no-change` or `ambiguous`, use `git commit --allow-empty`.

Use this commit message shape:

```text
FHIR-XXXXX: Brief imperative or audit summary

Explain what the issue asked for, what the current source now says, and why this commit changes source or intentionally changes nothing.

AutofHIR-Run: <run-id>
Issue-Fixup-Key: FHIR-XXXXX
Issue-Fixup-Decision: fixed|no-change|ambiguous

<related-jiras>
FHIR-YYYYY: relationship - why it matters
</related-jiras>

<evidence>
- Jira: FHIR-XXXXX status/resolution and what it establishes.
- Source: repo-relative file path and what was checked or changed.
- Git: commit(s), blame, or pickaxe result and what it establishes.
- Community: Zulip/Confluence evidence if relevant.
- Verification: command(s) run and relevant outcome.
</evidence>
```

Do not add Copilot coauthor trailers. Do not mention Jira issues as addressed unless the commit actually resolves or directly audits that issue. Related issues can be listed in `<related-jiras>`.

## Local Integration

Do not push to any remote. Integration is local-only.

Work on your private branch/worktree. After your issue commit is ready, replay it onto the latest combined branch and publish with a local non-checkout fast-forward update. If another worker lands first, rebase/replay and retry. Resolve conflicts inside your private or temporary integration worktree. If conflict resolution requires a new spec decision, publish an empty `ambiguous` commit if possible; otherwise return `blocked`.

## Result JSON

Write the JSON file named in the prompt. Use this shape:

```ts
type IssueFixupStatus = "fixed" | "no-change" | "ambiguous" | "blocked";

interface IssueFixupResult {
  schema_version: "issue-fixup-result-v1";
  run_id: string;
  chunk_id: string;
  issue_key: string;
  status: IssueFixupStatus;
  branch: string;
  commit?: {
    sha: string;
    subject: string;
    empty: boolean;
  };
  decision: {
    issue_key: string;
    status: IssueFixupStatus;
    summary: string;
    reasoning: string;
    recommendation: string;
    source_changes: string[];
    related_jiras: {
      key: string; // Jira-style key, e.g. FHIR-XXXXX or UP-XXXXX
      relationship: "duplicate" | "supersedes" | "superseded-by" | "same-change-family" | "supporting-decision" | "conflicting-decision" | "background" | "later-change" | "unclear";
      note: string;
    }[];
    evidence_items: {
      id: string;
      kind: "jira" | "zulip" | "confluence" | "source" | "git" | "published-spec" | "command" | "web";
      locator: string;
      url?: string;
      ref?: Record<string, string | number>;
      summary: string;
      supports: string[];
    }[];
    checks: string[];
    confidence: "high" | "medium" | "low";
  };
  journal_entries: {
    issue_key: string;
    decision: IssueFixupStatus;
    summary: string;
    reason: string;
    commit_sha?: string;
  }[];
  notes?: string[];
}
```

The `recommendation` should help a future human or agent pick up the issue quickly. It should explain why your chosen path is right, what was fixed or left alone, and what to do next if further work is needed.
