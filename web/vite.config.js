import { defineConfig } from 'vite';

const proxy = { '/api/v1': { target: 'http://127.0.0.1:8765', changeOrigin: false } };
const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws://127.0.0.1:5173; img-src 'self' blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
};

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy, headers },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy, headers },
  build: { outDir: 'dist' },
});
