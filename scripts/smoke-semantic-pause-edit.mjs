import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { VideoFrameService } = require('../electron/video-frame-service')
const { SemanticEditService } = require('../electron/semantic-edit-service')
const { attachEditDecisionList } = require('../electron/edit-decision-list')
const { MediaEditService } = require('../electron/media-edit-service')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback = '') => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || fallback
const appDataRoot = process.env.APPDATA || ''
const runtimeRoot = path.join(appDataRoot, 'ai-player', 'yt-dlp', 'ffmpeg-8.0.1-essentials_build', 'bin')
const ffmpegPath = path.resolve(valueOf('--ffmpeg', path.join(runtimeRoot, 'ffmpeg.exe')))
const ffprobePath = path.resolve(valueOf('--ffprobe', path.join(runtimeRoot, 'ffprobe.exe')))
const receiptPath = path.resolve(valueOf('--receipt', path.join(root, 'artifacts', 'acceptance', 'semantic-pause-edit', 'receipt.json')))
if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) throw new Error('缺少真实 ffmpeg/ffprobe，无法验收语义去停顿')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-semantic-pause-'))
const sourcePath = path.join(tempRoot, 'source.mp4')
const outputPath = path.join(tempRoot, 'source-AgentPlay去停顿版.mp4')
const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')

try {
  const generated = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0xAA3344:s=640x360:r=25:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-f', 'lavfi', '-i', 'color=c=0x222222:s=640x360:r=25:d=1.4',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1.4',
    '-f', 'lavfi', '-i', 'color=c=0x33AA66:s=640x360:r=25:d=2.6',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=2.6',
    '-f', 'lavfi', '-i', 'color=c=0x222222:s=640x360:r=25:d=1.5',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=1.5',
    '-f', 'lavfi', '-i', 'color=c=0x8844AA:s=640x360:r=25:d=2.5',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2.5',
    '-filter_complex', '[0:v][1:a][2:v][3:a][4:v][5:a][6:v][7:a][8:v][9:a]concat=n=5:v=1:a=1[vout][aout]',
    '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath
  ], { encoding: 'utf8', windowsHide: true })
  if (generated.status !== 0 || !fs.existsSync(sourcePath)) throw new Error(generated.stderr || '真实语义剪辑夹具生成失败')
  const sourceHash = sha256(sourcePath)
  const frames = new VideoFrameService({ ffmpegPath, ffprobePath })
  const semantic = new SemanticEditService({ frames })
  const planned = await semantic.plan({ instruction: '删掉超过1秒的长停顿', sourcePath })
  const decision = attachEditDecisionList(planned.decision)
  if (decision.semanticCut.removed.length !== 2) throw new Error(`应检测2处片中长停顿，实际 ${decision.semanticCut.removed.length}`)
  const service = new MediaEditService({ frames })
  const result = await service.concatSegments({ sourcePath, outputPath, decision })
  const actualDuration = await frames.probeDuration(outputPath)
  if (!fs.existsSync(outputPath) || Math.abs(actualDuration - decision.timeline.durationSeconds) > 0.25) throw new Error('真实去停顿成片时长不匹配')
  if (sha256(sourcePath) !== sourceHash) throw new Error('语义去停顿改写了原视频')
  const receipt = {
    acceptedAt: new Date().toISOString(),
    source: { bytes: fs.statSync(sourcePath).size, sha256: sourceHash, durationSeconds: await frames.probeDuration(sourcePath) },
    detection: decision.semanticCut,
    retainedSegments: decision.timeline.segments,
    output: { bytes: fs.statSync(outputPath).size, sha256: sha256(outputPath), durationSeconds: actualDuration },
    frameProof: result.frameProof,
    sourceUnchanged: true
  }
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true })
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ receiptPath, removed: receipt.detection.removed.map((item) => [item.startSeconds, item.endSeconds]), retained: receipt.retainedSegments.length, expectedDuration: decision.timeline.durationSeconds, actualDuration, sourceUnchanged: true })}\n`)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
