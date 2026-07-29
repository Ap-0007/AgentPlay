# -*- coding: utf8 -*-
# 一次性补丁：屏幕指路——主进程覆盖层+IPC、preload、类型、中栏按钮（跑完即删）

# ===== 1) electron/main.js =====
p = 'electron/main.js'
src = open(p, encoding='utf8', newline='').read()
nl = '\r\n' if '\r\n' in src else '\n'

old = "const { MpvService } = require('./mpv-service')"
new = old + nl + "const { requestScreenGuide } = require('./screen-guide-service')"
assert src.count(old) == 1
src = src.replace(old, new)

# 覆盖层管理函数：插在 createMpvContainer 注释前
old = '// 创建 mpv 嵌入容器窗口'
new = '''// 屏幕指路覆盖层：透明、点击穿透、置顶，15 秒自动消失
let guideOverlay = null
let guideOverlayTimer = null
function dismissGuideOverlay() {
  if (guideOverlayTimer) { clearTimeout(guideOverlayTimer); guideOverlayTimer = null }
  if (guideOverlay && !guideOverlay.isDestroyed()) guideOverlay.destroy()
  guideOverlay = null
}
// 覆盖层内以 0-1000 归一化坐标画圈与箭头（注入执行，勿引用外层变量）
function drawGuideMarks(marks) {
  const svg = document.getElementById('s')
  const w = window.innerWidth
  const h = window.innerHeight
  const px = (v) => (v / 1000) * w
  const py = (v) => (v / 1000) * h
  let inner = '<defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#6c70ff"/></marker></defs>'
  for (const mark of marks) {
    if (mark.type === 'circle') {
      inner += `<circle cx="${px(mark.x)}" cy="${py(mark.y)}" r="42" fill="none" stroke="#6c70ff" stroke-width="4" opacity="0.95"><animate attributeName="r" values="34;46;34" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.95;0.5;0.95" dur="1.6s" repeatCount="indefinite"/></circle>`
      inner += `<circle cx="${px(mark.x)}" cy="${py(mark.y)}" r="5" fill="#6c70ff"/>`
    } else if (mark.type === 'arrow') {
      inner += `<line x1="${px(mark.x)}" y1="${py(mark.y)}" x2="${px(mark.toX)}" y2="${py(mark.toY)}" stroke="#6c70ff" stroke-width="5" stroke-linecap="round" marker-end="url(#ah)"/>`
      inner += `<circle cx="${px(mark.toX)}" cy="${py(mark.toY)}" r="30" fill="none" stroke="#6c70ff" stroke-width="3" opacity="0.7"/>`
    }
  }
  svg.innerHTML = inner
}
function showGuideOverlay(marks, durationMs = 15000) {
  dismissGuideOverlay()
  guideOverlay = new BrowserWindow({
    fullscreen: true, transparent: true, frame: false, skipTaskbar: true,
    focusable: false, hasShadow: false, resizable: false, movable: false,
    webPreferences: { sandbox: true }
  })
  guideOverlay.setAlwaysOnTop(true, 'screen-saver')
  guideOverlay.setIgnoreMouseEvents(true, { forward: true })
  const html = '<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent"><svg id="s" style="position:fixed;inset:0;width:100vw;height:100vh"></svg></body></html>'
  guideOverlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  guideOverlay.webContents.once('did-finish-load', () => {
    if (guideOverlay && !guideOverlay.isDestroyed()) {
      guideOverlay.webContents.executeJavaScript(`(${drawGuideMarks.toString()})(${JSON.stringify(marks)})`).catch(() => {})
    }
  })
  guideOverlayTimer = setTimeout(dismissGuideOverlay, durationMs)
}

// 创建 mpv 嵌入容器窗口'''
assert src.count(old) == 1
src = src.replace(old, new)

# IPC：插在 window:isPlaybackChromeVisible 注册后
old = """  ipcMain.handle('window:isPlaybackChromeVisible', (event) => {
    assertTrustedSender(event)
    if (!mainWindow || mainWindow.isDestroyed()) return false
    return process.platform === 'darwin' ? true : mainWindow.isMenuBarVisible()
  })"""
new = old + nl + """  ipcMain.handle('guide:annotate', async (event, question) => {
    assertTrustedSender(event)
    try {
      const result = await requestScreenGuide(modelConfigStore.resolved('chat'), String(question || ''))
      if (result.marks.length) showGuideOverlay(result.marks)
      return { success: true, steps: result.steps, annotated: result.marks.length > 0 }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('guide:dismiss', (event) => {
    assertTrustedSender(event)
    dismissGuideOverlay()
    return true
  })"""
assert src.count(old) == 1
src = src.replace(old, new)

open(p, 'w', encoding='utf8', newline='').write(src)
print('main.js OK')

# ===== 2) electron/preload.js =====
p = 'electron/preload.js'
src = open(p, encoding='utf8', newline='').read()
nl = '\r\n' if '\r\n' in src else '\n'
old = '  computerUse: {'
new = '''  guide: {
    annotate: (question) => ipcRenderer.invoke('guide:annotate', question),
    dismiss: () => ipcRenderer.invoke('guide:dismiss')
  },
  computerUse: {'''
assert src.count(old) == 1
src = src.replace(old, new)
open(p, 'w', encoding='utf8', newline='').write(src)
print('preload.js OK')

# ===== 3) src/types/global.d.ts =====
p = 'src/types/global.d.ts'
src = open(p, encoding='utf8', newline='').read()
nl = '\r\n' if '\r\n' in src else '\n'
old = '    computerUse: {'
new = '''    guide: {
      annotate: (question: string) => Promise<{ success: boolean; steps?: Array<{ text: string; mark: unknown }>; annotated?: boolean; error?: string }>
      dismiss: () => Promise<boolean>
    }
    computerUse: {'''
assert src.count(old) == 1
src = src.replace(old, new)
open(p, 'w', encoding='utf8', newline='').write(src)
print('global.d.ts OK')

# ===== 4) AgentPanel：头部加「🎯 指路」按钮 + runGuide =====
p = 'src/components/AgentPanel.tsx'
src = open(p, encoding='utf8', newline='').read()
nl = '\r\n' if '\r\n' in src else '\n'

# 按钮（放在「海报/字幕 Key」前）
old = '''            <button onClick={() => setShowServiceEdit((value) => !value)} className="text-xs text-gray-400">海报/字幕 Key</button>'''
new = '''            <button onClick={() => void runGuide()} title="截取当前屏幕，让 AI 在屏幕上画出操作指引" className="text-xs text-cyan-300 hover:text-cyan-100">🎯 指路</button>
            <button onClick={() => setShowServiceEdit((value) => !value)} className="text-xs text-gray-400">海报/字幕 Key</button>'''
assert src.count(old) == 1
src = src.replace(old, new)

# runGuide 函数：插在 openAny 前
old = '  const openAny = async () => {'
new = '''  // 屏幕指路：截图发给视觉模型，在屏幕上画出操作标注，步骤同时回到对话里
  const runGuide = async () => {
    const question = inputText.trim()
    if (question) setInputText('')
    addMessage('user', question ? `🎯 屏幕指路：${question}` : '🎯 屏幕指路')
    const result = await window.aiPlayer?.guide?.annotate(question)
    if (!result) {
      addMessage('agent', '[错误] 指路功能在当前环境不可用')
      return
    }
    if (!result.success) {
      addMessage('agent', `[错误] ${result.error}`)
      return
    }
    const lines = (result.steps || []).map((step, index) => `${index + 1}. ${step.text}`).join('\\n')
    addMessage('agent', `${result.annotated ? '已在屏幕上画出标注（15 秒后自动消失）：' : '操作步骤：'}\\n${lines}`)
  }

  const openAny = async () => {'''
assert src.count(old) == 1
src = src.replace(old, new)

open(p, 'w', encoding='utf8', newline='').write(src)
print('AgentPanel OK')
