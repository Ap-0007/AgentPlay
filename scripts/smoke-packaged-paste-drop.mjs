import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', path.join(root, 'release-input-preview', 'win-unpacked', 'AgentPlay.exe')))
const docxPath = path.resolve(valueOf('--docx', path.join(root, 'artifacts', 'flo-analysis', 'node-professional-render-v2.docx')))
const imagePath = path.resolve(valueOf('--image', path.join(root, 'artifacts', 'flo-analysis', 'node-professional-qa-v2', 'page-01.png')))
const screenshotPath = path.resolve(valueOf('--screenshot', path.join(root, 'artifacts', 'paste-drop-installed-smoke.png')))
const userDataDir = path.resolve(valueOf('--user-data-dir', path.join(root, 'release-input-preview', `smoke-user-data-paste-drop-${process.pid}`)))
const port = Number(valueOf('--port', '19341'))

for (const required of [executable, docxPath, imagePath]) {
  if (!fs.existsSync(required)) throw new Error(`缺少粘贴/拖入验收文件：${required}`)
}
fs.mkdirSync(userDataDir, { recursive: true })
fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })

const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
  cwd: path.dirname(executable), windowsHide: true, shell: false
})
let clipboardHelper
let websocket
let nextId = 0
const pending = new Map()
const tempId = `agentplay-clipboard-smoke-${process.pid}-${Date.now()}`
const clipboardReady = path.join(os.tmpdir(), `${tempId}.ready`)
const clipboardDone = path.join(os.tmpdir(), `${tempId}.done`)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForChildExit(process, timeoutMs) {
  if (!process || process.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => { process.off('exit', onExit); resolve(false) }, timeoutMs)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    process.once('exit', onExit)
  })
}

async function findPage() {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await delay(250)
  }
  throw new Error('粘贴/拖入验收页未在 60 秒内就绪')
}

function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression, awaitPromise = false) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || '页面表达式执行失败')
      return response.result?.value
    } catch (error) {
      if (attempt < 2 && /Promise was collected|Execution context was destroyed/i.test(String(error))) {
        await delay(300)
        continue
      }
      throw error
    }
  }
  return undefined
}

async function waitFor(expression, label, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(expression)) return true
    await delay(250)
  }
  throw new Error(`${label} 未在 ${Math.round(attempts / 4)} 秒内出现`)
}

async function placeFileOnClipboard(filePath) {
  const escapePs = (value) => String(value).replace(/'/g, "''")
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$previous = [System.Windows.Forms.Clipboard]::GetDataObject()',
    'try {',
    '  $files = New-Object System.Collections.Specialized.StringCollection',
    `  [void]$files.Add('${escapePs(filePath)}')`,
    '  [System.Windows.Forms.Clipboard]::SetFileDropList($files)',
    `  [System.IO.File]::WriteAllText('${escapePs(clipboardReady)}', 'ready')`,
    `  $deadline = [DateTime]::UtcNow.AddSeconds(60); while (-not (Test-Path -LiteralPath '${escapePs(clipboardDone)}') -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }`,
    '} finally {',
    '  if ($null -ne $previous) { [System.Windows.Forms.Clipboard]::SetDataObject($previous, $true) } else { [System.Windows.Forms.Clipboard]::Clear() }',
    '}'
  ].join('; ')
  clipboardHelper = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, shell: false })
  for (let attempt = 0; attempt < 100 && !fs.existsSync(clipboardReady); attempt += 1) await delay(100)
  if (!fs.existsSync(clipboardReady)) throw new Error('Windows 文件剪贴板未准备好')
}

try {
  const page = await findPage()
  websocket = new WebSocket(page.webSocketDebuggerUrl)
  websocket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  await new Promise((resolve, reject) => {
    websocket.addEventListener('open', resolve, { once: true })
    websocket.addEventListener('error', reject, { once: true })
  })
  await command('Runtime.enable')
  await command('Page.bringToFront')
  await waitFor(`Boolean(document.querySelector('.agent-composer input'))`, '统一输入工作区')

  await placeFileOnClipboard(docxPath)
  const inputPoint = await evaluate(`(() => { const rect = document.querySelector('.agent-composer input').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`)
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: inputPoint.x, y: inputPoint.y, button: 'left', clickCount: 1 })
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inputPoint.x, y: inputPoint.y, button: 'left', clickCount: 1 })
  await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
  await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 })
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
  await waitFor(`(() => {
    const frame = document.querySelector('iframe[title="隔离的 Office 预览"]')
    const attachment = document.querySelector(${JSON.stringify(`[data-agent-attachment="${path.basename(docxPath)}"]`)})
    return Boolean(frame && (frame.getAttribute('srcdoc') || '').length > 100 && attachment)
  })()`, 'Ctrl+V 后的 DOCX 预览与附件')
  fs.writeFileSync(clipboardDone, 'done')
  await waitForChildExit(clipboardHelper, 5000)

  const panelPoint = await evaluate(`(() => { const rect = document.querySelector('.agent-panel').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`)
  const dragData = { items: [], files: [imagePath], dragOperationsMask: 1 }
  await command('Input.dispatchDragEvent', { type: 'dragEnter', x: panelPoint.x, y: panelPoint.y, data: dragData })
  await command('Input.dispatchDragEvent', { type: 'dragOver', x: panelPoint.x, y: panelPoint.y, data: dragData })
  await command('Input.dispatchDragEvent', { type: 'drop', x: panelPoint.x, y: panelPoint.y, data: dragData })
  await waitFor(`(() => {
    const image = document.querySelector('img[alt=${JSON.stringify(path.basename(imagePath))}]')
    const docxAttachment = document.querySelector(${JSON.stringify(`[data-agent-attachment="${path.basename(docxPath)}"]`)})
    const imageAttachment = document.querySelector(${JSON.stringify(`[data-agent-attachment="${path.basename(imagePath)}"]`)})
    return Boolean(image && image.getAttribute('src')?.startsWith('data:image/') && docxAttachment && imageAttachment)
  })()`, '拖入后的图片预览与附件')

  await delay(800)
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  const result = {
    paste: { file: path.basename(docxPath), previewVisible: true, attachmentVisible: true },
    drop: { file: path.basename(imagePath), previewVisible: true, attachmentVisible: true, previousAttachmentRetained: true },
    composerVisible: await evaluate(`Boolean(document.querySelector('.agent-composer input[placeholder*="告诉我想从这些素材"]'))`),
    screenshot: screenshotPath
  }
  if (!result.composerVisible) throw new Error(`粘贴/拖入成功但无法继续提要求：${JSON.stringify(result)}`)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  websocket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} }))
  await waitForChildExit(child, 5000)
} finally {
  try { if (clipboardHelper && clipboardHelper.exitCode === null && !fs.existsSync(clipboardDone)) fs.writeFileSync(clipboardDone, 'done') } catch {}
  await waitForChildExit(clipboardHelper, 5000)
  try { websocket?.close() } catch {}
  if (child.exitCode === null) {
    child.kill()
    await waitForChildExit(child, 5000)
  }
  for (const marker of [clipboardReady, clipboardDone]) {
    try { fs.rmSync(marker, { force: true }) } catch {}
  }
}
