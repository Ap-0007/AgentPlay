// 本文件由 scripts/package-rapidocr-pack.mjs 生成，请勿手改。
// 组件包托管在 GitHub Release 的 rapidocr-pack-v1 标签；SHA-256 与发布资产一一对应。
module.exports = {
  "schemaVersion": 1,
  "tag": "rapidocr-pack-v1",
  "product": "AgentPlay 高精度 OCR 组件（PP-OCRv4 中文，onnxruntime）",
  "assets": [
    {
      "id": "ch_PP-OCRv4_det_infer-onnx",
      "kind": "file",
      "label": "PP-OCRv4 文字检测模型",
      "path": "models/ch_PP-OCRv4_det_infer.onnx",
      "role": "model",
      "url": "https://github.com/wg5759/AgentPlay/releases/download/rapidocr-pack-v1/ch_PP-OCRv4_det_infer.onnx",
      "size": 4745517,
      "sha256": "30a86f5731181461d08021402766601e4302a9b9b9666be8aff402696339cdff"
    },
    {
      "id": "ch_PP-OCRv4_rec_infer-onnx",
      "kind": "file",
      "label": "PP-OCRv4 中文识别模型",
      "path": "models/ch_PP-OCRv4_rec_infer.onnx",
      "role": "model",
      "url": "https://github.com/wg5759/AgentPlay/releases/download/rapidocr-pack-v1/ch_PP-OCRv4_rec_infer.onnx",
      "size": 10822323,
      "sha256": "06b3e6af6c59a1ba5d53790ed8c2e4b2de389870b6cf5a97f349f3412cb269c0"
    },
    {
      "id": "ch_ppocr_mobile_v2-0_cls_infer-onnx",
      "kind": "file",
      "label": "方向分类模型",
      "path": "models/ch_ppocr_mobile_v2.0_cls_infer.onnx",
      "role": "model",
      "url": "https://github.com/wg5759/AgentPlay/releases/download/rapidocr-pack-v1/ch_ppocr_mobile_v2.0_cls_infer.onnx",
      "size": 578966,
      "sha256": "491843a3c65de46295864c6815e41127eaa812c4dac1e19c6850ec49da9d3640"
    },
    {
      "id": "ppocr_keys_v1-txt",
      "kind": "file",
      "label": "识别字典（6623 字）",
      "path": "models/ppocr_keys_v1.txt",
      "role": "config",
      "url": "https://github.com/wg5759/AgentPlay/releases/download/rapidocr-pack-v1/ppocr_keys_v1.txt",
      "size": 26249,
      "sha256": "28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7"
    }
  ]
}
