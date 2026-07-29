// 文档脱敏：文本类直换、DOCX 走 XML 文本节点掩码（样式无损）、XLSX 单元格掩码。
// 输出一律另存为新文件，原文件不动；命中统计如实汇报，不夸大覆盖率。
const fs = require('fs')
const path = require('path')
const JSZip = require('jszip')
const ExcelJS = require('exceljs')

const PII_RULES = [
  { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g, mask: (m) => `${m.slice(0, 3)}****${m.slice(7)}` },
  { name: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/g, mask: (m) => `${m.slice(0, 6)}********${m.slice(14)}` },
  { name: '银行卡号', re: /(?<!\d)\d{16,19}(?!\d)/g, mask: (m) => `**** **** **** ${m.slice(-4)}` },
  { name: '邮箱', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, mask: (m) => `${m[0]}***@${m.split('@')[1]}` }
]

const TEXT_EXTS = ['.txt', '.md', '.csv', '.json', '.srt', '.vtt']
const TEXT_NODE_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function maskText(text, rules = PII_RULES) {
  const hits = new Map()
  let out = String(text)
  for (const rule of rules) {
    out = out.replace(rule.re, (match) => {
      hits.set(rule.name, (hits.get(rule.name) || 0) + 1)
      return rule.mask(match)
    })
  }
  return { text: out, hits: [...hits.entries()].map(([name, count]) => ({ name, count })) }
}

function summarizeHits(hits, detail = '') {
  if (!hits.length) return '未检测到手机号/身份证/银行卡/邮箱等敏感信息' + (detail ? `（${detail}）` : '')
  const total = hits.reduce((sum, hit) => sum + hit.count, 0)
  return `已脱敏 ${total} 处（${hits.map((hit) => `${hit.name} ${hit.count} 处`).join('，')}）`
}

async function redactDocument(sourcePath, finalPath) {
  const ext = path.extname(sourcePath).toLowerCase()
  if (TEXT_EXTS.includes(ext)) {
    const { text, hits } = maskText(fs.readFileSync(sourcePath, 'utf8'))
    writeOut(finalPath, text)
    return summarizeHits(hits)
  }
  if (ext === '.docx') {
    const archive = await JSZip.loadAsync(fs.readFileSync(sourcePath))
    const documentFile = archive.file('word/document.xml')
    if (!documentFile) throw new Error('不是有效的 DOCX（缺少 word/document.xml）')
    const xml = await documentFile.async('string')
    const allHits = new Map()
    const maskedXml = xml.replace(TEXT_NODE_RE, (whole, inner) => {
      const plain = inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      const { text, hits } = maskText(plain)
      for (const hit of hits) allHits.set(hit.name, (allHits.get(hit.name) || 0) + hit.count)
      return whole.replace(inner, escapeXml(text))
    })
    archive.file('word/document.xml', maskedXml)
    writeOut(finalPath, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
    return summarizeHits([...allHits.entries()].map(([name, count]) => ({ name, count })), 'DOCX 样式与未涉及内容保持原样')
  }
  if (ext === '.xlsx') {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(sourcePath)
    const allHits = new Map()
    for (const sheet of workbook.worksheets) {
      sheet.eachRow({ includeEmpty: true }, (row) => {
        for (const cell of row.values.slice(1)) {
          if (cell && typeof cell.value === 'string') {
            const { text, hits } = maskText(cell.value)
            if (hits.length) {
              cell.value = text
              for (const hit of hits) allHits.set(hit.name, (allHits.get(hit.name) || 0) + hit.count)
            }
          }
        }
      })
    }
    await workbook.xlsx.writeFile(finalPath)
    return summarizeHits([...allHits.entries()].map(([name, count]) => ({ name, count })), '表格结构与公式保持原样')
  }
  throw new Error(`暂不支持脱敏的格式：${ext || '未知'}（支持 txt/md/csv/json/srt/vtt、docx、xlsx）`)
}

function writeOut(finalPath, content) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  if (Buffer.isBuffer(content)) fs.writeFileSync(tempPath, content)
  else fs.writeFileSync(tempPath, content, 'utf8')
  fs.renameSync(tempPath, finalPath)
}

module.exports = { redactDocument, maskText, PII_RULES, TEXT_EXTS }
