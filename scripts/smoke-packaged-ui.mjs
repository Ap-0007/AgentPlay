import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const executableArg = process.argv.slice(2).find((value) => value.startsWith('--exe='))
const userDataArg = process.argv.slice(2).find((value) => value.startsWith('--user-data-dir='))
const screenshotArg = process.argv.slice(2).find((value) => value.startsWith('--screenshot='))
const mediaArg = process.argv.slice(2).find((value) => !value.startsWith('--'))
const executable = executableArg ? path.resolve(executableArg.slice('--exe='.length)) : path.join(root, 'release', 'win-unpacked', 'AgentPlay.exe')
const userDataDir = userDataArg ? path.resolve(userDataArg.slice('--user-data-dir='.length)) : ''
const screenshotPath = screenshotArg ? path.resolve(screenshotArg.slice('--screenshot='.length)) : ''
const mediaPath = mediaArg || path.resolve(root, '..', '..', '测试视频-可见画面.mp4')
const port = 19333
for (const required of [executable, mediaPath]) if (!fs.existsSync(required)) throw new Error(`缺少桌面验收文件：${required}`)

const launchArgs = [`--remote-debugging-port=${port}`, ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []), mediaPath]
const child = spawn(executable, launchArgs, { cwd: path.dirname(executable), windowsHide: true, shell: false })
let websocket
let nextId = 0
const pending = new Map()

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function waitForChildExit(timeoutMs) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

async function findPage() {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = pages.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {}
    await delay(250)
  }
  throw new Error('正式 EXE 没有在 60 秒内开放验收页面')
}

function command(method, params = {}) {
  const id = ++nextId
  websocket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression, awaitPromise = false) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || '页面表达式执行失败')
  return response.result?.value
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
  await command('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (let attempt = 0; attempt < 240; attempt++) {
    const ready = await evaluate(`(() => {
      const video = document.querySelector('video[data-ai-player-video="true"]')
      return Boolean(video && video.readyState >= 1 && video.videoWidth > 0 && video.videoHeight > 0 && !video.error)
    })()`)
    if (ready) break
    await delay(250)
  }
  const version = await evaluate('window.aiPlayer?.version')
  const playback = await evaluate(`(() => {
    const video = document.querySelector('video[data-ai-player-video="true"]')
    return video ? {
      present: true,
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      currentSrc: video.currentSrc,
      error: video.error?.message || null
    } : { present: false }
  })()`)
  await evaluate(`(async () => {
    const video = document.querySelector('video[data-ai-player-video="true"]')
    video.currentTime = 0
    const toggle = document.querySelector('button[title^="播放"], button[title^="暂停"]')
    if (toggle?.title.startsWith('播放')) {
      window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'play-toggle' }))
      await new Promise((resolve) => requestAnimationFrame(() => resolve()))
    }
    await video.play()
    return true
  })()`, true)
  const normalChromeVisible = await evaluate(`(() => {
    const chrome = [...document.querySelectorAll('[data-player-chrome="true"]')]
    return chrome.length >= 3 && chrome.every((element) => {
      const style = getComputedStyle(element)
      return style.opacity === '1' && style.pointerEvents !== 'none'
    })
  })()`)
  await evaluate(`(() => {
    const root = document.querySelector('video[data-ai-player-video="true"]')?.parentElement
    root?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 400, clientY: 300 }))
    return true
  })()`)
  await delay(3800)
  const fullscreenGeometry = await evaluate(`(() => {
    const theater = document.querySelector('.workspace-theater')
    const video = document.querySelector('video[data-ai-player-video="true"]')
    const root = video?.parentElement
    const theaterRect = theater?.getBoundingClientRect()
    const rootRect = root?.getBoundingClientRect()
    const style = video ? getComputedStyle(video) : null
    const tolerance = 1
    return {
      viewport: { width: innerWidth, height: innerHeight },
      theater: theaterRect ? { width: theaterRect.width, height: theaterRect.height } : null,
      root: rootRect ? { x: rootRect.x, y: rootRect.y, width: rootRect.width, height: rootRect.height, right: rootRect.right, bottom: rootRect.bottom } : null,
      objectFit: style?.objectFit || '',
      pictureMode: video?.dataset.pictureMode || '',
      bounded: Boolean(theaterRect && rootRect && rootRect.x >= -tolerance && rootRect.y >= -tolerance && rootRect.right <= innerWidth + tolerance && rootRect.bottom <= innerHeight + tolerance && Math.abs(rootRect.width - theaterRect.width) <= tolerance && Math.abs(rootRect.height - theaterRect.height) <= tolerance)
    }
  })()`)
  const idleChromeHidden = await evaluate(`(() => {
    const chrome = [...document.querySelectorAll('[data-player-chrome="true"]')]
    return chrome.length >= 3 && chrome.every((element) => {
      const style = getComputedStyle(element)
      return style.opacity === '0' && style.pointerEvents === 'none'
    })
  })()`)
  const idleMenuHidden = !(await evaluate('window.aiPlayer.windowControls.isPlaybackChromeVisible()', true))
  await evaluate(`(() => {
    const root = document.querySelector('video[data-ai-player-video="true"]')?.parentElement
    root?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 300 }))
    return true
  })()`)
  await delay(600)
  const activityChromeState = await evaluate(`(() => {
    const chrome = [...document.querySelectorAll('[data-player-chrome="true"]')]
    const elements = chrome.map((element) => ({
      tag: element.tagName,
      text: element.textContent?.trim().slice(0, 24) || '',
      opacity: Number(getComputedStyle(element).opacity),
      pointerEvents: getComputedStyle(element).pointerEvents,
      className: element.className
    }))
    return { elements, visible: chrome.length >= 3 && chrome.every((element) => element.classList.contains('opacity-100') && !element.classList.contains('pointer-events-none')) }
  })()`)
  const activityChromeVisible = activityChromeState.visible
  const activityMenuVisible = await evaluate('window.aiPlayer.windowControls.isPlaybackChromeVisible()', true)
  if (screenshotPath) {
    const capture = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
    fs.writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'))
  }
  await evaluate("window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'play-toggle' })); true")
  await delay(3500)
  const pausedChromeState = await evaluate(`(() => {
    const chrome = [...document.querySelectorAll('[data-player-chrome="true"]')]
    const elements = chrome.map((element) => ({
      tag: element.tagName,
      text: element.textContent?.trim().slice(0, 24) || '',
      opacity: Number(getComputedStyle(element).opacity),
      pointerEvents: getComputedStyle(element).pointerEvents,
      className: element.className
    }))
    return { elements, visible: chrome.length >= 3 && chrome.every((element) => element.classList.contains('opacity-100') && !element.classList.contains('pointer-events-none')) }
  })()`)
  const pausedChromeVisible = pausedChromeState.visible
  const pausedMenuVisible = await evaluate('window.aiPlayer.windowControls.isPlaybackChromeVisible()', true)
  await evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  await delay(900)
  await evaluate(`window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: ${JSON.stringify(mediaPath)} })); true`)
  await delay(250)
  await evaluate("window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'analysis-studio' })); true")
  await delay(500)
  const analysisWorkspace = await evaluate(`(() => {
    const shell = document.querySelector('aside[aria-label="AgentPlay 助手"]')
    const input = shell?.querySelector('input[type="text"]')
    const rect = shell?.getBoundingClientRect()
    return {
      visible: Boolean(shell && rect && rect.width > 0 && rect.height > 0),
      hasComposer: Boolean(input),
      composerFocused: document.activeElement === input
    }
  })()`)
  const body = await evaluate('document.body.innerText')
  const capabilities = await evaluate('window.aiPlayer.studio.capabilities()', true)
  await evaluate("window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'document-workspace' })); true")
  await delay(300)
  const documentWorkspace = await evaluate(`(async () => {
    const shell = document.querySelector('aside[aria-label="AgentPlay 助手"]')
    const input = shell?.querySelector('input[type="text"]')
    const voiceButton = shell?.querySelector('button[title="语音输入"], button[title="停止语音输入"]')
    const rect = shell?.getBoundingClientRect()
    const capabilities = await window.aiPlayer.documents.capabilities()
    const plan = await window.aiPlayer.documents.plan({
      tokens: [], instruction: '生成一份 Word 文档', outputFormat: 'docx'
    })
    return {
      visible: Boolean(shell && rect && rect.width > 0 && rect.height > 0),
      hasTextInput: Boolean(input),
      hasVoiceInput: Boolean(voiceButton),
      composerFocused: document.activeElement === input,
      formats: capabilities.formats,
      plan
    }
  })()`, true)
  await evaluate(`(() => {
    const settingsButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('运行与隐私'))
    settingsButton?.click()
    return Boolean(settingsButton)
  })()`)
  await delay(300)
  const agentRuntimeShell = await evaluate(`(() => {
    const panel = document.querySelector('section[aria-label="运行与隐私设置"]')
    const names = ['问答', '规划', '执行', '自动']
    const buttons = names.map((name) => [...(panel?.querySelectorAll('button') || [])].find((button) => button.textContent?.trim() === name))
    buttons[1]?.click()
    return {
      visible: Boolean(panel),
      names: buttons.map((button) => button?.textContent?.trim() || '')
    }
  })()`)
  await delay(150)
  const agentPlanMode = await evaluate(`(() => {
    const panel = document.querySelector('section[aria-label="运行与隐私设置"]')
    const buttons = [...(panel?.querySelectorAll('button') || [])]
    const plan = buttons.find((button) => button.textContent?.trim() === '规划')
    const work = buttons.find((button) => button.textContent?.trim() === '执行')
    const result = {
      active: Boolean(plan?.classList.contains('is-active')),
      descriptionVisible: Boolean(panel?.textContent?.includes('只审查、拆解步骤和验收标准，不调用工具或执行任务'))
    }
    work?.click()
    return result
  })()`)
  await delay(150)
  const agentWorkRestored = await evaluate(`(() => {
    const panel = document.querySelector('section[aria-label="运行与隐私设置"]')
    return [...(panel?.querySelectorAll('button') || [])].some((button) => button.textContent?.trim() === '执行' && button.classList.contains('is-active'))
  })()`)
  const agentRuntimeModes = {
    ...agentRuntimeShell,
    planActive: agentPlanMode.active,
    planDescriptionVisible: agentPlanMode.descriptionVisible,
    restoredWork: agentWorkRestored
  }
  // 用可恢复的临时持久化任务验证步骤/证据/预算界面；验收后原样写回用户数据。
  const originalTaskStorage = await evaluate(`localStorage.getItem('agentplay-workspace-tasks')`)
  const smokeTaskStorage = JSON.stringify({
    state: {
      activeTaskId: 'smoke-agent-run',
      agentMode: 'work',
      tasks: [{
        id: 'smoke-agent-run', kind: 'utility', label: 'Agent · 执行', phase: 'completed', running: false,
        status: '', progress: 100, outputs: [], summary: '1/1 项执行证据已验证', error: '',
        instruction: '暂停当前视频', source: path.basename(mediaPath), retry: null,
        steps: [{ id: 'step-1', label: '暂停播放', phase: 'completed', detail: '播放器状态已核对', evidence: '播放器状态：已暂停', startedAt: Date.now() - 1000, completedAt: Date.now() }],
        evidence: [{ id: 'receipt-1', kind: 'state', label: '暂停播放', value: '播放器状态：已暂停', verified: true, createdAt: Date.now() }],
        budget: { turns: 1, maxTurns: 8, toolCalls: 1, maxToolCalls: 12, elapsedMs: 120, maxElapsedMs: 180000 },
        createdAt: Date.now() - 1000, updatedAt: Date.now(), completedAt: Date.now()
      }]
    },
    version: 3
  })
  await evaluate(`localStorage.setItem('agentplay-workspace-tasks', ${JSON.stringify(smokeTaskStorage)}); location.reload(); true`)
  for (let attempt = 0; attempt < 40; attempt++) {
    const taskCenterReady = await evaluate(`(() => {
      const open = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('任务与结果'))
      return Boolean(open && open.textContent?.includes('1'))
    })()`)
    if (taskCenterReady) break
    await delay(250)
  }
  await evaluate(`(() => {
    const open = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('任务与结果'))
    open?.click()
    return Boolean(open)
  })()`)
  await delay(150)
  const agentTaskReceipts = await evaluate(`(() => {
    const center = document.querySelector('section[aria-label="任务与结果中心"]')
    return {
      visible: Boolean(center),
      hasStep: Boolean(center?.textContent?.includes('暂停播放') && center?.querySelector('.task-center-steps')),
      hasEvidence: Boolean(center?.textContent?.includes('1/1 份证据已验证')),
      hasBudget: Boolean(center?.textContent?.includes('工具 1/12'))
    }
  })()`)
  if (originalTaskStorage == null) await evaluate(`localStorage.removeItem('agentplay-workspace-tasks'); true`)
  else await evaluate(`localStorage.setItem('agentplay-workspace-tasks', ${JSON.stringify(originalTaskStorage)}); true`)
  const result = {
    version,
    videoLoaded: Boolean(playback.present && playback.readyState >= 1 && playback.videoWidth > 0 && playback.videoHeight > 0 && !playback.error),
    playback,
    fullscreenGeometry,
    normalChromeVisible,
    idleChromeHidden,
    idleMenuHidden,
    activityChromeVisible,
    activityChromeState,
    activityMenuVisible,
    pausedChromeVisible,
    pausedChromeState,
    pausedMenuVisible,
    unifiedAnalysisVisible: analysisWorkspace.visible && analysisWorkspace.hasComposer && analysisWorkspace.composerFocused,
    analysisWorkspace,
    retiredStudioHidden: !body.includes('AI 拉片与原创工作台'),
    advancedRender: capabilities?.advancedRender,
    systemVoice: capabilities?.systemVoice,
    renderBinary: capabilities?.renderBinary,
    documentWorkspace,
    agentRuntimeModes,
    agentTaskReceipts,
    screenshot: screenshotPath || null
  }
  if (version !== expectedVersion || !Object.values({ videoLoaded: result.videoLoaded, fullscreenBounded: fullscreenGeometry.bounded && fullscreenGeometry.objectFit === 'contain' && fullscreenGeometry.pictureMode === 'fit', normalChromeVisible, idleChromeHidden, idleMenuHidden, activityChromeVisible, menuHiddenDuringActivity: !result.activityMenuVisible, pausedChromeVisible, menuHiddenWhenPaused: !result.pausedMenuVisible, unifiedAnalysisVisible: result.unifiedAnalysisVisible, retiredStudioHidden: result.retiredStudioHidden, advancedRender: result.advancedRender, systemVoice: result.systemVoice, documentWorkspaceVisible: documentWorkspace.visible, documentTextInput: documentWorkspace.hasTextInput, documentVoiceInput: documentWorkspace.hasVoiceInput, documentComposerFocused: documentWorkspace.composerFocused, documentFormats: documentWorkspace.formats.includes('docx') && documentWorkspace.formats.includes('xlsx') && documentWorkspace.formats.includes('pptx') && documentWorkspace.formats.includes('pdf'), documentPlan: documentWorkspace.plan.requiresAi && documentWorkspace.plan.outputFormat === 'docx', agentModesVisible: agentRuntimeModes.visible, agentModesComplete: agentRuntimeModes.names.join('|') === '问答|规划|执行|自动', agentPlanMode: agentRuntimeModes.planActive && agentRuntimeModes.planDescriptionVisible, agentWorkRestored: agentRuntimeModes.restoredWork, agentTaskReceipts: agentTaskReceipts.visible && agentTaskReceipts.hasStep && agentTaskReceipts.hasEvidence && agentTaskReceipts.hasBudget }).every(Boolean)) {
    throw new Error(`正式 EXE 验收失败：${JSON.stringify(result)}`)
  }
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
