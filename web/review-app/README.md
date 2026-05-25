# Review App Source

This is the React/Zustand source for the issue-fixup review UI. The exporter
builds it with `bun build` into a static `review-app.js` bundle, writes
`review-app.css`, and serves run data from `issue-fixup-diff-report.json`.

The app intentionally renders the full review text and embedded diffs into the
DOM after the JSON report loads, so browser Ctrl-F can search across the
complete review state. Do not add virtualized, delayed, or scroll-driven row
rendering unless that workflow requirement changes.

Review decisions and notes are stored in `localStorage` through Zustand persist,
so reviewers can refresh the page without losing approve/reject/defer choices.

Generated review reports should be produced from a live run with:

```bash
bun autofhir/scripts/export-issue-fixup-diff-viewer.ts --run-id <run-id>
```
