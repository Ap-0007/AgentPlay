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
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-brand-package-'))
const mediaDir = path.join(profileDir, 'media'); const sourcePath = path.join(mediaDir, 'brand-source.mp4')
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'); const ffmpegRoot = path.join(appData, 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build')
const ffmpeg = path.join(ffmpegRoot, 'bin', 'ffmpeg.exe'); const ffprobe = path.join(ffmpegRoot, 'bin', 'ffprobe.exe')
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'brand-package-d2-packaged', 'receipt.json')
const previewPath = path.join(root, 'artifacts', 'acceptance', 'brand-package-d2-packaged', 'preview.png')
const instruction = '按清爽科技品牌模板包装视频；标题《AgentPlay 新功能》；章节：第3秒《导入素材》、第7秒《自动成片》；人物《吴光｜产品负责人》；角标《AgentPlay》；片尾《一句话完成视频》'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeout = 6000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeout); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }
let cleaned = false
function cleanup() { if (cleaned) return; const resolved = path.resolve(profileDir); if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(resolved).startsWith('agentplay-packaged-brand-package-')) throw new Error(`拒绝清理非验收目录：${resolved}`); const link = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build'); try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link) } catch {}; fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); cleaned = true }
async function cleanupEventually() { for (let attempt = 0; attempt < 10; attempt += 1) { try { cleanup(); return } catch { await wait(500) } } }
process.once('exit', () => { try { cleanup() } catch {} })

if (![executable, ffmpeg, ffprobe].every(fs.existsSync)) throw new Error('缺少D2安装态验收组件')
fs.mkdirSync(mediaDir, { recursive: true }); const ffmpegLink = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build'); fs.mkdirSync(path.dirname(ffmpegLink), { recursive: true }); fs.symlinkSync(ffmpegRoot, ffmpegLink, 'junction')
const built = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=20:d=12', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath, '-loglevel', 'error'], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
if (built.status !== 0 || !fs.existsSync(sourcePath)) throw new Error(built.stderr || 'D2视频夹具生成失败')
const beforeHash = sha256(sourcePath); const port = await freePort()
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--window-position=-2400,-2400', sourcePath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
try {
  let page
  for (let attempt = 0; attempt < 300; attempt += 1) { if (child.exitCode !== null) throw new Error(`D2候选应用提前退出：${child.exitCode}`); try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page') } catch {}; if (page?.webSocketDebuggerUrl) break; await wait(250) }
  if (!page?.webSocketDebuggerUrl) throw new Error('D2候选应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let id = 0
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const job = pending.get(message.id); if (!job) return; pending.delete(message.id); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable'); await command('Page.enable')
  const pageResult = await evaluate(`(async()=>{
    const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const waitFor=async(probe,label,timeout=300000)=>{const started=Date.now();while(Date.now()-started<timeout){const value=await probe();if(value)return value;await wait(120)}throw new Error('等待超时：'+label)};
    await waitFor(()=>document.readyState==='complete'&&window.aiPlayer?.mediaTools?.planEdit,'桌面桥接');await waitFor(()=>{const v=document.querySelector('video[data-ai-player-video="true"]');return v&&v.readyState>=1&&v.duration>0},'视频就绪',60000);
    const runtimeButton=[...document.querySelectorAll('button')].find((button)=>button.title==='运行与隐私'||button.innerText.includes('运行与隐私'));runtimeButton?.click();await wait(100);const work=[...document.querySelectorAll('[aria-label="Agent 工作方式"] button')].find((button)=>button.innerText.trim()==='执行');work?.click();await wait(100);runtimeButton?.click();
    const plan=await window.aiPlayer.mediaTools.planEdit({instruction:${JSON.stringify(instruction)},sourcePath:${JSON.stringify(sourcePath)}});if(!plan.matched||plan.decision?.kind!=='media.visual-effects'||plan.decision?.brandPackage?.strategy!=='ass-brand-package-v1'||plan.decision?.effects?.[0]?.type!=='brand-package')throw new Error('D2方案不合格：'+JSON.stringify(plan).slice(0,1600));
    const input=document.querySelector('.agent-composer input[type="text"],input[placeholder*="完成什么"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(instruction)});input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(instruction)}}));await wait(100);document.querySelector('button[aria-label="发送"]')?.click();
    const task=await waitFor(async()=>{const items=await window.aiPlayer.taskRuntime.list();const item=[...items].reverse().find((entry)=>entry.type==='media.edit-visual-effects');return item&&['completed','failed','cancelled'].includes(item.state)?item:null},'D2任务完成',420000);if(task.state!=='completed')throw new Error((task.error||task.status)+'；'+JSON.stringify(task).slice(0,1800));
    const proof=task.result?.brandPackageProof;const titleVisible=proof?.elements?.title?.visible===true;const chapterVisibleCount=proof?.elements?.chapters?.visibleCount;const personVisible=proof?.elements?.person?.visible===true;const cornerVisible=proof?.elements?.corner?.visible===true;const outroVisible=proof?.elements?.outro?.visible===true;const quality100=task.quality?.score===100&&task.quality?.passed===true;
    if(!quality100||!titleVisible||chapterVisibleCount!==2||!personVisible||!cornerVisible||!outroVisible||proof?.templateId!=='clean-tech')throw new Error('D2五类像素证据不完整：'+JSON.stringify({quality100,titleVisible,chapterVisibleCount,personVisible,cornerVisible,outroVisible,proof}).slice(0,1800));
    if(!document.body.innerText.includes('品牌包装')||!/(?:5类|五类)最终像素证明/.test(document.body.innerText))throw new Error('D2对话回执不可见');
    return {version:window.aiPlayer.version,task,quality100,titleVisible,chapterVisibleCount,personVisible,cornerVisible,outroVisible};
  })()`)
  const afterHash = sha256(sourcePath); const sourceHashUnchanged = beforeHash === afterHash; const outputPath = pageResult.task.result.outputPath
  if (!sourceHashUnchanged || !fs.existsSync(outputPath)) throw new Error('D2源文件保护或成果失败')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  const montage = spawnSync(ffmpeg, ['-y', '-i', outputPath, '-filter_complex', '[0:v]trim=start=1.5:end=1.6,setpts=PTS-STARTPTS,scale=320:180[a];[0:v]trim=start=3.9:end=4.0,setpts=PTS-STARTPTS,scale=320:180[b];[0:v]trim=start=2.85:end=2.95,setpts=PTS-STARTPTS,scale=320:180[c];[0:v]trim=start=6.6:end=6.7,setpts=PTS-STARTPTS,scale=320:180[d];[0:v]trim=start=10.9:end=11.0,setpts=PTS-STARTPTS,scale=320:180[e];[a][b][c][d][e]hstack=inputs=5[out]', '-map', '[out]', '-frames:v', '1', previewPath, '-loglevel', 'error'], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
  if (montage.status !== 0 || !fs.existsSync(previewPath)) throw new Error(montage.stderr || 'D2预览图生成失败')
  const outputHash = sha256(outputPath); fs.writeFileSync(receiptPath, `${JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), executable, beforeHash, afterHash, sourceHashUnchanged, outputHash, previewPath, pageResult }, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, quality100: pageResult.quality100, titleVisible: pageResult.titleVisible, chapterVisibleCount: pageResult.chapterVisibleCount, personVisible: pageResult.personVisible, cornerVisible: pageResult.cornerVisible, outroVisible: pageResult.outroVisible, sourceHashUnchanged }, null, 2)}\n`)
  await Promise.race([command('Browser.close'), wait(1200)]).catch(()=>{})
} finally { if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) } try { socket?.close() } catch {}; await wait(1000); await cleanupEventually() }
