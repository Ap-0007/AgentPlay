import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const executable = executableArg ? path.resolve(executableArg.slice(6)) : path.join(root, 'release-input-preview', 'win-unpacked', 'AgentPlay.exe')
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-workflow-recovery-'))
const runtimeDir = path.join(profileDir, 'task-runtime')
const evidenceDir = path.join(profileDir, 'evidence')
const now = Date.now()

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fakeMp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(2048, 0)])
const waitForExit = (child, timeoutMs) => child.exitCode !== null ? Promise.resolve(true) : new Promise((resolve) => {
  const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, timeoutMs)
  const onExit = () => { clearTimeout(timer); resolve(true) }
  child.once('exit', onExit)
})

if (!fs.existsSync(executable)) throw new Error(`缺少桌面候选：${executable}`)
fs.mkdirSync(runtimeDir, { recursive: true })
fs.mkdirSync(evidenceDir, { recursive: true })
const sourcePath = path.join(evidenceDir, 'source.mp4')
fs.writeFileSync(sourcePath, 'installed recovery source')
const stat = fs.statSync(sourcePath)
const source = { path: fs.realpathSync(sourcePath), size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), sha256: crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex') }

const definitions = [
  ['analysis.run', 'history-written', 'analysis-report.docx'],
  ['subtitle.generate', 'artifact-written', 'translated.srt'],
  ['creative.video-generate', 'artifact-written', 'generated.mp4'],
  ['creative.recut-short', 'artifact-written', 'recut.mp4'],
  ['media.batch', 'artifact-written', 'batch-transcript.srt'],
  ['media.compress', 'artifact-written', 'compressed.mp4']
].map(([type, stage, file], index) => {
  const id = `smoke-${type.replace(/\W/g, '-')}-${now}-${index}`
  const outputPath = path.join(evidenceDir, file)
  if (/\.srt$/i.test(outputPath)) fs.writeFileSync(outputPath, '1\n00:00:00,000 --> 00:00:02,000\n恢复后的中文字幕。\n', 'utf8')
  else if (/\.docx$/i.test(outputPath)) fs.writeFileSync(outputPath, Buffer.concat([Buffer.from('PK'), Buffer.alloc(2048, 1)]))
  else fs.writeFileSync(outputPath, fakeMp4())
  const outputBytes = fs.statSync(outputPath).size
  const result = {
    success: true, outputPath, outputs: [outputPath], summary: `${type} recovered`,
    ...(type === 'analysis.run' ? { historyId: `history-${id}`, cueCount: 1, frameCount: 1, domainQuality: { score: 100, passed: true, level: 'pass', reasons: [] } } : {}),
    ...(type === 'subtitle.generate' ? { count: 1, targetLang: '中文' } : {}),
    ...(type === 'media.batch' ? { kind: 'transcribe', results: [{ token: 'smoke', success: true, outputPath }] } : {}),
    ...(type === 'media.compress' ? { mode: 'compress', beforeBytes: outputBytes * 2, afterBytes: outputBytes } : {})
  }
  const spec = type === 'analysis.run'
    ? { sources: [source], mediaName: 'source.mp4', durationSeconds: 1, instruction: '解剖视频', outputFormat: 'docx', modelRoute: null }
    : type === 'subtitle.generate'
      ? { sources: [source], subtitleSourceKind: '', targetLang: '中文', engine: 'local', durationSeconds: 1, modelRoute: null }
      : type === 'creative.video-generate'
        ? { instruction: '生成测试视频', prompt: '测试', duration: 1, fps: 24, size: '1280x720', modelRoute: null }
        : type === 'creative.recut-short'
          ? { instruction: '生成重构短片', reportText: '测试报告', mediaName: '测试', count: 2, seconds: 2, modelRoute: null }
          : type === 'media.batch'
            ? { kind: 'transcribe', sources: [{}], items: [{ token: 'smoke' }], plannedOutputs: [outputPath] }
            : { sources: [], mode: 'compress', targetMb: 25, outputPath }
  return {
    id, workspaceTaskId: `workspace-${id}`, type, state: 'running', spec,
    specHash: crypto.createHash('sha256').update(canonical(spec)).digest('hex'),
    checkpoint: { stage, result }, result: null, error: '', status: '模拟进程中断', approval: null,
    attempts: 1, createdAt: now - 1000, updatedAt: now - 500, startedAt: now - 1000, completedAt: null
  }
})
const duplicateA = path.join(evidenceDir, 'dedup-a.mp4')
const duplicateB = path.join(evidenceDir, 'dedup-b.mp4')
fs.writeFileSync(duplicateA, fakeMp4())
fs.writeFileSync(duplicateB, fakeMp4())
const duplicateHash = crypto.createHash('sha256').update(fs.readFileSync(duplicateA)).digest('hex')
const rootStat = fs.statSync(evidenceDir)
const dedupId = `smoke-media-dedup-${now}`
const dedupSpec = { root: { path: fs.realpathSync(evidenceDir), dev: Number(rootStat.dev) || 0, ino: Number(rootStat.ino) || 0 } }
const hashCache = Object.fromEntries([duplicateA, duplicateB].map((filePath) => {
  const fileStat = fs.statSync(filePath)
  return [filePath, { hash: duplicateHash, size: fileStat.size, mtimeMs: fileStat.mtimeMs }]
}))
definitions.push({
  id: dedupId, workspaceTaskId: `workspace-${dedupId}`, type: 'media.dedup', state: 'running', spec: dedupSpec,
  specHash: crypto.createHash('sha256').update(canonical(dedupSpec)).digest('hex'),
  checkpoint: { stage: 'hash-cache', hashCache }, result: null, error: '', status: '模拟哈希中断', approval: null,
  attempts: 1, createdAt: now - 1000, updatedAt: now - 500, startedAt: now - 1000, completedAt: null
})
fs.writeFileSync(path.join(runtimeDir, 'task-runtime-secret.bin'), crypto.randomBytes(32))
fs.writeFileSync(path.join(runtimeDir, 'task-runtime-v1.json'), JSON.stringify({ version: 1, tasks: definitions }, null, 2), 'utf8')

const port = 19640 + Math.floor(Math.random() * 200)
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--window-position=-2400,-2400'], {
  cwd: path.dirname(executable), windowsHide: true, shell: false
})
let websocket
try {
  let page
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`桌面候选提前退出：${child.exitCode}`)
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) break
    } catch {}
    await delay(250)
  }
  if (!page?.webSocketDebuggerUrl) throw new Error('桌面候选未开放验收页面')
  websocket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { websocket.addEventListener('open', resolve, { once: true }); websocket.addEventListener('error', reject, { once: true }) })
  const pending = new Map()
  let nextId = 0
  websocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const waiter = pending.get(message.id); pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result)
  })
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); websocket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression, awaitPromise = false) => {
    const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || '页面表达式执行失败')
    return response.result?.value
  }
  await command('Runtime.enable')
  let tasks = []
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await evaluate('Boolean(window.aiPlayer?.taskRuntime?.list)')) {
      tasks = await evaluate('window.aiPlayer.taskRuntime.list()', true)
      if (definitions.every((expected) => tasks.some((item) => item.id === expected.id && item.state === 'completed'))) break
    }
    await delay(250)
  }
  const recovery = definitions.map((expected) => {
    const actual = tasks.find((item) => item.id === expected.id)
    return { type: expected.type, state: actual?.state, attempts: actual?.attempts, checkpointStage: actual?.checkpoint?.stage, outputExists: Boolean(actual?.result?.outputs?.[0] && fs.existsSync(actual.result.outputs[0])), duplicateCount: actual?.result?.duplicates?.length || 0, qualityScore: actual?.quality?.score, qualityPassed: actual?.quality?.passed }
  })
  if (recovery.some((item) => item.state !== 'completed' || item.attempts !== 2 || item.qualityPassed !== true || item.qualityScore < 80 || (item.type === 'media.dedup' ? item.duplicateCount < 1 : !item.outputExists))) throw new Error(`工作流恢复验收失败：${JSON.stringify(recovery)}`)

  let agentUiReady = false
  for (let attempt = 0; attempt < 120; attempt += 1) {
    agentUiReady = await evaluate("Boolean(document.querySelector('.agent-composer input'))")
    if (agentUiReady) break
    await delay(100)
  }
  if (!agentUiReady) throw new Error('统一助手界面尚未挂载，不能验收任务中心')
  await evaluate("window.dispatchEvent(new CustomEvent('agentplay-open-task-center')); true")
  let visibleQuality = []
  for (let attempt = 0; attempt < 80; attempt += 1) {
    visibleQuality = await evaluate(`[...document.querySelectorAll('.task-center-quality')].map((node) => ({ text: node.textContent.trim(), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))`)
    if (visibleQuality.length >= definitions.length && visibleQuality.every((item) => item.text.includes('质量评分 100') && item.width > 0 && item.height > 0)) break
    await delay(100)
  }
  if (visibleQuality.length < definitions.length || visibleQuality.some((item) => !item.text.includes('质量评分 100') || item.width <= 0 || item.height <= 0)) {
    const diagnostics = await evaluate(`({
      taskCenter: Boolean(document.querySelector('.task-center')),
      composer: document.querySelector('.agent-composer')?.textContent || '',
      taskCards: document.querySelectorAll('.task-center-card').length,
      persistedLedger: localStorage.getItem('agentplay-workspace-tasks') || ''
    })`)
    throw new Error(`任务中心没有真实显示质量评分：${JSON.stringify({ visibleQuality, diagnostics })}`)
  }
  const taskCenterClosed = await evaluate(`(() => {
    const button = document.querySelector('.task-center-heading-actions button[aria-label="关闭任务与结果"]')
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!taskCenterClosed) throw new Error('质量评分验收后无法关闭任务中心')
  for (let attempt = 0; attempt < 40 && await evaluate("Boolean(document.querySelector('.task-center'))"); attempt += 1) await delay(50)

  const sample = `复制验证${now}`
  let focused = false
  for (let attempt = 0; attempt < 80; attempt += 1) {
    focused = await evaluate(`(() => { const input = document.querySelector('.agent-composer input'); if (!input) return false; input.focus(); return true })()`)
    if (focused) break
    await delay(100)
  }
  if (!focused) throw new Error('没有找到统一对话输入框')
  await command('Input.insertText', { text: sample })
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  let rect
  for (let attempt = 0; attempt < 80; attempt += 1) {
    rect = await evaluate(`(() => { const node = [...document.querySelectorAll('[data-chat-message="user"]')].find((item) => item.textContent.includes(${JSON.stringify(sample)})); if (!node) return null; const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, userSelect:getComputedStyle(node).userSelect } })()`)
    if (rect) break
    await delay(100)
  }
  if (!rect || rect.userSelect !== 'text') throw new Error(`消息没有进入可选择状态：${JSON.stringify(rect)}`)
  const y = Math.round((rect.top + rect.bottom) / 2)
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(rect.left + 8), y, button: 'left', buttons: 1, clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(rect.right - 8), y, button: 'left', buttons: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(rect.right - 8), y, button: 'left', buttons: 0, clickCount: 1 })
  const selectedText = await evaluate('String(window.getSelection()?.toString() || "")')
  if (!selectedText.trim()) throw new Error('真实鼠标拖动后没有选中文字')
  await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
  await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 2 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
  const clipboardText = await evaluate('navigator.clipboard.readText()', true)
  if (!String(clipboardText || '').includes(selectedText.trim())) throw new Error(`Ctrl+C 没有复制选中文字：${JSON.stringify({ selectedText, clipboardText })}`)
  process.stdout.write(`${JSON.stringify({ executable, recovery, visibleQuality, copySelection: { userSelect: rect.userSelect, selectedText, clipboardText } }, null, 2)}\n`)
  await Promise.race([command('Browser.close'), delay(1500)]).catch(() => {})
} finally {
  if (!(await waitForExit(child, 5000))) { child.kill(); await waitForExit(child, 5000) }
  try { websocket?.close() } catch {}
  const tempRoot = path.resolve(os.tmpdir()) + path.sep
  const resolved = path.resolve(profileDir)
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith('agentplay-workflow-recovery-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  }
}
