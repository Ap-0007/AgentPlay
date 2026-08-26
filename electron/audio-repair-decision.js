const path = require('path')

const CONSULTATION = /(?:能不能|可不可以|是否|怎么|如何|支不支持|可以吗|行吗|\?|？)/
const EXAMPLE = /(?:比如|例如|举例|假如|如果|假设)/
const DENOISE = /(?:降噪|去噪|减少底噪|清理底噪)/
const DC_REMOVAL = /(?:去直流|去除直流|直流偏移|去\s*DC|移除\s*DC)/i
const LOUDNESS = /(?:响度匹配|响度归一|响度标准化|统一响度)/
const SILENCE_REPAIR = /(?:静音修复|修复静音|修复断音|数字静音|静音断点)/
const SEPARATION = /(?:分离人声|人声.*伴奏.*分离|分离.*人声.*伴奏|提取人声|提取伴奏)/
const MUSIC_EDIT = /(?:(?:加|添加|配|换).{0,6}(?:背景音乐|配乐)|(?:背景音乐|配乐).{0,8}(?:加入|添加|使用)|用音乐第\s*\d)/

function portableBasename(value) { return path.posix.basename(String(value || '').replaceAll('\\', '/')) }

function targetLoudness(text) {
  const match = /(?:响度(?:匹配|归一(?:化)?|标准化)?(?:到|为)?|统一响度到)\s*(-?\d+(?:\.\d+)?)\s*LUFS/i.exec(String(text || ''))
  const value = match ? Number(match[1]) : -16
  return Number.isFinite(value) && value >= -24 && value <= -10 ? value : -16
}

function compileAudioRepairDecisionList({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim(); const source = String(sourcePath || '').trim()
  if (!text || !source || CONSULTATION.test(text) || EXAMPLE.test(text) || MUSIC_EDIT.test(text)) return null
  const actions = {
    denoise: DENOISE.test(text) && !/(?:不要|不用|取消|关闭).{0,4}(?:降噪|去噪)/.test(text),
    dcRemoval: DC_REMOVAL.test(text) && !/(?:不要|不用|取消|关闭).{0,4}(?:去直流|去除直流|去\s*DC)/i.test(text),
    loudnessMatch: LOUDNESS.test(text) && !/(?:不要|不用|取消|关闭).{0,4}(?:响度匹配|响度归一|统一响度)/.test(text),
    silenceRepair: SILENCE_REPAIR.test(text) && !/(?:不要|不用|取消|关闭).{0,4}(?:静音修复|修复静音)/.test(text),
    separation: SEPARATION.test(text) && !/(?:不要|不用|取消|关闭).{0,5}(?:分离人声|人声伴奏分离|提取人声|提取伴奏)/.test(text)
  }
  if (!Object.values(actions).some(Boolean)) return null
  const repair = {
    schemaVersion: 1,
    strategy: 'ffmpeg-audio-repair-v1',
    denoise: { enabled: actions.denoise, method: 'afftdn-adaptive-v1', noiseReductionDb: 12, noiseFloorDb: -25 },
    dcRemoval: { enabled: actions.dcRemoval, method: 'highpass-dc-block-v1', cutoffHz: 20 },
    loudness: { enabled: actions.loudnessMatch, targetLufs: targetLoudness(text), targetTruePeakDbtp: -1.5, maxTruePeakDbtp: -1, lra: 11, toleranceLufs: 0.7 },
    silenceRepair: { enabled: actions.silenceRepair, method: 'short-gap-room-tone-v1', minimumGapSeconds: 0.05, maximumGapSeconds: 0.3, fillAmplitude: 0.004, maximumGapCount: 12, restoresSpeech: false },
    separation: {
      enabled: actions.separation,
      method: 'stereo-mid-side-v1',
      requiresStereo: true,
      artifactWarning: '基础分离只利用立体声中置/侧声道差异；混响、偏置人声和中置乐器可能串入，人声或伴奏也可能变薄。这不是AI专业分轨。',
      outputs: actions.separation ? [{ role: 'voice', suffix: '基础人声轨' }, { role: 'accompaniment', suffix: '基础伴奏轨' }] : []
    }
  }
  const enabledLabels = [actions.denoise ? '降噪' : '', actions.dcRemoval ? '去直流' : '', actions.loudnessMatch ? '响度匹配' : '', actions.silenceRepair ? '短静音修复' : '', actions.separation ? '基础分离' : ''].filter(Boolean)
  return {
    schemaVersion: 1,
    kind: 'media.repair-audio',
    instruction: text,
    source: { path: source, name: portableBasename(source) },
    audioRepair: repair,
    output: { container: 'mp4', overwrite: false, suffix: `音频修复版-${enabledLabels.join('-')}` },
    verification: { toleranceSeconds: 0.2, requireAudioRepairProof: true, requireArtifactWarning: actions.separation }
  }
}

module.exports = { compileAudioRepairDecisionList, targetLoudness }
