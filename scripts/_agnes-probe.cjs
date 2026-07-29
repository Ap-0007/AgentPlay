// 探测 Agnes key 的模型清单/聊天/生图（不打印密钥）
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const https = require('https')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const KEY_FILE = path.join(os.tmpdir(), 'agnes-key.txt')
const BASE = 'https://apihub.agnes-ai.com/v1'

const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-probe-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

function req(method, url, key, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } }, (resp) => {
      let data = ''
      resp.on('data', (c) => { data += c })
      resp.on('end', () => resolve({ status: resp.statusCode, body: data }))
    })
    r.on('error', reject)
    r.setTimeout(timeoutMs, () => r.destroy(new Error('timeout')))
    if (body) r.write(JSON.stringify(body))
    r.end()
  })
}

app.whenReady().then(async () => {
  const key = fs.readFileSync(KEY_FILE, 'utf8').trim()
  const models = await req('GET', `${BASE}/models`, key)
  console.log('[1] /models:', models.status, models.body.slice(0, 300))

  const chat = await req('POST', `${BASE}/chat/completions`, key, {
    model: 'agnes-2.0-flash',
    messages: [{ role: 'user', content: '用一句话回答：三维扫描仪的核心卖点怎么说？' }],
    max_tokens: 80
  })
  console.log('[2] chat:', chat.status, chat.body.slice(0, 250))

  const img = await req('POST', `${BASE}/images/generations`, key, {
    model: 'agnes-image-2.1-flash',
    prompt: '一只在窗台晒太阳的橘猫，照片级写实',
    size: '1280x720'
  }, 180000)
  console.log('[3] image:', img.status, img.body.slice(0, 200))
  if (img.status === 200) {
    try {
      const parsed = JSON.parse(img.body)
      const b64 = parsed.data?.[0]?.b64_json
      if (b64) {
        const out = path.join(os.tmpdir(), 'agnes-cat.png')
        fs.writeFileSync(out, Buffer.from(b64, 'base64'))
        console.log('[3] 出图成功:', out, fs.statSync(out).size, 'bytes')
      } else {
        console.log('[3] 无 b64_json:', JSON.stringify(parsed).slice(0, 200))
      }
    } catch (e) {
      console.log('[3] JSON 解析失败:', e.message)
    }
  }
  app.exit(0)
})
