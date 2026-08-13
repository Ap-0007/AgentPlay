const GENERIC_STAGES = ['获取内容', '理解需求', '生成结果', '继续处理']

const STAGES_BY_KIND = {
  download: ['校验链接', '下载视频'],
  'link-analysis': ['获取内容', '理解画面', '生成结果', '继续创作'],
  doc: ['读取文件', '理解需求', '生成文档', '继续编辑'],
  analysis: ['读取媒体', '分析内容', '生成报告', '继续创作'],
  media: ['扫描媒体', '执行处理', '验证结果', '查看结果']
}

const COMPLETED_LABEL_BY_KIND = {
  download: '下载完成',
  'link-analysis': '分析完成',
  doc: '文档完成',
  analysis: '分析完成',
  media: '处理完成'
}

const RUNNING_LABEL_BY_KIND = {
  download: '正在下载',
  'link-analysis': '正在分析',
  doc: '正在处理文档',
  analysis: '正在分析',
  media: '正在处理'
}

const normalizeActiveStage = (task, stages) => {
  if (task.phase === 'completed') return stages.length - 1
  if (task.phase === 'failed' || task.phase === 'cancelled') return Math.max(0, Math.min(stages.length - 1, Number(task.progress || 0) > 0 ? Math.floor(Number(task.progress) / (100 / stages.length)) : 0))
  if (task.kind === 'download') return /下载|合并|写入|保存/i.test(task.status || '') ? 1 : 0
  if (Number.isFinite(task.progress) && task.progress !== null) return Math.max(0, Math.min(stages.length - 1, Math.floor(Number(task.progress) / (100 / stages.length))))
  if (task.outputs?.length) return Math.max(0, stages.length - 2)
  return task.running || task.phase === 'running' ? 1 : 0
}

export function workspaceJourneyForTask(task = {}) {
  const stages = STAGES_BY_KIND[task.kind] || GENERIC_STAGES
  let eyebrow = '当前内容'
  if (task.phase === 'completed') eyebrow = COMPLETED_LABEL_BY_KIND[task.kind] || '处理完成'
  else if (task.phase === 'failed') eyebrow = '处理失败'
  else if (task.phase === 'cancelled') eyebrow = '已取消'
  else if (task.phase === 'waiting') eyebrow = /确认|允许|审批/.test(task.status || '') ? '等待确认' : '等待处理'
  else if (task.phase === 'queued') eyebrow = '等待开始'
  else if (task.phase === 'running' || task.running) eyebrow = RUNNING_LABEL_BY_KIND[task.kind] || '正在处理'

  return { eyebrow, stages: [...stages], activeStage: normalizeActiveStage(task, stages) }
}
