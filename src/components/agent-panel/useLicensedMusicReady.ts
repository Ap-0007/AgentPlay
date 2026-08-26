import { useEffect } from 'react'
import { useAgentStore } from '../../stores/agentStore'

export default function useLicensedMusicReady() {
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; track?: string }>).detail
      if (!detail?.path) return
      const store = useAgentStore.getState()
      store.openPanel()
      store.addMessage('agent', `已把“${detail.track || '授权音乐'}”准备给剪辑 Agent；许可凭证已与音乐放在一起。你可以直接发送下面这句话，也可以补充音量、起止和节奏要求。`)
      store.setInputText(`使用 "${detail.path}" 作为当前视频的背景音乐，自动闪避对白，原视频不要覆盖`)
    }
    window.addEventListener('ai-player-licensed-music-ready', handler)
    return () => window.removeEventListener('ai-player-licensed-music-ready', handler)
  }, [])
}
