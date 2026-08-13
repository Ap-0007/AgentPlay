import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ai-player', 'AgentPlay.exe')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-service-credentials-'))
const secret = `agentplay-smoke-${crypto.randomUUID()}`

if (!fs.existsSync(executable)) throw new Error(`missing installed executable: ${executable}`)

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function openSession(port) {
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-position=-2400,-2400'
  ], { cwd: path.dirname(executable), windowsHide: true, shell: false })

  let page
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`installed app exited early: ${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('installed app did not expose a verification page within 60 seconds')

  const websocket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 0
  websocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    websocket.addEventListener('open', resolve, { once: true })
    websocket.addEventListener('error', reject, { once: true })
  })

  const command = (method, params = {}) => {
    const id = ++nextId
    websocket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const evaluate = async (expression, awaitPromise = false) => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'page expression failed')
    return response.result?.value
  }

  await command('Runtime.enable')
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await evaluate(`document.readyState === 'complete' && Boolean(window.aiPlayer?.serviceCredentials?.status)`)) break
    await delay(250)
  }
  return { child, websocket, command, evaluate }
}

async function closeSession(session) {
  try { await Promise.race([session.command('Browser.close'), delay(1500)]) } catch {}
  await waitForChildExit(session.child, 8000)
  if (session.child.exitCode === null) {
    session.child.kill()
    await waitForChildExit(session.child, 5000)
  }
  try { session.websocket.close() } catch {}
}

let first
let second
let third
try {
  first = await openSession(19488)
  const saved = await first.evaluate(`(async () => {
    const initial = await window.aiPlayer.serviceCredentials.status()
    const tmdb = await window.aiPlayer.serviceCredentials.save({ service: 'tmdb', key: ${JSON.stringify(secret)} })
    const subtitles = await window.aiPlayer.serviceCredentials.save({ service: 'opensubtitles', key: ${JSON.stringify(secret)} })
    return {
      initialTmdb: initial.services.tmdb.hasKey,
      initialSubtitles: initial.services.opensubtitles.hasKey,
      savedTmdb: tmdb.services.tmdb.hasKey,
      savedSubtitles: subtitles.services.opensubtitles.hasKey,
      responseLeakedSecret: JSON.stringify({ tmdb, subtitles }).includes(${JSON.stringify(secret)})
    }
  })()`, true)
  await closeSession(first)
  first = null

  const credentialPath = path.join(profileDir, 'service-credentials.json')
  if (!fs.existsSync(credentialPath)) throw new Error('installed app did not persist the encrypted credential file')
  const raw = fs.readFileSync(credentialPath, 'utf8')

  second = await openSession(19489)
  const persisted = await second.evaluate(`(async () => {
    const status = await window.aiPlayer.serviceCredentials.status()
    const clearedTmdb = await window.aiPlayer.serviceCredentials.save({ service: 'tmdb', clear: true })
    const clearedSubtitles = await window.aiPlayer.serviceCredentials.save({ service: 'opensubtitles', clear: true })
    localStorage.setItem('aiplayer_tmdb_key', ${JSON.stringify(secret)})
    localStorage.setItem('aiplayer_subtitle_key', ${JSON.stringify(secret)})
    return {
      tmdb: status.services.tmdb,
      opensubtitles: status.services.opensubtitles,
      clearedTmdb: clearedTmdb.services.tmdb.hasKey,
      clearedSubtitles: clearedSubtitles.services.opensubtitles.hasKey
    }
  })()`, true)
  await closeSession(second)
  second = null

  third = await openSession(19490)
  const migrated = await third.evaluate(`(async () => {
    let status
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await window.aiPlayer.serviceCredentials.status()
      if (status.services.tmdb.hasKey && status.services.opensubtitles.hasKey
        && localStorage.getItem('aiplayer_tmdb_key') === null
        && localStorage.getItem('aiplayer_subtitle_key') === null) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const legacyTmdbRemoved = localStorage.getItem('aiplayer_tmdb_key') === null
    const legacySubtitlesRemoved = localStorage.getItem('aiplayer_subtitle_key') === null
    await window.aiPlayer.serviceCredentials.save({ service: 'tmdb', clear: true })
    await window.aiPlayer.serviceCredentials.save({ service: 'opensubtitles', clear: true })
    return { status, legacyTmdbRemoved, legacySubtitlesRemoved }
  })()`, true)
  const migratedRaw = fs.readFileSync(credentialPath, 'utf8')

  const failures = []
  if (saved.initialTmdb || saved.initialSubtitles) failures.push('isolated profile was not empty')
  if (!saved.savedTmdb || !saved.savedSubtitles) failures.push('save did not report both credentials')
  if (saved.responseLeakedSecret) failures.push('renderer response exposed the secret')
  if (raw.includes(secret)) failures.push('credential file contains plaintext')
  if (!/encryptedKey/.test(raw)) failures.push('credential file has no encrypted records')
  if (!persisted.tmdb.hasKey || !persisted.opensubtitles.hasKey) failures.push('credentials did not survive restart')
  if (persisted.tmdb.source !== 'system' || persisted.opensubtitles.source !== 'system') failures.push('persisted credentials do not report system storage')
  if (persisted.clearedTmdb || persisted.clearedSubtitles) failures.push('clear did not remove stored credentials')
  if (!migrated.status.services.tmdb.hasKey || !migrated.status.services.opensubtitles.hasKey) failures.push('legacy renderer credentials were not migrated')
  if (!migrated.legacyTmdbRemoved || !migrated.legacySubtitlesRemoved) failures.push('legacy plaintext remained after migration')
  if (migratedRaw.includes(secret)) failures.push('migrated credential file contains plaintext')
  if (failures.length) throw new Error(failures.join('; '))

  process.stdout.write(`${JSON.stringify({
    version: await third.evaluate('window.aiPlayer.version'),
    initiallyEmpty: true,
    encryptedAtRest: true,
    rendererSecretLeak: false,
    persistedAfterRestart: true,
    source: 'system',
    clearVerified: true,
    legacyMigrationVerified: true
  }, null, 2)}\n`)
} finally {
  if (first) await closeSession(first)
  if (second) await closeSession(second)
  if (third) await closeSession(third)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolvedProfile = path.resolve(profileDir)
  if (resolvedProfile.startsWith(tempRoot) && path.basename(resolvedProfile).startsWith('agentplay-service-credentials-')) {
    fs.rmSync(resolvedProfile, { recursive: true, force: true })
  }
}
