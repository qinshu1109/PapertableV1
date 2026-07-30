import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: true,
      },
    },
  },
  build: {
    // 构建产物直接进入后端静态目录，访问 127.0.0.1:4317 即完整应用
    outDir: '../public',
    emptyOutDir: true,
  },
});
