# prompts/stage_leads_list.md

Used by `campaign-orchestrator` for `/campaign stage leads-list`. Covers BOTH stages 04
(v1 — pre-launch) and 05 (v2 — near-launch refresh), since they share the same notebook.

## Context

Template `04_leads_list_UC.py` is the canonical leads-list builder:

- Reads NB03's output (or NB02's if hand-off was skipped).
- Adds enrichment columns: PO phone, email, marketing consent, propensity scores,
  funnel-stage labels.
- Applies the five framework-default exclusions + any campaign-specific exclusions.
- Builds the funnel break-down (drop reasons per stage) via `lib/funnel.py`.
- Calls `assert_leads_list_schema(df)` from `lib/schema.py` — **fail-loud if the output
  schema diverges from `LEADS_LIST_SCHEMA + extras_data_dictionary.csv`**.
- Writes the leads-list Delta + a CSV mirror to the campaign's UC Volume.

`05_leads_list_UC.py` is a 2-cell shim that `%run`s `04_*` with `RUN_TAG=v2`.
**Never duplicate logic into 05** — only widget overrides.

## Procedure

1. **Load intake.md** sections 4 (exclusions), 6 (segmentation columns), 8 (extras).
   Halt if any `<!-- TODO -->` remains.

2. **Verify schemas.** Pass every column referenced in the final SELECT — both framework
   columns (from `lib/schema.py::LEADS_LIST_SCHEMA`) and extras — through
   `schema-verifier`. Critical because this is the schema the Campaign Engine consumes.

3. **Check exclusion-promotion candidates.** Before authoring, re-check the intake
   section 4 against `generic-campaigns/lib/exclusions.py`. If any campaign-specific
   exclusion appears in ≥2 historical campaigns (look at `intake-extractor`'s previous
   report if available), **prompt the user via `ask_user` to promote it into
   `lib/exclusions.py`** before proceeding. Do not write duplicate SQL fragments in
   per-campaign notebooks when a `lib/` home is appropriate.

4. **Sentinel-wrap the additions.** Markers:

   ```python
   # region campaign-specific:leads-list — START
   # ... custom exclusion calls, extras column derivations, funnel-stage adjustments ...
   # endregion campaign-specific:leads-list — END
   ```

5. **Compose:**
   - **Custom exclusions:** for each campaign-specific exclusion in intake section 4,
     call the matching helper from `lib/exclusions.py` (e.g. `excl.add_shared_phone_flag(df)`).
     If it's NOT in lib yet and the user opted not to promote, inline the SQL fragment
     here with a `# inline-exclusion: <name>` comment for future promotion.
   - **Extras columns:** for each row in `docs/extras_data_dictionary.csv`, derive the
     column in the appropriate location (often from NB02's PO aggregates or from a
     fresh join to a curated table). Document the derivation logic right above the
     `withColumn` call.
   - **Funnel break-down:** call `lib/funnel.render_funnel(stages_dict)` AFTER all
     exclusions are applied. The `stages_dict` maps stage names → row counts. Save the
     SVG + PNG to `docs/` AND to the Volume per ADR 0002 (Volume is canonical).
   - **Schema assertion:** ensure `assert_leads_list_schema(df_final)` is called BEFORE
     `df_final.write...`. The template should already have this — verify it's still
     there after your edits.

6. **Output paths.** Read from intake.md section 8 / the orchestrator's manifest of
   output FQNs. Standard pattern:
   - Delta: `<write_catalog>.<write_schema>.<campaign>_<batch>_leads_list_v{1,2}`
   - CSV mirror: `/Volumes/<write_catalog>/<write_schema>/<write_volume>/Campaigns/<channel>/<campaign>_<batch>/leads_list_v{1,2}.csv` with `encoding='utf-8-sig'`.

7. **Preserve non-marker code.**

8. **Audit-trail entry.**

9. **Stop.** Direct user to `/campaign verify leads-list`. They will need to run with
   `RUN_TAG=v1` first (pre-launch), and again with `RUN_TAG=v2` near launch (via the
   `05_*` shim).

## Hard rules

- `assert_leads_list_schema()` must pass — never write a leads-list Delta that
  bypasses the schema check.
- Single Delta with PII — do not split PII into a side artefact. Per ADR / AGENTS.md
  rule 4: PII access is UC's job, not the pipeline's.
- v2 differs from v1 only by `RUN_TAG` widget — never duplicate code into the `05_*` file.
- Funnel rendering: in-notebook via `lib/funnel.py`. The Volume copy is canonical
  (ADR 0002); `docs/*funnel.svg|.png` is a snapshot refreshed at launch.
- CSV encoding: `utf-8-sig` for non-ASCII characters.
- Column names: lowercase_with_underscores.
- Integer casts: `CAST(FLOOR/CEIL/ROUND(...) AS INT)` — never leave them as DOUBLE.
