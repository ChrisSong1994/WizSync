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
        // Shortcut of `build.lib.entry`.
        entry: 'src/main/main.ts',
        vite: {
          build: {
            rollupOptions: {
              external: ['chokidar', 'electron-store'],
            },
          },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        input: path.join(__dirname, 'src/main/preload.ts'),
      },
      // Ployfill the Electron and Node.js built-in modules for Renderer process.
      renderer: {},
    }),
  ],
  resolve: {
    alias: {
      '@': path.join(__dirname, 'src/render'),
    },
  },
})
