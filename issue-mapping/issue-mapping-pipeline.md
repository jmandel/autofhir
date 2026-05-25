# AutofHIR Issue Mapping Pipeline

This is the operating manual for issue-mapping workers. Issue mapping is a Jira-first discovery workflow. A worker starts from one seed Jira issue, researches that issue deeply enough to make a defensible decision, and may also record decisions about closely related issues discovered during the same research.

The goal is not to review a whole source chunk or classify a large candidate set. The goal is to build a durable map from Jira issues to likely spec work, affected source areas, and next steps.

## Inputs

Each worker prompt contains:

- The run context and output path.
- A pre-rendered snapshot of the seed Jira issue.
- The community-search command guide for Jira, Zulip, Confluence, and spec/source investigation.
- This operating manual.

The worker may inspect the local FHIR checkout and community-search databases directly. The seed snapshot in the prompt is a starting point, not the only allowed evidence.

## Required Output

Write exactly one JSON file:

```text
the required output file shown in the run context
```

The file must match the `SeedRunResult` shape described below. The output is a self-contained decision group: a list of issue decisions that includes the seed and may include tightly related issues adjudicated during the same investigation.

## Bounded Exploration

Explore broadly enough to understand the seed, but not indefinitely.

Start with the seed Jira snapshot. Then inspect linked issues, duplicate issues, source files, git history, Zulip threads, and Confluence minutes when they are likely to change the decision. Stop when you can make a defensible decision on the seed, or when additional research is unlikely to change the next step.

Do not write a bulk classifier over the candidate pool. Discover related issues by following links from the seed, searching Jira for exact phrases/artifacts/work groups, and checking source/spec history as needed.

This is a bounded adjudication task, not an open-ended research project. Prefer a useful, honest decision with clear uncertainty over continuing indefinitely. If you have spent substantial time and the remaining uncertainty would require broad new research, write the result with `assessment: "unclear"` or `next_step: "review"` and explain exactly what remains unresolved.

Avoid broad source sweeps. Do not run repository-wide searches for common words such as `mapping`, `status`, `value`, `workflow`, `search`, or a resource name by itself. Anchor searches with the issue key, exact element path, exact page id/title, exact phrase from Jira, exact URL slug, or a narrow source directory. Use result limits or targeted paths so tool output remains reviewable. If a search produces huge output, stop broadening and switch to a narrower query or a best-effort result.

Useful Jira search patterns for seed expansion:

- Snapshot the seed first: `bun run jira:search snapshot FHIR-XXXXX`.
- Search the seed key directly in Jira/Zulip/Confluence.
- Search exact phrases from the seed summary, resolution, related pages, or comments.
- Search `related_artifacts`, `related_pages`, and `work_group` with SQL when the built-in CLI filters are too broad.
- Keep the scope focused on `FHIR-core`; do not drift into IG issues unless the seed itself makes that necessary.
- Prefer issues updated after the run cutoff, but follow older linked or duplicate issues when they explain the seed.
- If a search returns hundreds of results, tighten it by exact artifact/page/WG/date terms; if the broad result is truly the relevant family, sample enough to identify a narrower follow-up search.

## Related Issue Decisions

Small-cluster adjudication is encouraged. If you have already read related Jira snapshots and current source/history while deciding the seed, do not stop at the seed when a small amount of additional checking lets you confidently adjudicate the related issues too. This is especially useful for duplicate issues, same-change-family issues, later superseding issues, and issues whose requested/current state is already explained by the same source inspection.

Include related issues in `issues` when all of these are true:

- You read that issue's Jira snapshot.
- The issue is closely connected to the seed issue or the same spec change family.
- You inspected enough source/history/context to support the same decision quality required for the seed.
- Your evidence, reasoning, and recommendation explain why the decision is justified in the context of the whole group.

Do not go fishing for a large cluster. The target is a tight group that naturally falls out of the seed investigation. A good rule of thumb: if you already read the related issue and can decide it with one or two more source/history checks, decide it. If it would require a separate open-ended investigation, list it under `related_but_not_decided` with a note about why you stopped.

If a related issue is only useful background, list it under `related_but_not_decided`. Do not force it into `issues`. But avoid putting an issue in `related_but_not_decided` merely because it is not the seed; if your research already supports a defensible conclusion, include it as an issue decision.

Each issue decision should be understandable on its own, but its `reasoning` and `recommendation` should account for the other issues in the group. For example, if three related trackers conflict and a later one settled the question, say for each issue whether the current source is correct with respect to the whole decision chain.

The scheduler accumulates all valid issue decisions. It is okay if another seed run also discusses the same related issue.

## Applied/Published Current-State Reconciliation

For issues marked Applied or Published, do not judge the current spec by literal string matching against the seed issue alone. The real question is:

> Considering the seed issue, its implementation history, and any later related Jira decisions you discovered, is the current pinned source the correct end state?

Many old Jira summaries are terse, pre-implementation, or later superseded. A seed may say "rename X to Y", while the final source correctly uses Z because a later WG decision, linked issue, implementation correction, or same-family tracker refined the naming. In that case, do not mark the seed as `not-fully-applied` just because Y is absent. Mark it `fully-applied` when the total evidence shows the current source is the right result of the full decision chain.

Do not over-flag harmless editorial differences. Slight wording tweaks, grammar changes, formatting differences, renamed surrounding headings, or clearer phrasing are acceptable when the meaning, constraint, cardinality, terminology binding, element name/path, conformance requirement, and implementation consequence are substantially the same as the approved decision. In those cases, use `fully-applied`, cite the current source, and explain that the implementation is semantically equivalent even if it is not a literal transcription of the Jira resolution.

Use `not-fully-applied` only when, after reconciling later issues and implementation history, the current source still appears wrong, incomplete, internally inconsistent, or impossible to verify confidently. This can include cases where the issue's explicitly listed page or artifact was updated, but the same approved rule, terminology, invariant, element rename, or conformance statement should also have been applied to other source locations and was missed, leaving inconsistent spec behavior. If the source differs from the seed's literal text but appears intentionally corrected by later work, explain that in `reasoning`, cite the later issue or commit in `prior_decisions` or `related_jiras`, and set `next_step: "none"` unless another concrete review/action remains.

## Decision Fields

Use these enum values exactly.

## HL7 Jira Status And Draft Resolutions

Do not treat the Jira `Resolution` field, resolution prose, or `Resolved` timestamp as final by itself.

HL7 Jira may show a proposed or draft Resolution value, such as `Persuasive` or `Persuasive with Modification`, and may also show detailed resolution text and a `Resolved` timestamp, while the workflow Status is still `Submitted`, `Triaged`, `Waiting for Input`, or another not-final state. That means the proposal has not necessarily been voted, applied, or accepted by the work group.

Only treat Jira as having a final WG decision when the workflow Status indicates a resolved/final spec disposition such as `Resolved - change required`, `Applied`, `Published`, `Resolved - No Change`, or another explicit WG disposition. `Duplicate` is not an independent spec disposition; it should usually be ignored as a seed or traced to the owning issue if needed.

If the Status is still open/triaged/waiting but the issue contains persuasive-looking Resolution values or resolution text, record:

- `tracker_state`: `not-resolved`
- `assessment`: usually `not-ready-to-apply`
- `next_step`: usually `needs-human-decision` or `review`

In that case, use the draft resolution as evidence of a likely path or option, not as authority to create an apply work item. Explain that the draft resolution appears actionable but still needs formal WG disposition before source editing.

### tracker_state

- `not-resolved`: Jira is still open, triaged, in progress, or otherwise not dispositioned into a final decision.
- `resolved-change-required`: Jira records that a spec change is required, but the current source still needs assessment or implementation.
- `applied-or-published`: Jira says the change was applied or published.
- `resolved-no-change`: Jira resolved the issue without requiring a spec change, such as Not Persuasive or duplicate where no separate change is required.
- `unknown`: The Jira state cannot be determined from the snapshot and reasonable follow-up.

### assessment

- `out-of-scope`: The issue is not relevant to FHIR core spec work, or not relevant after enough reading to tell.
- `fully-applied`: The current source correctly reflects the seed after accounting for implementation history and later related Jira decisions. This includes cases where the literal seed wording was intentionally refined, superseded, or absorbed by later same-family work, and cases where the implemented wording is editorially different but semantically equivalent.
- `not-fully-applied`: The tracker appears applied/published, but after reconciling related issues and history, the current source still appears meaningfully missing, partial, contradicted, semantically different, or not confidently verified. Do not use this merely because the current text is phrased differently from the Jira resolution.
- `ready-to-apply`: Jira has a clear change-required decision and you can describe the edit to make.
- `not-ready-to-apply`: A change may be needed, but the resolution is ambiguous, obsolete, contradictory, under-specified, or needs WG judgment.
- `resolved-no-change`: Jira decided no spec change is required and that still appears coherent.
- `needs-follow-up`: The seed reveals a new issue, gap, or follow-up not adequately captured by the existing tracker.
- `unclear`: You cannot make a reliable decision after bounded investigation.

### next_step

- `none`: No downstream action is needed.
- `apply`: Generate a spec-edit work item.
- `review`: Preserve for human or later automated review; do not apply directly.
- `file-jira`: File a new Jira or follow-up tracker.
- `needs-human-decision`: A WG/human decision is needed before implementation.
- `close-duplicate`: Recommend closing the seed as a duplicate or absorbed-by issue because another Jira already carries the actionable decision.

## Common Decision Patterns

Published/applied but not source-verified:

- `tracker_state`: `applied-or-published`
- `assessment`: `not-fully-applied`
- `next_step`: `review`
- Use this only after checking whether later same-family issues or implementation commits intentionally changed the seed's literal requested wording.
- Use this only for a real semantic or implementation concern: for example, an omitted required rule, a materially weaker/stronger conformance statement, the wrong element/path/code/binding/cardinality, an unresolved contradiction, or inability to verify the intended change after reasonable source/history checks.
- Also use this when the named target looks applied but related current spec locations remain inconsistent with the approved decision. It is fair to inspect sibling resources, module pages, shared patterns, generated search parameters, examples, invariants, mappings, narrative cross-references, and terminology artifacts when the issue's logic clearly should apply beyond the originally listed page.
- Do not use this for acceptable editorial implementation: for example, the same requirement stated with different sentence structure, punctuation, local terminology, formatting, or clearer surrounding prose.
- Explain what you could and could not verify, and why the current source still needs review after considering the full decision chain.

Published/applied and correctly reflected after later related work:

- `tracker_state`: `applied-or-published`
- `assessment`: `fully-applied`
- `next_step`: `none`
- Use this when the current source is correct after considering the seed plus later related issues, even if the current wording/name/path does not literally match the old seed summary.
- Also use this when the current source differs only editorially from the resolution text but preserves the same substantive meaning and implementation impact.
- Cite the later issue, commit, or WG decision that explains the difference.

Clear unresolved implementation work:

- `tracker_state`: `resolved-change-required`
- `assessment`: `ready-to-apply`
- `next_step`: `apply`
- Include a concrete edit sketch and target source paths.
- Use this only when Jira status, not just draft resolution text, indicates a final change-required decision.

Resolved but no change required:

- `tracker_state`: `resolved-no-change`
- `assessment`: `resolved-no-change`
- `next_step`: `none`
- Explain the rationale and why it still makes sense.

Open issue needing WG resolution:

- `tracker_state`: `not-resolved`
- `assessment`: `not-ready-to-apply`
- `next_step`: `needs-human-decision`
- Summarize the unresolved question, likely options, and your recommended path to bring to the WG.
- Fill `decision_questions` and `recommended_resolution_options`.
- If prior decisions constrain the seed, fill `prior_decisions` and explain whether the seed would reverse, refine, or preserve them.
- If the issue has draft resolution text in Jira, summarize it as one option or likely proposal, but do not treat it as approved unless the Jira status is final.

Open issue already answered by another Jira:

- `tracker_state`: `not-resolved`
- `assessment`: `not-ready-to-apply`
- `next_step`: `close-duplicate`
- Use this when the seed is open, but your research finds another Jira that already has the WG disposition or implementation path for the same question.
- `summary` should name the duplicate/owning Jira.
- `reasoning` should explain why the owning Jira really covers the seed, and what would be lost if the seed were closed.
- Put the owning Jira in `related_jiras` with `relationship: "duplicate"` or `relationship: "superseded-by"`.
- Include a preferred `recommended_resolution_options` entry that says to close or link the seed, and cite evidence from both the seed and owning Jira.

Deletion/removal correctly applied:

- `tracker_state`: `applied-or-published`
- `assessment`: `fully-applied`
- `next_step`: `none`
- Evidence may cite git history, absent paths checked by command, and current source absence. A current `source/file:line` is not required when the intended change is deletion.

## Target Chunks And Source Paths

`target_chunks` and `source_paths` are routing hints for downstream work-item generation. They do not constrain this seed run.

Use target chunks such as `fhir-i--search`, `oo--observation`, or `vocab--valueset` when you can infer likely ownership. If you are unsure, use an empty array and explain uncertainty in `reasoning`.

Do not use scheduler partition IDs as target chunks. Scheduler partitions use `wg::topic`, for example `oo::visionprescription`; target chunks use `wg--topic`, for example `oo--visionprescription`. If you cannot infer a valid chunk ID, leave `target_chunks` empty and provide source paths instead.

Use source paths relative to the FHIR checkout, such as `source/search.html` or `source/observation/`.

## Decision Memo Requirements

Every decision must include `recommendation`: a thoughtful human-facing handoff describing what should happen next and why. This is not a short label and it is not a duplicate of `next_step`. It should help a future human or agent pick up the issue without redoing your whole investigation.

A good recommendation usually includes:

- The concrete next action you recommend.
- Why that action follows from Jira status, current source, git history, and community evidence.
- What should not be done yet, if applicable.
- Any caveats, dependencies, or related issues that the next worker/reviewer should keep in mind.

Examples of the expected level of detail:

- For `ready-to-apply`: "Create a spec-edit work item for `source/profiling.html` implementing FHIR-00001's approved replacement wording. The tracker is resolved change-required, the WG minutes confirm the same wording direction, and the pinned source still has the old contradictory note. The edit should preserve the existing section structure and should cite the owning Jira; FHIR-00002 should be treated as background rather than a separate source edit unless its Jira status changes."
- For `close-duplicate`: "Do not create a separate edit from this open seed. Close or link it as absorbed by FHIR-00003, because that later tracker has the formal WG disposition for the same question and supplies the actionable resolution. Preserve this seed's discussion as supporting context so the duplicate closure does not lose the original implementer concern."
- For `needs-human-decision`: "Bring this back to the owning WG before editing source. The requested change would reverse a prior applied decision and the current Jira has not recorded that reversal. The useful next step is to choose between the listed resolution options, especially whether compatibility risk is acceptable for the next ballot."
- For `fully-applied`: "No spec edit is needed from this issue. The current source and git history match the published resolution, so downstream automation should mark this as verified. If future work revisits the area, use the cited commit and source paths as the baseline rather than reopening this tracker."

For `not-ready-to-apply`, `unclear`, or any decision with `next_step: "needs-human-decision"`, do not stop at "WG needs to decide." Produce a compact decision memo inside the structured fields:

- `decision_questions`: the exact questions the WG or human reviewer must answer.
- `recommended_resolution_options`: realistic paths forward, with pros/cons and the next step each option implies.
- `preferred_option_id`: your recommended option when the evidence supports one; omit it only when no preference is defensible.
- `prior_decisions`: previous Jira/Zulip/Confluence/git/spec decisions that constrain the seed, especially when the seed would reverse or reinterpret earlier work.

Use fake issue IDs in examples and never copy example IDs into real output.

Example shape for an unresolved issue that conflicts with previous design:

```json
{
  "decision_questions": [
    "Should the WG restore a primitive string choice, or continue representing plain text through CodeableConcept.text?",
    "If string is restored, is the WG intentionally reversing the prior R5 design?"
  ],
  "recommended_resolution_options": [
    {
      "id": "option-a",
      "label": "No change; clarify current design",
      "summary": "Keep CodeableConcept.text as the representation for uncoded payload text and add clearer examples.",
      "recommendation": "preferred",
      "pros": ["Preserves prior approved design", "Avoids overlapping string and CodeableConcept choices"],
      "cons": ["May remain unintuitive for implementers who expect a string choice"],
      "next_step": "apply",
      "source_changes": ["Add clarification and examples to the relevant payload section"],
      "evidence_refs": ["E1", "E3"]
    },
    {
      "id": "option-b",
      "label": "Restore string choice",
      "summary": "Add string back to content[x].",
      "recommendation": "not-recommended",
      "pros": ["Matches older releases", "Simple for plain-text payloads"],
      "cons": ["Reverses prior approved design", "Reintroduces overlap with CodeableConcept.text"],
      "next_step": "needs-human-decision",
      "source_changes": ["Change the choice type list on both affected resources"],
      "evidence_refs": ["E2", "E4"]
    }
  ],
  "preferred_option_id": "option-a"
}
```

Example shape for a terminology proposal that needs policy decisions:

```json
{
  "decision_questions": [
    "Which code system should own these common designation-use concepts?",
    "Which candidate concepts belong in designation-use versus a separate status mechanism?"
  ],
  "recommended_resolution_options": [
    {
      "id": "option-a",
      "label": "Define a small HL7-owned designation-use starter set",
      "summary": "Add only well-supported usage concepts such as abbreviation, formal-name, patient-friendly-name, and short-name; defer status-like concepts.",
      "recommendation": "preferred",
      "pros": ["Addresses recurring implementer requests", "Avoids overloading designation use with status"],
      "cons": ["Still requires Vocab/TI ownership and exact definitions"],
      "next_step": "needs-human-decision",
      "source_changes": ["Update the DesignationUse value set and affected binding notes after WG approval"],
      "evidence_refs": ["E1", "E5"]
    }
  ],
  "preferred_option_id": "option-a"
}
```

## Structured Evidence

Keep the existing `evidence` string array for readable summaries, but also fill `evidence_items` so downstream tools can make inspectable reports.

Every evidence item should have a stable `id` such as `E1`, a `kind`, a durable `locator`, and a short summary. Include `url` when one is known. Also fill `ref` when you know structured identifiers such as Jira key, Confluence page id, Zulip stream/topic/message id, git commit, source path/line, or command. Use `supports` to name what the evidence supports, such as `assessment`, `next_step`, `option:option-a`, `prior:P1`, or `edit_plan`.

Examples:

```json
{
  "id": "E1",
  "kind": "jira",
  "locator": "FHIR-00001 snapshot",
  "url": "https://jira.hl7.org/browse/FHIR-00001",
  "ref": {"jira_key": "FHIR-00001"},
  "summary": "The tracker is resolved change-required and supplies exact replacement wording.",
  "supports": ["tracker_state", "assessment", "edit_plan"]
}
```

```json
{
  "id": "E2",
  "kind": "source",
  "locator": "source/example/structuredefinition-Example.xml:123-145",
  "ref": {"source_path": "source/example/structuredefinition-Example.xml", "line_start": 123, "line_end": 145},
  "summary": "The current source still has the old element definition, so the approved text is not applied.",
  "supports": ["assessment", "next_step"]
}
```

## Output Schema

```ts
type TrackerState =
  | "not-resolved"
  | "resolved-change-required"
  | "applied-or-published"
  | "resolved-no-change"
  | "unknown";

type Assessment =
  | "out-of-scope"
  | "fully-applied"
  | "not-fully-applied"
  | "ready-to-apply"
  | "not-ready-to-apply"
  | "resolved-no-change"
  | "needs-follow-up"
  | "unclear";

type NextStep =
  | "none"
  | "apply"
  | "review"
  | "file-jira"
  | "needs-human-decision"
  | "close-duplicate";

interface SeedRunResult {
  schema_version: "issue-mapping-seed-v2";
  run_id: string;
  seed_key: string;
  issues: IssueDecision[]; // Includes the seed issue and any tightly related issues decided in this output.
  related_but_not_decided: RelatedIssue[];
  explored: ExplorationSummary;
  notes?: string;
}

interface IssueDecision {
  key: string;
  role: "seed" | "related";
  tracker_state: TrackerState;
  assessment: Assessment;
  next_step: NextStep;
  summary: string;
  reasoning: string;
  recommendation: string;
  evidence: string[];
  evidence_items: EvidenceItem[];
  target_chunks: string[];
  source_paths: string[];
  related_jiras: RelatedIssue[];
  prior_decisions: PriorDecision[];
  decision_questions: string[];
  recommended_resolution_options: ResolutionOption[];
  confidence: "high" | "medium" | "low";

  edit_plan?: string;
  blocker?: string;
  preferred_option_id?: string;
  proposed_jira?: ProposedJira;
}

interface EvidenceItem {
  id: string;
  kind:
    | "jira"
    | "zulip"
    | "confluence"
    | "source"
    | "git"
    | "published-spec"
    | "command"
    | "web";
  locator: string;
  url?: string;
  ref?: EvidenceRef;
  summary: string;
  supports: string[];
}

interface EvidenceRef {
  jira_key?: string;
  confluence_page_id?: string;
  zulip_stream?: string;
  zulip_topic?: string;
  zulip_message_id?: number;
  github_repo?: string;
  github_pr?: number;
  git_commit?: string;
  source_path?: string;
  line_start?: number;
  line_end?: number;
  package_id?: string;
  package_version?: string;
  command?: string;
}

interface PriorDecision {
  id: string;
  source: "jira" | "zulip" | "confluence" | "git" | "published-spec";
  locator: string;
  url?: string;
  decision_summary: string;
  relationship:
    | "supports-current-state"
    | "conflicts-with-seed"
    | "supersedes-seed"
    | "seed-refines-prior-decision"
    | "background";
  evidence_refs: string[];
}

interface ResolutionOption {
  id: string;
  label: string;
  summary: string;
  recommendation: "preferred" | "acceptable" | "not-recommended" | "unknown";
  pros: string[];
  cons: string[];
  next_step: NextStep;
  source_changes: string[];
  evidence_refs: string[];
}

interface RelatedIssue {
  key: string; // Jira-style key such as FHIR-00001 or UP-00001.
  relationship:
    | "duplicate"
    | "depends-on"
    | "supersedes"
    | "superseded-by"
    | "same-change-family"
    | "background"
    | "possible-follow-up"
    | "unclear";
  note: string;
}

interface ProposedJira {
  title: string;
  problem: string;
  where: string;
  suggested_fix: string;
  dedup_check: string;
}

interface ExplorationSummary {
  jira_snapshots_read: string[];
  zulip_threads_read: string[];
  confluence_pages_read: string[];
  source_paths_inspected: string[];
  git_queries_run: string[];
}
```

## Validation Checklist

Before finishing:

- `issues` is non-empty and contains exactly one issue with `role: "seed"` and `key` equal to the seed key.
- Every related issue decision has `role: "related"` and cites its Jira snapshot in `explored.jira_snapshots_read`.
- Every decision has non-empty `summary`, `reasoning`, and `evidence`.
- Every decision has a thoughtful non-empty `recommendation` explaining what to do next and why.
- Every decision has non-empty `evidence_items`, and every item has `id`, `kind`, `locator`, `summary`, and `supports`.
- `ready-to-apply` includes `edit_plan`.
- `not-ready-to-apply`, `unclear`, or `needs-human-decision` explains the blocker or unresolved question and includes `decision_questions` plus `recommended_resolution_options`.
- `close-duplicate` names the owning Jira in `related_jiras` and gives a preferred option explaining how to close/link the seed.
- If the decision says the seed conflicts with, reverses, supersedes, duplicates, or refines previous work, `prior_decisions` names that work and cites evidence.
- `needs-follow-up` or `file-jira` includes `proposed_jira` when a new tracker is needed.
- The output is valid JSON, not Markdown.
