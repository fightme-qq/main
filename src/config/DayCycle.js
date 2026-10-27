/**
 * Day-cycle phases: the shared vocabulary for "what time is it".
 *
 * The keyframes, the fog curves, the music director, the ambience and the tests
 * all need to agree on where day ends and dusk begins. That agreement lives here
 * rather than inside `LightingSystem`, because `LightingSystem` pulls in shaders
 * and materials and therefore cannot be imported by a Node self-test.
 *
 * Pure data and pure functions: no Three.js, no DOM.
 */

import { smoothstep } from '../utils/MathUtils.js';

/**
 * Day/night split, chosen for the horror pacing rather than for realism:
 *
 * - dawn 0.15–0.24 (early edges of the `dusk` phase);
 * - day 0.24–0.52;
 * - dusk 0.52–0.69;
 * - night 0.69–0.15.
 *
 * At 20 real minutes per cycle that is roughly 5.5 minutes of daylight, 3.5 of
 * dusk and 9 of night.
 */
export const DAYLIGHT_RISE = Object.freeze([0.15, 0.24]);
export const DAYLIGHT_FALL = Object.freeze([0.52, 0.69]);

/**
 * 0 at night, 1 at midday, ramping across dawn and dusk.
 * Mirrors `LightingSystem._evaluateSky`; the two must not drift.
 *
 * @param {number} timeOfDay 0..1.
 * @returns {number}
 */
export function daylightAt(timeOfDay) {
  const t = ((timeOfDay % 1) + 1) % 1;
  return t < 0.5
    ? smoothstep(DAYLIGHT_RISE[0], DAYLIGHT_RISE[1], t)
    : 1 - smoothstep(DAYLIGHT_FALL[0], DAYLIGHT_FALL[1], t);
}

/**
 * Classifies a time of day into a gameplay phase.
 *
 * @param {number} timeOfDay 0..1, 0 being midnight.
 * @param {Object} [options]
 * @param {boolean} [options.underground] Depth overrides the sky entirely.
 * @returns {'night'|'day'|'dusk'|'cave'}
 */
export function phaseAt(timeOfDay, { underground = false } = {}) {
  if (underground) return 'cave';
  const t = ((timeOfDay % 1) + 1) % 1;
  // Windows, not brightness thresholds: the keyframes put sunrise at 0.22 and
  // nightfall at 0.70, and a brightness test would let the flat top of the
  // smoothstep stretch "day" over a third of the cycle.
  if (t >= 0.24 && t < 0.52) return 'day';
  if (t >= 0.52 && t < 0.70) return 'dusk';
  // Dawn uses the same transition bed as dusk.
  if (t >= 0.15 && t < 0.24) return 'dusk';
  return 'night';
}

export default phaseAt;
