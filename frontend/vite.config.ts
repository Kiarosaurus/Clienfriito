import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev proxy target. Override to point the dev server at another backend,
// e.g. API_TARGET=http://localhost:8001 npx vite --port 3001
declare const process: { env: Record<string, string | undefined> }
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the stable vendor libraries out of the app chunk: better
        // long-term caching and no oversized-chunk warning on build.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/health': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
})
