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
const receiptPath = path.resolve(valueOf('--receipt', path.join(root, 'artifacts', 'acceptance', 'auto-inspection-packaged', 'receipt.json')))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-auto-inspection-'))
const mediaDir = path.join(profileDir, 'media')
const sourcePath = path.join(mediaDir, 'auto-inspection-source.mp4')
const subtitlePath = path.join(mediaDir, 'auto-inspection-source.srt')
const ffmpegRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpegPath = path.join(ffmpegRoot, 'bin', 'ffmpeg.exe')
const ffprobePath = path.join(ffmpegRoot, 'bin', 'ffprobe.exe')
const instruction = '自动检查这个视频并给我剪辑方案'
if (![executable, ffmpegPath, ffprobePath].every(fs.existsSync)) throw new Error('缺少安装态自动体检验收组件')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const probeDuration = (filePath) => Number(String(spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8', windowsHide: true }).stdout).trim()) || 0
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs = 5000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }

fs.mkdirSync(mediaDir, { recursive: true })
fs.mkdirSync(path.join(profileDir, 'yt-dlp'), { recursive: true })
fs.symlinkSync(ffmpegRoot, path.join(profileDir, 'yt-dlp', path.basename(ffmpegRoot)), 'junction')
const built = spawnSync(ffmpegPath, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-f', 'lavfi', '-i', 'color=black:duration=1:size=320x180:rate=10', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1',
  '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
  '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x180:rate=10,hue=h=90', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
  '-filter_complex', '[6:v]boxblur=4:1[blurred];[0:v][1:a][2:v][3:a][4:v][5:a][blurred][7:a][8:v][9:a]concat=n=5:v=1:a=1[v][a]',
  '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath
], { timeout: 60000, encoding: 'utf8', windowsHide: true })
if (built.status !== 0 || !fs.existsSync(sourcePath)) throw new Error(built.stderr || '自动体检夹具生成失败')
fs.writeFileSync(subtitlePath, `1\n00:00:00,000 --> 00:00:02,000\n开场介绍\n\n2\n00:00:03,300 --> 00:00:03,800\n嗯\n\n3\n00:00:03,900 --> 00:00:09,000\n后续产品演示\n`, 'utf8')
const sourceHash = sha256(sourcePath)

const port = await freePort()
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400', sourcePath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
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
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const waitFor = async (probe, label, timeoutMs = 120000) => { const started = Date.now(); while (Date.now() - started < timeoutMs) { const value = await probe(); if (value) return value; await wait(100) } throw new Error('等待超时：' + label) }
    const initial = await waitFor(() => { const input = document.querySelector('.agent-composer input[type="text"]'); const video = document.querySelector('video[data-ai-player-video="true"]'); return input && video && video.readyState >= 1 ? { duration: video.duration } : null }, '视频与对话就绪', 60000)
    const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(instruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    const inspection = plan.decision?.autoInspection
    if (!plan.matched || !inspection || plan.decision.kind !== 'media.concat-segments' || inspection.safeRemovals.length < 2 || !inspection.findings.blackRanges.length || !inspection.findings.blurRanges.length || !inspection.findings.duplicateRanges.length || !inspection.reviewOnly.some((item) => item.kind === 'blur') || !inspection.reviewOnly.some((item) => item.kind === 'duplicate-shot')) throw new Error('安装态自动体检方案不完整：' + JSON.stringify(plan))
    const input = document.querySelector('.agent-composer input[type="text"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(instruction)}); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(instruction)} })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    await waitFor(() => document.body.innerText.includes('自动体检方案已完成，尚未执行') && document.body.innerText.includes('仅标记、不自动删除') && document.body.innerText.includes('请回复“确认执行”或“取消”'), '自动体检确认方案可见', 120000)
    const before = (await window.aiPlayer.taskRuntime.list()).filter((item) => item.type === 'media.edit-concat' && item.spec?.decision?.autoInspection).length
    if (before !== 0) throw new Error('确认前不应创建自动体检批处理任务')
    setter.call(input, '确认执行'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '确认执行' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const task = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const found = [...items].reverse().find((item) => item.type === 'media.edit-concat' && item.spec?.decision?.autoInspection); return found && ['completed','failed','cancelled'].includes(found.state) ? found : null }, '自动体检批处理完成', 180000)
    if (task.state !== 'completed' || task.quality?.passed !== true || !task.result?.autoInspection || task.result.autoInspection.reviewOnly.length < 2) throw new Error(task.error || '自动体检批处理质量门失败')
    const preview = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - task.spec.decision.timeline.durationSeconds) <= 0.25 ? { duration: video.duration } : null }, '自动预览体检成片', 30000)
    if (!document.body.innerText.includes('仅标记未删除')) throw new Error('对话没有显示自动体检保留审阅项回执')
    setter.call(input, '撤销刚才的剪辑'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '撤销刚才的剪辑' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const undo = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - initial.duration) <= 0.25 ? { duration: video.duration } : null }, '自动体检撤销回原片', 30000)
    return { initial, plan, task, preview, undo, body: document.body.innerText }
  })()`)
  const outputPath = pageResult.task.result.outputPath
  const receipt = { acceptedAt: new Date().toISOString(), executable, source: { path: sourcePath, durationSeconds: probeDuration(sourcePath), sha256: sourceHash, unchanged: sha256(sourcePath) === sourceHash }, decision: pageResult.plan.decision, result: { outputPath, durationSeconds: probeDuration(outputPath), quality: pageResult.task.quality }, ui: { confirmationVisible: pageResult.body.includes('自动体检方案已完成，尚未执行'), reviewOnlyVisible: pageResult.body.includes('仅标记未删除'), previewDuration: pageResult.preview.duration, undoDuration: pageResult.undo.duration } }
  if (!receipt.source.unchanged || !fs.existsSync(outputPath)) throw new Error('安装态自动体检成果或原件保护失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, safeRemovals: receipt.decision.autoInspection.safeRemovals.length, reviewOnly: receipt.decision.autoInspection.reviewOnly.length, black: receipt.decision.autoInspection.findings.blackRanges.length, blur: receipt.decision.autoInspection.findings.blurRanges.length, duplicate: receipt.decision.autoInspection.findings.duplicateRanges.length, quality: receipt.result.quality.score, outputDuration: receipt.result.durationSeconds, undoDuration: receipt.ui.undoDuration, sourceUnchanged: true })}\n`)
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}
