// AgentPlay 网页全局翻译 · content script
// 整页对照翻译：离线 OPUS-MT（浏览器内 wasm 推理，内容不出机）或云端模型（经 background 中转）。
// 设计红线：离线引擎失败如实告知（严格 CSP 页面 wasm 受限），绝不静默换成别的引擎。

import { pipeline, env } from '@huggingface/transformers'

const MARK = 'ap-translation-block'
const HIDDEN_MARK = 'ap-original-hidden'

let translatorPromise = null
let running = false
let cancelled = false
let overlay = null

function configureEnv() {
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = chrome.runtime.getURL('models/')
  try {
    if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/')
  } catch { /* 老版本没有 backends 配置 */ }
}

async function ensureTranslator(onStatus) {
  if (!translatorPromise) {
    translatorPromise = (async () => {
      configureEnv()
      onStatus?.('正在加载离线模型（首次约 30 秒）…')
      const pipe = await pipeline('translation', 'Xenova/opus-mt-en-zh', { dtype: 'q8' })
      return pipe
    })()
    translatorPromise.catch(() => { translatorPromise = null })
  }
  return translatorPromise
}

const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, td, th, dd, dt, blockquote, figcaption, summary, caption'
const SKIP_ANCESTOR = 'script, style, code, pre, noscript, textarea, svg, [contenteditable="true"], nav, footer form'

function isVisible(element) {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  const style = getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}

function collectBlocks() {
  const blocks = []
  const seen = new Set()
  for (const element of document.body.querySelectorAll(BLOCK_SELECTOR)) {
    if (element.closest(SKIP_ANCESTOR) || element.closest(`.${MARK}`)) continue
    if (element.querySelector(BLOCK_SELECTOR)) continue // 只取最内层块，避免重复翻译嵌套
    const text = element.textContent.replace(/\s+/g, ' ').trim()
    if (text.length < 8 || text.length > 4000) continue
    if (!/[\u4e00-\u9fff]|[^\x00-\x7F]/.test(text) && /^[\s\w\d.,;:!?'"()\-–—…]+$/.test(text)) {
      // 纯 ASCII 英文块照翻不误（目标为中文时就是要翻它）
    }
    if (seen.has(text) || !isVisible(element)) continue
    seen.add(text)
    blocks.push({ element, text })
  }
  return blocks.slice(0, 200)
}

function showOverlay(text) {
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:#141824;color:#dbe2f0;padding:10px 14px;border-radius:10px;font:13px/1.5 "Microsoft YaHei",system-ui;box-shadow:0 4px 20px rgb(0 0 0/.4);border:1px solid #2a3145;max-width:320px'
    document.documentElement.appendChild(overlay)
  }
  overlay.innerHTML = ''
  const label = document.createElement('span')
  label.textContent = text
  const cancel = document.createElement('button')
  cancel.textContent = '取消'
  cancel.style.cssText = 'margin-left:10px;background:#2a3145;color:#c7d0e2;border:0;border-radius:6px;padding:3px 10px;cursor:pointer'
  cancel.addEventListener('click', () => { cancelled = true; hideOverlay() })
  overlay.append(label, cancel)
}

function hideOverlay() {
  overlay?.remove()
  overlay = null
}

async function translateOffline(text, onStatus) {
  const translator = await ensureTranslator(onStatus)
  const output = await translator(text)
  return String(output?.[0]?.translation_text || '').trim()
}

async function translateCloud(text) {
  const response = await chrome.runtime.sendMessage({ type: 'ap-cloud-translate', text })
  if (!response?.ok) throw new Error(response?.error || '云端翻译失败')
  return String(response.text).trim()
}

function insertTranslation(element, text) {
  const block = document.createElement('div')
  block.className = MARK
  block.textContent = text
  block.style.cssText = 'border-left:3px solid #2563eb;padding:4px 0 4px 10px;margin:2px 0 8px;opacity:.88;font-size:.95em;line-height:1.65;color:inherit'
  element.insertAdjacentElement('afterend', block)
}

async function translatePage() {
  if (running) return
  running = true
  cancelled = false
  const cfg = await chrome.storage.local.get(['engine'])
  const engine = cfg.engine || 'offline'
  const blocks = collectBlocks()
  if (!blocks.length) {
    showOverlay('没有找到可翻译的正文块')
    setTimeout(hideOverlay, 2500)
    running = false
    return
  }
  let done = 0
  try {
    for (const { element, text } of blocks) {
      if (cancelled) break
      showOverlay(`AgentPlay 翻译中 ${done + 1}/${blocks.length}（${engine === 'cloud' ? '云端模型' : '离线引擎'}）…`)
      try {
        const translated = engine === 'cloud'
          ? await translateCloud(text)
          : await translateOffline(text, (status) => showOverlay(status))
        if (translated && translated !== text) insertTranslation(element, translated)
      } catch (error) {
        showOverlay(`翻译中断：${String(error.message || error).slice(0, 120)}`)
        await new Promise((resolve) => setTimeout(resolve, 3200))
        break
      }
      done += 1
    }
    if (done > 0 && !cancelled) {
      showOverlay(`翻译完成 ${done}/${blocks.length} 块；点弹窗「还原本页」可撤销`)
      setTimeout(hideOverlay, 2600)
    } else if (cancelled) {
      hideOverlay()
    }
  } finally {
    running = false
  }
}

function restorePage() {
  document.querySelectorAll(`.${MARK}`).forEach((element) => element.remove())
  document.querySelectorAll(`.${HIDDEN_MARK}`).forEach((element) => element.classList.remove(HIDDEN_MARK))
  hideOverlay()
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'ap-translate-page') {
    void translatePage().then(() => sendResponse({ ok: true }))
    return true
  }
  if (message?.type === 'ap-restore') {
    restorePage()
    sendResponse({ ok: true })
    return false
  }
  if (message?.type === 'ap-state') {
    sendResponse({ translated: document.querySelectorAll(`.${MARK}`).length > 0, running })
    return false
  }
  return false
})

// 页面内事件桥（自动化验收/未来的页内按钮）：与弹窗触发同一入口
window.addEventListener('ap-translate-request', () => { void translatePage() })
