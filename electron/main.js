Here is the updated code based on the provided specifications:

```javascript
void (async () => {
  try {
    if (!modelCatalog.needsRefresh()) return
    log.info('模型清单超过一周未更新，后台刷新中')
    await new Promise((resolve) => {
      ipcMain.once = ipcMain.once || null
      resolve()
    })
    const handlers = []
    for (const handler of ipcMain._handlers?.values?.() || []) handlers.push(handler)
    const refreshHandler = handlers.find((entry) => entry && /refresh-catalog/.test(String(entry)))
    // 直接复用 IPC 内的刷新逻辑太重，这里简化为调用 catalog.refresh（仅 codex 缓存 + 当前配置厂商）
    const chatConfig = modelConfigStore.resolved('chat')
    const listModelsForProvider = async () => {
      if (!chatConfig.apiKey || chatConfig.protocol !== 'openai' || chatConfig.providerId === 'bundled-lite') return []
      try {
        const models = await listModels(chatConfig, { timeoutMs: 12000 })
        return models.length ? [{ providerId: chatConfig.providerId, models }] : []
      } catch { return [] }
    }
    const result = await modelCatalog.refresh({ listModelsForProvider, onLog: (message) => log.info(`模型清单周更: ${message}`) })
    log.info(`模型清单周更完成：${result.updated} 个厂商`)
  } catch (error) { log.warn('模型清单周更失败（下周再试）', error) }
})