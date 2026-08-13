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
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-shell-model-'))
const port = 19483

if (!fs.existsSync(executable)) throw new Error(`缺少正式 EXE：${executable}`)

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
    if (child.exitCode !== null) throw new Error(`正式 EXE 提前退出：${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('正式 EXE 没有在 60 秒内开放验收页面')

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
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || '页面表达式执行失败')
    return response.result?.value
  }

  await command('Runtime.enable')
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await evaluate(`document.readyState === 'complete' && Boolean(window.aiPlayer?.version)`)) break
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
  session = await openSession()
  const result = await session.evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const clickable = () => [...document.querySelectorAll('button, [role="button"], a')]
    const menuGetter = window.aiPlayer?.windowControls?.isPlaybackChromeVisible
    const menuVisible = typeof menuGetter === 'function' ? await menuGetter() : null
    const privacy = clickable().find((item) => item.textContent?.includes('运行与隐私'))
    privacy?.click()
    await wait(250)
    const modelEntry = clickable().find((item) => item.textContent?.includes('配置云端模型') || item.textContent?.includes('模型接入中心'))
    modelEntry?.click()
    await wait(350)
    const text = document.body.innerText
    const cloudMarkers = ['云端模型', 'OpenAI', 'Anthropic', 'Gemini', 'API Key', 'OpenAI 兼容']
      .filter((marker) => text.includes(marker))
    const localMarkers = ['本地模型', 'Ollama', 'LM Studio', 'llama.cpp']
      .filter((marker) => text.includes(marker))
    return {
      version: window.aiPlayer?.version,
      menuVisible,
      privacyEntryFound: Boolean(privacy),
      modelEntryFound: Boolean(modelEntry),
      cloudMarkers,
      localMarkers,
      visibleText: text.slice(0, 5000)
    }
  })()`, true)

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  const failures = []
  if (result.menuVisible !== false) failures.push(`首页原生菜单仍可见：${result.menuVisible}`)
  if (!result.privacyEntryFound || !result.modelEntryFound) failures.push('云端模型配置无法从运行与隐私抵达')
  if (result.cloudMarkers.length === 0) failures.push('模型接入页没有可识别的云端模型配置')
  if (failures.length > 0) throw new Error(failures.join('；'))
} finally {
  if (session) await closeSession(session)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolvedProfile = path.resolve(profileDir)
  if (resolvedProfile.startsWith(tempRoot) && path.basename(resolvedProfile).startsWith('agentplay-shell-model-')) {
    fs.rmSync(resolvedProfile, { recursive: true, force: true })
  }
}
