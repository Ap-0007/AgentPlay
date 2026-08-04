const fs = require('fs')
const path = require('path')

// PDF → DOCX 反向高保真（本地版式重建）：
// 文字层 PDF 按坐标聚类还原行/段落、按字号映射标题、按字体名尽力识别粗体，本机确定性完成、不依赖 Office。
// 边界如实告知：图片/复杂分栏/表格线不还原；无文字层（扫描件）直接报错并指引 OCR 路径。

const MAX_PAGES = 100

function extractPageLines(content) {
  const items = []
  for (const item of content.items) {
    const str = String(item.str || '').trim()
    if (!str) continue
    const style = content.styles?.[item.fontName]
    const family = `${item.fontName || ''} ${style?.fontFamily || ''}`
    items.push({
      str,
      x: item.transform[4],
      y: item.transform[5],
      h: Math.abs(item.transform[3]) || item.height || 10,
      bold: /bold|black|heavy|黑体|粗/i.test(family)
    })
  }
  // y 降序（PDF 原点在左下）聚类成行，容差 2pt；行内按 x 排序
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines = []
  for (const item of sorted) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - item.y) <= 2) last.items.push(item)
    else lines.push({ y: item.y, h: item.h, items: [item] })
  }
  return lines
}

async function pdfToDocxLayout(sourcePath, finalPath) {
  const { getDocumentProxy } = require('unpdf')
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak } = require('docx')
  const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(sourcePath)))
  try {
    if (pdf.numPages > MAX_PAGES) throw new Error(`PDF 共 ${pdf.numPages} 页，超过 ${MAX_PAGES} 页上限；请先拆分后再转换`)
    const pages = []
    const heights = []
    let totalItems = 0
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const lines = extractPageLines(await page.getTextContent())
      for (const line of lines) heights.push(line.h)
      totalItems += lines.reduce((sum, line) => sum + line.items.length, 0)
      pages.push(lines)
    }
    if (totalItems === 0) throw new Error('这个 PDF 没有文字层（扫描件）：请先用「提取文字」走 OCR 识别，再转换')
    heights.sort((a, b) => a - b)
    const medianH = heights[Math.floor(heights.length / 2)] || 10

    const children = []
    pages.forEach((lines, pageIndex) => {
      let prevLine = null
      for (const line of lines) {
        const text = line.items.map((item) => item.str).join('').trim()
        if (!text) continue
        const isHeading = line.h >= medianH * 1.5
        const gap = prevLine ? prevLine.y - line.y : 0
        children.push(new Paragraph({
          heading: isHeading ? HeadingLevel.HEADING_2 : undefined,
          spacing: { before: prevLine && gap > line.h * 1.6 ? 240 : 0 },
          children: [new TextRun({
            text,
            bold: !isHeading && line.items.some((item) => item.bold),
            size: Math.max(16, Math.round(Math.min(line.h, 36) * 2))
          })]
        }))
        prevLine = line
      }
      if (pageIndex < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }))
    })

    const doc = new Document({ sections: [{ children }] })
    const tempPath = `${finalPath}.${process.pid}.tmp`
    const outDir = path.dirname(finalPath)
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(tempPath, await Packer.toBuffer(doc))
    fs.renameSync(tempPath, finalPath)
    return { pages: pdf.numPages, paragraphs: children.length }
  } finally {
    if (typeof pdf.destroy === 'function') void pdf.destroy()
  }
}

module.exports = { pdfToDocxLayout }
