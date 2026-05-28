// Single-page renderer: Confluence page → docs/<slug>.html (with images) or .md.
//
// Exported as `renderPage({...})`; invoked from sync-atlassian.mjs `page` subcommand.

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { dirname, join, basename } from 'path'
import { fileURLToPath } from 'url'
import { storageToMarkdown, save, slugify, ensureDir, atlassianFetch, findRepoRoot, loadProjectConfig } from './lib.mjs'
import { loadSafetyRules, redactBody, classifyPage } from './safety.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(__dirname, '..', 'assets', 'templates')

const EXT_BY_SIG = [
  [[0x89, 0x50, 0x4e, 0x47], '.png'],
  [[0xff, 0xd8, 0xff], '.jpg'],
  [[0x47, 0x49, 0x46, 0x38], '.gif'],
  [[0x52, 0x49, 0x46, 0x46], '.webp'], // RIFF, also AVI - check
]

function guessExt(buf, fallback = '.bin') {
  for (const [sig, ext] of EXT_BY_SIG) {
    if (sig.every((b, i) => buf[i] === b)) return ext
  }
  return fallback
}

/** Download all attachments and return src→localPath map. */
async function downloadAttachments(auth, pageId, attachments, assetDir) {
  const map = new Map()
  for (const att of attachments) {
    const downloadPath = att._links?.download
    if (!downloadPath) continue
    try {
      const res = await atlassianFetch(auth, `/wiki${downloadPath}`, { raw: true })
      const buf = Buffer.from(await res.arrayBuffer())
      const baseExt = (att.title || '').match(/\.[a-z0-9]+$/i)?.[0]
      const ext = baseExt || guessExt(buf)
      const filename = slugify(att.title?.replace(/\.[a-z0-9]+$/i, '') || att.id, 60) + ext
      const outPath = join(assetDir, filename)
      save(outPath, buf, { quiet: true })
      map.set(att.title, filename)
      map.set(att.id, filename)
    } catch (err) {
      console.warn(`  ⚠ attachment "${att.title}": ${err.message.split('\n')[0]}`)
    }
  }
  return map
}

/** Replace Confluence's <ac:image><ri:attachment ri:filename="..."/></ac:image> with <img src="…">. */
function rewriteImageRefs(storageHtml, attMap, assetDirName) {
  return storageHtml.replace(
    /<ac:image[^>]*>\s*<ri:attachment\s+ri:filename="([^"]+)"[^>]*\/?>\s*<\/ac:image>/gi,
    (_, filename) => {
      const local = attMap.get(filename)
      if (!local) return `<!-- missing attachment: ${filename} -->`
      return `<img class="shot" src="${assetDirName}/${local}" alt="${filename}">`
    }
  ).replace(
    /<img[^>]+src="([^"]+)"[^>]*>/gi,
    (m, src) => {
      // If src already points at an attachment, try to map by filename
      const fn = basename(src.split('?')[0])
      const local = attMap.get(fn)
      if (local) return m.replace(src, `${assetDirName}/${local}`)
      return m
    }
  )
}

function applyTemplate(templateName, vars) {
  const tplPath = join(TEMPLATE_DIR, `${templateName}.html`)
  if (!existsSync(tplPath)) {
    throw new Error(`Unknown template "${templateName}". Available templates in: ${TEMPLATE_DIR}`)
  }
  let html = readFileSync(tplPath, 'utf8')
  for (const [key, value] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, value ?? '')
  }
  return html
}

export async function renderPage({
  auth, pageId, template = 'mirror', asMarkdown = false, outPath, repoRoot,
  fetchPageMeta, fetchPageBody, fetchPageAttachments,
}) {
  console.log(`📄 Fetching page ${pageId}…`)
  const meta = await fetchPageMeta(auth, pageId)
  const title = meta.title
  const slug = slugify(title)
  const spaceKey = meta.space?.key || ''
  const url = `${auth.base}/wiki/spaces/${spaceKey}/pages/${pageId}`
  const lastMod = meta.version?.when ? new Date(meta.version.when).toLocaleDateString() : 'Unknown'
  const ancestors = (meta.ancestors ?? []).map(a => a.title).join(' > ')

  const body = meta.body?.storage?.value ?? await fetchPageBody(auth, pageId)
  if (!body) throw new Error(`Page ${pageId} has empty body (or you lack read permission)`)

  // Always apply the safety pipeline to single-page exports — these often land in
  // `docs/` and get committed, so AV-bait bytes here pollute every CI clone.
  const rules = loadSafetyRules(repoRoot, loadProjectConfig(repoRoot))
  let pageLabels = []
  try {
    const labelData = await atlassianFetch(auth, `/wiki/rest/api/content/${pageId}/label?limit=200`, { allowNotFound: true })
    pageLabels = (labelData?.results || []).map(l => String(l.name || '').toLowerCase())
  } catch { /* labels are best-effort */ }

  const { body: redactedStorage, redactions } = redactBody(body, rules)
  const classification = classifyPage({ title, labels: pageLabels, body, rules })
  if (classification.dangerous) {
    console.warn(`⚠️  Page ${pageId} ("${title}") classified as dangerous (${classification.reasons.map(r => r.kind + ':' + r.value).join(', ')}).`)
    console.warn(`   Single-page export proceeds with full body redaction. To skip-and-quarantine,`)
    console.warn(`   use bulk sync (\`sync\` / \`subtree\` / \`space\`) instead of \`page\`.`)
  }
  if (redactions.length) {
    console.warn(`   Redactions applied: ${redactions.map(r => `${r.id}(${r.count})`).join(', ')}`)
  }

  if (asMarkdown) {
    const md = storageToMarkdown(redactedStorage)
    const out = outPath || join(repoRoot, 'docs', `${slug}.md`)
    const front = `# ${title}\n\n> **Path:** ${ancestors ? ancestors + ' > ' + title : title}  \n> **URL:** ${url}  \n> **Last modified:** ${lastMod}  \n> **Synced:** ${new Date().toISOString()}\n\n---\n\n`
    save(out, front + md)
    console.log(`\n✓ Markdown saved to ${out}`)
    return
  }

  // HTML mode: also fetch attachments and rewrite image refs
  console.log(`  • Fetching attachments…`)
  const attachments = await fetchPageAttachments(auth, pageId)
  console.log(`    found ${attachments.length}`)
  const outHtml = outPath || join(repoRoot, 'docs', `${slug}.html`)
  const assetDirName = `_${slug}_assets`
  const assetDir = join(dirname(outHtml), assetDirName)
  ensureDir(assetDir)

  const attMap = attachments.length ? await downloadAttachments(auth, pageId, attachments, assetDir) : new Map()
  const renderedBody = rewriteImageRefs(redactedStorage, attMap, assetDirName)

  const html = applyTemplate(template, {
    TITLE: escapeHtml(title),
    ANCESTORS: escapeHtml(ancestors || title),
    URL: url,
    LAST_MODIFIED: lastMod,
    SYNCED: new Date().toISOString(),
    BODY: renderedBody,
    SLUG: slug,
  })

  save(outHtml, html)
  console.log(`\n✓ HTML saved to ${outHtml}`)
  if (attachments.length) console.log(`  + ${attachments.length} assets in ${assetDir}`)
  if (template === 'checklist') {
    console.log('\nNote: --template checklist works best on procedural docs (steps/instructions).')
    console.log('      Plain pages may need manual touch-up to make checkboxes meaningful.')
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
