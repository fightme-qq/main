import { defineConfig } from 'vite';

/**
 * Vite configuration for TitanCraft.
 *
 * `base: './'` produces relative asset URLs so the built `dist/` folder can be
 * dropped onto GitHub Pages (including project sub-paths), Netlify, Cloudflare
 * Pages or any static file server without further configuration.
 *
 * Workers are bundled with the `iife` format and imported through Vite's
 * `?worker` suffix. That is deliberately the most compatible option: classic
 * workers are supported everywhere, whereas module workers are unavailable on
 * older Safari/iOS builds we still want to run on.
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    sourcemap: false,
    assetsInlineLimit: 2048,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          return null;
        },
      },
    },
  },
  worker: {
    format: 'iife',
  },
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: ['localhost', '127.0.0.1'],
  },
  preview: {
    host: true,
    port: 4173,
  },
});
