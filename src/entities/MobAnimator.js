/**
 * Drives one creature's skeleton from its gameplay state.
 *
 * ## What this replaces
 *
 * The old renderer decided animation with a `Limb` enum and a sine wave in GLSL:
 * every creature walked identically and the only way to change a gait was to
 * edit a shader. Here the mapping from *state* (moving, attacking, hurt, dead)
 * to *clip* is ordinary data-driven code, so it is testable and so each creature
 * can have its own authored motion.
 *
 * One instance per live mob. Renderer-free on purpose: the whole state machine
 * is asserted in `selftest.mjs` without a GL context.
 *
 * Requires the Phase 1 rig modules: `rendering/SkeletalModel.js`,
 * `rendering/AnimationController.js` and `entities/MobSkeletons.js`.
 */

import { AnimationController } from '../rendering/AnimationController.js';
import { Skeleton } from '../rendering/SkeletalModel.js';
import { HEAD_TRACK_CLIP, MOB_SKELETONS, resolveClip } from './MobSkeletons.js';

/** Ground speed above which `walk` becomes `run`. Blocks per second. */
export const RUN_SPEED = 3.2;

/** Below this the creature is treated as standing still. */
export const MOVE_EPSILON = 0.12;

/** The speed an authored walk cycle is tuned for. */
export const REFERENCE_WALK_SPEED = 1.6;

/** Clip playback rate is clamped so a fast mob does not vibrate. */
export const MIN_GAIT_RATE = 0.55;
export const MAX_GAIT_RATE = 2.1;

/** Cross-fade seconds per destination clip. */
const FADE_SECONDS = Object.freeze({
  death: 0.1,
  attack: 0.07,
  cast: 0.12,
  // A sixty block creature cannot snap into a pose: the roar and the weight
  // shift are given a long blend so the motion starts before it is expected.
  roar: 0.45,
  shift: 0.4,
  run: 0.15,
  walk: 0.18,
  flap: 0.15,
  idle: 0.26,
});

/** Seconds a hurt flinch stays layered on top of the body. */
export const FLINCH_SECONDS = 0.3;

/**
 * Chooses the clip for a gameplay state.
 *
 * Order matters and encodes the priority: death outranks everything, a scripted
 * emote outranks a swing, a swing outranks locomotion, and locomotion outranks
 * idling.
 *
 * @param {string} mobId
 * @param {{isDead?:boolean, emote?:string|null, attacking?:boolean, casting?:boolean, speed?:number, onGround?:boolean}} state
 * @returns {string|null}
 */
export function selectClip(mobId, state = {}) {
  if (!MOB_SKELETONS[mobId]) return null;
  // Every mob is guaranteed a death clip (see REQUIRED_CLIPS), so this one is
  // safe to return unguarded.
  if (state.isDead) return resolveClip(mobId, 'death');

  // Emotes -- the colossus's roar and weight shift -- are opt-in: `resolveClip`
  // answers with `idle` for a creature that has no such clip, and taking that
  // answer would drop a moving creature into idle. Only an exact match counts.
  if (state.emote) {
    const emote = resolveClip(mobId, state.emote);
    if (emote === state.emote) return emote;
  }

  // `cast` and `attack` are optional. resolveClip falls back to `idle` when a mob
  // lacks them, so returning it unguarded would drop a sprinting creature into
  // idle the instant it swings -- it reads as the mob freezing mid-stride. Only
  // take the branch if the clip genuinely exists, otherwise fall through to the
  // gait. This is the same guard the flap branch below uses.
  if (state.casting) {
    const cast = resolveClip(mobId, 'cast');
    if (cast === 'cast') return cast;
  }
  if (state.attacking) {
    const attack = resolveClip(mobId, 'attack');
    if (attack === 'attack') return attack;
  }

  const speed = Number.isFinite(state.speed) ? Math.abs(state.speed) : 0;
  // Airborne creatures with a flap clip use it instead of a ground gait.
  if (state.onGround === false) {
    const flap = resolveClip(mobId, 'flap');
    if (flap === 'flap') return flap;
  }
  if (speed > RUN_SPEED) return resolveClip(mobId, 'run');
  if (speed > MOVE_EPSILON) return resolveClip(mobId, 'walk');
  return resolveClip(mobId, 'idle');
}

/**
 * Playback rate that makes stride length match ground speed.
 *
 * Without this, a mob slowed by deep water still cycles its legs at full rate
 * and visibly skates. Clamped at both ends because matching exactly at very low
 * or very high speeds looks worse than approximating.
 *
 * @param {number} speed
 * @param {boolean} locomotive True for walk/run clips.
 * @returns {number}
 */
export function gaitRate(speed, locomotive) {
  if (!locomotive) return 1;
  const value = Number.isFinite(speed) ? Math.abs(speed) : 0;
  const rate = value / REFERENCE_WALK_SPEED;
  if (rate < MIN_GAIT_RATE) return MIN_GAIT_RATE;
  if (rate > MAX_GAIT_RATE) return MAX_GAIT_RATE;
  return rate;
}

/**
 * One creature's skeleton, controller and state mapping.
 */
export class MobAnimator {
  /**
   * @param {string} mobId
   * @throws {Error} When the creature has no authored skeleton.
   */
  constructor(mobId) {
    const entry = MOB_SKELETONS[mobId];
    if (!entry) throw new Error(`no skeleton authored for mob "${mobId}"`);

    this.mobId = mobId;
    this.skeleton = new Skeleton(entry.skeleton);

    // The shared head-tracking clip only makes sense on a rig that has a head;
    // the lurker does not, and registering the clip anyway would let a caller
    // silently request a layer that animates nothing.
    this.hasHead = this.skeleton.indexOf.has('head');
    const clips = this.hasHead
      ? { ...entry.clips, headTrack: HEAD_TRACK_CLIP }
      : { ...entry.clips };

    this.controller = new AnimationController(clips, { initial: 'idle' });
    this.clip = this.controller.current;
    this._flinch = 0;
    this._wasHurt = false;
  }

  /** Bone count, for sizing the pose buffer. */
  get boneCount() {
    return this.skeleton.boneCount;
  }

  /**
   * Advances one frame and returns the posed world matrices.
   *
   * @param {number} dt Seconds.
   * @param {Object} state
   * @param {number} [state.speed] Horizontal ground speed.
   * @param {boolean} [state.isDead]
   * @param {boolean} [state.attacking]
   * @param {boolean} [state.casting]
   * @param {boolean} [state.onGround]
   * @param {boolean} [state.hurt] True on the frame damage lands.
   * @param {number} [state.headYaw] Radians, additive look direction.
   * @returns {Float32Array} Bone world matrices.
   */
  update(dt, state = {}) {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const desired = selectClip(this.mobId, state);

    if (desired && desired !== this.clip) {
      this.controller.crossFade(desired, FADE_SECONDS[desired] ?? 0.2);
      this.clip = desired;
    }

    const locomotive = desired === 'walk' || desired === 'run';
    this.controller.speed = gaitRate(state.speed, locomotive);

    // Restart the flinch on the rising edge only. Re-arming it every frame while
    // a mob stands in fire would hold the clip on frame zero and freeze it.
    const hurt = state.hurt === true;
    if (hurt && !this._wasHurt && !state.isDead) {
      this._flinch = FLINCH_SECONDS;
      this.controller.clearLayer('flinch');
      this.controller.setLayer('flinch', 'hurt', 1);
    }
    this._wasHurt = hurt;

    if (this._flinch > 0) {
      this._flinch = Math.max(0, this._flinch - step);
      const weight = this._flinch / FLINCH_SECONDS;
      if (weight <= 0) this.controller.clearLayer('flinch');
      else this.controller.setLayer('flinch', 'hurt', weight);
    }

    this.controller.update(step);
    const pose = this.controller.getPose();

    // Head yaw is applied after sampling so steering composes with whatever the
    // clip is already doing to the head, instead of fighting it.
    if (this.hasHead && Number.isFinite(state.headYaw) && state.headYaw !== 0) {
      const existing = pose.get('head');
      if (existing) existing.rotation[1] += state.headYaw;
      else pose.set('head', { rotation: [0, state.headYaw, 0], position: [0, 0, 0] });
    }

    this.skeleton.applyPose(pose);
    return this.skeleton.world;
  }

  getStats() {
    return {
      mob: this.mobId,
      bones: this.skeleton.boneCount,
      ...this.controller.getStats(),
    };
  }
}

/**
 * Creates an animator, returning null for creatures without a rig rather than
 * throwing, so one unrigged creature cannot stop the renderer from starting.
 * @param {string} mobId
 * @returns {MobAnimator|null}
 */
export function tryCreateAnimator(mobId) {
  try {
    return new MobAnimator(mobId);
  } catch {
    return null;
  }
}

export default MobAnimator;
