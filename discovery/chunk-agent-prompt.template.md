# AutofHIR discovery assignment

You are an analysis subagent in an AutofHIR run. Your operating manual is below. Read it before starting.

Work incrementally. Durable intermediate files are required: write the query strategy, mechanically export the candidate table, and append one review record per candidate or proposed Jira. Do not wait until the end to write everything.

## Run context

- Working directory (this repo): /home/jmandel/hobby/fhir-community-search
- FHIR spec checkout: {{SPEC_CHECKOUT_ROOT}} on master, pinned at {{SPEC_COMMIT_PINNED}}
- Run ID: {{RUN_ID}}
- Chunk ID: {{CHUNK_ID}}
- Prompt file: {{PROMPT_PATH}} (this exact assignment; use it if you need to re-read your instructions)
- Output folder: {{CHUNK_DIR}} (already created; write all artifacts here)

## Your chunk

| Field | Value |
|---|---|
| Chunk ID | {{CHUNK_ID}} |
| Chunk name | {{CHUNK_NAME}} |
| Work group | {{WG}} ({{WG_NAME}}) |
| Source paths | {{SOURCE_PATHS}} |
| Activity cutoff (`updated_at >=`) | {{CUTOFF_DATE}} |
| Spec reference flavor | {{SPEC_REFERENCE}} |

## How to use this prompt

This prompt is self-contained. If your context is compacted or you need to re-read your assignment, reopen the prompt file above. The operating manual defines the required workflow and output schema. The community search command guide gives the local Jira/Zulip/Confluence/spec commands you may need while carrying out the workflow.

---

# Current Chunk Source Snapshot

<current_chunk_source_snapshot spec_checkout="{{SPEC_CHECKOUT_ROOT}}" spec_commit="{{SPEC_COMMIT_PINNED}}" max_text_bytes="{{SOURCE_SNAPSHOT_MAX_BYTES}}">

{{SOURCE_SNAPSHOT_BODY}}

</current_chunk_source_snapshot>

---

# Operating Manual

<operating_manual source="autofhir/discovery/analysis-pipeline.md">

{{PIPELINE_BODY}}

</operating_manual>

---

# Community Search Command Guide

<community_search_command_guide source="SKILL.md" setup_section_omitted="true">

{{COMMUNITY_SEARCH_BODY}}

</community_search_command_guide>
