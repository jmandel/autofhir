# AutoFHIR Commit Triage Rollup

Generated: 2026-06-05T20:47:06.850Z

Source run: `issue-reconcile-full-clean-balanced-v2`
Pruned run: `issue-reconcile-full-clean-balanced-v2-pruned-no-avoid-files`
Triage run: `issue-reconcile-full-clean-balanced-v2-pruned-no-avoid-files-commit-triage-v1`

## Summary

The original review branch had 1696 source-changing fixed commits. The hard-avoid-file pruning removed 102 commits whose remaining changes were only generated/layout/out-of-scope files, leaving 1594 source-changing commits for commit-level triage.

The default reviewer filter now shows 1457 commits (85.9% of the original source-changing set): Jira-backed missed applications with a clean whole-commit spec change. The secondary review bucket has 137 commits: 109 real fixes with unclear Jira path, and 28 changes not needed for current spec correctness.

Total trimmed out of the default direct-apply view: 239 of 1696 (14.1%).

## Category Counts

| Bucket | Count | Percent of original |
|---|---:|---:|
| Default: Jira-backed spec changes | 1457 | 85.9% |
| Pruned hard-avoid-only commits | 102 | 6.0% |
| Secondary: real fix, unclear Jira path | 109 | 6.4% |
| Secondary: no current spec impact | 28 | 1.7% |

## Work Group Rollup

| WG | Original | Pruned | Default | Unclear Jira | No spec impact | Dropped by file prune | Default % original |
|---|---:|---:|---:|---:|---:|---:|---:|
| fhir-i | 611 | 581 | 542 | 33 | 6 | 30 | 88.7% |
| oo | 233 | 214 | 187 | 22 | 5 | 19 | 80.3% |
| fm | 97 | 93 | 84 | 9 | 0 | 4 | 86.6% |
| vocab | 93 | 92 | 83 | 7 | 2 | 1 | 89.2% |
| pa | 102 | 89 | 82 | 5 | 2 | 13 | 80.4% |
| pharm | 82 | 79 | 72 | 3 | 4 | 3 | 87.8% |
| cds | 72 | 68 | 62 | 5 | 1 | 4 | 86.1% |
| pc | 76 | 67 | 58 | 6 | 3 | 9 | 76.3% |
| brr | 64 | 53 | 44 | 6 | 3 | 11 | 68.8% |
| security | 45 | 43 | 41 | 2 | 0 | 2 | 91.1% |
| mnm | 42 | 41 | 38 | 3 | 0 | 1 | 90.5% |
| cqi | 39 | 37 | 35 | 2 | 0 | 2 | 89.7% |
| ii | 34 | 34 | 32 | 2 | 0 | 0 | 94.1% |
| cbcc | 29 | 28 | 26 | 2 | 0 | 1 | 89.7% |
| sd | 22 | 22 | 21 | 0 | 1 | 0 | 95.5% |
| unknown | 12 | 12 | 10 | 1 | 1 | 0 | 83.3% |
| dev | 10 | 9 | 9 | 0 | 0 | 1 | 90.0% |
| inm | 9 | 9 | 9 | 0 | 0 | 0 | 100.0% |
| its | 9 | 9 | 9 | 0 | 0 | 0 | 100.0% |
| pher | 8 | 7 | 6 | 1 | 0 | 1 | 75.0% |
| fmg | 5 | 5 | 5 | 0 | 0 | 0 | 100.0% |
| cg | 1 | 1 | 1 | 0 | 0 | 0 | 100.0% |
| director | 1 | 1 | 1 | 0 | 0 | 0 | 100.0% |

## Verification

- Review report: `review/issue-reconcile-report.json` has 1594 source-changing rows.
- Viewer default preset: `Jira-backed spec changes` is 1457 rows.
- Details and patches: one JSON detail file and one patch file per surviving commit.
