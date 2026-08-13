const fs = require('fs')
const path = require('path')
const { PROVIDERS, normalizeConfig, validateProviderUrl } = require('./model-providers')

const CONFIG_SCHEMA_VERSION = 3
const SUPPORTED_ROLES = Object.freeze(['chat', 'computerUse'])
const MAX_PROFILES_PER_ROLE = 12
const NON_CLOUD_PROVIDER_IDS = ['bundled-lite', 'codex-chatgpt', 'claude-code', 'ollama', 'lmstudio', 'vllm', 'llamacpp', 'colibri', 'fara-local']

function normalizeRole(role) {
  return SUPPORTED_ROLES.includes(role) ? role : 'chat'
}

function uniqueFirst(records, keyOf, limit = MAX_PROFILES_PER_ROLE) {
  const seen = new Set()
  const result = []
  for (const record of records) {
    const key = keyOf(record)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(record)
    if (result.length >= limit) break
  }
  return result
}

class ModelConfigStore {
  constructor(userDataDir, safeStorage) {
    this.filePath = path.join(userDataDir, 'model-config.json')
    this.safeStorage = safeStorage
  }

  readRaw() {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) } catch { return {} }
  }

  readDocument() {
    const raw = this.readRaw()
    if (raw.schemaVersion === CONFIG_SCHEMA_VERSION && raw.roles && typeof raw.roles === 'object') {
      return {
        ...raw,
        roles: { ...raw.roles },
        profiles: raw.profiles && typeof raw.profiles === 'object' ? { ...raw.profiles } : {}
      }
    }
    if (raw.schemaVersion === 2 && raw.roles && typeof raw.roles === 'object') {
      const profiles = {}
      for (const role of SUPPORTED_ROLES) profiles[role] = [raw.roles[role], raw.stash?.[role]].filter(Boolean)
      return { ...raw, schemaVersion: CONFIG_SCHEMA_VERSION, roles: { ...raw.roles }, profiles, migratedAt: new Date().toISOString() }
    }
    const legacy = raw.providerId || raw.model || raw.baseUrl || raw.encryptedApiKey
      ? { providerId: raw.providerId, model: raw.model, baseUrl: raw.baseUrl, encryptedApiKey: raw.encryptedApiKey || '', updatedAt: raw.updatedAt }
      : null
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      roles: legacy ? { chat: legacy } : {},
      profiles: legacy ? { chat: [legacy] } : {},
      migratedAt: legacy ? new Date().toISOString() : undefined,
      updatedAt: raw.updatedAt
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
    try { return this.safeStorage.decryptString(Buffer.from(value, 'base64')) } catch { return '' }
  }

  recordKey(record = {}, role = 'chat') {
    const config = normalizeConfig(record, normalizeRole(role))
    return [config.providerId || '', config.model || '', config.thinkingMode || 'default', config.baseUrl || ''].join('::')
  }

  candidateRecords(role = 'chat', document = this.readDocument()) {
    const selectedRole = normalizeRole(role)
    const records = [
      document.roles?.[selectedRole],
      ...(Array.isArray(document.profiles?.[selectedRole]) ? document.profiles[selectedRole] : []),
      document.stash?.[selectedRole]
    ].filter((record) => record && PROVIDERS.some((provider) => provider.id === record.providerId && provider.roles.includes(selectedRole)))
    return uniqueFirst(records, (record) => this.recordKey(record, selectedRole))
  }

  resolved(role = 'chat') {
    const selectedRole = normalizeRole(role)
    const record = this.readDocument().roles[selectedRole] || {}
    if (record.providerId && !PROVIDERS.some((provider) => provider.id === record.providerId && provider.roles.includes(selectedRole))) {
      return { ...normalizeConfig({ providerId: 'bundled-lite' }, selectedRole), configured: false, migrationWarning: '原模型服务已下架或无法识别，请重新接入' }
    }
    return normalizeConfig({ ...record, role: selectedRole, apiKey: this.decrypt(record.encryptedApiKey) }, selectedRole)
  }

  resolvedCandidates(role = 'chat') {
    const selectedRole = normalizeRole(role)
    return this.candidateRecords(selectedRole).map((record) => normalizeConfig({
      ...record,
      role: selectedRole,
      apiKey: this.decrypt(record.encryptedApiKey)
    }, selectedRole)).filter((config) => {
      if (config.protocol === 'cli' || config.localOnly || config.bundled) return true
      return !config.requiresKey || Boolean(config.apiKey)
    })
  }

  publicRecord(record = {}, role = 'chat') {
    const selectedRole = normalizeRole(role)
    const config = normalizeConfig(record, selectedRole)
    const hasApiKey = Boolean(record.encryptedApiKey && this.decrypt(record.encryptedApiKey))
    const credentialUnreadable = Boolean(record.encryptedApiKey && !hasApiKey)
    const configured = config.protocol === 'cli'
      ? Boolean(record.providerId)
      : Boolean(config.baseUrl && config.model && (!config.requiresKey || hasApiKey))
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      role: selectedRole,
      providerId: config.providerId,
      providerName: config.providerName,
      protocol: config.protocol,
      model: config.model,
      baseUrl: config.baseUrl,
      hasApiKey,
      credentialUnreadable,
      requiresKey: config.requiresKey,
      localOnly: Boolean(config.localOnly || config.bundled),
      configured,
      keyStorage: '系统加密存储',
      capabilities: { ...config.capabilities },
      ...(config.contextWindow ? { contextWindow: config.contextWindow } : {}),
      ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
      ...(config.thinkingMode ? { thinkingMode: config.thinkingMode } : {}),
      ...(config.pricing ? { pricing: { ...config.pricing } } : {}),
      ...(config.pricingUrl ? { pricingUrl: config.pricingUrl } : {}),
      ...(config.pricingVerifiedAt ? { pricingVerifiedAt: config.pricingVerifiedAt } : {})
    }
  }

  publicConfig(role = 'chat') {
    const selectedRole = normalizeRole(role)
    return this.publicRecord(this.readDocument().roles[selectedRole] || {}, selectedRole)
  }

  publicCandidates(role = 'chat') {
    const selectedRole = normalizeRole(role)
    return this.candidateRecords(selectedRole).map((record) => this.publicRecord(record, selectedRole)).filter((config) => config.configured)
  }

  publicRoles() {
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      roles: Object.fromEntries(SUPPORTED_ROLES.map((role) => [role, this.publicConfig(role)]))
    }
  }

  disconnect(role = 'chat', providerId = '', baseUrl = '') {
    const selectedRole = normalizeRole(role)
    const document = this.readDocument()
    const matches = (record) => {
      if (!record) return false
      const config = normalizeConfig(record, selectedRole)
      return config.providerId === providerId && config.baseUrl === String(baseUrl || '').replace(/\/+$/, '')
    }
    document.profiles = { ...(document.profiles || {}) }
    document.profiles[selectedRole] = (document.profiles[selectedRole] || []).filter((record) => !matches(record))
    if (matches(document.stash?.[selectedRole])) delete document.stash[selectedRole]
    if (matches(document.roles[selectedRole])) {
      const remaining = document.profiles[selectedRole][0] || document.stash?.[selectedRole]
      document.roles[selectedRole] = remaining
        ? { ...remaining, updatedAt: new Date().toISOString() }
        : { providerId: 'bundled-lite', updatedAt: new Date().toISOString() }
    }
    document.updatedAt = new Date().toISOString()
    this.writeDocument(document)
    return this.publicCandidates(selectedRole)
  }

  save(input = {}) {
    const role = normalizeRole(input.role)
    const document = this.readDocument()
    const previous = document.roles[role] || {}
    const config = normalizeConfig(input, role)
    validateProviderUrl(config)
    const matching = this.candidateRecords(role, document).find((record) => {
      const candidate = normalizeConfig(record, role)
      return candidate.providerId === config.providerId && candidate.baseUrl === config.baseUrl
    })
    let encryptedApiKey = matching?.encryptedApiKey || (previous.providerId === config.providerId ? previous.encryptedApiKey : '') || ''
    if (input.clearApiKey) {
      encryptedApiKey = ''
      const clearScope = (record) => {
        const candidate = normalizeConfig(record, role)
        return candidate.providerId === config.providerId && candidate.baseUrl === config.baseUrl
          ? { ...record, encryptedApiKey: '' }
          : record
      }
      if (Array.isArray(document.profiles?.[role])) document.profiles[role] = document.profiles[role].map(clearScope)
      if (document.stash?.[role]) document.stash[role] = clearScope(document.stash[role])
    } else if (input.apiKey) {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error('当前系统加密服务不可用，API Key 未保存')
      encryptedApiKey = this.safeStorage.encryptString(String(input.apiKey)).toString('base64')
      const replaceScope = (record) => {
        const candidate = normalizeConfig(record, role)
        return candidate.providerId === config.providerId && candidate.baseUrl === config.baseUrl
          ? { ...record, encryptedApiKey }
          : record
      }
      if (Array.isArray(document.profiles?.[role])) document.profiles[role] = document.profiles[role].map(replaceScope)
      if (document.stash?.[role]) document.stash[role] = replaceScope(document.stash[role])
    }

    const now = new Date().toISOString()
    const nextRecord = {
      providerId: config.providerId,
      model: config.model,
      baseUrl: config.baseUrl,
      ...(config.thinkingMode ? { thinkingMode: config.thinkingMode } : {}),
      encryptedApiKey,
      updatedAt: now
    }
    document.schemaVersion = CONFIG_SCHEMA_VERSION
    document.roles[role] = nextRecord
    document.profiles = { ...(document.profiles || {}) }
    const records = [nextRecord, ...(document.profiles[role] || []), previous.providerId ? previous : null].filter(Boolean)
    document.profiles[role] = uniqueFirst(records, (record) => this.recordKey(record, role))
    document.updatedAt = now
    this.writeDocument(document)
    return this.publicConfig(role)
  }

  quickSwitchRole(role = 'chat', target = 'bundled') {
    const selectedRole = normalizeRole(role)
    const document = this.readDocument()
    const stash = document.stash && typeof document.stash === 'object' ? { ...document.stash } : {}
    const current = document.roles[selectedRole] || null
    const now = new Date().toISOString()

    if (target === 'bundled') {
      const isCloud = current && !NON_CLOUD_PROVIDER_IDS.includes(current.providerId)
      if (isCloud) stash[selectedRole] = current
      document.roles[selectedRole] = { providerId: 'bundled-lite', updatedAt: now }
    } else if (target === 'cloud') {
      const stashed = stash[selectedRole]
      if (!stashed || NON_CLOUD_PROVIDER_IDS.includes(stashed.providerId)) {
        return { switched: false, reason: '没有可恢复的云端配置', config: this.publicConfig(selectedRole) }
      }
      document.roles[selectedRole] = { ...stashed, updatedAt: now }
    } else {
      throw new Error(`未知切换目标：${target}`)
    }

    document.stash = stash
    document.profiles = { ...(document.profiles || {}) }
    const records = [document.roles[selectedRole], current, ...(document.profiles[selectedRole] || [])].filter(Boolean)
    document.profiles[selectedRole] = uniqueFirst(records, (record) => this.recordKey(record, selectedRole))
    document.schemaVersion = CONFIG_SCHEMA_VERSION
    document.updatedAt = now
    this.writeDocument(document)
    return { switched: true, config: this.publicConfig(selectedRole) }
  }
}

module.exports = { CONFIG_SCHEMA_VERSION, SUPPORTED_ROLES, ModelConfigStore }
