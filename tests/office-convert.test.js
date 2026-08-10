const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } = require('docx')
const { DocumentWorkspaceService, classifyTask } = require('../electron/document-workspace-service')
const { OfficeConvertService } = require('../electron/office-convert-service')

async function buildFixture(filePath) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: '高保真探针合同', heading: HeadingLevel.TITLE }),
        new Paragraph({ children: [new TextRun({ text: '加粗条款', bold: true }), new TextRun('与'), new TextRun({ text: '斜体备注', italics: true })] }),
        new Table({
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph('项目')] }), new TableCell({ children: [new Paragraph('金额')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('服务费')] }), new TableCell({ children: [new Paragraph('100元')] })] })
          ]
        })
      ]
    }]
  })
  fs.writeFileSync(filePath, await Packer.toBuffer(doc))
}

function localService(tempDir, officeConvert) {
  return new DocumentWorkspaceService({
    outputRoot: path.join(tempDir, 'outputs'),
    historyRoot: path.join(tempDir, 'history'),
    complete: async () => { throw new Error('不应调用模型') },
    renderPdf: async () => { throw new Error('不应渲染 PDF') },
    officeConvert
  })
}

test('Office COM startup retries only transient server failures and every script releases the application', () => {
  const root = path.join(__dirname, '..')
  const helper = fs.readFileSync(path.join(root, 'electron', 'office-com-helpers.ps1'), 'utf8')
  const convert = fs.readFileSync(path.join(root, 'electron', 'office-convert.ps1'), 'utf8')
  const enrich = fs.readFileSync(path.join(root, 'electron', 'excel-enrich.ps1'), 'utf8')
  assert.match(helper, /-2146959355/)
  assert.match(helper, /-2147023174/)
  assert.match(helper, /ValidateRange\(1, 5\).*MaxAttempts = 3/)
  assert.match(helper, /FinalReleaseComObject/)
  assert.match(convert, /New-AgentPlayOfficeApplication/)
  assert.match(convert, /Stop-AgentPlayOfficeApplication/)
  assert.match(enrich, /New-AgentPlayOfficeApplication/)
  assert.match(enrich, /Stop-AgentPlayOfficeApplication/)
})

test('高保真意图路由到本机引擎转换，普通转换保持原路径', () => {
  const docx = [{ path: '合同.docx' }]
  assert.deepEqual(classifyTask(docx, '把这份合同高保真转成PDF', 'auto'), {
    kind: 'office-convert', outputFormat: 'pdf', requiresAi: false, summary: '调用本机 Office 引擎高保真转换'
  })
  assert.equal(classifyTask(docx, '提取文字并改成pdf', 'auto').kind, 'convert')
  assert.equal(classifyTask(docx, '原样导出PDF', 'auto').kind, 'office-convert')
  assert.equal(classifyTask([{ path: '数据.xlsx' }], '高保真转成PDF', 'auto').kind, 'office-convert')
})

test('office-convert 走注入的引擎；无引擎时明确故障关闭并提示普通转换', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-convert-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    await buildFixture(fixture)
    const service = localService(tempDir, {
      convertToPdf: async (source, target) => {
        assert.equal(source, fixture)
        fs.writeFileSync(target, '%PDF-1.4\n%%EOF')
        return { engine: 'Word', bytes: 11 }
      }
    })
    const result = await service.run([fixture], '把这份合同高保真转成PDF', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'office-convert')
    assert.match(result.summary, /Word 引擎高保真转换/)
    assert.ok(fs.existsSync(result.outputs[0]))

    const noEngine = localService(tempDir, null)
    await assert.rejects(() => noEngine.run([fixture], '把这份合同高保真转成PDF', 'auto'), /普通转换/)

    const unavailable = localService(tempDir, {
      convertToPdf: async () => { throw new Error('高保真转换需要本机安装 Office、WPS 或 LibreOffice；当前未检测到可用引擎（可改用普通转换）') }
    })
    await assert.rejects(() => unavailable.run([fixture], '把这份合同高保真转成PDF', 'auto'), /未检测到可用引擎/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('本机 Office 引擎真实转换复杂 DOCX 为高保真 PDF（仅 Windows 且引擎可用）', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅 Windows 可用本机 Office 引擎')
  const service = new OfficeConvertService()
  const status = await service.detect()
  if (!status.available) return t.skip(`本机无转换引擎：${status.reason}`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-convert-e2e-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const target = path.join(tempDir, '合同.pdf')
    await buildFixture(fixture)
    const result = await service.convertToPdf(fixture, target)
    assert.ok(result.bytes > 10000)
    const { getDocumentProxy, extractText } = require('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(fs.readFileSync(target)))
    try {
      const { totalPages, text } = await extractText(pdf, { mergePages: true })
      assert.ok(totalPages >= 1)
      assert.match(String(text), /高保真探针合同/)
      assert.match(String(text), /服务费/)
    } finally {
      if (typeof pdf.destroy === 'function') void pdf.destroy()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('classifyTask routes chart and pivot instructions to spreadsheet-edit', () => {
  const file = [{ path: '销售.xlsx' }]
  assert.equal(classifyTask(file, '把数据做成柱状图', 'auto').kind, 'spreadsheet-edit')
  assert.equal(classifyTask(file, '生成透视表按地区汇总销售额', 'auto').kind, 'spreadsheet-edit')
  assert.equal(classifyTask(file, '生成透视表按地区汇总销售额', 'auto').requiresAi, false)
  const { parseExcelEnrichIntent } = require('../electron/document-workspace-service')
  assert.deepEqual(parseExcelEnrichIntent('把数据做成柱状图'), { chartType: 51, chartTitle: '数据图表', pivot: false, rowField: '', valueField: '' })
  assert.deepEqual(parseExcelEnrichIntent('画个饼图并生成透视表按地区汇总销售额'), { chartType: 5, chartTitle: '数据图表', pivot: true, rowField: '地区', valueField: '销售额' })
  assert.equal(parseExcelEnrichIntent('清理空格'), null)
})

test('本机 Excel 引擎真实生成图表页与透视表页（仅 Windows 且引擎可用）', async (t) => {
  if (process.platform !== 'win32') return t.skip('仅 Windows 可用本机 Office 引擎')
  const service = new OfficeConvertService()
  const status = await service.detect()
  if (!status.available || !status.engines.some((engine) => engine.app === 'Excel')) return t.skip('本机无 Excel 引擎')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-enrich-'))
  try {
    const ExcelJS = require('exceljs')
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['地区', '销售额'])
    sheet.addRow(['华东', 100])
    sheet.addRow(['华北', 200])
    sheet.addRow(['华南', 150])
    const fixture = path.join(tempDir, '销售.xlsx')
    await workbook.xlsx.writeFile(fixture)

    await service.excelEnrich(fixture, { chartType: 51, chartTitle: '销售额分布', pivot: true, rowField: '地区', valueField: '销售额' })

    const JSZip = require('jszip')
    const archive = await JSZip.loadAsync(fs.readFileSync(fixture))
    const names = Object.keys(archive.files)
    assert.ok(names.some((n) => /xl\/charts\/chart\d+\.xml$/.test(n)), '必须生成图表部件')
    assert.ok(names.some((n) => /xl\/pivotTables\/pivotTable\d+\.xml$/.test(n)), '必须生成透视表部件')
    const chartXml = await archive.file(names.find((n) => /xl\/charts\/chart\d+\.xml$/.test(n))).async('string')
    assert.ok(chartXml.includes('销售额分布'), '图表标题必须写入')
    // 字段名存在 pivotCacheDefinition 的 cacheFields 里（pivotTable 本体只存索引）
    const cacheDefName = names.find((n) => /xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(n))
    assert.ok(cacheDefName, '必须生成透视缓存定义')
    const cacheDefXml = await archive.file(cacheDefName).async('string')
    assert.ok(cacheDefXml.includes('地区') && cacheDefXml.includes('销售额'), '透视表字段必须写入')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('classifyTask routes high-fidelity PDF to Word conversion', () => {
  const file = [{ path: '报告.pdf' }]
  assert.deepEqual(classifyTask(file, '高保真转换成word', 'auto'), {
    kind: 'pdf-hifi-docx',
    outputFormat: 'docx',
    requiresAi: false,
    summary: '本地版式重建为 Word'
  })
})

test('PDF→DOCX 本地版式重建：行/段落/标题还原，扫描件如实报错', async () => {
  const { pdfToDocxLayout } = require('../electron/pdf-to-docx-service')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf2docx-layout-'))
  try {
    const { PDFDocument, StandardFonts } = require('pdf-lib')
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([595, 842])
    const regular = await pdf.embedFont(StandardFonts.Helvetica)
    page.drawText('Big Heading Probe', { x: 60, y: 780, size: 24, font: regular })
    page.drawText('Body line one stays in order.', { x: 60, y: 740, size: 12, font: regular })
    page.drawText('Body line two after a paragraph gap.', { x: 60, y: 690, size: 12, font: regular })
    const fixture = path.join(tempDir, 'probe.pdf')
    fs.writeFileSync(fixture, await pdf.save())

    const target = path.join(tempDir, 'probe.docx')
    const rebuilt = await pdfToDocxLayout(fixture, target)
    assert.equal(rebuilt.pages, 1)
    const mammoth = require('mammoth')
    const text = await mammoth.extractRawText({ path: target })
    assert.ok(text.value.includes('Big Heading Probe'))
    assert.ok(text.value.indexOf('Body line one') < text.value.indexOf('Body line two'))
    // 大字号行必须映射成标题样式
    const JSZip = require('jszip')
    const xml = await (await JSZip.loadAsync(fs.readFileSync(target))).file('word/document.xml').async('string')
    assert.match(xml, /Heading2[\s\S]{0,200}Big Heading Probe|Big Heading Probe[\s\S]{0,200}Heading2/)

    // 扫描件（无文字层）如实报错，不产出空文件
    const blank = await PDFDocument.create()
    blank.addPage([595, 842])
    const blankPath = path.join(tempDir, 'blank.pdf')
    fs.writeFileSync(blankPath, await blank.save())
    await assert.rejects(() => pdfToDocxLayout(blankPath, path.join(tempDir, 'blank.docx')), /没有文字层（扫描件）/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
