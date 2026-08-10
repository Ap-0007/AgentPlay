const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')
const ExcelJS = require('exceljs')
const { editPptx, parsePptxEditInstruction } = require('../electron/pptx-editor')
const { writePresentation } = require('../electron/pptx-generator')
const { DocumentWorkspaceService, classifyTask } = require('../electron/document-workspace-service')

async function buildFixture(filePath) {
  await writePresentation(filePath, '年度汇报', [
    { title: '年度汇报', bullets: ['汇报人：张三'], notes: '首页备注' },
    { title: '第二季度数据', bullets: ['收入增长 20%', '成本下降 5%'] },
    { title: '感谢观看', bullets: [] }
  ])
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function buildChartFixture(filePath, { labels, values, title = '季度销售', slideNumber = 2 }) {
  const slides = Array.from({ length: Math.max(2, slideNumber) }, (_unused, index) => ({
    title: index === 0 ? '封面' : `第 ${index + 1} 页`, bullets: []
  }))
  await writePresentation(filePath, title, slides)
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Sheet1')
  sheet.addRow(['类别', '销售额'])
  labels.forEach((label, index) => sheet.addRow([label, values[index]]))

  const archive = await JSZip.loadAsync(fs.readFileSync(filePath))
  const categoryPoints = labels.map((label, index) => `<c:pt idx="${index}"><c:v>${escapeXml(label)}</c:v></c:pt>`).join('')
  const valuePoints = values.map((value, index) => `<c:pt idx="${index}"><c:v>${Number(value)}</c:v></c:pt>`).join('')
  const lastRow = labels.length + 1
  const chartXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>${escapeXml(title)}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>销售额</c:v></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${lastRow}</c:f><c:strCache><c:ptCount val="${labels.length}"/>${categoryPoints}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$${lastRow}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${valuePoints}</c:numCache></c:numRef></c:val></c:ser><c:axId val="123456"/><c:axId val="654321"/></c:barChart><c:catAx><c:axId val="123456"/><c:crossAx val="654321"/></c:catAx><c:valAx><c:axId val="654321"/><c:crossAx val="123456"/></c:valAx></c:plotArea></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`
  archive.file('ppt/charts/chart1.xml', chartXml)
  archive.file('ppt/charts/_rels/chart1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/Microsoft_Excel_Worksheet1.xlsx"/></Relationships>')
  archive.file('ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx', await workbook.xlsx.writeBuffer())

  const slidePath = `ppt/slides/slide${slideNumber}.xml`
  const slideXml = await archive.file(slidePath).async('string')
  const chartFrame = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="20" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="3657600"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdChart1"/></a:graphicData></a:graphic></p:graphicFrame>'
  archive.file(slidePath, slideXml.replace('</p:spTree>', `${chartFrame}</p:spTree>`))
  const slideRelsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`
  const slideRels = await archive.file(slideRelsPath).async('string')
  archive.file(slideRelsPath, slideRels.replace('</Relationships>', '<Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>'))
  const types = await archive.file('[Content_Types].xml').async('string')
  archive.file('[Content_Types].xml', types.replace('</Types>', '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/><Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'))
  fs.writeFileSync(filePath, await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

async function slideTexts(filePath) {
  const archive = await JSZip.loadAsync(fs.readFileSync(filePath))
  const relsXml = await archive.file('ppt/_rels/presentation.xml.rels').async('string')
  const rels = new Map([...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1]
    const target = /Target="([^"]+)"/.exec(m[0])?.[1]
    return [id, target]
  }))
  const presentationXml = await archive.file('ppt/presentation.xml').async('string')
  const order = [...presentationXml.matchAll(/<p:sldId\b[^>]*>/g)].map((m) => /r:id="([^"]+)"/.exec(m[0])?.[1])
  const texts = []
  for (const rId of order) {
    const target = `ppt/${rels.get(rId)}`
    const xml = await archive.file(target).async('string')
    texts.push([...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(''))
  }
  return { texts, presentationXml, archive }
}

test('parsePptxEditInstruction reads scoped replace, remove and add; guards conversion and translation', () => {
  assert.deepEqual(parsePptxEditInstruction('把张三替换成李四'), [{ type: 'replace', from: '张三', to: '李四', page: null }])
  assert.deepEqual(parsePptxEditInstruction('把第2页的第二季度替换成第三季度'), [{ type: 'replace', from: '第二季度', to: '第三季度', page: 2 }])
  assert.deepEqual(parsePptxEditInstruction('删除第3页'), [{ type: 'remove', page: 3 }])
  assert.deepEqual(parsePptxEditInstruction('把演示稿改成pdf'), null)
  assert.equal(parsePptxEditInstruction('把标题改成英文'), null)
  const add = parsePptxEditInstruction('在第1页后加一页：新季度规划。目标翻倍。路线全球化')
  assert.equal(add[0].type, 'add')
  assert.equal(add[0].afterPage, 1)
  assert.equal(add[0].title, '新季度规划')
  assert.deepEqual(add[0].bullets, ['目标翻倍', '路线全球化'])
})

test('classifyTask routes deterministic pptx edits local', () => {
  const file = [{ path: '汇报.pptx' }]
  assert.deepEqual(classifyTask(file, '把张三替换成李四', 'auto'), {
    kind: 'pptx-edit',
    outputFormat: 'pptx',
    requiresAi: false,
    summary: '本地页面级编辑 PPTX',
    editOperations: [{ type: 'replace', from: '张三', to: '李四', page: null }]
  })
  assert.equal(classifyTask(file, '把演示稿改成pdf', 'auto').kind, 'convert')
})

test('replace runs across the deck while masters, layouts, theme and notes stay byte-identical', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-replace-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    const output = path.join(tempDir, '汇报-out.pptx')
    await buildFixture(fixture)
    await editPptx(fixture, output, [{ type: 'replace', from: '张三', to: '李四', page: null }])
    const { texts, archive } = await slideTexts(output)
    assert.ok(texts[0].includes('李四'))
    assert.ok(!texts.join('').includes('张三'))
    const before = await JSZip.loadAsync(fs.readFileSync(fixture))
    const preserved = []
    for (const name of Object.keys(before.files)) {
      if (!before.files[name].dir && /^ppt\/(slideMasters|slideLayouts|theme|notesSlides|media)\//.test(name)) preserved.push(name)
    }
    assert.ok(preserved.length > 0)
    for (const name of preserved) {
      assert.equal(await archive.file(name).async('string'), await before.file(name).async('string'), `${name} 必须逐字不变`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('removing a page cleans presentation list, relationships, content types and the part', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-remove-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    const output = path.join(tempDir, '汇报-out.pptx')
    await buildFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)
    await editPptx(fixture, output, [{ type: 'remove', page: 2 }])
    const { texts, presentationXml, archive } = await slideTexts(output)
    assert.equal(texts.length, 2)
    assert.ok(texts[0].includes('年度汇报'))
    assert.ok(texts[1].includes('感谢观看'))
    assert.ok(!texts.join('').includes('第二季度数据'))
    assert.ok(!archive.file('ppt/slides/slide2.xml'), '被删页面部件必须移除')
    assert.deepEqual(fs.readFileSync(fixture), originalBytes, '原文件不得被改动')
    await assert.rejects(() => editPptx(fixture, path.join(tempDir, 'x.pptx'), [{ type: 'remove', page: 9 }]), /没有第 9 页/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('adding a page reuses an existing layout and lands at the requested position', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-add-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    const output = path.join(tempDir, '汇报-out.pptx')
    await buildFixture(fixture)
    await editPptx(fixture, output, [{ type: 'add', title: '新季度规划', bullets: ['目标翻倍', '路线全球化'], afterPage: 1 }])
    const { texts, archive } = await slideTexts(output)
    assert.equal(texts.length, 4)
    assert.ok(texts[0].includes('年度汇报'))
    assert.ok(texts[1].includes('新季度规划'), '新页必须落在第 1 页之后')
    assert.ok(texts[1].includes('目标翻倍'))
    assert.ok(texts[1].includes('路线全球化'))
    const newSlideName = Object.keys(archive.files).find((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name) && !['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml'].includes(name))
    assert.ok(newSlideName)
    const newSlideRels = newSlideName.replace('slides/', 'slides/_rels/').replace('.xml', '.xml.rels')
    assert.ok(archive.file(newSlideRels), '新页必须带版式关系')
    assert.ok((await archive.file(newSlideRels).async('string')).includes('slideLayout'))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('service.run executes a mixed pptx edit task fully local and records history', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-mixed-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    await buildFixture(fixture)
    const service = new DocumentWorkspaceService({
      outputRoot: path.join(tempDir, 'outputs'),
      historyRoot: path.join(tempDir, 'history'),
      complete: async () => { throw new Error('不应调用模型') },
      renderPdf: async () => { throw new Error('不应渲染 PDF') }
    })
    const result = await service.run([fixture], '把张三替换成李四\n删除第3页\n在第1页后加一页：新季度规划。目标翻倍。路线全球化', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'pptx-edit')
    assert.equal(result.plan.requiresAi, false)
    assert.match(result.summary, /替换 1 处文字/)
    assert.match(result.summary, /删除第 3 页/)
    assert.match(result.summary, /新增页「新季度规划」/)
    const { texts } = await slideTexts(result.outputs[0])
    assert.equal(texts.length, 3)
    assert.ok(texts[0].includes('李四'))
    assert.ok(texts[1].includes('新季度规划'))
    assert.ok(texts[2].includes('第二季度数据'))
    const history = fs.readFileSync(path.join(tempDir, 'history', 'history.jsonl'), 'utf8')
    assert.match(history, /pptx-edit/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('parsePptxEditInstruction reads page move', () => {
  assert.deepEqual(parsePptxEditInstruction('把第3页移到第1页前'), [{ type: 'move', page: 3, beforePage: 1, position: 'before' }])
  assert.deepEqual(parsePptxEditInstruction('把第1页移到第3页后'), [{ type: 'move', page: 1, beforePage: 3, position: 'after' }])
})

test('moving pages reorders the deck while parts stay intact', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-move-'))
  try {
    const fixture = path.join(tempDir, '汇报.pptx')
    const output = path.join(tempDir, '汇报-out.pptx')
    await buildFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)
    await editPptx(fixture, output, [{ type: 'move', page: 3, beforePage: 1, position: 'before' }])
    let { texts } = await slideTexts(output)
    assert.ok(texts[0].includes('感谢观看'))
    assert.ok(texts[1].includes('年度汇报'))
    assert.ok(texts[2].includes('第二季度数据'))

    const output2 = path.join(tempDir, '汇报-out2.pptx')
    await editPptx(fixture, output2, [{ type: 'move', page: 1, beforePage: 3, position: 'after' }])
    ;({ texts } = await slideTexts(output2))
    assert.ok(texts[0].includes('第二季度数据'))
    assert.ok(texts[1].includes('感谢观看'))
    assert.ok(texts[2].includes('年度汇报'))
    assert.deepEqual(fs.readFileSync(fixture), originalBytes)

    await assert.rejects(() => editPptx(fixture, path.join(tempDir, 'x.pptx'), [{ type: 'move', page: 9, beforePage: 1, position: 'before' }]), /超出范围/)
    await assert.rejects(() => editPptx(fixture, path.join(tempDir, 'y.pptx'), [{ type: 'move', page: 1, beforePage: 1, position: 'before' }]), /相同/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('pptx keeps master, layouts, theme, animations and notes after edits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-complex-'))
  try {
    const fixture = path.join(dir, 'deck.pptx')
    await writePresentation(fixture, '复杂演示', [
      { title: '封面旧标题', bullets: [], notes: '首页备注' },
      { title: '带动画的第二页', bullets: [] }
    ])

    // 手工注入动画块；备注页由确定性的 Open XML 生成器创建。
    const TIMING = '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/></p:par></p:tnLst></p:timing>'
    let zip = await JSZip.loadAsync(fs.readFileSync(fixture))
    let slide2 = await zip.file('ppt/slides/slide2.xml').async('string')
    zip.file('ppt/slides/slide2.xml', slide2.replace('</p:sld>', TIMING + '</p:sld>'))
    zip.file('ppt/notesSlides/notesSlide1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld></notes>')
    fs.writeFileSync(fixture, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

    const out = path.join(dir, 'deck-out.pptx')
    await editPptx(fixture, out, [
      { type: 'replace', from: '旧标题', to: '新标题' },
      { type: 'replace', from: '带动画的第二页', to: '动画还在' },
      { type: 'add', title: '新增页', bullets: ['沿用母版'], afterPage: 2 }
    ])
    const a = await JSZip.loadAsync(fs.readFileSync(fixture))
    const b = await JSZip.loadAsync(fs.readFileSync(out))
    const same = async (name) => {
      const fa = a.file(name)
      const fb = b.file(name)
      if (!fa && !fb) return true
      return fa && fb && Buffer.compare(await fa.async('nodebuffer'), await fb.async('nodebuffer')) === 0
    }
    for (const name of Object.keys(a.files).filter((n) => /slideMaster\d+\.xml$|slideLayout\d+\.xml$|theme\d+\.xml$/.test(n))) {
      assert.ok(await same(name), `母版/版式/主题必须原样: ${name}`)
    }
    const s2out = await b.file('ppt/slides/slide2.xml').async('string')
    assert.ok(s2out.includes('<p:timing>') && s2out.includes('动画还在'), '动画块与替换必须共存')
    assert.ok(b.file('ppt/notesSlides/notesSlide1.xml'), '备注页必须保留')
    const s3rels = await b.file('ppt/slides/_rels/slide3.xml.rels').async('string')
    assert.ok(s3rels.includes('slideLayout'), '新页必须挂现有版式')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('parsePptxEditInstruction reads chart and animation operations', () => {
  assert.deepEqual(parsePptxEditInstruction('把图表标题改成全年汇总'), [{ type: 'chart-title', to: '全年汇总', page: null }])
  assert.deepEqual(parsePptxEditInstruction('把第2页图表里的一月改成500'), [{ type: 'chart-data', label: '一月', value: 500, page: 2 }])
  assert.deepEqual(parsePptxEditInstruction('删除第3页的动画'), [{ type: 'anim-clear', page: 3 }])
  assert.deepEqual(parsePptxEditInstruction('删除全部动画'), [{ type: 'anim-clear', page: null }])
  // 通用替换不受影响
  assert.deepEqual(parsePptxEditInstruction('把张三替换成李四'), [{ type: 'replace', from: '张三', to: '李四', page: null }])
})

test('chart title and data point edits hit cache and embedded workbook, other parts intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-chart-'))
  try {
    const fixture = path.join(dir, 'chart.pptx')
    await buildChartFixture(fixture, { labels: ['一月', '二月', '三月'], values: [100, 200, 150], title: '季度销售' })
    const out = path.join(dir, 'chart-out.pptx')
    await editPptx(fixture, out, [
      { type: 'chart-title', to: '全年汇总', page: 2 },
      { type: 'chart-data', label: '二月', value: 500, page: 2 }
    ])
    const archive = await JSZip.loadAsync(fs.readFileSync(out))
    const chartXml = await archive.file('ppt/charts/chart1.xml').async('string')
    assert.ok(chartXml.includes('全年汇总'), '图表标题缓存必须更新')
    assert.ok(!chartXml.includes('季度销售'), '旧标题必须消失')
    assert.match(chartXml, /<c:pt idx="1"><c:v>500<\/c:v><\/c:pt>/, '二月的数据点缓存必须为 500')
    // 嵌入式工作簿同步：Sheet1!B3（二月行）必须是 500
    const embedName = Object.keys(archive.files).find((n) => /embeddings\/.*\.xlsx$/.test(n))
    assert.ok(embedName, '必须有嵌入式工作簿')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(await archive.file(embedName).async('nodebuffer'))
    const sheet = workbook.getWorksheet('Sheet1')
    assert.equal(Number(sheet.getCell('B3').value), 500, '工作簿中二月值必须同步为 500')
    // 未触及部件原样
    const before = await JSZip.loadAsync(fs.readFileSync(fixture))
    for (const name of Object.keys(before.files).filter((n) => /slideMaster\d+\.xml$|theme\d+\.xml$/.test(n))) {
      assert.equal(await archive.file(name).async('string'), await before.file(name).async('string'), `${name} 必须逐字不变`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('chart-data errors honestly when label or chart missing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-chart-miss-'))
  try {
    const fixture = path.join(dir, 'nochart.pptx')
    await writePresentation(fixture, '纯文字页', [{ title: '纯文字页', bullets: [] }])
    await assert.rejects(() => editPptx(fixture, path.join(dir, 'x.pptx'), [{ type: 'chart-data', label: '一月', value: 1, page: 1 }]), /没有图表/)
    const fixture2 = path.join(dir, 'c.pptx')
    await buildChartFixture(fixture2, { labels: ['一月'], values: [1], slideNumber: 1 })
    await assert.rejects(() => editPptx(fixture2, path.join(dir, 'y.pptx'), [{ type: 'chart-data', label: '十二月', value: 1, page: null }]), /找不到类别：十二月/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('anim-clear removes timing from target page only and errors on page without animation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-anim-'))
  try {
    const fixture = path.join(dir, 'anim.pptx')
    await writePresentation(fixture, '动画夹具', [
      { title: '第一页', bullets: [] },
      { title: '第二页', bullets: [] },
      { title: '第三页', bullets: [] }
    ])
    const TIMING = '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"/></p:par></p:tnLst></p:timing>'
    const zip = await JSZip.loadAsync(fs.readFileSync(fixture))
    for (const name of ['ppt/slides/slide2.xml', 'ppt/slides/slide3.xml']) {
      const xml = await zip.file(name).async('string')
      zip.file(name, xml.replace('</p:sld>', TIMING + '</p:sld>'))
    }
    fs.writeFileSync(fixture, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

    const out = path.join(dir, 'anim-out.pptx')
    const summary = await editPptx(fixture, out, [{ type: 'anim-clear', page: 2 }])
    assert.match(summary, /删除第 2 页动画/)
    const after = await JSZip.loadAsync(fs.readFileSync(out))
    assert.ok(!(await after.file('ppt/slides/slide2.xml').async('string')).includes('<p:timing>'), '第2页动画必须清除')
    assert.ok((await after.file('ppt/slides/slide3.xml').async('string')).includes('<p:timing>'), '第3页动画必须保留')

    await assert.rejects(() => editPptx(fixture, path.join(dir, 'z.pptx'), [{ type: 'anim-clear', page: 1 }]), /没有动画/)

    const out2 = path.join(dir, 'anim-all.pptx')
    await editPptx(fixture, out2, [{ type: 'anim-clear', page: null }])
    const after2 = await JSZip.loadAsync(fs.readFileSync(out2))
    assert.ok(!(await after2.file('ppt/slides/slide2.xml').async('string')).includes('<p:timing>'))
    assert.ok(!(await after2.file('ppt/slides/slide3.xml').async('string')).includes('<p:timing>'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
