const path = require('path')

const AUDIO_PATH_SOURCE = String.raw`["'“”‘’]?((?:[A-Za-z]:)?[\\/][^"'“”‘’，。；\n]+?\.(?:mp3|wav|m4a|aac|flac|ogg|wma))["'“”‘’]?`
const AUDIO_PATH_GLOBAL = new RegExp(AUDIO_PATH_SOURCE, 'gi')
const CONSULTATION = /(?:能不能|可不可以|是否|怎么|如何|支不支持|可以吗|行吗|\?|？)/
const EXAMPLE = /(?:比如|例如|举例|假如|如果|假设)/
const MULTITRACK_INTENT = /(?:多轨|环境声|氛围声|音效|提示音|对白|原声|自动闪避|分段音量)/
const ROLE_REMOVAL = /(?:(?:去掉|删除|移除|关闭|静音|不要).{0,5}(?:背景音乐|音乐轨|环境声|氛围声|音效|提示音|对白|原声)|(?:背景音乐|音乐轨|环境声|氛围声|音效|提示音|对白|原声).{0,5}(?:去掉|删除|移除|关闭|静音|不要))/
const NO_DUCK = /(?:不要|关闭|取消|不做).{0,6}(?:对白闪避|自动闪避|duck)/i
const NO_LOOP = /(?:只播放一次|只播一次|不要循环|不循环|别循环)/
const DEFAULT_LOUDNESS = Object.freeze({
  enabled: true,
  targetLufs: -16,
  targetTruePeakDbtp: -1.5,
  maxTruePeakDbtp: -1,
  lra: 11,
  toleranceLufs: 0.7
})

function portableBasename(value) {
  return path.posix.basename(String(value || '').replaceAll('\\', '/'))
}

function extractAudioPathMatches(text) {
  return [...String(text || '').matchAll(AUDIO_PATH_GLOBAL)].map((match) => ({ path: match[1].trim(), index: match.index || 0, raw: match[0] }))
}

function clauseAround(text, index) {
  const source = String(text || '')
  const before = Math.max(source.lastIndexOf('，', index), source.lastIndexOf(',', index), source.lastIndexOf('；', index), source.lastIndexOf(';', index), source.lastIndexOf('\n', index))
  const candidates = ['，', ',', '；', ';', '\n'].map((token) => source.indexOf(token, index)).filter((value) => value >= 0)
  const after = candidates.length ? Math.min(...candidates) : source.length
  return source.slice(before + 1, after).trim()
}

function roleOf(text) {
  const value = String(text || '')
  if (/(?:环境声|氛围声|环境音|氛围音|雨声|风声|街道声|室内声)/.test(value)) return 'ambience'
  if (/(?:音效|提示音|转场音|鼓点|点击声|爆炸声|铃声)/.test(value)) return 'sfx'
  if (/(?:对白|人声|原声)/.test(value)) return 'dialogue'
  return 'music'
}

function percentVolume(text, fallback) {
  const match = /(?:音量|声音|调到|降到|改为)[^\d]{0,6}(\d+(?:\.\d+)?)\s*%/.exec(String(text || ''))
  if (!match) return fallback
  const value = Number(match[1]) / 100
  return Number.isFinite(value) && value >= 0 && value <= 1 ? Number(value.toFixed(3)) : fallback
}

function seconds(value) {
  const parsed = Number(String(value || '').trim())
  return Number.isFinite(parsed) ? Number(parsed.toFixed(3)) : null
}

function targetRange(text) {
  const value = String(text || '')
  const range = /(?:从|在|放在)?\s*第?\s*(\d+(?:\.\d+)?)\s*秒\s*(?:到|至|—|–|-|~|～)\s*第?\s*(\d+(?:\.\d+)?)\s*秒/.exec(value)
  if (range) {
    const startSeconds = seconds(range[1]); const endSeconds = seconds(range[2])
    if (startSeconds != null && endSeconds != null && startSeconds >= 0 && endSeconds > startSeconds) return { startSeconds, endSeconds }
  }
  const start = /(?:从|在|放在)\s*第?\s*(\d+(?:\.\d+)?)\s*秒(?:开始|进入|出现|播放|响起)?/.exec(value)
  const startSeconds = start ? seconds(start[1]) : 0
  return { startSeconds: startSeconds != null && startSeconds >= 0 ? startSeconds : 0 }
}

function automationFromClause(clause, role) {
  if (extractAudioPathMatches(clause).length) return null
  if (roleOf(clause) !== role) return null
  const range = targetRange(clause)
  const volume = percentVolume(clause, null)
  if (volume == null || range.endSeconds == null) return null
  return { startSeconds: range.startSeconds, endSeconds: range.endSeconds, volume }
}

function splitClauses(text) {
  return String(text || '').split(/[，,；;\n]+/).map((item) => item.trim()).filter(Boolean)
}

function extractLoudness(text) {
  if (/(?:不要|不做|关闭|取消).{0,6}(?:响度归一|响度标准化|音量归一)/.test(text)) return { ...DEFAULT_LOUDNESS, enabled: false }
  const match = /(?:响度(?:归一(?:化)?|标准化)?(?:到|为)?|归一(?:化)?到)\s*(-?\d+(?:\.\d+)?)\s*LUFS/i.exec(text)
  const target = match ? Number(match[1]) : DEFAULT_LOUDNESS.targetLufs
  return { ...DEFAULT_LOUDNESS, targetLufs: Number.isFinite(target) && target >= -24 && target <= -10 ? target : DEFAULT_LOUDNESS.targetLufs }
}

function isAudioMixIntent(text) {
  const source = String(text || '')
  const paths = extractAudioPathMatches(source)
  return paths.length >= 2 || (paths.length >= 1 && MULTITRACK_INTENT.test(source)) || (/(?:去掉|删除|静音).{0,5}(?:对白|原声)/.test(source) && paths.length >= 1)
}

function compileAudioMixDecisionList({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  if (!text || !source || CONSULTATION.test(text) || EXAMPLE.test(text) || !isAudioMixIntent(text)) return null
  const matches = extractAudioPathMatches(text)
  if (!matches.length || matches.length > 8) return null
  const clauses = splitClauses(text)
  const removedRoles = [...new Set(clauses.filter((clause) => ROLE_REMOVAL.test(clause)).map(roleOf))]
  const dialogueRemoved = removedRoles.includes('dialogue') || /(?:去掉|删除|关闭|静音|不要).{0,5}(?:对白|原声)|(?:对白|原声).{0,5}(?:去掉|删除|关闭|静音)/.test(text)
  const dialogueBaseClause = clauses.find((clause) => roleOf(clause) === 'dialogue' && /音量|声音|调到|降到|改为/.test(clause) && targetRange(clause).endSeconds == null) || ''
  const dialogue = {
    enabled: !dialogueRemoved,
    volume: percentVolume(dialogueBaseClause, 1),
    automation: clauses.map((clause) => automationFromClause(clause, 'dialogue')).filter(Boolean)
  }
  const counters = { music: 0, ambience: 0, sfx: 0 }
  const tracks = []
  for (const match of matches) {
    const clause = clauseAround(text, match.index)
    const role = roleOf(clause)
    if (role === 'dialogue' || (ROLE_REMOVAL.test(clause) && removedRoles.includes(role))) continue
    counters[role] += 1
    const alignment = targetRange(clause)
    const defaults = role === 'music' ? 0.15 : role === 'ambience' ? 0.12 : 0.35
    const loop = role !== 'sfx' && !NO_LOOP.test(clause)
    const automation = clauses.map((item) => automationFromClause(item, role)).filter(Boolean)
    tracks.push({
      id: `${role}-${counters[role]}`,
      role,
      path: match.path,
      name: portableBasename(match.path),
      volume: percentVolume(clause, defaults),
      startSeconds: alignment.startSeconds,
      ...(alignment.endSeconds != null ? { endSeconds: alignment.endSeconds } : {}),
      loop,
      duckAgainstDialogue: role !== 'sfx' && !NO_DUCK.test(text),
      fadeInSeconds: role === 'sfx' ? 0.02 : 0.5,
      fadeOutSeconds: role === 'sfx' ? 0.05 : 0.8,
      automation
    })
  }
  if (!tracks.length) return null
  return {
    schemaVersion: 1,
    kind: 'media.mix-audio',
    instruction: text,
    source: { path: source, name: portableBasename(source) },
    audioMix: {
      schemaVersion: 1,
      strategy: 'multitrack-audio-mix-v1',
      dialogue,
      tracks,
      removedRoles,
      master: { loudness: extractLoudness(text), limiter: { limit: 0.85, autoLevel: false } }
    },
    output: { container: 'mp4', overwrite: false, suffix: `多轨混音-${tracks.length + (dialogue.enabled ? 1 : 0)}轨` },
    verification: { toleranceSeconds: 0.2, requireTrackAlignment: true, requireAutomationReceipt: true, requireDuckingReceipt: true }
  }
}

module.exports = { compileAudioMixDecisionList, extractAudioPathMatches, isAudioMixIntent, roleOf, targetRange }
