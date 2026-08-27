import { FadeSlide, Headline, Kicker, Pill, Scene, Subhead } from '../components'
import { colors } from '../theme'

const facts = [
  ['20 / 20', 'professional edit samples passed'],
  ['Quality 100', 'delivery gate on every sample'],
  ['0 repeats', 'after eight task restarts'],
  ['0 cloud calls', 'for the E5 local editing corpus']
]

export const Proof = () => <Scene>
  <Kicker>Evidence, not a spinner</Kicker><Headline size={78}>Long work survives.<br />Results prove themselves.</Headline><Subhead>Checkpoints, approval boundaries, failure reasons, automatic repair, output hashes, and task receipts are first-class product behavior.</Subhead>
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginTop: 64 }}>{facts.map(([value, label], index) => <FadeSlide delay={index * 7} key={value}><div style={{ height: 210, padding: 30, borderRadius: 26, background: 'rgba(17,23,42,.82)', border: `1px solid ${colors.line}` }}><div style={{ fontSize: 49, fontWeight: 780, color: index === 1 ? colors.green : colors.text }}>{value}</div><div style={{ marginTop: 18, fontSize: 24, lineHeight: 1.35, color: colors.muted }}>{label}</div></div></FadeSlide>)}</div>
</Scene>
