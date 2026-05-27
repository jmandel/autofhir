# Issue Fixup Audit Pipeline

This workflow reviews commits produced by the issue-fixup pipeline. It does not edit the FHIR source and does not publish new git commits. Its output is an audit JSON record that says whether the generated commit should be kept, tweaked, dropped, or sent for human review, plus a replacement commit message in a consistent format.

## Goal

For the assigned issue-fixup commit:

1. Re-read the baked issue context, Jira snapshots, community snapshots, original fixup result, and generated commit.
2. Inspect the current combined FHIR source and relevant git history.
3. Decide whether the generated commit is semantically justified in the totality of the evidence.
4. Always write a full replacement commit message in the required format.
5. Write the requested audit result JSON.

The replacement message is required for every decision. Do not encode message rewriting in the decision name.

## Decisions

Use exactly one of these decisions:

- `keep`: The generated commit is correct enough to retain. Use the replacement commit message.
- `tweak`: The generated commit is directionally right but needs source, metadata, or wording changes before it should be retained. The replacement commit message should describe the corrected intended state.
- `drop`: The generated commit should not be retained. The replacement commit message should still explain why, for audit/history.
- `human-review`: The result is uncertain, policy-sensitive, or depends on a work-group/spec decision. The replacement commit message should summarize the evidence and decision point.

## Evidence Standard

Treat the first issue-mapping result and the issue-fixup result as useful leads, not as authoritative findings. Your job is to get to the bottom of what happened.

Check the complete story:

- the seed Jira and its real workflow status
- Jira issues referenced by the seed, generated commit, prior observations, source comments, Zulip threads, or Confluence minutes
- commits explicitly tagged with the issue key
- commits that do not mention the key but clearly touch the same tracker item, source element, example, terminology artifact, operation definition, narrative page, or generated artifact
- later or related Jira decisions that refined, superseded, reversed, or made the original request moot
- the current source state on the generated combined branch
- module pages, resource pages, StructureDefinition source, search parameter bundles, examples, operation definitions, terminology files, and narrative pages as relevant

For applied or published Jira issues, do not require a literal wording match to the Jira resolution. Slight wording changes, refactoring, renamed files, or a different representation are acceptable when implementers would understand the same rule. Flag a commit only when there is an important semantic deviation, an obviously missed source location, an inconsistency across related artifacts, a broken generated/source relationship, or a change that lacks support in the issue evidence.

Before deciding to keep a source-changing commit, confirm that the touched artifact is actually part of the current FHIR build or otherwise feeds a built artifact:

- Treat `source/fhir.ini` as the first build-scope authority for resources, profiles, work groups, and many generated artifacts. Active entries matter; commented entries usually indicate retired, disabled, or out-of-build artifacts.
- A file merely existing under `source/` is not enough. For profile files, look for an active `[profiles]` entry or another active source reference. A commented profile entry such as `;foo=profiles/foo.profile.xml` is strong evidence that edits to that profile are not current-spec fixes.
- For resource folders listed in active `[resources]`, source files in that folder usually feed the build. For narrative/module pages, confirm they are referenced by the relevant resource/module page machinery or by current source includes when the path is not obviously active.
- Do not rely on the local `publish/` folder as current evidence. It is generated output and may be stale. Use source/config/git history first; use `build.fhir.org` only as an external verification aid when needed.
- Checked-in generated artifacts, diagrams, or SVGs may be stale or unused. If a generated-looking artifact is the only file touched, verify that the build actually consumes it before recommending `keep`.

Also apply a high correctness threshold. The fixup pipeline is for source changes needed to make the current built specification correct, not for optional polish:

- Prefer no source change when the current spec already conveys the correct rule through an existing link, included section, generated definition, or nearby normative text.
- Do not add redundant explanatory prose beside a link simply because the linked target says something useful. Restating linked guidance can create long-term maintenance drift unless the local page is currently misleading without the restatement.
- For mixed commits, choose `tweak` when some hunks fix a real semantic problem but other hunks are redundant, speculative, out of build scope, or broader than the evidence supports. In `source_tweaks_needed`, say which parts to keep, remove, or rewrite.
- Judge each hunk by whether it changes implementer understanding of the current specification in a necessary way. Do not keep a hunk only because it is helpful, accurate, or adjacent to the topic.
- Keep or recommend a tweak when the generated commit fixes a real semantic problem: a wrong cardinality, missing constraint, stale contradiction, deprecated mechanism still recommended as current, inconsistent parallel artifacts, broken generated/source relationship, or omitted source location that changes implementer understanding.
- Drop or send to human review when the generated commit is merely nice-to-have clarification, editorial duplication, or a debatable documentation preference not required by the Jira decision or current source state.

HL7 Jira can contain draft resolution fields before the workflow status is final. Use Jira workflow status as the primary signal:

- `Resolved - change required`, `Applied`, and `Published` are actionable decision states.
- `Resolved - No Change` records a no-change decision.
- `Submitted`, `Triaged`, `Waiting for Input`, `Deferred`, and similar non-final states are not final decisions even when resolution text is present.
- Duplicate issues are usually not independent work items. Follow the duplicate target when relevant.

## Additional Exploration

The prompt includes baked snapshots, but you are expected to search further when needed. Use the local FHIR community-search checkout for Jira/Zulip/Confluence/spec searches and the inspection worktree for source/git checks.

Useful command shapes:

```bash
# From the community-search repository root
cd <repo-root>
bun run jira:search snapshot FHIR-XXXXX
bun run jira:search fts "\"exact phrase\" ResourceName"
bun run zulip:search fts "\"FHIR-XXXXX\""
bun run zulip:search snapshot "stream" "topic name"
bun run confluence:search refs jira FHIR-XXXXX
bun run confluence:search fts "\"FHIR-XXXXX\""
bun run confluence:search snapshot PAGE_ID

# From the FHIR inspection worktree
rg "exact phrase" source path/to/file
git log --all --fixed-strings --grep=FHIR-XXXXX --format='%H %ad %an %s' --date=iso
git log --all -S "exact source text" -- path/to/file
git show --stat --patch COMMIT -- path/to/file
git blame -L start,end -- path/to/file
rg -n "issue-specific-term|resource-name|profile-file-name" source/fhir.ini source -g '!publish/**'
```

Do not fish indefinitely. Search broadly enough to validate or reject the generated commit, then stop when additional searches are unlikely to change the audit decision. Prefer precise anchors: Jira key, element path, exact source phrase, commit SHA, resource name, artifact URL, and ballot/comment wording.

## Audit Examples

Use these examples as decision patterns. They are intentionally not real Jira IDs.

### Disabled profile file

A generated commit changes `source/profiles/example.profile.xml`, but `source/fhir.ini` has only `;example=profiles/example.profile.xml` under `[profiles]`, there are no active source references, and the current CI build has no corresponding profile page. The commit should usually be `drop`, because it edits an inactive artifact. The replacement message should explain that the historical requirement may have been valid for an old published profile, but this file is not a live current-build source.

### Redundant local explanation

A generated commit adds a local explanation of a rule that is already clearly defined in the referenced canonical section. If the local page does not contradict that rule or send readers toward the wrong behavior, the new explanation may be accurate but still unnecessary. Prefer `drop` for a wholly redundant commit, or `tweak` for a mixed commit where other hunks fix a real semantic gap.

### Local contradiction needs a source fix

A generated commit removes prose saying "use OldElement" from a page that also links to current guidance saying `OldElement` is deprecated. The local page would otherwise continue to tell implementers to use the wrong mechanism. This is a good `keep` or `tweak` candidate because it removes a semantic contradiction, not merely because it adds helpful context.

## Replacement Commit Message

Always produce a full replacement commit message in this exact section order:

```text
FHIR-XXXXX: Concise summary

Issue request:
What the Jira asked for, its final workflow status, and the decision/resolution that mattered.

Initial application:
How the issue appears to have been applied before AutoFHIR, including explicit Jira-tagged commits and implicit git-history discoveries touching the relevant source.

Additional context:
Later or related Jira decisions, source refactors, generated artifacts, branch state, community discussion, or spec moves that affect how the issue should be interpreted now.

AutoFHIR fixup:
What this generated commit did, or why it intentionally made no source change.

Recommendation:
Whether to keep, drop, tweak, or send for human review, and why.

AutofHIR-Run: <source issue-fixup run id>
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
    "supports": ["issue_request", "decision"]
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

Use `Initial application:` for both explicitly tagged commits and implicitly discovered commits that touched the tracker item. Use `Additional context:`, not `Complicating context:`.

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
    "learned": "This is final WG intent and establishes the target binding strength for the audited source check.",
    "supports": ["issue_request", "decision"]
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
    "supports": ["additional_context", "recommended_next_step"]
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

## Result JSON

Write the JSON file named in the prompt:

```ts
type AuditDecision = "keep" | "tweak" | "drop" | "human-review";

interface CommitAuditResult {
  schema_version: "issue-fixup-audit-v1";
  run_id: string;
  source_run_id: string;
  issue_key: string;
  commit_sha: string;
  decision: AuditDecision;
  replacement_commit_message: string;
  reasoning: string;
  recommended_next_step: string;
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
  related_jiras: {
    key: string;
    relationship: "duplicate" | "supersedes" | "superseded-by" | "same-change-family" | "supporting-decision" | "conflicting-decision" | "background" | "later-change" | "unclear";
    note: string;
  }[];
  source_tweaks_needed: string[];
  confidence: "high" | "medium" | "low";
  notes?: string[];
}
```

`reasoning` should explain your audit judgment. `recommended_next_step` should be concrete enough for a future human or agent to act without redoing the whole investigation.
