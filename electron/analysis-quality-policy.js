function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const secs = Math.floor(value % 60)
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':')
}

function languageStats(text) {
  const value = String(text || '')
  return {
    cjk: (value.match(/[\u3400-\u9fff]/g) || []).length,
    latin: (value.match(/[A-Za-z]/g) || []).length
  }
}

function detectSourceLanguage(cues) {
  const stats = languageStats((Array.isArray(cues) ? cues : []).map((cue) => cue.text).join(' '))
  return stats.cjk >= Math.max(12, stats.latin * 0.35) ? '中文' : stats.latin > 0 ? '英文' : '未知'
}

function cleanLine(value, maxLength = 88) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).replace(/[，。；：,.!?\s]+$/u, '')}…`
}

function sampleCues(cues, limit = 6) {
  if (!Array.isArray(cues) || cues.length <= limit) return Array.isArray(cues) ? cues : []
  const picked = []
  for (let index = 0; index < limit; index += 1) {
    const cueIndex = Math.round(index * (cues.length - 1) / (limit - 1))
    if (!picked.includes(cues[cueIndex])) picked.push(cues[cueIndex])
  }
  return picked
}

function uniqueCueSummaries(cues, limit = 5) {
  const seen = new Set()
  const summaries = []
  for (const cue of cues || []) {
    const text = cleanLine(cue.text, 76)
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    summaries.push({ ...cue, text })
    if (summaries.length >= limit) break
  }
  return summaries
}

function buildEvidenceAnalysis({ mediaName, duration, cues = [], translatedCues = [], frameCount = 0 }) {
  const sourceLanguage = detectSourceLanguage(cues)
  const usableCues = translatedCues.length === cues.length && translatedCues.length ? translatedCues : cues
  const translated = usableCues === translatedCues
  const first = usableCues[0]
  const last = usableCues[usableCues.length - 1]
  const averageCueSeconds = cues.length
    ? cues.reduce((sum, cue) => sum + Math.max(0, Number(cue.end) - Number(cue.start)), 0) / cues.length
    : 0
  const sourceText = cues.map((cue) => cue.text).join(' ')
  const sourceStats = languageStats(sourceText)
  const words = (sourceText.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length
  const perMinute = duration > 0
    ? Math.round((sourceLanguage === '英文' ? words : sourceStats.cjk) / duration * 60)
    : 0
  const densityUnit = sourceLanguage === '英文' ? '英文词' : '中文字'
  const timeline = sampleCues(usableCues).map((cue) =>
    `- ${formatTime(cue.start)}–${formatTime(cue.end)}：${cleanLine(cue.text)}`
  )
  const claims = uniqueCueSummaries(usableCues)
  const defects = []
  if (!frameCount) defects.push('- **画面证据不足**：本次没有关键帧，不能评价景别、构图、表演或真实剪辑点；报告不会用字幕时间冒充镜头时间。')
  if (averageCueSeconds > 12) defects.push(`- **字幕颗粒过粗**：平均每条覆盖 ${averageCueSeconds.toFixed(1)} 秒，难以精确定位 0–3 秒钩子和句间节奏；建议先细化到每条 3–8 秒。`)
  if (cues.length < 6) defects.push(`- **证据分段不足**：全片只有 ${cues.length} 条字幕，当前结论适合做内容骨架，不应冒充逐镜拉片。`)
  if (!translated && sourceLanguage === '英文') defects.push('- **语义翻译缺失**：源字幕为英文，但本机未提供可用中文翻译；以下仅保留短证据，不把英文原文大段复制成“中文报告”。')
  const hasAction = /(subscribe|follow|click|visit|download|注册|关注|点击|下载|购买|评论)/i.test(sourceText)
  if (!hasAction) defects.push('- **行动点不明确**：字幕证据里未发现清晰的关注、注册、下载或下一步指令，结尾转化链可能中断。')

  const positioning = first
    ? `视频从“${cleanLine(first.text, 64)}”切入，随后围绕这一主题逐步展开；${last ? `结尾落在“${cleanLine(last.text, 52)}”。` : ''}`
    : '没有可用字幕，当前只能确认媒体文件，不能可靠判断内容主题。'
  const languageNote = sourceLanguage === '英文'
    ? `源字幕为英文；${translated ? '本报告使用本地翻译后的中文证据组织结论，原英文不做大段堆叠。' : '当前未取得可靠中文翻译，只做结构性判断。'}`
    : `源字幕为${sourceLanguage}；报告语言固定为中文。`

  return [
    '## 第一部分　视频讲了什么',
    '',
    '### 一句话精华',
    `- ${positioning}`,
    `- ${languageNote}`,
    '',
    '### 全片结构时间轴',
    timeline.length ? timeline.join('\n') : '- 无字幕时间轴，不能生成可信段落划分。',
    '',
    '### 内容精华',
    claims.length ? claims.map((cue, index) => `- **要点 ${index + 1}（${formatTime(cue.start)}）**：${cue.text}`).join('\n') : '- 缺少可核对的字幕结论。',
    `- **信息密度**：约 ${perMinute || '无法计算'} ${perMinute ? densityUnit + '/分钟' : ''}；平均字幕跨度 ${averageCueSeconds ? averageCueSeconds.toFixed(1) + ' 秒' : '无法计算'}。`,
    '',
    '### 可复制的内容结构',
    first
      ? `- 开场证据位于 ${formatTime(first.start)}–${formatTime(first.end)}：“${cleanLine(first.text, 72)}”。${Number(first.end) - Number(first.start) > 12 ? '该字幕跨度过长，无法把真正的 0–3 秒钩子从中准确分离。' : '可以继续结合首帧验证画面是否同步兑现这句话。'}`
      : '- 没有开场字幕证据，暂不判断钩子。',
    '- 先用一句话定义角色或核心冲突，中段每一段只推进一个新事实，结尾用一个明确行动点收束。',
    '',
    '## 第二部分　专业视听拆解与 AI 复刻',
    '',
    '### 画面证据边界',
    `- ${frameCount ? `已有 ${frameCount} 张关键帧，可据此继续核对构图与节奏。` : '本次没有可用关键帧，因此不编造景别、机位、焦段、灯光、表演或真实剪辑点。'}`,
    '',
    '### 当前可确认的节奏与声音线索',
    `- 字幕平均跨度为 ${averageCueSeconds ? averageCueSeconds.toFixed(1) + ' 秒' : '无法计算'}；这只能说明口播分段颗粒，不能替代真实镜头切点。`,
    '- 未取得可核对的音频分析数据时，不猜测配乐、音效、麦克风型号或混音参数。',
    '',
    '### AI 复刻执行方案',
    defects.length ? defects.join('\n') : '- 当前证据未触发基础质量警报；仍建议人工复核关键帧与事实来源。',
    '- **改法 1｜开头**：把核心反差或最终收益压缩成 0–3 秒的一句话，首帧同时展示可验证结果，不先铺长背景。',
    '- **改法 2｜中段**：每 15–25 秒只推进一个新信息点；删掉同义复述，并用数据、演示或案例补足证据。',
    '- **改法 3｜结尾**：用一句明确行动指令收束；若目标是产品转化，应说明用户下一步做什么以及能得到什么。',
    '- **改法 4｜复核**：接入可看图的云端模型后再补齐摄影、构图、灯光、色彩、剪辑、字幕与声音分析；在此之前，本报告只作为字幕证据版内容拆解。'
  ].join('\n')
}

function evaluateAnalysisQuality(text, { outputLanguage = 'zh-CN', requireDeepStructure = false } = {}) {
  const value = String(text || '').trim()
  const reasons = []
  if (!value) reasons.push('模型没有返回内容')
  const stats = languageStats(value)
  if (/^zh/i.test(outputLanguage) && stats.latin > Math.max(120, stats.cjk * 1.6)) reasons.push('报告英文占比过高，不符合中文界面输出契约')
  if (/信息密度\s*[：:]\s*0(?:\D|$)/.test(value)) reasons.push('报告把信息密度写成 0，属于无效指标')
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 12 && !/^#+\s/.test(line))
  const counts = new Map()
  for (const line of lines) {
    const key = line.toLowerCase().replace(/\s+/g, ' ')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  if ([...counts.values()].some((count) => count >= 3) || /(?:镜头|节奏)[^\n]{0,80}(?:镜头|节奏)/.test(value) && /(?:时长[^\n]+){3,}/.test(value)) {
    reasons.push('报告存在成段重复或模板循环')
  }
  if (requireDeepStructure) {
    const headings = value.match(/^##\s+.+$/gm) || []
    if (headings.length < 4) reasons.push('深度报告结构不足，缺少必要分析章节')
    if (stats.cjk < 180) reasons.push('深度报告有效中文篇幅不足')
    if (!/(建议|改法|优化|行动点|可执行)/.test(value)) reasons.push('深度报告缺少可执行建议')
    if (!/(?:\d{2}:\d{2}|“[^”]{4,}”|「[^」]{4,}」)/.test(value)) reasons.push('深度报告缺少时间点或原句证据')
  }
  return { ok: reasons.length === 0, reasons, stats }
}

function timestampSeconds(value) {
  const parts = String(value || '').split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return null
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return null
}

function timelinePoints(text) {
  return [...String(text || '').matchAll(/\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g)]
    .map((match) => timestampSeconds(match[1] === undefined ? `${match[2]}:${match[3]}` : `${match[1]}:${match[2]}:${match[3]}`))
    .filter((value) => value !== null)
}

function evaluateProfessionalAnalysisQuality(text, { duration = 0, hasVisualEvidence = false } = {}) {
  const value = String(text || '').trim()
  const base = evaluateAnalysisQuality(value, { outputLanguage: 'zh-CN' })
  const reasons = [...base.reasons]
  const h1 = value.match(/^#\s+.+$/gm) || []
  const h2 = [...value.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim())
  if (h1.length) reasons.push('模型正文不得另加总标题，正式文档标题由渲染器统一生成')
  if (h2.length !== 2 || !/^第一部分[　\s]+视频讲了什么/.test(h2[0] || '') || !/^第二部分[　\s]+专业视听拆解与\s*AI\s*复刻/i.test(h2[1] || '')) {
    reasons.push('专业拉片报告必须正好两个部分：视频讲了什么；专业视听拆解与 AI 复刻')
  }
  const minimumCjk = Number(duration) <= 30 ? 260 : Number(duration) <= 180 ? 600 : 900
  if (base.stats.cjk < minimumCjk) reasons.push(`专业报告有效中文不足（至少 ${minimumCjk} 字）`)
  if (base.stats.cjk > 9000) reasons.push('专业报告过长，需删除重复说明和无关附录')
  if (!/(一句话精华|内容精华|内容主线)/.test(value) || !/(全片结构时间轴|结构时间轴)/.test(value)) {
    reasons.push('第一部分必须包含内容精华和全片结构时间轴')
  }
  const productionChecks = [
    ['摄影与镜头', /(摄影|机位|景别|镜头)/],
    ['构图', /构图/],
    ['灯光与曝光', /(灯光|布光|曝光)/],
    ['剪辑与节奏', /(剪辑|转场|节奏)/],
    ['字幕与声音', /(字幕|声音|口播|配乐|音效|混音)/],
    ['AI 复刻', /(AI\s*复刻|复刻执行|生成提示词|素材清单)/i]
  ]
  const missing = productionChecks.filter(([, pattern]) => !pattern.test(value)).map(([label]) => label)
  if (missing.length) reasons.push(`第二部分缺少专业项目：${missing.join('、')}`)
  if (hasVisualEvidence && !/(原片观察|画面观察|视觉证据)/.test(value)) reasons.push('有画面证据时必须明确标注原片观察')
  if (!/(复刻动作|复刻时|执行方案|制作步骤)/.test(value)) reasons.push('第二部分缺少可直接执行的复刻动作')

  const points = [...new Set(timelinePoints(value))].sort((a, b) => a - b)
  const d = Number(duration) || 0
  const minPoints = d <= 30 ? 2 : d <= 180 ? 5 : 8
  if (points.length < minPoints) reasons.push(`时间轴证据不足，至少需要 ${minPoints} 个不同时间点`)
  if (d > 0 && (points.length === 0 || points[0] > Math.max(5, d * 0.08) || points[points.length - 1] < d * 0.75)) {
    reasons.push('结构时间轴没有覆盖全片开头到结尾')
  }
  for (const line of value.split(/\r?\n/).filter((item) => /\b\d{2,3}\s*mm\b/i.test(item))) {
    if (!/(估算|推断|等效|可能|建议)/.test(line)) {
      reasons.push('焦段等无法从单帧精确确认的参数必须标注为专业估算或推断')
      break
    }
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], stats: base.stats, timeline: points }
}

function isUnderpoweredLocalAnalysisModel(model = {}) {
  if (!model.local) return false
  const name = String(model.model || '').toLowerCase()
  return /(?:^|[^0-9])0\.[0-9]+\s*b\b|(?:^|[-_:])(1|1\.5|2)\s*b\b|tiny|mini.*(?:0\.|1b|2b)/i.test(name)
}

module.exports = {
  buildEvidenceAnalysis,
  detectSourceLanguage,
  evaluateAnalysisQuality,
  evaluateProfessionalAnalysisQuality,
  isUnderpoweredLocalAnalysisModel
}
