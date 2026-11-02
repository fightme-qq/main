/**
 * Where a colossus stands.
 *
 * The creature is placed, not spawned: it is a landmark, and a landmark has to
 * be *visible* from the place the player starts. That makes this a search
 * problem rather than a random pick -- a colossus in the sea, on a cliff face or
 * with a tree growing through its shin is worse than no colossus at all.
 *
 * ## What the search looks for
 *
 *  - dry, loaded ground at least a couple of blocks above sea level;
 *  - a flat-ish footprint, because the foot probe takes the highest of nine
 *    samples and a fifty block step in terrain would leave half the creature
 *    buried;
 *  - open sky above the surface rather than a treetop or a roof, because the
 *    whole point is that the head is up in the cloud layer;
 *  - a spot in front of the player, at a distance where the fog has started to
 *    eat the legs but the head is still clear.
 *
 * Nothing here touches Three.js or the entity pool: it answers with coordinates
 * and lets the caller decide how to place the creature.
 */

import { SEA_LEVEL } from '../config/GameConfig.js';
import { Block } from './BlockTypes.js';

/** Surfaces that mean "something is growing here", not "solid ground". */
const ORGANIC_SURFACE = new Set([Block.OAK_LEAVES, Block.OAK_LOG]);

/** Default search band, in blocks from the player. */
export const COLOSSUS_SEARCH = Object.freeze({
  minDistance: 42,
  maxDistance: 132,
  preferredDistance: 74,
  ringStep: 6,
  angles: 20,
  /** Maximum height difference inside the footprint. */
  maxRoughness: 3,
  /** How much a good direction is worth against a flat lawn, in blocks. */
  angleWeight: 26,
  distanceWeight: 0.4,
});

/** Samples across the footprint, as a fraction of the collision half-size. */
const FOOTPRINT = 0.62;

/**
 * Evaluates one candidate position.
 *
 * @param {Object} world
 * @param {number} x
 * @param {number} z
 * @param {number} halfSize
 * @returns {{x:number, z:number, y:number, roughness:number}|null}
 */
function evaluateSite(world, x, z, halfSize) {
  const reach = Math.max(1, halfSize * FOOTPRINT);
  let lowest = Infinity;
  let highest = -Infinity;

  for (let along = -1; along <= 1; along++) {
    for (let across = -1; across <= 1; across++) {
      const probeX = Math.floor(x + across * reach);
      const probeZ = Math.floor(z + along * reach);
      if (!world.isLoaded?.(probeX, probeZ)) return null;
      const surface = world.getSurfaceY(probeX, probeZ);
      if (!Number.isFinite(surface) || surface < SEA_LEVEL + 2) return null;
      const block = world.getBlock(probeX, surface, probeZ);
      if (ORGANIC_SURFACE.has(block)) return null;
      if (surface < lowest) lowest = surface;
      if (surface > highest) highest = surface;
    }
  }

  return { x, z, y: highest + 1, roughness: highest - lowest };
}

/**
 * Finds the best place for a colossus around a point.
 *
 * @param {Object} world
 * @param {number} originX
 * @param {number} originZ
 * @param {Object} [options]
 * @param {number} [options.heading] Direction to favour, radians, where 0 is +Z.
 * @param {number} [options.halfSize] Creature footprint half-width.
 * @param {number} [options.minDistance]
 * @param {number} [options.maxDistance]
 * @param {number} [options.preferredDistance]
 * @returns {{x:number, z:number, y:number, roughness:number, distance:number, angle:number, facing:number, score:number}|null}
 */
export function findColossusSite(world, originX, originZ, {
  heading = 0,
  halfSize = 7.4,
  minDistance = COLOSSUS_SEARCH.minDistance,
  maxDistance = COLOSSUS_SEARCH.maxDistance,
  preferredDistance = COLOSSUS_SEARCH.preferredDistance,
} = {}) {
  if (!world?.getSurfaceY) return null;
  let best = null;

  for (let distance = minDistance; distance <= maxDistance; distance += COLOSSUS_SEARCH.ringStep) {
    for (let index = 0; index < COLOSSUS_SEARCH.angles; index++) {
      const turn = index / COLOSSUS_SEARCH.angles;
      const angle = heading + turn * Math.PI * 2;
      const x = Math.floor(originX + Math.sin(angle) * distance) + 0.5;
      const z = Math.floor(originZ + Math.cos(angle) * distance) + 0.5;
      const site = evaluateSite(world, x, z, halfSize);
      if (!site || site.roughness > COLOSSUS_SEARCH.maxRoughness) continue;

      // Angular distance from the favoured direction, in radians [0, PI].
      const halfTurn = turn > 0.5 ? 1 - turn : turn;
      const angular = halfTurn * Math.PI * 2;
      const score = site.roughness * 8 +
        Math.abs(distance - preferredDistance) * COLOSSUS_SEARCH.distanceWeight +
        angular * COLOSSUS_SEARCH.angleWeight;

      if (!best || score < best.score) {
        best = {
          ...site,
          distance,
          angle,
          // Face the place the player came from, so the first thing they see is
          // the front of it rather than a back plate.
          facing: Math.atan2(originX - x, originZ - z),
          score,
        };
      }
    }
  }

  return best;
}

export default findColossusSite;
