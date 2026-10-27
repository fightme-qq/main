/**
 * The gameplay-event → sound mapping.
 *
 * ## Why this module exists
 *
 * FinalV2 synthesised thirty sounds at startup and then played exactly two of
 * them. `SoundRegistry` had `mob.death`, `tool.break`, `chest.open`, `player.eat`
 * and the rest fully implemented, but the only `audio.play(...)` calls in the
 * whole codebase were `player.jump` and `player.land` in `Game.js`. The audio was
 * not missing — it was built and then never triggered.
 *
 * Scattering twenty-eight new `audio.play('...')` string literals across the
 * gameplay code would fix the symptom and create a worse problem: a typo'd name
 * fails silently at runtime, and nothing can tell you which sounds are orphaned.
 *
 * So the mapping is declarative and lives in one file. Gameplay code emits a
 * semantic event (`GameplayEvent.CHEST_OPEN`), this table decides which buffer
 * that means, and the self-test asserts that **every name in this table exists in
 * the catalogue** and that **every catalogue entry is reachable**. A typo is now a
 * failing test rather than a silent absence.
 *
 * ## Material-aware events
 *
 * Break, place and footstep sounds are per-material. Those entries declare a
 * `materialAction` instead of a fixed `sound`, and resolve through
 * `soundKeyFor(action, group)` at call time using the block that was actually hit.
 */

import { SoundGroup } from '../world/BlockTypes.js';
import { soundKeyFor } from './SoundRegistry.js';

/**
 * Every gameplay moment that makes a noise.
 * @enum {string}
 */
export const GameplayEvent = Object.freeze({
  // -- player movement
  PLAYER_JUMP: 'player.jump',
  PLAYER_LAND: 'player.land',
  PLAYER_STEP: 'player.step',
  PLAYER_SWIM: 'player.swim',
  PLAYER_SPLASH: 'player.splash',

  // -- player state
  PLAYER_HURT: 'player.hurt',
  PLAYER_DEATH: 'player.death',
  PLAYER_EAT: 'player.eat',
  PLAYER_EAT_FINISH: 'player.eatFinish',
  PLAYER_LEVEL_UP: 'player.levelUp',
  PLAYER_XP_PICKUP: 'player.xpPickup',

  // -- blocks
  BLOCK_BREAK: 'block.break',
  BLOCK_PLACE: 'block.place',
  BLOCK_PLANT: 'block.plant',
  BLOCK_TILL: 'block.till',
  BLOCK_IGNITE: 'block.ignite',

  // -- containers and interaction
  CHEST_OPEN: 'chest.open',
  CHEST_CLOSE: 'chest.close',
  FURNACE_OPEN: 'furnace.open',
  DOOR_TOGGLE: 'door.toggle',
  CRAFT_COMPLETE: 'craft.complete',
  ITEM_PICKUP: 'item.pickup',
  BUCKET_USE: 'item.bucket',

  // -- combat
  ATTACK_SHARP: 'combat.attackSharp',
  ATTACK_BLUNT: 'combat.attackBlunt',
  ATTACK_MISS: 'combat.attackMiss',
  TOOL_BREAK: 'tool.break',
  SHIELD_BLOCK: 'combat.shieldBlock',
  SHIELD_BREAK: 'combat.shieldBreak',
  BOW_SHOOT: 'combat.bowShoot',
  PROJECTILE_HIT_ENTITY: 'combat.projectileHitEntity',
  PROJECTILE_HIT_BLOCK: 'combat.projectileHitBlock',

  // -- mobs
  MOB_HURT: 'mob.hurt',
  MOB_DEATH: 'mob.death',
  MOB_ATTACK: 'mob.attack',
  DRAGON_ROAR: 'dragon.roar',
  DRAGON_BATTLE: 'dragon.battle',

  // -- ui
  UI_CLICK: 'ui.click',
  UI_SELECT: 'ui.select',
  UI_BACK: 'ui.back',
});

/**
 * Actions that resolve to a per-material buffer.
 * @enum {string}
 */
export const MaterialAction = Object.freeze({
  BREAK: 'break',
  PLACE: 'place',
  STEP: 'step',
});

/**
 * @typedef {Object} SoundEventBinding
 * @property {string} [sound] Fixed catalogue name.
 * @property {string} [materialAction] Resolve per-material instead.
 * @property {number} volume Base gain 0..1.
 * @property {number} [pitch] Base playback rate multiplier.
 * @property {number} [cooldown] Minimum seconds between plays of this event.
 * @property {boolean} [positional] Play at the emitting entity's position.
 */

/**
 * The table. Every `sound` here is asserted to exist by the self-test.
 *
 * @type {Readonly<Record<string, SoundEventBinding>>}
 */
export const SOUND_EVENTS = Object.freeze({
  [GameplayEvent.PLAYER_JUMP]: { sound: 'player.jump', volume: 0.6, cooldown: 0.12 },
  [GameplayEvent.PLAYER_LAND]: { sound: 'player.land', volume: 0.7, cooldown: 0.12 },
  [GameplayEvent.PLAYER_STEP]: { materialAction: MaterialAction.STEP, volume: 0.34, cooldown: 0.22 },
  [GameplayEvent.PLAYER_SWIM]: { sound: 'player.swim', volume: 0.5, cooldown: 0.35 },
  [GameplayEvent.PLAYER_SPLASH]: { sound: 'player.splash', volume: 0.75, cooldown: 0.25 },

  [GameplayEvent.PLAYER_HURT]: { sound: 'player.hurt', volume: 0.8, cooldown: 0.3 },
  // No dedicated death sound in the catalogue; a low, slow hurt reads correctly
  // and avoids inventing a buffer this phase does not have time to tune.
  [GameplayEvent.PLAYER_DEATH]: { sound: 'player.hurt', volume: 1, pitch: 0.72 },
  [GameplayEvent.PLAYER_EAT]: { sound: 'player.eat', volume: 0.55, cooldown: 0.28 },
  [GameplayEvent.PLAYER_EAT_FINISH]: { sound: 'player.burp', volume: 0.5 },
  [GameplayEvent.PLAYER_LEVEL_UP]: { sound: 'player.levelup', volume: 0.8 },
  [GameplayEvent.PLAYER_XP_PICKUP]: { sound: 'pickup', volume: 0.3, pitch: 1.45, cooldown: 0.06 },

  [GameplayEvent.BLOCK_BREAK]: { materialAction: MaterialAction.BREAK, volume: 0.85, positional: true },
  [GameplayEvent.BLOCK_PLACE]: { materialAction: MaterialAction.PLACE, volume: 0.6, positional: true },
  [GameplayEvent.BLOCK_PLANT]: { sound: 'block.plant', volume: 0.55, positional: true },
  [GameplayEvent.BLOCK_TILL]: { sound: 'block.till', volume: 0.65, positional: true },
  [GameplayEvent.BLOCK_IGNITE]: { sound: 'item.ignite', volume: 0.7, positional: true },

  [GameplayEvent.CHEST_OPEN]: { sound: 'chest.open', volume: 0.6, positional: true },
  // The same hinge played lower and slower reads as closing.
  [GameplayEvent.CHEST_CLOSE]: { sound: 'chest.open', volume: 0.5, pitch: 0.82, positional: true },
  [GameplayEvent.FURNACE_OPEN]: { sound: 'chest.open', volume: 0.5, pitch: 0.9, positional: true },
  [GameplayEvent.DOOR_TOGGLE]: { materialAction: MaterialAction.PLACE, volume: 0.55, positional: true },
  [GameplayEvent.CRAFT_COMPLETE]: { sound: 'craft.complete', volume: 0.5 },
  [GameplayEvent.ITEM_PICKUP]: { sound: 'pickup', volume: 0.45, cooldown: 0.05 },
  [GameplayEvent.BUCKET_USE]: { sound: 'item.bucket', volume: 0.7, positional: true },

  [GameplayEvent.ATTACK_SHARP]: { sound: 'attack.sharp', volume: 0.7, cooldown: 0.1 },
  [GameplayEvent.ATTACK_BLUNT]: { sound: 'attack.blunt', volume: 0.7, cooldown: 0.1 },
  // A miss is the same swing with no impact: quieter and slightly faster.
  [GameplayEvent.ATTACK_MISS]: { sound: 'attack.sharp', volume: 0.32, pitch: 1.18, cooldown: 0.1 },
  [GameplayEvent.TOOL_BREAK]: { sound: 'tool.break', volume: 0.85 },
  [GameplayEvent.SHIELD_BLOCK]: { sound: 'item.shield_block', volume: 0.75 },
  [GameplayEvent.SHIELD_BREAK]: { sound: 'item.shield_break', volume: 0.9 },
  [GameplayEvent.BOW_SHOOT]: { sound: 'item.bow_shoot', volume: 0.65 },
  [GameplayEvent.PROJECTILE_HIT_ENTITY]: { sound: 'projectile.hit', volume: 0.7, positional: true },
  [GameplayEvent.PROJECTILE_HIT_BLOCK]: { sound: 'projectile.hit_block', volume: 0.6, positional: true },

  [GameplayEvent.MOB_HURT]: { sound: 'mob.hurt', volume: 0.7, cooldown: 0.1, positional: true },
  [GameplayEvent.MOB_DEATH]: { sound: 'mob.death', volume: 0.8, positional: true },
  [GameplayEvent.MOB_ATTACK]: { sound: 'mob.attack', volume: 0.7, cooldown: 0.15, positional: true },
  [GameplayEvent.DRAGON_ROAR]: { sound: 'mob.ender_dragon.roar', volume: 0.8, cooldown: 2 },
  // This binding documents the loop's catalogue reachability; Game controls it
  // through AudioManager.setLoop so it starts and stops with the live fight.
  [GameplayEvent.DRAGON_BATTLE]: { sound: 'music.dragon', volume: 0.46 },

  [GameplayEvent.UI_CLICK]: { sound: 'ui.click', volume: 0.4 },
  [GameplayEvent.UI_SELECT]: { sound: 'ui.select', volume: 0.45 },
  [GameplayEvent.UI_BACK]: { sound: 'ui.back', volume: 0.4 },
});

/**
 * Resolves an event into a concrete catalogue name and gain.
 *
 * @param {string} event A `GameplayEvent`.
 * @param {Object} [context]
 * @param {string} [context.soundGroup] Block sound group, for material events.
 * @param {number} [context.volumeScale] Extra multiplier, e.g. distance falloff.
 * @param {number} [context.pitchScale] Extra playback-rate multiplier.
 * @returns {{name:string, volume:number, pitch:number, positional:boolean, cooldown:number}|null}
 *   Null when the event is unknown, so a bad call is a no-op rather than a throw.
 */
export function resolveSoundEvent(event, context = {}) {
  const binding = SOUND_EVENTS[event];
  if (!binding) return null;

  const name = binding.materialAction
    ? soundKeyFor(binding.materialAction, context.soundGroup || SoundGroup.STONE)
    : binding.sound;
  if (!name) return null;

  const volumeScale = Number.isFinite(context.volumeScale) ? context.volumeScale : 1;
  const pitchScale = Number.isFinite(context.pitchScale) ? context.pitchScale : 1;

  return {
    name,
    volume: Math.max(0, Math.min(1, binding.volume * volumeScale)),
    pitch: (binding.pitch ?? 1) * pitchScale,
    positional: binding.positional === true,
    cooldown: binding.cooldown ?? 0,
  };
}

/**
 * Every fixed catalogue name this table can play.
 *
 * Used by the self-test to prove the mapping cannot reference a sound that does
 * not exist.
 *
 * @returns {string[]} Sorted, de-duplicated.
 */
export function listFixedSoundNames() {
  const names = new Set();
  for (const binding of Object.values(SOUND_EVENTS)) {
    if (binding.sound) names.add(binding.sound);
  }
  return [...names].sort();
}

/**
 * Every material-resolved name this table can play, across all sound groups.
 * @returns {string[]} Sorted, de-duplicated.
 */
export function listMaterialSoundNames() {
  const names = new Set();
  for (const binding of Object.values(SOUND_EVENTS)) {
    if (!binding.materialAction) continue;
    for (const group of Object.values(SoundGroup)) {
      names.add(soundKeyFor(binding.materialAction, group));
    }
  }
  return [...names].sort();
}

/** Union of the two lists above. */
export function listAllSoundNames() {
  return [...new Set([...listFixedSoundNames(), ...listMaterialSoundNames()])].sort();
}

/**
 * A tiny per-event rate limiter.
 *
 * Footsteps and item pickups fire many times a second; without this the mixer
 * gets a dozen identical buffers per frame and the result is a buzz rather than a
 * sound. Kept here rather than in `AudioManager` because the cooldown is a
 * property of the *event*, not of the buffer.
 */
export class SoundEventThrottle {
  constructor() {
    /** @type {Map<string, number>} */
    this._last = new Map();
    this._now = 0;
  }

  /** Advances the internal clock. */
  tick(dt) {
    this._now += Number.isFinite(dt) && dt > 0 ? dt : 0;
  }

  /**
   * @param {string} event
   * @param {number} cooldown Seconds.
   * @returns {boolean} True when the event may play now.
   */
  allow(event, cooldown) {
    if (!(cooldown > 0)) return true;
    const last = this._last.get(event);
    if (last !== undefined && this._now - last < cooldown) return false;
    this._last.set(event, this._now);
    return true;
  }

  reset() {
    this._last.clear();
    this._now = 0;
  }
}

export default SOUND_EVENTS;
