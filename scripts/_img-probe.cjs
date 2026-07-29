// 探测：doubao-seedream-3.0-t2i 真实出图验证
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'img-probe-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

app.whenReady().then(async () => {
  const stash = JSON.parse(fs.readFileSync(path.join(REAL_USERDATA, 'model-config.json'), 'utf8')).stash.chat
  const key = safeStorage.decryptString(Buffer.from(stash.encryptedApiKey, 'base64'))
  const body = JSON.stringify({
    model: 'doubao-seedream-3-0-t2i-250415',
    prompt: '一只在窗台晒太阳的橘猫，照片级写实，柔和自然光',
    size: '1024x1024',
    response_format: 'b64_json'
  })
  const result = await new Promise((resolve, reject) => {
    const req = https.request('https://ark.cn-beijing.volces.com/api/v3/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } }, (resp) => {
      let data = ''
      resp.on('data', (c) => { data += c })
      resp.on('end', () => resolve({ status: resp.statusCode, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error('timeout')))
    req.write(body)
    req.end()
  })
  console.log('status:', result.status)
  if (result.status === 200) {
    const parsed = JSON.parse(result.body)
    const b64 = parsed.data?.[0]?.b64_json
    if (b64) {
      const out = path.join(tmpProfile, 'cat.png')
      fs.writeFileSync(out, Buffer.from(b64, 'base64'))
      console.log('出图成功:', out, fs.statSync(out).size, 'bytes')
    } else {
      console.log('无 b64_json:', JSON.stringify(parsed).slice(0, 200))
    }
  } else {
    console.log('失败:', result.body.slice(0, 300))
  }
  app.exit(0)
})
