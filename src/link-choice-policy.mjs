export function buildLinkChoice(detection, text) {
  if (!detection?.matched || !detection.url) return null
  return {
    url: String(detection.url),
    text: String(text || ''),
    direct: detection.direct !== false,
    // 链接命中后始终保留用户选择权；mode 只表达语句倾向，不得隐藏“下载并拉片”。
    canAnalyze: true
  }
}
