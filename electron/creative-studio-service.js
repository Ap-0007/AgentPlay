const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { safeFetch } = require('./safe-fetch')

const MAX_VISUAL_EVIDENCE = 12
const MAX_IMAGE_BYTES = 1_500_000
const CREATIVE_PLAN_SYSTEM = `你是视频导演、剪辑师和事实核查员。只能依据提供的字幕、人工拉片和画面帧制定原创改编方案。
输出严格 JSON，不要 Markdown。不得虚构画面里未出现的人物、品牌或事实。新镜头必须标记为 generated，并给出可直接用于图像生成的 prompt；保留原片则标记 source。`

function safeText(value, max = 10000) {
  return String(value || '').replace(/\u0000/g, '').slice(0, max)
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abortError = () => signal?.reason instanceof Error && signal.reason.name !== 'AbortError'
      ? signal.reason
      : new Error('已取消')
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function normalizeDataUrl(value) {
  const match = String(value || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/)
  if (!match) return null
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null
  return { dataUrl: `data:${match[1]};base64,${match[2]}`, mimeType: match[1], base64: match[2], bytes: bytes.length }
}

function collectVisualEvidence(markers = []) {
  return markers.flatMap((marker) => {
    const image = normalizeDataUrl(marker?.thumbnail)
    if (!image) return []
    return [{
      at: Number(marker.at) || 0,
      note: safeText(marker.note, 500),
      shotSize: safeText(marker.shotSize, 50),
      movement: safeText(marker.movement, 50),
      ...image
    }]
  }).slice(0, MAX_VISUAL_EVIDENCE)
}

function buildCreativePrompt(input = {}, visualCount = 0) {
  const segments = Array.isArray(input.segments) ? input.segments.slice(0, 100) : []
  const cues = Array.isArray(input.cues) ? input.cues.slice(0, 1000) : []
  return [
    '请生成一份可执行的原创视频方案。',
    `目标：${safeText(input.originalGoal, 2000)}`,
    `风格：${safeText(input.style, 1000)}`,
    `原片名：${safeText(input.mediaName, 300)}`,
    `已提供画面帧：${visualCount} 张。没有画面帧时只能做文本证据分析。`,
    `当前重排片段：${JSON.stringify(segments.map((item) => ({ id: item.id, start: Number(item.start), end: Number(item.end), title: safeText(item.title, 300) })))}`,
    `人工拉片：${JSON.stringify((input.markers || []).slice(0, 200).map(({ thumbnail, ...marker }) => marker))}`,
    `字幕：${cues.map((cue) => `[${Number(cue.start).toFixed(1)}-${Number(cue.end).toFixed(1)}] ${safeText(cue.text, 500)}`).join('\n').slice(0, 40000)}`,
    'JSON schema：{"title":"","hook":"","narration":"完整旁白","musicBrief":"","subtitleStyle":"clean|impact|documentary","deepAnalysis":{"narrative":"","visual":"","editing":"","audio":"","hook":"","weaknesses":[""]},"shots":[{"id":"shot-1","kind":"source|generated","segmentId":"来源片段id或空","duration":3,"title":"","prompt":"仅generated必填","narration":"本镜旁白","caption":"屏幕字幕"}],"riskNotes":[""]}',
    '总镜头最多 24 个；generated 镜头建议占 20%-40%，用于补充原创视觉表达，不得冒充纪实证据。'
  ].join('\n\n')
}

function extractJson(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(source) } catch {}
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1))
  throw new Error('模型没有返回可解析的创作方案 JSON')
}

function normalizeCreativePlan(raw = {}, input = {}) {
  const validSegments = new Set((input.segments || []).map((segment) => String(segment.id)))
  const shots = (Array.isArray(raw.shots) ? raw.shots : []).slice(0, 24).flatMap((shot, index) => {
    const kind = shot.kind === 'generated' ? 'generated' : 'source'
    const segmentId = safeText(shot.segmentId, 100)
    if (kind === 'source' && !validSegments.has(segmentId)) return []
    return [{
      id: safeText(shot.id, 100) || `shot-${index + 1}`,
      kind,
      segmentId: kind === 'source' ? segmentId : '',
      duration: Math.max(1, Math.min(15, Number(shot.duration) || 3)),
      title: safeText(shot.title, 300) || `镜头 ${index + 1}`,
      prompt: kind === 'generated' ? safeText(shot.prompt, 2000) : '',
      narration: safeText(shot.narration, 2000),
      caption: safeText(shot.caption, 500),
      assetPath: '',
      status: kind === 'source' ? 'ready' : 'pending'
    }]
  })
  if (!shots.length) {
    for (const [index, segment] of (input.segments || []).slice(0, 24).entries()) {
      shots.push({
        id: `shot-${index + 1}`, kind: 'source', segmentId: String(segment.id),
        duration: Math.max(1, Math.min(15, Number(segment.end) - Number(segment.start) || 3)),
        title: safeText(segment.title, 300) || `片段 ${index + 1}`, prompt: '', narration: '', caption: '', assetPath: '', status: 'ready'
      })
    }
  }
  return {
    version: 1,
    title: safeText(raw.title, 300) || `${safeText(input.mediaName, 200) || '视频'} · 原创版`,
    hook: safeText(raw.hook, 1000),
    narration: safeText(raw.narration, 20000) || shots.map((shot) => shot.narration).filter(Boolean).join('\n'),
    musicBrief: safeText(raw.musicBrief, 1000) || '轻量、不抢人声、随叙事推进',
    subtitleStyle: ['clean', 'impact', 'documentary'].includes(raw.subtitleStyle) ? raw.subtitleStyle : 'clean',
    deepAnalysis: {
      narrative: safeText(raw.deepAnalysis?.narrative, 5000),
      visual: safeText(raw.deepAnalysis?.visual, 5000),
      editing: safeText(raw.deepAnalysis?.editing, 5000),
      audio: safeText(raw.deepAnalysis?.audio, 5000),
      hook: safeText(raw.deepAnalysis?.hook, 5000),
      weaknesses: (Array.isArray(raw.deepAnalysis?.weaknesses) ? raw.deepAnalysis.weaknesses : []).slice(0, 20).map((item) => safeText(item, 500))
    },
    shots,
    riskNotes: (Array.isArray(raw.riskNotes) ? raw.riskNotes : []).slice(0, 20).map((item) => safeText(item, 500)),
    modality: 'text-evidence'
  }
}

async function requestCreativePlan(config, input = {}, options = {}) {
  const evidence = collectVisualEvidence(input.markers)
  let usedEvidence = evidence
  let visualFallbackReason = ''
  const prompt = buildCreativePrompt(input, evidence.length)
  if (config.requiresKey && !config.apiKey) throw new Error('请先在模型接入中心保存 API Key')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('AI 创作方案请求超时')), options.timeoutMs || 600000)
  const requestOptions = { signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json' } }
  let response
  try {
    if (config.protocol === 'anthropic') {
      requestOptions.headers['x-api-key'] = config.apiKey
      requestOptions.headers['anthropic-version'] = '2023-06-01'
      requestOptions.body = JSON.stringify({
        model: config.model, max_tokens: 5000, system: CREATIVE_PLAN_SYSTEM,
        messages: [{ role: 'user', content: [
          ...evidence.map((item) => ({ type: 'image', source: { type: 'base64', media_type: item.mimeType, data: item.base64 } })),
          { type: 'text', text: prompt }
        ] }]
      })
      response = await safeFetch(config, `${config.baseUrl}/v1/messages`, requestOptions)
    } else if (config.protocol === 'gemini') {
      requestOptions.body = JSON.stringify({
        systemInstruction: { parts: [{ text: CREATIVE_PLAN_SYSTEM }] },
        contents: [{ role: 'user', parts: [
          { text: prompt },
          ...evidence.map((item) => ({ inlineData: { mimeType: item.mimeType, data: item.base64 } }))
        ] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
      response = await safeFetch(config, `${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, requestOptions)
    } else {
      if (config.apiKey) requestOptions.headers.Authorization = `Bearer ${config.apiKey}`
      const content = evidence.length
        ? [{ type: 'text', text: prompt }, ...evidence.map((item) => ({ type: 'image_url', image_url: { url: item.dataUrl, detail: 'low' } }))]
        : prompt
      const body = {
        model: config.model,
        messages: [{ role: 'system', content: CREATIVE_PLAN_SYSTEM }, { role: 'user', content }],
        temperature: 0.4,
        response_format: { type: 'json_object' }
      }
      requestOptions.body = JSON.stringify(body)
      response = await safeFetch(config, `${config.baseUrl}/chat/completions`, requestOptions)
      if ([400, 415, 422].includes(response.status)) {
        delete body.response_format
        requestOptions.body = JSON.stringify(body)
        response = await safeFetch(config, `${config.baseUrl}/chat/completions`, requestOptions)
      }
      if (evidence.length && [400, 415, 422].includes(response.status)) {
        usedEvidence = []
        visualFallbackReason = `当前型号 ${config.model} 拒绝图像输入，已退回字幕与拉片证据；请在模型中心切换支持视觉的型号。`
        body.messages = [{ role: 'system', content: CREATIVE_PLAN_SYSTEM }, { role: 'user', content: prompt }]
        requestOptions.body = JSON.stringify(body)
        response = await safeFetch(config, `${config.baseUrl}/chat/completions`, requestOptions)
      }
    }
    if (!response.ok) throw new Error(`创作模型返回 ${response.status}: ${(await response.text()).slice(0, 1000)}`)
    const body = await response.json()
    const text = config.protocol === 'anthropic'
      ? (body.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      : config.protocol === 'gemini'
        ? (body.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('\n')
        : body.choices?.[0]?.message?.content
    const plan = normalizeCreativePlan(extractJson(text), input)
    plan.modality = usedEvidence.length ? 'vision+text-evidence' : 'text-evidence'
    plan.provider = config.providerName
    plan.model = config.model
    plan.visualEvidenceCount = usedEvidence.length
    plan.visualFallbackReason = visualFallbackReason
    return plan
  } finally {
    clearTimeout(timeout)
  }
}

function validateOutputDirectory(outputDir) {
  const resolved = path.resolve(outputDir)
  fs.mkdirSync(resolved, { recursive: true })
  if (!fs.statSync(resolved).isDirectory()) throw new Error('创作资产目录不可用')
  return resolved
}

async function generateImageAsset(config, input = {}) {
  if (config.protocol !== 'openai') throw new Error('当前图像生成先支持 OpenAI 兼容的 /images/generations 接口；可改用“导入素材”')
  if (config.requiresKey && !config.apiKey) throw new Error('请先保存图像生成接口的 API Key')
  const prompt = safeText(input.prompt, 4000)
  if (!prompt) throw new Error('新镜头缺少图像提示词')
  // 火山方舟：Coding 端点没有图像接口，必须走标准 v3 端点 + seedream 模型
  const isVolc = /^volcengine/.test(config.providerId || '') || /volces\.com/.test(config.baseUrl || '')
  const isAgnes = config.providerId === 'agnes' || /agnes-ai\.com/.test(config.baseUrl || '')
  const baseUrl = isVolc ? 'https://ark.cn-beijing.volces.com/api/v3' : config.baseUrl
  const model = safeText(input.model, 200) || (isAgnes ? 'agnes-image-2.1-flash' : isVolc ? 'doubao-seedream-4-0-250828' : 'gpt-image-1')
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(input.signal?.reason || new Error('已取消'))
  if (input.signal) {
    if (input.signal.aborted) onOuterAbort()
    else input.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timeout = setTimeout(() => controller.abort(new Error('图像生成超时')), 180000)
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
    // agnes 的 t2i 不支持 response_format 参数（400 UnsupportedParamsError 实测），其它厂商照发
    const requestBody = { model, prompt, size: input.size || '1024x1024' }
    if (!isAgnes) requestBody.response_format = 'b64_json'
    const response = await safeFetch({ ...config, baseUrl }, `${baseUrl}/images/generations`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify(requestBody)
    })
    if (!response.ok) {
      const body = await response.text()
      if (/ModelNotOpen/i.test(body)) {
        throw new Error(`图像模型 ${model} 未在你的火山方舟账号开通：控制台「模型广场」搜 seedream 一键开通（有免费额度），开通后重试；也可以先用「导入素材」`)
      }
      throw new Error(`图像接口返回 ${response.status}: ${body.slice(0, 600)}`)
    }
    const body = await response.json()
    let bytes = null
    const base64 = body.data?.[0]?.b64_json
    if (base64) {
      bytes = Buffer.from(base64, 'base64')
    } else {
      // agnes 等厂商只回 URL：只允许从已知输出域名拉取（防不受控外链）
      const imageUrl = String(body.data?.[0]?.url || '')
      const ALLOWED_IMAGE_HOSTS = ['platform-outputs.agnes-ai.space']
      const host = /^https:\/\/([^/]+)/.exec(imageUrl)?.[1] || ''
      if (!ALLOWED_IMAGE_HOSTS.includes(host)) {
        throw new Error('图像接口没有返回 b64_json 或可信输出 URL；为避免不受控外链下载，请改用支持 base64 的接口或手动导入素材')
      }
      const imageResp = await safeFetch({ ...config, baseUrl: `https://${host}` }, imageUrl, { signal: controller.signal })
      if (!imageResp.ok) throw new Error(`图像下载失败 ${imageResp.status}`)
      bytes = Buffer.from(await imageResp.arrayBuffer())
    }
    if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error('图像结果为空或超过 30MB')
    const outputDir = validateOutputDirectory(input.outputDir)
    const outputPath = path.join(outputDir, `${safeText(input.id, 80).replace(/[^\w-]+/g, '_') || Date.now()}.png`)
    fs.writeFileSync(outputPath, bytes, { flag: 'wx' })
    return { success: true, outputPath, bytes: bytes.length }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', onOuterAbort)
  }
}

// Agnes 视频生成：POST /v1/videos 创建任务 → video_id 轮询（只认 video_id，喂 task_id 必 404）→ 白名单下载。
// 帧数必须 8n+1；视频请求与轮询共用 5 RPM，轮询间隔 ≥13s；服务端单任务串行。
function framesFor(seconds, fps = 24) {
  const target = Math.max(9, Math.ceil(seconds * fps))
  const remainder = (target - 1) % 8
  return remainder === 0 ? target : target + (8 - remainder)
}

async function generateVideoAsset(config, input = {}) {
  const isAgnes = config.providerId === 'agnes' || /agnes-ai\.com/.test(config.baseUrl || '')
  if (!isAgnes) throw new Error('视频生成当前支持 Agnes（agnes-video-v2.0）；静态镜头可走图像生成或导入素材')
  if (config.requiresKey && !config.apiKey) throw new Error('请先保存视频生成接口的 API Key')
  const prompt = safeText(input.prompt, 4000)
  if (!prompt) throw new Error('新镜头缺少视频提示词')
  const fps = Math.max(1, Math.min(60, Number(input.fps) || 24))
  const seconds = Math.max(1, Math.min(8, Number(input.duration) || 4))
  const numFrames = framesFor(seconds, fps)
  const baseUrl = config.baseUrl || 'https://apihub.agnes-ai.com/v1'
  const root = baseUrl.replace(/\/v1\/?$/, '')
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort(input.signal?.reason || new Error('已取消'))
  if (input.signal) {
    if (input.signal.aborted) onOuterAbort()
    else input.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const timeout = setTimeout(() => controller.abort(new Error('视频生成超时（20 分钟）')), 20 * 60 * 1000)
  try {
    if (controller.signal.aborted) throw new Error('已取消')
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }
    // Agnes 视频参数名是 width/height/num_frames/frame_rate（写成 size/fps 会 401"无效的令牌"）
    const [width, height] = String(input.size || '1280x720').toLowerCase().split('x').map((v) => Number(v) || 0)
    const body = { model: safeText(input.model, 200) || 'agnes-video-v2.0', prompt, width: width || 1280, height: height || 720, num_frames: numFrames, frame_rate: fps }
    if (input.imageBase64) {
      // 图生视频：必须纯 base64（带 data-URI 前缀会报 Incorrect padding）
      body.image = String(input.imageBase64).replace(/^data:image\/[a-z]+;base64,/i, '')
    }
    let videoId = safeText(input.resumeVideoId, 300)
    if (!videoId) {
      let created = null
      let createdText = ''
      // 服务端单任务串行：队列满/Service busy/网络抖动都按忙时退避重试（safeFetch 对网络错误直接抛出）
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          created = await safeFetch({ ...config, baseUrl }, `${baseUrl}/videos`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
          if (created.ok) break
          createdText = await created.text()
        } catch (error) {
          createdText = error instanceof Error ? error.message : String(error)
        }
        const busy = !created || created.status === 503 || /Service busy|queue full|queue_full|fetch failed|ECONNRESET|ETIMEDOUT|timeout/i.test(createdText)
        if (!busy || controller.signal.aborted) break
        await abortableDelay(45000, controller.signal)
      }
      if (!created || !created.ok) {
        if (/rate limit/i.test(createdText)) throw new Error('Agnes 视频今日额度已打满（UTC 计日，北京 08:00 重置）；明天再试或减镜头数')
        throw new Error(`视频生成请求返回 ${created ? created.status : '网络错误'}: ${createdText.slice(0, 500)}`)
      }
      const createdBody = await created.json()
      videoId = String(createdBody.video_id || '')
      // 铁律：创建响应必须存在 video_id，否则立即失败并保留原响应（拿 task_id 轮询必 404）
      if (!videoId) throw new Error(`视频任务创建响应缺少 video_id：${JSON.stringify(createdBody).slice(0, 400)}`)
      input.onCheckpoint?.({ stage: 'remote-created', videoId, numFrames })
    }
    const started = Date.now()
    let completed = null
    while (Date.now() - started < 19 * 60 * 1000) {
      await abortableDelay(13000, controller.signal)
      // 轮询期网络抖动照常继续（长任务跑到十几分钟，断一次就全盘输太亏）
      const poll = await safeFetch({ ...config, baseUrl: root }, `${root}/agnesapi?video_id=${encodeURIComponent(videoId)}`, { headers, signal: controller.signal }).catch(() => null)
      if (!poll || !poll.ok) continue
      const status = await poll.json()
      const state = String(status.status || status.state || status.internal_status || '').toLowerCase()
      if (state === 'completed' || state === 'succeeded' || state === 'success' || status.video_url || status.url) {
        completed = status
        break
      }
      if (state === 'failed' || state === 'error') throw new Error(`视频生成失败：${JSON.stringify(status).slice(0, 300)}`)
    }
    if (!completed) throw new Error('视频生成超时（19 分钟未完成）')
    const videoUrl = String(completed.video_url || completed.url || '')
    const host = /^https:\/\/([^/]+)/.exec(videoUrl)?.[1] || ''
    const ALLOWED_VIDEO_HOSTS = ['platform-outputs.agnes-ai.space']
    if (!ALLOWED_VIDEO_HOSTS.includes(host)) throw new Error(`视频完成但未返回可信下载地址：${JSON.stringify(completed).slice(0, 300)}`)
    // 下载地址是预签名公开 URL：带 Authorization 头反而 401（实测），裸拉
    const videoResp = await safeFetch({ ...config, baseUrl: `https://${host}` }, videoUrl, { signal: controller.signal })
    if (!videoResp.ok) throw new Error(`视频下载失败 ${videoResp.status}`)
    const bytes = Buffer.from(await videoResp.arrayBuffer())
    if (!bytes.length || bytes.length > 200 * 1024 * 1024) throw new Error('视频结果为空或超过 200MB')
    const outputDir = validateOutputDirectory(input.outputDir)
    const outputPath = path.join(outputDir, `${safeText(input.id, 80).replace(/[^\w-]+/g, '_') || Date.now()}.mp4`)
    fs.writeFileSync(outputPath, bytes, { flag: 'wx' })
    return { success: true, outputPath, bytes: bytes.length, videoId, numFrames }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', onOuterAbort)
  }
}

async function synthesizeCloudVoice(config, input = {}) {
  if (config.protocol !== 'openai') throw new Error('当前云配音先支持 OpenAI 兼容的 /audio/speech 接口；也可使用本机系统配音')
  const text = safeText(input.text, 20000)
  if (!text) throw new Error('旁白文本为空')
  const outputDir = validateOutputDirectory(input.outputDir)
  const outputPath = path.join(outputDir, `narration-${Date.now()}.mp3`)
  const headers = { 'Content-Type': 'application/json' }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error('云配音超时')), 180000)
  try {
    const response = await safeFetch(config, `${config.baseUrl}/audio/speech`, {
      method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ model: safeText(input.model, 200) || 'gpt-4o-mini-tts', voice: safeText(input.voice, 100) || 'alloy', input: text, format: 'mp3' })
    })
    if (!response.ok) throw new Error(`配音接口返回 ${response.status}: ${(await response.text()).slice(0, 1000)}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error('配音结果为空或超过 100MB')
    fs.writeFileSync(outputPath, bytes, { flag: 'wx' })
    return { success: true, outputPath, bytes: bytes.length, engine: 'cloud' }
  } finally {
    clearTimeout(timeout)
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, ...options })
    options.onSpawn?.(child)
    let logs = ''
    child.stdout?.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-12000) })
    child.stderr?.on('data', (chunk) => { logs = (logs + chunk.toString()).slice(-12000) })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error('任务已取消'))
      else if (code === 0) resolve({ code, logs })
      else reject(new Error(`进程退出码 ${code}${logs ? `：${logs.split(/\r?\n/).filter(Boolean).slice(-10).join(' ')}` : ''}`))
    })
  })
}

async function synthesizeSystemVoice(input = {}) {
  const text = safeText(input.text, 20000)
  if (!text) throw new Error('旁白文本为空')
  const outputDir = validateOutputDirectory(input.outputDir)
  const outputStem = safeText(input.id, 80).replace(/[^\w\-㐀-鿿]+/g, '_')
  if (process.platform === 'win32') {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-voice-'))
    const textPath = path.join(tempDir, 'narration.txt')
    const outputPath = path.join(outputDir, `${outputStem || `narration-${Date.now()}`}.wav`)
    const helperPath = path.resolve(String(input.helperPath || ''))
    if (!fs.existsSync(helperPath) || !fs.statSync(helperPath).isFile()) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      throw new Error('本机配音组件缺失，请重新安装完整版本')
    }
    fs.writeFileSync(textPath, `\uFEFF${text}`, 'utf16le')
    try {
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size >= 1000) return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'windows-sapi' }
      await runProcess(helperPath, [textPath, outputPath, String(Math.max(-5, Math.min(5, Number(input.rate) || 0)))])
      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) throw new Error('系统配音没有生成有效音频')
      return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'windows-sapi' }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
  if (process.platform === 'darwin') {
    const outputPath = path.join(outputDir, `${outputStem || `narration-${Date.now()}`}.aiff`)
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size >= 1000) return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'macos-say' }
    await runProcess('say', ['-o', outputPath, text])
    return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'macos-say' }
  }
  const outputPath = path.join(outputDir, `${outputStem || `narration-${Date.now()}`}.wav`)
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size >= 1000) return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'espeak-ng' }
  await runProcess('espeak-ng', ['-w', outputPath, text])
  return { success: true, outputPath, bytes: fs.statSync(outputPath).size, engine: 'espeak-ng' }
}

function assTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = Math.floor(value % 60)
  const cs = Math.floor((value % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function escapeAss(value) {
  return safeText(value, 1000).replace(/\{[^}]*\}/g, '').replace(/\\/g, '＼').replace(/\r?\n/g, '\\N')
}

function buildSubtitleAss(shots = [], style = 'clean') {
  const preset = style === 'impact'
    ? { font: 52, outline: 5, margin: 72, primary: '&H00FFFFFF', back: '&H80000000' }
    : style === 'documentary'
      ? { font: 40, outline: 2, margin: 54, primary: '&H00F4F0E8', back: '&H70000000' }
      : { font: 44, outline: 3, margin: 64, primary: '&H00FFFFFF', back: '&H70000000' }
  let cursor = 0
  const dialogues = []
  for (const shot of shots) {
    const duration = Math.max(0.2, Number(shot.duration) || 3)
    const caption = escapeAss(shot.caption || shot.narration)
    if (caption) dialogues.push(`Dialogue: 0,${assTime(cursor)},${assTime(cursor + duration)},Default,,0,0,0,,${caption}`)
    cursor += duration
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,Microsoft YaHei,${preset.font},${preset.primary},&H000000FF,&H00101010,${preset.back},-1,0,0,0,100,100,0,0,1,${preset.outline},1,2,60,60,${preset.margin},1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogues.join('\n')}\n`
}

function validateCreativeTimeline(input = {}) {
  const needsSource = (input.shots || []).some((shot) => shot.kind !== 'generated')
  // 纯 AI 新镜头时间线不需要源视频；只有用到来源片段时才校验原视频存在
  let sourcePath = ''
  if (needsSource) {
    sourcePath = path.resolve(String(input.sourcePath || ''))
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new Error('原视频不存在')
  }
  const segments = new Map((input.segments || []).map((segment) => [String(segment.id), segment]))
  const shots = (input.shots || []).slice(0, 100).map((shot, index) => {
    if (shot.kind === 'generated') {
      const assetPath = path.resolve(String(shot.assetPath || ''))
      if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) throw new Error(`第 ${index + 1} 个 AI 新镜头尚未生成或导入素材`)
      return { ...shot, kind: 'generated', assetPath, duration: Math.max(1, Math.min(30, Number(shot.duration) || 3)) }
    }
    const segment = segments.get(String(shot.segmentId))
    const start = Number(segment?.start)
    const end = Number(segment?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error(`第 ${index + 1} 个来源片段无效`)
    return { ...shot, kind: 'source', sourcePath, start, end, duration: end - start }
  })
  if (!shots.length) throw new Error('创作时间线为空')
  return shots
}

async function renderCreativeVideo({ mpvPath, ffmpegPath, input, outputPath, onSpawn }) {
  if (!mpvPath || !fs.existsSync(mpvPath)) throw new Error('视频渲染内核不可用')
  const shots = validateCreativeTimeline(input)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-player-creative-'))
  const videoCodec = process.platform === 'win32' ? 'h264_mf' : 'mpeg4'
  const ffmpegOk = Boolean(ffmpegPath && fs.existsSync(ffmpegPath))
  let activeChild = null
  const spawnHook = (child) => { activeChild = child; onSpawn?.(child) }
  try {
    const clipPaths = []
    for (const [index, shot] of shots.entries()) {
      const clipPath = path.join(tempDir, `clip-${String(index).padStart(3, '0')}.mp4`)
      const source = shot.kind === 'source' ? shot.sourcePath : shot.assetPath
      if (ffmpegOk) {
        // 镜头预渲染用 ffmpeg：mpv 对单张图片产出无时长文件（EDL 组合必炸）
        const filter = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p'
        const isVideoAsset = /\.(mp4|mov|webm|mkv)$/i.test(source)
        const ffArgs = shot.kind === 'source'
          ? ['-hide_banner', '-loglevel', 'error', '-ss', String(shot.start), '-i', source, '-t', String(shot.duration), '-vf', filter, '-c:v', 'libx264', '-an', '-y', clipPath]
          : isVideoAsset
            ? ['-hide_banner', '-loglevel', 'error', '-i', source, '-t', String(shot.duration), '-vf', filter, '-c:v', 'libx264', '-an', '-y', clipPath]
            : ['-hide_banner', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-i', source, '-t', String(shot.duration), '-vf', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', clipPath]
        await runProcess(ffmpegPath, ffArgs, { onSpawn: spawnHook })
      } else {
        const args = [source, '--no-config', '--no-audio', '--no-sub', '--of=mp4', `--ovc=${videoCodec}`, '--vf=lavfi=[scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p]', `--o=${clipPath}`]
        if (shot.kind === 'source') args.push(`--start=${shot.start}`, `--length=${shot.duration}`)
        else args.push(`--length=${shot.duration}`, `--image-display-duration=${shot.duration}`)
        await runProcess(mpvPath, args, { onSpawn: spawnHook })
      }
      if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size < 1000) throw new Error(`第 ${index + 1} 个镜头预渲染失败`)
      clipPaths.push(clipPath)
    }

    const edlPath = path.join(tempDir, 'timeline.edl')
    const edl = `# mpv EDL v0\n${clipPaths.map((clip) => {
      const normalized = clip.replace(/\\/g, '/')
      return `%${Buffer.byteLength(normalized, 'utf8')}%${normalized}`
    }).join('\n')}\n`
    fs.writeFileSync(edlPath, edl, 'utf8')
    const assPath = path.join(tempDir, 'captions.ass')
    fs.writeFileSync(assPath, buildSubtitleAss(shots, input.subtitleStyle), 'utf8')
    const totalDuration = shots.reduce((sum, shot) => sum + shot.duration, 0)
    const args = [edlPath, '--no-config', '--of=mp4', `--ovc=${videoCodec}`, '--oac=aac', `--sub-file=${assPath}`, '--sub-auto=no', '--sub-visibility=yes', `--length=${totalDuration}`, `--o=${outputPath}`]
    const audioFiles = []
    if (input.voicePath && fs.existsSync(input.voicePath)) audioFiles.push(path.resolve(input.voicePath))
    if (input.musicPath && fs.existsSync(input.musicPath)) audioFiles.push(path.resolve(input.musicPath))
    for (const audio of audioFiles) args.push(`--audio-file=${audio}`)
    if (audioFiles.length === 2) {
      const musicVolume = Math.max(0.02, Math.min(0.5, Number(input.musicVolume) || 0.12))
      args.push(`--lavfi-complex=[aid1]volume=1.0,asplit=2[voice][key];[aid2]volume=${musicVolume}[music];[music][key]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[ducked];[voice][ducked]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[ao]`)
    }
    await runProcess(mpvPath, args, { onSpawn: spawnHook })
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) throw new Error('创意成片没有生成有效文件')
    return { success: true, outputPath, bytes: fs.statSync(outputPath).size, shots: shots.length, duration: totalDuration }
  } catch (error) {
    if (activeChild?.killed) throw new Error('渲染已取消')
    throw error
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
  }
}

module.exports = {
  abortableDelay,
  buildCreativePrompt,
  buildSubtitleAss,
  collectVisualEvidence,
  extractJson,
  framesFor,
  generateImageAsset,
  generateVideoAsset,
  normalizeCreativePlan,
  renderCreativeVideo,
  requestCreativePlan,
  synthesizeCloudVoice,
  synthesizeSystemVoice,
  validateCreativeTimeline
}
