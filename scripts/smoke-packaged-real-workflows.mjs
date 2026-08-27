import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { assertRealWorkflowAcceptance } from './lib/real-workflow-acceptance.mjs'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')
const { extractText } = require('../electron/document-workspace-service')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback = '') => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')))
const contractPath = path.resolve(valueOf('--contract'))
const researchPaths = valueOf('--research').split('|').map((item) => path.resolve(item)).filter(Boolean)
const videoPath = path.resolve(valueOf('--video'))
const ffmpegDir = path.resolve(valueOf('--ffmpeg-dir'))
const receiptPath = path.resolve(valueOf('--receipt', path.join(root, 'artifacts', 'acceptance', 'real-workflows-c5', 'receipt.json')))
for (const [label, filePath] of [['EXE', executable], ['合同', contractPath], ['视频', videoPath], ['ffmpeg', path.join(ffmpegDir, 'ffmpeg.exe')], ['ffprobe', path.join(ffmpegDir, 'ffprobe.exe')]]) if (!fs.existsSync(filePath)) throw new Error(`缺少${label}：${filePath}`)
if (researchPaths.length < 2 || researchPaths.some((item) => !fs.existsSync(item))) throw new Error('研究资料至少需要两份存在的文件')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const digest = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

function flattenContent(content) {
  if (Array.isArray(content)) return content.map((item) => typeof item === 'string' ? item : String(item?.text || item?.type || '')).join('\n')
  return String(content || '')
}

function responseFor(domain, format) {
  const factIds = ['F1']
  if (domain === 'contract') {
    if (format === 'xlsx') return { sheets: [{ name: '条款清单', rows: [['类别', '核对结论', '处置'], ['租金', '原合同已有租金条款', '签约前核对金额与周期'], ['押金', '原合同已有押金条款', '核对退还条件'], ['阳台', '原合同包含阳台条款', '核对使用和维护责任'], ['违约', '原合同已有违约条款', '核对触发条件与责任']] }], factIds }
    return { title: '租赁合同核对报告', content: '# 核对范围\n- 依据原合同中的租金、押金、阳台使用、违约及甲乙方责任条款整理。\n# 关键核对\n- 签约前应逐项确认金额、付款周期、押金退还条件和违约责任。\n- 阳台条款应明确使用范围、维护责任和损坏承担。\n# 边界\n- 本报告只做条款整理，具体金额与法律效力以原合同和专业法律意见为准。', factIds }
  }
  if (domain === 'research') {
    if (format === 'xlsx') return { sheets: [{ name: '模型接入对比', rows: [['方向', '优势', '风险', '建议'], ['Colibri', '本地文本模型接入', '协议与资源需实机核对', '先做只读小步验收'], ['Fara', '观察型计算机使用建议', '不应默认执行高风险动作', '保留观察与执行分离'], ['AgentPlay', '统一模型路由与工具协议', '配置复杂度', '将工程配置隐藏到高级入口']] }], factIds }
    if (format === 'pptx') return { title: '本地模型接入决策汇报', slides: [{ title: '研究范围', bullets: ['Colibri 文本模型', 'Fara 观察型计算机使用', 'AgentPlay 统一路由'], notes: '根据冻结研究资料' }, { title: '决策建议', bullets: ['先只读后执行', '模型身份持久冻结', '高风险动作继续审批'], notes: '不将推测写成实机事实' }], factIds }
    return { title: '本地模型接入研究报告', content: '# 研究结论\n- 资料围绕 Colibri、Fara 与 AgentPlay 的本地模型接入、观察型计算机使用和统一路由展开。\n# 共识\n- 模型规划与工具执行应分层，执行结果必须有真实回执。\n- 本地服务的协议、资源和延迟要用实机验收，不按模型名称猜测。\n# 建议\n- 优先完成只读探测、模型路由冻结和安全失败关闭，再扩大执行权限。', factIds }
  }
  if (format === 'xlsx') return { sheets: [{ name: '复刻拆解', rows: [['时段', '画面', '镜头与动作'], ['00:00-00:05', '科幻城市与巨型飞行装置', '广角建立空间和威压'], ['00:05-00:11', '装甲人物与快速飞行物', '运动模糊加快节奏'], ['00:11-00:17', '人物近景与城市爆炸', '近景反应后回到大全景']] }], factIds }
  if (format === 'pptx') return { title: '科幻城市战斗镜头拆解', slides: [{ title: '内容主线', bullets: ['巨型飞行装置压迫城市', '装甲人物在战场移动', '爆炸与群体战斗推高强度'], notes: '只基于画面证据' }, { title: 'AI 复刻要点', bullets: ['先建立天空与城市空间', '用运动模糊连接飞行物', '人物近景承接情绪'], notes: '不复刻受保护角色或Logo' }], factIds }
  return { title: '科幻城市战斗内容报告', content: '# 内容摘要\n- 画面展示科幻城市上空的大型飞行装置、装甲人物和高强度战斗。\n# 节奏\n- 建立镜头后迅速进入追逐与爆炸，再以人物近景补足反应。\n# 复刻边界\n- 可复刻大尺度城市战场、高速飞行物和蓝青色调，不复刻受保护角色、Logo或原片镜头。', factIds }
}

const analysisText = [
  '## 第一部分　视频讲了什么',
  '### 一句话精华', '这是一段约17秒的科幻城市战斗蒙太奇：巨型飞行装置逼近城市，装甲人物在高速飞行物与爆炸中应战。',
  '### 内容主线', '先用飞行装置与城市大全景建立威胁，再切入装甲人物的移动和反应，最后以塔状建筑周边的群体战斗与爆炸收束。',
  '### 全片结构时间轴', '- 00:00–00:05：巨型飞行装置压迫城市，装甲人物入画。', '- 00:05–00:11：高速飞行物掠过，战场移动与火力密度增加。', '- 00:11–00:17：人物近景反应与城市大全景爆炸交替，强度达到高点。',
  '### 可复制的内容结构', '- 威胁建立→人物入场→速度升级→近景反应→大全景收束，可用于15–20秒高强度动作短片。',
  '## 第二部分　专业视听拆解与 AI 复刻',
  '### 分镜与剪辑结构', '- 00:00–00:05用低机位广角建立飞行装置与人物的尺度对比；00:05–00:11用横向运动模糊连接高速飞行物；00:11–00:17以人物近景和战场大全景交替收束。',
  '### 摄影、构图、灯光与色彩', '- 原片观察为大景深城市空间、蓝青主色与橙黄爆炸对比；焦段只能作专业估算：建立镜头约24–35mm等效，人物近景约50–85mm等效。',
  '### 后期、节奏与声音', '- 剪辑用飞行物方向连续性维持空间，爆炸只放在节奏重音；本素材无可核对音轨，音效与配乐属于未知，复刻时应另建合法声音设计。',
  '### AI 复刻执行方案', '- 先生成一张低机位城市建立镜头，再生成飞行物横移、人物抬头反应和远景爆炸三个单动作镜头，最后统一蓝青/橙黄色彩与运动方向。',
  '### 生成提示词与素材清单', '- 提示词：原创科幻城市战场，低机位广角，巨型无标识飞行装置，原创装甲人物，蓝青天空，橙黄爆炸，高速横移运动模糊；素材包含城市背景、原创装甲人物、飞行装置、爆炸层和合法声音。'
].join('\n')

const contractText = await extractText(contractPath)
const researchTexts = await Promise.all(researchPaths.map((item) => extractText(item)))
if (contractText.length < 1000 || !['租金', '押金', '违约', '阳台'].every((item) => contractText.includes(item))) throw new Error('合同正文不满足真实验收门禁')
if (researchTexts.reduce((sum, item) => sum + item.length, 0) < 5000) throw new Error('研究资料正文不足')
const videoProbe = JSON.parse(execFileSync(path.join(ffmpegDir, 'ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height', '-of', 'json', videoPath], { encoding: 'utf8', windowsHide: true }))
const durationSeconds = Number(videoProbe.format?.duration || 0)
const decoded = durationSeconds >= 5 && videoProbe.streams?.some((item) => item.codec_type === 'video')
if (!decoded || fs.statSync(videoPath).size < 1024 * 1024) throw new Error('视频不满足真实容器与时长门禁')

const sourceBefore = new Map([contractPath, ...researchPaths, videoPath].map((item) => [item, digest(item)]))
const apiPort = await freePort(); const debugPort = await freePort()
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-real-workflows-'))
const profileFfmpegDir = path.join(profileDir, 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin'); fs.mkdirSync(profileFfmpegDir, { recursive: true })
fs.copyFileSync(path.join(ffmpegDir, 'ffmpeg.exe'), path.join(profileFfmpegDir, 'ffmpeg.exe'))
fs.copyFileSync(path.join(ffmpegDir, 'ffprobe.exe'), path.join(profileFfmpegDir, 'ffprobe.exe'))
fs.writeFileSync(path.join(profileDir, 'model-config.json'), JSON.stringify({
  schemaVersion: 3,
  roles: { chat: { providerId: 'custom', model: 'real-workflow-smoke', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' } },
  profiles: { chat: [{ providerId: 'custom', model: 'real-workflow-smoke', baseUrl: `http://127.0.0.1:${apiPort}/v1`, encryptedApiKey: '' }] }
}, null, 2), 'utf8')

const modelCalls = []
const apiServer = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  const prompt = (body.messages || []).map((item) => flattenContent(item.content)).join('\n')
  const format = ['DOCX', 'XLSX', 'PPTX', 'PDF'].find((item) => prompt.includes(`本次只生成 ${item}`))?.toLowerCase() || 'analysis'
  const domain = /阳台|租金|押金/.test(prompt) ? 'contract' : /Colibri|Fara|模型接入/.test(prompt) ? 'research' : 'video'
  modelCalls.push({ domain, format, promptLength: prompt.length })
  const content = format === 'analysis' ? analysisText : responseFor(domain, format)
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 300, completion_tokens: 120 } }))
})
await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(apiPort, '127.0.0.1', resolve) })

const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=-2400,-2400'], { cwd: path.dirname(executable), windowsHide: true, shell: false })
let socket; let nextId = 0; const pending = new Map()
const command = (method, params = {}) => { const id = ++nextId; socket.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) }
const evaluate = async (expression) => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value }

async function reopenOutput(outputPath) {
  const ext = path.extname(outputPath).toLowerCase()
  if (ext === '.xlsx') {
    const outputWorkbook = new ExcelJS.Workbook(); await outputWorkbook.xlsx.readFile(outputPath)
    return outputWorkbook.worksheets.length > 0 && outputWorkbook.worksheets.some((sheet) => sheet.rowCount > 1)
  }
  return (await extractText(outputPath)).trim().length >= 20
}

function sourceReceipt(filePath, chars = 0) {
  return { path: filePath, bytes: fs.statSync(filePath).size, chars, beforeSha256: sourceBefore.get(filePath), afterSha256: digest(filePath), preserved: sourceBefore.get(filePath) === digest(filePath) }
}

async function outputReceipts(outputPaths) {
  return Promise.all(outputPaths.map(async (outputPath) => ({ path: outputPath, format: path.extname(outputPath).slice(1).toLowerCase(), bytes: fs.statSync(outputPath).size, sha256: digest(outputPath), reopened: await reopenOutput(outputPath) })))
}

try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try { const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json(); page = pages.find((item) => item.type === 'page'); if (page?.webSocketDebuggerUrl) break } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('待验收应用未开放调试页')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result) })
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  await command('Runtime.enable'); await delay(3000)

  const contractCallsBefore = modelCalls.length
  const contractResult = await evaluate(`(async () => {
    const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(contractPath)}])
    return window.aiPlayer.documents.run({ tokens: attached.map((item) => item.token), instruction: '根据这份真实租赁合同，生成 Word 风险核对报告、Excel 条款清单和 PDF 交付版', outputFormat: 'auto', cloudApproved: false, requestId: 'real-contract-workflow', workspaceTaskId: 'workspace-real-contract' })
  })()`)
  if (!contractResult?.success || contractResult.quality?.score !== 100 || contractResult.outputs?.length !== 3) throw new Error(`合同工作流失败：${JSON.stringify(contractResult)}`)
  const contractCalls = modelCalls.length - contractCallsBefore
  const contractContinue = await evaluate(`(async () => { const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(contractResult.outputs.find((item) => item.endsWith('.docx')))}]); return window.aiPlayer.documents.run({ tokens: [attached[0].token], instruction: '继续把这个结果转换为 TXT', outputFormat: 'auto', cloudApproved: false, requestId: 'real-contract-continue', workspaceTaskId: 'workspace-real-contract-continue' }) })()`)

  const researchCallsBefore = modelCalls.length
  const researchResult = await evaluate(`(async () => {
    const attached = await window.aiPlayer.documents.attachPaths(${JSON.stringify(researchPaths)})
    return window.aiPlayer.documents.run({ tokens: attached.map((item) => item.token), instruction: '综合这些真实研究资料，生成 Word 研究报告、PPT 决策汇报和 Excel 对比矩阵', outputFormat: 'auto', cloudApproved: false, requestId: 'real-research-workflow', workspaceTaskId: 'workspace-real-research' })
  })()`)
  if (!researchResult?.success || researchResult.quality?.score !== 100 || researchResult.outputs?.length !== 3) throw new Error(`研究资料工作流失败：${JSON.stringify(researchResult)}`)
  const researchCalls = modelCalls.length - researchCallsBefore
  const researchContinue = await evaluate(`(async () => { const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(researchResult.outputs.find((item) => item.endsWith('.docx')))}]); return window.aiPlayer.documents.run({ tokens: [attached[0].token], instruction: '继续把这个结果转换为 TXT', outputFormat: 'auto', cloudApproved: false, requestId: 'real-research-continue', workspaceTaskId: 'workspace-real-research-continue' }) })()`)

  const videoCallsBefore = modelCalls.length
  const videoResult = await evaluate(`(async () => {
    await window.aiPlayer.models.save({ role: 'chat', providerId: 'agnes', model: 'agnes-2.0-flash', baseUrl: ${JSON.stringify(`http://127.0.0.1:${apiPort}/v1`)}, apiKey: 'local-test' })
    await window.aiPlayer.models.routingSettings({ preference: 'local', objective: 'quality' })
    window.aiPlayer.menu.confirmOpenFile(${JSON.stringify(videoPath)})
    return window.aiPlayer.outcomeWorkflow.run({ sourcePath: ${JSON.stringify(videoPath)}, mediaName: ${JSON.stringify(path.basename(videoPath))}, duration: ${durationSeconds}, instruction: '把这个真实视频做成中文拉片 Word 报告、PPT 汇报和 Excel 复刻拆解表', cloudApproved: false, requestId: 'real-video-workflow', workspaceTaskId: 'workspace-real-video' })
  })()`)
  if (!videoResult?.success || videoResult.quality?.score !== 100 || videoResult.outputs?.length !== 3) throw new Error(`视频内容包工作流失败：${JSON.stringify(videoResult)}`)
  const videoCalls = modelCalls.length - videoCallsBefore
  const videoTask = await evaluate(`window.aiPlayer.taskRuntime.list().then((items) => items.find((item) => item.id === 'real-video-workflow'))`)
  const frameEvidenceCount = Number(videoTask?.checkpoint?.analysisResult?.frameCount || 0)
  if (frameEvidenceCount <= 0) throw new Error(`视频画面证据诊断：${JSON.stringify({ modelRoute: videoTask?.spec?.modelRoute, analysisResult: videoTask?.checkpoint?.analysisResult, analysisCheckpoint: videoTask?.checkpoint?.analysisCheckpoint })}`)
  const videoContinue = await evaluate(`(async () => { const attached = await window.aiPlayer.documents.attachPaths([${JSON.stringify(videoResult.outputs.find((item) => item.endsWith('.docx')))}]); return window.aiPlayer.documents.run({ tokens: [attached[0].token], instruction: '继续把这个结果转换为 TXT', outputFormat: 'auto', cloudApproved: false, requestId: 'real-video-continue', workspaceTaskId: 'workspace-real-video-continue' }) })()`)

  for (const [label, first, next] of [['contract', contractResult, contractContinue], ['research', researchResult, researchContinue], ['video', videoResult, videoContinue]]) {
    if (!next?.success || next.projectCapsule?.projectId !== first.projectCapsule?.projectId || modelCalls.length !== videoCallsBefore + videoCalls) throw new Error(`${label}继续修改没有进入原项目或产生额外模型调用`)
  }

  const taskCenterText = await evaluate(`(async () => { window.dispatchEvent(new CustomEvent('agentplay-open-task-center')); await new Promise((resolve) => setTimeout(resolve, 1000)); return document.body.innerText })()`)
  if ((taskCenterText.match(/质量评分 100/g) || []).length < 3 || !taskCenterText.includes('成果包一致性已验证') || !taskCenterText.includes('继续修改')) throw new Error('任务中心未完整呈现三类工作流回执')

  const receipt = {
    schemaVersion: 1,
    kind: 'agentplay.real-workflow-acceptance',
    acceptedAt: new Date().toISOString(),
    executable: { path: executable, sha256: digest(executable) },
    controlledLocalModel: true,
    cloudUploads: 0,
    workflows: [
      {
        kind: 'contract', sources: [sourceReceipt(contractPath, contractText.length)], outputs: await outputReceipts(contractResult.outputs), quality: contractResult.quality,
        deliveryConsistency: contractResult.deliveryReceipt?.bundle?.consistency?.verdict, continueModification: contractContinue?.projectCapsule?.projectId === contractResult.projectCapsule?.projectId,
        projectId: contractResult.projectCapsule?.projectId, modelCalls: contractCalls
      },
      {
        kind: 'research', sources: researchPaths.map((item, index) => sourceReceipt(item, researchTexts[index].length)), outputs: await outputReceipts(researchResult.outputs), quality: researchResult.quality,
        deliveryConsistency: researchResult.deliveryReceipt?.bundle?.consistency?.verdict, continueModification: researchContinue?.projectCapsule?.projectId === researchResult.projectCapsule?.projectId,
        projectId: researchResult.projectCapsule?.projectId, modelCalls: researchCalls
      },
      {
        kind: 'video-content-package', sources: [sourceReceipt(videoPath, 0)], outputs: await outputReceipts(videoResult.outputs), quality: videoResult.quality,
        deliveryConsistency: videoResult.deliveryReceipt?.bundle?.consistency?.verdict, continueModification: videoContinue?.projectCapsule?.projectId === videoResult.projectCapsule?.projectId,
        projectId: videoResult.projectCapsule?.projectId, modelCalls: videoCalls, durationSeconds, decoded, frameEvidenceCount,
        workflowReceiptComplete: videoResult.workflowReceipt?.steps?.length === 2 && videoResult.workflowReceipt.steps.every((item) => item.state === 'completed')
      }
    ],
    ui: { taskCenterQualityCount: (taskCenterText.match(/质量评分 100/g) || []).length, consistencyVisible: taskCenterText.includes('成果包一致性已验证'), continueVisible: taskCenterText.includes('继续修改') }
  }
  assertRealWorkflowAcceptance(receipt, { exists: (filePath) => fs.existsSync(filePath), digest })
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true }); fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, workflows: receipt.workflows.map((item) => ({ kind: item.kind, sources: item.sources.length, outputs: item.outputs.map((output) => output.format), quality: item.quality.score, calls: item.modelCalls, projectId: item.projectId })), frameEvidenceCount, cloudUploads: 0, sourcePreserved: receipt.workflows.every((item) => item.sources.every((source) => source.preserved)), ui: receipt.ui })}\n`)
  try { socket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} })) } catch {}
  await delay(500)
} finally {
  try { socket?.close() } catch {}
  if (child.exitCode === null) child.kill()
  await new Promise((resolve) => apiServer.close(resolve))
  try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch {}
}
