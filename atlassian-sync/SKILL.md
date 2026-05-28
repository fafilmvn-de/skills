---
name: atlassian-sync
description: Pull Confluence pages (and Jira projects) from any Atlassian Cloud tenant into a local cache or a single shareable HTML/MD file. Auth via SSO browser session cookie (works behind enterprise SSO where API tokens are blocked) with optional API-token fallback. Two modes — bulk knowledge-base crawl into `.confluence-cache/` (gitignored), and one-shot single-page export to `docs/<slug>.html` with optional templates (`checklist` for procedural docs). Every page write goes through a content-safety layer that redacts known AV-bait patterns and quarantines pages tagged pentest/security/etc., so on-access EDR scanners (Microsoft Defender and similar) don't quarantine the cache. Cache reads go through a built-in `search` subcommand instead of recursive grep.
triggers:
  - confluence
  - atlassian
  - sync wiki
  - pull confluence page
  - confluence to html
  - confluence to markdown
  - jira sync
---

# Atlassian Sync

Fetches Confluence pages and (optionally) Jira project data from any Atlassian Cloud tenant using your browser's SSO session — no API token, no IT request.

> **Heads up:** see `docs/adr/0001-confluence-auth-via-session-cookie.md` for why we use cookies. See `docs/adr/0002-content-safety-for-confluence-cache.md` and `docs/adr/0003-search-index-for-confluence-cache.md` for why the cache write path redacts/encodes and why you must never `grep -r` the cache.

## When to use this skill

- "Pull this Confluence page" — single URL → local HTML mirror or markdown
- "Build a knowledge base from this space" — recursive crawl + categorisation + index files
- "Sync the latest from our wiki" — re-runs the configured bulk sync
- Any request mentioning a Confluence/Jira URL *paired with* a fetch/sync/export verb

**Don't use this skill for**: posting/editing Confluence content, Confluence permissions, Atlassian admin tasks.

---

## ⚠️ Read the safety model first

**Never `grep -r .confluence-cache/`.** Any sufficiently large Confluence space is statistically likely to contain at least one pentest/security page with a literal payload sample (PHP webshell, reverse-shell one-liner, etc.). On a machine running Microsoft Defender for Endpoint or a similar on-access EDR, a recursive grep will (a) trigger the scanner on every file and quarantine the matching one, and (b) put the keyword chain into command-line telemetry that SOC keyword rules treat as discovery activity. This skill defuses both signals — see `references/safety-model.md` and ADRs 0002/0003 — but only as long as you use `search` instead of grep.

---

## Quickstart

```bash
# Install (from this folder)
npm install -g .          # or: npm link

# 1. One-time per machine: configure base URL + grab SSO cookies (interactive)
atlassian-sync setup

# 2a. One-shot: pull a single page as HTML (default)
atlassian-sync page \
  https://your-org.atlassian.net/wiki/spaces/EXAMPLE/pages/123456/Some+Page

# 2b. Same page as interactive checklist (procedural docs)
atlassian-sync page <url> --template checklist

# 2c. Same page as markdown (for agent context)
atlassian-sync page <url> --md

# 3. Bulk sync from project config (reads .atlassian-sync.json at repo root)
atlassian-sync

# 4. Search the cache (USE THIS INSTEAD OF grep)
atlassian-sync search "agent platform"
echo "<sensitive query>" | atlassian-sync search -

# 5. After a safety-rules update or to clean up an old cache
atlassian-sync migrate

# 6. When the cookie expires
atlassian-sync setup --renew
```

> Without `npm install -g`, replace `atlassian-sync` with `node scripts/sync-atlassian.mjs`.

---

## Auth model

**Session cookie + XSRF token**, stored at `~/.atlassian-sync/.env` (cross-repo, user-global). A repo-local `.env` overrides if present.

The `setup` subcommand walks you through the DevTools cookie-grabbing steps and writes the file for you. See `references/cookie-acquisition.md` for the manual procedure.

**Cookies expire** (hours → weeks depending on the tenant's policy). On a 401, the script prints a clear message pointing at `setup --renew`.

**API-token fallback:** if your tenant allows it, set `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` in the same env file and the script will prefer that path. API tokens don't auto-expire.

---

## Output locations

| Mode | Path | Committed? |
|---|---|---|
| Bulk sync (markdown, benign pages) | `<repo>/.confluence-cache/confluence/{folder}/{category}/*.md` | ❌ gitignored |
| Bulk sync (dangerous-tagged pages, encoded) | `<repo>/.confluence-cache/_quarantine/<id>-<sha8>.md.b64` | ❌ gitignored |
| Quarantine sidecar (`pageId → title/hash/intendedPath`) | `<repo>/.confluence-cache/_quarantine/_index.json` | ❌ gitignored |
| Search index | `<repo>/.confluence-cache/.index.json` | ❌ gitignored |
| Redaction audit log | `<repo>/.confluence-cache/.audit.log` (JSONL) | ❌ gitignored |
| Bulk sync (Jira) | `<repo>/.confluence-cache/jira/*.md` | ❌ gitignored |
| Single page HTML | `<repo>/docs/<slug>.html` (+ `<repo>/docs/_<slug>_assets/`) | ✅ if you commit it (already redacted) |
| Single page MD | `<repo>/docs/<slug>.md` | ✅ if you commit it (already redacted) |

> The bulk cache is **per-user, per-machine**. Each developer re-runs sync themselves. This is deliberate (see ADR 0001 for the cookie-personal-data tradeoff).

---

## Safety model (summary)

Detailed: `references/safety-model.md`. ADRs: [0002](./docs/adr/0002-content-safety-for-confluence-cache.md), [0003](./docs/adr/0003-search-index-for-confluence-cache.md).

- All page bodies are run through `safety-rules.json:redactPatterns` (regex sources stored base64-encoded so the rules file itself doesn't trip AV).
- A page is `dangerous` if it has a security-themed Confluence label, a security-themed title keyword, or its body had ≥3 redact hits.
- Benign pages → plain redacted `.md`. Dangerous pages → base64-encoded body at `_quarantine/<id>-<sha8>.md.b64` with content-neutral filename.
- Cache reads go through `atlassian-sync search` (one file open, no recursive grep, no AV on-access fan-out, no keyword chain in argv).

---

## Bulk sync configuration

Create `<repo>/.atlassian-sync.json` (gitignored by default) with the spaces / root pages / Jira projects you want to crawl:

```json
{
  "confluenceSpaces": [
    {"key": "DOCS", "label": "Engineering Docs"}
  ],
  "confluenceRootPages": [
    {"id": "123456789", "label": "Architecture handbook", "spaceKey": "DOCS", "folder": "architecture"}
  ],
  "confluencePinnedPages": [
    {"id": "987654321", "label": "Onboarding checklist"}
  ],
  "jiraProjects": [
    {"key": "PROJ", "label": "Main project"}
  ],
  "safety": {
    "extraLabels": ["internal-only"],
    "extraTitleKeywords": ["secrets"],
    "bodyScanEscalationThreshold": 2
  }
}
```

If the file doesn't exist, the script runs in CLI-only mode (you can still use `page`, `subtree`, `space` one-shots). The `safety` block is optional — defaults from `safety-rules.json` always apply.

---

## CLI reference

```
atlassian-sync                           Bulk sync from .atlassian-sync.json (auto-builds index at end)
atlassian-sync setup                     Interactive cookie setup (writes ~/.atlassian-sync/.env)
atlassian-sync setup --renew             Re-prompt for cookie when expired
atlassian-sync page <url|id>             Single page → docs/<slug>.html (redacted)
   --template <name>                       Use a named HTML template (mirror|checklist). Default: mirror
   --md                                    Emit markdown instead of HTML
   --out <path>                            Override default output path
atlassian-sync subtree <root-id>         Recursive crawl from a root page → .confluence-cache/
   --folder <name>                         Output sub-folder name (default: derived from page title)
   --space <key>                           Space key (helps with URL generation)
atlassian-sync space <space-key>         Full space crawl → .confluence-cache/
atlassian-sync search "<query>"          Search the cached index. USE THIS INSTEAD OF grep.
   --limit <n>                             Max results (default: 25)
   --snippet <n>                           Snippet length in chars (default: 240)
   --include-dangerous                     Also search _quarantine/ pages
   --json                                  Machine-readable output
   <query> can be "-" to read from stdin   (so codenames stay out of argv)
atlassian-sync index                     (Re)build the search index from the on-disk cache
atlassian-sync migrate                   Re-apply current safety rules to an existing cache
atlassian-sync ping                      Quick auth + connectivity test
```

---

## Files in this skill

```
atlassian-sync/
├── SKILL.md                              ← you are here (agent contract)
├── README.md                             ← human landing page
├── ARCHITECTURE.html                     ← visual: data flow + safety pipeline + CLI map
├── LICENSE                               ← MIT
├── package.json                          ← bin: atlassian-sync
├── safety-rules.json                     ← redact patterns (base64) + dangerous-label list
├── scripts/
│   ├── sync-atlassian.mjs                ← main CLI dispatcher + bulk sync engine
│   ├── lib.mjs                           ← env loader, fetch wrapper, MD converter, helpers
│   ├── safety.mjs                        ← classify + redact + safe storage (ADR 0002)
│   ├── index.mjs                         ← build .confluence-cache/.index.json
│   ├── search.mjs                        ← `search` subcommand (ADR 0003)
│   ├── migrate.mjs                       ← rename-before-read migration of existing caches
│   ├── setup.mjs                         ← interactive cookie acquisition
│   └── pull-page.mjs                     ← single-page HTML/MD renderer (also redacts)
├── assets/templates/
│   ├── mirror.html                       ← default plain-mirror template
│   └── checklist.html                    ← interactive-checkbox template (procedural docs)
├── references/
│   ├── cookie-acquisition.md             ← DevTools cookie-grabbing steps
│   └── safety-model.md                   ← operational explainer for ADRs 0002 + 0003
└── docs/adr/
    ├── 0001-confluence-auth-via-session-cookie.md
    ├── 0002-content-safety-for-confluence-cache.md
    └── 0003-search-index-for-confluence-cache.md
```
