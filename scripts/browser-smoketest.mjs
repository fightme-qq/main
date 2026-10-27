/**
 * Headless browser smoke test.
 *
 * The Node self-test covers the worker-safe half of the engine, but the things
 * that actually break in front of a player live on the GPU: shader compilation,
 * texture atlas sampling, material state. This script boots the real Vite bundle
 * in headless Chromium, drives it into a world, and then *reads pixels back* to
 * assert what the player actually sees.
 *
 * Its first job is the water surface. Water used to render magenta because the
 * animated UV offset was unbounded and eventually sampled unpainted atlas cells
 * (see `src/rendering/WaterUv.js`). A numeric invariant test cannot prove the fix
 * reached the screen; sampling the framebuffer can. The water checks therefore
 * run at several points in time, spanning the regimes where the original bug
 * drifted off-tile (~2 s), turned magenta (~16.6 s) and became permanently
 * magenta (~56 s).
 *
 * ## Two targets
 *
 * 1. `dist/` — the shipped production bundle. Verified to boot to the menu with
 *    no fatal error and no console noise. This is the artifact users get.
 * 2. `dist-smoketest/app/` — the same source built with `NODE_ENV=development`,
 *    which makes `main.js` expose `window.game`. The deep gameplay and pixel
 *    assertions need that handle; production deliberately does not expose it.
 *
 * Both are produced by the normal Vite pipeline, so target 2 is not a special
 * build of different code — only the dev flag differs.
 *
 * Usage:
 *   npm run build && npm run smoketest:browser
 *
 * Environment:
 *   SMOKETEST_HEADED=1        run with a visible browser (needs a display)
 *   SMOKETEST_SKIP_BUILD=1    reuse an existing instrumented build
 */

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import bundledChromium from '@sparticuz/chromium';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'dist-smoketest');
const INSTRUMENTED = join(OUT, 'app');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks++;
  if (condition) {
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n\x1b[1m${title}\x1b[0m\n`);
}

function info(text) {
  process.stdout.write(`    ${text}\n`);
}

// ------------------------------------------------------------------ static host

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

// ------------------------------------------------------------------ pixel maths

/** Converts one sRGB pixel to HSV so "is this blue?" is a cheap question. */
function toHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let hue = 0;
  if (delta > 1e-6) {
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max <= 0 ? 0 : delta / max, v: max };
}

/**
 * Magenta is the failure signature: a saturated hue near 300, i.e. red and blue
 * both high while green lags well behind.
 */
function isMagenta({ h, s, v }) {
  return s > 0.28 && v > 0.18 && h >= 265 && h <= 345;
}

/** Water should read blue or teal: cyan through blue. */
function isBlueOrTeal({ h, s }) {
  return s > 0.08 && h >= 165 && h <= 260;
}

function classify(pixels) {
  let magenta = 0;
  let blue = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (const [r, g, b] of pixels) {
    const hsv = toHsv(r, g, b);
    if (isMagenta(hsv)) magenta++;
    if (isBlueOrTeal(hsv)) blue++;
    sumR += r;
    sumG += g;
    sumB += b;
  }
  const n = pixels.length || 1;
  return {
    total: n,
    magenta,
    blue,
    magentaRatio: magenta / n,
    blueRatio: blue / n,
    mean: [Math.round(sumR / n), Math.round(sumG / n), Math.round(sumB / n)],
  };
}

// -------------------------------------------------------------- pixel sampling

/**
 * Reads the middle of the viewport as classified pixels.
 *
 * The screenshot has to come from Playwright rather than from `drawImage` on the
 * WebGL canvas: the renderer is created with `preserveDrawingBuffer: false`
 * (deliberately — it lets tiled GPUs discard the buffer), so copying the canvas
 * outside the render callback yields solid black. Playwright captures through
 * the compositor, which is exactly the image the player sees.
 *
 * The PNG is handed back into the page to be decoded, because the browser
 * already has a correct PNG decoder and Node does not.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{pixels: number[][], scroll: number|null}>}
 */
async function sampleCentre(page) {
  // SwiftShader on a CI runner can take far longer than Playwright's default 30 s
  // to flatten a 1280x720 WebGL frame; the resulting timeout was the only reason
  // the smoke test failed in Actions while passing locally.
  const shot = await page.screenshot({ type: 'png', timeout: 120000 });
  const base64 = shot.toString('base64');
  const pixels = await page.evaluate(async (data) => {
    const image = new Image();
    await new Promise((done, fail) => {
      image.onload = done;
      image.onerror = fail;
      image.src = `data:image/png;base64,${data}`;
    });
    const w = 160;
    const h = 120;
    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    const ctx = scratch.getContext('2d');
    // Crop the centre quarter, which is where the camera is aimed.
    ctx.drawImage(
      image,
      Math.floor(image.width / 2 - image.width / 8),
      Math.floor(image.height / 2 - image.height / 8),
      Math.floor(image.width / 4),
      Math.floor(image.height / 4),
      0,
      0,
      w,
      h
    );
    const { data: rgba } = ctx.getImageData(0, 0, w, h);
    const out = [];
    for (let i = 0; i < rgba.length; i += 4) out.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
    return out;
  }, base64);

  const scroll = await page.evaluate(
    () => window.game?.materials?.waterDiagnostics?.scroll ?? null
  );
  return { pixels, scroll };
}

// ------------------------------------------------------------------------- main

await mkdir(OUT, { recursive: true });

if (!existsSync(join(DIST, 'index.html'))) {
  process.stdout.write('\x1b[31mdist/index.html is missing — run `npm run build` first.\x1b[0m\n');
  process.exit(1);
}

if (process.env.SMOKETEST_SKIP_BUILD !== '1') {
  process.stdout.write('Building instrumented bundle (NODE_ENV=development)...\n');
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', 'build', '--outDir', 'dist-smoketest/app', '--logLevel', 'warn'],
    { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development' }, stdio: 'inherit' }
  );
}

const production = await startServer(DIST);
const instrumented = await startServer(INSTRUMENTED);

const bundledExecutable = process.env.PLAYWRIGHT_EXECUTABLE_PATH || await bundledChromium.executablePath();
const browser = await chromium.launch({
  executablePath: bundledExecutable,
  headless: process.env.SMOKETEST_HEADED !== '1',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // The sandbox has no GPU; without a software GL backend the canvas silently
    // fails to produce a WebGL context at all.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ],
});

/** Noise that is expected in a headless software-GL run. */
const IGNORABLE =
  /GroupMarkerNotSet|Automatic fallback to software|SwiftShader|deprecated|Slow read-back|THREE\.WebGLRenderer: A WebGL context could not/i;

function attachConsole(page) {
  const errors = [];
  const shader = [];
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && !IGNORABLE.test(text)) errors.push(text);
    if (/shader|glsl|program/i.test(text) && /error|fail/i.test(text)) shader.push(text);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return { errors, shader };
}

const report = {};

try {
  // ------------------------------------------------------- 1. production bundle

  section('Production bundle (dist/)');
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1024, height: 640 });
    const logs = attachConsole(page);

    await page.goto(`http://127.0.0.1:${production.port}/index.html`, {
      waitUntil: 'load',
      timeout: 60000,
    });

    const webgl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return { ok: false };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        ok: true,
        version: gl.getParameter(gl.VERSION),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
      };
    });
    check('a WebGL context is available', webgl.ok);
    if (webgl.ok) info(`${webgl.version}`);
    if (webgl.ok) info(`${webgl.renderer}`);
    report.webgl = webgl;

    await page.waitForFunction(() => !document.querySelector('#boot-screen'), null, {
      timeout: 90000,
    });
    check('boot screen is dismissed', true);
    check('no fatal error screen', (await page.$('.fatal-error')) === null);
    check(
      'main menu is rendered',
      (await page.locator('button', { hasText: 'Play' }).count()) > 0 &&
        (await page.locator('button', { hasText: 'World options' }).count()) > 0
    );
    check(
      'production build does not leak window.game',
      (await page.evaluate(() => typeof window.game)) === 'undefined'
    );
    await page.screenshot({ path: join(OUT, '01-production-menu.png') });
    check('no unexpected console errors', logs.errors.length === 0, logs.errors.slice(0, 3).join(' | '));
    report.productionConsole = logs.errors;
    await page.close();
  }

  // ---------------------------------------------------- 2. instrumented bundle

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1024, height: 640 });
  const logs = attachConsole(page);

  const shoot = (name) => page.screenshot({ path: join(OUT, `${name}.png`), timeout: 60000 }).catch((e) => console.warn(`screenshot ${name} failed: ${e.message}`));

  section('World creation');

  await page.goto(`http://127.0.0.1:${instrumented.port}/index.html`, {
    waitUntil: 'load',
    timeout: 60000,
  });
  await page.waitForFunction(() => !document.querySelector('#boot-screen'), null, {
    timeout: 90000,
  });
  await page.waitForFunction(() => typeof window.game !== 'undefined', null, { timeout: 30000 });
  check('instrumented build exposes window.game', true);

  await page.locator('button', { hasText: 'World options' }).first().click();
  await page.waitForTimeout(300);
  check(
    'the create-world dialog opens',
    (await page.locator('button', { hasText: 'Create and play' }).count()) > 0
  );
  const difficultyMenu = await page.evaluate(() => {
    const select = document.querySelector('select[aria-label="Game mode and difficulty"]');
    if (!select) return null;
    const options = [...select.options].map((option) => ({
      value:option.value,
      label:option.textContent,
    }));
    select.value = 'chug_tuff';
    select.dispatchEvent(new Event('change', { bubbles:true }));
    const description = document.querySelector('.mode-description')?.textContent ?? '';
    select.value = 'creative';
    select.dispatchEvent(new Event('change', { bubbles:true }));
    return { options, description };
  });
  report.difficultyMenu = difficultyMenu;
  check('the mode menu contains Creative plus four survival difficulties',
    difficultyMenu?.options?.length === 5, JSON.stringify(difficultyMenu));
  check('Easy, Normal, Hardcore and Chug Tuff are selectable',
    ['easy','normal','hardcore','chug_tuff'].every((value) =>
      difficultyMenu?.options?.some((option) => option.value === value)));
  check('Chug Tuff explains its one-life brutal rules',
    /one life/i.test(difficultyMenu?.description ?? '') && /relentless mobs/i.test(difficultyMenu?.description ?? ''));

  // A fixed seed keeps the run reproducible.
  const inputs = page.locator('input.text-input');
  await inputs.nth(0).fill('Smoke Test');
  await inputs.nth(1).fill('4242');
  await shoot('02-create-dialog');

  await page.locator('button', { hasText: 'Create and play' }).first().click();

  await page.waitForFunction(() => window.game?.ui?.screen === 'playing', null, {
    timeout: 180000,
  });
  check('the game reaches the playing screen', true);

  // Let terrain stream in and the frame loop settle.
  await page.waitForFunction(() => (window.game?.world?.stats?.loaded ?? 0) > 8, null, {
    timeout: 120000,
  });

  // SwiftShader is roughly three orders of magnitude slower than a real GPU, and
  // the default render distance drops the frame rate low enough that a
  // screenshot can catch a partially streamed world. Pull the distance in: the
  // shader path under test is unchanged, there is simply less of it.
  await page.evaluate(() => {
    const s = window.game.settings;
    s.setMany({
      'graphics.renderDistance': 4,
      'graphics.shadows': false,
      'graphics.postProcessing': false,
      // Keep water animated — that is the code path this test exists to check.
      'graphics.waterQuality': 'animated',
      'graphics.waterAnimation': true,
      // Freeze the sun. Otherwise the surface legitimately brightens over the
      // sampling window and colour drift stops being a usable signal; with it
      // frozen, any change in the water's colour over time is suspicious, which
      // is exactly the regression this test guards.
      'gameplay.pauseDayCycle': true,
    });
  });
  await page.waitForTimeout(3000);
  await shoot('03-playing');

  section('Shader and material health');

  const state = await page.evaluate(() => {
    const g = window.game;
    return {
      screen: g.ui?.screen,
      usingFallback: g.materials?.usingFallback,
      usingWaterFallback: g.materials?.usingWaterFallback,
      waterProblems: g.materials?.verifyWaterMaterial?.() ?? ['method missing'],
      chunks: g.world?.stats?.loaded ?? 0,
      seed: g.worldRecord?.seed ?? null,
    };
  });
  report.state = state;

  info(`seed ${state.seed}, ${state.chunks} chunks loaded`);
  check('the custom voxel shader compiled', state.usingFallback === false);
  check('the water shader compiled', state.usingWaterFallback === false);
  check(
    'runtime water material assertion passes',
    Array.isArray(state.waterProblems) && state.waterProblems.length === 0,
    JSON.stringify(state.waterProblems)
  );
  check('no shader compile errors were logged', logs.shader.length === 0, logs.shader.join(' | '));

  section('Version 9 voxel characters');
  const voxelCharacters = await page.evaluate(() => {
    const g = window.game;
    g.cameraController.setPersonMode(1);
    g.player.updateBody(1, g.cameraController.yaw, 1 / 60);
    const names = [];
    let meshCount = 0;
    g.player._bodyGroup?.traverse((part) => {
      if (part.name) names.push(part.name);
      if (part.isMesh) meshCount++;
    });
    const result = {
      visible:g.player._bodyGroup?.visible === true,
      style:g.player._bodyGroup?.userData?.avatarStyle ?? null,
      meshCount,
      hasEyes:names.includes('player-eye-left-white') && names.includes('player-eye-right-iris'),
      hasFace:names.includes('player-nose') && names.includes('player-mouth'),
      hasClothes:names.includes('player-left-sleeve') && names.includes('player-right-boot'),
      articulated:names.includes('player-head-pivot') && names.includes('player-left-arm-pivot'),
      mobShadowPool:g.entities.mobRenderer.shadowMesh?.isInstancedMesh === true,
      mobShadowName:g.entities.mobRenderer.shadowMesh?.name ?? null,
    };
    g.cameraController.setPersonMode(0);
    g.player.updateBody(0, g.cameraController.yaw, 1 / 60);
    return result;
  });
  report.voxelCharacters = voxelCharacters;
  check('third-person view shows the detailed original block character',
    voxelCharacters.visible && voxelCharacters.style === 'original-teal-voxel');
  check('the player rig has face, clothing and articulation geometry',
    voxelCharacters.meshCount >= 25 && voxelCharacters.hasEyes && voxelCharacters.hasFace &&
    voxelCharacters.hasClothes && voxelCharacters.articulated);
  check('mobs share an instanced terrain contact-shadow pool',
    voxelCharacters.mobShadowPool && voxelCharacters.mobShadowName === 'mob-contact-shadows');

  const material = await page.evaluate(() => {
    const m = window.game.materials.forLayer('liquid');
    return {
      name: m?.name ?? null,
      transparent: Boolean(m?.transparent),
      depthWrite: Boolean(m?.depthWrite),
      depthTest: Boolean(m?.depthTest),
      side: m?.side,
      opacity: m?.uniforms?.uOpacity?.value ?? (typeof m?.opacity === 'number' ? m.opacity : null),
      hasGuard: Boolean(m?.uniforms?.uWaterUvGuard),
      guard: m?.uniforms?.uWaterUvGuard
        ? [m.uniforms.uWaterUvGuard.value.x, m.uniforms.uWaterUvGuard.value.y]
        : null,
      rect: m?.uniforms?.uWaterTileRect
        ? [
            m.uniforms.uWaterTileRect.value.x,
            m.uniforms.uWaterTileRect.value.y,
            m.uniforms.uWaterTileRect.value.z,
            m.uniforms.uWaterTileRect.value.w,
          ]
        : null,
    };
  });
  report.material = material;
  info(`liquid material "${material.name}", opacity ${material.opacity}`);
  check('liquid material is the water shader', material.name === 'voxel-water');
  check('liquid material is transparent', material.transparent);
  check('liquid opacity is below 1', material.opacity !== null && material.opacity < 1);
  check('liquid writes depth', material.depthWrite);
  check('water UV guard uniforms are present', material.hasGuard, JSON.stringify(material.guard));

  section('Water surface colour over time');

  const placed = await page.evaluate(() => {
    const g = window.game;
    const world = g.world;
    const WATER = 10;
    const SEA = 56;

    // Search outward from spawn for a column whose top block is water.
    let found = null;
    for (let radius = 0; radius < 200 && !found; radius += 4) {
      for (let angle = 0; angle < 360; angle += 12) {
        const rad = (angle * Math.PI) / 180;
        const x = Math.round(g.player.position.x + Math.cos(rad) * radius);
        const z = Math.round(g.player.position.z + Math.sin(rad) * radius);
        for (let y = SEA + 4; y > SEA - 8; y--) {
          if (world.getBlock(x, y, z) === WATER && world.getBlock(x, y + 1, z) === 0) {
            found = { x, y, z };
            break;
          }
        }
        if (found) break;
      }
    }

    // Nothing nearby: carve a pool into the terrain surface so the test still
    // exercises the water material instead of silently passing on dry land.
    // Cut into the ground rather than stacking water in mid-air, so the result
    // is a real surface with solid blocks behind it.
    let synthetic = false;
    if (!found) {
      const cx = Math.round(g.player.position.x);
      const cz = Math.round(g.player.position.z);
      const surface = world.getSurfaceY(cx, cz);
      const top = surface - 1;
      const radius = 9;
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          // Clear everything above the pool so nothing occludes the view down.
          for (let y = top + 1; y <= top + 12; y++) {
            world.setBlock(cx + dx, y, cz + dz, 0, { cause: 'player' });
          }
          // Fill a few layers of water with stone beneath it.
          for (let y = top - 3; y <= top; y++) {
            world.setBlock(cx + dx, y, cz + dz, WATER, { cause: 'player' });
          }
          world.setBlock(cx + dx, top - 4, cz + dz, 1, { cause: 'player' });
        }
      }
      found = { x: cx, y: top, z: cz };
      synthetic = true;
    }

    // Hover above the water, look straight down, and stop moving so the sample
    // is stable and filled with surface.
    //
    // Flight is essential, not convenience: without it the player sinks into the
    // pool, the camera goes under the surface, and the underwater HUD tint would
    // make the colour assertions pass for entirely the wrong reason. `setFlying`
    // is refused when the setting is off, so the setting is forced first and the
    // result is reported back for assertion.
    g.settings.set('gameplay.allowFly', true);
    const flying = g.player.setFlying(true);
    g.player.teleport(found.x + 0.5, found.y + 5, found.z + 0.5);
    g.player.velocity.set(0, 0, 0);
    g.cameraController.setRotation(0.4, -Math.PI / 2 + 0.05);
    return { ...found, synthetic, flying };
  });
  report.waterLocation = placed;
  info(
    `sampling at ${placed.x},${placed.y},${placed.z} ` +
      `(${placed.synthetic ? 'synthesised pool' : 'natural water'})`
  );

  check('the camera can hover above the water', placed.flying === true);

  // Wait for the pool to actually mesh and appear. Sampling before the remesh
  // lands reads the terrain that used to be there, not water.
  {
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt++) {
      await page.waitForTimeout(1000);
      const probe = classify((await sampleCentre(page)).pixels);
      ready = probe.blueRatio > 0.5;
    }
    check('water is visible in the viewport before sampling begins', ready);
  }

  // The colour assertions below are only meaningful if the blue is coming from
  // the water *material*. Two things could otherwise fake it: a submerged camera
  // (which tints the whole screen through the underwater HUD overlay) and the
  // overlay itself being non-zero for any other reason. Both are ruled out here,
  // so a pass cannot be a false positive.
  {
    const view = await page.evaluate(() => {
      const g = window.game;
      const overlay = document.querySelector('.underwater-overlay');
      return {
        underwater: Boolean(g.water?.isUnderwater),
        submersion: g.water?.submersionDepth ?? 0,
        overlayOpacity: Number(overlay?.style.opacity || 0),
        headInWater: Boolean(g.player?.headInWater),
        eyeY: g.player.position.y + g.player.eyeHeight,
      };
    });
    report.viewState = view;
    info(`eye at y=${view.eyeY.toFixed(2)}, underwater=${view.underwater}`);
    check('the camera is above the surface, not submerged', view.underwater === false);
    check('the player is not swimming', view.headInWater === false);
    check(
      'the underwater tint overlay is off',
      view.overlayOpacity === 0,
      `opacity ${view.overlayOpacity}`
    );
  }

  // The original bug drifted off-tile at ~2 s, became magenta at ~16.6 s and was
  // pinned magenta from ~56 s. Sample across all three regimes.
  const timeline = [1, 5, 20, 40, 70];
  const samples = [];
  let previous = 0;
  for (const at of timeline) {
    await page.waitForTimeout(Math.max(0, (at - previous) * 1000));
    previous = at;
    const raw = await sampleCentre(page);
    const stats = classify(raw.pixels);
    samples.push({ at, ...stats, scroll: raw.scroll });
    info(
      `t=${String(at).padStart(2)}s  mean rgb(${stats.mean.join(',')})  ` +
        `blue ${(stats.blueRatio * 100).toFixed(1)}%  ` +
        `magenta ${(stats.magentaRatio * 100).toFixed(1)}%  ` +
        `scroll ${raw.scroll === null ? 'n/a' : raw.scroll.toFixed(4)}`
    );
    await shoot(`04-water-t${String(at).padStart(2, '0')}s`);
  }
  report.samples = samples;

  const worstMagenta = Math.max(...samples.map((s) => s.magentaRatio));
  const worstBlue = Math.min(...samples.map((s) => s.blueRatio));

  check(
    'water is never magenta at any point in time',
    worstMagenta < 0.02,
    `worst ${(worstMagenta * 100).toFixed(1)}% magenta`
  );
  // Deliberately the *worst* sample, not the best: the original bug looked fine
  // for the first couple of seconds, so a best-case assertion would have passed
  // on the broken code.
  check(
    'water reads as blue/teal at every sampled time',
    worstBlue > 0.5,
    `worst ${(worstBlue * 100).toFixed(1)}% blue`
  );
  check(
    'the scroll uniform stays bounded',
    samples.every((s) => s.scroll !== null && Math.abs(s.scroll) < 1),
    samples.map((s) => s.scroll).join(', ')
  );
  // With the sun frozen the surface colour should barely move. A large drift
  // means the sample is wandering across the atlas again.
  {
    const blues = samples.map((s) => s.mean[2]);
    const spread = Math.max(...blues) - Math.min(...blues);
    check('water colour is stable with the sun frozen', spread < 40, `blue spread ${spread}`);
  }

  section('Core interactions');

  const interactions = await page.evaluate(async () => {
    const g = window.game;
    const world = g.world;
    const out = {};

    const px = Math.round(g.player.position.x) + 3;
    const py = Math.floor(g.player.position.y) + 2;
    const pz = Math.round(g.player.position.z) + 3;

    world.setBlock(px, py, pz, 1, { cause: 'player' });
    out.placed = world.getBlock(px, py, pz) === 1;
    out.broke = world.breakBlock(px, py, pz, { drop: false }) === 1 && world.getBlock(px, py, pz) === 0;

    g.player.inventory.selectSlot(3);
    out.slotSelected = g.player.inventory.selectedSlot === 3;

    g.ui.openInventory();
    out.inventoryOpens = g.ui.screen === 'inventory';
    g.ui.closeInventory();
    out.inventoryCloses = g.ui.screen === 'playing';

    g.pause();
    out.pauses = g.ui.screen === 'paused';
    g.resume();
    out.resumes = g.ui.screen === 'playing';

    await g.save({ manual: true });
    const worlds = await g.saveManager.listWorlds();
    out.saved = worlds.length > 0;
    out.savedName = worlds[0]?.name ?? null;

    // Note: `renderer.info` is not sampled here. `info.autoReset` clears it at
    // the start of every frame, so reading it outside the render callback
    // reports whatever partial state the last frame left behind rather than the
    // scene's real cost. Profiling belongs in the in-game debug overlay.
    out.fps = Math.round(g.loop.fps);
    out.chunks = g.world.stats.loaded;
    return out;
  });
  report.interactions = interactions;

  check('a block can be placed', interactions.placed);
  check('a block can be broken', interactions.broke);
  check('a hotbar slot can be selected', interactions.slotSelected);
  check('the inventory opens', interactions.inventoryOpens);
  check('the inventory closes back to play', interactions.inventoryCloses);
  check('the game pauses', interactions.pauses);
  check('the game resumes', interactions.resumes);
  check('the world saves and is listed', interactions.saved, String(interactions.savedName));
  // SwiftShader is a software rasteriser; this number says nothing about real
  // hardware and is logged only to catch a total stall.
  info(`software GL: ${interactions.fps} fps, ${interactions.chunks} chunks`);

  section('Survival systems');

  const survival = await page.evaluate(async () => {
    const g = window.game;
    const out = {};

    // Move off the test pool onto solid ground first. Standing in water would
    // drain the air meter during the checks below and make the HUD screenshot
    // show a swimming player, which muddles what this section is demonstrating.
    {
      const x = Math.round(g.player.position.x) + 30;
      const z = Math.round(g.player.position.z) + 30;
      const surface = g.world.getSurfaceY(x, z);
      g.player.teleport(x + 0.5, surface + 1, z + 0.5);
      g.player.setSpawnHere();
      g.cameraController.setRotation(0.6, -0.15);
      await new Promise((r) => setTimeout(r, 600));
      out.onLand = !g.player.inWater && !g.player.headInWater;
    }

    // Switch to survival so the stats engine is live, then verify the HUD bars
    // actually appear — the Node tests cover the maths, but only the browser can
    // confirm the DOM is wired to it.
    g.player.setMode('survival');
    out.statsEnabled = g.player.stats.enabled;
    out.startingHealth = g.player.stats.health;
    out.startingHunger = g.player.stats.hunger;

    // Give the renderer a frame to draw the bars.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const hearts = document.querySelectorAll('.status-heart');
    const drumsticks = document.querySelectorAll('.status-hunger');
    out.heartCount = hearts.length;
    out.hungerCount = drumsticks.length;
    out.barsVisible = !document.querySelector('.status-bars')?.hidden;
    out.fullHearts = [...hearts].filter((h) => h.classList.contains('is-full')).length;

    // --- inventory: a real pickup through the public API ---
    g.player.inventory.clear();
    const leftover = g.player.inventory.addItem('stone', 5);
    out.pickupLeftover = leftover;
    out.pickupLanded = g.player.inventory.getSlot(0)?.itemId === 'stone';
    out.pickupCount = g.player.inventory.countOf('stone');

    // --- a tool keeps its damage through a save/load round trip ---
    const ItemStackCtor = g.player.inventory.getSlot(0).constructor;
    g.player.inventory.setSlot(1, new ItemStackCtor('iron_pickaxe', 1, { damage: 99 }));
    const json = JSON.parse(JSON.stringify(g.player.inventory.toJSON()));
    g.player.inventory.fromJSON(json);
    out.toolDamagePersisted = g.player.inventory.getSlot(1)?.damage === 99;

    // --- the hotbar draws a durability bar for a worn tool ---
    g.player.inventory.selectSlot(1);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const bars = [...document.querySelectorAll('.hotbar-slot-durability')];
    out.durabilityBarShown = bars.some((b) => !b.hidden);

    // --- damage and the invulnerability window, end to end ---
    g.player.hurt(4, 'mob');
    out.afterFirstHit = g.player.stats.health;
    const blocked = g.player.hurt(4, 'mob');
    out.secondHitBlocked = blocked === false;
    out.afterSecondHit = g.player.stats.health;

    return out;
  });
  report.survival = survival;

  check('the player can stand on dry land', survival.onLand === true);
  check('survival mode enables the stats engine', survival.statsEnabled === true);
  check('the player starts at full health', survival.startingHealth === 20);
  check('ten heart icons are rendered', survival.heartCount === 10, `${survival.heartCount}`);
  check('ten hunger icons are rendered', survival.hungerCount === 10, `${survival.hungerCount}`);
  check('the status bars are visible in survival', survival.barsVisible === true);
  check('all hearts start full', survival.fullHearts === 10, `${survival.fullHearts}`);
  check('an item can be picked up', survival.pickupLanded && survival.pickupLeftover === 0);
  check('the picked-up count is correct', survival.pickupCount === 5);
  check('tool damage survives a save round trip', survival.toolDamagePersisted === true);
  check('a worn tool shows a durability bar', survival.durabilityBarShown === true);
  check('damage reduces health', survival.afterFirstHit === 16, `${survival.afterFirstHit}`);
  check('an immediate second hit is blocked', survival.secondHitBlocked === true);
  check('health is unchanged by the blocked hit', survival.afterSecondHit === 16);

  await shoot('06-survival-hud');

  // --- death and respawn, driven through the real UI ---
  const death = await page.evaluate(async () => {
    const g = window.game;
    g.player.stats.kill('mob');
    await new Promise((r) => setTimeout(r, 400));
    return {
      screen: g.ui.screen,
      dialogVisible: !document.querySelector('.screen--death')?.hidden,
      causeText: document.querySelector('.death-cause')?.textContent ?? '',
      hudHidden: Boolean(document.querySelector('.hud')?.hidden),
      hasRespawnButton: [...document.querySelectorAll('button')].some((b) =>
        /respawn/i.test(b.textContent)
      ),
      hasMenuButton: [...document.querySelectorAll('button')].some((b) =>
        /return to menu/i.test(b.textContent)
      ),
    };
  });
  report.death = death;

  check('dying switches to the death screen', death.screen === 'dead', String(death.screen));
  check('the death dialog is visible', death.dialogVisible === true);
  check('the death cause is shown', death.causeText.length > 0, death.causeText);
  check('the HUD is hidden while dead', death.hudHidden === true);
  check('a Respawn button is offered', death.hasRespawnButton === true);
  check('a Return to Menu button is offered', death.hasMenuButton === true);

  await shoot('07-death-screen');

  // Click the real button rather than calling the handler, so the wiring from
  // DOM to respawn is what gets exercised.
  await page.locator('button', { hasText: 'Respawn' }).first().click();
  await page.waitForTimeout(1200);

  const afterRespawn = await page.evaluate(() => {
    const g = window.game;
    return {
      screen: g.ui.screen,
      health: g.player.stats.health,
      hunger: g.player.stats.hunger,
      dead: g.player.stats.isDead,
      y: g.player.position.y,
      inSolid: g.world.isCollidable(
        Math.floor(g.player.position.x),
        Math.floor(g.player.position.y),
        Math.floor(g.player.position.z)
      ),
    };
  });
  report.afterRespawn = afterRespawn;

  check('respawning returns to gameplay', afterRespawn.screen === 'playing', String(afterRespawn.screen));
  check('respawning restores full health', afterRespawn.health === 20);
  check('respawning restores hunger', afterRespawn.hunger === 20);
  check('the player is alive again', afterRespawn.dead === false);
  check('the respawn point is above the void', afterRespawn.y > 0, String(afterRespawn.y));
  check('the player does not respawn inside a block', afterRespawn.inSolid === false);

  const permadeathUi = await page.evaluate(async () => {
    const g = window.game;
    g.ui.showDeath({
      message:'Chug Tuff test defeat',
      keptInventory:false,
      permadeath:true,
      difficultyLabel:'Chug Tuff',
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = {
      title:document.querySelector('.dialog--death .dialog-title')?.textContent ?? '',
      detail:document.querySelector('.death-detail')?.textContent ?? '',
      respawnHidden:Boolean(document.querySelector('.dialog--death button')?.hidden),
      screen:g.ui.screen,
    };
    g.ui.startPlaying();
    return result;
  });
  report.permadeathUi = permadeathUi;
  check('Chug Tuff uses a permanent world-loss screen',
    permadeathUi.screen === 'dead' && permadeathUi.title === 'Chug Tuff world lost');
  check('one-life defeat hides Respawn and explains the lock',
    permadeathUi.respawnHidden && /cannot be played again/i.test(permadeathUi.detail));

  await shoot('08-after-respawn');

  section('Crafting and workstations');

  // Craft by hand through the real UI: open the inventory, lay out a recipe from
  // the recipe book, take the result.
  const handCraft = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    const inv = g.player.inventory;

    inv.clear();
    inv.addItem('oak_log', 3);

    // Open the survival inventory (creative shows the block palette instead).
    g.player.setMode('survival');
    g.ui.containerScreen.close();
    g._toggleInventory();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    out.screen = g.ui.screen;
    out.craftingSlots = document.querySelectorAll('.slot-grid--crafting .slot').length;
    out.resultSlots = document.querySelectorAll('.slot-grid--result .slot').length;
    out.playerSlots = document.querySelectorAll('.slot-grid--player .slot').length;

    // Lay a log into the 2x2 grid by hand and check the preview appears.
    const grid = g.playerCrafting;
    inv.removeItem('oak_log', 1);
    grid.container.setSlot(0, new (inv.getSlot(0)?.constructor ?? Object)('oak_log', 1));
    grid.refresh(true);
    out.previewItem = grid.result?.itemId ?? null;
    out.previewCount = grid.result?.quantity ?? 0;

    // The preview must not have consumed anything.
    out.gridStillHasLog = grid.container.getSlot(0)?.quantity === 1;

    // Take the result: this is the only thing that consumes ingredients.
    const produced = grid.takeResult();
    out.producedItem = produced?.itemId ?? null;
    out.producedCount = produced?.quantity ?? 0;
    out.gridEmptyAfterTake = grid.container.getSlot(0) === null;

    if (produced) inv.addItem(produced);
    out.planksInInventory = inv.countOf('oak_planks');
    return out;
  });
  report.handCraft = handCraft;

  check('the survival inventory opens as a container', handCraft.screen === 'container', String(handCraft.screen));
  check('a 2x2 crafting grid is rendered', handCraft.craftingSlots === 4, `${handCraft.craftingSlots}`);
  check('a result slot is rendered', handCraft.resultSlots === 1);
  check('the player inventory is rendered', handCraft.playerSlots === 36, `${handCraft.playerSlots}`);
  check('a log previews as planks', handCraft.previewItem === 'oak_planks', String(handCraft.previewItem));
  check('the preview shows the right count', handCraft.previewCount === 4);
  check('previewing consumes nothing', handCraft.gridStillHasLog === true);
  check('taking the result yields planks', handCraft.producedItem === 'oak_planks');
  check('taking the result consumes the log', handCraft.gridEmptyAfterTake === true);
  check('the planks reach the inventory', handCraft.planksInInventory === 4, `${handCraft.planksInInventory}`);

  await shoot('09-inventory-crafting');

  // Closing a container with items on the grid must give them back.
  const reclaim = await page.evaluate(async () => {
    const g = window.game;
    const inv = g.player.inventory;

    // Start from a known state. `_toggleInventory` *toggles*, so calling it while
    // the screen is already open would close it and make the assertions below
    // measure nothing.
    g.ui.containerScreen.close();
    await new Promise((r) => setTimeout(r, 100));

    inv.clear();
    inv.addItem('oak_log', 2);

    g._toggleInventory();
    await new Promise((r) => setTimeout(r, 150));
    const opened = g.ui.screen === 'container';

    // Move a stack onto the grid using the same transfer helper the UI uses.
    const stack = inv.getSlot(0);
    g.playerCrafting.container.insert(stack);
    if (stack.isEmpty) inv.setSlot(0, null);
    const onGrid = g.playerCrafting.container.countOf('oak_log');
    const heldAfterMove = inv.countOf('oak_log');

    g.ui.containerScreen.close();
    await new Promise((r) => setTimeout(r, 150));
    return {
      opened,
      onGrid,
      heldAfterMove,
      gridEmpty: g.playerCrafting.container.isEmpty,
      logsBack: inv.countOf('oak_log'),
      screen: g.ui.screen,
    };
  });
  report.reclaim = reclaim;

  check('the inventory opens for the reclaim check', reclaim.opened === true);
  check('moving to the grid removes from the inventory', reclaim.heldAfterMove === 0, `${reclaim.heldAfterMove}`);

  check('items can be placed on the crafting grid', reclaim.onGrid > 0, `${reclaim.onGrid}`);
  check('closing empties the crafting grid', reclaim.gridEmpty === true);
  check('closing returns the ingredients', reclaim.logsBack === 2, `${reclaim.logsBack}`);
  check('closing returns to gameplay', reclaim.screen === 'playing', String(reclaim.screen));

  // Place a crafting table and open it with Use.
  const table = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    const x = Math.round(g.player.position.x) + 2;
    const z = Math.round(g.player.position.z);
    const y = Math.floor(g.player.position.y);

    g.world.setBlock(x, y, z, 38 /* CRAFTING_TABLE */, { cause: 'player' });
    out.placed = g.world.getBlock(x, y, z) === 38;

    g._openCraftingTable(x, y, z);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.screen = g.ui.screen;
    out.gridSlots = document.querySelectorAll('.slot-grid--crafting .slot').length;
    out.hasRecipeBook = document.querySelector('.recipe-book') !== null;
    out.recipeEntries = document.querySelectorAll('.recipe-entry').length;
    out.title = document.querySelector('.container-title')?.textContent ?? '';
    return out;
  });
  report.table = table;

  check('a crafting table can be placed', table.placed === true);
  check('Use opens the crafting table', table.screen === 'container');
  check('the table shows a 3x3 grid', table.gridSlots === 9, `${table.gridSlots}`);
  check('the table is titled correctly', table.title === 'Crafting Table', table.title);
  check('a recipe book is present', table.hasRecipeBook === true);
  check('the recipe book lists recipes', table.recipeEntries > 10, `${table.recipeEntries}`);

  await shoot('10-crafting-table');

  // Use the recipe book to lay out a pickaxe, then craft it.
  const bookCraft = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    const inv = g.player.inventory;
    inv.clear();
    inv.addItem('oak_planks', 8);
    inv.addItem('stick', 4);

    // Click the real recipe-book entry for a wooden pickaxe.
    const entries = [...document.querySelectorAll('.recipe-entry')];
    const target = entries.find((e) => /Wood Pickaxe/i.test(e.textContent));
    out.foundEntry = Boolean(target);
    target?.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const grid = g.tableCrafting;
    grid.refresh(true);
    out.laidOut = grid.container.usedSlots;
    out.matched = grid.recipe?.id ?? null;
    out.preview = grid.result?.itemId ?? null;

    const produced = grid.takeResult();
    out.producedItem = produced?.itemId ?? null;
    if (produced) inv.addItem(produced);
    out.pickaxes = inv.countOf('wood_pickaxe');
    return out;
  });
  report.bookCraft = bookCraft;

  check('the recipe book lists a wooden pickaxe', bookCraft.foundEntry === true);
  check('clicking a recipe lays it out', bookCraft.laidOut === 5, `${bookCraft.laidOut} slots`);
  check('the laid-out recipe matches', bookCraft.matched === 'wood_pickaxe', String(bookCraft.matched));
  check('a pickaxe is crafted', bookCraft.producedItem === 'wood_pickaxe');
  check('the pickaxe reaches the inventory', bookCraft.pickaxes === 1);

  // Furnace: place, load, and let it actually smelt.
  const furnace = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    g.ui.containerScreen.close();

    const x = Math.round(g.player.position.x) + 3;
    const z = Math.round(g.player.position.z) + 1;
    const y = Math.floor(g.player.position.y);
    g.world.setBlock(x, y, z, 39 /* FURNACE */, { cause: 'player' });
    out.placed = g.world.getBlock(x, y, z) === 39;

    const entity = g.world.getBlockEntity(x, y, z);
    out.hasEntity = entity !== null;
    out.entityType = entity?.type ?? null;

    g._openFurnace(x, y, z);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.screen = g.ui.screen;
    out.gauges = document.querySelectorAll('.gauge-fill').length;

    // Load it through the real transfer path.
    const inv = g.player.inventory;
    inv.clear();
    inv.addItem('iron_ore', 2);
    inv.addItem('coal', 2);
    // Shift-click routes fuel to the fuel slot and ore to the input slot.
    g.ui.containerScreen.transferHandler(0);
    g.ui.containerScreen.transferHandler(1);
    out.inputLoaded = entity.inputStack?.itemId ?? null;
    out.fuelLoaded = entity.fuelStack?.itemId ?? null;

    // Stashed on `window` so the next evaluate block can find the same furnace.
    window.__furnaceAt = { x, y, z };
    out.position = { x, y, z };
    return out;
  });
  report.furnace = furnace;

  check('a furnace can be placed', furnace.placed === true);
  check('placing a furnace creates a block entity', furnace.hasEntity === true);
  check('the entity is a furnace', furnace.entityType === 'furnace', String(furnace.entityType));
  check('Use opens the furnace', furnace.screen === 'container');
  check('the furnace shows two gauges', furnace.gauges === 2, `${furnace.gauges}`);
  check('shift-click routes ore to the input slot', furnace.inputLoaded === 'iron_ore', String(furnace.inputLoaded));
  check('shift-click routes coal to the fuel slot', furnace.fuelLoaded === 'coal', String(furnace.fuelLoaded));

  await shoot('11-furnace');

  // Close the screen and confirm the furnace keeps working without it.
  const smelted = await page.evaluate(async () => {
    const g = window.game;
    const { x, y, z } = window.__furnaceAt;
    g.ui.containerScreen.close();
    await new Promise((r) => setTimeout(r, 200));

    const entity = g.world.getBlockEntity(x, y, z);
    const screenWhileSmelting = g.ui.screen;
    const litWhileClosed = [];

    // Drive the *world* tick rather than waiting on wall-clock time.
    //
    // SwiftShader renders at 2-3 fps, and `GameLoop` discards any frame delta
    // above `PHYSICS.maxFrameDelta` (0.25 s) to stop a stall becoming a physics
    // explosion. At 2 fps every frame exceeds that, so game time advances roughly
    // thirty times slower than real time: twenty seconds of waiting is under a
    // second of simulation, and a ten-second smelt would never finish.
    //
    // Calling `world.fixedUpdate` directly still exercises the real path —
    // World -> BlockEntityStore.tick -> FurnaceBlockEntity._advance — with the
    // screen genuinely closed, which is the behaviour under test. Only the clock
    // is substituted.
    for (let i = 0; i < 300; i++) {
      g.world.fixedUpdate(0.1);
      if (i % 20 === 0) litWhileClosed.push(g.world.getBlock(x, y, z) === 40 /* FURNACE_LIT */);
      if (entity.outputStack) break;
    }

    return {
      output: entity.outputStack?.itemId ?? null,
      outputCount: entity.outputStack?.quantity ?? 0,
      wasLit: litWhileClosed.some(Boolean),
      blockNow: g.world.getBlock(x, y, z),
      screen: screenWhileSmelting,
      inputLeft: entity.inputStack?.quantity ?? 0,
    };
  });
  report.smelted = smelted;

  check('the furnace smelts while its screen is closed', smelted.output === 'iron_ingot', String(smelted.output));
  check('an ingot was produced', smelted.outputCount >= 1, `${smelted.outputCount}`);
  check('the ore was consumed', smelted.inputLeft < 2, `${smelted.inputLeft} left`);
  check('the furnace block lit up while burning', smelted.wasLit === true);
  check('the screen was closed throughout', smelted.screen === 'playing', String(smelted.screen));

  await shoot('12-furnace-smelted');

  // Chest: place, store, break, and confirm the contents drop rather than vanish.
  const chest = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    const x = Math.round(g.player.position.x) - 2;
    const z = Math.round(g.player.position.z) + 2;
    const y = Math.floor(g.player.position.y);

    g.world.setBlock(x, y, z, 41 /* CHEST */, { cause: 'player' });
    const entity = g.world.getBlockEntity(x, y, z);
    out.hasEntity = entity !== null;

    g._openChest(x, y, z);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    out.screen = g.ui.screen;
    out.chestSlots = document.querySelectorAll('.slot-grid--chest .slot').length;

    const inv = g.player.inventory;
    inv.clear();
    inv.addItem('diamond', 5);
    g.ui.containerScreen.transferHandler(0);
    out.stored = entity.container.countOf('diamond');
    out.removedFromPlayer = inv.countOf('diamond');

    g.ui.containerScreen.close();

    // Break the chest: the contents must become world items.
    const before = g.entities.liveItemCount;
    g.world.setBlock(x, y, z, 0, { cause: 'break' });
    out.entityGone = g.world.getBlockEntity(x, y, z) === null;
    out.itemsSpawned = g.entities.liveItemCount - before;
    return out;
  });
  report.chest = chest;

  check('placing a chest creates a block entity', chest.hasEntity === true);
  check('Use opens the chest', chest.screen === 'container');
  check('the chest shows 27 slots', chest.chestSlots === 27, `${chest.chestSlots}`);
  check('items can be stored in a chest', chest.stored === 5, `${chest.stored}`);
  check('stored items leave the inventory', chest.removedFromPlayer === 0);
  check('breaking a chest removes its entity', chest.entityGone === true);
  check('breaking a chest drops its contents', chest.itemsSpawned > 0, `${chest.itemsSpawned}`);

  await shoot('13-chest');

  section('Tools, mining tiers and combat');

  const mining = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    g.ui.containerScreen.close();
    await new Promise((r) => setTimeout(r, 150));

    const inv = g.player.inventory;
    const x = Math.round(g.player.position.x) + 4;
    const z = Math.round(g.player.position.z) - 2;
    const y = Math.floor(g.player.position.y);

    // --- wrong tool: stone breaks but yields nothing ---
    inv.clear();
    g.world.setBlock(x, y, z, 1 /* STONE */, { cause: 'player' });
    const beforeBare = g.entities.liveItemCount;
    // Break it through the world with harvesting disallowed, mirroring what
    // BlockBreaker does when `wouldDrop` is false.
    g.world.breakBlock(x, y, z, { drop: false });
    out.bareHandDrops = g.entities.liveItemCount - beforeBare;

    // --- correct tool: stone yields cobblestone ---
    g.world.setBlock(x, y, z, 1, { cause: 'player' });
    const beforePick = g.entities.liveItemCount;
    g.world.breakBlock(x, y, z, { drop: true });
    out.pickaxeDrops = g.entities.liveItemCount - beforePick;

    // --- tool wear is charged once per broken block, not per frame ---
    inv.clear();
    const Stack = inv.constructor;
    inv.addItem('iron_pickaxe', 1);
    const pick = inv.getSlot(0);
    inv.selectSlot(0);
    const damageBefore = pick.damage;
    inv.damageSelected(1);
    out.wearApplied = inv.getSlot(0).damage - damageBefore;

    // --- a tool breaks when exhausted and leaves the slot empty ---
    inv.clear();
    inv.addItem('wood_pickaxe', 1);
    inv.selectSlot(0);
    const max = inv.getSlot(0).maxDurability;
    out.brokeOnLastUse = inv.damageSelected(max);
    out.slotEmptyAfterBreak = inv.getSlot(0) === null;

    // --- the breaker reports harvest state so the HUD can warn ---
    inv.clear();
    inv.addItem('iron_shovel', 1);
    inv.selectSlot(0);
    g.world.setBlock(x, y, z, 1, { cause: 'player' });
    // Aim at the block and mine for a frame.
    g.player.teleport(x + 0.5, y + 1, z + 3.5);
    g.cameraController.setRotation(Math.PI, -0.2);
    await new Promise((r) => setTimeout(r, 400));

    out.position = { x, y, z };
    return out;
  });
  report.mining = mining;

  check('the wrong tool yields no drop', mining.bareHandDrops === 0, `${mining.bareHandDrops}`);
  check('the right tool yields a drop', mining.pickaxeDrops > 0, `${mining.pickaxeDrops}`);
  check('tool wear is charged once', mining.wearApplied === 1, `${mining.wearApplied}`);
  check('a tool breaks on its last use', mining.brokeOnLastUse === true);
  check('a broken tool leaves an empty slot', mining.slotEmptyAfterBreak === true);

  // Combat, driven through the real system with a stub target.
  const combat = await page.evaluate(async () => {
    const g = window.game;
    const out = {};

    let damage = 0;
    const dummy = {
      alive: true,
      isDead: false,
      x: g.player.position.x,
      y: g.player.position.y,
      z: g.player.position.z + 2.5,
      halfSize: 0.4,
      height: 1.8,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      hurt(amount) {
        damage += amount;
        return true;
      },
    };

    // Look at the dummy.
    g.cameraController.setRotation(0, 0);
    const eye = g.player.getEyePosition(g._eye);

    const swing = (itemId) =>
      g.combat.tryAttack({
        origin: { x: dummy.x, y: eye.y, z: dummy.z - 2.5 },
        direction: { x: 0, y: 0, z: 1 },
        reach: 4.5,
        itemId,
        blockDistance: Infinity,
        candidates: [dummy],
      });

    g.combat.reset();
    out.firstHit = swing('iron_sword') !== null;
    out.damageDealt = damage;
    out.onCooldown = g.combat.isReady === false;
    out.blockedSecond = swing('iron_sword') === null;
    out.knockback = dummy.velocityZ > 0;

    g.combat.reset();
    damage = 0;
    out.fistHit = swing(null) !== null;
    out.fistDamage = damage;

    out.readinessAfter = g.combat.readiness;
    return out;
  });
  report.combat = combat;

  check('a swing hits an entity in the crosshair', combat.firstHit === true);
  check('the hit deals the weapon damage', combat.damageDealt === 6, `${combat.damageDealt}`);
  check('a hit applies knockback', combat.knockback === true);
  check('attacking starts a cooldown', combat.onCooldown === true);
  check('a second swing during cooldown is refused', combat.blockedSecond === true);
  check('a bare hand can still attack', combat.fistHit === true);
  check('a bare hand deals less damage', combat.fistDamage < 6, `${combat.fistDamage}`);
  check('readiness is reported below 1 while recharging', combat.readinessAfter < 1);

  // The hoe: dirt becomes farmland, and the tool wears.
  const hoe = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    const inv = g.player.inventory;
    inv.clear();
    inv.addItem('iron_hoe', 1);
    inv.selectSlot(0);

    const x = Math.round(g.player.position.x) + 6;
    const z = Math.round(g.player.position.z);
    const surface = g.world.getSurfaceY(x, z);
    const y = surface - 1;

    g.world.setBlock(x, y, z, 3 /* DIRT */, { cause: 'player' });
    g.world.setBlock(x, y + 1, z, 0, { cause: 'player' });

    // Call the real handler with a synthetic upward-face hit.
    const tilled = g._tillSoil({
      hit: true,
      blockX: x,
      blockY: y,
      blockZ: z,
      blockId: 3,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
    });
    out.tilled = tilled;
    out.blockNow = g.world.getBlock(x, y, z);
    out.hoeDamage = inv.getSlot(0)?.damage ?? -1;

    // Tilling must fail when something sits on top: it would destroy whatever is
    // there.
    g.world.setBlock(x, y, z, 3, { cause: 'player' });
    g.world.setBlock(x, y + 1, z, 1 /* STONE */, { cause: 'player' });
    out.blockedByCover = g._tillSoil({
      hit: true,
      blockX: x,
      blockY: y,
      blockZ: z,
      blockId: 3,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
    });

    // And when hit from the side, since tilling an underside is meaningless.
    g.world.setBlock(x, y + 1, z, 0, { cause: 'player' });
    out.blockedBySideHit = g._tillSoil({
      hit: true,
      blockX: x,
      blockY: y,
      blockZ: z,
      blockId: 3,
      normalX: 1,
      normalY: 0,
      normalZ: 0,
    });
    return out;
  });
  report.hoe = hoe;

  check('a hoe tills dirt', hoe.tilled === true);
  check('the block becomes farmland', hoe.blockNow === 42, `block ${hoe.blockNow}`);
  check('tilling wears the hoe', hoe.hoeDamage === 1, `${hoe.hoeDamage}`);
  check('tilling is refused under a covering block', hoe.blockedByCover === false);
  check('tilling is refused from the side', hoe.blockedBySideHit === false);

  // Item details popover, which is the only way to read tool stats on touch.
  const details = await page.evaluate(async () => {
    const g = window.game;
    const inv = g.player.inventory;
    inv.clear();
    inv.addItem('diamond_pickaxe', 1);
    inv.selectSlot(0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    g.ui.hotbar._showDetails(0, 400, 400);
    await new Promise((r) => requestAnimationFrame(r));
    const node = document.querySelector('.item-details');
    const text = node?.textContent ?? '';
    const shown = node ? !node.hidden : false;
    g.ui.hotbar._endPress();
    return { shown, text, hiddenAfter: node ? node.hidden : true };
  });
  report.details = details;

  check('item details can be shown', details.shown === true);
  check('details name the item', /Diamond Pickaxe/i.test(details.text), details.text.slice(0, 60));
  check('details report the harvest level', /Harvest level/i.test(details.text));
  check('details report durability', /Durability/i.test(details.text));
  check('details hide again', details.hiddenAfter === true);

  await shoot('14-tools');

  section('V2 architecture and ecosystem');

  const v2 = await page.evaluate(async () => {
    const g = window.game;
    const world = g.world;
    const out = {};
    const baseX = Math.floor(g.player.position.x) + 12;
    const baseZ = Math.floor(g.player.position.z) + 12;
    const surface = world.getSurfaceY(baseX, baseZ);
    const y = Math.min(118, Math.max(4, surface + 2));

    // Build a deterministic open test cell in an already loaded chunk.
    for (let dx = -1; dx <= 7; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        world.setBlock(baseX + dx, y - 1, baseZ + dz, 1 /* STONE */, { cause: 'test' });
        for (let dy = 0; dy <= 3; dy++) {
          world.setBlock(baseX + dx, y + dy, baseZ + dz, 0 /* AIR */, { cause: 'test' });
        }
      }
    }

    // Wide block IDs and state bytes must survive the live World path, not only
    // the Node codec tests. Upper slab uses state bit 0x10.
    out.upperSlabPlaced = world.setBlock(baseX, y, baseZ, 57 /* OAK_SLAB */, {
      cause: 'test',
      state: 0x10,
    });
    out.upperSlabId = world.getBlock(baseX, y, baseZ);
    out.upperSlabState = world.getBlockState(baseX, y, baseZ);

    // Runtime propagated lighting: a torch should illuminate several voxels
    // beyond its own face and decrease with distance.
    world.setBlock(baseX + 2, y, baseZ, 22 /* TORCH */, { cause: 'test' });
    out.lightSource = world.getBlockLight(baseX + 2, y, baseZ);
    out.lightNear = world.getBlockLight(baseX + 3, y, baseZ);
    out.lightFar = world.getBlockLight(baseX + 6, y, baseZ);

    // Shared effects affect gameplay and survive the player's JSON boundary.
    g.player.effects.clear();
    out.effectApplied = g.player.effects.apply('speed', 30, 1, { source: 'smoketest' });
    out.speedMultiplier = g.player.effects.movementSpeedMultiplier;
    const savedEffects = g.player.toJSON().effects;
    g.player.effects.clear();
    g.player.effects.fromJSON(savedEffects);
    out.effectRestored = g.player.effects.has('speed');

    // Clear only the pooled test mobs, then exercise feeding, breeding, baby
    // scaling and entity persistence through the real manager.
    for (const mob of g.entities.mobs) mob.kill();
    const first = g.entities.spawnMob('cow', baseX + 1.5, y, baseZ - 0.5, 101);
    const second = g.entities.spawnMob('cow', baseX + 2.5, y, baseZ - 0.5, 202);
    out.parentsSpawned = Boolean(first && second);
    if (first && second) {
      out.parentsFed = first.feed('wheat').accepted && second.feed('wheat').accepted;
      g.entities._updateBreeding();
      const baby = g.entities.mobs.find((mob) => mob.alive && mob.isBaby);
      out.babySpawned = Boolean(baby);
      out.babyScale = baby?.ageScale ?? 1;
      const snapshot = g.entities.toJSON();
      out.babyPersisted = snapshot.mobs.some((mob) => mob.babyAge > 0 && mob.mobId === 'cow');
    }

    // Every camera mode must remain reachable after the V2 camera fixes.
    g.cameraController.setPersonMode(0);
    out.cameraModes = [
      g.cameraController.togglePerson(),
      g.cameraController.togglePerson(),
      g.cameraController.togglePerson(),
    ];
    g.cameraController.setPersonMode(0);

    // The enhanced diagnostics should expose live lighting, state, effects and
    // entity counts without throwing.
    Object.assign(g._target, {
      hit: true,
      blockId: 57,
      blockX: baseX,
      blockY: y,
      blockZ: baseZ,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      distance: 2,
    });
    g.ui.debugOverlay.setVisible(true);
    g.ui.debugOverlay.update(1, g._collectDebugState());
    const debugText = [...document.querySelectorAll('.debug-overlay')]
      .map((node) => node.textContent || '')
      .join('\n');
    out.debugHasLight = /light\s+block/i.test(debugText);
    out.debugHasEffects = /effects\s+Speed/i.test(debugText);
    out.debugHasMobs = /mobs\s+\d+/i.test(debugText);
    out.debugHasBlockState = /state\s+16\s+\(0x10\)/i.test(debugText);

    await g.save({ manual: true });
    return out;
  });
  report.v2 = v2;

  check('a stateful structural block works through the live world',
    v2.upperSlabPlaced && v2.upperSlabId === 57 && v2.upperSlabState === 0x10,
    JSON.stringify({ id: v2.upperSlabId, state: v2.upperSlabState }));
  check('a torch reports full source light', v2.lightSource === 14, `${v2.lightSource}`);
  check('block light propagates beyond adjacent faces', v2.lightNear > v2.lightFar && v2.lightFar > 0,
    `${v2.lightNear} -> ${v2.lightFar}`);
  check('status effects modify movement', v2.effectApplied && v2.speedMultiplier > 1);
  check('status effects persist through player JSON', v2.effectRestored === true);
  check('two passive adults can be spawned and fed', v2.parentsSpawned && v2.parentsFed);
  check('fed passive adults produce a scaled baby', v2.babySpawned && v2.babyScale < 1);
  check('baby state is included in entity persistence', v2.babyPersisted === true);
  check('all three camera modes cycle in order', JSON.stringify(v2.cameraModes) === '[1,2,0]', JSON.stringify(v2.cameraModes));
  check('debug diagnostics expose propagated light', v2.debugHasLight === true);
  check('debug diagnostics expose active effects', v2.debugHasEffects === true);
  check('debug diagnostics expose live mobs', v2.debugHasMobs === true);
  check('debug diagnostics expose raw block state', v2.debugHasBlockState === true);

  await shoot('16-v2-diagnostics');
  await page.evaluate(() => window.game.ui.debugOverlay.setVisible(false));

  section('Dropping and inventory UX');

  const dropping = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    g.ui.containerScreen.close();
    await new Promise((r) => setTimeout(r, 150));

    const inv = g.player.inventory;
    inv.clear();
    inv.addItem('cobblestone', 10);
    inv.selectSlot(0);

    // --- drop one ---
    const before = g.entities.liveItemCount;
    out.droppedOne = g._dropHeld(false);
    out.entitiesAfterOne = g.entities.liveItemCount - before;
    out.heldAfterOne = inv.countOf('cobblestone');

    // --- drop the rest of the stack ---
    out.droppedStack = g._dropHeld(true);
    out.heldAfterStack = inv.countOf('cobblestone');
    out.slotEmpty = inv.getSlot(0) === null;

    // --- dropping an empty slot is a no-op, not an error ---
    out.droppedNothing = g._dropHeld(false);

    // --- the dropped entities carry real stacks ---
    // Checked with `some` rather than by index: the pool still holds entities from
    // earlier sections, so the first live slot is not necessarily the one just
    // dropped.
    const live = [...g.entities.items].filter((i) => i.alive);
    out.liveCarryStacks = live.every((i) => i.stack !== null && i.itemId !== null);
    out.foundDropped = live.some((i) => i.itemId === 'cobblestone');
    out.liveCount = live.length;
    return out;
  });
  report.dropping = dropping;

  check('the drop action drops one item', dropping.droppedOne === true);
  check('dropping spawns a world entity', dropping.entitiesAfterOne >= 1, `${dropping.entitiesAfterOne}`);
  check('dropping one leaves the rest', dropping.heldAfterOne === 9, `${dropping.heldAfterOne}`);
  check('the stack drop empties the slot', dropping.droppedStack === true && dropping.slotEmpty === true);
  check('nothing is held afterwards', dropping.heldAfterStack === 0);
  check('dropping an empty slot is a safe no-op', dropping.droppedNothing === false);
  check('dropped entities carry real stacks', dropping.liveCarryStacks === true);
  check(
    'the dropped item keeps its identity in the world',
    dropping.foundDropped === true,
    `${dropping.liveCount} live entities, none cobblestone`
  );

  // Buoyancy: an item dropped in water must float where it can be recovered.
  const buoyancy = await page.evaluate(async () => {
    const g = window.game;
    const x = Math.round(g.player.position.x) + 10;
    const z = Math.round(g.player.position.z) + 10;
    const surface = g.world.getSurfaceY(x, z);
    const top = surface - 1;

    // Carve a small pool.
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let y = top + 1; y <= top + 6; y++) g.world.setBlock(x + dx, y, z + dz, 0, { cause: 'player' });
        for (let y = top - 4; y <= top; y++) g.world.setBlock(x + dx, y, z + dz, 10 /* WATER */, { cause: 'player' });
        g.world.setBlock(x + dx, top - 5, z + dz, 1, { cause: 'player' });
      }
    }

    const item = g.entities.spawnItem(x + 0.5, top + 3, z + 0.5, 1 /* STONE */, 1);
    if (!item) return { spawned: false };
    item.velocityY = -3;
    const startY = item.y;

    // Drive the entity directly: SwiftShader's frame rate makes wall-clock
    // simulation useless (see the furnace note).
    for (let i = 0; i < 400; i++) item.update(1 / 60, g.world);

    return {
      spawned: true,
      startY,
      endY: item.y,
      inLiquid: item.inLiquid,
      // The floor of the pool is at top-5. Anything at or below that has sunk.
      poolFloor: top - 5,
      alive: item.alive,
    };
  });
  report.buoyancy = buoyancy;

  check('a test item spawned in water', buoyancy.spawned === true);
  if (buoyancy.spawned) {
    check('the item is in liquid', buoyancy.inLiquid === true);
    check(
      'the item floats rather than sinking to the floor',
      buoyancy.endY > buoyancy.poolFloor + 1,
      `y=${buoyancy.endY?.toFixed(2)} floor=${buoyancy.poolFloor}`
    );
    check('the item survives', buoyancy.alive === true);
  }

  section('Version 8 End campaign and High graphics');

  const endCampaign = await page.evaluate(async () => {
    const g = window.game;
    const out = {};
    g.ui.containerScreen.close();
    g.ui.startPlaying();

    out.switchedToEnd = g.world.switchDimension('end');
    g.sky.setDimension('end');
    g.settings.applyPreset('high');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    out.highPreset = g.settings.get('graphics.preset') === 'high';
    out.highSsao = g.settings.get('graphics.screenSpaceAmbientOcclusion') === true && Boolean(g.renderer.post._ssaoPass);
    g.player.teleport(0.5, 74, 28.5);
    for (let attempt = 0; attempt < 120 && !g.world.chunks.getChunk(0, 0)?.blocks; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    out.endChunkReady = Boolean(g.world.chunks.getChunk(0, 0)?.blocks);
    const fight = g.phase5.beginDragonFight('end');
    g.dragonRenderer.update(fight, 1 / 60);
    g.ui.update(1 / 60, g._collectDebugState());
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    out.dragonVisible = g.dragonRenderer.group.visible;
    out.crystalsVisible = g.dragonRenderer.crystals.filter((entry) => entry.crystal.visible).length;
    out.bossBarVisible = !document.querySelector('.boss-bar')?.hidden;
    out.skyDimension = g.sky._dimension;
    g._updateAudio();
    out.endAudioLoop = g.audio._loops?.has('ambient.end') ?? false;
    g._updateDragonAudio(.1);
    out.dragonMusicLoop = g.audio._loops?.has('music.dragon') ?? false;

    out.eyeTargetsStronghold = Boolean(g.phase5.throwEyeOfEnder(0, 70, 0)?.target);
    out.eyeUsed = g._tryUseItem(null, 'eye_of_ender');
    out.eyeVisible = g.eyeOfEnderRenderer?.active === true && g.eyeOfEnderRenderer.group.visible;
    out.eyeTrailPoints = g.eyeOfEnderRenderer?.trail.geometry.attributes.position.count ?? 0;
    out.outerCity = g.phase5.outerEndDestination();

    const boxX = 3, boxY = 74, boxZ = 3;
    g.world.setBlock(boxX, boxY, boxZ, 368 /* SHULKER_BOX */, { cause:'player' });
    out.shulkerStorage = g.world.getBlockEntity(boxX, boxY, boxZ)?.type ?? null;

    fight.tick(7.1);
    g.phase5.fixedUpdate(0, {
      spawnProjectile:(x,y,z,direction,options) => g.entities.spawnProjectile(x,y,z,direction,options),
    });
    out.dragonFireball = g.entities.projectiles.some((projectile) => projectile.alive && projectile.visualKind === 'dragon_fireball');

    fight.crystals.forEach((_, index) => fight.destroyCrystal(index));
    fight.damage(999, { part:'head', source:'projectile' });
    for (let index = 0; index < 82; index++) {
      g.phase5.fixedUpdate(1 / 20, {
        spawnProjectile:(x,y,z,direction,options) => g.entities.spawnProjectile(x,y,z,direction,options),
      });
      g.dragonRenderer.update(g.phase5.activeFight, 1 / 20);
      if (index === 20) {
        out.deathBurst = g.dragonRenderer.deathBurst.visible;
        out.deathBeams = g.dragonRenderer.deathBeams.filter((beam) => beam.visible).length;
      }
    }
    out.dragonDefeated = g.phase5.dragonsDefeated === 1;
    out.exitPortal = g.phase5.exitPortalOpen;
    out.gatewayWritten = g.world.getBlock(12, 71, 0) === 370 /* END_GATEWAY */;

    const ritual = [[4,0],[-4,0],[0,4],[0,-4]].map(([x,z]) =>
      g.phase5.placeRespawnCrystal(x, 74, z, 'end')
    );
    out.resummoned = ritual[3]?.ready === true && g.phase5.activeFight?.crystalsAlive === 10;
    out.arenaRegenerated = g.phase5.arenaRegeneratedBlocks > 0;
    out.ironCage = g.world.getBlock(45, 96, 0) === 371 /* IRON_BARS */;
    g.dragonRenderer.update(g.phase5.activeFight, 1 / 60);

    g.phase5.fight = null;
    g.phase5._refreshAttackables();
    g.phase5.completeStory();
    g._showCredits();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    out.creditsVisible = !document.querySelector('.story-screen')?.hidden;
    out.poemLines = document.querySelectorAll('.end-poem p').length;
    out.creditsTitle = document.querySelector('.end-credits h2')?.textContent ?? '';

    document.querySelector('.story-screen .ui-button--primary')?.click();
    out.creditsRecorded = g.phase5.creditsSeen;
    out.returnedToPlay = g.ui.screen === 'playing';

    g.world.switchDimension('overworld');
    const spawn = g.world.findSpawnPosition(0, 0);
    g.player.teleport(spawn.x, spawn.y, spawn.z);
    g.sky.setDimension('overworld');
    return out;
  });
  report.endCampaign = endCampaign;

  check('the live world switches to the End', endCampaign.switchedToEnd === true);
  check('the High preset is active in the live renderer', endCampaign.highPreset === true);
  check('High graphics builds a live SSAO pass', endCampaign.highSsao === true);
  check('the central End chunk streams before block interactions', endCampaign.endChunkReady === true);
  check('the dedicated dragon rig is visible', endCampaign.dragonVisible === true);
  check('all ten end crystals render', endCampaign.crystalsVisible === 10, `${endCampaign.crystalsVisible}`);
  check('the Ender Dragon boss bar renders', endCampaign.bossBarVisible === true);
  check('the End sky palette is active', endCampaign.skyDimension === 'end');
  check('the End ambience loop is active', endCampaign.endAudioLoop === true);
  check('the dragon battle music loop is active', endCampaign.dragonMusicLoop === true);
  check('an Eye of Ender locates a stronghold', endCampaign.eyeTargetsStronghold === true);
  check('using an Eye launches its visible flight model', endCampaign.eyeUsed === true && endCampaign.eyeVisible === true);
  check('the visible Eye carries its complete trail', endCampaign.eyeTrailPoints === 20, `${endCampaign.eyeTrailPoints}`);
  check('the gateway resolves a generated outer city', Math.hypot(endCampaign.outerCity?.x ?? 0, endCampaign.outerCity?.z ?? 0) > 300);
  check('placed shulker boxes own storage', endCampaign.shulkerStorage === 'shulker_box', String(endCampaign.shulkerStorage));
  check('the live dragon fires its custom projectile', endCampaign.dragonFireball === true);
  check('dragon death renders its burst and all beams', endCampaign.deathBurst === true && endCampaign.deathBeams === 8, `${endCampaign.deathBeams}`);
  check('the browser fight can defeat the dragon', endCampaign.dragonDefeated === true);
  check('dragon death opens the exit portal', endCampaign.exitPortal === true);
  check('dragon death creates an End gateway', endCampaign.gatewayWritten === true);
  check('four crystals resummon the dragon', endCampaign.resummoned === true);
  check('the resummon ritual regenerates damaged arena blocks', endCampaign.arenaRegenerated === true);
  check('resummoning restores a real iron-bar pillar cage', endCampaign.ironCage === true);
  check('the original End poem and credits render', endCampaign.creditsVisible === true && endCampaign.poemLines >= 7 && endCampaign.creditsTitle === 'VOXEL SANDBOX');
  check('finishing credits is recorded', endCampaign.creditsRecorded === true);
  check('credits return to playable world state', endCampaign.returnedToPlay === true);

  await shoot('16-end-campaign');

  section('Responsive layouts');
  await page.setViewportSize({ width:390, height:844 });
  await page.waitForTimeout(300);
  const phoneLayout = await page.evaluate(() => ({
    viewport:document.documentElement.clientWidth,
    bodyOverflow:document.documentElement.scrollWidth - document.documentElement.clientWidth,
    canvasWidth:document.querySelector('#game-canvas')?.getBoundingClientRect().width ?? 0,
    hotbarVisible:!document.querySelector('.hotbar')?.hidden,
  }));
  check('phone viewport renders at the requested width', phoneLayout.viewport === 390, `${phoneLayout.viewport}`);
  check('phone layout has no horizontal overflow', phoneLayout.bodyOverflow <= 1, `${phoneLayout.bodyOverflow}`);
  check('the game canvas fills the phone viewport', Math.abs(phoneLayout.canvasWidth - 390) <= 1, `${phoneLayout.canvasWidth}`);
  check('the hotbar remains visible on phone layout', phoneLayout.hotbarVisible === true);
  await shoot('17-phone-layout');
  await page.setViewportSize({ width:1024, height:640 });
  await page.waitForTimeout(200);

  // The controls reference must be generated and must name the new drop key.
  const controls = await page.evaluate(async () => {
    const g = window.game;
    g.ui.openSettings('menu');
    await new Promise((r) => setTimeout(r, 200));

    // Switch to the Controls section.
    const tabs = [...document.querySelectorAll('button')];
    const controlsTab = tabs.find((b) => /^controls$/i.test(b.textContent.trim()));
    controlsTab?.click();
    await new Promise((r) => setTimeout(r, 200));

    const reference = document.querySelector('.controls-reference');
    const text = reference?.textContent ?? '';
    const rows = document.querySelectorAll('.controls-row').length;

    // Scroll it into view. The settings body scrolls, so the reference sits below
    // the fold — and a screenshot that does not show it proves nothing about how
    // it looks.
    reference?.scrollIntoView({ block: 'end' });
    await new Promise((r) => setTimeout(r, 200));
    const box = reference?.getBoundingClientRect();
    const onScreen = Boolean(box && box.top < window.innerHeight && box.bottom > 0);

    // Deliberately left open so the screenshot below captures it; closed after.
    return { present: Boolean(reference), rows, text, onScreen };
  });
  report.controls = controls;

  check('a controls reference is rendered', controls.present === true);
  check('it lists many actions', controls.rows > 10, `${controls.rows} rows`);
  check('it documents dropping one item', /Drop one item/i.test(controls.text));
  check('it documents dropping a stack', /Drop whole stack/i.test(controls.text));
  check('it mentions touch controls', /touch/i.test(controls.text));
  check('the reference is reachable by scrolling', controls.onScreen === true);

  await shoot('15-controls');
  // Close only after capturing, and return to gameplay for the reload section.
  await page.evaluate(() => {
    window.game.ui.closeSettings();
    window.game.ui.startPlaying();
  });
  await page.waitForTimeout(200);

  section('Reload persistence');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.game !== 'undefined', null, { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('#boot-screen'), null, {
    timeout: 90000,
  });
  const reloaded = await page.evaluate(async () => {
    const worlds = await window.game.saveManager.listWorlds();
    return { count: worlds.length, name: worlds[0]?.name ?? null, seed: worlds[0]?.seed ?? null };
  });
  check('the saved world survives a reload', reloaded.count > 0, JSON.stringify(reloaded));
  check('the saved world keeps its name', reloaded.name === 'Smoke Test', String(reloaded.name));
  await shoot('05-after-reload');

  section('Console health');
  check(
    'no unexpected console errors',
    logs.errors.length === 0,
    logs.errors.slice(0, 4).join(' | ')
  );
  report.console = logs.errors;
} catch (error) {
  failures++;
  process.stdout.write(`\n\x1b[31mSmoke test threw: ${error?.stack || error}\x1b[0m\n`);
  report.error = String(error?.stack || error);
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages.length > 0) await pages[pages.length - 1].screenshot({ path: join(OUT, '99-failure.png') });
  } catch {
    /* screenshot is best effort */
  }
} finally {
  await browser.close();
  production.server.close();
  instrumented.server.close();
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
}

process.stdout.write(
  `\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} browser checks passed\x1b[0m\n`
);
process.stdout.write(`artifacts in ${OUT}\n`);
process.exit(failures === 0 ? 0 : 1);
