# prompts/stage_handoff_mapping.md

Used by `campaign-orchestrator` for `/campaign stage handoff-mapping`. Authors
the **campaign-specific hand-off rules** in `03_handoff_mapping_UC.py`.

## When to skip this stage entirely

Read intake.md section 7. If "Stage 03 external hand-off?" is `No`, this stage is
**skipped**. Mark `03_handoff_mapping_UC.py` with a top-level comment:

```python
# region campaign-specific:handoff-mapping — START
# Stage 03 skipped — intake.md section 7 = No external hand-off.
# This file is a no-op pass-through: <campaign>_<batch>_po_final → <campaign>_<batch>_po_postoff.
# endregion campaign-specific:handoff-mapping — END
```

And generate a trivial pass-through cell that just renames the table. Then audit-trail
and stop.

## Procedure (when hand-off IS required)

1. **Load intake.md** section 7. Identify:
   - Hand-off team / system (e.g. retention ops, VTB branch, external Marketing partner).
   - Expected turnaround (informational; doesn't drive code).
   - Owner contact (for the audit trail).

2. **Identify the hand-off file.** Hand-off lists usually arrive as CSV uploaded to a
   Volume path like `/Volumes/<write_catalog>/<write_schema>/handoff_inbox/`.
   Ask the user (via `ask_user`) for the exact Volume path if not already configured.
   Verify the path exists via `databricks fs ls`.

3. **Verify schemas.** The hand-off CSV's expected columns (`po_num`, `policy_id`,
   `handoff_decision`, `handoff_reason`) must be confirmed. If the format is
   non-standard, ask the user to map columns explicitly.

4. **Sentinel-wrap the additions.**

5. **Compose:**
   - Read the hand-off CSV via `spark.read.csv(..., header=True)` with explicit schema
     (do NOT rely on inference for VND-amount or date columns).
   - Anti-join NB02's PO-level output with the hand-off list on `po_num`:
     `po_final.join(handoff, on='po_num', how='left_anti')` — drops POs hand-off
     explicitly excluded.
   - For POs in the hand-off with a decision (e.g. `KEEP`, `DROP`, `DEFER`), apply the
     decision column to the PO record.
   - Write `<campaign>_<batch>_po_postoff` to the campaign's UC database.

6. **Preserve non-marker code.**

7. **Audit-trail entry** — include the hand-off file path + the user-supplied turnaround.

8. **Stop.** Direct user to `/campaign verify handoff-mapping`.

## Hard rules

- Hand-off CSVs MAY contain PII (phone, email). Read into the Delta — do not split.
- Anti-join semantics: NB02 PO is dropped from the leads list only if the hand-off
  decision is `DROP`. Default behaviour for un-listed POs = KEEP.
- Always log the hand-off file's row count and the post-hand-off PO count to the audit
  trail for funnel reconciliation.
- If the hand-off CSV is missing required columns, halt — do not improvise.
