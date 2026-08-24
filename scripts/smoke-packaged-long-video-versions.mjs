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
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'long-video-versions-packaged', 'receipt.json')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-long-versions-'))
const mediaDir = path.join(profileDir, 'media')
const sourcePath = path.join(mediaDir, 'long-source.mp4')
const subtitlePath = path.join(mediaDir, 'long-source.srt')
const ffmpegRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpegPath = path.join(ffmpegRoot, 'bin', 'ffmpeg.exe')
const ffprobePath = path.join(ffmpegRoot, 'bin', 'ffprobe.exe')
const instruction = '把这个长视频做成短版、精华版、章节版和多个平台时长版本'
if (![executable, ffmpegPath, ffprobePath].every(fs.existsSync)) throw new Error('缺少安装态长视频多版本验收组件')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const probeDuration = (filePath) => Number(String(spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8', windowsHide: true }).stdout).trim()) || 0
const srtTime = (seconds) => { const ms = Math.round(seconds * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}` }
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs = 5000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }

fs.mkdirSync(mediaDir, { recursive: true }); fs.mkdirSync(path.join(profileDir, 'yt-dlp'), { recursive: true }); fs.symlinkSync(ffmpegRoot, path.join(profileDir, 'yt-dlp', path.basename(ffmpegRoot)), 'junction')
const built = spawnSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=72:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=72', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath], { timeout: 120000, encoding: 'utf8', windowsHide: true })
if (built.status !== 0 || !fs.existsSync(sourcePath)) throw new Error(built.stderr || '长视频夹具生成失败')
const cues = Array.from({ length: 12 }, (_, index) => ({ cueIndex: index + 1, startSeconds: index * 6, endSeconds: (index + 1) * 6, text: `第${index + 1}段真实字幕内容` }))
fs.writeFileSync(subtitlePath, cues.map((cue) => `${cue.cueIndex}\n${srtTime(cue.startSeconds)} --> ${srtTime(cue.endSeconds)}\n${cue.text}\n`).join('\n'), 'utf8')
const evidence = (indexes) => indexes.map((cueIndex) => ({ cueIndex, quote: cues[cueIndex - 1].text }))
const modelPayload = {
  summary: '从问题背景、解决方案到案例总结的完整产品讲解',
  chapters: [
    { title: '问题背景', startCueIndex: 1, endCueIndex: 4, importance: 0.8, reason: '交代问题', evidence: evidence([1, 4]) },
    { title: '解决方案', startCueIndex: 5, endCueIndex: 8, importance: 0.98, reason: '核心方案', evidence: evidence([5, 8]) },
    { title: '案例总结', startCueIndex: 9, endCueIndex: 12, importance: 0.9, reason: '案例结论', evidence: evidence([9, 12]) }
  ],
  highlights: [
    { startCueIndex: 2, endCueIndex: 3, importance: 0.99, reason: '关键问题', evidence: evidence([2, 3]) },
    { startCueIndex: 6, endCueIndex: 7, importance: 0.97, reason: '核心方案', evidence: evidence([6, 7]) },
    { startCueIndex: 10, endCueIndex: 11, importance: 0.92, reason: '案例结论', evidence: evidence([10, 11]) }
  ]
}
const sourceHash = sha256(sourcePath)
const modelPort = await freePort(); const modelRequests = []
const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
  let body = ''; request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk }); request.on('end', () => { modelRequests.push(JSON.parse(body)); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelPayload) } }], usage: { prompt_tokens: 800, completion_tokens: 500 } })) })
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(modelPort, '127.0.0.1', resolve) })

const port = await freePort(); const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400', sourcePath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) { if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`); try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = pages.find((item) => item.type === 'page'); if (page?.webSocketDebuggerUrl) break } catch {}; await delay(250) }
  if (!page?.webSocketDebuggerUrl) throw new Error('候选应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let nextId = 0
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => { const id = ++nextId; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable')
  const pageResult = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const waitFor = async (probe, label, timeoutMs = 180000) => { const started = Date.now(); while (Date.now() - started < timeoutMs) { const value = await probe(); if (value) return value; await wait(100) } throw new Error('等待超时：' + label) }
    await waitFor(() => { const input = document.querySelector('.agent-composer input[type="text"]'); const video = document.querySelector('video[data-ai-player-video="true"]'); return input && video && video.readyState >= 1 }, '视频与对话就绪', 60000)
    const saved = await window.aiPlayer.models.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.5-flash', baseUrl: ${JSON.stringify(`http://127.0.0.1:${modelPort}/v1`)}, apiKey: 'long-version-smoke-key' })
    if (!saved.hasApiKey) throw new Error('模型配置失败')
    const input = document.querySelector('.agent-composer input[type="text"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(instruction)}); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(instruction)} })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    await waitFor(() => document.body.innerText.includes('长视频多版本方案已完成，尚未执行') && document.body.innerText.includes('不会为每个版本重复调用模型') && document.body.innerText.includes('请回复“确认执行”或“取消”'), '多版本确认方案可见')
    const before = (await window.aiPlayer.taskRuntime.list()).filter((item) => item.type === 'media.version-bundle').length
    if (before !== 0) throw new Error('确认前不应创建多版本任务')
    setter.call(input, '确认执行'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '确认执行' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const task = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const found = [...items].reverse().find((item) => item.type === 'media.version-bundle'); return found && ['completed','failed','cancelled'].includes(found.state) ? found : null }, '多版本任务完成', 360000)
    if (task.state !== 'completed' || task.quality?.passed !== true || task.result?.outputs?.length !== 8 || task.result?.versions?.length !== 8 || !task.result?.plan?.planHash || task.result.plan.variants.length !== 5 || task.result.plan.chapters.length !== 3) throw new Error(task.error || '多版本任务质量门失败')
    const preview = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - task.result.versions[0].durationSeconds) <= 0.25 ? { duration: video.duration } : null }, '自动预览第一个版本', 30000)
    return { plan: task.result.plan, task, preview, body: document.body.innerText }
  })()`)
  if (modelRequests.length !== 1) throw new Error(`整套多版本只应调用模型一次，实际${modelRequests.length}次`)
  const outputs = pageResult.task.result.outputs
  const durations = outputs.map((filePath) => probeDuration(filePath))
  const variants = pageResult.task.result.versions.slice(0, 5)
  variants.forEach((item, index) => { if (durations[index] > Number(item.targetSeconds) + 0.25) throw new Error(`${item.label}超过目标时长`) })
  const receipt = { acceptedAt: new Date().toISOString(), executable, source: { path: sourcePath, durationSeconds: probeDuration(sourcePath), sha256: sourceHash, unchanged: sha256(sourcePath) === sourceHash }, modelCalls: modelRequests.length, plan: pageResult.plan, result: { outputs, durations, quality: pageResult.task.quality, versions: pageResult.task.result.versions }, ui: { confirmationVisible: pageResult.body.includes('长视频多版本方案已完成，尚未执行'), previewDuration: pageResult.preview.duration } }
  if (!receipt.source.unchanged || outputs.some((item) => !fs.existsSync(item))) throw new Error('安装态多版本成果或原件保护失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, modelCalls: receipt.modelCalls, outputs: outputs.length, variants: pageResult.plan.variants.length, chapters: pageResult.plan.chapters.length, quality: receipt.result.quality.score, durations, sourceUnchanged: true })}\n`)
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  await new Promise((resolve) => server.close(resolve))
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}
