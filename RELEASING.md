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
pnpm release:verify
node scripts/smoke-packaged-ui.mjs
node scripts/smoke-packaged-download.mjs
node scripts/verify-office-quality.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-office-com.ps1
pnpm security:scan:packaged
```

验收必须覆盖真实安装包或 `win-unpacked` 应用，不得只测开发服务器。下载功能至少验证一个无需登录的真实公开链接；Facebook 等需要登录态的平台必须使用维护者自己的有效 Cookies，证据中不得包含 Cookies 本身。

## 4. Release 资产

GitHub Release 只上传 ASCII 文件名，至少包含：

- `AgentPlay-<version>-Windows-x64-Standard.exe`
- `AgentPlay-<version>-SHA256SUMS.txt`
- `AgentPlay-<version>-release-verification.json`
- `AgentPlay-<version>-security-release-scan.json`
- `AgentPlay-<version>.spdx.json`
- GitHub 自动生成的 Source code 归档

校验 JSON 只能包含仓库相对路径或公开资产名，不能泄露维护者绝对路径。SPDX SBOM 应从已合并的默认分支通过 GitHub Dependency Graph SBOM API 获取，确保对应最终提交。

## 5. 合并、标签与发布

1. 等待 Ubuntu 与 Windows CI 全绿，并确认 PR 中的提交就是完成本地验收的提交。
2. 合并 PR 后记录 `master` 的精确提交 SHA。
3. 在该提交创建带注释标签 `v<version>`，不得让标签指向候选分支的旧提交。
4. 先创建 Draft Release，上传全部资产并逐个读回远端大小和摘要。
5. 发布说明列出新增、修复、已知限制、签名状态、许可证与 SHA-256 校验方法。
6. 发布后使用未登录会话从公开 Release 下载安装包，重新计算 SHA-256 并与 `SHA256SUMS.txt` 比较。

## 6. 停止发布条件

出现以下任一情况即保持 Draft，不合并、不打标签或不公开 Release：

- 全新克隆无法安装或质量门失败；
- 生产依赖或完整依赖审计不为 0；
- 安装包哈希、字节数、校验 JSON 或远端资产不一致；
- 打包安全扫描发现密钥、凭据、个人路径或未授权内容；
- “仅下载”或“下载并拉片”任一入口退化；
- X 公开下载未通过，或 Facebook 在缺少有效登录态时伪报成功；
- Office 输出无法被真实 Word、Excel、PowerPoint 打开，或遗留本轮新建进程；
- 发布说明把未验证平台、未签名状态或不可复现构建写成已完成。
