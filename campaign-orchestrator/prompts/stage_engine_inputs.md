# prompts/stage_engine_inputs.md

Used by `campaign-orchestrator` for `/campaign stage engine-inputs`. Configures
**widgets only** in `06_campaign_engine_inputs.py`.

## CRITICAL RULE — DO NOT AUTHOR THE BODY

`06_campaign_engine_inputs.py` is a `%run` shim around the shared
`/agency-campaigns/_campaign_input_files.py`. **Per `generic-campaigns/AGENTS.md` rule 5,
this file's body must NEVER be regenerated, edited, or absorbed.** Only the dozen
`dbutils.widgets` defaults change per campaign.

If the user asks for body changes in NB06, halt and explain that the shared file is the
contract — body changes are ADR-required and out of scope for the orchestrator.

## Procedure

1. **Load intake.md.** Extract section 1 (metadata: campaign code, channel,
   CMPGN_TYPE, launch / end dates, communication cycle, offer period, target response
   rate, processor) and section 7 (sFTP upload owner).

2. **Reference `generic-campaigns/docs/PER_CAMPAIGN_INPUTS.md`** for the canonical
   widget list. (If that file doesn't exist yet, fall back to reading the existing
   widget declarations in the template `06_*.py`.) Map each intake field to a widget.

3. **Verify the leads-list Delta exists.** Use `schema-verifier table <leads_list_fqn>`
   to confirm the v1 (or v2) leads-list table is materialised before configuring NB06.
   If not found, halt — tell the user to run stage `leads-list` first.

4. **Set widget defaults.** Edit `06_campaign_engine_inputs.py` widget declarations
   in-place. Each `dbutils.widgets.text("WIDGET_NAME", "<default>", "...")` line gets
   its `<default>` updated. Use a sentinel block to track which lines the orchestrator
   manages:

   ```python
   # region campaign-specific:engine-inputs — START
   dbutils.widgets.text("CAMPAIGN",       "<campaign>_<yyyy>_<mm>", "Campaign code")
   dbutils.widgets.text("CHANNEL",        "Agency",                "Channel")
   dbutils.widgets.text("CMPGN_TYPE",     "ANNIV",                   "CE enum")
   dbutils.widgets.text("LAUNCH_DATE",    "2026-09-15",            "YYYY-MM-DD")
   dbutils.widgets.text("END_DATE",       "2026-12-15",            "YYYY-MM-DD")
   dbutils.widgets.text("COMM_CYCLE_MTHS","3",                     "months")
   dbutils.widgets.text("OFFER_PERIOD_MTHS","3",                   "months")
   dbutils.widgets.text("TARGET_RESP_RT", "0.05",                  "decimal")
   dbutils.widgets.text("PROCESSOR",      "<name>",                "processor")
   dbutils.widgets.text("LEADS_LIST_FQN", "<write_catalog>....", "input leads Delta")
   dbutils.widgets.text("RUN_TAG",        "v1",                    "v1 | v2")
   dbutils.widgets.text("OUTPUT_VOLUME",  "/Volumes/...",          "CSV output dir")
   # endregion campaign-specific:engine-inputs — END
   ```

5. **Preserve everything outside the sentinel** — especially the `%run
   /agency-campaigns/_campaign_input_files` line.

6. **Audit-trail entry.**

7. **Stop.** Direct user to `/campaign verify engine-inputs`. After verification, the
   four CE input CSVs (ENGINE_MEMBER / ENGINE_PROMO / ENGINE_OFFER / ENGINE_TARGET) will be in
   `OUTPUT_VOLUME` ready for the sFTP upload owner.

## Hard rules

- NEVER edit the `%run` line or anything below the sentinel block.
- NEVER add Python logic to NB06 — it is a contract shim only.
- All four CSV outputs use `encoding='utf-8-sig'` (handled by the shared file).
- If a required widget is missing from the shared file, file an ADR — do not work
  around it locally.
