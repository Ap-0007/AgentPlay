import { AbsoluteFill, Sequence } from 'remotion'
import { CreateFlow } from './scenes/CreateFlow'
import { Cta } from './scenes/Cta'
import { EditFlow } from './scenes/EditFlow'
import { Hook } from './scenes/Hook'
import { LinkFlow } from './scenes/LinkFlow'
import { Proof } from './scenes/Proof'
import { Workspace } from './scenes/Workspace'

export const AgentPlayPromo = () => <AbsoluteFill>
  <Sequence from={0} durationInFrames={150}><Hook /></Sequence>
  <Sequence from={150} durationInFrames={180}><Workspace /></Sequence>
  <Sequence from={330} durationInFrames={180}><LinkFlow /></Sequence>
  <Sequence from={510} durationInFrames={210}><EditFlow /></Sequence>
  <Sequence from={720} durationInFrames={180}><CreateFlow /></Sequence>
  <Sequence from={900} durationInFrames={210}><Proof /></Sequence>
  <Sequence from={1110} durationInFrames={240}><Cta /></Sequence>
</AbsoluteFill>
