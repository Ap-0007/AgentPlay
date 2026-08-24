const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { attachEditDecisionList } = require('../electron/edit-decision-list')
const { MediaEditService } = require('../electron/media-edit-service')
const { VideoFrameService } = require('../electron/video-frame-service')
const { buildSmartReframeDecision, trackingMoments, validateTrackingPayload } = require('../electron/smart-reframe-service')

const bin = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin')
const ffmpeg = path.join(bin, 'ffmpeg.exe'); const ffprobe = path.join(bin, 'ffprobe.exe')
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const redCentroidX = (file, seconds = 1.6) => {
  const width = 101; const height = 180; const sampled = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:${height},format=rgb24`, '-f', 'rawvideo', '-'])
  let count = 0; let sumX = 0
  for (let index = 0; index + 2 < sampled.stdout.length; index += 3) {
    const r = sampled.stdout[index]; const g = sampled.stdout[index + 1]; const b = sampled.stdout[index + 2]
    if (r > g + 80 && r > b + 80) { count += 1; sumX += (index / 3) % width }
  }
  return { count, x: count ? sumX / count : -1 }
}

test('real smart reframe exports 16:9, 9:16 and 1:1 while following a frozen moving subject', { timeout: 180000 }, async (t) => {
  if (!fs.existsSync(ffmpeg)) return t.skip('ffmpeg unavailable')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-smart-reframe-'))
  try {
    const source = path.join(dir, 'source.mp4')
    assert.equal(spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=0x202020:size=640x360:rate=15:duration=6', '-f', 'lavfi', '-i', 'color=red:size=70x170:rate=15:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-filter_complex', "[0:v][1:v]overlay=x='40+70*t':y=90:eval=frame[vout]", '-map', '[vout]', '-map', '2:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source, '-loglevel', 'error'], { timeout: 60000 }).status, 0)
    const before = hash(source); const moments = trackingMoments(6)
    const payload = { observedSubject: '移动红色人物框', frames: moments.map((item) => ({ label: item.label, box: { x: (40 + 70 * item.seconds) / 640, y: 90 / 360, width: 70 / 640, height: 170 / 360 }, confidence: 0.98 })) }
    const tracking = validateTrackingPayload(payload, moments, '移动红色人物框')
    const decision = attachEditDecisionList(buildSmartReframeDecision({ instruction: '生成16:9、9:16、1:1三个版本，跟踪移动红色人物框', sourcePath: source, width: 640, height: 360, durationSeconds: 6, tracking, model: { providerId: 'fixture', providerName: 'fixture', model: 'fixture-vision', local: true } }))
    const outputs = decision.reframe.outputs.map((item) => path.join(dir, `${item.aspect.replace(':', 'x')}.mp4`))
    const frames = new VideoFrameService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe })
    const result = await new MediaEditService({ frames }).smartReframe({ sourcePath: source, outputPaths: outputs, decision })
    assert.equal(result.outputs.length, 3)
    assert.deepEqual(result.versions.map((item) => [item.aspect, item.dimensions.width, item.dimensions.height]), [['16:9', 640, 360], ['9:16', 202, 360], ['1:1', 360, 360]])
    assert.ok(result.trackingReceipt.minimumSubjectCoverage >= 0.9, result.trackingReceipt.minimumSubjectCoverage)
    assert.equal(result.trackingReceipt.frameCount, 5)
    const centroid = redCentroidX(outputs[1])
    assert.ok(centroid.count > 200 && Math.abs(centroid.x - 50) < 12, JSON.stringify(centroid))
    assert.equal(hash(source), before)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
