import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Second build target: emits the unpacked MV3 extension.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: resolve(__dirname, '../extension-dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        ceremony: resolve(__dirname, 'ceremony.html'),
        background: resolve(__dirname, 'background.js'),
      },
      output: { entryFileNames: '[name].js', format: 'es' },
    },
  },
})
