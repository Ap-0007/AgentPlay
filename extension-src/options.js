// options：引擎与云端模型配置，全部只存本机 chrome.storage.local
const fields = ['engine', 'baseUrl', 'apiKey', 'cloudModel', 'targetLang']

async function load() {
  const cfg = await chrome.storage.local.get(fields)
  document.querySelector(`input[name="engine"][value="${cfg.engine || 'offline'}"]`).checked = true
  document.getElementById('baseUrl').value = cfg.baseUrl || ''
  document.getElementById('apiKey').value = cfg.apiKey || ''
  document.getElementById('cloudModel').value = cfg.cloudModel || ''
  document.getElementById('targetLang').value = cfg.targetLang || '中文'
  toggle()
}

function toggle() {
  const engine = document.querySelector('input[name="engine"]:checked').value
  document.getElementById('cloudBox').style.display = engine === 'cloud' ? '' : 'none'
}

document.querySelectorAll('input[name="engine"]').forEach((radio) => radio.addEventListener('change', toggle))

document.getElementById('save').addEventListener('click', async () => {
  const engine = document.querySelector('input[name="engine"]:checked').value
  await chrome.storage.local.set({
    engine,
    baseUrl: document.getElementById('baseUrl').value.trim(),
    apiKey: document.getElementById('apiKey').value.trim(),
    cloudModel: document.getElementById('cloudModel').value.trim(),
    targetLang: document.getElementById('targetLang').value
  })
  document.getElementById('saved').textContent = '已保存'
  window.setTimeout(() => { document.getElementById('saved').textContent = '' }, 1500)
})

void load()
