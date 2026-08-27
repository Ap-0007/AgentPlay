import { Img, staticFile } from 'remotion'
import { Backdrop, Brand, Pill } from './components'
import { colors, font } from './theme'

export const SocialPreview = () => <Backdrop>
  <div style={{ position: 'absolute', inset: 50, display: 'grid', gridTemplateColumns: '0.92fr 1.08fr', gap: 44, alignItems: 'center', fontFamily: font }}>
    <div><Brand compact /><div style={{ marginTop: 58, fontSize: 64, lineHeight: 1.02, letterSpacing: '-.055em', fontWeight: 790 }}>One local AI workspace<br />for links, media,<br />and documents.</div><div style={{ display: 'flex', gap: 12, marginTop: 34 }}><Pill accent={colors.cyan}>Open source</Pill><Pill>Local-first</Pill></div></div>
    <div style={{ height: 500, overflow: 'hidden', borderRadius: 28, border: `1px solid ${colors.line}`, boxShadow: '0 30px 90px rgba(0,0,0,.5)' }}><Img src={staticFile('workspace.png')} style={{ width: 1020, height: 500, objectFit: 'cover', objectPosition: 'right center', transform: 'translateX(-330px)' }} /></div>
  </div>
</Backdrop>
