import { Brand, FadeSlide, Headline, Pill, Scene, Subhead } from '../components'
import { colors } from '../theme'

export const Hook = () => <Scene>
  <Brand />
  <div style={{ marginTop: 126 }}>
    <FadeSlide><Headline>One place to get<br />real work done.</Headline></FadeSlide>
    <FadeSlide delay={10}><Subhead>Drop a file or paste a link. AgentPlay turns plain language into media, document, and AI workflows you can verify.</Subhead></FadeSlide>
    <FadeSlide delay={20}><div style={{ display: 'flex', gap: 16, marginTop: 44 }}><Pill accent={colors.cyan}>Local-first</Pill><Pill>Recoverable tasks</Pill><Pill accent={colors.green}>Quality receipts</Pill></div></FadeSlide>
  </div>
</Scene>
