// 探测：真实创作方案请求在 400 重试后的真实耗时（上限 620s）
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { ModelConfigStore } = require('../electron/model-config-store')
const { requestCreativePlan } = require('../electron/creative-studio-service')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-probe-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

app.whenReady().then(async () => {
  const store = new ModelConfigStore(REAL_USERDATA, safeStorage)
  const config = store.resolved('chat')
  const t0 = Date.now()
  try {
    const plan = await requestCreativePlan(config, {
      topic: '15 秒手持三维扫描仪产品短片',
      audience: '创业者',
      duration: 15,
      style: '科技简洁',
      markers: []
    }, { timeoutMs: 620000 })
    console.log('PLAN OK', Date.now() - t0, 'ms')
    console.log(JSON.stringify(plan).slice(0, 800))
  } catch (e) {
    console.log('PLAN FAIL', Date.now() - t0, 'ms:', e.message)
  }
  app.exit(0)
})
