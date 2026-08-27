const fs = require('fs')
const path = require('path')

class MediaEditExecutorRegistry {
  constructor({ service, visualQuality = null } = {}) {
    if (!service) throw new Error('媒体编辑执行注册表缺少服务')
    this.service = service
    this.visualQuality = visualQuality
  }
  supports(kind) { return ['media.trim', 'media.remove-segment', 'media.add-music', 'media.visual-effects'].includes(String(kind || '')) }
  async execute({ decision, sourcePath, dependencyPaths = [], outputPath, signal, visualProfile = 'media-edit-visual-effects' } = {}) {
    if (!this.supports(decision?.kind)) throw new Error(`统一编辑执行注册表不支持：${decision?.kind || 'unknown'}`)
    if (decision.kind === 'media.add-music') {
      const audioPath = path.resolve(String(decision.audio?.path || ''))
      if (dependencyPaths.length !== 1 || audioPath.toLowerCase() !== path.resolve(String(dependencyPaths[0] || '')).toLowerCase()) throw new Error('配乐依赖快照不一致')
    }
    if (decision.kind === 'media.visual-effects') {
      const expected = (decision.effectSources || []).map((entry) => path.resolve(String(entry?.path || '')).toLowerCase())
      if (expected.length !== dependencyPaths.length || expected.some((entry, index) => entry !== path.resolve(String(dependencyPaths[index] || '')).toLowerCase())) throw new Error('视觉效果辅助素材快照不一致')
    }
    let result
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) result = await this.service.verify({ sourcePath, outputPath, decision, signal })
    else if (decision.kind === 'media.trim') result = await this.service.trim({ sourcePath, outputPath, decision, signal })
    else if (decision.kind === 'media.remove-segment') result = await this.service.removeSegment({ sourcePath, outputPath, decision, signal })
    else if (decision.kind === 'media.add-music') result = await this.service.addMusic({ sourcePath, outputPath, decision: { ...decision, audio: { ...decision.audio, path: dependencyPaths[0] } }, signal })
    else result = await this.service.visualEffects({ sourcePath, outputPath, decision, signal })
    if (decision.kind === 'media.visual-effects') {
      if (!this.visualQuality) throw new Error('视觉效果缺少统一导出质量门')
      const visualQc = await this.visualQuality.inspect({ sourcePath, artifacts: [{ path: outputPath, role: 'visual-effects', expectedDimensions: result.effectReceipt?.outputDimensions, allowBlackBars: decision.effects.some((entry) => entry.type === 'scale' && Number(entry.factor) < 1) }], profile: visualProfile, signal })
      if (!visualQc.passed) throw new Error(`统一视觉导出质量门失败：${visualQc.failures.map((entry) => entry.code).join('、')}`)
      result = { ...result, visualQc }
    }
    return result
  }
}

module.exports = { MediaEditExecutorRegistry }
