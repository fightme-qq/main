/**
 * The noise field: a short-lived record of how loud the player has just been.
 *
 * ## Why it is a system rather than an event
 *
 * A single "player made a sound" event tells a creature *that* something happened,
 * but not *where* or *how loud*. Converting it into an event per listener would mean
 * every mob subscribing to every gameplay event; instead the world keeps a small
 * decaying list of pulses and each predator asks "what is the loudest thing near
 * me right now?".
 *
 * Pulses fade over `LIFETIME` seconds, so a chase never starts from a footstep the
 * player took ten seconds ago, and the loudest pulse wins rather than the newest —
 * sprinting past a creature should out-shout a distant door.
 *
 * Pure data, no imports: the AI self-test uses it directly.
 */

/** Seconds a pulse stays audible. */
export const NOISE_LIFETIME = 2.6;
const MAX_PULSES = 24;

export class NoiseSystem {
  constructor() {
    /** @type {Array<{x:number,y:number,z:number,radius:number,age:number,source:string}>} */
    this.pulses = [];
  }

  /**
   * Records one noise pulse.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} radius How far the sound carries, in blocks.
   * @param {string} [source] 'sprint'|'step'|'mine'|'combat'|'door'
   */
  emit(x, y, z, radius, source = 'unknown') {
    if (!(radius > 0)) return;
    this.pulses.push({ x, y, z, radius, age: 0, source });
    if (this.pulses.length > MAX_PULSES) this.pulses.splice(0, this.pulses.length - MAX_PULSES);
  }

  /** Ages and drops pulses. Call once per frame. */
  update(dt) {
    if (this.pulses.length === 0) return;
    let write = 0;
    for (let read = 0; read < this.pulses.length; read++) {
      const pulse = this.pulses[read];
      pulse.age += dt;
      if (pulse.age >= NOISE_LIFETIME) continue;
      this.pulses[write++] = pulse;
    }
    this.pulses.length = write;
  }

  /**
   * Loudest pulse that can reach a position.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} [hearing] Maximum radius to consider.
   * @returns {{x:number,y:number,z:number,strength:number,distance:number,source:string}|null}
   */
  loudestNear(x, z, hearing = 24) {
    let best = null;
    let bestStrength = 0;
    for (const pulse of this.pulses) {
      const attenuation = 1 - pulse.age / NOISE_LIFETIME;
      if (attenuation <= 0) continue;
      const reach = Math.min(pulse.radius, hearing);
      const distance = Math.hypot(pulse.x - x, pulse.z - z);
      if (distance > reach) continue;
      const strength = (1 - distance / reach) * attenuation;
      if (strength > bestStrength) {
        bestStrength = strength;
        best = {
          x: pulse.x,
          y: pulse.y,
          z: pulse.z,
          strength: Math.round(strength * 100) / 100,
          distance: Math.round(distance * 10) / 10,
          source: pulse.source,
        };
      }
    }
    return best;
  }

  /** Pulse count, for the debug overlay and tests. */
  get size() {
    return this.pulses.length;
  }

  clear() {
    this.pulses.length = 0;
  }
}

export default NoiseSystem;
