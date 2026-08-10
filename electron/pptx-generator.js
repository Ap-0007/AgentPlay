const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const JSZip = require('jszip')

const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const SLIDE_WIDTH = 12192000
const SLIDE_HEIGHT = 6858000

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function safeDate(value) {
  const parsed = value instanceof Date ? value : new Date(value || Date.now())
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed
}

function relationships(items) {
  return `${XML_HEADER}<Relationships xmlns="${NS_PACKAGE_REL}">${items.map((item) => (
    `<Relationship Id="${escapeXml(item.id)}" Type="${escapeXml(item.type)}" Target="${escapeXml(item.target)}"/>`
  )).join('')}</Relationships>`
}

function groupShapeProperties() {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
}

function run(text, { size, color, bold = false }) {
  const font = '<a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Microsoft YaHei"/>'
  return `<a:r><a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${font}</a:rPr><a:t xml:space="preserve">${escapeXml(text)}</a:t></a:r>`
}

function textShape({ id, name, x, y, width, height, paragraphs, anchor = 't' }) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
}

function rectangleShape(id, color) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Accent bar"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="146304" cy="${SLIDE_HEIGHT}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    `<a:ln><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></p:spPr></p:sp>`
}

function paragraph(text, options) {
  const bullet = options.bullet
    ? '<a:pPr marL="228600" indent="-228600"><a:spcAft><a:spcPts val="1200"/></a:spcAft><a:buClr><a:srgbClr val="DCE7F7"/></a:buClr><a:buSzPct val="100000"/><a:buChar char="&#x2022;"/></a:pPr>'
    : `<a:pPr${options.align ? ` algn="${options.align}"` : ''}><a:buNone/></a:pPr>`
  return `<a:p>${bullet}${run(text, options)}<a:endParaRPr lang="zh-CN" sz="${options.size}"/></a:p>`
}

function slideXml(item, index, total) {
  const title = String(item.title || `第 ${index + 1} 页`)
  const bullets = (Array.isArray(item.bullets) ? item.bullets : String(item.content || '').split(/\r?\n/).filter(Boolean))
    .slice(0, 8).map((value) => String(value))
  const titleParagraph = paragraph(title, { size: index === 0 ? 3000 : 2500, color: 'F8FAFC', bold: true })
  const bulletParagraphs = bullets.length
    ? bullets.map((value) => paragraph(value, { size: 2000, color: 'DCE7F7', bullet: true })).join('')
    : '<a:p><a:endParaRPr lang="zh-CN" sz="2000"/></a:p>'
  const footer = paragraph(`AgentPlay · ${index + 1} / ${total}`, { size: 900, color: '64748B', align: 'r' })
  const background = index === 0 ? '071426' : '0B1220'
  return `${XML_HEADER}<p:sld xmlns:a="${NS_DRAWING}" xmlns:r="${NS_REL}" xmlns:p="${NS_PRESENTATION}">` +
    `<p:cSld name="Slide ${index + 1}"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree>${groupShapeProperties()}${rectangleShape(2, '2F80ED')}` +
    `${textShape({ id: 3, name: 'Title', x: 685800, y: 530352, width: 10424160, height: 640080, paragraphs: titleParagraph, anchor: 'ctr' })}` +
    `${textShape({ id: 4, name: 'Body', x: 868680, y: 1417320, width: 10149840, height: 4480560, paragraphs: bulletParagraphs })}` +
    `${textShape({ id: 5, name: 'Footer', x: 8961120, y: 6473952, width: 2103120, height: 182880, paragraphs: footer, anchor: 'ctr' })}` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
}

function notesSlideXml(notes, slideNumber) {
  const lines = String(notes).split(/\r?\n/).filter((line) => line.length > 0)
  const noteParagraphs = (lines.length ? lines : ['']).map((line) => (
    `<a:p>${run(line, { size: 1200, color: '000000' })}<a:endParaRPr lang="zh-CN" sz="1200"/></a:p>`
  )).join('')
  return `${XML_HEADER}<p:notes xmlns:a="${NS_DRAWING}" xmlns:r="${NS_REL}" xmlns:p="${NS_PRESENTATION}"><p:cSld><p:spTree>` +
    `${groupShapeProperties()}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${noteParagraphs}</p:txBody></p:sp>` +
    `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number Placeholder 3"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" sz="quarter" idx="10"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{7F38D895-7F4D-4EE0-9B68-1E96A370BB8A}" type="slidenum"><a:rPr lang="zh-CN"/><a:t>${slideNumber}</a:t></a:fld><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>` +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
}

function colorScheme() {
  return '<a:clrScheme name="AgentPlay"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="071426"/></a:dk2><a:lt2><a:srgbClr val="DCE7F7"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="2F80ED"/></a:accent1><a:accent2><a:srgbClr val="56CCF2"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="27AE60"/></a:accent3><a:accent4><a:srgbClr val="F2C94C"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="EB5757"/></a:accent5><a:accent6><a:srgbClr val="9B51E0"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'
}

function themeXml() {
  const fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)
  const lines = [6350, 12700, 19050].map((width) => `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')
  const effects = '<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)
  return `${XML_HEADER}<a:theme xmlns:a="${NS_DRAWING}" name="AgentPlay Theme"><a:themeElements>${colorScheme()}` +
    '<a:fontScheme name="AgentPlay"><a:majorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Microsoft YaHei"/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Microsoft YaHei"/></a:minorFont></a:fontScheme>' +
    `<a:fmtScheme name="AgentPlay"><a:fillStyleLst>${fills}</a:fillStyleLst><a:lnStyleLst>${lines}</a:lnStyleLst><a:effectStyleLst>${effects}</a:effectStyleLst><a:bgFillStyleLst>${fills}</a:bgFillStyleLst></a:fmtScheme>` +
    '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
}

function slideMasterXml() {
  return `${XML_HEADER}<p:sldMaster xmlns:a="${NS_DRAWING}" xmlns:r="${NS_REL}" xmlns:p="${NS_PRESENTATION}"><p:cSld><p:spTree>${groupShapeProperties()}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:hf sldNum="0" hdr="0" ftr="0" dt="0"/>' +
    '<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'
}

function slideLayoutXml() {
  return `${XML_HEADER}<p:sldLayout xmlns:a="${NS_DRAWING}" xmlns:r="${NS_REL}" xmlns:p="${NS_PRESENTATION}" preserve="1"><p:cSld name="DEFAULT"><p:spTree>${groupShapeProperties()}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
}

function notesMasterXml() {
  return `${XML_HEADER}<p:notesMaster xmlns:a="${NS_DRAWING}" xmlns:r="${NS_REL}" xmlns:p="${NS_PRESENTATION}"><p:cSld><p:spTree>${groupShapeProperties()}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:notesStyle><a:lvl1pPr marL="0"><a:defRPr sz="1200"><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>'
}

function contentTypes(slides, notesIndexes) {
  const overrides = [
    ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
    ['/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
    ['/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
    ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ['/ppt/presProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml'],
    ['/ppt/viewProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml'],
    ['/ppt/tableStyles.xml', 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml']
  ]
  slides.forEach((_slide, index) => overrides.push([`/ppt/slides/slide${index + 1}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml']))
  if (notesIndexes.length) overrides.push(['/ppt/notesMasters/notesMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml'])
  notesIndexes.forEach((index) => overrides.push([`/ppt/notesSlides/notesSlide${index + 1}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml']))
  return `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('')}</Types>`
}

function presentationXml(slides, hasNotes) {
  const ids = slides.map((_slide, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  const notesId = hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rIdNotesMaster"/></p:notesMasterIdLst>' : ''
  return `${XML_HEADER}<p:presentation xmlns:a="${NS_DRAWING}" xmlns:r="${NS_REL}" xmlns:p="${NS_PRESENTATION}" saveSubsetFonts="1" autoCompressPictures="0">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst>${notesId}` +
    `<p:sldSz cx="${SLIDE_WIDTH}" cy="${SLIDE_HEIGHT}"/><p:notesSz cx="6858000" cy="12192000"/><p:defaultTextStyle/></p:presentation>`
}

function appProperties(slideCount, notesCount) {
  return `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>Microsoft Office PowerPoint</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>${slideCount}</Slides><Notes>${notesCount}</Notes>` +
    '<HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop><Company>AgentPlay</Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>'
}

function coreProperties(title, createdAt) {
  const timestamp = createdAt.toISOString()
  return `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(title)}</dc:title><dc:subject>AgentPlay Presentation</dc:subject><dc:creator>AgentPlay</dc:creator><cp:lastModifiedBy>AgentPlay</cp:lastModifiedBy><cp:revision>1</cp:revision>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`
}

async function buildPresentationBuffer({ title = 'AgentPlay 演示文稿', slides = [], createdAt = new Date() } = {}) {
  const normalizedSlides = slides.length ? slides : [{ title, bullets: ['内容生成完成'] }]
  const normalizedTitle = String(title || 'AgentPlay 演示文稿')
  const fileDate = safeDate(createdAt)
  const notesIndexes = normalizedSlides.map((slide, index) => String(slide.notes || '').trim() ? index : -1).filter((index) => index >= 0)
  const zip = new JSZip()
  const add = (name, contents) => zip.file(name, contents, { date: fileDate })

  add('[Content_Types].xml', contentTypes(normalizedSlides, notesIndexes))
  add('_rels/.rels', relationships([
    { id: 'rId1', type: `${NS_REL}/extended-properties`, target: 'docProps/app.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: `${NS_REL}/officeDocument`, target: 'ppt/presentation.xml' }
  ]))
  add('docProps/app.xml', appProperties(normalizedSlides.length, notesIndexes.length))
  add('docProps/core.xml', coreProperties(normalizedTitle, fileDate))
  add('ppt/presentation.xml', presentationXml(normalizedSlides, notesIndexes.length > 0))

  const presentationRelationships = [
    { id: 'rId1', type: `${NS_REL}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    ...normalizedSlides.map((_slide, index) => ({ id: `rId${index + 2}`, type: `${NS_REL}/slide`, target: `slides/slide${index + 1}.xml` }))
  ]
  if (notesIndexes.length) presentationRelationships.push({ id: 'rIdNotesMaster', type: `${NS_REL}/notesMaster`, target: 'notesMasters/notesMaster1.xml' })
  presentationRelationships.push(
    { id: 'rIdPresProps', type: `${NS_REL}/presProps`, target: 'presProps.xml' },
    { id: 'rIdViewProps', type: `${NS_REL}/viewProps`, target: 'viewProps.xml' },
    { id: 'rIdTheme', type: `${NS_REL}/theme`, target: 'theme/theme1.xml' },
    { id: 'rIdTableStyles', type: `${NS_REL}/tableStyles`, target: 'tableStyles.xml' }
  )
  add('ppt/_rels/presentation.xml.rels', relationships(presentationRelationships))
  add('ppt/slideMasters/slideMaster1.xml', slideMasterXml())
  add('ppt/slideMasters/_rels/slideMaster1.xml.rels', relationships([
    { id: 'rId1', type: `${NS_REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: `${NS_REL}/theme`, target: '../theme/theme1.xml' }
  ]))
  add('ppt/slideLayouts/slideLayout1.xml', slideLayoutXml())
  add('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relationships([
    { id: 'rId1', type: `${NS_REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml' }
  ]))
  add('ppt/theme/theme1.xml', themeXml())
  add('ppt/presProps.xml', `${XML_HEADER}<p:presentationPr xmlns:a="${NS_DRAWING}" xmlns:r="${NS_REL}" xmlns:p="${NS_PRESENTATION}"/>`)
  add('ppt/viewProps.xml', `${XML_HEADER}<p:viewPr xmlns:a="${NS_DRAWING}" xmlns:r="${NS_REL}" xmlns:p="${NS_PRESENTATION}"><p:normalViewPr/><p:slideViewPr><p:cSldViewPr/></p:slideViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`)
  add('ppt/tableStyles.xml', `${XML_HEADER}<a:tblStyleLst xmlns:a="${NS_DRAWING}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`)

  if (notesIndexes.length) {
    add('ppt/notesMasters/notesMaster1.xml', notesMasterXml())
    add('ppt/notesMasters/_rels/notesMaster1.xml.rels', relationships([
      { id: 'rId1', type: `${NS_REL}/theme`, target: '../theme/theme1.xml' }
    ]))
  }

  normalizedSlides.forEach((slide, index) => {
    const slideNumber = index + 1
    add(`ppt/slides/slide${slideNumber}.xml`, slideXml(slide, index, normalizedSlides.length))
    const slideRelationships = [{ id: 'rId1', type: `${NS_REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' }]
    if (notesIndexes.includes(index)) {
      slideRelationships.push({ id: 'rId2', type: `${NS_REL}/notesSlide`, target: `../notesSlides/notesSlide${slideNumber}.xml` })
      add(`ppt/notesSlides/notesSlide${slideNumber}.xml`, notesSlideXml(slide.notes, slideNumber))
      add(`ppt/notesSlides/_rels/notesSlide${slideNumber}.xml.rels`, relationships([
        { id: 'rId1', type: `${NS_REL}/notesMaster`, target: '../notesMasters/notesMaster1.xml' },
        { id: 'rId2', type: `${NS_REL}/slide`, target: `../slides/slide${slideNumber}.xml` }
      ]))
    }
    add(`ppt/slides/_rels/slide${slideNumber}.xml.rels`, relationships(slideRelationships))
  })

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' })
}

async function writePresentation(finalPath, title, slides) {
  const buffer = await buildPresentationBuffer({ title, slides })
  const tempPath = `${finalPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp.pptx`
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  try {
    fs.writeFileSync(tempPath, buffer)
    fs.renameSync(tempPath, finalPath)
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }) } catch {}
    throw error
  }
}

module.exports = { buildPresentationBuffer, writePresentation }
