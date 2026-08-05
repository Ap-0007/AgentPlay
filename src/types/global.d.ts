declare module '*.mjs' {
  export const PLAYER_CHROME_HIDE_DELAY_MS: number
  export const PLAYER_MOUSE_WAKE_THRESHOLD_PX: number
  export function shouldAutoHideControls(input: { hasMedia?: boolean; playing: boolean; blocked?: boolean }): boolean
  export function isRealMouseActivity(last: { x: number; y: number } | null, next: { x: number; y: number } | null, threshold?: number): boolean
}

// 桌面端 Electron 注入的全局 API 类型声明
interface AiPlayerPlayerAPI {
  info: () => Promise<{ ready: boolean; embedded: boolean; available: boolean }>
  loadFile: (p: string) => Promise<boolean>
  play: () => Promise<boolean>
  pause: () => Promise<boolean>
  seek: (s: number) => Promise<boolean>
  setVolume: (v: number) => Promise<boolean>
  setSpeed: (v: number) => Promise<boolean>
  setPictureMode: (mode: 'original' | 'fit' | 'fill' | 'stretch') => Promise<boolean>
  loadSubtitle: (p: string) => Promise<boolean>
  setSubtitleVisible: (v: boolean) => Promise<boolean>
  stop: () => Promise<boolean>
  screenshot: (suggestedName: string) => Promise<boolean>
  setPlayerArea: (rect: { x: number; y: number; width: number; height: number }) => void
  showContainer: () => void
  hideContainer: () => void
  onEvent: (cb: (data: MpvEvent) => void) => () => void
  onRemeasure: (cb: () => void) => () => void
}

interface AiPlayerAPI {
  platform: string
  isElectron: boolean
  version: string
  documents?: {
    capabilities: () => Promise<{
      formats: string[]
      modelConfigured: boolean
      modelLocal: boolean
      providerName: string
      model: string
      defaultOutputDir: string
    }>
    selectFiles: () => Promise<Array<{ token: string; name: string; ext: string; size: number }>>
    attachPaths: (filePaths: string[]) => Promise<Array<{ token: string; name: string; ext: string; size: number }> | { error: string }>
    history: () => Promise<Array<{ id: string; createdAt: string; instruction: string; kind: string; outputs: string[]; summary: string }>>
    plan: (input: {
      tokens: string[]
      instruction: string
      outputFormat: string
    }) => Promise<{
      kind: string
      requiresAi: boolean
      outputFormat: string
      summary: string
      files: Array<{ name: string; ext: string; size: number }>
    }>
    run: (input: {
      tokens: string[]
      instruction: string
      outputFormat: string
      cloudApproved: boolean
      requestId: string
    }) => Promise<{
      success: boolean
      requestId: string
      outputs?: string[]
      summary?: string
      historyId?: string
      plan?: { kind: string; requiresAi: boolean; outputFormat: string }
      error?: string
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
    onOpenExternal: (cb: (files: Array<{ token: string; name: string; ext: string; size: number }>) => void) => () => void
  }
  analysis?: {
    detect: (text: string) => Promise<{ matched: boolean; outputFormat: string }>
    run: (input: {
      sourcePath: string
      mediaName: string | null
      duration: number
      instruction: string
      outputFormat: string
      cloudApproved: boolean
      requestId: string
    }) => Promise<{
      success: boolean
      requestId: string
      requiresApproval?: boolean
      outputs?: string[]
      summary?: string
      historyId?: string
      usedAi?: boolean
      excerpt?: string
      cueCount?: number
      error?: string
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  localAI?: {
    status: () => Promise<LocalAiComponentStatus>
    download: () => Promise<{ success: boolean; error?: string; status?: BundledModelStatus }>
    cancel: () => Promise<boolean>
    onProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  home?: {
    open: () => Promise<{ media: string[]; documents: Array<{ token: string; name: string; ext: string; size: number }>; folders: string[] }>
    openFolder: () => Promise<{ folders: string[] }>
  }
  chat?: {
    openAny: () => Promise<{ media: string[]; documents: Array<{ token: string; name: string; ext: string; size: number }> }>
    attachPaths: (filePaths: string[]) => Promise<{ documents: Array<{ token: string; name: string; ext: string; size: number }>; skipped: number }>
  }
  transcribe?: {
    status: () => Promise<{ available: boolean; engineOk: boolean; modelOk: boolean; reason: string; download: Partial<LocalAiDownloadProgress> & { active: boolean; installed: boolean; presentBytes: number; totalBytes: number }; pack: { tag: string; totalBytes: number; assetCount: number } }>
    download: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    downloadSmall: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    cancelDownloadSmall: () => Promise<boolean>
    cancelDownload: () => Promise<boolean>
    blob: (input: { data: Uint8Array; ext?: string }) => Promise<{ success: boolean; text?: string; error?: string }>
    onProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  siteVideo?: {
    status: () => Promise<{ available: boolean; reason: string; enginePath: string; download: Partial<LocalAiDownloadProgress> & { active: boolean; installed: boolean; presentBytes: number; totalBytes: number }; pack: { tag: string; totalBytes: number; assetCount: number } }>
    downloadComponent: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    cancelComponent: () => Promise<boolean>
    download: (input: { url: string; requestId: string }) => Promise<{ success: boolean; error?: string; requestId?: string; outputPath?: string; bytes?: number; info?: { title: string; duration: number; uploader: string; extractor: string } }>
    importCookies: () => Promise<{ success: boolean; canceled?: boolean; error?: string; domain?: string; count?: number }>
    cookiesStatus: () => Promise<Array<{ domain: string; updatedAt: number }>>
    login: (input: { domain?: string }) => Promise<{ success: boolean; canceled?: boolean; error?: string; domain?: string; file?: string }>
    onComponentProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  mirror?: {
    startReceiver: () => Promise<{ success: boolean; port?: number; pin?: string; name?: string; error?: string }>
    stopReceiver: () => Promise<boolean>
    scan: () => Promise<Array<{ name: string; host: string; port: number }>>
    startSender: (input: { host: string; port: number; pin: string }) => Promise<{ success: boolean; error?: string }>
    stopSender: () => Promise<boolean>
    status: () => Promise<{ receiving: { port: number; pin: string; name: string } | null; sending: { host: string; port: number } | null }>
  }
  mediaDownload?: {
    detect: (text: string) => Promise<{ matched: boolean; url: string; direct?: boolean; mode?: 'analyze' | 'download' | null }>
    download: (input: { url: string; requestId: string }) => Promise<{ success: boolean; error?: string; requestId?: string; outputPath?: string; bytes?: number; finalUrl?: string }>
    linkAnalysis: (input: { url?: string; videoPath?: string; instruction?: string; outputFormat?: string; cloudApproved?: boolean; requestId: string }) => Promise<{ success: boolean; error?: string; requiresApproval?: boolean; requestId?: string; videoPath?: string; info?: { title: string; duration: number; uploader: string }; outputs?: string[]; summary?: string; usedAi?: boolean; excerpt?: string; cueCount?: number; whispered?: boolean }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  translatePack?: {
    status: () => Promise<{ available: boolean; missing: string[]; reason: string; modelDir: string; download: Partial<LocalAiDownloadProgress> & { active: boolean; installed: boolean; presentBytes: number; totalBytes: number }; pack: { tag: string; totalBytes: number; assetCount: number } }>
    download: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    cancelDownload: () => Promise<boolean>
    onProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  ebook?: {
    open: (input: { identifier: string; fileName: string }) => Promise<{ success: boolean; error?: string; chapters: string[]; count: number }>
    chapter: (input: { identifier: string; fileName: string; index: number }) => Promise<{ success: boolean; error?: string; title: string; text: string; index: number }>
    translate: (input: { identifier: string; fileName: string; index: number; engine: 'offline' | 'cloud'; target?: 'zh' | 'vernacular' | 'en' }) => Promise<{ success: boolean; error?: string; text: string; cached?: boolean }>
    onTranslateStatus: (cb: (event: { index: number; status: string }) => void) => () => void
  }
  rapidocrPack?: {
    status: () => Promise<{ available: boolean; missing: string[]; reason: string; modelDir: string; download: Partial<LocalAiDownloadProgress> & { active: boolean; installed: boolean; presentBytes: number; totalBytes: number }; pack: { tag: string; totalBytes: number; assetCount: number } }>
    download: () => Promise<{ success: boolean; error?: string; availability?: unknown }>
    cancelDownload: () => Promise<boolean>
    onProgress: (cb: (progress: LocalAiDownloadProgress) => void) => () => void
  }
  onlineMedia?: {
    search: (input: { query: string; kind?: 'movie' | 'audio' | 'book'; page?: number }) => Promise<{ success: boolean; error?: string; items: Array<{ identifier: string; title: string; year: string; creator: string; downloads: number }>; total: number }>
    files: (input: { identifier: string; kind?: 'movie' | 'audio' }) => Promise<{ success: boolean; error?: string; identifier: string; title: string; files: Array<{ name: string; size: number; url: string; format: string }> }>
    bookFiles: (input: { identifier: string }) => Promise<{ success: boolean; error?: string; identifier: string; title: string; creator: string; files: Array<{ name: string; size: number; url: string; format: string }> }>
    download: (input: { url: string; requestId: string }) => Promise<{ success: boolean; error?: string; outputPath?: string; bytes?: number }>
    cancel: (requestId: string) => Promise<boolean>
    onProgress: (cb: (progress: { requestId: string; received: number; total: number }) => void) => () => void
  }
  subtitleBilingual?: {
    generate: (input: { path: string; requestId: string }) => Promise<{ success: boolean; error?: string; needDownload?: boolean; srtPath?: string; count?: number; failed?: number }>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  detectLanguage?: (filePath: string) => Promise<{ lang: string; reason?: string; sample?: string }>
  subtitleLive?: {
    start: (input: { mediaPath: string; subtitlePath?: string; currentTime?: number; targetLang?: string; requestId: string }) => Promise<{
      success: boolean
      error?: string
      requestId?: string
      total?: number
      subtitlePath?: string
      cues?: Array<{ index: number; start: number; end: number; text: string }>
    }>
    startTranscribe: (input: { mediaPath: string; currentTime: number; duration?: number; requestId?: string }) => Promise<{
      success: boolean
      error?: string
      requestId?: string
      durationSec?: number
    }>
    seek: (input: { requestId: string; currentTime: number }) => Promise<boolean>
    stop: (requestId?: string) => Promise<boolean>
    onEvent: (cb: (event: {
      requestId: string
      type: 'progress' | 'finish' | 'error' | 'transcribe-cues' | 'refining' | 'refined' | 'refine-failed'
      done?: number
      failed?: number
      total?: number
      batch?: Array<{ index: number; text: string }>
      cueCount?: number
      cues?: Array<{ index: number; start: number; end: number; text: string }>
      srtPath?: string | null
      cancelled?: boolean
      error?: string
    }) => void) => () => void
  }
  player?: AiPlayerPlayerAPI
  sync?: {
    url: () => Promise<string | null>
    stop: () => Promise<boolean>
    setPeer: (url: string) => Promise<boolean>
    upload: () => Promise<{ success?: boolean; error?: string; count?: number }>
    download: () => Promise<{ success?: boolean; error?: string; count?: number }>
    getProgress: (key: string) => Promise<{ position: number; preferences?: { volume?: number; subtitleVisible?: boolean }; updatedAt: number } | null>
    setProgress: (key: string, position: number, preferences: { volume: number; subtitleVisible: boolean }) => Promise<boolean>
  }
  cast?: {
    scan: () => Promise<Array<{ id: string; name: string; location: string; controlUrl: string; lastSuccess?: boolean }>>
    cast: (deviceId: string, filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
    stop: (deviceId: string) => Promise<{ success: boolean; action?: string; error?: string }>
    pause: (deviceId: string) => Promise<{ success: boolean; action?: string; error?: string }>
    resume: (deviceId: string) => Promise<{ success: boolean; action?: string; error?: string }>
    seek: (deviceId: string, seconds: number) => Promise<{ success: boolean; action?: string; error?: string }>
    status: (deviceId: string) => Promise<{ success: boolean; state?: string; label?: string; error?: string }>
    ensureFirewall: () => Promise<{ needed: boolean }>
    allowFirewall: () => Promise<{ success: boolean; error?: string }>
  }
  tmdb?: {
    search: (name: string, apiKey?: string) => Promise<{ success: boolean; data?: { title: string; poster: string | null; overview: string; year: string | null }; error?: string }>
  }
  wifi?: {
    url: () => Promise<string | null>
    pin: () => Promise<string | null>
    stop: () => Promise<boolean>
  }
  dlna?: {
    serverUrl: () => Promise<string | null>
    stopServer: () => Promise<boolean>
  }
  plugin?: {
    list: () => Promise<Array<{ name: string; version?: string; description?: string; tools?: unknown[]; error?: string; file: string }>>
    openFolder: () => Promise<{ success: boolean; error?: string }>
  }
  media?: {
    analyze: (dir?: string) => Promise<{
      files: Array<{ name: string; path: string; ext: string; type: string; size: number; tags: string[]; group: string }>
      clusters: Record<string, unknown[]>
    }>
    dedup: (dir?: string) => Promise<Array<{ original: string; duplicate: string; name: string }>>
    suggest: (dir?: string) => Promise<Array<{ tag: string; count: number; files: string[]; suggestion: string }>>
  }
  studio?: {
    capabilities: () => Promise<{ platform: string; multimodalPlanning: boolean; cloudImage: boolean; cloudVoice: boolean; systemVoice: boolean; advancedRender: boolean; renderBinary: string | null }>
    context: (mediaPath: string) => Promise<{
      subtitlePath: string | null
      cues: Array<{ start: number; end: number; text: string }>
      transcript: string
    }>
    offlineAnalysis: (input: {
      mediaName: string | null
      duration: number
      markers: Array<{
        id: string
        at: number
        thumbnail?: string
        shotSize: string
        movement: string
        function: string
        emotion: string
        note: string
      }>
      cues: Array<{ start: number; end: number; text: string }>
    }) => Promise<string>
    exportProject: (project: Record<string, unknown>) => Promise<{ success: boolean; cancelled?: boolean; outputPath?: string }>
    render: (input: {
      mediaName: string | null
      sourcePath: string
      segments: Array<{ start: number; end: number }>
    }) => Promise<{ success: boolean; cancelled?: boolean; outputPath?: string; bytes?: number }>
    creativePlan: (input: Record<string, unknown>) => Promise<{
      version: number
      title: string
      hook: string
      narration: string
      musicBrief: string
      subtitleStyle: 'clean' | 'impact' | 'documentary'
      deepAnalysis: { narrative: string; visual: string; editing: string; audio: string; hook: string; weaknesses: string[] }
      modality: 'text-evidence' | 'vision+text-evidence'
      provider?: string
      model?: string
      visualEvidenceCount?: number
      visualFallbackReason?: string
      riskNotes: string[]
      shots: Array<{
        id: string
        kind: 'source' | 'generated'
        segmentId: string
        duration: number
        title: string
        prompt: string
        narration: string
        caption: string
        assetPath: string
        status: string
      }>
    }>
    generateImage: (input: { id: string; prompt: string; model?: string; size?: string }) => Promise<{ success: boolean; outputPath: string; bytes: number }>
    generateVideo: (input: { id?: string; prompt: string; model?: string; duration?: number; fps?: number; size?: string; imageBase64?: string }) => Promise<{ success: boolean; outputPath?: string; bytes?: number; videoId?: string; numFrames?: number; error?: string }>
    recutShort: (input: { reportText?: string; mediaName: string; count?: number; seconds?: number; requestId?: string }) => Promise<{ success: boolean; outputPath?: string; shots?: string[]; clips?: number; error?: string }>
    onRecutProgress: (cb: (event: { requestId?: string; stage: string }) => void) => () => void
    generateVoice: (input: { text: string; engine: 'system' | 'cloud'; model?: string; voice?: string; rate?: number }) => Promise<{ success: boolean; outputPath: string; bytes: number; engine: string }>
    selectAsset: (kind: 'image' | 'audio') => Promise<string | null>
    renderCreative: (input: Record<string, unknown>) => Promise<{ success: boolean; cancelled?: boolean; outputPath?: string; bytes?: number; shots?: number; duration?: number }>
    cancelRender: () => Promise<boolean>
  }
  receiver?: {
    start: () => Promise<boolean>
    stop: () => Promise<boolean>
    onPlay: (cb: (url: string) => void) => () => void
  }
  menu?: {
    onAction: (cb: (action: string) => void) => () => void
    onOpenFile: (cb: (filePath: string) => void) => () => void
    confirmOpenFile?: (filePath: string) => void
    onOpenFolder: (cb: (dirPath: string) => void) => () => void
    onAgent: (cb: () => void) => () => void
  }
  contextMenu?: {
    show: (state: { hasMedia: boolean; isPlaying: boolean; subtitleVisible: boolean; pictureMode: string; playbackRate: number; liveTranslate?: boolean }) => void
  }
  windowControls?: {
    setPreset: (preset: 'original' | 'half' | 'fill' | 'fullscreen', mediaSize?: { width: number; height: number }) => Promise<boolean>
    setPlaybackChromeVisible: (visible: boolean) => Promise<boolean>
    isPlaybackChromeVisible: () => Promise<boolean>
    onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  }
  screenshot?: {
    save: (dataUrl: string, suggestedName: string) => Promise<boolean>
  }
  models?: {
    providers: () => Promise<Array<{
      id: string; name: string; region: string; protocol: 'openai' | 'anthropic' | 'gemini';
      baseUrl: string; models: string[]; requiresKey: boolean; modelHint?: string; warning?: string;
      computerUseProtocol?: 'fara-native';
      bundled?: boolean;
      roles: Array<'chat' | 'computerUse'>;
      capabilities: { streaming?: boolean; tools?: boolean; vision?: boolean; computerUse?: boolean }
    }>>
    config: (role?: 'chat' | 'computerUse') => Promise<{ schemaVersion: number; role: 'chat' | 'computerUse'; providerId: string; providerName: string; model: string; baseUrl: string; hasApiKey: boolean; keyStorage: string; capabilities: Record<string, boolean | number> }>
    save: (config: { role?: 'chat' | 'computerUse'; providerId: string; model: string; baseUrl: string; apiKey?: string; clearApiKey?: boolean }) => Promise<{ providerId: string; model: string; baseUrl: string; hasApiKey: boolean }>
    list: (config: { role?: 'chat' | 'computerUse'; providerId: string; model: string; baseUrl: string; apiKey?: string; useSavedKey?: boolean }) => Promise<{ success: boolean; models: string[]; error?: string }>
    test: (config: { role?: 'chat' | 'computerUse'; providerId: string; model: string; baseUrl: string; apiKey?: string; useSavedKey?: boolean }) => Promise<{ success: boolean; message: string; planDetected?: boolean; upgrade?: { providerId: string; baseUrl: string; model: string; models: string[] } }>
    discoverLocal: (role?: 'chat' | 'computerUse') => Promise<Array<{ id: string; role: 'chat' | 'computerUse'; name: string; providerId: string; baseUrl: string; status: 'ready'; models: string[] }>>
    autoDetect: (input: { apiKey: string }) => Promise<{ success: boolean; matches?: Array<{ providerId: string; providerName: string; models: string[]; latencyMs: number }>; error?: string }>
    cliStatus: () => Promise<{ codex: { installed: boolean; loggedIn: boolean; note: string }; claude: { installed: boolean; loggedIn: boolean; note: string } }>
    refreshCatalog: () => Promise<{ updated: number; providers?: string[]; error?: string }>
    bundledStatus: () => Promise<BundledModelStatus>
    startBundled: () => Promise<BundledModelStatus>
    stopBundled: () => Promise<BundledModelStatus>
    quickSwitch: (input: { role?: 'chat' | 'computerUse'; target: 'cloud' | 'bundled' }) => Promise<{ switched: boolean; needDownload?: boolean; reason?: string; config?: { providerId: string; providerName: string; model: string; baseUrl: string; hasApiKey: boolean } }>
  }
  mediaBatch?: {
    run: (input: { tokens: string[]; kind?: 'compress' | 'transcribe'; targetMb?: number; requestId?: string }) => Promise<{ success: boolean; kind?: string; results?: Array<{ token: string; success: boolean; outputPath?: string; error?: string }> }>
    onProgress: (cb: (event: { requestId?: string; done: number; total: number; name: string }) => void) => () => void
  }
  mediaTools?: {
    compress: (input: { sourcePath: string; targetMb?: number; mode?: 'remux' | 'compress' }) => Promise<{ success: boolean; outputPath?: string; beforeBytes?: number; afterBytes?: number; mode?: string; error?: string }>
  }
  guide?: {
    annotate: (question: string) => Promise<{ success: boolean; steps?: Array<{ text: string; mark: unknown }>; annotated?: boolean; error?: string }>
    askFrame: (input: { question: string; dataUrl?: string }) => Promise<{ success: boolean; answer?: string; error?: string }>
    dismiss: () => Promise<boolean>
  }
  computerUse?: {
    suggest: (task: string, requestId: string) => Promise<{
      requestId: string; mode: 'observe-only'; warning: string;
      observation: { frameId: string; width: number; height: number; dataUrl: string; createdAt: number };
      recommendation: { frameId: string; reason: string; action: { type: string; x?: number; y?: number; button?: string; text?: string; deltaY?: number; key?: string } }
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStatus: (cb: (event: { requestId: string; status: string }) => void) => () => void
  }
  subtitle?: {
    search: (name: string, apiKey?: string) => Promise<{ success: boolean; data?: Array<{ id: string; fileId: number; fileName: string; language: string; release: string }>; error?: string }>
    download: (fileId: number, apiKey?: string) => Promise<{ success: boolean; path?: string; fileName?: string; error?: string }>
  }
  xlsx?: {
    preview: (filePath: string) => Promise<{ success: boolean; html?: string; error?: string }>
  }
  docx?: {
    preview: (filePath: string) => Promise<{ success: boolean; html?: string; error?: string }>
  }
  dialog?: {
    openFile: () => Promise<string | null>
    openFolder: () => Promise<string | null>
  }
  system?: {
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>
    showInFolder: (filePath: string) => Promise<boolean>
  }
  print?: {
    file: (filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
    text: (filePath: string) => Promise<{ success: boolean; action?: string; error?: string }>
    html: (html: string) => Promise<{ success: boolean; action?: string; error?: string }>
  }
  files?: {
    scan: (dir?: string) => Promise<Array<{ name: string; path: string; ext: string; size: number }>>
    defaultDir: () => Promise<string>
    readText: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
    readDataUrl: (filePath: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>
  }
  ai?: {
    chat: (messages: Array<{ role: string; content: string }>, context?: {
      name: string | null
      path: string | null
      currentTime: number
      duration: number
      volume: number
      lastAudibleVolume: number
      playbackRate: number
      pictureMode: 'original' | 'fit' | 'fill' | 'stretch'
      subtitleVisible: boolean
      isFullscreen: boolean
    }, requestId?: string) => Promise<{
      requestId: string
      text: string
      cancelled?: boolean
      toolResults: Array<{
        tool: string
        args: Record<string, unknown>
        result: unknown
      }>
    }>
    cancel: (requestId: string) => Promise<boolean>
    onStream: (cb: (event: { requestId: string; status?: string; delta?: string }) => void) => () => void
  }
}

interface MpvEvent {
  event: string
  data: { name?: string; data?: unknown }
}

interface Window {
  aiPlayer?: AiPlayerAPI
}

interface BundledModelStatus {
  state: 'stopped' | 'verifying' | 'loading' | 'ready' | 'error'
  running: boolean
  assetsPresent: boolean
  assetsLocation?: 'bundled' | 'userData' | null
  modelName: string
  modelSizeMb: number
  providerId: string
  baseUrl: string
  model: string
  idleReleaseMinutes: number
  lastNotice: string
  lastError: string
  hardware: {
    totalMemoryGb: number
    availableMemoryGb: number
    logicalCpus: number
    eligible: boolean
    tier: 'unsupported' | 'limited' | 'recommended'
    reason: string
    contextSize: number
    threads: number
    batchThreads: number
  }
}


interface LocalAiDownloadProgress {
  stage: 'download' | 'verify' | 'extract' | 'done'
  currentFile: string
  fileIndex: number
  fileCount: number
  receivedBytes: number
  totalBytes: number
}

interface LocalAiComponentStatus extends BundledModelStatus {
  download: Partial<LocalAiDownloadProgress> & {
    active: boolean
    installed: boolean
    presentBytes: number
    totalBytes: number
  }
  pack: { tag: string; totalBytes: number; assetCount: number }
}
