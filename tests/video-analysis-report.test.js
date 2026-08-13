const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const JSZip = require('jszip')

const { writeProfessionalVideoAnalysisDocx } = require('../electron/video-analysis-report-service')

// 1×1 JPEG，只用于确认图片真实嵌入 OOXML；正式路径使用 ffmpeg 关键帧。
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64')

test('professional video report embeds evidence frames and preserves exactly two major parts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-analysis-report-'))
  const output = path.join(root, 'report.docx')
  const content = [
    '## 第一部分　视频讲了什么',
    '### 一句话精华',
    '这是内容精华。',
    '### 全片结构时间轴',
    '| 时间 | 内容 |',
    '| --- | --- |',
    '| 00:00–00:05 | 开场 |',
    '## 第二部分　专业视听拆解与 AI 复刻',
    '### 分镜与剪辑结构',
    '- **原片观察**：固定机位。',
    '### AI 复刻执行方案',
    '复刻动作明确。'
  ].join('\n')
  await writeProfessionalVideoAnalysisDocx(output, {
    title: '样片专业拉片与 AI 复刻报告',
    content,
    frames: [
      { label: 't=00:00', data: JPEG },
      { label: 't=00:05', data: JPEG }
    ]
  })
  assert.ok(fs.statSync(output).size > 3000)
  const zip = await JSZip.loadAsync(fs.readFileSync(output))
  const xml = await zip.file('word/document.xml').async('string')
  assert.match(xml, /第一部分/)
  assert.match(xml, /第二部分/)
  assert.match(xml, /关键画面证据/)
  assert.match(xml, /w:tbl/)
  assert.equal(Object.keys(zip.files).filter((name) => /^word\/media\//.test(name)).length, 2)
})
