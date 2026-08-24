const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { MediaAutoInspection } = require('../electron/media-auto-inspection')
const { VideoFrameService } = require('../electron/video-frame-service')

const ffmpegRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin')
const ffmpeg = path.join(ffmpegRoot, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = path.join(ffmpegRoot, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

test('real visual inspection finds an internal black interval, severe blur and a later repeated changing shot', { timeout: 120000 }, async (t) => {
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) return t.skip('ffmpeg fixture unavailable')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-auto-inspection-'))
  try {
    const source = path.join(directory, 'inspection.mp4')
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi', '-i', 'color=black:duration=1:size=320x180:rate=10', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1',
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x180:rate=10,hue=h=90', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2',
      '-filter_complex', '[6:v]boxblur=4:1[blurred];[0:v][1:a][2:v][3:a][4:v][5:a][blurred][7:a][8:v][9:a]concat=n=5:v=1:a=1[v][a]',
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source
    ]
    const built = spawnSync(ffmpeg, args, { timeout: 60000, windowsHide: true })
    assert.equal(built.status, 0, String(built.stderr || 'fixture build failed'))
    const frames = new VideoFrameService({ ffmpegPath: ffmpeg, ffprobePath: ffprobe })
    const durationSeconds = await frames.probeDuration(source)
    const result = await new MediaAutoInspection({ frames }).inspect({ sourcePath: source, durationSeconds })
    assert.ok(result.blackRanges.some((item) => item.startSeconds <= 2.1 && item.endSeconds >= 2.9), JSON.stringify(result.blackRanges))
    assert.ok(result.blurRanges.some((item) => item.startSeconds < 6.5 && item.endSeconds > 5.5), JSON.stringify(result.blurRanges))
    assert.ok(result.duplicateRanges.some((item) => item.referenceStartSeconds < 0.6 && item.startSeconds >= 2.5 && item.startSeconds <= 3.5), JSON.stringify(result.duplicateRanges))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
