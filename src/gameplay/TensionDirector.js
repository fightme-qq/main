/**
 * The tension director: decides when the world is allowed to scare the player.
 *
 * ## Why a director instead of random one-shots
 *
 * Sprinkling `Math.random()` calls through gameplay produces two failure modes at
 * once: long stretches where nothing happens, and clusters where four stings fire
 * in ten seconds. Both destroy tension — the first by boredom, the second by
 * turning the horror into noise. A director keeps a timer, respects a minimum gap,
 * never repeats the same event twice in a row, and scales its patience with the
 * time of day.
 *
 * ## What it drives
 *
 *  - **Distant events** — knocks, whispers, scrapes, far roars, footsteps. They are
 *    placed 10–26 blocks away in a random direction, so the player hears a
 *    *direction* and has to decide what it means. Panic comes from ambiguity.
 *  - **Heartbeat** — a quiet loop that rises with low health and with the depth of
 *    the night; it is the player's own body, not a monster.
 *  - **Music phase** — delegated to the mixer, but the phase is chosen here so one
 *    place owns "how the world feels right now".
 *
 * The director never spawns creatures. When the AI stage lands, threats feed their
 * own sounds; this module keeps the world itself feeling watched.
 */

import { clamp01 } from '../utils/MathUtils.js';

/** Event pools per phase, with weights. Higher weight is more common. */
const EVENT_POOLS = {
  // Daylight is not safe, only quieter: a distant sting every minute or two keeps
  // the player from settling into "it is daytime, nothing can happen".
  day: [
    ['horror_sting_subtle_01', 3],
    ['horror_branch_snap_01', 2],
    ['horror_sting_distant_01', 2],
    ['creature_stalker_distant_01', 1],
  ],
  dusk: [
    ['horror_sting_distant_01', 3],
    ['horror_footsteps_distant_01', 3],
    ['horror_branch_snap_01', 2],
    ['horror_sting_subtle_01', 2],
  ],
  night: [
    ['horror_knock_01', 3],
    ['horror_whisper_distant_01', 3],
    ['horror_scrape_01', 2],
    ['horror_roar_distant_01', 1],
    ['horror_footsteps_distant_01', 2],
    ['horror_footsteps_behind_01', 1],
    ['horror_static_01', 1],
    ['creature_stalker_distant_01', 2],
  ],
  cave: [
    ['horror_scrape_01', 3],
    ['horror_whisper_distant_01', 2],
    ['horror_impact_01', 2],
    ['horror_knock_01', 1],
  ],
};

/** Minimum and maximum gap between events, by phase. Night is the most active. */
const GAPS = {
  day: [75, 150],
  dusk: [38, 78],
  night: [22, 52],
  cave: [40, 85],
};

/** Music phase for the mixer. */
const MUSIC_PHASE = {
  menu: 'music.menu',
  day: 'music.day',
  dusk: 'music.dusk',
  night: 'music.night',
  cave: 'music.cave',
};

export class TensionDirector {
  /**
   * @param {Object} options
   * @param {import('../audio/AudioManager.js').AudioManager} options.audio
   * @param {() => number} [options.random]
   */
  constructor({ audio, random = Math.random }) {
    this._audio = audio;
    this._random = random;

    /** Seconds until the next scripted event. */
    this._nextEvent = 18;
    /** Last event id, so the same sound never fires twice in a row. */
    this._lastEvent = null;
    /** Music key currently requested. */
    this._musicKey = null;
    /** Heartbeat loop volume, eased so it does not pop. */
    this._heartbeat = 0;
    /** True once the director has run, used by diagnostics and tests. */
    this.enabled = true;
  }

  /**
   * Advances the director.
   *
   * @param {number} dt Seconds.
   * @param {Object} state
   * @param {string} state.phase 'menu'|'day'|'dusk'|'night'|'cave'
   * @param {number} state.daylight 0..1
   * @param {boolean} state.underground
   * @param {{x: number, y: number, z: number}} state.position Player position.
   * @param {number} state.healthFraction 0..1
   * @param {boolean} [state.paused] Suppresses events but keeps loops alive.
   */
  update(dt, state) {
    if (!this.enabled) return;
    const paused = state.paused === true || state.phase === 'menu';

    const phase = state.phase ?? 'day';
    this._updateMusic(phase);
    this._updateHeartbeat(dt, state, paused);

    if (paused) return;

    const pool = EVENT_POOLS[phase] ?? EVENT_POOLS.night;
    this._nextEvent -= dt;
    if (this._nextEvent > 0) return;

    this._fireEvent(pool, phase, state);
    const [min, max] = GAPS[phase] ?? GAPS.night;
    // Deep night (daylight near zero) is busier than the edge of dusk.
    const activity = phase === 'night' ? 1 - clamp01(state.daylight ?? 0) * 0.5 : 0.75;
    this._nextEvent = (min + this._random() * (max - min)) / Math.max(0.6, activity);
  }

  /** Chooses and plays one distant event. */
  _fireEvent(pool, phase, state) {
    const candidates = pool.filter(([id]) => id !== this._lastEvent);
    const source = candidates.length > 0 ? candidates : pool;
    let total = 0;
    for (const [, weight] of source) total += weight;
    let roll = this._random() * total;
    let chosen = source[source.length - 1][0];
    for (const [id, weight] of source) {
      roll -= weight;
      if (roll <= 0) {
        chosen = id;
        break;
      }
    }
    this._lastEvent = chosen;

    const position = state.position
      ? this._eventPosition(state.position, chosen)
      : undefined;
    // Behind-the-player events are the one place where a fixed point is honest:
    // the whole point is that it came from where the player is not looking.
    this._audio.playLibrarySound(chosen, {
      position,
      volume: phase === 'night' ? 0.85 : 0.7,
      hrtf: true,
    });
  }

  /** Places an event in a ring around the player, never at their feet. */
  _eventPosition(origin) {
    const angle = this._random() * Math.PI * 2;
    const distance = 10 + this._random() * 16;
    return {
      x: origin.x + Math.cos(angle) * distance,
      y: origin.y + 0.5 + this._random() * 2,
      z: origin.z + Math.sin(angle) * distance,
    };
  }

  /** Crossfades the music layer for the current phase. */
  _updateMusic(phase) {
    const key = MUSIC_PHASE[phase] ?? MUSIC_PHASE.day;
    if (key === this._musicKey) return;
    this._musicKey = key;
    this._audio.setMusicPhase?.(phase);
  }

  /**
   * Heartbeat: the player's own body is the one sound that should never lie about
   * danger. It rises with low health and, more quietly, with the night itself.
   */
  _updateHeartbeat(dt, state, paused) {
    const health = clamp01(state.healthFraction ?? 1);
    const night = state.phase === 'night' || state.phase === 'cave' ? 0.18 : 0;
    const lowHealth = health < 0.55 ? (0.55 - health) / 0.55 : 0;
    const target = paused ? 0 : Math.min(0.65, night + lowHealth * 0.65);
    const ease = 1 - Math.exp(-dt / 0.8);
    this._heartbeat += (target - this._heartbeat) * ease;
    this._audio.setLoop('player.heartbeat.fast', this._heartbeat);
  }

  /** Diagnostics for the debug overlay. */
  getStats() {
    return {
      nextEvent: Math.max(0, Math.round(this._nextEvent * 10) / 10),
      lastEvent: this._lastEvent,
      music: this._musicKey,
      heartbeat: Math.round(this._heartbeat * 100) / 100,
    };
  }
}

export default TensionDirector;
