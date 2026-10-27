/**
 * Natural mob spawning.
 *
 * Spawning is deliberately separate from `EntityManager`: the manager owns
 * pools and rendering, while this class owns ecological policy — caps, distance
 * bands, light/day rules and group sizes. Tests can therefore feed it a tiny
 * world stand-in and assert that invalid positions are never accepted.
 */

import { ENTITIES, WORLD_HEIGHT } from '../config/GameConfig.js';
import { IS_LIQUID, IS_SOLID } from '../world/BlockRegistry.js';
import { Block } from '../world/BlockTypes.js';
import {
  getMob,
  HOSTILE_MOBS,
  MobFamily,
  PASSIVE_MOBS,
} from './MobTypes.js';
import { getDifficulty } from '../gameplay/Difficulty.js';

/**
 * Mob ids belonging to one dimension, cached per (pool, dimension).
 *
 * `MobTypes` tags every definition with a `dimension`; without this filter a
 * ghast could spawn in a meadow and a cow could spawn on netherrack.
 */
const DIMENSION_POOLS = new Map();

export function mobsForDimension(ids, dimensionId = 'overworld') {
  const key = `${dimensionId}|${ids.length}|${ids[0] ?? ''}`;
  const cached = DIMENSION_POOLS.get(key);
  if (cached) return cached;
  const filtered = [];
  for (const id of ids) {
    const definition = getMob(id);
    if (!definition) continue;
    // Bosses arrive through a summon ritual. Letting the wandering spawner pick
    // one would drop a 300 HP Wither on an unsuspecting player in a corridor.
    if (definition.boss) continue;
    // `dimensions` is the authoritative list; `dimension` is the fallback for
    // definitions written before a creature could span two worlds.
    const homes = definition.dimensions ?? [definition.dimension ?? 'overworld'];
    if (homes.includes(dimensionId)) filtered.push(id);
  }
  const frozen = Object.freeze(filtered);
  DIMENSION_POOLS.set(key, frozen);
  return frozen;
}

const MIN_SPAWN_DISTANCE = 24;
const MAX_SPAWN_DISTANCE = 56;
const CAVE_ATTEMPTS = 18;
const GROUP_RADIUS = 4;

function nextRandom(spawner) {
  let x = spawner._randomState || 0xa341316c;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  spawner._randomState = x >>> 0;
  return (spawner._randomState >>> 0) / 4294967296;
}

/** Counts live mobs by family. */
export function countMobFamilies(mobs) {
  let passive = 0;
  let hostile = 0;
  let neutral = 0;
  for (const mob of mobs) {
    if (!mob?.alive || mob.isDead || !mob.definition) continue;
    if (mob.definition.family === MobFamily.HOSTILE) hostile++;
    else if (mob.definition.family === MobFamily.NEUTRAL) neutral++;
    else passive++;
  }
  return { passive, hostile, neutral, total: passive + hostile + neutral };
}

/**
 * Whether a creature's full collision box fits at a position.
 */
export function isSpawnVolumeClear(world, definition, x, y, z) {
  const minX = Math.floor(x - definition.halfSize);
  const maxX = Math.floor(x + definition.halfSize);
  const minY = Math.floor(y);
  const maxY = Math.floor(y + definition.height - 1e-4);
  const minZ = Math.floor(z - definition.halfSize);
  const maxZ = Math.floor(z + definition.halfSize);

  if (minY < 1 || maxY >= WORLD_HEIGHT) return false;
  for (let yy = minY; yy <= maxY; yy++) {
    for (let zz = minZ; zz <= maxZ; zz++) {
      for (let xx = minX; xx <= maxX; xx++) {
        if (world.isCollidable(xx, yy, zz) || world.isLiquid?.(xx, yy, zz)) return false;
      }
    }
  }

  // Every corner needs ground. This rejects cliff-edge spawns whose centre is
  // technically supported but whose wide body starts half over empty space.
  const groundY = Math.floor(y - 0.05);
  for (const xx of [minX, maxX]) {
    for (const zz of [minZ, maxZ]) {
      if (!world.isCollidable(xx, groundY, zz)) return false;
    }
  }
  return true;
}

/**
 * Applies family-specific spawn rules to an otherwise clear position.
 */
export function isValidMobSpawn(world, definition, x, y, z, { daylight = 1 } = {}) {
  if (!definition || !world.isLoaded?.(x, z)) return false;
  if (!isSpawnVolumeClear(world, definition, x, y, z)) return false;

  const below = world.getBlock(Math.floor(x), Math.floor(y - 0.05), Math.floor(z));
  if (!IS_SOLID[below] || IS_LIQUID[below]) return false;

  const surface = world.getSurfaceY?.(Math.floor(x), Math.floor(z));
  const exposed = surface === undefined || surface < y + 0.25;
  const blockLight = Math.max(0, Math.min(15, Number(
    world.getBlockLight?.(Math.floor(x), Math.floor(y), Math.floor(z)) ?? 0
  ) || 0));
  const skyLight = exposed ? Math.round(Math.max(0, Math.min(1, daylight)) * 15) : 0;
  const effectiveLight = Math.max(blockLight, skyLight);

  if (definition.family === MobFamily.PASSIVE) {
    // Farm animals belong on natural, open ground in daylight. This avoids cows
    // appearing in mines or on the roof of a player's cobblestone tower.
    const naturalGround =
      below === Block.GRASS ||
      below === Block.DIRT ||
      below === Block.SNOW ||
      below === Block.SAND;
    return naturalGround && exposed && effectiveLight >= 9;
  }

  if (definition.family === MobFamily.HOSTILE) {
    // Hostiles require real darkness. A torch or powered lamp now protects a
    // roofed base and cave instead of the old exposure-only approximation.
    return effectiveLight <= 7;
  }

  return true;
}

/** Picks an integer in [min,max]. */
function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Picks a spawn id, weighted by `definition.spawnWeight`.
 *
 * Uniform choice made the horror roster as likely as a zombie, which floods a night
 * with the wrong creature. Weights let the walker be the common threat, the hunter
 * rarer, and the stalker rarest.
 *
 * @param {ReadonlyArray<string>} ids
 * @param {() => number} random
 * @returns {string|null}
 */
export function pickWeightedMob(ids, random) {
  if (ids.length === 0) return null;
  let total = 0;
  const weights = ids.map((id) => {
    const weight = getMob(id)?.spawnWeight ?? 1;
    total += weight;
    return weight;
  });
  let roll = random() * total;
  for (let index = 0; index < ids.length; index++) {
    roll -= weights[index];
    if (roll <= 0) return ids[index];
  }
  return ids[ids.length - 1];
}

export class MobSpawner {
  constructor(seed = 1, difficulty = 'normal') {
    this._randomState = (seed ^ 0x9e3779b9) >>> 0 || 1;
    this._difficulty = getDifficulty(difficulty?.id ?? difficulty);
    this._timer = 1.5;
    this._passiveCooldown = 0;
    this.spawnSerial = 0;
  }

  reset(seed = 1) {
    this._randomState = (seed ^ 0x9e3779b9) >>> 0 || 1;
    this._timer = 1.5;
    this._passiveCooldown = 0;
    this.spawnSerial = 0;
  }

  /**
   * Runs a bounded natural-spawn pass.
   *
   * @param {number} dt
   * @param {Object} options
   * @param {Object} options.world
   * @param {import('../player/Player.js').Player|null} options.player
   * @param {number} options.daylight
   * @param {Iterable<import('./MobEntity.js').MobEntity>} options.mobs
   * @param {(mobId:string,x:number,y:number,z:number,seed:number)=>Object|null} options.spawn
   * @param {boolean} [options.enabled]
   * @returns {number} Number spawned.
   */
  update(dt, {
    world,
    player,
    daylight = 1,
    mobs,
    spawn,
    enabled = true,
    difficulty = this._difficulty,
  }) {
    const profile = getDifficulty(difficulty?.id ?? difficulty);
    if (!enabled || !player || player.stats?.isDead) return 0;
    this._timer -= dt;
    this._passiveCooldown = Math.max(0, this._passiveCooldown - dt);
    if (this._timer > 0) return 0;
    this._timer = (0.9 + nextRandom(this) * 0.8) / profile.hostileSpawnRate;

    // No sky means no day/night suppression; treat the Nether as permanent night.
    if ((world?.dimension?.skyLight ?? true) === false) daylight = 0;

    const counts = countMobFamilies(mobs);
    if (counts.total >= ENTITIES.maxMobs) return 0;

    const hostileCap = Math.min(
      ENTITIES.maxMobs,
      Math.max(1, Math.floor(ENTITIES.hostileMobCap * profile.hostileCapMultiplier))
    );
    const hostileRoom = Math.max(0, hostileCap - counts.hostile);
    const passiveRoom = Math.max(0, ENTITIES.passiveMobCap - counts.passive);
    const nightBias = 1 - daylight;

    let family;
    if (hostileRoom > 0 && (passiveRoom === 0 || nextRandom(this) < 0.62 + nightBias * 0.3)) {
      family = MobFamily.HOSTILE;
    } else if (passiveRoom > 0 && this._passiveCooldown <= 0) {
      family = MobFamily.PASSIVE;
    } else {
      return 0;
    }

    // Phase 4: the roster is per-dimension. The Nether has no passive mobs and
    // no daylight, so an empty pool is a normal outcome rather than an error.
    const dimensionId = world?.dimension?.id ?? 'overworld';
    const basePool = family === MobFamily.HOSTILE ? HOSTILE_MOBS : PASSIVE_MOBS;
    const ids = mobsForDimension(basePool, dimensionId);
    if (ids.length === 0) return 0;
    const definition = getMob(pickWeightedMob(ids, () => nextRandom(this)));
    if (!definition) return 0;

    const centre = this._findPosition(world, player, definition, daylight);
    if (!centre) return 0;

    const room = family === MobFamily.HOSTILE ? hostileRoom : passiveRoom;
    const wanted = Math.min(
      room,
      randomInt(() => nextRandom(this), definition.spawnGroupMin, definition.spawnGroupMax)
    );

    let spawned = 0;
    for (let member = 0; member < wanted; member++) {
      const x = centre.x + (nextRandom(this) - 0.5) * GROUP_RADIUS * 2;
      const z = centre.z + (nextRandom(this) - 0.5) * GROUP_RADIUS * 2;
      const location = member === 0
        ? centre
        : this._fitNear(world, definition, x, z, daylight, centre.cave);
      if (!location) continue;
      const entity = spawn(
        definition.id,
        location.x,
        location.y,
        location.z,
        (this._randomState ^ ++this.spawnSerial) >>> 0
      );
      if (entity) spawned++;
    }

    if (spawned > 0 && family === MobFamily.PASSIVE) {
      // Passive populations grow slowly and then persist, unlike disposable
      // hostiles. A cooldown prevents a meadow filling in one minute.
      this._passiveCooldown = 18 + nextRandom(this) * 18;
    }
    return spawned;
  }

  _findPosition(world, player, definition, daylight) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const angle = nextRandom(this) * Math.PI * 2;
      const distance = MIN_SPAWN_DISTANCE + nextRandom(this) * (MAX_SPAWN_DISTANCE - MIN_SPAWN_DISTANCE);
      const x = Math.floor(player.position.x + Math.sin(angle) * distance) + 0.5;
      const z = Math.floor(player.position.z + Math.cos(angle) * distance) + 0.5;
      if (!world.isLoaded?.(x, z)) continue;

      if (definition.family === MobFamily.HOSTILE && daylight > 0.24 && nextRandom(this) < 0.72) {
        const cave = this._findCave(world, definition, x, z, daylight);
        if (cave) return cave;
      }

      const surface = world.getSurfaceY(x, z);
      const y = surface + 1;
      if (isValidMobSpawn(world, definition, x, y, z, { daylight })) {
        return { x, y, z, cave: false };
      }
    }
    return null;
  }

  _findCave(world, definition, x, z, daylight) {
    const surface = world.getSurfaceY(x, z);
    if (surface < 8) return null;
    for (let attempt = 0; attempt < CAVE_ATTEMPTS; attempt++) {
      const y = randomInt(() => nextRandom(this), 3, Math.max(3, surface - 3));
      if (isValidMobSpawn(world, definition, x, y, z, { daylight })) {
        return { x, y, z, cave: true };
      }
    }
    return null;
  }

  _fitNear(world, definition, x, z, daylight, preferCave) {
    if (!world.isLoaded?.(x, z)) return null;
    if (preferCave) {
      const cave = this._findCave(world, definition, x, z, daylight);
      if (cave) return cave;
    }
    const y = world.getSurfaceY(x, z) + 1;
    return isValidMobSpawn(world, definition, x, y, z, { daylight })
      ? { x, y, z, cave: false }
      : null;
  }
}

export default MobSpawner;
