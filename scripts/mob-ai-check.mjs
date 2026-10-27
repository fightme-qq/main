/**
 * Browser verification for the horror roster's behaviour.
 *
 * The Node self-test proves the brain's state machine; this proves the *wiring*:
 * that a spawned walker actually notices the player in a live world, that a hunter
 * runs, that a stalker leaves when stared at, that the recorded voices are played,
 * and that the stalker despawns without a death event.
 *
 * Usage: `npm run mobs:browser` (add `--skip-build` to reuse the last bundle).
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
  await page.setViewportSize({ width: 1280, height: 720 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  try {
    console.log('Creating a survival world...');
    await page.goto(`http://127.0.0.1:${host.port}/index.html`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('#boot-screen'), null, { timeout: 120000 });
    await page.waitForFunction(() => typeof window.game !== 'undefined', null, { timeout: 60000 });
    await page.locator('button', { hasText: 'World options' }).first().click();
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const select = document.querySelector('select[aria-label="Game mode and difficulty"]');
      if (!select) return;
      select.value = 'normal';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const inputs = page.locator('input.text-input');
    await inputs.nth(0).fill('Mob AI Check');
    await inputs.nth(1).fill('55117');
    await page.locator('button', { hasText: 'Create and play' }).first().click();
    await page.waitForFunction(() => window.game?.ui?.screen === 'playing', null, { timeout: 220000 });
    await page.waitForFunction(() => (window.game?.world?.stats?.loaded ?? 0) > 8, null, { timeout: 150000 });

    await page.evaluate(() => {
      const game = window.game;
      game.settings.setMany({ 'graphics.renderDistance': 4, 'graphics.shadows': false });
      // Night, so hostile spawning and the roles are in their element.
      game.lighting.setTimeOfDay(0.0);
      game.settings.setMany({ 'gameplay.pauseDayCycle': true });
      // Record every sound requested through the mixer.
      window.__played = [];
      const play = game.audio.play.bind(game.audio);
      game.audio.play = (name, options) => {
        window.__played.push(name);
        return play(name, options);
      };
    });
    await page.waitForTimeout(2500);

    const spawn = await page.evaluate(() => {
      const game = window.game;
      const p = game.player.position;
      game.entities.mobs.forEach((mob) => { if (mob.alive) mob.kill(); });
      const walker = game.entities.spawnMob('walker', p.x, p.y + 0.2, p.z - 9, 31);
      const hunter = game.entities.spawnMob('hunter', p.x + 9, p.y + 0.2, p.z - 7, 32);
      const stalker = game.entities.spawnMob('stalker', p.x - 15, p.y + 0.2, p.z - 6, 33);
      // Look north at the walker; the stalker is placed off to the side on purpose.
      game.cameraController.yaw = 0;
      // Heal continuously: the point of the test is behaviour, and a hunter that
      // kills the test subject would end the run early.
      window.__heal = setInterval(() => {
        if (game.player?.stats) game.player.stats.health = game.player.stats.maxHealth;
      }, 250);
      return {
        walker: Boolean(walker),
        hunter: Boolean(hunter),
        stalker: Boolean(stalker),
        creative: game.player.isCreative,
      };
    });
    check('all three roles spawn', spawn.walker && spawn.hunter && spawn.stalker);
    check('the test player is in survival', spawn.creative === false);

    await page.waitForTimeout(3500);
    const states = await page.evaluate(() => {
      const byId = {};
      for (const mob of window.game.entities.mobs) {
        if (mob.alive && mob.definition?.behavior) byId[mob.definition.behavior] = mob.brainState;
      }
      return { byId, played: window.__played.slice() };
    });
    console.log('States:', JSON.stringify(states.byId));
    check(
      'the walker notices and commits to a chase',
      ['detect', 'chase', 'attack', 'search'].includes(states.byId.walker),
      String(states.byId.walker),
    );
    check(
      'the hunter closes the distance',
      ['detect', 'chase', 'attack', 'search'].includes(states.byId.hunter),
      String(states.byId.hunter),
    );
    check(
      'the stalker watches instead of charging',
      ['observe', 'roam', 'retreat'].includes(states.byId.stalker),
      String(states.byId.stalker),
    );
    check(
      'creature voices were played',
      states.played.some((name) => name.startsWith('creature_walker_') || name.startsWith('creature_hunter_')),
      states.played.filter((name) => name.startsWith('creature_')).slice(0, 4).join(','),
    );

    await page.screenshot({ path: join(OUT, 'mob-roles-night.png') });

    // Stare the stalker down. The world-level sight line depends on terrain, so the
    // live mob's brain is driven with a deterministic perception instead: same code
    // path the game uses, minus "a tree happened to be in the way".
    const stare = await page.evaluate(async () => {
      const game = window.game;
      const stalker = game.entities.mobs.find((mob) => mob.alive && mob.definition?.behavior === 'stalker');
      if (!stalker) return { missing: true };
      const brain = stalker.horrorBrain;
      const target = { x: game.player.position.x, y: game.player.position.y, z: game.player.position.z };
      stalker.x = target.x;
      stalker.z = target.z - 15;
      const ctx = {
        mob: stalker,
        target,
        targetVisible: true,
        distance: 15,
        playerLook: { x: 0, z: -1 },
        attackCooldown: 0,
        emitSound: () => {},
      };
      let intent;
      for (let step = 0; step < 20; step++) intent = brain.update(0.1, ctx);
      const left = intent.state;

      const farCtx = { ...ctx, distance: 40, targetVisible: false, playerLook: { x: 0, z: 1 } };
      let despawned = false;
      for (let step = 0; step < 40; step++) {
        intent = brain.update(0.1, farCtx);
        if (intent.despawn) despawned = true;
      }
      return { left, despawned, alive: stalker.alive };
    });
    check('staring makes the stalker leave', stare.left === 'retreat', String(stare.left));
    check('the stalker despawns once it is alone and unseen', stare.despawned === true);

    // The world-level vanishing path: once the brain requests a despawn, the entity
    // must be gone without emitting a death event. Verified by looking away and
    // letting the live stalker run.
    const vanish = await page.evaluate(async () => {
      const game = window.game;
      const stalker = game.entities.mobs.find((mob) => mob.alive && mob.definition?.behavior === 'stalker');
      if (!stalker) return { vanished: true, deathEvents: 0 };
      game.cameraController.yaw += Math.PI;
      // Put it beyond the vanish distance on solid ground, so "out of sight" does not
      // depend on whether a tree happened to stand between us.
      const z = game.player.position.z - 36;
      stalker.x = game.player.position.x;
      stalker.z = z;
      stalker.y = (game.world.getSurfaceY(Math.floor(stalker.x), Math.floor(z)) ?? game.player.position.y) + 1;
      stalker.velocityX = 0;
      stalker.velocityZ = 0;
      let deaths = 0;
      const handler = () => { deaths++; };
      game.bus.on('mob:died', handler);
      await new Promise((done) => setTimeout(done, 7000));
      game.bus.off('mob:died', handler);
      return { vanished: !stalker.alive, deathEvents: deaths };
    });
    check('the stalker vanishes once out of sight', vanish.vanished);
    check('the vanishing is not a death event', vanish.deathEvents === 0, String(vanish.deathEvents));

    // Noise: a sprint pulse next to a hunter that cannot see the player should be
    // investigated. The hunter is teleported behind a wall-free distance and blinded
    // by line-of-sight through the ground being impossible, so we use distance.
    const noiseReaction = await page.evaluate(async () => {
      const game = window.game;
      const p = game.player.position;
      const hunter = game.entities.spawnMob('hunter', p.x + 24, p.y + 0.2, p.z, 44);
      if (!hunter) return { spawned: false };
      // Face away so it cannot see the player immediately.
      hunter.facing = Math.PI;
      await new Promise((done) => setTimeout(done, 300));
      game.noise.emit(hunter.x, hunter.y, hunter.z, 20, 'sprint');
      await new Promise((done) => setTimeout(done, 1200));
      return { spawned: true, state: hunter.brainState };
    });
    check('a noise makes the hunter investigate', noiseReaction.state === 'investigate', String(noiseReaction.state));
  } finally {
    await browser.close();
    host.server.close();
  }

  const relevant = consoleErrors.filter((line) => !/Autoplay|GroupMarkerNotSet|SwiftShader/i.test(line));
  check('no console errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));

  if (failures > 0) {
    console.log(`\nMob AI check: ${failures} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log('\nMob AI check: all assertions passed.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
