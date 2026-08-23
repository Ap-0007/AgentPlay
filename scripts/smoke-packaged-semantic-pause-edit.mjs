import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueOf = (name, fallback = '') => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')))
const receiptPath = path.resolve(valueOf('--receipt', path.join(root, 'artifacts', 'acceptance', 'semantic-pause-edit-packaged', 'receipt.json')))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-semantic-pause-'))
const sourceDir = path.join(profileDir, 'media')
const sourcePath = path.join(sourceDir, 'semantic-pause-source.mp4')
const installedFfmpeg = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpegPath = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe')
const ffprobePath = path.join(installedFfmpeg, 'bin', 'ffprobe.exe')
const instruction = '删掉超过1秒的长停顿'
if (!fs.existsSync(executable) || !fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) throw new Error('缺少安装态语义剪辑验收组件')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
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
function probeDuration(filePath) {
  return Number(String(spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8', windowsHide: true }).stdout).trim()) || 0
}

fs.mkdirSync(sourceDir, { recursive: true })
fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true })
fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction')
const generated = spawnSync(ffmpegPath, [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=0xAA3344:s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
  '-f', 'lavfi', '-i', 'color=c=0x222222:s=640x360:r=25:d=1.4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1.4',
  '-f', 'lavfi', '-i', 'color=c=0x33AA66:s=640x360:r=25:d=2.6', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2.6',
  '-f', 'lavfi', '-i', 'color=c=0x222222:s=640x360:r=25:d=1.5', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1.5',
  '-f', 'lavfi', '-i', 'color=c=0x8844AA:s=640x360:r=25:d=2.5', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2.5',
  '-filter_complex', '[0:v][1:a][2:v][3:a][4:v][5:a][6:v][7:a][8:v][9:a]concat=n=5:v=1:a=1[vout][aout]',
  '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath
], { encoding: 'utf8', windowsHide: true })
if (generated.status !== 0 || !fs.existsSync(sourcePath)) throw new Error(generated.stderr || '安装态夹具生成失败')
const sourceHash = sha256(sourcePath)

const port = await freePort()
const child = spawn(executable, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  '--window-position=-2400,-2400', sourcePath
], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`)
    try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); page = pages.find((item) => item.type === 'page'); if (page?.webSocketDebuggerUrl) break } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('候选应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map(); let nextId = 0
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => { const id = ++nextId; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable')
  const pageResult = await evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label, timeoutMs = 120000) => { const started = Date.now(); while (Date.now() - started < timeoutMs) { const value = await probe(); if (value) return value; await wait(100) } throw new Error('等待超时：' + label) }
    const initial = await waitFor(() => { const input = document.querySelector('.agent-composer input[type="text"]'); const video = document.querySelector('video[data-ai-player-video="true"]'); return input && video && video.readyState >= 1 && video.duration > 9 ? { duration: video.duration } : null }, '视频与对话就绪', 60000)
    const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(instruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    if (!plan.matched || plan.decision?.semanticCut?.removed?.length !== 2 || plan.decision?.edl?.decisionKind !== 'media.concat-segments') throw new Error('安装态语义方案或EDL不合格')
    const input = document.querySelector('.agent-composer input[type="text"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(instruction)}); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(instruction)} })); await wait(100)
    document.querySelector('button[aria-label="发送"]')?.click()
    const task = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const found = [...items].reverse().find((item) => item.type === 'media.edit-concat' && item.spec?.decision?.semanticCut); return found && ['completed','failed','cancelled'].includes(found.state) ? found : null }, '语义去停顿任务完成', 180000)
    if (task.state !== 'completed' || task.result?.semanticCut?.removed?.length !== 2 || task.quality?.passed !== true) throw new Error(task.error || '安装态语义剪辑质量门失败')
    const preview = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - task.spec.decision.timeline.durationSeconds) <= 0.25 ? { duration: video.duration, src: video.currentSrc } : null }, '自动预览去停顿成片', 30000)
    if (!document.body.innerText.includes('真实音轨证据') || !document.body.innerText.includes('删除 2 处长停顿')) throw new Error('对话没有显示可审计语义剪辑回执')
    setter.call(input, '撤销刚才的剪辑'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '撤销刚才的剪辑' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const undo = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - initial.duration) <= 0.25 && document.body.innerText.includes('项目版本：1/2') ? { duration: video.duration, src: video.currentSrc } : null }, '对话撤销回原片', 30000)
    return { task, preview, undo, body: document.body.innerText }
  })()`)
  const task = pageResult.task
  const outputPath = task.result.outputPath
  const receipt = {
    acceptedAt: new Date().toISOString(), executable,
    source: { path: sourcePath, durationSeconds: probeDuration(sourcePath), sha256: sourceHash, unchanged: sha256(sourcePath) === sourceHash },
    decision: task.spec.decision,
    result: { outputPath, durationSeconds: probeDuration(outputPath), quality: task.quality, frameProof: task.result.frameProof },
    ui: { semanticReceiptVisible: pageResult.body.includes('真实音轨证据'), previewDuration: pageResult.preview.duration, undoDuration: pageResult.undo.duration }
  }
  if (!receipt.source.unchanged || !fs.existsSync(outputPath)) throw new Error('安装态成果或原件保护失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, removed: receipt.decision.semanticCut.removed.length, quality: receipt.result.quality.score, frameProof: receipt.result.frameProof.verdict, outputDuration: receipt.result.durationSeconds, undoDuration: receipt.ui.undoDuration, sourceUnchanged: true })}\n`)
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}
  const resolved = path.resolve(profileDir); const tempBase = `${path.resolve(os.tmpdir())}${path.sep}`
  if (resolved.startsWith(tempBase) && path.basename(resolved).startsWith('agentplay-packaged-semantic-pause-')) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
