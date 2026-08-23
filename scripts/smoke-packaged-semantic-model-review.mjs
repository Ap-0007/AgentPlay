import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'semantic-model-review-packaged', 'receipt.json')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-semantic-model-'))
const mediaDir = path.join(profileDir, 'media')
const sourcePath = path.join(mediaDir, 'semantic-model-source.mp4')
const subtitlePath = path.join(mediaDir, 'semantic-model-source.srt')
const userDataRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player')
const ffmpegRoot = path.join(userDataRoot, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpegPath = path.join(ffmpegRoot, 'bin', 'ffmpeg.exe')
const ffprobePath = path.join(ffmpegRoot, 'bin', 'ffprobe.exe')
const instruction = '删掉语义重复和跑题内容'
if (![executable, ffmpegPath, ffprobePath].every(fs.existsSync)) throw new Error('缺少安装态语义模型审阅验收组件')

const modelPayload = {
  topicSummary: '产品价格、功能与价值介绍',
  candidates: [
    { type: 'near_duplicate', cueIndexes: [2, 3], removeCueIndexes: [3], confidence: 0.94, reason: '两句表达相同价格信息', evidence: [{ cueIndex: 2, quote: '价格是一百元' }, { cueIndex: 3, quote: '卖一百块钱' }] },
    { type: 'off_topic', cueIndexes: [4], removeCueIndexes: [4], confidence: 0.96, reason: '与产品介绍主旨无关', evidence: [{ cueIndex: 4, quote: '昨晚吃了火锅' }] }
  ]
}
const visualPayload = { validations: [
  { candidateIndex: 1, verdict: 'safe', confidence: 0.93, reason: '候选前后场景连续，中间没有独有演示动作', evidenceLabels: ['candidate-1-before', 'candidate-1-middle', 'candidate-1-after', 'candidate-1-reference'] },
  { candidateIndex: 2, verdict: 'safe', confidence: 0.92, reason: '候选前后场景连续，中间没有独有产品证据', evidenceLabels: ['candidate-2-before', 'candidate-2-middle', 'candidate-2-after'] }
] }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const probeDuration = (filePath) => Number(String(spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8', windowsHide: true }).stdout).trim()) || 0
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs = 5000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }

fs.mkdirSync(mediaDir, { recursive: true })
fs.mkdirSync(path.join(profileDir, 'yt-dlp'), { recursive: true })
fs.symlinkSync(ffmpegRoot, path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build'), 'junction')
const generated = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x27455F:s=640x360:r=25:d=10', '-f', 'lavfi', '-i', 'sine=frequency=520:sample_rate=48000:duration=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath], { encoding: 'utf8', windowsHide: true })
if (generated.status !== 0 || !fs.existsSync(sourcePath)) throw new Error(generated.stderr || '语义审阅视频夹具生成失败')
fs.writeFileSync(subtitlePath, `1\n00:00:00,500 --> 00:00:01,600\n今天介绍这款产品\n\n2\n00:00:01,800 --> 00:00:03,000\n这款产品的价格是一百元\n\n3\n00:00:03,200 --> 00:00:04,400\n这款产品卖一百块钱\n\n4\n00:00:04,600 --> 00:00:05,800\n顺便说我昨晚吃了火锅\n\n5\n00:00:06,000 --> 00:00:07,400\n接下来介绍产品功能\n\n6\n00:00:07,600 --> 00:00:09,000\n最后总结产品价值\n`, 'utf8')
const sourceHash = sha256(sourcePath)

const modelPort = await freePort(); const modelRequests = []
const modelServer = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
  let body = ''; request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk }); request.on('end', () => {
    const parsed = JSON.parse(body); const serialized = JSON.stringify(parsed); const visual = serialized.includes('image_url')
    const prompt = (parsed.messages || []).map((item) => typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).join('\n')
    modelRequests.push({ kind: visual ? 'vision' : 'text', prompt })
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(visual ? visualPayload : modelPayload) } }], usage: { prompt_tokens: 320, completion_tokens: 180 } }))
  })
})
await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(modelPort, '127.0.0.1', resolve) })

const debugPort = await freePort()
const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400', sourcePath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) { if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`); try { const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); page = pages.find((item) => item.type === 'page'); if (page?.webSocketDebuggerUrl) break } catch {}; await delay(250) }
  if (!page?.webSocketDebuggerUrl) throw new Error('候选应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let nextId = 0
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => { const id = ++nextId; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable')
  const pageResult = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const waitFor = async (probe, label, timeoutMs = 120000) => { const started = Date.now(); while (Date.now() - started < timeoutMs) { const value = await probe(); if (value) return value; await wait(100) } throw new Error('等待超时：' + label) }
    const initial = await waitFor(() => { const input = document.querySelector('.agent-composer input[type="text"]'); const video = document.querySelector('video[data-ai-player-video="true"]'); return input && video && video.readyState >= 1 ? { duration: video.duration } : null }, '视频与对话就绪', 60000)
    const savedModel = await window.aiPlayer.models.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.5-flash', baseUrl: ${JSON.stringify(`http://127.0.0.1:${modelPort}/v1`)}, apiKey: 'packaged-smoke-key' })
    if (savedModel.providerId !== 'agnes' || !savedModel.hasApiKey) throw new Error('安装态视觉模型配置失败')
    const input = document.querySelector('.agent-composer input[type="text"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(instruction)}); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(instruction)} })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    await waitFor(() => document.body.innerText.includes('语义近似重复') && document.body.innerText.includes('疑似跑题') && document.body.innerText.includes('镜头交叉验证：2 个候选通过') && document.body.innerText.includes('请回复“确认执行”或“取消”'), '字幕与镜头交叉确认方案可见', 120000)
    const before = (await window.aiPlayer.taskRuntime.list()).filter((item) => item.type === 'media.edit-concat').length
    if (before !== 0) throw new Error('确认前不应创建语义模型剪辑任务')
    setter.call(input, '确认执行'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '确认执行' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const task = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const found = [...items].reverse().find((item) => item.type === 'media.edit-concat'); return found && ['completed','failed','cancelled'].includes(found.state) ? found : null }, '模型语义剪辑任务完成', 180000)
    if (task.state !== 'completed' || task.quality?.passed !== true || task.result?.semanticCut?.strategy !== 'model-semantic-review-v1' || task.result?.semanticCut?.removed?.length !== 2 || task.result?.semanticCut?.visualEvidence?.safeCandidateIndexes?.length !== 2) throw new Error(task.error || '字幕与镜头交叉剪辑质量门失败')
    const preview = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - task.spec.decision.timeline.durationSeconds) <= 0.25 ? { duration: video.duration } : null }, '自动预览语义精简成片', 30000)
    setter.call(input, '撤销刚才的剪辑'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '撤销刚才的剪辑' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const undo = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - initial.duration) <= 0.25 ? { duration: video.duration } : null }, '模型语义剪辑撤销回原片', 30000)
    return { initial, task, preview, undo, body: document.body.innerText }
  })()`)
  const textRequests = modelRequests.filter((item) => item.kind === 'text'); const visionRequests = modelRequests.filter((item) => item.kind === 'vision')
  if (textRequests.length !== 1 || visionRequests.length !== 1 || !textRequests[0].prompt.includes('[2][1.80-3.00]') || !textRequests[0].prompt.includes('只能引用以上字幕序号') || !visionRequests[0].prompt.includes('candidate-1-reference')) throw new Error('安装态模型没有收到唯一的字幕请求和完整镜头请求')
  const outputPath = pageResult.task.result.outputPath
  const receipt = { acceptedAt: new Date().toISOString(), executable, source: { path: sourcePath, durationSeconds: probeDuration(sourcePath), sha256: sourceHash, unchanged: sha256(sourcePath) === sourceHash }, modelCalls: modelRequests.length, textCalls: textRequests.length, visionCalls: visionRequests.length, decision: pageResult.task.spec.decision, result: { outputPath, durationSeconds: probeDuration(outputPath), quality: pageResult.task.quality }, ui: { confirmationVisible: pageResult.body.includes('请回复“确认执行”或“取消”'), visualEvidenceVisible: pageResult.body.includes('镜头交叉验证：2 个候选通过'), previewDuration: pageResult.preview.duration, undoDuration: pageResult.undo.duration } }
  if (!receipt.source.unchanged || !fs.existsSync(outputPath)) throw new Error('安装态语义模型成果或原件保护失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, modelCalls: receipt.modelCalls, textCalls: receipt.textCalls, visionCalls: receipt.visionCalls, removed: receipt.decision.semanticCut.removed.length, textModel: receipt.decision.semanticCut.modelEvidence.model, visionModel: receipt.decision.semanticCut.visualEvidence.model, quality: receipt.result.quality.score, outputDuration: receipt.result.durationSeconds, undoDuration: receipt.ui.undoDuration, sourceUnchanged: true })}\n`)
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  await new Promise((resolve) => modelServer.close(resolve))
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}
