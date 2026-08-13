import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-plugin-skill-'))
const pluginSource = path.join(root, 'examples', 'agentplay-plugin-video-notes')
const pluginTarget = path.join(profileDir, 'plugins', 'video-notes')
const port = 19491
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
fs.mkdirSync(path.dirname(pluginTarget), { recursive: true })
fs.cpSync(pluginSource, pluginTarget, { recursive: true })

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, timeoutMs)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    child.once('exit', onExit)
  })
}

const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--window-position=-2400,-2400'
], { cwd: path.dirname(executable), windowsHide: true, shell: false })

let websocket
let nextId = 0
const pending = new Map()

try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`EXE 提前退出：${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('EXE 未在 60 秒内开放验收页面')

  websocket = new WebSocket(page.webSocketDebuggerUrl)
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
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  }

  await command('Runtime.enable')
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await evaluate(`document.readyState === 'complete' && Boolean(window.aiPlayer?.plugin?.list)`)) break
    await delay(250)
  }

  const result = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const initial = await window.aiPlayer.plugin.list()
    const installed = initial.find((item) => item.id === 'video-notes')
    const enabledResult = await window.aiPlayer.plugin.setEnabled({ id: 'video-notes', enabled: true, permissions: ['app.read'] })
    const enabled = enabledResult.plugins?.find((item) => item.id === 'video-notes')
    window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'plugins' }))
    await wait(800)
    const bodyText = document.body.innerText
    const disabledResult = await window.aiPlayer.plugin.setEnabled({ id: 'video-notes', enabled: false, permissions: [] })
    const disabled = disabledResult.plugins?.find((item) => item.id === 'video-notes')
    return {
      version: window.aiPlayer.version,
      initialDisabled: installed?.valid === true && installed?.enabled === false,
      enabled: enabledResult.success === true && enabled?.enabled === true,
      disabledAgain: disabledResult.success === true && disabled?.enabled === false,
      skillCount: enabled?.skillCount,
      toolCount: enabled?.toolCount,
      pluginUiVisible: bodyText.includes('插件与 Skill') && bodyText.includes('视频笔记助手')
    }
  })()`, true)

  const statePath = path.join(profileDir, 'plugins', '.agentplay-plugin-state.json')
  result.statePersisted = fs.existsSync(statePath)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  const failed = Object.entries({
    initialDisabled: result.initialDisabled,
    enabled: result.enabled,
    disabledAgain: result.disabledAgain,
    contributionCounts: result.skillCount === 1 && result.toolCount === 1,
    pluginUiVisible: result.pluginUiVisible,
    statePersisted: result.statePersisted
  }).filter(([, value]) => !value).map(([key]) => key)
  if (failed.length) throw new Error(`插件 / Skill 打包验收失败：${failed.join(', ')}`)

  await Promise.race([command('Browser.close'), delay(1500)])
  await waitForChildExit(child, 8000)
} finally {
  try { websocket?.close() } catch {}
  if (child.exitCode === null) {
    child.kill()
    await waitForChildExit(child, 5000)
  }
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolvedProfile = path.resolve(profileDir)
  if (resolvedProfile.startsWith(tempRoot) && path.basename(resolvedProfile).startsWith('agentplay-plugin-skill-')) {
    try { fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }) } catch {}
  }
}
