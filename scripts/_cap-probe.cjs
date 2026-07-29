// 一次性探测：火山 Coding 端点与标准 v3 端点的图像/语音接口能力（不打印密钥）
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-probe-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

function postJson(url, key, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 300) }))
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.write(JSON.stringify(body))
    req.end()
  })
}

app.whenReady().then(async () => {
  const stash = JSON.parse(fs.readFileSync(path.join(REAL_USERDATA, 'model-config.json'), 'utf8')).stash.chat
  const key = safeStorage.decryptString(Buffer.from(stash.encryptedApiKey, 'base64'))

  // 1) Coding 端点 /images/generations
  try {
    const res = await postJson(`${stash.baseUrl}/images/generations`, key, { model: 'gpt-image-1', prompt: 'a cat', size: '1024x1024', response_format: 'b64_json' })
    console.log('[1] coding/images/generations:', res.status, res.body.slice(0, 200))
  } catch (e) {
    console.log('[1] coding/images/generations FAIL:', e.message)
  }

  // 2) 标准 ark v3 /images/generations（doubao-seedream）
  try {
    const res = await postJson('https://ark.cn-beijing.volces.com/api/v3/images/generations', key, { model: 'doubao-seedream-4-0-250828', prompt: '一只在窗台晒太阳的橘猫，照片级写实', size: '1024x1024', response_format: 'b64_json' }, 120000)
    console.log('[2] v3/images/generations seedream:', res.status, res.body.slice(0, 200))
  } catch (e) {
    console.log('[2] v3/images/generations FAIL:', e.message)
  }

undefined
})
