import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')))
const docxPath = path.resolve(valueOf('--docx', ''))
const userDataDir = path.resolve(valueOf('--user-data-dir', path.join(root, 'release', `smoke-user-data-document-context-${process.pid}`)))
const port = Number(valueOf('--port', '19349'))
if (!fs.existsSync(executable) || !fs.existsSync(docxPath)) throw new Error(`缺少安装包或真实文档：${executable} / ${docxPath}`)
fs.mkdirSync(userDataDir, { recursive: true })

// 用独立 userData 强制本地 2K 模型，避免读写用户现有模型设置。
fs.writeFileSync(path.join(userDataDir, 'model-config.json'), JSON.stringify({
  schemaVersion: 2,
  roles: { chat: { providerId: 'bundled-lite', model: 'ai-player-qwen2.5-0.5b', baseUrl: 'http://127.0.0.1:11555/v1', encryptedApiKey: '' } }
}, null, 2))

const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], { cwd: path.dirname(executable), windowsHide: true, shell: false })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let socket
let nextId = 0
const pending = new Map()

async function page() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      if (pages[0]?.webSocketDebuggerUrl) return pages[0]
    } catch {}
    await delay(250)
  }
  throw new Error('桌面页未就绪')
}

function command(method, params = {}) {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result?.value
}

try {
  const target = await page()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await command('Runtime.enable')
  await delay(3000)
  const result = await evaluate(`(async () => {
    const first = await window.aiPlayer.documents.attachPaths([${JSON.stringify(docxPath)}])
    const second = await window.aiPlayer.documents.attachPaths([${JSON.stringify(docxPath)}])
    const plan = await window.aiPlayer.documents.plan({ tokens: [first[0].token, second[0].token], instruction: '整理成 Word', outputFormat: 'docx' })
    return { first, second, plan }
  })()`)
  const plan = result?.plan || {}
  if (plan.files?.length !== 1) throw new Error(`重试附件未去重：${JSON.stringify(result)}`)
  if (!(plan.estimatedTokens > plan.contextWindow) || plan.processingMode !== 'local-chunked') {
    throw new Error(`2K 模型未进入长文分段：${JSON.stringify(result)}`)
  }
  process.stdout.write(`${JSON.stringify({
    file: plan.files[0].name,
    deduplicatedFileCount: plan.files.length,
    estimatedTokens: plan.estimatedTokens,
    contextWindow: plan.contextWindow,
    processingMode: plan.processingMode,
    cloudApprovalRequired: plan.requiresCloudApproval
  })}\n`)
  socket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} }))
  await delay(1000)
} finally {
  try { socket?.close() } catch {}
  if (child.exitCode === null) child.kill()
}
