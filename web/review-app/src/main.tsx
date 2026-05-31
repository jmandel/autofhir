import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type ReviewDecision = "undecided" | "approve" | "reject" | "defer";

type CommitReport = {
  sequence: number;
  sha: string;
  short_sha: string;
  author: string;
  authored_at: string;
  subject: string;
  body?: string;
  body_url?: string;
  issue_key?: string;
  seed_key?: string;
  seed_decisions?: SeedDecision[];
  status?: string;
  decision_status?: string;
  commit_summary?: string;
  commit_context?: string;
  summary?: string;
  recommendation?: string;
  original_subject?: string;
  original_body?: string;
  original_body_url?: string;
  fixup_status?: string;
  fixup_decision_status?: string;
  fixup_result_path?: string;
  audit_decision?: string;
  audit_confidence?: "high" | "medium" | "low";
  audit_reasoning?: string;
  audit_recommended_next_step?: string;
  audit_source_tweaks_needed?: string[];
  audit_result_path?: string;
  github_commit_url?: string;
  previous_issue_commits?: PreviousIssueCommit[];
  previous_issue_commits_omitted?: number;
  result_path?: string;
  wg?: string;
  wg_label?: string;
  wg_confidence?: "high" | "medium" | "low";
  files: string[];
  stat: string;
  patch?: string;
  patch_url?: string;
  patch_bytes?: number;
  patch_truncated?: boolean;
  omitted_patch_files?: { file: string; reason: string }[];
};

type SeedDecision = {
  issue_key: string;
  role?: string;
  status?: string;
  commit_sha?: string;
  summary?: string;
};

type PreviousIssueCommit = {
  sha: string;
  short_sha: string;
  authored_at: string;
  author: string;
  subject: string;
  github_commit_url: string;
};

type Report = {
  schema_version: string;
  generated_at: string;
  run: {
    run_id: string;
    fhir_repo?: string;
    base: string;
    head: string;
    combined_branch: string;
    github_tree_url?: string;
    github_compare_url?: string;
    review_pages_url?: string;
    review_github_tree_url?: string;
    review_raw_base_url?: string;
    github_repo?: string;
    source_run_id?: string;
    source_issue_fixup_run_id?: string;
    audit_run_id?: string;
    artifacts?: Record<string, string | undefined>;
    max_patch_bytes?: number;
    max_file_diff_lines?: number;
  };
  counts: {
    commits: number;
    with_result: number;
    by_wg?: Record<string, number>;
  };
  commits: CommitReport[];
};

type ReviewEntry = {
  decision: ReviewDecision;
  note: string;
};

type ReviewStore = {
  bySha: Record<string, ReviewEntry>;
  entry: (sha: string) => ReviewEntry;
  setDecision: (sha: string, decision: ReviewDecision) => void;
  setNote: (sha: string, note: string) => void;
  clear: (shas: string[]) => void;
};

type SelectionStore = {
  selected: string | null;
  setSelected: (sha: string | null) => void;
};

const EnhancementContext = React.createContext(false);

const reviewOptions: [ReviewDecision, string][] = [
  ["undecided", "Undecided"],
  ["approve", "Approve"],
  ["reject", "Reject"],
  ["defer", "Defer"],
];

const useReviewStore = create<ReviewStore>()(
  persist(
    (set, get) => ({
      bySha: {},
      entry: (sha) => {
        const existing = get().bySha[sha];
        if (existing) return normalizeEntry(existing);
        return { decision: "undecided", note: "" };
      },
      setDecision: (sha, decision) => set((state) => ({
        bySha: { ...state.bySha, [sha]: { ...normalizeEntry(state.bySha[sha]), decision } },
      })),
      setNote: (sha, note) => set((state) => ({
        bySha: { ...state.bySha, [sha]: { ...normalizeEntry(state.bySha[sha]), note } },
      })),
      clear: (shas) => set((state) => {
        const next = { ...state.bySha };
        for (const sha of shas) delete next[sha];
        return { bySha: next };
      }),
    }),
    {
      name: "issue-fixup-review-state",
      version: 2,
    },
  ),
);

const useSelectionStore = create<SelectionStore>()((set) => ({
  selected: null,
  setSelected: (sha) => set({ selected: sha }),
}));

function normalizeEntry(entry?: Partial<ReviewEntry>): ReviewEntry {
  const raw = entry?.decision;
  const decision: ReviewDecision =
    raw === "approve" || raw === "reject" || raw === "defer" || raw === "undecided"
      ? raw
      : raw === "pick" ? "approve"
      : raw === "drop" ? "reject"
      : raw === "needs-revision" || raw === "needs-human-review" || raw === "hold-for-later" ? "defer"
      : "undecided";
  return { decision, note: entry?.note || "" };
}

function App() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [wg, setWg] = useState("");
  const [file, setFile] = useState("");
  const [reviewDecision, setReviewDecision] = useState("");
  const [sort, setSort] = useState("wg");
  const [diffsEnabled, setDiffsEnabled] = useState(false);
  const [linksEnabled, setLinksEnabled] = useState(false);
  const [copied, setCopied] = useState(false);
  const bySha = useReviewStore((state) => state.bySha);
  const clear = useReviewStore((state) => state.clear);

  useEffect(() => {
    const url = window.__AUTOFHIR_REPORT_URL__ || "issue-fixup-diff-report.json";
    ensureScrollIdleTracker();
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((data: Report) => {
        const hashSha = shaFromHash(data.commits);
        setReport(data);
        if (!hashSha && !isAuditReport(data)) setStatus(sourceChangingStatus(data.commits));
        window.requestAnimationFrame(() => {
          window.setTimeout(() => setLinksEnabled(true), 250);
          window.setTimeout(() => setDiffsEnabled(true), 1000);
        });
        useSelectionStore.getState().setSelected(hashSha || data.commits[0]?.sha || null);
        if (hashSha) window.setTimeout(() => scrollToSha(hashSha), 0);
      })
      .catch((err) => setError(String(err?.message || err)));
  }, []);

  const options = React.useMemo(() => report ? buildOptions(report, bySha, { status, wg, file, reviewDecision }) : null, [report, bySha, status, wg, file, reviewDecision]);
  const rows = React.useMemo(() => report ? ordered(report.commits.filter((commit) => passes(commit, bySha, { status, wg, file, reviewDecision })), sort) : [], [report, bySha, status, wg, file, reviewDecision, sort]);

  const selectCommit = useCallback((sha: string, urlMode: "push" | "replace" | "none" = "none") => {
    useSelectionStore.getState().setSelected(sha);
    if (urlMode !== "none") updateUrlForSha(sha, urlMode);
  }, []);

  const openCommit = useCallback((sha: string, urlMode: "push" | "replace" = "push") => {
    selectCommit(sha, urlMode);
    scrollToSha(sha);
  }, [selectCommit]);

  useEffect(() => {
    const selected = useSelectionStore.getState().selected;
    if (!rows.length) useSelectionStore.getState().setSelected(null);
    else if (!selected || !rows.some((commit) => commit.sha === selected)) {
      useSelectionStore.getState().setSelected(rows[0].sha);
      updateUrlForSha(rows[0].sha, "replace");
    }
  }, [rows]);

  useEffect(() => {
    if (!report) return;
    const onHashChange = () => {
      const sha = shaFromHash(report.commits);
      if (!sha) return;
      useSelectionStore.getState().setSelected(sha);
      window.setTimeout(() => scrollToSha(sha), 0);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [report]);

  useVisibleCommitObserver(rows, (sha) => {
    if (useSelectionStore.getState().selected !== sha) {
      useSelectionStore.getState().setSelected(sha);
      scheduleUrlForSha(sha);
    }
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      const editing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (editing && event.key !== "Escape") return;
      if (event.key === "Escape" && editing) {
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      const selected = useSelectionStore.getState().selected;
      if (!report || !selected) return;
      const key = event.key.toLowerCase();
      if (key === "a") {
        event.preventDefault();
        useReviewStore.getState().setDecision(selected, "approve");
      } else if (key === "r") {
        event.preventDefault();
        useReviewStore.getState().setDecision(selected, "reject");
      } else if (key === "d" || key === "h") {
        event.preventDefault();
        useReviewStore.getState().setDecision(selected, "defer");
      } else if (key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const next = relativeCommit(rows, selected, 1);
        openCommit(next.sha, "replace");
      } else if (key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = relativeCommit(rows, selected, -1);
        openCommit(next.sha, "replace");
      } else if (key === "c") {
        event.preventDefault();
        copyPlan(report, rows, bySha, setCopied);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [report, rows, bySha, openCommit]);

  if (error) {
    return <div className="empty">Could not load review data: {error}</div>;
  }
  if (!report || !options) {
    return <div className="empty">Loading review data.</div>;
  }

  return (
    <EnhancementContext.Provider value={linksEnabled}>
      <header>
        <h1>{isAuditReport(report) ? "AutoFHIR Issue Fixup Audit Review" : "AutoFHIR Issue Fixup Diffs"}</h1>
        <div className="meta">
          <span>Run: {report.run.run_id}</span>
          {isAuditReport(report) ? <span>Audit view</span> : null}
          <span>Proposed commits: {report.run.github_tree_url ? <a href={report.run.github_tree_url} target="_blank" rel="noreferrer">GitHub branch</a> : report.run.run_id}</span>
          <span>Commits: {report.counts.commits}</span>
          <span>With results: {report.counts.with_result}</span>
          <span>WGs: {Object.keys(report.counts.by_wg || {}).length}</span>
          <span>Generated: {report.generated_at}</span>
          {report.run.github_compare_url && <a href={report.run.github_compare_url} target="_blank" rel="noreferrer">Full branch diff on GitHub</a>}
        </div>
      </header>
      <Intro report={report} />
      <div className="controls">
        <Facet className="control-status" value={status} onChange={setStatus} label="All commit types" options={options.statuses} />
        <Facet className="control-wg" value={wg} onChange={setWg} label="All work groups" options={options.wgs} />
        <Facet className="control-file" value={file} onChange={setFile} label="All changed files" options={options.files} />
        <Facet className="control-review" value={reviewDecision} onChange={setReviewDecision} label="All review choices" options={options.reviews} />
        <select className="control-sort" value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="wg">Group by work group</option>
          <option value="branch">Commit order</option>
        </select>
      </div>
      <div className="reviewbar">
        <div>
          <div>{reviewCountText(report.commits, bySha)}</div>
          <div className="help">Shortcuts: <strong>A</strong> approve, <strong>R</strong> reject, <strong>D</strong> defer, <strong>J/K</strong> next/previous, <strong>C</strong> copy review plan. Browser Ctrl-F searches the rendered commit messages and diffs.</div>
        </div>
        <div className="buttons">
          <button className={copied ? "primary copied" : "primary"} onClick={() => copyPlan(report, rows, bySha, setCopied)}>{copied ? "Copied" : "Copy Review Plan"}</button>
          <button onClick={() => clear(rows.map((commit) => commit.sha))}>Clear Visible Review State</button>
        </div>
      </div>
      <SelectionSideEffects />
      <main>
        <CommitList rows={rows} onOpen={openCommit} sort={sort} />
        <CommitDetails rows={rows} onSelect={selectCommit} sort={sort} diffsEnabled={diffsEnabled} />
      </main>
    </EnhancementContext.Provider>
  );
}

function SelectionSideEffects() {
  const selected = useSelectionStore((state) => state.selected);
  useEffect(() => {
    if (!selected) return;
    const timer = window.setTimeout(() => scrollSidebarToSha(selected), 120);
    return () => window.clearTimeout(timer);
  }, [selected]);
  return null;
}

function Intro({ report }: { report: Report }) {
  if (isAuditReport(report)) {
    return (
      <section className="intro" aria-label="Review guide">
        <p>
          This audit view reviews the generated reconciliation commits using the second-pass audit results. Filter by audit decision: Keep, Tweak, Human review, or Drop. Each card shows the audit replacement commit message first, so the text you review is the proposed rewritten message rather than the original generated message.
        </p>
        <p>
          Use the Jira, proposed GitHub commit, prior HL7/fhir commits, audit recommendation, and diff together before marking your review choice. Mark each item Approve, Reject, or Defer; notes are saved locally in this browser. Copy Review Plan exports your choices plus the portable branch/artifact links for an agent to apply the reviewed decisions.
        </p>
      </section>
    );
  }
  return (
    <section className="intro" aria-label="Review guide">
      <p>
        This page reviews proposed commits that reconcile FHIR Jira resolutions with the current spec source. Use the filters to narrow by outcome, work group, file, or your review choice. Open each card's Jira, proposed GitHub commit, and any prior HL7/fhir commits mentioning the same issue before deciding. The colored diff is embedded for scanning; use the full GitHub diff link when a patch is truncated or you need complete context.
      </p>
      <p>
        Example starting points: <a href="#commit-a87868d1c99971648781cb8f157784658e6279a2">source fix</a>, <a href="#commit-e0a9c71f754cff2750a475160e037c5fcb2c4655">no source change needed</a>, <a href="#commit-b2a6724ff6542b1c786150011abb524017952ac7">needs human review</a>, and <a href="#commit-23dcb49d3396d4ec09cce8ca3673adaf77e2f63d">issue with prior commits</a>. Mark each item Approve, Reject, or Defer; notes are saved locally in this browser. Use Copy Review Plan to export your decisions, links, and notes as a prompt that another LLM agent can use to apply or omit the reviewed commits.
      </p>
    </section>
  );
}

function Facet({ label, value, options, onChange, className }: { label: string; value: string; options: FacetOption[]; onChange: (value: string) => void; className?: string }) {
  return (
    <select className={className} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{label} ({options.total})</option>
      {options.items.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}
    </select>
  );
}

function CommitList({ rows, onOpen, sort }: { rows: CommitReport[]; onOpen: (sha: string) => void; sort: string }) {
  let lastGroup = "";
  return (
    <div className="list">
      {rows.map((commit) => {
        const group = wgTitle(commit);
        const header = sort === "wg" && group !== lastGroup;
        if (header) lastGroup = group;
        return (
          <React.Fragment key={commit.sha}>
            {header && <div className="group-header">{group}</div>}
            <CommitRow commit={commit} onOpen={onOpen} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

const CommitRow = memo(function CommitRow({ commit, onOpen }: { commit: CommitReport; onOpen: (sha: string) => void }) {
  const active = useSelectionStore((state) => state.selected === commit.sha);
  const rawEntry = useReviewStore((state) => state.bySha[commit.sha]);
  const entry = normalizeEntry(rawEntry);
  return (
    <button id={`row-${commit.sha}`} type="button" className={active ? "row active" : "row"} onClick={() => onOpen(commit.sha)}>
      <span className="row-title">{commit.short_sha} {commit.subject}</span>
      <span className="row-summary">{displaySummary(commit)}</span>
      <span className="chips">
        <Chip value={commit.issue_key} />
        <OutcomeChip value={commit.status || commit.decision_status} />
        <Chip value={commit.wg || "unknown"} />
        <Chip value={decisionLabel(entry.decision)} className={entry.decision} />
        <Chip value={`${commit.files?.length || 0} files`} />
      </span>
    </button>
  );
});

function CommitDetails({ rows, onSelect, sort, diffsEnabled }: { rows: CommitReport[]; onSelect: (sha: string) => void; sort: string; diffsEnabled: boolean }) {
  let lastGroup = "";
  const selectCommit = useCallback((sha: string) => onSelect(sha), [onSelect]);
  return (
    <div className="detail">
      {rows.length ? rows.map((commit) => {
        const group = wgTitle(commit);
        const header = sort === "wg" && group !== lastGroup;
        if (header) lastGroup = group;
        return (
          <React.Fragment key={commit.sha}>
            {header && <div className="detail-group">{group}</div>}
            <CommitCard commit={commit} onSelect={selectCommit} diffsEnabled={diffsEnabled} />
          </React.Fragment>
        );
      }) : <div className="empty">No commits match the current filters.</div>}
    </div>
  );
}

const CommitCard = memo(function CommitCard({ commit, onSelect, diffsEnabled }: { commit: CommitReport; onSelect: (sha: string) => void; diffsEnabled: boolean }) {
  const selected = useSelectionStore((state) => state.selected === commit.sha);
  const rawEntry = useReviewStore((state) => state.bySha[commit.sha]);
  const entry = normalizeEntry(rawEntry);
  const setDecision = useReviewStore((state) => state.setDecision);
  const setNote = useReviewStore((state) => state.setNote);
  const body = useLazyText(commit.sha, commit.body, commit.body_url);
  const originalBody = useLazyText(commit.sha, commit.original_body, commit.original_body_url);
  return (
    <article id={`commit-${commit.sha}`} data-sha={commit.sha} className={selected ? "commit-card active" : "commit-card"} onFocus={() => onSelect(commit.sha)}>
      <div className="card-head">
        <h2>
          {commit.short_sha} {commit.subject}
          <a className="permalink" href={`#commit-${commit.sha}`} title="Permalink to this review item" aria-label={`Permalink to ${commit.issue_key || commit.short_sha}`} onClick={() => onSelect(commit.sha)}>#</a>
          {commit.github_commit_url && <a className="full-link" href={commit.github_commit_url} target="_blank" rel="noreferrer">{commit.patch_truncated ? "Full diff on GitHub (required)" : "Full diff on GitHub"}</a>}
        </h2>
        <div className="chips">
          <Chip value={commit.issue_key} />
          <OutcomeChip value={commit.status || commit.decision_status} />
          <Chip value={commit.wg || "unknown"} />
          <Chip value={decisionLabel(entry.decision)} className={entry.decision} />
          <Chip value={`${commit.files?.length || 0} files`} />
          {commit.patch_truncated && <Chip value="embedded diff incomplete" />}
        </div>
        <div className="decision-grid">
          <div className="decision-actions">
            {reviewOptions.filter(([value]) => value !== "undecided").map(([value, label]) => (
              <button key={value} type="button" className={`decision-button ${value}${entry.decision === value ? " active" : ""}`} onClick={() => setDecision(commit.sha, value)}>{label}</button>
            ))}
          </div>
          <textarea className="decision-note" value={entry.note} onChange={(event) => setNote(commit.sha, event.target.value)} placeholder="Optional review note for later apply/exclude context" />
        </div>
      </div>
      <div className="card-body">
        {commit.omitted_patch_files?.length ? <div className="notice critical">Embedded diff is incomplete for this commit. Use the GitHub full diff link for complete content.</div> : null}
        <CommitOverview commit={commit} />
        <CommitMessageNarrative commit={commit} body={body} />
        {!commit.audit_decision ? (
          <details className="review-details">
            <summary>Raw git commit message</summary>
            <pre className="commit-message">{body || commit.subject || "(empty commit message)"}</pre>
          </details>
        ) : null}
        {originalBody && !commit.audit_decision ? (
          <details className="review-details">
            <summary>Original generated commit message</summary>
            <pre className="commit-message">{originalBody}</pre>
          </details>
        ) : null}
        <details className="review-details">
          <summary>{commit.audit_decision ? "Files and stats" : "Fixup agent assessment, files, and stats"}</summary>
          {commit.audit_decision ? <FilesAndStats commit={commit} /> : <AgentAssessment commit={commit} />}
        </details>
        {diffsEnabled ? <DiffSection commit={commit} /> : <DeferredDiffSection />}
      </div>
    </article>
  );
});

function DeferredDiffSection() {
  return (
    <section className="diff-section">
      <div className="section-heading">
        <h3>Diff</h3>
      </div>
      <pre className="diff-text">Loading diff after initial review content.</pre>
    </section>
  );
}

function CommitOverview({ commit }: { commit: CommitReport }) {
  return (
    <section className="overview">
      <div className="link-row">
        {commit.issue_key ? <a href={jiraUrl(commit.issue_key)} target="_blank" rel="noreferrer">Jira {commit.issue_key}</a> : <span>No Jira issue</span>}
        {commit.github_commit_url ? <a href={commit.github_commit_url} target="_blank" rel="noreferrer">GitHub commit {commit.short_sha}</a> : null}
        {commit.result_path ? <span>{commit.audit_decision ? "Audit report" : "Agent report"}: {commit.result_path}</span> : <span>No agent report JSON</span>}
      </div>
      <PreviousIssueCommits commit={commit} />
      <SeedDecisions commit={commit} />
      <dl className="metadata-grid">
        <div><dt>{commit.audit_decision ? "Audit Decision" : "Result"}</dt><dd>{outcomeLabel(commit.status || commit.decision_status)}</dd></div>
        {commit.fixup_status ? <div><dt>Original Fixup Result</dt><dd>{outcomeLabel(commit.fixup_status)}</dd></div> : null}
        {commit.audit_confidence ? <div><dt>Audit Confidence</dt><dd>{commit.audit_confidence}</dd></div> : null}
        <div><dt>Work Group</dt><dd>{wgTitle(commit)}</dd></div>
      </dl>
      {commit.audit_source_tweaks_needed?.length ? (
        <section className="narrative-section">
          <h3>Source Tweaks Needed</h3>
          <ul className="file-list">
            {commit.audit_source_tweaks_needed.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function SeedDecisions({ commit }: { commit: CommitReport }) {
  const decisions = commit.seed_decisions || [];
  if (!commit.seed_key || decisions.length <= 1) return null;
  return (
    <section className="previous-commits seed-decisions">
      <h3>Issues Decided From Seed {commit.seed_key}</h3>
      <ul>
        {decisions.map((decision) => (
          <li key={decision.issue_key}>
            <a href={jiraUrl(decision.issue_key)} target="_blank" rel="noreferrer">{decision.issue_key}</a>
            {decision.role ? <span className="chip">{decision.role}</span> : null}
            {decision.status ? <span className={`chip ${decision.status}`}>{outcomeLabel(decision.status)}</span> : null}
            <span>{decision.summary || ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type MessageSection = { key: string; title: string; text: string };

const commitSectionTitles = [
  "Issue request",
  "Initial application",
  "Additional context",
  "AutoFHIR fixup",
  "AutoFHIR reconciliation",
  "Recommendation",
];

// Loads commit text that the report may inline (`inline`) or externalize behind a
// side-file URL (`url`, e.g. messages/<id>.txt). Mirrors the patch_url lazy load so
// large reports stay small while the full commit message still renders into the DOM.
function useLazyText(sha: string, inline: string | undefined, url: string | undefined): string {
  const [text, setText] = useState(inline ?? "");
  useEffect(() => {
    let cancelled = false;
    if (inline !== undefined) {
      setText(inline);
      return () => { cancelled = true; };
    }
    if (!url) {
      setText("");
      return () => { cancelled = true; };
    }
    setText("");
    fetchPatchQueued(assetUrl(url))
      .then((value) => waitForScrollIdle().then(() => value))
      .then((value) => { if (!cancelled) setText(value); })
      .catch(() => { if (!cancelled) setText(""); });
    return () => { cancelled = true; };
  }, [sha, inline, url]);
  return text;
}

function CommitMessageNarrative({ commit, body }: { commit: CommitReport; body: string }) {
  const sections = React.useMemo(() => parsedMessageSections(commit, body), [body, commit.subject, commit.commit_summary, commit.commit_context, commit.recommendation]);
  if (!sections.length) {
    return (
      <section className="narrative-card">
        <h3>Commit message</h3>
        <p>{displaySummary(commit) || "(no summary)"}</p>
      </section>
    );
  }
  return (
    <section className="message-sections" aria-label="Parsed commit message">
      {sections.map((section) => (
        <article key={section.key} className={`message-section message-${section.key}`}>
          <h3>{section.title}</h3>
          <RichText text={section.text} />
        </article>
      ))}
    </section>
  );
}

function parsedMessageSections(commit: CommitReport, body: string): MessageSection[] {
  const fromBody = sectionsFromBody(body || "");
  if (fromBody.length) return fromBody;
  const fromExportedFields = sectionsFromExportedFields(commit);
  if (fromExportedFields.length) return fromExportedFields;
  return [];
}

function sectionsFromBody(body: string): MessageSection[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (current && isCommitMetadataStart(trimmed)) {
      current = null;
      continue;
    }
    const title = commitSectionTitles.find((candidate) => trimmed === `${candidate}:` || trimmed.startsWith(`${candidate}: `));
    if (title) {
      current = title;
      if (!sections.has(title)) sections.set(title, []);
      const inline = trimmed.slice(title.length + 1).trim();
      if (inline) sections.get(title)!.push(inline);
      continue;
    }
    if (current) sections.get(current)!.push(line);
  }
  return commitSectionTitles
    .map((title) => ({ key: sectionKey(title), title, text: (sections.get(title) || []).join("\n").trim() }))
    .filter((section) => section.text);
}

function isCommitMetadataStart(trimmed: string) {
  return /^AutofHIR-Run:/i.test(trimmed)
    || /^Issue-Fixup-/i.test(trimmed)
    || /^Issue-Reconcile-/i.test(trimmed)
    || /^<\/?(related-jiras|evidence)>$/i.test(trimmed)
    || /^Verification:/i.test(trimmed);
}

function sectionsFromExportedFields(commit: CommitReport): MessageSection[] {
  const sections: MessageSection[] = [];
  if (commit.commit_summary) {
    sections.push({ key: "issue-request", title: "Issue request", text: stripSectionPrefix(commit.commit_summary, "Issue request") });
  }
  if (commit.commit_context) {
    sections.push(...sectionsFromBody(`${commit.commit_context}\n`));
  }
  if (commit.recommendation && !sections.some((section) => section.key === "recommendation")) {
    sections.push({ key: "recommendation", title: "Recommendation", text: commit.recommendation });
  }
  return sections.filter((section) => section.text.trim());
}

function stripSectionPrefix(text: string, title: string) {
  return text.replace(new RegExp(`^${escapeRegExp(title)}:\\s*`, "i"), "").trim();
}

function sectionKey(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function RichText({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const bulletLines = paragraph.split("\n").map((line) => line.trim()).filter(Boolean);
        if (bulletLines.length > 1 && bulletLines.every((line) => /^[-*]\s+/.test(line))) {
          return (
            <ul key={index}>
              {bulletLines.map((line) => <li key={line}><LinkifiedText text={line.replace(/^[-*]\s+/, "")} /></li>)}
            </ul>
          );
        }
        return <p key={index}><LinkifiedText text={paragraph} /></p>;
      })}
    </>
  );
}

function LinkifiedText({ text }: { text: string }) {
  const linksEnabled = React.useContext(EnhancementContext);
  if (!linksEnabled) return <>{text}</>;
  const tokenPattern = /(FHIR-\d+|PR\s+#?\d+|(?<![A-Za-z0-9])[a-f0-9]{7,40}(?![A-Za-z0-9]))/gi;
  const pieces: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index || 0;
    if (index > last) pieces.push(text.slice(last, index));
    pieces.push(linkForToken(token, `${index}-${token}`));
    last = index + token.length;
  }
  if (last < text.length) pieces.push(text.slice(last));
  return <>{pieces}</>;
}

function linkForToken(token: string, key: string) {
  const normalized = token.toUpperCase();
  if (/^FHIR-\d+$/.test(normalized)) {
    return <a key={key} href={jiraUrl(normalized)} target="_blank" rel="noreferrer">{token}</a>;
  }
  const pr = token.match(/^PR\s+#?(\d+)$/i);
  if (pr) {
    return <a key={key} href={`https://github.com/HL7/fhir/pull/${pr[1]}`} target="_blank" rel="noreferrer">{token}</a>;
  }
  if (/^[a-f0-9]{7,40}$/i.test(token)) {
    const label = token.length > 7 ? token.slice(0, 7) : token;
    return <a key={key} href={`https://github.com/HL7/fhir/commit/${token}`} target="_blank" rel="noreferrer" title={token}>{label}</a>;
  }
  return token;
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function useVisibleCommitObserver(rows: CommitReport[], onVisible: (sha: string) => void) {
  const callbackRef = useRef(onVisible);
  const pendingShaRef = useRef<string | null>(null);
  const notifyTimerRef = useRef<number>(0);
  useEffect(() => {
    callbackRef.current = onVisible;
  }, [onVisible]);

  useEffect(() => {
    if (!rows.length) return;
    if (!("IntersectionObserver" in window)) {
      let frame = 0;
      const updateFromScroll = () => {
        frame = 0;
        const sha = visibleSha(rows);
        if (sha) callbackRef.current(sha);
      };
      const onScroll = () => {
        if (!frame) frame = window.requestAnimationFrame(updateFromScroll);
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
      window.setTimeout(updateFromScroll, 0);
      return () => {
        if (frame) window.cancelAnimationFrame(frame);
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
      };
    }

    const notify = (sha: string) => {
      pendingShaRef.current = sha;
      if (notifyTimerRef.current) window.clearTimeout(notifyTimerRef.current);
      notifyTimerRef.current = window.setTimeout(() => {
        notifyTimerRef.current = 0;
        const pending = pendingShaRef.current;
        if (!pending) return;
        waitForScrollIdle().then(() => {
          if (pendingShaRef.current) callbackRef.current(pendingShaRef.current);
        });
      }, 80);
    };
    const visible = new Map<string, DOMRectReadOnly>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const sha = (entry.target as HTMLElement).dataset.sha;
        if (!sha) continue;
        if (entry.isIntersecting) visible.set(sha, entry.boundingClientRect);
        else visible.delete(sha);
      }
      const topOffset = stickyBottomOffset() + 8;
      const best = [...visible.entries()]
        .filter(([, rect]) => rect.bottom > topOffset)
        .sort((a, b) => Math.abs(a[1].top - topOffset) - Math.abs(b[1].top - topOffset))[0];
      if (best) notify(best[0]);
    }, {
      root: null,
      rootMargin: `-${Math.ceil(stickyBottomOffset() + 8)}px 0px -55% 0px`,
      threshold: [0, 0.01, 0.1],
    });

    let cancelled = false;
    window.requestAnimationFrame(() => {
      if (cancelled) return;
      for (const commit of rows) {
        const element = document.getElementById(`commit-${commit.sha}`);
        if (element) observer.observe(element);
      }
    });
    return () => {
      cancelled = true;
      if (notifyTimerRef.current) window.clearTimeout(notifyTimerRef.current);
      notifyTimerRef.current = 0;
      observer.disconnect();
    };
  }, [rows]);
}

function PreviousIssueCommits({ commit }: { commit: CommitReport }) {
  const previous = commit.previous_issue_commits || [];
  if (!previous.length) return null;
  return (
    <section className="previous-commits">
      <h3>Prior HL7/fhir commits mentioning {commit.issue_key}</h3>
      <ul>
        {previous.map((prior) => (
          <li key={prior.sha}>
            <a href={prior.github_commit_url} target="_blank" rel="noreferrer">{prior.short_sha}</a>
            <span>{prior.subject}</span>
            <small>{dateOnly(prior.authored_at)} · {prior.author}</small>
          </li>
        ))}
      </ul>
      {commit.previous_issue_commits_omitted ? <div className="help">Omitted {commit.previous_issue_commits_omitted} additional matching commits.</div> : null}
    </section>
  );
}

function AgentAssessment({ commit }: { commit: CommitReport }) {
  return (
    <div className="assessment">
      {commit.summary ? (
        <section className="narrative-section">
          <h3>Fixup Agent Summary</h3>
          <p>{commit.summary}</p>
        </section>
      ) : null}
      {commit.recommendation ? (
        <section className="narrative-section">
          <h3>Fixup Agent Recommendation</h3>
          <p>{commit.recommendation}</p>
        </section>
      ) : null}
      <FilesAndStats commit={commit} />
    </div>
  );
}

function FilesAndStats({ commit }: { commit: CommitReport }) {
  return (
    <div className="assessment">
      <section className="narrative-section">
        <h3>Files</h3>
        <ul className="file-list">
          {(commit.files?.length ? commit.files : ["(none)"]).map((file) => <li key={file}>{file}</li>)}
        </ul>
      </section>
      <section className="narrative-section">
        <h3>Stat</h3>
        <pre className="stat-text">{commit.stat || "(none)"}</pre>
      </section>
    </div>
  );
}

function DiffSection({ commit }: { commit: CommitReport }) {
  const hasEmbeddedPatch = commit.patch !== undefined;
  const [patch, setPatch] = useState(commit.patch ?? "");
  const [patchState, setPatchState] = useState<"ready" | "loading" | "error">(hasEmbeddedPatch ? "ready" : commit.patch_url ? "loading" : "ready");
  const preRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPatch(commit.patch ?? "");
    if (commit.patch !== undefined || !commit.patch_url) {
      setPatchState("ready");
      return () => { cancelled = true; };
    }
    setPatchState("loading");
    fetchPatchQueued(assetUrl(commit.patch_url))
      .then((text) => {
        return waitForScrollIdle().then(() => text);
      })
      .then((text) => {
        if (!cancelled) {
          setPatch(text);
          setPatchState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setPatchState("error");
    });
    return () => { cancelled = true; };
  }, [commit.sha, commit.patch, commit.patch_url]);
  const patchText =
    patch || (patchState === "loading" ? "Loading diff." : patchState === "error" ? "Could not load embedded diff. Use the GitHub full diff link." : "(empty commit; no source diff)");
  useEffect(() => {
    const element = preRef.current;
    if (!element) return;
    registerDiffHighlights(commit.sha, element, patchText);
    return () => unregisterDiffHighlights(commit.sha);
  }, [commit.sha, patchText]);
  return (
    <section className="diff-section">
      <div className="section-heading">
        <h3>Diff</h3>
      </div>
      {commit.patch_truncated ? <div className="notice critical">Embedded diff is truncated. Use the GitHub full diff link for complete content.</div> : null}
      <pre ref={preRef} className="diff-text" aria-label={`Diff for ${commit.subject}`}>{patchText}</pre>
    </section>
  );
}

type PatchJob = {
  url: string;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
};

const patchCache = new Map<string, string>();
const patchInflight = new Map<string, Promise<string>>();
const patchQueue: PatchJob[] = [];
let activePatchLoads = 0;
const maxPatchLoads = 4;
let scrollTrackerInstalled = false;
let scrollIdleTimer = 0;
let scrollBusyUntil = 0;
let scrollIdleWaiters: (() => void)[] = [];

function fetchPatchQueued(url: string): Promise<string> {
  const cached = patchCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  const inflight = patchInflight.get(url);
  if (inflight) return inflight;
  const promise = new Promise<string>((resolve, reject) => {
    patchQueue.push({ url, resolve, reject });
    pumpPatchQueue();
  });
  patchInflight.set(url, promise);
  promise.finally(() => patchInflight.delete(url));
  return promise;
}

function pumpPatchQueue() {
  if (!isScrollIdle()) {
    scheduleScrollIdleFlush();
    return;
  }
  while (activePatchLoads < maxPatchLoads && patchQueue.length) {
    const job = patchQueue.shift()!;
    activePatchLoads++;
    fetch(job.url)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.text();
      })
      .then((text) => {
        patchCache.set(job.url, text);
        job.resolve(text);
      })
      .catch(job.reject)
      .finally(() => {
        activePatchLoads--;
        pumpPatchQueue();
      });
  }
}

function ensureScrollIdleTracker() {
  if (scrollTrackerInstalled || typeof window === "undefined") return;
  scrollTrackerInstalled = true;
  window.addEventListener("scroll", () => {
    scrollBusyUntil = performance.now() + 250;
    scheduleScrollIdleFlush();
  }, { passive: true });
}

function isScrollIdle() {
  return typeof performance === "undefined" || performance.now() >= scrollBusyUntil;
}

function waitForScrollIdle() {
  ensureScrollIdleTracker();
  if (isScrollIdle()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    scrollIdleWaiters.push(resolve);
    scheduleScrollIdleFlush();
  });
}

function scheduleScrollIdleFlush() {
  if (scrollIdleTimer || typeof window === "undefined") return;
  const delay = Math.max(16, scrollBusyUntil - performance.now());
  scrollIdleTimer = window.setTimeout(() => {
    scrollIdleTimer = 0;
    if (!isScrollIdle()) {
      scheduleScrollIdleFlush();
      return;
    }
    const waiters = scrollIdleWaiters;
    scrollIdleWaiters = [];
    for (const resolve of waiters) resolve();
    pumpPatchQueue();
  }, delay);
}

type HighlightRangeSet = Record<DiffGroup["kind"], Range[]>;

const diffHighlightRegistry = new Map<string, HighlightRangeSet>();
let diffHighlightFrame = 0;

function registerDiffHighlights(id: string, element: HTMLPreElement, text: string) {
  if (!supportsCssHighlights()) return;
  const node = element.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const ranges: HighlightRangeSet = { meta: [], hunk: [], add: [], del: [], context: [] };
  let offset = 0;
  for (const line of text.split("\n")) {
    const length = line.length;
    const kind = diffKind(line);
    if (length && kind !== "context") {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + length);
      ranges[kind].push(range);
    }
    offset += length + 1;
  }
  diffHighlightRegistry.set(id, ranges);
  scheduleDiffHighlightApply();
}

function unregisterDiffHighlights(id: string) {
  if (!supportsCssHighlights()) return;
  diffHighlightRegistry.delete(id);
  scheduleDiffHighlightApply();
}

function scheduleDiffHighlightApply() {
  if (diffHighlightFrame || typeof window === "undefined") return;
  diffHighlightFrame = window.requestAnimationFrame(() => {
    diffHighlightFrame = 0;
    applyDiffHighlights();
  });
}

function applyDiffHighlights() {
  if (!supportsCssHighlights()) return;
  const merged: HighlightRangeSet = { meta: [], hunk: [], add: [], del: [], context: [] };
  for (const ranges of diffHighlightRegistry.values()) {
    merged.meta.push(...ranges.meta);
    merged.hunk.push(...ranges.hunk);
    merged.add.push(...ranges.add);
    merged.del.push(...ranges.del);
  }
  setHighlight("autofhir-diff-meta", merged.meta);
  setHighlight("autofhir-diff-hunk", merged.hunk);
  setHighlight("autofhir-diff-add", merged.add);
  setHighlight("autofhir-diff-del", merged.del);
}

function setHighlight(name: string, ranges: Range[]) {
  const highlightApi = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  if (!highlightApi) return;
  if (!ranges.length) {
    highlightApi.delete(name);
    return;
  }
  highlightApi.set(name, new Highlight(...ranges));
}

function supportsCssHighlights() {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

type FacetOption = { total: number; items: { value: string; label: string; count: number }[] };

function buildOptions(report: Report, bySha: Record<string, ReviewEntry>, filters: Record<string, string>) {
  return {
    statuses: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, status: "" })), (c) => [statusValue(c)], outcomeLabel),
    wgs: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, wg: "" })), (c) => [wgCode(c)], (value) => {
      const sample = report.commits.find((c) => wgCode(c) === value);
      return `${value} · ${sample ? wgName(sample) : value}`;
    }),
    files: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, file: "" })), (c) => c.files || [], (value) => value),
    reviews: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, reviewDecision: "" })), (c) => [reviewEntry(c.sha, bySha).decision], decisionLabel),
  };
}

function facet(rows: CommitReport[], valuesFor: (commit: CommitReport) => string[], labelFor: (value: string) => string): FacetOption {
  const counts = new Map<string, number>();
  for (const row of rows) for (const value of valuesFor(row).filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return {
    total: rows.length,
    items: [...counts.entries()].sort((a, b) => b[1] - a[1] || labelFor(a[0]).localeCompare(labelFor(b[0]))).map(([value, count]) => ({ value, label: labelFor(value), count })),
  };
}

function passes(commit: CommitReport, bySha: Record<string, ReviewEntry>, filters: Record<string, string>) {
  return (!filters.status || statusValue(commit) === filters.status)
    && (!filters.wg || wgCode(commit) === filters.wg)
    && (!filters.file || (commit.files || []).includes(filters.file))
    && (!filters.reviewDecision || reviewEntry(commit.sha, bySha).decision === filters.reviewDecision);
}

function ordered(rows: CommitReport[], sort: string) {
  const copy = rows.slice();
  if (sort === "wg") {
    copy.sort((a, b) => wgName(a).localeCompare(wgName(b)) || wgCode(a).localeCompare(wgCode(b)) || a.sequence - b.sequence);
  } else {
    copy.sort((a, b) => a.sequence - b.sequence);
  }
  return copy;
}

function statusValue(commit: CommitReport) {
  return commit.status || commit.decision_status || "none";
}

function isSourceChanging(commit: CommitReport) {
  return (commit.files || []).length > 0;
}

// Default the combined "commit types" filter to the status shared by the
// source-changing commits (e.g. "fixed"), so reviewers land on source changes
// first while still being able to pick any other commit type from the dropdown.
function sourceChangingStatus(commits: CommitReport[]) {
  const counts = new Map<string, number>();
  for (const commit of commits) {
    if (!isSourceChanging(commit)) continue;
    const value = statusValue(commit);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function outcomeLabel(value?: string) {
  return ({
    keep: "Keep",
    tweak: "Tweak",
    "human-review": "Human review",
    drop: "Drop",
    fixed: "Source change made",
    "no-change": "No source change needed",
    "external-repo": "External repo",
    ambiguous: "Needs human review",
    blocked: "Blocked",
    none: "Missing review data",
  } as Record<string, string>)[value || "none"] || value || "Missing review data";
}

function wgCode(commit: CommitReport) {
  return commit.wg || "unknown";
}

function wgName(commit: CommitReport) {
  return commit.wg_label || commit.wg || "Unknown";
}

function wgTitle(commit: CommitReport) {
  return `${wgCode(commit)} · ${wgName(commit)}`;
}

function displaySummary(commit: CommitReport) {
  return commit.audit_recommended_next_step || commit.recommendation || commit.commit_summary || commit.summary || "";
}

function isAuditReport(report: Report) {
  return report.schema_version === "issue-fixup-audit-review-v1" || Boolean(report.run.audit_run_id);
}

function dateOnly(value?: string) {
  return value ? value.slice(0, 10) : "";
}

function reviewEntry(sha: string, bySha = useReviewStore.getState().bySha) {
  return normalizeEntry(bySha[sha]);
}

function decisionLabel(value: string) {
  return (reviewOptions.find(([candidate]) => candidate === value)?.[1] || value || "Undecided");
}

function reviewCountText(commits: CommitReport[], bySha: Record<string, ReviewEntry>) {
  const counts: Record<ReviewDecision, number> = { approve: 0, reject: 0, defer: 0, undecided: 0 };
  for (const commit of commits) counts[reviewEntry(commit.sha, bySha).decision]++;
  return `Your review: approve ${counts.approve} · reject ${counts.reject} · defer ${counts.defer} · undecided ${counts.undecided}`;
}

function relativeCommit(rows: CommitReport[], selected: string, delta: number) {
  const index = Math.max(0, rows.findIndex((commit) => commit.sha === selected));
  return rows[Math.min(rows.length - 1, Math.max(0, index + delta))] || rows[0];
}

function shaFromHash(commits: CommitReport[]) {
  const rawHash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  if (!rawHash) return null;
  const token = rawHash.startsWith("commit-") ? rawHash.slice("commit-".length) : rawHash;
  return commits.find((commit) => commit.sha === token || commit.short_sha === token || commit.issue_key === token)?.sha || null;
}

function updateUrlForSha(sha: string, mode: "push" | "replace") {
  const next = new URL(window.location.href);
  next.hash = `commit-${sha}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const target = `${next.pathname}${next.search}${next.hash}`;
  if (current === target) return;
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", next);
}

let scheduledUrlSha: string | null = null;
let scheduledUrlTimer = 0;

function scheduleUrlForSha(sha: string) {
  scheduledUrlSha = sha;
  if (scheduledUrlTimer) window.clearTimeout(scheduledUrlTimer);
  scheduledUrlTimer = window.setTimeout(() => {
    scheduledUrlTimer = 0;
    if (scheduledUrlSha) updateUrlForSha(scheduledUrlSha, "replace");
    scheduledUrlSha = null;
  }, 500);
}

function visibleSha(rows: CommitReport[]) {
  const offset = stickyBottomOffset() + 8;
  for (const commit of rows) {
    const element = document.getElementById(`commit-${commit.sha}`);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom > offset) return commit.sha;
  }
  return rows[rows.length - 1]?.sha || null;
}

function stickyBottomOffset() {
  const reviewbar = document.querySelector(".reviewbar")?.getBoundingClientRect();
  if (reviewbar && reviewbar.bottom > 0) return reviewbar.bottom;
  const controls = document.querySelector(".controls")?.getBoundingClientRect();
  return controls && controls.bottom > 0 ? controls.bottom : 0;
}

function scrollToSha(sha: string) {
  window.setTimeout(() => document.getElementById(`commit-${sha}`)?.scrollIntoView({ block: "start", behavior: "auto" }), 0);
}

function scrollSidebarToSha(sha: string) {
  const row = document.getElementById(`row-${sha}`);
  const list = row?.closest(".list") as HTMLElement | null;
  if (!row || !list || getComputedStyle(list).overflowY === "visible") return;
  const rowRect = row.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  if (rowRect.top < listRect.top) {
    list.scrollTop -= listRect.top - rowRect.top + 8;
  } else if (rowRect.bottom > listRect.bottom) {
    list.scrollTop += rowRect.bottom - listRect.bottom + 8;
  }
}

function Chip({ value, className }: { value?: string; className?: string }) {
  if (!value) return null;
  return <span className={`chip ${className || value}`}>{value}</span>;
}

function OutcomeChip({ value }: { value?: string }) {
  return <span className={`chip ${value || "none"}`} title={outcomeLabel(value)}>{outcomeLabel(value)}</span>;
}

function jiraUrl(key?: string) {
  return key && /^FHIR-\d+$/.test(key) ? `https://jira.hl7.org/browse/${key}` : "";
}

type DiffGroup = { kind: "meta" | "hunk" | "add" | "del" | "context"; text: string };

function groupedDiff(patch: string): DiffGroup[] {
  const lines = patch ? patch.split("\n") : [];
  const groups: DiffGroup[] = [];
  for (const line of lines) {
    const kind = diffKind(line);
    const last = groups[groups.length - 1];
    if (last?.kind === kind) last.text += `\n${line}`;
    else groups.push({ kind, text: line });
  }
  return groups;
}

function diffKind(line: string): DiffGroup["kind"] {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function artifactUrl(report: Report, name?: string) {
  return name ? new URL(name, report.run.review_raw_base_url || location.href).href : "(not available)";
}

function assetUrl(name: string) {
  const base = window.__AUTOFHIR_REPORT_URL__
    ? new URL(window.__AUTOFHIR_REPORT_URL__, location.href).href
    : location.href;
  return new URL(name, base).href;
}

function reviewPlan(report: Report, visibleRows: CommitReport[], bySha: Record<string, ReviewEntry>) {
  const reviewed = report.commits.filter((commit) => reviewEntry(commit.sha, bySha).decision !== "undecided" || reviewEntry(commit.sha, bySha).note.trim());
  const groups = {
    approve: reviewed.filter((commit) => reviewEntry(commit.sha, bySha).decision === "approve"),
    reject: reviewed.filter((commit) => reviewEntry(commit.sha, bySha).decision === "reject"),
    defer: reviewed.filter((commit) => reviewEntry(commit.sha, bySha).decision === "defer"),
  };
  const lineFor = (commit: CommitReport) => `- ${commit.sha} ${commit.issue_key || ""} ${commit.subject}${reviewEntry(commit.sha, bySha).note ? `\n  Reviewer note: ${reviewEntry(commit.sha, bySha).note}` : ""}`;
  const artifacts = report.run.artifacts || {};
  const payload = {
    schema_version: "issue-fixup-review-decisions-v1",
    run_id: report.run.run_id,
    github_repo: report.run.github_repo || null,
    reconciliation_branch_url: report.run.github_tree_url || null,
    github_compare_url: report.run.github_compare_url || null,
    review_app_url: report.run.review_pages_url || null,
    review_artifact_url: report.run.review_github_tree_url || null,
    base: report.run.base,
    head: report.run.head,
    copied_at: new Date().toISOString(),
    visible_count: visibleRows.length,
    decisions: reviewed.map((commit) => ({
      issue_key: commit.issue_key || null,
      sha: commit.sha,
      subject: commit.subject,
      review_decision: reviewEntry(commit.sha, bySha).decision,
      review_note: reviewEntry(commit.sha, bySha).note,
      github_commit_url: commit.github_commit_url || null,
      files: commit.files || [],
    })),
  };
  return [
    "# AutoFHIR Review Plan",
    "",
    "This whole file can be saved as prompt.md and given to an agent. The agent should use it as the review plan for deciding which commits from the AutoFHIR reconciliation branch to keep, drop, or defer. For post-audit review apps, the reconciliation branch is already pruned to the audit-selected source-changing commits and carries the audit replacement commit messages.",
    "",
    "Portable branch and review locations:",
    `- GitHub repository: ${report.run.github_repo ? `https://github.com/${report.run.github_repo}` : "(not available)"}`,
    `- Reconciliation branch with proposed commits: ${report.run.github_tree_url || "(not available)"}`,
    `- Base commit: ${report.run.base}`,
    `- Current head: ${report.run.head}`,
    `- GitHub compare: ${report.run.github_compare_url || "(not available)"}`,
    `- Review app on GitHub Pages: ${report.run.review_pages_url || "(not available)"}`,
    `- Review app and artifact folder: ${report.run.review_github_tree_url || "(not available)"}`,
    "",
    "Downloadable context artifacts:",
    `- Full source discovery/issue-mapping JSON used as the input to this fixup run: ${artifactUrl(report, artifacts.source_issue_mapping_json_gzip)}`,
    `- Full review JSON used by this app: ${artifactUrl(report, artifacts.fixup_review_json)}`,
    `- Gzipped fixup review JSON with embedded patches: ${artifactUrl(report, artifacts.fixup_review_full_json_gzip || artifacts.fixup_review_json_gzip)}`,
    `- Original pre-audit fixup review JSON, when this is a post-audit app: ${artifactUrl(report, artifacts.source_issue_fixup_review_json_gzip)}`,
    `- Per-commit embedded patch files: ${artifactUrl(report, artifacts.fixup_patch_dir)}`,
    `- Standalone review HTML: ${artifactUrl(report, "index.html")}`,
    `- Source run id: ${report.run.source_run_id || "(unknown)"}`,
    "",
    "How to apply:",
    "1. Start from the base commit above, or from the target branch that already contains that base.",
    "2. Cherry-pick the commits listed under KEEP in the order shown below.",
    "3. Do not apply commits listed under DROP.",
    "4. Treat DEFER as unresolved review work: inspect the note and original commit before deciding whether to apply it later.",
    "5. Resolve conflicts by preserving the reviewed intent, then run the normal FHIR build/tests appropriate for the touched files.",
    "",
    "Decision counts:",
    `- KEEP: ${groups.approve.length}`,
    `- DROP: ${groups.reject.length}`,
    `- DEFER: ${groups.defer.length}`,
    `- Reviewed rows with notes or decisions: ${reviewed.length}`,
    "",
    "## KEEP",
    ...(groups.approve.length ? groups.approve.map(lineFor) : ["(none)"]),
    "",
    "## DROP",
    ...(groups.reject.length ? groups.reject.map(lineFor) : ["(none)"]),
    "",
    "## DEFER",
    ...(groups.defer.length ? groups.defer.map(lineFor) : ["(none)"]),
    "",
    "## Structured Decisions",
    "",
    "BEGIN STRUCTURED JSON",
    JSON.stringify(payload, null, 2),
    "END STRUCTURED JSON",
  ].join("\n");
}

async function copyPlan(report: Report, rows: CommitReport[], bySha: Record<string, ReviewEntry>, setCopied: (value: boolean) => void) {
  const text = reviewPlan(report, rows, bySha);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = document.createElement("textarea");
    box.value = text;
    document.body.appendChild(box);
    box.select();
    document.execCommand("copy");
    box.remove();
  }
  setCopied(true);
  window.setTimeout(() => setCopied(false), 1200);
}

declare global {
  interface Window {
    __AUTOFHIR_REPORT_URL__?: string;
  }
}

createRoot(document.getElementById("root")!).render(<App />);
