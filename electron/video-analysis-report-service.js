const fs = require('fs')
const crypto = require('crypto')
const {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType
} = require('docx')

const BLUE = '2676B8'
const DARK_BLUE = '164E7A'
const INK = '172033'
const MUTED = '6B7890'
const PALE_BLUE = 'EAF2F9'
const PALE_GRAY = 'F2F5F8'
const BORDER = 'CBD5E1'
const FONT = 'Microsoft YaHei'
const CONTENT_WIDTH = 9000

function textRuns(value, { size = 21, color = INK, italic = false } = {}) {
  const text = String(value || '')
  const runs = []
  let cursor = 0
  for (const match of text.matchAll(/\*\*([^*]+)\*\*/g)) {
    if (match.index > cursor) runs.push(new TextRun({ text: text.slice(cursor, match.index), font: FONT, size, color, italics: italic }))
    runs.push(new TextRun({ text: match[1], font: FONT, size, color, bold: true, italics: italic }))
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) runs.push(new TextRun({ text: text.slice(cursor), font: FONT, size, color, italics: italic }))
  return runs.length ? runs : [new TextRun({ text: ' ', font: FONT, size, color })]
}

function heading(text, level) {
  const sizes = { [HeadingLevel.HEADING_1]: 34, [HeadingLevel.HEADING_2]: 27, [HeadingLevel.HEADING_3]: 23 }
  return new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 300 : 220, after: 130 },
    keepNext: true,
    children: [new TextRun({ text, font: FONT, size: sizes[level] || 23, bold: true, color: level === HeadingLevel.HEADING_1 ? BLUE : DARK_BLUE })]
  })
}

function borders(color = BORDER, size = 4) {
  const edge = { style: BorderStyle.SINGLE, size, color }
  return { top: edge, bottom: edge, left: edge, right: edge, insideHorizontal: edge, insideVertical: edge }
}

function parseTableRow(line) {
  return String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function markdownTable(lines) {
  const rows = lines.map(parseTableRow)
  const columnCount = Math.max(...rows.map((row) => row.length), 1)
  const widths = Array.from({ length: columnCount }, () => Math.floor(CONTENT_WIDTH / columnCount))
  return new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    columnWidths: widths,
    borders: borders(),
    rows: rows.map((row, rowIndex) => new TableRow({
      tableHeader: rowIndex === 0,
      cantSplit: true,
      children: Array.from({ length: columnCount }, (_, index) => new TableCell({
        width: { size: widths[index], type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
        shading: rowIndex === 0 ? { type: ShadingType.CLEAR, fill: PALE_BLUE } : undefined,
        margins: { top: 90, bottom: 90, left: 110, right: 110 },
        children: [new Paragraph({
          spacing: { after: 0 },
          children: textRuns(row[index] || '', { size: rowIndex === 0 ? 19 : 18, color: rowIndex === 0 ? DARK_BLUE : INK })
        })]
      }))
    }))
  })
}

function jpegDimensions(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
  for (let offset = 2; offset + 9 < buffer.length;) {
    if (buffer[offset] !== 0xff) { offset += 1; continue }
    const marker = buffer[offset + 1]
    const length = buffer.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xc3 && length >= 7) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    if (!Number.isFinite(length) || length < 2) break
    offset += length + 2
  }
  return { width: 16, height: 9 }
}

function containSize(data, maxWidth = 245, maxHeight = 150) {
  const { width, height } = jpegDimensions(data)
  const scale = Math.min(maxWidth / Math.max(width, 1), maxHeight / Math.max(height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function selectFrames(frames, limit = 6) {
  const source = Array.isArray(frames) ? frames.filter((frame) => Buffer.isBuffer(frame?.data) && frame.data.length) : []
  if (source.length <= limit) return source
  return Array.from({ length: limit }, (_, index) => source[Math.round(index * (source.length - 1) / (limit - 1))])
}

function frameEvidence(frames) {
  const selected = selectFrames(frames)
  if (!selected.length) return []
  const result = [heading('关键画面证据', HeadingLevel.HEADING_2)]
  for (let index = 0; index < selected.length; index += 2) {
    const pair = selected.slice(index, index + 2)
    result.push(new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      columnWidths: [Math.floor(CONTENT_WIDTH / 2), Math.floor(CONTENT_WIDTH / 2)],
      borders: borders('FFFFFF', 0),
      rows: [new TableRow({
        cantSplit: true,
        children: pair.map((frame) => {
          const size = containSize(frame.data)
          return new TableCell({
            width: { size: Math.floor(CONTENT_WIDTH / 2), type: WidthType.DXA },
            margins: { top: 50, bottom: 60, left: 60, right: 60 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 60 },
                children: [new ImageRun({ data: frame.data, type: 'jpg', transformation: size })]
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 0 },
                children: [new TextRun({ text: frame.label || '关键帧', font: FONT, size: 17, color: MUTED, italics: true })]
              })
            ]
          })
        }).concat(pair.length === 1 ? [new TableCell({ children: [new Paragraph('')] })] : [])
      })]
    }))
  }
  return result
}

function markdownBlocks(content, frames) {
  const lines = String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/)
  const blocks = []
  let secondPartSeen = false
  let framesInserted = false
  for (let index = 0; index < lines.length;) {
    const raw = lines[index]
    const line = raw.trim()
    if (!line || /^---+$/.test(line)) { index += 1; continue }
    if (/^\|/.test(line) && index + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[index + 1].trim())) {
      const tableLines = [line]
      index += 2 // 跳过 Markdown 分隔行
      while (index < lines.length && /^\|/.test(lines[index].trim())) {
        tableLines.push(lines[index].trim())
        index += 1
      }
      blocks.push(markdownTable(tableLines))
      continue
    }
    if (/^```/.test(line)) {
      const code = []
      index += 1
      while (index < lines.length && !/^```/.test(lines[index].trim())) { code.push(lines[index]); index += 1 }
      index += 1
      blocks.push(new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: PALE_GRAY },
        spacing: { before: 80, after: 120, line: 280 },
        indent: { left: 160, right: 120 },
        children: [new TextRun({ text: code.join('\n'), font: 'Consolas', size: 18, color: INK })]
      }))
      continue
    }
    if (/^##\s+/.test(line)) {
      const title = line.replace(/^##\s+/, '')
      secondPartSeen = /^第二部分/.test(title)
      blocks.push(heading(title, HeadingLevel.HEADING_1))
      if (secondPartSeen && !framesInserted) {
        blocks.push(...frameEvidence(frames))
        framesInserted = true
      }
      index += 1
      continue
    }
    if (/^###\s+/.test(line)) { blocks.push(heading(line.replace(/^###\s+/, ''), HeadingLevel.HEADING_2)); index += 1; continue }
    if (/^####\s+/.test(line)) { blocks.push(heading(line.replace(/^####\s+/, ''), HeadingLevel.HEADING_3)); index += 1; continue }
    if (/^#\s+/.test(line)) { index += 1; continue }
    if (/^>\s?/.test(line)) {
      blocks.push(new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: PALE_BLUE },
        border: { left: { style: BorderStyle.SINGLE, size: 18, color: BLUE, space: 8 } },
        spacing: { before: 60, after: 90, line: 330 },
        indent: { left: 140, right: 100 },
        children: textRuns(line.replace(/^>\s?/, ''), { size: 19, color: DARK_BLUE })
      }))
      index += 1
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    const numbered = line.match(/^\d+[.)、]\s*(.+)$/)
    if (bullet || numbered) {
      blocks.push(new Paragraph({
        bullet: bullet ? { level: 0 } : undefined,
        spacing: { after: 80, line: 330 },
        indent: numbered ? { left: 240, hanging: 180 } : undefined,
        children: textRuns(numbered ? `${line.match(/^\d+/)[0]}. ${numbered[1]}` : bullet[1], { size: 20 })
      }))
      index += 1
      continue
    }
    blocks.push(new Paragraph({
      spacing: { after: 110, line: 350 },
      keepLines: true,
      children: textRuns(line, { size: 20 })
    }))
    index += 1
  }
  return blocks
}

async function writeProfessionalVideoAnalysisDocx(finalPath, { title, content, frames = [] } = {}) {
  const header = new Header({ children: [new Paragraph({
    alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: 'AGENTPLAY · VIDEO DECONSTRUCTION', font: FONT, size: 16, color: MUTED, bold: true })]
  })] })
  const footer = new Footer({ children: [new Paragraph({
    alignment: AlignmentType.RIGHT,
    children: [new TextRun({ text: 'AgentPlay · 专业复刻分析　', font: FONT, size: 16, color: MUTED }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: MUTED })]
  })] })
  const children = [
    new Paragraph({ spacing: { before: 420, after: 120 }, children: [new TextRun({ text: '视频专业复刻简报', font: FONT, size: 24, bold: true, color: BLUE })] }),
    new Paragraph({ spacing: { after: 160 }, keepNext: true, children: [new TextRun({ text: String(title || '专业拉片与 AI 复刻报告'), font: FONT, size: 42, bold: true, color: INK })] }),
    new Paragraph({ spacing: { after: 260 }, children: [new TextRun({ text: '内容精华 × 全镜头语言 × AI 微改复刻方案', font: FONT, size: 24, color: DARK_BLUE })] }),
    ...markdownBlocks(content, frames)
  ]
  const doc = new Document({
    creator: 'AgentPlay',
    title: String(title || '专业拉片与 AI 复刻报告'),
    description: 'AgentPlay 两部分专业视频拉片报告',
    styles: { default: { document: { run: { font: FONT, size: 20, color: INK }, paragraph: { spacing: { line: 340 } } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 480, footer: 480 } } },
      headers: { default: header },
      footers: { default: footer },
      children
    }]
  })
  const buffer = await Packer.toBuffer(doc)
  const temp = `${finalPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temp, buffer)
  fs.renameSync(temp, finalPath)
  return { bytes: buffer.length, frameCount: selectFrames(frames).length }
}

module.exports = {
  jpegDimensions,
  selectFrames,
  writeProfessionalVideoAnalysisDocx
}
