// popup：触发当前页整页翻译/还原；状态由 content.js 回报
const go = document.getElementById('go')
const undo = document.getElementById('undo')
const status = document.getElementById('status')
const engineInfo = document.getElementById('engineInfo')

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

async function refresh() {
  const cfg = await chrome.storage.local.get(['engine', 'cloudModel'])
  engineInfo.innerHTML = cfg.engine === 'cloud'
    ? `引擎：<b>云端模型</b>（${cfg.cloudModel || '未配置'}）`
    : '引擎：<b>离线 OPUS-MT</b>（内容不出机）'
  const tab = await currentTab()
  try {
    const state = await chrome.tabs.sendMessage(tab.id, { type: 'ap-state' })
    undo.hidden = !state?.translated
  } catch { /* 页面未注入 */ }
}

go.addEventListener('click', async () => {
  go.disabled = true
  status.textContent = '启动翻译…（首次离线引擎需加载模型约 30 秒）'
  const tab = await currentTab()
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'ap-translate-page' })
    status.textContent = '正在翻译，可在页面上查看进度…'
    window.setTimeout(() => window.close(), 1200)
  } catch {
    status.textContent = '这个页面无法注入（chrome://、商店页或 PDF 不支持）'
  }
  go.disabled = false
})

undo.addEventListener('click', async () => {
  const tab = await currentTab()
  await chrome.tabs.sendMessage(tab.id, { type: 'ap-restore' })
  window.close()
})

document.getElementById('openOptions').addEventListener('click', (event) => {
  event.preventDefault()
  chrome.runtime.openOptionsPage()
})

void refresh()
