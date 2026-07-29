// 裸 https 对照：POST /videos 文生视频（定位 fetch failed 根因）
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-probe-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

app.whenReady().then(async () => {
  const stash = JSON.parse(fs.readFileSync(path.join(REAL_USERDATA, 'model-config.json'), 'utf8')).stash.chat
  const key = safeStorage.decryptString(Buffer.from(stash.encryptedApiKey, 'base64'))
  const body = JSON.stringify({ model: 'agnes-video-v2.0', prompt: '猫咪在窗台上慢慢转头看向镜头，阳光柔和', size: '1280x720', fps: 24, num_frames: 73 })
  const result = await new Promise((resolve) => {
    const req = https.request('https://apihub.agnes-ai.com/v1/videos', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } }, (resp) => {
      let data = ''
      resp.on('data', (c) => { data += c })
      resp.on('end', () => resolve({ status: resp.statusCode, body: data.slice(0, 400) }))
    })
    req.on('error', (e) => resolve({ status: -1, body: e.message }))
    req.setTimeout(60000, () => { req.destroy(); resolve({ status: -2, body: 'timeout' }) })
    req.write(body)
    req.end()
  })
  console.log('裸 POST /videos:', JSON.stringify(result))
  app.exit(0)
})
