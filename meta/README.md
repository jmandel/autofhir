# autofhir/meta

Durable meta-prompts and reference material for the discovery/planning workflow. Nothing here is a runnable artifact. These files are planning/design source material.

For the shared orchestration model, start with `../SKILL.md` and `../workflows/orchestration.md`. For workflow-specific behavior:

- `../workflows/discovery.md` summarizes how these meta documents are used in read-only discovery runs.
- `../workflows/apply.md` summarizes the downstream spec-edit application workflow.
- Implementation-facing discovery prompt/reference files live under `../discovery/`; keep these `meta/` copies for planning history and design iteration.

## Active files (read these)

| File | Purpose | Read when |
|---|---|---|
| `analysis-pipeline.md` | Per-chunk seven-phase operating manual. Defines the discovery worker workflow, on-disk layout, and `plan.json` schema (including the `mentioned_keys` invariant). | You are a discovery chunk agent, or you're rendering/validating one. |
| `chunk-agent-prompt.template.md` | Thin per-chunk wrapper; the renderer substitutes placeholders and inlines `analysis-pipeline.md` into the final prompt. | You need to change per-chunk framing. Change behavior in `analysis-pipeline.md`. |
| `agent-partitioning.md` | Discovery workflow partitioning story: WG-axis partitioning, source-chunk granularity, the four status bundles, reconciliation philosophy. | You're designing or validating discovery chunk generation. |
| `orchestration-plan.md` | Discovery workflow runbook: build roster → parallel analysis → misroute apply → delta re-runs → untouched reconciliation → aggregate report. | You're implementing discovery workflow logic on top of the shared AutofHIR engine. |
| `jira-topic-scan.md` | Tiered (E1/E2/E3/M1/M2) candidate-construction methodology used in Phase 2 of `analysis-pipeline.md`. | You're a chunk agent in Phase 2, or you're hand-running a one-off scan. |
| `applying-chunks-of-work.md` | The autofhir brief for the downstream worker pipeline (parallel Copilot agents applying spec edits). | You're handing off analysis output to the worker pipeline (see `../SKILL.md`). |

## How they chain

```
chunk-agent-prompt.template.md   (rendered per chunk)
        │
        ▼
analysis-pipeline.md             (the agent's operating manual)
        │
        ▼ uses
jira-topic-scan.md               (tiered Phase 2 methodology)

        ─── discovery workflow view ───
orchestration-plan.md            (the runbook: waves and reconciliation)
        │
        ▼ enforces
agent-partitioning.md            (WG-axis partition, bundle taxonomy, reconciliation)

        ─── downstream handoff ───
applying-chunks-of-work.md  +  ../workflows/apply.md  +  ../SKILL.md
                                (worker pipeline consumes drift + apply queue)
```

## Generated data (created during a run)

Chunks are produced algorithmically at Wave 0; no pre-committed topic list lives in this directory. The inputs are:

- `/home/jmandel/work/fhir/source/fhir.ini` `[workgroups]` — authoritative resource → WG map from the spec itself.
- `wg-source-map.json` (to be authored once, ~1h of curation) — narrative-page → WG overlay for the ~215 top-level HTML files that aren't in `fhir.ini`.

From those, Wave 0 emits:

- `autofhir/runs/<run-id>/chunks.json` — the run's chunk roster.
- Per-chunk artifacts under `autofhir/runs/<run-id>/chunks/<chunk-id>/` (see `analysis-pipeline.md`).

Because chunk generation is mechanical and re-runs read the pinned FHIR checkout plus overlay, the roster naturally tracks spec evolution. New resources in master become new chunks in the next run without any meta-file edits. The committed meta directory should not contain a point-in-time `chunks.generated.json`; any such roster belongs under a specific run directory.

## Conventions for adding files here

- Meta = how to do work. Executable belongs in `autofhir/scripts/` or `scripts/`.
- One responsibility per file. Don't merge files that evolve on different cadences.
- Cross-reference by relative path (e.g. `analysis-pipeline.md`).
- Mark spec-version-dependent content with **(R5)** / **(R6+)** tags so it stays legible across releases.
