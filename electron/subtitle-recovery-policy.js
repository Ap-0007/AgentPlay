const AGNES_PRICING_URL = 'https://wiki.agnes-ai.com/en/docs/agnes-25-flash'
const AGNES_PRICING_VERIFIED_AT = '2026-08-11'

function roundedMb(bytes) {
  return Math.max(1, Math.round((Number(bytes) || 0) / 1024 / 1024))
}

function buildWhisperRecovery({ packBytes = 0, durationSeconds = 0, targetLang = '中文' } = {}) {
  const durationMinutes = Math.max(0, Math.ceil((Number(durationSeconds) || 0) / 60))
  const timeLabel = durationMinutes
    ? `视频约 ${durationMinutes} 分钟；组件下载后，本机 CPU 识别约 ${durationMinutes}–${durationMinutes * 4} 分钟`
    : '组件下载后，本机 CPU 识别通常约为视频时长的 1–4 倍'
  return {
    kind: 'install-whisper',
    title: '先安装离线语音识别组件',
    detail: '这个视频旁边没有现成字幕，需要先在本机把语音转成带时间轴的字幕。',
    actionLabel: `安装并继续（约 ${roundedMb(packBytes)}MB）`,
    canAutoFix: true,
    downloadBytes: Number(packBytes) || 0,
    estimatedRequests: 0,
    timeLabel,
    costLabel: '本地免费 · 视频和音频不上传',
    targetLang
  }
}

function buildOfflineTranslateRecovery({ packBytes = 0, entryCount = 0, targetLang = '中文' } = {}) {
  const count = Math.max(0, Math.round(Number(entryCount) || 0))
  const minMinutes = Math.max(1, Math.ceil(count / 120))
  const maxMinutes = Math.max(2, Math.ceil(count / 40))
  return {
    kind: 'install-translate',
    title: '安装本地英译中组件',
    detail: `已找到 ${count} 段英文字幕，只差离线翻译组件；安装后会自动继续并直接显示中文字幕。`,
    actionLabel: `安装并继续（约 ${roundedMb(packBytes)}MB）`,
    canAutoFix: true,
    downloadBytes: Number(packBytes) || 0,
    estimatedRequests: 0,
    timeLabel: `${count} 段字幕首次加载后约 ${minMinutes}–${maxMinutes} 分钟，取决于 CPU`,
    costLabel: '本地免费 · 字幕不离开电脑',
    targetLang
  }
}

function buildCloudTranslateRecovery({ entryCount = 0, targetLang = '英文' } = {}) {
  const count = Math.max(0, Math.round(Number(entryCount) || 0))
  const estimatedRequests = Math.max(1, Math.ceil(count / 20))
  const timeLabel = estimatedRequests <= 5
    ? `${count} 段字幕约 ${estimatedRequests} 次文本请求，通常 10–60 秒`
    : `${count} 段字幕约 ${estimatedRequests} 次文本请求，通常 1–${Math.max(2, Math.ceil(estimatedRequests / 3))} 分钟`
  return {
    kind: 'configure-cloud',
    title: '中文转英文需要一个云端文本模型',
    detail: '推荐接入 Agnes 2.5 Flash。只发送字幕原文，不上传视频；保存 Key 后会自动回来继续。',
    actionLabel: '接入 Agnes 并继续',
    canAutoFix: false,
    downloadBytes: 0,
    estimatedRequests,
    timeLabel,
    costLabel: 'Agnes 2.5 Flash 当前公开价约 $0；实际以账户权益与 Billing 为准',
    targetLang,
    providerId: 'agnes',
    model: 'agnes-2.5-flash',
    pricingUrl: AGNES_PRICING_URL,
    pricingVerifiedAt: AGNES_PRICING_VERIFIED_AT
  }
}

module.exports = {
  AGNES_PRICING_URL,
  AGNES_PRICING_VERIFIED_AT,
  buildWhisperRecovery,
  buildOfflineTranslateRecovery,
  buildCloudTranslateRecovery
}
