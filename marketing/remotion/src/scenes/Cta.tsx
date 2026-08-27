import { Brand, FadeSlide, Headline, Kicker, Pill, Scene, Subhead } from '../components'
import { colors } from '../theme'

export const Cta = () => <Scene>
  <div style={{ display: 'grid', placeItems: 'center', height: '100%', textAlign: 'center' }}>
    <div><Brand /><div style={{ height: 66 }} /><Kicker>Open source · Windows preview</Kicker><FadeSlide><Headline size={88} width={1500}>One local AI workspace.<br />Your files. Your decisions.</Headline></FadeSlide><Subhead width={1160}>Try the unsigned 0.9.1 Preview, verify its SHA-256, and help shape the first stable signed release.</Subhead><div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginTop: 46 }}><Pill accent={colors.cyan}>github.com/wg5759/AgentPlay</Pill><Pill>Apache-2.0</Pill></div></div>
  </div>
</Scene>
