import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev: the Vite server proxies /bff to the BFF (npm run bff). Prod: the BFF serves dist/.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/bff': process.env.BFF_URL ?? 'http://localhost:3000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
