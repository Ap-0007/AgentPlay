import { FadeSlide, Headline, Kicker, Scene, Subhead, WindowShot } from '../components'

export const EditFlow = () => <Scene>
  <div style={{ display: 'grid', gridTemplateColumns: '1.12fr .88fr', gap: 60, alignItems: 'center', height: 900 }}>
    <FadeSlide><WindowShot src="edit.png" style={{ width: 1040, height: 620 }} /></FadeSlide>
    <div><Kicker>Say the edit</Kicker><Headline size={68}>“Keep seconds 4–20.”</Headline><Subhead width={650}>Trim, remove, reorder, add music, repair audio, style subtitles, or reframe — while the source stays untouched.</Subhead></div>
  </div>
</Scene>
