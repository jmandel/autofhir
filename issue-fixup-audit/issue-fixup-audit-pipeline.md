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
```

Do not fish indefinitely. Search broadly enough to validate or reject the generated commit, then stop when additional searches are unlikely to change the audit decision. Prefer precise anchors: Jira key, element path, exact source phrase, commit SHA, resource name, artifact URL, and ballot/comment wording.

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
- Jira: ...
- Source: ...
- Git: ...
- Community: ...
- Verification: ...
</evidence>
```

Use `Initial application:` for both explicitly tagged commits and implicitly discovered commits that touched the tracker item. Use `Additional context:`, not `Complicating context:`.

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
    ref?: Record<string, string | number>;
    summary: string;
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
