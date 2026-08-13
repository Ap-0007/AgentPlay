const path = require('path')

const CHINESE_DIGITS = Object.freeze({
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9
})

const NUMBER_TOKEN = String.raw`(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)`
const TIME_TOKEN = String.raw`(?:\d{1,3}:\d{2}(?:\.\d+)?|第?\s*${NUMBER_TOKEN}\s*(?:分(?:钟)?(?:\s*${NUMBER_TOKEN}\s*秒)?|秒|s))`
const RANGE_PATTERN = new RegExp(`(${TIME_TOKEN})\\s*(?:到|至|—|–|-|~|～)\\s*(${TIME_TOKEN})`, 'i')
const DIRECT_EDIT_PATTERN = /(?:保留|留下|截取|截出|剪出|剪辑|裁剪|取出)/
const REMOVE_EDIT_PATTERN = /(?:删除|删掉|剪掉|去掉|移除)/
const SEGMENT_REQUEST_PATTERN = /(?:我(?:只)?想要|我要|给我|替我)[\s\S]*(?:这|那)?(?:一)?段(?:视频|片段)/
const CONSULTATION_PATTERN = /(?:能不能|可不可以|是否|怎么|如何|支不支持|能做到|可以吗|行吗|\?|？)/
const NEGATION_PATTERN = /(?:不要|别把|别剪|无需|不用|取消|不想)/
const EXAMPLE_PATTERN = /(?:比如|例如|举例|假如|如果|假设|我说[“\"])/
const UNDO_EDIT_PATTERN = /^(?:(?:请|帮我|麻烦你?)\s*)?(?:撤销(?:刚才的剪辑|这次剪辑|上一步(?:剪辑)?|上一个(?:剪辑)?版本)|撤回(?:刚才的剪辑|上一步(?:剪辑)?)|回到剪辑前|退回上一个(?:剪辑)?版本)\s*[吧。！!]*$/
const REDO_EDIT_PATTERN = /^(?:(?:请|帮我|麻烦你?)\s*)?(?:重做(?:刚才撤销的剪辑|刚才的剪辑|下一步(?:剪辑)?)|恢复(?:刚才撤销的剪辑|下一个(?:剪辑)?版本)|回到下一个(?:剪辑)?版本)\s*[吧。！!]*$/

function chineseInteger(value) {
  const text = String(value || '')
  if (!text) return Number.NaN
  if (!/[十百]/.test(text)) {
    const digits = [...text].map((char) => CHINESE_DIGITS[char])
    if (digits.some((digit) => digit == null)) return Number.NaN
    return Number(digits.join(''))
  }
  let total = 0
  let current = 0
  for (const char of text) {
    if (char === '百') {
      total += (current || 1) * 100
      current = 0
    } else if (char === '十') {
      total += (current || 1) * 10
      current = 0
    } else if (CHINESE_DIGITS[char] != null) {
      current = CHINESE_DIGITS[char]
    } else {
      return Number.NaN
    }
  }
  return total + current
}

function parseNumber(value) {
  const text = String(value || '').trim()
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return chineseInteger(text)
}

function parseTimeSeconds(value) {
  const text = String(value || '').replace(/^第\s*/, '').replace(/\s+/g, '')
  const colon = /^(\d{1,3}):(\d{2}(?:\.\d+)?)$/.exec(text)
  if (colon) return Number(colon[1]) * 60 + Number(colon[2])
  const minutes = new RegExp(`^(${NUMBER_TOKEN})分(?:钟)?(?:(${NUMBER_TOKEN})秒)?$`).exec(text)
  if (minutes) return parseNumber(minutes[1]) * 60 + (minutes[2] ? parseNumber(minutes[2]) : 0)
  const seconds = new RegExp(`^(${NUMBER_TOKEN})(?:秒|s)$`, 'i').exec(text)
  return seconds ? parseNumber(seconds[1]) : Number.NaN
}

function formatSeconds(value) {
  const totalMilliseconds = Math.round(Number(value) * 1000)
  const minutes = Math.floor(totalMilliseconds / 60000)
  const seconds = Math.floor((totalMilliseconds % 60000) / 1000)
  const milliseconds = totalMilliseconds % 1000
  return `${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s${milliseconds ? `-${String(milliseconds).padStart(3, '0')}ms` : ''}`
}

function compileEditDecisionList({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim()
  const source = String(sourcePath || '').trim()
  if (!text || !source || /^(?:https?|blob):/i.test(source)) return null
  const removesRange = REMOVE_EDIT_PATTERN.test(text)
  if ((!DIRECT_EDIT_PATTERN.test(text) && !SEGMENT_REQUEST_PATTERN.test(text) && !removesRange) || CONSULTATION_PATTERN.test(text) || NEGATION_PATTERN.test(text) || EXAMPLE_PATTERN.test(text)) return null
  const range = RANGE_PATTERN.exec(text)
  if (!range) return null
  const startSeconds = parseTimeSeconds(range[1])
  const endSeconds = parseTimeSeconds(range[2])
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) return null
  const durationSeconds = Number((endSeconds - startSeconds).toFixed(3))
  if (removesRange) {
    return {
      schemaVersion: 1,
      kind: 'media.remove-segment',
      instruction: text,
      source: { path: source, name: path.basename(source) },
      timeline: { startSeconds, endSeconds, removedDurationSeconds: durationSeconds },
      operations: [{ type: 'remove', sourceStartSeconds: startSeconds, sourceEndSeconds: endSeconds }],
      output: {
        container: 'mp4',
        overwrite: false,
        suffix: `删除版-${formatSeconds(startSeconds)}-${formatSeconds(endSeconds)}`
      },
      verification: { removedDurationSeconds: durationSeconds, toleranceSeconds: 0.2 }
    }
  }
  return {
    schemaVersion: 1,
    kind: 'media.trim',
    instruction: text,
    source: { path: source, name: path.basename(source) },
    timeline: { startSeconds, endSeconds, durationSeconds },
    operations: [{ type: 'trim', sourceStartSeconds: startSeconds, sourceEndSeconds: endSeconds, targetStartSeconds: 0 }],
    output: {
      container: 'mp4',
      overwrite: false,
      suffix: `剪辑版-${formatSeconds(startSeconds)}-${formatSeconds(endSeconds)}`
    },
    verification: { expectedDurationSeconds: durationSeconds, toleranceSeconds: 0.2 }
  }
}

function compileEditHistoryAction(instruction) {
  const text = String(instruction || '').trim()
  if (!text || CONSULTATION_PATTERN.test(text) || NEGATION_PATTERN.test(text) || EXAMPLE_PATTERN.test(text)) return null
  if (UNDO_EDIT_PATTERN.test(text)) return { action: 'undo', instruction: text }
  if (REDO_EDIT_PATTERN.test(text)) return { action: 'redo', instruction: text }
  return null
}

module.exports = { compileEditDecisionList, compileEditHistoryAction, parseTimeSeconds, chineseInteger }
