# AgentPlay 0.8.0 候选版多端验证状态

本文件只记录实际证据。能编译、能同步工程、能生成安装包和能在真机完整使用是四种不同结论。

## 当前结论（2026-08-13）

| 端 | 已验证 | 尚未验证 / 阻塞 |
|---|---|---|
| Windows 11 x64 | 619 项自动化测试（616 通过、0 失败、3 项因当前环境能力跳过）；TypeScript、ESLint、Vite 6 Web/PWA 与 NSIS 构建通过；Electron 43.3.0 + electron-builder 26.15.7 的 0.8.0 标准版安装包（202,066,085 字节，SHA-256 `3DBB9A4DFEEB670C5C4062C5B743D237C0399C5A707B25EB0DB8FE7A5D5E0135`）；构建版与已安装版 `app.asar` SHA-256 均为 `172829227FC97BA37D6D9F66B5B0101DCE155DBF46546FA440D32B7858F64D76`，安装位主程序 SHA-256 为 `F6C2BD77BFBA7FEC338EE79BB101A3415C375548A628858F8AF8DDB2D606D1A9`。正式 EXE 已完成真实视频载入、控制层显隐、统一分析、文档工作区、模型三种使用方式、问答/规划/执行/自动四模式、持久任务恢复和高级 OCR 默认关闭冒烟；本地候选同时生成 SPDX 2.3 SBOM、SHA256SUMS 与安全扫描报告。另用空白 `--user-data-dir` 完成首次配置启动验收。全新 Windows Sandbox 已完成当前用户安装、快捷方式、首次启动、应用内打开视频、资源管理器双击 MP4 显示 AgentPlay 候选、参数启动并播放、卸载、安装目录/快捷方式/打开方式清理；首轮暴露的“没有注册类”已通过 ProgID + OpenWithProgids + Capabilities 修复并在第二个全新 Sandbox 复验。X/Facebook 双下载入口、专业两部分拉片、DOCX/PPTX/Excel/PDF、轻量 OCR、转写、mpv/SAPI 等链路继续回归 | 0.8.0 尚未公开发布且没有 Authenticode 可信签名，安装时显示未知发布者；Unlimited-OCR 只完成可选适配和模拟服务回归，真实 GPU 质量待硬件合格环境验收；尚未在另一台物理 Windows 电脑复验；Facebook 没有有效用户 Cookies 时只能验证登录/导入入口与诚实失败提示；Win11 第一层右键菜单仍受系统限制；其他平台未交付 |
| Web PWA | Vite 生产构建退出 0；产物包含 index、JS、CSS、manifest、service worker | 浏览器没有 Electron IPC，不能直接访问本地模型密钥库、SAPI、mpv 创意渲染；不能算桌面功能等价 |
| Android | Capacitor 8.5.0 依赖已安装；历史 `sync android` 曾成功 | 0.8.0 尚未重做 sync、APK 构建与真机验证；文件选择、后台音频、AI 成片均未验证 |
| macOS | CI 构建定义存在；代码对系统 `say` 配音有适配 | 本机不是 Mac，未生成/启动 DMG；仓库没有 macOS mpv 闭包，高级 MP4 渲染会明确显示不可用 |
| Linux | CI 构建定义存在；代码对 `espeak-ng` 有适配 | WSL 有 Linux 内核但未形成可分发 mpv 闭包；AppImage/deb 启动、桌面集成和高级渲染未通过 |
| iOS | 尚无 0.8.0 实机证据 | 需要 macOS、Xcode、iOS 工程、签名和真机；当前不能称已交付 |

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
