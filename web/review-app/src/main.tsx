import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
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
  body: string;
  issue_key?: string;
  status?: string;
  decision_status?: string;
  commit_summary?: string;
  commit_context?: string;
  summary?: string;
  recommendation?: string;
  github_commit_url?: string;
  result_path?: string;
  wg?: string;
  wg_label?: string;
  wg_confidence?: "high" | "medium" | "low";
  files: string[];
  stat: string;
  patch: string;
  patch_truncated?: boolean;
  omitted_patch_files?: { file: string; reason: string }[];
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
    source_run_id?: string;
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
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const bySha = useReviewStore((state) => state.bySha);
  const clear = useReviewStore((state) => state.clear);

  useEffect(() => {
    const url = window.__AUTOFHIR_REPORT_URL__ || "issue-fixup-diff-report.json";
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then((data: Report) => {
        setReport(data);
        setSelected(data.commits[0]?.sha || null);
      })
      .catch((err) => setError(String(err?.message || err)));
  }, []);

  const options = useMemo(() => report ? buildOptions(report, bySha, { status, wg, file, reviewDecision }) : null, [report, bySha, status, wg, file, reviewDecision]);
  const rows = useMemo(() => report ? ordered(report.commits.filter((commit) => passes(commit, bySha, { status, wg, file, reviewDecision })), sort) : [], [report, bySha, status, wg, file, reviewDecision, sort]);

  useEffect(() => {
    if (!rows.length) setSelected(null);
    else if (!selected || !rows.some((commit) => commit.sha === selected)) setSelected(rows[0].sha);
  }, [rows, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      const editing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (editing && event.key !== "Escape") return;
      if (event.key === "Escape" && editing) {
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
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
        setSelected(next.sha);
        scrollToSha(next.sha);
      } else if (key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = relativeCommit(rows, selected, -1);
        setSelected(next.sha);
        scrollToSha(next.sha);
      } else if (key === "c") {
        event.preventDefault();
        copyPlan(report, rows, bySha, setCopied);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [report, rows, selected, bySha]);

  if (error) {
    return <div className="empty">Could not load review data: {error}</div>;
  }
  if (!report || !options) {
    return <div className="empty">Loading review data.</div>;
  }

  return (
    <>
      <header>
        <h1>AutoFHIR Issue Fixup Diffs</h1>
        <div className="meta">
          <span>Run: {report.run.run_id}</span>
          <span>Branch: {report.run.combined_branch}</span>
          <span>Commits: {report.counts.commits}</span>
          <span>With results: {report.counts.with_result}</span>
          <span>WGs: {Object.keys(report.counts.by_wg || {}).length}</span>
          <span>Generated: {report.generated_at}</span>
        </div>
      </header>
      <div className="controls">
        <Facet value={status} onChange={setStatus} label="All results" options={options.statuses} />
        <Facet value={wg} onChange={setWg} label="All work groups" options={options.wgs} />
        <Facet value={file} onChange={setFile} label="All changed files" options={options.files} />
        <Facet value={reviewDecision} onChange={setReviewDecision} label="All review choices" options={options.reviews} />
        <select value={sort} onChange={(event) => setSort(event.target.value)}>
          <option value="wg">Group by work group</option>
          <option value="branch">Commit order</option>
        </select>
      </div>
      <div className="reviewbar">
        <div>
          <div>{reviewCountText(report.commits, bySha)}</div>
          <div className="help">Shortcuts: <strong>A</strong> approve, <strong>R</strong> reject, <strong>D</strong> defer, <strong>J/K</strong> next/previous, <strong>C</strong> copy review plan. Browser Ctrl-F searches rendered commit messages and diffs.</div>
        </div>
        <div className="buttons">
          {report.run.github_compare_url && <a className="button-link primary" href={report.run.github_compare_url} target="_blank" rel="noreferrer">Full Branch Diff on GitHub</a>}
          <button className={copied ? "primary copied" : "primary"} onClick={() => copyPlan(report, rows, bySha, setCopied)}>{copied ? "Copied" : "Copy Review Plan"}</button>
          <button onClick={() => clear(rows.map((commit) => commit.sha))}>Clear Visible Review State</button>
        </div>
      </div>
      <main>
        <CommitList rows={rows} selected={selected} onSelect={setSelected} sort={sort} />
        <CommitDetails rows={rows} selected={selected} onSelect={setSelected} sort={sort} />
      </main>
    </>
  );
}

function Facet({ label, value, options, onChange }: { label: string; value: string; options: FacetOption[]; onChange: (value: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{label} ({options.total})</option>
      {options.items.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.count})</option>)}
    </select>
  );
}

function CommitList({ rows, selected, onSelect, sort }: { rows: CommitReport[]; selected: string | null; onSelect: (sha: string) => void; sort: string }) {
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
            <button type="button" className={commit.sha === selected ? "row active" : "row"} onClick={() => { onSelect(commit.sha); scrollToSha(commit.sha); }}>
              <span className="row-title">{commit.short_sha} {commit.subject}</span>
              <span className="row-summary">{displaySummary(commit)}</span>
              <span className="chips">
                <Chip value={commit.issue_key} />
                <OutcomeChip value={commit.status || commit.decision_status} />
                <Chip value={commit.wg || "unknown"} />
                <Chip value={decisionLabel(reviewEntry(commit.sha).decision)} className={reviewEntry(commit.sha).decision} />
                <Chip value={`${commit.files?.length || 0} files`} />
              </span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function CommitDetails({ rows, selected, onSelect, sort }: { rows: CommitReport[]; selected: string | null; onSelect: (sha: string) => void; sort: string }) {
  let lastGroup = "";
  const selectCommit = useCallback((sha: string) => onSelect(sha), [onSelect]);
  return (
    <div className="detail">
      {rows.map((commit) => {
        const group = wgTitle(commit);
        const header = sort === "wg" && group !== lastGroup;
        if (header) lastGroup = group;
        return (
          <React.Fragment key={commit.sha}>
            {header && <div className="detail-group">{group}</div>}
            <CommitCard commit={commit} selected={commit.sha === selected} onSelect={selectCommit} />
          </React.Fragment>
        );
      })}
    </div>
  );
}

const CommitCard = memo(function CommitCard({ commit, selected, onSelect }: { commit: CommitReport; selected: boolean; onSelect: (sha: string) => void }) {
  const rawEntry = useReviewStore((state) => state.bySha[commit.sha]);
  const entry = normalizeEntry(rawEntry);
  const setDecision = useReviewStore((state) => state.setDecision);
  const setNote = useReviewStore((state) => state.setNote);
  const text = useMemo(() => reviewText(commit), [commit]);
  return (
    <article id={`commit-${commit.sha}`} data-sha={commit.sha} className={selected ? "commit-card active" : "commit-card"} onFocus={() => onSelect(commit.sha)}>
      <div className="card-head">
        <h2>
          {commit.short_sha} {commit.subject}
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
        <details className="review-details">
          <summary>Commit message, evidence, and diff</summary>
          <pre className="review-text">{text}</pre>
        </details>
      </div>
    </article>
  );
});

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

function outcomeLabel(value?: string) {
  return ({
    fixed: "Source change made",
    "no-change": "No source change needed",
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
  return commit.commit_summary || commit.summary || "";
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

function scrollToSha(sha: string) {
  window.setTimeout(() => document.getElementById(`commit-${sha}`)?.scrollIntoView({ block: "start", behavior: "auto" }), 0);
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

function reviewText(commit: CommitReport) {
  return [
    `Jira Issue: ${commit.issue_key || "(none)"} ${jiraUrl(commit.issue_key)}`,
    `Result: ${outcomeLabel(commit.status || commit.decision_status)}`,
    `Work Group: ${wgTitle(commit)}`,
    `Author: ${commit.author}`,
    `Authored: ${commit.authored_at}`,
    `SHA: ${commit.sha}`,
    commit.github_commit_url ? `GitHub commit: ${commit.github_commit_url}` : "",
    commit.result_path ? `Agent report: ${commit.result_path}` : "Agent report: none",
    "",
    "WHAT CHANGED",
    displaySummary(commit) || "(no summary)",
    commit.commit_context || "",
    "",
    commit.summary ? `AGENT SUMMARY\n${commit.summary}\n` : "",
    commit.recommendation ? `AGENT RECOMMENDATION\n${commit.recommendation}\n` : "",
    "FILES",
    ...(commit.files?.length ? commit.files : ["(none)"]),
    "",
    "COMMIT MESSAGE",
    commit.body || "",
    "",
    "STAT",
    commit.stat || "",
    "",
    "DIFF",
    commit.patch || "(empty commit; no source diff)",
  ].filter(Boolean).join("\n");
}

function artifactUrl(report: Report, name?: string) {
  return name ? new URL(name, report.run.review_raw_base_url || location.href).href : "(not available)";
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
    combined_branch: report.run.combined_branch,
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
    "This whole file can be saved as prompt.md and given to an agent. The agent should use it as the review plan for deciding which commits from the AutoFHIR reconciliation branch to keep, drop, or defer.",
    "",
    "Branch location:",
    `- Local FHIR repository: ${report.run.fhir_repo || "(unknown)"}`,
    `- Local branch: ${report.run.combined_branch}`,
    `- Base commit: ${report.run.base}`,
    `- Current head: ${report.run.head}`,
    `- GitHub compare: ${report.run.github_compare_url || "(not available)"}`,
    `- GitHub branch tree: ${report.run.github_tree_url || "(not available)"}`,
    `- Review app on GitHub Pages: ${report.run.review_pages_url || "(not available)"}`,
    `- Review app and artifact folder: ${report.run.review_github_tree_url || "(not available)"}`,
    "",
    "Downloadable context artifacts:",
    `- Full source discovery/issue-mapping JSON used as the input to this fixup run: ${artifactUrl(report, artifacts.source_issue_mapping_json_gzip)}`,
    `- Full fixup review JSON emitted by this run, which is the data this viewer is built from: ${artifactUrl(report, artifacts.fixup_review_json)}`,
    `- Gzipped fixup review JSON, if a smaller download is preferred: ${artifactUrl(report, artifacts.fixup_review_json_gzip)}`,
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
