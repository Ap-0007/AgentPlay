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
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-subtitle-transform-')); const mediaDir = path.join(profileDir, 'media')
const videoPath = path.join(mediaDir, 'demo.mp4'); const subtitlePath = path.join(mediaDir, 'demo.srt')
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'); const installedUserData = path.join(appData, 'ai-player'); const ffmpeg = path.join(installedUserData, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffmpeg.exe')
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'subtitle-transform-d3-packaged', 'receipt.json')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeout = 6000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeout); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }
let cleaned = false
function cleanup() { if (cleaned) return; const resolved = path.resolve(profileDir); if (!resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) || !path.basename(resolved).startsWith('agentplay-packaged-subtitle-transform-')) throw new Error(`拒绝清理非验收目录：${resolved}`); const link = path.join(profileDir, 'translate-pack'); try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link) } catch {}; fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); cleaned = true }
async function cleanupEventually() { for (let attempt = 0; attempt < 10; attempt += 1) { try { cleanup(); return } catch { await wait(500) } } }
process.once('exit', () => { try { cleanup() } catch {} })

const translatePack = path.join(installedUserData, 'translate-pack')
if (![executable, ffmpeg, translatePack].every(fs.existsSync)) throw new Error('缺少D3安装态验收组件')
fs.mkdirSync(mediaDir, { recursive: true }); fs.symlinkSync(translatePack, path.join(profileDir, 'translate-pack'), 'junction')
const built = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=20:d=12', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath, '-loglevel', 'error'], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
if (built.status !== 0) throw new Error(built.stderr || 'D3视频夹具生成失败')
fs.writeFileSync(subtitlePath, ['1\n00:00:00,500 --> 00:00:02,000\nHello everyone','2\n00:00:02,500 --> 00:00:04,000\nProduct overview','3\n00:00:04,200 --> 00:00:06,000\nPricing details','4\n00:00:06,500 --> 00:00:10,000\nEdit faster and create better','5\n00:00:10,200 --> 00:00:12,000\nThanks for watching'].join('\n\n') + '\n', 'utf8')
const instruction = `批量处理字幕 ${subtitlePath}：第1条改成《Welcome to AgentPlay》；合并第2到第3条；第4条在8.2秒拆成《Edit faster｜Create better》；整体提前0.5秒；翻译成中文；风格改成强调`
const beforeHash = sha256(subtitlePath); const port = await freePort(); const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--window-position=-2400,-2400', videoPath], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
try {
  let page
  for (let attempt = 0; attempt < 300; attempt += 1) { if (child.exitCode !== null) throw new Error(`D3候选应用提前退出：${child.exitCode}`); try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page') } catch {}; if (page?.webSocketDebuggerUrl) break; await wait(250) }
  if (!page?.webSocketDebuggerUrl) throw new Error('D3候选应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let id = 0
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const job = pending.get(message.id); if (!job) return; pending.delete(message.id); message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable'); await command('Page.enable')
  const pageResult = await evaluate(`(async()=>{
    const wait=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const waitFor=async(probe,label,timeout=420000)=>{const started=Date.now();while(Date.now()-started<timeout){const value=await probe();if(value)return value;await wait(150)}throw new Error('等待超时：'+label)};
    await waitFor(()=>document.readyState==='complete'&&window.aiPlayer?.mediaTools?.planEdit,'桌面桥接');await waitFor(()=>{const v=document.querySelector('video[data-ai-player-video="true"]');return v&&v.readyState>=1&&v.duration>0},'视频就绪',60000);window.aiPlayer.menu.confirmOpenFile?.(${JSON.stringify(subtitlePath)});await wait(100);
    const runtimeButton=[...document.querySelectorAll('button')].find((button)=>button.title==='运行与隐私'||button.innerText.includes('运行与隐私'));runtimeButton?.click();await wait(100);const work=[...document.querySelectorAll('[aria-label="Agent 工作方式"] button')].find((button)=>button.innerText.trim()==='执行');work?.click();await wait(100);runtimeButton?.click();
    const plan=await window.aiPlayer.mediaTools.planEdit({instruction:${JSON.stringify(instruction)},sourcePath:${JSON.stringify(videoPath)}});const expected=['replace','merge','split','shift','translate','style'];if(!plan.matched||plan.decision?.kind!=='media.transform-subtitles'||JSON.stringify(plan.decision?.subtitleTransform?.operationKinds)!==JSON.stringify(expected)||plan.decision?.output?.container!=='ass')throw new Error('D3方案不合格：'+JSON.stringify(plan).slice(0,1800));
    const input=document.querySelector('.agent-composer input[type="text"],input[placeholder*="完成什么"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,${JSON.stringify(instruction)});input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(instruction)}}));await wait(100);document.querySelector('button[aria-label="发送"]')?.click();
    const task=await waitFor(async()=>{const items=await window.aiPlayer.taskRuntime.list();const item=[...items].reverse().find((entry)=>entry.type==='media.transform-subtitles');return item&&['completed','failed','cancelled'].includes(item.state)?item:null},'D3任务完成');if(task.state!=='completed')throw new Error((task.error||task.status)+'；'+JSON.stringify(task).slice(0,2000));
    const proof=task.result?.transformProof;const quality100=task.quality?.score===100&&task.quality?.passed===true;const operationKinds=proof?.operationKinds;const outputCueCount=proof?.outputCueCount;const translatedChinese=proof?.translation?.targetLang==='中文'&&proof?.translation?.matched===true;const styledAss=proof?.style?.preset==='impact'&&proof?.style?.matched===true;
    if(!quality100||JSON.stringify(operationKinds)!==JSON.stringify(expected)||outputCueCount!==5||!translatedChinese||!styledAss||proof?.exactStructure!==true)throw new Error('D3批量证据不完整：'+JSON.stringify({quality100,operationKinds,outputCueCount,translatedChinese,styledAss,proof}).slice(0,2000));
    if(!document.body.innerText.includes('批量字幕变换')||!document.body.innerText.includes('一个任务中完成'))throw new Error('D3对话回执不可见');
    return {version:window.aiPlayer.version,task,quality100,operationKinds,outputCueCount,translatedChinese,styledAss};
  })()`)
  const afterHash = sha256(subtitlePath); const sourceHashUnchanged = beforeHash === afterHash; const outputPath = pageResult.task.result.outputPath
  if (!sourceHashUnchanged || !fs.existsSync(outputPath) || path.extname(outputPath).toLowerCase() !== '.ass') throw new Error('D3源字幕保护或ASS成果失败')
  const outputText = fs.readFileSync(outputPath, 'utf8'); if ((outputText.match(/^Dialogue:/gm) || []).length !== 5 || !/[一-鿿]/.test(outputText) || !outputText.includes('Style: Impact')) throw new Error('D3磁盘成果内容不合格')
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), executable, beforeHash, afterHash, sourceHashUnchanged, outputHash: sha256(outputPath), pageResult }, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: true, receiptPath, quality100: pageResult.quality100, operationKinds: pageResult.operationKinds, outputCueCount: pageResult.outputCueCount, translatedChinese: pageResult.translatedChinese, styledAss: pageResult.styledAss, sourceHashUnchanged }, null, 2)}\n`)
  await Promise.race([command('Browser.close'), wait(1200)]).catch(()=>{})
} finally { if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) } try { socket?.close() } catch {}; await wait(1000); await cleanupEventually() }
