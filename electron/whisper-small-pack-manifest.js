// 精修转写模型组件包：whisper.cpp ggml-small（与 whisper-pack 共用引擎，只下发模型文件）
// 托管在 GitHub Release 的 whisper-small-pack-v1 标签；SHA-256 与发布资产一一对应。
module.exports = {
  schemaVersion: 1,
  tag: 'whisper-small-pack-v1',
  product: 'AgentPlay 精修转写模型（whisper.cpp ggml-small）',
  assets: [
    {
      id: 'model-ggml-small',
      kind: 'file',
      label: 'ggml-small 精修模型',
      path: 'ggml-small.bin',
      role: 'model',
      url: 'https://github.com/wg5759/AgentPlay/releases/download/whisper-small-pack-v1/ggml-small.bin',
      size: 487601967,
      sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
    }
  ]
}
