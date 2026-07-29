// Agnes 图生视频真机验收：产品图 → 3 秒动画 → ffprobe 验证
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const { ModelConfigStore } = require('../electron/model-config-store')
const { generateVideoAsset } = require('../electron/creative-studio-service')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const FFMPEG = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player\\yt-dlp\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe'
const FFPROBE = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player\\yt-dlp\\ffmpeg-8.0.1-essentials_build\\bin\\ffprobe.exe'
const SOURCE_IMG = 'D:\\BUILD-~1\\temp\\agnes-accept-fec3pZ\\img\\agnes-shot-1.png'

const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'agnes-video-e2e-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

app.whenReady().then(async () => {
  const store = new ModelConfigStore(REAL_USERDATA, safeStorage)
  const config = store.resolved('chat')
  console.log('provider:', config.providerId)

  // 图生视频要纯 base64 的 ≤768px JPG（载荷小更稳）
  const jpg = path.join(tmpProfile, 'src.jpg')
  spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', SOURCE_IMG, '-vf', 'scale=768:-2', '-q:v', '3', '-y', jpg])
  const imageBase64 = fs.readFileSync(jpg).toString('base64')

  const t0 = Date.now()
  const result = await generateVideoAsset(config, {
    prompt: '产品镜头：手持三维扫描仪在桌面上缓慢环绕展示，点云图在笔记本屏幕上缓缓旋转，光线柔和，科技产品广告质感',
    duration: 3,
    id: 'agnes-video-shot-1',
    imageBase64,
    outputDir: path.join(tmpProfile, 'videos')
  })
  console.log('视频生成:', Date.now() - t0, 'ms', JSON.stringify(result))

  const probe = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,r_frame_rate', '-of', 'json', result.outputPath])
  console.log('ffprobe:', probe.stdout.toString('utf8'))
  app.exit(0)
}).catch((e) => {
  console.log('FAIL:', e.message)
  app.exit(1)
})
