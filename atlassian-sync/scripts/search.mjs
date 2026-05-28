// search.mjs — query the cached index without recursive grep across .md files.
//
// Why this exists: recursive grep across a Confluence cache is a known dangerous
// pattern in any environment running Microsoft Defender + Sentinel (or similar
// EDR + SIEM combos). It (a) triggers on-access AV scans on every file, which
// is statistically likely to flag a scraped pentest/security page, and (b) puts
// the keyword chain into command-line telemetry, which SOC keyword rules treat
// as discovery activity. This tool replaces that pattern with one file open,
// query-via-stdin support, and no keyword fan-out. See docs/adr/0003-*.
//
// Usage:
//   node search.mjs "<query>"                            # AND across whitespace-split tokens
//   node search.mjs "term1|term2"                        # OR (single token containing pipes)
//   echo "<sensitive query>" | node search.mjs -         # read query from stdin (no argv leak)
//   node search.mjs --limit 20 --snippet 280 "<query>"
//   node search.mjs --include-dangerous "<query>"        # also search quarantined pages
//   node search.mjs --json "<query>"                     # machine-readable output

import { readFileSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { findRepoRoot } from './lib.mjs'
import { indexPath, buildIndex } from './index.mjs'

const REPO_ROOT = findRepoRoot()
const CACHE_DIR = join(REPO_ROOT, '.confluence-cache')

function parseArgs(argv) {
  const flags = { limit: 25, snippet: 240, includeDangerous: false, json: false, _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--limit') flags.limit = parseInt(argv[++i], 10) || flags.limit
    else if (a === '--snippet') flags.snippet = parseInt(argv[++i], 10) || flags.snippet
    else if (a === '--include-dangerous') flags.includeDangerous = true
    else if (a === '--json') flags.json = true
    else if (a === '-h' || a === '--help') flags.help = true
    else flags._.push(a)
  }
  return flags
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => data += chunk)
    process.stdin.on('end', () => resolve(data.trim()))
  })
}

function tokenize(q) {
  // Split on whitespace; each token may itself be an OR group via "|".
  // All tokens must match (AND); within a token, any branch matching counts.
  return q.split(/\s+/).filter(Boolean).map(tok => {
    if (tok.includes('|')) return { kind: 'or', terms: tok.split('|').filter(Boolean) }
    return { kind: 'term', terms: [tok] }
  })
}

function matchEntry(entry, tokens) {
  const hay = (entry.title + '\n' + entry.redactedBody).toLowerCase()
  let score = 0
  for (const t of tokens) {
    const hit = t.terms.find(term => hay.includes(term.toLowerCase()))
    if (!hit) return null
    score += hay.split(hit.toLowerCase()).length - 1
  }
  return score
}

function snippetAround(body, tokens, len) {
  const lc = body.toLowerCase()
  for (const t of tokens) {
    for (const term of t.terms) {
      const idx = lc.indexOf(term.toLowerCase())
      if (idx >= 0) {
        const start = Math.max(0, idx - Math.floor(len / 2))
        const end = Math.min(body.length, start + len)
        return (start > 0 ? '… ' : '') + body.slice(start, end).replace(/\s+/g, ' ').trim() + (end < body.length ? ' …' : '')
      }
    }
  }
  return body.slice(0, len).replace(/\s+/g, ' ').trim() + (body.length > len ? ' …' : '')
}

function printHelp() {
  console.log(`atlassian-sync search — query .confluence-cache without recursive grep.

Usage:
  search "<query>"                       AND across whitespace-split tokens
  search "term1|term2"                   OR via pipes inside a token
  echo "<query>" | search -              Read query from stdin (no argv leak)
  search --limit 20 --snippet 280 "<q>"  Tune output
  search --include-dangerous "<q>"       Also search quarantined pages
  search --json "<q>"                    JSON output

Why not grep? See docs/adr/0003-search-index-for-confluence-cache.md.
`)
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.help) { printHelp(); return }

  let query
  if (flags._[0] === '-') {
    query = await readStdin()
  } else {
    query = flags._.join(' ').trim()
  }
  if (!query) { printHelp(); process.exit(2) }

  const idxPath = indexPath(CACHE_DIR)
  if (!existsSync(idxPath)) {
    console.error(`No index at ${idxPath}.`)
    console.error('Run a sync first, or: node skills/atlassian-sync/scripts/sync-atlassian.mjs index')
    process.exit(1)
  }
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'))
  const tokens = tokenize(query)

  const hits = []
  for (const entry of idx.entries) {
    if (entry.dangerous && !flags.includeDangerous) continue
    const score = matchEntry(entry, tokens)
    if (score !== null) hits.push({ entry, score })
  }
  hits.sort((a, b) => b.score - a.score)
  const top = hits.slice(0, flags.limit)

  if (flags.json) {
    console.log(JSON.stringify({
      query, total: hits.length, returned: top.length,
      results: top.map(h => ({
        id: h.entry.id, title: h.entry.title, path: h.entry.path,
        dangerous: h.entry.dangerous, score: h.score,
        snippet: snippetAround(h.entry.redactedBody, tokens, flags.snippet),
      })),
    }, null, 2))
    return
  }

  console.log(`\n🔎 "${query}" — ${hits.length} match${hits.length === 1 ? '' : 'es'} (showing ${top.length})\n`)
  for (const h of top) {
    const tag = h.entry.dangerous ? '🔒 ' : ''
    console.log(`${tag}${h.entry.title}`)
    console.log(`   path: ${h.entry.path}   score: ${h.score}${h.entry.id ? '   id: ' + h.entry.id : ''}`)
    console.log(`   ${snippetAround(h.entry.redactedBody, tokens, flags.snippet)}`)
    console.log('')
  }
  if (hits.length === 0) {
    console.log('No matches. Tips:')
    console.log('  - Reduce token count: each whitespace-separated token must match (AND).')
    console.log('  - Use pipes for OR inside a token: "agent|chatbot|copilot"')
    console.log('  - Add --include-dangerous if the result might be in a quarantined page.')
    console.log('  - Rebuild the index: node skills/atlassian-sync/scripts/sync-atlassian.mjs index')
  }
}

main().catch(err => { console.error(err.message || err); process.exit(1) })
