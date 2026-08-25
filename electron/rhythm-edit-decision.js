const path = require('path')

const AUDIO_PATH_SOURCE = String.raw`["'“”‘’]?((?:[A-Za-z]:)?[\\/][^"'“”‘’，。；\n]+?\.(?:mp3|wav|m4a|aac|flac|ogg|wma))["'“”‘’]?`
const AUDIO_PATH = new RegExp(AUDIO_PATH_SOURCE, 'i')
const INTENT = /(?:按(?:音乐)?节拍|跟着(?:音乐)?节拍|卡点|踩点|鼓点切镜|高潮对齐|音乐高潮|片尾自然收束|节奏(?:更快|更克制))/
const ACTION = /(?:剪|切镜|卡点|踩点|对齐|收束|重剪|剪辑)/
const CONSULTATION = /(?:能不能|可不可以|是否|怎么|如何|支不支持|可以吗|行吗|\?|？)/
const EXAMPLE = /(?:比如|例如|举例|假如|如果|假设)/

function portableBasename(value) { return path.posix.basename(String(value || '').replaceAll('\\', '/')) }

function matchesRhythmEditInstruction(instruction) {
  const text = String(instruction || '').trim()
  return Boolean(text && INTENT.test(text) && ACTION.test(text) && !CONSULTATION.test(text) && !EXAMPLE.test(text))
}

function extractRhythmMusicPath(instruction) {
  return AUDIO_PATH.exec(String(instruction || ''))?.[1]?.trim() || ''
}

function pacePolicy(instruction) {
  const text = String(instruction || '')
  const fast = /(?:更快|快一点|节奏快|密一点|多切)/.test(text)
  const restrained = /(?:更克制|克制一点|慢一点|少切|舒缓一点)/.test(text)
  if (fast && restrained) throw new Error('节奏要求同时包含“更快”和“更克制”，请只保留一种')
  const pace = fast ? 'fast' : restrained ? 'restrained' : 'balanced'
  const presets = {
    fast: { baseBeatsPerCut: 2, highlightBeatsPerCut: 1, jumpGapSeconds: 0.14, tailFadeSeconds: 1.2 },
    balanced: { baseBeatsPerCut: 4, highlightBeatsPerCut: 2, jumpGapSeconds: 0.09, tailFadeSeconds: 1.5 },
    restrained: { baseBeatsPerCut: 8, highlightBeatsPerCut: 4, jumpGapSeconds: 0.04, tailFadeSeconds: 1.8 }
  }
  return { pace, ...presets[pace], minimumCutSeconds: 0.28, maximumCuts: 40 }
}

function compileRhythmEditRequest({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  if (!source || !matchesRhythmEditInstruction(text)) return null
  const musicPath = extractRhythmMusicPath(text)
  if (!musicPath) return {
    matched: true,
    review: { kind: 'rhythm-music-missing', summary: '要按真实音乐节拍剪辑，请拖入或明确提供一首本地音乐文件；我不会从未知网站自动抓取商业录音。', candidates: [] }
  }
  return {
    schemaVersion: 1,
    kind: 'media.rhythm-edit-request',
    instruction: text,
    source: { path: source, name: portableBasename(source) },
    music: { path: musicPath, name: portableBasename(musicPath) },
    policy: {
      schemaVersion: 1,
      strategy: 'pcm-beat-highlight-edit-v1',
      analysis: 'decoded-pcm-onset-grid-v1',
      ...pacePolicy(text),
      preserveDialogue: true,
      musicVolume: 0.22,
      dialogueDucking: true,
      outputLoudness: { targetLufs: -16, maxTruePeakDbtp: -1 }
    }
  }
}

module.exports = { compileRhythmEditRequest, extractRhythmMusicPath, matchesRhythmEditInstruction, pacePolicy }
