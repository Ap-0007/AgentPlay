// yt-dlp 站点视频解析组件清单：直接引用 yt-dlp 官方 GitHub Release（不经我们转发），
// SHA-256 与官方 SHA2-256SUMS 一致并已本地下载复核（2026-07-27）。
module.exports = {
  schemaVersion: 1,
  tag: 'yt-dlp-2026.07.04',
  product: 'AgentPlay 站点视频解析组件（yt-dlp 官方版）',
  assets: [
    {
      id: 'yt-dlp-win-x64',
      kind: 'file',
      label: 'yt-dlp 2026.07.04（yt-dlp 官方发布）',
      path: 'yt-dlp.exe',
      role: 'engine',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe',
      size: 18226085,
      sha256: '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8'
    }
  ]
}
