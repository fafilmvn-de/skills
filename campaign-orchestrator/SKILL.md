---
name: campaign-orchestrator
description: Orchestrates the end-to-end build of a new agency-campaigns/<campaign>/<batch>/ pipeline on top of the generic-campaigns/ framework. Use when the user invokes /campaign with any sub-verb (init, stage, status, verify, extract-intake), or when they ask to "start a new campaign", "bootstrap a campaign batch", "build campaign leads list", "scaffold a campaign", "create a new <your-campaign-family> campaign", or to clone an existing campaign with new parameters.
---

# campaign-orchestrator

End-to-end builder for retention / upsell campaigns under `agency-campaigns/`, on top of the
`generic-campaigns/` framework (template + lib). One slash-style command, five verbs.

## What this skill does

Drives the canonical 6-stage campaign pipeline (01 data-prep → 02 PO aggregation →
03 hand-off mapping → 04 leads-list v1 → 05 leads-list v2 → 06 CE inputs) **without**
re-authoring boilerplate — `generic-campaigns/template/` already supplies the notebook
shells with `# TODO: campaign-specific` markers, and `generic-campaigns/lib/` supplies
schema, exclusions, dictionary, funnel, and write helpers.

This orchestrator coordinates four moving parts:

1. **Bootstrap** — copy `generic-campaigns/template/` into the new campaign folder.
2. **Intake interview** — fill `docs/intake.md`'s `<!-- TODO -->` placeholders.
3. **Stage authoring** — fill the `# TODO: campaign-specific` blocks inside the copied
   notebooks (one stage at a time, resumable).
4. **Deploy + verify** — push to GitHub, wait for the Databricks Git folder to pull,
   submit a one-shot run, parse row counts.

Cross-cutting sub-skills (each owns its own `task`-tool dispatch):

- `intake-extractor` — reverse-engineer a draft `intake.md` from an existing reference campaign.
- `schema-verifier` — `DESCRIBE TABLE` via `databricks` CLI; caches into `lt-memory/schemas/`.
- `deploy-verifier` — git-push → workspace-pull poll → submit run → row-count assertions.

## Hard rules (inherited)

Before running any verb, internalise these from `generic-campaigns/AGENTS.md`:

1. **Never** edit `generic-campaigns/lib/` or `generic-campaigns/template/` directly during a
   campaign build. Only edit inside the copied campaign folder. The only exception is
   promoting an exclusion that genuinely applies to ≥2 campaigns into `lib/exclusions.py`
   (that requires an explicit user confirmation + an audit-trail entry).
2. **Never** regenerate `06_campaign_engine_inputs.py` — it is a `%run` shim around the
   shared `/agency-campaigns/_campaign_input_files.py`. Only set its widgets.
3. **Never** write to `hive_metastore` or `<source_catalog>`. Reads from `<source_catalog>.*`,
   writes to `<write_catalog>.*`. Volumes follow `/Volumes/<write_catalog>/.../`.
4. **Never** invent column names. Before authoring any SQL fragment, call `schema-verifier`
   on every referenced table.
5. **Channel** is a closed enum `{Agency, VTB}`. New channel = ADR required, halt and tell
   the user.
6. **Notebook conventions** per `/.github/copilot-instructions.md`: `# Databricks notebook
   source` line 1, `# COMMAND ----------` separators, `import pyspark.sql.functions as F`,
   UPPER_SNAKE_CASE constants, `%run` cells stand alone, `CAST(... AS INT)` after
   `FLOOR/CEIL/ROUND`, `encoding='utf-8-sig'` on non-ASCII (e.g. ese) CSV exports, lowercase output
   columns.
7. **Stages 04 + 05** are the *same notebook* with `RUN_TAG=v1` / `RUN_TAG=v2`. The
   `05_*` file is a 2-cell shim that `%run`s `04_*`. Do not duplicate logic.

## Verb dispatch

The user's invocation will look like one of:

```
/campaign init <campaign> <batch> [--reference <path>]
/campaign stage <stage-name>
/campaign status
/campaign verify [<stage-name>]
/campaign extract-intake <campaign-batch-path>
```

If the user provides a natural-language request (e.g. *"start a new <campaign> <batch>
using batch-2 as reference"*), parse it into the equivalent verb + args **and confirm with
the user before any file write**.

Stage names map 1:1 to the template notebooks:

| Stage name | Template notebook |
|---|---|
| `data-prep` | `01_data_preparation_UC.py` |
| `po-aggregation` | `02_po_level_aggregation_UC.py` |
| `handoff-mapping` | `03_handoff_mapping_UC.py` |
| `leads-list` | `04_leads_list_UC.py` (RUN_TAG=v1) and `05_leads_list_UC.py` (RUN_TAG=v2 shim) |
| `engine-inputs` | `06_campaign_engine_inputs.py` (widget config only — DO NOT re-author body) |
| `docs` | `docs/audit-trail.md` append + `handovers/` HTML entry |

---

## Verb: `init`

**Signature:** `/campaign init <campaign> <batch> [--reference <reference-path>]`

**Arguments:**

- `<campaign>` — lower_snake_case slug, e.g. `<campaign>`. Becomes the folder name under
  `agency-campaigns/`.
- `<batch>` — batch slug, e.g. `batch-3`. Becomes the sub-folder.
- `--reference <path>` (optional but recommended) — path to an existing campaign batch to
  clone the intake from (e.g. `agency-campaigns/<campaign>/<batch>`).

**Procedure:**

1. **Pre-flight checks.**
   - Verify `agency-campaigns/<campaign>/<batch>/` does NOT already exist. If it does, halt
     and ask the user whether to abort or to overwrite (default: abort).
   - Verify `generic-campaigns/template/` exists. If not, halt — the framework is missing.

2. **Bootstrap.** Copy the template into the campaign folder:

   ```powershell
   Copy-Item -Recurse generic-campaigns/template agency-campaigns/<campaign>/<batch>
   ```

   The copy includes: `01_*.py` through `06_*.py`, `intake.md`, `extras_data_dictionary.csv`,
   and `campaign-files/`. Do NOT alter `generic-campaigns/template/` itself.

3. **Seed intake.md from reference (if `--reference` provided).**
   - Invoke the `intake-extractor` skill with the reference path. It returns a draft
     `intake.md` with as many `<!-- TODO -->` placeholders pre-filled as it can recover
     from the reference's notebooks + filled intake.
   - Overwrite `agency-campaigns/<campaign>/<batch>/docs/intake.md` with the draft.
     (The template's blank intake.md is replaced.)
   - If the extractor flags any exclusion patterns that appear in the reference but are
     missing from `generic-campaigns/lib/exclusions.py`, surface them to the user with a
     prompt to promote (e.g. `excl_shared_phone` from batch-1).

4. **Diff-interview to fill remaining TODOs.**
   - Read `agency-campaigns/<campaign>/<batch>/docs/intake.md`.
   - Identify every remaining `<!-- TODO -->` placeholder.
   - Load `prompts/intake_interview.md` and walk the user through each unfilled TODO,
     one question at a time. Recommend a default answer based on the reference (if any).
   - Use the `ask_user` tool — never embed multiple-choice in plain text.
   - After each answer, edit the intake.md in-place.

5. **Set widget defaults in each notebook.**
   - For NB01 through NB05, edit the `dbutils.widgets.text(..., default, ...)` defaults to
     match the now-filled intake.md (e.g. `CAMPAIGN`, `CHANNEL`, `SNAPSHOT_DATE`, plan-code
     lists, age bands).
   - For NB06, only set the dozen widgets that map to the Campaign Engine inputs. Do not
     touch the body — it `%run`s the shared file.
   - Confirm the widget edits with the user before writing.

6. **Audit-trail entry.**
   - Append a row to `agency-campaigns/<campaign>/<batch>/docs/audit-trail.md`:
     `YYYY-MM-DD | init | scaffolded from <reference or 'cold start'>`.

7. **Hand-off message.**
   - Tell the user: campaign folder is initialised, intake.md is filled, widgets are set.
     Next step is `/campaign stage data-prep` to fill the campaign-specific eligibility CTE
     in NB01. Do NOT auto-proceed.

---

## Verb: `stage`

**Signature:** `/campaign stage <stage-name>`

**Arguments:** `<stage-name>` ∈ `{data-prep, po-aggregation, handoff-mapping, leads-list,
engine-inputs, docs}`.

**Procedure:**

1. **Resolve current campaign context.** Determine the active campaign folder. If the
   user's CWD is inside an `agency-campaigns/<campaign>/<batch>/` folder, use that. Else
   look for the most recently-modified campaign folder, and confirm with `ask_user`.

2. **Pre-flight intake.** Open the campaign's `docs/intake.md`. If any `<!-- TODO -->`
   markers remain, halt and tell the user to finish `/campaign init` first. Refuse to
   author stage code against an incomplete intake.

3. **Load the matching stage prompt.** Read
   `skills/campaign-orchestrator/prompts/stage_<stage-name with underscores>.md`
   (e.g. `stage_data_prep.md`, `stage_po_aggregation.md`). The prompt file IS the
   authoring procedure — follow it verbatim.

4. **Schema verification gate.** Before any SQL is authored or edited, the stage prompt
   will list the source tables + columns it intends to reference. Pass each through the
   `schema-verifier` skill (dispatch via the `task` tool of type `task` if the list is
   large; inline if ≤2 tables). Halt on any `not_found` — surface the suggestion to the
   user via `ask_user`.

5. **Idempotent edit inside sentinel blocks.** The stage prompt always uses sentinel
   markers (`# region campaign-specific:<stage>` / `/* campaign-specific:<stage>:START */`)
   so re-runs only replace the managed region. Code outside the sentinels — including
   user hand-edits — is preserved.

6. **Audit-trail entry.** Append `YYYY-MM-DD | stage:<stage-name> | <summary>` to
   `docs/audit-trail.md`.

7. **Hand-off message.** Tell the user the stage is authored locally. The next step is
   `/campaign verify <stage-name>` to push + sync + run. Do NOT auto-proceed.

**Stage-specific exceptions:**

- `engine-inputs` only edits widget defaults; the body is NEVER regenerated (rule 2).
- `leads-list` covers BOTH stages 04 and 05 — author only `04_*` (the v1 file); `05_*`
  remains the unchanged `%run` shim.
- `handoff-mapping` may be a near-no-op if `intake.md` section 7 says no external
  hand-off (the prompt handles this case).
- `docs` is the only stage that runs AFTER deployment — it reads run output and audit
  trail to render `docs/README.md`, `docs/DOC.md`, and the `handovers/` HTML.

---

## Verb: `status`

**Signature:** `/campaign status [<campaign-batch-path>]`

**Procedure:**

1. **Resolve the campaign folder** (same logic as stage step 1).

2. **Intake-completion %.** Open `docs/intake.md`. Count total `<!-- TODO -->` markers
   present vs the canonical template's count (read
   `generic-campaigns/template/intake.md` for the denominator). Report `<filled>/<total>`.

3. **Notebook sentinel coverage.** For each notebook NB01-NB06 in the campaign folder:
   - Detect whether a `# region campaign-specific:<stage>` block exists.
   - If yes, report `<stage>: AUTHORED`.
   - If no, report `<stage>: PENDING`.
   - Special case `engine-inputs`: check whether the widget defaults differ from the
     pristine template defaults.

4. **Schema-cache freshness.** List `lt-memory/schemas/*.json` files. For each, parse
   `fetched_at` and flag any older than 7 days as `STALE` — these will be re-fetched
   on next `schema-verifier` invocation.

5. **Last audit-trail entry.** Tail `docs/audit-trail.md` and print the most recent
   5 entries with their dates.

6. **Output table existence.** Read intake section 8 (output expectations) for the
   expected output FQNs. For each, invoke `schema-verifier table <fqn>` (cached-only —
   do NOT force a live fetch from `status`). Report `EXISTS` / `MISSING` / `UNKNOWN`.

7. **Render the status report** as a Markdown table. No file writes.

---

## Verb: `verify`

**Signature:** `/campaign verify [<stage-name>]`

**Procedure:**

1. **Resolve the campaign folder.**

2. **Resolve the notebook to run.** Map `<stage-name>` to its notebook file inside the
   campaign folder. If `<stage-name>` is omitted, default to the most recently-edited
   notebook (per `git log -1 --format=%H -- <file>`).

3. **Determine widgets to pass.** Read the notebook's widget declarations and the
   filled intake.md to compute the run-time widget overrides. For `leads-list`, prompt
   the user via `ask_user` whether this is a `RUN_TAG=v1` (pre-launch) or `v2`
   (near-launch refresh) run.

4. **Determine row-count assertion.** From intake.md section 8, derive the expected
   minimum row count for the stage's output. If intake doesn't specify a number, ask
   the user for a sane floor (e.g. ≥ 1000 rows for a leads-list).

5. **Dispatch to `deploy-verifier`.** Use the `task` tool with `agent_type: task`
   (Haiku) so the long-running poll doesn't fill the main context. Pass:
   - notebook path
   - widget overrides
   - row-count assertion (`<fqn>:<n>`)
   - default cluster id `<your-cluster-id>`

6. **Interpret the report.** When `deploy-verifier` returns:
   - `git.synced == false` → halt and surface the sync error. Do not retry blindly.
   - `job.status == FAILED` → print the stdout tail; ask the user whether to debug
     locally and re-verify, or escalate.
   - `assertions.passed == false` → flag as a real problem. A successful job with an
     under-count almost always means an exclusion is too aggressive or a join dropped
     more rows than expected.
   - `assertions.passed == true` → append `YYYY-MM-DD | verify:<stage> | run_id=<id>
     rows=<actual>` to `docs/audit-trail.md` and tell the user the stage is verified.

7. **Never auto-rerun.** If the run fails, halt. The fix loop is owned by the user
   (edit locally, commit, re-`/campaign verify`).

---

## Verb: `extract-intake`

**Signature:** `/campaign extract-intake <campaign-batch-path>`

**Procedure:**

1. **Validate the path.** Confirm `<campaign-batch-path>/01_data_preparation_UC.{py,ipynb}`
   exists. If not, halt — the path isn't a campaign batch.

2. **Dispatch to `intake-extractor`.** Load the skill via the `skill` tool. It will
   read the reference notebooks + any existing intake.md + audit-trail and emit a draft
   `intake.md` with `<!-- TODO -->` markers wherever it couldn't recover a value.

3. **Surface promotion candidates.** The extractor returns a list of campaign-specific
   exclusions / helpers that appear in this batch but aren't in
   `generic-campaigns/lib/`. Forward each to the user via `ask_user` with a
   recommendation:
   - If the pattern appears in ≥2 known campaigns → recommend promotion to `lib/`.
   - If it's unique → recommend keeping it in the campaign-specific sentinel block.

4. **Write the draft.** Save the produced intake.md to
   `<campaign-batch-path>/docs/intake.md` ONLY if the file doesn't exist, or if the
   user confirms overwrite via `ask_user`.

5. **Audit-trail entry.**

6. **Done.** This verb does NOT run any stages — it's a one-shot extraction.

---

## Dispatch model

This is a Copilot CLI skill. When the main agent loads it, the SKILL.md is *the* dispatch
logic — no runtime engine. The main agent reads this file, parses the user's verb + args,
and executes the procedure inline using the standard tools (`view`, `edit`, `create`,
`powershell`, `ask_user`) plus the `skill` tool to load `intake-extractor`,
`schema-verifier`, and `deploy-verifier` when needed.

Sub-skills should be loaded **only when their verb actually fires**, not preemptively, to
keep the main context small.

## Prompts

The `prompts/` subdirectory contains the interview / authoring scripts. Each is loaded by
the main agent on demand:

- `prompts/intake_interview.md` — how to interview the user through unfilled intake TODOs.
- `prompts/stage_*.md` — how to fill the `# TODO: campaign-specific` blocks in each
  notebook (pending step 4 of the build sequence).

## What this skill does NOT do

- Author business logic from scratch — eligibility, segmentation, and exclusion criteria
  come from the user's intake answers, not from the LLM's training data.
- Touch `generic-campaigns/lib/` (except the documented exclusion-promotion path).
- Push to GitHub or run notebooks on Databricks — those are `deploy-verifier`'s job.
- Author the Campaign Engine input file body — only its widgets.
