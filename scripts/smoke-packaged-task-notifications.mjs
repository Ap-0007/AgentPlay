import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { ProjectCapsuleStore } = require('../electron/project-capsule-store')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback = '') => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')))
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort(host = '127.0.0.1') {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    const match = (entries || []).find((item) => item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))
    if (match) return match.address
  }
  return '0.0.0.0'
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-notification-smoke-'))
const fixtureDir = path.join(profileDir, 'fixtures'); fs.mkdirSync(fixtureDir)
const onePath = path.join(fixtureDir, '材料一.txt')
const twoPath = path.join(fixtureDir, '材料二.txt')
const documentPath = path.join(fixtureDir, '完成通知来源.txt')
fs.writeFileSync(onePath, '一月收入100万。', 'utf8')
fs.writeFileSync(twoPath, '一月收入100万，二月未提供。', 'utf8')
fs.writeFileSync(documentPath, '这是一份用于验收 Windows 完成通知和成果回开的本地文档。', 'utf8')
const projectStore = new ProjectCapsuleStore({ rootDir: path.join(profileDir, 'project-capsules') })
projectStore.recordTask({ projectId: 'project-notification-smoke', taskId: 'seed', type: 'project.seed', instruction: '建立通知验收项目', sources: [onePath, twoPath], outputs: [] })

const apiPort = await freePort('0.0.0.0'); const debugPort = await freePort()
const host = lanAddress()
fs.writeFileSync(path.join(profileDir, 'model-config.json'), JSON.stringify({
  schemaVersion: 3,
  roles: { chat: { providerId: 'custom', model: 'notification-smoke', baseUrl: `http://${host}:${apiPort}/v1`, encryptedApiKey: '' } },
  profiles: { chat: [{ providerId: 'custom', model: 'notification-smoke', baseUrl: `http://${host}:${apiPort}/v1`, encryptedApiKey: '' }] }
}, null, 2), 'utf8')

const calls = []
const apiServer = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const prompt = (body.messages || []).map((item) => String(item.content || '')).join('\n')
  calls.push(prompt)
  if (prompt.includes('触发失败通知')) {
    await delay(1800)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: '{"claims":[{"text":"无引用结论","status":"confirmed","evidenceIds":[]}]}' } }] }))
    return
  }
  await delay(3200)
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Windows 完成通知验收', content: '# 验收结果\n- 真实文档任务已完成并生成可回开的 Word 成果。', factIds: ['F1'] }) } }], usage: { prompt_tokens: 60, completion_tokens: 30 } }))
})
await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(apiPort, '0.0.0.0', resolve) })

const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400'], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket; let nextId = 0; const pending = new Map()
const command = (method, params = {}) => { const id = ++nextId; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
const evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value }

try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try { const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); page = pages.find((item) => item.type === 'page'); if (page?.webSocketDebuggerUrl) break } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('待验收应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await command('Runtime.enable'); await delay(2500)

  const waiting = await evaluate(`(async () => {
    const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(onePath)}])
    return window.aiPlayer.crossMaterial.ask({ tokens: [attached[0].token], question: '对比这些材料，是否一致？', cloudApproved: false, requestId: 'notification-waiting', workspaceTaskId: 'workspace-notification-waiting' })
  })()`)
  if (!waiting.requiresApproval || calls.length !== 0) throw new Error('待审批通知失去真实审批边界')
  await evaluate(`window.aiPlayer.crossMaterial.cancel('notification-waiting')`)
  await evaluate(`(async () => {
    await window.aiPlayer.models.save({ role: 'chat', providerId: 'custom', model: 'notification-smoke', baseUrl: ${JSON.stringify(`http://127.0.0.1:${apiPort}/v1`)}, apiKey: '' })
    await window.aiPlayer.models.routingSettings({ preference: 'local', objective: 'quality' })
  })()`)

  const completed = await evaluate(`(async () => {
    const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(documentPath)}])
    return window.aiPlayer.documents.run({ tokens: [attached[0].token], instruction: '请生成完成通知验收 Word 报告', outputFormat: 'docx', cloudApproved: false, requestId: 'notification-completed', workspaceTaskId: 'workspace-notification-completed' })
  })()`)
  if (!completed.success || completed.quality?.score !== 100 || !completed.outputs?.[0] || !fs.existsSync(completed.outputs[0])) throw new Error(`完成通知的真实文档任务失败：${JSON.stringify(completed)}`)

  const failed = await evaluate(`(async () => {
    const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(onePath)}])
    return window.aiPlayer.crossMaterial.ask({ tokens: [attached[0].token], question: '对比这些材料并触发失败通知？', cloudApproved: false, requestId: 'notification-failed', workspaceTaskId: 'workspace-notification-failed' })
  })()`)
  if (failed.success !== false || !failed.error) throw new Error('失败通知没有来自真实失败任务')

  const records = await evaluate(`window.aiPlayer.notifications.history()`)
  const selected = Object.fromEntries(['notification-waiting', 'notification-completed', 'notification-failed'].map((id) => [id, records.find((item) => item.runtimeTaskId === id)]))
  for (const id of Object.keys(selected)) if (!selected[id]) throw new Error(`缺少 ${id} 通知回执`)
  if (selected['notification-waiting'].state !== 'waiting_approval' || selected['notification-completed'].state !== 'completed' || selected['notification-failed'].state !== 'failed') throw new Error('通知状态与持久任务不一致')
  if (!Object.values(selected).every((item) => item.nativeSupported && item.nativeShown)) throw new Error(`Windows 原生通知未真实调用：${JSON.stringify(selected)}`)
  if (selected['notification-completed'].body.includes(path.dirname(completed.outputs[0])) || !selected['notification-completed'].body.includes(path.basename(completed.outputs[0]))) throw new Error('完成通知泄露了完整路径或缺少成果名')

  const navigation = await evaluate(`(async () => {
    window.__notificationNavigation = null
    window.__notificationReopen = ''
    window.addEventListener('agentplay-notification-navigated', (event) => { window.__notificationNavigation = event.detail }, { once: true })
    window.addEventListener('ai-player-play-file', (event) => { window.__notificationReopen = event.detail }, { once: true })
    const activated = await window.aiPlayer.notifications.activate(${JSON.stringify(selected['notification-completed'].id)})
    await new Promise((resolve) => setTimeout(resolve, 800))
    return { activated, navigated: window.__notificationNavigation, reopened: window.__notificationReopen, body: document.body.innerText }
  })()`)
  if (!navigation.activated || navigation.navigated?.workspaceTaskId !== 'workspace-notification-completed' || navigation.reopened !== completed.outputs[0]) throw new Error(`通知点击未回到原任务和成果：${JSON.stringify(navigation)}`)
  if (!navigation.body.includes('请生成完成通知验收 Word 报告') || !navigation.body.includes(path.basename(completed.outputs[0])) || !navigation.body.includes('已根据要求生成文档')) throw new Error(`通知点击界面未回到原对话与成果：${JSON.stringify({ navigated: navigation.navigated, reopened: navigation.reopened, body: navigation.body.slice(0, 4000) })}`)

  const after = await evaluate(`window.aiPlayer.notifications.history()`)
  const activatedRecord = after.find((item) => item.id === selected['notification-completed'].id)
  if (!activatedRecord?.activatedAt) throw new Error('通知点击没有持久回执')
  process.stdout.write(`${JSON.stringify({ states: Object.fromEntries(Object.entries(selected).map(([id, item]) => [id, { state: item.state, title: item.title, nativeShown: item.nativeShown }])), output: { path: completed.outputs[0], bytes: fs.statSync(completed.outputs[0]).size }, activation: { workspaceTaskId: navigation.navigated.workspaceTaskId, reopened: navigation.reopened, activatedAt: activatedRecord.activatedAt }, modelCalls: calls.length })}\n`)
  try { socket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} })) } catch {}
  await delay(500)
} finally {
  try { socket?.close() } catch {}
  if (child.exitCode === null) child.kill()
  await new Promise((resolve) => apiServer.close(resolve))
  try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch {}
}
