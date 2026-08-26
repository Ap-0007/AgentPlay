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
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-batch-edit-e3-'))
const mediaDir = path.join(profileDir, 'media')
const evidenceDir = path.join(root, 'artifacts', 'acceptance', 'batch-edit-e3-packaged')
const installedFfmpeg = path.join(process.env.APPDATA || '', 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const stagedFfmpeg = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpeg = path.join(installedFfmpeg, 'bin', 'ffmpeg.exe')
const sources = [4, 2, 5].map((duration, index) => ({ duration, path: path.join(mediaDir, `e3-source-${index + 1}-${duration}s.mp4`) }))
const instruction = '全部保留第1秒到第3秒'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => { child.off('exit', done); resolve(false) }, timeoutMs); const done = () => { clearTimeout(timer); resolve(true) }; child.once('exit', done) }) }
async function openSession() {
  const port = await freePort()
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', sources[0].path], { cwd: path.dirname(executable), windowsHide: true, shell: false })
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
function cleanup() { const resolved = path.resolve(profileDir); if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(resolved).startsWith('agentplay-packaged-batch-edit-e3-')) throw new Error(`拒绝清理非验收目录：${resolved}`); try { if (fs.lstatSync(stagedFfmpeg).isSymbolicLink()) fs.unlinkSync(stagedFfmpeg) } catch {}; fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }

let session
try {
  if (!fs.existsSync(executable) || !fs.existsSync(ffmpeg)) throw new Error('缺少候选EXE或已安装FFmpeg')
  fs.mkdirSync(mediaDir, { recursive: true }); fs.mkdirSync(path.dirname(stagedFfmpeg), { recursive: true }); fs.symlinkSync(installedFfmpeg, stagedFfmpeg, 'junction'); fs.mkdirSync(evidenceDir, { recursive: true })
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]
    const made = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', `testsrc2=duration=${source.duration}:size=640x360:rate=15`, '-f', 'lavfi', '-i', `sine=frequency=${440 + index * 110}:duration=${source.duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', source.path, '-loglevel', 'error'], { windowsHide: true, shell: false })
    if (made.status !== 0) throw new Error(String(made.stderr).slice(-800))
  }
  const sourceHashes = Object.fromEntries(sources.map((item) => [path.basename(item.path), sha256(item.path)]))
  session = await openSession()
  await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<300;i++){if(window.aiPlayer?.mediaTools?.planBatchEdit&&window.aiPlayer?.taskRuntime?.list)return true;await wait(100)}throw new Error('E3桥接未就绪')})()`, true)
  const sourcePaths = sources.map((item) => item.path)
  const plan = await session.evaluate(`(async()=>{for(const p of ${JSON.stringify(sourcePaths)})window.aiPlayer.menu.confirmOpenFile(p);await new Promise(r=>setTimeout(r,200));return window.aiPlayer.mediaTools.planBatchEdit({instruction:${JSON.stringify(instruction)},sourcePaths:${JSON.stringify(sourcePaths)}})})()`, true)
  if (!plan?.matched || plan.plan?.strategy !== 'independent-media-edit-batch-v1' || plan.plan?.items?.length !== 3) throw new Error(`E3冻结方案不合格：${JSON.stringify(plan).slice(0, 3000)}`)
  const requestId = `packaged-e3-${Date.now()}`
  const result = await session.evaluate(`window.aiPlayer.mediaTools.runBatchEdit({plan:${JSON.stringify(plan.plan)},requestId:${JSON.stringify(requestId)}})`, true)
  const task = await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<3600;i++){const item=(await window.aiPlayer.taskRuntime.list()).find(x=>x.id===${JSON.stringify(requestId)});if(item&&['completed','failed','cancelled'].includes(item.state))return item;await wait(100)}throw new Error('E3批量编辑超时')})()`, true)
  const states = (task.result?.results || []).map((item) => item.state)
  if (!result?.success || task.state !== 'completed' || task.quality?.score !== 100 || JSON.stringify(states) !== JSON.stringify(['succeeded', 'failed', 'succeeded'])) throw new Error(`E3安装态结果不合格：${JSON.stringify({ result, state: task.state, quality: task.quality, states, error: task.error }).slice(0, 8000)}`)
  const failed = task.result.results[1]
  if (failed.outputPath || failed.failure?.code !== 'MEDIA_RANGE_OUT_OF_BOUNDS') throw new Error(`E3失败隔离不合格：${JSON.stringify(failed)}`)
  if (task.result.outputs.length !== 2 || task.result.results.filter((item) => item.state === 'succeeded').some((item) => item.qualityScore !== 100)) throw new Error('E3成功项没有逐条100分或成果数不符')
  if (sources.some((item) => sha256(item.path) !== sourceHashes[path.basename(item.path)])) throw new Error('E3批量编辑改写了源视频')
  const attempts = task.attempts
  for (const outputPath of task.result.outputs) fs.copyFileSync(outputPath, path.join(evidenceDir, path.basename(outputPath)))
  const screenshot = await session.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const screenshotPath = path.join(evidenceDir, 'conversation-result.png'); fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  await closeSession(session); session = await openSession()
  const restarted = await session.evaluate(`(async()=>{const wait=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<300;i++){try{if(window.aiPlayer?.taskRuntime?.list){const item=(await window.aiPlayer.taskRuntime.list()).find(x=>x.id===${JSON.stringify(requestId)});if(item)return item}}catch{}await wait(100)}throw new Error('E3重启任务未恢复')})()`, true)
  const restartPersisted = restarted.state === 'completed' && restarted.attempts === attempts && restarted.result?.batchEditReceipt?.recovery?.repeatedCompletedItems === 0
  if (!restartPersisted) throw new Error(`E3重启后重复执行或回执丢失：${JSON.stringify({ before: attempts, after: restarted.attempts, receipt: restarted.result?.batchEditReceipt })}`)
  const receipt = { passed: true, checkedAt: new Date().toISOString(), strategy: plan.plan.strategy, planDigest: plan.plan.digest, total: 3, successCount: 2, failureCount: 1, states, failureCode: failed.failure.code, qualityScore: task.quality.score, sourceHashesUnchanged: true, restartPersisted, repeatedCompletedItems: restarted.result.batchEditReceipt.recovery.repeatedCompletedItems, outputs: task.result.outputs.map((item) => ({ name: path.basename(item), bytes: fs.statSync(item).size, sha256: sha256(item) })), screenshotPath }
  const receiptPath = path.join(evidenceDir, 'receipt.json'); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, successCount: 2, failureCount: 1, qualityScore: receipt.qualityScore, failureCode: receipt.failureCode, restartPersisted }, null, 2)}\n`)
} finally { if (session) await closeSession(session); cleanup() }
