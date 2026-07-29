// Agnes 接入验收：加密保存配置 → 走 App 正式路径 generateImageAsset → 验证出图
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { ModelConfigStore } = require('../electron/model-config-store')
const { generateImageAsset } = require('../electron/creative-studio-service')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const KEY_FILE = path.join(os.tmpdir(), 'agnes-key.txt')

const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-accept-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

app.whenReady().then(async () => {
  const store = new ModelConfigStore(REAL_USERDATA, safeStorage)
  const key = fs.readFileSync(KEY_FILE, 'utf8').trim()
  const saved = store.save({
    role: 'chat',
    providerId: 'agnes',
    model: 'agnes-2.0-flash',
    baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKey: key
  })
  console.log('配置已保存:', saved.providerId, saved.model, '| key 加密落盘 ✓')

  const config = store.resolved('chat')
  console.log('resolved:', config.providerId, config.model, config.baseUrl)
  const outDir = path.join(tmpProfile, 'img')
  const result = await generateImageAsset(config, {
    prompt: '手持式三维激光扫描仪放在木质桌面上，旁边有笔记本电脑显示点云图，科技产品摄影，柔和自然光',
    id: 'agnes-shot-1',
    size: '1280x720',
    outputDir: outDir
  })
  console.log('出图:', JSON.stringify(result))
  app.exit(0)
}).catch((e) => {
  console.log('FAIL:', e.message)
  app.exit(1)
})
