// 探测：ark 账号可见的图像/语音模型清单
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'models-probe-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

app.whenReady().then(async () => {
  const stash = JSON.parse(fs.readFileSync(path.join(REAL_USERDATA, 'model-config.json'), 'utf8')).stash.chat
  const key = safeStorage.decryptString(Buffer.from(stash.encryptedApiKey, 'base64'))
  const res = await new Promise((resolve, reject) => {
    const req = https.request('https://ark.cn-beijing.volces.com/api/v3/models', { headers: { Authorization: `Bearer ${key}` } }, (resp) => {
      let data = ''
      resp.on('data', (c) => { data += c })
      resp.on('end', () => resolve({ status: resp.statusCode, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('timeout')))
    req.end()
  })
  console.log('status:', res.status)
  try {
    const parsed = JSON.parse(res.body)
    const ids = (parsed.data || []).map((m) => m.id)
    const relevant = ids.filter((id) => /seedream|seededit|image|tts|visual|dub/i.test(id))
    console.log('全部模型数:', ids.length)
    console.log('图像/语音相关:', relevant.length ? relevant.join(', ') : '（无）')
  } catch {
    console.log('body:', res.body.slice(0, 200))
  }
  app.exit(0)
})
