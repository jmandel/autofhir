import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type ReviewDecision = "undecided" | "approve" | "reject" | "defer";
type TriageCategory = "misapplied-jira" | "real-fix-unclear-jira" | "not-needed-for-spec-correctness";

type CommitTriage = {
  schema_version: "commit-triage-result-v1" | "commit-triage-result-v2";
  run_id: string;
  source_run_id?: string;
  commit_sha: string;
  issue_key?: string;
  category: TriageCategory;
  summary?: string;
  reviewer_summary?: string;
  category_rationale?: string;
  fhir_spec_impact?: string;
  recommended_reviewer_action?: string;
  confidence: "high" | "medium" | "low";
  justifying_jiras?: { key: string; role: string; why: string }[];
  jira_evidence?: { key: string; relationship: string; explanation: string }[];
  seed_jira_correct?: "yes" | "partial" | "no" | "unknown";
  attribution_note?: string;
  issue_attribution?: "direct" | "misattributed" | "mixed" | "unclear" | "none-needed";
  why_required?: string;
  possible_jiras?: string[];
  why_real?: string;
  why_jira_unclear?: string;
  suggested_path?: string;
  category_2_path?: string;
  reason?: string;
  category_3_reason?: string;
  spec_impact_explanation?: string;
  tooling_recommendation?: string;
  review_notes?: string[];
  caveats?: string[];
};

type CommitReport = {
  sequence: number;
  review_id?: string;
  sha: string;
  commit_sha?: string;
  short_sha: string;
  author: string;
  authored_at: string;
  subject: string;
  body?: string;
  body_url?: string;
  issue_key?: string;
  status?: string;
  decision_status?: string;
  commit_summary?: string;
  commit_context?: string;
  summary?: string;
  recommendation?: string;
  original_subject?: string;
  original_body?: string;
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
  details_url?: string;
  seed_key?: string;
  role?: "seed" | "opportunistic";
  issue_request?: string;
  initial_application?: string;
  additional_context?: string;
  reconciliation?: string;
  source_changes?: string[];
  related_jiras?: { key: string; relationship: string; note: string }[];
  evidence_items?: { id: string; kind: string; locator: string; url?: string; summary: string; learned?: string; supports?: string[] }[];
  checks?: string[];
  confidence?: "high" | "medium" | "low";
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
  triage?: CommitTriage;
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

const wgNames: Record<string, string> = {
  brr: "Biomedical Research and Regulation",
  cbcc: "Community Based Collaborative Care",
  cds: "Clinical Decision Support",
  cg: "Clinical Genomics",
  cgit: "Conformance",
  cqi: "Clinical Quality Information",
  dev: "Health Care Devices",
  director: "FHIR Director",
  ehr: "Electronic Health Records",
  "fhir-i": "FHIR Infrastructure",
  fm: "Financial Management",
  fmg: "FHIR Management Group",
  hsi: "Health Standards Integration",
  ii: "Imaging Integration",
  inm: "Infrastructure and Messaging",
  its: "Implementable Technology Specifications",
  mnm: "Modeling and Methodology",
  oo: "Orders and Observations",
  pa: "Patient Administration",
  pc: "Patient Care",
  pharm: "Pharmacy",
  pher: "Public Health",
  phx: "Pharmacy",
  sd: "Structured Documents",
  sec: "Security",
  security: "Security",
  "us-realm": "US Realm Steering Committee",
  vocab: "Vocabulary",
  unknown: "Unknown",
};

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
  const [triagePreset, setTriagePreset] = useState("jira-backed-spec-change");
  const [triageCategory, setTriageCategory] = useState("");
  const [triagePath, setTriagePath] = useState("");
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
        window.requestAnimationFrame(() => {
          window.setTimeout(() => setLinksEnabled(true), 250);
          window.setTimeout(() => setDiffsEnabled(true), 1000);
        });
        useSelectionStore.getState().setSelected(hashSha || data.commits[0]?.sha || null);
        if (hashSha) window.setTimeout(() => scrollToSha(hashSha), 0);
      })
      .catch((err) => setError(String(err?.message || err)));
  }, []);

  const options = React.useMemo(() => report ? buildOptions(report, bySha, { status, wg, file, triagePreset, triageCategory, triagePath, reviewDecision }) : null, [report, bySha, status, wg, file, triagePreset, triageCategory, triagePath, reviewDecision]);
  const rows = React.useMemo(() => report ? ordered(report.commits.filter((commit) => passes(commit, bySha, { status, wg, file, triagePreset, triageCategory, triagePath, reviewDecision })), sort) : [], [report, bySha, status, wg, file, triagePreset, triageCategory, triagePath, reviewDecision, sort]);

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
    else if (!selected || !rows.some((commit) => reviewKey(commit) === selected)) {
      useSelectionStore.getState().setSelected(reviewKey(rows[0]));
      updateUrlForSha(reviewKey(rows[0]), "replace");
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
        openCommit(reviewKey(next), "replace");
      } else if (key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = relativeCommit(rows, selected, -1);
        openCommit(reviewKey(next), "replace");
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
        <h1>{reportTitle(report)}</h1>
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
        <Facet className="control-triage-preset" value={triagePreset} onChange={setTriagePreset} label="All" options={options.triagePresets} />
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
          <div className="help">Shortcuts: <strong>A</strong> approve, <strong>R</strong> reject, <strong>D</strong> defer, <strong>J/K</strong> next/previous, <strong>C</strong> copy review plan. Browser Ctrl-F searches the sidebar plus the selected issue details and diff.</div>
        </div>
        <div className="buttons">
          <button className={copied ? "primary copied" : "primary"} onClick={() => copyPlan(report, rows, bySha, setCopied)}>{copied ? "Copied" : "Copy Review Plan"}</button>
          <button onClick={() => clear(rows.map((commit) => reviewKey(commit)))}>Clear Visible Review State</button>
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
  if (isReconcileReport(report)) {
    return (
      <section className="intro" aria-label="Review guide">
        <p>
          This page reviews issue-reconcile decisions for Applied/Published FHIR Jira issues. The app loads the report JSON externally and renders source-changing fixes, no-change audits, external-repo audits, human-review decisions, and any opportunistic related issue decisions from the same combined branch.
        </p>
        <p>
          Use the filters to narrow by decision, changed file, or review choice. Mark each item Approve, Reject, or Defer; notes are saved locally in this browser. Source-changing commits include diffs, while empty audit commits should be reviewed from their structured rationale and evidence.
        </p>
      </section>
    );
  }
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
  const selected = useSelectionStore((state) => state.selected);
  const bySha = useReviewStore((state) => state.bySha);
  return (
    <div className="list">
      {rows.map((commit) => {
        const group = wgTitle(commit);
        const header = sort === "wg" && group !== lastGroup;
        if (header) lastGroup = group;
        return (
          <React.Fragment key={reviewKey(commit)}>
            {header && <div className="group-header">{group}</div>}
            <CommitRow commit={commit} active={selected === reviewKey(commit)} entry={reviewEntry(reviewKey(commit), bySha)} onOpen={onOpen} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

const CommitRow = memo(function CommitRow({ commit, active, entry, onOpen }: { commit: CommitReport; active: boolean; entry: ReviewEntry; onOpen: (sha: string) => void }) {
  const id = reviewKey(commit);
  return (
    <button id={`row-${id}`} type="button" className={active ? "row active" : "row"} onClick={() => onOpen(id)}>
      <span className="row-title">{commit.short_sha} {commit.subject}</span>
      <span className="row-summary">{displaySummary(commit)}</span>
      <span className="chips">
        <Chip value={commit.issue_key} />
        <OutcomeChip value={commit.status || commit.decision_status} />
        <Chip value={commit.wg || "unknown"} />
        <TriageChip triage={commit.triage} />
        <Chip value={decisionLabel(entry.decision)} className={entry.decision} />
        <Chip value={`${commit.files?.length || 0} files`} />
      </span>
    </button>
  );
});

function CommitDetails({ rows, onSelect, sort, diffsEnabled }: { rows: CommitReport[]; onSelect: (sha: string) => void; sort: string; diffsEnabled: boolean }) {
  const selected = useSelectionStore((state) => state.selected);
  const selectCommit = useCallback((sha: string) => onSelect(sha), [onSelect]);
  const commit = rows.find((row) => reviewKey(row) === selected) || rows[0];
  if (!commit) return <div className="detail"><div className="empty">No commits match the current filters.</div></div>;
  const group = wgTitle(commit);
  return (
    <div className="detail">
      {sort === "wg" && <div className="detail-group">{group}</div>}
      <CommitCard key={reviewKey(commit)} commit={commit} onSelect={selectCommit} diffsEnabled={diffsEnabled} />
    </div>
  );
}

const CommitCard = memo(function CommitCard({ commit, onSelect, diffsEnabled }: { commit: CommitReport; onSelect: (sha: string) => void; diffsEnabled: boolean }) {
  const id = reviewKey(commit);
  const selected = useSelectionStore((state) => state.selected === id);
  const rawEntry = useReviewStore((state) => state.bySha[id]);
  const entry = normalizeEntry(rawEntry);
  const setDecision = useReviewStore((state) => state.setDecision);
  const setNote = useReviewStore((state) => state.setNote);
  const [details, setDetails] = useState<Partial<CommitReport> | null>(null);
  const [detailsState, setDetailsState] = useState<"ready" | "loading" | "error">(!commit.details_url ? "ready" : "loading");
  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    if (!commit.details_url) {
      setDetailsState("ready");
      return () => { cancelled = true; };
    }
    setDetailsState("loading");
    fetch(assetUrl(commit.details_url))
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((data) => {
        if (!cancelled) {
          setDetails(data);
          setDetailsState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setDetailsState("error");
      });
    return () => { cancelled = true; };
  }, [id, commit.details_url]);
  const view = details ? { ...commit, ...details } : commit;
  return (
    <article id={`commit-${id}`} data-sha={id} className={selected ? "commit-card active" : "commit-card"} onFocus={() => onSelect(id)}>
      <div className="card-head">
        <h2>
          {commit.short_sha} {commit.subject}
          <a className="permalink" href={`#commit-${id}`} title="Permalink to this review item" aria-label={`Permalink to ${commit.issue_key || commit.short_sha}`} onClick={() => onSelect(id)}>#</a>
          {commit.github_commit_url && <a className="full-link" href={commit.github_commit_url} target="_blank" rel="noreferrer">{commit.patch_truncated ? "Full diff on GitHub (required)" : "Full diff on GitHub"}</a>}
        </h2>
        <div className="chips">
          <Chip value={commit.issue_key} />
          <OutcomeChip value={commit.status || commit.decision_status} />
          <Chip value={commit.wg || "unknown"} />
          <TriageChip triage={commit.triage} />
          <Chip value={decisionLabel(entry.decision)} className={entry.decision} />
          <Chip value={`${commit.files?.length || 0} files`} />
          {commit.patch_truncated && <Chip value="embedded diff incomplete" />}
        </div>
        <div className="decision-grid">
          <div className="decision-actions">
            {reviewOptions.filter(([value]) => value !== "undecided").map(([value, label]) => (
              <button key={value} type="button" className={`decision-button ${value}${entry.decision === value ? " active" : ""}`} onClick={() => setDecision(id, value)}>{label}</button>
            ))}
          </div>
          <textarea className="decision-note" value={entry.note} onChange={(event) => setNote(id, event.target.value)} placeholder="Optional review note for later apply/exclude context" />
        </div>
      </div>
      <div className="card-body">
        {commit.omitted_patch_files?.length ? <div className="notice critical">Embedded diff is incomplete for this commit. Use the GitHub full diff link for complete content.</div> : null}
        {detailsState === "error" ? <div className="notice critical">Could not load issue detail JSON. The list metadata is still available.</div> : null}
        {detailsState === "loading" ? <div className="notice">Loading issue details.</div> : null}
        <CommitOverview commit={view} />
        <TriagePanel triage={view.triage} />
        {!commit.audit_decision ? (
          <RawCommitMessage commit={view} />
        ) : null}
        <AgentExtractedDetails commit={view} />
        {commit.original_body && !commit.audit_decision ? (
          <details className="review-details">
            <summary>Original generated commit message</summary>
            <pre className="commit-message">{commit.original_body}</pre>
          </details>
        ) : null}
        <details className="review-details">
          <summary>{commit.audit_decision ? "Files and stats" : "Fixup agent assessment, files, and stats"}</summary>
          {commit.audit_decision ? <FilesAndStats commit={view} /> : <AgentAssessment commit={view} />}
        </details>
        {diffsEnabled ? <DiffSection commit={view} /> : <DeferredDiffSection />}
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

function TriageChip({ triage }: { triage?: CommitTriage }) {
  return <Chip value={triage ? triageCategoryLabel(triage.category) : "Untriaged"} className={triage?.category || "untriaged"} />;
}

function TriagePanel({ triage }: { triage?: CommitTriage }) {
  if (!triage) {
    return (
      <section className="triage-panel untriaged">
        <h3>Triage</h3>
        <p className="help">No 1/2/3 triage result is attached for this commit yet.</p>
      </section>
    );
  }
  return (
    <section className={`triage-panel ${triage.category}`}>
      <div className="section-heading">
        <h3>Triage</h3>
        <span className="chips">
          <Chip value={triageCategoryLabel(triage.category)} className={triage.category} />
          <Chip value={triage.confidence} />
          {triage.issue_attribution ? <Chip value={`attribution ${triage.issue_attribution}`} /> : null}
          {triage.seed_jira_correct ? <Chip value={`seed ${triage.seed_jira_correct}`} /> : null}
        </span>
      </div>
      <RichText text={triage.reviewer_summary || triage.summary || "(no triage summary)"} />
      {triage.category_rationale ? <TriageText title="Category Rationale" text={triage.category_rationale} /> : null}
      {triage.fhir_spec_impact ? <TriageText title="FHIR Spec Impact" text={triage.fhir_spec_impact} /> : null}
      {triage.recommended_reviewer_action ? <TriageText title="Recommended Reviewer Action" text={triage.recommended_reviewer_action} /> : null}
      {triage.jira_evidence?.length ? (
        <div className="triage-block">
          <h4>Jira Evidence</h4>
          <ul className="file-list">
            {triage.jira_evidence.map((row) => (
              <li key={`${row.key}-${row.relationship}`}>
                <a href={jiraUrl(row.key)} target="_blank" rel="noreferrer">{row.key}</a>
                {" "}<Chip value={row.relationship} /> <LinkifiedText text={row.explanation || ""} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {triage.justifying_jiras?.length ? (
        <div className="triage-block">
          <h4>Justifying Jiras</h4>
          <ul className="file-list">
            {triage.justifying_jiras.map((row) => (
              <li key={`${row.key}-${row.role}`}>
                <a href={jiraUrl(row.key)} target="_blank" rel="noreferrer">{row.key}</a>
                {" "}<Chip value={row.role} /> <LinkifiedText text={row.why || ""} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {triage.attribution_note ? <TriageText title="Attribution" text={triage.attribution_note} /> : null}
      {triage.why_required ? <TriageText title="Why Required" text={triage.why_required} /> : null}
      {triage.why_real ? <TriageText title="Why Real" text={triage.why_real} /> : null}
      {triage.why_jira_unclear ? <TriageText title="Why Jira Is Unclear" text={triage.why_jira_unclear} /> : null}
      {triage.spec_impact_explanation ? <TriageText title="Spec Impact" text={triage.spec_impact_explanation} /> : null}
      {triage.tooling_recommendation ? <TriageText title="Tooling Recommendation" text={triage.tooling_recommendation} /> : null}
      {((triage.category_2_path || triage.suggested_path) && (triage.category_2_path || triage.suggested_path) !== "none") || ((triage.category_3_reason || triage.reason) && (triage.category_3_reason || triage.reason) !== "none") || triage.possible_jiras?.length ? (
        <dl className="metadata-grid triage-meta">
          {(triage.category_2_path || triage.suggested_path) && (triage.category_2_path || triage.suggested_path) !== "none" ? <div><dt>Review Path</dt><dd>{triagePathLabel(triage.category_2_path || triage.suggested_path)}</dd></div> : null}
          {(triage.category_3_reason || triage.reason) && (triage.category_3_reason || triage.reason) !== "none" ? <div><dt>No-Impact Reason</dt><dd>{triagePathLabel(triage.category_3_reason || triage.reason)}</dd></div> : null}
          {triage.possible_jiras?.length ? <div><dt>Possible Jiras</dt><dd>{triage.possible_jiras.join(", ")}</dd></div> : null}
        </dl>
      ) : null}
      {(triage.caveats || triage.review_notes)?.length ? <ListOrEmpty values={triage.caveats || triage.review_notes || []} /> : null}
    </section>
  );
}

function TriageText({ title, text }: { title: string; text: string }) {
  return (
    <div className="triage-block">
      <h4>{title}</h4>
      <RichText text={text} />
    </div>
  );
}

function RawCommitMessage({ commit }: { commit: CommitReport }) {
  const id = reviewKey(commit);
  const [body, setBody] = useState(commit.body || "");
  const [state, setState] = useState<"ready" | "loading" | "error">(commit.body || !commit.body_url ? "ready" : "loading");
  useEffect(() => {
    let cancelled = false;
    setBody(commit.body || "");
    if (commit.body || !commit.body_url) {
      setState("ready");
      return () => { cancelled = true; };
    }
    setState("loading");
    fetch(assetUrl(commit.body_url))
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.text();
      })
      .then((text) => {
        if (!cancelled) {
          setBody(text);
          setState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => { cancelled = true; };
  }, [id, commit.body, commit.body_url]);
  const text = body || (state === "loading" ? "Loading raw commit message." : state === "error" ? "Could not load raw commit message." : commit.subject || "(empty commit message)");
  return (
    <details className="review-details">
      <summary>Raw git commit message</summary>
      <pre className="commit-message">{text}</pre>
    </details>
  );
}

function AgentExtractedDetails({ commit }: { commit: CommitReport }) {
  const hasDetails = isIssueReconcileCommit(commit) || parsedMessageSections(commit).length > 0 || displaySummary(commit);
  if (!hasDetails) return null;
  return (
    <details className="review-details extracted-details">
      <summary>Agent extracted details</summary>
      {isIssueReconcileCommit(commit) ? <IssueReconcileMainPanel commit={commit} /> : <CommitMessageNarrative commit={commit} />}
    </details>
  );
}

function CommitOverview({ commit }: { commit: CommitReport }) {
  const addressedJiras = directlyAddressedJiras(commit);
  return (
    <section className="overview">
      <div className="link-row">
        {addressedJiras.length ? addressedJiras.map((key) => <a key={key} href={jiraUrl(key)} target="_blank" rel="noreferrer">Jira {key}</a>) : <span>No Jira issue</span>}
        {commit.github_commit_url ? <a href={commit.github_commit_url} target="_blank" rel="noreferrer">GitHub commit {commit.short_sha}</a> : null}
        {commit.result_path ? <span>{commit.audit_decision ? "Audit report" : "Agent report"}: {commit.result_path}</span> : <span>No agent report JSON</span>}
      </div>
      <PreviousIssueCommits commit={commit} />
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

type MessageSection = { key: string; title: string; text: string };

const commitSectionTitles = [
  "Issue request",
  "Initial application",
  "Additional context",
  "AutoFHIR reconciliation",
  "Reconciliation",
  "AutoFHIR fixup",
  "Recommendation",
];

function CommitMessageNarrative({ commit }: { commit: CommitReport }) {
  const sections = React.useMemo(() => parsedMessageSections(commit), [commit.body, commit.subject, commit.commit_summary, commit.commit_context, commit.recommendation]);
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

function parsedMessageSections(commit: CommitReport): MessageSection[] {
  const fromBody = sectionsFromBody(commit.body || "");
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
    || /^<\/?(related-jiras|evidence)>$/i.test(trimmed)
    || /^Verification:/i.test(trimmed);
}

function sectionsFromExportedFields(commit: CommitReport): MessageSection[] {
  if (commit.issue_request || commit.initial_application || commit.additional_context || commit.reconciliation || commit.recommendation) {
    return [
      { key: "issue-request", title: "Issue request", text: commit.issue_request || "" },
      { key: "initial-application", title: "Initial application", text: commit.initial_application || "" },
      { key: "additional-context", title: "Additional context", text: commit.additional_context || "" },
      { key: "reconciliation", title: "Reconciliation", text: commit.reconciliation || "" },
      { key: "recommendation", title: "Recommendation", text: commit.recommendation || "" },
    ].filter((section) => section.text.trim());
  }
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

function isIssueReconcileCommit(commit: CommitReport) {
  return Boolean(commit.issue_request || commit.initial_application || commit.additional_context || commit.reconciliation || commit.source_changes?.length || commit.evidence_items?.length || commit.checks?.length);
}

function IssueReconcileMainPanel({ commit }: { commit: CommitReport }) {
  return (
    <section className="reconcile-main" aria-label="Issue reconcile details">
      <div className="reconcile-summary-grid">
        <article>
          <h3>Summary</h3>
          <RichText text={commit.summary || displaySummary(commit) || "(no summary)"} />
        </article>
        <article>
          <h3>Recommendation</h3>
          <RichText text={commit.recommendation || "(no recommendation recorded)"} />
        </article>
      </div>
      <ReconcileTextDetails title="Issue request" text={commit.issue_request} />
      <ReconcileTextDetails title="Initial application" text={commit.initial_application} />
      <ReconcileTextDetails title="Additional context" text={commit.additional_context} />
      <ReconcileTextDetails title="Reconciliation" text={commit.reconciliation} />
      <IssueReconcileAssessment commit={commit} />
    </section>
  );
}

function ReconcileTextDetails({ title, text }: { title: string; text?: string }) {
  return (
    <details className="review-details">
      <summary>{title}</summary>
      {text?.trim() ? <div className="details-body"><RichText text={text} /></div> : <p className="help">None recorded.</p>}
    </details>
  );
}

function IssueReconcileAssessment({ commit }: { commit: CommitReport }) {
  return (
    <section className="assessment">
      <details className="review-details">
        <summary>Source changes</summary>
        <ListOrEmpty values={commit.source_changes || []} />
      </details>
      <details className="review-details">
        <summary>Related Jiras</summary>
        {commit.related_jiras?.length ? (
          <ul className="file-list">
            {commit.related_jiras.map((row) => (
              <li key={`${row.key}-${row.relationship}`}>
                <a href={jiraUrl(row.key)} target="_blank" rel="noreferrer">{row.key}</a>
                {" "}<Chip value={row.relationship} /> <LinkifiedText text={row.note || ""} />
              </li>
            ))}
          </ul>
        ) : <p className="help">None recorded.</p>}
      </details>
      <details className="review-details">
        <summary>Evidence</summary>
        {commit.evidence_items?.length ? <EvidenceTable rows={commit.evidence_items} /> : <p className="help">None recorded.</p>}
      </details>
      <details className="review-details">
        <summary>Checks</summary>
        <ListOrEmpty values={commit.checks || []} />
      </details>
    </section>
  );
}

function ListOrEmpty({ values }: { values: string[] }) {
  if (!values.length) return <p className="help">None recorded.</p>;
  return <ul className="file-list">{values.map((value) => <li key={value}><LinkifiedText text={value} /></li>)}</ul>;
}

function EvidenceTable({ rows }: { rows: NonNullable<CommitReport["evidence_items"]> }) {
  return (
    <table className="evidence-table">
      <thead><tr><th>ID</th><th>Kind</th><th>Locator</th><th>Summary</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{row.id}</td>
            <td>{row.kind}</td>
            <td>{row.url ? <a href={row.url} target="_blank" rel="noreferrer">{row.locator}</a> : <LinkifiedText text={row.locator} />}</td>
            <td><LinkifiedText text={row.summary} />{row.learned ? <><br /><small><LinkifiedText text={row.learned} /></small></> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
        const element = document.getElementById(`commit-${reviewKey(commit)}`);
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
  const id = reviewKey(commit);
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
  }, [id, commit.patch, commit.patch_url]);
  const patchText =
    patch || (patchState === "loading" ? "Loading diff." : patchState === "error" ? "Could not load embedded diff. Use the GitHub full diff link." : "(empty commit; no source diff)");
  useEffect(() => {
    const element = preRef.current;
    if (!element) return;
    registerDiffHighlights(id, element, patchText);
    return () => unregisterDiffHighlights(id);
  }, [id, patchText]);
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

type HighlightRangeSet = Record<DiffGroup["kind"], Range[]> & {
  addStrong: Range[];
  delStrong: Range[];
};

const diffHighlightRegistry = new Map<string, HighlightRangeSet>();
let diffHighlightFrame = 0;

function registerDiffHighlights(id: string, element: HTMLPreElement, text: string) {
  if (!supportsCssHighlights()) return;
  const node = element.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const ranges: HighlightRangeSet = { meta: [], hunk: [], add: [], del: [], context: [], addStrong: [], delStrong: [] };
  const changedLines: DiffLineInfo[] = [];
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
    if (length && (kind === "add" || kind === "del")) {
      changedLines.push({ kind, line, offset });
    }
    offset += length + 1;
  }
  addIntralineDiffRanges(node, changedLines, ranges);
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
  const merged: HighlightRangeSet = { meta: [], hunk: [], add: [], del: [], context: [], addStrong: [], delStrong: [] };
  for (const ranges of diffHighlightRegistry.values()) {
    merged.meta.push(...ranges.meta);
    merged.hunk.push(...ranges.hunk);
    merged.add.push(...ranges.add);
    merged.del.push(...ranges.del);
    merged.addStrong.push(...ranges.addStrong);
    merged.delStrong.push(...ranges.delStrong);
  }
  setHighlight("autofhir-diff-meta", merged.meta);
  setHighlight("autofhir-diff-hunk", merged.hunk);
  setHighlight("autofhir-diff-add", merged.add);
  setHighlight("autofhir-diff-del", merged.del);
  setHighlight("autofhir-diff-add-strong", merged.addStrong);
  setHighlight("autofhir-diff-del-strong", merged.delStrong);
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

type DiffLineInfo = {
  kind: "add" | "del";
  line: string;
  offset: number;
};

function addIntralineDiffRanges(node: ChildNode, changedLines: DiffLineInfo[], ranges: HighlightRangeSet) {
  let i = 0;
  while (i < changedLines.length) {
    const delBlock: DiffLineInfo[] = [];
    const addBlock: DiffLineInfo[] = [];
    while (changedLines[i]?.kind === "del") delBlock.push(changedLines[i++]);
    while (changedLines[i]?.kind === "add") addBlock.push(changedLines[i++]);
    if (!delBlock.length || !addBlock.length) continue;
    const pairCount = Math.min(delBlock.length, addBlock.length);
    for (let index = 0; index < pairCount; index++) {
      addIntralinePairRanges(node, delBlock[index], addBlock[index], ranges);
    }
  }
}

function addIntralinePairRanges(node: ChildNode, delLine: DiffLineInfo, addLine: DiffLineInfo, ranges: HighlightRangeSet) {
  const oldText = delLine.line.slice(1);
  const newText = addLine.line.slice(1);
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(oldText.length - prefix, newText.length - prefix);
  while (
    suffix < maxSuffix
    && oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]
  ) {
    suffix++;
  }

  addStrongRange(node, ranges.delStrong, delLine.offset + 1 + prefix, delLine.offset + 1 + oldText.length - suffix);
  addStrongRange(node, ranges.addStrong, addLine.offset + 1 + prefix, addLine.offset + 1 + newText.length - suffix);
}

function addStrongRange(node: ChildNode, ranges: Range[], start: number, end: number) {
  if (end <= start) return;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  ranges.push(range);
}

type FacetOption = { total: number; items: { value: string; label: string; count: number }[] };

function buildOptions(report: Report, bySha: Record<string, ReviewEntry>, filters: Record<string, string>) {
  return {
    statuses: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, status: "" })), (c) => [statusValue(c)], outcomeLabel),
    changeKinds: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, changeKind: "" })), (c) => [changeKindValue(c)], changeKindLabel),
    wgs: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, wg: "" })), (c) => [wgCode(c)], (value) => {
      const sample = report.commits.find((c) => wgCode(c) === value);
      return `${value} · ${sample ? wgName(sample) : value}`;
    }),
    files: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, file: "" })), (c) => c.files || [], (value) => value),
    triagePresets: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, triagePreset: "" })), (c) => [triagePresetValue(c)], triagePresetLabel),
    triageCategories: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, triageCategory: "" })), (c) => [triageCategoryValue(c)], triageCategoryLabel),
    triagePaths: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, triagePath: "" })), (c) => [triagePathValue(c)], triagePathLabel),
    reviews: facet(report.commits.filter((c) => passes(c, bySha, { ...filters, reviewDecision: "" })), (c) => [reviewEntry(reviewKey(c), bySha).decision], decisionLabel),
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
    && (!filters.changeKind || changeKindValue(commit) === filters.changeKind)
    && (!filters.wg || wgCode(commit) === filters.wg)
    && (!filters.file || (commit.files || []).includes(filters.file))
    && (!filters.triagePreset || triagePresetValue(commit) === filters.triagePreset)
    && (!filters.triageCategory || triageCategoryValue(commit) === filters.triageCategory)
    && (!filters.triagePath || triagePathValue(commit) === filters.triagePath)
    && (!filters.reviewDecision || reviewEntry(reviewKey(commit), bySha).decision === filters.reviewDecision);
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

function outcomeLabel(value?: string) {
  return ({
    keep: "Keep",
    tweak: "Tweak",
    "human-review": "Human review",
    drop: "Drop",
    fixed: "Source change made",
    "no-change": "No source change needed",
    "external-repo": "External repo / out of core",
    ambiguous: "Needs human review",
    blocked: "Blocked",
    none: "Missing review data",
  } as Record<string, string>)[value || "none"] || value || "Missing review data";
}

function changeKindValue(commit: CommitReport) {
  return (commit.files || []).length ? "source-change" : "no-source-change";
}

function changeKindLabel(value?: string) {
  return ({
    "source-change": "Source-changing commits",
    "no-source-change": "No source changes",
  } as Record<string, string>)[value || ""] || value || "Unknown";
}

function triagePresetValue(commit: CommitReport) {
  if (triageCategoryValue(commit) === "misapplied-jira" && triagePathValue(commit) === "clean-whole-commit") {
    return "jira-backed-spec-change";
  }
  if (commit.triage) return "needs-secondary-review";
  return "untriaged";
}

function triagePresetLabel(value?: string) {
  return ({
    "jira-backed-spec-change": "Jira-backed spec changes",
    "needs-secondary-review": "Secondary review",
    untriaged: "Untriaged",
  } as Record<string, string>)[value || "untriaged"] || value || "Untriaged";
}

function triageCategoryValue(commit: CommitReport) {
  return commit.triage?.category || "untriaged";
}

function triageCategoryLabel(value?: string) {
  return ({
    "misapplied-jira": "Jira-backed missed application",
    "real-fix-unclear-jira": "Real fix, unclear path",
    "not-needed-for-spec-correctness": "No current spec impact",
    untriaged: "Untriaged",
  } as Record<string, string>)[value || "untriaged"] || value || "Untriaged";
}

function triagePathValue(commit: CommitReport) {
  const path = commit.triage?.category_2_path || commit.triage?.suggested_path;
  if (path && path !== "none") return path;
  const reason = commit.triage?.category_3_reason || commit.triage?.reason;
  if (reason && reason !== "none") return reason;
  return commit.triage ? "clean-whole-commit" : "untriaged";
}

function triagePathLabel(value?: string) {
  return ({
    "clean-whole-commit": "Clean whole-commit review",
    "apply-subset-only": "Apply subset only",
    "find-better-jira": "Find better Jira",
    "new-jira": "Needs new Jira",
    "rollup-cleanup-jira": "Rollup cleanup Jira",
    "wg-review": "Needs WG review",
    "build-ignores-or-strips": "Build ignores or strips source",
    "commented-out-source": "Commented-out source",
    "non-rendered-metadata": "Non-rendered metadata",
    "layout-only-svg": "Layout/diagram SVG",
    "generated-or-derived-file": "Generated or derived file",
    "outside-editor-owned-surface": "Outside editor-owned surface",
    "repo-hygiene-only": "Repository hygiene only",
    "tooling-warning-candidate": "Tooling warning candidate",
    other: "Other",
    untriaged: "Untriaged",
  } as Record<string, string>)[value || "untriaged"] || value || "Untriaged";
}

function wgCode(commit: CommitReport) {
  return commit.wg || "unknown";
}

function wgName(commit: CommitReport) {
  const code = commit.wg || "unknown";
  return commit.wg_label && commit.wg_label !== code ? commit.wg_label : wgNames[code] || commit.wg_label || code || "Unknown";
}

function wgTitle(commit: CommitReport) {
  return `${wgCode(commit)} · ${wgName(commit)}`;
}

function displaySummary(commit: CommitReport) {
  return commit.audit_recommended_next_step || commit.summary || commit.commit_summary || commit.recommendation || "";
}

function directBackingJiras(commit: CommitReport) {
  const keys = new Set<string>();
  for (const row of commit.triage?.jira_evidence || []) {
    if (row.relationship === "directly-justifies" || row.relationship === "better-attribution") {
      keys.add(row.key);
    }
  }
  return [...keys].filter((key) => key && key !== commit.issue_key).sort();
}

function directlyAddressedJiras(commit: CommitReport) {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of commit.triage?.jira_evidence || []) {
    if (row.relationship !== "directly-justifies" && row.relationship !== "better-attribution") continue;
    if (!row.key || seen.has(row.key)) continue;
    seen.add(row.key);
    keys.push(row.key);
  }
  if (!keys.length && commit.issue_key) keys.push(commit.issue_key);
  return keys;
}

function reviewTitle(commit: CommitReport) {
  return commit.subject;
}

function stripLeadingIssueKey(subject: string, issueKey?: string) {
  if (!issueKey) return subject;
  return subject.replace(new RegExp(`^${escapeRegExp(issueKey)}:\\s*`), "");
}

function reviewKey(commit: CommitReport) {
  return commit.review_id || commit.sha;
}

function reportTitle(report: Report) {
  if (isReconcileReport(report)) return "AutoFHIR Issue Reconcile Review";
  return isAuditReport(report) ? "AutoFHIR Issue Fixup Audit Review" : "AutoFHIR Issue Fixup Diffs";
}

function isReconcileReport(report: Report) {
  return report.schema_version === "issue-reconcile-review-report-v1";
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
  for (const commit of commits) counts[reviewEntry(reviewKey(commit), bySha).decision]++;
  return `Your review: approve ${counts.approve} · reject ${counts.reject} · defer ${counts.defer} · undecided ${counts.undecided}`;
}

function relativeCommit(rows: CommitReport[], selected: string, delta: number) {
  const index = Math.max(0, rows.findIndex((commit) => reviewKey(commit) === selected));
  return rows[Math.min(rows.length - 1, Math.max(0, index + delta))] || rows[0];
}

function shaFromHash(commits: CommitReport[]) {
  const rawHash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  if (!rawHash) return null;
  const token = rawHash.startsWith("commit-") ? rawHash.slice("commit-".length) : rawHash;
  const match = commits.find((commit) => reviewKey(commit) === token || commit.sha === token || commit.commit_sha === token || commit.short_sha === token || commit.issue_key === token);
  return match ? reviewKey(match) : null;
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
    const element = document.getElementById(`commit-${reviewKey(commit)}`);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom > offset) return reviewKey(commit);
  }
  return rows.length ? reviewKey(rows[rows.length - 1]) : null;
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
  const reviewed = report.commits.filter((commit) => reviewEntry(reviewKey(commit), bySha).decision !== "undecided" || reviewEntry(reviewKey(commit), bySha).note.trim());
  const groups = {
    approve: reviewed.filter((commit) => reviewEntry(reviewKey(commit), bySha).decision === "approve"),
    reject: reviewed.filter((commit) => reviewEntry(reviewKey(commit), bySha).decision === "reject"),
    defer: reviewed.filter((commit) => reviewEntry(reviewKey(commit), bySha).decision === "defer"),
  };
  const lineFor = (commit: CommitReport) => {
    const backing = directBackingJiras(commit);
    const backingText = backing.length ? ` [backing Jira${backing.length === 1 ? "" : "s"}: ${backing.join(", ")}]` : "";
    return `- ${commit.commit_sha || commit.sha} ${commit.issue_key || ""}${backingText} ${reviewTitle(commit)}${reviewEntry(reviewKey(commit), bySha).note ? `\n  Reviewer note: ${reviewEntry(reviewKey(commit), bySha).note}` : ""}`;
  };
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
      backing_jiras: directBackingJiras(commit),
      review_id: reviewKey(commit),
      sha: commit.sha,
      commit_sha: commit.commit_sha || commit.sha,
      subject: reviewTitle(commit),
      review_decision: reviewEntry(reviewKey(commit), bySha).decision,
      review_note: reviewEntry(reviewKey(commit), bySha).note,
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
    `- Commit triage rollup, when available: ${artifactUrl(report, artifacts.triage_rollup_md)}`,
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
