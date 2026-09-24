import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev-only proxy so the browser talks to one origin and CORS never enters
    // the picture during development. In production the API base URL is baked
    // in at build time via VITE_API_BASE_URL.
    proxy: {
      '/api': { target: 'http://127.0.0.1:4010', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
