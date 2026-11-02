/**
 * The mind and the footing of a creature too large for the normal mob systems.
 *
 * ## Why a colossus cannot use the ordinary path
 *
 * Two things break at this size, and both of them break hard enough that a
 * `scale` multiplier is not an option:
 *
 *  1. **Collision.** `Entity._blocked` walks every voxel inside the body box. A
 *     15x15x62 box is fourteen thousand lookups per axis per substep, at 60 Hz,
 *     for a creature that is not moving. `settleGiantOnGround` replaces it with
 *     nine surface probes at the feet -- which is all that matters for something
 *     whose knees are above the treeline.
 *
 *  2. **Decision making.** Pathfinding, wander goals, jumping obstacles and
 *     daylight burning are all written for a creature one or two blocks tall.
 *     A colossus needs the opposite of that: long silences, a very slow head
 *     turn, and the occasional roar. That is what this file produces as data.
 *
 * ## What the presence does
 *
 * It is a clock and a gaze. It never moves the body, never attacks and never
 * decides to chase. It returns:
 *
 *  - `headYaw`, in radians relative to the body, so the head can track a player
 *    standing in front of it and drift back to a slow scan when nobody is there;
 *  - `emote`, one of `roar` / `shift`, with the seconds it should hold for;
 *  - `events`, sound requests that `MobEntity` forwards to the audio bus with a
 *    world position attached.
 *
 * Everything is plain numbers and a seeded random, so the whole behaviour can be
 * simulated in Node without a renderer or an audio context.
 *
 * Worker-safe and renderer-free: no DOM, no Three.js.
 */

import { PHYSICS } from '../config/GameConfig.js';

/**
 * Tuning for the standing colossus.
 *
 * The intervals are deliberately long. A creature that roars every five seconds
 * is a sound effect; one that roars every half minute, from somewhere you cannot
 * see yet, is a thing in the world. Note that the earshot values are much larger
 * than the fog distance on purpose: the point of the roar is that you hear it
 * before the fog lets you see it.
 */
export const GIANT_TIMINGS = Object.freeze({
  /** Seconds between roars, and how far away it will bother. */
  roarMin: 26,
  roarMax: 47,
  roarEarshot: 300,
  /** The first roar lands while the player is still reading the loading screen. */
  roarFirst: 4.5,

  groanMin: 9,
  groanMax: 18,
  groanEarshot: 200,

  breathMin: 4.4,
  breathMax: 8.2,
  breathEarshot: 74,

  shiftMin: 17,
  shiftMax: 33,
  shiftEarshot: 140,

  /** How often the idle gaze picks a new direction when nobody is near. */
  scanMin: 6.5,
  scanMax: 12,
  scanLimit: 0.34,

  /** Beyond this the head stops tracking the player and goes back to scanning. */
  watchRange: 88,
  /** Maximum head yaw relative to the body, radians (~41 degrees). */
  headLimit: 0.72,
  /** How fast the head turns, radians per second. A slow servo, not a snap. */
  headTurnRate: 0.42,
  /** How fast it gives up on a target that has left, radians per second. */
  headReleaseRate: 0.2,
});

/** Emote durations, matching the authored clips in `MobSkeletons.js`. */
export const GIANT_EMOTE_SECONDS = Object.freeze({
  roar: 5.2,
  shift: 4.6,
});

/**
 * Sound requests per emote. `atHead` decides where the voice is placed: a roar
 * comes from the head, a weight shift from the feet.
 */
const SOUNDS = Object.freeze({
  roar: Object.freeze({
    name: 'mob.colossus.roar',
    volume: 1,
    maxDistance: 320,
    refDistance: 26,
    rolloff: 0.5,
    atHead: true,
  }),
  groan: Object.freeze({
    name: 'mob.colossus.groan',
    volume: 0.72,
    maxDistance: 210,
    refDistance: 20,
    rolloff: 0.6,
    atHead: false,
  }),
  breath: Object.freeze({
    name: 'mob.colossus.breath',
    volume: 0.85,
    maxDistance: 95,
    refDistance: 9,
    rolloff: 1.1,
    atHead: true,
  }),
  shift: Object.freeze({
    name: 'mob.colossus.step',
    volume: 0.9,
    maxDistance: 240,
    refDistance: 22,
    rolloff: 0.55,
    atHead: false,
  }),
});

/** Wraps an angle into `(-PI, PI]`. */
export function wrapAngle(angle) {
  let value = angle;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value <= -Math.PI) value += Math.PI * 2;
  return value;
}

/** Signed shortest rotation from `from` toward `to`. */
export function angleDelta(from, to) {
  return wrapAngle(to - from);
}

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);

/**
 * The standing colossus's behaviour.
 *
 * One instance per creature. Purely a function of elapsed time and the player's
 * position, which is what makes it testable: the self-test drives it for a
 * simulated hour and asserts that it roared, that it never spoke while alone
 * across the world, and that its head never left its neck.
 */
export class GiantPresence {
  /**
   * @param {Object} [options]
   * @param {() => number} [options.random] Seeded random from the mob.
   */
  constructor({ random = Math.random } = {}) {
    this.random = random;
    const between = (min, max) => min + random() * (max - min);

    /** Seconds until the next vocalisation of each kind. */
    this._roarIn = GIANT_TIMINGS.roarFirst;
    this._groanIn = between(GIANT_TIMINGS.groanMin, GIANT_TIMINGS.groanMax);
    this._breathIn = between(GIANT_TIMINGS.breathMin, GIANT_TIMINGS.breathMax);
    this._shiftIn = between(GIANT_TIMINGS.shiftMin, GIANT_TIMINGS.shiftMax);
    this._scanIn = between(GIANT_TIMINGS.scanMin, GIANT_TIMINGS.scanMax);

    /** Where the gaze currently is, and where it is heading. */
    this.headYaw = 0;
    this._targetYaw = 0;
    this._watching = false;

    /** Counters, exposed for the self-test and the debug overlay. */
    this.roars = 0;
    this.groans = 0;
    this.breaths = 0;
    this.shifts = 0;
  }

  /**
   * Advances the presence by one frame.
   *
   * @param {number} dt Seconds.
   * @param {Object} [input]
   * @param {number} [input.distance] Horizontal distance to the player.
   * @param {number|null} [input.bearing] Player direction relative to the body,
   *   radians; `null` when there is no player.
   * @returns {{headYaw:number, emote:string|null, emoteSeconds:number, events:Array<Object>}}
   */
  update(dt, { distance = Infinity, bearing = null } = {}) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const timings = GIANT_TIMINGS;
    const events = [];

    // --- gaze -------------------------------------------------------------
    //
    // A player inside the watch radius is tracked, clamped to what the neck can
    // actually do. Anyone further out than that gets no reaction at all, which
    // is what makes the head turn feel like it noticed you rather than like a
    // turret lock.
    const watching = bearing !== null && Number.isFinite(distance) && distance <= timings.watchRange;
    if (watching) {
      this._watching = true;
      this._targetYaw = clamp(bearing, -timings.headLimit, timings.headLimit);
    } else {
      if (this._watching) {
        this._watching = false;
        this._scanIn = 0.8;
      }
      this._scanIn -= step;
      if (this._scanIn <= 0) {
        this._scanIn = timings.scanMin + this.random() * (timings.scanMax - timings.scanMin);
        this._targetYaw = (this.random() * 2 - 1) * timings.scanLimit;
      }
    }

    const rate = watching ? timings.headTurnRate : timings.headReleaseRate;
    const delta = this._targetYaw - this.headYaw;
    const maxStep = rate * step;
    this.headYaw += Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep;

    // --- voice ------------------------------------------------------------
    this._roarIn -= step;
    if (this._roarIn <= 0) {
      this._roarIn = timings.roarMin + this.random() * (timings.roarMax - timings.roarMin);
      if (distance <= timings.roarEarshot) {
        this.roars++;
        events.push({ ...SOUNDS.roar, kind: 'roar' });
      }
    }

    this._groanIn -= step;
    if (this._groanIn <= 0) {
      this._groanIn = timings.groanMin + this.random() * (timings.groanMax - timings.groanMin);
      if (distance <= timings.groanEarshot) {
        this.groans++;
        events.push({ ...SOUNDS.groan, kind: 'groan' });
      }
    }

    this._breathIn -= step;
    if (this._breathIn <= 0) {
      this._breathIn = timings.breathMin + this.random() * (timings.breathMax - timings.breathMin);
      if (distance <= timings.breathEarshot) {
        this.breaths++;
        events.push({ ...SOUNDS.breath, kind: 'breath' });
      }
    }

    this._shiftIn -= step;
    if (this._shiftIn <= 0) {
      this._shiftIn = timings.shiftMin + this.random() * (timings.shiftMax - timings.shiftMin);
      if (distance <= timings.shiftEarshot) {
        this.shifts++;
        events.push({ ...SOUNDS.shift, kind: 'shift' });
      }
    }

    // The roar and the weight shift are visible as well as audible, so they are
    // reported as an emote for the animation state machine. Groans and breaths
    // are not: at this scale a breath that visibly moved the chest every few
    // seconds would look like the creature was panting.
    let emote = null;
    for (const event of events) {
      if (event.kind === 'roar' || event.kind === 'shift') {
        emote = event.kind;
        break;
      }
    }

    return {
      headYaw: this.headYaw,
      emote,
      emoteSeconds: emote ? GIANT_EMOTE_SECONDS[emote] : 0,
      events,
    };
  }
}

/** Feet probe spacing as a fraction of the collision half-size. */
const FOOT_PROBE = 0.55;

/**
 * Highest walkable surface under a giant's feet, or `null` when the ground is
 * not loaded yet.
 *
 * `world.getSurfaceY` falls back to the generator's idea of the height when a
 * chunk is missing, which would let a colossus be placed inside a mountain that
 * has not streamed in. Every probe therefore has to answer `isLoaded` first.
 *
 * @param {Object} world
 * @param {number} x
 * @param {number} z
 * @param {number} halfSize
 * @returns {number|null} Feet height in world units.
 */
export function giantFooting(world, x, z, halfSize) {
  if (!world?.isLoaded || !world?.getSurfaceY) return null;
  const reach = Math.max(1, halfSize * FOOT_PROBE);
  let highest = -Infinity;
  for (let offset = -1; offset <= 1; offset++) {
    for (let along = -1; along <= 1; along++) {
      const probeX = Math.floor(x + offset * reach);
      const probeZ = Math.floor(z + along * reach);
      if (!world.isLoaded(probeX, probeZ)) return null;
      const surface = world.getSurfaceY(probeX, probeZ);
      if (!Number.isFinite(surface) || surface < 0) return null;
      if (surface > highest) highest = surface;
    }
  }
  return highest + 1;
}

/**
 * Resolves a giant's vertical position against the terrain.
 *
 * Deliberately not a collision solve: the feet snap to the highest surface in
 * footprint, gravity is integrated while it is above that, and horizontal
 * motion is ignored because a standing colossus has none. A rise of more than a
 * couple of blocks is left alone rather than teleporting the creature up a
 * cliff that generated underneath it.
 *
 * @param {Object} world
 * @param {{x:number,y:number,z:number,halfSize:number,velocityY:number,onGround:boolean}} giant
 * @param {number} dt
 * @returns {boolean} True when the footing was known and applied.
 */
export function settleGiantOnGround(world, giant, dt) {
  const footing = giantFooting(world, giant.x, giant.z, giant.halfSize);
  if (footing === null) return false;

  // Terrain that has risen above the feet is not something to step over at this
  // size. A sixty block mass does not climb a cliff that generated under it, and
  // teleporting it upward would look exactly like a bug. It stays where it is.
  if (footing - giant.y > 3) {
    giant.velocityY = 0;
    giant.onGround = true;
    return true;
  }

  if (giant.y <= footing + 0.02) {
    giant.y = footing;
    giant.velocityY = 0;
    giant.onGround = true;
    return true;
  }

  giant.onGround = false;
  const gravity = Number.isFinite(PHYSICS.gravity) ? PHYSICS.gravity : 32;
  giant.velocityY = Math.max(-PHYSICS.terminalVelocity, giant.velocityY - gravity * dt);
  giant.y += giant.velocityY * dt;

  if (giant.y <= footing) {
    giant.y = footing;
    giant.velocityY = 0;
    giant.onGround = true;
  }
  return true;
}

export default GiantPresence;
