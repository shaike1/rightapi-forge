import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  // The React app is mounted at /app/ in production (Express routes
  // /app and /app/* to public/app/index.html). Without an explicit
  // base, vite emits root-absolute asset paths (<script src="/assets/...">),
  // which 404 because the files actually live under /app/assets/...
  // Setting base aligns emitted HTML with where the bundle is served.
  // BrowserRouter's basename is also "/app" (src/main.tsx).
  base: '/app/',
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') }
  },
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.replaceAll('\\', '/')
          if (/\/node_modules\/(react|react-dom|react-router|react-router-dom)\//.test(moduleId)) return 'vendor-react'
          if (moduleId.includes('/node_modules/recharts/')) return 'vendor-charts'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:19123',
      '/integrations': 'http://localhost:19123',
    }
  }
})
