#!/usr/bin/env node
// atlassian-sync — main CLI dispatcher
//
// Subcommands:
//   (default)                Bulk sync from <repo>/.atlassian-sync.json
//   setup [--renew]          Interactive cookie setup
//   page <url|id> [flags]    Single-page render (HTML or MD)
//   subtree <root-id> ...    Recursive crawl of a single page tree
//   space <key>              Full space crawl
//   ping                     Auth + connectivity test
//
// All file paths follow the skill conventions documented in SKILL.md.

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import {
  loadEnv, findRepoRoot, buildAuthHeaders, atlassianFetch, AuthExpiredError,
  storageToMarkdown, save, slugify, extractPageId, loadProjectConfig,
} from './lib.mjs'
import { loadSafetyRules, safeStoreMarkdown } from './safety.mjs'
import { buildIndex } from './index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = findRepoRoot()
const CACHE_DIR = join(REPO_ROOT, '.confluence-cache')

// Top-level dispatcher
const [, , cmd, ...rest] = process.argv

async function dispatch() {
  switch (cmd) {
    case 'setup':
      await import('./setup.mjs')
      return
    case 'page':
      await runPage(rest)
      return
    case 'subtree':
      await runSubtree(rest)
      return
    case 'space':
      await runSpace(rest)
      return
    case 'ping':
      await runPing()
      return
    case 'search':
      await import('./search.mjs')
      return
    case 'migrate':
      await import('./migrate.mjs')
      return
    case 'index':
      await runIndex()
      return
    case undefined:
    case 'sync':
      await runBulkSync()
      return
    case '-h':
    case '--help':
    case 'help':
      printHelp()
      return
    default:
      console.error(`Unknown subcommand: ${cmd}\n`)
      printHelp()
      process.exit(1)
  }
}

function printHelp() {
  console.log(`atlassian-sync — Confluence/Jira puller

Usage:
  node sync-atlassian.mjs                       Bulk sync from .atlassian-sync.json
  node sync-atlassian.mjs setup [--renew]       Interactive cookie setup
  node sync-atlassian.mjs page <url|id> [flags] Single page → docs/<slug>.html
    --template <mirror|checklist>                 HTML template (default: mirror)
    --md                                          Emit markdown instead of HTML
    --out <path>                                  Override default output path
  node sync-atlassian.mjs subtree <root-id> [flags]  Recursive crawl
    --folder <name>                               Output sub-folder (default: derived from title)
    --space <key>                                 Space key for URL generation
  node sync-atlassian.mjs space <space-key>      Full space crawl
  node sync-atlassian.mjs ping                   Auth + connectivity test
  node sync-atlassian.mjs search "<query>"       Search the cached index (use INSTEAD of grep)
  node sync-atlassian.mjs index                  (Re)build the search index from the cache
  node sync-atlassian.mjs migrate                Re-apply safety rules to an existing cache

Safety model: see references/safety-model.md.
NEVER \`grep -r .confluence-cache/\` — use \`search\`. See docs/adr/0003-*.
`)
}

// ---------------------------------------------------------------------------
// Confluence fetch helpers (used by all subcommands)
// ---------------------------------------------------------------------------

async function fetchPageMeta(auth, pageId) {
  return atlassianFetch(auth, `/wiki/rest/api/content/${pageId}?expand=version,ancestors,space,body.storage`)
}

async function fetchPageBody(auth, pageId) {
  // v2 storage if available; fall back to v1
  try {
    const data = await atlassianFetch(auth, `/wiki/api/v2/pages/${pageId}?body-format=storage`)
    if (data?.body?.storage?.value) return data.body.storage.value
  } catch {}
  const data = await atlassianFetch(auth, `/wiki/rest/api/content/${pageId}?expand=body.storage`)
  return data?.body?.storage?.value ?? ''
}

async function fetchPageAttachments(auth, pageId) {
  const out = []
  let start = 0
  const limit = 50
  while (true) {
    const data = await atlassianFetch(auth,
      `/wiki/rest/api/content/${pageId}/child/attachment?limit=${limit}&start=${start}`)
    const results = data?.results ?? []
    out.push(...results)
    if (results.length < limit) break
    start += limit
  }
  return out
}

/** Fetch labels for a page; returns array of label names (lowercase). Empty array on failure. */
async function fetchPageLabels(auth, pageId) {
  try {
    const data = await atlassianFetch(auth, `/wiki/rest/api/content/${pageId}/label?limit=200`, { allowNotFound: true })
    return (data?.results || []).map(l => String(l.name || '').toLowerCase()).filter(Boolean)
  } catch {
    return []
  }
}

async function fetchPageDescendants(auth, rootId) {
  const all = []
  const queue = [rootId]
  while (queue.length) {
    const pid = queue.shift()
    let start = 0
    const limit = 50
    while (true) {
      const data = await atlassianFetch(auth,
        `/wiki/rest/api/content/${pid}/child/page?limit=${limit}&start=${start}&expand=version,ancestors`)
      const results = data?.results ?? []
      all.push(...results)
      results.forEach(p => queue.push(p.id))
      if (results.length < limit) break
      start += limit
    }
  }
  return all
}

async function fetchSpacePages(auth, spaceKey) {
  const out = []
  let start = 0
  const limit = 50
  while (true) {
    const data = await atlassianFetch(auth,
      `/wiki/rest/api/content?spaceKey=${spaceKey}&type=page&limit=${limit}&start=${start}&expand=version,ancestors`)
    const results = data?.results ?? []
    out.push(...results)
    if (results.length < limit) break
    start += limit
  }
  return out
}

function pageMarkdown(page, bodyHtml, base) {
  const md = storageToMarkdown(bodyHtml)
  if (!md.trim()) return null
  const ancestors = (page.ancestors ?? []).map(a => a.title).join(' > ')
  const version = page.version?.number ?? '?'
  const lastMod = page.version?.when ? new Date(page.version.when).toLocaleDateString() : 'Unknown'
  const spaceKey = page._spaceKey || page.space?.key || ''
  const url = `${base}/wiki/spaces/${spaceKey}/pages/${page.id}`
  return `# ${page.title}

> **Path:** ${ancestors ? ancestors + ' > ' + page.title : page.title}  
> **Version:** ${version} | **Last modified:** ${lastMod}  
> **URL:** ${url}  
> **Synced:** ${new Date().toISOString()}

---

${md}
`
}

function categoryFromAncestors(ancestors, rootId = null) {
  const a = ancestors ?? []
  if (rootId) {
    const idx = a.findIndex(x => String(x.id) === String(rootId))
    if (idx >= 0 && a.length > idx + 1) return slugify(a[idx + 1].title, 50)
    return null
  }
  if (a.length < 2) return 'uncategorized'
  return slugify(a[1].title, 50)
}

// ---------------------------------------------------------------------------
// `page` — single-page render
// ---------------------------------------------------------------------------

function parseFlags(args, defaults = {}) {
  const flags = { ...defaults, _: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) { flags[key] = next; i++ }
      else flags[key] = true
    } else {
      flags._.push(a)
    }
  }
  return flags
}

async function runPage(args) {
  const flags = parseFlags(args, { template: 'mirror' })
  const target = flags._[0]
  if (!target) { console.error('Usage: page <url|id> [--template mirror|checklist] [--md] [--out path]'); process.exit(2) }

  loadEnv(REPO_ROOT)
  const auth = buildAuthHeaders()
  const pageId = extractPageId(target)

  const { renderPage } = await import('./pull-page.mjs')
  await renderPage({
    auth, pageId,
    template: flags.template,
    asMarkdown: !!flags.md,
    outPath: flags.out,
    repoRoot: REPO_ROOT,
    fetchPageMeta, fetchPageBody, fetchPageAttachments,
  })
}

// ---------------------------------------------------------------------------
// `subtree` — recursive crawl from a single root page
// ---------------------------------------------------------------------------

async function runSubtree(args) {
  const flags = parseFlags(args, {})
  const rootId = flags._[0] ? extractPageId(flags._[0]) : null
  if (!rootId) { console.error('Usage: subtree <root-id|url> [--folder name] [--space key]'); process.exit(2) }

  loadEnv(REPO_ROOT)
  const auth = buildAuthHeaders()
  const rules = loadSafetyRules(REPO_ROOT, loadProjectConfig(REPO_ROOT))

  const rootMeta = await fetchPageMeta(auth, rootId)
  const spaceKey = flags.space || rootMeta.space?.key || ''
  const folder = flags.folder || slugify(rootMeta.title)
  const label = rootMeta.title

  console.log(`\n🌳 Subtree crawl: "${label}" (${rootId}) → .confluence-cache/confluence/${folder}/`)
  const children = await fetchPageDescendants(auth, rootId)
  const allPages = [rootMeta, ...children]
  console.log(`   Found ${allPages.length} pages`)

  const categoryMap = {}
  let saved = 0, skipped = 0, quarantined = 0

  for (const page of allPages) {
    try {
      page._spaceKey = spaceKey
      const body = page.body?.storage?.value ?? await fetchPageBody(auth, page.id)
      const md = pageMarkdown(page, body, auth.base)
      if (!md) { skipped++; continue }

      let category = categoryFromAncestors(page.ancestors, rootId)
      if (!category) category = String(page.id) === String(rootId) ? '_root' : 'general'

      const relPath = `confluence/${folder}/${category}/${page.id}-${slugify(page.title)}.md`
      const benignPath = join(CACHE_DIR, relPath)
      const labels = await fetchPageLabels(auth, page.id)
      const result = safeStoreMarkdown({
        cacheDir: CACHE_DIR,
        page: { id: page.id, title: page.title, labels },
        markdown: md,
        benignPath,
        rules,
        kind: 'subtree',
      })
      if (result.dangerous) quarantined++

      const catLabel = page.ancestors?.find((_, i, arr) => {
        const rIdx = arr.findIndex(x => String(x.id) === String(rootId))
        return rIdx >= 0 && i === rIdx + 1
      })?.title || (String(page.id) === String(rootId) ? label : 'General')
      if (!categoryMap[category]) categoryMap[category] = { label: catLabel, pages: [] }
      categoryMap[category].pages.push({ title: page.title, relPath: result.dangerous ? `_quarantine/${page.id}-…md.b64` : relPath })
      saved++
    } catch (err) {
      console.error(`  ✗ "${page.title}": ${err.message.split('\n')[0]}`)
      skipped++
    }
  }

  // Per-category index files
  for (const [cat, { label: catLabel, pages: cps }] of Object.entries(categoryMap)) {
    const idx = `# ${catLabel} — Category Index\n\n> Folder: \`confluence/${folder}/${cat}/\`  \n> Pages: ${cps.length}  \n> Synced: ${new Date().toISOString()}\n\n---\n\n` +
      cps.map(p => `- [${p.title}](${p.relPath.replace(`confluence/${folder}/`, '')})`).join('\n')
    save(join(CACHE_DIR, 'confluence', folder, `_${cat}-index.md`), idx, { quiet: true })
  }

  // Folder-level index
  const summary = Object.entries(categoryMap)
    .sort((a, b) => b[1].pages.length - a[1].pages.length)
    .map(([cat, { label: cl, pages: cps }]) => `| [${cl}](./${folder}/_${cat}-index.md) | \`${folder}/${cat}/\` | ${cps.length} |`)
    .join('\n')
  const folderIndex = `# ${label} — Confluence Index

> **Root page ID:** ${rootId}  
> **Space:** ${spaceKey}  
> **Total pages:** ${allPages.length} (${saved} synced, ${skipped} empty/skipped, ${quarantined} quarantined)  
> **URL:** ${auth.base}/wiki/spaces/${spaceKey}/pages/${rootId}  
> **Synced:** ${new Date().toISOString()}

---

## Sections

| Section | Folder | Pages |
|---------|--------|-------|
${summary}
`
  save(join(CACHE_DIR, 'confluence', `${folder}-index.md`), folderIndex)
  writeCacheReadme(CACHE_DIR)
  console.log(`   ✓ ${saved} pages saved (${quarantined} quarantined), ${skipped} skipped, ${Object.keys(categoryMap).length} sections`)
}

// ---------------------------------------------------------------------------
// `space` — full space crawl
// ---------------------------------------------------------------------------

async function runSpace(args) {
  const flags = parseFlags(args, {})
  const spaceKey = flags._[0]
  if (!spaceKey) { console.error('Usage: space <space-key>'); process.exit(2) }

  loadEnv(REPO_ROOT)
  const auth = buildAuthHeaders()
  const rules = loadSafetyRules(REPO_ROOT, loadProjectConfig(REPO_ROOT))

  console.log(`\n📚 Space crawl: ${spaceKey} → .confluence-cache/confluence/${spaceKey.toLowerCase()}/`)
  const pages = await fetchSpacePages(auth, spaceKey)
  console.log(`   Found ${pages.length} pages`)

  const categoryMap = {}
  let saved = 0, skipped = 0, quarantined = 0
  for (const page of pages) {
    try {
      page._spaceKey = spaceKey
      const body = await fetchPageBody(auth, page.id)
      const md = pageMarkdown(page, body, auth.base)
      if (!md) { skipped++; continue }
      const category = categoryFromAncestors(page.ancestors) || 'uncategorized'
      const relPath = `confluence/${spaceKey.toLowerCase()}/${category}/${page.id}-${slugify(page.title)}.md`
      const benignPath = join(CACHE_DIR, relPath)
      const labels = await fetchPageLabels(auth, page.id)
      const result = safeStoreMarkdown({
        cacheDir: CACHE_DIR,
        page: { id: page.id, title: page.title, labels },
        markdown: md,
        benignPath,
        rules,
        kind: 'space',
      })
      if (result.dangerous) quarantined++

      if (!categoryMap[category]) categoryMap[category] = { label: page.ancestors?.[1]?.title ?? category, pages: [] }
      categoryMap[category].pages.push({ title: page.title, relPath: result.dangerous ? `_quarantine/${page.id}-…md.b64` : relPath })
      saved++
    } catch (err) {
      console.error(`  ✗ "${page.title}": ${err.message.split('\n')[0]}`)
      skipped++
    }
  }

  const summary = Object.entries(categoryMap)
    .sort((a, b) => b[1].pages.length - a[1].pages.length)
    .map(([cat, { label, pages: cps }]) =>
      `| [${label}](${spaceKey.toLowerCase()}/_${cat}-index.md) | \`${spaceKey.toLowerCase()}/${cat}/\` | ${cps.length} |`
    ).join('\n')
  const spaceIndex = `# ${spaceKey} — Confluence Space Index

> Total pages: ${pages.length} (${saved} synced, ${skipped} skipped, ${quarantined} quarantined)  
> Categories: ${Object.keys(categoryMap).length}  
> Synced: ${new Date().toISOString()}

---

| Category | Folder | Pages |
|----------|--------|-------|
${summary}
`
  save(join(CACHE_DIR, 'confluence', `${spaceKey.toLowerCase()}-index.md`), spaceIndex)
  writeCacheReadme(CACHE_DIR)
  console.log(`   ✓ ${saved} pages in ${Object.keys(categoryMap).length} categories (${quarantined} quarantined)`)
}

// ---------------------------------------------------------------------------
// `sync` / default — bulk from .atlassian-sync.json
// ---------------------------------------------------------------------------

async function runBulkSync() {
  loadEnv(REPO_ROOT)
  const cfg = loadProjectConfig(REPO_ROOT)
  const hasAnything = (cfg.confluenceSpaces?.length || 0) +
                      (cfg.confluenceRootPages?.length || 0) +
                      (cfg.confluencePinnedPages?.length || 0) +
                      (cfg.jiraProjects?.length || 0) > 0
  if (!hasAnything) {
    console.log('No .atlassian-sync.json found (or empty). Nothing to sync.')
    console.log('Either create one at the repo root, or use CLI subcommands:')
    console.log('  page <url>, subtree <id>, space <key>')
    return
  }

  await runPing()

  for (const { key, label } of cfg.confluenceSpaces || []) {
    try { await runSpace([key]); console.log(`  (${label})`) }
    catch (err) { console.error(`  ✗ Space ${key}: ${err.message.split('\n')[0]}`) }
  }

  for (const { id, label, spaceKey, folder } of cfg.confluenceRootPages || []) {
    try {
      const args = [id]
      if (folder) args.push('--folder', folder)
      if (spaceKey) args.push('--space', spaceKey)
      await runSubtree(args)
      console.log(`  (${label})`)
    } catch (err) { console.error(`  ✗ Root ${id}: ${err.message.split('\n')[0]}`) }
  }

  if (cfg.confluencePinnedPages?.length) {
    console.log('\n📌 Pinned pages')
    loadEnv(REPO_ROOT)
    const auth = buildAuthHeaders()
    const rules = loadSafetyRules(REPO_ROOT, cfg)
    for (const { id, label } of cfg.confluencePinnedPages) {
      try {
        const meta = await fetchPageMeta(auth, id)
        meta._spaceKey = meta.space?.key || ''
        const body = await fetchPageBody(auth, id)
        const md = pageMarkdown(meta, body, auth.base)
        if (md) {
          const labels = await fetchPageLabels(auth, id)
          const benignPath = join(CACHE_DIR, 'confluence', `${slugify(label)}.md`)
          safeStoreMarkdown({
            cacheDir: CACHE_DIR,
            page: { id, title: meta.title || label, labels },
            markdown: md,
            benignPath,
            rules,
            kind: 'pinned',
          })
        }
      } catch (err) { console.error(`  ✗ ${label}: ${err.message.split('\n')[0]}`) }
    }
  }

  if (cfg.jiraProjects?.length) {
    console.log('\n📋 Jira sync not yet implemented. Skipping configured Jira projects.')
  }

  // Always (re)build the search index and refresh the README at the end of a bulk sync.
  console.log('\n🗂  Building search index…')
  try {
    const stats = buildIndex(CACHE_DIR, REPO_ROOT)
    console.log(`   ✓ ${stats.count} entries (${stats.dangerous} quarantined)`)
  } catch (err) {
    console.error(`   ✗ index build failed: ${err.message}`)
  }
  writeCacheReadme(CACHE_DIR)
}

async function runIndex() {
  if (!existsSync(CACHE_DIR)) {
    console.error(`No cache at ${CACHE_DIR}. Run a sync first.`)
    process.exit(1)
  }
  const stats = buildIndex(CACHE_DIR, REPO_ROOT)
  console.log(`✓ ${stats.count} entries (${stats.dangerous} quarantined) → ${stats.path}`)
  writeCacheReadme(CACHE_DIR)
}

function writeCacheReadme(cacheDir) {
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  const body = `# .confluence-cache/ — DO NOT GREP THIS FOLDER

This directory is the per-user, per-machine cache produced by \`skills/atlassian-sync\`.

## Read it via the search index, never with recursive grep

Doing \`grep -r -i '<keyword>' .confluence-cache/ --include=*.md\` will:

1. **Trigger Defender on-access scans on every \`.md\` file** — at least one scraped
   page is almost certain to contain payload-shaped strings (PHP webshell samples,
   reverse-shell one-liners, etc.) from Confluence security/pentest pages. Defender
   will quarantine those files and open a SOC ticket against you.
2. **Put the keyword chain into command-line telemetry**, where SOC's keyword-rules
   may flag the command itself as discovery activity, independently of any AV hit.

Both have been observed in production at organisations running Microsoft Defender for
Endpoint + Sentinel — see \`docs/adr/0002-content-safety-for-confluence-cache.md\`.

## Use the search subcommand instead

\`\`\`bash
atlassian-sync search "<your query>"
atlassian-sync search "term1|term2 term3"  # AND of (term1 OR term2) AND term3

# If the query contains sensitive codenames, pipe via stdin so nothing lands in process argv:
echo "<sensitive query>" | atlassian-sync search -
\`\`\`

## Files in here

| Path | What it is |
|------|-----------|
| \`confluence/<folder>/<category>/<id>-<slug>.md\` | Benign pages, redacted plain markdown |
| \`_quarantine/<id>-<sha8>.md.b64\` | Pages tagged dangerous (pentest/security/...) — base64-encoded redacted body, content-neutral filename |
| \`_quarantine/_index.json\` | Maps \`pageId → {title, hash, intendedPath, reasons}\` for quarantined pages |
| \`.index.json\` | Single-file search index used by the \`search\` subcommand |
| \`.audit.log\` | JSONL log of every redaction / quarantine event (no payload bytes) |

## Operational

- To re-process this cache after a safety-rule update: \`atlassian-sync migrate\`.
- To rebuild the index without re-fetching from Confluence: \`atlassian-sync index\`.
- To inspect a specific quarantined page's content: read \`_quarantine/_index.json\` for the pageId, then \`base64 -d _quarantine/<file>.md.b64\`.

Generated by atlassian-sync; safe to delete this README — it will be regenerated on the next sync.
`
  writeFileSync(join(cacheDir, 'README.md'), body, 'utf8')
}

// ---------------------------------------------------------------------------
// `ping`
// ---------------------------------------------------------------------------

async function runPing() {
  loadEnv(REPO_ROOT)
  const auth = buildAuthHeaders()
  console.log(`🔍 ${auth.base}  (mode: ${auth.mode})`)
  try {
    const me = await atlassianFetch(auth, '/wiki/rest/api/user/current')
    console.log(`  ✓ Confluence: ${me.displayName || me.username}`)
  } catch (err) {
    console.log(`  ✗ Confluence: ${err.message.split('\n')[0]}`)
    if (err instanceof AuthExpiredError) process.exit(1)
  }
  try {
    const me = await atlassianFetch(auth, '/rest/api/3/myself')
    console.log(`  ✓ Jira: ${me.displayName} (${me.emailAddress || ''})`)
  } catch (err) {
    console.log(`  ⚠ Jira: ${err.message.split('\n')[0]}`)
  }
}

// ---------------------------------------------------------------------------

dispatch().catch(err => {
  console.error('\n' + (err.message || err))
  process.exit(1)
})
