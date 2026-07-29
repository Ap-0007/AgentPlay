// 双语重排：文档正文 → 段落拆分 → 批量翻译 → 中英对照 DOCX（原文正常、译文灰色小字交替）。
// 输出一律另存为新文件，不动原文件；未译出的段落如实标注。
const fs = require('fs')
const path = require('path')
const { Document, Packer, Paragraph, TextRun } = require('docx')
const { translateEntries } = require('./subtitle-bilingual-service')

const MAX_PARAGRAPHS = 200
const MAX_PARA_CHARS = 2000

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^## 第 \d+ 页$/.test(p) && !/^={3,}/.test(p))
    .slice(0, MAX_PARAGRAPHS)
    .map((p) => p.slice(0, MAX_PARA_CHARS))
}

function writeOut(finalPath, buffer) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  const tempPath = `${finalPath}.${process.pid}.tmp`
  fs.writeFileSync(tempPath, buffer)
  fs.renameSync(tempPath, finalPath)
}

async function bilingualReflow({ sourceText, title, complete, finalPath, engineLabel = '模型翻译' }) {
  const paragraphs = splitParagraphs(sourceText)
  if (!paragraphs.length) throw new Error('没有可排版的正文内容')
  const entries = paragraphs.map((text, index) => ({ index: index + 1, text }))
  const { translations, failed } = await translateEntries(entries, complete, { batchSize: 20 })

  const children = [
    new Paragraph({ children: [new TextRun({ text: `${title}（中英对照 · ${engineLabel}）`, bold: true, size: 32 })] })
  ]
  paragraphs.forEach((text, index) => {
    children.push(new Paragraph({ spacing: { before: 220 }, children: [new TextRun({ text, size: 22 })] }))
    const translation = translations.get(index + 1)
    children.push(new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({ text: translation || '（本段未译出）', size: 20, color: '595959', italics: true })]
    }))
  })
  const doc = new Document({
    creator: 'AgentPlay',
    title: `${title}（中英对照）`,
    sections: [{ children }]
  })
  writeOut(finalPath, await Packer.toBuffer(doc))
  return {
    total: paragraphs.length,
    failed,
    summary: `双语对照已生成：共 ${paragraphs.length} 段${failed ? `，${failed} 段未译出已如实标注` : '，全部译出'}`
  }
}

module.exports = { bilingualReflow, splitParagraphs }
