# Per-chunk discovery pipeline

Your job is to analyze one FHIR spec chunk and write durable discovery artifacts. You do not edit the FHIR spec. Your primary output is `review/issues.ndjson`: one structured row for every candidate Jira you review, plus rows for any real no-existing-Jira problems you discover.

## Output Files

Write all artifacts under your assigned chunk output folder:

```text
queries.md                 # query strategy and iterations
final-candidates.sql       # exact SQL used for the final candidate export
candidates.tsv             # mechanically exported candidate table
spec-notes.md              # source/history notes and source-found possible problems
review/issues.ndjson       # primary output: append-only review records
```

These files are incremental. If you stop midway, the next worker should be able to inspect existing rows in `review/issues.ndjson`, skip already-reviewed Jira keys, and continue with the next candidate.

Do not bulk-generate final review rows from heuristics. Scripts are appropriate for exporting candidates, sorting keys, finding already-reviewed rows, and printing work queues. They are not appropriate for deciding what an issue means, whether it is fully applied, whether a resolved change is still valid, or what downstream should do. Use your own analysis issue by issue after the candidate queries are refined. A `review/issues.ndjson` row is a reviewed conclusion, not a classifier guess.

## Workflow

### 1. Source Reconnaissance

Read the chunk assignment and the inlined current source snapshot for the owned FHIR source paths. The snapshot contains one tagged `<source_file>` block per assigned file, unless a file is binary or omitted by the prompt-size budget. You may rely on included snapshot text as current-state text for this pinned run. For omitted files, line numbers, surrounding files, generated artifacts, exact current file context, or very large chunks, inspect the FHIR spec checkout directly. Inspect git history when you need to understand how wording arrived, previous filenames, issue-linked commits, or whether a Jira resolution was actually applied.

No precomputed keyword hints are supplied. Start broad enough to understand the page/resource, then collect search terms:

- filenames and page names
- headings and anchor ids
- canonical URLs
- element paths, operation names, code systems, value sets
- distinctive phrases
- old names or moved files from git history
- Jira keys or PRs mentioned in nearby git commits

Use commands like:

```bash
git -C /home/jmandel/work/fhir rev-parse HEAD
git -C /home/jmandel/work/fhir log --follow --name-status -- source/<path>
git -C /home/jmandel/work/fhir log --all -G '<distinctive term>' -- source/<path>
rg -n '<term>' /home/jmandel/work/fhir/source/<path>
```

Record useful notes in `spec-notes.md`. If you find a likely no-existing-Jira problem while reading source, record it in `spec-notes.md`, then later perform a Jira dedup search before appending a `proposed-jira` row.

### 2. Candidate Query And Export

<jira_candidate_search_guidance>

Build a high-sensitivity Jira candidate queue for this chunk. The goal is to capture issues that may require or explain work for the owned source paths, then review them one by one. Large queues are acceptable for central pages.

For FHIR core source chunks, candidate queries must be scoped to Jira issues whose `specification` includes `FHIR-core`. Do not rely on `work_group` alone to exclude implementation-guide issues; work group and specification are different axes.

Start from exact anchors, then add broader terms when they are needed for sensitivity. Refine broad queries to remove nonspecific false positives, not to make the queue small.

Useful anchors include:

- `related_pages` values for the page or resource.
- `related_artifacts` values for owned resources, operations, profiles, value sets, and code systems.
- rendered filenames such as `search.html`.
- canonical URLs and fragment ids.
- exact element paths, operation names, parameter names, modifier names, or distinctive phrases.
- Jira keys found in relevant source commits.

Log each query attempt in `queries.md`:

```text
## Iteration <n> (<timestamp>)
Intent: <what issue family this query is trying to find>
SQL or command: <exact query>
Result: <count and small sample>
Decision: keep | broaden | tighten | drop
Notes: <why this helps or why it is too noisy>
```

If a broad query returns hundreds of candidates, that may be correct for a page with many historical comments. Tighten only when sampling shows the hits are nonspecific noise. Use exact anchors, work-group filters, date filters, source terms, and exclusion patterns to improve precision without dropping likely-relevant issues.

When you settle on the final query, write one final SQL query to `final-candidates.sql`, then mechanically export `candidates.tsv`. Do not transcribe Jira lists by hand.

The final candidate table should favor high sensitivity. Refine queries to remove nonspecific false positives, not to make the queue artificially small. If a central page legitimately has hundreds of candidate issues, export them and process them incrementally. Record broader explored counts, retained patterns, and dropped noise patterns in `queries.md`; do not mark candidates reviewed heuristically just because the queue is large.

Use the prompt's cutoff as an activity cutoff, not a creation cutoff. In SQL, filter on `updated_at >= <cutoff>` so older issues with later decisions, comments, publication/application changes, or triage activity are still included. Include `created_at`, `updated_at`, and `resolved_at` in the export for context. `created_at >= <cutoff>` alone is too narrow for this workflow.

Example:

`final-candidates.sql` should include the FHIR-core specification scope and the activity cutoff. Adapt the anchor predicates to the chunk:

```sql
WITH candidates AS (
  SELECT
    i.key,
    json_extract(i.data, '$.status') AS status,
    json_extract(i.data, '$.status_category') AS status_category,
    'related_pages:<page-or-resource-anchor>' AS primary_anchor,
    json_extract(i.data, '$.created_at') AS created_at,
    json_extract(i.data, '$.updated_at') AS updated_at,
    json_extract(i.data, '$.resolved_at') AS resolved_at,
    json_extract(i.data, '$.summary') AS summary
  FROM issues i
  WHERE json_extract(i.data, '$.updated_at') >= '<cutoff>'
    AND EXISTS (
      SELECT 1 FROM json_each(i.data, '$.specification') s
      WHERE s.value = 'FHIR-core'
    )
    AND EXISTS (
      SELECT 1 FROM json_each(i.data, '$.related_pages') p
      WHERE p.value = '<page-or-resource-anchor>'
    )
)
SELECT *
FROM candidates
ORDER BY key;
```

Then mechanically export it:

```bash
CHUNK_DIR="/absolute/output/folder/from/your-prompt"
sqlite3 -header -separator $'\t' jira/data.db \
  < "$CHUNK_DIR/final-candidates.sql" \
  > "$CHUNK_DIR/candidates.tsv"
```

`candidates.tsv` must have a header and at least these columns:

```text
key  status  status_category  primary_anchor  created_at  updated_at  resolved_at  summary
```

`primary_anchor` is just the search reason for including the candidate, such as `related_pages:FHIR-core-search`, `text:search.html`, or `phrase:_include`. It is not a classification, priority, or evidence that the issue is applied.

Sort candidates by key unless you document a better stable order in `queries.md`.

Common Jira SQL reminders:

- Jira array fields such as `specification`, `related_pages`, `related_artifacts`, and `work_group` require `json_each(...)`.
- Scope FHIR core discovery queries with `EXISTS (SELECT 1 FROM json_each(i.data, '$.specification') s WHERE s.value = 'FHIR-core')`.
- Use `updated_at >= <cutoff>` for this workflow unless the prompt says otherwise. Generic examples in the command guide may show `created_at`; do not copy that as the discovery-run cutoff.
- `Resolved - change required` has a resolution date but is not applied/published; treat it as work needing review.
- Comments can contain key implementation links and page references, but a comment hit is only a candidate-search anchor.
- FTS5 parses hyphenated issue keys oddly; snapshot known Jira keys directly with `bun run jira:search snapshot FHIR-XXXXX`.

</jira_candidate_search_guidance>

### 3. Candidate-By-Candidate Review

Create `review/`. Process `candidates.tsv` in order, top to bottom. Before reviewing, read any existing `review/issues.ndjson` and skip keys that already have a valid row.

You may use high-signal candidates to orient yourself first, but do not narrow the assignment to only the easiest subset. The chunk owns every listed source path, and final completion requires one review row for every candidate in `candidates.tsv`. Related sibling pages may be useful context or out-of-scope targets, but do not silently drop a candidate merely because it also mentions another page.

Do not create a shortcut classifier for large queues. Once `candidates.tsv` is specific enough, process it one issue at a time: take the next row from the CSV, snapshot that Jira unless it is obvious out-of-scope noise, investigate and evaluate it, read related Jira/Zulip/Confluence/source history if needed, append exactly one NDJSON adjudication for that issue, then move to the next CSV row. Do this with your own issue-by-issue judgment, not by writing a script that assigns conclusions. A git commit mentioning a Jira key is useful evidence to follow, but it is not enough by itself to mark the issue fully applied; fully-applied still requires comparing the Jira resolution to current source and citing current source file:line evidence.

For each candidate:

1. Start the next not-yet-reviewed row from `candidates.tsv`.
2. Decide whether it is obviously out of scope from the candidate row alone. If yes, append an `OutOfScopeCandidate` row and move to the next CSV row. You do not need a snapshot for obvious noise.
3. Otherwise run `bun run jira:search snapshot <FHIR-XXXXX>` and read the full issue context before appending any row.
4. Re-check the relevant source, git history, and, when useful, related Jira issues, Zulip threads, or Confluence pages.
5. Append exactly one `jira-candidate` JSON object to `review/issues.ndjson` immediately after deciding that issue.
6. Only then move to the next row in `candidates.tsv`.

Only obvious out-of-scope noise may be recorded without a Jira snapshot. For every other Jira candidate row, `snapshot_read` must be `true`. This includes `scope: "context-only"` and `scope: "unclear"`; those are still conclusions about the issue and require reading it.

Set `snapshot_read` to `true` only after reading the Jira snapshot in this run or after preserving a pre-existing valid row that already recorded snapshot evidence.

For `assessment: "fully-applied"`, do not rely on Jira status, `related_pages`, `applied_for_version`, or a git commit reference alone. You must verify the actual current source and cite source evidence showing where the intended change appears. If you have not compared the Jira resolution with current source, use `next_step: "review"` instead of `fully-applied`.

The row should answer:

- Does this Jira belong to this chunk? (`scope`)
- What state is the Jira in? (`tracker_state`)
- What should downstream do? (`next_step`)
- What did you conclude after investigation? (`assessment` plus the shape-specific fields)

Map `tracker_state` from the Jira issue and your source verification:

- `applied_or_published`: the issue is done/applied/published and, after reading the snapshot and checking source, the current source appears to contain the intended change.
- `resolved_change_required`: the issue has an accepted/resolved change that still needs source work or verification.
- `resolved_no_change`: the issue was resolved with no spec change, rejected, withdrawn, duplicate-only, or otherwise closed without a direct edit.
- `not_resolved`: the issue is still open, triaged, in progress, or otherwise lacks a final resolution.
- `unknown`: the issue state cannot be determined from the snapshot and available fields.

Use `next_step` conservatively for Jira candidate rows:

- `none`: no downstream work.
- `apply`: enough information exists to create a spec-edit work chunk.
- `review`: relevant, but not safe/direct enough for automatic application.

Use `file-jira` only on `proposed-jira` rows for newly discovered problems not covered by an existing tracker.

### 4. Source-Discovered Problems

For any real issue found from source review that does not appear to have a Jira:

1. Search Jira using exact phrases and likely synonyms to confirm it is not already filed.
2. Record the dedup query terms and result summary.
3. Append a `proposed-jira` row to `review/issues.ndjson`.

Do not create a proposed Jira from a vague concern. It needs source evidence and a dedup check.

## Review Row Schema

`review/issues.ndjson` is JSON Lines. Each line is one `ReviewRecord`.

```ts
type ReviewRecord = JiraCandidateReview | ProposedJiraReview;

type TrackerState =
  | "applied_or_published"
  | "resolved_change_required"
  | "resolved_no_change"
  | "not_resolved"
  | "unknown";

type Scope = "in-scope" | "context-only" | "out-of-scope" | "unclear";
type CandidateNextStep = "none" | "apply" | "review";
type ProposedJiraNextStep = "file-jira";

interface BaseJiraReview {
  record_type: "jira-candidate";
  key: `FHIR-${number}`;
  tracker_state: TrackerState;
  scope: Scope;
  next_step: CandidateNextStep;
  summary: string;
  evidence?: string[];
  related_keys?: string[];
}

type JiraCandidateReview =
  | OutOfScopeCandidate
  | UnclearCandidate
  | AppliedFullyReview
  | AppliedDriftReview
  | ResolvedChangeReadyReview
  | ResolvedChangeNotReadyReview
  | ResolvedNoChangeReview
  | NotResolvedReview
  | UnknownStateReview;

interface OutOfScopeCandidate extends BaseJiraReview {
  scope: "out-of-scope";
  next_step: "none";
  snapshot_read: boolean;
  assessment: "out-of-scope";
  out_of_scope_reason: string;
}

interface UnclearCandidate extends BaseJiraReview {
  scope: "unclear";
  next_step: "review";
  snapshot_read: true;
  assessment: "unclear";
  question: string;
}

interface AppliedFullyReview extends BaseJiraReview {
  tracker_state: "applied_or_published";
  scope: "in-scope" | "context-only";
  next_step: "none";
  snapshot_read: true;
  assessment: "fully-applied";
  applied_change: string;
  evidence: string[];
}

interface AppliedDriftReview extends BaseJiraReview {
  tracker_state: "applied_or_published";
  scope: "in-scope";
  next_step: "apply" | "review";
  snapshot_read: true;
  assessment: "not-fully-applied" | "superseded-after-application";
  intended_change: string;
  current_state: string;
  drift_reason:
    | "application-mistake"
    | "partial-application"
    | "contradicted-by-current-source"
    | "superseded-after-application"
    | "ambiguous";
  fix_sketch?: string;
  evidence: string[];
}

interface ResolvedChangeReadyReview extends BaseJiraReview {
  tracker_state: "resolved_change_required";
  scope: "in-scope";
  next_step: "apply";
  snapshot_read: true;
  assessment: "ready-to-apply";
  resolution_summary: string;
  edit_plan: string;
  evidence: string[];
  dependencies?: string[];
  risk?: string;
}

interface ResolvedChangeNotReadyReview extends BaseJiraReview {
  tracker_state: "resolved_change_required";
  scope: "in-scope" | "context-only";
  next_step: "review" | "none";
  snapshot_read: true;
  assessment: "not-ready-to-apply";
  blocker:
    | "ambiguous"
    | "underdefined"
    | "superseded"
    | "conflicting-decision"
    | "changed-source-context"
    | "needs-discussion";
  what_is_missing: string;
  recommendation: string;
}

interface ResolvedNoChangeReview extends BaseJiraReview {
  tracker_state: "resolved_no_change";
  scope: "in-scope" | "context-only";
  next_step: "none";
  snapshot_read: true;
  assessment: "no-change-still-makes-sense" | "context-for-other-work";
  rationale: string;
}

interface NotResolvedReview extends BaseJiraReview {
  tracker_state: "not_resolved";
  scope: "in-scope" | "context-only";
  next_step: "review" | "none";
  snapshot_read: true;
  assessment: "needs-resolution" | "monitor" | "not-actionable";
  discussion_state: string;
  recommendation: string;
  options?: Array<{ label: string; pros: string; cons: string; compatibility?: string }>;
}

interface UnknownStateReview extends BaseJiraReview {
  tracker_state: "unknown";
  scope: "unclear";
  next_step: "review";
  snapshot_read: true;
  assessment: "unclear";
  question: string;
}

interface ProposedJiraReview {
  record_type: "proposed-jira";
  key?: null;
  next_step: ProposedJiraNextStep;
  summary: string;
  proposed_jira: {
    title: string;
    problem: string;
    where: string;
    suggested_fix: string;
    dedup_check: string;
    source_evidence: string[];
    related_candidate_keys?: string[];
  };
}
```

Evidence can include source `file:line`, Jira keys, Zulip topic references, Confluence page references, PRs, or commit ids. Use source `file:line` evidence whenever a row claims current spec text is correct, missing, partial, contradicted, or ready to edit.

## Final CLI Message

After all output files are written, end with a short final CLI message for the coordinator logs. The coordinator does not parse this message; the durable output is `review/issues.ndjson` and the other files listed above. Do not put unique data only in the final message.

Include:

- number of candidate rows reviewed
- number out of scope
- number with `next_step: "apply"`
- number with `next_step: "review"`
- number of proposed Jira rows
- path to `review/issues.ndjson`
