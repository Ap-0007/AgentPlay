const DEFAULT_CONTEXT_WINDOWS = Object.freeze({
  'bundled-lite': 2048,
  'codex-chatgpt': 200000,
  'claude-code': 200000,
  anthropic: 200000,
  openai: 128000,
  'volcengine-coding': 128000,
  agnes: 524288,
  moonshot: 131072,
  deepseek: 1000000,
  zhipu: 128000,
  google: 1000000
})

function contextWindowForConfig(config = {}) {
  const explicit = Number(config.contextWindow || config.contextSize)
  if (Number.isFinite(explicit) && explicit >= 1024) return Math.floor(explicit)
  return DEFAULT_CONTEXT_WINDOWS[config.providerId] || 32768
}

function maxOutputTokensForConfig(config = {}) {
  if (config.providerId === 'bundled-lite') return 512
  return 4096
}

function configured(config = {}) {
  const requiresKey = config.requiresKey !== false
  return Boolean(config.model && (config.protocol === 'cli' || (config.baseUrl && (!requiresKey || config.apiKey))))
}

function cloudFallbackFromStore(store, role = 'chat') {
  const record = store?.readDocument?.().stash?.[role]
  if (!record) return null
  const provider = require('./model-providers').normalizeConfig({
    ...record,
    role,
    apiKey: store.decrypt(record.encryptedApiKey)
  }, role)
  return configured(provider) ? provider : null
}

function chooseDocumentModel({ current, fallback, preflight, cloudApproved }) {
  const currentConfig = { ...current, contextWindow: contextWindowForConfig(current), ready: current?.ready ?? configured(current) }
  const fallbackConfig = fallback
    ? { ...fallback, contextWindow: contextWindowForConfig(fallback), ready: fallback.ready ?? configured(fallback) }
    : null
  const shouldFallback = Boolean(preflight?.exceedsSingleCall && currentConfig.local && fallbackConfig?.ready && !fallbackConfig.local)
  if (shouldFallback && cloudApproved) return { config: fallbackConfig, mode: 'cloud-fallback', requiresCloudApproval: false }
  return {
    config: currentConfig,
    mode: preflight?.exceedsSingleCall ? 'local-chunked' : 'single',
    requiresCloudApproval: Boolean(shouldFallback && !cloudApproved)
  }
}

module.exports = {
  DEFAULT_CONTEXT_WINDOWS,
  chooseDocumentModel,
  cloudFallbackFromStore,
  contextWindowForConfig,
  maxOutputTokensForConfig
}
