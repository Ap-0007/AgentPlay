# 发布流程

本文件是 AgentPlay 的公开发布合同。任何一次退出码为 0、历史绿色记录或本机已有产物都不能单独证明可以发布。

## 1. 冻结范围

1. 从最新 `master` 创建 `agent/<主题>` 分支。
2. 用 `git status --short` 和 `git diff --check` 确认变更边界，不混入安装包、模型、媒体、缓存、密钥或用户目录。
3. 同步 `package.json`、`pnpm-lock.yaml`、`CHANGELOG.md`、`README.md`、`ROADMAP.md`、`SECURITY.md` 和第三方许可材料。
4. Pull Request 保持 Draft，直到下面所有适用门禁都有本次提交的证据。

## 2. 全新克隆复现源码门禁

在一个不存在的全新目录中克隆候选分支，不复制原工作区的 `node_modules`、`dist`、`release`、`resources` 或缓存：

```powershell
git clone --branch agent/<主题> --single-branch https://github.com/wg5759/AgentPlay.git AgentPlay-release-check
Set-Location AgentPlay-release-check
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod --registry=https://registry.npmjs.org
pnpm audit --registry=https://registry.npmjs.org
```

源码门禁失败、锁文件漂移、测试总数异常下降、扫描报告缺失或完整审计出现已知漏洞时停止发布。

## 3. Windows 候选包验收

Windows 打包依赖仓库外的可再分发资源。每个资源必须在清单中记录来源 URL、版本、SHA-256、许可证和目标路径；没有清单时，不得声称安装包可从 Git 仓库独立复现。

```powershell
pnpm build:electron
pnpm release:portable
pnpm release:verify
node scripts/smoke-packaged-ui.mjs
node scripts/smoke-packaged-download.mjs
node scripts/smoke-packaged-plugin-skill.mjs
node scripts/verify-office-quality.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-office-com.ps1
pnpm security:scan:packaged
```

验收必须覆盖真实安装包或 `win-unpacked` 应用，不得只测开发服务器。下载功能至少验证一个无需登录的真实公开链接；Facebook 等需要登录态的平台必须使用维护者自己的有效 Cookies，证据中不得包含 Cookies 本身。

正式公开前还必须在另一台 Windows 11 x64 电脑、Windows Sandbox 或全新本地用户中完成一次首次安装 → 首次启动 → 打开真实视频 → 卸载验收。使用临时 `--user-data-dir` 只能提前检查空白配置启动，不能替代安装器、快捷方式、注册表和卸载器的全新环境证据。

0.8.0 当前候选已在两个独立 Windows Sandbox 实例中完成上述闭环。首轮发现 MP4 双击报“没有注册类”，修复为 ProgID + OpenWithProgids + Capabilities 后，第二轮已验证系统选择器显示 AgentPlay、参数启动后播放成功，卸载后候选项、快捷方式和安装目录均被清理。该证据只适用于当前哈希对应的安装包，重打包后必须重跑。

## 4. Release 资产

GitHub Release 只上传 ASCII 文件名，至少包含：

- `AgentPlay-<version>-Windows-x64-Standard.exe`
- `AgentPlay-<version>-Windows-x64-Portable.zip`
- `AgentPlay-<version>-SHA256SUMS.txt`
- `AgentPlay-<version>-release-manifest.json`
- `AgentPlay-<version>-release-verification.json`
- `AgentPlay-<version>-security-release-scan.json`
- `AgentPlay-<version>.spdx.json`
- `Install-AgentPlay.ps1`
- GitHub 自动生成的 Source code 归档

校验 JSON 只能包含仓库相对路径或公开资产名，不能泄露维护者绝对路径。SPDX SBOM 应从已合并的默认分支通过 GitHub Dependency Graph SBOM API 获取，确保对应最终提交。

### 4.1 Preview、Beta 与 Stable 三条通道

数字签名不再阻塞开源项目持续迭代，但三条通道必须严格分开：

| 通道 | GitHub 状态 | 未签名是否允许 | 面向对象 |
| --- | --- | --- | --- |
| Preview | Prerelease | 允许，但必须显式标注并核对 SHA-256 | 希望提前体验最新功能的测试者 |
| Beta | Prerelease | 允许，但必须显式标注并核对 SHA-256 | 参与完整回归的测试者 |
| Stable | 正式 Release | 不允许 | 普通用户 |

生成未签名资产必须显式执行 `pnpm release:assets:preview` 或 `pnpm release:assets:beta`；脚本会把通道、Prerelease 状态、签名状态、安装器、便携包、SBOM 和校验文件写入公开清单。稳定版只能执行 `pnpm release:assets:stable`，安装包或 `win-unpacked/AgentPlay.exe` 任一签名不是 `Valid` 时立即失败。

命令行安装只是桌面安装器和便携包的可选入口，不是绕过 Windows 安全机制的手段。`Install-AgentPlay.ps1` 只接受官方 Release，先验证发布清单和 SHA-256，再检查 Authenticode；使用未签名 Preview/Beta 必须显式添加 `-AllowUnsigned`，脚本不会关闭或绕过 SmartScreen。禁止宣传 `irm | iex` 这类未审阅远程脚本执行方式。

### 4.2 数字签名与开源项目申请硬门

本地候选、内部测试包、Preview、Beta 和 Draft Release 可以在明确标注 `NotSigned` 的前提下继续验收；面向普通用户宣布“稳定公开版”前，必须同时满足：

1. SignPath Foundation（或等价的可信开源代码签名计划）正式批准项目，而不是只有提交记录、试用组织或待审核状态；
2. 候选安装包和安装后的主程序均带有效 Authenticode 签名，签名状态、证书主题、时间戳和 SHA-256 写入本轮验证证据；
3. 从公开 Release 匿名下载后再次验证签名链和哈希，结果与本地候选一致；
4. 若申请曾因公开采用证据不足被拒，先补齐可核验的 stars、forks、外部贡献者、独立文章或社区讨论证据，再重新申请，禁止把重复提交申请当作完成。

未获批或未签名时只能发布为明确提示风险的 Preview/Beta，不得宣称已解决 SmartScreen、可信发布或 winget 分发。

免费 SignPath 重申材料见 `docs/SIGNPATH_REAPPLICATION.md`。获批前不得配置 `SIGNPATH_API_TOKEN` 或把试用组织冒充开源签名组织；获批后只允许从 `master` 手工触发 `.github/workflows/signpath-release.yml`。工作流必须先在 GitHub-hosted Windows runner 构建并上传未签名 artifact，再由 `signpath/github-action-submit-signing-request@v2` 提交；返回产物必须验证 Authenticode，且仍需人工安装后复核主程序签名。该工作流不创建标签、不创建或公开 Release。

## 5. 合并、标签与发布

1. 等待 Ubuntu 与 Windows CI 全绿，并确认 PR 中的提交就是完成本地验收的提交。
2. 合并 PR 后记录 `master` 的精确提交 SHA。
3. 在该提交创建带注释标签 `v<version>`，不得让标签指向候选分支的旧提交；Preview/Beta 使用带预发布后缀的 SemVer 标签。
4. 先创建 Draft Release，上传全部资产并逐个读回远端大小和摘要；Preview/Beta 必须勾选 GitHub Prerelease，Stable 不得勾选。
5. 发布说明列出新增、修复、已知限制、签名状态、许可证与 SHA-256 校验方法。
6. 发布后使用未登录会话从公开 Release 下载安装包，重新计算 SHA-256 并与 `SHA256SUMS.txt` 比较。

## 6. 停止发布条件

出现以下任一情况即保持 Draft，不合并、不打标签或不公开 Release：

- 全新克隆无法安装或质量门失败；
- 生产依赖或完整依赖审计不为 0；
- 安装包哈希、字节数、校验 JSON 或远端资产不一致；
- 打包安全扫描发现密钥、凭据、个人路径或未授权内容；
- “仅下载”或“下载并拉片”任一入口退化；
- 第三方插件可执行任意代码、可映射非内置工具、未确认权限即启用，或打包应用中的默认禁用/撤销授权验收失败；
- X 公开下载未通过，或 Facebook 在缺少有效登录态时伪报成功；
- Office 输出无法被真实 Word、Excel、PowerPoint 打开，或遗留本轮新建进程；
- 发布说明把未验证平台、未签名状态或不可复现构建写成已完成。
- Preview/Beta 未显式披露 `NotSigned`、未标为 Prerelease，或没有安装器、便携包、发布清单、SHA-256、SBOM 与安全扫描闭包。
- Stable 候选未通过 SignPath/等价开源签名计划审批，或安装包、安装后 EXE、公开下载回读任一处 Authenticode 无效。
