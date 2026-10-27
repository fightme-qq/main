/**
 * Shared plumbing for the audio tooling: paths, manifest shape, atomic writes.
 *
 * The manifest is the contract between the offline generator and the browser, so
 * it lives in one place and both sides build it through these helpers. The game
 * reads `public/assets/audio/manifest.json`; nothing else in the repository is
 * allowed to guess a sound's path.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** Shipped audio, served by the browser. */
export const AUDIO_ROOT = join(ROOT, 'public', 'assets', 'audio');
/** Runtime manifest read by `AudioManager`. */
export const MANIFEST_PATH = join(AUDIO_ROOT, 'manifest.json');
/** Build-time report; deliberately outside `public/` so it is not shipped. */
export const REPORT_PATH = join(ROOT, 'assets', 'audio', 'generation-report.json');

export const MANIFEST_VERSION = 1;
export const AUDIO_FORMAT = 'mp3';

/** Relative path of the audio file for one catalogue entry. */
export function fileFor(entry) {
  return `${entry.category}/${entry.id}.${AUDIO_FORMAT}`;
}

/** Absolute path of the audio file for one catalogue entry. */
export function absoluteFileFor(entry) {
  return join(AUDIO_ROOT, fileFor(entry));
}

/**
 * Writes JSON atomically.
 *
 * A crashed or interrupted generator must never leave a half-written manifest:
 * the browser would then fail to parse it and lose *every* sound, not just the
 * one being generated. The temporary name is unique per call because the
 * generator writes from several workers at once — a shared `.tmp` path makes two
 * renames race and one of them fail with ENOENT.
 */
let temporaryCounter = 0;
export async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${temporaryCounter++}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

/** Reads the manifest, or returns an empty one when it does not exist yet. */
export async function readManifest() {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.entries ? parsed : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

export function emptyManifest() {
  return {
    version: MANIFEST_VERSION,
    format: AUDIO_FORMAT,
    generatedAt: null,
    entries: {},
  };
}

/**
 * Assembles the manifest from catalogue order plus whatever has been generated.
 *
 * @param {ReadonlyArray<import('./catalogue.mjs').SoundEntry>} catalogue
 * @param {Record<string, Object>} entries Entries keyed by id, possibly partial.
 */
export function buildManifest(catalogue, entries) {
  const ordered = {};
  for (const sound of catalogue) {
    const entry = entries[sound.id];
    if (entry) ordered[sound.id] = entry;
  }
  return {
    version: MANIFEST_VERSION,
    format: AUDIO_FORMAT,
    generatedAt: new Date().toISOString(),
    entries: ordered,
  };
}

/** Human-readable byte size for the console summary. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Sleep helper for the retry backoff. */
export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
