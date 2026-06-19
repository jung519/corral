import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Dev server proxies the control-plane API (run `pnpm dev` in the repo root on :4400).
// In production the built assets are served by the control-plane server / Electron.
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4400',
      '/events': 'http://localhost:4400',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
