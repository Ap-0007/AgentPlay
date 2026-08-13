import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback) => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const executable = path.resolve(valueOf('--exe', path.join(root, 'release-doc-preview', 'win-unpacked', 'AgentPlay.exe')))
const userDataDir = path.resolve(valueOf('--user-data-dir', path.join(root, 'release-doc-preview', `smoke-user-data-document-preview-${process.pid}`)))
const docxPath = path.resolve(valueOf('--docx', path.join(root, 'artifacts', 'flo-analysis', 'node-professional-render-v2.docx')))
const pdfPath = path.resolve(valueOf('--pdf', path.join(root, 'artifacts', 'flo-analysis', 'node-professional-qa-v2', 'report.pdf')))
const imagePath = path.resolve(valueOf('--image', path.join(root, 'artifacts', 'flo-analysis', 'node-professional-qa-v2', 'page-01.png')))
const screenshotPath = path.resolve(valueOf('--screenshot', path.join(root, 'artifacts', 'document-preview-smoke.png')))
const port = Number(valueOf('--port', '19337'))

for (const required of [executable, docxPath, pdfPath, imagePath]) {
  if (!fs.existsSync(required)) throw new Error(`缺少桌面文档预览验收文件：${required}`)
}
fs.mkdirSync(userDataDir, { recursive: true })
fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })

const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
  cwd: path.dirname(executable), windowsHide: true, shell: false
})
let websocket
let nextId = 0
const pending = new Map()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForChildExit(timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, timeoutMs)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    child.once('exit', onExit)
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
  throw new Error('桌面文档预览验收页未在 60 秒内就绪')
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

async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await evaluate(expression)) return true
    await delay(250)
  }
  throw new Error(`${label} 未在 40 秒内出现`)
}

async function attachAndOpen(filePath) {
  const result = await evaluate(`(async () => {
    const docs = await window.aiPlayer?.documents?.attachPaths?.([${JSON.stringify(filePath)}])
    if (!Array.isArray(docs) || docs.length === 0) return { ok: false, docs }
    window.dispatchEvent(new CustomEvent('ai-player-attach-docs', { detail: docs }))
    return { ok: true, docs }
  })()`, true)
  if (!result?.ok || !result.docs?.[0]?.previewPath) throw new Error(`附件授权未返回预览路径：${JSON.stringify(result)}`)
  return result.docs[0]
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
  await waitFor('Boolean(window.aiPlayer?.documents?.attachPaths)', '文档工作区桥接')
  await waitFor(`Boolean(document.querySelector('input[placeholder="今天想完成什么？"]'))`, '统一输入工作区')

  const docx = await attachAndOpen(docxPath)
  await waitFor(`(() => {
    const frame = document.querySelector('iframe[title="隔离的 Office 预览"]')
    return Boolean(frame && (frame.getAttribute('srcdoc') || '').length > 100 && document.body.innerText.includes(${JSON.stringify(path.basename(docxPath))}))
  })()`, 'DOCX 内置预览与附件条')
  // srcDoc 注入成功早于 Chromium 完成 iframe 绘制；留出一帧稳定窗口，截图才是用户真正看到的内容。
  await delay(1500)
  const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))

  const pdf = await attachAndOpen(pdfPath)
  await waitFor(`(() => {
    const frame = document.querySelector('iframe[title="pdf"]')
    return Boolean(frame && (frame.getAttribute('src') || '').startsWith('data:application/pdf') && document.body.innerText.includes(${JSON.stringify(path.basename(pdfPath))}))
  })()`, 'PDF 内置预览与附件条')

  const image = await attachAndOpen(imagePath)
  await waitFor(`(() => {
    const image = document.querySelector('img[alt=${JSON.stringify(path.basename(imagePath))}]')
    return Boolean(image && image.getAttribute('src')?.startsWith('data:image/') && document.body.innerText.includes(${JSON.stringify(path.basename(imagePath))}))
  })()`, '图片内置预览与附件条')

  const result = {
    docx: { name: docx.name, previewPath: docx.previewPath, visible: true },
    pdf: { name: pdf.name, previewPath: pdf.previewPath, visible: true },
    image: { name: image.name, previewPath: image.previewPath, visible: true },
    composerVisible: await evaluate(`Boolean(document.querySelector('.agent-composer input[placeholder*="告诉我想从这些素材"]'))`),
    screenshot: screenshotPath
  }
  if (!result.composerVisible) throw new Error(`预览出现但统一输入框不可用：${JSON.stringify(result)}`)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  websocket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close', params: {} }))
  await waitForChildExit(5000)
} finally {
  try { websocket?.close() } catch {}
  if (child.exitCode === null) {
    child.kill()
    await waitForChildExit(5000)
  }
}
