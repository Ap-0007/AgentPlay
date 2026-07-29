// 诊断：1 秒超短任务，看创建响应与轮询真实形态
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'vpoll-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

function req(method, url, key, body) {
  return new Promise((resolve) => {
    const r = https.request(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } }, (resp) => {
      let data = ''
      resp.on('data', (c) => { data += c })
      resp.on('end', () => resolve({ status: resp.statusCode, body: data }))
    })
    r.on('error', (e) => resolve({ status: -1, body: e.message }))
    r.setTimeout(90000, () => { r.destroy(); resolve({ status: -2, body: 'timeout' }) })
    if (body) r.write(JSON.stringify(body))
    r.end()
  })
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const stash = JSON.parse(fs.readFileSync(path.join(REAL_USERDATA, 'model-config.json'), 'utf8')).stash.chat
  const key = safeStorage.decryptString(Buffer.from(stash.encryptedApiKey, 'base64'))
  const created = await req('POST', 'https://apihub.agnes-ai.com/v1/videos', key, {
    model: 'agnes-video-v2.0', prompt: '猫咪在窗台伸懒腰', width: 1280, height: 720, num_frames: 25, frame_rate: 24
  })
  console.log('创建:', created.status, created.body.slice(0, 300))
  let vid = ''
  try { vid = String(JSON.parse(created.body).video_id || '') } catch { /* ignore */ }
  if (!vid) { app.exit(1); return }
  for (let i = 0; i < 20; i++) {
    await wait(15000)
    const poll = await req('GET', `https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(vid)}`, key)
    console.log(`[轮询 ${i + 1}]`, poll.status, poll.body.slice(0, 250))
    if (/completed|succeeded/.test(poll.body) || /"url"/.test(poll.body)) break
  }
  app.exit(0)
})
