import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const screenshotArg = process.argv.slice(2).find((value) => value.startsWith('--screenshot='))
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const screenshotPath = screenshotArg
  ? path.resolve(screenshotArg.slice('--screenshot='.length))
  : path.join(os.tmpdir(), 'agentplay-packaged-task-recovery.png')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-task-recovery-'))
const testTaskId = `smoke-interrupted-${Date.now()}`
const testTaskLabel = '冷启动恢复验收任务'
const expectedError = '应用上次关闭时任务尚未完成，请确认源内容后重试。'

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
  await command('Page.enable')
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await evaluate(`document.readyState === 'complete' && Boolean(window.aiPlayer?.version)`)) break
    await delay(250)
  }
  return { child, websocket, command, evaluate }
}

async function closeSession(session) {
  try {
    // Chromium may tear down the WebSocket before acknowledging Browser.close.
    // Bound that command so the smoke test can still observe the process exit.
    await Promise.race([session.command('Browser.close'), delay(1500)])
  } catch {}
  await waitForChildExit(session.child, 8000)
  if (session.child.exitCode === null) {
    session.child.kill()
    await waitForChildExit(session.child, 5000)
  }
  try { session.websocket.close() } catch {}
}

let firstSession
let secondSession
try {
  firstSession = await openSession(19481)
  const firstLaunch = await firstSession.evaluate(`(() => {
    const text = document.body.innerText
    return {
      version: window.aiPlayer?.version,
      hasAiHome: text.includes('一个入口，完成整件事') && text.includes('把任何事情交给我'),
      hasTaskCenterEntry: text.includes('任务与结果'),
      hasCapabilityDrawer: Boolean(document.querySelector('[aria-label="全部能力"]'))
    }
  })()`)
  if (firstLaunch.version !== expectedVersion || !firstLaunch.hasAiHome || !firstLaunch.hasTaskCenterEntry || !firstLaunch.hasCapabilityDrawer) {
    throw new Error(`新版桌面首页验收失败：${JSON.stringify(firstLaunch)}`)
  }

  const seeded = await firstSession.evaluate(`(() => {
    const now = Date.now()
    const task = {
      id: ${JSON.stringify(testTaskId)},
      kind: 'download',
      label: ${JSON.stringify(testTaskLabel)},
      phase: 'running',
      running: true,
      status: '正在下载 2/5',
      progress: 40,
      outputs: [],
      summary: '',
      error: '',
      instruction: '验证应用关闭后的任务恢复',
      source: 'https://example.invalid/smoke-video',
      retry: { kind: 'download', url: 'https://example.invalid/smoke-video', direct: true },
      createdAt: now,
      updatedAt: now,
      completedAt: null
    }
    const value = JSON.stringify({ state: { tasks: [task], activeTaskId: task.id }, version: 1 })
    localStorage.setItem('agentplay-workspace-tasks', value)
    return JSON.parse(localStorage.getItem('agentplay-workspace-tasks')).state.tasks[0]
  })()`)
  if (seeded.phase !== 'running' || seeded.id !== testTaskId) throw new Error('未能持久化执行中的测试任务')
  await delay(750)
  await closeSession(firstSession)
  firstSession = null

  secondSession = await openSession(19482)
  let recovered
  for (let attempt = 0; attempt < 120; attempt++) {
    recovered = await secondSession.evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('agentplay-workspace-tasks') || '{}')
      const task = stored?.state?.tasks?.find((item) => item.id === ${JSON.stringify(testTaskId)})
      return task ? { phase: task.phase, running: task.running, error: task.error } : null
    })()`)
    if (recovered?.phase === 'interrupted') break
    await delay(250)
  }

  const visible = await secondSession.evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    document.querySelector('[aria-label="最近任务"]')?.click()
    await wait(150)
    const recentText = document.querySelector('[aria-label="最近任务"]')?.parentElement?.parentElement?.innerText || document.body.innerText
    const item = [...document.querySelectorAll('button')].find((button) => button.innerText.includes(${JSON.stringify(testTaskLabel)}))
    item?.click()
    await wait(200)
    const center = document.querySelector('[aria-label="任务与结果中心"]')
    return {
      recentHasTask: recentText.includes(${JSON.stringify(testTaskLabel)}),
      recentHasInterrupted: recentText.includes('已中断，可重试'),
      centerVisible: Boolean(center),
      centerHasTask: Boolean(center?.innerText.includes(${JSON.stringify(testTaskLabel)})),
      centerHasInterrupted: Boolean(center?.innerText.includes('已中断')),
      centerHasError: Boolean(center?.innerText.includes(${JSON.stringify(expectedError)})),
      centerHasRetry: Boolean(center?.innerText.includes('再次执行'))
    }
  })()`, true)

  const screenshot = await secondSession.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))

  const result = { executable, expectedVersion, firstLaunch, seededPhase: seeded.phase, recovered, visible, screenshotPath }
  if (recovered?.phase !== 'interrupted' || recovered.running !== false || recovered.error !== expectedError || !Object.values(visible).every(Boolean)) {
    throw new Error(`冷启动任务恢复验收失败：${JSON.stringify(result)}`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  if (firstSession) await closeSession(firstSession)
  if (secondSession) await closeSession(secondSession)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolvedProfile = path.resolve(profileDir)
  if (resolvedProfile.startsWith(tempRoot) && path.basename(resolvedProfile).startsWith('agentplay-task-recovery-')) {
    fs.rmSync(resolvedProfile, { recursive: true, force: true })
  }
}
