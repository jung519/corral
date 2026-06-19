import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Dev server proxies the control-plane API (run `pnpm dev` in the repo root on :4400).
// In production the built assets are served by the control-plane server / Electron.
export default defineConfig({
  // Relative asset paths so the build works under file:// (Electron) AND when served
  // by the control-plane server. Absolute "/assets" would 404 under file://.
  base: './',
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
