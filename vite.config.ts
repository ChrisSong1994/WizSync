import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // 渲染进程本地开发端口（Electron 主进程通过 VITE_DEV_SERVER_URL 连接该端口）
  server: {
    port: 5678,
    // 端口被占用时直接失败，避免 Vite 自动换端口导致 Electron 连到旧地址
    strictPort: true,
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'src/main/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['electron-store'],
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'src/main/preload.ts'),
      },
      renderer: {},
    }),
  ],
  resolve: {
    alias: {
      '@': path.join(__dirname, 'src/render'),
    },
  },
})
