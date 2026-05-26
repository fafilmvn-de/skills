# prompts/stage_data_prep.md

Used by `campaign-orchestrator` for `/campaign stage data-prep`. Authors the
**campaign-specific eligibility additions** in `01_data_preparation_UC.py` of the
current campaign batch.

## Context

The copied template `01_data_preparation_UC.py` already handles the *common* eligibility:
in-force status, age band (`PO_AGE_MIN/MAX`), plan-code filter (via `ELIGIBLE_PLAN_CODES`
widget), corporate-PO exclusion, channel filter. **Do not duplicate that logic.**

Campaign-specific additions usually take one of three forms:

1. **An extra CTE** inserted into `ELIGIBILITY_SQL` just before the final `SELECT`
   (e.g. `cash_balance_filter` for a minimum-balance campaign).
2. **Additional WHERE conditions** appended to the final `WHERE` clause
   (e.g. `AND pol.anniv_year BETWEEN 5 AND 10`).
3. **A new derived column** in the final `SELECT` (e.g. `endowment_maturity_dt`).

## Procedure

1. **Load intake.md.** Read `agency-campaigns/<campaign>/<batch>/docs/intake.md`.
   Extract sections 2 (product eligibility) and 3 (customer eligibility). If any
   `<!-- TODO -->` markers remain, halt and tell the user to run `/campaign init`
   to completion first.

2. **Verify schemas.** For every column referenced in the intake (product_code, anniv_year,
   cash_value, etc.), call `schema-verifier` on the relevant source table. If any
   column comes back `not_found`, halt and tell the user — do not author SQL that
   references fabricated columns. The schema-verifier will suggest closest matches
   (e.g. `vndr_nm` → `vnd_nm`); offer those to the user via `ask_user`.

3. **Identify the insertion points.** Open the campaign's NB01 and locate:
   - The `ELIGIBILITY_SQL` string literal (typically lines ~80–190).
   - The final `WHERE` clause inside it.
   - The final `SELECT` column list.

4. **Wrap the additions in markers.** Insert a sentinel block so future
   `/campaign stage data-prep` re-runs only touch this region:

   ```python
   # region campaign-specific:data-prep — START (managed by campaign-orchestrator)
   # ... new CTE(s), WHERE conditions, derived columns ...
   # endregion campaign-specific:data-prep — END
   ```

   For SQL inside the `ELIGIBILITY_SQL` string, use comment markers:

   ```sql
   /* campaign-specific:data-prep:START */
   ...
   /* campaign-specific:data-prep:END */
   ```

5. **Compose the additions** based on intake.md:
   - **ANNIV range**: append `AND pb.anniv_year BETWEEN <min> AND <max>` to the final WHERE.
   - **Month window**: append `AND pb.anniv_month IN (<comma-list>)`.
   - **Cash-value threshold**: add an `AND c.total_cash_vnd >= <amount>` filter.
   - **Tenure threshold**: append `AND pb.pol_tenure_yr >= <years>`.
   - **Loan rule**: confirm `c.has_loan = 'N'` is present (default behaviour); if intake
     says "allow all", add a sentinel comment noting the override.
   - **Paid-up status**: append the appropriate `pmt_mode` / `paid_up_flag` filter.
   - **Extras columns** (e.g. `endowment_maturity_dt`): add to the final SELECT and to
     `docs/extras_data_dictionary.csv`.

6. **Preserve non-marker code.** Any code OUTSIDE the sentinel block was either copied
   from the template or hand-edited by the user — leave it alone.

7. **Update widget defaults if not already done by init.** ANNIV-range and cash-value
   widgets may need to be added (the base template only ships `PO_AGE_MIN/MAX` +
   `ELIGIBLE_PLAN_CODES`). Add them as `dbutils.widgets.text(...)` lines near the
   existing widget block, also inside a sentinel.

8. **Audit-trail entry.** Append `YYYY-MM-DD | stage:data-prep | <summary>` to
   `agency-campaigns/<campaign>/<batch>/docs/audit-trail.md`.

9. **Stop.** Do not run the notebook yet. Tell the user to invoke
   `/campaign verify data-prep` to push + sync + run.

## Anti-patterns to refuse

- Inventing column names — always go via schema-verifier.
- Rewriting `policy_base`, `ape_by_pol`, `cash`, `po_link`, `po_details`, `po_province`,
  `product` CTEs — these are framework-owned.
- Adding business logic to `generic-campaigns/lib/` — only mechanical helpers belong
  there; per-campaign rules stay in the campaign notebook.
- Using `hive_metastore.*` or `abfss://` paths.
- Skipping the sentinel block — re-runs need to be idempotent.
