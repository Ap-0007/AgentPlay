const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  buildWhisperRecovery,
  buildOfflineTranslateRecovery,
  buildCloudTranslateRecovery
} = require('../electron/subtitle-recovery-policy')

test('missing speech recognition becomes an inline local install plan with honest timing', () => {
  const recovery = buildWhisperRecovery({ packBytes: 150 * 1024 * 1024, durationSeconds: 600, targetLang: '中文' })
  assert.equal(recovery.kind, 'install-whisper')
  assert.equal(recovery.canAutoFix, true)
  assert.equal(recovery.downloadBytes, 150 * 1024 * 1024)
  assert.equal(recovery.costLabel, '本地免费 · 视频和音频不上传')
  assert.match(recovery.timeLabel, /视频约 10 分钟/)
  assert.match(recovery.timeLabel, /识别约 10–40 分钟/)
  assert.equal(recovery.targetLang, '中文')
})

test('missing English-to-Chinese engine offers the local OPUS pack and batch estimate', () => {
  const recovery = buildOfflineTranslateRecovery({ packBytes: 310 * 1024 * 1024, entryCount: 160, targetLang: '中文' })
  assert.equal(recovery.kind, 'install-translate')
  assert.equal(recovery.canAutoFix, true)
  assert.equal(recovery.estimatedRequests, 0)
  assert.equal(recovery.costLabel, '本地免费 · 字幕不离开电脑')
  assert.match(recovery.timeLabel, /160 段/)
  assert.match(recovery.actionLabel, /安装并继续/)
})

test('Chinese-to-English recovery presets Agnes and discloses current public pricing without pretending it is guaranteed', () => {
  const recovery = buildCloudTranslateRecovery({ entryCount: 45, targetLang: '英文' })
  assert.equal(recovery.kind, 'configure-cloud')
  assert.equal(recovery.canAutoFix, false)
  assert.equal(recovery.providerId, 'agnes')
  assert.equal(recovery.model, 'agnes-2.5-flash')
  assert.equal(recovery.estimatedRequests, 3)
  assert.match(recovery.costLabel, /当前公开价约 \$0/)
  assert.match(recovery.costLabel, /账户权益/)
  assert.equal(recovery.pricingVerifiedAt, '2026-08-11')
  assert.match(recovery.pricingUrl, /^https:\/\/.*agnes-ai\.com\//)
})

test('subtitle recovery is wired from main-process failures to inline repair and model-center intent', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')
  const player = fs.readFileSync(path.join(root, 'src', 'components', 'PlayerView.tsx'), 'utf8')
  const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
  const modelCenter = fs.readFileSync(path.join(root, 'src', 'components', 'ModelCenter.tsx'), 'utf8')

  assert.match(main, /buildWhisperRecovery/)
  assert.match(main, /buildOfflineTranslateRecovery/)
  assert.match(main, /buildCloudTranslateRecovery/)
  assert.match(main, /AgentPlay原文\.srt/)
  assert.match(main, /检测到上次识别的原文字幕/)
  assert.match(player, /data-subtitle-recovery="true"/)
  assert.match(player, /install-whisper/)
  assert.match(player, /install-translate/)
  assert.match(player, /ai-player-open-model-center/)
  assert.match(player, /void generateBilingual\(recovery\.targetLang\)/)
  assert.match(app, /ai-player-open-model-center/)
  assert.match(modelCenter, /intent\?\.providerId/)
  assert.match(modelCenter, /字幕翻译只发送字幕原文/)
})
