const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')

const { buildPresentationBuffer, writePresentation } = require('../electron/pptx-generator')

function decodeXmlText(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function visibleText(xml) {
  return [...String(xml).matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
    .map((match) => decodeXmlText(match[1]))
    .join('\n')
}

test('deterministic PPTX generator writes a complete text-only OOXML presentation', async () => {
  const buffer = await buildPresentationBuffer({
    title: '季度复盘 & 计划',
    createdAt: new Date('2026-08-09T00:00:00.000Z'),
    slides: [
      { title: '收入 <增长>', bullets: ['渠道 A & B', '成本 "下降"'], notes: '开场说明\n强调利润' },
      { title: '下一步', bullets: ['扩大有效渠道'], notes: '' }
    ]
  })

  assert.equal(buffer.subarray(0, 2).toString(), 'PK')
  const archive = await JSZip.loadAsync(buffer)
  const files = Object.keys(archive.files).filter((name) => !archive.files[name].dir)
  const required = [
    '[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml',
    'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml',
    'ppt/theme/theme1.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml',
    'ppt/notesMasters/notesMaster1.xml', 'ppt/notesSlides/notesSlide1.xml'
  ]
  for (const name of required) assert.ok(archive.file(name), `missing ${name}`)
  assert.equal(files.some((name) => name.startsWith('ppt/media/')), false)

  const presentation = await archive.file('ppt/presentation.xml').async('string')
  assert.equal((presentation.match(/<p:sldId\b/g) || []).length, 2)
  assert.match(presentation, /<p:sldSz cx="12192000" cy="6858000"\/?>/)
  const slide1 = await archive.file('ppt/slides/slide1.xml').async('string')
  assert.match(slide1, /<a:srgbClr val="071426"\/?>/)
  assert.match(visibleText(slide1), /收入 <增长>/)
  assert.match(visibleText(slide1), /渠道 A & B/)
  assert.match(slide1, /收入 &lt;增长&gt;/)
  assert.match(slide1, /渠道 A &amp; B/)
  assert.match(slide1, /<a:buClr><a:srgbClr val="DCE7F7"\/><\/a:buClr>/)

  const slide1Rels = await archive.file('ppt/slides/_rels/slide1.xml.rels').async('string')
  assert.match(slide1Rels, /relationships\/notesSlide/)
  const slide2Rels = await archive.file('ppt/slides/_rels/slide2.xml.rels').async('string')
  assert.doesNotMatch(slide2Rels, /relationships\/notesSlide/)
  const notes = await archive.file('ppt/notesSlides/notesSlide1.xml').async('string')
  assert.match(visibleText(notes), /开场说明/)
  assert.match(visibleText(notes), /强调利润/)
})

test('PPTX writer is atomic and supplies a useful default slide', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplay-pptx-generator-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const output = path.join(dir, '默认演示.pptx')
  await writePresentation(output, '默认演示', [])
  assert.equal(fs.readFileSync(output).subarray(0, 2).toString(), 'PK')
  assert.deepEqual(fs.readdirSync(dir), ['默认演示.pptx'])

  const archive = await JSZip.loadAsync(fs.readFileSync(output))
  const slide = await archive.file('ppt/slides/slide1.xml').async('string')
  assert.match(visibleText(slide), /内容生成完成/)
})
