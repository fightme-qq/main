/**
 * Atmospheric tuning: how far the player can see, and how much that changes.
 *
 * ## Why fog distance is data
 *
 * The linear fog used by the voxel shader is defined by `near` and `far` in
 * blocks. Before this module both came straight from the render distance and the
 * fog slider, so a midnight forest and a noon desert had exactly the same
 * visibility — the night was merely *darker*, which a player can simply turn up
 * the brightness to defeat. Visibility is the part of night that actually
 * constrains movement, so it is driven by biome and time rather than by colour.
 *
 * The multiplier here scales `far`:
 *
 *  - `< 1` — shorter sight lines (forest, swamp, night, low ground, caves);
 *  - `> 1` — longer sight lines (desert, plains, high altitude).
 *
 * ## Smoothing
 *
 * `fogVisibilityFactor` is pure and stateless; the renderer smooths its result
 * over about half a second. That matters at biome borders: snapping the fog to a
 * new distance as the player crosses an invisible line is one of the most
 * obviously artificial things a voxel game can do.
 *
 * Pure data and pure functions, so the self-test can assert the ordering
 * (swamp foggier than plains at night, day clearer than night) without a browser.
 */

import { SEA_LEVEL } from './GameConfig.js';
import { clamp, smoothstep } from '../utils/MathUtils.js';

/**
 * Per-biome daytime and night-time visibility multipliers.
 *
 * `tint` is an optional cold/green cast applied to the fog colour — a fraction of
 * a colour step, not a filter. Anything unlisted falls back to `DEFAULT_PROFILE`,
 * which keeps new biomes from silently inheriting swamp fog.
 *
 * @typedef {Object} BiomeFogProfile
 * @property {number} day Multiplier applied at full daylight.
 * @property {number} night Multiplier applied in full darkness.
 * @property {[number, number, number]} [tint] Fog colour multiplier.
 */

/** @type {Readonly<BiomeFogProfile>} */
export const DEFAULT_FOG_PROFILE = Object.freeze({ day: 1, night: 0.92, tint: [1, 1, 1] });

/**
 * Global night visibility as a fraction of the render distance.
 *
 * This is deliberately independent of the per-biome pair above: the biome table
 * says "this place is foggier than that place", while this constant says "night
 * costs you half your sight". Keeping them separate is what stops a clear plains
 * night from being as open as the day just because its biome profile is 1.
 */
export const NIGHT_VISIBILITY = 0.55;

/**
 * Global daytime visibility cap.
 *
 * A crisp, endlessly visible noon is the single strongest reminder that this is a
 * sandbox. Even in clear weather the far plane is pulled to 78% of what the render
 * distance allows, so there is always haze at the horizon and the world never looks
 * entirely safe. Night keeps its own, much stronger penalty below.
 */
export const DAY_VISIBILITY = 0.78;

/** @type {Readonly<Record<string, Readonly<BiomeFogProfile>>>} */
export const FOG_BIOME_PROFILES = Object.freeze({
  // Dense canopy: the reference "you cannot see the next tree" biome.
  Forest: Object.freeze({ day: 0.9, night: 0.8, tint: [0.94, 1, 0.98] }),
  'Birch Forest': Object.freeze({ day: 0.92, night: 0.83 }),
  'Flower Forest': Object.freeze({ day: 0.94, night: 0.86 }),
  'Dark Forest': Object.freeze({ day: 0.8, night: 0.7, tint: [0.9, 0.98, 0.94] }),
  Taiga: Object.freeze({ day: 0.9, night: 0.8 }),
  'Old Growth Pine Taiga': Object.freeze({ day: 0.84, night: 0.74 }),
  'Old Growth Spruce Taiga': Object.freeze({ day: 0.84, night: 0.74 }),
  'Snowy Taiga': Object.freeze({ day: 0.86, night: 0.78 }),
  Jungle: Object.freeze({ day: 0.84, night: 0.74 }),
  'Bamboo Jungle': Object.freeze({ day: 0.82, night: 0.72 }),
  'Sparse Jungle': Object.freeze({ day: 0.88, night: 0.8 }),
  'Cherry Grove': Object.freeze({ day: 0.93, night: 0.86 }),

  // Wet lowlands: the worst visibility on purpose. This is where getting lost
  // should be a real risk rather than an inconvenience.
  Swamp: Object.freeze({ day: 0.7, night: 0.56, tint: [0.92, 1, 0.9] }),
  'Mangrove Swamp': Object.freeze({ day: 0.68, night: 0.54, tint: [0.92, 1, 0.9] }),

  // Open ground: creatures are visible from far away, which is its own tension.
  Plains: Object.freeze({ day: 1.06, night: 1 }),
  'Sunflower Plains': Object.freeze({ day: 1.06, night: 1 }),
  Meadow: Object.freeze({ day: 1.04, night: 0.98 }),
  Savanna: Object.freeze({ day: 1.08, night: 1.02 }),
  'Savanna Plateau': Object.freeze({ day: 1.08, night: 1.02 }),
  Desert: Object.freeze({ day: 1.12, night: 1.05, tint: [1.03, 1, 0.96] }),
  Badlands: Object.freeze({ day: 1.08, night: 1.02 }),
  'Wooded Badlands': Object.freeze({ day: 1.02, night: 0.95 }),
  'Eroded Badlands': Object.freeze({ day: 1.08, night: 1.02 }),
  'Snowy Plains': Object.freeze({ day: 1.02, night: 0.94 }),
  'Ice Spikes': Object.freeze({ day: 1.02, night: 0.94 }),
  MushroomFields: Object.freeze({ day: 0.9, night: 0.82 }),

  // Coast and sea.
  Ocean: Object.freeze({ day: 1, night: 0.9 }),
  'Frozen Ocean': Object.freeze({ day: 0.94, night: 0.84 }),
  'Cold Ocean': Object.freeze({ day: 0.98, night: 0.88 }),
  'Lukewarm Ocean': Object.freeze({ day: 1, night: 0.9 }),
  'Warm Ocean': Object.freeze({ day: 1, night: 0.9 }),
  'Deep Ocean': Object.freeze({ day: 0.98, night: 0.88 }),
  Beach: Object.freeze({ day: 1.04, night: 0.96 }),
  'Stony Shore': Object.freeze({ day: 1.02, night: 0.94 }),
  River: Object.freeze({ day: 1, night: 0.9 }),
  'Frozen River': Object.freeze({ day: 0.96, night: 0.86 }),

  // High ground: you can see the weather coming.
  RockyHills: Object.freeze({ day: 0.98, night: 0.92 }),
  Mountains: Object.freeze({ day: 1.02, night: 0.96 }),
  'Snowy Peaks': Object.freeze({ day: 1.05, night: 0.98 }),
  'Windswept Hills': Object.freeze({ day: 1.04, night: 0.98 }),
  Grove: Object.freeze({ day: 0.9, night: 0.8 }),
});

/**
 * Visibility multiplier for the current place and time.
 *
 * @param {Object} input
 * @param {string} [input.biomeName] Biome display name from `World.getBiomeNameAt`.
 * @param {number} [input.daylight] 0 at night, 1 at midday.
 * @param {number} [input.y] Camera height in blocks.
 * @param {number} [input.extraDensity] 0..1 temporary fog thickening (events, weather).
 * @returns {number} Multiplier for the fog far distance, clamped to a sane band.
 */
export function fogVisibilityFactor({
  biomeName = 'Plains',
  daylight = 1,
  y = SEA_LEVEL,
  extraDensity = 0,
} = {}) {
  const profile = FOG_BIOME_PROFILES[biomeName] ?? DEFAULT_FOG_PROFILE;
  const light = clamp(daylight, 0, 1);
  // Two independent effects: the global night penalty, and the biome's own
  // day/night character. Multiplying them keeps a foggy biome foggy in daylight
  // and a clear one still constrained at night.
  const nightPenalty = NIGHT_VISIBILITY + (1 - NIGHT_VISIBILITY) * light;
  // Daytime haze: full strength at noon, absent at night where the night penalty
  // already does the work.
  const dayHaze = DAY_VISIBILITY + (1 - DAY_VISIBILITY) * (1 - light);
  let factor = nightPenalty * dayHaze * (profile.night + (profile.day - profile.night) * light);

  // Low ground holds moisture and mist; ridgelines clear. The band is generous
  // because the interesting part is "valley is worse than hill", not a precise
  // pressure model.
  const lowland = 1 - smoothstep(SEA_LEVEL - 12, SEA_LEVEL + 34, y);
  factor *= 1 - lowland * (0.1 + (1 - light) * 0.14);

  // High altitude thins the fog slightly, which also rewards climbing for a view.
  const altitude = smoothstep(SEA_LEVEL + 48, SEA_LEVEL + 110, y);
  factor *= 1 + altitude * 0.08;

  factor *= 1 - clamp(extraDensity, 0, 1) * 0.55;
  return clamp(factor, 0.32, 1.3);
}

/**
 * How much a camera depth inside the world should close the fog in.
 *
 * A cave should not read like the surface at night: the surface has a sky, and a
 * cave has a wall behind every direction. Returns 0 at the surface and 1 well
 * underground.
 *
 * @param {number} y Camera height.
 * @returns {number}
 */
export function caveFogAmount(y) {
  return 1 - smoothstep(SEA_LEVEL - 46, SEA_LEVEL - 4, y);
}

/**
 * Fog colour tint for a biome, mixed towards neutral so it stays subtle.
 *
 * @param {string} biomeName
 * @returns {[number, number, number]}
 */
export function fogBiomeTint(biomeName) {
  return (FOG_BIOME_PROFILES[biomeName] ?? DEFAULT_FOG_PROFILE).tint ?? [1, 1, 1];
}

/** Seconds between biome probes, per graphics tier. Cheap but not every frame. */
export const BIOME_PROBE_INTERVAL = Object.freeze({ potato: 0.75, low: 0.5, medium: 0.3, high: 0.2 });

/** Seconds over which a visibility change is eased in. */
export const FOG_EASE_SECONDS = 0.55;

export default fogVisibilityFactor;
