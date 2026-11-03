/**
 * Builds a single self-contained HTML file for browser smoke testing.
 *
 * Why this exists: the sandbox's headless browser can read the filesystem but
 * cannot reach a local HTTP server, and `file://` pages have a null origin, which
 * blocks ES module scripts. Bundling everything — JS, CSS and the Web Worker —
 * into one inline classic script sidesteps both restrictions, so the real engine
 * can be booted and inspected end to end.
 *
 * This is a *test harness only*. The shipped build is produced by `vite build`
 * and is a normal multi-file ES module bundle; nothing here affects it.
 *
 * Usage: node scripts/build-smoketest.mjs [outputPath]
 */

import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const OUTPUT = resolve(PROJECT_ROOT, process.argv[2] || 'dist-smoketest/index.html');

/** Vite's `?raw` suffix becomes esbuild's `text` loader. */
const rawSuffixPlugin = {
  name: 'raw-suffix',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-file',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'raw-file' }, async (args) => {
      const { readFile } = await import('node:fs/promises');
      return { contents: await readFile(args.path, 'utf8'), loader: 'text' };
    });
  },
};

/**
 * Vite's `?worker` suffix becomes an inline Blob worker.
 *
 * The worker is bundled separately as an IIFE, then embedded as a string literal
 * and turned into a `Blob` URL at construction time. That is exactly what Vite's
 * `?worker&inline` does, so the runtime behaviour matches the shipped build.
 */
const inlineWorkerPlugin = {
  name: 'inline-worker',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\?worker$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?worker$/, '')),
      namespace: 'inline-worker',
    }));

    pluginBuild.onLoad({ filter: /.*/, namespace: 'inline-worker' }, async (args) => {
      const result = await build({
        entryPoints: [args.path],
        bundle: true,
        write: false,
        format: 'iife',
        target: 'es2020',
        platform: 'browser',
        plugins: [rawSuffixPlugin],
        logLevel: 'error',
      });
      const code = result.outputFiles[0].text;

      return {
        contents: `
          const workerSource = ${JSON.stringify(code)};
          let cachedUrl = null;
          export default class InlineWorker extends Worker {
            constructor() {
              if (!cachedUrl) {
                cachedUrl = URL.createObjectURL(
                  new Blob([workerSource], { type: 'text/javascript' })
                );
              }
              super(cachedUrl);
            }
          }
        `,
        loader: 'js',
        resolveDir: dirname(args.path),
      };
    });
  },
};

/** CSS is injected with a `<style>` tag at import time. */
const inlineCssPlugin = {
  name: 'inline-css',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.css$/ }, async (args) => {
      const { readFile } = await import('node:fs/promises');
      const css = await readFile(args.path, 'utf8');
      return {
        contents: `
          const style = document.createElement('style');
          style.textContent = ${JSON.stringify(css)};
          document.head.appendChild(style);
        `,
        loader: 'js',
      };
    });
  },
};

const result = await build({
  entryPoints: [resolve(PROJECT_ROOT, 'src/main.js')],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  platform: 'browser',
  // The smoke test wants `window.game`, which the entry point only exposes in a
  // development build.
  define: {
    'import.meta.env': JSON.stringify({ DEV: true }),
    'import.meta.hot': 'undefined',
  },
  plugins: [inlineWorkerPlugin, rawSuffixPlugin, inlineCssPlugin],
  logLevel: 'info',
});

const bundle = result.outputFiles[0].text;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>TitanCraft — smoke test</title>
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  </head>
  <body>
    <div id="app">
      <canvas id="game-canvas"></canvas>
      <div id="ui-root"></div>
    </div>
    <div id="boot-screen" class="boot-screen">
      <div class="boot-inner">
        <h1 class="boot-title">TITAN<span>CRAFT</span></h1>
        <div class="boot-bar"><div class="boot-bar-fill"></div></div>
        <p class="boot-status">Loading engine&hellip;</p>
      </div>
    </div>
    <script>
${bundle}
    </script>
  </body>
</html>
`;

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, html);
console.log(`wrote ${OUTPUT} (${(html.length / 1024).toFixed(0)} KB)`);
