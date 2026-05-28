# Reads against the Confluence cache go through a single-file search index, not recursive grep

**Context:** Companion to [ADR 0002](./0002-content-safety-for-confluence-cache.md). The Defender/SIEM failure pattern has two distinct signals — content (a payload-shaped string in a cached `.md`) and behaviour (`grep -r -i '<keyword|keyword|…>' …/.confluence-cache/ --include=*.md`). ADR 0002 hardens the content side. This ADR hardens the behaviour side: the recursive-grep-with-keyword-chain pattern is the canonical "discovery activity" shape SIEM rules watch for, and on a corpus of thousands of scraped pages it also triggers on-access AV on every single file (multiplying the AV-bait surface from 1 file to N files). Even after every page is redacted, the *act* of doing `grep -r` across the cache is the wrong shape.

**Decision:** `atlassian-sync` ships a `search` subcommand backed by a single-file JSON index. All downstream consumers (agents reading the cache, human users looking things up, future tools depending on the cache) are instructed to use it instead of grep/find. The index lives at `.confluence-cache/.index.json` and is rebuilt at the end of every bulk sync and on demand via `atlassian-sync index`. The `search` subcommand:

- Opens the index file *once* per query (AV sees one read of one JSON file, not N reads of N markdown files).
- Accepts queries via argv **or stdin** (`echo "<q>" | search -`) so codenames never need to appear in command-line telemetry.
- Defaults to excluding `dangerous`-classified pages; `--include-dangerous` opts in and decodes on read.
- Provides AND across whitespace-separated tokens and OR via pipes inside a token.
- A generated `.confluence-cache/README.md` instructs future readers to never `grep -r` this folder.

**Why this is non-obvious:** A future reader will see we built a hand-rolled search over a JSON file and assume we either (a) didn't know about ripgrep, or (b) over-engineered something a one-line shell pipeline would solve. We did know, and we deliberately rejected the shell-pipeline approach because the shell-pipeline approach is *exactly* what triggers the failure. The search subcommand is not about being faster than grep; it's about presenting a single-file, single-process read pattern to AV and SIEM telemetry.

**Alternatives considered and rejected:**

- **SQLite FTS5 index.** Considered first. Rejected because it introduces a runtime dependency: `node:sqlite` is behind `--experimental-sqlite` on the Node LTS versions a lot of users still run, and `better-sqlite3` is a native module that needs build tools (Windows users regularly fail on it). The threat model does not require FTS5-grade ranking — typical corpus sizes are in the low thousands of pages, and a linear scan over a redacted-text JSON is sub-100ms. We took the deployability win.
- **Bundle the cache into one `bundle.txt`.** Defeats per-file AV scanning equally well, but is awful for incremental updates (must rewrite the whole bundle on every sync) and provides no structured query — agents would just run `grep` against the bundle, putting keywords back into argv.
- **README-only ("trust agents to behave").** This is what naive sync tools effectively do. Fails in production. Agent and human muscle memory will default to `grep -r` unless we provide an obviously-better alternative with the same ergonomics.
- **Force encode-every-page so grep can't read raw bytes.** This is the ADR-0002-rejected universal-hammer option. It would also solve B (no raw bytes for grep to match against), but at the cost of breaking `view`, `cat`, IDE preview, and every other read tool. The search index is a lighter-weight way to make grep unnecessary, paired with ADR-0002's selective encoding for pages where raw bytes are themselves dangerous.

**Trade-offs we accepted:**

- **+** One file open per query, regardless of corpus size. Telemetry looks like `node search "<q>"`, not `grep -r ... --include=*.md`.
- **+** stdin query mode means even sensitive codenames don't have to appear in command lines.
- **+** Index includes the redacted form of dangerous pages too, so legitimate queries find them without needing to touch the encoded files at all (except when `--include-dangerous` is set, which still goes through `readQuarantined` rather than raw filesystem access).
- **+** No new runtime dependencies. Works on any Node 18+.
- **−** Naive AND/OR over substring matching is less expressive than FTS5 (no stemming, no phrase queries, no relevance ranking beyond hit-count). Adequate for a documentation cache; not adequate as a general search backend.
- **−** Index is rebuilt wholesale on each sync, so for very large corpora (10k+ pages) we'd want incremental updates. Re-evaluate then.
- **−** Doesn't physically prevent someone from running grep anyway. Defence relies on the README + agent-instruction nudge and on `search` being more ergonomic than grep for the use case (it is).

**Reversal cost:** Low. The index format is internal — we can swap the storage for SQLite FTS5 or anything else without changing the public CLI (`atlassian-sync search "<q>"`). Downstream agents are coupled to the subcommand interface, not to the JSON shape.
