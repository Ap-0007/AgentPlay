const fs = require('fs')
const path = require('path')

// 高精度 OCR 服务：PP-OCRv4（det+rec+字典，onnxruntime-node）经 @gutenye/ocr-node 在本机运行。
// 定位：扫描件 PDF/图片的中文高精度识别，优先于 WinRT OCR；组件由应用内下载（rapidocr-pack-v1，SHA-256 校验）。
// 红线：模型文件只从组件目录读取，不联网下载；识别在 CPU 本地完成，内容不出机。

const REQUIRED_FILES = ['ch_PP-OCRv4_det_infer.onnx', 'ch_PP-OCRv4_rec_infer.onnx', 'ppocr_keys_v1.txt']

class RapidOcrService {
  constructor({ modelRoot } = {}) {
    this.modelRoot = modelRoot ? path.resolve(modelRoot) : modelRoot
    this.ocrPromise = null
  }

  modelDir() {
    return path.join(this.modelRoot, 'models')
  }

  availability() {
    const dir = this.modelDir()
    const missing = REQUIRED_FILES.filter((file) => {
      try {
        return !fs.statSync(path.join(dir, file)).isFile()
      } catch {
        return true
      }
    })
    return {
      available: missing.length === 0,
      missing,
      modelDir: dir,
      reason: missing.length ? `高精度 OCR 组件未安装（缺 ${missing.length} 个文件）` : ''
    }
  }

  async ensureOcr() {
    if (!this.ocrPromise) {
      this.ocrPromise = (async () => {
        if (!this.availability().available) throw new Error('高精度 OCR 组件未安装，请先在模型接入中心下载')
        const { default: Ocr } = await import('@gutenye/ocr-node')
        const dir = this.modelDir()
        return Ocr.create({
          models: {
            detectionPath: path.join(dir, 'ch_PP-OCRv4_det_infer.onnx'),
            recognitionPath: path.join(dir, 'ch_PP-OCRv4_rec_infer.onnx'),
            dictionaryPath: path.join(dir, 'ppocr_keys_v1.txt')
          }
        })
      })()
      this.ocrPromise.catch(() => { this.ocrPromise = null })
    }
    return this.ocrPromise
  }

  // 与 WinRtOcrService.recognize 同构：Map<imagePath, { ok, text }>，附带行级结果供表格恢复复用
  async recognize(imagePaths, { signal } = {}) {
    const ocr = await this.ensureOcr()
    const results = new Map()
    for (const imagePath of imagePaths) {
      if (signal?.aborted) throw new Error('已取消')
      try {
        const lines = await ocr.detect(imagePath)
        const text = (lines || []).map((line) => String(line.text || '').trim()).filter(Boolean).join('\n')
        results.set(imagePath, { ok: true, text, lines: lines || [] })
      } catch (error) {
        results.set(imagePath, { ok: false, text: '', lines: [], error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }
}

module.exports = { RapidOcrService, REQUIRED_FILES }
