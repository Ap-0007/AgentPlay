import { Composition } from 'remotion'
import { AgentPlayPromo } from './video'
import { SocialPreview } from './social-preview'

export const Root = () => (
  <>
    <Composition id="AgentPlayPromo" component={AgentPlayPromo} durationInFrames={1350} fps={30} width={1920} height={1080} />
    <Composition id="AgentPlaySocial" component={SocialPreview} durationInFrames={120} fps={30} width={1280} height={640} />
  </>
)
