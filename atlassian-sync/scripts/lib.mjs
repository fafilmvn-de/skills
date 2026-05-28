// Shared helpers for atlassian-sync skill.
// - Dual env loading (user-global at ~/.atlassian-sync/.env + repo-local override)
// - Auth header construction (cookie+XSRF preferred, API token fallback)
// - atlassianFetch wrapper with 401 detection that points at `setup --renew`
// - Storage → markdown converter
// - Cross-platform path helpers

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

export const GLOBAL_ENV_DIR = join(homedir(), '.atlassian-sync')
export const GLOBAL_ENV_PATH = join(GLOBAL_ENV_DIR, '.env')

/** Find the repo root by walking up from cwd looking for .git or .atlassian-sync.json. */
export function findRepoRoot(start = process.cwd()) {
  let dir = start
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, '.git')) ||
        existsSync(join(dir, '.atlassian-sync.json'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

/** Load .env from user-global first, then repo-local. Repo-local wins on key conflicts. */
export function loadEnv(repoRoot) {
  const sources = [
    GLOBAL_ENV_PATH,
    join(repoRoot, '.env'),  // repo-local override
  ]
  let foundAny = false
  for (const p of sources) {
    if (!existsSync(p)) continue
    foundAny = true
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
      process.env[key] = value
    }
  }
  return foundAny
}

/** Build auth headers. Throws a UX-friendly error if no creds are configured. */
export function buildAuthHeaders() {
  const cookie = process.env.ATLASSIAN_SESSION_COOKIE
  const xsrf = process.env.ATLASSIAN_XSRF_TOKEN
  const email = process.env.ATLASSIAN_EMAIL
  const token = process.env.ATLASSIAN_API_TOKEN
  const base = process.env.ATLASSIAN_BASE_URL
  if (!base) {
    throw new Error(
      'ATLASSIAN_BASE_URL is not set.\n' +
      'Run `node scripts/setup.mjs` to configure it, or add the following to ~/.atlassian-sync/.env:\n' +
      '  ATLASSIAN_BASE_URL=https://your-org.atlassian.net'
    )
  }

  if (token && token !== 'your_api_token_here') {
    if (!email) throw new Error('ATLASSIAN_EMAIL required when using API token. Run `setup` or edit ~/.atlassian-sync/.env.')
    const auth = Buffer.from(`${email}:${token}`).toString('base64')
    return {
      base,
      mode: 'apitoken',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    }
  }
  if (cookie) {
    const cookieHeader = xsrf ? `${cookie}; atlassian.xsrf.token=${xsrf}` : cookie
    const headers = {
      Cookie: cookieHeader,
      Accept: 'application/json',
      'X-Atlassian-Token': 'no-check',
    }
    if (xsrf) headers['X-Acpt'] = xsrf
    return { base, mode: 'cookie', headers }
  }
  throw new Error(
    'No Atlassian credentials configured.\n' +
    '  Run: node skills/atlassian-sync/scripts/sync-atlassian.mjs setup\n' +
    '  (Or set ATLASSIAN_SESSION_COOKIE / ATLASSIAN_API_TOKEN in ~/.atlassian-sync/.env)'
  )
}

export class AuthExpiredError extends Error {
  constructor(url) {
    super(
      'Auth rejected by Atlassian (401/403/redirect-to-login). Your session cookie has likely expired.\n' +
      '  Run: node skills/atlassian-sync/scripts/sync-atlassian.mjs setup --renew\n' +
      `  Failing URL: ${url}`
    )
    this.name = 'AuthExpiredError'
  }
}

/** Fetch wrapper that uses headers from buildAuthHeaders and detects 401/403/redirect-to-login. */
export async function atlassianFetch(auth, path, { allowNotFound = false, raw = false } = {}) {
  const url = path.startsWith('http') ? path : `${auth.base}${path}`
  const res = await fetch(url, { headers: auth.headers, redirect: 'manual' })
  if (res.status === 401 || res.status === 403) throw new AuthExpiredError(url)
  if (res.status === 302 || res.status === 301) {
    const loc = res.headers.get('location') || ''
    if (loc.includes('id.atlassian.com') || loc.includes('login') || loc.includes('auth')) {
      throw new AuthExpiredError(url)
    }
  }
  if (!res.ok) {
    if (allowNotFound && res.status === 404) return null
    const body = await res.text()
    throw new Error(`${res.status} ${res.statusText} — ${url}\n${body.slice(0, 400)}`)
  }
  return raw ? res : res.json()
}

/** Atlassian "storage" XHTML → rough markdown. */
export function storageToMarkdown(html) {
  if (!html) return ''
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n')
    .replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n')
    .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em>(.*?)<\/em>/gi, '_$1_')
    .replace(/<i>(.*?)<\/i>/gi, '_$1_')
    .replace(/<code>(.*?)<\/code>/gi, '`$1`')
    .replace(/<li[^>]*>(.*?)<\/li>/gis, '- $1\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gis, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function save(filePath, content, opts = {}) {
  ensureDir(dirname(filePath))
  if (typeof content === 'string') {
    writeFileSync(filePath, content, 'utf8')
  } else {
    writeFileSync(filePath, content)
  }
  if (!opts.quiet) console.log(`  ✓ ${filePath}`)
}

export function slugify(s, maxLen = 80) {
  return String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, maxLen)
}

/** Extract page ID from a Confluence URL or return the input if it already looks like an ID. */
export function extractPageId(input) {
  if (/^\d+$/.test(input)) return input
  const m = String(input).match(/\/pages\/(\d+)/)
  if (m) return m[1]
  throw new Error(`Could not extract page ID from: ${input}`)
}

/** Read .atlassian-sync.json from repo root if present; return {} otherwise. */
export function loadProjectConfig(repoRoot) {
  const p = join(repoRoot, '.atlassian-sync.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (err) {
    console.warn(`⚠️  ${p} is not valid JSON: ${err.message}`)
    return {}
  }
}
