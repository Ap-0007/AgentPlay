import { Brand, FadeSlide, Headline, Kicker, Scene, Subhead, WindowShot } from '../components'

export const Workspace = () => <Scene>
  <Brand compact />
  <div style={{ display: 'grid', gridTemplateColumns: '0.78fr 1.22fr', gap: 52, alignItems: 'center', height: 840 }}>
    <div><FadeSlide><Kicker>One entry</Kicker><Headline size={72}>Links, videos,<br />subtitles, documents.</Headline></FadeSlide><FadeSlide delay={12}><Subhead width={660}>The interface stays quiet until the work needs a decision.</Subhead></FadeSlide></div>
    <FadeSlide delay={8}><WindowShot src="workspace.png" style={{ width: 1030, height: 600 }} /></FadeSlide>
  </div>
</Scene>
