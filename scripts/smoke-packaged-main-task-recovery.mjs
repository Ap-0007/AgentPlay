import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const urlArg = process.argv.slice(2).find((value) => value.startsWith('--url='))
const executable = executableArg
  ? path.resolve(executableArg.slice('--exe='.length))
  : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const mediaUrl = urlArg?.slice('--url='.length) || 'https://media.w3.org/2010/05/sintel/trailer.mp4'
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-main-recovery-'))
const runtimeDir = path.join(profileDir, 'task-runtime')
const startedAt = Date.now()
const taskId = `smoke-recovery-${Date.now()}`
const workspaceTaskId = `workspace-${taskId}`
const spec = { url: mediaUrl }

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForExit(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      processHandle.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    processHandle.once('exit', onExit)
  })
}

function safeRemoveCreatedFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return
  const resolved = path.resolve(filePath)
  const stat = fs.statSync(resolved)
  if (path.basename(path.dirname(resolved)) === 'AgentPlay 下载' && stat.mtimeMs >= startedAt) fs.rmSync(resolved, { force: true })
}

if (!fs.existsSync(executable)) throw new Error(`缺少桌面候选：${executable}`)
fs.mkdirSync(runtimeDir, { recursive: true })
fs.writeFileSync(path.join(runtimeDir, 'task-runtime-secret.bin'), crypto.randomBytes(32))
fs.writeFileSync(path.join(runtimeDir, 'task-runtime-v1.json'), JSON.stringify({
  version: 1,
  tasks: [{
    id: taskId,
    workspaceTaskId,
    type: 'download.direct',
    state: 'running',
    spec,
    specHash: crypto.createHash('sha256').update(canonical(spec)).digest('hex'),
    checkpoint: {},
    result: null,
    error: '',
    status: '模拟进程中断',
    approval: null,
    attempts: 1,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 500,
    startedAt: Date.now() - 1000,
    completedAt: null
  }]
}, null, 2), 'utf8')

const port = 19531
const child = spawn(executable, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--window-position=-2400,-2400'
], { cwd: path.dirname(executable), windowsHide: true, shell: false })

let websocket
let outputPath = ''
try {
  let page
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child.exitCode !== null) throw new Error(`桌面候选提前退出：${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('桌面候选未开放验收页面')
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
    if (await evaluate(`Boolean(window.aiPlayer?.taskRuntime?.list)`)) break
    await delay(250)
  }
  let task
  for (let attempt = 0; attempt < 360; attempt++) {
    task = await evaluate(`window.aiPlayer.taskRuntime.list().then((items) => items.find((item) => item.id === ${JSON.stringify(taskId)}))`, true)
    if (task?.state === 'completed' || task?.state === 'failed' || task?.state === 'cancelled') break
    await delay(250)
  }
  outputPath = String(task?.result?.outputPath || '')
  const result = {
    executable,
    taskId,
    state: task?.state,
    attempts: task?.attempts,
    status: task?.status,
    error: task?.error,
    outputPath,
    outputExists: Boolean(outputPath && fs.existsSync(outputPath)),
    bytes: outputPath && fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0
  }
  if (result.state !== 'completed' || result.attempts !== 2 || !result.outputExists || result.bytes <= 0) {
    throw new Error(`主进程冷启动恢复验收失败：${JSON.stringify(result)}`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  await Promise.race([command('Browser.close'), delay(1500)]).catch(() => {})
} finally {
  if (!(await waitForExit(child, 5000))) {
    child.kill()
    await waitForExit(child, 5000)
  }
  try { websocket?.close() } catch {}
  safeRemoveCreatedFile(outputPath)
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolvedProfile = path.resolve(profileDir)
  if (resolvedProfile.startsWith(tempRoot) && path.basename(resolvedProfile).startsWith('agentplay-main-recovery-')) {
    try {
      fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      process.stderr.write(`临时验收目录稍后由系统清理：${error.message}\n`)
    }
  }
}
