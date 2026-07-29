// 探测：response_format=json_object 是否让 Coding 端点挂起
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-probe-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

function call(baseUrl, key, body, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const req = https.request(`${baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } }, (resp) => {
      let data = ''
      resp.on('data', (c) => { data += c })
      resp.on('end', () => resolve({ ms: Date.now() - started, status: resp.statusCode, body: data.slice(0, 150) }))
    })
    req.on('error', (e) => resolve({ ms: Date.now() - started, status: -1, body: e.message }))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ms: Date.now() - started, status: -2, body: 'timeout' }) })
    req.write(JSON.stringify(body))
    req.end()
  })
}

app.whenReady().then(async () => {
  const stash = JSON.parse(fs.readFileSync(path.join(REAL_USERDATA, 'model-config.json'), 'utf8')).stash.chat
  const key = safeStorage.decryptString(Buffer.from(stash.encryptedApiKey, 'base64'))
  const base = { model: stash.model, messages: [{ role: 'user', content: '用一句话回答：1+1=?' }], max_tokens: 50 }

  const r1 = await call(stash.baseUrl, key, { ...base, response_format: { type: 'json_object' } }, 60000)
  console.log('带 response_format:', JSON.stringify(r1))
  const r2 = await call(stash.baseUrl, key, base, 60000)
  console.log('不带 response_format:', JSON.stringify(r2))
  app.exit(0)
})
