import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueOf = (name, fallback = '') => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', 'C:\\Program Files\\ai-player\\AgentPlay\\AgentPlay.exe'))
const sourceUserData = path.join(process.env.APPDATA || '', 'ai-player')
const sourceLocalAi = path.join(sourceUserData, 'local-ai')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-chat-abort-repro-'))
const stagedLocalAi = path.join(profileDir, 'local-ai')
if (!fs.existsSync(executable) || !fs.existsSync(path.join(sourceLocalAi, 'models', 'Qwen2.5-0.5B-Instruct-Q4_0.gguf'))) throw new Error('缺少安装EXE或内置模型包')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve)); return port
}
async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true) }) })
}

fs.symlinkSync(sourceLocalAi, stagedLocalAi, 'junction')
fs.writeFileSync(path.join(profileDir, 'model-config.json'), JSON.stringify({
  schemaVersion: 2,
  roles: {
    chat: { providerId: 'bundled-lite', model: 'ai-player-qwen2.5-0.5b', baseUrl: 'http://127.0.0.1:11555/v1', encryptedApiKey: '' }
  }
}, null, 2), 'utf8')

const port = await freePort()
const child = spawn(executable, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  '--window-position=-2400,-2400'
], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`应用提前退出：${child.exitCode}`)
    try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = pages.find((item) => item.type === 'page'); if (page?.webSocketDebuggerUrl) break } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map(); let nextId = 0
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => { const id = ++nextId; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable')
  const result = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    for (let attempt = 0; attempt < 600 && !window.aiPlayer?.ai?.chat; attempt += 1) await wait(100)
    if (!window.aiPlayer?.ai?.chat || !window.aiPlayer?.models?.startBundled) throw new Error('聊天桥接未就绪')
    const status = await window.aiPlayer.models.startBundled()
    if (!status.running) throw new Error(status.reason || '内置模型未启动')
    const firstStartedAt = Date.now()
    const first = await window.aiPlayer.ai.chat([{ role: 'user', content: '你是谁？你都能做什么？' }], null, 'chat-repro-first', { mode: 'work' })
    const secondStartedAt = Date.now()
    const second = await Promise.race([
      window.aiPlayer.ai.chat([
        { role: 'user', content: '你是谁？你都能做什么？' },
        { role: 'assistant', content: first.text },
        { role: 'user', content: '具体都能完成什么任务？' }
      ], null, 'chat-repro-second', { mode: 'work' }),
      wait(70000).then(() => ({ text: 'HARNESS_TIMEOUT_70000MS' }))
    ])
    const exactAbort = /\[网络错误\]\s*This operation was aborted/.test(second.text || '')
    const timedOut = second.text === 'HARNESS_TIMEOUT_70000MS'
    if (exactAbort || timedOut) throw new Error((exactAbort ? 'REPRODUCED_CHAT_ABORT: ' : 'REPRODUCED_CHAT_HANG: ') + second.text)
    const sendViaUi = async (text) => {
      const before = document.querySelectorAll('[data-chat-message="agent"]').length
      const input = document.querySelector('.agent-composer input[type="text"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, text); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); await wait(50)
      document.querySelector('button[aria-label="发送"]')?.click()
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const agents = [...document.querySelectorAll('[data-chat-message="agent"]')]
        const latest = agents.at(-1)?.textContent?.trim() || ''
        if (agents.length > before && latest && latest !== '思考中…') return latest
        await wait(50)
      }
      throw new Error('UI回复等待超时：' + text)
    }
    const uiFirst = await sendViaUi('你是谁？你都能做什么？')
    const uiSecond = await sendViaUi('具体都能完成什么任务？')
    if (/This operation was aborted|\[网络错误\]/.test(uiFirst + uiSecond)) throw new Error('REPRODUCED_UI_CHAT_ABORT')
    return { first: first.text, second: second.text, uiFirst, uiSecond, firstMs: secondStartedAt - firstStartedAt, secondMs: Date.now() - secondStartedAt, exactAbort, timedOut }
  })()`)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  try { if (fs.lstatSync(stagedLocalAi).isSymbolicLink()) fs.unlinkSync(stagedLocalAi) } catch {}
  const resolved = path.resolve(profileDir); const tempBase = `${path.resolve(os.tmpdir())}${path.sep}`
  if (resolved.startsWith(tempBase) && path.basename(resolved).startsWith('agentplay-chat-abort-repro-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
    catch (error) { process.stderr.write(`临时复现目录稍后由系统清理：${error.message}\n`) }
  }
}
