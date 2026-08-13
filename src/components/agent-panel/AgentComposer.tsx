import type { RefObject } from 'react'
import UiIcon from '../UiIcon'

type AgentComposerProps = {
  inputRef: RefObject<HTMLInputElement>
  inputText: string
  onInputChange: (value: string) => void
  onSend: () => void
  onOpenAny: () => void
  onToggleSettings: () => void
  onToggleTaskCenter: () => void
  onToggleListening: () => void
  onStopThinking: () => void
  onCancelTask: () => void
  listening: boolean
  thinking: boolean
  busy: boolean
  cancellable: boolean
  attachmentCount: number
  mediaName: string | null
  taskCount: number
  quietHome: boolean
}

export default function AgentComposer(props: AgentComposerProps) {
  const {
    inputRef, inputText, onInputChange, onSend, onOpenAny, onToggleSettings, onToggleTaskCenter, onToggleListening,
    onStopThinking, onCancelTask, listening, thinking, busy, cancellable, attachmentCount,
    mediaName, taskCount, quietHome
  } = props
  return (
    <div className={'agent-composer-wrap' + (quietHome ? ' agent-composer-wrap-home' : '')}>
      <div className="agent-composer">
        <button type="button" onClick={onOpenAny} title="添加文件、文件夹或媒体" className="agent-composer-icon"><UiIcon name="plus" size={20} /></button>
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && !thinking && !busy && onSend()}
          placeholder={attachmentCount ? '告诉我想从这些素材得到什么…' : mediaName ? '继续问，或说下一步要做什么…' : '今天想完成什么？'}
        />
        <button type="button" onClick={onToggleSettings} title="运行与隐私" className="agent-composer-icon"><UiIcon name="shield" size={18} /></button>
        <button type="button" onClick={onToggleListening} title={listening ? '停止语音输入' : '语音输入'} className={'agent-composer-icon' + (listening ? ' is-listening' : '')}>
          <UiIcon name="mic" size={19} />
        </button>
        <button type="button" onClick={busy ? (cancellable ? onCancelTask : undefined) : thinking ? onStopThinking : onSend} disabled={busy && !cancellable} className={'agent-send-button' + (busy || thinking ? ' is-stop' : '')} aria-label={busy ? (cancellable ? '停止' : '任务执行中') : thinking ? '停止' : '发送'}>
          {busy ? <span>{cancellable ? '停止' : '处理中'}</span> : thinking ? <span>停止</span> : <UiIcon name="send" size={19} />}
        </button>
      </div>
      <div className="agent-composer-footnote">
        <button type="button" onClick={onToggleTaskCenter}><UiIcon name="history" size={13} /> 任务与结果{taskCount > 0 ? ` · ${taskCount}` : ''}</button>
        {quietHome && <span><UiIcon name="shield" size={13} /> 本地优先 · 内容上云前会询问</span>}
        <button type="button" onClick={onToggleSettings}>运行与隐私</button>
      </div>
    </div>
  )
}
