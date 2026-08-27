import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueArg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const executable = path.resolve(valueArg('--exe') || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-ai-assets-e1-'))
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'ai-assets-e1-packaged')
const installedFfmpeg = path.join(process.env.APPDATA || '', 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const instruction = '补一个3秒清晨办公室镜头，生成一段简洁旁白和配音，再生成1秒清脆提示音'
const requestedKinds = ['shot', 'narration', 'voice', 'sound-effect']
const apiCalls = []
let apiEndpoint = ''
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => { child.off('exit', done); resolve(false) }, timeoutMs); const done = () => { clearTimeout(timer); resolve(true) }; child.once('exit', done) }) }
async function openSession() {
  const port = await freePort(); const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']; const child = spawn(executable, args, { cwd: path.dirname(executable), windowsHide: true, shell: false, env: { ...process.env, AGENTPLAY_E1_SMOKE_ENDPOINT: apiEndpoint } })
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
function cleanup() { const resolved = path.resolve(profileDir); if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(resolved).startsWith('agentplay-packaged-ai-assets-e1-')) throw new Error(`拒绝清理非验收目录：${resolved}`); try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}; fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }

let session
let apiServer
try {
  if (!fs.existsSync(executable)) throw new Error(`缺少待验收EXE：${executable}`)
  if (!fs.existsSync(path.join(installedFfmpeg, 'bin', 'ffmpeg.exe'))) throw new Error('缺少已安装FFmpeg')
  fs.mkdirSync(profileDir, { recursive: true }); fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true }); fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction'); fs.mkdirSync(evidenceDir, { recursive: true })
  const pngPath = path.join(profileDir, 'mock-shot.png'); const ffmpeg = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe'); const made = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=0x4f7cac:s=1280x720:d=0.1', '-frames:v', '1', '-y', pngPath, '-loglevel', 'error'], { windowsHide: true, shell: false }); if (made.status !== 0) throw new Error(`无法生成E1受控生图夹具：${String(made.stderr).slice(-500)}`)
  const imageBase64 = fs.readFileSync(pngPath).toString('base64'); const apiPort = await freePort(); apiEndpoint = `http://127.0.0.1:${apiPort}/v1`
  apiServer = http.createServer((request, response) => { let body = ''; request.on('data', (chunk) => { body += chunk }); request.on('end', () => { apiCalls.push({ path: request.url, bodyBytes: Buffer.byteLength(body) }); const payload = request.url === '/v1/chat/completions' ? { choices: [{ message: { content: JSON.stringify({ narration: '真正的效率，不是加速，而是少走弯路。', shotPrompt: '清晨办公室，柔和阳光掠过整洁桌面，镜头缓慢前推，写实清透，无文字无Logo', soundEffect: { kind: 'chime', label: '清脆确认音', durationSeconds: 1, frequencyHz: 880 } }) } }] } : request.url === '/v1/images/generations' ? { data: [{ b64_json: imageBase64 }] } : { data: [] }; const bytes = Buffer.from(JSON.stringify(payload)); response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length }); response.end(bytes) }) })
  await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(apiPort, '127.0.0.1', resolve) })
  session = await openSession()
  const planned = await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<300;i++){if(document.readyState==='complete'&&window.aiPlayer?.studio?.planAssets)return true;await wait(100)}throw new Error('E1桥接未就绪')})()`, true)
  if (!planned) throw new Error('E1桥接不可用')
  const preflight = await session.evaluate(`(async()=>{const before=await window.aiPlayer.taskRuntime.list();const plan=await window.aiPlayer.studio.planAssets({instruction:${JSON.stringify(instruction)}});const after=await window.aiPlayer.taskRuntime.list();return{before:before.length,after:after.length,plan}})()`, true)
  const preApprovalCalls = apiCalls.length
  if (preApprovalCalls !== 0 || !preflight.plan?.matched || JSON.stringify(preflight.plan.decision?.requestedKinds) !== JSON.stringify(requestedKinds)) throw new Error(`审批前规划不合格：${JSON.stringify(preflight)}`)
  await session.evaluate(`(async()=>{const input=document.querySelector('.agent-composer input[type="text"],input[placeholder*="完成什么"]');if(!input)throw new Error('没有对话输入框');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(instruction)});input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(instruction)}}));await new Promise(r=>setTimeout(r,180));const send=document.querySelector('button[aria-label="发送"]');if(!send)throw new Error('没有发送按钮');send.click();return true})()`, true)
  const task = await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<7200;i++){const tasks=await window.aiPlayer.taskRuntime.list();const item=[...tasks].reverse().find(x=>x.type==='creative.asset-bundle');if(item&&['completed','failed','cancelled'].includes(item.state))return item;await wait(100)}throw new Error('E1任务等待超时')})()`, true)
  if (task.state !== 'completed') throw new Error(`E1安装态任务失败：${task.error || task.status}`)
  const receipt = task.result?.aiAssetReceipt; const aiGenerated = receipt?.artifacts?.every((item) => item.aiGenerated === true && fs.existsSync(item.path) && sha256(item.path) === item.sha256)
  const sourceMediaUploaded = receipt?.sourceMediaUploaded
  const qualityScore = task.quality?.score
  if (task.approval?.status !== 'approved' || JSON.stringify(receipt?.requestedKinds) !== JSON.stringify(requestedKinds) || sourceMediaUploaded !== false || !aiGenerated || qualityScore !== 100 || task.result.outputs.length !== 5) throw new Error(`E1审批、来源或质量回执不合格：${JSON.stringify({ approval: task.approval?.status, requested: receipt?.requestedKinds, sourceMediaUploaded, aiGenerated, qualityScore, outputs: task.result?.outputs?.length })}`)
  if (apiCalls.filter((item) => item.path === '/v1/chat/completions').length !== 1 || apiCalls.filter((item) => item.path === '/v1/images/generations').length !== 1) throw new Error(`E1受控模型调用次数不合格：${JSON.stringify(apiCalls)}`)
  const attemptsBefore = task.attempts; const resumed = await session.evaluate(`window.aiPlayer.taskRuntime.resume({id:${JSON.stringify(task.id)},token:${JSON.stringify(task.resumeToken)}})`, true)
  const recoveryZeroCalls = resumed.attempts === attemptsBefore && resumed.state === 'completed' && resumed.result?.aiAssetReceipt?.recovery?.repeatedCloudCalls === 0
  if (!recoveryZeroCalls) throw new Error('E1完成态恢复重复调用或改变了attempts')
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const screenshotPath = path.join(evidenceDir, 'conversation-result.png'); fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const persistedOutputs = receipt.artifacts.map((item) => { const extension = path.extname(item.path); const persistedPath = path.join(evidenceDir, `e1-${item.kind}${extension}`); fs.copyFileSync(item.path, persistedPath); return { kind: item.kind, name: path.basename(persistedPath), bytes: item.bytes, sha256: item.sha256, generationMethod: item.generationMethod } })
  const persistedManifest = path.join(evidenceDir, 'e1-AI生成来源.json'); fs.copyFileSync(receipt.manifest.path, persistedManifest)
  const finalReceipt = { passed: true, checkedAt: new Date().toISOString(), executable, preApprovalCalls, requestedKinds, sourceMediaUploaded, qualityScore, recoveryZeroCalls, aiGenerated, outputs: persistedOutputs, manifest: { name: path.basename(persistedManifest), sha256: receipt.manifest.sha256 }, mediaProof: receipt.mediaProof, screenshotPath }
  const receiptPath = path.join(evidenceDir, 'receipt.json'); fs.writeFileSync(receiptPath, `${JSON.stringify(finalReceipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, preApprovalCalls, requestedKinds, sourceMediaUploaded, qualityScore, recoveryZeroCalls, aiGenerated }, null, 2)}\n`)
} finally { if (session) await closeSession(session); if (apiServer) await new Promise((resolve) => apiServer.close(resolve)); cleanup() }
