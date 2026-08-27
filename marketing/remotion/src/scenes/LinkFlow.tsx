import { FadeSlide, Headline, Kicker, Pill, Scene, Subhead } from '../components'
import { colors } from '../theme'

export const LinkFlow = () => <Scene>
  <div style={{ marginTop: 54 }}><Kicker>Paste once</Kicker><Headline size={82}>Download — or download<br />and understand.</Headline><Subhead>Supported routes include YouTube, Bilibili, Douyin, X, and Facebook, with login boundaries shown instead of hidden.</Subhead></div>
  <FadeSlide delay={12}><div style={{ marginTop: 70, padding: 34, borderRadius: 28, background: 'rgba(17,23,42,.8)', border: `1px solid ${colors.line}` }}><div style={{ color: colors.muted, fontSize: 27 }}>https://x.com/creator/status/…</div><div style={{ display: 'flex', gap: 18, marginTop: 30 }}><Pill accent={colors.cyan}>Download only</Pill><Pill>Download + analyze</Pill></div></div></FadeSlide>
</Scene>
