// 创作链 E2E：真实云端方案 → 占位镜头 → 系统配音 → 合成 MP4 → ffprobe 验收
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const { ModelConfigStore } = require('../electron/model-config-store')
const { requestCreativePlan, synthesizeSystemVoice, renderCreativeVideo } = require('../electron/creative-studio-service')

const REAL_USERDATA = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player'
const FFMPEG = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player\\yt-dlp\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe'
const FFPROBE = 'C:\\Users\\Administrator\\AppData\\Roaming\\ai-player\\yt-dlp\\ffmpeg-8.0.1-essentials_build\\bin\\ffprobe.exe'
const MPV = 'D:\\Ai工具升级\\项目源码（开发者用）\\ai-player\\resources\\bin\\win\\mpv.com'
const VOICE_HELPER = 'D:\\Ai工具升级\\项目源码（开发者用）\\ai-player\\resources\\bin\\win\\ai-player-voice.exe'

const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-e2e-'))
fs.copyFileSync(path.join(REAL_USERDATA, 'Local State'), path.join(tmpProfile, 'Local State'))
app.setPath('userData', tmpProfile)

app.whenReady().then(async () => {
  const outDir = path.join(tmpProfile, 'out')
  fs.mkdirSync(outDir, { recursive: true })

  // 1) 真实云端创作方案
  const store = new ModelConfigStore(REAL_USERDATA, safeStorage)
  const config = store.resolved('chat')
  console.log('[1] chat provider:', config.providerId, '| model:', config.model)
  console.log('PLAN START')
  const plan = await requestCreativePlan(config, {
    topic: '15 秒手持三维扫描仪产品短片',
    audience: '创业者',
    duration: 15,
    style: '科技简洁',
    markers: []
  }, { timeoutMs: 620000 })
  console.log('[1] 方案:', JSON.stringify(plan).slice(0, 400))

  // 2) 两个占位镜头（纯色底，模拟 AI 新镜头素材位）
  const shots = []
  const colors = ['0x1F2A44', '0x2D4A22']
  for (let i = 0; i < 2; i++) {
    const img = path.join(outDir, `shot-${i}.png`)
    spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${colors[i]}:s=1280x720`, '-frames:v', '1', '-y', img])
    shots.push({ kind: 'generated', assetPath: img, duration: 3, caption: `镜头 ${i + 1}：产品卖点 ${i + 1}`, narration: `镜头 ${i + 1}` })
  }
  console.log('[2] 占位镜头就绪:', shots.length)

  // 3) 系统配音（真实 SAPI）
  const voice = await synthesizeSystemVoice({ text: '这是我们用了四年做出的手持三维扫描仪，千元美金，全球发售。', outputDir: outDir, helperPath: VOICE_HELPER, rate: 0 })
  console.log('[3] 系统配音:', voice.engine, voice.bytes, 'bytes')

  // 4) 合成成片
  const outputPath = path.join(outDir, '成片.mp4')
  const rendered = await renderCreativeVideo({ mpvPath: MPV, ffmpegPath: FFMPEG, input: { sourcePath: 'x', shots, voicePath: voice.outputPath }, outputPath })
  console.log('[4] 合成:', JSON.stringify(rendered))

  // 5) ffprobe 验收
  const probe = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', outputPath])
  console.log('[5] ffprobe:', probe.stdout.toString('utf8'))
  app.exit(0)
}).catch((e) => {
  console.log('FAIL:', e.message)
  app.exit(1)
})
