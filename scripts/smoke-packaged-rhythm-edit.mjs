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
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-rhythm-edit-'))
const mediaDir = path.join(profileDir, 'media')
const sourcePath = path.join(mediaDir, 'source.mp4')
const musicPath = path.join(mediaDir, 'beat.wav')
const installedFfmpeg = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpeg = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'rhythm-edit-c3-packaged')
const instruction = `用 ${musicPath} 按音乐节拍切镜，音乐高潮对齐，片尾自然收束，节奏更快`
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
function fingerprint(file) {
  const data = fs.readFileSync(file)
  return { bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }
}
async function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, shell: false })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(exe)}退出码${code}：${stderr.slice(-1200)}`)))
  })
}
async function openSession() {
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
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map(); let id = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data); const job = pending.get(message.id)
    if (!job) return
    pending.delete(message.id); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
  const evaluate = async (expression) => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  }
  await command('Runtime.enable'); await command('Page.enable')
  return { child, socket, command, evaluate }
}
async function close(active) {
  try { await Promise.race([active.command('Browser.close'), wait(1500)]) } catch {}
  for (let attempt = 0; attempt < 40 && active.child.exitCode === null; attempt += 1) await wait(200)
  if (active.child.exitCode === null) active.child.kill()
  try { active.socket.close() } catch {}
}
function cleanup() {
  const resolved = path.resolve(profileDir); const base = `${path.resolve(os.tmpdir())}${path.sep}`
  if (!resolved.startsWith(base) || !path.basename(resolved).startsWith('agentplay-packaged-rhythm-edit-')) throw new Error(`拒绝清理非验收目录：${resolved}`)
  try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

let active
try {
  if (!fs.existsSync(ffmpeg)) throw new Error(`缺少已安装FFmpeg：${ffmpeg}`)
  fs.mkdirSync(mediaDir, { recursive: true }); fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true }); fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction'); fs.mkdirSync(evidenceDir, { recursive: true })
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=16:size=320x180:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=16', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath, '-loglevel', 'error'])
  const expression = '0.012*sin(2*PI*220*t)+if(lt(mod(t\\,0.5)\\,0.025)\\,0.85*exp(-mod(t\\,0.5)*90)\\,0)+if(between(t\\,6\\,10)\\,0.12*sin(2*PI*440*t)\\,0)'
  await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', `aevalsrc=${expression}:s=11025:d=16`, '-ar', '11025', '-c:a', 'pcm_s16le', musicPath, '-loglevel', 'error'])
  const before = { source: fingerprint(sourcePath), music: fingerprint(musicPath) }
  active = await openSession()
  const pageResult = await active.evaluate(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label, timeout = 300000) => { const started = Date.now(); while (Date.now() - started < timeout) { const value = await probe(); if (value) return value; await wait(100) } throw new Error('等待超时：' + label) }
    await waitFor(() => document.readyState === 'complete' && window.aiPlayer?.mediaTools?.planEdit, '桌面桥接')
    await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && video.readyState >= 1 && video.duration > 0 }, '视频就绪', 60000)
    const runtimeButton = [...document.querySelectorAll('button')].find((button) => button.title === '运行与隐私' || button.innerText.includes('运行与隐私'))
    runtimeButton?.click(); await wait(100)
    const workButton = [...document.querySelectorAll('[aria-label="Agent 工作方式"] button')].find((button) => button.innerText.trim() === '执行')
    workButton?.click(); await waitFor(() => document.querySelector('[aria-label="Agent 工作方式"] button.is-active')?.innerText.trim() === '执行', '执行方式'); runtimeButton?.click()
    window.aiPlayer.menu.confirmOpenFile?.(${JSON.stringify(musicPath)})\n    const plan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(instruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    if (!plan.matched || plan.decision?.kind !== 'media.rhythm-edit' || Math.abs(plan.decision.rhythm?.bpm - 120) > 3 || plan.decision.rhythm?.confirmationRequired !== true) throw new Error('安装态C3方案不合格：' + JSON.stringify(plan).slice(0, 1200))
    const send = async (text) => {
      const input = document.querySelector('.agent-composer input[type="text"], input[placeholder*="完成什么"], input[placeholder*="下一步"], input[placeholder*="素材"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, text); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); await wait(100)
      document.querySelector('button[aria-label="发送"]').click()
    }
    const beforeTasks = (await window.aiPlayer.taskRuntime.list()).filter((entry) => entry.type === 'media.rhythm-edit').length
    await send(${JSON.stringify(instruction)})
    await waitFor(() => document.body.innerText.includes('节拍剪辑方案已完成') && document.body.innerText.includes('真实节拍：'), 'C3方案显示', 60000)
    const plannedTasks = (await window.aiPlayer.taskRuntime.list()).filter((entry) => entry.type === 'media.rhythm-edit').length
    if (plannedTasks !== beforeTasks) throw new Error('C3确认前不应创建持久任务')
    await send('确认执行')
    const task = await waitFor(async () => { const tasks = await window.aiPlayer.taskRuntime.list(); const item = [...tasks].reverse().find((entry) => entry.type === 'media.rhythm-edit'); return item && ['completed','failed','cancelled'].includes(item.state) ? item : null }, 'C3任务完成')
    if (task.state !== 'completed') throw new Error((task.error || task.status) + '；' + JSON.stringify(task))
    if (task.quality?.score !== 100 || task.result?.beatProof?.visibleCutRatio < 0.5 || task.result?.beatProof?.musicCorrelation < 0.02 || task.result?.beatProof?.highlight?.denserThanOutside !== true || task.result?.beatProof?.tail?.audioFaded !== true || task.result?.beatProof?.tail?.videoFaded !== true) throw new Error('安装态C3节拍、高潮、音乐或片尾证明未通过')
    if (task.result?.projectCapsule?.canUndo !== true || task.result?.outputs?.length !== 1) throw new Error('安装态C3成果或撤销未闭环')
    if (!document.body.innerText.includes('高潮区切镜更密') || !document.body.innerText.includes('片尾在强拍处')) throw new Error('对话框没有显示C3结果边界')
    return { version: window.aiPlayer.version, plan: plan.decision.rhythm, task }
  })()`)
  const after = { source: fingerprint(sourcePath), music: fingerprint(musicPath) }
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('安装态C3修改了源视频或音乐')
  const output = pageResult.task.result.outputPath
  if (!fs.existsSync(output)) throw new Error('安装态C3缺少成片')
  const persisted = path.join(evidenceDir, 'rhythm-edit-c3-16s.mp4'); fs.copyFileSync(output, persisted)
  const screenshot = await active.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const screenshotPath = path.join(evidenceDir, 'conversation-result.png'); fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const receipt = { passed: true, checkedAt: new Date().toISOString(), executable, before, after, persisted, screenshotPath, pageResult }
  const receiptPath = path.join(evidenceDir, 'receipt.json'); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, persisted, screenshotPath, quality: pageResult.task.quality, rhythmReceipt: pageResult.task.result.rhythmReceipt, beatProof: pageResult.task.result.beatProof, projectCapsule: pageResult.task.result.projectCapsule }, null, 2)}\n`)
} finally {
  if (active) await close(active)
  cleanup()
}
