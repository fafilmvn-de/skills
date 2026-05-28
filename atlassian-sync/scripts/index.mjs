// index.mjs — build a single-file JSON search index for .confluence-cache/
//
// Why JSON, not SQLite FTS5: see docs/adr/0003-search-index-for-confluence-cache.md.
// One file open during search => no per-.md Defender on-access scans, no recursive
// directory read in process telemetry.
//
// Index shape:
//   {
//     builtAt: string,
//     entries: [
//       { id, title, path, dangerous, labels, redactedBody }
//     ]
//   }
//
// Dangerous pages are included with their redacted markdown (NOT the encoded blob).
// The body has already been through redactBody() so no AV-bait bytes are written
// to the index file itself.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'fs'
import { join, relative } from 'path'
import { loadSafetyRules, redactBody, readQuarantined } from './safety.mjs'
import { loadProjectConfig } from './lib.mjs'

const INDEX_FILENAME = '.index.json'

function walkMd(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === '_quarantine') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMd(full, out)
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

function parseFrontMeta(md) {
  // Our pageMarkdown() writes a "# Title\n\n> Path: ...\n> URL: ...\n" preamble.
  // Extract the title from the first h1 and URL/id where present.
  const titleMatch = md.match(/^#\s+(.+)\s*$/m)
  const urlMatch = md.match(/^>\s*\*\*URL:\*\*\s+(\S+)/m)
  const idMatch = urlMatch ? urlMatch[1].match(/\/pages\/(\d+)/) : null
  return {
    title: titleMatch ? titleMatch[1].trim() : null,
    url: urlMatch ? urlMatch[1] : null,
    id: idMatch ? idMatch[1] : null,
  }
}

/** Build the index from a .confluence-cache directory. */
export function buildIndex(cacheDir, repoRoot) {
  const rules = loadSafetyRules(repoRoot, loadProjectConfig(repoRoot))
  const entries = []

  // 1. Walk benign .md files
  for (const path of walkMd(cacheDir)) {
    try {
      const md = readFileSync(path, 'utf8')
      const meta = parseFrontMeta(md)
      // Defensive: re-redact at index time even though writer already did.
      const { body } = redactBody(md, rules)
      entries.push({
        id: meta.id || null,
        title: meta.title || relative(cacheDir, path),
        path: relative(cacheDir, path),
        dangerous: false,
        labels: [],
        redactedBody: body,
      })
    } catch (err) {
      console.warn(`  ⚠ skip ${path}: ${err.message.split('\n')[0]}`)
    }
  }

  // 2. Pull in quarantined entries from sidecar index (decoded + already redacted)
  const qIdxPath = join(cacheDir, '_quarantine', '_index.json')
  if (existsSync(qIdxPath)) {
    try {
      const qIdx = JSON.parse(readFileSync(qIdxPath, 'utf8'))
      for (const [pageId, e] of Object.entries(qIdx.entries || {})) {
        const decoded = readQuarantined(cacheDir, pageId)
        if (!decoded) continue
        entries.push({
          id: pageId,
          title: e.title,
          path: e.file,
          dangerous: true,
          labels: [],
          redactedBody: decoded.body,
        })
      }
    } catch (err) {
      console.warn(`  ⚠ quarantine index unreadable: ${err.message.split('\n')[0]}`)
    }
  }

  const out = { builtAt: new Date().toISOString(), entries }
  const outPath = join(cacheDir, INDEX_FILENAME)
  writeFileSync(outPath, JSON.stringify(out), 'utf8')
  return { count: entries.length, dangerous: entries.filter(e => e.dangerous).length, path: outPath }
}

export function indexPath(cacheDir) { return join(cacheDir, INDEX_FILENAME) }
export { INDEX_FILENAME }
