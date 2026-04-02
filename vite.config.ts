import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
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
