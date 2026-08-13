import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import fs from 'fs'

// 从 ASCII junction 构建时，Rollup 会把 HTML 输入解析成真实路径；root 若仍保留
// junction 字符串，HTML 插件会误算出 ../中文路径/index.html 并拒绝产物名。
const projectRoot = fs.realpathSync(__dirname)

// 双端共享 Vite 配置：Electron 加载 dev server / 构建产物，Web 部署为 PWA
export default defineConfig({
  root: projectRoot,
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      includeAssets: ['icons/**'],
      manifest: {
        name: 'AgentPlay',
        short_name: 'AgentPlay',
        description: '会动手的 AI 媒体中枢',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      }
    })
  ],
  resolve: {
    alias: { '@': path.resolve(projectRoot, 'src') }
  },
  server: { port: 5173 }
})
