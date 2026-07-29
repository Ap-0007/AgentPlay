const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { redactDocument, maskText } = require('../electron/redact-service')
const { splitParagraphs } = require('../electron/bilingual-reflow-service')
const { clusterRows, clusterColumns, recoverTable } = require('../electron/table-recovery-service')

test('maskText covers phone, ID, bank card and email with boundaries', () => {
  const { text, hits } = maskText('联系我13800138000或010-12345678，身份证11010119900307777X，卡号6222021234567890123，邮箱 a.b-c@example.com。')
  assert.ok(text.includes('138****8000'))
  assert.ok(text.includes('110101********777X'))
  assert.ok(text.includes('**** **** **** 0123'))
  assert.ok(text.includes('a***@example.com'))
  assert.equal(hits.length, 4)
  const clean = maskText('没有任何敏感信息的普通句子。')
  assert.equal(clean.hits.length, 0)
})

test('redactDocument masks txt and reports hits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-'))
  const source = path.join(dir, '客户名单.txt')
  fs.writeFileSync(source, '张三 13912345678\n李四 110101199001011234\n')
  const out = path.join(dir, 'out.txt')
  const summary = await redactDocument(source, out)
  const content = fs.readFileSync(out, 'utf8')
  assert.ok(content.includes('139****5678'))
  assert.ok(content.includes('110101********1234'))
  assert.match(summary, /已脱敏 2 处/)
  assert.ok(fs.readFileSync(source, 'utf8').includes('13912345678'), '原文件必须保持不动')
})

test('redactDocument masks docx text nodes without touching styles', async () => {
  const { Document, Packer, Paragraph, TextRun } = require('docx')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-docx-'))
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: '联系人电话 13800138000，谢谢。', bold: true })] })
      ]
    }]
  })
  const source = path.join(dir, 'in.docx')
  fs.writeFileSync(source, await Packer.toBuffer(doc))
  const out = path.join(dir, 'out.docx')
  const summary = await redactDocument(source, out)
  const JSZip = require('jszip')
  const zip = await JSZip.loadAsync(fs.readFileSync(out))
  const xml = await zip.file('word/document.xml').async('string')
  assert.ok(xml.includes('138****8000'))
  assert.ok(!xml.includes('13800138000'))
  assert.ok(await zip.file('word/styles.xml'), '样式部件必须在')
  assert.match(summary, /已脱敏 1 处/)
})

test('bilingual reflow paragraph splitting respects caps and skips page markers', () => {
  const text = Array.from({ length: 250 }, (_, i) => `第 ${i} 段`).join('\n\n') + '\n## 第 1 页\n尾段'
  const paragraphs = splitParagraphs(text)
  assert.equal(paragraphs.length, 200)
  assert.ok(!paragraphs.some((p) => /^## 第/.test(p)))
})

test('table recovery clusters a clean 3x3 grid from word boxes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-'))
  const words = []
  const xs = [10, 200, 400]
  const ys = [10, 40, 70]
  const data = [['姓名', '部门', '分数'], ['张三', '研发部', '91'], ['李四', '市场部', '88']]
  data.forEach((row, r) => row.forEach((text, c) => words.push({ x: xs[c], y: ys[r], w: 60, h: 16, text })))
  const out = path.join(dir, 'out.xlsx')
  const info = await recoverTable({ words, finalPath: out })
  assert.equal(info.rows, 3)
  assert.equal(info.cols, 3)
  const ExcelJS = require('exceljs')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(out)
  const sheet = wb.worksheets[0]
  assert.equal(sheet.getCell('A1').value, '姓名')
  assert.equal(sheet.getCell('C3').value, '88')
})

test('clusterColumns rejects a plain single-column text page', () => {
  const words = Array.from({ length: 10 }, (_, i) => ({ x: 10, y: i * 30, w: 150, h: 16, text: `第${i}行` }))
  const rows = clusterRows(words)
  const grid = clusterColumns(rows)
  assert.equal(grid[0].length, 1)
})

test('document workspace routes redact, bilingual-reflow and table-recovery', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'document-workspace-service.js'), 'utf8')
  assert.match(service, /kind: 'redact'/)
  assert.match(service, /kind: 'bilingual-reflow'/)
  assert.match(service, /kind: 'table-recovery'/)
  assert.match(service, /await redactDocument\(plan\.files\[0\]\.path, finalPath\)/)
  assert.match(service, /await bilingualReflow\(\{/)
  assert.match(service, /recoverTableInto\(workbook/)
  assert.match(service, /this\.tableOcr/)
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8')
  assert.match(main, /tableOcr: \{ wordsForPdf, wordsForImage \}/)
  assert.match(main, /scale: 1\.5/)
})

test('ocr service exposes word-box mode and ps1 stays UTF-8 BOM', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ocr-service.js'), 'utf8')
  assert.match(service, /async recognizeWords\(imagePaths/)
  assert.match(service, /'-Words'/)
  const ps1 = fs.readFileSync(path.join(__dirname, '..', 'electron', 'ocr-winrt.ps1'), 'utf8')
  assert.ok(ps1.charCodeAt(0) === 0xfeff, 'ps1 必须带 BOM，否则中文注释在 GBK 下解析失败')
  assert.match(ps1, /\$Words/)
})
