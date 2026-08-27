import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { E5_GROUPS, percentile, validateTechnicalReceipt } from './lib/professional-corpus-e5.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueArg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const executable = path.resolve(valueArg('--exe') || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-professional-corpus-e5-'))
const sourceDir = path.join(profileDir, 'sources')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'professional-corpus-e5-packaged')
const evidenceMediaDir = path.join(evidenceDir, 'media')
const thumbDir = path.join(evidenceDir, 'thumbs')
const installedFfmpeg = path.join(process.env.APPDATA || '', 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpeg = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe')
const ffprobe = path.join(installedFfmpeg, 'bin', 'ffprobe.exe')
const musicPath = path.join(sourceDir, 'e5-self-generated-music.wav')
const dimensions = ['640x360', '360x640', '512x512', '854x480']
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const elapsedMs = (started) => Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(1))
const run = (exe, args) => { const result = spawnSync(exe, args, { windowsHide: true, shell: false, encoding: 'utf8' }); if (result.status !== 0) throw new Error(`${path.basename(exe)}失败：${String(result.stderr || result.stdout).slice(-1200)}`); return result }

function probe(file) {
  const parsed = JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,codec_name', '-of', 'json', file]).stdout)
  const video = (parsed.streams || []).find((item) => item.codec_type === 'video')
  return { decodePassed: Boolean(video && Number(parsed.format?.duration) > 0), durationSeconds: Number(Number(parsed.format?.duration || 0).toFixed(3)), width: Number(video?.width) || 0, height: Number(video?.height) || 0, codec: String(video?.codec_name || ''), hasAudio: (parsed.streams || []).some((item) => item.codec_type === 'audio'), bytes: fs.statSync(file).size, sha256: sha256(file) }
}

async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => { child.off('exit', done); resolve(false) }, timeoutMs); const done = () => { clearTimeout(timer); resolve(true) }; child.once('exit', done) }) }
async function openSession(firstSource) {
  const port = await freePort(); const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', firstSource], { cwd: path.dirname(executable), windowsHide: true, shell: false })
  let page
  for (let attempt = 0; attempt < 300; attempt += 1) { if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`); try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page') } catch {}; if (page?.webSocketDebuggerUrl) break; await wait(250) }
  if (!page?.webSocketDebuggerUrl) throw new Error('E5应用未开放调试页面')
  const websocket = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let nextId = 0
  websocket.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (!message.id || !pending.has(message.id)) return; const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result) })
  await new Promise((resolve, reject) => { websocket.addEventListener('open', resolve, { once: true }); websocket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => { const id = ++nextId; websocket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
  const evaluate = async (expression, awaitPromise = false) => { const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable'); await command('Page.enable'); return { child, websocket, command, evaluate }
}
async function closeSession(session) { try { await Promise.race([session.command('Browser.close'), wait(1500)]) } catch {}; await waitForExit(session.child, 8000); if (session.child.exitCode === null) session.child.kill(); try { session.websocket.close() } catch {} }
function cleanup() { const resolved = path.resolve(profileDir); if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(resolved).startsWith('agentplay-professional-corpus-e5-')) throw new Error(`拒绝清理非验收目录：${resolved}`); try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}; fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }

function makeSheet(group, groupSamples) {
  const images = []
  for (const item of groupSamples) {
    const sourceThumb = path.join(thumbDir, `${item.id}-source.png`); const outputThumb = path.join(thumbDir, `${item.id}-output.png`)
    run(ffmpeg, ['-hide_banner', '-nostdin', '-ss', '2', '-i', item.evidenceSourcePath, '-frames:v', '1', '-y', sourceThumb, '-loglevel', 'error'])
    run(ffmpeg, ['-hide_banner', '-nostdin', '-ss', String(Math.min(2, Math.max(0.4, item.output.durationSeconds / 2))), '-i', item.evidenceOutputPath, '-frames:v', '1', '-y', outputThumb, '-loglevel', 'error'])
    images.push(sourceThumb, outputThumb)
  }
  const labels = images.map((_, index) => `[${index}:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black[v${index}]`).join(';')
  const rows = Array.from({ length: 4 }, (_, index) => `[v${index * 2}][v${index * 2 + 1}]hstack=inputs=2[r${index}]`).join(';')
  const sheet = path.join(evidenceDir, `contact-sheet-${group}.png`)
  run(ffmpeg, [...images.flatMap((file) => ['-i', file]), '-filter_complex', `${labels};${rows};[r0][r1][r2][r3]vstack=inputs=4[out]`, '-map', '[out]', '-frames:v', '1', '-y', sheet, '-loglevel', 'error'])
  return path.basename(sheet)
}

const samples = E5_GROUPS.flatMap((group, groupIndex) => Array.from({ length: 4 }, (_, index) => {
  const id = `${group}-${index + 1}`; const duration = Number((5.2 + index * 0.35).toFixed(2)); const sourcePath = path.join(sourceDir, `${id}-${dimensions[index]}.mp4`)
  return { id, group, index, groupIndex, duration, dimensions: dimensions[index], sourcePath, subtitlePath: group === 'subtitle' ? path.join(sourceDir, `${id}.srt`) : '' }
}))
const batchInstructions = {
  trim: '全部保留第1秒到第3.5秒', remove: '全部删除第1.5秒到第2.5秒',
  music: `全部添加背景音乐 ${musicPath}，音量15%，不要响度归一`,
  visual: '全部裁成9:16，放大1.08倍，做一个缓慢推近，亮度提高10%，对比度提高10%，饱和度提高10%'
}

let session
try {
  if (!fs.existsSync(executable) || !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) throw new Error('缺少E5候选EXE或FFmpeg/FFprobe')
  fs.rmSync(evidenceDir, { recursive: true, force: true }); fs.mkdirSync(sourceDir, { recursive: true }); fs.mkdirSync(evidenceMediaDir, { recursive: true }); fs.mkdirSync(thumbDir, { recursive: true }); fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true }); fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction')
  run(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=523:duration=8', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', musicPath, '-loglevel', 'error'])
  for (const sample of samples) {
    const hue = (sample.groupIndex * 4 + sample.index) * 23
    run(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', `testsrc2=duration=${sample.duration}:size=${sample.dimensions}:rate=15`, '-f', 'lavfi', '-i', `sine=frequency=${360 + sample.groupIndex * 90 + sample.index * 25}:duration=${sample.duration}`, '-vf', `hue=h=${hue}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', sample.sourcePath, '-loglevel', 'error'])
    sample.sourceSha256 = sha256(sample.sourcePath); sample.sourceProbe = probe(sample.sourcePath)
    if (sample.subtitlePath) fs.writeFileSync(sample.subtitlePath, `1\n00:00:00,400 --> 00:00:01,300\nAgentPlay 样本 ${sample.id}\n\n2\n00:00:01,600 --> 00:00:02,900\n统一入口，直接说出修改要求\n\n3\n00:00:03,200 --> 00:00:04,500\nPreview equals final delivery\n`, 'utf8')
  }
  session = await openSession(samples[0].sourcePath)
  await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<600;i++){if(window.aiPlayer?.mediaTools?.planBatchEdit&&window.aiPlayer?.taskRuntime?.list)return true;await wait(100)}throw new Error('E5桥接未就绪')})()`, true)
  const allAuthorized = [...samples.map((item) => item.sourcePath), musicPath, ...samples.filter((item) => item.subtitlePath).map((item) => item.subtitlePath)]
  await session.evaluate(`(async()=>{for(const p of ${JSON.stringify(allAuthorized)})window.aiPlayer.menu.confirmOpenFile(p);await new Promise(r=>setTimeout(r,300));return true})()`, true)
  const taskAttempts = new Map(); const technicalSamples = []; let totalElapsedMs = 0
  for (const group of E5_GROUPS.filter((item) => item !== 'subtitle')) {
    const groupSamples = samples.filter((item) => item.group === group); const sourcePaths = groupSamples.map((item) => item.sourcePath); const instruction = batchInstructions[group]
    const plan = await session.evaluate(`window.aiPlayer.mediaTools.planBatchEdit({instruction:${JSON.stringify(instruction)},sourcePaths:${JSON.stringify(sourcePaths)}})`, true)
    if (!plan?.matched || plan.plan?.items?.length !== 4) throw new Error(`E5 ${group}规划失败：${JSON.stringify(plan).slice(0, 2000)}`)
    const requestId = `e5-${group}-${Date.now()}`; const started = process.hrtime.bigint()
    const result = await session.evaluate(`window.aiPlayer.mediaTools.runBatchEdit({plan:${JSON.stringify(plan.plan)},requestId:${JSON.stringify(requestId)}})`, true)
    const elapsed = elapsedMs(started); totalElapsedMs += elapsed
    const task = await session.evaluate(`(async()=>{const x=(await window.aiPlayer.taskRuntime.list()).find(i=>i.id===${JSON.stringify(requestId)});return x})()`, true)
    if (!result?.success || task?.state !== 'completed' || task.quality?.score !== 100 || result.results?.some((item) => item.state !== 'succeeded')) throw new Error(`E5 ${group}执行失败：${JSON.stringify({ result, task }).slice(0, 4000)}`)
    taskAttempts.set(requestId, task.attempts)
    for (let index = 0; index < groupSamples.length; index += 1) {
      const sample = groupSamples[index]; const item = result.results[index]; const output = probe(item.outputPath)
      technicalSamples.push({ ...sample, operation: instruction, outputPath: item.outputPath, output, qualityScore: item.qualityScore, governance: { digest: task.result.editGovernanceReceipt.governanceDigest, verifiedStep: task.result.editGovernanceReceipt.run.steps[0].evidence.verified, toolCalls: task.result.editGovernanceReceipt.run.budget.toolCalls }, elapsedMs: Number((elapsed / 4).toFixed(1)) })
    }
  }
  for (const sample of samples.filter((item) => item.group === 'subtitle')) {
    const instruction = `把字幕 ${sample.subtitlePath} 烧进视频，黄色大字顶部`; const plan = await session.evaluate(`window.aiPlayer.mediaTools.planEdit({instruction:${JSON.stringify(instruction)},sourcePath:${JSON.stringify(sample.sourcePath)}})`, true)
    if (!plan?.matched || plan.decision?.kind !== 'media.burn-subtitles') throw new Error(`E5字幕规划失败：${sample.id}`)
    const requestId = `e5-subtitle-${sample.index + 1}-${Date.now()}`; const started = process.hrtime.bigint()
    const result = await session.evaluate(`window.aiPlayer.mediaTools.trim({sourcePath:${JSON.stringify(sample.sourcePath)},instruction:${JSON.stringify(instruction)},decision:${JSON.stringify(plan.decision)},requestId:${JSON.stringify(requestId)}})`, true)
    const elapsed = elapsedMs(started); totalElapsedMs += elapsed
    const task = await session.evaluate(`(async()=>{return (await window.aiPlayer.taskRuntime.list()).find(i=>i.id===${JSON.stringify(requestId)})})()`, true)
    if (!result?.success || task?.state !== 'completed' || task.quality?.score !== 100 || task.result?.subtitlePreviewBurnProof?.sameArtifact !== true) throw new Error(`E5字幕执行失败：${sample.id}/${JSON.stringify({ result, task }).slice(0, 3000)}`)
    taskAttempts.set(requestId, task.attempts)
    technicalSamples.push({ ...sample, operation: instruction, outputPath: result.outputPath, output: probe(result.outputPath), qualityScore: task.quality.score, governance: { digest: task.result.editGovernanceReceipt.governanceDigest, verifiedStep: task.result.editGovernanceReceipt.run.steps[0].evidence.verified, toolCalls: task.result.editGovernanceReceipt.run.budget.toolCalls }, elapsedMs: elapsed })
  }
  for (const item of technicalSamples) {
    if (sha256(item.sourcePath) !== item.sourceSha256) throw new Error(`E5源文件被修改：${item.id}`)
    item.license = 'self-generated'; item.sourceHashUnchanged = true; item.source = { name: path.basename(item.sourcePath), sha256: item.sourceSha256, ...item.sourceProbe }
    const evidenceSourcePath = path.join(evidenceMediaDir, `${item.id}-source.mp4`); const evidenceOutputPath = path.join(evidenceMediaDir, `${item.id}-output.mp4`)
    fs.copyFileSync(item.sourcePath, evidenceSourcePath); fs.copyFileSync(item.outputPath, evidenceOutputPath); item.evidenceSourcePath = evidenceSourcePath; item.evidenceOutputPath = evidenceOutputPath
  }
  await closeSession(session); session = await openSession(samples[0].sourcePath)
  const restart = await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<600;i++){try{const items=await window.aiPlayer.taskRuntime.list();if(${JSON.stringify([...taskAttempts.keys()])}.every(id=>items.some(x=>x.id===id)))return items}catch{}await wait(100)}throw new Error('E5重启任务未恢复')})()`, true)
  const repeatedCompletedTasks = [...taskAttempts].filter(([id, attempts]) => restart.find((item) => item.id === id)?.attempts !== attempts).length
  const contactSheets = E5_GROUPS.map((group) => makeSheet(group, technicalSamples.filter((item) => item.group === group)))
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); fs.writeFileSync(path.join(evidenceDir, 'installed-task-center.png'), Buffer.from(screenshot.data, 'base64'))
  const publicOperation = { trim: '批量保留第1秒到第3.5秒', remove: '批量删除第1.5秒到第2.5秒', music: '批量添加自有生成音乐（音量15%，不做响度归一）', visual: '批量裁成9:16并执行推近与调色', subtitle: '烧录自有字幕（黄色大字顶部）' }
  const publicSamples = technicalSamples.map(({ sourcePath, outputPath, subtitlePath, sourceProbe, evidenceSourcePath, evidenceOutputPath, groupIndex, index, duration, dimensions: size, ...item }) => ({ ...item, operation: publicOperation[item.group], dimensions: size, source: item.source, output: item.output }))
  const elapsedValues = publicSamples.map((item) => item.elapsedMs)
  const technical = {
    schemaVersion: 1, kind: 'agentplay.professional-corpus-e5', checkedAt: new Date().toISOString(), installedAcceptance: true, executable: path.basename(executable), sampleLicense: 'self-generated', sampleCount: publicSamples.length, groups: E5_GROUPS, samples: publicSamples,
    performance: { sampleCount: publicSamples.length, taskCount: taskAttempts.size, totalElapsedMs: Number(totalElapsedMs.toFixed(1)), p50ElapsedMs: percentile(elapsedValues, 0.5), p95ElapsedMs: percentile(elapsedValues, 0.95), totalInputSeconds: Number(publicSamples.reduce((sum, item) => sum + item.source.durationSeconds, 0).toFixed(3)), totalOutputBytes: publicSamples.reduce((sum, item) => sum + item.output.bytes, 0), machine: { platform: process.platform, arch: process.arch, cpuCount: os.cpus().length, cpuModel: os.cpus()[0]?.model || '', totalMemoryBytes: os.totalmem() } },
    cost: { basis: 'local-deterministic-acceptance', cloudCalls: 0, usageTokens: 0, estimatedUsd: 0, electricityCost: 'unmeasured', note: '本轮只计算模型/API边际费用；未测电费，不把订阅套餐或本机资源冒充完全免费' },
    restart: { persisted: repeatedCompletedTasks === 0, taskCount: taskAttempts.size, repeatedCompletedTasks }, contactSheets, manualReviewStatus: 'pending'
  }
  validateTechnicalReceipt(technical)
  fs.writeFileSync(path.join(evidenceDir, 'technical-receipt.json'), `${JSON.stringify(technical, null, 2)}\n`, 'utf8')
  const reviewTemplate = { schemaVersion: 1, kind: 'agentplay.professional-corpus-e5-manual-review', reviewer: '', reviewedAt: '', contactSheets, decisions: publicSamples.map((item) => ({ id: item.id, verdict: 'pending', visualContinuity: false, operationMatched: false, artifactFree: false, note: '' })) }
  fs.writeFileSync(path.join(evidenceDir, 'manual-review-template.json'), `${JSON.stringify(reviewTemplate, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, technicalReceipt: path.join(evidenceDir, 'technical-receipt.json'), reviewTemplate: path.join(evidenceDir, 'manual-review-template.json'), samples: publicSamples.length, tasks: taskAttempts.size, performance: technical.performance, cost: technical.cost, contactSheets }, null, 2)}\n`)
} finally { if (session) await closeSession(session); cleanup() }
