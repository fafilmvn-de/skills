# prompts/intake_interview.md

Used by `campaign-orchestrator` during the `init` verb's diff-interview phase to fill the
remaining `<!-- TODO -->` placeholders in a campaign's `docs/intake.md`.

## How to use this prompt

After the bootstrap copy + (optional) intake-extractor pass, open
`agency-campaigns/<campaign>/<batch>/docs/intake.md` and identify every remaining
`<!-- TODO -->` placeholder. For each one, walk the user through the corresponding
question below. **One question at a time** via the `ask_user` tool. After each answer,
write the user's value back into intake.md in place of the placeholder, then move to the
next.

If a reference was provided (`--reference <path>`), the extractor will already have
pre-filled most TODOs. In that case, present the inherited value as the **first
multiple-choice option labelled `(from reference)`** and ask whether to keep, modify, or
clear it. Don't re-ask if the user said the campaign is a near-clone.

Skip any section the user has explicitly opted out of (e.g. stage 03 hand-off = No → skip
section 7's follow-up TODOs).

## Question bank — keyed by intake.md section

### Section 1 — Campaign metadata

| TODO | Question | Default / Note |
|---|---|---|
| Campaign name | "Full human-readable campaign name?" | e.g. *<Campaign Name> 2026-09* |
| Campaign code | "Lower-snake-case campaign code (used as table + folder prefix)?" | Derive from name; suggest auto-slug |
| Channel | "Channel — Agency or VTB?" | Closed enum. If user says anything else, halt with ADR-required message |
| CMPGN_TYPE | "Campaign Engine CMPGN_TYPE enum?" | Choices: PRD / nurturing / MAT / C2S — confirm against `generic-campaigns/docs/CAMPAIGN_ENGINE_CONTRACT.md` |
| Launch date | "Campaign launch date (YYYY-MM-DD)?" | If reference exists, suggest reference launch + 1 batch interval |
| End date | "Campaign end date (YYYY-MM-DD)?" | Default: launch + offer_period_months |
| Communication cycle (months) | "Communication cycle length in months?" | Reference default; typical 3 |
| Offer period (months) | "Offer period in months?" | Reference default; typical 3 |
| Target response rate | "Target response rate (decimal)?" | Reference default; typical 0.05 |
| Processor | "Campaign processor (person or team)?" | Free text |

### Section 2 — Product eligibility

| TODO | Question | Default / Note |
|---|---|---|
| Eligible plan codes | "List the eligible `product_code` values (comma-separated)" | Validate each via `schema-verifier` against `<write_schema>.legacy_products`. Flag unknowns. |
| nurturing range | "ANNIV (anniversary-year) range — e.g. 5–10, or 'none' if no nurturing filter?" | Reference default |
| Month window | "Restrict to policies with ANNIV-month in specific months? (e.g. Apr, May, or 'none')" | Reference default |

### Section 3 — Customer eligibility

| TODO | Question | Default / Note |
|---|---|---|
| Tenure threshold (years) | "Minimum customer tenure in years (or 'none')?" | Typical: ≥ 2 |
| PO age band | "PO age range — min and max?" | Typical: 25–60 or 18–70 |
| Cash-value / balance threshold | "Minimum cash-value or balance threshold in VND (or 'none')?" | Reference default |
| Loan rule | "Loan exclusion rule — exclude outstanding loans, allow all, or other?" | Typical: exclude outstanding loan |
| Paid-up status | "Premium status — premium-paying only, paid-up only, or both?" | Typical: premium-paying only |

### Section 4 — Exclusions

The five framework-default exclusions are pre-listed in the template — confirm the user
wants all of them (default: yes):

- `excl_complaint_l6m`
- `excl_csc_transfer_l6m`
- `excl_outstanding_loan`
- `excl_no_contactability`
- `excl_mkt_consent`

Then ask:

| TODO | Question | Default / Note |
|---|---|---|
| Campaign-specific exclusions | "Any campaign-specific exclusions beyond the five defaults? (or 'none')" | If reference has additional exclusions and they appear in ≥2 historical campaigns, prompt the user to **promote them into `generic-campaigns/lib/exclusions.py`** before continuing (e.g. `excl_shared_phone` from batch-1). Promotion path: edit `lib/exclusions.py`, add SQL fragment, bump audit-trail. |

### Section 5 — Servicing-agent rule

| TODO | Question | Default / Note |
|---|---|---|
| Accepted tiers | "Which servicing-agent tiers are accepted? (e.g. <tier1>, <tier2>, <tier3>)" | Reference default. Verify each tier exists in `agent_master` schema via `schema-verifier`. |
| retention override | "Should retention-serviced policies always win the servicing-agent tie-break? Yes/No" | Typical: Yes for retention-themed campaigns |
| Closed-bank handling | "Closed-bank channel codes — treat as Agency? Yes/No" | Closed-enum rule: must be Yes (per ADR 0002) |

### Section 6 — Segmentation tiers

Free-form table — present the reference's segmentation as a default and ask whether to
keep / modify. Validate that segment criteria reference real columns via `schema-verifier`.

### Section 7 — Hand-offs

| TODO | Question | Default / Note |
|---|---|---|
| Stage 03 external hand-off | "Is there a Stage 03 external hand-off (e.g. to retention, VTB team, or Branch)? If yes — team name + expected turnaround. If no — Stage 03 will be skipped." | If No, mark NB03 as inert and skip it during `/campaign stage handoff-mapping` |
| Stage 06 sFTP upload owner | "Who owns the sFTP upload of the four Campaign Engine CSVs (ENGINE_MEMBER / ENGINE_PROMO / ENGINE_OFFER / ENGINE_TARGET)?" | Free text — name or team |

### Section 8 — Output expectations

| TODO | Question | Default / Note |
|---|---|---|
| Campaign-specific columns | "Any extra columns beyond `LEADS_LIST_SCHEMA`? Each will be added to `docs/extras_data_dictionary.csv`." | Reference's `extras_data_dictionary.csv` is the natural source of defaults |
| Power BI dashboard required? | "Is a Power BI dashboard a deliverable? Yes/No" | Typical: Yes for new campaigns |
| Funnel artefact required? | (Pre-filled: Yes, framework default — do not ask.) | Framework requirement |

## After all TODOs are filled

1. Compute the SNAPSHOT_DATE the campaign will use (typically Launch date − N days, where
   N is a per-campaign offset).
2. Set widget defaults in NB01–NB05 to match the answers:
   - `CAMPAIGN` ← Campaign code (section 1)
   - `CHANNEL` ← Channel (section 1)
   - `SNAPSHOT_DATE` ← computed
   - `ELIGIBLE_PLAN_CODES` ← comma-joined list (section 2)
   - `PO_AGE_MIN` / `PO_AGE_MAX` ← from PO age band (section 3)
   - `RUN_TAG` ← `v1` (default; user re-runs with `v2` near launch)
   - `RUN_DATE` ← today's date as YYYYMMDD
3. For NB06, set its widget defaults per `generic-campaigns/docs/PER_CAMPAIGN_INPUTS.md`.

4. Save intake.md with all `<!-- TODO -->` markers replaced. Append a row to
   `docs/audit-trail.md`: `YYYY-MM-DD | intake-filled | <reference or 'cold start'>`.

5. Surface to the user: how many TODOs were filled from reference vs interview, any
   schema-verifier warnings, and any pending exclusion promotions.

6. Do NOT auto-proceed to `/campaign stage data-prep`. Tell the user that is the next
   manual step.
