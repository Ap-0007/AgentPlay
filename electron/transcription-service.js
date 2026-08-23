const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseWhisperWordJson } = require('./word-timing-service')

// 离线录音转写：whisper.cpp（whisper-cli）+ ggml-tiny 模型。
// whisper-cli 原生可读 mp3/ogg/flac/wav；其它音频与视频先经 mpv 抽音为 wav。
const DIRECT_AUDIO_EXTS = ['.mp3', '.ogg', '.flac', '.wav']
const EXTRACT_AUDIO_EXTS = ['.m4a', '.aac', '.wma', '.mp4', '.mkv', '.mov', '.webm', '.ts', '.m4v', '.wmv', '.flv', '.3gp', '.mpg', '.mpeg']
const TIMEOUT_MS = 15 * 60 * 1000

// whisper tiny 高频繁体字 → 简体（zh 输出仍有零星繁体，如「創意」「殘」；只映射严格繁体字，不误伤简体）
const TRADITIONAL_TO_SIMPLIFIED = {
  創: '创', 殘: '残', 闆: '板', 總: '总', 們: '们', 軟: '软', 後: '后', 這: '这', 業: '业', 時: '时',
  間: '间', 麼: '么', 為: '为', 過: '过', 說: '说', 話: '话', 點: '点', 擊: '击', 視: '视', 頻: '频',
  內: '内', 應: '应', 該: '该', 現: '现', 實: '实', 發: '发', 學: '学', 習: '习', 問: '问', 題: '题',
  無: '无', 關: '关', 係: '系', 統: '统', 經: '经', 營: '营', 環: '环', 節: '节', 將: '将', 產: '产',
  動: '动', 見: '见', 長: '长', 開: '开', 場: '场', 聲: '声', 聽: '听', 讓: '让', 認: '认', 識: '识',
  選: '选', 擇: '择', 換: '换', 號: '号', 團: '团', 隊: '队', 設: '设', 計: '计', 劃: '划', 準: '准',
  項: '项', 頭: '头', 體: '体', 樣: '样', 個: '个', 來: '来', 對: '对', 與: '与', 還: '还', 進: '进',
  鏈: '链', 條: '条', 記: '记', 錄: '录', 標: '标', 質: '质', 數: '数', 據: '据', 圖: '图', 檔: '档',
  鍵: '键', 碼: '码', 網: '网', 頁: '页', 語: '语', 譯: '译', 寫: '写', 讀: '读', 聯: '联', 戶: '户',
  氣: '气', 錢: '钱', 夠: '够', 試: '试', 驗: '验', 證: '证', 確: '确', 訊: '讯', 樂: '乐', 獲: '获', 測: '测'
}
const TRADITIONAL_RE = new RegExp('[' + Object.keys(TRADITIONAL_TO_SIMPLIFIED).join('') + ']', 'g')

function toSimplified(text) {
  return String(text || '').replace(TRADITIONAL_RE, (char) => TRADITIONAL_TO_SIMPLIFIED[char] || char)
}

class TranscriptionService {
  constructor({ whisperRoot, mpvPath, spawnImpl, timeoutMs } = {}) {
    this.whisperRoot = whisperRoot ? path.resolve(whisperRoot) : whisperRoot
    this.mpvPath = mpvPath
    this.spawnImpl = spawnImpl || spawn
    this.timeoutMs = timeoutMs || TIMEOUT_MS
    this.activeChildren = new Set()
  }

  // 退出时统一收尸：before-quit 调用，避免 whisper-cli/抽音 mpv 变孤儿
  stopAll() {
    for (const child of this.activeChildren) {
      try { child.kill() } catch { /* 已退出 */ }
    }
    this.activeChildren.clear()
  }

  availability() {
    const engineOk = fs.existsSync(path.join(this.whisperRoot, 'engine', 'whisper-cli.exe'))
    const modelOk = fs.existsSync(path.join(this.whisperRoot, 'ggml-tiny.bin'))
    const smallAvailable = fs.existsSync(path.join(this.whisperRoot, 'ggml-small.bin'))
    return {
      available: engineOk && modelOk,
      engineOk,
      modelOk,
      smallAvailable,
      reason: !engineOk ? '转写引擎未安装（whisper 组件包）' : !modelOk ? '转写模型未安装（ggml-tiny）' : ''
    }
  }

  exec(file, args, timeoutMs, options = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(file, args, { windowsHide: true, ...options })
      this.activeChildren.add(child)
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.activeChildren.delete(child)
        fn(value)
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('转写超时'))
      }, timeoutMs || this.timeoutMs)
      // 取消链：外层 abort 时立即杀子进程
      const signal = options.signal
      const onAbort = () => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('已取消'))
      }
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.on('error', (error) => finish(reject, error))
      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort)
        if (code === 0) finish(resolve, stdout)
        else finish(reject, new Error(stderr.trim().split('\n').pop() || `转写进程退出 (${code})`))
      })
    })
  }

  async transcribe({ sourcePath, lang = 'zh', timestamps = false, onProgress, signal, timeoutMs, noSpeechThold, logprobThold, model }) {
    const status = this.availability()
    if (!status.available) throw new Error(`${status.reason}，请先在模型接入中心下载转写组件`)
    const ext = path.extname(sourcePath).toLowerCase()
    if (![...DIRECT_AUDIO_EXTS, ...EXTRACT_AUDIO_EXTS].includes(ext)) {
      throw new Error(`不支持转写的格式：${ext || '未知'}（支持音频 mp3/wav/m4a/flac/ogg/aac/wma 与常见视频）`)
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-whisper-'))
    try {
      // whisper-cli 的 C 运行时会把 argv 里的中文路径转成乱码并直接崩溃（0xC0000409）。
      // 因此：模型用相对路径（cwd=whisperRoot），输入一律暂存到 ASCII 安全名下。
      let input = sourcePath
      if (EXTRACT_AUDIO_EXTS.includes(ext)) {
        onProgress?.('正在提取音轨')
        const wavPath = path.join(tempDir, 'audio.wav')
        await this.exec(this.mpvPath, ['--no-video', '--ao=pcm', `--ao-pcm-file=${wavPath}`, sourcePath], 5 * 60 * 1000, { signal })
        input = wavPath
      } else if (/[^\x00-\x7F]/.test(input) || !path.isAbsolute(input)) {
        const staged = path.join(tempDir, `audio${ext}`)
        fs.copyFileSync(input, staged)
        input = staged
      }
      onProgress?.('正在离线转写（CPU 需要数倍于音频时长，可取消）')
      // 模型可选（默认 tiny；精修用 ggml-small.bin），白名单文件名防路径穿越
      const modelFile = /^ggml-[\w.-]+\.bin$/.test(String(model || '')) ? String(model) : 'ggml-tiny.bin'
      const args = ['-m', modelFile, '-l', lang, '-f', input, '-nt', '-np']
      // 幻觉抑制（音乐/静默段防乱编）：仅在调用方显式给阈值时启用，默认行为不变
      if (Number(noSpeechThold) > 0) args.push('--no-speech-thold', String(noSpeechThold))
      if (Number.isFinite(logprobThold)) args.push('--logprob-thold', String(logprobThold))
      if (timestamps) args.push('-osrt')
      const output = await this.exec(path.join(this.whisperRoot, 'engine', 'whisper-cli.exe'), args, timeoutMs || this.timeoutMs, { cwd: this.whisperRoot, signal })
      let text = output.trim()
      if (timestamps) {
        const srtPath = `${input}.srt`
        if (fs.existsSync(srtPath)) text = fs.readFileSync(srtPath, 'utf8').trim()
      }
      if (!text) throw new Error('没有识别到语音内容（可能是纯音乐或音量过低）')
      if (lang === 'zh') text = toSimplified(text)
      return { text, timestamps }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }

  async transcribeWords({ sourcePath, lang = 'auto', signal, timeoutMs, model } = {}) {
    const status = this.availability()
    if (!status.available) throw new Error(`${status.reason}，请先在模型接入中心下载转写组件`)
    const ext = path.extname(sourcePath).toLowerCase()
    if (![...DIRECT_AUDIO_EXTS, ...EXTRACT_AUDIO_EXTS].includes(ext)) throw new Error(`不支持逐词转写的格式：${ext || '未知'}`)
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-whisper-words-'))
    try {
      let input = sourcePath
      if (EXTRACT_AUDIO_EXTS.includes(ext)) {
        const wavPath = path.join(tempDir, 'audio.wav')
        await this.exec(this.mpvPath, ['--no-video', '--ao=pcm', `--ao-pcm-file=${wavPath}`, sourcePath], 5 * 60 * 1000, { signal })
        input = wavPath
      } else if (/[^\x00-\x7F]/.test(input) || !path.isAbsolute(input)) {
        const staged = path.join(tempDir, `audio${ext}`)
        fs.copyFileSync(input, staged)
        input = staged
      }
      const modelFile = /^ggml-[\w.-]+\.bin$/.test(String(model || '')) ? String(model) : (status.smallAvailable ? 'ggml-small.bin' : 'ggml-tiny.bin')
      const dtwPreset = modelFile.replace(/^ggml-/, '').replace(/\.bin$/, '').replace(/-q\d.*$/i, '')
      const outputBase = path.join(tempDir, 'words')
      const args = ['-m', modelFile, '-l', lang, '-f', input, '-nt', '-np', '-sow', '-ojf', '-dtw', dtwPreset, '-nfa', '-of', outputBase]
      await this.exec(path.join(this.whisperRoot, 'engine', 'whisper-cli.exe'), args, timeoutMs || this.timeoutMs, { cwd: this.whisperRoot, signal })
      const jsonPath = `${outputBase}.json`
      if (!fs.existsSync(jsonPath)) throw new Error('逐词转写没有生成JSON证据')
      const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      const words = parseWhisperWordJson(payload)
      if (!words.length) throw new Error('逐词转写没有生成可用DTW时间段')
      if (lang === 'zh') words.forEach((word) => { word.text = toSimplified(word.text) })
      return { words, model: modelFile, language: payload?.result?.language || lang, timingMethod: 'whisper.cpp-dtw-v1' }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

module.exports = { TranscriptionService, DIRECT_AUDIO_EXTS, EXTRACT_AUDIO_EXTS, toSimplified }
