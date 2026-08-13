import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const videoRootArg = process.argv.slice(2).find((value) => value.startsWith('--video-root='))
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ai-player', 'AgentPlay.exe')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-dedup-cancel-profile-'))
const videoRoot = videoRootArg ? path.resolve(videoRootArg.slice('--video-root='.length)) : path.join(os.homedir(), 'Videos')
const fixtureDir = path.join(videoRoot, `AgentPlay-Dedup-Cancel-E2E-${process.pid}-${Date.now()}`)
const port = 19491

if (!fs.existsSync(executable)) throw new Error(`missing installed executable: ${executable}`)
if (!fs.existsSync(videoRoot) || !fs.statSync(videoRoot).isDirectory()) throw new Error(`missing video root: ${videoRoot}`)

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

function createFixture() {
  fs.mkdirSync(fixtureDir, { recursive: true })
  const original = path.join(fixtureDir, 'duplicate-000.mp4')
  const handle = fs.openSync(original, 'w')
  try {
    const block = crypto.randomBytes(1024 * 1024)
    for (let index = 0; index < 32; index += 1) fs.writeSync(handle, block)
  } finally {
    fs.closeSync(handle)
  }
  for (let index = 1; index <= 300; index += 1) {
    fs.linkSync(original, path.join(fixtureDir, `duplicate-${String(index).padStart(3, '0')}.mp4`))
  }
  return { files: 301, bytesPerFile: fs.statSync(original).size }
}

async function openSession() {
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
    if (await evaluate(`document.readyState === 'complete' && Boolean(window.aiPlayer?.media?.onDedupProgress)`)) break
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

let session
try {
  const fixture = createFixture()
  session = await openSession()
  const requestId = `dedup-e2e-${crypto.randomUUID()}`
  const result = await session.evaluate(`(async () => {
    const started = performance.now()
    const progress = []
    let cancelStarted = 0
    let cancelAck = null
    let cancelPromise = null
    const unsubscribe = window.aiPlayer.media.onDedupProgress((event) => {
      if (event.requestId !== ${JSON.stringify(requestId)}) return
      progress.push(event)
      if (event.phase === 'hashing' && !cancelPromise) {
        cancelStarted = performance.now()
        cancelPromise = window.aiPlayer.media.cancel(${JSON.stringify(requestId)}).then((value) => { cancelAck = value })
      }
    })
    try {
      const output = await window.aiPlayer.media.dedup({ requestId: ${JSON.stringify(requestId)}, dir: ${JSON.stringify(fixtureDir)} })
      if (cancelPromise) await cancelPromise
      return { output, progress, cancelAck, elapsedMs: performance.now() - started, cancelLatencyMs: cancelStarted ? performance.now() - cancelStarted : null }
    } finally {
      unsubscribe()
    }
  })()`, true)

  const hashing = result.progress.filter((item) => item.phase === 'hashing')
  const lastHashing = hashing.at(-1) || {}
  const failures = []
  if (result.cancelAck !== true) failures.push('backend did not acknowledge cancellation')
  if (!result.output?.cancelled || result.output?.error !== '已取消') failures.push('dedup result was not cancelled')
  if (!hashing.length) failures.push('hashing phase was never observed')
  if (Number(lastHashing.processedFiles || 0) >= Number(lastHashing.totalFiles || fixture.files)) failures.push('scan finished all candidate files after cancellation')
  if (result.elapsedMs > 10_000) failures.push(`cancellation took too long: ${Math.round(result.elapsedMs)}ms`)
  if (failures.length) throw new Error(failures.join('; '))

  process.stdout.write(`${JSON.stringify({
    version: await session.evaluate('window.aiPlayer.version'),
    fixtureFiles: fixture.files,
    logicalCandidateBytes: fixture.files * fixture.bytesPerFile,
    cancelAck: result.cancelAck,
    cancelled: result.output.cancelled,
    error: result.output.error,
    elapsedMs: Math.round(result.elapsedMs),
    cancelLatencyMs: Math.round(result.cancelLatencyMs || 0),
    processedFilesAtLastProgress: Number(lastHashing.processedFiles || 0),
    totalCandidateFiles: Number(lastHashing.totalFiles || 0)
  }, null, 2)}\n`)
} finally {
  if (session) await closeSession(session)
  const expectedVideoPrefix = path.resolve(videoRoot) + path.sep
  const resolvedFixture = path.resolve(fixtureDir)
  if (resolvedFixture.startsWith(expectedVideoPrefix) && path.basename(resolvedFixture).startsWith('AgentPlay-Dedup-Cancel-E2E-')) {
    fs.rmSync(resolvedFixture, { recursive: true, force: true })
  }
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolvedProfile = path.resolve(profileDir)
  if (resolvedProfile.startsWith(tempRoot) && path.basename(resolvedProfile).startsWith('agentplay-dedup-cancel-profile-')) {
    fs.rmSync(resolvedProfile, { recursive: true, force: true })
  }
}
