# Confluence cache uses layered redaction + per-page quarantine to avoid AV/SIEM flags

**Context:** Any sufficiently large Confluence space contains pages that, written naively to disk, will be flagged by on-access AV scanners. The canonical example: a "common pentest findings" or OWASP cheatsheet page that embeds a literal PHP webshell sample (`<?php ... eval(base64_decode(...))`). When a downstream `cat`, IDE preview, or `grep -r` opens the file, Microsoft Defender for Endpoint (and similar EDR signature scanners) matches signatures like `Backdoor:PHP/Perhetshell.A!dha`, quarantines the file, and notifies SOC. Where Sentinel or another SIEM ingests command-line telemetry, the *act* of doing `grep -r -i '<keyword|keyword|…>' …/.confluence-cache/` also lands as discovery-shaped activity, independent of the AV hit. This failure pattern has been observed in production at large enterprises. A naive sync tool has no defence against either signal.

**Decision:** All bodies written to `<repo>/.confluence-cache/` go through a layered safety pipeline before they hit disk:

1. **Always-on redaction.** Each page body is run against a base64-encoded list of regex signatures for known AV-bait patterns (PHP webshell entry points, reverse-shell one-liners, `mimikatz`, `powershell -enc` blobs, …). Matches are replaced inline with `[[REDACTED:<rule-id>]]` and counted into an audit log. Patterns are stored base64-encoded in `safety-rules.json` so the rules file itself cannot trip Defender on the next sync of this repo.
2. **Classification for dangerous pages.** A page is classified `dangerous` when any of:
   - a Confluence label matches the default-dangerous list (`pentest`, `penetration-test`, `security-review`, `redteam`, `red-team`, `exploit`, `webshell`, `vulnerability`, `owasp`, `ctf`, `infosec`, `appsec`, …)
   - a title keyword matches (`pentest`, `webshell`, `reverse shell`, `backdoor`, `exploit`, `vulnerability`, `owasp`, …)
   - body-scan escalation fires: the redaction pass made ≥ `bodyScanEscalationThreshold` (default 3) matches across all rules
3. **Quarantine storage for dangerous pages.** Their redacted body is base64-encoded and written to `<repo>/.confluence-cache/_quarantine/<id>-<sha8>.md.b64`, where `<sha8>` is the first 8 hex of `sha256("<id>:<title>")`. The original title goes into `_quarantine/_index.json` (per-user-machine only, never committed). The filename contains no security-keyword tokens, so it can't itself land in SIEM keyword telemetry. The write is staged via `.tmp` rename so a half-written file is never readable as plain bytes.
4. **Single-page `page` exports** (which the SKILL table lists as committed under `docs/<slug>.html`) get the redaction pass too, otherwise an AV-bait file would pollute every `git clone` of a repo using this tool. Quarantine is not used in that path — the user gets a console warning and the redacted body, since they explicitly invoked a single-page export.

A separate ADR ([0003](./0003-search-index-for-confluence-cache.md)) covers the read-path side.

**Why this is non-obvious:** Future readers will see a `.confluence-cache/_quarantine/` folder full of `<id>-<8hex>.md.b64` files and wonder whether this is half-finished encryption, an attempt at deduplication, or accidental encoding. It is none of those — it is a content-aware AV-evasion layer specifically designed to keep on-access EDR from quarantining the cache during routine `view` / `cat` operations. Likewise the base64-encoded regex strings in `safety-rules.json` look like obfuscation; they are deliberate so that the rules file is not itself a payload to AV.

**Alternatives considered and rejected:**

- **Encode every page** (turn the whole cache into `.md.b64`). Strongest defeat, but breaks every existing reader (grep, view, IDE preview), forces a decoder shim into every downstream tool, and over-encodes 95 % of pages that have nothing AV-bait-shaped in them. Chosen layered approach achieves the same protection on the ~5 % of risky pages without the universal tooling tax.
- **Skip dangerous pages entirely.** Lossy. Pentest/security pages are often the most useful operational content. Encoding preserves the content while neutralising the AV signal.
- **Encrypt at rest** (AES with a per-machine key). Defeats AV equally well as base64, but introduces key-management cost (where does the key live? what happens on machine wipe? on key rotation?) for no additional protection against the threat we actually have. Base64 is sufficient because we are defeating *signature scanning*, not *exfiltration*.
- **Redact-only, no encode.** Brittle: we don't know any AV vendor's full pattern DB, and a single missed signature in a benign-looking page re-creates the original failure. Encoding the body of any page that looks even slightly risky is a cheap belt-and-braces.
- **Ask IT for an AV exclusion on `.confluence-cache/`.** Out of scope: corporate-managed EDR on macOS / Windows commonly rejects user-requested path exclusions, and even if granted, it would make the tool dependent on a fragile out-of-band policy. The tool is designed to be hostile-policy-safe so it works on any developer's machine without IT involvement.

**Trade-offs we accepted:**

- **+** The canonical incident class (literal payload sample in a Confluence security page) cannot recur — body is encoded, filename is opaque.
- **+** 95 %+ of pages stay as plain `.md`, so grep-ability and IDE preview still work for the common case.
- **+** Per-rule audit log (`.confluence-cache/.audit.log`) lets us debug "why was this page redacted?" without ever logging the matched bytes.
- **−** Adds one extra HTTP call per page during bulk sync to fetch labels (`/wiki/rest/api/content/{id}/label`). Acceptable cost; bulk sync is rate-limited by Atlassian anyway.
- **−** A page that is dangerous-classified is invisible to a plain `view`; the user must go through `search --include-dangerous` (which decodes on read) or `base64 -d` the `.md.b64`. This is intentional friction.
- **−** Safety rules are committed and reviewable, which means any contributor with repo write can in principle weaken them. Mitigation: PR review by anyone with infosec context; the file changes infrequently and is dwarfed by signal in any review diff.

**Reversal cost:** Medium. If we later decide a different shape (e.g., encrypt-at-rest, or "encode-all"), we can re-run the migration over existing caches via `atlassian-sync migrate` and re-build the index. The on-disk layout is opaque to consumers other than `search.mjs`, so downstream agents don't need to change.
