import { useEffect } from 'react'
import { useAgentStore } from '../../stores/agentStore'

type Options = {
  selectTask: (id: string) => void
  openTaskCenter: () => void
}

export default function useTaskNotificationNavigation({ selectTask, openTaskCenter }: Options) {
  useEffect(() => window.aiPlayer?.notifications?.onActivate((record) => {
    useAgentStore.getState().openPanel()
    openTaskCenter()
    window.dispatchEvent(new CustomEvent('agentplay-open-task-center'))
    if (record.outputPath) window.dispatchEvent(new CustomEvent('ai-player-play-file', { detail: record.outputPath }))
    const workspaceTaskId = String(record.workspaceTaskId || '')
    if (workspaceTaskId) window.setTimeout(() => selectTask(workspaceTaskId), 120)
    window.dispatchEvent(new CustomEvent('agentplay-notification-navigated', { detail: record }))
  }), [])
}
