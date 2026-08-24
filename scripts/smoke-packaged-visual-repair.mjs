import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueArg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const executable = path.resolve(valueArg('--exe') || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'visual-repair-packaged', 'receipt.json')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-visual-repair-')); const mediaDir = path.join(profileDir, 'media'); fs.mkdirSync(mediaDir, { recursive: true })
const sourcePath = path.join(mediaDir, 'shaky-dark-source.mp4')
const ffmpegRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpegPath = path.join(ffmpegRoot, 'bin', 'ffmpeg.exe'); const ffprobePath = path.join(ffmpegRoot, 'bin', 'ffprobe.exe')
if (![executable, ffmpegPath, ffprobePath].every(fs.existsSync)) throw new Error('缺少安装态画面修复验收组件')
fs.mkdirSync(path.join(profileDir, 'yt-dlp'), { recursive: true }); fs.symlinkSync(ffmpegRoot, path.join(profileDir, 'yt-dlp', path.basename(ffmpegRoot)), 'junction')
const filter = "pad=400:280:20:20,crop=360:240:x='20+10*sin(n*1.7)':y='20+8*cos(n*1.3)',eq=brightness=-0.24:saturation=0.55,colorbalance=bs=.18,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,2,2.8)'"
const built = spawnSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=5:size=360x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-vf', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath, '-loglevel', 'error'], { timeout: 60000, windowsHide: true })
if (built.status !== 0) throw new Error(`画面修复夹具生成失败：${String(built.stderr || '')}`)
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); const sourceHash = sha256(sourcePath)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs = 5000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }
const probeDimensions = (filePath) => { const raw = String(spawnSync(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', filePath], { encoding: 'utf8', windowsHide: true }).stdout).trim(); const [width, height] = raw.split('x').map(Number); return { width, height } }

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
  const instruction = '帮我防抖，顺时针旋转90度，自动修复曝光和偏色，并提示低质量片段，保留前后对比'
  const result = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const waitFor = async (probe, label, timeoutMs = 180000) => { const started = Date.now(); while (Date.now() - started < timeoutMs) { const value = await probe(); if (value) return value; await wait(100) } throw new Error('等待超时：' + label) }
    const initial = await waitFor(() => { const input = document.querySelector('.agent-composer input[type="text"]'); const video = document.querySelector('video[data-ai-player-video="true"]'); return input && video && video.readyState >= 1 ? { duration: video.duration, width: video.videoWidth, height: video.videoHeight } : null }, '视频与对话就绪', 60000)
    const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(instruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    if (!plan.matched || plan.decision?.kind !== 'media.visual-repair' || plan.decision?.repair?.rotationDegrees !== 90 || plan.decision?.repair?.lowQualityFindings?.some((item) => item.action !== 'review-only')) throw new Error('安装态画面修复方案或低质量边界不合格')
    const input = document.querySelector('.agent-composer input[type="text"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const send = async (text) => { setter.call(input, text); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click() }
    await send(${JSON.stringify(instruction)})
    await waitFor(() => document.body.innerText.includes('画面修复方案已完成，尚未执行') && document.body.innerText.includes('低质量片段仅提示、不自动删除') && document.body.innerText.includes('请回复“确认执行”或“取消”'), '确认前修复方案可见')
    const before = (await window.aiPlayer.taskRuntime.list()).filter((item) => item.type === 'media.visual-repair').length
    if (before !== 0) throw new Error('确认前不应创建画面修复任务')
    await send('确认执行')
    const task = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const found = [...items].reverse().find((item) => item.type === 'media.visual-repair'); return found && ['completed','failed','cancelled'].includes(found.state) ? found : null }, '画面修复任务完成')
    if (task.state !== 'completed' || task.quality?.score !== 100 || task.result?.outputs?.length !== 2 || task.result?.repairReceipt?.stabilization?.verdict !== 'improved' || task.result?.repairReceipt?.color?.verdict !== 'improved' || task.result?.repairReceipt?.sourceUnchanged !== true) throw new Error(task.error || '安装态画面修复质量门失败')
    const preview = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && video.videoWidth === 240 && video.videoHeight === 360 ? { duration: video.duration, width: video.videoWidth, height: video.videoHeight } : null }, '自动预览旋转修复版', 30000)
    await send('撤销刚才的剪辑')
    const undo = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && video.videoWidth === initial.width && video.videoHeight === initial.height ? { duration: video.duration, width: video.videoWidth, height: video.videoHeight } : null }, '撤销回原片', 30000)
    if (!document.body.innerText.includes('处理前后对比版') || !document.body.innerText.includes('原文件未改动')) throw new Error('对话没有显示修复/对比回执')
    return { initial, plan, task, preview, undo, body: document.body.innerText }
  })()`)
  const repairedPath = result.task.result.outputs[0]; const comparisonPath = result.task.result.outputs[1]
  const receipt = { acceptedAt: new Date().toISOString(), executable, source: { path: sourcePath, sha256: sourceHash, unchanged: sha256(sourcePath) === sourceHash, dimensions: probeDimensions(sourcePath) }, decision: result.task.spec.decision, result: { repairedPath, comparisonPath, repairedDimensions: probeDimensions(repairedPath), comparisonDimensions: probeDimensions(comparisonPath), quality: result.task.quality, repairReceipt: result.task.result.repairReceipt }, ui: { preview: result.preview, undo: result.undo, confirmationVisible: result.body.includes('画面修复方案已完成，尚未执行') } }
  if (!receipt.source.unchanged || receipt.result.repairedDimensions.width !== 240 || receipt.result.repairedDimensions.height !== 360 || receipt.result.comparisonDimensions.width <= 360) throw new Error('安装态画面修复成果或原件保护失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, quality: receipt.result.quality.score, stabilization: receipt.result.repairReceipt.stabilization, color: { beforeDistance: receipt.result.repairReceipt.color.beforeDistance, afterDistance: receipt.result.repairReceipt.color.afterDistance }, repairedDimensions: receipt.result.repairedDimensions, comparisonDimensions: receipt.result.comparisonDimensions, findings: receipt.result.repairReceipt.lowQualityFindings.length, sourceUnchanged: true })}\n`)
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}
