const fs = require('fs')
const path = require('path')

const DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1'
const DEFAULT_MODEL = 'baidu/Unlimited-OCR'
const CONFIG_SCHEMA_VERSION = 1

function normalizeEndpoint(value = DEFAULT_BASE_URL) {
  const raw = String(value || DEFAULT_BASE_URL).trim()
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('高级文档 OCR 地址无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('高级文档 OCR 只支持 HTTP 或 HTTPS 地址')
  if (url.username || url.password) throw new Error('高级文档 OCR 地址不能包含用户名或密码')
  if (url.search) throw new Error('高级文档 OCR 地址不能包含查询参数')
  if (url.hash) throw new Error('高级文档 OCR 地址不能包含片段')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function isLoopbackEndpoint(value) {
  const hostname = new URL(normalizeEndpoint(value)).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function cleanUnlimitedOcrOutput(value) {
  const pages = String(value || '')
    .replace(/<\|ref\|>[\s\S]*?<\|\/ref\|>/g, '')
    .replace(/<\|det\|>[^<\n]*(?:\[[^\]]*\])?\s*<\|\/det\|>/g, '')
    .split(/\s*<page>\s*/i)
    .map((page) => page.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean)
  return pages.map((page, index) => `## 第 ${index + 1} 页\n${page}`).join('\n\n')
}

function validateParsedText(text, expectedPages) {
  const normalized = String(text || '').trim()
  if (normalized.length < 2) throw new Error('高级文档 OCR 没有返回有效内容')
  const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const counts = new Map()
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1)
  const maxRepeats = Math.max(0, ...counts.values())
  if (lines.length >= 10 && maxRepeats / lines.length >= 0.6) throw new Error('高级文档 OCR 输出重复过多，未通过质量检查')
  const pageHeaders = (normalized.match(/^## 第 \d+ 页$/gm) || []).length
  if (expectedPages > 1 && pageHeaders < Math.min(expectedPages, 2)) throw new Error('高级文档 OCR 返回的分页不完整')
  return normalized
}

class UnlimitedOcrConfigStore {
  constructor(userDataDir, safeStorage) {
    this.filePath = path.join(userDataDir, 'unlimited-ocr.json')
    this.safeStorage = safeStorage
  }

  readDocument() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        enabled: raw.enabled === true,
        baseUrl: normalizeEndpoint(raw.baseUrl),
        model: String(raw.model || DEFAULT_MODEL).trim().slice(0, 200) || DEFAULT_MODEL,
        encryptedApiKey: String(raw.encryptedApiKey || '')
      }
    } catch {
      return {
        schemaVersion: CONFIG_SCHEMA_VERSION,
        enabled: false,
        baseUrl: DEFAULT_BASE_URL,
        model: DEFAULT_MODEL,
        encryptedApiKey: ''
      }
    }
  }

  writeDocument(document) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 })
    try {
      fs.renameSync(temporary, this.filePath)
    } catch {
      fs.copyFileSync(temporary, this.filePath)
      fs.unlinkSync(temporary)
    }
  }

  decrypt(value) {
    if (!value) return ''
    try {
      return this.safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return ''
    }
  }

  resolved() {
    const document = this.readDocument()
    return { ...document, apiKey: this.decrypt(document.encryptedApiKey), local: isLoopbackEndpoint(document.baseUrl) }
  }

  publicConfig() {
    const document = this.readDocument()
    return {
      enabled: document.enabled,
      baseUrl: document.baseUrl,
      model: document.model,
      local: isLoopbackEndpoint(document.baseUrl),
      hasApiKey: Boolean(document.encryptedApiKey && this.decrypt(document.encryptedApiKey))
    }
  }

  save(input = {}, { remoteApproved = false } = {}) {
    const previous = this.readDocument()
    const baseUrl = normalizeEndpoint(input.baseUrl === undefined ? previous.baseUrl : input.baseUrl)
    const local = isLoopbackEndpoint(baseUrl)
    if (!local && remoteApproved !== true) throw new Error('远端高级文档 OCR 需要本次明确确认')
    if (!local && new URL(baseUrl).protocol !== 'https:') throw new Error('远端高级文档 OCR 必须使用 HTTPS')
    const model = String(input.model === undefined ? previous.model : input.model).trim().slice(0, 200)
    if (!model) throw new Error('高级文档 OCR 模型名不能为空')
    let encryptedApiKey = previous.encryptedApiKey
    if (input.clearApiKey === true) encryptedApiKey = ''
    else if (String(input.apiKey || '').trim()) {
      const apiKey = String(input.apiKey).trim()
      if (apiKey.length > 8192) throw new Error('高级文档 OCR 凭证过长，未保存')
      if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('当前系统加密服务不可用，凭证未保存')
      encryptedApiKey = this.safeStorage.encryptString(apiKey).toString('base64')
    }
    this.writeDocument({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      enabled: input.enabled === undefined ? previous.enabled : input.enabled === true,
      baseUrl,
      model,
      encryptedApiKey
    })
    return this.publicConfig()
  }
}

class UnlimitedOcrService {
  constructor({ configStore, fetchImpl = globalThis.fetch, timeoutMs = 8000, rasterizePdf = null, fallbackRecognizePdf = null } = {}) {
    this.configStore = configStore
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.rasterizePdf = rasterizePdf
    this.fallbackRecognizePdf = fallbackRecognizePdf
  }

  async requestJson(url, options = {}) {
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) forwardAbort()
    else options.signal?.addEventListener?.('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status || '请求失败'}`)
      return response.json()
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', forwardAbort)
    }
  }

  async status({ probe = false } = {}) {
    const config = this.configStore.publicConfig()
    if (!config.enabled) return { ...config, ready: false, reason: '高级文档 OCR 未启用' }
    if (!probe) return { ...config, ready: false, reason: '尚未验证连接' }
    try {
      const resolved = this.configStore.resolved()
      const data = await this.requestJson(`${resolved.baseUrl}/models`, {
        headers: resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {}
      })
      const models = Array.isArray(data?.data) ? data.data.map((item) => String(item?.id || '')).filter(Boolean) : []
      if (models.length && !models.includes(resolved.model)) {
        return { ...config, ready: false, reason: `服务没有返回已配置模型 ${resolved.model}`, models }
      }
      return { ...config, ready: true, reason: '', models }
    } catch (error) {
      return { ...config, ready: false, reason: error instanceof Error ? error.message : String(error), models: [] }
    }
  }

  async recognizeImages(images, { signal } = {}) {
    const resolved = this.configStore.resolved()
    if (!resolved.enabled) throw new Error('高级文档 OCR 未启用')
    if (!Array.isArray(images) || images.length === 0) throw new Error('没有可供高级文档 OCR 处理的页面')
    if (images.length > 50) throw new Error('高级文档 OCR 单次最多处理 50 页')
    const multiPage = images.length > 1
    const content = [
      { type: 'text', text: multiPage ? '<image>Multi page parsing.' : '<image>document parsing.' },
      ...images.map((image) => ({
        type: 'image_url',
        image_url: { url: `data:${String(image.mimeType || 'image/png')};base64,${Buffer.from(image.data).toString('base64')}` }
      }))
    ]
    const payload = {
      model: resolved.model,
      messages: [{ role: 'user', content }],
      max_tokens: 32768,
      temperature: 0,
      skip_special_tokens: false,
      vllm_xargs: { ngram_size: 35, window_size: multiPage ? 1024 : 128 }
    }
    const headers = { 'Content-Type': 'application/json' }
    if (resolved.apiKey) headers.Authorization = `Bearer ${resolved.apiKey}`
    const response = await this.requestJson(`${resolved.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal
    })
    const raw = String(response?.choices?.[0]?.message?.content || '')
    const text = validateParsedText(cleanUnlimitedOcrOutput(raw), images.length)
    return { ok: true, text, pageCount: images.length, model: resolved.model, local: resolved.local }
  }

  async recognizePdf(filePath, { signal, cloudApproved = false } = {}) {
    const config = this.configStore.publicConfig()
    if (!config.enabled) {
      if (!this.fallbackRecognizePdf) throw new Error('高级文档 OCR 未启用')
      return { engine: 'fallback', text: await this.fallbackRecognizePdf(filePath, { signal }), warning: '高级文档 OCR 未启用' }
    }
    if (!config.local && cloudApproved !== true) {
      const warning = '远端高级文档 OCR 需要当前文档任务单独授权'
      if (!this.fallbackRecognizePdf) throw new Error(warning)
      return { engine: 'fallback', text: await this.fallbackRecognizePdf(filePath, { signal }), warning }
    }
    try {
      const status = await this.status({ probe: true })
      if (!status.ready) throw new Error(status.reason || '高级文档 OCR 服务未就绪')
      if (typeof this.rasterizePdf !== 'function') throw new Error('PDF 页面转换器未配置')
      const pages = await this.rasterizePdf(filePath, { signal })
      const images = pages.map((page) => ({ data: page, mimeType: 'image/png' }))
      const parsed = await this.recognizeImages(images, { signal })
      return { engine: 'unlimited-ocr', text: parsed.text, pageCount: parsed.pageCount, model: parsed.model, local: parsed.local }
    } catch (error) {
      if (!this.fallbackRecognizePdf) throw error
      const text = await this.fallbackRecognizePdf(filePath, { signal })
      return { engine: 'fallback', text, warning: error instanceof Error ? error.message : String(error) }
    }
  }
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  normalizeEndpoint,
  isLoopbackEndpoint,
  cleanUnlimitedOcrOutput,
  validateParsedText,
  UnlimitedOcrConfigStore,
  UnlimitedOcrService
}
