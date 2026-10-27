/**
 * Quality control for the generated sound library.
 *
 * ## Why a browser does the measuring
 *
 * The delivered files are MP3, and Node has no decoder for them. Chromium does —
 * and it is already installed for the browser self-tests — so the script serves
 * `public/`, decodes each file through `OfflineAudioContext.decodeAudioData` and
 * reads the samples back. That measures exactly the thing the game will play,
 * with no extra dependency and no re-encoding.
 *
 * ## What is checked
 *
 *  - the file decodes at all (a truncated download fails here);
 *  - it is not silent (peak and RMS floors);
 *  - it is not clipped (fraction of samples at full scale);
 *  - it does not begin or end with a long empty tail, which would put a hole in a
 *    loop or a delay before a footstep;
 *  - the measured duration overwrites the *requested* duration in the manifest,
 *    because the API is free to return something shorter.
 *
 * Usage: `npm run audio:qc`
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

import { chromium } from 'playwright';

import { SOUNDS } from './catalogue.mjs';
import { MANIFEST_PATH, ROOT, emptyManifest, formatBytes } from './shared.mjs';

const QUALITY_REPORT = join(ROOT, 'assets', 'audio', 'quality-report.json');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
  '.ogg': 'audio/ogg',
};

/** Silence is anything below -60 dBFS. */
const SILENCE = 0.001;
const MIN_PEAK = 0.02;
const MAX_CLIPPING_SHARE = 0.002;
const MAX_LEADING_SILENCE = 0.6;
const MAX_TRAILING_SILENCE = 1.2;
const MIN_DURATION = 0.2;

/**
 * Loudness targets per category.
 *
 * The model returns whatever level it likes: the generated footstep peaked at
 * -24 dBFS while a crackle loop peaked near full scale. Rather than hard-code a
 * gain per file, QC measures RMS and stores a normalisation gain in the manifest,
 * so the mixer starts from a consistent loudness and the category sliders do the
 * artistic part.
 */
const TARGET_RMS = {
  environment: 0.035,
  player: 0.06,
  world: 0.06,
  creature: 0.06,
  horror: 0.06,
  ui: 0.05,
};
const MAX_GAIN = 6;
const MIN_GAIN = 0.5;

function startServer(root) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    // A real page at the root gives the QC page a same-origin context, so `fetch`
    // of the audio files needs no CORS handling.
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><body>audio qc</body></html>');
      return;
    }
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

/** Finds the Playwright Chromium when the package revision and download drifted. */
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

async function main() {
  const manifestPath = MANIFEST_PATH;

  const host = await startServer(join(ROOT, 'public'));
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
    (process.platform === 'win32' ? findPlaywrightChromium() : undefined);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${host.port}/`, { waitUntil: 'load' });

    for (const entry of SOUNDS) {
      const filePath = join(ROOT, 'public', 'assets', 'audio', entry.category, `${entry.id}.mp3`);
      if (!existsSync(filePath)) {
        // Not generated yet is not a quality failure: a partial batch is a normal,
        // resumable state.
        results.push({ id: entry.id, category: entry.category, status: 'missing' });
        continue;
      }
      const url = `http://127.0.0.1:${host.port}/assets/audio/${entry.category}/${entry.id}.mp3`;
      const stats = await page.evaluate(async ({ source }) => {
        try {
          const response = await fetch(source);
          if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
          const buffer = await response.arrayBuffer();
          const bytes = buffer.byteLength;
          const context = new OfflineAudioContext(1, 1, 44100);
          const audio = await context.decodeAudioData(buffer);
          let peak = 0;
          let sumSquares = 0;
          let clipped = 0;
          let samples = 0;
          let firstAudible = -1;
          let lastAudible = -1;
          for (let channel = 0; channel < audio.numberOfChannels; channel++) {
            const data = audio.getChannelData(channel);
            for (let i = 0; i < data.length; i++) {
              const value = data[i];
              const magnitude = Math.abs(value);
              if (magnitude > peak) peak = magnitude;
              sumSquares += value * value;
              if (magnitude >= 0.999) clipped++;
              samples++;
              if (magnitude > 0.001) {
                if (firstAudible < 0) firstAudible = i;
                lastAudible = i;
              }
            }
          }
          const rate = audio.sampleRate;
          const length = audio.length;

          // Count loud transients separated by at least 150 ms. A footstep must be
          // exactly one; the first batch occasionally rendered two steps in a
          // one-second file, which is what made running sound like a loop.
          const first = audio.getChannelData(0);
          const threshold = peak * 0.5;
          let transients = 0;
          let lastAbove = -Infinity;
          for (let i = 0; i < first.length; i++) {
            if (Math.abs(first[i]) <= threshold) continue;
            if (i - lastAbove > rate * 0.15) transients++;
            lastAbove = i;
          }

          return {
            ok: true,
            bytes,
            duration: audio.duration,
            sampleRate: rate,
            channels: audio.numberOfChannels,
            peak,
            rms: Math.sqrt(sumSquares / Math.max(1, samples)),
            clippingShare: clipped / Math.max(1, samples),
            leadingSilence: firstAudible < 0 ? audio.duration : firstAudible / rate,
            trailingSilence: lastAudible < 0 ? audio.duration : (length - lastAudible) / rate,
            transients,
          };
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      }, { source: url });

      if (!stats.ok) {
        results.push({ id: entry.id, category: entry.category, ok: false, error: stats.error });
        console.log(`  FAIL  ${entry.id}: ${stats.error}`);
        continue;
      }

      const problems = [];
      if (stats.duration < MIN_DURATION) problems.push(`too short (${stats.duration.toFixed(2)}s)`);
      if (stats.peak < MIN_PEAK) problems.push(`near-silent (peak ${stats.peak.toFixed(3)})`);
      if (stats.clippingShare > MAX_CLIPPING_SHARE) {
        problems.push(`clipping (${(stats.clippingShare * 100).toFixed(2)}%)`);
      }
      if (stats.leadingSilence > MAX_LEADING_SILENCE) {
        problems.push(`leading silence ${stats.leadingSilence.toFixed(1)}s`);
      }
      if (stats.trailingSilence > MAX_TRAILING_SILENCE) {
        problems.push(`trailing silence ${stats.trailingSilence.toFixed(1)}s`);
      }
      if (entry.id.startsWith('player_footstep') && stats.transients > 1) {
        problems.push(`multiple impacts in one footstep (${stats.transients})`);
      }

      results.push({
        id: entry.id,
        category: entry.category,
        status: 'checked',
        loop: entry.loop,
        ok: problems.length === 0,
        problems,
        ...stats,
      });
      const label = problems.length === 0 ? 'ok  ' : 'warn';
      console.log(
        `  ${label}  ${entry.id.padEnd(30)} ${stats.duration.toFixed(2)}s ` +
          `${formatBytes(stats.bytes)} peak=${stats.peak.toFixed(2)} ` +
          `rms=${stats.rms.toFixed(3)} lead=${stats.leadingSilence.toFixed(2)}s ` +
          `tail=${stats.trailingSilence.toFixed(2)}s` +
          (problems.length ? `  ${problems.join('; ')}` : '')
      );
    }
  } finally {
    await browser.close();
    host.server.close();
  }

  // Update the manifest's measured durations. A requested 30s file that came back
  // as 28.4s must be recorded as 28.4s.
  const measured = new Map(results.filter((r) => r.ok !== false && r.duration).map((r) => [r.id, r]));
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : emptyManifest();
  for (const [id, entry] of Object.entries(manifest.entries ?? {})) {
    const stats = measured.get(id);
    if (stats) {
      entry.seconds = Math.round(stats.duration * 100) / 100;
      entry.bytes = stats.bytes;
      entry.channels = stats.channels;
      entry.sampleRate = stats.sampleRate;
      const target = TARGET_RMS[entry.category] ?? 0.06;
      const wanted = target / Math.max(stats.rms, 1e-4);
      // Never normalise into clipping: the peak cap wins over the RMS target.
      const peakCap = 0.95 / Math.max(stats.peak, 1e-4);
      entry.gain = Math.round(Math.min(MAX_GAIN, Math.max(MIN_GAIN, Math.min(wanted, peakCap))) * 100) / 100;
    }
  }
  manifest.qualityCheckedAt = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  mkdirSync(join(ROOT, 'assets', 'audio'), { recursive: true });
  writeFileSync(
    QUALITY_REPORT,
    `${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`,
    'utf8'
  );

  const checked = results.filter((result) => result.status === 'checked');
  const failed = checked.filter((result) => result.ok === false).length;
  const warned = checked.filter((result) => result.problems.length > 0).length;
  const missing = results.filter((result) => result.status === 'missing').length;
  console.log(
    `\nQC: ${checked.length - failed - warned} clean, ${warned} with warnings, ` +
      `${failed} unreadable, ${missing} not generated yet.`
  );
  console.log(`Report: ${QUALITY_REPORT}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
