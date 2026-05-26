# prompts/stage_po_aggregation.md

Used by `campaign-orchestrator` for `/campaign stage po-aggregation`. Authors the
**campaign-specific PO-level rules** in `02_po_level_aggregation_UC.py`.

## Context

Template NB02 collapses the policy-level eligible set from NB01 to one row per `po_num`,
applies servicing-agent tie-breaking, and computes PO-level aggregates (sum of APE,
max tenure, etc.). The framework-owned logic includes:

- Standard servicing-agent tier resolution (<tier1>, <tier2>, <tier3>).
- Closed-bank channel-code mapping to Agency (per ADR 0002).
- Aggregates: `n_policies`, `total_ape_vnd`, `max_tenure_yr`, `max_cash_vnd`.

Campaign-specific additions usually cover:

1. **Custom tier acceptance** — restricting to a subset of tiers (intake section 5).
2. **retention override** — when a PO has any retention-serviced policy, force the servicing-agent
   choice to retention regardless of tier ranking (intake section 5).
3. **Segmentation tier assignment** (intake section 6) — `CASE WHEN ... END AS lead_segment`.
4. **PO-level filters** beyond the per-policy ones (e.g. PO must have ≥ N eligible policies).

## Procedure

1. **Load intake.md.** Read sections 5 (servicing-agent) and 6 (segmentation). Halt if
   any `<!-- TODO -->` remains.

2. **Verify schemas.** Any column referenced in segmentation criteria (e.g. `ape_vnd`,
   `pol_tenure_yr`, `total_cash_vnd`) — pass through `schema-verifier` against the NB01
   output table FQN (`<campaign>_<batch>_pol_final`). Use the cached schema if NB01 was
   verified recently.

3. **Sentinel-wrap the additions.** Use the same marker convention as `stage_data_prep`:

   ```python
   # region campaign-specific:po-aggregation — START
   # ... custom segmentation CASE expression, retention override join, tier filter ...
   # endregion campaign-specific:po-aggregation — END
   ```

   For SQL inside aggregation strings: `/* campaign-specific:po-aggregation:START */ ... :END */`.

4. **Compose:**
   - **Accepted tiers filter:** add `AND agt.agt_tier IN (<tier list>)` after the
     servicing-agent join. Verify each tier value against `agent_master.agt_tier`
     distinct values via `schema-verifier`.
   - **retention override:** add a CTE that flags POs with any retention-serviced policy, and amend
     the tier-resolution `ROW_NUMBER() OVER (...)` ordering to put retention-serviced first
     when the override flag is set. Per intake, default is **Yes** for retention campaigns.
   - **Segmentation CASE:** add a CASE expression in the final SELECT producing
     `lead_segment STRING`. Each segment criterion must reference real columns
     (schema-verified). Add `lead_segment` to `docs/extras_data_dictionary.csv` if not
     already in `LEADS_LIST_SCHEMA`.
   - **PO-level filters:** append to the final `WHERE` (e.g. PO total cash ≥ threshold,
     PO must hold ≥ 1 eligible policy of family X).

5. **Preserve non-marker code.**

6. **Audit-trail entry.**

7. **Stop.** Direct user to `/campaign verify po-aggregation`.

## Hard rules

- The PO_KEY (`po_num`) is sacred — never aggregate by anything else; never collapse on
  `policy_id` at this stage.
- Channel must remain `{Agency, VTB}` (closed enum).
- `LEADS_LIST_SCHEMA` is enforced at stage 04 — do not drop columns it expects.
- Closed-bank policies serviced by Agency staff → `channel = 'Agency'` (ADR 0002).
