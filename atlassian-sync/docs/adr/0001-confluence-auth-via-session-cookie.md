# Confluence sync authenticates via SSO browser session cookie, not API token

**Context:** Many enterprise Atlassian Cloud tenants are gated by SSO and have personal API tokens (`id.atlassian.com/manage-profile/security/api-tokens`) either disabled outright or pinned behind an IT-ticket workflow. Even where tokens are available, the official admin/MCP route adds latency and approval friction we don't want to repeat per repo. Meanwhile, every user already has a valid Confluence session in their browser whenever they're working.

**Decision:** `atlassian-sync` authenticates by reading the user's already-authenticated browser session cookie (`cloud.session.token` + `atlassian.xsrf.token`) from `~/.atlassian-sync/.env`. API token auth is supported as a transparent fallback if both `ATLASSIAN_EMAIL` and `ATLASSIAN_API_TOKEN` are set, but is **not the primary path**.

**Why this is non-obvious:** Every other Atlassian integration tutorial, and most LLM coding assistants, will default to API tokens. A future reader looking at this code will assume the cookie path is a hack or workaround — it isn't; it's the deliberate choice for SSO-gated environments.

**Trade-offs we accepted:**
- **+** Works today with zero IT involvement; same path your browser already uses.
- **+** No leak risk via long-lived tokens — cookies expire automatically (typically days to weeks).
- **−** Cookies expire, so users must re-run `setup --renew` periodically. The script detects 401 / redirect-to-login and prints a clear remediation message instead of stack-tracing.
- **−** Cookies are personal — output is gitignored (`.confluence-cache/`) so synced content can't leak via the repo. This is enforced by the tool's design, not just convention.

**Reversal cost:** Low-medium. If a user's tenant enables API tokens broadly, they can simply set the two env vars and the existing dual-mode auth code picks them up — no skill changes needed.
