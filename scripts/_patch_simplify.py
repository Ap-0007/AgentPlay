# -*- coding: utf8 -*-
# 一次性补丁：中栏精简 + 指路等待反馈 + 热键回退 + Sidebar 删媒体库入口（跑完即删）

# ===== 1) AgentPanel =====
p = 'src/components/AgentPanel.tsx'
src = open(p, encoding='utf8', newline='').read()
nl = '\r\n'

# 1a. 模型名行缩短（Key 状态改绿点）
old = "    setModelLabel(`${config.providerName || config.providerId} / ${config.model}${config.hasApiKey ? ' · Key 已加密保存' : ''}`)"
new = "    setModelLabel(`${config.providerName || config.providerId} · ${config.model}`)"
assert src.count(old) == 1, 'a1: %d' % src.count(old)
src = src.replace(old, new)

# 1b. 头部右侧链接精简：删模型接入中心/电脑观察（左栏已有），海报Key 改 ⚙ 图标
old = '''          <div className="flex items-center gap-3 shrink-0">
            <button onClick={() => window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'model-center' }))} className="text-xs text-player-accent">模型接入中心</button>
            <button onClick={() => window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'computer-use' }))} className="text-xs text-amber-400">电脑观察</button>
            <button onClick={() => void runGuide()} title="截取当前屏幕，让 AI 在屏幕上画出操作指引" className="text-xs text-cyan-300 hover:text-cyan-100">🎯 指路</button>
            <button onClick={() => setShowServiceEdit((value) => !value)} className="text-xs text-gray-400">海报/字幕 Key</button>
          </div>'''
new = '''          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => void runGuide()} title="截取当前屏幕，让 AI 在屏幕上画出操作指引" className="rounded px-1.5 py-0.5 text-xs text-cyan-300 hover:bg-white/5 hover:text-cyan-100">🎯 指路</button>
            <button onClick={() => setShowServiceEdit((value) => !value)} title="海报/字幕服务 Key（可选）" className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-white/5 hover:text-gray-200">⚙</button>
          </div>'''
assert src.count(old) == 1, 'a2: %d' % src.count(old)
src = src.replace(old, new)

# 1c. 指路加等待反馈
old = """    addMessage('user', question ? `🎯 屏幕指路：${question}` : '🎯 屏幕指路')
    const result = await window.aiPlayer?.guide?.annotate(question)"""
new = """    addMessage('user', question ? `🎯 屏幕指路：${question}` : '🎯 屏幕指路')
    addMessage('agent', '正在截取屏幕并分析，稍等几秒…')
    const result = await window.aiPlayer?.guide?.annotate(question)"""
assert src.count(old) == 1, 'a3: %d' % src.count(old)
src = src.replace(old, new)

open(p, 'w', encoding='utf8', newline='').write(src)
print('AgentPanel OK')

# ===== 2) Sidebar：删「媒体库」入口（功能并入「打开」的文件夹授权） =====
p = 'src/components/Sidebar.tsx'
src = open(p, encoding='utf8', newline='').read()
old = "          {actionButton('🗂', '媒体库', onOpenLibrary)}\n"
if old not in src:
    old = old.replace('\n', '\r\n')
assert src.count(old) == 1, 'b1: %d' % src.count(old)
src = src.replace(old, '')
# onOpenLibrary prop 仍被「投屏/设备」复用，保留
open(p, 'w', encoding='utf8', newline='').write(src)
print('Sidebar OK')

# ===== 3) main.js：热键注册失败回退 + 日志 =====
p = 'electron/main.js'
src = open(p, encoding='utf8', newline='').read()

old = """  // 全局热键：随叫随到——任何场景下 Ctrl+Shift+A 唤起主窗口并直接开麦克风
  globalShortcut.register('CmdOrCtrl+Shift+A', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('menu:action', 'agent-voice')
  })"""
new = """  // 全局热键：随叫随到——任何场景下唤起主窗口并直接开麦克风；主键被占用时回退备选
  const wakeApp = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('menu:action', 'agent-voice')
  }
  const hotkeyRegistered = globalShortcut.register('CmdOrCtrl+Shift+A', wakeApp)
    || globalShortcut.register('CmdOrCtrl+Shift+Q', wakeApp)
  log.info(`全局唤醒来 hotkey 注册${hotkeyRegistered ? '成功（Ctrl+Shift+A 或 Ctrl+Shift+Q）' : '失败：可能被其他软件占用'}`)"""
assert src.count(old) == 1, 'c1: %d' % src.count(old)
src = src.replace(old, new)
open(p, 'w', encoding='utf8', newline='').write(src)
print('main.js OK')
