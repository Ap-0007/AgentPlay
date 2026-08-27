import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback = '') => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')))
const receiptPath = path.resolve(valueOf('--receipt', path.join(root, 'artifacts', 'acceptance', 'background-delivery-e5', 'receipt.json')))
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256File = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}

async function startApp(profileDir) {
  const debugPort = await freePort()
  const child = spawn(executable, [
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling', '--window-position=-2400,-2400'
  ], { cwd: path.dirname(executable), windowsHide: true, shell: false })
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('候选应用未开放调试页')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map(); let nextId = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data); const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => {
    const id = ++nextId
    socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const evaluate = async (expression, awaitPromise = true) => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  }
  await command('Runtime.enable')
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await evaluate('Boolean(window.aiPlayer?.taskRuntime?.list)', false)) return { child, socket, command, evaluate }
    await delay(250)
  }
  throw new Error('候选应用桥接未就绪')
}

async function stopApp(session, closeGracefully = false) {
  try {
    if (closeGracefully) await Promise.race([session.command('Browser.close'), delay(1000)])
  } catch {}
  try { session.socket.close() } catch {}
  if (session.child.exitCode === null) session.child.kill()
  await waitForExit(session.child)
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-background-e5-'))
const sourcePath = path.join(profileDir, '后台恢复经营资料.txt')
fs.writeFileSync(sourcePath, '1月收入100，成本80。后台任务必须在崩溃后继续，并回开同一成果。', 'utf8')
const apiPort = await freePort()
fs.writeFileSync(path.join(profileDir, 'model-config.json'), JSON.stringify({
  schemaVersion: 3,
  roles: { chat: { providerId: 'custom', model: 'e5-loopback', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' } },
  profiles: { chat: [{ providerId: 'custom', model: 'e5-loopback', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' }] }
}, null, 2), 'utf8')

const modelCalls = []
const apiServer = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const prompt = (body.messages || []).map((item) => String(item.content || '')).join('\n')
  const kind = prompt.includes('本次只生成 DOCX') ? 'docx' : prompt.includes('本次只生成 XLSX') ? 'xlsx' : 'other'
  modelCalls.push({ kind, at: Date.now() })
  if (kind === 'xlsx' && modelCalls.filter((item) => item.kind === 'xlsx').length === 1) await delay(4000)
  const content = kind === 'xlsx'
    ? { sheets: [{ name: '月度数据', rows: [['月份', '收入', '成本'], ['1月', 100, 80]] }], factIds: ['F1'] }
    : { title: '后台恢复验收', content: '# 核心数据\n- 1月收入100，成本80。', factIds: ['F1'] }
  if (response.destroyed) return
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 50, completion_tokens: 25 } }))
})
await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(apiPort, '127.0.0.1', resolve) })

const runtimeTaskId = 'e5-crash-recovery'
const workspaceTaskId = 'workspace-e5-crash-recovery'
const expiredTaskId = 'e5-expired-approval'
let first
let second
let outputs = []
try {
  first = await startApp(profileDir)
  void first.evaluate(`(async () => {
    const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(sourcePath)}])
    return window.aiPlayer.documents.run({
      tokens: [attached[0].token], instruction: '做成一套 Word 报告和 Excel 分析表', outputFormat: 'auto',
      cloudApproved: false, requestId: ${JSON.stringify(runtimeTaskId)}, workspaceTaskId: ${JSON.stringify(workspaceTaskId)}
    })
  })()`).catch(() => {})

  let beforeCrash
  for (let attempt = 0; attempt < 600; attempt += 1) {
    beforeCrash = await first.evaluate(`window.aiPlayer.taskRuntime.list().then((items) => items.find((item) => item.id === ${JSON.stringify(runtimeTaskId)}))`)
    if (beforeCrash?.checkpoint?.bundle?.sections?.docx) break
    if (['completed', 'failed', 'cancelled'].includes(beforeCrash?.state)) throw new Error(`任务未进入可恢复崩溃点：${JSON.stringify(beforeCrash)}`)
    await delay(100)
  }
  if (!beforeCrash?.checkpoint?.bundle?.sections?.docx || beforeCrash.state !== 'running') throw new Error('没有捕获到已完成 DOCX、XLSX 仍在运行的检查点')
  const callsAtCrash = modelCalls.map((item) => item.kind)
  await stopApp(first, false)
  first = null

  const statePath = path.join(profileDir, 'task-runtime', 'task-runtime-v1.json')
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const expiredSpec = { sources: [], question: '审批过期不得继续执行' }
  const expiredAt = Date.now() - 1000
  persisted.tasks.push({
    id: expiredTaskId, workspaceTaskId: 'workspace-e5-expired-approval', type: 'project.evidence-qa', state: 'waiting_approval',
    spec: expiredSpec, specHash: crypto.createHash('sha256').update(canonical(expiredSpec)).digest('hex'), checkpoint: {}, result: null,
    quality: null, failure: null, repairHistory: [], error: '', status: '等待确认', attempts: 0,
    approval: { id: 'approval-e5-expired', action: 'cloud', summary: '把提取片段发送给云端', status: 'pending', createdAt: expiredAt - 1000, expiresAt: expiredAt, consumedAt: null },
    createdAt: expiredAt - 1000, updatedAt: expiredAt - 1000, startedAt: null, completedAt: null
  })
  fs.writeFileSync(statePath, JSON.stringify(persisted, null, 2), 'utf8')

  second = await startApp(profileDir)
  let recovered
  let expired
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const tasks = await second.evaluate('window.aiPlayer.taskRuntime.list()')
    recovered = tasks.find((item) => item.id === runtimeTaskId)
    expired = tasks.find((item) => item.id === expiredTaskId)
    if (recovered?.state === 'completed' && expired?.state === 'failed') break
    if (recovered && ['failed', 'cancelled'].includes(recovered.state)) throw new Error(`崩溃恢复失败：${JSON.stringify(recovered)}`)
    await delay(100)
  }
  outputs = recovered?.result?.outputs || []
  if (recovered?.attempts !== 2 || outputs.length !== 2 || !outputs.every((item) => fs.existsSync(item))) throw new Error(`崩溃重启成果不完整：${JSON.stringify(recovered)}`)
  if (expired?.approval?.status !== 'expired' || !/审批令牌已经过期/.test(expired?.error || '')) throw new Error(`审批过期没有失败关闭：${JSON.stringify(expired)}`)
  if (modelCalls.filter((item) => item.kind === 'docx').length !== 1) throw new Error(`已完成的模型步骤被重复调用：${JSON.stringify(modelCalls)}`)

  let notifications
  for (let attempt = 0; attempt < 240; attempt += 1) {
    notifications = await second.evaluate('window.aiPlayer.notifications.history()')
    if (notifications.some((item) => item.runtimeTaskId === runtimeTaskId && item.state === 'completed') && notifications.some((item) => item.runtimeTaskId === expiredTaskId && item.state === 'failed')) break
    await delay(100)
  }
  const completionNotice = notifications.find((item) => item.runtimeTaskId === runtimeTaskId && item.state === 'completed')
  const expiryNotice = notifications.find((item) => item.runtimeTaskId === expiredTaskId && item.state === 'failed')
  if (!completionNotice?.nativeShown || !expiryNotice?.nativeShown) throw new Error(`安装态系统通知不完整：${JSON.stringify(notifications)}`)

  const activation = await second.evaluate(`(async () => {
    window.__e5Navigation = null; window.__e5Reopened = ''
    window.addEventListener('agentplay-notification-navigated', (event) => { window.__e5Navigation = event.detail }, { once: true })
    window.addEventListener('ai-player-play-file', (event) => { window.__e5Reopened = event.detail }, { once: true })
    await window.aiPlayer.notifications.activate(${JSON.stringify(completionNotice.id)})
    for (let attempt = 0; attempt < 100 && (!window.__e5Navigation || !window.__e5Reopened); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50))
    window.dispatchEvent(new CustomEvent('agentplay-open-task-center'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    return { workspaceTaskId: window.__e5Navigation?.workspaceTaskId || '', reopened: window.__e5Reopened || '', body: document.body.innerText }
  })()`)
  if (activation.workspaceTaskId !== workspaceTaskId || path.resolve(activation.reopened) !== path.resolve(outputs[0])) throw new Error(`通知没有回到原任务和成果：${JSON.stringify(activation)}`)
  if (!activation.body.includes('后台恢复验收') && !activation.body.includes('文档任务')) throw new Error('任务中心没有显示恢复任务')

  const receipt = {
    acceptedAt: new Date().toISOString(), executable, executableSha256: sha256File(executable),
    crash: { state: beforeCrash.state, checkpointStage: beforeCrash.checkpoint?.stage, completedSections: Object.keys(beforeCrash.checkpoint.bundle.sections), callsAtCrash },
    recovery: { state: recovered.state, attempts: recovered.attempts, checkpointStage: recovered.checkpoint?.stage, outputs: outputs.map((item) => ({ path: item, bytes: fs.statSync(item).size, sha256: sha256File(item) })) },
    approvalExpiry: { state: expired.state, approvalStatus: expired.approval.status, error: expired.error, notificationShown: expiryNotice.nativeShown },
    notification: { state: completionNotice.state, nativeShown: completionNotice.nativeShown, workspaceTaskId: activation.workspaceTaskId, reopened: activation.reopened },
    modelCalls: modelCalls.map((item) => item.kind), sourceUnchanged: sha256File(sourcePath)
  }
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, crash: receipt.crash, recovery: receipt.recovery, approvalExpiry: receipt.approvalExpiry, notification: receipt.notification, modelCalls: receipt.modelCalls })}\n`)
} finally {
  if (first) await stopApp(first, false)
  if (second) await stopApp(second, true)
  await new Promise((resolve) => apiServer.close(resolve))
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolved = path.resolve(profileDir)
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('agentplay-background-e5-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  }
}
