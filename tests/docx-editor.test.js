const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')
const mammoth = require('mammoth')
const { Document, Footer, Header, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } = require('docx')
const { editDocx, parseEditInstruction } = require('../electron/docx-editor')
const { DocumentWorkspaceService, classifyTask } = require('../electron/document-workspace-service')

async function buildComplexFixture(filePath) {
  const doc = new Document({
    sections: [{
      headers: { default: new Header({ children: [new Paragraph('机密页眉2026')] }) },
      footers: { default: new Footer({ children: [new Paragraph('第 1 页共 N 页')] }) },
      children: [
        new Paragraph({ text: '合作框架协议', heading: HeadingLevel.TITLE }),
        new Paragraph({
          children: [
            new TextRun({ text: '甲方：', bold: true }),
            new TextRun({ text: '张' }),
            new TextRun({ text: '三（', italics: true }),
            new TextRun({ text: '身份证号略）' })
          ]
        }),
        new Table({
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph('条款')] }), new TableCell({ children: [new Paragraph('内容')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('价格')] }), new TableCell({ children: [new Paragraph('100元')] })] })
          ]
        }),
        new Paragraph('其他约定事项保持不变。')
      ]
    }]
  })
  fs.writeFileSync(filePath, await Packer.toBuffer(doc))
}

test('parseEditInstruction reads replace and append, rejects conversion and translation phrasing', () => {
  assert.deepEqual(parseEditInstruction('把张三替换成李四'), [{ type: 'replace', from: '张三', to: '李四' }])
  assert.deepEqual(parseEditInstruction('把合同里的"价格"改为"200元"'), [{ type: 'replace', from: '合同里的价格', to: '200元' }])
  assert.equal(parseEditInstruction('把文档改成pdf'), null)
  assert.equal(parseEditInstruction('提取文字并改成pdf'), null)
  assert.equal(parseEditInstruction('把内容改成英文'), null)
  const append = parseEditInstruction('在文档末尾追加：第三条 双方另行约定')
  assert.equal(append[0].type, 'append')
  assert.ok(append[0].lines.join(' ').includes('第三条'))
})

test('classifyTask routes deterministic docx edits local and keeps convert/translation behavior', () => {
  const doc = [{ path: '合同.docx' }]
  assert.deepEqual(classifyTask(doc, '把合同里的张三替换成李四', 'auto'), {
    kind: 'docx-edit',
    outputFormat: 'docx',
    requiresAi: false,
    summary: '本地无损编辑 DOCX',
    editOperations: [{ type: 'replace', from: '合同里的张三', to: '李四' }]
  })
  assert.equal(classifyTask(doc, '提取文字并改成pdf', 'auto').kind, 'convert')
  assert.equal(classifyTask(doc, '把内容改成英文', 'auto').requiresAi, true)
})

test('editDocx replaces text spanning runs and appends, leaving styles, table, header and footer intact', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-edit-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-out.docx')
    await buildComplexFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)

    const summary = await editDocx(fixture, output, [
      { type: 'replace', from: '张三', to: '李四' },
      { type: 'append', lines: ['# 补充条款', '第一条 本条款为测试追加。'] }
    ])
    assert.match(summary, /替换 1 处/)

    const [before, after] = await Promise.all([JSZip.loadAsync(originalBytes), JSZip.loadAsync(fs.readFileSync(output))])
    const beforeDoc = await before.file('word/document.xml').async('string')
    const afterDoc = await after.file('word/document.xml').async('string')
    assert.notEqual(afterDoc, beforeDoc)
    const visible = [...afterDoc.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
    assert.ok(visible.includes('李四'))
    assert.ok(!visible.includes('张三'))
    assert.ok(visible.includes('补充条款'))
    assert.ok(visible.includes('第一条 本条款为测试追加。'))
    assert.ok(afterDoc.includes('<w:tbl>'), '表格结构必须保留')
    assert.ok(afterDoc.includes('Heading1'), '追加标题使用 Heading1 样式')

    for (const name of ['word/styles.xml', 'word/header1.xml', 'word/footer1.xml']) {
      const beforeEntry = before.file(name)
      const afterEntry = after.file(name)
      if (!beforeEntry) continue
      assert.equal(await afterEntry.async('string'), await beforeEntry.async('string'), `${name} 必须逐字不变`)
    }

    const text = await mammoth.extractRawText({ path: output })
    assert.ok(text.value.includes('李四'))
    assert.ok(text.value.includes('补充条款'))
    assert.deepEqual(fs.readFileSync(fixture), originalBytes, '原文件不得被改动')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('service.run executes a docx edit task fully local and records history', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-edit-run-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    await buildComplexFixture(fixture)
    const service = new DocumentWorkspaceService({
      outputRoot: path.join(tempDir, 'outputs'),
      historyRoot: path.join(tempDir, 'history'),
      complete: async () => { throw new Error('不应调用模型') },
      renderPdf: async () => { throw new Error('不应渲染 PDF') }
    })
    const result = await service.run([fixture], '把合同里的张三替换成李四；在文档末尾追加：补充条款如下', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'docx-edit')
    assert.equal(result.plan.requiresAi, false)
    assert.ok(result.outputs[0].endsWith('-AgentPlay处理版.docx'))
    const text = await mammoth.extractRawText({ path: result.outputs[0] })
    assert.ok(text.value.includes('李四'))
    assert.ok(text.value.includes('补充条款'))
    const history = fs.readFileSync(path.join(tempDir, 'history', 'history.jsonl'), 'utf8')
    assert.match(history, /docx-edit/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('missing replacement text fails without touching the original file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-edit-miss-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-out.docx')
    await buildComplexFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)
    await assert.rejects(() => editDocx(fixture, output, [{ type: 'replace', from: '不存在的名字', to: '李四' }]), /没有找到要替换的文字/)
    assert.equal(fs.existsSync(output), false)
    assert.deepEqual(fs.readFileSync(fixture), originalBytes)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('parseEditInstruction reads track mode, inserts and comments', () => {
  assert.deepEqual(parseEditInstruction('以修订模式把张三替换成李四'), [{ type: 'replace', from: '张三', to: '李四', mode: 'track' }])
  assert.deepEqual(parseEditInstruction('把张三替换成李四(修订模式)'), [{ type: 'replace', from: '张三', to: '李四', mode: 'track' }])
  assert.deepEqual(parseEditInstruction('在第2段后插入：新条款内容'), [{ type: 'insert', anchor: 2, position: 'after', lines: ['新条款内容'] }])
  const anchorInsert = parseEditInstruction('在其他约定前插入：签约地点待定')
  assert.deepEqual(anchorInsert, [{ type: 'insert', anchor: '其他约定', position: 'before', lines: ['签约地点待定'] }])
  assert.deepEqual(parseEditInstruction('给价格加批注：需要法务复核'), [{ type: 'comment', anchor: '价格', text: '需要法务复核' }])
  assert.equal(parseEditInstruction('在文档末尾追加：第三条规定')[0].type, 'append')
})

test('track-mode replace emits w:ins/w:del and hides deleted text from the plain layer', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-track-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-track.docx')
    await buildComplexFixture(fixture)
    await editDocx(fixture, output, [{ type: 'replace', from: '张三', to: '李四', mode: 'track' }])
    const archive = await JSZip.loadAsync(fs.readFileSync(output))
    const xml = await archive.file('word/document.xml').async('string')
    assert.ok(xml.includes('<w:del '), '必须有 w:del')
    assert.ok(xml.includes('<w:ins '), '必须有 w:ins')
    // 跨 run 命中的修订按 run 分段留痕（拒绝修订可逐段还原）
    assert.ok(xml.includes('<w:delText xml:space="preserve">张</w:delText>'))
    assert.ok(xml.includes('<w:delText xml:space="preserve">三</w:delText>'))
    assert.ok(xml.includes('<w:t xml:space="preserve">李四</w:t>'))
    const plainVisible = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
    assert.ok(!plainVisible.includes('张三'), '修订模式下纯文本层不得再含被删文字')
    assert.ok(plainVisible.includes('李四'))
    const beforeHeader = await (await JSZip.loadAsync(fs.readFileSync(fixture))).file('word/header1.xml').async('string')
    assert.equal(await archive.file('word/header1.xml').async('string'), beforeHeader, '页眉必须逐字不变')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('insert by index and by anchor places paragraphs at the right position', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-insert-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-insert.docx')
    await buildComplexFixture(fixture)
    await editDocx(fixture, output, [
      { type: 'insert', anchor: 1, position: 'after', lines: ['签约地点：待定'] },
      { type: 'insert', anchor: '其他约定', position: 'before', lines: ['【插入的分隔】'] }
    ])
    const archive = await JSZip.loadAsync(fs.readFileSync(output))
    const xml = await archive.file('word/document.xml').async('string')
    const order = ['合作框架协议', '签约地点：待定', '甲方：', '【插入的分隔】', '其他约定事项保持不变。']
    const positions = order.map((text) => xml.indexOf(text))
    assert.ok(positions.every((position) => position >= 0), '所有段落都应在文档中')
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, '段落顺序必须正确')
    assert.ok(xml.includes('<w:tbl>'), '表格结构必须保留')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('comments create the full comments part, ranges, content type and relationship', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-comment-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-comment.docx')
    await buildComplexFixture(fixture)
    await editDocx(fixture, output, [{ type: 'comment', anchor: '价格', text: '需要法务复核' }])
    const [before, after] = await Promise.all([JSZip.loadAsync(fs.readFileSync(fixture)), JSZip.loadAsync(fs.readFileSync(output))])
    const commentsXml = await after.file('word/comments.xml').async('string')
    assert.ok(commentsXml.includes('需要法务复核'))
    assert.ok(commentsXml.includes('w:author="AgentPlay"'))
    const xml = await after.file('word/document.xml').async('string')
    assert.ok(xml.includes('<w:commentRangeStart w:id="0"/>'))
    assert.ok(xml.includes('<w:commentRangeEnd w:id="0"/>'))
    assert.ok(xml.includes('<w:commentReference w:id="0"/>'))
    assert.ok((await after.file('[Content_Types].xml').async('string')).includes('comments+xml'))
    assert.ok((await after.file('word/_rels/document.xml.rels').async('string')).includes('comments'))
    for (const name of ['word/styles.xml', 'word/header1.xml', 'word/footer1.xml']) {
      assert.equal(await after.file(name).async('string'), await before.file(name).async('string'), `${name} 必须逐字不变`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('service.run handles a mixed track-replace, comment and insert task fully local', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-mixed-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    await buildComplexFixture(fixture)
    const service = new DocumentWorkspaceService({
      outputRoot: path.join(tempDir, 'outputs'),
      historyRoot: path.join(tempDir, 'history'),
      complete: async () => { throw new Error('不应调用模型') },
      renderPdf: async () => { throw new Error('不应渲染 PDF') }
    })
    const result = await service.run([fixture], '以修订模式把张三替换成李四\n给价格加批注：需法务复核\n在第1段后插入：签约地点待定', 'auto')
    assert.equal(result.success, true)
    assert.equal(result.plan.kind, 'docx-edit')
    assert.match(result.summary, /以修订模式替换 1 处文字/)
    assert.match(result.summary, /后插入 1 段/)
    assert.match(result.summary, /添加 1 条批注/)
    const archive = await JSZip.loadAsync(fs.readFileSync(result.outputs[0]))
    const xml = await archive.file('word/document.xml').async('string')
    assert.ok(xml.includes('<w:ins '))
    assert.ok((await archive.file('word/comments.xml').async('string')).includes('需法务复核'))
    assert.ok(xml.indexOf('签约地点待定') > xml.indexOf('合作框架协议'))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('parseEditInstruction reads paragraph removal by index and by text', () => {
  assert.deepEqual(parseEditInstruction('删除第2段'), [{ type: 'remove', anchor: 2 }])
  assert.deepEqual(parseEditInstruction('删除包含"机密"的段落'), [{ type: 'remove', anchor: '机密' }])
  const mixed = parseEditInstruction('删除第1段\n把张三替换成李四')
  assert.equal(mixed.length, 2)
  assert.equal(mixed[0].type, 'remove')
  assert.equal(mixed[1].type, 'replace')
})

test('remove paragraphs by index and by text, leaving everything else intact', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-remove-'))
  try {
    const fixture = path.join(tempDir, '合同.docx')
    const output = path.join(tempDir, '合同-out.docx')
    await buildComplexFixture(fixture)
    const originalBytes = fs.readFileSync(fixture)
    const summary = await editDocx(fixture, output, [{ type: 'remove', anchor: 2 }])
    assert.match(summary, /删除 1 个段落/)
    let archive = await JSZip.loadAsync(fs.readFileSync(output))
    let xml = await archive.file('word/document.xml').async('string')
    assert.ok(!xml.includes('张'))
    assert.ok(xml.includes('合作框架协议'))
    assert.ok(xml.includes('<w:tbl>'))

    const output2 = path.join(tempDir, '合同-out2.docx')
    await editDocx(fixture, output2, [{ type: 'remove', anchor: '其他约定' }])
    archive = await JSZip.loadAsync(fs.readFileSync(output2))
    xml = await archive.file('word/document.xml').async('string')
    assert.ok(!xml.includes('其他约定事项保持不变'))
    assert.deepEqual(fs.readFileSync(fixture), originalBytes)

    await assert.rejects(() => editDocx(fixture, path.join(tempDir, 'x.docx'), [{ type: 'remove', anchor: '根本不存在的词xyz' }]), /没有找到要删除的段落/)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('complex docx keeps headers, footers, styles, media and tables byte-identical after edits', async () => {
  const { Document, Packer, Paragraph, TextRun, Header, Footer, Table, TableRow, TableCell, WidthType, ImageRun, HeadingLevel } = require('docx')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-complex-'))
  try {
    const png1px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const doc = new Document({
      sections: [{
        headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun('机密页眉')] })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun('页脚')] })] }) },
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('年度报告')] }),
          new Paragraph({ children: [new TextRun('目标一千万元整。')] }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('毛利率')] }), new TableCell({ children: [new Paragraph('42%')] })] })]
          }),
          new Paragraph({ children: [new ImageRun({ data: png1px, transformation: { width: 20, height: 20 }, type: 'png' })] })
        ]
      }]
    })
    const fixture = path.join(dir, 'complex.docx')
    fs.writeFileSync(fixture, await Packer.toBuffer(doc))
    const out = path.join(dir, 'complex-out.docx')
    await editDocx(fixture, out, [
      { type: 'replace', from: '一千万元整', to: '壹仟贰佰万元整' },
      { type: 'insert', anchor: '年度报告', position: 'after', lines: ['插入段'] },
      { type: 'comment', anchor: '壹仟贰佰万元整', text: '已复核' }
    ])
    const a = await JSZip.loadAsync(fs.readFileSync(fixture))
    const b = await JSZip.loadAsync(fs.readFileSync(out))
    const same = async (name) => {
      const fa = a.file(name)
      const fb = b.file(name)
      if (!fa && !fb) return true
      return fa && fb && Buffer.compare(await fa.async('nodebuffer'), await fb.async('nodebuffer')) === 0
    }
    const header = Object.keys(a.files).find((n) => /header\d+\.xml$/.test(n))
    const footer = Object.keys(a.files).find((n) => /footer\d+\.xml$/.test(n))
    const media = Object.keys(a.files).filter((n) => n.includes('media/'))
    assert.ok(await same(header), '页眉必须原样')
    assert.ok(await same(footer), '页脚必须原样')
    assert.ok(await same('word/styles.xml'), '样式表必须原样')
    for (const m of media) assert.ok(await same(m), `图片必须原样: ${m}`)
    const xml = await b.file('word/document.xml').async('string')
    assert.ok(xml.includes('壹仟贰佰万元整') && xml.includes('<w:tbl>') && xml.includes('插入段'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('inline style full fidelity: cross-run replace keeps untouched runs byte-identical and inherits match-start rPr', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-fidelity-'))
  try {
    const { Document, Packer, Paragraph, TextRun } = require('docx')
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: '价格：' }),
              new TextRun({ text: '100', bold: true }),
              new TextRun({ text: '元整，' }),
              new TextRun({ text: '一次性付清。', italics: true })
            ]
          })
        ]
      }]
    })
    const fixture = path.join(tempDir, 'f.docx')
    fs.writeFileSync(fixture, await Packer.toBuffer(doc))
    const output = path.join(tempDir, 'f-out.docx')
    // '100元' 跨 run：bold('100') + 普通('元整，')；替换文字应继承命中起点 run 的 bold
    await editDocx(fixture, output, [{ type: 'replace', from: '100元', to: '200元' }])
    const archive = await JSZip.loadAsync(fs.readFileSync(output))
    const xml = await archive.file('word/document.xml').async('string')
    const visible = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('')
    assert.equal(visible, '价格：200元整，一次性付清。')
    // '200' 所在 run 必须是 bold（继承命中起点 run 的 rPr）
    const run200 = [...xml.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)].find((r) => r[0].includes('200元'))
    assert.ok(run200 && run200[0].includes('<w:b/>'), '200元 run 必须继承 bold')
    // 未触及的斜体 run 必须原样保留
    assert.ok(xml.includes('一次性付清。'))
    const runs = [...xml.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)]
    const italicRun = runs.find((r) => r[0].includes('一次性付清。'))
    assert.ok(italicRun && italicRun[0].includes('<w:i/>'), '斜体 run 必须保留斜体')
    // 前缀普通 run '价格：' 不带 bold
    const headRun = runs.find((r) => r[0].includes('价格：'))
    assert.ok(headRun && !headRun[0].includes('<w:b/>'))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('track mode preserves surrounding run formatting', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-track-fmt-'))
  try {
    const { Document, Packer, Paragraph, TextRun } = require('docx')
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({
            children: [
              new TextRun({ text: '甲方：', bold: true }),
              new TextRun({ text: '张三', italics: true }),
              new TextRun({ text: '签约。' })
            ]
          })
        ]
      }]
    })
    const fixture = path.join(tempDir, 't.docx')
    fs.writeFileSync(fixture, await Packer.toBuffer(doc))
    const output = path.join(tempDir, 't-out.docx')
    await editDocx(fixture, output, [{ type: 'replace', from: '张三', to: '李四', mode: 'track' }])
    const archive = await JSZip.loadAsync(fs.readFileSync(output))
    const xml = await archive.file('word/document.xml').async('string')
    // 未触及的 bold run '甲方：' 逐字保留（含 rPr）
    const headBold = [...xml.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)].find((r) => r[0].includes('甲方：'))
    assert.ok(headBold && headBold[0].includes('<w:b/>'), '甲方： run 必须保留 bold')
    // ins 里的替换文字继承命中 run 的斜体
    const insBlock = /<w:ins\b[\s\S]*?<\/w:ins>/.exec(xml)
    assert.ok(insBlock && insBlock[0].includes('李四') && insBlock[0].includes('<w:i/>'), 'ins 必须继承斜体')
    // del 留痕保留原斜体
    const delBlock = /<w:del\b[\s\S]*?<\/w:del>/.exec(xml)
    assert.ok(delBlock && delBlock[0].includes('张三') && delBlock[0].includes('<w:i/>'), 'del 必须保留斜体')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('insert and append inherit anchor paragraph style (paragraph-level style inheritance)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-inherit-'))
  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx')
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: '普通段落' }),
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('第二节')] }),
          new Paragraph({ children: [new TextRun({ text: '结尾段。', bold: true })] })
        ]
      }]
    })
    const fixture = path.join(tempDir, 's.docx')
    fs.writeFileSync(fixture, await Packer.toBuffer(doc))
    const output = path.join(tempDir, 's-out.docx')
    await editDocx(fixture, output, [
      { type: 'insert', anchor: '第二节', position: 'after', lines: ['继承样式的插入段'] },
      { type: 'append', lines: ['继承样式的追加段'] }
    ])
    const archive = await JSZip.loadAsync(fs.readFileSync(output))
    const xml = await archive.file('word/document.xml').async('string')
    // 插入段继承锚点（Heading2）的 pStyle
    assert.match(xml, /<w:p><w:pPr><w:pStyle w:val="Heading2"\/><\/w:pPr><w:r>[\s\S]*?继承样式的插入段/)
    // 追加段继承文末段（bold run）的 rPr
    const appended = [...xml.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)].find((r) => r[0].includes('继承样式的追加段'))
    assert.ok(appended && appended[0].includes('<w:b/>'), '追加段必须继承 bold')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
