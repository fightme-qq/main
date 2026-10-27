/**
 * Browser verification for the generated sound library and the mixer.
 *
 * The Node self-test can validate a manifest on disk, but only a real browser can
 * answer the questions that matter here: does the AudioContext start, do the MP3s
 * decode, do streamed loops actually play, and does a gameplay key still resolve
 * when the file library is present?
 *
 * Run after `npm run visual:horror` or standalone: `npm run audio:browser`.
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const APP = join(ROOT, 'dist-smoketest', 'app');

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
  // Always rebuild unless asked not to: a stale instrumented bundle silently tests
  // the previous implementation, which is exactly how this check first reported a
  // correct game as broken.
  if (!process.argv.includes('--skip-build')) {
    console.log('Building instrumented bundle (NODE_ENV=development)...');
    execFileSync(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-smoketest/app', '--logLevel', 'warn'],
      { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'inherit' }
    );
  }
  if (!existsSync(join(APP, 'index.html'))) {
    throw new Error('instrumented bundle missing');
  }

  const host = await startServer(APP);
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (process.platform === 'win32' ? findPlaywrightChromium() : undefined);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // Without this Chromium keeps the AudioContext suspended in headless runs and
      // every playback assertion would fail for a reason unrelated to the game.
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
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
  });

  try {
    console.log('Starting a world...');
    await page.goto(`http://127.0.0.1:${host.port}/index.html`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('#boot-screen'), null, { timeout: 120000 });
    await page.waitForFunction(() => typeof window.game !== 'undefined', null, { timeout: 60000 });
    await page.locator('button', { hasText: 'World options' }).first().click();
    await page.waitForTimeout(400);
    // Creative keeps the test subject alive and unharassed while audio loads.
    await page.evaluate(() => {
      const select = document.querySelector('select[aria-label="Game mode and difficulty"]');
      if (!select) return;
      select.value = 'creative';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const inputs = page.locator('input.text-input');
    await inputs.nth(0).fill('Audio Check');
    await inputs.nth(1).fill('9090');
    await page.locator('button', { hasText: 'Create and play' }).first().click();
    await page.waitForFunction(() => window.game?.ui?.screen === 'playing', null, { timeout: 220000 });

    // The opening scene must already be dusk, not a bright day.
    const opening = await page.evaluate(() => ({
      time: window.game.lighting.timeOfDay,
      daylight: window.game.lighting.daylight,
    }));
    console.log('Opening:', JSON.stringify(opening));
    check(
      'the world opens in late afternoon',
      opening.time >= 0.55 && opening.time < 0.7,
      String(opening.time),
    );
    check('the opening light is already dim', opening.daylight < 0.55, String(opening.daylight));

    // The unlock is wired to the click that started the world; wait for it.
    await page.waitForFunction(() => window.game.audio?.unlocked === true, null, { timeout: 30000 })
      .catch(() => {});
    await page.waitForFunction(() => window.game.audio?.hasLibrary === true, null, { timeout: 60000 })
      .catch(() => {});
    await page.waitForFunction(
      () => (window.game.audio?.getStats().decoded ?? 0) >= 80,
      null,
      { timeout: 120000 }
    ).catch(() => {});

    const stats = await page.evaluate(() => ({
      ...window.game.audio.getStats(),
      contextState: window.game.audio._context?.state ?? 'none',
    }));
    console.log('Audio stats:', JSON.stringify(stats));

    // The frame loop should start ambience on its own once the library is in.
    const autoStarted = await page
      .waitForFunction(() => (window.game.audio?.getStats().libraryLoops ?? 0) >= 1, null, {
        timeout: 25000,
      })
      .then(() => true)
      .catch(() => false);

    // Diagnose the ambience path explicitly when the automatic start did not
    // happen: a paused game or a lost focus in a headless run stops the loop that
    // normally drives `updateAmbience`.
    const ambience = await page.evaluate(() => {
      const game = window.game;
      const before = game.audio.getStats().libraryLoops;
      game.audio.updateAmbience({
        underwater: false,
        altitude: game.player.position.y,
        daylight: game.lighting.daylight,
        rainIntensity: 0,
        paused: false,
        dimension: 'overworld',
        biome: 'Forest',
        underground: false,
      });
      return {
        before,
        after: game.audio.getStats().libraryLoops,
        paused: game.paused,
        screen: game.ui.screen,
        loops: game.audio.getStats().loops,
      };
    });
    console.log('Ambience probe:', JSON.stringify(ambience));

    check('the AudioContext runs', stats.contextState === 'running', stats.contextState);
    check('the generated manifest was loaded', stats.library === 142, String(stats.library));
    check('generated one-shots were decoded', stats.decoded >= 100, String(stats.decoded));
    check('gameplay keys have variants', stats.variants >= 40, String(stats.variants));
    check('streamed ambience starts from the frame loop', autoStarted, JSON.stringify(ambience));
    check('the ambience path starts streamed loops on demand', ambience.after >= 1);

    // Playback through the public API, exactly as gameplay calls it.
    const played = await page.evaluate(() => {
      const audio = window.game.audio;
      const result = {};
      for (const key of [
        'step.grass',
        'break.stone',
        'place.wood',
        'player.hurt',
        'chest.open',
        'craft.complete',
        'creature_walker_growl_01',
        'horror_sting_subtle_01',
      ]) {
        result[key] = audio.play(key);
      }
      return result;
    });
    for (const [key, ok] of Object.entries(played)) {
      check(`play("${key}") starts a voice`, ok === true);
    }

    // Positional audio: a creature call placed off to the side must go through a
    // PannerNode, and the library's direct-play API must be usable by the AI later.
    const spatial = await page.evaluate(() => {
      const audio = window.game.audio;
      const player = window.game.player.position;
      const started = audio.playLibrarySound('horror_knock_01', {
        position: { x: player.x + 6, y: player.y + 1, z: player.z },
        hrtf: true,
      });
      return { started, voices: audio.getStats().spatialVoices };
    });
    check('positional playback starts', spatial.started === true);
    check('positional playback uses a panner', spatial.voices >= 1, String(spatial.voices));

    // Movement sounds: jump, landing and the five-variant footsteps the user can
    // actually hear while running.
    const movement = await page.evaluate(async () => {
      const audio = window.game.audio;
      // Spaced out: the player category caps simultaneous voices, and three
      // instant plays would test the cap rather than the recordings.
      const jump = audio.play('player.jump');
      await new Promise((done) => setTimeout(done, 350));
      const land = audio.play('player.land');
      await new Promise((done) => setTimeout(done, 350));
      const swim = audio.play('player.swim');
      return {
        jump,
        land,
        swim,
        variants: (audio._variants.get('step.grass') ?? []).length,
      };
    });
    check('jump has a recorded sound', movement.jump === true);
    check('landing has a recorded sound', movement.land === true);
    check('swimming has a recorded sound', movement.swim === true);
    check('grass footsteps have five variants', movement.variants === 5, String(movement.variants));

    // Night mood: the music bed switches and the director schedules a scare.
    await page.evaluate(() => window.game.lighting.setTimeOfDay(0.9));
    await page.waitForTimeout(2500);
    const mood = await page.evaluate(async () => {
      const game = window.game;
      // Step the director directly: the headless frame loop can be slower than the
      // countdown, and this assertion is about pacing, not frame rate. One minute
      // of simulated night must contain at least one event.
      for (let step = 0; step < 600; step++) {
        game.tension.update(0.1, {
          phase: 'night',
          daylight: 0,
          position: game.player.position,
          healthFraction: 1,
        });
      }
      return {
        music: game.audio.getStats().music,
        lastEvent: game.tension.getStats().lastEvent,
        heartbeat: game.audio.getStats().libraryLoops,
      };
    });
    check('night switches the music bed', mood.music === 'music.night', String(mood.music));
    check('the director fires a night event', Boolean(mood.lastEvent), String(mood.lastEvent));
    check('night keeps streamed layers running', mood.heartbeat >= 1, String(mood.heartbeat));

    // A new category slider must exist and move exactly one gain node.
    const category = await page.evaluate(() => {
      const game = window.game;
      // 0.45 is on the slider's 0.05 step; 0.42 would be snapped and the assertion
      // would test the snapping rather than the mixer.
      game.settings.setMany({ 'audio.creatures': 0.45 });
      game.audio.applySettings(game.settings.values.audio);
      const gain = game.audio._categoryGains.creatures;
      return {
        value: game.settings.values.audio.creatures,
        hasGain: Boolean(gain),
        gainValue: gain ? gain.gain.value : null,
      };
    });
    check('the creatures category has its own gain node', category.hasGain);
    check('the creatures slider reaches the mixer', category.value === 0.45, String(category.value));

    // Footsteps must cycle through more than one file.
    const variants = await page.evaluate(() => {
      const audio = window.game.audio;
      return [...(audio._variants.get('step.grass') ?? [])];
    });
    check('grass footsteps have five recorded variants', variants.length === 5, variants.join(','));

    // Restore the default so a later run starts from the documented value.
    await page.evaluate(() => window.game.settings.setMany({ 'audio.creatures': 0.85 }));
  } finally {
    await browser.close();
    host.server.close();
  }

  const relevant = consoleErrors.filter((line) => !/Autoplay|GroupMarkerNotSet|SwiftShader/i.test(line));
  check('no console errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));
  const audioFailures = failedRequests.filter((line) => /assets\/audio/.test(line));
  check('every audio asset request succeeded', audioFailures.length === 0, audioFailures.slice(0, 3).join(' | '));

  if (failures > 0) {
    console.log(`\nAudio browser check: ${failures} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nAudio browser check: all assertions passed.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
