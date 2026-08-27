import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { parseWhisperWordJson } = require('../electron/word-timing-service')
const { acousticEmbedding, clusterSpeakers } = require('../electron/professional-subtitle-service')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueArg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const executable = path.resolve(valueArg('--exe') || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-professional-subtitle-'))
const mediaDir = path.join(profileDir, 'media'); const sourcePath = path.join(mediaDir, 'dialogue.mp4'); const subtitlePath = path.join(mediaDir, 'dialogue.srt'); const speechPath = path.join(mediaDir, 'speech.wav'); const extractedPath = path.join(mediaDir, 'extracted.wav')
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'); const whisperRoot = path.join(appData, 'ai-player', 'whisper-pack'); const ffmpegRoot = path.join(appData, 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpeg = path.join(ffmpegRoot, 'bin', 'ffmpeg.exe'); const ffprobe = path.join(ffmpegRoot, 'bin', 'ffprobe.exe'); const mpv = path.join(root, 'release', 'win-unpacked', 'resources', 'bin', 'win', 'mpv.com'); const whisper = path.join(whisperRoot, 'engine', 'whisper-cli.exe')
const wordModel = 'ggml-tiny.bin'
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'professional-subtitle-d1-packaged', 'receipt.json')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const probeDuration = (file) => Number(String(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true }).stdout).trim()) || 0
const srtTime = (seconds) => { const ms = Math.max(0, Math.round(seconds * 1000)); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0')}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}` }
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeout = 6000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeout); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }
let cleaned = false
function cleanup() { if (cleaned) return; const resolved = path.resolve(profileDir); if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(resolved).startsWith('agentplay-packaged-professional-subtitle-')) throw new Error(`拒绝清理非验收目录：${resolved}`); for (const name of ['whisper-pack', path.join('yt-dlp', 'ffmpeg-8.0.1-essentials_build')]) { const item = path.join(profileDir, name); try { if (fs.lstatSync(item).isSymbolicLink()) fs.unlinkSync(item) } catch {} } fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); cleaned = true }
async function cleanupEventually() { let lastError; for (let attempt = 0; attempt < 10; attempt += 1) { try { cleanup(); return true } catch (error) { lastError = error; await wait(500) } } process.stderr.write(`D1验收临时目录稍后由系统清理：${String(lastError?.message || lastError)}\n`); return false }
process.once('exit', () => { try { cleanup() } catch {} })

if (![executable, ffmpeg, ffprobe, mpv, whisper, path.join(whisperRoot, 'ggml-tiny.bin')].every(fs.existsSync)) throw new Error('缺少D1安装态验收所需组件')
fs.mkdirSync(mediaDir, { recursive: true })
for (const [target, source] of [[path.join(profileDir, 'whisper-pack'), whisperRoot], [path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build'), ffmpegRoot]]) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.symlinkSync(source, target, 'junction') }
const powershell = process.env.AGENTPLAY_PWSH || 'pwsh.exe'
const phrases = ['产品价格透明一号', '服务现在开始一号', '产品价格透明二号', '服务现在开始二号']
const speakerVoices = ['Microsoft Huihui Desktop', 'Microsoft Kangkang']
const segments = []; const segmentDurations = []
for (const [index, text] of phrases.entries()) {
  const raw = path.join(mediaDir, `raw-${index}.wav`); const target = path.join(mediaDir, `speaker-${index}.wav`)
  const tts = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice($env:AGENTPLAY_VOICE); $s.Rate=-1; $s.SetOutputToWaveFile($env:AGENTPLAY_WAV); $s.Speak($env:AGENTPLAY_TEXT); $s.Dispose()'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, AGENTPLAY_WAV: raw, AGENTPLAY_TEXT: text, AGENTPLAY_VOICE: speakerVoices[index % 2] } })
  if (tts.status !== 0 || !fs.existsSync(raw)) throw new Error(tts.stderr || 'D1 SAPI夹具生成失败')
  const sampleRate = Number(String(spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', raw], { encoding: 'utf8', windowsHide: true }).stdout).trim())
  if (!(sampleRate > 0)) throw new Error('D1无法读取SAPI采样率')
  const filter = index % 2 ? `asetrate=${Math.round(sampleRate * 1.5)},aresample=44100,atempo=0.666667` : 'aresample=44100'
  const converted = spawnSync(ffmpeg, ['-y', '-i', raw, '-af', filter, '-ac', '1', '-c:a', 'pcm_s16le', target, '-loglevel', 'error'], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  if (converted.status !== 0) throw new Error(converted.stderr || 'D1声纹夹具变换失败')
  segments.push(target)
  segmentDurations.push(probeDuration(target))
}
const silence = path.join(mediaDir, 'silence.wav'); spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '0.3', '-c:a', 'pcm_s16le', silence, '-loglevel', 'error'], { windowsHide: true })
const silenceDuration = probeDuration(silence)
const fixtureEmbeddings = segments.map((segment) => {
  const decoded = spawnSync(ffmpeg, ['-i', segment, '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1', '-loglevel', 'error'], { windowsHide: true, encoding: null, maxBuffer: 16 * 1024 * 1024 })
  if (decoded.status !== 0) throw new Error(String(decoded.stderr || 'D1声纹夹具解码失败'))
  return acousticEmbedding(decoded.stdout, 8000)
})
const fixtureAssignments = clusterSpeakers(fixtureEmbeddings).assignments
if (JSON.stringify(fixtureAssignments) !== '[0,1,0,1]') throw new Error(`D1双说话人夹具没有形成交替声纹真值：${JSON.stringify({ fixtureAssignments, fixtureEmbeddings })}`)
const concatInputs = []; const labels = []
segments.forEach((segment, index) => { concatInputs.push('-i', segment); labels.push(`[${concatInputs.filter((item) => item === '-i').length - 1}:a]`); if (index < segments.length - 1) { concatInputs.push('-i', silence); labels.push(`[${concatInputs.filter((item) => item === '-i').length - 1}:a]`) } })
const joined = spawnSync(ffmpeg, ['-y', ...concatInputs, '-filter_complex', `${labels.join('')}concat=n=${labels.length}:v=0:a=1[a]`, '-map', '[a]', '-c:a', 'pcm_s16le', speechPath, '-loglevel', 'error'], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
if (joined.status !== 0) throw new Error(joined.stderr || 'D1多说话人音频拼接失败')
const duration = probeDuration(speechPath)
const video = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `testsrc2=s=640x360:r=20:d=${duration.toFixed(3)}`, '-i', speechPath, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', sourcePath, '-loglevel', 'error'], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
if (video.status !== 0) throw new Error(video.stderr || 'D1视频夹具生成失败')
const extracted = spawnSync(mpv, ['--no-video', '--ao=pcm', `--ao-pcm-file=${extractedPath}`, sourcePath], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
if (extracted.status !== 0 || !fs.existsSync(extractedPath)) throw new Error(extracted.stderr || 'D1视频音轨提取失败')
const extractedDuration = probeDuration(extractedPath)
const decodeTimelineOffset = Math.max(0, extractedDuration - duration)
const wordBase = path.join(mediaDir, 'words'); const dtwPreset = wordModel.replace(/^ggml-/, '').replace(/\.bin$/, ''); const wordRun = spawnSync(whisper, ['-m', wordModel, '-l', 'zh', '-f', extractedPath, '-nt', '-np', '-sow', '-ojf', '-dtw', dtwPreset, '-nfa', '-of', wordBase], { cwd: whisperRoot, encoding: 'utf8', windowsHide: true, timeout: 240000 })
if (wordRun.status !== 0 || !fs.existsSync(`${wordBase}.json`)) throw new Error(wordRun.stderr || 'D1独立逐词证据失败')
const detectedWords = parseWhisperWordJson(JSON.parse(fs.readFileSync(`${wordBase}.json`, 'utf8'))).filter((word) => word.confidence >= 0.15)
const silenceRun = spawnSync(ffmpeg, ['-i', extractedPath, '-af', 'silencedetect=noise=-38dB:d=0.18', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
const silenceStarts = [...String(silenceRun.stderr).matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]))
const silenceEnds = [...String(silenceRun.stderr).matchAll(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g)].map((match) => ({ end: Number(match[1]), duration: Number(match[2]) }))
const silenceCandidates = silenceEnds.map((entry, index) => ({ start: silenceStarts[index], ...entry })).filter((entry) => Number.isFinite(entry.start) && entry.start > 0.05 && entry.end < duration - 0.05)
const silenceBoundaries = []; let fixtureCursor = 0
for (let index = 0; index < segmentDurations.length - 1; index += 1) {
  fixtureCursor += segmentDurations[index]
  const boundary = fixtureCursor + silenceDuration / 2 + decodeTimelineOffset
  const detected = silenceCandidates.find((item) => item.start <= boundary && item.end >= boundary)
  if (!detected || !(detected.duration > 0.18)) throw new Error(`D1独立音频证据没有覆盖夹具静音边界${index + 1}：${JSON.stringify({ boundary, silenceCandidates })}`)
  silenceBoundaries.push(boundary)
  fixtureCursor += silenceDuration
}
const cueGroups = Array.from({ length: 4 }, () => [])
for (const word of detectedWords) {
  const groupIndex = silenceBoundaries.filter((boundary) => Number(word.startSeconds) >= boundary).length
  cueGroups[groupIndex].push(word)
}
if (cueGroups.some((group) => !group.length)) throw new Error(`D1独立逐词证据没有覆盖四段对白：${JSON.stringify(cueGroups.map((group) => group.length))}`)
const wordMidpoint = (word) => (Number(word.startSeconds) + Number(word.endSeconds)) / 2
const cueRanges = cueGroups.map((group, index) => ({
  startSeconds: index === 0 ? Number(group[0].startSeconds) : (wordMidpoint(cueGroups[index - 1].at(-1)) + wordMidpoint(group[0])) / 2,
  endSeconds: index === cueGroups.length - 1 ? Number(group.at(-1).endSeconds) : (wordMidpoint(group.at(-1)) + wordMidpoint(cueGroups[index + 1][0])) / 2
}))
fs.writeFileSync(subtitlePath, cueGroups.map((group, index) => `${index + 1}\n${srtTime(cueRanges[index].startSeconds)} --> ${srtTime(cueRanges[index].endSeconds)}\n${group.map((word) => word.text.trim()).join('')}`).join('\n\n') + '\n', 'utf8')
const keywordValues = [...new Set([cueGroups[0][0].text.trim(), cueGroups.at(-1)[0].text.trim()].filter(Boolean))]
const instruction = `把字幕 ${subtitlePath} 做成专业动态字幕：识别说话人、逐词高亮、卡拉OK，关键词：${keywordValues.join('、')}；自动避开画面安全区`
const before = { source: sha256(sourcePath), subtitle: sha256(subtitlePath) }

const port = await freePort(); const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--window-position=-2400,-2400', sourcePath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
try {
  let page
  for (let attempt = 0; attempt < 300; attempt += 1) { if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`); try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page') } catch {}; if (page?.webSocketDebuggerUrl) break; await wait(250) }
  if (!page?.webSocketDebuggerUrl) throw new Error('D1候选应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let id = 0
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const job = pending.get(message.id); if (!job) return; pending.delete(message.id); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable'); await command('Page.enable')
  const pageResult = await evaluate(`(async () => {
    const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms)); const waitFor=async(probe,label,timeout=300000)=>{const started=Date.now();while(Date.now()-started<timeout){const value=await probe();if(value)return value;await wait(120)}throw new Error('等待超时：'+label)}
    await waitFor(()=>document.readyState==='complete'&&window.aiPlayer?.mediaTools?.planEdit,'桌面桥接'); await waitFor(()=>{const v=document.querySelector('video[data-ai-player-video="true"]');return v&&v.readyState>=1&&v.duration>0},'视频就绪',60000)
    window.aiPlayer.menu.confirmOpenFile?.(${JSON.stringify(subtitlePath)}); await wait(100)
    const runtimeButton=[...document.querySelectorAll('button')].find((button)=>button.title==='运行与隐私'||button.innerText.includes('运行与隐私'));runtimeButton?.click();await wait(100);const work=[...document.querySelectorAll('[aria-label="Agent 工作方式"] button')].find((button)=>button.innerText.trim()==='执行');work?.click();await wait(100);runtimeButton?.click()
    const plan=await window.aiPlayer.mediaTools.planEdit({instruction:${JSON.stringify(instruction)},sourcePath:${JSON.stringify(sourcePath)}}); if(!plan.matched||plan.decision?.kind!=='media.burn-subtitles'||plan.decision.subtitle?.professional?.strategy!=='acoustic-speaker-karaoke-v1')throw new Error('D1方案不合格：'+JSON.stringify(plan).slice(0,1200))
    const input=document.querySelector('.agent-composer input[type="text"],input[placeholder*="完成什么"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(instruction)});input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(instruction)}}));await wait(100);document.querySelector('button[aria-label="发送"]')?.click()
    const task=await waitFor(async()=>{const items=await window.aiPlayer.taskRuntime.list();const item=[...items].reverse().find((entry)=>entry.type==='media.edit-burn-subtitles');return item&&['completed','failed','cancelled'].includes(item.state)?item:null},'D1任务完成',420000)
    if(task.state!=='completed')throw new Error((task.error||task.status)+'；'+JSON.stringify(task).slice(0,1600)); const proof=task.result?.professionalSubtitleProof
    const quality100=task.quality?.score===100&&task.quality?.passed===true; const speakerCount=proof?.speakerEvidence?.speakerCount; const speakerAssignments=task.result?.professionalSubtitle?.speakers?.assignments; const speakerCues=task.result?.professionalSubtitle?.speakers?.cues; const wordCount=proof?.wordTimingEvidence?.wordCount; const karaoke=proof?.karaokeEvidence?.tagCount; const emphasisCount=proof?.keywordEvidence?.emphasisCount; const chosenZone=proof?.safeArea?.chosenZone
    if(!quality100||speakerCount!==2||JSON.stringify(speakerAssignments)!=='[0,1,0,1]'||wordCount<4||karaoke!==wordCount||emphasisCount<1||!['top','bottom'].includes(chosenZone)||proof.safeArea.subtitleInChosenZone!==true)throw new Error('D1五项证据不完整：'+JSON.stringify({quality100,speakerCount,speakerAssignments,speakerCues,wordCount,karaoke,emphasisCount,chosenZone,proof}).slice(0,1800))
    if(!document.body.innerText.includes('专业动态字幕')||!document.body.innerText.includes('说话人'))throw new Error('D1对话回执不可见')
    return {version:window.aiPlayer.version,task,quality100,speakerCount,speakerAssignments,wordCount,karaoke,emphasisCount,chosenZone}
  })()`)
  const after = { source: sha256(sourcePath), subtitle: sha256(subtitlePath) }; const sourceHashesUnchanged = JSON.stringify(before) === JSON.stringify(after)
  if (!sourceHashesUnchanged || !fs.existsSync(pageResult.task.result.outputPath)) throw new Error('D1源文件保护或成果失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), executable, before, after, sourceHashesUnchanged, fixtureAssignments, independentWordCount: detectedWords.length, keywords: keywordValues, pageResult }, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, quality100: pageResult.quality100, speakerCount: pageResult.speakerCount, wordCount: pageResult.wordCount, karaoke: pageResult.karaoke, emphasisCount: pageResult.emphasisCount, chosenZone: pageResult.chosenZone, sourceHashesUnchanged }, null, 2)}\n`)
  await Promise.race([command('Browser.close'), wait(1200)]).catch(()=>{})
} finally { if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) } try { socket?.close() } catch {}; await wait(1200); await cleanupEventually() }
