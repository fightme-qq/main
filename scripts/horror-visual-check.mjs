/**
 * Visual verification for the horror pass.
 *
 * Builds the instrumentation bundle (`window.game`), starts a fixed-seed world,
 * lines up one of every visually distinct creature in front of the camera and
 * captures day, dusk and night frames. Then it does the same for atmosphere:
 * a forest night shot and a low-lying fog shot.
 *
 * This exists because "the shader compiled" is not the same claim as "the cow
 * has a face". The screenshots land in `dist-smoketest/visual/` and are meant to
 * be looked at, not just produced.
 *
 * Usage: node scripts/horror-visual-check.mjs [--skip-build]
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import bundledChromium from '@sparticuz/chromium';

import { MOB_SKIN_STYLES, mobSkinTileName } from '../src/config/MobSkins.js';
import { ATLAS_COLUMNS, TILE_PADDING, TILE_STRIDE } from '../src/world/AtlasLayout.js';
import { TILE_INDEX } from '../src/world/BlockTypes.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'dist-smoketest', 'visual');
const APP = join(ROOT, 'dist-smoketest', 'app');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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

/** Creatures worth looking at first: one per distinct silhouette and skin face. */
const LINEUP_IDS = [
  'cow', 'pig', 'sheep', 'chicken', 'villager', 'iron_golem',
  'zombie', 'skeleton', 'creeper', 'spider', 'slime',
  'husk', 'bonecaster', 'lurker', 'enderman', 'blaze',
  // Horror roster: the three roles must be readable next to everything else.
  'walker', 'hunter', 'stalker',
];

/** Skin facts the pixel analysis needs, extracted from the real catalogue. */
const LINEUP = LINEUP_IDS.map((id) => {
  const style = MOB_SKIN_STYLES[id];
  return { id, eye: style?.eye ?? [255, 0, 255], glow: style?.eyeGlow === true };
});

/**
 * Projects a world point to viewport coordinates using the live camera.
 *
 * Done by hand rather than with `THREE.Vector3.project` because the bundle does
 * not expose THREE on `window`, and the projection is six multiplies.
 */
const PROJECT_SOURCE = `
  function projectPoint(cam, x, y, z) {
    const vm = cam.matrixWorldInverse.elements;
    const pm = cam.projectionMatrix.elements;
    const vx = vm[0] * x + vm[4] * y + vm[8] * z + vm[12];
    const vy = vm[1] * x + vm[5] * y + vm[9] * z + vm[13];
    const vz = vm[2] * x + vm[6] * y + vm[10] * z + vm[14];
    const vw = vm[3] * x + vm[7] * y + vm[11] * z + vm[15];
    const cx = pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12] * vw;
    const cy = pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13] * vw;
    const cw = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15] * vw;
    if (Math.abs(cw) < 1e-6) return null;
    return { x: cx / cw * 0.5 + 0.5, y: 0.5 - cy / cw * 0.5, w: cw };
  }
`;

/**
 * Screenshots the page, decodes it inside the browser and reports per-creature
 * pixel statistics.
 *
 * The image never reaches Node as pixels: the browser already has a PNG decoder,
 * and shipping a decoder for a verification script is not worth it. What comes
 * back is a small summary per creature — colour variety in the head window and
 * whether any pixel matches that creature's eye colour.
 *
 * @param {import('playwright').Page} page
 * @param {string} path Where to keep the screenshot.
 * @param {Array<{id: string, x: number, y: number, z: number, headY: number, eye: number[], glow: boolean}>} mobs
 */
async function analyseFrame(page, path, mobs) {
  // Pin the lineup to its spawn points before capturing: hostile mobs wander, and a
  // screenshot taken two seconds later would show half of them out of frame.
  await page.evaluate(() => {
    for (const mob of window.game.entities.mobs) {
      if (!mob.alive || !mob.visualTag) continue;
      mob.x = mob.visualX;
      mob.y = mob.visualY;
      mob.z = mob.visualZ;
      mob.velocityX = 0;
      mob.velocityZ = 0;
      mob.facing = mob.visualFacing;
    }
  });
  await page.waitForTimeout(160);

  // Creatures wander between spawn and screenshot, so their live positions are
  // read immediately before the frame is captured. Projecting stale spawn points
  // would sample empty ground and report a flat "skin" that is really a hill.
  const live = await page.evaluate(() =>
    window.game.entities.mobs
      .filter((mob) => mob.alive && mob.visualTag)
      .map((mob) => ({
        id: mob.visualTag,
        x: mob.x,
        y: mob.y,
        z: mob.z,
        height: mob.height ?? 1.4,
        headY: mob.y + (mob.height ?? 1.4) * 0.9,
      }))
  );
  const byId = new Map(live.map((mob) => [mob.id, mob]));
  const pinned = mobs.map((mob) => ({ ...mob, ...(byId.get(mob.id) ?? {}) }));

  const shot = await page.screenshot({ path });
  const data = shot.toString('base64');
  const result = await page.evaluate(
    async ({ imageData, mobEntries, source }) => {
      const image = new Image();
      await new Promise((done, fail) => {
        image.onload = done;
        image.onerror = fail;
        image.src = `data:image/png;base64,${imageData}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const frame = context.getImageData(0, 0, image.width, image.height);
      const pixels = frame.data;

      // eslint-disable-next-line no-new-func
      const projectPoint = new Function(`${source}; return projectPoint;`)();
      const camera = window.game.camera;

      /**
       * Summarises a square window of the frame.
       * @param {number} cx
       * @param {number} cy
       * @param {number} radius
       * @param {number[]|null} eyeColour When set, counts pixels near this colour.
       */
      const sample = (cx, cy, radius, eyeColour) => {
        const colours = new Set();
        let luma = 0;
        let count = 0;
        let bright = 0;
        let eyeHits = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const x = Math.round(cx + dx);
            const y = Math.round(cy + dy);
            if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
            const index = (y * image.width + x) * 4;
            const r = pixels[index];
            const g = pixels[index + 1];
            const b = pixels[index + 2];
            colours.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
            luma += r * 0.299 + g * 0.587 + b * 0.114;
            count++;
            if (Math.max(r, g, b) > 90) bright++;
            if (eyeColour && Math.hypot(r - eyeColour[0], g - eyeColour[1], b - eyeColour[2]) < 56) {
              eyeHits++;
            }
          }
        }
        return {
          colours: colours.size,
          luma: count > 0 ? luma / count : 0,
          brightShare: count > 0 ? bright / count : 0,
          eyeHits,
        };
      };

      const mobs = [];
      for (const entry of mobEntries) {
        // A tall creature's head can sit outside a small window if the rig and the
        // collision height disagree, so the whole body column is probed and the
        // most detailed window wins. The metric is "is a textured creature here",
        // not "did one exact projection land on a nose".
        const height = entry.height ?? 1.4;
        const candidates = [entry.headY, entry.y + height * 0.62, entry.y + 0.45];
        const radius = Math.max(10, Math.round(image.height * 0.032));
        let best = null;
        for (const worldY of candidates) {
          const point = projectPoint(camera, entry.x, worldY, entry.z);
          if (!point || point.w <= 0.1) continue;
          const cx = point.x * image.width;
          const cy = point.y * image.height;
          if (cx < 0 || cx >= image.width || cy < 0 || cy >= image.height) continue;
          const stats = sample(cx, cy, radius, entry.glow ? entry.eye : null);
          if (!best || stats.colours > best.colours) best = { ...stats, cx, cy, w: point.w };
        }
        if (!best) {
          mobs.push({ id: entry.id, visible: false });
          continue;
        }
        mobs.push({
          id: entry.id,
          visible: true,
          colours: best.colours,
          luma: Math.round(best.luma),
          brightShare: Math.round(best.brightShare * 100) / 100,
          eyeHits: entry.glow ? best.eyeHits : null,
        });
      }

      let total = 0;
      let counted = 0;
      for (let i = 0; i < pixels.length; i += 4 * 37) {
        total += pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
        counted++;
      }
      return {
        mobs,
        frame: { width: image.width, height: image.height, meanLuma: Math.round(total / counted) },
      };
    },
    { imageData: data, source: PROJECT_SOURCE, mobEntries: pinned }
  );
  return result;
}

/**
 * Checks the painted atlas itself: every face tile must contain the exact eye
 * colour its palette promises (or dark sockets for a skull).
 *
 * This is the deterministic half of "does the creature have a face": geometry and
 * UVs are covered by `horror-selftest.mjs`, and this proves the pixels those UVs
 * point at really are a face. Read from the live atlas canvas, so a painter that
 * silently stopped running fails here.
 *
 * @param {import('playwright').Page} page
 * @param {Array<{id: string, headTile: number, expected: number[]}>} entries
 */
async function verifyAtlasFaces(page, entries) {
  return page.evaluate(
    ({ tileEntries, columns, stride, padding }) => {
      const canvas = window.game.atlas.canvas;
      const context = canvas.getContext('2d');
      const results = [];
      for (const entry of tileEntries) {
        const column = entry.headTile % columns;
        const row = Math.floor(entry.headTile / columns);
        const x0 = column * stride + padding;
        const y0 = row * stride + padding;
        const data = context.getImageData(x0, y0, 16, 16).data;
        let hits = 0;
        let unique = new Set();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          unique.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
          if (Math.hypot(r - entry.expected[0], g - entry.expected[1], b - entry.expected[2]) <= 12) {
            hits++;
          }
        }
        results.push({ id: entry.id, hits, colours: unique.size });
      }
      return results;
    },
    {
      tileEntries: entries,
      columns: ATLAS_COLUMNS,
      stride: TILE_STRIDE,
      padding: TILE_PADDING,
    }
  );
}

/**
 * Finds a Playwright-downloaded Chromium when the package version and the
 * downloaded revision disagree (which happens after a lockfile bump without a
 * browser reinstall).
 *
 * @returns {string|null}
 */
function findPlaywrightChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'ms-playwright');
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

async function main() {
  mkdirSync(OUT, { recursive: true });

  if (!process.argv.includes('--skip-build')) {
    console.log('Building instrumented bundle (NODE_ENV=development)...');
    // Run vite through Node rather than the `.cmd` shim: Node 22+ refuses to
    // spawn a batch file without a shell, and adding a shell would reintroduce
    // quoting problems for the output directory.
    execFileSync(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-smoketest/app', '--logLevel', 'warn'],
      { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'inherit' }
    );
  }
  if (!existsSync(join(APP, 'index.html'))) {
    throw new Error('instrumented bundle missing — run without --skip-build');
  }

  const host = await startServer(APP);
  // Prefer an explicitly provided browser, then the Lambda build if it actually
  // extracted somewhere (it is Linux-only), then Playwright's own download.
  let executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (!executablePath && process.platform !== 'win32') {
    try {
      const bundled = await bundledChromium.executablePath();
      if (bundled && existsSync(bundled) && statSync(bundled).isFile()) executablePath = bundled;
    } catch {
      // Not available on this platform; Playwright's browser is used instead.
    }
  }
  if (!executablePath && process.platform === 'win32') executablePath = findPlaywrightChromium();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: process.env.SMOKETEST_HEADED !== '1',
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
    ],
  });

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 720 });
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  try {
    await page.goto(`http://127.0.0.1:${host.port}/index.html`, {
      waitUntil: 'load',
      timeout: 90000,
    });
    await page.waitForFunction(() => !document.querySelector('#boot-screen'), null, {
      timeout: 120000,
    });
    await page.waitForFunction(() => typeof window.game !== 'undefined', null, {
      timeout: 60000,
    });

    console.log('Creating world...');
    await page.locator('button', { hasText: 'World options' }).first().click();
    await page.waitForTimeout(400);
    // Creative for the lineup: hostile mobs otherwise walk out of the frame and
    // attack the camera between the day and night captures.
    await page.evaluate(() => {
      const select = document.querySelector('select[aria-label="Game mode and difficulty"]');
      if (!select) return;
      select.value = 'creative';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const inputs = page.locator('input.text-input');
    await inputs.nth(0).fill('Horror Visual');
    await inputs.nth(1).fill('777001');
    await page.locator('button', { hasText: 'Create and play' }).first().click();
    await page.waitForFunction(() => window.game?.ui?.screen === 'playing', null, {
      timeout: 220000,
    });
    await page.waitForFunction(() => (window.game?.world?.stats?.loaded ?? 0) > 8, null, {
      timeout: 150000,
    });

    // Software GL cannot afford the default render distance.
    await page.evaluate(() => {
      window.game.settings.setMany({
        'graphics.renderDistance': 4,
        'graphics.shadows': false,
        'gameplay.pauseDayCycle': true,
      });
    });
    await page.waitForTimeout(2500);

    // Capture the actual opening scene before any test changes the time: this is
    // what the player sees when a world loads.
    const opening = await page.evaluate(() => ({
      timeOfDay: window.game.lighting.timeOfDay,
      daylight: window.game.lighting.daylight,
    }));
    console.log('Opening scene:', JSON.stringify(opening));
    await page.screenshot({ path: join(OUT, 'world-start.png') });

    const lineup = await page.evaluate(async (entries) => {
      const game = window.game;
      const player = game.player;
      const camera = game.cameraController;

      // Stand the player on solid ground at the spawn, looking north (-Z).
      camera.yaw = 0;
      camera.pitch = -0.02;

      const px = player.position.x;
      const pz = player.position.z;
      const py = player.position.y;

      const mobs = [];
      // Two rows: sixteen creatures at one distance would not fit the frustum, and
      // a row that leaves the frame proves nothing about the ones that left it.
      const perRow = 8;
      const spacing = 1.35;
      entries.forEach((entry, index) => {
        const row = Math.floor(index / perRow);
        const column = index % perRow;
        const count = Math.min(perRow, entries.length - row * perRow);
        const x = px + (column - (count - 1) / 2) * spacing + row * 0.6;
        const z = pz - 4.2 - row * 2.6;
        const mob = game.entities.spawnMob(entry.id, x, py + 0.2, z, index);
        if (!mob) return;
        // Face the camera so every face is front-on in the screenshot.
        mob.facing = Math.atan2(px - x, pz - z);
        mob.visualTag = entry.id;
        mob.velocityX = 0;
        mob.velocityZ = 0;
        mobs.push({
          id: entry.id,
          eye: entry.eye,
          glow: entry.glow,
          x: mob.x,
          y: mob.y,
          z: mob.z,
          headY: mob.y + (mob.height ?? 1.4) * 0.9,
          // Kept so the frame can be re-pinned before every capture.
          visualX: mob.x,
          visualY: mob.y,
          visualZ: mob.z,
          visualFacing: mob.facing,
        });
        mob.visualTag = entry.id;
        mob.visualX = mob.x;
        mob.visualY = mob.y;
        mob.visualZ = mob.z;
        mob.visualFacing = mob.facing;
      });

      game.lighting.setTimeOfDay(0.4);
      await new Promise((done) => setTimeout(done, 300));
      return { mobs };
    }, LINEUP);

    const mobs = lineup.mobs;
    console.log(`Spawned ${mobs.length}: ${mobs.map((mob) => mob.id).join(', ')}`);
    await page.waitForTimeout(2500);

    const day = await analyseFrame(page, join(OUT, 'mob-lineup-day.png'), mobs);
    console.log('\nDay frame (per creature: distinct colours in the head window, eye hits):');
    for (const mob of day.mobs) {
      console.log(
        `  ${mob.id.padEnd(12)} visible=${mob.visible} colours=${mob.colours ?? '-'} ` +
          `luma=${mob.luma ?? '-'} eyeHits=${mob.eyeHits ?? '-'}`
      );
    }

    // --- night, same lineup ---
    await page.evaluate(() => {
      const game = window.game;
      game.lighting.setTimeOfDay(0.0);
      // Software GL runs at a few frames per second and the loop clamps dt, so
      // wall-clock waiting would leave the fog easing mid-transition. Stepping the
      // lighting system directly puts six simulated seconds behind the switch.
      for (let step = 0; step < 120; step++) game.lighting.update(0.05, game.camera.position);
    });
    await page.waitForTimeout(900);
    const night = await analyseFrame(page, join(OUT, 'mob-lineup-night.png'), mobs);
    console.log(
      `\nFrame luminance: day ${day.frame.meanLuma}, night ${night.frame.meanLuma}`
    );

    // --- scenic night shot for fog and silhouettes ---
    await page.evaluate(() => {
      const game = window.game;
      const player = game.player;
      game.cameraController.pitch = 0.05;
      player.teleport(player.position.x, player.position.y + 6, player.position.z);
    });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: join(OUT, 'night-fog.png') });

    // --- low ground fog: dive to a low area and look along it ---
    const fogReport = await page.evaluate(() => {
      const game = window.game;
      const lighting = game.lighting;
      const state = lighting.lightingState;
      return {
        timeOfDay: lighting.timeOfDay,
        daylight: lighting.daylight,
        fogNear: state.fogNear,
        fogFar: state.fogFar,
        fogColor: [state.fogColor.r, state.fogColor.g, state.fogColor.b],
        visibility: lighting.getAtmosphereStats().visibility,
        biome: game.world.getBiomeNameAt(game.player.position.x, game.player.position.z),
      };
    });
    console.log('Atmosphere state:', JSON.stringify(fogReport));

    // --- dusk ---
    await page.evaluate(() => window.game.lighting.setTimeOfDay(0.62));
    await page.waitForTimeout(1400);
    await page.screenshot({ path: join(OUT, 'dusk-fog.png') });

    const runtime = await page.evaluate(() => {
      const game = window.game;
      return {
        shaderFallback: game.materials?.usingFallback ?? null,
        liveMobs: game.entities.mobs.filter((mob) => mob.alive).length,
        loadedChunks: game.world.stats.loaded,
      };
    });
    console.log('Runtime:', JSON.stringify(runtime));

    // ------------------------------------------------------------ assertions
    const failures = [];

    // Faces: the painted atlas must contain the promised eye colour for every
    // creature whose face type has eyes, and dark sockets for a skull.
    const atlasEntries = LINEUP_IDS.map((id) => {
      const style = MOB_SKIN_STYLES[id];
      const eyeScale = style.eyeGlow ? 1.25 : 1;
      const expected = style.face === 'skull'
        ? [14, 12, 16]
        : style.eye.map((channel) => Math.min(255, Math.round(channel * eyeScale)));
      return {
        id,
        headTile: TILE_INDEX[mobSkinTileName(id, 'head')],
        expected,
      };
    });
    const faces = await verifyAtlasFaces(page, atlasEntries);
    console.log('\nPainted faces (eye-coloured pixels in the head tile):');
    for (const face of faces) console.log(`  ${face.id.padEnd(12)} eyePixels=${face.hits} colours=${face.colours}`);
    for (const face of faces) {
      if (face.hits < 2) failures.push(`${face.id}: head tile has no face (${face.hits} eye pixels)`);
      if (face.colours < 8) failures.push(`${face.id}: head tile is nearly flat (${face.colours} colours)`);
    }

    const visible = day.mobs.filter((mob) => mob.visible);
    if (visible.length < mobs.length) {
      failures.push(`${mobs.length - visible.length} creatures fell outside the frame`);
    }
    const flat = visible.filter((mob) => (mob.colours ?? 0) < 6);
    if (flat.length > 0) {
      failures.push(`flat-looking skins on screen: ${flat.map((mob) => mob.id).join(', ')}`);
    }
    if (night.frame.meanLuma > day.frame.meanLuma * 0.75) {
      failures.push(
        `night is not darker than day (day ${day.frame.meanLuma}, night ${night.frame.meanLuma})`
      );
    }
    if (night.frame.meanLuma < 2) {
      failures.push(`night frame is effectively black (luma ${night.frame.meanLuma})`);
    }
    if (fogReport.fogFar >= 100) {
      failures.push(`night fog far plane is still open (${fogReport.fogFar.toFixed(1)} blocks)`);
    }
    if (fogReport.visibility > 0.65) {
      failures.push(
        `night visibility did not settle (${fogReport.visibility.toFixed(2)} of the render distance)`
      );
    }
    if (runtime.shaderFallback !== false) {
      failures.push('voxel shader fell back to the stock material');
    }

    if (failures.length > 0) {
      console.log('\nVisual check failures:');
      for (const failure of failures) console.log(`  - ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('\nVisual check: all image assertions passed.');
    }
  } finally {
    await browser.close();
    host.server.close();
  }

  const relevant = problems.filter(
    (line) => !/GroupMarkerNotSet|SwiftShader|deprecated|Automatic fallback/i.test(line)
  );
  if (relevant.length > 0) {
    console.log('\nConsole errors:');
    for (const line of relevant.slice(0, 20)) console.log('  ' + line);
  } else {
    console.log('\nNo console errors.');
  }
  console.log(`Screenshots: ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
