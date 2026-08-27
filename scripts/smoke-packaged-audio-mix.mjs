import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueArg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const executable = path.resolve(valueArg('--exe') || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
if (!fs.existsSync(executable)) throw new Error(`缺少待验收 EXE：${executable}`)
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-audio-mix-'))
const mediaDir = path.join(profileDir, 'media')
const sourcePath = path.join(mediaDir, 'source.mp4')
const musicPath = path.join(mediaDir, 'music.wav')
const ambiencePath = path.join(mediaDir, 'ambience.wav')
const sfxPath = path.join(mediaDir, 'sfx.wav')
const installedFfmpeg = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpeg = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'audio-mix-c1-packaged')
const instruction = `做多轨混音：背景音乐 ${musicPath} 从0秒到6秒 音量20%；环境声 ${ambiencePath} 从1秒到5秒 音量10%；音效 ${sfxPath} 放在2秒开始 音量30%；对白在3秒到4秒音量70%；音乐在4秒到5秒音量5%；自动闪避；响度归一到-16 LUFS`
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function fingerprint(filePath) {
  const stat = fs.statSync(filePath)
  return { bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex') }
}

async function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, shell: false })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) }); child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(exe)} 退出码 ${code}：${stderr.slice(-1200)}`)))
  })
}

async function session() {
  const port = await freePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', sourcePath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`)
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page') } catch {}
    if (page?.webSocketDebuggerUrl) break
    await wait(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('候选应用未开放调试页面')
  const socket = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let id = 0
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const job = pending.get(message.id); if (!job) return; pending.delete(message.id); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable'); await command('Page.enable')
  return { child, socket, command, evaluate }
}

async function close(active) {
  try { await Promise.race([active.command('Browser.close'), wait(1500)]) } catch {}
  for (let attempt = 0; attempt < 40 && active.child.exitCode === null; attempt += 1) await wait(200)
  if (active.child.exitCode === null) { active.child.kill(); for (let attempt = 0; attempt < 25 && active.child.exitCode === null; attempt += 1) await wait(200) }
  try { active.socket.close() } catch {}
}

function cleanup() {
  const resolved = path.resolve(profileDir); const base = `${path.resolve(os.tmpdir())}${path.sep}`
  if (!resolved.startsWith(base) || !path.basename(resolved).startsWith('agentplay-packaged-audio-mix-')) throw new Error(`拒绝清理非验收目录：${resolved}`)
  try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

let active
try {
  if (!fs.existsSync(ffmpeg)) throw new Error(`缺少已安装 FFmpeg：${ffmpeg}`)
  fs.mkdirSync(mediaDir, { recursive: true }); fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true }); fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction'); fs.mkdirSync(evidenceDir, { recursive: true })
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath, '-loglevel', 'error'])
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'pcm_s16le', musicPath, '-loglevel', 'error'])
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'pcm_s16le', ambiencePath, '-loglevel', 'error'])
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.5', '-c:a', 'pcm_s16le', sfxPath, '-loglevel', 'error'])
  const before = Object.fromEntries([sourcePath, musicPath, ambiencePath, sfxPath].map((file) => [path.basename(file), fingerprint(file)]))
  active = await session()
  const pageResult = await active.evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label, timeout = 180000) => { const started = Date.now(); while (Date.now() - started < timeout) { const value = await probe(); if (value) return value; await wait(100) } throw new Error('等待超时：' + label) }
    await waitFor(() => document.readyState === 'complete' && window.aiPlayer?.mediaTools?.planEdit, '桌面桥接')
    await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && video.readyState >= 1 && video.duration > 0 }, '视频就绪', 60000)
    const runtimeButton = [...document.querySelectorAll('button')].find((button) => button.title === '运行与隐私' || button.innerText.includes('运行与隐私'))
    runtimeButton?.click(); await wait(120)
    const workButton = [...document.querySelectorAll('[aria-label="Agent 工作方式"] button')].find((button) => button.innerText.trim() === '执行')
    if (!workButton) throw new Error('没有找到执行工作方式')
    workButton.click(); await waitFor(() => document.querySelector('[aria-label="Agent 工作方式"] button.is-active')?.innerText.trim() === '执行', '执行工作方式生效', 10000)
    runtimeButton?.click(); await wait(120)
    for (const file of ${JSON.stringify([musicPath, ambiencePath, sfxPath])}) window.aiPlayer.menu.confirmOpenFile?.(file)
    const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(instruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    if (!plan.matched || plan.decision?.kind !== 'media.mix-audio' || plan.decision.audioMix?.tracks?.length !== 3) throw new Error('安装态多轨方案不合格：' + JSON.stringify(plan).slice(0, 700))
    const input = document.querySelector('.agent-composer input[type="text"], input[placeholder*="完成什么"], input[placeholder*="下一步"], input[placeholder*="素材"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(instruction)}); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(instruction)} })); await wait(100)
    document.querySelector('button[aria-label="发送"]').click()
    await wait(2000)
    const startedTasks = await window.aiPlayer.taskRuntime.list()
    if (![...startedTasks].reverse().some((entry) => entry.type === 'media.edit-audio-mix')) throw new Error('对话没有创建多轨持久任务；最近任务：' + JSON.stringify(startedTasks.slice(-5)) + '；工作方式存储：' + localStorage.getItem('agentplay-workspace-tasks') + '；界面：' + document.body.innerText.slice(-1200))
    let task
    try {
      task = await waitFor(async () => { const tasks = await window.aiPlayer.taskRuntime.list(); const item = [...tasks].reverse().find((entry) => entry.type === 'media.edit-audio-mix'); return item && ['completed', 'failed', 'cancelled'].includes(item.state) ? item : null }, '多轨任务完成', 300000)
    } catch (error) {
      const tasks = await window.aiPlayer.taskRuntime.list()
      throw new Error(error.message + '；最近任务：' + JSON.stringify(tasks.slice(-5)))
    }
    if (task.state !== 'completed') throw new Error((task.error || task.status) + '；任务：' + JSON.stringify(task))
    if (task.quality?.score !== 100 || task.result?.audioMixProof?.verdict !== 'matched' || task.result?.audioMixProof?.tracks?.some((item) => !item.aligned)) throw new Error('安装态多轨声音与质量门未通过')
    if (task.result?.loudnessProof?.verdict !== 'matched' || task.result?.projectCapsule?.canUndo !== true) throw new Error('安装态响度或撤销项目未闭环')
    const visible = document.body.innerText.includes('多轨混音') && document.body.innerText.includes('外部轨均通过目标时间对齐')
    if (!visible) throw new Error('对话框没有显示多轨质量回执')
    return { version: window.aiPlayer.version, task }
  })()`)
  const outputPath = pageResult.task.result.outputPath
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error('安装态多轨任务没有成果文件')
  const after = Object.fromEntries([sourcePath, musicPath, ambiencePath, sfxPath].map((file) => [path.basename(file), fingerprint(file)]))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('安装态多轨任务修改了源文件')
  const screenshot = await active.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = path.join(evidenceDir, 'conversation-result.png'); fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const persistedOutputPath = path.join(evidenceDir, 'audio-mix-c1-6s.mp4'); fs.copyFileSync(outputPath, persistedOutputPath)
  const receipt = { passed: true, checkedAt: new Date().toISOString(), executable, before, after, persistedOutputPath, screenshotPath, pageResult }
  const receiptPath = path.join(evidenceDir, 'receipt.json'); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, persistedOutputPath, screenshotPath, quality: pageResult.task.quality, audioMixProof: pageResult.task.result.audioMixProof, loudnessProof: pageResult.task.result.loudnessProof, projectCapsule: pageResult.task.result.projectCapsule }, null, 2)}\n`)
} finally {
  if (active) await close(active)
  cleanup()
}
