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
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-personal-skill-e2-'))
const mediaDir = path.join(profileDir, 'media')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'personal-edit-skill-e2-packaged')
const installedFfmpeg = path.join(process.env.APPDATA || '', 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpeg = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe')
const sourcePath = path.join(mediaDir, 'e2-source.mp4')
const musicPath = path.join(mediaDir, 'e2-music.wav')
const saveInstruction = '以后这类视频都按快节奏、纪录片字幕和-16 LUFS处理，保存为“知识口播”'
const updateInstruction = '把“知识口播”改成克制节奏、简洁字幕、-18 LUFS'
const editInstruction = `给视频加背景音乐 ${musicPath}`
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => { child.off('exit', done); resolve(false) }, timeoutMs); const done = () => { clearTimeout(timer); resolve(true) }; child.once('exit', done) }) }
async function openSession() {
  const port = await freePort(); const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', sourcePath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
  let page
  for (let attempt = 0; attempt < 300; attempt += 1) { if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`); try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page') } catch {}; if (page?.webSocketDebuggerUrl) break; await wait(250) }
  if (!page?.webSocketDebuggerUrl) throw new Error('候选应用未开放调试页面')
  const websocket = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let nextId = 0
  websocket.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (!message.id || !pending.has(message.id)) return; const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result) })
  await new Promise((resolve, reject) => { websocket.addEventListener('open', resolve, { once: true }); websocket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => { const id = ++nextId; websocket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
  const evaluate = async (expression, awaitPromise = false) => { const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable'); return { child, websocket, command, evaluate }
}
async function closeSession(session) { try { await Promise.race([session.command('Browser.close'), wait(1500)]) } catch {}; await waitForExit(session.child, 8000); if (session.child.exitCode === null) session.child.kill(); try { session.websocket.close() } catch {} }
function cleanup() { const resolved = path.resolve(profileDir); if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(resolved).startsWith('agentplay-packaged-personal-skill-e2-')) throw new Error(`拒绝清理非验收目录：${resolved}`); try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}; fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }

let session
try {
  if (!fs.existsSync(executable) || !fs.existsSync(ffmpeg)) throw new Error('缺少候选EXE或已安装FFmpeg')
  fs.mkdirSync(mediaDir, { recursive: true }); fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true }); fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction'); fs.mkdirSync(evidenceDir, { recursive: true })
  let made = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x360:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', sourcePath, '-loglevel', 'error'], { windowsHide: true, shell: false }); if (made.status !== 0) throw new Error(String(made.stderr).slice(-500))
  made = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-y', musicPath, '-loglevel', 'error'], { windowsHide: true, shell: false }); if (made.status !== 0) throw new Error(String(made.stderr).slice(-500))
  const sourceHash = sha256(sourcePath); const musicHash = sha256(musicPath)
  session = await openSession()
  await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<300;i++){if(document.readyState==='complete'&&window.aiPlayer?.personalEditSkills?.execute&&document.querySelector('video[data-ai-player-video="true"]')?.duration>0)return true;await wait(100)}throw new Error('E2桥接或视频未就绪')})()`, true)
  const lifecycle = await session.evaluate(`(async()=>{const saved=await window.aiPlayer.personalEditSkills.execute({instruction:${JSON.stringify(saveInstruction)}});const viewed=await window.aiPlayer.personalEditSkills.list();const updated=await window.aiPlayer.personalEditSkills.execute({instruction:${JSON.stringify(updateInstruction)}});const disabled=await window.aiPlayer.personalEditSkills.execute({instruction:'停用“知识口播”'});window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(musicPath)});await new Promise(r=>setTimeout(r,100));const disabledPlan=await window.aiPlayer.mediaTools.planEdit({instruction:${JSON.stringify(editInstruction)},sourcePath:${JSON.stringify(sourcePath)}});const enabled=await window.aiPlayer.personalEditSkills.execute({instruction:'启用“知识口播”'});const enabledPlan=await window.aiPlayer.mediaTools.planEdit({instruction:${JSON.stringify(editInstruction)},sourcePath:${JSON.stringify(sourcePath)}});return{saved,viewed,updated,disabled,enabled,disabledHasSkill:!!disabledPlan.decision?.personalEditSkill,enabledPlan}})()`, true)
  const markers = { saved: lifecycle.saved?.skill?.revision === 1, viewed: lifecycle.viewed?.skills?.length === 1, updated: lifecycle.updated?.skill?.revision === 2 && lifecycle.updated?.skill?.settings?.targetLufs === -18, disabled: lifecycle.disabled?.skill?.enabled === false && lifecycle.disabledHasSkill === false, enabled: lifecycle.enabled?.skill?.enabled === true && lifecycle.enabledPlan?.decision?.personalEditSkill?.name === '知识口播' }
  if (Object.values(markers).some((value) => value !== true)) throw new Error(`E2管理生命周期不合格：${JSON.stringify({ markers, lifecycle }).slice(0, 2400)}`)
  const appliedDigest = lifecycle.enabledPlan.decision.personalEditSkill.digest; if (lifecycle.enabledPlan.decision.audio?.loudness?.targetLufs !== -18 || lifecycle.enabledPlan.decision.personalEditSkill.fieldsApplied[0] !== 'audio.targetLufs') throw new Error('E2默认值没有进入冻结剪辑决策')
  await closeSession(session); session = await openSession()
  const restart = await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<300;i++){if(window.aiPlayer?.personalEditSkills?.list&&document.querySelector('video[data-ai-player-video="true"]')?.duration>0)break;await wait(100)}const state=await window.aiPlayer.personalEditSkills.list();window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(musicPath)});await wait(100);const plan=await window.aiPlayer.mediaTools.planEdit({instruction:${JSON.stringify(editInstruction)},sourcePath:${JSON.stringify(sourcePath)}});return{state,plan}})()`, true)
  const restartPersisted = restart.state?.active?.digest === appliedDigest && restart.plan?.decision?.personalEditSkill?.digest === appliedDigest
  if (!restartPersisted) throw new Error('E2重启后Skill或默认值未恢复')
  await session.evaluate(`(async()=>{const input=document.querySelector('.agent-composer input[type="text"],input[placeholder*="完成什么"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(editInstruction)});input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(editInstruction)}}));await new Promise(r=>setTimeout(r,180));document.querySelector('button[aria-label="发送"]')?.click();return true})()`, true)
  const task = await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<3600;i++){const item=[...(await window.aiPlayer.taskRuntime.list())].reverse().find(x=>x.type==='media.edit-music');if(item&&['completed','failed','cancelled'].includes(item.state))return item;await wait(100)}throw new Error('E2应用任务超时')})()`, true)
  if (task.state !== 'completed' || task.quality?.score !== 100 || task.spec?.decision?.personalEditSkill?.digest !== appliedDigest || task.spec?.decision?.audio?.loudness?.targetLufs !== -18) throw new Error(`E2实际应用失败：${JSON.stringify({ state: task.state, error: task.error, quality: task.quality, skill: task.spec?.decision?.personalEditSkill, loudness: task.spec?.decision?.audio?.loudness }).slice(0, 5000)}`)
  if (sha256(sourcePath) !== sourceHash || sha256(musicPath) !== musicHash) throw new Error('E2应用改写了源视频或音乐')
  const persistedOutput = path.join(evidenceDir, 'e2-applied-skill.mp4'); fs.copyFileSync(task.result.outputPath, persistedOutput)
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const screenshotPath = path.join(evidenceDir, 'conversation-result.png'); fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const receipt = { passed: true, checkedAt: new Date().toISOString(), saved: markers.saved, viewed: markers.viewed, updated: markers.updated, disabled: markers.disabled, enabled: markers.enabled, appliedDigest, restartPersisted, qualityScore: task.quality.score, targetLufs: task.spec.decision.audio.loudness.targetLufs, sourceHashesUnchanged: true, output: { name: path.basename(persistedOutput), bytes: fs.statSync(persistedOutput).size, sha256: sha256(persistedOutput) }, screenshotPath }
  const receiptPath = path.join(evidenceDir, 'receipt.json'); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, saved: receipt.saved, viewed: receipt.viewed, updated: receipt.updated, disabled: receipt.disabled, enabled: receipt.enabled, appliedDigest, restartPersisted, qualityScore: receipt.qualityScore, targetLufs: receipt.targetLufs }, null, 2)}\n`)
} finally { if (session) await closeSession(session); cleanup() }
