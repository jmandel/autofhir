# Issue Reconcile Pipeline

This workflow combines issue discovery with source reconciliation. A worker starts from one FHIR-core Jira issue that has reached the `Applied` or `Published` workflow status, investigates the current specification and surrounding history, and may publish a small set of one-issue commits when the same investigation clearly resolves related issues. `Resolved - change required` issues can be included only when the run was explicitly prepared in that broader mode.

## Goal

For the assigned seed issue:

1. Re-read the prompt, seed Jira snapshot, precomputed context, and operating guides.
2. Explore the relevant source, git history, Jira neighborhood, Zulip, and Confluence evidence deeply enough to understand the current state.
3. Decide the seed issue.
4. Opportunistically decide a small number of tightly related Jira issues when they are already part of the same evidence trail and only a little more checking is needed.
5. Publish one commit per decided issue to the combined branch:
   - a normal source-changing commit when the current spec needs a correction
   - an empty audit commit when the current spec is already correct, the issue belongs outside the current build, or human review is needed
6. Write the result JSON requested by the prompt.

The seed decision is mandatory unless the run is genuinely blocked. Related decisions are optional. Do not turn one seed into an unbounded neighborhood sweep.

## How This Issue Got Here

The seed came from a filtered FHIR-core Jira pool after R4. By default, that pool is limited to issues whose Jira workflow status is `Applied` or `Published`, and it avoids unresolved, duplicate, and resolved-no-change issues unless the run was explicitly prepared otherwise.

The prompt may also contain observations from earlier issue-mapping runs. Those observations are useful leads, not authoritative conclusions:

- an observation may be incomplete, overconfident, or wrong
- the same issue may appear once as a seed and elsewhere as a related issue
- multiple observations may agree, disagree, or emphasize different source locations
- an observation may call something `not-fully-applied` because it saw a wording mismatch, a stale generated artifact, an omitted related page, or a real semantic problem

Treat all prior observations as context to evaluate. Your job is to decide what the current specification should say after considering the totality of Jira decisions, source history, and current build scope.

## Exploration Standard

Explore broadly, but keep the search bounded by relevance.

Start with the seed Jira and source locations implied by its related page/artifact fields. Then check:

- current source files and nearby generated/source inputs
- module pages, resource pages, StructureDefinition source, search parameter bundles, examples, operation definitions, terminology files, and narrative pages as relevant
- git commits that explicitly mention the seed issue
- git commits that do not mention the seed but changed the same elements, pages, examples, terminology, or generated artifacts
- Jira issues referenced by the seed, commits, comments, source comments, Zulip, Confluence minutes, or prior observations
- later Jira resolutions that may have reversed, refined, narrowed, or superseded the seed
- Zulip and Confluence discussions when they are likely to clarify intent or application history

Do not keep expanding just because search returns more issue keys. Decide additional issues only when they are tightly connected to the seed, already encountered in the evidence path, and you have enough evidence to make a self-contained decision for each one. As a rule of thumb, deciding 1-5 issues from one seed is reasonable; deciding more than about 8 means you are probably doing a cluster sweep and should stop or explain why the issues are inseparable.

## Evidence Standard

For applied or published issues, the central question is not whether the current source literally matches the original issue summary or resolution prose. The question is whether the current source is correct after considering the seed issue plus any later or related decisions.

Slight wording differences, refactoring, renamed elements, or a different representation are fine when the meaning is preserved and implementers would understand the same rule.

Flag a problem only when there is an important semantic deviation that would lead to a different understanding of what the specification means, an obviously forgotten source location, or an inconsistency across related pages/resources/definitions. Do not spend a commit on tiny editorial differences unless they create real ambiguity, broken links, stale normative guidance, or divergent conformance expectations.

## Build Scope and Edit Threshold

Before editing a file, confirm that it is actually part of the current FHIR build or otherwise feeds a built artifact:

- Treat `source/fhir.ini` as the first build-scope authority for resources, profiles, work groups, and many generated artifacts. Active entries matter; commented entries usually indicate retired, disabled, or out-of-build artifacts.
- A file merely existing under `source/` is not enough. For profile files, look for an active `[profiles]` entry or another active source reference. A commented profile entry such as `;foo=profiles/foo.profile.xml` is strong evidence that edits to that profile are not current-spec fixes.
- For resource folders listed in active `[resources]`, source files in that folder usually feed the build. For narrative/module pages, confirm they are referenced by the relevant resource/module page machinery or by current source includes when the path is not obviously active.
- Core FHIR no longer owns every extension that older Jira issues or historical source mention. The worker prompt's run context gives the local FHIR Extension Pack checkout path. When a tracker mentions an extension URL, `StructureDefinition/<extension-name>`, or an extension that appears to have disappeared from core, search that repository as read-only evidence before concluding that core source is stale or incomplete.
- If an extension definition has intentionally moved to the Extension Pack, do not treat its absence from the core FHIR checkout as a missing core source change. If the only needed source edit belongs in the Extension Pack, record `external-repo` or `human-review` with an empty audit commit in the core combined branch, and explain the recommended extension-pack work.
- Do not rely on the local `publish/` folder as current evidence. It is generated output and may be stale. Use source/config/git history first; use `build.fhir.org` only as an external verification aid when needed.
- Checked-in generated artifacts, diagrams, or SVGs may be stale or unused. Do not make a source-changing commit whose only edited files are generated-looking diagram/SVG artifacts such as `source/<resource>/<resource>.svg`. If the only apparent remaining issue is in such a diagram/SVG, record `no-change` when the authoritative source already conveys the correct semantics, or `human-review` when a human explicitly needs to decide whether diagram artifacts are in scope. Prefer editing the authoritative XML, spreadsheet, narrative, terminology, or operation source that generates/defines the spec behavior.

Apply a high correctness threshold. This workflow is for changes needed to make the current built specification correct, not for optional polish:

- Prefer `no-change` when the current spec already conveys the correct rule through an existing link, included section, generated definition, or nearby normative text.
- Do not add redundant explanatory prose simply because it is accurate or adjacent to the topic. Restating guidance in multiple places can create long-term maintenance drift unless the local page is currently misleading without the restatement.
- Judge each candidate edit by whether it changes implementer understanding of the current specification in a necessary way. Do not keep a hunk only because it is helpful, tidy, or phrased more nicely.
- For mixed candidate changes, keep only hunks that fix a real semantic problem. Drop hunks that are redundant, speculative, out of build scope, or broader than the evidence supports.
- Make source edits for real semantic problems: wrong cardinality, missing constraint, stale contradiction, deprecated mechanism still recommended as current, inconsistent parallel artifacts, broken generated/source relationship, broken link, or omitted source location that changes implementer understanding.

## Jira Workflow Status

HL7 Jira often contains draft resolution text before the issue is actually resolved. A `resolution` value such as `Persuasive` and a proposed resolution description do not by themselves mean the work group has made a final decision.

Use Jira workflow status as the primary signal:

- `Applied` and `Published` are the default source-edit seed states for this workflow.
- `Resolved - change required` is a real work-group decision, but it may not have been applied or published yet. Treat it as context in default runs; only create source-changing work for these issues when the run was explicitly prepared to include them or when human instructions make that scope clear.
- `Resolved - No Change` records a no-change decision.
- `Submitted`, `Triaged`, `Waiting for Input`, `Deferred`, and similar non-final states are not final decisions even if resolution text is present.
- `Duplicate` issues are usually not independent work items. Follow the duplicate target when it is relevant, but do not treat the duplicate itself as a final source-edit decision.

## Related Issue Decisions

You may decide a related issue when all of these are true:

- it was discovered naturally while investigating the seed
- its Jira state is final enough and in scope for the decision you are making
- it concerns the same artifact, source location, policy, terminology family, or closely coupled behavior
- you inspected the current source and any later decisions needed to decide it
- you can write a self-contained commit message and JSON explanation for that issue

Do not decide a related issue when it is only background, only mentioned in passing, unresolved, not in the run's source-edit scope, governed by a different work group question, or would require a separate search path. In default runs, a related `Resolved - change required` issue is usually context for interpreting `Applied`/`Published` work, not a separate fixup commit.

If a related issue is already represented on the combined branch with `Issue-Reconcile-Key: FHIR-XXXXX`, do not publish another commit for it. You may still cite it as related evidence for the seed.

## Decisions

Use one of these per-issue statuses:

- `fixed`: source changed and a non-empty commit was published.
- `no-change`: an empty audit commit was published because the current source is already correct when the whole issue family is considered.
- `human-review`: an empty audit commit was published because the issue needs human or work-group review before source changes are safe.
- `external-repo`: an empty audit commit was published because the issue belongs outside this FHIR source checkout or outside the current build.
- `blocked`: no commit could be published for this issue because the investigation, edit, or integration could not be completed. This should be rare.

The top-level run status should be `complete` if at least the seed was decided and all listed issue results are valid. Use `blocked` only when the seed cannot be decided or the result cannot be published/written.

## Commit Message

Every successful per-issue result must leave exactly one commit on the combined branch with this trailer:

```text
Issue-Reconcile-Key: FHIR-XXXXX
```

For source fixes, use a normal non-empty commit. For `no-change`, `human-review`, or `external-repo`, use `git commit --allow-empty`.

Use this commit message shape. Keep the section labels exactly as shown so downstream audit and review tools can parse and compare results:

```text
FHIR-XXXXX: Brief imperative or audit summary

Issue request:
What the Jira asked for, its final workflow status, and the decision/resolution that mattered.

Initial application:
How the issue appears to have been applied before this reconciliation, including explicit Jira-tagged commits and implicit git-history discoveries touching the relevant source. If there was no prior application, say so.

Additional context:
Later or related Jira decisions, source refactors, generated artifacts, branch state, community discussion, build-scope findings, or spec moves that affect how the issue should be interpreted now.

AutoFHIR reconciliation:
What this commit did, or why it intentionally made no source change.

Recommendation:
Whether to keep this commit as-is, revisit with human/work-group review, or do follow-up work, and why.

AutofHIR-Run: <run-id>
Issue-Reconcile-Key: FHIR-XXXXX
Issue-Reconcile-Decision: fixed|no-change|human-review|external-repo

<related-jiras>
FHIR-YYYYY: relationship - why it matters
</related-jiras>

<evidence>
- E1 Jira FHIR-XXXXX: brief status/resolution summary. Learned: what this establishes for the decision.
- E2 Source path/to/file.ext:line: brief source summary. Learned: why this source check matters.
- E3 Git abc1234: brief commit/history summary. Learned: what changed before this reconciliation.
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
    "supports": ["issue_request", "reconciliation"]
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

For `fixed`, the message should make clear why each edited source file is in build scope and why each hunk is necessary. For empty audit commits, the message should still be a durable explanation of why no source change is correct or why human review is needed. Do not add Copilot coauthor trailers. Do not mention Jira issues as addressed unless the commit directly resolves or audits that issue. Related issues can be listed in `<related-jiras>`.

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
    "supports": ["issue_request", "reconciliation"]
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

## Examples

Use these as patterns only. The issue IDs are fictional.

### Related issue worth deciding

Seed `FHIR-90001` asks to rename an element in ResourceA. While checking git history, you find `FHIR-90002` applied the matching search parameter rename, and both commits touched the same files. Current source missed the search parameter but has the element rename. If you verify `FHIR-90002` is final and current source is wrong, publish one `fixed` commit for `FHIR-90001` and a second `fixed` commit for `FHIR-90002`, each with its own self-contained message.

### Related issue not worth deciding

Seed `FHIR-90003` asks about terminology binding text. A Zulip thread mentions `FHIR-90004`, but that issue is still Triaged and concerns a broader terminology policy. Cite it as background if useful, but do not publish a `FHIR-90004` commit.

### No source change

Seed `FHIR-90005` says to remove a deprecated mechanism from a local page. Current source already links to a section that contains the full current mechanism, and the local page is not misleading without duplicating that section. Publish an empty `no-change` commit explaining why adding redundant local prose would be unnecessary and potentially harder to maintain.

## Local Integration

Do not push to any remote. Integration is local-only.

Work on your private branch/worktree. After your per-issue commits are ready, replay them onto the latest combined branch and publish with a local non-checkout fast-forward update. If another worker lands first, rebase/replay and retry. Resolve conflicts inside your private or temporary integration worktree. If conflict resolution requires a new spec decision, publish an empty `human-review` commit for the issue if possible; otherwise return `blocked`.

Before committing or publishing a related issue, check whether another worker already landed it:

```bash
git -C "$SPEC_CHECKOUT_ROOT" log --fixed-strings --grep="Issue-Reconcile-Key: FHIR-XXXXX" --format='%H %s' -n 5 "$COMBINED_BRANCH"
```

## Result JSON

Write the JSON file named in the prompt. Use this shape:

```ts
type IssueReconcileStatus = "fixed" | "no-change" | "human-review" | "external-repo" | "blocked";

interface IssueReconcileResult {
  schema_version: "issue-reconcile-result-v1";
  run_id: string;
  seed_key: string;
  status: "complete" | "blocked";
  branch: string;
  issue_results: {
    issue_key: string;
    role: "seed" | "opportunistic";
    status: IssueReconcileStatus;
    commit?: {
      sha: string;
      subject: string;
      empty: boolean;
    };
    summary: string;
    issue_request: string;
    initial_application: string;
    additional_context: string;
    reconciliation: string;
    recommendation: string;
    source_changes: string[];
    related_jiras: {
      key: string;
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
  }[];
  related_not_decided: {
    key: string;
    reason: string;
  }[];
  journal_entries: {
    issue_key: string;
    role: "seed" | "opportunistic";
    decision: IssueReconcileStatus;
    summary: string;
    reason: string;
    commit_sha?: string;
  }[];
  notes?: string[];
}
```

The seed must appear in `issue_results`. Every non-blocked issue result must have a matching commit on the combined branch. The `recommendation` should help a future human or agent pick up the issue quickly. It should explain why your chosen path is right, what was fixed or left alone, and what to do next if further work is needed.
