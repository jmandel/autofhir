#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readRun, runPath } from "./lib";

type AgentOutput = {
  seed_key: string;
  result_path: string;
  created_at: string;
  output: any;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(`Usage: bun autofhir/scripts/export-issue-mapping-viewer.ts --run-id ID [--out-dir DIR]

Builds:
  autofhir/runs/<run-id>/review/issue-mapping-report.json
  autofhir/runs/<run-id>/review/issue-mapping-viewer.html

The report is a list of agent outputs, one entry per result.json. The HTML is
standalone and embeds the current JSON snapshot.`);
  process.exit(0);
}

const runId = arg("--run-id") ?? process.env.RUN_ID;
if (!runId) throw new Error("--run-id or RUN_ID is required");

const root = runPath(runId);
const outDir = path.resolve(arg("--out-dir") ?? path.join(root, "review"));
const run = readRun(runId);

function stateCount(state: string): number {
  const dir = path.join(root, "seeds", state);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((file) => file.endsWith(".json")).length;
}

function decisionsFor(output: any): any[] {
  const v2 = Array.isArray(output.issues) ? output.issues : undefined;
  const v1 = [output.seed_decision, ...(Array.isArray(output.opportunistic_decisions) ? output.opportunistic_decisions : [])];
  return (v2 ?? v1).filter((decision) => decision && typeof decision === "object" && typeof decision.key === "string");
}

function readAgentOutputs(): AgentOutput[] {
  const seedRunsDir = path.join(root, "seed-runs");
  if (!existsSync(seedRunsDir)) return [];

  const outputs: AgentOutput[] = [];
  for (const seedKey of readdirSync(seedRunsDir).sort()) {
    const absResultPath = path.join(seedRunsDir, seedKey, "result.json");
    if (!existsSync(absResultPath)) continue;
    let output: any;
    try {
      output = JSON.parse(readFileSync(absResultPath, "utf8"));
    } catch {
      continue;
    }
    if (decisionsFor(output).length === 0) continue;
    outputs.push({
      seed_key: seedKey,
      result_path: path.relative(root, absResultPath),
      created_at: statSync(absResultPath).mtime.toISOString(),
      output,
    });
  }
  return outputs.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.seed_key.localeCompare(b.seed_key));
}

const agentOutputs = readAgentOutputs();
const allDecisions = agentOutputs.flatMap((agentOutput) => decisionsFor(agentOutput.output));
const issueCount = new Set(allDecisions.map((decision) => decision.key)).size;

const report = {
  schema_version: "issue-mapping-review-v3",
  generated_at: new Date().toISOString(),
  run: {
    run_id: runId,
    status: run.status,
    description: run.description,
    fhir_repo: run.fhirRepo,
    base_sha: run.baseSha,
  },
  seed_counts: Object.fromEntries(["pending", "running", "done", "skipped", "failed", "blocked"].map((state) => [state, stateCount(state)])),
  counts: {
    agent_outputs: agentOutputs.length,
    issues: issueCount,
    decisions: allDecisions.length,
    related_decisions: allDecisions.filter((decision) => decision.role === "related" || decision.role === "opportunistic").length,
  },
  agent_outputs: agentOutputs,
};

function htmlEscapeForScript(value: string): string {
  return value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function viewerHtml(data: unknown): string {
  const json = htmlEscapeForScript(JSON.stringify(data));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AutofHIR Issue Mapping Review</title>
<style>
:root { color-scheme: light; --bg: #f7f8fa; --panel: #ffffff; --line: #d7dce2; --text: #16202a; --muted: #5d6b7a; --accent: #1f6feb; --warn: #9a6700; --good: #1f7a4d; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; color: var(--text); background: var(--bg); }
header { padding: 16px 20px 12px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 3; }
h1 { margin: 0 0 8px; font-size: 20px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 16px; color: var(--muted); }
.controls { display: grid; grid-template-columns: 1fr repeat(3, minmax(150px, 190px)); gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: #eef2f6; position: sticky; top: 75px; z-index: 2; }
input, select { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--text); }
main { display: grid; grid-template-columns: minmax(420px, 44%) 1fr; gap: 0; min-height: calc(100vh - 130px); }
.list { border-right: 1px solid var(--line); overflow: auto; max-height: calc(100vh - 130px); }
.detail { overflow: auto; max-height: calc(100vh - 130px); padding: 18px 20px 40px; background: var(--panel); }
.row { padding: 12px 14px; border-bottom: 1px solid var(--line); cursor: pointer; background: var(--panel); }
.row:hover, .row.active { background: #eaf2ff; }
.row h2 { margin: 0 0 5px; font-size: 15px; display: flex; gap: 8px; align-items: center; }
.summary { color: var(--text); margin-bottom: 7px; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { border: 1px solid var(--line); border-radius: 999px; padding: 2px 7px; color: var(--muted); background: #fff; font-size: 12px; }
.apply, .fully-applied { color: var(--good); border-color: #9ad3b1; }
.review, .needs-human-decision, .file-jira, .close-duplicate { color: var(--warn); border-color: #eac56b; }
.section { margin: 0 0 22px; }
.section h3 { margin: 0 0 8px; font-size: 15px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
pre { white-space: pre-wrap; word-break: break-word; background: #f4f6f8; border: 1px solid var(--line); border-radius: 6px; padding: 10px; overflow: auto; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.empty { padding: 30px; color: var(--muted); }
@media (max-width: 900px) { .controls { grid-template-columns: 1fr 1fr; top: 95px; } main { grid-template-columns: 1fr; } .list, .detail { max-height: none; } .list { border-right: 0; } }
</style>
</head>
<body>
<header>
  <h1>AutofHIR Issue Mapping Review</h1>
  <div class="meta" id="meta"></div>
</header>
<div class="controls">
  <input id="q" placeholder="Search issue keys, recommendations, evidence, chunks">
  <select id="nextStep"><option value="">All next steps</option></select>
  <select id="assessment"><option value="">All assessments</option></select>
  <select id="chunk"><option value="">All chunks</option></select>
</div>
<main>
  <div class="list" id="list"></div>
  <div class="detail" id="detail"><div class="empty">Select an agent output.</div></div>
</main>
<script id="report-data" type="application/json">${json}</script>
<script>
const report = JSON.parse(document.getElementById('report-data').textContent);
const list = document.getElementById('list');
const detail = document.getElementById('detail');
const q = document.getElementById('q');
const nextStep = document.getElementById('nextStep');
const assessment = document.getElementById('assessment');
const chunk = document.getElementById('chunk');
let selected = null;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function jiraLink(key) { return /^FHIR-\\d+$/.test(key) ? '<a href="https://jira.hl7.org/browse/' + esc(key) + '">' + esc(key) + '</a>' : esc(key); }
function chip(value) { return '<span class="chip ' + esc(value) + '">' + esc(value) + '</span>'; }
function chips(values) { return (values || []).map(chip).join(''); }
function decisionsForOutput(agentOutput) {
  const output = agentOutput.output || {};
  const v2 = Array.isArray(output.issues) ? output.issues : null;
  const v1 = [output.seed_decision, ...(Array.isArray(output.opportunistic_decisions) ? output.opportunistic_decisions : [])];
  return (v2 || v1).filter(d => d && d.key);
}
function derived(agentOutput) {
  const decisions = decisionsForOutput(agentOutput);
  const seedDecision = decisions.find(d => d.role === 'seed') || decisions[0] || {};
  return {
    issue_keys: [...new Set(decisions.map(d => d.key).filter(Boolean))].sort(),
    assessments: [...new Set(decisions.map(d => d.assessment).filter(Boolean))].sort(),
    next_steps: [...new Set(decisions.map(d => d.next_step).filter(Boolean))].sort(),
    target_chunks: [...new Set(decisions.flatMap(d => d.target_chunks || []))].sort(),
    title: seedDecision.summary || agentOutput.seed_key,
    recommendation: seedDecision.recommendation || ''
  };
}
function uniqFlat(field) { return [...new Set(report.agent_outputs.flatMap(o => derived(o)[field] || []))].sort(); }
function fillSelect(el, values) { for (const v of values) { const o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o); } }

document.getElementById('meta').innerHTML = [
  'Run: ' + esc(report.run.run_id),
  'Generated: ' + esc(report.generated_at),
  'Agent outputs: ' + report.counts.agent_outputs,
  'Issues: ' + report.counts.issues,
  'Decisions: ' + report.counts.decisions,
  'Seeds done/running/pending/skipped/failed: ' + [report.seed_counts.done, report.seed_counts.running, report.seed_counts.pending, report.seed_counts.skipped, report.seed_counts.failed].join('/')
].map(x => '<span>' + x + '</span>').join('');

fillSelect(nextStep, uniqFlat('next_steps'));
fillSelect(assessment, uniqFlat('assessments'));
fillSelect(chunk, uniqFlat('target_chunks'));

function searchable(agentOutput) { return JSON.stringify(agentOutput).toLowerCase(); }
function filtered() {
  const term = q.value.trim().toLowerCase();
  return report.agent_outputs.filter(agentOutput => {
    const d = derived(agentOutput);
    return (!term || searchable(agentOutput).includes(term)) &&
      (!nextStep.value || d.next_steps.includes(nextStep.value)) &&
      (!assessment.value || d.assessments.includes(assessment.value)) &&
      (!chunk.value || d.target_chunks.includes(chunk.value));
  });
}
function renderList() {
  const rows = filtered();
  list.innerHTML = rows.length ? rows.map(agentOutput => {
    const d = derived(agentOutput);
    return '<div class="row ' + (selected === agentOutput.seed_key ? 'active' : '') + '" data-key="' + esc(agentOutput.seed_key) + '">' +
      '<h2>' + jiraLink(agentOutput.seed_key) + ' <span class="chip">' + d.issue_keys.length + ' issue' + (d.issue_keys.length === 1 ? '' : 's') + '</span></h2>' +
      '<div class="summary">' + esc(d.title || '(no summary)') + '</div>' +
      '<div class="summary">' + esc(d.recommendation || '') + '</div>' +
      '<div class="chips">' + chips(d.next_steps) + chips(d.assessments) + chips(d.target_chunks.slice(0, 5)) + '</div>' +
      '</div>';
  }).join('') : '<div class="empty">No matching agent outputs.</div>';
}
function renderDetail(seedKey) {
  const agentOutput = report.agent_outputs.find(o => o.seed_key === seedKey);
  if (!agentOutput) return;
  selected = seedKey;
  const d = derived(agentOutput);
  detail.innerHTML = '<div class="section"><h2>' + jiraLink(agentOutput.seed_key) + '</h2>' +
    '<div class="chips">' + chips(d.issue_keys) + chips(d.next_steps) + chips(d.assessments) + chips(d.target_chunks) + '</div></div>' +
    '<div class="section"><h3>Agent Output JSON</h3><pre>' + esc(JSON.stringify(agentOutput.output, null, 2)) + '</pre></div>';
  renderList();
}
list.addEventListener('click', e => { const row = e.target.closest('.row'); if (row) renderDetail(row.dataset.key); });
[q, nextStep, assessment, chunk].forEach(el => el.addEventListener('input', () => { renderList(); }));
renderList();
if (report.agent_outputs[0]) renderDetail(report.agent_outputs[0].seed_key);
</script>
</body>
</html>`;
}

mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, "issue-mapping-report.json");
const htmlPath = path.join(outDir, "issue-mapping-viewer.html");
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(htmlPath, viewerHtml(report));

console.log(`run_id=${runId}`);
console.log(`agent_outputs=${report.counts.agent_outputs}`);
console.log(`issues=${report.counts.issues}`);
console.log(`decisions=${report.counts.decisions}`);
console.log(`json=${jsonPath}`);
console.log(`html=${htmlPath}`);
