// 模型清单 catalog：静态 providers 兜底 + 每周自动刷新（淘汰下架旧模型、上新型号）
// 数据源：① codex-chatgpt 读 Codex CLI 自维护的 models_cache.json ② 已保存 Key 的云端厂商调 /models 端点
const fs = require('fs')
const os = require('os')
const path = require('path')

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // 一周

class ModelCatalog {
  constructor(userDataDir) {
    this.filePath = path.join(userDataDir, 'model-catalog.json')
  }

  read() {
    try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) } catch { return {} }
  }

  // 某厂商的清单（catalog 覆盖优先于静态清单）
  modelsFor(providerId, fallback = []) {
    const entry = this.read().providers?.[providerId]
    return Array.isArray(entry?.models) && entry.models.length ? entry.models : fallback
  }

  needsRefresh() {
    const catalog = this.read()
    const updatedAt = Date.parse(catalog.updatedAt || 0) || 0
    return Date.now() - updatedAt > REFRESH_INTERVAL_MS
  }

  // 刷新：codex 读 CLI 缓存；云端厂商用各自已保存的 Key 拉 /models。失败的厂商保留旧清单（不淘汰）
  async refresh({ listModelsForProvider, onLog = () => {} }) {
    const catalog = this.read()
    const providers = { ...(catalog.providers || {}) }

    // codex-chatgpt：Codex CLI 自维护的模型缓存（官方每周更新，直接采信）
    try {
      const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json')
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
      const models = (Array.isArray(cache.models) ? cache.models : [])
        .map((item) => (typeof item === 'string' ? item : item?.id || item?.slug || item?.name))
        .filter(Boolean)
        .slice(0, 30)
      if (models.length) {
        providers['codex-chatgpt'] = { models, updatedAt: new Date().toISOString(), source: 'codex-cli-cache' }
        onLog(`codex-chatgpt 清单已更新（${models.length} 个，来自 Codex CLI 缓存）`)
      }
    } catch { /* 无 Codex CLI 或缓存缺失则跳过 */ }

    // 云端厂商（有已保存 Key 的）：拉 /models 真实列表
    if (listModelsForProvider) {
      const result = await listModelsForProvider()
      for (const entry of result || []) {
        if (entry?.providerId && Array.isArray(entry.models) && entry.models.length) {
          providers[entry.providerId] = { models: entry.models.slice(0, 60), updatedAt: new Date().toISOString(), source: 'models-endpoint' }
          onLog(`${entry.providerId} 清单已更新（${entry.models.length} 个，来自 /models 端点）`)
        }
      }
    }

    const document = { schemaVersion: 1, updatedAt: new Date().toISOString(), providers }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(document, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.filePath)
    return { updated: Object.keys(providers).length, providers: Object.keys(providers) }
  }
}

module.exports = { ModelCatalog, REFRESH_INTERVAL_MS }
