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
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'visual-effects-packaged', 'receipt.json')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-effects-'))
const keepFailedProfile = process.env.AGENTPLAY_KEEP_FAILED_SMOKE === '1'
const mediaDir = path.join(profileDir, 'media'); fs.mkdirSync(mediaDir, { recursive: true })
const sourcePath = path.join(mediaDir, 'effects-source.mp4')
const pipDir = path.join(os.homedir(), 'Videos', 'AgentPlay B1 Smoke'); fs.mkdirSync(pipDir, { recursive: true })
const pipPath = path.join(pipDir, `pip-${process.pid}-${Date.now()}.mp4`)
const userDataRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player')
const ffmpegRoot = path.join(userDataRoot, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpegPath = path.join(ffmpegRoot, 'bin', 'ffmpeg.exe'); const ffprobePath = path.join(ffmpegRoot, 'bin', 'ffprobe.exe')
if (![executable, ffmpegPath, ffprobePath].every(fs.existsSync)) throw new Error('缺少安装态视觉效果验收组件')
fs.mkdirSync(path.join(profileDir, 'yt-dlp'), { recursive: true }); fs.symlinkSync(ffmpegRoot, path.join(profileDir, 'yt-dlp', path.basename(ffmpegRoot)), 'junction')
const build = (args, label) => { const result = spawnSync(ffmpegPath, args, { timeout: 60000, windowsHide: true }); if (result.status !== 0) throw new Error(`${label}生成失败：${String(result.stderr || '')}`) }
build(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath, '-loglevel', 'error'], '源片')
build(['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=160x90:rate=15,hue=h=90', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', pipPath, '-loglevel', 'error'], '画中画')
const instruction = `裁成9:16，缩小到0.9倍，把 ${pipPath} 作为右上角画中画，占画面25%，第1秒到第5秒显示；做一个缓慢推近的关键帧运动；在第3秒加0.5秒叠化转场；第1秒到第4秒左下角加遮罩并强模糊；亮度提高10%，对比度提高20%，饱和度降低15%`
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const sourceHash = sha256(sourcePath); const pipHash = sha256(pipPath)
const probeDuration = (filePath) => Number(String(spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8', windowsHide: true }).stdout).trim()) || 0
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs = 5000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }

const port = await freePort(); const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400', sourcePath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
let accepted = false
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
    const initial = await waitFor(() => { const input = document.querySelector('.agent-composer input[type="text"]'); const video = document.querySelector('video[data-ai-player-video="true"]'); return input && video && video.readyState >= 1 ? { duration: video.duration } : null }, '视频与对话就绪', 60000)
    const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(instruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    if (!plan?.matched || plan?.decision?.kind !== 'media.visual-effects' || plan.decision.effects?.length !== 8) throw new Error('安装态规划失败：' + JSON.stringify(plan))
    const input = document.querySelector('.agent-composer input[type="text"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const sendText = async (text) => { setter.call(input, text); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click() }
    await sendText('保留第1秒之后')
    await waitFor(() => document.body.innerText.includes('要保留到第几秒？'), '基础剪辑路由追问', 10000)
    await sendText('算了')
    await waitFor(() => document.body.innerText.includes('已取消这次剪辑'), '基础剪辑路由取消', 10000)
    await sendText(${JSON.stringify(instruction)})
    const createdTask = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); return [...items].reverse().find((item) => item.type === 'media.edit-visual-effects') || null }, '视觉效果任务入队', 10000).catch(async (error) => {
      const items = await window.aiPlayer.taskRuntime.list()
      const video = document.querySelector('video[data-ai-player-video="true"]')
      throw new Error(error.message + '；诊断=' + JSON.stringify({ videoSrc: video?.currentSrc || video?.src || '', body: document.body.innerText.slice(-2000), tasks: items.slice(-5) }))
    })
    const task = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const found = items.find((item) => item.id === createdTask.id); return found && ['completed','failed','cancelled'].includes(found.state) ? found : null }, '视觉效果任务完成')
    if (task.state !== 'completed' || task.quality?.passed !== true || task.result?.effectReceipt?.effectKinds?.length !== 8 || task.result.effectReceipt.dimensionMatch !== true || task.result.effectReceipt.changed !== true || task.result?.visualQc?.passed !== true || task.result.visualQc.artifacts?.length !== 1) throw new Error(task.error || '安装态视觉效果质量门失败')
    const preview = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - task.result.durationSeconds) <= 0.35 ? { duration: video.duration } : null }, '自动预览视觉效果成片', 30000)
    if (!document.body.innerText.includes('已应用 8 类视觉效果')) throw new Error('对话没有显示视觉效果回执')
    setter.call(input, '撤销刚才的剪辑'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '撤销刚才的剪辑' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const undo = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - initial.duration) <= 0.25 ? { duration: video.duration } : null }, '视觉效果撤销回原片', 30000)
    return { initial, plan, task, preview, undo, body: document.body.innerText }
  })()`)
  const result = pageResult.task.result; const outputPath = result.outputPath
  const receipt = { acceptedAt: new Date().toISOString(), executable, source: { path: sourcePath, sha256: sourceHash, unchanged: sha256(sourcePath) === sourceHash }, pip: { path: pipPath, sha256: pipHash, unchanged: sha256(pipPath) === pipHash }, decision: pageResult.task.spec.decision, result: { outputPath, durationSeconds: probeDuration(outputPath), quality: pageResult.task.quality, effectReceipt: result.effectReceipt, visualQc: result.visualQc }, ui: { previewDuration: pageResult.preview.duration, undoDuration: pageResult.undo.duration } }
  if (!receipt.source.unchanged || !receipt.pip.unchanged || !fs.existsSync(outputPath)) throw new Error('安装态视觉效果成果或原件保护失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, effects: receipt.result.effectReceipt.effectKinds, dimensions: receipt.result.effectReceipt.outputDimensions, quality: receipt.result.quality.score, visualQc: receipt.result.visualQc.passed, qcArtifacts: receipt.result.visualQc.artifacts.length, duration: receipt.result.durationSeconds, undoDuration: receipt.ui.undoDuration, sourceUnchanged: true, pipUnchanged: true })}\n`)
  accepted = true
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  if (!accepted && keepFailedProfile) process.stderr.write(`保留失败验收配置：${profileDir}\n`)
  else try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
  try { fs.rmSync(pipPath, { force: true }); if (fs.existsSync(pipDir) && fs.readdirSync(pipDir).length === 0) fs.rmdirSync(pipDir) } catch {}
}
