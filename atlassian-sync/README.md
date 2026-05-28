# atlassian-sync

> Pull Confluence pages from any Atlassian Cloud tenant into a local cache or a single shareable HTML/MD file — using your own browser's SSO session, no API token, no IT ticket.
>
> 📐 **[Open the architecture diagram →](./ARCHITECTURE.html)** for a one-glance picture of how it works.

This is the human landing page. If you're an AI agent or want the full CLI reference, read [`SKILL.md`](./SKILL.md) instead.

---

## Why this exists

Three things make this tool worth its own repo:

1. **API tokens aren't always an option.** Atlassian Cloud's official integration path is a personal API token from `id.atlassian.com/manage-profile/security/api-tokens`. In many enterprise tenants — especially ones with SSO mandates — that page is disabled, requires an IT request, or gives you a token your tenant won't actually accept. Meanwhile you already have a perfectly valid Confluence session in your browser every day. This tool uses that. API tokens are still supported as a fallback if you do have one.

2. **Naive sync tools get quarantined by EDR.** Any Confluence space large enough to be worth syncing will, with high probability, contain at least one page with a literal payload sample — a PHP webshell snippet on a pentest write-up, a reverse-shell one-liner in an OWASP cheatsheet, a `powershell -enc` blob in an incident-response runbook. Writing those pages to disk as plain markdown is fine *until* anything reads them: Microsoft Defender for Endpoint (and similar on-access EDR scanners) will pattern-match the file content and quarantine it. SOC will get a notification. You may get a ticket.

   The companion failure: anyone with a synced cache will eventually run `grep -r -i 'something' .confluence-cache/`. That recursive open-and-read pattern fans the AV scan out to every file in the cache, and the keyword chain in `argv` lands in command-line telemetry that SOC keyword rules treat as discovery activity. So one careless grep can simultaneously trip AV *and* SIEM.

3. **We still need the content.** Confluence is where the institutional knowledge lives. Pretending it doesn't isn't useful.

So this tool is **safe by default**. The write path redacts known AV-bait patterns and quarantines obviously-dangerous pages (base64-encoded with content-neutral filenames). The read path goes through a `search` subcommand that opens one index file instead of fanning out a recursive grep. See [`ARCHITECTURE.html`](./ARCHITECTURE.html) panel 2 and ADRs [0002](./docs/adr/0002-content-safety-for-confluence-cache.md) + [0003](./docs/adr/0003-search-index-for-confluence-cache.md) for the full story.

---

## Try it in 60 seconds

```bash
# Install
npm install -g .   # from this folder, or: npm link

# 1. One-time: configure your tenant URL + grab your SSO cookies (interactive)
atlassian-sync setup

# 2. Pull any Confluence page you can read in the browser
atlassian-sync page \
  https://your-org.atlassian.net/wiki/spaces/DOCS/pages/123456/Some+Page

# → writes docs/some-page.html, redacted, opens in any browser
```

That's it. Re-run `setup --renew` when your cookie expires (typically every few days to weeks, depending on your tenant's policy).

---

## What you get

- **Single-page export** — Confluence URL → `docs/<slug>.html` (default) or `docs/<slug>.md`. Useful for sharing one page with someone outside the wiki, or feeding it to an LLM agent.
- **Checklist template** — `--template checklist` turns procedural docs into an interactive HTML page with checkboxes and a progress bar. Great for runbooks and onboarding flows.
- **Bulk knowledge-base sync** — point a `.atlassian-sync.json` at spaces / root pages / Jira projects and crawl them into `.confluence-cache/` (gitignored, per-user, per-machine). Builds a search index automatically.
- **`search` subcommand** — query the cache from the terminal without ever running `grep -r` over it. Reads from stdin too, so codenames stay out of your shell history and process telemetry.
- **`migrate`** — re-apply current safety rules to a pre-existing cache when you update the rules file.

---

## The safety story, short version

Every page that gets written to disk goes through this pipeline:

1. **Redact.** Regex rules (stored base64-encoded so the rules file itself doesn't trip AV) replace known dangerous patterns with `[[REDACTED:<rule-id>]]`. Hits are counted into `.confluence-cache/.audit.log` (rule-id + count only — never the matched bytes).
2. **Classify.** A page is *dangerous* if it has a security-themed Confluence label, a security-themed title keyword, or its body had ≥3 redact hits.
3. **Store.** Benign → plain redacted `.md`. Dangerous → base64-encoded body at `_quarantine/<id>-<sha8>.md.b64` with a content-neutral filename. AV filename heuristics and on-access content scans both stay quiet.
4. **Read via `search`.** One file open, no recursive fan-out, no keyword chain in argv.

Detail: [`references/safety-model.md`](./references/safety-model.md) and [`ARCHITECTURE.html`](./ARCHITECTURE.html) panel 2.

---

## When NOT to use this skill

- **Posting or editing Confluence content** — this is read-only. Use the Confluence UI or a real API token with a real Atlassian SDK.
- **Confluence admin tasks** — permissions, space settings, user management. Not in scope.
- **Anything that needs an auditable service identity** — cookie auth is *your* identity. If you need a bot account with its own audit trail, get a real API token.
- **Sharing the cache** — `.confluence-cache/` is per-user, per-machine. Don't commit it, don't zip-and-send it. Each teammate runs their own sync. (See ADR [0001](./docs/adr/0001-confluence-auth-via-session-cookie.md) for the cookie-as-personal-data tradeoff.)

---

## ⚠️ The one rule

**Never `grep -r .confluence-cache/`** (or `Select-String -Path .confluence-cache\*`, or `rg --no-ignore .confluence-cache/`, or any other recursive content scan). Use `atlassian-sync search` instead. The cache is designed to be safe to *store* but recursive grep defeats the read-time half of that. The auto-generated `.confluence-cache/README.md` reminds future readers (and future agents) of this.

---

## Further reading

- [`SKILL.md`](./SKILL.md) — full CLI reference, agent contract, file map
- [`ARCHITECTURE.html`](./ARCHITECTURE.html) — three-panel visual: data flow, safety pipeline, CLI map
- [`references/safety-model.md`](./references/safety-model.md) — operational explainer for the redact-and-quarantine pipeline
- [`references/cookie-acquisition.md`](./references/cookie-acquisition.md) — DevTools steps for the `setup` flow
- [ADR 0001](./docs/adr/0001-confluence-auth-via-session-cookie.md) — why session cookies, not API tokens
- [ADR 0002](./docs/adr/0002-content-safety-for-confluence-cache.md) — write-time redact-and-quarantine
- [ADR 0003](./docs/adr/0003-search-index-for-confluence-cache.md) — why agents must `search`, not `grep -r`

---

## License

[MIT](./LICENSE).

## Contributing

Issues and PRs welcome. Two areas where outside contributions are especially useful:

- **`safety-rules.json` additions** — if you find a payload pattern that lands in real-world Confluence pages and is missed by current rules, PR a new base64-encoded regex with an explanation of where it came from. See the bottom of `references/safety-model.md` for the encoding recipe.
- **Tenant-specific quirks** — Atlassian's various REST API quirks across tenant configurations are an endless source of small bugs. If your tenant returns an unexpected shape, open an issue with a redacted sample response.
