const path = require('path')

function material(id, role, value = {}) {
  const filePath = String(value.path || '').trim()
  if (!filePath) throw new Error(`EDL 缺少${role}素材路径`)
  return { id, role, path: filePath, name: String(value.name || path.basename(filePath)) }
}

function finiteRange(start, end, label) {
  const from = Number(start)
  const to = Number(end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) throw new Error(`EDL ${label}无效`)
  return { start: from, end: to }
}

function videoMaterialAndTracks(source) {
  return {
    materials: [material('material-video-1', 'video', source)],
    tracks: [
      { id: 'track-video-1', type: 'video', materialId: 'material-video-1' },
      { id: 'track-audio-1', type: 'audio', materialId: 'material-video-1', optional: true }
    ]
  }
}

function videoAndSubtitleMaterialAndTracks(source, subtitle) {
  const video = material('material-video-1', 'video', source)
  const captions = material('material-subtitle-1', 'subtitle', subtitle)
  return {
    materials: [video, captions],
    tracks: [
      { id: 'track-video-1', type: 'video', materialId: video.id },
      { id: 'track-audio-1', type: 'audio', materialId: video.id, optional: true },
      { id: 'track-subtitle-1', type: 'subtitle', materialId: captions.id }
    ]
  }
}

function buildEditDecisionList(decision) {
  if (!decision || decision.schemaVersion !== 1 || typeof decision.kind !== 'string') throw new Error('EDL 决策无效')
  const output = {
    container: String(decision.output?.container || ''),
    overwrite: decision.output?.overwrite === true,
    suffix: String(decision.output?.suffix || '')
  }
  if (!output.container || output.overwrite || !output.suffix) throw new Error('EDL 输出策略无效')
  const quality = JSON.parse(JSON.stringify(decision.verification || {}))

  if (decision.kind === 'media.trim') {
    const sourceRangeSeconds = finiteRange(decision.timeline?.startSeconds, decision.timeline?.endSeconds, '裁剪源范围')
    const duration = Number(decision.timeline?.durationSeconds)
    if (!Number.isFinite(duration) || duration <= 0 || Math.abs(duration - (sourceRangeSeconds.end - sourceRangeSeconds.start)) > 0.001) throw new Error('EDL 裁剪时长无效')
    const media = videoMaterialAndTracks(decision.source)
    return {
      schemaVersion: 1,
      kind: 'agentplay.edit-decision-list',
      decisionKind: decision.kind,
      ...media,
      operations: [{
        id: 'operation-1',
        type: 'trim',
        materialId: 'material-video-1',
        trackIds: ['track-video-1', 'track-audio-1'],
        sourceRangeSeconds,
        targetRangeSeconds: { start: 0, end: duration }
      }],
      output,
      quality: {
        ...quality,
        ...(decision.semanticLocate ? { semanticLocate: JSON.parse(JSON.stringify(decision.semanticLocate)) } : {}),
        ...(decision.semanticSelect ? { semanticSelect: JSON.parse(JSON.stringify(decision.semanticSelect)) } : {})
      }
    }
  }
  if (decision.kind === 'media.remove-segment') {
    const sourceRangeSeconds = finiteRange(decision.timeline?.startSeconds, decision.timeline?.endSeconds, '删除源范围')
    const removedDuration = Number(decision.timeline?.removedDurationSeconds)
    if (!Number.isFinite(removedDuration) || Math.abs(removedDuration - (sourceRangeSeconds.end - sourceRangeSeconds.start)) > 0.001) throw new Error('EDL 删除时长无效')
    const media = videoMaterialAndTracks(decision.source)
    return {
      schemaVersion: 1,
      kind: 'agentplay.edit-decision-list',
      decisionKind: decision.kind,
      ...media,
      operations: [{
        id: 'operation-1', type: 'remove', materialId: 'material-video-1',
        trackIds: ['track-video-1', 'track-audio-1'], sourceRangeSeconds
      }],
      output,
      quality
    }
  }
  if (decision.kind === 'media.concat-segments') {
    const segments = Array.isArray(decision.timeline?.segments) ? decision.timeline.segments : []
    const expectedDuration = Number(decision.timeline?.durationSeconds)
    if (segments.length < 2 || segments.length > 24 || !Number.isFinite(expectedDuration) || expectedDuration <= 0) throw new Error('EDL 拼接时间线无效')
    let cursor = 0
    const operations = segments.map((segment, index) => {
      const sourceRangeSeconds = finiteRange(segment.sourceStartSeconds, segment.sourceEndSeconds, `拼接片段 ${index + 1} 源范围`)
      const targetRangeSeconds = finiteRange(segment.targetStartSeconds, segment.targetEndSeconds, `拼接片段 ${index + 1} 目标范围`)
      const duration = sourceRangeSeconds.end - sourceRangeSeconds.start
      if (Math.abs(duration - (targetRangeSeconds.end - targetRangeSeconds.start)) > 0.001 || Math.abs(targetRangeSeconds.start - cursor) > 0.001) throw new Error('EDL 拼接目标时间线不连续')
      cursor = targetRangeSeconds.end
      return {
        id: `operation-${index + 1}`, type: 'append', materialId: 'material-video-1',
        trackIds: ['track-video-1', 'track-audio-1'], sourceRangeSeconds, targetRangeSeconds
      }
    })
    if (Math.abs(cursor - expectedDuration) > 0.001) throw new Error('EDL 拼接总时长无效')
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      ...videoMaterialAndTracks(decision.source), operations, output,
      quality: {
        ...quality,
        ...(decision.semanticCut ? { semanticCut: JSON.parse(JSON.stringify(decision.semanticCut)) } : {}),
        ...(decision.semanticSelect ? { semanticSelect: JSON.parse(JSON.stringify(decision.semanticSelect)) } : {}),
        ...(decision.autoInspection ? { autoInspection: JSON.parse(JSON.stringify(decision.autoInspection)) } : {})
      }
    }
  }
  if (decision.kind === 'media.concat-sources') {
    const sources = Array.isArray(decision.sources) ? decision.sources : []
    if (sources.length < 2 || sources.length > 20) throw new Error('EDL 跨素材数量无效')
    const materials = sources.map((source, index) => material(`material-video-${index + 1}`, 'video', source))
    const tracks = materials.flatMap((item, index) => ([
      { id: `track-video-${index + 1}`, type: 'video', materialId: item.id },
      { id: `track-audio-${index + 1}`, type: 'audio', materialId: item.id, optional: true }
    ]))
    const operations = materials.map((item, index) => ({
      id: `operation-${index + 1}`, type: 'append-source', materialId: item.id,
      trackIds: [`track-video-${index + 1}`, `track-audio-${index + 1}`], order: index
    }))
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials, tracks, operations, output, quality
    }
  }
  if (decision.kind === 'media.mix-audio') {
    const video = material('material-video-1', 'video', decision.source)
    const mix = decision.audioMix
    const audioTracks = Array.isArray(mix?.tracks) ? mix.tracks : []
    if (mix?.schemaVersion !== 1 || mix?.strategy !== 'multitrack-audio-mix-v1' || audioTracks.length > 8 || (!mix.dialogue?.enabled && !audioTracks.length)) throw new Error('EDL 多轨音频合同无效')
    const materials = audioTracks.map((track, index) => material(`material-audio-${index + 1}`, track.role, track))
    const validateAutomation = (automation, label) => (Array.isArray(automation) ? automation : []).map((item) => {
      const range = finiteRange(item.startSeconds, item.endSeconds, `${label}分段音量`)
      const volume = Number(item.volume)
      if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error(`EDL ${label}分段音量无效`)
      return { ...range, volume }
    })
    const dialogueVolume = Number(mix.dialogue?.volume)
    if (!Number.isFinite(dialogueVolume) || dialogueVolume < 0 || dialogueVolume > 1) throw new Error('EDL 对白音量无效')
    const operations = [{
      id: 'operation-dialogue', type: mix.dialogue?.enabled ? 'mix-dialogue' : 'disable-dialogue', materialId: video.id,
      trackIds: ['track-dialogue-1'], parameters: { enabled: mix.dialogue?.enabled === true, volume: dialogueVolume, automation: validateAutomation(mix.dialogue?.automation, '对白') }
    }]
    for (let index = 0; index < audioTracks.length; index += 1) {
      const track = audioTracks[index]
      if (!['music', 'ambience', 'sfx'].includes(track.role)) throw new Error('EDL 多轨音频角色无效')
      const volume = Number(track.volume)
      const startSeconds = Number(track.startSeconds)
      const endSeconds = track.endSeconds == null ? null : Number(track.endSeconds)
      if (!Number.isFinite(volume) || volume <= 0 || volume > 1 || !Number.isFinite(startSeconds) || startSeconds < 0 || (endSeconds != null && (!Number.isFinite(endSeconds) || endSeconds <= startSeconds))) throw new Error('EDL 多轨音频参数无效')
      operations.push({
        id: `operation-audio-${index + 1}`, type: 'mix-audio-track', materialId: materials[index].id,
        trackIds: [`track-audio-${index + 1}`],
        ...(endSeconds != null ? { targetRangeSeconds: { start: startSeconds, end: endSeconds } } : {}),
        parameters: {
          role: track.role, volume, startSeconds, loop: track.loop === true,
          duckAgainstDialogue: track.duckAgainstDialogue === true,
          fadeInSeconds: Number(track.fadeInSeconds), fadeOutSeconds: Number(track.fadeOutSeconds),
          automation: validateAutomation(track.automation, track.role)
        }
      })
    }
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials: [video, ...materials],
      tracks: [
        { id: 'track-video-1', type: 'video', materialId: video.id },
        { id: 'track-dialogue-1', type: 'audio', materialId: video.id, optional: true },
        ...materials.map((item, index) => ({ id: `track-audio-${index + 1}`, type: 'audio', materialId: item.id }))
      ],
      operations, output,
      quality: { ...quality, audioMix: JSON.parse(JSON.stringify(mix)), loudness: JSON.parse(JSON.stringify(mix.master?.loudness || {})) }
    }
  }
  if (decision.kind === 'media.repair-audio') {
    const video = material('material-video-1', 'video', decision.source)
    const repair = decision.audioRepair
    if (repair?.schemaVersion !== 1 || repair?.strategy !== 'ffmpeg-audio-repair-v1' || !['boolean'].includes(typeof repair.denoise?.enabled) || !['boolean'].includes(typeof repair.dcRemoval?.enabled) || !['boolean'].includes(typeof repair.silenceRepair?.enabled) || !['boolean'].includes(typeof repair.separation?.enabled)) throw new Error('EDL 音频修复合同无效')
    const enabled = ['denoise', 'dcRemoval', 'loudness', 'silenceRepair', 'separation'].filter((key) => repair[key]?.enabled)
    if (!enabled.length) throw new Error('EDL 音频修复没有启用动作')
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials: [video],
      tracks: [{ id: 'track-video-1', type: 'video', materialId: video.id }, { id: 'track-audio-1', type: 'audio', materialId: video.id }],
      operations: enabled.map((key, index) => ({ id: `operation-audio-repair-${index + 1}`, type: `audio-${key}`, materialId: video.id, trackIds: ['track-audio-1'], parameters: JSON.parse(JSON.stringify(repair[key])) })),
      output, quality: { ...quality, audioRepair: JSON.parse(JSON.stringify(repair)), expectedOutputs: repair.separation.enabled ? ['video', 'voice', 'accompaniment'] : ['video'] }
    }
  }
  if (decision.kind === 'media.rhythm-edit') {
    const video = material('material-video-1', 'video', decision.source)
    const music = material('material-music-1', 'music', decision.music)
    const rhythm = decision.rhythm
    const segments = Array.isArray(rhythm?.segments) ? rhythm.segments : []
    if (rhythm?.schemaVersion !== 1 || rhythm?.strategy !== 'beat-synced-jump-cut-v1' || segments.length < 4 || segments.length > 41) throw new Error('EDL 节拍剪辑合同无效')
    let cursor = 0
    const operations = segments.map((segment, index) => {
      const sourceRangeSeconds = finiteRange(segment.sourceStartSeconds, segment.sourceEndSeconds, `节拍镜头 ${index + 1} 源范围`)
      const targetRangeSeconds = finiteRange(segment.targetStartSeconds, segment.targetEndSeconds, `节拍镜头 ${index + 1} 目标范围`)
      if (Math.abs(targetRangeSeconds.start - cursor) > 0.001 || Math.abs((sourceRangeSeconds.end - sourceRangeSeconds.start) - (targetRangeSeconds.end - targetRangeSeconds.start)) > 0.001) throw new Error('EDL 节拍镜头时间线不连续')
      cursor = targetRangeSeconds.end
      return { id: `operation-rhythm-${index + 1}`, type: 'append-on-beat', materialId: video.id, trackIds: ['track-video-1', 'track-dialogue-1'], sourceRangeSeconds, targetRangeSeconds }
    })
    if (Math.abs(cursor - Number(rhythm.outputDurationSeconds)) > 0.001 || !Array.isArray(rhythm.cutTimes) || rhythm.cutTimes.length !== segments.length - 1) throw new Error('EDL 节拍剪辑总时长或切点无效')
    operations.push({
      id: 'operation-rhythm-music', type: 'mix-rhythm-music', materialId: music.id, trackIds: ['track-music-1'],
      sourceRangeSeconds: { start: 0, end: Number(rhythm.outputDurationSeconds) },
      targetRangeSeconds: { start: 0, end: Number(rhythm.outputDurationSeconds) },
      parameters: { volume: Number(decision.policy?.musicVolume), dialogueDucking: decision.policy?.dialogueDucking === true }
    })
    operations.push({ id: 'operation-rhythm-tail', type: 'fade-to-beat', materialId: video.id, trackIds: ['track-video-1', 'track-dialogue-1', 'track-music-1'], parameters: JSON.parse(JSON.stringify(rhythm.tail)) })
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials: [video, music],
      tracks: [
        { id: 'track-video-1', type: 'video', materialId: video.id },
        { id: 'track-dialogue-1', type: 'audio', materialId: video.id, optional: true },
        { id: 'track-music-1', type: 'audio', materialId: music.id }
      ],
      operations, output,
      quality: { ...quality, rhythm: JSON.parse(JSON.stringify(rhythm)), beatAnalysis: { method: rhythm.analysisMethod, bpm: rhythm.bpm, supportRatio: rhythm.supportRatio } }
    }
  }
  if (decision.kind === 'media.add-music') {
    const video = material('material-video-1', 'video', decision.source)
    const music = material('material-music-1', 'music', decision.audio)
    const volume = Number(decision.audio?.volume)
    const fadeInSeconds = Number(decision.audio?.fadeInSeconds)
    const fadeOutSeconds = Number(decision.audio?.fadeOutSeconds)
    if (!Number.isFinite(volume) || volume <= 0 || volume > 1 || !Number.isFinite(fadeInSeconds) || fadeInSeconds < 0 || !Number.isFinite(fadeOutSeconds) || fadeOutSeconds < 0) throw new Error('EDL 配乐参数无效')
    const selection = decision.audio?.selection
    const sourceRangeSeconds = selection ? finiteRange(selection.startSeconds, selection.endSeconds, '音乐选段') : null
    if (sourceRangeSeconds && Math.abs(Number(selection.durationSeconds) - (sourceRangeSeconds.end - sourceRangeSeconds.start)) > 0.001) throw new Error('EDL 音乐选段时长无效')
    const operation = {
      id: 'operation-1', type: 'mix-music', materialId: music.id, trackIds: ['track-music-1'],
      ...(sourceRangeSeconds ? { sourceRangeSeconds } : {}),
      parameters: {
        volume, loop: decision.audio?.loop !== false, duck: decision.audio?.duck !== false,
        fadeInSeconds, fadeOutSeconds
      }
    }
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials: [video, music],
      tracks: [
        { id: 'track-video-1', type: 'video', materialId: video.id },
        { id: 'track-audio-1', type: 'audio', materialId: video.id, optional: true },
        { id: 'track-music-1', type: 'audio', materialId: music.id }
      ],
      operations: [operation], output,
      quality: { ...quality, ...(decision.audio?.loudness ? { loudness: JSON.parse(JSON.stringify(decision.audio.loudness)) } : {}) }
    }
  }
  if (decision.kind === 'media.burn-subtitles') {
    const media = videoAndSubtitleMaterialAndTracks(decision.source, decision.subtitle)
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      ...media,
      operations: [{
        id: 'operation-1', type: 'burn-subtitles', materialId: 'material-subtitle-1',
        trackIds: ['track-subtitle-1'],
        parameters: { style: JSON.parse(JSON.stringify(decision.subtitle?.style || {})), ...(decision.subtitle?.professional ? { professional: JSON.parse(JSON.stringify(decision.subtitle.professional)) } : {}) }
      }],
      output, quality
    }
  }
  if (decision.kind === 'media.visual-effects') {
    const video = material('material-video-1', 'video', decision.source)
    const effectSources = (Array.isArray(decision.effectSources) ? decision.effectSources : []).map((item, index) => material(`material-effect-${index + 1}`, 'effect-video', item))
    const effects = Array.isArray(decision.effects) ? decision.effects : []
    if (!effects.length || effects.length > 12) throw new Error('EDL 视觉效果数量无效')
    const operations = effects.map((effect, index) => ({
      id: `operation-${index + 1}`, type: `visual-${String(effect.type || '')}`,
      materialId: effect.type === 'pip' ? `material-effect-${effectSources.findIndex((item) => item.path === effect.path) + 1}` : video.id,
      trackIds: ['track-video-1'], parameters: JSON.parse(JSON.stringify(effect.type === 'brand-package' ? { ...effect, brandPackage: decision.brandPackage } : effect))
    }))
    if (operations.some((item) => !item.type || item.materialId === 'material-effect-0')) throw new Error('EDL 视觉效果素材无效')
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials: [video, ...effectSources],
      tracks: [{ id: 'track-video-1', type: 'video', materialId: video.id }, { id: 'track-audio-1', type: 'audio', materialId: video.id, optional: true }, ...effectSources.map((item, index) => ({ id: `track-effect-${index + 1}`, type: 'video', materialId: item.id }))],
      operations, output, quality: { ...quality, effects: JSON.parse(JSON.stringify(effects)), ...(decision.brandPackage ? { brandPackage: JSON.parse(JSON.stringify(decision.brandPackage)) } : {}) }
    }
  }
  if (decision.kind === 'media.smart-reframe') {
    const video = material('material-video-1', 'video', decision.source)
    const reframe = decision.reframe
    if (!reframe || !Array.isArray(reframe.tracking?.frames) || reframe.tracking.frames.length !== 5 || !Array.isArray(reframe.outputs) || reframe.outputs.length !== 3) throw new Error('EDL 智能构图证据无效')
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials: [video],
      tracks: [{ id: 'track-video-1', type: 'video', materialId: video.id }, { id: 'track-audio-1', type: 'audio', materialId: video.id, optional: true }],
      operations: [{ id: 'operation-1', type: 'smart-reframe', materialId: video.id, trackIds: ['track-video-1', 'track-audio-1'], parameters: JSON.parse(JSON.stringify(reframe)) }],
      output, quality: { ...quality, expectedAspects: reframe.outputs.map((item) => item.aspect), subject: reframe.subject?.description || '', trackingStrategy: reframe.strategy }
    }
  }
  if (decision.kind === 'media.visual-repair') {
    const video = material('material-video-1', 'video', decision.source)
    const repair = decision.repair
    if (!repair || repair.strategy !== 'ffmpeg-visual-repair-v1' || !repair.comparison?.enabled) throw new Error('EDL 画面修复合同无效')
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      materials: [video],
      tracks: [{ id: 'track-video-1', type: 'video', materialId: video.id }, { id: 'track-audio-1', type: 'audio', materialId: video.id, optional: true }],
      operations: [{ id: 'operation-1', type: 'visual-repair', materialId: video.id, trackIds: ['track-video-1', 'track-audio-1'], parameters: JSON.parse(JSON.stringify(repair)) }],
      output, quality: { ...quality, repair: JSON.parse(JSON.stringify(repair)), expectedOutputs: ['repaired', 'comparison'] }
    }
  }
  const subtitleOperations = {
    'media.mux-subtitles': ['mux-subtitles', {}],
    'media.shift-subtitles': ['shift-subtitles', decision.shift],
    'media.translate-subtitles': ['translate-subtitles', decision.translate],
    'media.edit-subtitle-cues': ['edit-subtitle-cues', decision.cueEdit]
  }
  if (subtitleOperations[decision.kind]) {
    const [type, rawParameters] = subtitleOperations[decision.kind]
    if (!rawParameters || typeof rawParameters !== 'object') throw new Error(`EDL ${type} 参数无效`)
    const media = videoAndSubtitleMaterialAndTracks(decision.source, decision.subtitle)
    return {
      schemaVersion: 1, kind: 'agentplay.edit-decision-list', decisionKind: decision.kind,
      ...media,
      operations: [{
        id: 'operation-1', type, materialId: 'material-subtitle-1',
        trackIds: ['track-subtitle-1'], parameters: JSON.parse(JSON.stringify(rawParameters))
      }],
      output, quality
    }
  }
  throw new Error(`EDL 暂不支持决策类型：${decision.kind}`)
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function attachEditDecisionList(decision) {
  return { ...decision, edl: buildEditDecisionList(decision) }
}

function assertEditDecisionList(decision) {
  if (!decision?.edl || canonical(decision.edl) !== canonical(buildEditDecisionList(decision))) throw new Error('EDL 与冻结决策不一致')
  return decision.edl
}

module.exports = { assertEditDecisionList, attachEditDecisionList, buildEditDecisionList }
