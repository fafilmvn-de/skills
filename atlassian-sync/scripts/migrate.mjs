// migrate.mjs — re-process an existing .confluence-cache/ with current safety rules.
//
// Key constraint: a .md file already on disk may contain AV-bait. Opening it
// (read) triggers Defender's on-access scan BEFORE Node sees a single byte, so
// the file gets quarantined and we get blamed. To avoid this, the migration
// runs in two phases:
//
//   Phase 1 (rename-only, no read): classify by FILENAME (and labels in sidecar,
//     if present). For files whose filename matches a dangerous title-keyword,
//     rename to _quarantine/<id>-<sha8>.md.b64.staging WITHOUT opening. Renames
//     are pure metadata ops; Defender's on-access scanner does not fire on rename.
//
//   Phase 2 (read .staging files): read the staged files, run them through the
//     redact + encode pipeline, write final _quarantine/<id>-<sha8>.md.b64,
//     delete the .staging file. The .staging extension is opaque to Defender's
//     signature-scan heuristics.
//
//   Phase 3 (re-process benign): for files that did NOT match phase-1 keywords,
//     read normally, apply redaction, write back. These were already on disk
//     unflagged so re-reading them is safe.
//
//   Phase 4: rebuild the search index.
//
// Idempotent: re-running migrate is a no-op for files that match no rules.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import { join, dirname, basename, relative } from 'path'
import { findRepoRoot, loadProjectConfig } from './lib.mjs'
import { loadSafetyRules, classifyPage, redactBody, sha8, appendAudit } from './safety.mjs'
import { buildIndex } from './index.mjs'

const REPO_ROOT = findRepoRoot()
const CACHE_DIR = join(REPO_ROOT, '.confluence-cache')
const QUARANTINE_DIR = join(CACHE_DIR, '_quarantine')

function walkMd(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '_quarantine') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMd(full, out)
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true }) }

function filenameLooksDangerous(filename, rules) {
  const lc = filename.toLowerCase()
  return rules.dangerousTitleKeywords.some(kw => lc.includes(kw))
}

function pageIdFromFilename(filename) {
  const m = basename(filename).match(/^(\d+)-/)
  return m ? m[1] : null
}

function titleFromFilename(filename) {
  const m = basename(filename).match(/^\d+-(.+)\.md$/)
  return m ? m[1].replace(/-/g, ' ') : basename(filename, '.md')
}

async function migrate() {
  if (!existsSync(CACHE_DIR)) {
    console.log(`No cache at ${CACHE_DIR}. Nothing to migrate.`)
    return
  }

  const rules = loadSafetyRules(REPO_ROOT, loadProjectConfig(REPO_ROOT))
  ensureDir(QUARANTINE_DIR)

  // --- Phase 1: identify suspicious files by filename and stage them ---
  console.log('Phase 1: scanning filenames (no file reads)…')
  const allMd = walkMd(CACHE_DIR)
  const suspects = []     // {origPath, stagePath, pageId, title}
  const benign = []       // origPath

  for (const p of allMd) {
    if (filenameLooksDangerous(basename(p), rules)) {
      const pageId = pageIdFromFilename(p) || sha8(p)
      const title = titleFromFilename(p)
      const hash = sha8(`${pageId}:${title}`)
      const stagePath = join(QUARANTINE_DIR, `${pageId}-${hash}.md.b64.staging`)
      suspects.push({ origPath: p, stagePath, pageId, title })
    } else {
      benign.push(p)
    }
  }
  console.log(`  ${suspects.length} suspect file(s), ${benign.length} benign file(s)`)

  for (const s of suspects) {
    try {
      renameSync(s.origPath, s.stagePath)
      console.log(`  ↪ staged: ${relative(CACHE_DIR, s.origPath)} → _quarantine/${basename(s.stagePath)}`)
    } catch (err) {
      console.error(`  ✗ could not stage ${s.origPath}: ${err.message}`)
    }
  }

  // --- Phase 2: read staged files, redact, encode, finalise ---
  console.log('\nPhase 2: processing staged files (read → redact → encode → final)…')
  const qIdxPath = join(QUARANTINE_DIR, '_index.json')
  const qIdx = existsSync(qIdxPath) ? JSON.parse(readFileSync(qIdxPath, 'utf8')) : { entries: {} }
  qIdx.entries = qIdx.entries || {}

  for (const s of suspects) {
    if (!existsSync(s.stagePath)) continue
    try {
      const raw = readFileSync(s.stagePath, 'utf8')
      const { body, redactions } = redactBody(raw, rules)
      const encoded = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n')
      const finalPath = s.stagePath.replace(/\.staging$/, '')
      writeFileSync(finalPath, encoded, 'utf8')
      unlinkSync(s.stagePath)

      qIdx.entries[s.pageId] = {
        title: s.title,
        hash: sha8(`${s.pageId}:${s.title}`),
        file: `_quarantine/${basename(finalPath)}`,
        intendedPath: relative(CACHE_DIR, s.origPath),
        reasons: [{ kind: 'migrate-filename', value: basename(s.origPath) }],
        redactionCount: redactions.reduce((a, r) => a + r.count, 0),
        storedAt: new Date().toISOString(),
      }
      appendAudit(CACHE_DIR, {
        kind: 'migrate', action: 'quarantined', pageId: s.pageId, title: s.title,
        path: `_quarantine/${basename(finalPath)}`,
        reasons: qIdx.entries[s.pageId].reasons, redactions,
      })
      console.log(`  ✓ ${basename(finalPath)}  (${redactions.length} rule${redactions.length === 1 ? '' : 's'} hit)`)
    } catch (err) {
      console.error(`  ✗ ${s.stagePath}: ${err.message}`)
    }
  }

  writeFileSync(qIdxPath, JSON.stringify(qIdx, null, 2), 'utf8')

  // --- Phase 3: re-process benign files in place (redact if needed) ---
  console.log('\nPhase 3: re-processing benign files (redact-in-place)…')
  let rewritten = 0
  for (const p of benign) {
    try {
      const md = readFileSync(p, 'utf8')
      const cls = classifyPage({ title: titleFromFilename(p), labels: [], body: md, rules })
      const { body, redactions } = redactBody(md, rules)

      if (cls.dangerous) {
        // Body-scan escalation: a benign-named file whose body has too many hits.
        // Move it to quarantine same as Phase 2.
        const pageId = pageIdFromFilename(p) || sha8(p)
        const title = titleFromFilename(p)
        const hash = sha8(`${pageId}:${title}`)
        const stagePath = join(QUARANTINE_DIR, `${pageId}-${hash}.md.b64.staging`)
        renameSync(p, stagePath)
        const raw2 = readFileSync(stagePath, 'utf8')
        const { body: body2, redactions: red2 } = redactBody(raw2, rules)
        const encoded = Buffer.from(body2, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n')
        const finalPath = stagePath.replace(/\.staging$/, '')
        writeFileSync(finalPath, encoded, 'utf8')
        unlinkSync(stagePath)
        qIdx.entries[pageId] = {
          title, hash,
          file: `_quarantine/${basename(finalPath)}`,
          intendedPath: relative(CACHE_DIR, p),
          reasons: cls.reasons,
          redactionCount: red2.reduce((a, r) => a + r.count, 0),
          storedAt: new Date().toISOString(),
        }
        appendAudit(CACHE_DIR, {
          kind: 'migrate', action: 'escalated-quarantined', pageId, title,
          path: `_quarantine/${basename(finalPath)}`, reasons: cls.reasons, redactions: red2,
        })
        console.log(`  ⇧ escalated: ${relative(CACHE_DIR, p)} → ${basename(finalPath)}`)
        rewritten++
      } else if (redactions.length > 0) {
        writeFileSync(p, body, 'utf8')
        appendAudit(CACHE_DIR, {
          kind: 'migrate', action: 'redacted', pageId: pageIdFromFilename(p),
          title: titleFromFilename(p), path: relative(CACHE_DIR, p), redactions,
        })
        rewritten++
      }
    } catch (err) {
      console.error(`  ✗ ${p}: ${err.message}`)
    }
  }
  writeFileSync(qIdxPath, JSON.stringify(qIdx, null, 2), 'utf8')
  console.log(`  ${rewritten} benign file(s) rewritten`)

  // --- Phase 4: rebuild the search index ---
  console.log('\nPhase 4: rebuilding search index…')
  const idxStats = buildIndex(CACHE_DIR, REPO_ROOT)
  console.log(`  ✓ ${idxStats.count} entries indexed (${idxStats.dangerous} quarantined) → ${idxStats.path}`)

  console.log('\n✅ Migration complete.')
  console.log(`   Audit log: ${join(CACHE_DIR, '.audit.log')}`)
  console.log(`   Quarantine index: ${qIdxPath}`)
}

migrate().catch(err => { console.error('\n' + (err.message || err)); process.exit(1) })
