// 轻量语言探测：mpv 抽前 N 秒音频 → whisper(auto) 小样转写 → 按字符分布判定 zh/en/其他。
// 判定只对"要不要弹出翻译提示"负责，不做精确语言学分类；结果按 路径+修改时间 缓存。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const SAMPLE_SECONDS = 12

function classifyScript(text) {
  const value = String(text || '')
  const cjk = (value.match(/[一-鿿]/g) || []).length
  const latin = (value.match(/[A-Za-z]/g) || []).length
  if (cjk >= 8 && cjk >= latin / 3) return 'zh'
  if (latin >= 20 && latin >= cjk * 3) return 'en'
  return 'other'
}

class LanguageDetectService {
  constructor({ whisperRoot, mpvPath, spawnImpl, sampleSeconds } = {}) {
    this.whisperRoot = whisperRoot ? path.resolve(whisperRoot) : whisperRoot
    this.mpvPath = mpvPath
    this.spawnImpl = spawnImpl || spawn
    this.sampleSeconds = sampleSeconds || SAMPLE_SECONDS
    this.cache = new Map()
  }

  availability() {
    const engineOk = this.whisperRoot && fs.existsSync(path.join(this.whisperRoot, 'engine', 'whisper-cli.exe'))
    const modelOk = this.whisperRoot && fs.existsSync(path.join(this.whisperRoot, 'ggml-tiny.bin'))
    return { available: Boolean(engineOk && modelOk), engineOk, modelOk }
  }

  exec(file, args, timeoutMs, options = {}) {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(file, args, { windowsHide: true, ...options })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch { /* 已退出 */ }
        finish(reject, new Error('语言探测超时'))
      }, timeoutMs)
      const finish = (fn, value) => {
        if (finish.done) return
        finish.done = true
        clearTimeout(timer)
        fn(value)
      }
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.on('error', (error) => finish(reject, error))
      child.on('close', (code) => {
        if (code === 0) finish(resolve, stdout)
        else finish(reject, new Error(stderr.trim().split('\n').pop() || `探测进程退出 (${code})`))
      })
    })
  }

  async detect(sourcePath) {
    if (!this.availability().available) return { lang: 'unknown', reason: '转写组件未安装' }
    const stat = fs.statSync(sourcePath)
    const key = `${path.resolve(sourcePath)}:${stat.mtimeMs}`
    if (this.cache.has(key)) return this.cache.get(key)
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-lang-'))
    try {
      const wavPath = path.join(tempDir, 'sample.wav')
      await this.exec(this.mpvPath, ['--no-video', '--ao=pcm', `--ao-pcm-file=${wavPath}`, `--end=${this.sampleSeconds}`, sourcePath], 60000)
      const text = await this.exec(path.join(this.whisperRoot, 'engine', 'whisper-cli.exe'), ['-m', 'ggml-tiny.bin', '-l', 'auto', '-f', wavPath, '-nt', '-np'], 180000, { cwd: this.whisperRoot })
      const result = { lang: classifyScript(text), sample: text.trim().slice(0, 120) }
      this.cache.set(key, result)
      return result
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

module.exports = { LanguageDetectService, classifyScript, SAMPLE_SECONDS }
