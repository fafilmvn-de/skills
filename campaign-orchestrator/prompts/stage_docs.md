# prompts/stage_docs.md

Used by `campaign-orchestrator` for `/campaign stage docs`. Generates the
campaign-level documentation artefacts AFTER the pipeline has produced output.

## Outputs

1. **`docs/audit-trail.md`** — append a final "campaign-shipped" entry summarising
   funnel numbers, output FQNs, and known caveats.
2. **`docs/README.md`** — overview, pipeline diagram (mermaid), known issues, owner.
3. **`docs/DOC.md`** — per-file YAML metadata block for each notebook (lines, source,
   output, dependencies, change-log).
4. **`docs/*_metadata.md`** (optional) — column-level dictionary if extras exceed ~5.
5. **`handovers/<CAMPAIGN_CODE>.html`** — public-facing campaign page in the handovers
   wiki, mirroring the format of `handovers/00_CMP-*.html` and
   `handovers/00_TRK-*.html`.

## Procedure

1. **Load intake.md.** Use it as the source of truth for metadata, eligibility,
   segmentation, hand-offs, output expectations.

2. **Load audit-trail.md** to assemble the per-stage change log (init →
   data-prep → po-aggregation → handoff-mapping → leads-list → engine-inputs).

3. **Pull funnel numbers** from the leads-list run's stdout (the
   `lib/funnel.render_funnel()` call logs counts). If a CSV funnel artefact was saved
   to the Volume, read it. Fail loud if no funnel data is available — the docs are
   useless without it.

4. **Render `docs/README.md`.** Sections in order:
   - Title (campaign name + batch).
   - Owner / processor / launch date / end date.
   - Pipeline diagram (mermaid):
     ```
     graph LR
       NB01[01 data-prep] --> NB02[02 PO agg] --> NB03[03 hand-off] --> NB04[04 leads v1] --> NB05[05 leads v2] --> NB06[06 CE inputs]
     ```
     Drop NB03 from the diagram if hand-off was skipped.
   - Funnel break-down (table from step 3).
   - Output tables (FQNs + Volume paths).
   - Known issues / open items.
   - Cross-references to `generic-campaigns/` framework version used.

5. **Render `docs/DOC.md`** — YAML metadata per notebook, conforming to repo
   convention (`lines`, `source`, `output`, `change-log`). Inherit format from
   `agency-campaigns/<campaign>/<batch>/docs/DOC.md`.

6. **Render `handovers/<CAMPAIGN_CODE>.html`** — use the
   `web-artifacts-builder` or `frontend-design` skill if available. Otherwise inherit
   layout from the most recent `handovers/00_CMP-*.html`. Sections:
   - Campaign metadata (from intake.md section 1).
   - Eligibility summary (sections 2, 3).
   - Exclusions list (section 4).
   - Segmentation tiers (section 6).
   - Funnel break-down (from step 3, with the rendered SVG embedded).
   - Output dictionary (column list with comments — from
     `lib/data_dictionary_base.csv` + `docs/extras_data_dictionary.csv`).
   - Stage-by-stage source-table walkthrough.

7. **Append the final audit-trail entry:**
   `YYYY-MM-DD | stage:docs | docs generated; campaign ready for sFTP upload`.

8. **Stop.** Tell the user the campaign is documented. Remind them that the sFTP
   upload of the four CE input CSVs is owned by the processor named in intake section 7.

## Hard rules

- `docs/README.md` must include the funnel break-down — empty docs are not acceptable.
- `handovers/*.html` must be styled consistent with existing pages — load
  `skills/frontend-design/SKILL.md` if uncertain.
- Never claim a funnel number that isn't from the actual run — read the audit trail.
- Update `docs/INDEX.md` at the repo root to register the new campaign — but ONLY
  add a row, never reformat the file.
- Use `encoding='utf-8-sig'` if any CSV is emitted by this stage.
