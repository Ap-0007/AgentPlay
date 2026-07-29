// AI播放器 Electron 主进程
// dev: 加载 Vite dev server；prod: 加载构建产物
// 集成 mpv sidecar，IPC 桥接渲染进程
const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, session, desktopCapturer, globalShortcut } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { MpvService } = require('./mpv-service')
const { requestScreenGuide, askAboutImage } = require('./screen-guide-service')
const { shouldEmbedMpv } = require('./playback-policy')
const { AgentEngine } = require('./llm-service')
const { scanDir, defaultVideoDir, ALL_EXTS, getType } = require('./file-service')
const { printFile } = require('./print-file')
const { WifiTransfer } = require('./wifi-transfer')
const { searchMovie } = require('./tmdb-service')
const { CastService } = require('./cast-service')
const { SyncService } = require('./sync-service')
const { previewDocx, previewXlsx } = require('./office-preview')
const { searchSubtitle, downloadSubtitle } = require('./subtitle-service')
const { DlnaReceiver } = require('./dlna-receiver')
const log = require('./logger')
const { analyzeDir, clusterByTag, findDuplicates, suggestClip } = require('./media-service')
const { DlnaServer } = require('./dlna-server')
const { listPlugins } = require('./plugin-service')
const { PROVIDERS, listModels, probeConnection, detectVolcenginePlan, VOLCENGINE_CODING_BASE_URL, VOLCENGINE_CODING_MODELS } = require('./model-providers')
const { discoverLocalServices } = require('./local-model-discovery')
const { ModelConfigStore } = require('./model-config-store')
const { ComputerUseProvider } = require('./adapters/computer-use-provider')
const { ComputerUseOrchestrator } = require('./computer-use-orchestrator')
const { ScreenCaptureService } = require('./screen-capture-service')
const { BundledLocalRuntime } = require('./bundled-local-runtime')
const { extractExternalMediaPaths, hasDocumentVerbFlag, extractDocumentVerbPaths } = require('./external-media-open')
const { buildOfflineAnalysis, loadAnalysisContext, renderRecut, findAdjacentSubtitle, parseSubtitleCues } = require('./analysis-studio-service')
const { detectAnalysisIntent, resolveAnalysisOutput, runChatAnalysis } = require('./analysis-chat-service')
const {
  generateImageAsset,
  renderCreativeVideo,
  requestCreativePlan,
  synthesizeCloudVoice,
  synthesizeSystemVoice
} = require('./creative-studio-service')
const { generateVideoAsset } = require('./creative-studio-service')
const { DocumentWorkspaceService, SUPPORTED_EXTENSIONS, pdfPageCount } = require('./document-workspace-service')
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']
const AUDIO_MEDIA_EXTS = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.wma']
const { WinRtOcrService } = require('./ocr-service')
const { LanguageDetectService } = require('./language-detect-service')
const { OfficeConvertService } = require('./office-convert-service')
const { TranscriptionService } = require('./transcription-service')
const { parseSrt, buildBilingualSrt, translateEntries, cuesToEntries, runLiveTranslation } = require('./subtitle-bilingual-service')
const { splitOpenAnyPaths, isPathInsideRoots } = require('./open-any')
const { downloadRemoteMedia, extractUrl, isDownloadIntent, isMediaUrl } = require('./media-download-service')
const { rasterizePdfPages } = require('./pdf-rasterizer')
const { LocalAiDownloadService } = require('./local-ai-download-service')
const LOCAL_AI_PACK = require('./local-ai-pack-manifest')

process.on('uncaughtException', (error) => log.error('主进程未捕获异常', error))
process.on('unhandledRejection', (error) => log.error('主进程未处理 Promise', error))

const isDev = !app.isPackaged
let mpv = null
let agentEngine = null
let modelConfigStore = null
let computerUseOrchestrator = null
let bundledRuntime = null
let wifiTransfer = null
let castService = null
let syncService = null
let dlnaReceiver = null
let dlnaServer = null
let mainWindow = null
let mpvContainer = null
let playerArea = null
let mpvReady = false
let rendererLoaded = false
let activeRecutProcess = null
let documentWorkspace = null
let localAiDownload = null
const pendingExternalMedia = []
const pendingDocumentFiles = []
let documentFlushTimer = null
const activeAiRequests = new Map()
const activeComputerUseRequests = new Map()
const activeDocumentRequests = new Map()
const activeAnalysisRequests = new Map()
const activeMediaDownloads = new Map()
let liveSubtitleSession = null
let llmComplete = null
let llmCompleteVisionMulti = null
const approvedDocumentSelections = new Map()
const authorizedFolders = new Set()
const userAuthorizedPaths = new Set()

ipcMain.on('app:version', (event) => {
  assertTrustedSender(event)
  event.returnValue = app.getVersion()
})

ipcMain.on('external-media:accepted', (event, filePath) => {
  assertTrustedSender(event)
  const acceptedPath = extractExternalMediaPaths([filePath])[0]
  if (acceptedPath) log.info(`播放界面已接收外部文件: ${path.basename(acceptedPath)}`)
})

function stopActiveRender() {
  if (!activeRecutProcess || activeRecutProcess.killed) return false
  if (process.platform === 'win32' && activeRecutProcess.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(activeRecutProcess.pid), '/t', '/f'], { windowsHide: true, shell: false })
    killer.unref()
  } else {
    activeRecutProcess.kill('SIGTERM')
  }
  return true
}

function flushPendingExternalMedia() {
  if (!rendererLoaded || !mainWindow || mainWindow.isDestroyed()) return false
  while (pendingExternalMedia.length > 0) {
    mainWindow.webContents.send('menu:openFile', pendingExternalMedia.shift())
  }
  return true
}

function queueExternalMediaArgs(argv) {
  if (hasDocumentVerbFlag(argv)) return queueDocumentVerbArgs(argv)
  const filePath = extractExternalMediaPaths(argv)[0]
  if (!filePath) return false
  pendingExternalMedia.length = 0
  pendingExternalMedia.push(filePath)
  log.info(`收到系统打开文件请求: ${path.basename(filePath)}`)
  flushPendingExternalMedia()
  return true
}

function approveDocumentPaths(filePaths) {
  const files = documentWorkspace.inspect(filePaths)
  return files.map((file) => {
    const token = crypto.randomUUID()
    approvedDocumentSelections.set(token, { path: file.path, createdAt: Date.now() })
    userAuthorizedPaths.add(file.path)
    return { token, name: file.name, ext: file.ext, size: file.size }
  })
}

function flushPendingDocuments() {
  if (pendingDocumentFiles.length === 0) return false
  if (!rendererLoaded || !mainWindow || mainWindow.isDestroyed() || !documentWorkspace) return false
  const paths = pendingDocumentFiles.splice(0)
  try {
    mainWindow.webContents.send('documents:open-external', approveDocumentPaths(paths))
    log.info(`已把 ${paths.length} 个资源管理器文档请求转交文档工作台`)
  } catch (error) {
    log.error('资源管理器文档处理请求无效', error)
  }
  return true
}

// Windows 资源管理器“用 AgentPlay 智能处理”动词：多选时每个文件会各起一个
// 进程，这里汇总后成批交给文档工作台，绝不送入播放器。
function queueDocumentVerbArgs(argv) {
  const paths = extractDocumentVerbPaths(argv, { allowedExtensions: SUPPORTED_EXTENSIONS })
  if (paths.length === 0) return false
  const identityOf = (filePath) => (process.platform === 'win32' ? filePath.toLowerCase() : filePath)
  const seen = new Set(pendingDocumentFiles.map(identityOf))
  for (const filePath of paths) {
    if (seen.has(identityOf(filePath)) || pendingDocumentFiles.length >= 20) continue
    seen.add(identityOf(filePath))
    pendingDocumentFiles.push(filePath)
  }
  if (pendingDocumentFiles.length === 0) return false
  log.info(`收到资源管理器文档处理请求: ${paths.map((filePath) => path.basename(filePath)).join(', ')}`)
  if (documentFlushTimer) clearTimeout(documentFlushTimer)
  documentFlushTimer = setTimeout(() => {
    documentFlushTimer = null
    flushPendingDocuments()
  }, 700)
  if (typeof documentFlushTimer.unref === 'function') documentFlushTimer.unref()
  return true
}

const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    queueExternalMediaArgs(argv)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.on('open-file', (event, filePath) => {
  event.preventDefault()
  queueExternalMediaArgs([filePath])
})

queueExternalMediaArgs(process.argv)

function assertTrustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
    throw new Error('已拒绝非主窗口 IPC 请求')
  }
}

function normalizeRequestId(value, prefix) {
  const id = String(value || '').trim()
  if (/^[A-Za-z0-9_-]{8,100}$/.test(id)) return id
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// 读取 BrowserWindow 原生句柄 HWND（Windows：指针值实际落在 32 位范围）
function getHwndNumber(win) {
  const buf = win.getNativeWindowHandle()
  return buf.readInt32LE(0)
}

// 屏幕指路覆盖层：透明、点击穿透、置顶，15 秒自动消失
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

// 创建 mpv 嵌入容器窗口（child，无边框，黑色背景，不渲染 HTML 内容）
// mpv --wid 附加到此窗口的 HWND，在其内创建子窗口渲染视频
function createMpvContainer(parent) {
  const pb = parent.getBounds()
  const w = 800
  const h = 450
  const container = new BrowserWindow({
    parent,
    frame: false,
    show: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#000000',
    width: w,
    height: h,
    x: pb.x + Math.round((pb.width - w) / 2),
    y: pb.y + Math.round((pb.height - h) / 2)
  })
  container.loadURL('about:blank')
  container.webContents.once('dom-ready', () => {
    container.webContents.insertCSS('html,body{background:#000!important;margin:0;overflow:hidden}')
  })
  return container
}

function updateContainerBounds() {
  if (!mpvContainer || mpvContainer.isDestroyed()) return
  if (!playerArea || !mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) return
  const cb = mainWindow.getContentBounds()
  mpvContainer.setBounds({
    x: cb.x + playerArea.x,
    y: cb.y + playerArea.y,
    width: Math.max(1, playerArea.width),
    height: Math.max(1, playerArea.height)
  })
}

function createWindow() {
  const { screen } = require('electron')
  const display = screen.getPrimaryDisplay()
  const w = Math.min(1280, display.workArea.width - 40)
  const h = Math.min(800, display.workArea.height - 40)
  mainWindow = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 800,
    minHeight: 520,
    maxWidth: display.workArea.width,
    maxHeight: display.workArea.height,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error(`preload 加载失败: ${preloadPath}`, error)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('渲染进程退出', details)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    log.error(`页面加载失败 ${code} ${description} ${url}`)
  })
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const output = `renderer[${level}] ${message} (${sourceId}:${line})`
    if (level >= 2) log.error(output)
    else log.info(output)
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowedPrefix = isDev ? 'http://localhost:5173/' : 'file:///'
    if (!String(targetUrl).startsWith(allowedPrefix)) event.preventDefault()
  })
  mainWindow.webContents.once('did-finish-load', async () => {
    rendererLoaded = true
    flushPendingExternalMedia()
    flushPendingDocuments()
    try {
      const injected = await mainWindow.webContents.executeJavaScript('window.aiPlayer?.isElectron === true')
      log.info(`桌面桥接注入状态: ${injected}`)
    } catch (error) {
      log.error('桌面桥接自检失败', error)
    }
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
  return mainWindow
}

const supportedExtensions = ALL_EXTS.map((ext) => ext.slice(1))
const openFileOptions = {
  filters: [{ name: '支持的媒体与文档', extensions: supportedExtensions }, { name: '所有文件', extensions: ['*'] }],
  properties: ['openFile']
}

function assertPrintablePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('打印路径无效')
  const resolved = path.resolve(filePath)
  if (userAuthorizedPaths.has(resolved)) return resolved
  // 媒体库扫描目录与常用目录内的文件同样可打印（此前只放行显式选过的路径，库里点打印必静默失败）
  if (isPathInsideRoots(resolved, allowedRoots(), { realpathSync: (value) => fs.realpathSync(value) })) return resolved
  throw new Error('只允许打印经你明确选择过、媒体库或常用目录内的文件')
}

// 共享路径门禁：授权文件夹、默认媒体目录与常用用户目录内才放行；
// 敏感凭证文件与（按需）可执行扩展名一律拒绝；先解析真实路径再校验，防软链绕过
const SENSITIVE_FILE = /(?:^|[\\/])\.env(?:\.|$)|(?:^|[\\/])\.git-credentials$|(?:^|[\\/])\.ssh[\\/]|\.(?:pem|key|pfx|p12|pgpass|netrc|npmrc)$|(?:^|[\\/])web\.config$|(?:^|[\\/])(?:id_rsa|id_ed25519|id_dsa|\.aws[\\/]credentials)$/i
const EXECUTABLE_EXTS = new Set(['.exe', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.com', '.scr', '.pif', '.lnk', '.ps1', '.reg', '.dll'])

function allowedRoots() {
  const roots = new Set([...authorizedFolders])
  const home = path.resolve(os.homedir())
  for (const dir of [defaultVideoDir(), app.getPath('videos'), app.getPath('documents'), app.getPath('downloads'), app.getPath('desktop'), app.getPath('music')]) {
    // defaultVideoDir 退化到整个 home 时不得整盘放开
    if (dir && path.resolve(dir) !== home) roots.add(dir)
  }
  return [...roots]
}

function assertAllowedPath(filePath, { denyExecutable = false } = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('路径无效')
  let resolved = path.resolve(filePath)
  try { resolved = fs.realpathSync(resolved) } catch { /* 文件不存在时按词法路径校验 */ }
  if (SENSITIVE_FILE.test(resolved)) throw new Error('该文件属于敏感凭证，禁止访问')
  if (denyExecutable && EXECUTABLE_EXTS.has(path.extname(resolved).toLowerCase())) throw new Error('不允许打开可执行文件')
  if (userAuthorizedPaths.has(resolved) || userAuthorizedPaths.has(path.resolve(filePath))) return resolved
  if (isPathInsideRoots(resolved, allowedRoots(), { realpathSync: (value) => fs.realpathSync(value) })) return resolved
  throw new Error('只允许访问你明确授权过、媒体库或常用目录内的文件')
}

// 云端发送同意：原生对话框一次确认、本次开机内有效（渲染器自报布尔不算数）
let cloudConsentGranted = false
async function ensureCloudConsent(detail) {
  if (cloudConsentGranted) return true
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '云端发送确认',
    message: '本次任务需要把内容发送给你配置的云端模型',
    detail: `${detail}\n\n允许后本次开机内不再询问。内容只发往你配置的模型地址；不允许则改用本地处理或取消。`,
    buttons: ['不允许', '允许'],
    defaultId: 0,
    cancelId: 0
  })
  if (result.response === 1) {
    cloudConsentGranted = true
    return true
  }
  return false
}

async function chooseFile() {
  const result = await dialog.showOpenDialog(mainWindow, openFileOptions)
  if (result.canceled) return null
  userAuthorizedPaths.add(path.resolve(result.filePaths[0]))
  return result.filePaths[0]
}

async function renderHtmlToPdf(html, finalPath) {
  const preview = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  try {
    await preview.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(String(html || ''))}`)
    const buffer = await preview.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'none' }
    })
    fs.writeFileSync(tempPath, buffer)
    fs.renameSync(tempPath, finalPath)
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
    if (!preview.isDestroyed()) preview.destroy()
  }
}

function createHiddenWindow({ width, height }) {
  return new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
}

const ocrService = new WinRtOcrService()
const languageDetect = new LanguageDetectService({
  whisperRoot: resolveWhisperRoot(),
  mpvPath: app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'win', 'mpv.com')
    : path.join(__dirname, '..', 'resources', 'bin', 'win', 'mpv.com')
})
const officeConvert = new OfficeConvertService()

function resolveWhisperRoot() {
  const packRoot = path.join(app.getPath('userData'), 'whisper-pack')
  if (fs.existsSync(path.join(packRoot, 'engine', 'whisper-cli.exe')) && fs.existsSync(path.join(packRoot, 'ggml-tiny.bin'))) return packRoot
  if (!app.isPackaged) return path.join(__dirname, '..', 'resources', 'whisper')
  return packRoot
}

const transcriptionService = new TranscriptionService({
  whisperRoot: resolveWhisperRoot(),
  mpvPath: app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'win', 'mpv.com')
    : path.join(__dirname, '..', 'resources', 'bin', 'win', 'mpv.com')
})
const WHISPER_PACK = require('./whisper-pack-manifest')
const whisperDownload = new LocalAiDownloadService({
  installRoot: path.join(app.getPath('userData'), 'whisper-pack'),
  manifest: WHISPER_PACK,
  logger: log
})
const TRANSLATE_PACK = require('./translate-pack-manifest')
const YTDLP_PACK = require('./ytdlp-pack-manifest')
const { SiteVideoService, detectCookiesDomain, normalizeCookiesText, cookiesFileForUrl } = require('./site-video-service')
const { SiteLoginService } = require('./site-login-service')
const { MirrorReceiver, MirrorSender, MirrorDiscovery } = require('./mirror-service')
const { VideoFrameService } = require('./video-frame-service')
const ytdlpDownload = new LocalAiDownloadService({
  installRoot: path.join(app.getPath('userData'), 'yt-dlp'),
  manifest: YTDLP_PACK,
  logger: log
})
// 站点登录态：App 内扫码一次，持久分区自持，cookies 过期时隐藏窗静默续期
const SITE_COOKIES_DIR = path.join(app.getPath('userData'), 'site-cookies')
const siteSessionCookies = () => session.fromPartition('persist:site-login').cookies.get({})
const siteLogin = new SiteLoginService({
  cookiesDir: SITE_COOKIES_DIR,
  createWindow: ({ show }) => {
    const win = new BrowserWindow({
      show,
      width: 480,
      height: 760,
      autoHideMenuBar: true,
      webPreferences: { partition: 'persist:site-login', sandbox: true, contextIsolation: true }
    })
    return {
      loadURL: (url, ua) => {
        win.webContents.setUserAgent(ua)
        return win.loadURL(url, { userAgent: ua })
      },
      getCookies: () => win.webContents.session.cookies.get({}),
      close: () => { if (!win.isDestroyed()) win.close() },
      onClosed: (fn) => win.on('closed', fn)
    }
  }
})
const siteVideo = new SiteVideoService({
  enginePath: path.join(app.getPath('userData'), 'yt-dlp', 'yt-dlp.exe'),
  ffmpegDir: path.join(app.getPath('userData'), 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin'),
  cookiesDir: SITE_COOKIES_DIR,
  refreshCookies: (target) => {
    const file = cookiesFileForUrl(SITE_COOKIES_DIR, target)
    const domain = file ? path.basename(file, '.txt') : ''
    return domain ? siteLogin.silentRefresh(domain, siteSessionCookies) : false
  }
})
// 拉片关键帧：复用 yt-dlp 组件包里的 ffmpeg/ffprobe，组件未下载时优雅降级为纯字幕分析
const videoFrames = new VideoFrameService({
  ffmpegPath: path.join(app.getPath('userData'), 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffmpeg.exe'),
  ffprobePath: path.join(app.getPath('userData'), 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffprobe.exe')
})
const translateDownload = new LocalAiDownloadService({
  installRoot: path.join(app.getPath('userData'), 'translate-pack'),
  manifest: TRANSLATE_PACK,
  logger: log
})
const { OfflineTranslateService, shouldUseOffline } = require('./offline-translate-service')
const offlineTranslate = new OfflineTranslateService({
  modelRoot: path.join(app.getPath('userData'), 'translate-pack', 'models')
})

// 字幕翻译路由：离线翻译组件可用且任务为"英→中"时纯本地翻译；否则回退到已配置云端模型
function pickTranslateEngine(entries, targetLang = '中文') {
  if (offlineTranslate.availability().available && shouldUseOffline(entries, targetLang)) {
    return { complete: (input) => offlineTranslate.jsonComplete(input), label: '离线翻译组件', offline: true }
  }
  return { complete: llmComplete, label: '云端模型', offline: false }
}

async function transcribeToFile(sourcePath, finalPath, { timestamps = false } = {}) {
  const transcription = await transcriptionService.transcribe({
    sourcePath,
    timestamps,
    onProgress: (stage) => log.info(`转写进度: ${stage}`)
  })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  fs.writeFileSync(tempPath, `${transcription.text}\n`, 'utf8')
  fs.renameSync(tempPath, finalPath)
  return { summary: `离线转写完成（${transcription.text.length} 字${timestamps ? '，含时间轴' : ''}）` }
}

async function recognizePdfWithOcr(filePath) {
  const status = await ocrService.detect()
  if (!status.available) return null
  const pageCount = await pdfPageCount(filePath)
  const images = await rasterizePdfPages({ pdfPath: filePath, pageCount, createWindow: createHiddenWindow })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-ocr-'))
  try {
    const imagePaths = images.map((buffer, index) => {
      const imagePath = path.join(tempDir, `page-${index + 1}.png`)
      fs.writeFileSync(imagePath, buffer)
      return imagePath
    })
    const results = await ocrService.recognize(imagePaths)
    const chunks = []
    for (let index = 0; index < imagePaths.length; index += 1) {
      const entry = results.get(imagePaths[index])
      if (entry?.ok && entry.text) chunks.push(`## 第 ${index + 1} 页\n${entry.text}`)
    }
    return chunks.join('\n\n')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function wordsForImage(imagePath) {
  const status = await ocrService.detect()
  if (!status.available) throw new Error(`系统 OCR 不可用：${status.reason}`)
  const results = await ocrService.recognizeWords([imagePath])
  const entry = results.get(imagePath)
  if (!entry?.ok) throw new Error(entry?.error || 'OCR 识别失败')
  return entry.words
}

async function wordsForPdf(filePath) {
  const status = await ocrService.detect()
  if (!status.available) throw new Error(`系统 OCR 不可用：${status.reason}`)
  const pageCount = await pdfPageCount(filePath)
  // 表格恢复用 1.5 倍栅格化：CJK 小字号在 1600px 宽页面上会丢字/误字（实测 20px 丢张三、30px 全对）
  const images = await rasterizePdfPages({ pdfPath: filePath, pageCount, createWindow: createHiddenWindow, scale: 1.5 })
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-table-'))
  try {
    const imagePaths = images.map((buffer, index) => {
      const imagePath = path.join(tempDir, `page-${index + 1}.png`)
      fs.writeFileSync(imagePath, buffer)
      return imagePath
    })
    const results = await ocrService.recognizeWords(imagePaths)
    return imagePaths.map((imagePath, index) => ({
      page: index + 1,
      words: results.get(imagePath)?.ok ? results.get(imagePath).words : []
    }))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function documentSelectionFromToken(token) {
  const record = approvedDocumentSelections.get(String(token || ''))
  if (!record || Date.now() - record.createdAt > 24 * 60 * 60 * 1000) {
    approvedDocumentSelections.delete(String(token || ''))
    throw new Error('文件选择已过期，请重新选择')
  }
  return record.path
}

function isLocalModelConfig(config) {
  return Boolean(config?.providerId === 'bundled-lite' || config?.localOnly || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(config?.baseUrl || ''))
}

function sendAction(action) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu:action', action)
}

function setWindowPreset(preset, mediaSize = null) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const { screen } = require('electron')
  const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea
  if (preset === 'fullscreen') {
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
    return true
  }
  if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
  if (preset === 'fill') {
    mainWindow.maximize()
    return true
  }
  if (mainWindow.isMaximized()) mainWindow.unmaximize()
  const width = preset === 'half'
    ? Math.max(800, Math.round(workArea.width / 2))
    : Math.min(workArea.width, Math.max(800, Math.round(mediaSize?.width || 1280)))
  const height = preset === 'half'
    ? Math.max(520, Math.round(workArea.height / 2))
    : Math.min(workArea.height, Math.max(520, Math.round((mediaSize?.height || 690) + 110)))
  mainWindow.setBounds({
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height
  }, true)
  return true
}

const menuTemplate = [
  { label: '文件', submenu: [
    { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: async () => { const filePath = await chooseFile(); if (filePath) mainWindow?.webContents.send('menu:openFile', filePath) } },
    { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: async () => { const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if (!r.canceled) { authorizedFolders.add(r.filePaths[0]); mainWindow?.webContents.send('menu:openFolder', r.filePaths[0]) } } },
    { label: '添加网络源…', click: () => sendAction('network-source') },
    { type: 'separator' },
    { role: 'quit', label: '退出' }
  ] },
  { label: '播放', submenu: [
    { label: '播放 / 暂停　空格', click: () => sendAction('play-toggle') },
    { label: '后退 10 秒　←', click: () => sendAction('seek-backward') },
    { label: '前进 10 秒　→', click: () => sendAction('seek-forward') },
    { type: 'separator' },
    { label: '音量 +5　↑', click: () => sendAction('volume-up') },
    { label: '音量 -5　↓', click: () => sendAction('volume-down') },
    { label: '静音 / 恢复　M', click: () => sendAction('mute-toggle') },
    { label: '字幕开关', click: () => sendAction('subtitle-toggle') },
    { label: '在线字幕…', click: () => sendAction('online-subtitle') },
    { label: '播放速度', submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => ({ label: `${rate}×`, click: () => sendAction(`speed-${rate}`) })) },
    { type: 'separator' },
    { label: '截取当前画面', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendAction('screenshot') }
  ] },
  { label: '功能', submenu: [
    { label: 'AI 对话窗', accelerator: 'CmdOrCtrl+D', click: () => sendAction('agent') },
    { label: '模型接入中心…', click: () => sendAction('model-center') },
    { label: '拉片、深度解剖与原创重构…', accelerator: 'CmdOrCtrl+L', click: () => sendAction('analysis-studio') },
    { label: '设备、投屏与同步', click: () => sendAction('devices') }
  ] },
  { label: '窗口', submenu: [
    { label: '原始窗口', accelerator: 'CmdOrCtrl+1', click: () => sendAction('window-original') },
    { label: '1/2 屏窗口', accelerator: 'CmdOrCtrl+2', click: () => sendAction('window-half') },
    { label: '铺满桌面', accelerator: 'CmdOrCtrl+3', click: () => sendAction('window-fill') },
    { label: '全屏窗口', accelerator: 'F11', click: () => sendAction('window-fullscreen') },
    { type: 'separator' },
    { label: '画面比例', submenu: [
      { label: '原始比例（大画面自动缩小）', click: () => sendAction('picture-original') },
      { label: '完整显示（推荐）', accelerator: 'Ctrl+0', click: () => sendAction('picture-fit') },
      { label: '裁剪铺满（可能隐藏边缘）', click: () => sendAction('picture-fill') },
      { label: '拉伸铺满（可能变形）', click: () => sendAction('picture-stretch') }
    ] },
    { type: 'separator' },
    { role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }
  ] },
  { label: '帮助', submenu: [
    { label: '快捷键', click: () => sendAction('shortcuts') },
    { label: '关于 AI播放器', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: '关于 AI播放器', message: 'AI播放器', detail: `版本 ${app.getVersion()}\n支持本地播放、网络源、投屏同步与多模型 AI 助手。` }) }
  ] }
]
Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

log.info('AI播放器启动')

app.whenReady().then(async () => {
  const win = createWindow()

  // 全局热键：随叫随到——任何场景下唤起主窗口并直接开麦克风；主键被占用时回退备选
  const wakeApp = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('menu:action', 'agent-voice')
  }
  const hotkeyRegistered = globalShortcut.register('CmdOrCtrl+Shift+A', wakeApp)
    || globalShortcut.register('CmdOrCtrl+Shift+Q', wakeApp)
  log.info(`全局唤醒热键注册${hotkeyRegistered ? '成功（Ctrl+Shift+A，被占用时回退 Ctrl+Shift+Q）' : '失败：可能被其他软件占用'}`)


  mpv = new MpvService()
  const useEmbed = shouldEmbedMpv()
  if (useEmbed) {
    mpvContainer = createMpvContainer(win)
    const hwnd = getHwndNumber(mpvContainer)
    mpvReady = await mpv.start(hwnd)
    log.info(`mpv 嵌入模式${mpvReady ? '启动成功' : '启动失败，回退 HTML5'}，HWND=${hwnd}`)
  } else {
    mpvReady = await mpv.start(null)
    log.info(`默认使用 HTML5 播放；mpv 独立兼容模式${mpvReady ? '已就绪' : '不可用'}`)
  }

  modelConfigStore = new ModelConfigStore(app.getPath('userData'), safeStorage)
  bundledRuntime = new BundledLocalRuntime({
    resourceRoot: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources'),
    userDataRoot: path.join(app.getPath('userData'), 'local-ai')
  })
  localAiDownload = new LocalAiDownloadService({
    installRoot: path.join(app.getPath('userData'), 'local-ai'),
    manifest: LOCAL_AI_PACK,
    logger: log
  })
  agentEngine = new AgentEngine(mpv)
  llmComplete = async ({ systemPrompt, prompt, signal, timeoutMs }) => {
    let config = modelConfigStore.resolved('chat')
    let usesBundledRuntime = false
    try {
      if (config.providerId === 'bundled-lite') {
        const status = await bundledRuntime.start()
        bundledRuntime.retain()
        usesBundledRuntime = true
        config = { ...config, model: status.model, baseUrl: status.baseUrl }
      }
      return await agentEngine.completeText([{ role: 'user', content: prompt }], config, { systemPrompt, signal, timeoutMs })
    } finally {
      if (usesBundledRuntime) bundledRuntime.release()
    }
  }
  // 多图视觉调用（拉片关键帧）：images = [{ dataUrl, label }]，必须带当前配置，否则会落到引擎默认端点
  llmCompleteVisionMulti = async ({ systemPrompt, prompt, images, signal, timeoutMs }) => {
    const config = modelConfigStore.resolved('chat')
    return agentEngine.completeVisionMulti({
      prompt,
      systemPrompt,
      imageDataUrls: images.map((image) => image.dataUrl),
      labels: images.map((image) => image.label),
      apiKey: config,
      signal,
      timeoutMs: timeoutMs || 300000
    })
  }
  // 图片理解：优先已配置云端视觉模型；不行就本机 WinRT OCR 兜底（本地模型与零配置场景也能答）
  const describeImage = async (imagePath, instruction, { signal } = {}) => {
    const config = modelConfigStore.resolved('chat')
    const requiresKey = config.requiresKey !== false
    const visionReady = config.providerId !== 'bundled-lite' && Boolean(config.baseUrl && config.model && (!requiresKey || config.apiKey))
    if (visionReady) {
      const ext = path.extname(imagePath).toLowerCase().slice(1)
      try {
        const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${fs.readFileSync(imagePath).toString('base64')}`
        if (dataUrl.length > 20 * 1024 * 1024) throw new Error('图片超过 15MB，请先压缩')
        const result = await agentEngine.completeVision({ prompt: instruction, imageDataUrl: dataUrl, apiKey: config, signal, timeoutMs: 120000 })
        return result.text
      } catch (error) {
        log.warn('视觉模型图片理解失败，回落 OCR', error)
      }
    }
    const availability = await ocrService.availability()
    if (availability.available) {
      const results = await ocrService.recognize([imagePath])
      const entry = results.get(imagePath)
      if (entry?.ok && String(entry.text || '').trim()) {
        return `${visionReady ? '（视觉模型暂不可用，已用本机 OCR 识别图中文字）' : '（当前模型不支持看图，已用本机 OCR 识别图中文字）'}\n${String(entry.text).trim()}`
      }
    }
    throw new Error(visionReady ? '图片理解失败：视觉模型与 OCR 都没有给出结果' : '没有可用的图片理解方式：云端视觉模型未配置，本机 OCR 不可用或未识别到文字')
  }
  documentWorkspace = new DocumentWorkspaceService({
    outputRoot: path.join(app.getPath('documents'), 'AgentPlay 输出'),
    historyRoot: path.join(app.getPath('userData'), 'document-workspace'),
    renderPdf: renderHtmlToPdf,
    ocr: { recognizePdf: recognizePdfWithOcr },
    tableOcr: { wordsForPdf, wordsForImage },
    officeConvert,
    imageWindow: createHiddenWindow,
    transcriber: { transcribeToFile },
    describeImage,
    complete: llmComplete
  })
  const screenCapture = new ScreenCaptureService(() => mainWindow)
  computerUseOrchestrator = new ComputerUseOrchestrator({
    capture: () => screenCapture.capture(),
    provider: new ComputerUseProvider()
  })

  // LAN-facing services are instantiated but remain stopped until the user
  // explicitly enables them from “设备、投屏与同步”.
  wifiTransfer = new WifiTransfer()

  castService = new CastService()

  syncService = new SyncService(path.join(app.getPath('userData'), 'sync-progress.json'))

  dlnaServer = new DlnaServer()

  dlnaReceiver = new DlnaReceiver()
  dlnaReceiver.onPlay = (url) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('receiver:play', url)

  }
  // AgentPlay 互投（屏幕镜像）：接收端开 TCP+UDP 广播并弹镜像窗；发送端采集全屏推流
  let mirrorReceiver = null
  let mirrorSender = null
  let mirrorCaptureTimer = null
  let mirrorWindow = null
  let mirrorDiscovery = null

  const closeMirrorWindow = () => {
    try { mirrorWindow?.close() } catch { /* 忽略 */ }
    mirrorWindow = null
  }
  const stopMirrorReceiver = () => {
    mirrorReceiver?.stop()
    mirrorReceiver = null
    closeMirrorWindow()
  }
  const stopMirrorSender = async () => {
    if (mirrorCaptureTimer) clearInterval(mirrorCaptureTimer)
    mirrorCaptureTimer = null
    mirrorSender?.close()
    mirrorSender = null
  }
  const openMirrorWindow = (pin, name) => {
    closeMirrorWindow()
    mirrorWindow = new BrowserWindow({
      width: 960,
      height: 600,
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      title: `AgentPlay 互投接收 - ${name}`,
      webPreferences: { preload: path.join(__dirname, 'mirror-preload.js'), sandbox: true }
    })
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#000;overflow:hidden}
      #v{width:100%;height:100%;object-fit:contain;display:block}
      #pin{position:fixed;top:12px;right:12px;background:rgba(0,0,0,.72);color:#4ade80;font:600 22px/1.5 monospace;padding:8px 14px;border-radius:8px;letter-spacing:4px}
      #tip{position:fixed;left:12px;top:12px;background:rgba(0,0,0,.72);color:#aaa;font:13px/1.5 system-ui;padding:8px 12px;border-radius:8px}
    </style></head><body>
    <img id="v" alt="">
    <div id="pin">PIN ${pin}</div>
    <div id="tip">等待发送端连接…（在另一台电脑的 AgentPlay「设备、投屏与同步」里扫描并输入 PIN）</div>
    <script>
      const img = document.getElementById('v')
      window.mirrorView.onFrame((b64) => {
        img.src = 'data:image/jpeg;base64,' + b64
        const tip = document.getElementById('tip')
        if (tip) tip.remove()
      })
    </script></body></html>`
    mirrorWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    mirrorWindow.on('closed', () => {
      mirrorWindow = null
      stopMirrorReceiver()
    })
  }

  ipcMain.handle('mirror:start-receiver', async (event) => {
    assertTrustedSender(event)
    stopMirrorReceiver()
    const receiver = new MirrorReceiver({
      name: os.hostname(),
      onFrame: (jpeg) => {
        if (mirrorWindow && !mirrorWindow.isDestroyed()) mirrorWindow.webContents.send('mirror:frame', jpeg.toString('base64'))
      }
    })
    const info = await receiver.start()
    mirrorReceiver = receiver
    openMirrorWindow(info.pin, info.name)
    return { success: true, ...info }
  })
  ipcMain.handle('mirror:stop-receiver', (event) => {
    assertTrustedSender(event)
    stopMirrorReceiver()
    return true
  })
  ipcMain.handle('mirror:scan', async (event) => {
    assertTrustedSender(event)
    mirrorDiscovery?.stop()
    mirrorDiscovery = new MirrorDiscovery()
    return mirrorDiscovery.listen(2500)
  })
  ipcMain.handle('mirror:start-sender', async (event, input = {}) => {
    assertTrustedSender(event)
    const host = String(input.host || '').trim()
    const port = Number(input.port)
    const pin = String(input.pin || '').trim()
    if (!host || !Number.isInteger(port) || port <= 0 || !/^\d{6}$/.test(pin)) return { success: false, error: '目标地址或 PIN 无效' }
    await stopMirrorSender()
    const sender = new MirrorSender({ host, port, pin })
    try {
      await sender.connect()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
    mirrorSender = sender
    mirrorCaptureTimer = setInterval(async () => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } })
        const shot = sources[0]?.thumbnail
        if (shot && !shot.isEmpty()) sender.sendJpeg(shot.toJPEG(70))
      } catch { /* 单帧失败不中断推流 */ }
    }, 350)
    return { success: true }
  })
  ipcMain.handle('mirror:stop-sender', async (event) => {
    assertTrustedSender(event)
    await stopMirrorSender()
    return true
  })
  ipcMain.handle('mirror:status', (event) => {
    assertTrustedSender(event)
    return {
      receiving: mirrorReceiver ? mirrorReceiver.info() : null,
      sending: mirrorSender ? { host: mirrorSender.host, port: mirrorSender.port } : null
    }
  })

  // mpv 事件转发渲染进程
  mpv.on((event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mpv:event', { event, data })
    }
  })

  // 容器即时跟随；resize/maximize 时播放区布局可能变，请前端重测上报
  ;['resize', 'move', 'maximize', 'unmaximize', 'restore'].forEach((evt) => {
    win.on(evt, () => {
      updateContainerBounds()
      if (evt === 'resize' || evt === 'maximize' || evt === 'unmaximize') {
        win.webContents.send('mpv:remeasure')
      }
    })
  })

  win.on('closed', () => {
    if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.destroy()
    mpvContainer = null
    rendererLoaded = false
    mainWindow = null
  })
  win.on('enter-full-screen', () => win.webContents.send('window:fullscreen-changed', true))
  win.on('leave-full-screen', () => win.webContents.send('window:fullscreen-changed', false))

  // IPC：渲染进程 -> mpv
  ipcMain.on('mpv:playerArea', (_e, rect) => {
    assertTrustedSender(_e)
    playerArea = rect
    updateContainerBounds()
  })
  ipcMain.on('mpv:showContainer', (event) => {
    assertTrustedSender(event)
    if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.show()
  })
  ipcMain.on('mpv:hideContainer', (event) => {
    assertTrustedSender(event)
    if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.hide()
  })
  ipcMain.handle('mpv:info', (event) => { assertTrustedSender(event); return ({ ready: mpvReady, embedded: mpvReady && !!mpvContainer, available: mpv.isAvailable() }) })
  ipcMain.handle('mpv:load', (_e, p) => { assertTrustedSender(_e); return mpvReady && mpv.loadFile(p) })
  ipcMain.handle('mpv:play', (event) => { assertTrustedSender(event); return mpvReady && mpv.play() })
  ipcMain.handle('mpv:pause', (event) => { assertTrustedSender(event); return mpvReady && mpv.pause() })
  ipcMain.handle('mpv:seek', (_e, s) => { assertTrustedSender(_e); return mpvReady && mpv.seek(s) })
  ipcMain.handle('mpv:volume', (_e, v) => { assertTrustedSender(_e); return mpvReady && mpv.setVolume(v) })
  ipcMain.handle('mpv:speed', (_e, v) => { assertTrustedSender(_e); return mpvReady && mpv.setSpeed(v) })
  ipcMain.handle('mpv:picture-mode', (_e, mode) => { assertTrustedSender(_e); return mpvReady && mpv.setPictureMode(mode) })
  ipcMain.handle('mpv:subtitle', (_e, p) => { assertTrustedSender(_e); return mpvReady && mpv.loadSubtitle(p) })
  ipcMain.handle('mpv:subtitle-visible', (_e, v) => { assertTrustedSender(_e); return mpvReady && mpv.setSubtitleVisible(v) })
  ipcMain.handle('mpv:stop', (event) => { assertTrustedSender(event); return mpvReady && mpv.stopPlayback() })
  ipcMain.handle('mpv:screenshot', async (_e, suggestedName) => {
    assertTrustedSender(_e)
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('pictures'), String(suggestedName || 'AI播放器截图.png')),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    })
    return result.canceled || !result.filePath ? false : mpvReady && mpv.screenshot(result.filePath)
  })

  // 可编辑区域与选中文字的系统右键菜单（复制/粘贴/剪切/全选），播放器菜单之外的通用编辑入口
  mainWindow.webContents.on('context-menu', (_e, params) => {
    if (params.isEditable) {
      Menu.buildFromTemplate([
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      ]).popup({ window: mainWindow })
    } else if (String(params.selectionText || '').trim()) {
      Menu.buildFromTemplate([{ role: 'copy', label: '复制' }]).popup({ window: mainWindow })
    }
  })
  ipcMain.on('context:show', (_event, state = {}) => {
    assertTrustedSender(_event)
    const item = (label, action, extra = {}) => ({ label, click: () => sendAction(action), ...extra })
    const contextMenu = Menu.buildFromTemplate([
      item(state.isPlaying ? '暂停' : '播放', 'play-toggle', { enabled: !!state.hasMedia }),
      item('后退 10 秒', 'seek-backward', { enabled: !!state.hasMedia }),
      item('前进 10 秒', 'seek-forward', { enabled: !!state.hasMedia }),
      { type: 'separator' },
      item('截取当前画面…', 'screenshot', { enabled: !!state.hasMedia }),
      item(state.subtitleVisible ? '关闭字幕' : '打开字幕', 'subtitle-toggle', { enabled: !!state.hasMedia }),
      item('生成双语字幕（离线识别+云端翻译）', 'bilingual-subtitle', { enabled: !!state.hasMedia }),
      item(state.liveTranslate ? '停止实时翻译字幕' : '实时翻译字幕（译文排在原文下方）', 'live-translate-subtitle', { enabled: !!state.hasMedia }),
      item('拉片与原创重构…', 'analysis-studio', { enabled: !!state.hasMedia }),
      { label: '播放速度', submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => item(`${rate}×`, `speed-${rate}`, { type: 'radio', checked: state.playbackRate === rate })) },
      { label: '画面比例', submenu: [
        item('原始比例（大画面自动缩小）', 'picture-original', { type: 'radio', checked: state.pictureMode === 'original' }),
        item('完整显示（推荐）', 'picture-fit', { type: 'radio', checked: state.pictureMode === 'fit' }),
        item('裁剪铺满（可能隐藏边缘）', 'picture-fill', { type: 'radio', checked: state.pictureMode === 'fill' }),
        item('拉伸铺满（可能变形）', 'picture-stretch', { type: 'radio', checked: state.pictureMode === 'stretch' })
      ] },
      { label: '窗口大小', submenu: [
        item('原始窗口', 'window-original'), item('1/2 屏窗口', 'window-half'),
        item('铺满桌面', 'window-fill'), item('全屏窗口', 'window-fullscreen')
      ] },
      { type: 'separator' },
      item('打开文件…', 'open-file')
    ])
    contextMenu.popup({ window: mainWindow })
  })
  ipcMain.handle('window:setPreset', (_e, preset, mediaSize) => { assertTrustedSender(_e); return setWindowPreset(preset, mediaSize) })
  ipcMain.handle('window:setPlaybackChromeVisible', (_e, visible) => {
    assertTrustedSender(_e)
    if (!mainWindow || mainWindow.isDestroyed()) return false
    if (process.platform !== 'darwin') {
      // 播放期间菜单栏全程隐藏（Alt 可唤出），不随控制栏显隐：
      // 菜单栏显隐会改变客户区高度(~21px)，把按钮挪到静止光标下触发 pointerenter，形成显隐循环
      mainWindow.setAutoHideMenuBar(!visible)
      mainWindow.setMenuBarVisibility(Boolean(visible))
    }
    return true
  })
  ipcMain.handle('window:isPlaybackChromeVisible', (event) => {
    assertTrustedSender(event)
    if (!mainWindow || mainWindow.isDestroyed()) return false
    return process.platform === 'darwin' ? true : mainWindow.isMenuBarVisible()
  })
  ipcMain.handle('guide:annotate', async (event, question) => {
    assertTrustedSender(event)
    try {
      const ask = () => requestScreenGuide(modelConfigStore.resolved('chat'), String(question || ''))
      // 网络抖动自动重试一次（实测云端视觉偶发 fetch failed）
      const result = await ask().catch((firstError) => {
        if (!/fetch failed|network|timed ?out|abort|econn|socket/i.test(firstError.message)) throw firstError
        return ask()
      })
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
  })
  // 画面问答：视频帧/截图发给视觉模型。mpv 播放时主进程直接截图，HTML5 由渲染端给 dataUrl
  ipcMain.handle('guide:askFrame', async (event, input) => {
    assertTrustedSender(event)
    const fsPromises = require('fs').promises
    let dataUrl = String(input?.dataUrl || '')
    let tmpShot = ''
    try {
      if (!dataUrl) {
        if (!mpvReady || !mpv) throw new Error('播放器尚未就绪')
        tmpShot = path.join(os.tmpdir(), `agentplay-frame-${Date.now()}.jpg`)
        const ok = await mpv.screenshot(tmpShot)
        if (!ok || !fs.existsSync(tmpShot)) throw new Error('视频帧抓取失败')
        dataUrl = 'data:image/jpeg;base64,' + (await fsPromises.readFile(tmpShot)).toString('base64')
      }
      const result = await askAboutImage(modelConfigStore.resolved('chat'), {
        dataUrl,
        question: String(input?.question || '')
      })
      return { success: true, answer: result.answer }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (tmpShot) await fsPromises.unlink(tmpShot).catch(() => {})
    }
  })
  ipcMain.handle('screenshot:save', async (_e, dataUrl, suggestedName) => {
    assertTrustedSender(_e)
    try {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
      if (!match) throw new Error('截图数据格式无效')
      const buffer = Buffer.from(match[1], 'base64')
      if (buffer.length > 50 * 1024 * 1024) throw new Error('截图超过 50MB')
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(app.getPath('pictures'), String(suggestedName || 'AI播放器截图.png')),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) return false
      fs.writeFileSync(result.filePath, buffer)
      return true
    } catch (error) {
      log.error('截图保存失败', error)
      return false
    }
  })

  // IPC：对话流式输出、取消，以及按角色隔离的模型配置。
  ipcMain.handle('ai:chat', async (event, messages, context, requestedId) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(requestedId, 'chat')
    activeAiRequests.get(requestId)?.abort()
    const controller = new AbortController()
    activeAiRequests.set(requestId, controller)
    let usesBundledRuntime = false
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('ai:stream', { requestId, ...payload })
    }
    try {
      send({ status: 'queued' })
      let chatConfig = modelConfigStore.resolved('chat')
      if (chatConfig.providerId === 'bundled-lite') {
        send({ status: 'loading-local-model' })
        const localStatus = await bundledRuntime.start()
        bundledRuntime.retain()
        usesBundledRuntime = true
        chatConfig = { ...chatConfig, model: localStatus.model, baseUrl: localStatus.baseUrl }
      }
      const result = await agentEngine.chat(messages, chatConfig, context, {
        signal: controller.signal,
        onStatus: (status) => send({ status }),
        onDelta: (delta) => send({ delta })
      })
      send({ status: result.cancelled ? 'cancelled' : 'done' })
      return { ...result, requestId }
    } finally {
      if (usesBundledRuntime) bundledRuntime.release()
      activeAiRequests.delete(requestId)
    }
  })
  ipcMain.handle('ai:cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeAiRequests.get(String(requestId || ''))
    controller?.abort()
    return Boolean(controller)
  })
  ipcMain.handle('documents:capabilities', (event) => {
    assertTrustedSender(event)
    const config = modelConfigStore.resolved('chat')
    const requiresKey = config.requiresKey !== false
    return {
      formats: ['txt', 'md', 'csv', 'doc', 'docx', 'xlsx', 'pptx', 'pdf', 'odt', 'ods', 'odp', 'rtf', 'html'],
      modelConfigured: Boolean(config.baseUrl && config.model && (!requiresKey || config.apiKey)),
      modelLocal: isLocalModelConfig(config),
      providerName: config.providerName || config.providerId || '未配置',
      model: config.model || '',
      defaultOutputDir: path.join(app.getPath('documents'), 'AgentPlay 输出')
    }
  })
  ipcMain.handle('documents:select-files', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要交给 AgentPlay 处理的文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档、表格、演示稿和 PDF', extensions: [...SUPPORTED_EXTENSIONS].map((ext) => ext.slice(1)) },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return approveDocumentPaths(result.filePaths.slice(0, 20))
  })
  // 站点视频（B站/YouTube/抖音等公开视频页）：解析组件缺失时先自动下载，再执行下载
  ipcMain.handle('media:site-status', (event) => {
    assertTrustedSender(event)
    return { ...siteVideo.availability(), download: ytdlpDownload.status(), pack: ytdlpDownload.packInfo() }
  })
  ipcMain.handle('media:site-download-component', async (event) => {
    assertTrustedSender(event)
    try {
      await ytdlpDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('media:site-component-progress', progress)
        }
      })
      return { success: true, availability: siteVideo.availability() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:site-cancel-component', (event) => {
    assertTrustedSender(event)
    return ytdlpDownload.cancel()
  })
  // 导入浏览器导出的 cookies.txt（站点风控/登录态用；浏览器锁库与 ABE 使直读浏览器库不可行）
  ipcMain.handle('media:site-import-cookies', async (event) => {
    assertTrustedSender(event)
    const picked = await dialog.showOpenDialog({
      title: '选择导出的 Cookies 文件',
      properties: ['openFile'],
      filters: [{ name: 'Cookies 文件 (txt/json)', extensions: ['txt', 'json'] }]
    })
    if (picked.canceled || !picked.filePaths.length) return { success: false, canceled: true }
    try {
      const source = picked.filePaths[0]
      const normalized = normalizeCookiesText(fs.readFileSync(source, 'utf8'))
      if (!normalized) return { success: false, error: '无法识别的 Cookies 文件（支持 Netscape cookies.txt，或 J2TEAM / Cookie-Editor 的 JSON 导出）' }
      const detected = detectCookiesDomain(normalized)
      if (!detected) return { success: false, error: '不是有效的 Cookies 文件（没有识别到任何 Cookie 条目）' }
      const dir = path.join(app.getPath('userData'), 'site-cookies')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${detected.domain}.txt`), normalized)
      return { success: true, domain: detected.domain, count: detected.count }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:site-cookies-status', (event) => {
    assertTrustedSender(event)
    const dir = path.join(app.getPath('userData'), 'site-cookies')
    try {
      return fs.readdirSync(dir).filter((name) => name.endsWith('.txt')).map((name) => ({
        domain: name.replace(/\.txt$/, ''),
        updatedAt: fs.statSync(path.join(dir, name)).mtimeMs
      }))
    } catch {
      return []
    }
  })
  // App 内扫码登录（抖音等需要登录态的站点）：一次登录，分区自持+静默续期
  ipcMain.handle('media:site-login', async (event, input = {}) => {
    assertTrustedSender(event)
    const domain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(input.domain || '')) ? String(input.domain) : 'douyin.com'
    return siteLogin.openLogin(domain, siteSessionCookies)
  })
  ipcMain.handle('media:site-download', async (event, input = {}) => {
    assertTrustedSender(event)
    const url = String(input.url || '').trim()
    if (!url) return { success: false, error: '没有找到链接' }
    const requestId = normalizeRequestId(input.requestId, 'site-dl')
    activeMediaDownloads.get(requestId)?.abort()
    const controller = new AbortController()
    activeMediaDownloads.set(requestId, controller)
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('media:download-status', { requestId, status })
    }
    try {
      if (!siteVideo.availability().available) {
        sendStatus('首次使用站点视频，正在下载解析组件（约 18MB）')
        await ytdlpDownload.start({
          onProgress: (progress) => {
            if (progress.totalBytes) sendStatus(`下载解析组件 ${Math.round(((progress.presentBytes || progress.receivedBytes || 0) / progress.totalBytes) * 100)}%`)
          }
        })
      }
      sendStatus('正在解析视频页')
      const info = await siteVideo.resolve(url, { signal: controller.signal, onRetryNote: (note) => sendStatus(note) })
      sendStatus(`正在下载：${info.title.slice(0, 40)}`)
      const result = await siteVideo.download(url, {
        destDir: path.join(app.getPath('videos'), 'AgentPlay 下载'),
        signal: controller.signal,
        onRetryNote: (note) => sendStatus(note),
        onProgress: (progress) => sendStatus(`正在下载 ${progress.percent}%`)
      })
      userAuthorizedPaths.add(path.resolve(result.outputPath))
      sendStatus('下载完成')
      return { success: true, requestId, info, ...result }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    } finally {
      activeMediaDownloads.delete(requestId)
    }
  })
  ipcMain.handle('media:link-analysis', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'link-ana')
    activeMediaDownloads.get(requestId)?.abort()
    const controller = new AbortController()
    activeMediaDownloads.set(requestId, controller)
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('media:download-status', { requestId, status })
    }
    try {
      let videoPath = String(input.videoPath || '').trim()
      let info = null
      const url = extractUrl(input.url || '')
      if (!videoPath && !url) return { success: false, error: '没有找到链接' }
      const destDir = path.join(app.getPath('videos'), 'AgentPlay 下载')
      if (!videoPath) {
        if (isMediaUrl(url)) {
          sendStatus('正在下载视频')
          const result = await downloadRemoteMedia(url, {
            destDir, signal: controller.signal,
            onProgress: ({ received, total }) => sendStatus(total ? `正在下载 ${Math.round((received / total) * 100)}%` : `已下载 ${(received / 1024 / 1024).toFixed(1)}MB`)
          })
          videoPath = result.outputPath
        } else {
          if (!siteVideo.availability().available) {
            sendStatus('首次使用站点视频，正在下载解析组件（约 18MB）')
            await ytdlpDownload.start({})
          }
          sendStatus('正在解析视频页')
          info = await siteVideo.resolve(url, { signal: controller.signal, onRetryNote: (note) => sendStatus(note) })
          sendStatus(`正在下载：${info.title.slice(0, 40)}`)
          const result = await siteVideo.download(url, {
            destDir, signal: controller.signal,
            onRetryNote: (note) => sendStatus(note),
            onProgress: (progress) => sendStatus(`正在下载 ${progress.percent}%`)
          })
          videoPath = result.outputPath
        }
        userAuthorizedPaths.add(path.resolve(videoPath))
      }
      if (!fs.existsSync(videoPath)) throw new Error('视频文件不存在或已被移动')
      // 转写：有组件才做；写出同名字幕，后续解剖与播放器共用
      const whisperStatus = transcriptionService.availability()
      if (whisperStatus.available) {
        const dur = Number(info?.duration) || 0
        if (dur > 45 * 60) {
          // 长视频前置守护：离线转写超 2 小时才跑完的事不硬干（分段转写排期中）
          sendStatus('视频超过 45 分钟，离线转写预计超过 2 小时，本次跳过（分段转写排期中）')
        } else {
          sendStatus('正在离线转写语音（CPU，约为音频时长数倍）')
          const transcription = await transcriptionService.transcribe({
            sourcePath: videoPath,
            lang: 'auto',
            timestamps: true,
            signal: controller.signal,
            timeoutMs: dur > 0 ? Math.max(15 * 60 * 1000, dur * 3000 + 5 * 60 * 1000) : undefined
          })
          if (String(transcription.text || '').trim()) {
            const srtPath = path.join(path.dirname(videoPath), `${path.parse(videoPath).name}.srt`)
            if (!fs.existsSync(srtPath)) fs.writeFileSync(srtPath, transcription.text, 'utf8')
          }
        }
      }
      // 拉片解剖（自动读取同名字幕证据）
      sendStatus('正在生成拉片解剖报告')
      const config = modelConfigStore.resolved('chat')
      const requiresKey = config.requiresKey !== false
      const approved = await ensureCloudConsent('视频关键画面截图与口播字幕将发送给云端模型用于拉片分析。')
      const analysis = await runChatAnalysis({
        sourcePath: videoPath,
        mediaName: info?.title || path.basename(videoPath),
        duration: info?.duration,
        instruction: input.instruction || '深度解剖这个视频',
        outputFormat: input.outputFormat || resolveAnalysisOutput(input.instruction),
        cloudApproved: approved,
        signal: controller.signal,
        onStatus: sendStatus,
        workspace: documentWorkspace,
        complete: llmComplete,
        completeVisionMulti: llmCompleteVisionMulti,
        frames: videoFrames,
        model: {
          configured: Boolean(config.baseUrl && config.model && (!requiresKey || config.apiKey)),
          local: isLocalModelConfig(config),
          provider: config.providerName || config.providerId || '',
          model: config.model || ''
        }
      })
      if (analysis.requiresApproval) {
        return { success: false, requiresApproval: true, requestId, videoPath, info }
      }
      return { success: true, requestId, videoPath, info, outputs: analysis.outputs, summary: analysis.summary, usedAi: analysis.usedAi, cueCount: analysis.cueCount, whispered: whisperStatus.available }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    } finally {
      activeMediaDownloads.delete(requestId)
    }
  })
  ipcMain.handle('media:download-detect', (event, text) => {
    assertTrustedSender(event)
    const url = extractUrl(text)
    const wantsAnalysis = /拉片|解剖|分析|解读|讲解/.test(String(text || ''))
    const wantsDownloadOnly = /下载|保存/.test(String(text || '')) && !wantsAnalysis
    const mode = wantsAnalysis ? 'analyze' : wantsDownloadOnly ? 'download' : isDownloadIntent(text) ? 'analyze' : null
    return { matched: Boolean(mode), url, direct: isMediaUrl(url), mode }
  })
  ipcMain.handle('media:download', async (event, input = {}) => {
    assertTrustedSender(event)
    const url = extractUrl(input.url || input.text || '')
    if (!url) return { success: false, error: '没有找到可下载的链接' }
    const requestId = normalizeRequestId(input.requestId, 'media-dl')
    activeMediaDownloads.get(requestId)?.abort()
    const controller = new AbortController()
    activeMediaDownloads.set(requestId, controller)
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('media:download-status', { requestId, status })
    }
    try {
      sendStatus('正在校验链接')
      const result = await downloadRemoteMedia(url, {
        destDir: path.join(app.getPath('videos'), 'AgentPlay 下载'),
        signal: controller.signal,
        onProgress: ({ received, total }) => {
          const mb = (value) => (value / 1024 / 1024).toFixed(1)
          sendStatus(total ? `正在下载 ${mb(received)}/${mb(total)}MB` : `已下载 ${mb(received)}MB`)
        }
      })
      userAuthorizedPaths.add(path.resolve(result.outputPath))
      sendStatus('下载完成')
      return { success: true, requestId, ...result }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    } finally {
      activeMediaDownloads.delete(requestId)
    }
  })
  ipcMain.handle('media:download-cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeMediaDownloads.get(String(requestId || ''))
    controller?.abort()
    return Boolean(controller)
  })
  ipcMain.handle('documents:attach-paths', (event, filePaths) => {
    assertTrustedSender(event)
    // 拖入/粘贴等同用户显式授权（恢复产品本意）；但敏感凭证类文件永远拒绝附加
    const requested = Array.isArray(filePaths) ? filePaths.slice(0, 20) : []
    if (!requested.length) return []
    const valid = requested.filter((p) => {
      try {
        let real = path.resolve(String(p || ''))
        if (!fs.existsSync(real)) return false
        try { real = fs.realpathSync(real) } catch { /* 按词法路径校验 */ }
        return !SENSITIVE_FILE.test(real)
      } catch {
        return false
      }
    })
    if (!valid.length) return { error: '没有可处理的文件（敏感凭证类文件不允许附加）' }
    try {
      return approveDocumentPaths(valid)
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('documents:history', (event) => {
    assertTrustedSender(event)
    const historyFile = path.join(app.getPath('userData'), 'document-workspace', 'history.jsonl')
    try {
      const lines = fs.readFileSync(historyFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
      return lines.slice(-10).reverse().map((line) => {
        try {
          const record = JSON.parse(line)
          return { id: record.id, createdAt: record.createdAt, instruction: record.instruction, kind: record.kind, outputs: record.outputs || [], summary: record.summary || '' }
        } catch { return null }
      }).filter(Boolean)
    } catch {
      return []
    }
  })
  ipcMain.handle('documents:plan', (event, input = {}) => {
    assertTrustedSender(event)
    const tokens = Array.isArray(input.tokens) ? input.tokens.slice(0, 20) : []
    const paths = tokens.map(documentSelectionFromToken)
    const plan = documentWorkspace.plan(paths, input.instruction, input.outputFormat)
    return {
      kind: plan.kind,
      requiresAi: plan.requiresAi,
      outputFormat: plan.outputFormat,
      summary: plan.summary,
      files: plan.files.map(({ name, ext, size }) => ({ name, ext, size }))
    }
  })
  ipcMain.handle('documents:run', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'document')
    activeDocumentRequests.get(requestId)?.abort()
    const controller = new AbortController()
    activeDocumentRequests.set(requestId, controller)
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('documents:status', { requestId, status })
    }
    try {
      const tokens = Array.isArray(input.tokens) ? input.tokens.slice(0, 20) : []
      const paths = tokens.map(documentSelectionFromToken)
      const plan = documentWorkspace.plan(paths, input.instruction, input.outputFormat)
      if (plan.requiresAi) {
        const config = modelConfigStore.resolved('chat')
        const requiresKey = config.requiresKey !== false
        if (!config.baseUrl || !config.model || (requiresKey && !config.apiKey)) {
          throw new Error('这个任务需要模型理解内容，请先在“模型接入中心”配置模型')
        }
        if (paths.length > 0 && !isLocalModelConfig(config) && input.cloudApproved !== true && !(await ensureCloudConsent('所选文件的正文将用于理解并生成新文档。'))) {
          throw new Error('当前连接的是云端模型。请勾选“允许发送所选文件内容”，或改用本地模型')
        }
      }
      sendStatus(plan.requiresAi ? '正在理解要求和生成内容' : '正在执行本地文档操作')
      const result = await documentWorkspace.run(paths, input.instruction, input.outputFormat, { signal: controller.signal, onStatus: sendStatus })
      sendStatus('正在验证并保存结果')
      return { ...result, requestId }
    } catch (error) {
      return { success: false, requestId, error: error instanceof Error ? error.message : String(error) }
    } finally {
      activeDocumentRequests.delete(requestId)
    }
  })
  ipcMain.handle('documents:cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeDocumentRequests.get(String(requestId || ''))
    controller?.abort()
    return Boolean(controller)
  })
  // “打开任意文件”统一分流：媒体进播放器、文档进授权附件（chat:open-any 与 home:open 共用）
  const splitAndApproveAny = (filePaths) => {
    const split = splitOpenAnyPaths(filePaths, {
      inspectDocuments: (paths) => {
        const ext = path.extname(paths[0]).toLowerCase()
        if (AUDIO_MEDIA_EXTS.includes(ext)) throw new Error('音视频走播放器')
        return documentWorkspace.inspect(paths)
      },
      isMediaPath: (filePath, ext) => ALL_EXTS.includes(ext),
      approveDocument: (file) => {
        const token = crypto.randomUUID()
        approvedDocumentSelections.set(token, { path: file.path, createdAt: Date.now() })
        userAuthorizedPaths.add(file.path)
        return { token, name: file.name, ext: file.ext, size: file.size }
      }
    })
    for (const mediaPath of split.media) userAuthorizedPaths.add(mediaPath)
    return split
  }

  ipcMain.handle('chat:open-any', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开文件（视频、音频、图片或文档）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有支持的文件', extensions: [...new Set([...ALL_EXTS, ...SUPPORTED_EXTENSIONS].map((ext) => ext.slice(1)))] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) return { media: [], documents: [] }
    return splitAndApproveAny(result.filePaths)
  })
  // 首页“打开”：一个对话框同时接受文件与文件夹；文件按类型分流，文件夹授权并回报给媒体库
  ipcMain.handle('home:open', async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开（可选择文件或文件夹）',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [
        { name: '所有支持的文件', extensions: [...new Set([...ALL_EXTS, ...SUPPORTED_EXTENSIONS].map((ext) => ext.slice(1)))] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled) return { media: [], documents: [], folders: [] }
    const folders = []
    const files = []
    for (const filePath of result.filePaths.slice(0, 20)) {
      try {
        if (fs.statSync(filePath).isDirectory()) folders.push(path.resolve(filePath))
        else files.push(filePath)
      } catch { /* 路径失效时跳过 */ }
    }
    for (const folder of folders) authorizedFolders.add(folder)
    const split = splitAndApproveAny(files)
    return { ...split, folders }
  })
  ipcMain.handle('chat:attach-paths', (event, filePaths) => {
    assertTrustedSender(event)
    const roots = [...authorizedFolders]
    const requested = Array.isArray(filePaths) ? filePaths.slice(0, 20) : []
    const valid = requested.filter((filePath) => isPathInsideRoots(filePath, roots, { realpathSync: (value) => fs.realpathSync(value) }))
    if (valid.length === 0) return { documents: [], skipped: requested.length }
    return { documents: approveDocumentPaths(valid), skipped: requested.length - valid.length }
  })
  ipcMain.handle('models:providers', (event) => {
    assertTrustedSender(event)
    return PROVIDERS
  })
  ipcMain.handle('models:config', (event, role = 'chat') => {
    assertTrustedSender(event)
    return modelConfigStore.publicConfig(role)
  })
  ipcMain.handle('models:save', (event, config) => {
    assertTrustedSender(event)
    return modelConfigStore.save(config)
  })
  ipcMain.handle('models:quick-switch', async (event, input = {}) => {
    assertTrustedSender(event)
    const target = input.target === 'cloud' ? 'cloud' : 'bundled'
    if (target === 'bundled') {
      const status = await bundledRuntime.status()
      if (!status.assetsPresent) return { switched: false, needDownload: true, reason: '本地 AI 组件未下载' }
    }
    const result = modelConfigStore.quickSwitchRole(input.role || 'chat', target)
    return { ...result, bundled: await bundledRuntime.status() }
  })
  ipcMain.handle('models:list', async (event, config = {}) => {
    assertTrustedSender(event)
    try {
      const saved = modelConfigStore.resolved(config.role || 'chat')
      const apiKey = config.apiKey || (config.useSavedKey && config.providerId === saved.providerId ? saved.apiKey : '')
      // 用已存 Key 时必须钉死已存地址，防止渲染器把 Key 带到任意 baseUrl（Key 外泄面）
      if (!config.apiKey && config.useSavedKey && config.providerId === saved.providerId) config = { ...config, baseUrl: saved.baseUrl }
      const localStatus = config.providerId === 'bundled-lite' ? await bundledRuntime.start() : null
      return { success: true, models: await listModels({ ...config, apiKey, ...(localStatus ? { model: localStatus.model, baseUrl: localStatus.baseUrl } : {}) }) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), models: [] }
    }
  })
  ipcMain.handle('models:test', async (event, config = {}) => {
    assertTrustedSender(event)
    try {
      const saved = modelConfigStore.resolved(config.role || 'chat')
      const apiKey = config.apiKey || (config.useSavedKey && config.providerId === saved.providerId ? saved.apiKey : '')
      // 用已存 Key 时必须钉死已存地址，防止渲染器把 Key 带到任意 baseUrl（Key 外泄面）
      if (!config.apiKey && config.useSavedKey && config.providerId === saved.providerId) config = { ...config, baseUrl: saved.baseUrl }
      const localStatus = config.providerId === 'bundled-lite' ? await bundledRuntime.start() : null
      // 火山方舟：先探测 Key 是否属于 Coding Plan 套餐，是则按套餐专用地址验证并给出修正建议
      if (config.providerId === 'volcengine' && apiKey) {
        const plan = await detectVolcenginePlan(apiKey)
        if (plan.isPlan) {
          const models = plan.models.length ? plan.models : VOLCENGINE_CODING_MODELS
          return {
            success: true,
            planDetected: true,
            upgrade: {
              providerId: 'volcengine-coding',
              baseUrl: VOLCENGINE_CODING_BASE_URL,
              model: models.includes('ark-code-latest') ? 'ark-code-latest' : models[0],
              models
            },
            message: `检测到你的 Key 属于 Coding Plan 套餐：必须用套餐专用地址（/api/coding/v3），用通用地址会失败或产生额外费用。套餐内可用 ${models.length} 个模型，点「按套餐接入」一键修正。`
          }
        }
      }
      const result = await probeConnection({ ...config, apiKey, ...(localStatus ? { model: localStatus.model, baseUrl: localStatus.baseUrl } : {}) })
      const detail = result.generationVerified ? '，并已完成最小生成验证' : ''
      return { success: true, message: `连接成功，返回 ${result.models.length} 个可用模型${detail}` }
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('models:discover-local', async (event, role = 'chat') => {
    assertTrustedSender(event)
    return discoverLocalServices(role)
  })
  ipcMain.handle('models:bundled-status', (event) => {
    assertTrustedSender(event)
    return bundledRuntime.status()
  })
  ipcMain.handle('models:start-bundled', async (event) => {
    assertTrustedSender(event)
    return bundledRuntime.start()
  })
  ipcMain.handle('localai:status', (event) => {
    assertTrustedSender(event)
    return { ...bundledRuntime.status(), download: localAiDownload.status(), pack: localAiDownload.packInfo() }
  })
  ipcMain.handle('localai:download', async (event) => {
    assertTrustedSender(event)
    try {
      await localAiDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('localai:progress', progress)
        }
      })
      return { success: true, status: bundledRuntime.status() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('localai:cancel', (event) => {
    assertTrustedSender(event)
    return localAiDownload.cancel()
  })
  ipcMain.handle('transcribe:status', (event) => {
    assertTrustedSender(event)
    const availability = transcriptionService.availability()
    return {
      ...availability,
      download: whisperDownload.status(),
      pack: whisperDownload.packInfo()
    }
  })
  // 对话窗麦克风：接收录音二进制 → 暂存 → 本地 whisper 离线转写 → 文本返回（不出机）
  ipcMain.handle('transcribe:blob', async (event, input = {}) => {
    assertTrustedSender(event)
    const status = transcriptionService.availability()
    if (!status.available) return { success: false, error: '语音转写组件未下载：请到「模型接入中心」下载转写组件' }
    const data = input.data
    const isBinary = Boolean(data) && (ArrayBuffer.isView(data) || data instanceof ArrayBuffer)
    if (!isBinary) return { success: false, error: '音频数据格式无效' }
    const buffer = Buffer.from(data)
    // 大小以转换后的真实字节数为准（byteLength/length 属性可被伪造）
    if (!buffer.length) return { success: false, error: '没有收到音频数据' }
    if (buffer.length > 25 * 1024 * 1024) return { success: false, error: '录音超过 25MB 上限' }
    const ext = /^\.(webm|ogg|wav|mp3|m4a)$/.test(String(input.ext || '')) ? String(input.ext) : '.webm'
    const tmp = path.join(app.getPath('temp'), `agentplay-mic-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`)
    try {
      fs.writeFileSync(tmp, buffer)
      const transcription = await transcriptionService.transcribe({ sourcePath: tmp, lang: 'auto' })
      return { success: true, text: String(transcription.text || '').trim() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
    }
  })
  ipcMain.handle('transcribe:download', async (event) => {
    assertTrustedSender(event)
    try {
      await whisperDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('transcribe:progress', progress)
        }
      })
      return { success: true, availability: transcriptionService.availability() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('transcribe:cancel-download', (event) => {
    assertTrustedSender(event)
    return whisperDownload.cancel()
  })
  ipcMain.handle('translatePack:status', (event) => {
    assertTrustedSender(event)
    return {
      ...offlineTranslate.availability(),
      download: translateDownload.status(),
      pack: translateDownload.packInfo()
    }
  })
  ipcMain.handle('translatePack:download', async (event) => {
    assertTrustedSender(event)
    try {
      await translateDownload.start({
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send('translatePack:progress', progress)
        }
      })
      return { success: true, availability: offlineTranslate.availability() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('translatePack:cancel-download', (event) => {
    assertTrustedSender(event)
    return translateDownload.cancel()
  })
  ipcMain.handle('subtitle:bilingual-generate', async (event, input = {}) => {
    assertTrustedSender(event)
    const mediaPath = String(input.path || '').trim()
    if (!mediaPath || !fs.existsSync(mediaPath)) return { success: false, error: '没有可用的本地媒体文件' }
    if (!userAuthorizedPaths.has(path.resolve(mediaPath)) && !isPathInsideRoots(mediaPath, [...authorizedFolders], { realpathSync: (value) => fs.realpathSync(value) })) {
      return { success: false, error: '只允许处理你明确打开过或媒体库内的文件' }
    }
    const config = modelConfigStore.resolved('chat')
    const requiresKey = config.requiresKey !== false
    const cloudReady = Boolean(config.baseUrl && config.model && (!requiresKey || config.apiKey))
    const offlineReady = offlineTranslate.availability().available
    if (!cloudReady && !offlineReady) {
      return { success: false, error: '翻译需要云端模型或离线翻译组件，请先在模型接入中心配置或下载' }
    }
    // 双语生成可取消：controller 用渲染端已知的 requestId 注册，whisper 阶段直接可中止
    const cancelKey = String(input.requestId || 'bilingual')
    activeAnalysisRequests.get(cancelKey)?.abort()
    const controller = new AbortController()
    activeAnalysisRequests.set(cancelKey, controller)
    const requestId = String(input.requestId || 'bilingual')
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('subtitle:bilingual-status', { requestId, status })
    }
    try {
      // 有现成字幕（同名 srt/vtt/ass）时跳过语音识别，直接翻译，秒级出双语
      const adjacent = findAdjacentSubtitle(mediaPath)
      if (adjacent) {
        sendStatus(`检测到现成字幕 ${path.basename(adjacent)}，跳过语音识别，直接翻译`)
        const rawCues = parseSubtitleCues(fs.readFileSync(adjacent, 'utf8'), path.extname(adjacent))
        const entries = cuesToEntries(rawCues)
        if (entries.length === 0) return { success: false, error: '现成字幕内容为空，无法翻译' }
        const engine = pickTranslateEngine(entries)
        if (!engine.offline && !cloudReady) return { success: false, error: '当前字幕不是英文为主，离线组件翻不了，请先配置云端模型' }
        sendStatus(`共 ${entries.length} 句，正在逐批翻译（${engine.label}）`)
        const { translations, failed } = await translateEntries(entries, engine.complete)
        const bilingual = buildBilingualSrt(entries, translations)
        const srtPath = path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}-AgentPlay双语.srt`)
        fs.writeFileSync(srtPath, bilingual, 'utf8')
        sendStatus('双语字幕已生成')
        return { success: true, srtPath, count: entries.length, failed, fastPath: true }
      }
      const whisperStatus = transcriptionService.availability()
      if (!whisperStatus.available) return { success: false, error: `${whisperStatus.reason}，请先下载转写组件`, needDownload: true }
      sendStatus('正在离线识别语音（CPU，约为音频时长数倍）')
      const transcription = await transcriptionService.transcribe({ sourcePath: mediaPath, lang: 'auto', timestamps: true, signal: controller.signal })
      const entries = parseSrt(transcription.text)
      if (entries.length === 0) return { success: false, error: '没有识别到语音内容（可能是纯音乐或音量过低）' }
      const engine = pickTranslateEngine(entries)
      if (!engine.offline && !cloudReady) return { success: false, error: '识别出的内容不是英文为主，离线组件翻不了，请先配置云端模型' }
      sendStatus(`识别到 ${entries.length} 句，正在逐批翻译（${engine.label}）`)
      const { translations, failed } = await translateEntries(entries, engine.complete)
      const bilingual = buildBilingualSrt(entries, translations)
      const srtPath = path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}-AgentPlay双语.srt`)
      fs.writeFileSync(srtPath, bilingual, 'utf8')
      sendStatus('双语字幕已生成')
      return { success: true, srtPath, count: entries.length, failed }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      activeAnalysisRequests.delete(cancelKey)
    }
  })
  ipcMain.handle('subtitle:bilingual-cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeAnalysisRequests.get(String(requestId || ''))
    controller?.abort()
    return Boolean(controller)
  })
  // 轻量语言探测：抽前 12 秒音频转写判定 zh/en，给"要不要弹翻译提示"用
  ipcMain.handle('media:detect-language', async (event, filePath) => {
    assertTrustedSender(event)
    if (typeof filePath !== 'string' || !/\.(mp4|mkv|avi|mov|flv|webm|ts|m4v|wmv|mp3|flac|wav|aac|m4a|ogg|wma)$/i.test(filePath)) {
      return { lang: 'unknown', reason: '不是可探测的媒体文件' }
    }
    try {
      const resolved = assertAllowedPath(filePath)
      return await languageDetect.detect(resolved)
    } catch (error) {
      return { lang: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
  })
  // 实时双语字幕：从当前播放位置起逐批翻译，渲染进程叠显（原文上、译文下）；译完自动存双语 srt（不覆盖已有文件）
  ipcMain.handle('subtitle:live-start', async (event, input = {}) => {
    assertTrustedSender(event)
    const mediaPath = String(input.mediaPath || '').trim()
    if (!mediaPath || /^(https?|blob):/i.test(mediaPath) || !fs.existsSync(mediaPath)) {
      return { success: false, error: '实时翻译只支持本地媒体文件' }
    }
    if (!userAuthorizedPaths.has(path.resolve(mediaPath)) && !isPathInsideRoots(mediaPath, [...authorizedFolders], { realpathSync: (value) => fs.realpathSync(value) })) {
      return { success: false, error: '只允许处理你明确打开过或媒体库内的文件' }
    }
    const requestedSubtitle = String(input.subtitlePath || '').trim()
    const subtitlePath = requestedSubtitle && fs.existsSync(requestedSubtitle) ? requestedSubtitle : findAdjacentSubtitle(mediaPath)
    if (!subtitlePath) return { success: false, error: '没有找到可翻译的字幕：请先加载字幕，或用“生成双语字幕”先识别' }
    // 显式指定的字幕文件与媒体文件同权校验，防止借字幕通道读任意文本送云端
    if (requestedSubtitle && !userAuthorizedPaths.has(path.resolve(subtitlePath)) && !isPathInsideRoots(subtitlePath, allowedRoots(), { realpathSync: (value) => fs.realpathSync(value) })) {
      return { success: false, error: '字幕文件不在授权范围内' }
    }
    const ext = path.extname(subtitlePath).toLowerCase()
    if (!['.srt', '.vtt', '.ass', '.ssa'].includes(ext)) return { success: false, error: '字幕格式不支持（仅 srt/vtt/ass/ssa）' }
    const rawCues = parseSubtitleCues(fs.readFileSync(subtitlePath, 'utf8'), ext)
    if (!rawCues.length) return { success: false, error: '字幕内容为空，无法翻译' }
    const config = modelConfigStore.resolved('chat')
    const requiresKey = config.requiresKey !== false
    const cloudReady = Boolean(config.baseUrl && config.model && (!requiresKey || config.apiKey))
    const engine = pickTranslateEngine(rawCues.map((text, order) => ({ index: order + 1, text: text.text })))
    if (!engine.offline && !cloudReady) {
      return { success: false, error: offlineTranslate.availability().available ? '当前字幕不是英文为主，离线组件翻不了，请先配置云端模型' : '实时翻译需要云端模型或离线翻译组件，请先在模型接入中心配置或下载' }
    }
    liveSubtitleSession?.controller.abort()
    const requestId = normalizeRequestId(input.requestId, 'live-sub')
    const controller = new AbortController()
    const cues = rawCues.map((cue, order) => ({ index: order + 1, startSeconds: cue.start, endSeconds: cue.end, text: cue.text }))
    const entries = cuesToEntries(rawCues)
    const targetLang = String(input.targetLang || '中文').slice(0, 20)
    liveSubtitleSession = { requestId, controller, position: Number(input.currentTime) || 0 }
    const send = (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('subtitle:live-event', { requestId, ...payload })
    }
    ;(async () => {
      try {
        const result = await runLiveTranslation({
          cues, complete: engine.complete, signal: controller.signal, targetLang,
          getPosition: () => (liveSubtitleSession?.requestId === requestId ? liveSubtitleSession.position : 0),
          onBatch: async ({ batch, translations, failed }) => {
            send({
              type: 'progress', done: translations.size, failed: failed.size, total: cues.length,
              batch: batch.map((entry) => ({ index: entry.index, text: translations.get(entry.index) || '' })).filter((item) => item.text)
            })
          }
        })
        let srtPath = null
        if (result.translations.size) {
          const candidate = path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}-AgentPlay双语.srt`)
          try {
            if (!fs.existsSync(candidate)) {
              fs.writeFileSync(candidate, buildBilingualSrt(entries, result.translations), 'utf8')
            }
            srtPath = candidate
          } catch (error) { log.error('实时双语字幕写盘失败', error) }
        }
        send({ type: 'finish', done: result.translations.size, failed: result.failed, total: cues.length, srtPath, cancelled: result.cancelled })
      } catch (error) {
        send({ type: 'error', error: error instanceof Error ? error.message : String(error) })
      } finally {
        if (liveSubtitleSession?.requestId === requestId) liveSubtitleSession = null
      }
    })()
    return { success: true, requestId, total: cues.length, subtitlePath, cues: cues.map((cue) => ({ index: cue.index, start: cue.startSeconds, end: cue.endSeconds, text: cue.text })) }
  })
  ipcMain.handle('subtitle:live-seek', (event, input = {}) => {
    assertTrustedSender(event)
    if (liveSubtitleSession && liveSubtitleSession.requestId === String(input.requestId || '')) {
      liveSubtitleSession.position = Number(input.currentTime) || 0
      return true
    }
    return false
  })
  ipcMain.handle('subtitle:live-stop', (event, requestId) => {
    assertTrustedSender(event)
    if (liveSubtitleSession && (!requestId || liveSubtitleSession.requestId === String(requestId))) {
      liveSubtitleSession.controller.abort()
      liveSubtitleSession = null
      return true
    }
    return false
  })
  ipcMain.handle('models:stop-bundled', async (event) => {
    assertTrustedSender(event)
    return bundledRuntime.stop()
  })

  ipcMain.handle('studio:context', (event, mediaPath) => {
    assertTrustedSender(event)
    return loadAnalysisContext(mediaPath)
  })
  ipcMain.handle('studio:capabilities', (event) => {
    assertTrustedSender(event)
    const renderBinary = mpv?.getBinaryPath()
    const voiceHelper = process.platform === 'win32'
      ? (app.isPackaged ? path.join(process.resourcesPath, 'bin', 'win', 'ai-player-voice.exe') : path.join(__dirname, '..', 'resources', 'bin', 'win', 'ai-player-voice.exe'))
      : null
    const systemVoiceAvailable = process.platform === 'win32'
      ? Boolean(voiceHelper && fs.existsSync(voiceHelper))
      : process.platform === 'darwin'
        ? fs.existsSync('/usr/bin/say')
        : ['/usr/bin/espeak-ng', '/usr/local/bin/espeak-ng'].some((candidate) => fs.existsSync(candidate))
    return {
      platform: process.platform,
      multimodalPlanning: true,
      cloudImage: true,
      cloudVoice: true,
      systemVoice: systemVoiceAvailable,
      advancedRender: Boolean(renderBinary && fs.existsSync(renderBinary)),
      renderBinary: renderBinary && fs.existsSync(renderBinary) ? path.basename(renderBinary) : null
    }
  })
  ipcMain.handle('studio:offline-analysis', (event, input = {}) => {
    assertTrustedSender(event)
    return buildOfflineAnalysis(input)
  })
  // 对话流视频解剖：AI 助手面板直接对当前视频发起，报告经文档工作台另存，原文件不动
  ipcMain.handle('analysis:detect', (event, text) => {
    assertTrustedSender(event)
    return { matched: detectAnalysisIntent(text), outputFormat: resolveAnalysisOutput(text) }
  })
  ipcMain.handle('analysis:run', async (event, input = {}) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(input.requestId, 'analysis')
    activeAnalysisRequests.get(requestId)?.abort()
    const controller = new AbortController()
    activeAnalysisRequests.set(requestId, controller)
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('analysis:status', { requestId, status })
    }
    try {
      const config = modelConfigStore.resolved('chat')
      const requiresKey = config.requiresKey !== false
      const approved = await ensureCloudConsent('视频关键画面截图与口播字幕将发送给云端模型用于深度解剖。')
      const result = await runChatAnalysis({
        sourcePath: input.sourcePath,
        mediaName: input.mediaName,
        duration: input.duration,
        instruction: input.instruction,
        outputFormat: input.outputFormat,
        cloudApproved: approved,
        signal: controller.signal,
        onStatus: sendStatus,
        workspace: documentWorkspace,
        complete: llmComplete,
        completeVisionMulti: llmCompleteVisionMulti,
        frames: videoFrames,
        model: {
          configured: Boolean(config.baseUrl && config.model && (!requiresKey || config.apiKey)),
          local: isLocalModelConfig(config),
          provider: config.providerName || config.providerId || '',
          model: config.model || ''
        }
      })
      return { ...result, requestId }
    } finally {
      activeAnalysisRequests.delete(requestId)
    }
  })
  ipcMain.handle('analysis:cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeAnalysisRequests.get(String(requestId || ''))
    controller?.abort()
    return Boolean(controller)
  })
  ipcMain.handle('studio:export-project', async (event, project = {}) => {
    assertTrustedSender(event)
    const serialized = JSON.stringify(project, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > 10 * 1024 * 1024) throw new Error('项目文件超过 10MB')
    const safeName = String(project.mediaName || '视频').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.[^.]+$/, '')
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('documents'), `${safeName}-AI拉片项目.aiproj.json`),
      filters: [{ name: 'AI播放器拉片项目', extensions: ['aiproj.json', 'json'] }]
    })
    if (result.canceled || !result.filePath) return { success: false, cancelled: true }
    fs.writeFileSync(result.filePath, serialized, 'utf8')
    return { success: true, outputPath: result.filePath }
  })
  ipcMain.handle('studio:render', async (event, input = {}) => {
    assertTrustedSender(event)
    if (activeRecutProcess && !activeRecutProcess.killed) throw new Error('已有原创重构任务正在渲染')
    const safeName = String(input.mediaName || '原创重构').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.[^.]+$/, '')
    const destination = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('videos'), `${safeName}-原创重构.mp4`),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    if (destination.canceled || !destination.filePath) return { success: false, cancelled: true }
    try {
      const playbackBinary = mpv.getBinaryPath()
      const renderBinary = process.platform === 'win32' && fs.existsSync(playbackBinary.replace(/\.exe$/i, '.com'))
        ? playbackBinary.replace(/\.exe$/i, '.com')
        : playbackBinary
      return await renderRecut({
        mpvPath: renderBinary,
        sourcePath: input.sourcePath,
        segments: input.segments,
        outputPath: destination.filePath,
        onSpawn: (child) => { activeRecutProcess = child }
      })
    } finally {
      activeRecutProcess = null
    }
  })
  ipcMain.handle('studio:creative-plan', async (event, input = {}) => {
    assertTrustedSender(event)
    return requestCreativePlan(modelConfigStore.resolved('chat'), input)
  })
  ipcMain.handle('studio:generate-image', async (event, input = {}) => {
    assertTrustedSender(event)
    return generateImageAsset(modelConfigStore.resolved('chat'), {
      ...input,
      outputDir: path.join(app.getPath('userData'), 'creative-assets', 'images')
    })
  })
  ipcMain.handle('studio:generate-video', async (event, input = {}) => {
    assertTrustedSender(event)
    return generateVideoAsset(modelConfigStore.resolved('chat'), {
      ...input,
      outputDir: path.join(app.getPath('userData'), 'creative-assets', 'videos')
    })
  })
  ipcMain.handle('studio:generate-voice', async (event, input = {}) => {
    assertTrustedSender(event)
    const request = {
      ...input,
      outputDir: path.join(app.getPath('userData'), 'creative-assets', 'voice'),
      helperPath: app.isPackaged
        ? path.join(process.resourcesPath, 'bin', 'win', 'ai-player-voice.exe')
        : path.join(__dirname, '..', 'resources', 'bin', 'win', 'ai-player-voice.exe')
    }
    return input.engine === 'cloud'
      ? synthesizeCloudVoice(modelConfigStore.resolved('chat'), request)
      : synthesizeSystemVoice(request)
  })
  ipcMain.handle('studio:select-asset', async (event, kind) => {
    assertTrustedSender(event)
    const image = kind === 'image'
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: image
        ? [{ name: '图片素材', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
        : [{ name: '音频素材', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aiff'] }]
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('studio:render-creative', async (event, input = {}) => {
    assertTrustedSender(event)
    if (activeRecutProcess && !activeRecutProcess.killed) throw new Error('已有创作或渲染任务正在运行')
    const safeName = String(input.mediaName || input.title || 'AI原创成片').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.[^.]+$/, '')
    const destination = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('videos'), `${safeName}-AI原创成片.mp4`),
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }]
    })
    if (destination.canceled || !destination.filePath) return { success: false, cancelled: true }
    try {
      const playbackBinary = mpv.getBinaryPath()
      const renderBinary = process.platform === 'win32' && fs.existsSync(playbackBinary.replace(/\.exe$/i, '.com'))
        ? playbackBinary.replace(/\.exe$/i, '.com')
        : playbackBinary
      return await renderCreativeVideo({
        mpvPath: renderBinary,
        ffmpegPath: path.join(app.getPath('userData'), 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin', 'ffmpeg.exe'),
        input,
        outputPath: destination.filePath,
        onSpawn: (child) => { activeRecutProcess = child }
      })
    } finally {
      activeRecutProcess = null
    }
  })
  ipcMain.handle('studio:cancel-render', (event) => {
    assertTrustedSender(event)
    return stopActiveRender()
  })

  ipcMain.handle('computerUse:suggest', async (event, task, requestedId) => {
    assertTrustedSender(event)
    const requestId = normalizeRequestId(requestedId, 'observe')
    activeComputerUseRequests.get(requestId)?.abort()
    const controller = new AbortController()
    activeComputerUseRequests.set(requestId, controller)
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('computerUse:status', { requestId, status })
    }
    try {
      sendStatus('capturing')
      const result = await computerUseOrchestrator.suggest({
        task,
        config: modelConfigStore.resolved('computerUse'),
        signal: controller.signal,
        onStatus: sendStatus
      })
      sendStatus('done')
      return { ...result, requestId }
    } finally {
      activeComputerUseRequests.delete(requestId)
    }
  })
  ipcMain.handle('computerUse:cancel', (event, requestId) => {
    assertTrustedSender(event)
    const controller = activeComputerUseRequests.get(String(requestId || ''))
    controller?.abort()
    return Boolean(controller)
  })

  ipcMain.handle('files:scan', (_e, dir) => {
    assertTrustedSender(_e)
    try {
      return scanDir(dir ? assertAllowedPath(dir) : defaultVideoDir())
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('files:defaultDir', (event) => { assertTrustedSender(event); return defaultVideoDir() })
  ipcMain.handle('files:readText', async (_e, filePath) => {
    assertTrustedSender(_e)
    try {
      const resolved = assertAllowedPath(filePath)
      const stat = fs.statSync(resolved)
      const ext = path.extname(resolved).toLowerCase()
      if (!stat.isFile() || !['text', 'subtitle'].includes(getType(ext))) throw new Error('只允许读取支持的文本文件')
      if (stat.size > 2 * 1024 * 1024) throw new Error('文本文件超过 2MB 预览上限')
      const content = fs.readFileSync(resolved, 'utf-8')
      return { success: true, content: content.slice(0, 100000) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('files:readDataUrl', async (_e, filePath) => {
    assertTrustedSender(_e)
    try {
      const resolved = assertAllowedPath(filePath)
      const stat = fs.statSync(resolved)
      const type = getType(path.extname(resolved).toLowerCase())
      if (!stat.isFile() || !['image', 'pdf'].includes(type)) throw new Error('只允许读取图片或 PDF')
      if (stat.size > 50 * 1024 * 1024) throw new Error('文件超过 50MB 预览上限')
      const buffer = fs.readFileSync(resolved)
      const ext = path.extname(resolved).slice(1).toLowerCase()
      const mimeMap = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
        tif: 'image/tiff', tiff: 'image/tiff',
        pdf: 'application/pdf'
      }
      const mime = mimeMap[ext] || 'application/octet-stream'
      return { success: true, dataUrl: 'data:' + mime + ';base64,' + buffer.toString('base64') }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
  ipcMain.handle('print:file', async (event, p) => {
    assertTrustedSender(event)
    try {
      const resolved = assertPrintablePath(p)
      const ext = path.extname(resolved).toLowerCase()
      if (['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.csv', '.ods', '.ppt', '.pptx', '.odp'].includes(ext)) {
        const printed = await officeConvert.printFile(resolved)
        return { success: true, action: `已用本机 ${printed.engine} 发送打印` }
      }
      return printFile(resolved)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('print:html', async (event, html) => {
    assertTrustedSender(event)
    try {
      const content = String(html || '')
      if (!content.trim()) throw new Error('没有可打印的内容')
      if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) throw new Error('打印内容超过 5MB')
      const win = new BrowserWindow({ show: false, sandbox: true, webPreferences: { contextIsolation: true, nodeIntegration: false } })
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(content))
      win.webContents.print({ printBackground: true })
      setTimeout(() => win.close(), 2000)
      return { success: true, action: '已发送打印' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('print:text', async (event, filePath) => {
    assertTrustedSender(event)
    try {
      const resolved = assertPrintablePath(filePath)
      const content = require('fs').readFileSync(resolved, 'utf-8').slice(0, 50000)
      const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const win = new BrowserWindow({ show: false })
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<pre style="font-family:monospace;white-space:pre-wrap;padding:20px">' + escaped + '</pre>'))
      win.webContents.print({ printBackground: true })
      setTimeout(() => win.close(), 2000)
      return { success: true, action: '已发送打印' }
    } catch (e) { return { success: false, error: String(e) } }
  })
  ipcMain.handle('wifi:url', async (event) => {
    assertTrustedSender(event)
    if (!wifiTransfer) return null
    try {
      if (!wifiTransfer.server) await wifiTransfer.start()
      return wifiTransfer.getUrl()
    } catch (error) {
      log.error('用户启用 WiFi 传输失败', error)
      return null
    }
  })
  ipcMain.handle('wifi:pin', (event) => { assertTrustedSender(event); return (wifiTransfer?.server ? wifiTransfer.getPin() : null) })
  ipcMain.handle('wifi:stop', (event) => {
    assertTrustedSender(event);
    wifiTransfer?.stop(); return true })
  ipcMain.handle('tmdb:search', (_e, name, apiKey) => { assertTrustedSender(_e); return searchMovie(name, apiKey || process.env.TMDB_API_KEY) })
  ipcMain.handle('subtitle:search', (_e, name, apiKey) => { assertTrustedSender(_e); return searchSubtitle(name, apiKey || process.env.OPENSUBTITLES_API_KEY) })
  ipcMain.handle('subtitle:download', (_e, fileId, apiKey) => { assertTrustedSender(_e); return downloadSubtitle(fileId, apiKey || process.env.OPENSUBTITLES_API_KEY) })
  ipcMain.handle('media:analyze', (_e, dir) => {
    assertTrustedSender(_e)
    try {
      const files = analyzeDir(dir ? assertAllowedPath(dir) : defaultVideoDir())
      return { files, clusters: clusterByTag(files) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:dedup', (_e, dir) => {
    assertTrustedSender(_e)
    try {
      const files = analyzeDir(dir ? assertAllowedPath(dir) : defaultVideoDir())
      return findDuplicates(files)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('media:suggest', (_e, dir) => {
    assertTrustedSender(_e)
    try {
      const files = analyzeDir(dir ? assertAllowedPath(dir) : defaultVideoDir())
      return suggestClip(files)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('dlna:serverUrl', async (event) => {
    assertTrustedSender(event)
    if (!dlnaServer) return null
    try {
      if (!dlnaServer.server) await dlnaServer.start(defaultVideoDir())
      return `http://${require('./utils').getLanIp()}:${dlnaServer.port}`
    } catch (error) {
      log.error('用户启用 DLNA 媒体库失败', error)
      return null
    }
  })
  ipcMain.handle('dlna:serverStop', (event) => {
    assertTrustedSender(event);
    dlnaServer?.stop(); return true })
  ipcMain.handle('receiver:start', async (event) => {
    assertTrustedSender(event)
    if (!dlnaReceiver) return false
    try {
      if (!dlnaReceiver.httpServer) await dlnaReceiver.start()
      return true
    } catch (error) {
      log.error('用户启用 DLNA 接收失败', error)
      return false
    }
  })
  ipcMain.handle('receiver:stop', (event) => {
    assertTrustedSender(event);
    dlnaReceiver?.stop(); return true })
  ipcMain.handle('plugin:list', (event) => { assertTrustedSender(event); return listPlugins() })
  ipcMain.handle('plugin:openFolder', async (event) => {
    assertTrustedSender(event)
    const { shell } = require('electron')
    const { PLUGIN_DIR } = require('./plugin-service')
    fs.mkdirSync(PLUGIN_DIR, { recursive: true })
    const error = await shell.openPath(PLUGIN_DIR)
    return error ? { success: false, error } : { success: true }
  })
  ipcMain.handle('cast:scan', (event) => { assertTrustedSender(event); return castService.scan() })
  ipcMain.handle('cast:cast', (event, deviceId, filePath) => {
    assertTrustedSender(event)
    try {
      return castService.cast(deviceId, assertAllowedPath(filePath))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('cast:stop', (_e, deviceId) => { assertTrustedSender(_e); return castService.stopCast(deviceId) })
  ipcMain.handle('dialog:openFile', (event) => { assertTrustedSender(event); return chooseFile() })
  ipcMain.handle('dialog:openFolder', async (event) => {
    assertTrustedSender(event);
    const { dialog } = require('electron'); const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }); if (r.canceled) return null; authorizedFolders.add(r.filePaths[0]); return r.filePaths[0] })
  ipcMain.handle('system:openPath', async (_e, filePath) => {
    assertTrustedSender(_e)
    const { shell } = require('electron')
    try {
      const resolved = assertAllowedPath(filePath, { denyExecutable: true })
      if (!fs.existsSync(resolved)) return { success: false, error: '文件不存在' }
      const error = await shell.openPath(resolved)
      return error ? { success: false, error } : { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('docx:preview', (_e, filePath) => {
    assertTrustedSender(_e)
    try {
      return previewDocx(assertAllowedPath(filePath))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('xlsx:preview', (_e, filePath) => {
    assertTrustedSender(_e)
    try {
      return previewXlsx(assertAllowedPath(filePath))
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('sync:url', async (event) => {
    assertTrustedSender(event)
    if (!syncService) return null
    try {
      if (!syncService.server) await syncService.start()
      return syncService.getUrl()
    } catch (error) {
      log.error('用户启用跨设备同步失败', error)
      return null
    }
  })
  ipcMain.handle('sync:stop', (event) => {
    assertTrustedSender(event);
    syncService?.stop(); return true })
  ipcMain.handle('sync:setPeer', (_e, url) => {
    assertTrustedSender(_e)
    return syncService?.setPeer(url) ?? false
  })
  ipcMain.handle('sync:upload', (event) => { assertTrustedSender(event); return syncService.upload() })
  ipcMain.handle('sync:download', (event) => { assertTrustedSender(event); return syncService.download() })
  ipcMain.handle('sync:getProgress', (_e, key) => { assertTrustedSender(_e); return syncService.getProgress(key) })
  ipcMain.handle('sync:setProgress', (_e, key, position, preferences) => {
    assertTrustedSender(_e)
    syncService.setProgress(key, position, preferences)
    return true
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  for (const controller of activeAiRequests.values()) controller.abort()
  for (const controller of activeComputerUseRequests.values()) controller.abort()
  for (const controller of activeDocumentRequests.values()) controller.abort()
  // 统一收尸：分析/下载/实时字幕/镜像/转写，退出不留孤儿进程
  for (const controller of activeAnalysisRequests.values()) controller.abort()
  for (const controller of activeMediaDownloads.values()) controller.abort()
  try { liveSubtitleSession?.stop?.() } catch { /* 忽略 */ }
  try { mirrorReceiver?.stop() } catch { /* 忽略 */ }
  if (mirrorCaptureTimer) clearInterval(mirrorCaptureTimer)
  try { mirrorSender?.close() } catch { /* 忽略 */ }
  try { mirrorWindow && !mirrorWindow.isDestroyed() && mirrorWindow.destroy() } catch { /* 忽略 */ }
  try { transcriptionService.stopAll() } catch { /* 忽略 */ }
  if (mpv) mpv.stop()
  if (mpvContainer && !mpvContainer.isDestroyed()) mpvContainer.destroy()
  if (wifiTransfer) wifiTransfer.stop()
  if (castService) castService.stop()
  if (syncService) syncService.stop()
  if (dlnaReceiver) dlnaReceiver.stop()
  if (dlnaServer) dlnaServer.stop()
  if (bundledRuntime) void bundledRuntime.stop()
  stopActiveRender()
})
