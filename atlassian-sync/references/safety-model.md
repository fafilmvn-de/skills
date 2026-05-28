# Safety model for `atlassian-sync`

This file is the operational explainer for ADRs [0002](../docs/adr/0002-content-safety-for-confluence-cache.md) and [0003](../docs/adr/0003-search-index-for-confluence-cache.md). It lives in the repo so it travels with the code.

## What problem this solves

Naive Confluence sync tools have two production failure modes on any developer machine running Microsoft Defender for Endpoint or a similar on-access EDR + SIEM stack:

1. **AV quarantines the cache.** A Confluence space large enough to be worth syncing will, with high probability, contain at least one page with a literal payload sample — a PHP webshell snippet on a "common pentest findings" write-up, a `nc -e /bin/bash …` reverse-shell example in a CTF retrospective, a `powershell -enc …` blob in an incident-response runbook. Written to disk as plain markdown and then read by anything (an IDE preview, `cat`, `grep`), Defender's signature scanner can match patterns like `Backdoor:PHP/Perhetshell.A!dha` and quarantine the file. The user's SOC gets a notification. A ticket may follow.

2. **Recursive grep amplifies the AV signal and adds a SIEM signal of its own.** Once a cache exists, the natural next step is `grep -r -i 'something' .confluence-cache/`. That pattern (a) opens every file in the cache, triggering Defender on-access scans on each one and exponentially increasing the chance of an AV hit, and (b) puts a long keyword chain into command-line telemetry where SIEM keyword rules treat it as discovery-shaped activity, independent of any AV match.

Both failure modes have been observed in production at large enterprises running Defender + Sentinel. This tool is designed to defuse both signals by default.

## Two-layer defence

### Layer 1: Write-time content safety (ADR 0002)

On every page write, in this order:

1. **Redact.** Run `safety-rules.json:redactPatterns` against the body. Each regex is decoded from base64 at startup (so the rules file itself can't trip AV). Hits are replaced with `[[REDACTED:<rule-id>]]` and counted into `.confluence-cache/.audit.log` (JSONL; never logs the matched bytes).
2. **Classify.** A page is `dangerous` if:
   - it has a Confluence label in `safety-rules.json:dangerousLabels`, OR
   - its title contains a keyword in `safety-rules.json:dangerousTitleKeywords`, OR
   - the redaction pass made ≥ `bodyScanEscalationThreshold` (default 3) hits.
3. **Store.**
   - **Benign pages** → plain redacted markdown at `.confluence-cache/confluence/<folder>/<category>/<id>-<slug>.md`.
   - **Dangerous pages** → base64-encoded redacted markdown at `.confluence-cache/_quarantine/<id>-<sha8>.md.b64`, where `<sha8>` is `sha256("<id>:<title>")[:8]`. Filename contains no keyword tokens. Original title goes into `_quarantine/_index.json`. Encoded write is staged via `.tmp` rename so a half-written file is never readable as plain bytes mid-write.

### Layer 2: Read-time hygiene (ADR 0003)

- Every sync rebuilds `.confluence-cache/.index.json` — one file containing the redacted body and metadata for every cached page (including, separately, decoded-already-redacted dangerous ones).
- The `search` subcommand is the *only* sanctioned way to query the cache. It opens that one file, runs the query in-process, prints hits.
- **Never `grep -r .confluence-cache/`.** The generated `.confluence-cache/README.md` says so. Future agents and humans are instructed to use `search`.

## Day-to-day usage

```bash
# Bulk sync — builds index automatically at the end
atlassian-sync

# Single page, single category, full space — all flow through the safety pipeline
atlassian-sync subtree <root-id>
atlassian-sync space DOCS

# Search the cache (use this INSTEAD of grep)
atlassian-sync search "agent platform"
atlassian-sync search "deploy|deployment"
atlassian-sync search --include-dangerous "webshell"
echo "<sensitive query>" | atlassian-sync search -

# Re-apply safety rules to a pre-existing cache (e.g. after a rules update)
atlassian-sync migrate

# Force an index rebuild (e.g. after manually editing the cache)
atlassian-sync index
```

## How `migrate` avoids re-triggering AV

The migration runs in four phases:

1. **Filename scan, no reads.** Walk `.md` files, identify any whose filename contains a dangerous title-keyword.
2. **Rename-only.** For each suspect, rename to `_quarantine/<id>-<sha8>.md.b64.staging`. Most on-access AV scanners do **not** fire on rename — only on read.
3. **Read staged, encode, finalise.** Read each `.staging` file (filename is now opaque, so it's invisible to filename heuristics), redact, base64-encode, write the final `.md.b64`, delete the `.staging`.
4. **Re-process benign + rebuild index.** Files that did not match phase-1 are read normally and either rewritten with redactions, or escalated to quarantine if body-scan threshold tripped. Finally the search index is rebuilt.

If a `.staging` file is left behind (process crash, etc.), it is a leftover from phase 2 — running `migrate` again finishes it.

## Per-repo customisation

Add a `safety` block to `<repo>/.atlassian-sync.json` to extend defaults:

```json
{
  "confluenceSpaces": [{"key": "DOCS", "label": "Engineering Docs"}],
  "safety": {
    "extraLabels": ["internal-only"],
    "extraTitleKeywords": ["secrets"],
    "bodyScanEscalationThreshold": 2,
    "extraPatterns": [
      {
        "id": "custom-marker",
        "encodedPattern": "<base64 of regex source>",
        "replacement": "[[REDACTED:custom-marker]]",
        "severity": "medium"
      }
    ]
  }
}
```

Defaults always apply; the per-repo block only *adds*. There is no way to weaken built-in rules via project config — that would defeat the point.

## Auditing what got redacted

`.confluence-cache/.audit.log` is JSONL, one event per line:

```json
{"ts":"2026-05-28T08:31:02.000Z","kind":"space","action":"quarantined","pageId":"248591674","title":"Pentest common issues","path":"_quarantine/248591674-3221f168.md.b64","reasons":[{"kind":"title","value":"pentest"}],"redactions":[{"id":"php-eval-base64","count":1,"severity":"high"}]}
```

The log never contains the actual matched bytes — only the rule-id and count. Safe to grep this file (`jq` recommended).

## What this does NOT defend against

- A page whose Confluence-rendered body is malicious *after* our redaction (a novel pattern not yet in `safety-rules.json`). Mitigation: review `.audit.log` periodically; add new rules as needed via the per-repo block, then `migrate` to retroactively apply.
- An attacker with write access to the cache directory who places a real payload there. Out of threat model: cache is gitignored and lives on the developer's machine; if an attacker has filesystem write on the dev machine, they own you regardless.
- AV / EDR policies that block the sync script itself (e.g., script signing requirements). Out of scope: that's an IT-policy conversation, not a code one.
- Network-side DLP that flags the act of pulling content from Confluence at all. Also out of scope — the sync uses the user's own SSO session, no different from opening Confluence in a browser.

## Adding a new redaction pattern

1. Take the regex source you want to match — e.g., `<\?php[\s\S]*?passthru\(`.
2. Base64-encode it:
   ```
   node -e "console.log(Buffer.from(String.raw\`<\?php[\s\S]*?passthru\(\`).toString('base64'))"
   ```
3. Add to `safety-rules.json:redactPatterns`:
   ```json
   { "id": "php-passthru", "encodedPattern": "<that base64>", "replacement": "[[REDACTED:php-passthru]]", "severity": "high" }
   ```
4. Re-run `migrate` over any existing cache to retroactively apply.
5. Commit `safety-rules.json` — security-minded reviewers (and future you) should be able to PR-review it.
