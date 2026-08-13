import { useEffect } from 'react'

type CurrentRef<T> = { current: T }

type VoiceInputOptions = {
  listening: boolean
  setListening: (value: boolean) => void
  setInputText: (value: string) => void
  setStatus: (value: string) => void
  addMessage: (role: 'user' | 'agent', text: string) => void
  routeTextRef: CurrentRef<(textOverride?: string) => Promise<void>>
}

export default function useVoiceInput(options: VoiceInputOptions) {
  const {
    listening, setListening, setInputText, setStatus, addMessage, routeTextRef
  } = options

  useEffect(() => {
    if (!listening) return
    let cancelled = false
    let recorder: MediaRecorder | null = null
    const chunks: Blob[] = []
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        addMessage('agent', '[错误] 当前环境不支持录音')
        setListening(false)
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        recorder = new MediaRecorder(stream)
        recorder.ondataavailable = (event) => {
          if (!event.data.size) return
          const total = chunks.reduce((sum, chunk) => sum + chunk.size, 0) + event.data.size
          if (total > 25 * 1024 * 1024) {
            addMessage('agent', '录音已达 25MB 上限，自动停止')
            setListening(false)
            try { recorder?.stop() } catch { /* 已停止 */ }
            return
          }
          chunks.push(event.data)
        }
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop())
          if (cancelled) return
          const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' })
          if (!blob.size) return
          setStatus('正在离线转写语音…')
          try {
            const data = new Uint8Array(await blob.arrayBuffer())
            const result = await window.aiPlayer?.transcribe?.blob({ data, ext: '.webm' })
            if (result?.success && result.text) {
              const text = result.text.trim()
              if (text) {
                setInputText(text)
                window.setTimeout(() => void routeTextRef.current(text), 0)
              }
            } else {
              addMessage('agent', `[错误] ${result?.error || '语音转写失败'}`)
            }
          } finally {
            setStatus('')
          }
        }
        recorder.start()
      } catch (error) {
        addMessage('agent', `[错误] 无法打开麦克风：${error instanceof Error ? error.message : String(error)}`)
        setListening(false)
      }
    }
    void start()
    return () => {
      cancelled = true
      try { recorder?.stop() } catch { /* 已停止 */ }
    }
  }, [listening, setListening])
}
