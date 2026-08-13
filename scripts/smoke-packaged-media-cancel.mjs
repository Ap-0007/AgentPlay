import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const sourceArg = process.argv.slice(2).find((value) => value.startsWith('--source='))
const useRealProfile = process.argv.includes('--real-profile')
const executable = executableArg ? path.resolve(executableArg.slice('--exe='.length)) : ''
const sourcePath = sourceArg ? path.resolve(sourceArg.slice('--source='.length)) : ''
const profileDir = useRealProfile ? '' : fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-media-cancel-'))
const requestId = `compress-cancel-smoke-${Date.now()}`
const port = 19483

if (!executable || !fs.existsSync(executable)) throw new Error(`缺少正式 EXE：${executable}`)
if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error(`缺少取消验收视频：${sourcePath}`)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

const launchArgs = [
  `--remote-debugging-port=${port}`,
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--window-position=-2400,-2400'
]
if (profileDir) launchArgs.push(`--user-data-dir=${profileDir}`)
const child = spawn(executable, launchArgs, { cwd: path.dirname(executable), windowsHide: true, shell: false })

let websocket
let command
const sourceDir = path.dirname(sourcePath)
const outputPrefix = `${path.parse(sourcePath).name}-AgentPlay`
const listOutputs = () => fs.readdirSync(sourceDir)
  .filter((name) => name.startsWith(outputPrefix) && name.toLowerCase().endsWith('.mp4'))
  .sort()
const outputsBefore = listOutputs()

try {
  let page
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`正式 EXE 提前退出：${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('正式 EXE 没有在 60 秒内开放验收页面')

  websocket = new WebSocket(page.webSocketDebuggerUrl)
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
  command = (method, params = {}) => {
    const id = ++nextId
    websocket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const evaluate = async (expression, awaitPromise = false) => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || '页面表达式执行失败')
    return response.result?.value
  }
  await command('Runtime.enable')
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await evaluate(`document.readyState === 'complete' && Boolean(window.aiPlayer?.mediaTools?.cancel)`)) break
    await delay(250)
  }

  const failClosed = await evaluate(`(async () => ({
    version: window.aiPlayer?.version,
    missingMedia: await window.aiPlayer.mediaTools.cancel('missing-media-request'),
    missingCreative: await window.aiPlayer.studio.cancelTask('missing-creative-request')
  }))()`, true)

  const cancellation = await evaluate(`(async () => {
    const startedAt = Date.now()
    const work = window.aiPlayer.mediaTools.compress({
      sourcePath: ${JSON.stringify(sourcePath)},
      targetMb: 25,
      mode: 'compress',
      requestId: ${JSON.stringify(requestId)}
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const cancelConfirmed = await window.aiPlayer.mediaTools.cancel(${JSON.stringify(requestId)})
    const result = await work
    return { cancelConfirmed, result, elapsedMs: Date.now() - startedAt }
  })()`, true)
  await delay(750)
  const outputsAfter = listOutputs()
  const newOutputs = outputsAfter.filter((name) => !outputsBefore.includes(name))
  const result = { executable, sourcePath, failClosed, cancellation, outputsBefore, outputsAfter, newOutputs }
  if (failClosed.version !== '0.8.0' || failClosed.missingMedia !== false || failClosed.missingCreative !== false) {
    throw new Error(`取消接口没有 fail-close：${JSON.stringify(result)}`)
  }
  if (!cancellation.cancelConfirmed || cancellation.result?.success !== false || cancellation.result?.cancelled !== true || cancellation.result?.error !== '已取消' || newOutputs.length > 0) {
    throw new Error(`正式 EXE 媒体取消验收失败：${JSON.stringify(result)}`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  try { await Promise.race([command?.('Browser.close'), delay(1500)]) } catch {}
  await waitForChildExit(child, 8000)
  if (child.exitCode === null) {
    child.kill()
    await waitForChildExit(child, 5000)
  }
  try { websocket?.close() } catch {}
  const extraOutputs = listOutputs().filter((name) => !outputsBefore.includes(name))
  for (const name of extraOutputs) {
    const candidate = path.join(sourceDir, name)
    if (path.dirname(candidate) === sourceDir && path.basename(candidate).startsWith(outputPrefix)) fs.rmSync(candidate, { force: true })
  }
  if (profileDir) {
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    const resolvedProfile = path.resolve(profileDir)
    if (resolvedProfile.startsWith(tempRoot) && path.basename(resolvedProfile).startsWith('agentplay-media-cancel-')) {
      fs.rmSync(resolvedProfile, { recursive: true, force: true })
    }
  }
}
