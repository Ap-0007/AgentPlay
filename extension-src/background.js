// background（service worker）：云端模型中转——content script 发页面正文过来，这里调用户配置的 API。
// 走 background 是因为扩展源不受页面 CORS 限制；Key 只在 chrome.storage.local 读取，不落地任何日志。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ap-cloud-translate') return false
  void (async () => {
    try {
      const cfg = await chrome.storage.local.get(['baseUrl', 'apiKey', 'cloudModel', 'targetLang'])
      if (!cfg.baseUrl || !cfg.cloudModel) throw new Error('云端模型未配置：请先到扩展选项页填接口地址和模型')
      const base = cfg.baseUrl.replace(/\/+$/, '')
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: cfg.cloudModel,
          messages: [
            { role: 'system', content: `你是网页翻译助手。把内容翻成通顺的${cfg.targetLang || '中文'}，保留换行与列表结构，只输出译文，不要解释。` },
            { role: 'user', content: String(message.text || '').slice(0, 6000) }
          ],
          temperature: 0.2
        })
      })
      if (!response.ok) throw new Error(`云端返回 ${response.status}`)
      const data = await response.json()
      const text = String(data.choices?.[0]?.message?.content || '').trim()
      if (!text) throw new Error('云端没有返回译文')
      sendResponse({ ok: true, text })
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })()
  return true // 异步响应
})
