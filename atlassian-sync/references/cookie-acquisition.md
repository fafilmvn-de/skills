# Cookie acquisition — manual procedure

If you can't run `setup` (no Node, locked-down machine, etc.) or you want to understand what the interactive setup is doing, here's the manual version.

## What you need

Two values from your authenticated browser session at your Atlassian Cloud tenant (`https://your-org.atlassian.net`):

1. **`cloud.session.token`** — the SSO session bearer cookie (or `tenant.session.token` on some tenants)
2. **`atlassian.xsrf.token`** — XSRF protection cookie required by some Jira endpoints

## Steps (Chrome / Edge)

1. Open `https://your-org.atlassian.net/wiki/` and make sure you're logged in (via SSO or otherwise).
2. Press **F12** to open DevTools.
3. Go to the **Application** tab → **Storage** → **Cookies** → click `https://your-org.atlassian.net`.
4. Find these two rows and copy the **Value** column:
   - `cloud.session.token` (long alphanumeric string, hundreds of chars)
   - `atlassian.xsrf.token` (short, format: `xxxx-xxxx-xxxx-xxxx|<digits>`)
5. Open `~/.atlassian-sync/.env` (on Windows: `%USERPROFILE%\.atlassian-sync\.env`) and paste:

   ```env
   ATLASSIAN_BASE_URL=https://your-org.atlassian.net
   ATLASSIAN_SESSION_COOKIE=cloud.session.token=<value from step 4a>
   ATLASSIAN_XSRF_TOKEN=<value from step 4b>
   ```

   Make sure the file mode is restrictive: on Unix-like systems, `chmod 600 ~/.atlassian-sync/.env`. On Windows, the default per-user profile permissions are usually sufficient but verify in File Explorer → Properties → Security if you're paranoid.

6. Test with:
   ```bash
   atlassian-sync ping
   # or: node scripts/sync-atlassian.mjs ping
   ```

## Security notes

- These cookies are **bearer credentials** — anyone with them can act as you in Confluence/Jira until they expire.
- **Never** paste them into chat tools, ticketing systems, code commits, or screenshots.
- The `~/.atlassian-sync/` directory is outside any git repo by design — you can't accidentally commit it.
- When you log out of Atlassian in the browser, the cookie is invalidated server-side. Re-run `setup --renew` next time.
- Cookies expire on their own after some period set by your tenant (typically days to weeks for SSO). Rotation is automatic when expired — you just re-run setup.

## Alternative: API token (if your tenant allows it)

If your tenant has API tokens enabled (`id.atlassian.com/manage-profile/security/api-tokens`), you can swap auth modes by setting these instead in the same file:

```env
ATLASSIAN_BASE_URL=https://your-org.atlassian.net
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=<token from id.atlassian.com>
```

The script will prefer the API token if both are set. API tokens don't expire automatically (you have to revoke them), so they're operationally simpler — see `docs/adr/0001-confluence-auth-via-session-cookie.md` for why the default is still cookies.
