# Unlimited-OCR 可选接入

AgentPlay 不打包、不自动下载 Unlimited-OCR 的代码、容器或约 6.7GB 模型权重。这个接入面向有合适 NVIDIA GPU、并愿意自行维护推理服务的用户；普通用户继续使用现有的 Windows OCR / RapidOCR 回退链。

## 它如何接入 AgentPlay

1. 用户在自己的 GPU 主机部署官方 OpenAI-compatible vLLM 服务。
2. 确认 `http://127.0.0.1:8000/v1/models` 能返回 `baidu/Unlimited-OCR`。
3. 打开 AgentPlay 的“模型接入 → 高级设置 → 本机组件 → 高级文档解析 · Unlimited-OCR”。
4. 保持默认地址和模型名，点“验证并启用”。
5. 添加扫描 PDF 后说“使用高级文档解析提取文字并整理成 Markdown”。

成功时，AgentPlay 会把 PDF 页面发送给该服务，清理定位标记、检查分页与重复输出，再另存 Markdown；服务未启动、输出为空、重复失控或质量检查失败时，会显示原因并回退本机轻量 OCR，不会把失败包装成成功。

## 官方 vLLM 部署参考

官方 vLLM recipe 当前说明：模型为 3B BF16，单卡推理最低约 8GB 显存；实际可用性还取决于 GPU 架构、驱动、CUDA 和容器环境。AgentPlay 团队尚未在本机完成真实 Unlimited-OCR 推理验收，因此本页只记录官方服务方式，不宣称所有 8GB 显卡都已适配。

Linux/NVIDIA Docker 的官方命令为：

```bash
docker run --rm --gpus all --network host --ipc host \
  vllm/vllm-openai:unlimited-ocr \
  baidu/Unlimited-OCR \
  --trust-remote-code \
  --logits_processors vllm.model_executor.models.unlimited_ocr:NGramPerReqLogitsProcessor \
  --no-enable-prefix-caching \
  --mm-processor-cache-gb 0
```

CUDA 12.9 Hopper GPU 使用官方 `vllm/vllm-openai:unlimited-ocr-cu129` 镜像。Windows 用户应先按 NVIDIA、Docker Desktop/WSL2 与 vLLM 的官方说明确认 GPU 容器可用；也可以把服务部署到同一局域网的 Linux GPU 主机。

不要省略 logits processor、`<image>` 提示词、`skip_special_tokens=false` 和 n-gram 参数，否则官方说明中可能出现空输出或长文档重复循环。AgentPlay 连接器已经固定这些请求参数：单页窗口 128，多页/PDF 窗口 1024。

## 隐私与安全边界

- `localhost` / `127.0.0.1` / `::1` 视为本机服务，不需要云端授权。
- 非本机地址只允许 HTTPS；启用时要确认一次，每个扫描文档任务还要单独批准后才会发送页面。
- 任务会冻结地址、模型名和本地/远端属性；程序重启恢复时配置若已变化，会停止并要求重新确认。
- API Key 只进入 Electron 系统安全存储，不写入项目、日志或任务规范。
- HTTP 重定向被禁用，防止页面或凭证被转发到另一地址。

## 来源与许可

- 官方项目：<https://github.com/baidu/Unlimited-OCR>
- 官方模型卡：<https://huggingface.co/baidu/Unlimited-OCR>
- 官方 vLLM recipe：<https://recipes.vllm.ai/baidu/Unlimited-OCR>
- Unlimited-OCR 代码与模型卡标注为 MIT。用户自行下载、部署和使用时仍应复核当前许可证与其依赖许可。

AgentPlay 当前只实现协议适配器，不复制 Unlimited-OCR 源码，不再分发模型权重，也不把第三方名称或模型许可改写为 AgentPlay 自有资产。
