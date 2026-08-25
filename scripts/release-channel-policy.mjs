const SUPPORTED_CHANNELS = new Set(['preview', 'beta', 'stable'])

export function normalizeReleaseChannel(value) {
  const channel = String(value || '').trim().toLowerCase()
  if (!SUPPORTED_CHANNELS.has(channel)) throw new Error(`不支持的发布通道：${value || ''}`)
  return channel
}

function signingEvidence(verification, key) {
  const raw = verification?.signing?.[key] || {}
  return {
    status: String(raw.status || '').trim(),
    subject: String(raw.subject || '').trim(),
    thumbprint: String(raw.thumbprint || '').trim(),
    timestamped: raw.timestamped === true,
  }
}

export function resolveReleaseChannel({
  channel: rawChannel,
  verification,
  policy,
  acknowledgeUnsigned = false,
}) {
  const channel = normalizeReleaseChannel(rawChannel)
  const channelPolicy = policy?.channels?.[channel]
  if (!channelPolicy?.allowed) throw new Error(`发布通道 ${channel} 已被策略禁用`)

  const installer = signingEvidence(verification, 'installer')
  const application = signingEvidence(verification, 'application')
  if (!installer.status || !application.status) throw new Error('发布校验报告缺少安装包或主程序签名状态')

  const signed = [installer, application].every((item) => (
    item.status === 'Valid' && item.subject && item.thumbprint && item.timestamped
  ))
  if (!signed && channelPolicy.allowUnsigned !== true) {
    throw new Error(`${channel} 通道要求安装包与主程序 Authenticode 均为 Valid，并带证书身份与时间戳`)
  }
  if (!signed && !acknowledgeUnsigned) {
    throw new Error(`${channel} 通道为未签名候选，必须显式传入 --ack-unsigned`)
  }

  return {
    channel,
    prerelease: channelPolicy.prerelease === true,
    signed,
    signing: { installer, application },
    notice: signed ? String(channelPolicy.signedNotice || '') : String(channelPolicy.unsignedNotice || ''),
  }
}
