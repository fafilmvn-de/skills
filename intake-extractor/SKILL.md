---
name: intake-extractor
description: Reverse-engineers a draft generic-campaigns-style intake.md from an existing reference campaign folder (e.g. agency-campaigns/<campaign>/<batch>). Use when campaign-orchestrator's init verb runs with --reference, or when the user invokes /campaign extract-intake to retroactively backfill an intake for a pre-framework campaign. Scans both .py and .ipynb notebooks, extracts campaign code, plan codes, filters, exclusions, segmentation, output FQNs, and flags cross-campaign exclusion patterns for promotion into lib/exclusions.py.
---

# intake-extractor

Reverse-engineers `generic-campaigns/template/intake.md`-shaped content from an existing
campaign folder. Two callers:

- `campaign-orchestrator` during `init --reference <path>` — produces a draft intake.md
  that pre-fills as many `<!-- TODO -->` placeholders as it can find evidence for.
- `/campaign extract-intake <path>` — direct invocation for retroactively backfilling
  an intake.md against pre-framework campaigns (notably `agency-campaigns/<campaign>/<batch>`).

## Inputs

- `<reference-path>` — absolute or repo-relative path to a campaign batch folder. Must
  contain at least one notebook (`01_*.py` or `01_*.ipynb`). Other discoverable artefacts:
  - `docs/intake.md` or any `*Intake*.md` — highest-priority source if present.
  - `docs/extras_data_dictionary.csv` — column extras.
  - `docs/audit-trail.md` — historical context.
  - `docs/DOC.md` — per-file YAML metadata.

## Output

Writes nothing directly. Returns to the caller a fully-formed `intake.md` string with
`<!-- TODO: ... -->` markers replaced by extracted values, plus a structured report:

```yaml
filled_from_reference:  # TODOs we recovered with high confidence
  - section: 1
    field: campaign_code
    value: <campaign>
    evidence: "01_*.py:34 CAMPAIGN constant"
remaining_todos:        # TODOs we could NOT recover; need human via intake_interview.md
  - section: 1
    field: target_response_rate
    reason: no_evidence_in_notebooks
exclusion_promotion_candidates:  # exclusions in this reference NOT yet in lib/exclusions.py
  - name: excl_shared_phone
    appears_in:
      - agency-campaigns/<campaign>/<batch>
    sql_fragment: |
      AND po.phone_number NOT IN (
        SELECT phone_number FROM ...
        GROUP BY phone_number HAVING COUNT(DISTINCT po_num) > 1
      )
    recommend_promote: true
schema_warnings:        # tables/columns referenced by reference that may be stale
  - table: <source_schema_external>.<deprecated_table>
    note: dropped May 2026 — replaced by <source_schema_audit>.<audit_table>
```

## Procedure

1. **Locate reference artefacts.** Glob the reference path:
   - `**/01_*.py` or `**/01_*.ipynb` — primary data-prep NB.
   - `**/02_*.py` or `**/02_*.ipynb` — PO aggregation NB.
   - `**/03_*.py` or `**/03_*.ipynb` — handoff mapping NB (optional).
   - `**/04_*.py` or `**/04_*.ipynb` — leads-list NB.
   - `**/05_*.py` or `**/05_*.ipynb` — leads-list v2 NB (optional; may be a shim).
   - `**/06_*.py` or `**/06_*.ipynb` — campaign engine inputs NB.
   - `docs/*Intake*.md` and `docs/intake.md`.
   - `docs/extras_data_dictionary.csv`.
   - `docs/audit-trail.md`.

2. **Prefer the existing intake.md.** If `docs/intake.md` or `docs/*Intake*.md` exists and
   has fewer than 20% `<!-- TODO -->` markers remaining, treat it as the primary source.
   Carry over every filled field. The notebook scan then only fills the remaining holes.

3. **Notebook scan — section 1 (metadata).** Look for these patterns (both `.py` and
   `.ipynb` JSON):

   | Field | Patterns to grep |
   |---|---|
   | `campaign_code` | `CAMPAIGN\s*=\s*["']([^"']+)["']`, `dbutils.widgets.text\("CAMPAIGN", "([^"]+)"` |
   | `channel` | `CHANNEL\s*=\s*["']([^"']+)["']`, comment headers mentioning Agency/VTB |
   | `launch_date`, `end_date` | `CAMPAIGN_START_DATE`, `LAUNCH_DATE`, `CAMPAIGN_END_DATE` constants |
   | `snapshot_date` | `SNAPSHOT_DATE\s*=\s*["'](\d{4}-\d{2}-\d{2})["']` (informational only — not carried) |
   | `cmpgn_type` | NB06 `CMPGN_TYPE` widget default |

4. **Notebook scan — section 2 (product eligibility).** In NB01:

   | Field | Patterns |
   |---|---|
   | `eligible_product_codes` | `PLAN_LIST\s*=`, `ELIGIBLE_PLAN_CODES`, hardcoded `product_code IN (...)` lists, `legacy_products` joins filtering by `plan_family`/`product_family` |
   | `anniv_range` | `anniv\s*BETWEEN`, `anniv_year`, ANNIV-band CTEs |
   | `month_window` | `MONTH(pol_eff_dt) IN (...)`, `anniv_month` filters |

5. **Notebook scan — section 3 (customer eligibility).** In NB01:

   | Field | Patterns |
   |---|---|
   | `tenure_threshold` | `tenure_years\s*>=`, `DATEDIFF(.+pol_eff_dt).+/365` thresholds |
   | `po_age_band` | `PO_AGE_MIN`, `PO_AGE_MAX`, `po_age BETWEEN` |
   | `cash_value_threshold` | `cash_value\s*>=`, `aod_balance` thresholds |
   | `loan_rule` | `has_loan = 'N'`, `outstanding_loan = 0` |
   | `paid_up_status` | `paid_up_flag`, `premium_status` filters |

6. **Notebook scan — section 4 (exclusions).** Critical step. In NB01 + NB02:

   For each `excl_` flag referenced, classify:
   - **In `lib/exclusions.py`?** Read `generic-campaigns/lib/exclusions.py`, get the
     defined-exclusion set. Any `excl_*` flag in the reference NOT in this set is a
     *promotion candidate*.
   - **Used in ≥2 campaigns?** Glob `agency-campaigns/**/0*.{py,ipynb}` and count
     campaigns referencing this exclusion. If ≥2, mark `recommend_promote: true`.

   **Known promotion target for v1:** `excl_shared_phone` from
   `agency-campaigns/<campaign>/<batch>`. The extractor must recognise this pattern
   (look for `shared_phone`, `phone_number.*GROUP BY.*HAVING COUNT.*>` constructs) and
   extract the SQL fragment.

7. **Notebook scan — section 5 (servicing-agent rule).** In NB02:

   | Field | Patterns |
   |---|---|
   | `accepted_tiers` | `agt_tier IN (...)`, `<tier1>`, `<tier2>`, `<tier3>`, `<tier4_*>` literals |
   | `retention_override` | Comment / CTE explicitly preferring retention-serviced policies |
   | `closed_bank_handling` | Mapping of closed-bank channel codes to Agency |

8. **Notebook scan — section 6 (segmentation).** In NB02 or NB03:
   Look for CASE expressions producing a segment column (`lead_segment`, `priority_tier`,
   `propensity_band`). Extract the case branches as the segmentation table.

9. **Notebook scan — section 7 (hand-offs).** NB03:
   - If NB03 exists and is non-trivial (>30 lines of real code), there IS a hand-off.
     Extract the joined hand-off table name and the column patterns to infer the team.
   - If NB03 doesn't exist or is just a placeholder, hand-off = `No`.

10. **Notebook scan — section 8 (output expectations).**
    - Output table FQNs: read NB04's `.saveAsTable("...")` and `.write...` calls.
    - Extras columns: read `docs/extras_data_dictionary.csv` if present; otherwise diff
      NB04's final SELECT against `lib/schema.py::LEADS_LIST_SCHEMA` columns.
    - Power BI: grep `docs/` for `.pbix` or "dashboard" mentions.
    - Funnel: always Yes (framework default).

11. **Schema warnings.** Cross-check every table FQN in the reference's notebooks against
    `lt-memory/catalog-mapping.md` and `lt-memory/pitfalls.md`. Flag any:
    - Tables that have been deprecated (e.g. `<source_schema_external>.<deprecated_table>`).
    - `/mnt/...` or `abfss://` paths (must be migrated to Volumes).
    - `hive_metastore.*` references (must be migrated to Unity Catalog).

12. **Compose the draft intake.md.** Start from `generic-campaigns/template/intake.md`.
    For every field with a high-confidence extracted value, replace `<!-- TODO: ... -->`
    with the value followed by `<!-- inferred from: <source> -->` (so the user sees
    provenance).

13. **Return the report.** Hand back to the caller (campaign-orchestrator or the user):
    - The composed intake.md (as a string or by writing to a designated path).
    - The structured report: `filled_from_reference`, `remaining_todos`,
      `exclusion_promotion_candidates`, `schema_warnings`.

## Dispatch model

This skill is heavily file-I/O. When loaded by `campaign-orchestrator`, the main agent
should dispatch the actual scan to a `task` tool agent of type `explore` (Haiku model,
fast and read-only), passing this SKILL.md content as the prompt plus the reference path.
This keeps the main context clean.

When invoked directly via `/campaign extract-intake <path>`, the main agent may run it
inline if the reference is small (<10 files), else spawn an `explore` agent.

## Tools used

- `view`, `grep`, `glob` for reading reference artefacts.
- `view` against `generic-campaigns/lib/exclusions.py` for the defined-exclusion set.
- `view` against `lt-memory/catalog-mapping.md` and `lt-memory/pitfalls.md` for schema warnings.
- No writes — pure read + report.

## Hard rules

1. Never modify the reference campaign — read-only.
2. Never invent values. If evidence is weak (single occurrence, ambiguous), surface as a
   `remaining_todos` entry rather than guessing.
3. Always carry `<!-- inferred from: ... -->` provenance so the user can audit.
4. Promotion of exclusions into `lib/exclusions.py` is **a recommendation only** — the
   actual edit happens via campaign-orchestrator after user confirmation.

## Known historical patterns to recognise

- `agency-campaigns/<campaign>/<batch>/`: has `excl_shared_phone` (uses
  `phone_number GROUP BY HAVING COUNT(DISTINCT po_num) > 1` construct), `anniv_month` as INT
  (not string), `<plan-code>` not applicable.
- `agency-campaigns/<campaign>/<batch>/`: similar to batch-1 but missing
  `excl_shared_phone`; introduces `import-list` exclusion (Stage 04 → handoff → Stage 05);
  `cmpgn_st_dt` column added.
- `agency-campaigns/potential-surrender/batch-3/`: cleanest 3-stage example (no NB04/05
  v1/v2 split — single-pass).
- `agency-campaigns/potential-surrender/batch-4/`: v1/v2 refresh pattern.

If the reference is one of these, prefer the documented characterisation over fresh notebook scanning.
