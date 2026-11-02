/**
 * Browser verification for the standing colossus.
 *
 * The Node self-test proves the rig, the clips and the presence clock in
 * isolation. This proves the parts that only exist in a live world: that the
 * atlas painter is registered, that the creature is actually placed on the
 * terrain in front of the player, that it settles through the foot probe, that
 * the head tracks the player, that the roar reaches the mixer, and -- the one
 * thing a headless test normally cannot show -- that the model really is drawn,
 * at the size and on the screen position the numbers claim.
 *
 * The render check is a differential screenshot: the colossus mesh is hidden,
 * a frame is captured, the mesh is shown again, and a second frame is captured.
 * Everything else in the scene is identical between the two (clouds are switched
 * off, the day cycle is paused), so the differing pixels are the creature.
 *
 * Usage: `node scripts/colossus-check.mjs` (add `--skip-build` to reuse the last
 * instrumented bundle).
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
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

/**
 * Minimal PNG reader for the 8-bit RGBA screenshots Chromium produces.
 * Node ships the inflate; the only work left is undoing the per-scanline filters.
 */
function decodePng(buffer) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels || bitDepth !== 8) throw new Error(`unsupported PNG: colour type ${colorType}, depth ${bitDepth}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const current = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      current[x] = value & 255;
    }
    current.copy(out, y * stride);
    previous = current;
  }
  return { width, height, channels, data: out };
}

/** Average colour of a square patch. */
function samplePatch(image, cx, cy, radius = 6) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = Math.max(0, Math.round(cy) - radius); y < Math.min(image.height, Math.round(cy) + radius); y++) {
    for (let x = Math.max(0, Math.round(cx) - radius); x < Math.min(image.width, Math.round(cx) + radius); x++) {
      const index = (y * image.width + x) * image.channels;
      r += image.data[index];
      g += image.data[index + 1];
      b += image.data[index + 2];
      count++;
    }
  }
  return count ? { r: r / count, g: g / count, b: b / count } : { r: 0, g: 0, b: 0 };
}

/**
 * Compares two frames and reports where they differ.
 *
 * The grid step keeps scattered noise (HUD timers, a bird, a waterfall) from
 * stretching the bounding box; only cells with a real amount of change count.
 */
function diffFrames(before, after, threshold = 26) {
  const { width, height, channels } = before;
  const gridColumns = 32;
  const gridRows = 18;
  const cells = new Float64Array(gridColumns * gridRows);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    const rowCell = Math.min(gridRows - 1, Math.floor((y / height) * gridRows));
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * channels;
      const delta = Math.abs(before.data[index] - after.data[index]) +
        Math.abs(before.data[index + 1] - after.data[index + 1]) +
        Math.abs(before.data[index + 2] - after.data[index + 2]);
      if (delta < threshold) continue;
      changed++;
      const columnCell = Math.min(gridColumns - 1, Math.floor((x / width) * gridColumns));
      cells[rowCell * gridColumns + columnCell]++;
    }
  }

  const cellWidth = width / gridColumns;
  const cellHeight = height / gridRows;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let activeCells = 0;
  for (let row = 0; row < gridRows; row++) {
    for (let column = 0; column < gridColumns; column++) {
      if (cells[row * gridColumns + column] <= 4) continue;
      activeCells++;
      minX = Math.min(minX, column * cellWidth);
      maxX = Math.max(maxX, (column + 1) * cellWidth);
      minY = Math.min(minY, row * cellHeight);
      maxY = Math.max(maxY, (row + 1) * cellHeight);
    }
  }
  return {
    changed,
    activeCells,
    box: activeCells ? { minX, minY, maxX, maxY } : null,
  };
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

async function main() {
  if (!process.argv.includes('--skip-build')) {
    console.log('Building instrumented bundle...');
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
  await page.setViewportSize({ width: 1280, height: 720 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  try {
    console.log('Creating a world...');
    await page.goto(`http://127.0.0.1:${host.port}/index.html`, { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('#boot-screen'), null, { timeout: 120000 });
    await page.waitForFunction(() => typeof window.game !== 'undefined', null, { timeout: 60000 });
    await page.locator('button', { hasText: 'World options' }).first().click();
    await page.waitForTimeout(400);
    const inputs = page.locator('input.text-input');
    await inputs.nth(0).fill('Colossus Check');
    await inputs.nth(1).fill('8675309');
    await page.locator('button', { hasText: 'Create and play' }).first().click();
    await page.waitForFunction(() => window.game?.ui?.screen === 'playing', null, { timeout: 220000 });

    await page.evaluate(() => {
      const game = window.game;
      window.__played = [];
      const play = game.audio.play.bind(game.audio);
      game.audio.play = (name, options) => {
        window.__played.push(name);
        return play(name, options);
      };
      // Noon, clouds off, day cycle paused and a generous draw distance: the
      // screenshot has to show the head against the sky, and the differential
      // capture has to have nothing moving in it except the creature.
      game.lighting.setTimeOfDay(0.38);
      game.settings.setMany({
        'gameplay.pauseDayCycle': true,
        'graphics.renderDistance': 12,
        'graphics.clouds': false,
      });
      window.__keepAlive = setInterval(() => {
        if (game.player?.stats) game.player.stats.health = game.player.stats.maxHealth;
      }, 250);
    });

    console.log('Waiting for the colossus to be placed...');
    await page.waitForFunction(() => window.game?._colossusSettled === true, null, { timeout: 180000 });
    await page.waitForTimeout(1500);

    const placement = await page.evaluate(() => {
      const game = window.game;
      const mob = game.entities.mobs.find((entry) => entry.alive && entry.mobId === 'colossus');
      if (!mob) return null;
      const surface = game.world.getSurfaceY(Math.floor(mob.x), Math.floor(mob.z));
      return {
        x: mob.x, y: mob.y, z: mob.z,
        surface,
        height: mob.height,
        halfSize: mob.halfSize,
        health: mob.health,
        maxHealth: mob.maxHealth,
        giant: mob.definition.giant,
        onGround: mob.onGround,
        persistent: mob.persistent,
        hasPresence: Boolean(mob.presence),
        facing: mob.facing,
        distanceToPlayer: Math.hypot(mob.x - game.player.position.x, mob.z - game.player.position.z),
      };
    });
    console.log('Placement:', JSON.stringify(placement));
    check('a colossus exists in the world', placement !== null);
    check('it is a giant', placement?.giant === true);
    check('its collision height is 62 blocks', placement?.height === 62, String(placement?.height));
    check('it stands on the surface', Math.abs(placement.y - (placement.surface + 1)) <= 1.5,
      `y=${placement.y} surface=${placement.surface}`);
    check('its footing resolved', placement?.onGround === true);
    check('it is persistent', placement?.persistent === true);
    check('it owns a presence brain', placement?.hasPresence === true);
    check('it was placed within sight of spawn', placement.distanceToPlayer > 35 && placement.distanceToPlayer < 140,
      String(Math.round(placement.distanceToPlayer)));

    console.log('Waiting for the first roar...');
    const roared = await page.waitForFunction(
      () => window.__played.some((name) => name === 'mob.colossus.roar'),
      null,
      { timeout: 20000 }
    ).then(() => true).catch(() => false);
    check('the roar reaches the mixer', roared);

    // Stand off to one side of the creature rather than dead in front: dead in
    // front means the head is already on target and the gaze test proves nothing.
    const vantage = await page.evaluate(() => {
      const game = window.game;
      const mob = game.entities.mobs.find((entry) => entry.alive && entry.mobId === 'colossus');
      const distance = 46;
      const side = 0.42;
      const angle = mob.facing + side;
      const x = mob.x + Math.sin(angle) * distance;
      const z = mob.z + Math.cos(angle) * distance;
      const y = game.world.getSurfaceY(Math.floor(x), Math.floor(z)) + 1;
      game.player.teleport(x, y, z);
      window.__headBefore = mob.headYaw;
      return { x, y, z, mobX: mob.x, mobY: mob.y, mobZ: mob.z };
    });
    console.log('Vantage point:', JSON.stringify(vantage));
    await page.waitForTimeout(4000);

    await page.evaluate(() => {
      const game = window.game;
      const mob = game.entities.mobs.find((entry) => entry.alive && entry.mobId === 'colossus');
      const eye = game.player.getEyePosition();
      const dx = mob.x - eye.x;
      const dz = mob.z - eye.z;
      const dy = mob.y + 40 - eye.y;
      game.cameraController.setRotation(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    });
    await page.waitForTimeout(5000);

    const gaze = await page.evaluate(() => {
      const mob = window.game.entities.mobs.find((entry) => entry.alive && entry.mobId === 'colossus');
      return { before: window.__headBefore, after: mob.headYaw, emote: mob.emote };
    });
    console.log('Gaze:', JSON.stringify(gaze));
    check('the head turned toward the player', Math.abs(gaze.after - gaze.before) > 0.05,
      `${gaze.before} -> ${gaze.after}`);

    // Where the model should be on screen, according to the camera.
    const projection = await page.evaluate(() => {
      const game = window.game;
      const mob = game.entities.mobs.find((entry) => entry.alive && entry.mobId === 'colossus');
      const Vector = game.camera.position.constructor;
      const project = (y) => {
        const point = new Vector(mob.x, y, mob.z);
        point.project(game.camera);
        return {
          ndcX: point.x, ndcY: point.y, ndcZ: point.z,
          screenX: (point.x * 0.5 + 0.5) * window.innerWidth,
          screenY: (-point.y * 0.5 + 0.5) * window.innerHeight,
        };
      };
      return {
        head: project(mob.y + 59),
        chest: project(mob.y + 38),
        feet: project(mob.y + 1),
      };
    });
    console.log('Projection:', JSON.stringify(projection));
    check('the head projects onto the screen', Math.abs(projection.head.ndcX) < 1 && projection.head.ndcY > -1 &&
      projection.head.ndcY < 1 && projection.head.ndcZ < 1);
    check('the head is above the chest on screen', projection.head.screenY < projection.chest.screenY);
    check('the creature is close to filling the frame vertically',
      projection.feet.screenY - projection.head.screenY > 300,
      String(Math.round(projection.feet.screenY - projection.head.screenY)));

    const visible = await page.screenshot({ path: join(OUT, 'colossus-approach.png') });
    const framed = decodePng(visible);
    const chestColour = samplePatch(framed, projection.chest.screenX, projection.chest.screenY, 8);
    const skyColour = samplePatch(framed, projection.head.screenX, Math.max(4, projection.head.screenY - 90), 8);
    console.log('Chest colour:', JSON.stringify(chestColour), 'sky:', JSON.stringify(skyColour));
    const colourGap = Math.abs(chestColour.r - skyColour.r) + Math.abs(chestColour.g - skyColour.g) +
      Math.abs(chestColour.b - skyColour.b);
    check('the chest pixels are not sky', colourGap > 40, `gap=${Math.round(colourGap)}`);

    // Differential capture: hide the creature's mesh, grab a frame, show it
    // again, grab another. `sync` is stubbed out for the duration so it cannot
    // restore the mesh between the two frames.
    await page.evaluate(() => {
      const game = window.game;
      const renderer = game.entities.mobRenderer;
      window.__sync = renderer.sync;
      renderer.sync = () => {};
      const entry = renderer._entries.get('colossus');
      window.__colossusMesh = entry.mesh;
      entry.mesh.visible = false;
    });
    await page.waitForTimeout(250);
    const hiddenFrame = decodePng(await page.screenshot());
    await page.evaluate(() => {
      const game = window.game;
      const renderer = game.entities.mobRenderer;
      window.__colossusMesh.visible = true;
      renderer.sync = window.__sync;
    });
    await page.waitForTimeout(250);
    const shownFrame = decodePng(await page.screenshot());

    const silhouette = diffFrames(hiddenFrame, shownFrame);
    console.log('Silhouette diff:', JSON.stringify(silhouette));
    check('the creature is actually drawn', silhouette.changed > 15000, `pixels=${silhouette.changed}`);
    check('the silhouette spans a tall region',
      silhouette.box && silhouette.box.maxY - silhouette.box.minY > 200,
      silhouette.box ? String(Math.round(silhouette.box.maxY - silhouette.box.minY)) : 'none');
    check('the silhouette is centred where the projection says',
      silhouette.box && silhouette.box.minX < projection.chest.screenX && silhouette.box.maxX > projection.chest.screenX,
      silhouette.box ? `${Math.round(silhouette.box.minX)}..${Math.round(silhouette.box.maxX)} vs ${Math.round(projection.chest.screenX)}` : 'none');

    // Close-up: the head, from inside its own shadow.
    await page.evaluate(() => {
      const game = window.game;
      const mob = game.entities.mobs.find((entry) => entry.alive && entry.mobId === 'colossus');
      const distance = 24;
      const x = mob.x + Math.sin(mob.facing + 0.3) * distance;
      const z = mob.z + Math.cos(mob.facing + 0.3) * distance;
      const y = game.world.getSurfaceY(Math.floor(x), Math.floor(z)) + 1;
      game.player.teleport(x, y, z);
    });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const game = window.game;
      const mob = game.entities.mobs.find((entry) => entry.alive && entry.mobId === 'colossus');
      const eye = game.player.getEyePosition();
      const dx = mob.x - eye.x;
      const dz = mob.z - eye.z;
      const dy = mob.y + 50 - eye.y;
      game.cameraController.setRotation(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: join(OUT, 'colossus-close.png') });

    const report = await page.evaluate(() => {
      const game = window.game;
      const mob = game.entities.mobs.find((entry) => entry.alive && entry.mobId === 'colossus');
      return {
        headYaw: mob.headYaw,
        emote: mob.emote,
        played: [...new Set(window.__played.filter((name) => name.startsWith('mob.colossus')))],
        fogFar: game.lighting.lightingState?.fogFar ?? null,
        loadedChunks: game.world.stats?.loaded ?? 0,
      };
    });
    console.log('Report:', JSON.stringify(report));
    check('more than one colossus voice has been heard', report.played.length >= 2, report.played.join(','));

    const relevantErrors = consoleErrors.filter((text) =>
      !/Failed to load resource|net::ERR|AudioContext|favicon/i.test(text));
    check('no console errors', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));
  } finally {
    await page.evaluate(() => clearInterval(window.__keepAlive)).catch(() => {});
    await browser.close();
    host.server.close();
  }

  console.log(failures === 0 ? '\nAll colossus checks passed.' : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
