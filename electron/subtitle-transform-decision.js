const path = require('node:path')

const SUBTITLE_PATH_PATTERN = /["'“”‘’]?((?:[A-Za-z]:)?[\\/][^"'“”‘’，。；;\n]+?\.srt)["'“”‘’]?/i
const TRANSFORM_INTENT = /批量处理字幕|批量改字幕|批量字幕|字幕[^。；]{0,20}(?:合并|拆分|拆成|风格|改字)|第\s*\d+\s*条[^。；]{0,20}(?:合并|拆分|拆成)/
const CONSULTATION = /能不能|可不可以|可以吗|是否|怎么|如何|支不支持|\?|？/
const NEGATION_OR_EXAMPLE = /不要|不用|取消|比如|例如|假如|如果|举例/

function portableBasename(value) { return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '' }
function subtitlePathOf(text) { return SUBTITLE_PATH_PATTERN.exec(String(text || ''))?.[1]?.trim() || '' }
function positiveIndex(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : 0 }

function compileSubtitleTransformDecision({ instruction, sourcePath } = {}) {
  const text = String(instruction || '').trim(); const source = String(sourcePath || '').trim()
  if (!text || CONSULTATION.test(text) || NEGATION_OR_EXAMPLE.test(text) || !TRANSFORM_INTENT.test(text)) return { matched: false }
  const subtitlePath = subtitlePathOf(text)
  if (!subtitlePath) return { matched: true, review: { kind: 'subtitle-transform-clarification', summary: '要批量处理哪个SRT字幕？请给出完整路径，或把字幕文件拖进对话。', candidates: [] } }

  const replacements = [...text.matchAll(/第\s*(\d+)\s*条(?:字幕)?\s*(?:改成|改为|换成)《([^》]{1,500})》/g)].map((match) => ({ index: positiveIndex(match[1]), text: match[2].trim() })).filter((item) => item.index && item.text)
  const merges = [...text.matchAll(/合并第\s*(\d+)\s*(?:条)?\s*(?:到|至|—|- )\s*第?\s*(\d+)\s*条/g)].map((match) => ({ startIndex: positiveIndex(match[1]), endIndex: positiveIndex(match[2]), separator: ' ' })).filter((item) => item.startIndex && item.endIndex > item.startIndex)
  const splits = [...text.matchAll(/第\s*(\d+)\s*条(?:字幕)?\s*(?:在|于)\s*(\d+(?:\.\d+)?)\s*秒(?:处)?\s*(?:拆成|拆分成)《([^》]{1,500})》/g)].map((match) => ({ index: positiveIndex(match[1]), atSeconds: Number(match[2]), parts: match[3].split(/[｜|]/).map((item) => item.trim()).filter(Boolean) })).filter((item) => item.index && item.atSeconds > 0 && item.parts.length === 2)
  if (/(?:拆成|拆分成)《/.test(text) && !splits.length) return { matched: true, review: { kind: 'subtitle-transform-split-time', summary: '拆分字幕需要明确秒点，例如“第4条在8.2秒拆成《前半｜后半》”；没有真实逐词边界时不按字符比例猜时间。', candidates: [] } }

  let shift = null
  const shiftMatch = /(?:整体)?\s*(提前|延后|推迟)\s*(\d+(?:\.\d+)?)\s*秒/.exec(text)
  if (shiftMatch) shift = { direction: shiftMatch[1] === '提前' ? 'earlier' : 'later', offsetSeconds: Number(shiftMatch[2]) }
  let translate = null
  const translateMatch = /(?:翻译|译)(?:成|为)\s*(中文|英文|双语)/.exec(text)
  if (translateMatch) translate = translateMatch[1] === '双语' ? { targetLang: 'auto', mode: 'bilingual' } : { targetLang: translateMatch[1], mode: 'translated' }
  let style = null
  const styleMatch = /(?:风格|样式)(?:改成|改为|换成|设为|设置成)?\s*(强调|冲击|简洁|纪录片)/.exec(text)
  if (styleMatch) style = { preset: /强调|冲击/.test(styleMatch[1]) ? 'impact' : styleMatch[1] === '纪录片' ? 'documentary' : 'clean' }

  const operationKinds = [replacements.length ? 'replace' : '', merges.length ? 'merge' : '', splits.length ? 'split' : '', shift ? 'shift' : '', translate ? 'translate' : '', style ? 'style' : ''].filter(Boolean)
  if (!operationKinds.length) return { matched: true, review: { kind: 'subtitle-transform-clarification', summary: '请说明要改哪些字幕文字、合并或拆分哪些条目、整体提前/延后几秒、翻译方向或目标风格。', candidates: [] } }

  const occupied = new Set()
  for (const merge of merges) {
    for (let index = merge.startIndex; index <= merge.endIndex; index += 1) {
      if (occupied.has(index)) return { matched: true, review: { kind: 'subtitle-transform-conflict', summary: `第${index}条同时落入多个合并/拆分范围，请把结构操作改成互不重叠。`, candidates: [] } }
      occupied.add(index)
    }
  }
  for (const split of splits) {
    if (occupied.has(split.index)) return { matched: true, review: { kind: 'subtitle-transform-conflict', summary: `第${split.index}条不能同时合并和拆分，请保留一个结构操作。`, candidates: [] } }
    occupied.add(split.index)
  }
  if (new Set(replacements.map((item) => item.index)).size !== replacements.length) return { matched: true, review: { kind: 'subtitle-transform-conflict', summary: '同一条字幕出现了多次改字，请只保留最终文本。', candidates: [] } }
  if (replacements.length > 50 || merges.length > 20 || splits.length > 20) return { matched: true, review: { kind: 'subtitle-transform-limit', summary: '单次批量字幕变换过多，请拆成两次处理（改字最多50条，合并/拆分各最多20处）。', candidates: [] } }

  const subtitleTransform = { schemaVersion: 1, strategy: 'ordered-subtitle-transform-v1', replacements, merges, splits, ...(shift ? { shift } : {}), ...(translate ? { translate } : {}), ...(style ? { style } : {}), operationKinds }
  const container = style ? 'ass' : 'srt'
  return {
    matched: true,
    decision: {
      schemaVersion: 1, kind: 'media.transform-subtitles', instruction: text,
      source: { path: source, name: portableBasename(source) || path.basename(source) },
      subtitle: { path: subtitlePath, name: portableBasename(subtitlePath) }, subtitleTransform,
      output: { container, overwrite: false, suffix: `批量字幕版-${operationKinds.join('-')}` },
      verification: { expectedOperationKinds: operationKinds, exactStructureRequired: true }
    }
  }
}

module.exports = { compileSubtitleTransformDecision, portableBasename, subtitlePathOf }
