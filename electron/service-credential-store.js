const fs = require('fs')
const path = require('path')

const SERVICE_CREDENTIAL_SCHEMA_VERSION = 1
const SUPPORTED_SERVICES = Object.freeze(['tmdb', 'opensubtitles'])

function normalizeService(value) {
  const service = String(value || '').trim().toLowerCase()
  if (!SUPPORTED_SERVICES.includes(service)) throw new Error(`不支持的服务凭证：${service || '空'}`)
  return service
}

class ServiceCredentialStore {
  constructor(userDataDir, safeStorage) {
    this.filePath = path.join(userDataDir, 'service-credentials.json')
    this.safeStorage = safeStorage
  }

  readDocument() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      const services = raw?.services && typeof raw.services === 'object' ? raw.services : {}
      return {
        schemaVersion: SERVICE_CREDENTIAL_SCHEMA_VERSION,
        services: Object.fromEntries(SUPPORTED_SERVICES
          .filter((service) => services[service] && typeof services[service] === 'object')
          .map((service) => [service, { ...services[service] }]))
      }
    } catch {
      return { schemaVersion: SERVICE_CREDENTIAL_SCHEMA_VERSION, services: {} }
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

  get(service) {
    const selected = normalizeService(service)
    return this.decrypt(this.readDocument().services[selected]?.encryptedKey)
  }

  publicStatus() {
    const document = this.readDocument()
    return {
      schemaVersion: SERVICE_CREDENTIAL_SCHEMA_VERSION,
      keyStorage: '系统加密存储',
      services: Object.fromEntries(SUPPORTED_SERVICES.map((service) => {
        const record = document.services[service] || {}
        return [service, { hasKey: Boolean(record.encryptedKey), updatedAt: record.updatedAt || null }]
      }))
    }
  }

  save(input = {}) {
    const service = normalizeService(input.service)
    const document = this.readDocument()
    const existing = document.services[service]

    if (input.clear === true) {
      if (existing) {
        delete document.services[service]
        this.writeDocument(document)
      }
      return this.publicStatus()
    }

    const key = String(input.key || '').trim()
    if (!key) return this.publicStatus()
    if (key.length > 8192) throw new Error('服务凭证过长，未保存')
    if (!this.safeStorage?.isEncryptionAvailable?.()) throw new Error('当前系统加密服务不可用，服务凭证未保存')

    document.services[service] = {
      encryptedKey: this.safeStorage.encryptString(key).toString('base64'),
      updatedAt: new Date().toISOString()
    }
    this.writeDocument(document)
    return this.publicStatus()
  }
}

module.exports = {
  SERVICE_CREDENTIAL_SCHEMA_VERSION,
  SUPPORTED_SERVICES,
  ServiceCredentialStore
}
