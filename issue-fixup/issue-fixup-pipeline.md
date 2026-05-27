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

## Build Scope and Edit Threshold

Before editing a file, confirm that it is actually part of the current FHIR build or otherwise feeds a built artifact:

- Treat `source/fhir.ini` as the first build-scope authority for resources, profiles, work groups, and many generated artifacts. Active entries matter; commented entries usually indicate retired, disabled, or out-of-build artifacts.
- A file merely existing under `source/` is not enough. For profile files, look for an active `[profiles]` entry or another active source reference. A commented profile entry such as `;foo=profiles/foo.profile.xml` is strong evidence that edits to that profile are not current-spec fixes.
- For resource folders listed in active `[resources]`, source files in that folder usually feed the build. For narrative/module pages, confirm they are referenced by the relevant resource/module page machinery or by current source includes when the path is not obviously active.
- Do not rely on the local `publish/` folder as current evidence. It is generated output and may be stale. Use source/config/git history first; use `build.fhir.org` only as an external verification aid when needed.
- Checked-in generated artifacts, diagrams, or SVGs may be stale or unused. If a generated-looking artifact is the only source of the apparent problem, verify that the build actually consumes it before editing.

Apply a high correctness threshold. This workflow is for changes needed to make the current built specification correct, not for optional polish:

- Prefer `no-change` when the current spec already conveys the correct rule through an existing link, included section, generated definition, or nearby normative text.
- Do not add redundant explanatory prose simply because it is accurate or adjacent to the topic. Restating guidance in multiple places can create long-term maintenance drift unless the local page is currently misleading without the restatement.
- Judge each candidate edit by whether it changes implementer understanding of the current specification in a necessary way. Do not keep a hunk only because it is helpful, tidy, or phrased more nicely.
- For mixed candidate changes, keep only hunks that fix a real semantic problem. Drop hunks that are redundant, speculative, out of build scope, or broader than the evidence supports.
- Make source edits for real semantic problems: wrong cardinality, missing constraint, stale contradiction, deprecated mechanism still recommended as current, inconsistent parallel artifacts, broken generated/source relationship, broken link, or omitted source location that changes implementer understanding.

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

Use this commit message shape. Keep the section labels exactly as shown so downstream audit and review tools can parse and compare results:

```text
FHIR-XXXXX: Brief imperative or audit summary

Issue request:
What the Jira asked for, its final workflow status, and the decision/resolution that mattered.

Initial application:
How the issue appears to have been applied before this fixup, including explicit Jira-tagged commits and implicit git-history discoveries touching the relevant source. If there was no prior application, say so.

Additional context:
Later or related Jira decisions, source refactors, generated artifacts, branch state, community discussion, build-scope findings, or spec moves that affect how the issue should be interpreted now.

AutoFHIR fixup:
What this commit did, or why it intentionally made no source change.

Recommendation:
Whether to keep this commit as-is, revisit with human/work-group review, or do follow-up work, and why.

AutofHIR-Run: <run-id>
Issue-Fixup-Key: FHIR-XXXXX
Issue-Fixup-Decision: fixed|no-change|ambiguous

<related-jiras>
FHIR-YYYYY: relationship - why it matters
</related-jiras>

<evidence>
- E1 Jira FHIR-XXXXX: brief status/resolution summary. Learned: what this establishes for the decision.
- E2 Source path/to/file.ext:line: brief source summary. Learned: why this source check matters.
- E3 Git abc1234: brief commit/history summary. Learned: what changed before this fixup.
- E4 Community Zulip/Confluence locator: brief discussion/minutes summary, or explicit negative search summary. Learned: whether community evidence changes the conclusion.
- E5 Verification command/query: brief result. Learned: what confidence it provides.
</evidence>

<evidence-manifest>
[
  {
    "id": "E1",
    "kind": "jira",
    "locator": "FHIR-XXXXX",
    "url": "https://jira.hl7.org/browse/FHIR-XXXXX",
    "snapshot_path": "contexts/FHIR-XXXXX/jira/FHIR-XXXXX.md",
    "ref": { "jira_key": "FHIR-XXXXX" },
    "summary": "One-sentence summary of what the issue says.",
    "learned": "One-sentence explanation of what this proves or rules out.",
    "supports": ["issue_request", "fixup"]
  },
  {
    "id": "E2",
    "kind": "command",
    "locator": "Zulip and Confluence search for FHIR-XXXXX plus key terms",
    "command": "bun run zulip:search fts 'FHIR-XXXXX key terms' --limit 10; bun run confluence:search refs jira FHIR-XXXXX",
    "summary": "No directly relevant or conflicting community hits were found.",
    "learned": "There is no discovered community record that changes the Jira/source conclusion.",
    "supports": ["absence_of_conflict", "confidence"]
  }
]
</evidence-manifest>
```

For `fixed`, the message should make clear why each edited source file is in build scope and why each hunk is necessary. For `no-change` or `ambiguous`, the message should be a durable audit explanation, not a terse skip note. Do not add Copilot coauthor trailers. Do not mention Jira issues as addressed unless the commit actually resolves or directly audits that issue. Related issues can be listed in `<related-jiras>`.

The `<evidence>` block is for human scanning. The `<evidence-manifest>` block must be valid JSON and should mirror the important result JSON evidence items. Keep it concise, but include enough to link back to the original Jira/Zulip/Confluence/source/git/command evidence. Use `snapshot_path` for pre-baked or worker-saved snapshots when available. If you searched Zulip or Confluence and found nothing relevant, include a `kind: "command"` evidence row with the query, result summary, and what the absence of evidence means. If community evidence was relevant, cite the original URL and snapshot path if one exists.

Use these fictional examples for consistent evidence population:

```json
[
  {
    "id": "E1",
    "kind": "jira",
    "locator": "FHIR-90001",
    "url": "https://jira.hl7.org/browse/FHIR-90001",
    "snapshot_path": "contexts/FHIR-90001/jira/FHIR-90001.md",
    "ref": { "jira_key": "FHIR-90001" },
    "summary": "Applied/Persuasive with Modification issue requiring ResourceX.status to use a required binding to Example Status.",
    "learned": "This is final WG intent and establishes the target binding strength for the current source check.",
    "supports": ["issue_request", "fixup"]
  },
  {
    "id": "E2",
    "kind": "confluence",
    "locator": "FHIR-I Minutes 2025-05-20 page 123456789",
    "url": "https://confluence.hl7.org/display/FHIRI/2025-05-20+FHIR-I+Minutes",
    "snapshot_path": "contexts/FHIR-90001/confluence/123456789.md",
    "ref": { "confluence_page_id": 123456789 },
    "summary": "Minutes record a 7-0-0 motion to accept FHIR-90001 and clarify that ResourceY should not be changed.",
    "learned": "This confirms the approved scope is ResourceX only and prevents an overbroad edit.",
    "supports": ["additional_context", "source_change_scope"]
  },
  {
    "id": "E3",
    "kind": "zulip",
    "locator": "#implementers > ResourceX status binding",
    "url": "https://chat.fhir.org/#narrow/stream/179166-implementers/topic/ResourceX.20status.20binding",
    "snapshot_path": "contexts/FHIR-90001/zulip/implementers--ResourceX-status-binding.md",
    "ref": { "stream": "implementers", "topic": "ResourceX status binding", "message_id": 123456789 },
    "summary": "The responsible editor explains that the base resource remains extensible because local codes must still be possible.",
    "learned": "This supports leaving the base binding unchanged and fixing only the profile-specific text.",
    "supports": ["additional_context", "recommendation"]
  },
  {
    "id": "E4",
    "kind": "command",
    "locator": "Negative community search for FHIR-90001 and ResourceX status binding",
    "command": "bun run zulip:search fts 'FHIR-90001 ResourceX status binding' --limit 10; bun run confluence:search refs jira FHIR-90001",
    "query": "FHIR-90001 ResourceX status binding",
    "result_count": 0,
    "summary": "No directly relevant Zulip or Confluence hits were found.",
    "learned": "No discovered community record changes the Jira/source conclusion, so confidence depends on Jira, source, and git evidence.",
    "supports": ["absence_of_conflict", "confidence"]
  }
]
```

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
      snapshot_path?: string;
      command?: string;
      query?: string;
      result_count?: number;
      ref?: Record<string, string | number>;
      summary: string;
      learned: string;
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
