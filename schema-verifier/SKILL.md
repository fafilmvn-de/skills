---
name: schema-verifier
description: Verifies that Unity Catalog tables and columns referenced by SQL exist and have expected types before authoring or running Databricks notebooks. Use proactively before writing any SQL that references a UC table not already verified, or when campaign-orchestrator's stage verb runs. Caches results into lt-memory/schemas/ with a 7-day TTL. Triggers on "verify schema", "describe table", "check column exists", "validate table", or whenever fabricated column names risk appearing in generated SQL.
---

# schema-verifier

Runs `DESCRIBE TABLE` against the live Unity Catalog via the `databricks` CLI and answers:
*does this table exist? does this column exist? what is its type?* Caches results into
`lt-memory/schemas/` to avoid repeated cluster round-trips.

This skill exists because past sessions have repeatedly hallucinated column names
(`vndr_nm` on `agent_master`, `paid_through_dt` on `policies`, fictional divergences between
`policies` in `<source_schema>` vs `<source_schema_snapshot>`). Every campaign
notebook SQL fragment must pass through this verifier before being authored.

## Inputs

The caller passes one or more of:

- `table <fqn>` — check whether the FQN exists; return its column list + types + partition columns.
- `column <fqn>.<column>` — check whether a specific column exists on the FQN; return its type.
- `columns <fqn> <col1>,<col2>,<col3>` — batch column check.
- `--refresh` — force a re-fetch from Databricks even if cached entry is fresh.
- `--cluster <id>` — override the default cluster (`<your-cluster-id>`).

## Outputs

Structured response per input:

```yaml
table: <source_catalog>.<source_schema>.policies
status: ok            # ok | not_found | error
fetched_at: 2026-05-26T16:20:00Z
from_cache: true
columns_total: 47
partitions: [snapshot_date]
columns_checked:      # only present when columns were specified in the query
  - name: policy_id
    status: ok
    type: STRING
  - name: paid_through_dt
    status: not_found
    suggestion: pt_thru_dt    # if a close-by column name exists
  - name: vndr_nm
    status: not_found
    suggestion: vnd_nm
```

If `status: error`, include `error_message` and do NOT proceed — surface to the caller
so they can decide whether to retry, abort, or fall back.

## Procedure

1. **Normalise the FQN.** Strip backticks, lowercase the catalog + schema parts, validate
   it's a 3-part FQN. Reject 2-part (legacy `schema.table`) and `hive_metastore.*` —
   per hard rules, only `<source_catalog>.*` and `<write_catalog>.*` are valid.

2. **Cache lookup.** Read `lt-memory/schemas/<fqn>.json` (filename uses the FQN with `.`
   separators). If exists and `fetched_at` is within 7 days and `--refresh` was not
   passed, return from cache with `from_cache: true`.

3. **Live fetch via `databricks` CLI.** Build the command:

   ```powershell
   databricks api post /api/2.0/sql/statements \
     --json (@{
       statement = "DESCRIBE TABLE EXTENDED $fqn"
       warehouse_id = (databricks warehouses list | Where-Object name -like '*Analytics*' | Select-Object -ExpandProperty id -First 1)
       wait_timeout = "30s"
     } | ConvertTo-Json)
   ```

   **Note:** Prefer the SQL warehouse over a cluster for `DESCRIBE TABLE` — it's much
   cheaper and faster (no Spark JVM startup). Only fall back to an all-purpose cluster
   if no warehouse is available.

   Parse the JSON response. Schema output rows are:
   - `(col_name, data_type, comment)` triplets until a blank row.
   - Then `# Partition Information` header, then partition columns.
   - Then `# Detailed Table Information` with metadata.

4. **Persist to cache.** Write the parsed schema to `lt-memory/schemas/<fqn>.json` in the
   shape documented in `lt-memory/schemas/README.md`. Include `fetched_at` (ISO 8601 UTC).

5. **Answer the query.**
   - For `table <fqn>`: return the parsed structure with `status: ok`.
   - For `column <fqn>.<col>`: look up the column; if missing, run a typo-suggestion pass
     (Levenshtein distance ≤ 2 against the column list) and include `suggestion` if a
     close match exists. Known historical suggestions:
       - `vndr_nm` → `vnd_nm`
       - `paid_through_dt` → `pt_thru_dt`
       - `product_code_base` → `product_code` (on `policies`; only `policy_curated_*` has the `_base` variant)
   - For `columns <fqn> <list>`: batch-check, one row per requested column.

6. **Error handling.**
   - Cluster offline / warehouse unavailable: surface `error_message: warehouse_unavailable`
     and tell the caller to either start the warehouse or fall back to the cached entry
     (with a stale-cache warning).
   - Table does not exist: `status: not_found`. Suggest closest table by name across
     known catalogs. Known patterns:
       - `<legacy_catalog>.<table>` → search `<write_catalog>.<write_schema>_*.<table>`.
       - `<source_schema_external>.<deprecated_table>` → `<source_schema_audit>.<audit_table>`
         (dropped May 2026).
   - Permission denied: `status: error` with `error_message: permission_denied` — caller
     decides whether to retry under a different identity.

## Dispatch model

Heanniv I/O + uses the `databricks` CLI. When loaded by `campaign-orchestrator`, the main
agent should dispatch the verification to a `task` tool agent of type `task` (Haiku, with
powershell access) so the cluster polling doesn't fill the main context.

For single-table quick checks, the main agent can run inline.

## Tools used

- `powershell` for `databricks` CLI calls.
- `view` / `create` / `edit` for `lt-memory/schemas/<fqn>.json` cache files.

## Hard rules

1. Refuse `hive_metastore.*` FQNs — return `status: error`, `error_message: legacy_catalog_rejected`.
2. Refuse 2-part FQNs (`schema.table`) — require explicit catalog. Tell the caller to
   pick `<source_catalog>` (read) or `<write_catalog>` (write).
3. Never invent columns. If `DESCRIBE TABLE` returns 0 rows for a name, the column does
   not exist — return `not_found` even if it sounds plausible.
4. Always include `from_cache` in the response so the caller can opt to `--refresh` if
   they suspect staleness.
5. Cache TTL = 7 days. Older entries are treated as stale (the cache lookup step ignores
   them and proceeds to live fetch).

## Regression test

Feeding `column <source_catalog>.<source_schema_ams>.agent_master.vndr_nm` must return:

```yaml
table: <source_catalog>.<source_schema_ams>.agent_master
status: ok
columns_checked:
  - name: vndr_nm
    status: not_found
    suggestion: vnd_nm
```

If this regression fails, the skill is broken — surface the failure prominently before
proceeding with any SQL authoring.

## Known good FQNs to pre-warm the cache (optional)

For the very first run, the orchestrator may want to pre-warm the cache for these
high-frequency tables. None of these calls is required — they just save time later:

- `<source_catalog>.<source_schema>.policies`
- `<source_catalog>.<source_schema_cdc>.policies`
- `<source_catalog>.<source_schema_cdc>.tcoverages`
- `<source_catalog>.<source_schema_cdc>.tclient_policy_links`
- `<source_catalog>.<source_schema_cdc>.tclient_details`
- `<source_catalog>.<source_schema_ams>.agent_master`
- `<write_catalog>.<write_schema>.agent_curated_mthend`
- `<write_catalog>.<write_schema>.legacy_products`
