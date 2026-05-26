---
name: deploy-verifier
description: Deploys local notebook edits to Databricks via the git-sync workflow (push -> workspace pull poll -> one-shot job run -> row-count assertion) and verifies the run succeeded. Use when campaign-orchestrator's verify verb runs, or whenever the user asks to "deploy and test on databricks", "sync and run notebook", "push and verify on cluster", "submit job and check output", or "verify <stage> end-to-end". Never uses databricks workspace import (direct upload bypasses git history).
---

# deploy-verifier

Closes the loop between local notebook edits and a Databricks cluster run, strictly
through the git-sync workflow. Never uses direct workspace uploads.

## Inputs

- `<notebook-path>` — repo-relative path to the notebook to run, e.g.
  `agency-campaigns/<campaign>/<batch>/04_leads_list_UC.py`.
- `--cluster <id>` (default `<your-cluster-id>`).
- `--workspace-repo <path>` (default `/Workspace/Users/<your-user>@<your-domain>/<your-repo>`)
  — the workspace path under which the Databricks Git folder is cloned. The notebook to
  run is `<workspace-repo>/<notebook-path without .py/.ipynb suffix>`.
- `--widgets <key=value,key=value>` — widget overrides for the run (e.g. `RUN_TAG=v1`).
- `--assert-min-rows <fqn>:<n>` — optional row-count assertion to run after the job
  completes (e.g. `<write_catalog>.<write_schema>.<campaign>_<batch>_leads_list_v1:1000`).
- `--timeout <seconds>` — max wait for git-pull sync (default 90s) and job run (default 1800s).

## Output

Structured report:

```yaml
git:
  local_head_sha: a1b2c3d...
  pushed: true
  workspace_sha: a1b2c3d...
  synced: true
  sync_wait_s: 12
job:
  run_id: 1234567890
  status: SUCCESS    # SUCCESS | FAILED | TIMEOUT
  duration_s: 217
  output_tail: |
    ...last 50 lines of notebook stdout including funnel break-down...
assertions:
  - fqn: <write_catalog>.<write_schema>.<campaign>_<batch>_leads_list_v1
    expected_min: 1000
    actual: 9242
    passed: true
```

## Procedure

1. **Pre-flight.**
   - Verify `<notebook-path>` exists locally and `git status` shows the file is committed
     (not dirty). If dirty, halt and tell the user to commit first.
   - Verify `git status` is on a branch that's pushable. Tag the current local HEAD SHA.
   - Verify `databricks` CLI is authenticated: `databricks current-user me` must succeed.
     If it returns an auth error, halt and tell the user to run
     `databricks auth login --host <host>` — do NOT attempt to bypass.
   - Discover the Repos ID if not cached: `databricks repos list` → find the entry whose
     `path` starts with `--workspace-repo`. Cache the `id` in `lt-memory/databricks/repos.json`
     for subsequent runs.

2. **Push.** `git push` to GitHub. If the push fails (auth, conflict), halt with the
   error. Do NOT attempt a force-push.

3. **Poll workspace git-folder pull.** The Databricks Repos / Git folder must pull the
   new commit before the run is submitted, otherwise it executes stale code.

   ```powershell
   $sha = git rev-parse HEAD
   # The workspace path under which the repo is cloned:
   $wsRepo = "/Workspace/Users/<your-user>@<your-domain>/<your-repo>"
   $deadline = (Get-Date).AddSeconds(90)
   while ((Get-Date) -lt $deadline) {
     # Trigger a pull (idempotent) — uses the Repos API:
     databricks repos update --branch main <repo_id> | Out-Null
     $current = databricks repos get <repo_id> | ConvertFrom-Json
     if ($current.head_commit_id -eq $sha) { break }
     Start-Sleep -Seconds 3
   }
   if ($current.head_commit_id -ne $sha) { throw "Sync timeout" }
   ```

   The `<repo_id>` should be discovered once via `databricks repos list` and cached.

4. **Submit one-shot job run.** Use the Jobs API to submit a run that points at the
   workspace notebook path:

   ```powershell
   $wsNotebook = "$wsRepo/agency-campaigns/.../04_leads_list_UC"
   databricks jobs submit `
     --json (@{
       run_name = "deploy-verifier: $(Split-Path -Leaf $wsNotebook)"
       tasks = @(@{
         task_key = "main"
         existing_cluster_id = $clusterId
         notebook_task = @{
           notebook_path = $wsNotebook
           base_parameters = $widgets
         }
       })
     } | ConvertTo-Json -Depth 10)
   ```

   Capture the returned `run_id`.

5. **Poll run status.** `databricks jobs get-run <run_id>` until
   `state.life_cycle_state` is `TERMINATED`, `INTERNAL_ERROR`, or `SKIPPED`. Honor
   `--timeout`. If `state.result_state != 'SUCCESS'`, fetch the run output for the failed
   task and include in the report.

6. **Capture output tail.** `databricks jobs get-run-output <run_id> --task-key main`
   — extract the last ~50 lines of stdout. Include in the report.

7. **Run row-count assertions** (if `--assert-min-rows` provided). For each FQN, execute
   `SELECT COUNT(*) FROM <fqn>` via the SQL warehouse (NOT the cluster — cheaper). If
   actual < expected_min, mark `passed: false` and surface prominently.

8. **Return the structured report.** Do NOT auto-rerun on failure — let the caller
   decide whether to debug locally and re-push.

## Dispatch model

Long-running (potentially 5-30 minutes for full leads-list runs). When loaded by
`campaign-orchestrator`, dispatch to a `task` tool agent of type `task` so the polling
doesn't dominate the main context. The agent uses `powershell` for all CLI calls.

For very short runs (e.g. stage `engine-inputs` is fast), the main agent may run inline.

## Tools used

- `powershell` for `git`, `databricks` CLI calls.
- `view` to confirm notebook path exists locally.

## Hard rules

1. **Never** use `databricks workspace import` or any direct file upload. The only
   acceptable deploy path is push-to-git → workspace pull.
2. **Never** force-push. If git rejects the push, halt and surface to the user.
3. **Never** declare success if `state.result_state != 'SUCCESS'`. Failed runs are
   failed runs.
4. **Never** suppress the row-count assertion failure — even if the job succeeded, an
   under-count is a real problem.
5. **Always** poll the workspace HEAD SHA explicitly — do not assume the pull happened
   just because some seconds elapsed.
6. **Always** include the last ~50 lines of stdout in the report so the user has
   debugging context without a second tool call.

## Failure modes to recognise

- **Sync timeout**: workspace pull didn't catch up within `--timeout`. Likely causes:
  Databricks Repos service slow, branch mismatch (workspace on `main`, push on a
  feature branch), or the workspace repo doesn't have `<repo_id>` configured. Surface
  these as the specific diagnosis, not just "timeout".
- **Cluster auto-start delay**: if the cluster is `TERMINATED`, allow extra time
  (3-5 min) before the job actually starts running. Detect this from the run state
  going through `PENDING` → `RUNNING`.
- **Notebook path not found**: the local path doesn't have a workspace equivalent.
  Usually means a `_UC` suffix or path mismatch. Surface the exact path lookup that
  failed.
- **Schema-assert failure inside the notebook**: surface the `assert_leads_list_schema`
  traceback verbatim — it tells the user exactly which column drifted.
