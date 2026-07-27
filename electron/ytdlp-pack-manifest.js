// yt-dlp 站点视频解析组件清单：yt-dlp 与 ffmpeg 均直接引用官方 GitHub Release（不经我们转发），
// SHA-256 均已本地下载复核（2026-07-27）。
module.exports = {
  schemaVersion: 1,
  tag: 'yt-dlp-2026.07.04-ffmpeg-8.0.1',
  product: 'AgentPlay 站点视频解析组件（yt-dlp + ffmpeg 官方版）',
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
    },
    {
      id: 'ffmpeg-essentials-win-x64',
      kind: 'zip',
      label: 'ffmpeg 8.0.1 essentials（GyanD 官方构建）',
      url: 'https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip',
      size: 106259850,
      sha256: 'e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673',
      files: [
        {
          path: 'ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe',
          size: 99264000,
          sha256: '5af82a0d4fe2b9eae211b967332ea97edfc51c6b328ca35b827e73eac560dc0d'
        },
        {
          path: 'ffmpeg-8.0.1-essentials_build/bin/ffprobe.exe',
          size: 99066368,
          sha256: '192a1d6899059765ac8c39764fc3148d4e6049955956dc2029f81f4bd6a8972d'
        }
      ]
    }
  ]
}
