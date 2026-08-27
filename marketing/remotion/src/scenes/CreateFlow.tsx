import { FadeSlide, Headline, Kicker, Scene, Subhead, WindowShot } from '../components'

export const CreateFlow = () => <Scene>
  <div style={{ display: 'grid', gridTemplateColumns: '.82fr 1.18fr', gap: 58, alignItems: 'center', height: 900 }}>
    <div><Kicker>Go beyond editing</Kicker><Headline size={69}>Ask for the missing shot.</Headline><Subhead width={630}>Create B-roll, voice, sound, subtitles, and a new rendered cut — with provenance and hashes kept beside the result.</Subhead></div>
    <FadeSlide delay={8}><WindowShot src="create.png" style={{ width: 1000, height: 620 }} /></FadeSlide>
  </div>
</Scene>
