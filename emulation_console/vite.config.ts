import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api':       { target: process.env.VITE_API || 'http://localhost:3000', changeOrigin: true },
      '/wh':        { target: process.env.VITE_API || 'http://localhost:3000', changeOrigin: true },
      '/bots':      { target: process.env.VITE_API || 'http://localhost:3000', changeOrigin: true },
      '/spec':      { target: process.env.VITE_API || 'http://localhost:3000', changeOrigin: true },
      '/revisions': { target: process.env.VITE_API || 'http://localhost:3000', changeOrigin: true },
      '/generate':  { target: process.env.VITE_API || 'http://localhost:3000', changeOrigin: true },
      '/deploy':    { target: process.env.VITE_API || 'http://localhost:3000', changeOrigin: true },
    }
  }
})
