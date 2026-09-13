// Static dashboard bundle. Output is fully self-contained: relative asset
// paths, no CDN, no external fonts, no inline scripts (the broker serves it
// under a strict Content-Security-Policy).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'dashboard',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/dashboard',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    host: '127.0.0.1',
  },
});
