import type { CSSProperties, ReactNode } from 'react'
import { Img, interpolate, staticFile, useCurrentFrame } from 'remotion'
import { colors, font } from './theme'

export const Backdrop = ({ children }: { children: ReactNode }) => {
  const frame = useCurrentFrame()
  const drift = interpolate(frame, [0, 180], [-120, 80], { extrapolateRight: 'clamp' })
  return <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', color: colors.text, fontFamily: font, background: `radial-gradient(circle at ${28 + drift / 30}% 18%, rgba(118,87,255,.28), transparent 34%), radial-gradient(circle at 82% 74%, rgba(57,198,255,.18), transparent 32%), ${colors.bg}` }}>{children}</div>
}

export const Brand = ({ compact = false }: { compact?: boolean }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 16 : 22 }}>
    <div style={{ width: compact ? 58 : 76, height: compact ? 58 : 76, borderRadius: 22, display: 'grid', placeItems: 'center', background: 'rgba(118,87,255,.16)', border: `1px solid ${colors.line}` }}>
      <Img src={staticFile('agentplay-mark.svg')} style={{ width: compact ? 42 : 56, height: compact ? 42 : 56 }} />
    </div>
    <div style={{ fontWeight: 740, letterSpacing: '-.02em', fontSize: compact ? 28 : 38 }}>AgentPlay</div>
  </div>
)

export const Kicker = ({ children }: { children: ReactNode }) => <div style={{ color: colors.cyan, fontSize: 25, fontWeight: 720, letterSpacing: '.06em', textTransform: 'uppercase' }}>{children}</div>

export const Headline = ({ children, size = 92, width = 1500 }: { children: ReactNode; size?: number; width?: number }) => <div style={{ maxWidth: width, marginTop: 24, fontSize: size, lineHeight: 1.02, letterSpacing: '-.055em', fontWeight: 790 }}>{children}</div>

export const Subhead = ({ children, width = 1200 }: { children: ReactNode; width?: number }) => <div style={{ maxWidth: width, marginTop: 28, fontSize: 34, lineHeight: 1.45, color: colors.muted }}>{children}</div>

export const Pill = ({ children, accent = colors.violet }: { children: ReactNode; accent?: string }) => <div style={{ padding: '17px 26px', borderRadius: 999, fontSize: 27, fontWeight: 650, background: `${accent}22`, border: `1px solid ${accent}66` }}>{children}</div>

export const WindowShot = ({ src, style }: { src: string; style?: CSSProperties }) => (
  <div style={{ overflow: 'hidden', borderRadius: 30, border: `1px solid ${colors.line}`, boxShadow: '0 34px 100px rgba(0,0,0,.48)', background: '#080b16', ...style }}>
    <Img src={staticFile(src)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  </div>
)

export const FadeSlide = ({ children, delay = 0, distance = 42 }: { children: ReactNode; delay?: number; distance?: number }) => {
  const frame = useCurrentFrame()
  const opacity = interpolate(frame, [delay, delay + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const y = interpolate(frame, [delay, delay + 22], [distance, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  return <div style={{ opacity, transform: `translateY(${y}px)` }}>{children}</div>
}

export const Scene = ({ children }: { children: ReactNode }) => <Backdrop><div style={{ position: 'absolute', inset: '74px 92px 70px' }}>{children}</div></Backdrop>
