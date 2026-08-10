# AI播放器 0.7.6 候选版多端验证状态

本文件只记录实际证据。能编译、能同步工程、能生成安装包和能在真机完整使用是四种不同结论。

## 当前结论（2026-08-10）

| 端 | 已验证 | 尚未验证 / 阻塞 |
|---|---|---|
| Windows 11 x64 | 414/414 自动化测试；TypeScript、ESLint、Vite 6 Web/PWA 构建；生产依赖 209 项、全依赖 988 项的审计均为 0 漏洞；Electron 43.3.0 + electron-builder 26.15.7 的 0.7.6 标准版安装包（202,453,185 字节，SHA-256 `B6680A6AE570268D4BA81D5E74CC3DE2D626063FBADCF7387467606F7F63E8CF`）；正式 EXE 完成视频加载、控制层显隐、统一拉片对话、文档能力和 X/Facebook 双下载选项冒烟；X 公公开视频已由真实 yt-dlp 链下载并校验 MP4；PPTX 已改为 JSZip/Open XML 确定性生成，成品 ASAR 不含 `pptxgenjs`/`image-size`，并由 PowerPoint 完成真实打开验证；DOCX/PPTX/Excel/PDF、OCR、转写、mpv/SAPI 等原有链路继续全量回归 | 0.7.6 未发布且未购买 Authenticode 证书，安装时显示未知发布者；Facebook 本轮没有可用登录 Cookies，已验证登录/导入入口与诚实失败提示，但登录后真实媒体下载仍待用户态闭环；Win11 第一层右键菜单仍受系统限制；其他平台未交付 |
| Web PWA | Vite 生产构建退出 0；产物包含 index、JS、CSS、manifest、service worker | 浏览器没有 Electron IPC，不能直接访问本地模型密钥库、SAPI、mpv 创意渲染；不能算桌面功能等价 |
| Android | Capacitor 8.5.0 依赖已安装；历史 `sync android` 曾成功 | 0.7.6 尚未重做 sync、APK 构建与真机验证；文件选择、后台音频、AI 成片均未验证 |
| macOS | CI 构建定义存在；代码对系统 `say` 配音有适配 | 本机不是 Mac，未生成/启动 DMG；仓库没有 macOS mpv 闭包，高级 MP4 渲染会明确显示不可用 |
| Linux | CI 构建定义存在；代码对 `espeak-ng` 有适配 | WSL 有 Linux 内核但未形成可分发 mpv 闭包；AppImage/deb 启动、桌面集成和高级渲染未通过 |
| iOS | 尚无 0.7.6 实机证据 | 需要 macOS、Xcode、iOS 工程、签名和真机；当前不能称已交付 |

## 已固化的验证入口

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm exec eslint src --max-warnings=0
pnpm build:web
node node_modules/@capacitor/cli/bin/capacitor sync android
pnpm platform:report -- --require-creative
node scripts/smoke-creative-render.mjs --packaged
node scripts/smoke-packaged-ui.mjs
node scripts/smoke-packaged-download.mjs
node scripts/verify-office-quality.cjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-office-com.ps1
pnpm security:scan:packaged
pnpm audit --prod --registry=https://registry.npmjs.org
pnpm audit --registry=https://registry.npmjs.org
pnpm release:verify
```

`scripts/platform-capability-report.mjs` 会为每个构建机写出 `release/platform-capabilities-<platform>-<arch>.json`。应用运行时也会检查本端是否真的有系统配音和 mpv 渲染内核；缺失时禁用最终 MP4 按钮，不允许把“界面存在”冒充“功能可用”。

## GitHub Actions

`.github/workflows/build.yml` 已配置 Windows、macOS、Ubuntu 三个平台的测试、Web 构建、能力报告和安装包任务，但本轮没有推送代码或触发远程工作流，因此不能把该 YAML 当成 macOS/Linux 已通过的证据。

下一步要把其余端提升为完整交付，必须在对应系统补齐可再分发的媒体渲染闭包，并完成：安装 → 打开横/竖屏视频 → 右键/文件关联 → 多模态拉片 → 新镜头/配音/字幕/音乐 → 导出成片 → 重启恢复项目的端到端测试。
