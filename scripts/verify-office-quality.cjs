// 一次性验收：DOCX 复杂格式无损编辑 + PPTX 母版/动画保留 + XLSX 公式（COM 重算交给 ps1）
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')
const { Document, Packer, Paragraph, TextRun, Header, Footer, Table, TableRow, TableCell, WidthType, ImageRun, HeadingLevel } = require('docx')
const ExcelJS = require('exceljs')
const { editDocx } = require('../electron/docx-editor')
const { editPptx } = require('../electron/pptx-editor')
const { writePresentation } = require('../electron/pptx-generator')

const OUT = path.join(os.tmpdir(), 'office-quality')
fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

const results = []
function check(name, ok, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}

async function zipText(file, name) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file))
  const entry = zip.file(name)
  return entry ? entry.async('string') : null
}
async function zipBytes(file, name) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file))
  const entry = zip.file(name)
  return entry ? entry.async('nodebuffer') : null
}

// ── DOCX 复杂格式夹具 ──
async function buildDocxFixture() {
  const doc = new Document({
    sections: [{
      headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun('机密页眉-勿改')] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun('第 X 页页脚')] })] }) },
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('年度经营报告')] }),
        new Paragraph({ children: [new TextRun('营收目标是一千万元整。')] }),
        new Paragraph({ children: [new TextRun('旧口号：继续加油干。')] }),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph('指标')] }), new TableCell({ children: [new Paragraph('数值')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('毛利率')] }), new TableCell({ children: [new Paragraph('42%')] })] })
          ]
        }),
        new Paragraph({ children: [new ImageRun({ data: PNG_1PX, transformation: { width: 20, height: 20 }, type: 'png' })] })
      ]
    }]
  })
  const file = path.join(OUT, 'complex-fixture.docx')
  fs.writeFileSync(file, await Packer.toBuffer(doc))
  return file
}

async function verifyDocx() {
  const fixture = await buildDocxFixture()
  const edited = path.join(OUT, 'complex-fixture-edited.docx')
  await editDocx(fixture, edited, [
    { type: 'replace', from: '一千万元整', to: '壹仟贰佰万元整' },
    { type: 'replace', from: '继续加油干', to: '利润翻倍冲', mode: 'track' },
    { type: 'insert', anchor: '年度经营报告', position: 'after', lines: ['【插入段】副标题一行'] },
    { type: 'append', lines: ['结尾新增一段。'] },
    { type: 'remove', anchor: '毛利率' },
    { type: 'comment', anchor: '壹仟贰佰万元整', text: '财务已复核' }
  ])
  const same = async (name) => {
    const a = await zipBytes(fixture, name)
    const b = await zipBytes(edited, name)
    return a && b && Buffer.compare(a, b) === 0
  }
  check('DOCX 页眉无损', await same('word/header1.xml'))
  check('DOCX 页脚无损', await same('word/footer1.xml'))
  check('DOCX 样式表无损', await same('word/styles.xml'))
  // 图片逐一枚举对比（docx 库按内容哈希命名，不能写死 image1.png）
  {
    const zipA = await JSZip.loadAsync(fs.readFileSync(fixture))
    const zipB = await JSZip.loadAsync(fs.readFileSync(edited))
    const mediaA = Object.entries(zipA.files).filter(([n, e]) => !e.dir && n.includes('media/'))
    let mediaOk = mediaA.length > 0
    for (const [name, entry] of mediaA) {
      const other = zipB.file(name)
      if (!other || Buffer.compare(await entry.async('nodebuffer'), await other.async('nodebuffer')) !== 0) mediaOk = false
    }
    check('DOCX 图片无损', mediaOk, `${mediaA.length} 张`)
  }
  const xml = await zipText(edited, 'word/document.xml')
  check('DOCX 替换生效', xml.includes('壹仟贰佰万元整') && !xml.includes('一千万元整'))
  check('DOCX 修订留痕', xml.includes('<w:del') && xml.includes('<w:ins') && xml.includes('利润翻倍冲'))
  check('DOCX 插入段', xml.includes('【插入段】副标题一行'))
  check('DOCX 追加段', xml.includes('结尾新增一段。'))
  check('DOCX 表格行删除', !xml.includes('毛利率') && xml.includes('指标'))
  const comments = await zipText(edited, 'word/comments.xml')
  check('DOCX 批注', Boolean(comments && comments.includes('财务已复核')))
  check('DOCX 表格结构保留', xml.includes('<w:tbl>'))
}

// ── PPTX 夹具（手工注入动画与备注页） ──
const TIMING_BLOCK = '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/></p:par></p:tnLst></p:timing>'
async function buildPptxFixture() {
  const file = path.join(OUT, 'master-fixture.pptx')
  await writePresentation(file, '母版夹具', [
    { title: '封面：旧标题文字', bullets: [], notes: '首页备注' },
    { title: '第二页：保留这段动画', bullets: [] }
  ])

  // 注入动画块到 slide2；备注页由确定性的 Open XML 生成器创建。
  const zip = await JSZip.loadAsync(fs.readFileSync(file))
  let slide2 = await zip.file('ppt/slides/slide2.xml').async('string')
  slide2 = slide2.replace('</p:sld>', TIMING_BLOCK + '</p:sld>')
  zip.file('ppt/slides/slide2.xml', slide2)
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return file
}

async function verifyPptx() {
  const fixture = await buildPptxFixture()
  const edited = path.join(OUT, 'master-fixture-edited.pptx')
  await editPptx(fixture, edited, [
    { type: 'replace', from: '旧标题文字', to: '新标题文字' },
    { type: 'replace', from: '保留这段动画', to: '动画还在我身上' },
    { type: 'add', title: '新增的一页', bullets: ['沿用母版背景色', '要点二'], afterPage: 2 },
    { type: 'move', page: 3, beforePage: 1, position: 'before' }
  ])
  const same = async (name) => {
    const a = await zipBytes(fixture, name)
    const b = await zipBytes(edited, name)
    if (!a && !b) return true
    return a && b && Buffer.compare(a, b) === 0
  }
  check('PPTX 母版无损', await same('ppt/slideMasters/slideMaster1.xml'))
  check('PPTX 版式无损', await same('ppt/slideLayouts/slideLayout1.xml'))
  check('PPTX 主题无损', await same('ppt/theme/theme1.xml'))
  const slide2 = await zipText(edited, 'ppt/slides/slide2.xml')
  check('PPTX 动画块保留', Boolean(slide2 && slide2.includes('<p:timing>') && slide2.includes('tmRoot')))
  check('PPTX 替换生效', Boolean(slide2 && slide2.includes('动画还在我身上')))
  const slide3 = await zipText(edited, 'ppt/slides/slide3.xml')
  check('PPTX 新页存在', Boolean(slide3 && slide3.includes('新增的一页') && slide3.includes('沿用母版背景色')))
  const s3rels = await zipText(edited, 'ppt/slides/_rels/slide3.xml.rels')
  check('PPTX 新页挂版式', Boolean(s3rels && s3rels.includes('slideLayout')))
  const notes = await zipText(edited, 'ppt/notesSlides/notesSlide1.xml')
  check('PPTX 备注页保留', Boolean(notes))
  const pres = await zipText(edited, 'ppt/presentation.xml')
  const firstTarget = /<p:sldId\b[^>]*r:id="([^"]+)"/.exec(pres || '')?.[1]
  const rels = await zipText(edited, 'ppt/_rels/presentation.xml.rels')
  const firstSlide = new RegExp(`Id="${firstTarget}"[^>]*Target="([^"]+)"`).exec(rels || '')?.[1]
  check('PPTX 移动后新页排最前', Boolean(firstSlide && firstSlide.includes('slide3.xml')))
}

// ── XLSX 公式夹具 ──
async function verifyXlsx() {
  const file = path.join(OUT, 'formula-fixture.xlsx')
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('数据')
  ws.getCell('A1').value = 5
  ws.getCell('B1').value = 7
  ws.getCell('C1').value = { formula: 'A1+B1*2' }
  ws.getCell('D1').value = { formula: 'SUM(A1:B1)' }
  ws.getCell('E1').value = { formula: 'IF(A1>3,"大","小")' }
  await wb.xlsx.writeFile(file)
  console.log('XLSX 夹具:', file)
  return file
}

;(async () => {
  await verifyDocx()
  await verifyPptx()
  await verifyXlsx()
  console.log(results.join('\n'))
  console.log('夹具目录:', OUT)
  console.log(results.every((r) => r.startsWith('PASS')) ? 'XML-LEVEL ALL PASS' : 'XML-LEVEL SOME FAIL')
})().catch((e) => {
  console.log('FAIL:', e.stack || e.message)
  process.exit(1)
})
