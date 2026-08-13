import { useEffect, useState } from 'react'
import UiIcon from '../UiIcon'
import { AGENT_MODES } from '../../../electron/agent-runtime-policy.mjs'
import type { AgentMode } from '../../../electron/agent-runtime-policy.mjs'

type ServiceId = 'tmdb' | 'opensubtitles'
type ServiceCredentialStatus = {
  hasKey: boolean
  source: 'system' | 'environment' | 'none'
}

type RuntimeSettingsProps = {
  open: boolean
  onClose: () => void
  onGuide: () => void
  addMessage: (role: 'user' | 'agent', text: string) => void
  agentMode: AgentMode
  onAgentModeChange: (mode: AgentMode) => void
}

export default function RuntimeSettings({ open, onClose, onGuide, agentMode, onAgentModeChange }: RuntimeSettingsProps) {
  const [tmdbKey, setTmdbKey] = useState('')
  const [subtitleKey, setSubtitleKey] = useState('')
  const [serviceCredentials, setServiceCredentials] = useState<Record<ServiceId, ServiceCredentialStatus>>({
    tmdb: { hasKey: false, source: 'none' },
    opensubtitles: { hasKey: false, source: 'none' }
  })
  const [serviceSaving, setServiceSaving] = useState(false)
  const [serviceSaveStatus, setServiceSaveStatus] = useState('')
  const [modelLabel, setModelLabel] = useState('正在读取…')

  const applyRoutingLabel = (status: ModelRoutingStatus) => {
    const labels: Record<ModelRoutingStatus['settings']['preference'], string> = {
      smart: '智能选择',
      local: '只在本机',
      cloud: '优先效果'
    }
    setModelLabel(labels[status.settings.preference])
  }

  const openModelCenter = () => {
    onClose()
    window.dispatchEvent(new CustomEvent('ai-player-action', { detail: 'model-center' }))
  }

  const refreshModelPreference = async () => {
    const status = await window.aiPlayer?.models?.routingStatus?.()
    if (status) applyRoutingLabel(status)
    return status
  }

  const refreshServiceCredentials = async () => {
    const status = await window.aiPlayer?.serviceCredentials?.status()
    if (status) setServiceCredentials(status.services)
    return status
  }

  const saveOtherServices = async () => {
    if (serviceSaving) return
    setServiceSaving(true)
    setServiceSaveStatus('')
    try {
      const credentialApi = window.aiPlayer?.serviceCredentials
      if (!credentialApi) throw new Error('服务凭证只能在桌面版使用系统加密存储保存')
      if (tmdbKey.trim()) await credentialApi.save({ service: 'tmdb', key: tmdbKey.trim() })
      if (subtitleKey.trim()) await credentialApi.save({ service: 'opensubtitles', key: subtitleKey.trim() })
      await refreshServiceCredentials()
      setTmdbKey('')
      setSubtitleKey('')
      setServiceSaveStatus('已保存到系统加密存储')
      onClose()
    } catch (error) {
      setServiceSaveStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setServiceSaving(false)
    }
  }

  const clearServiceCredential = async (service: ServiceId) => {
    if (serviceSaving) return
    setServiceSaving(true)
    setServiceSaveStatus('')
    try {
      const credentialApi = window.aiPlayer?.serviceCredentials
      if (!credentialApi) throw new Error('服务凭证只能在桌面版清除')
      const status = await credentialApi.save({ service, clear: true })
      if (status) setServiceCredentials(status.services)
      if (service === 'tmdb') setTmdbKey('')
      else setSubtitleKey('')
      setServiceSaveStatus(status?.services[service].source === 'environment' ? '已清除本机保存值；环境变量仍在生效' : '已清除')
    } catch (error) {
      setServiceSaveStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setServiceSaving(false)
    }
  }

  useEffect(() => {
    const load = () => void refreshModelPreference()
    load()
    const handler = () => load()
    window.addEventListener('ai-player-models-changed', handler)
    return () => window.removeEventListener('ai-player-models-changed', handler)
  }, [])

  useEffect(() => {
    let active = true
    const migrateLegacyCredentials = async () => {
      const legacyTmdb = localStorage.getItem('aiplayer_tmdb_key') || ''
      const legacySubtitles = localStorage.getItem('aiplayer_subtitle_key') || ''
      try {
        if (legacyTmdb && window.aiPlayer?.serviceCredentials) {
          const status = await window.aiPlayer.serviceCredentials.save({ service: 'tmdb', key: legacyTmdb })
          if (status.services.tmdb.hasKey) localStorage.removeItem('aiplayer_tmdb_key')
        }
        if (legacySubtitles && window.aiPlayer?.serviceCredentials) {
          const status = await window.aiPlayer.serviceCredentials.save({ service: 'opensubtitles', key: legacySubtitles })
          if (status.services.opensubtitles.hasKey) localStorage.removeItem('aiplayer_subtitle_key')
        }
        const status = await window.aiPlayer?.serviceCredentials?.status()
        if (active && status) setServiceCredentials(status.services)
      } catch (error) {
        if (active) setServiceSaveStatus(error instanceof Error ? error.message : String(error))
      }
    }
    void migrateLegacyCredentials()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (open) {
      void refreshServiceCredentials()
      void refreshModelPreference()
    }
  }, [open])

  if (!open) return null
  const serviceStateText = (service: ServiceId) => serviceCredentials[service].source === 'environment'
    ? '环境变量已配置'
    : serviceCredentials[service].hasKey ? '已安全保存' : '未配置'

  return (
    <section className="agent-backstage" aria-label="运行与隐私设置">
      <div className="agent-backstage-heading">
        <div><span>后台设置</span><strong>运行方式与可选服务</strong></div>
        <button type="button" onClick={onClose} aria-label="关闭设置"><UiIcon name="close" size={16} /></button>
      </div>
      <div className="agent-runtime-row">
        <div><span className="agent-backstage-label">AI 运行方式</span><small>{modelLabel}</small></div>
        <div className="agent-segmented-control">
          <button type="button" onClick={openModelCenter}>更改 AI 使用方式</button>
        </div>
      </div>
      <div className="agent-runtime-row agent-mode-row">
        <div><span className="agent-backstage-label">工作方式</span><small>{AGENT_MODES[agentMode].description}</small></div>
        <div className="agent-segmented-control" aria-label="Agent 工作方式">
          {(Object.keys(AGENT_MODES) as AgentMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              title={AGENT_MODES[mode].description}
              onClick={() => onAgentModeChange(mode)}
              className={agentMode === mode ? 'is-active' : ''}
            >{AGENT_MODES[mode].label}</button>
          ))}
        </div>
      </div>
      <div className="agent-service-grid">
        <div className="agent-service-field">
          <div className="agent-service-field-heading"><span>海报信息服务 · {serviceStateText('tmdb')}</span>{serviceCredentials.tmdb.source === 'system' && <button type="button" onClick={() => void clearServiceCredential('tmdb')} disabled={serviceSaving}>清除</button>}</div>
          <input type="password" value={tmdbKey} onChange={(event) => setTmdbKey(event.target.value)} autoComplete="off" placeholder={serviceCredentials.tmdb.hasKey ? '输入新 Key 可替换' : 'TMDB Key（可选）'} />
        </div>
        <div className="agent-service-field">
          <div className="agent-service-field-heading"><span>在线字幕库 · {serviceStateText('opensubtitles')}</span>{serviceCredentials.opensubtitles.source === 'system' && <button type="button" onClick={() => void clearServiceCredential('opensubtitles')} disabled={serviceSaving}>清除</button>}</div>
          <input type="password" value={subtitleKey} onChange={(event) => setSubtitleKey(event.target.value)} autoComplete="off" placeholder={serviceCredentials.opensubtitles.hasKey ? '输入新 Key 可替换' : 'OpenSubtitles API Key（不是 AI 模型）'} />
        </div>
      </div>
      {serviceSaveStatus && <p className="agent-service-status" role="status">{serviceSaveStatus}</p>}
      <div className="agent-backstage-actions">
        <button type="button" onClick={onGuide}><UiIcon name="target" size={16} /> 屏幕指路</button>
        <button type="button" onClick={() => void saveOtherServices()} disabled={serviceSaving} className="is-primary">{serviceSaving ? '保存中…' : '保存设置'}</button>
      </div>
    </section>
  )
}
