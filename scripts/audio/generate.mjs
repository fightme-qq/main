/**
 * Batch generator for the ElevenLabs sound library.
 *
 * ## What it does
 *
 * Reads the catalogue, skips files that already exist, requests the rest from
 * the official Sound Effects endpoint, writes them under `public/assets/audio/`
 * and keeps `manifest.json` and a build report up to date after every file.
 *
 * ## Safety rules (from the project plan)
 *
 *  - the API key is read from `ELEVENLABS_API_KEY` only, never from a file, and
 *    is never printed or written anywhere;
 *  - the script runs offline (it is a developer tool, the browser never sees it);
 *  - existing files are not regenerated without `--force`;
 *  - retries are bounded and rate limits are respected via `--concurrency`;
 *  - if the account cannot use sound effects the script stops instead of writing
 *    placeholders — a silent placeholder is worse than a missing file.
 *
 * ## Usage
 *
 * ```
 * npm run audio:generate -- --dry-run
 * npm run audio:generate -- --only=player_hurt_01,ui_item_select_01
 * npm run audio:generate -- --category=horror --concurrency=2
 * npm run audio:generate -- --force --only=amb_forest_night_01
 * ```
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SOUNDS, promptFor } from './catalogue.mjs';
import {
  AUDIO_ROOT,
  MANIFEST_PATH,
  REPORT_PATH,
  absoluteFileFor,
  buildManifest,
  fileFor,
  formatBytes,
  readManifest,
  sleep,
  writeJsonAtomic,
} from './shared.mjs';

const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation';
/** Music has its own endpoint and a different request body. */
const MUSIC_ENDPOINT = 'https://api.elevenlabs.io/v1/music';
/** Deliverable format. MP3 decodes in every browser; raw Opus from the API is not
 * an Ogg container and cannot be handed to `decodeAudioData`. */
const OUTPUT_FORMAT = 'mp3_44100_128';
const MIN_VALID_BYTES = 4096;
const MAX_ATTEMPTS = 4;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    force: false,
    only: null,
    category: null,
    limit: Infinity,
    concurrency: 2,
    quiet: false,
  };
  for (const argument of argv) {
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--quiet') options.quiet = true;
    else if (argument.startsWith('--only=')) {
      options.only = argument.slice('--only='.length).split(',').map((id) => id.trim()).filter(Boolean);
    } else if (argument.startsWith('--category=')) options.category = argument.slice('--category='.length);
    else if (argument.startsWith('--limit=')) options.limit = Math.max(0, Number(argument.slice('--limit='.length)) || 0);
    else if (argument.startsWith('--concurrency=')) {
      options.concurrency = Math.min(6, Math.max(1, Number(argument.slice('--concurrency='.length)) || 1));
    } else if (argument === '--help' || argument === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument "${argument}" (use --help)`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Generate the ElevenLabs sound library.

  --dry-run            List what would be generated, make no requests.
  --only=id1,id2       Restrict to these catalogue ids.
  --category=NAME      Restrict to environment|player|world|creature|horror|ui.
  --limit=N            Stop after N requests (use 3-5 for a first quality check).
  --force              Regenerate even when a valid file already exists.
  --concurrency=N      Parallel requests, 1-6 (default 2).
  --quiet              Only print the summary.

Requires ELEVENLABS_API_KEY in the environment.`);
}

function requireKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || key.trim().length < 20) {
    console.error(
      'ELEVENLABS_API_KEY is missing or too short.\n' +
        'Export it in your shell (never commit it):\n' +
        '  PowerShell: $env:ELEVENLABS_API_KEY="..."\n' +
        '  bash:       export ELEVENLABS_API_KEY="..."'
    );
    process.exit(2);
  }
  return key.trim();
}

/** Selects the catalogue entries the flags ask for. */
function selectEntries(options) {
  let entries = SOUNDS;
  if (options.only) {
    const wanted = new Set(options.only);
    const unknown = options.only.filter((id) => !SOUNDS.some((sound) => sound.id === id));
    if (unknown.length > 0) throw new Error(`Unknown catalogue ids: ${unknown.join(', ')}`);
    entries = entries.filter((entry) => wanted.has(entry.id));
  }
  if (options.category) {
    const known = new Set(SOUNDS.map((sound) => sound.category));
    if (!known.has(options.category)) {
      throw new Error(`Unknown category "${options.category}" (expected ${[...known].join(', ')})`);
    }
    entries = entries.filter((entry) => entry.category === options.category);
  }
  if (Number.isFinite(options.limit)) entries = entries.slice(0, options.limit);
  return entries;
}

/** True when a file exists and is plausibly a real audio payload. */
async function hasValidFile(path) {
  if (!existsSync(path)) return false;
  try {
    const info = await stat(path);
    return info.isFile() && info.size >= MIN_VALID_BYTES;
  } catch {
    return false;
  }
}

/** One API request with bounded retries. Returns the audio bytes. */
async function requestSound(key, entry, attempt = 1) {
  const isMusic = entry.api === 'music';
  const body = isMusic
    ? JSON.stringify({
        prompt: promptFor(entry),
        music_length_ms: Math.round(entry.seconds * 1000),
        model_id: 'music_v1',
        force_instrumental: true,
      })
    : JSON.stringify({
        text: promptFor(entry),
        duration_seconds: entry.seconds,
        prompt_influence: 0.45,
        loop: entry.loop,
      });
  const url = `${isMusic ? MUSIC_ENDPOINT : ENDPOINT}?output_format=${OUTPUT_FORMAT}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': key,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body,
    signal: AbortSignal.timeout(240_000),
  });

  if (response.ok) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < MIN_VALID_BYTES) {
      throw new Error(`response was only ${buffer.length} bytes`);
    }
    return buffer;
  }

  const detail = await response.text().catch(() => '');
  const retryable = response.status === 429 || response.status >= 500;
  if (retryable && attempt < MAX_ATTEMPTS) {
    const delay = 3_000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
    if (!optionsQuiet()) {
      console.warn(`    ${entry.id}: HTTP ${response.status}, retrying in ${(delay / 1000).toFixed(0)}s`);
    }
    await sleep(delay);
    return requestSound(key, entry, attempt + 1);
  }
  // 401/403/422 mean the account or the request is wrong; retrying cannot help.
  throw new Error(`HTTP ${response.status}: ${detail.slice(0, 300)}`);
}

let quietFlag = false;
function optionsQuiet() {
  return quietFlag;
}

async function generateOne(key, entry) {
  const path = absoluteFileFor(entry);
  await mkdir(join(AUDIO_ROOT, entry.category), { recursive: true });

  const started = Date.now();
  const buffer = await requestSound(key, entry);
  const temporary = `${path}.part`;
  await writeFile(temporary, buffer);
  await rename(temporary, path);

  return {
    entry,
    path,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    elapsedMs: Date.now() - started,
  };
}

function manifestEntry(entry, result) {
  return {
    file: fileFor(entry),
    category: entry.category,
    loop: entry.loop,
    requestedSeconds: entry.seconds,
    // Replaced with the measured value by `qc.mjs`; the requested duration is a
    // hint, and the game must not assume the service obeyed it.
    seconds: entry.seconds,
    bytes: result.bytes,
    sha256: result.sha256,
    generatedAt: new Date().toISOString(),
    prompt: promptFor(entry),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  quietFlag = options.quiet;
  const entries = selectEntries(options);
  if (entries.length === 0) {
    console.log('Nothing selected.');
    return;
  }

  console.log(`Catalogue selection: ${entries.length} sound(s).`);
  const key = options.dryRun ? null : requireKey();

  const previous = await readManifest();
  /** @type {Record<string, Object>} */
  const manifestEntries = { ...previous.entries };
  const report = {
    startedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    musicEndpoint: MUSIC_ENDPOINT,
    outputFormat: OUTPUT_FORMAT,
    requested: entries.length,
    generated: [],
    skipped: [],
    failed: [],
  };

  if (options.dryRun) {
    for (const entry of entries) {
      const exists = await hasValidFile(absoluteFileFor(entry));
      const willGenerate = options.force || !exists;
      console.log(
        `  ${willGenerate ? 'generate' : 'skip    '}  ${entry.id.padEnd(30)} ` +
          `${String(entry.seconds).padStart(2)}s ${entry.loop ? 'loop' : '    '}  ${fileFor(entry)}`
      );
    }
    console.log('\nDry run: no requests were made.');
    return;
  }

  // Report progress as it happens: a mass generation can take many minutes and a
  // crash halfway must not lose the record of what was already paid for. Writes
  // are serialised because several workers share the same two files.
  let flushChain = Promise.resolve();
  const flushReport = () => {
    flushChain = flushChain
      .then(async () => {
        await writeJsonAtomic(REPORT_PATH, report);
        await writeJsonAtomic(MANIFEST_PATH, buildManifest(SOUNDS, manifestEntries));
      })
      // A failed report write must not mark a successfully generated sound as a
      // failure; the next flush writes the same state again.
      .catch((error) => console.error(`  report write failed: ${error.message}`));
    return flushChain;
  };

  const queue = entries.slice();
  let index = 0;

  const worker = async () => {
    while (index < queue.length) {
      const entry = queue[index++];
      const path = absoluteFileFor(entry);
      if (!options.force && (await hasValidFile(path))) {
        const size = (await stat(path)).size;
        report.skipped.push({ id: entry.id, bytes: size });
        // A file can exist from an earlier run while the manifest lost its entry
        // (interrupted write); rebuild it instead of re-generating audio.
        if (!manifestEntries[entry.id]) {
          const buffer = await readFile(path);
          manifestEntries[entry.id] = manifestEntry(entry, {
            bytes: buffer.length,
            sha256: createHash('sha256').update(buffer).digest('hex'),
          });
          await flushReport();
        }
        if (!quietFlag) console.log(`  skip    ${entry.id}`);
        continue;
      }

      try {
        if (!quietFlag) console.log(`  request ${entry.id} (${entry.seconds}s)…`);
        const result = await generateOne(key, entry);
        manifestEntries[entry.id] = manifestEntry(entry, result);
        report.generated.push({
          id: entry.id,
          bytes: result.bytes,
          elapsedMs: result.elapsedMs,
          sha256: result.sha256,
        });
        console.log(
          `  ok      ${entry.id.padEnd(30)} ${formatBytes(result.bytes)} ` +
            `in ${(result.elapsedMs / 1000).toFixed(1)}s`
        );
        await flushReport();
      } catch (error) {
        // One bad file must not abort a paid batch; record it and continue.
        report.failed.push({ id: entry.id, error: String(error.message || error) });
        console.error(`  FAILED  ${entry.id}: ${error.message || error}`);
        await flushReport();
      }
    }
  };

  const started = Date.now();
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, queue.length) }, () => worker())
  );

  report.finishedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - started;
  report.totalBytes =
    report.generated.reduce((sum, item) => sum + item.bytes, 0) +
    report.skipped.reduce((sum, item) => sum + item.bytes, 0);
  await flushReport();

  console.log(
    `\nDone: ${report.generated.length} generated, ${report.skipped.length} skipped, ` +
      `${report.failed.length} failed, ${formatBytes(report.totalBytes)} on disk ` +
      `in ${(report.elapsedMs / 1000).toFixed(0)}s.`
  );
  console.log(`Manifest: ${MANIFEST_PATH}`);
  console.log(`Report:   ${REPORT_PATH}`);
  if (report.failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
