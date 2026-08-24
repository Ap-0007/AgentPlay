import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const valueArg = (name) => process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || ''
const executable = path.resolve(valueArg('--exe') || path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe'))
const receiptPath = path.join(root, 'artifacts', 'acceptance', 'style-reuse-packaged', 'receipt.json')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-packaged-style-reuse-'))
if (!fs.existsSync(executable)) throw new Error('缺少安装态风格复用候选应用')
const reportText = `# 两部分专业拉片报告
00:00–00:02 中景，固定，冷色，高对比，居中构图。
00:02–00:05 近景，缓慢推镜，暖色，侧光，三分构图。
00:05–00:09 特写，跟拍，低饱和，逆光。
原片人物叫 Lindy，品牌为 AcmeAI，口播原句“Building the most comprehensive profile”。画面出现 AcmeAI Logo。`
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; await new Promise((resolve) => server.close(resolve)); return port }
async function waitForExit(child, timeoutMs = 5000) { if (child.exitCode !== null) return true; return new Promise((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); child.once('exit', () => { clearTimeout(timer); resolve(true) }) }) }

const debugPort = await freePort(); const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--window-position=-2400,-2400'], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket
try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) { if (child.exitCode !== null) throw new Error(`候选应用提前退出：${child.exitCode}`); try { const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); page = pages.find((item) => item.type === 'page'); if (page?.webSocketDebuggerUrl) break } catch {}; await delay(250) }
  if (!page?.webSocketDebuggerUrl) throw new Error('候选应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl); const pending = new Map(); let nextId = 0
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  const command = (method, params = {}) => { const id = ++nextId; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
  const evaluate = async (expression) => { const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text); return response.result?.value }
  await command('Runtime.enable')
  const result = await evaluate(`(async () => {
    const plan = await window.aiPlayer.studio.planRecut({ reportText: ${JSON.stringify(reportText)}, mediaName: 'AcmeAI参考片', count: 3, originalGoal: '拍一条社区图书交换的原创短片' })
    if (!plan?.success || !plan.blueprintSha256 || plan.blueprint?.strategy !== 'abstract-style-blueprint-v1') throw new Error('安装态抽象风格蓝图生成失败')
    const serialized = JSON.stringify(plan.blueprint)
    if (/Lindy|AcmeAI|Building the most/.test(serialized) || plan.blueprint?.sourceSpecificTextExcluded !== true || plan.blueprint?.copyrightBoundary?.referenceImagesAllowed !== false) throw new Error('抽象蓝图泄漏了参考作品专有表达')
    if (plan.blueprint.rhythm.durations.join(',') !== '2,3,4' || plan.blueprint.shotSizes.slice(0,3).join(',') !== '中景,近景,特写' || plan.blueprint.movements.slice(0,3).join(',') !== '固定,推,跟') throw new Error('节奏/景别/运镜结构提取不正确')
    const safeShots = [
      { prompt: '清晨社区门口，居民把读完的书放上共享木架，冷色高对比自然光', duration: 2, shotSize: '中景', movement: '固定', originalityDeclaration: '原创重构，不复制原片专有表达' },
      { prompt: '年轻人翻开交换登记册并贴上手写编号，暖色侧光，画面按三分法安排', duration: 3, shotSize: '近景', movement: '推', originalityDeclaration: '原创重构，不复制原片专有表达' },
      { prompt: '一本旧书交到新读者手中，逆光下突出书脊与双方动作，低饱和质感', duration: 4, shotSize: '特写', movement: '跟', originalityDeclaration: '原创重构，不复制原片专有表达' }
    ]
    const validated = await window.aiPlayer.studio.validateRecutShots({ reportText: ${JSON.stringify(reportText)}, mediaName: 'AcmeAI参考片', count: 3, shots: safeShots })
    const unsafe = await window.aiPlayer.studio.validateRecutShots({ reportText: ${JSON.stringify(reportText)}, mediaName: 'AcmeAI参考片', count: 3, shots: safeShots.map((item, index) => index === 1 ? { ...item, prompt: '逐帧复刻 AcmeAI Logo 和 Lindy 的原片构图' } : item) })
    if (!validated?.success || validated.receipt?.rawReportSentToShotModel !== false || validated.receipt?.referenceImagesSent !== 0 || unsafe?.success !== false || !/版权|专有|复制/.test(String(unsafe?.error || ''))) throw new Error('安装态原创镜头版权门没有按合同工作')
    const before = (await window.aiPlayer.taskRuntime.list()).filter((item) => item.type === 'creative.recut-short').length
    const tampered = await window.aiPlayer.studio.recutShort({ reportText: ${JSON.stringify(reportText)}, mediaName: 'AcmeAI参考片', count: 3, originalGoal: '拍一条社区图书交换的原创短片', blueprintSha256: '0'.repeat(64), requestId: 'style-tamper-smoke', workspaceTaskId: 'workspace-style-tamper' })
    const after = (await window.aiPlayer.taskRuntime.list()).filter((item) => item.type === 'creative.recut-short').length
    if (tampered?.success !== false || !String(tampered?.error || '').includes('风格蓝图与当前拉片报告不一致') || before !== after) throw new Error('篡改蓝图没有在付费任务前失败关闭')
    return { plan, validated, unsafe, tampered, taskCountUnchanged: before === after }
  })()`)
  const receipt = { acceptedAt: new Date().toISOString(), executable, blueprint: result.plan.blueprint, blueprintSha256: result.plan.blueprintSha256, protectedFragmentCount: result.plan.protectedFragmentCount, summary: result.plan.summary, validation: { safePassed: result.validated.success, unsafeBlocked: result.unsafe.success === false, unsafeError: result.unsafe.error, receipt: result.validated.receipt }, tamperGate: { blocked: result.tampered.success === false, error: result.tampered.error, taskCountUnchanged: result.taskCountUnchanged }, proprietaryTextAbsent: !/Lindy|AcmeAI|Building the most/.test(JSON.stringify(result.plan.blueprint)) }
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, blueprintSha256: receipt.blueprintSha256, durations: receipt.blueprint.rhythm.durations, shotSizes: receipt.blueprint.shotSizes, movements: receipt.blueprint.movements, protectedFragmentCount: receipt.protectedFragmentCount, proprietaryTextAbsent: receipt.proprietaryTextAbsent, safeShotsPassed: receipt.validation.safePassed, copiedShotBlocked: receipt.validation.unsafeBlocked, rawReportSentToShotModel: receipt.validation.receipt.rawReportSentToShotModel, referenceImagesSent: receipt.validation.receipt.referenceImagesSent, tamperBlockedBeforeTask: receipt.tamperGate.taskCountUnchanged })}\n`)
  await Promise.race([command('Browser.close'), delay(1000)]).catch(() => {})
} finally {
  if (!(await waitForExit(child))) { child.kill(); await waitForExit(child) }
  try { socket?.close() } catch {}
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch {}
}
