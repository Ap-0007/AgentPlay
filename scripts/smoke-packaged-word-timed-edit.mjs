import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { findPhraseWordTiming, parseWhisperWordJson } = require('../electron/word-timing-service')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'word-timed-edit-packaged', 'receipt.json')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-word-edit-'))
const mediaDir = path.join(profileDir, 'media')
const wavPath = path.join(mediaDir, 'speech.wav')
const sourcePath = path.join(mediaDir, 'word-timed-source.mp4')
const subtitlePath = path.join(mediaDir, 'word-timed-source.srt')
const userDataRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player')
const whisperRoot = path.join(userDataRoot, 'whisper-pack')
const ffmpegRoot = path.join(userDataRoot, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpegPath = path.join(ffmpegRoot, 'bin', 'ffmpeg.exe')
const ffprobePath = path.join(ffmpegRoot, 'bin', 'ffprobe.exe')
const whisperCli = path.join(whisperRoot, 'engine', 'whisper-cli.exe')
const speechText = '欢迎大家。就是，今天我们介绍产品。接下来介绍功能。谢谢大家。'
const instruction = '删掉口头禅和重复的话'
const phraseInstruction = '从他说到“今天我们介绍产品”开始'
if (![executable, ffmpegPath, ffprobePath, whisperCli, path.join(whisperRoot, 'ggml-tiny.bin')].every(fs.existsSync)) throw new Error('缺少安装态逐词剪辑验收组件')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
const srtTime = (seconds) => {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000)); const hh = String(Math.floor(ms / 3600000)).padStart(2, '0')
  const mm = String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0'); const ss = String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')
  return `${hh}:${mm}:${ss},${String(ms % 1000).padStart(3, '0')}`
}
const probeDuration = (filePath) => Number(String(spawnSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8', windowsHide: true }).stdout).trim()) || 0
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs = 5000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }

fs.mkdirSync(mediaDir, { recursive: true })
for (const [target, source] of [[path.join(profileDir, 'whisper-pack'), whisperRoot], [path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build'), ffmpegRoot]]) {
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync(source, target, 'junction')
}
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const tts = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $v=$s.GetInstalledVoices() | Where-Object {$_.VoiceInfo.Culture.Name -eq "zh-CN"} | Select-Object -First 1; if($v){$s.SelectVoice($v.VoiceInfo.Name)}; $s.Rate=-1; $s.SetOutputToWaveFile($env:AGENTPLAY_SMOKE_WAV); $s.Speak($env:AGENTPLAY_SMOKE_TEXT); $s.Dispose()'], {
  encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENTPLAY_SMOKE_WAV: wavPath, AGENTPLAY_SMOKE_TEXT: speechText }
})
if (tts.status !== 0 || !fs.existsSync(wavPath)) throw new Error(tts.stderr || 'SAPI中文语音夹具生成失败')
const duration = probeDuration(wavPath)
const sourceBuild = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x315A8A:s=640x360:r=25:d=${duration.toFixed(3)}`, '-i', wavPath, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath], { encoding: 'utf8', windowsHide: true })
if (sourceBuild.status !== 0 || !fs.existsSync(sourcePath)) throw new Error(sourceBuild.stderr || '逐词剪辑视频夹具生成失败')

const expectedBase = path.join(mediaDir, 'expected-words')
const wordRun = spawnSync(whisperCli, ['-m', 'ggml-tiny.bin', '-l', 'zh', '-f', wavPath, '-nt', '-np', '-sow', '-ojf', '-dtw', 'tiny', '-nfa', '-of', expectedBase], { cwd: whisperRoot, encoding: 'utf8', windowsHide: true, timeout: 120000 })
if (wordRun.status !== 0 || !fs.existsSync(`${expectedBase}.json`)) throw new Error(wordRun.stderr || '独立逐词证据生成失败')
const wordPayload = JSON.parse(fs.readFileSync(`${expectedBase}.json`, 'utf8'))
const tokens = wordPayload.transcription.flatMap((segment) => segment.tokens || []).filter((token) => Number(token.t_dtw) >= 0 && !/^\[?_.*_\]?$/.test(String(token.text || '').trim()))
const groups = []
for (const token of tokens) { const text = String(token.text || '').trim(); const last = groups.at(-1); if (last?.dtw === token.t_dtw) last.text += text; else groups.push({ text, dtw: Number(token.t_dtw) }) }
const fillerIndex = groups.findIndex((item) => item.text === '就是')
if (fillerIndex < 0 || !groups[fillerIndex + 1] || groups[fillerIndex + 1].dtw <= groups[fillerIndex].dtw) throw new Error('SAPI夹具没有形成“就是”的独立DTW词界')
const expectedWord = { startSeconds: groups[fillerIndex].dtw / 100, endSeconds: groups[fillerIndex + 1].dtw / 100 }
const phrase = '今天我们介绍产品'
const expectedPhrase = findPhraseWordTiming(parseWhisperWordJson(wordPayload), phrase)
if (!expectedPhrase) throw new Error('SAPI夹具没有形成唯一、完整且起于真实词界的目标短语')
const cueStart = Math.max(0.1, expectedWord.startSeconds - 0.18)
const cueEnd = Math.min(duration - 0.1, Math.max(expectedWord.endSeconds + 1.8, expectedPhrase.endSeconds + 0.18))
fs.writeFileSync(subtitlePath, `1\n${srtTime(0)} --> ${srtTime(cueStart)}\n欢迎大家\n\n2\n${srtTime(cueStart)} --> ${srtTime(cueEnd)}\n就是，今天我们介绍产品\n\n3\n${srtTime(cueEnd)} --> ${srtTime(duration)}\n接下来介绍功能，谢谢大家\n`, 'utf8')
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
    const evidence = plan.decision?.semanticCut?.wordTimingEvidence?.[0]
    if (!plan.matched || !evidence || plan.decision.semanticCut.confirmationRequired !== true || plan.decision.semanticCut.removed.length !== 1) throw new Error('安装态逐词剪辑方案不合格：' + JSON.stringify(plan))
    const input = document.querySelector('.agent-composer input[type="text"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(instruction)}); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(instruction)} })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    await waitFor(() => document.body.innerText.includes('逐词对齐口头禅') && document.body.innerText.includes('请回复“确认执行”或“取消”'), '逐词确认方案可见', 120000)
    const before = (await window.aiPlayer.taskRuntime.list()).filter((item) => item.type === 'media.edit-concat').length
    if (before !== 0) throw new Error('确认前不应创建逐词剪辑任务')
    setter.call(input, '确认执行'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '确认执行' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const task = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const found = [...items].reverse().find((item) => item.type === 'media.edit-concat'); return found && ['completed','failed','cancelled'].includes(found.state) ? found : null }, '逐词剪辑任务完成', 180000)
    if (task.state !== 'completed' || task.quality?.passed !== true || task.result?.semanticCut?.wordTimingEvidence?.length !== 1) throw new Error(task.error || '逐词剪辑质量门失败')
    const preview = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - task.spec.decision.timeline.durationSeconds) <= 0.25 ? { duration: video.duration } : null }, '自动预览逐词剪辑成片', 30000)
    setter.call(input, '撤销刚才的剪辑'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '撤销刚才的剪辑' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const undo = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - initial.duration) <= 0.25 ? { duration: video.duration } : null }, '逐词剪辑撤销回原片', 30000)
    const phrasePlan = await window.aiPlayer.mediaTools.planEdit({ instruction: ${JSON.stringify(phraseInstruction)}, sourcePath: ${JSON.stringify(sourcePath)} })
    const phraseEvidence = phrasePlan.decision?.semanticLocate?.wordTimingEvidence
    if (!phrasePlan.matched || phrasePlan.decision?.kind !== 'media.trim' || phrasePlan.decision?.semanticLocate?.strategy !== 'whisper-dtw-phrase-start-v1' || !phraseEvidence) throw new Error('安装态句中原话逐词定位方案不合格：' + JSON.stringify(phrasePlan))
    setter.call(input, ${JSON.stringify(phraseInstruction)}); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(phraseInstruction)} })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const phraseTask = await waitFor(async () => { const items = await window.aiPlayer.taskRuntime.list(); const found = [...items].reverse().find((item) => item.type === 'media.edit-trim' && item.spec?.decision?.semanticLocate?.strategy === 'whisper-dtw-phrase-start-v1'); return found && ['completed','failed','cancelled'].includes(found.state) ? found : null }, '句中原话逐词剪辑任务完成', 180000)
    if (phraseTask.state !== 'completed' || phraseTask.quality?.passed !== true || !phraseTask.result?.semanticLocate?.wordTimingEvidence) throw new Error(phraseTask.error || '句中原话逐词剪辑质量门失败')
    const phrasePreview = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - phraseTask.spec.decision.timeline.durationSeconds) <= 0.25 ? { duration: video.duration } : null }, '自动预览句中原话成片', 30000)
    if (!document.body.innerText.includes('Whisper DTW逐词定位')) throw new Error('对话没有显示句中原话逐词证据')
    setter.call(input, '撤销刚才的剪辑'); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '撤销刚才的剪辑' })); await wait(100); document.querySelector('button[aria-label="发送"]')?.click()
    const phraseUndo = await waitFor(() => { const video = document.querySelector('video[data-ai-player-video="true"]'); return video && Math.abs(video.duration - initial.duration) <= 0.25 ? { duration: video.duration } : null }, '句中原话剪辑撤销回原片', 30000)
    return { initial, plan, task, preview, undo, phrasePlan, phraseTask, phrasePreview, phraseUndo, body: document.body.innerText }
  })()`)
  const evidence = pageResult.plan.decision.semanticCut.wordTimingEvidence[0]
  if (Math.abs(evidence.startSeconds - expectedWord.startSeconds) > 0.8 || Math.abs(evidence.endSeconds - expectedWord.endSeconds) > 0.8) throw new Error('安装态逐词边界与独立DTW证据偏差过大')
  const phraseEvidence = pageResult.phrasePlan.decision.semanticLocate.wordTimingEvidence
  if (Math.abs(phraseEvidence.phraseStartSeconds - expectedPhrase.startSeconds) > 0.8 || Math.abs(phraseEvidence.phraseEndSeconds - expectedPhrase.endSeconds) > 0.8) throw new Error('安装态句中原话边界与独立DTW证据偏差过大')
  const outputPath = pageResult.task.result.outputPath
  const receipt = { acceptedAt: new Date().toISOString(), executable, source: { path: sourcePath, durationSeconds: probeDuration(sourcePath), sha256: sourceHash, unchanged: sha256(sourcePath) === sourceHash }, expectedWord, expectedPhrase, decision: pageResult.plan.decision, result: { outputPath, durationSeconds: probeDuration(outputPath), quality: pageResult.task.quality }, phrase: { decision: pageResult.phrasePlan.decision, outputPath: pageResult.phraseTask.result.outputPath, durationSeconds: probeDuration(pageResult.phraseTask.result.outputPath), quality: pageResult.phraseTask.quality }, ui: { confirmationVisible: pageResult.body.includes('请回复“确认执行”或“取消”'), phraseEvidenceVisible: pageResult.body.includes('Whisper DTW逐词定位'), previewDuration: pageResult.preview.duration, undoDuration: pageResult.undo.duration, phrasePreviewDuration: pageResult.phrasePreview.duration, phraseUndoDuration: pageResult.phraseUndo.duration } }
  if (!receipt.source.unchanged || !fs.existsSync(outputPath) || !fs.existsSync(receipt.phrase.outputPath)) throw new Error('安装态逐词成果或原件保护失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, expectedWord, actualWord: evidence, quality: receipt.result.quality.score, outputDuration: receipt.result.durationSeconds, undoDuration: receipt.ui.undoDuration, expectedPhrase, actualPhrase: phraseEvidence, phraseQuality: receipt.phrase.quality.score, phraseDuration: receipt.phrase.durationSeconds, phraseUndoDuration: receipt.ui.phraseUndoDuration, sourceUnchanged: true })}\n`)
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}
