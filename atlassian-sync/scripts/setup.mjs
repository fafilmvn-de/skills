// Interactive cookie/credential setup. Writes to ~/.atlassian-sync/.env.
//
// Invoked by sync-atlassian.mjs as:
//   node setup.mjs            -> first-time setup
//   node setup.mjs --renew    -> renew expired session cookie

import { createInterface } from 'readline'
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { GLOBAL_ENV_DIR, GLOBAL_ENV_PATH, buildAuthHeaders, atlassianFetch, loadEnv, findRepoRoot } from './lib.mjs'

const RENEW = process.argv.includes('--renew')

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(resolve => rl.question(q, a => resolve(a.trim())))

function readExisting() {
  if (!existsSync(GLOBAL_ENV_PATH)) return {}
  const out = {}
  for (const line of readFileSync(GLOBAL_ENV_PATH, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i === -1) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function writeEnv(values) {
  if (!existsSync(GLOBAL_ENV_DIR)) mkdirSync(GLOBAL_ENV_DIR, { recursive: true })
  const lines = [
    '# Atlassian sync credentials',
    '# Managed by: skills/atlassian-sync/scripts/setup.mjs',
    `# Last updated: ${new Date().toISOString()}`,
    '',
    `ATLASSIAN_BASE_URL=${values.ATLASSIAN_BASE_URL}`,
    '',
    '# Browser session auth (works behind enterprise SSO)',
    `ATLASSIAN_SESSION_COOKIE=${values.ATLASSIAN_SESSION_COOKIE || ''}`,
    `ATLASSIAN_XSRF_TOKEN=${values.ATLASSIAN_XSRF_TOKEN || ''}`,
    '',
    '# Optional API-token auth (only if your org allows it)',
    `ATLASSIAN_EMAIL=${values.ATLASSIAN_EMAIL || ''}`,
    `ATLASSIAN_API_TOKEN=${values.ATLASSIAN_API_TOKEN || ''}`,
    '',
  ]
  writeFileSync(GLOBAL_ENV_PATH, lines.join('\n'), { mode: 0o600 })
  console.log(`\n✓ Wrote ${GLOBAL_ENV_PATH} (mode 0600)`)
}

async function pingAuth() {
  loadEnv(findRepoRoot())
  const auth = buildAuthHeaders()
  console.log(`\n🔍 Testing connectivity (${auth.mode}) against ${auth.base}…`)
  try {
    const me = await atlassianFetch(auth, '/wiki/rest/api/user/current')
    console.log(`  ✓ Confluence: ${me.displayName || me.username || 'logged in'}`)
  } catch (err) {
    console.log(`  ✗ Confluence: ${err.message.split('\n')[0]}`)
    return false
  }
  try {
    const me = await atlassianFetch(auth, '/rest/api/3/myself')
    console.log(`  ✓ Jira: ${me.displayName} (${me.emailAddress || 'no email'})`)
  } catch (err) {
    console.log(`  ⚠ Jira: ${err.message.split('\n')[0]} (Jira access optional)`)
  }
  return true
}

async function main() {
  const existing = readExisting()
  const baseDefault = existing.ATLASSIAN_BASE_URL || 'https://your-org.atlassian.net'

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(RENEW ? '🔄  Renew Atlassian session cookie' : '🔧  Atlassian sync — first-time setup')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
  console.log('Steps to get your session cookie:')
  console.log('')
  console.log('  1. Open Chrome and log into', baseDefault)
  console.log('  2. Press F12 to open DevTools')
  console.log('  3. Go to the "Application" tab → Cookies → ' + baseDefault.replace(/^https?:\/\//, ''))
  console.log('  4. Copy these two values:')
  console.log('       a) cloud.session.token  (or tenant.session.token)')
  console.log('       b) atlassian.xsrf.token')
  console.log('')
  console.log('⚠️  These are bearer credentials — anyone with them can act as you in')
  console.log('   Confluence/Jira until they expire. Do not paste them into chat or commit.')
  console.log('')

  const base = (await ask(`Atlassian base URL [${baseDefault}]: `)) || baseDefault

  let cookieRaw
  while (true) {
    cookieRaw = await ask('Paste cloud.session.token value (or full "name=value"): ')
    if (cookieRaw) break
    console.log('  ↳ Required. Try again.')
  }
  const cookie = cookieRaw.includes('=')
    ? cookieRaw
    : `cloud.session.token=${cookieRaw}`

  const xsrf = await ask('Paste atlassian.xsrf.token value (optional, recommended): ')

  writeEnv({
    ATLASSIAN_BASE_URL: base,
    ATLASSIAN_SESSION_COOKIE: cookie,
    ATLASSIAN_XSRF_TOKEN: xsrf,
    ATLASSIAN_EMAIL: existing.ATLASSIAN_EMAIL,
    ATLASSIAN_API_TOKEN: existing.ATLASSIAN_API_TOKEN,
  })

  const ok = await pingAuth()
  rl.close()
  if (!ok) {
    console.log('\n✗ Auth still failing. Common causes:')
    console.log('  • Pasted a stale cookie (re-login in Chrome and copy fresh values)')
    console.log('  • Pasted the wrong cookie name (need cloud.session.token, not __Secure-* etc.)')
    console.log('  • XSRF token mismatch (paste both from the same DevTools session)')
    process.exit(1)
  }
  console.log('\n✓ Setup complete. Try:')
  console.log('  node skills/atlassian-sync/scripts/sync-atlassian.mjs page <url>')
}

main().catch(err => { console.error(err.message || err); process.exit(1) })
