import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('Origin', 'http://127.0.0.1:8787'));
        },
      },
      '/telegram': 'http://127.0.0.1:8787',
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
  build: { sourcemap: false, target: 'es2022' },
});
