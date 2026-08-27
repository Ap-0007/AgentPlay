import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueArg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const executable = path.resolve(valueArg('--exe') || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'smart-reframe-packaged', 'receipt.json')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-reframe-'))
const mediaDir = path.join(profileDir, 'media'); fs.mkdirSync(mediaDir, { recursive: true })
const sourcePath = path.join(mediaDir, 'moving-subjects.mp4')
const ffmpegRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpegPath = path.join(ffmpegRoot, 'bin', 'ffmpeg.exe'); const ffprobePath = path.join(ffmpegRoot, 'bin', 'ffprobe.exe')
if (![executable, ffmpegPath, ffprobePath].every(fs.existsSync)) throw new Error('缺少安装态智能构图验收组件')
fs.mkdirSync(path.join(profileDir, 'yt-dlp'), { recursive: true }); fs.symlinkSync(ffmpegRoot, path.join(profileDir, 'yt-dlp', path.basename(ffmpegRoot)), 'junction')
const built = spawnSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'color=c=0x202020:size=640x360:rate=15:duration=6', '-f', 'lavfi', '-i', 'color=red:size=70x190:rate=15:duration=6', '-f', 'lavfi', '-i', 'color=blue:size=70x170:rate=15:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-filter_complex', "[0:v][1:v]overlay=x='40+70*t':y=70:eval=frame[tmp];[tmp][2:v]overlay=x='530-70*t':y=100:eval=frame[vout]", '-map', '[vout]', '-map', '3:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath, '-loglevel', 'error'], { timeout: 60000, windowsHide: true })
if (built.status !== 0) throw new Error(`智能构图夹具生成失败：${String(built.stderr || '')}`)
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); const sourceHash = sha256(sourcePath)
const colorCentroid = (filePath, target, seconds = 1.6) => {
  const width = 101; const height = 180
  const sampled = spawnSync(ffmpegPath, ['-v', 'error', '-ss', String(seconds), '-i', filePath, '-frames:v', '1', '-vf', `scale=${width}:${height},format=rgb24`, '-f', 'rawvideo', '-'], { windowsHide: true })
  if (sampled.status !== 0 || !Buffer.isBuffer(sampled.stdout) || sampled.stdout.length < width * height * 3) throw new Error(`无法读取成片颜色证据：${String(sampled.stderr || '')}`)
  let count = 0; let sumX = 0; let sumY = 0
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3; const r = sampled.stdout[offset]; const g = sampled.stdout[offset + 1]; const b = sampled.stdout[offset + 2]
    const matched = target === 'red' ? r > b + 80 && r > g + 80 : b > r + 80 && b > g + 40
    if (matched) { count += 1; sumX += x; sumY += y }
  }
  return { count, x: count ? Number((sumX / count).toFixed(2)) : -1, y: count ? Number((sumY / count).toFixed(2)) : -1, width, height }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs = 5000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }
const frameSeconds = [0.2, 1.6, 3, 4.4, 5.8]
const boxes = (target) => frameSeconds.map((seconds, index) => ({ label: `subject-frame-${index + 1}`, box: target === 'red' ? { x: (40 + 70 * seconds) / 640, y: 70 / 360, width: 70 / 640, height: 190 / 360 } : { x: (530 - 70 * seconds) / 640, y: 100 / 360, width: 70 / 640, height: 170 / 360 }, confidence: 0.98 }))
const modelPort = await freePort(); const modelRequests = []
const modelServer = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
  let body = ''; request.setEncoding('utf8'); request.on('data', (chunk) => { body += chunk }); request.on('end', () => {
    const payload = JSON.parse(body); const prompt = JSON.stringify(payload.messages || []); const target = prompt.includes('蓝色人物框') ? 'blue' : 'red'
    modelRequests.push({ target, hasImages: prompt.includes('image_url'), prompt })
    const content = JSON.stringify({ observedSubject: target === 'red' ? '移动红色人物框' : '移动蓝色人物框', frames: boxes(target) })
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 400, completion_tokens: 220 } }))
  })
})
await new Promise((resolve, reject) => { modelServer.once('error', reject); modelServer.listen(modelPort, '127.0.0.1', resolve) })

const debugPort = await freePort(); const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400', sourcePath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
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
  const firstInstruction = '自动生成16:9、9:16和1:1三个版本，跟踪红色人物框'
  const correctionInstruction = '改为跟踪蓝色人物框'
  const result = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const waitFor = async (probe, label, timeoutMs = 180000) => { const started = Date.now(); while (Date.now() - started < timeoutMs) { const value = await probe(); if (value) return value; await wait(100) } throw new Error('等待超时：' + label) }
    const initial = await waitFor(() => { const input = document.querySelector('.agent-composer input[type="text"]'); const video = document.querySelector('video[data-ai-player-video="true"]'); return input && video && video.readyState >= 1 ? { duration: video.duration } : null }, '视频与对话就绪', 60000)
    const saved = await window.aiPlayer.models.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.5-flash', baseUrl: ${JSON.stringify(`http://127.0.0.1:${modelPort}/v1`)}, apiKey: 'smart-reframe-smoke-key' })
    if (saved.providerId !== 'agnes' || !saved.hasApiKey) throw new Error('视觉模型配置失败')
    const input = document.querySelector('.agent-composer input[type="text"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const send = async (text) => { setter.call(input, text); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click() }
    await send(${JSON.stringify(firstInstruction)})
    const first = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const task = [...items].reverse().find((item) => item.type === 'media.smart-reframe'); return task && ['completed','failed','cancelled'].includes(task.state) ? task : null }, '第一轮智能构图完成')
    if (first.state !== 'completed' || first.quality?.score !== 100 || first.result?.outputs?.length !== 3 || first.result?.trackingReceipt?.subject?.description !== '红色人物框' || first.result?.visualQc?.passed !== true || first.result.visualQc.artifacts?.length !== 3) throw new Error(first.error || '第一轮智能构图质量门失败')
    const firstPreview = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - initial.duration) <= 0.35 ? { duration: video.duration } : null }, '第一轮自动预览', 30000)
    window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: first.result.outputs[1] })); await waitFor(() => decodeURI(document.querySelector('video[data-ai-player-video="true"]')?.currentSrc || '').includes('竖屏9x16'), '打开竖屏关联成果', 30000)
    await send(${JSON.stringify(correctionInstruction)})
    const second = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const tasks = items.filter((item) => item.type === 'media.smart-reframe'); return tasks.length >= 2 && ['completed','failed','cancelled'].includes(tasks.at(-1).state) ? tasks.at(-1) : null }, '修正跟踪对象完成')
    if (second.state !== 'completed' || second.quality?.score !== 100 || second.result?.outputs?.length !== 3 || second.result?.trackingReceipt?.subject?.description !== '蓝色人物框' || second.spec?.decision?.reframe?.correctionOf?.subject !== '红色人物框' || second.spec?.decision?.source?.path !== ${JSON.stringify(sourcePath)} || second.result?.visualQc?.passed !== true || second.result.visualQc.artifacts?.length !== 3) throw new Error(second.error || '修正对象没有从原片重新生成')
    if (!document.body.innerText.includes('生成16:9、9:16和1:1三个跟踪构图版本')) throw new Error('对话没有显示三比例成果回执')
    return { first, second, firstPreview, body: document.body.innerText }
  })()`)
  if (modelRequests.length !== 2 || modelRequests[0].target !== 'red' || modelRequests[1].target !== 'blue' || modelRequests.some((item) => !item.hasImages)) throw new Error('视觉模型调用次数、对象或图片证据不正确')
  const firstCenter = colorCentroid(result.first.result.outputs[1], 'red'); const correctionCenter = colorCentroid(result.second.result.outputs[1], 'blue')
  if (firstCenter.count < 200 || correctionCenter.count < 200 || Math.abs(firstCenter.x - 50) > 12 || Math.abs(correctionCenter.x - 50) > 12) throw new Error(`成片没有实际跟随指定对象：${JSON.stringify({ firstCenter, correctionCenter })}`)
  const receipt = { acceptedAt: new Date().toISOString(), executable, source: { path: sourcePath, sha256: sourceHash, unchanged: sha256(sourcePath) === sourceHash }, modelRequests: modelRequests.map((item) => ({ target: item.target, hasImages: item.hasImages })), first: { decision: result.first.spec.decision, outputs: result.first.result.outputs, quality: result.first.quality, trackingReceipt: result.first.result.trackingReceipt, visualQc: result.first.result.visualQc, colorCentroid: firstCenter }, correction: { decision: result.second.spec.decision, outputs: result.second.result.outputs, quality: result.second.quality, trackingReceipt: result.second.result.trackingReceipt, visualQc: result.second.result.visualQc, colorCentroid: correctionCenter } }
  if (!receipt.source.unchanged || [...receipt.first.outputs, ...receipt.correction.outputs].some((item) => !fs.existsSync(item))) throw new Error('安装态智能构图成果或原片保护失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, firstQuality: receipt.first.quality.score, correctionQuality: receipt.correction.quality.score, firstSubject: receipt.first.trackingReceipt.subject.description, correctionSubject: receipt.correction.trackingReceipt.subject.description, visualQc: receipt.first.visualQc.passed && receipt.correction.visualQc.passed, qcArtifacts: receipt.first.visualQc.artifacts.length + receipt.correction.visualQc.artifacts.length, firstCenter, correctionCenter, outputs: receipt.first.outputs.length + receipt.correction.outputs.length, modelRequests: modelRequests.length, sourceUnchanged: true })}\n`)
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  await new Promise((resolve) => modelServer.close(resolve))
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}
