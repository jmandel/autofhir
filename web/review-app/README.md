# Review App Source

This is the React/Zustand source for the AutoFHIR review UI. The exporters
build it with `bun build` into a static `review-app.js` bundle, write
`review-app.css`, and serve run data from either `issue-fixup-diff-report.json`
or `issue-reconcile-report.json`.

For small reports, the sidebar renders the full filtered list. For large
issue-reconcile reports, the sidebar renders a window around the selected item
and selected issue details, raw commit messages, and diffs load from sidecar
files. This keeps the same main review sections without forcing the browser to
mount thousands of full issue cards and patches at once.

Review decisions and notes are stored in `localStorage` through Zustand persist,
so reviewers can refresh the page without losing approve/reject/defer choices.

Generated review reports should be produced from a live run with:

```bash
bun autofhir/scripts/export-issue-fixup-diff-viewer.ts --run-id <run-id>
bun autofhir/scripts/export-issue-reconcile-viewer.ts --run-id <run-id>
```
