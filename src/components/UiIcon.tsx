import type { SVGProps } from 'react'

export type UiIconName =
  | 'agent' | 'home' | 'history' | 'grid' | 'open'
  | 'analysis' | 'cast' | 'globe' | 'model' | 'palette'
  | 'pin' | 'plus' | 'mic' | 'send' | 'shield'
  | 'target' | 'settings' | 'close' | 'file' | 'video' | 'report'

interface Props extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: UiIconName
  size?: number
}

const PATHS: Record<UiIconName, string> = {
  agent: 'M4 13c5.2-.1 8.8-2.7 13.5-8-1.2 5-3.4 9.5-8.7 12.4L4 19l1.6-4.2L4 13Zm5.8-3.2L5.4 5.7l6 .9',
  home: 'm3 10 9-7 9 7M5 9.5V21h14V9.5M9 21v-7h6v7',
  history: 'M20.5 12a8.5 8.5 0 1 1-2.5-6M12 7v5l3.4 2M18 3v4h-4',
  grid: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
  open: 'M3.5 8h6l2 2H21v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2 2h7v5m-6 2-3 3m3-3 3 3m-3-3v6',
  analysis: 'M4 19V9m5 10V5m5 14v-7m5 7V3M3 7l5-4 5 6 7-6',
  cast: 'M3 5h18v12H3V5Zm5 16h8m-4-4v4M5 14c1.8 0 3 1.2 3 3m-3-7c4.2 0 7 2.8 7 7',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c4.4 5 4.4 13 0 18-4.4-5-4.4-13 0-18Z',
  model: 'm12 3 8 4.5-8 4.5-8-4.5L12 3ZM4 12l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5',
  palette: 'M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 0-4H12a1.5 1.5 0 0 1 0-3h3.2A5.8 5.8 0 0 0 21 8.2C21 5.3 17 3 12 3ZM7.5 9h.01M10 6.5h.01M15 6.5h.01',
  pin: 'm8 3 8 8m-2-8 7 7-4 1-4 4-1 4-7-7 4-1 4-4 1-4ZM9 15l-6 6',
  plus: 'M12 5v14M5 12h14',
  mic: 'M8 7a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0V7Zm-3 4a7 7 0 0 0 14 0m-7 7v3m-3 0h6',
  send: 'm4 4 17 8-17 8 3-8-3-8Zm3 8h14',
  shield: 'M12 3 4.5 6v5.2c0 4.6 3 8.2 7.5 9.8 4.5-1.6 7.5-5.2 7.5-9.8V6L12 3Zm-3 9 2 2 4-4',
  target: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-5 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM12 2v3m0 14v3M2 12h3m14 0h3',
  settings: 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm4.4 3 .4 2-2.8 2.8-2-.4-1 1.6h-4l-1-1.6-2 .4L4.2 17l.4-2-1.6-1v-4l1.6-1-.4-2L7 4.2l2 .4 1-1.6h4l1 1.6 2-.4L19.8 7l-.4 2 1.6 1v4l-1.6 1Z',
  close: 'm5 5 14 14M19 5 5 19',
  file: 'M6 3h8l4 4v14H6V3Zm8 0v5h5M9 13h6m-6 4h6',
  video: 'M3 5h18v14H3V5Zm7 4 5 3-5 3V9Z',
  report: 'M5 3h11l3 3v15H5V3Zm4 6h6m-6 4h6m-6 4h4'
}

export default function UiIcon({ name, size = 18, ...props }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d={PATHS[name]} />
    </svg>
  )
}
