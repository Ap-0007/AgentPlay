// 屏幕指路：截图 → 视觉模型返回步骤+归一化标注坐标 → 主进程画透明覆盖层
const { desktopCapturer, screen } = require('electron')
const { safeFetch } = require('./safe-fetch')

const GUIDE_SYSTEM = `你是电脑屏幕操作向导。用户会发一张屏幕截图和一个问题。
观察截图内容，用简体中文给出 2-5 个简短操作步骤；凡是需要用户在屏幕上找到并点击的位置，给出标注。
只返回 JSON（不要 markdown 代码块、不要多余文字）：
{"steps":[{"text":"点击右上角的菜单按钮","mark":{"type":"circle","x":500,"y":80}},{"text":"选择设置","mark":null}]}
mark.type 只能是 "circle"（圈出目标）或 "arrow"（箭头指向，另给 toX/toY 表示目标点）。
x/y/toX/toY 都是 0-1000 的归一化坐标：x 向右、y 向下，相对整张截图的比例估算。
找不到值得指出的位置时 mark 设为 null。步骤文字要具体到按钮/入口名称，不要泛泛而谈。`

async function captureScreenDataUrl() {
  const primary = screen.getPrimaryDisplay()
  const scale = primary.scaleFactor || 1
  const width = Math.min(1600, Math.round(primary.size.width * scale))
  const height = Math.min(1000, Math.round(primary.size.height * scale))
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
  const source = sources.find((item) => item.display_id === String(primary.id)) || sources[0]
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法截取当前屏幕')
  return source.thumbnail.toDataURL()
}

function extractGuideJson(text) {
  const match = /\{[\s\S]*\}/.exec(String(text || ''))
  if (!match) throw new Error('模型没有返回可解析的指路结果')
  const parsed = JSON.parse(match[0])
  const steps = Array.isArray(parsed.steps) ? parsed.steps : []
  const clampCoord = (value) => Math.max(0, Math.min(1000, Math.round(Number(value) || 0)))
  return steps
    .map((step) => {
      const mark = step && typeof step.mark === 'object' && step.mark !== null ? step.mark : null
      const type = mark && (mark.type === 'circle' || mark.type === 'arrow') ? mark.type : null
      return {
        text: String(step?.text || '').slice(0, 120),
        mark: type
          ? { type, x: clampCoord(mark.x), y: clampCoord(mark.y), toX: clampCoord(mark.toX ?? mark.x), toY: clampCoord(mark.toY ?? mark.y) }
          : null
      }
    })
    .filter((step) => step.text)
}

async function requestScreenGuide(config, question) {
  if (config.protocol !== 'openai') throw new Error('屏幕指路需要 OpenAI 兼容的视觉模型接口（如 Agnes）；请在模型接入中心切换')
  if (config.requiresKey && !config.apiKey) throw new Error('请先保存模型 API Key')
  const dataUrl = await captureScreenDataUrl()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('屏幕指路超时')), 90000)
  try {
    const body = {
      model: config.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: GUIDE_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: String(question || '').slice(0, 500) || '教我怎么操作当前屏幕上的界面' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
          ]
        }
      ]
    }
    const response = await safeFetch(config, `${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      const text = await response.text()
      if ([400, 415, 422].includes(response.status)) {
        throw new Error(`当前模型 ${config.model} 不支持看图，屏幕指路需要视觉模型（如 Agnes agnes-2.5-flash）`)
      }
      throw new Error(`模型返回 ${response.status}: ${text.slice(0, 300)}`)
    }
    const payload = await response.json()
    const text = payload.choices?.[0]?.message?.content
    const steps = extractGuideJson(text)
    if (!steps.length) throw new Error('模型没有给出操作步骤，换个问法试试')
    return { steps, marks: steps.map((step) => step.mark).filter(Boolean) }
  } finally {
    clearTimeout(timeout)
  }
}

// 画面问答：把一张图（视频帧/截图）发给视觉模型，返回自然语言回答
async function askAboutImage(config, { dataUrl, question }) {
  if (config.protocol !== 'openai') throw new Error('画面问答需要 OpenAI 兼容的视觉模型接口（如 Agnes）；请在模型接入中心切换')
  if (config.requiresKey && !config.apiKey) throw new Error('请先保存模型 API Key')
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(String(dataUrl || ''))) throw new Error('画面数据无效')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('画面问答超时')), 90000)
  try {
    const body = {
      model: config.model,
      temperature: 0.3,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: String(question || '这个画面里是什么？用中文简要描述').slice(0, 500) },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
        ]
      }]
    }
    const response = await safeFetch(config, `${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      const text = await response.text()
      if ([400, 415, 422].includes(response.status)) throw new Error(`当前模型 ${config.model} 不支持看图，画面问答需要视觉模型（如 Agnes agnes-2.5-flash）`)
      throw new Error(`模型返回 ${response.status}: ${text.slice(0, 300)}`)
    }
    const payload = await response.json()
    const answer = String(payload.choices?.[0]?.message?.content || '').trim()
    if (!answer) throw new Error('模型没有给出回答')
    return { answer }
  } finally {
    clearTimeout(timeout)
  }
}

module.exports = { requestScreenGuide, askAboutImage }
