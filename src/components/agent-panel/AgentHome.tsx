import UiIcon from '../UiIcon'
import type { AgentHistoryRecord } from './types'

const EXAMPLE_TASKS = [
  { label: '下载一个视频', format: 'auto', text: '请下载这个视频：' },
  { label: '整理这份文件', format: 'docx', text: '请把这份文件整理成结构清晰的 Word 文档。' },
  { label: '分析当前画面', format: 'auto', text: '请分析当前视频画面，告诉我关键信息。' },
  { label: '生成一份报告', format: 'pdf', text: '请根据现有素材生成一份结构清晰的报告。' }
]

type AgentHomeProps = {
  history: AgentHistoryRecord[]
  expanded: boolean
  onToggleHistory: () => void
  onSelectExample: (text: string, format: string) => void
}

export default function AgentHome({ history, expanded, onToggleHistory, onSelectExample }: AgentHomeProps) {
  return (
    <div className="agent-home">
      <div className="agent-home-mark"><UiIcon name="agent" size={34} /></div>
      <p className="agent-home-eyebrow">一个入口，完成整件事</p>
      <h1>把任何事情交给我</h1>
      <p className="agent-home-subtitle">发链接、拖文件，或直接说你想得到什么结果</p>
      <div className="agent-home-suggestions">
        {EXAMPLE_TASKS.map((item) => (
          <button type="button" key={item.label} onClick={() => onSelectExample(item.text, item.format)}>{item.label}</button>
        ))}
      </div>
      {history.length > 0 && (
        <div className="agent-home-history">
          <div className="agent-home-history-heading">
            <span>最近完成</span>
            <button type="button" onClick={onToggleHistory}>{expanded ? '收起' : '查看全部'}</button>
          </div>
          <div className="agent-home-history-grid">
            {history
              .filter((record, index, records) => records.findIndex((item) => item.instruction === record.instruction) === index)
              .slice(0, expanded ? 6 : 3)
              .map((record) => (
                <article key={record.id} className="agent-history-object">
                  <span><UiIcon name={record.kind === 'video-analysis' ? 'video' : 'report'} size={17} /></span>
                  <div><strong>{record.instruction}</strong><small>{record.summary || '任务已完成'}</small></div>
                  {record.outputs[0] && <button type="button" onClick={() => void window.aiPlayer?.system?.openPath(record.outputs[0])}>打开</button>}
                </article>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
