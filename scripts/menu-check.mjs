/**
 * Main-menu contract check.
 *
 * The menu is deliberately minimal now: one Play button, two quiet secondary
 * actions, and a first click that drops the player straight into a survival world
 * on normal difficulty and the medium graphics preset. This script proves exactly
 * that in a real browser, because menu layout is the one thing a unit test cannot
 * see.
 *
 * Usage: `npm run menu:browser`
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP = join(ROOT, 'dist-smoketest', 'app');
const OUT = join(ROOT, 'dist-smoketest', 'visual');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function startServer(root) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const target = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(root)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, {
        'content-type': MIME[extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }));
  });
}

function findPlaywrightChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!existsSync(cache)) return null;
  for (const entry of readdirSync(cache)) {
    if (!entry.startsWith('chromium-')) continue;
    for (const relative of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome']) {
      const candidate = join(cache, entry, relative);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  if (!process.argv.includes('--skip-build')) {
    console.log('Building instrumented bundle (NODE_ENV=development)...');
    execFileSync(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-smoketest/app', '--logLevel', 'warn'],
      { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'inherit' }
    );
  }
  mkdirSync(OUT, { recursive: true });

  const host = await startServer(APP);
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (process.platform === 'win32' ? findPlaywrightChromium() : undefined);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
    ],
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1024, height: 640 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  try {
    await page.goto(`http://127.0.0.1:${host.port}/index.html`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('#boot-screen'), null, { timeout: 120000 });
    await page.waitForFunction(() => typeof window.game !== 'undefined', null, { timeout: 60000 });

    const menu = await page.evaluate(() => {
      const screen = document.querySelector('.screen--menu');
      if (!screen) return { buttons: [] };
      const buttons = [...screen.querySelectorAll('button')]
        .filter((node) => node.offsetParent !== null)
        .map((node) => node.textContent.trim());
      return { buttons };
    });
    console.log('Menu buttons:', JSON.stringify(menu.buttons));

    check('the main screen has a Play button', menu.buttons.includes('Play'));
    check('extra options live behind World options', menu.buttons.includes('World options'));
    check('settings have their own button', menu.buttons.includes('Settings'));
    check('there is no separate New world button', !menu.buttons.includes('New world'));
    check('there is no import button on the main screen', !menu.buttons.includes('Import save'));

    const defaults = await page.evaluate(() => ({
      mode: window.game.settings.get('gameplay.mode'),
      preset: window.game.settings.get('graphics.preset'),
    }));
    check('the default mode is survival', defaults.mode === 'survival', String(defaults.mode));
    check('the default preset is medium', defaults.preset === 'medium', String(defaults.preset));

    await page.screenshot({ path: join(OUT, 'menu-single-play.png') });

    console.log('Pressing Play...');
    await page.locator('button', { hasText: 'Play' }).first().click();
    await page.waitForFunction(() => window.game?.ui?.screen === 'playing', null, { timeout: 240000 });

    const started = await page.evaluate(() => ({
      mode: window.game.worldRecord?.mode,
      difficulty: window.game.worldRecord?.difficulty,
      preset: window.game.settings.get('graphics.preset'),
      playing: window.game.ui.screen,
    }));
    console.log('Started world:', JSON.stringify(started));
    check('Play starts a world without opening a dialog', started.playing === 'playing');
    check('the new world is survival', started.mode === 'survival', String(started.mode));
    check('the new world is normal difficulty', started.difficulty === 'normal', String(started.difficulty));
    check('the new world uses the medium preset', started.preset === 'medium', String(started.preset));

    await page.screenshot({ path: join(OUT, 'menu-play-start.png') });
  } finally {
    await browser.close();
    host.server.close();
  }

  const relevant = consoleErrors.filter((line) => !/Autoplay|GroupMarkerNotSet|SwiftShader/i.test(line));
  check('no console errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));

  if (failures > 0) {
    console.log(`\nMenu check: ${failures} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nMenu check: all assertions passed.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
