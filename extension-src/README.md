# AgentPlay 网页全局翻译（浏览器扩展）

整页对照翻译，与 AgentPlay 桌面版同一条双轨：

- **离线 OPUS-MT 英译中**（默认）：模型在浏览器内 wasm 推理，**内容不出机**；与桌面版离线翻译组件同一份模型（约 114MB，打进扩展包，一次安装永久离线）。
- **云端模型**（可选）：在选项页填你自己的 OpenAI 兼容接口（地址/Key/模型/目标语言），可翻任意语言；Key 只存本机浏览器存储，翻译时仅正文块经 background 中转发往你填写的地址。

## 安装（开发者模式）

1. 构建：在项目根目录执行 `node scripts/build-extension.mjs`（产出 `extension/`，约 177MB 含模型与 wasm）。
2. Chrome / Edge 打开 `chrome://extensions`，开启右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择本项目的 `extension/` 目录。
4. 任意英文网页点工具栏扩展图标 →「翻译本页」。首次使用离线引擎需编译加载模型（约 30-90 秒，之后缓存常驻）。
5. 译文以蓝色左边条对照块插在原段落下方；「还原本页」一键撤销。

## 边界（如实说明）

- 离线引擎只支持 **英文 → 中文**；其它方向请在选项页配置云端模型。
- 严格 CSP 的站点（如 github.com）可能限制内容脚本内的 wasm 推理，届时按提示改用云端模型（后续版本会把离线引擎迁到 offscreen 文档绕开）。
- 长页面上限 200 个正文块，逐块翻译，可中途取消。
- chrome://、扩展商店页、PDF 查看器不可注入。

## 工程

- 源文件在 `extension-src/`；`extension/` 是构建产物（git 忽略）。
- onnxruntime-web 钉在 1.24.3：新版（1.26+）的 MatMulNBits 对 OPUS-MT q8 量化模型要求缺失的 scale 张量，加载即报 `Missing required scale`（桌面端 onnxruntime-node 同样钉 1.24.3）。
