/**
 * Procedurally synthesised sound effects.
 *
 * Every sound in the game is generated from noise and oscillators into an
 * `AudioBuffer` at startup. Nothing is downloaded and nothing is copied from
 * another game, which is the same rule the texture atlas follows.
 *
 * ## Why synthesis rather than sample files
 *
 * A block-break sound is a short transient: a click, a body resonance and a noise
 * tail. That is almost exactly what a filtered noise burst with an envelope *is*,
 * so synthesising it costs a few hundred lines and no network requests, and it
 * gives per-material variation for free — the same recipe with a different centre
 * frequency and decay reads as stone, wood or sand.
 *
 * ## The DSP used
 *
 * Deliberately minimal, all single-sample-state filters:
 *
 *  - one-pole low-pass and high-pass for spectral shaping;
 *  - a two-pole resonant band-pass for the "body" of a material;
 *  - exponential and linear envelopes;
 *  - a seeded PRNG so a given sound is byte-identical every session.
 *
 * That is enough for every sound here and avoids pulling in a synthesis library.
 */

import { mulberry32, clamp } from '../utils/MathUtils.js';
import { SoundGroup } from '../world/BlockTypes.js';

/** Volume categories, matching the audio settings group. */
export const SoundCategory = Object.freeze({
  MUSIC: 'music',
  AMBIENT: 'ambient',
  BLOCKS: 'blocks',
  WEATHER: 'weather',
  PLAYER: 'player',
  CREATURES: 'creatures',
  HORROR: 'horror',
  UI: 'ui',
});

// ---------------------------------------------------------------- DSP helpers

/** One-pole low-pass. `cutoff` is a normalised coefficient in (0, 1]. */
function createLowPass(cutoff) {
  let state = 0;
  return (input) => {
    state += (input - state) * cutoff;
    return state;
  };
}

/** One-pole high-pass, built as input minus its own low-passed version. */
function createHighPass(cutoff) {
  let state = 0;
  return (input) => {
    state += (input - state) * cutoff;
    return input - state;
  };
}

/**
 * Two-pole resonant band-pass.
 *
 * This is what gives a material its identity: stone rings around 260 Hz, wood
 * around 420 Hz, glass up at 2.4 kHz. `q` controls how long it rings.
 */
function createResonator(sampleRate, frequency, q) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const alpha = Math.sin(omega) / (2 * q);
  const norm = 1 / (1 + alpha);
  const b0 = alpha * norm;
  const b2 = -alpha * norm;
  const a1 = -2 * Math.cos(omega) * norm;
  const a2 = (1 - alpha) * norm;

  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  return (input) => {
    const output = b0 * input + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = input;
    y2 = y1;
    y1 = output;
    return output;
  };
}

/** Exponential decay envelope, 1 at t=0. */
function decay(t, rate) {
  return Math.exp(-t * rate);
}

/** Short attack followed by exponential decay. */
function pluck(t, attack, rate) {
  const rise = attack <= 0 ? 1 : Math.min(1, t / attack);
  return rise * decay(Math.max(0, t - attack), rate);
}

// --------------------------------------------------------------- sound recipes

/**
 * A material impact: a noise transient through a resonator, plus a low thump.
 *
 * @param {Object} spec
 * @param {number} spec.frequency Resonant body frequency in Hz.
 * @param {number} spec.q Resonance sharpness.
 * @param {number} spec.decayRate Envelope decay rate.
 * @param {number} spec.noise Amount of unfiltered noise mixed in.
 * @param {number} spec.thump Amount of low sine "body".
 * @param {number} spec.thumpFrequency
 * @param {number} spec.brightness High-pass amount, 0..1.
 */
function impact(spec) {
  return (data, sampleRate, random) => {
    const resonator = createResonator(sampleRate, spec.frequency, spec.q);
    const highPass = createHighPass(clamp(spec.brightness, 0.01, 0.99));
    const lowPass = createLowPass(0.35);
    const length = data.length;

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const envelope = pluck(t, 0.0015, spec.decayRate);
      const white = random() * 2 - 1;

      let sample = resonator(white) * 3.1;
      sample += highPass(white) * spec.noise;
      // Low body: a decaying sine an octave or two below the resonance.
      sample += Math.sin(2 * Math.PI * spec.thumpFrequency * t) * spec.thump * decay(t, spec.decayRate * 1.6);
      sample = lowPass(sample);

      data[i] = clamp(sample * envelope, -1, 1);
    }
  };
}

/** Granular scuff: many tiny noise grains, used for sand and gravel. */
function granular(spec) {
  return (data, sampleRate, random) => {
    const highPass = createHighPass(spec.brightness);
    const lowPass = createLowPass(spec.smoothing);
    const grainLength = Math.max(1, Math.floor(sampleRate * spec.grainSeconds));
    let grainEnergy = 0;

    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      if (i % grainLength === 0) grainEnergy = random();
      const white = (random() * 2 - 1) * grainEnergy;
      const shaped = lowPass(highPass(white));
      data[i] = clamp(shaped * spec.gain * decay(t, spec.decayRate), -1, 1);
    }
  };
}

/** Soft rustle for foliage: band-limited noise with a slow amplitude wobble. */
function rustle(spec) {
  return (data, sampleRate, random) => {
    const band = createResonator(sampleRate, spec.frequency, 1.1);
    const highPass = createHighPass(0.4);
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      const white = random() * 2 - 1;
      const wobble = 0.7 + 0.3 * Math.sin(2 * Math.PI * 24 * t);
      data[i] = clamp(band(highPass(white)) * 2.4 * wobble * decay(t, spec.decayRate), -1, 1);
    }
  };
}

/** Water splash: bright noise sweeping down into a bubbly tail. */
function splash(spec) {
  return (data, sampleRate, random) => {
    let cutoff = 0.9;
    const lowPass = createLowPass(cutoff);
    const bubble = createResonator(sampleRate, spec.bubbleFrequency, 5);
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      // Sweep the low-pass down over the sound's life.
      cutoff = 0.9 * decay(t, 7) + 0.04;
      const white = random() * 2 - 1;
      const body = lowPass(white) * cutoff;
      const tail = bubble(white) * 1.8 * decay(t, 3.2);
      data[i] = clamp((body * 1.4 + tail) * spec.gain * decay(t, spec.decayRate), -1, 1);
    }
  };
}

/** A tonal blip, used for UI feedback and item pickup. */
function blip(spec) {
  return (data, sampleRate) => {
    for (let i = 0; i < data.length; i++) {
      const t = i / sampleRate;
      const progress = t / (data.length / sampleRate);
      const frequency = spec.startFrequency + (spec.endFrequency - spec.startFrequency) * progress;
      // A little second harmonic keeps it from sounding like a test tone.
      const tone =
        Math.sin(2 * Math.PI * frequency * t) * 0.8 +
        Math.sin(4 * Math.PI * frequency * t) * 0.2;
      data[i] = clamp(tone * spec.gain * pluck(t, 0.004, spec.decayRate), -1, 1);
    }
  };
}

/** Seamless looping wind: layered slow-modulated low-passed noise. */
function wind() {
  return (data, sampleRate, random) => {
    const length = data.length;
    const lowA = createLowPass(0.02);
    const lowB = createLowPass(0.006);

    for (let i = 0; i < length; i++) {
      const white = random() * 2 - 1;
      const layerA = lowA(white) * 6;
      const layerB = lowB(white) * 12;
      const t = i / sampleRate;
      // Two slow gusts at incommensurate rates so the loop does not pulse.
      const gust = 0.55 + 0.3 * Math.sin(2 * Math.PI * 0.07 * t) + 0.15 * Math.sin(2 * Math.PI * 0.031 * t);
      data[i] = clamp((layerA * 0.5 + layerB) * gust * 0.5, -1, 1);
    }

    crossfadeLoop(data, sampleRate * 0.35);
  };
}

/** Seamless looping rain: dense high-passed noise with sparse droplet accents. */
function rain() {
  return (data, sampleRate, random) => {
    const highPass = createHighPass(0.55);
    const lowPass = createLowPass(0.45);
    const droplet = createResonator(sampleRate, 2200, 9);

    for (let i = 0; i < data.length; i++) {
      const white = random() * 2 - 1;
      let sample = lowPass(highPass(white)) * 1.6;
      // Occasional individual drops on top of the hiss.
      if (random() > 0.9985) sample += droplet(1) * 0.8;
      else sample += droplet(0) * 0.8;
      data[i] = clamp(sample * 0.55, -1, 1);
    }

    crossfadeLoop(data, sampleRate * 0.25);
  };
}

/**
 * Cross-fades the tail of a buffer into its head so it loops without a click.
 * @param {Float32Array} data
 * @param {number} fadeSamples
 */
function crossfadeLoop(data, fadeSamples) {
  const fade = Math.min(Math.floor(fadeSamples), Math.floor(data.length / 3));
  if (fade <= 1) return;
  const start = data.length - fade;
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    // Equal-power cross-fade keeps the perceived level constant through the seam.
    const fadeOut = Math.cos(t * Math.PI * 0.5);
    const fadeIn = Math.sin(t * Math.PI * 0.5);
    const blended = data[start + i] * fadeOut + data[i] * fadeIn;
    data[start + i] = blended;
  }
  // Trim the very beginning so the head matches the blended tail.
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    data[i] *= Math.sin(t * Math.PI * 0.5) * 0.5 + 0.5;
  }
}

// -------------------------------------------------------------- sound catalogue

/**
 * @typedef {Object} SoundDefinition
 * @property {number} duration Seconds.
 * @property {string} category One of `SoundCategory`.
 * @property {boolean} [loop]
 * @property {number} [gain] Baseline gain applied on playback.
 * @property {number} [pitchVariance] Random playback-rate spread, e.g. 0.12.
 * @property {(data: Float32Array, sampleRate: number, random: () => number) => void} render
 */

/**
 * The material impact recipes, one per sound group. Break and place sounds are
 * derived from the same recipe with a different envelope, which is why a placed
 * block sounds like a quieter, duller version of a broken one.
 * @type {Record<string, Object>}
 */
const MATERIALS = {
  [SoundGroup.STONE]: { frequency: 270, q: 2.6, decayRate: 26, noise: 0.5, thump: 0.5, thumpFrequency: 92, brightness: 0.5 },
  [SoundGroup.DIRT]: { frequency: 190, q: 1.3, decayRate: 30, noise: 0.85, thump: 0.4, thumpFrequency: 70, brightness: 0.35 },
  [SoundGroup.GRASS]: { frequency: 340, q: 1.1, decayRate: 34, noise: 1.1, thump: 0.2, thumpFrequency: 80, brightness: 0.6 },
  [SoundGroup.WOOD]: { frequency: 430, q: 4.5, decayRate: 22, noise: 0.35, thump: 0.55, thumpFrequency: 118, brightness: 0.45 },
  [SoundGroup.SAND]: { frequency: 620, q: 0.9, decayRate: 32, noise: 1.3, thump: 0.15, thumpFrequency: 74, brightness: 0.7 },
  [SoundGroup.GLASS]: { frequency: 2400, q: 8, decayRate: 20, noise: 0.6, thump: 0.1, thumpFrequency: 160, brightness: 0.85 },
  [SoundGroup.PLANT]: { frequency: 900, q: 1.2, decayRate: 40, noise: 1.0, thump: 0.05, thumpFrequency: 90, brightness: 0.72 },
  [SoundGroup.SNOW]: { frequency: 520, q: 0.8, decayRate: 38, noise: 0.95, thump: 0.12, thumpFrequency: 66, brightness: 0.66 },
  [SoundGroup.METAL]: { frequency: 1400, q: 7, decayRate: 18, noise: 0.4, thump: 0.35, thumpFrequency: 210, brightness: 0.6 },
  [SoundGroup.LIQUID]: { frequency: 700, q: 2, decayRate: 24, noise: 0.9, thump: 0.2, thumpFrequency: 110, brightness: 0.5 },
};

/**
 * Builds the full sound catalogue.
 * @returns {Record<string, SoundDefinition>}
 */
export function createSoundCatalogue() {
  /** @type {Record<string, SoundDefinition>} */
  const catalogue = {};

  // Per-material break, place and footstep sounds.
  for (const [group, spec] of Object.entries(MATERIALS)) {
    catalogue[`break.${group}`] = {
      duration: 0.3,
      category: SoundCategory.BLOCKS,
      gain: 0.85,
      pitchVariance: 0.14,
      render: impact(spec),
    };
    catalogue[`place.${group}`] = {
      duration: 0.22,
      category: SoundCategory.BLOCKS,
      gain: 0.6,
      pitchVariance: 0.1,
      // Placing is a softer, duller version: faster decay, less noise.
      render: impact({ ...spec, decayRate: spec.decayRate * 1.5, noise: spec.noise * 0.5 }),
    };
    catalogue[`step.${group}`] =
      group === SoundGroup.SAND || group === SoundGroup.SNOW
        ? {
            duration: 0.2,
            category: SoundCategory.BLOCKS,
            gain: 0.35,
            pitchVariance: 0.2,
            render: granular({
              brightness: 0.6,
              smoothing: 0.5,
              grainSeconds: 0.004,
              gain: 1.6,
              decayRate: 26,
            }),
          }
        : group === SoundGroup.PLANT || group === SoundGroup.GRASS
          ? {
              duration: 0.2,
              category: SoundCategory.BLOCKS,
              gain: 0.32,
              pitchVariance: 0.22,
              render: rustle({ frequency: 1200, decayRate: 32 }),
            }
          : {
              duration: 0.18,
              category: SoundCategory.BLOCKS,
              gain: 0.34,
              pitchVariance: 0.2,
              render: impact({
                ...spec,
                decayRate: spec.decayRate * 2.1,
                noise: spec.noise * 0.7,
                thump: spec.thump * 1.3,
              }),
            };
  }

  // Player actions.
  catalogue['player.jump'] = {
    duration: 0.16,
    category: SoundCategory.BLOCKS,
    gain: 0.3,
    pitchVariance: 0.12,
    render: impact({ frequency: 220, q: 1.2, decayRate: 34, noise: 0.6, thump: 0.35, thumpFrequency: 78, brightness: 0.45 }),
  };
  catalogue['player.land'] = {
    duration: 0.28,
    category: SoundCategory.BLOCKS,
    gain: 0.6,
    pitchVariance: 0.1,
    render: impact({ frequency: 150, q: 1.6, decayRate: 22, noise: 0.7, thump: 0.9, thumpFrequency: 58, brightness: 0.32 }),
  };
  catalogue['player.splash'] = {
    duration: 0.6,
    category: SoundCategory.BLOCKS,
    gain: 0.7,
    pitchVariance: 0.16,
    render: splash({ gain: 1.1, decayRate: 5.5, bubbleFrequency: 900 }),
  };
  catalogue['player.swim'] = {
    duration: 0.42,
    category: SoundCategory.BLOCKS,
    gain: 0.34,
    pitchVariance: 0.24,
    render: splash({ gain: 0.7, decayRate: 8, bubbleFrequency: 640 }),
  };
  catalogue.pickup = {
    duration: 0.14,
    category: SoundCategory.UI,
    gain: 0.42,
    pitchVariance: 0.2,
    render: blip({ startFrequency: 620, endFrequency: 1180, gain: 0.7, decayRate: 26 }),
  };

  // Survival feedback.
  //
  // A snapping tool: a short bright crack rather than a tonal blip, so it is
  // immediately distinguishable from a pickup even with the volume low.
  catalogue['tool.break'] = {
    duration: 0.26,
    category: SoundCategory.BLOCKS,
    gain: 0.7,
    pitchVariance: 0.16,
    render: impact({
      frequency: 1900,
      q: 0.7,
      decayRate: 30,
      noise: 0.95,
      thump: 0.3,
      thumpFrequency: 190,
      brightness: 0.95,
    }),
  };
  // Taking damage: a dull downward thud in the chest register, deliberately
  // unpleasant and clearly not a block sound.
  catalogue['player.hurt'] = {
    duration: 0.3,
    category: SoundCategory.BLOCKS,
    gain: 0.62,
    pitchVariance: 0.12,
    render: impact({
      frequency: 150,
      q: 1.1,
      decayRate: 16,
      noise: 0.45,
      thump: 0.9,
      thumpFrequency: 82,
      brightness: 0.3,
    }),
  };
  // Eating: repeated soft granular bites, played once per chew tick.
  catalogue['player.eat'] = {
    duration: 0.16,
    category: SoundCategory.BLOCKS,
    gain: 0.4,
    pitchVariance: 0.26,
    render: granular({
      brightness: 0.42,
      smoothing: 0.65,
      grainSeconds: 0.006,
      gain: 1.2,
      decayRate: 30,
    }),
  };
  // Combat. A bladed swing is a bright, short slice; a blunt one is a duller
  // thud, so the player can hear which they are using without looking.
  catalogue['attack.sharp'] = {
    duration: 0.18,
    category: SoundCategory.BLOCKS,
    gain: 0.5,
    pitchVariance: 0.2,
    render: granular({
      brightness: 0.9,
      smoothing: 0.2,
      grainSeconds: 0.003,
      gain: 1.5,
      decayRate: 42,
    }),
  };
  catalogue['attack.blunt'] = {
    duration: 0.2,
    category: SoundCategory.BLOCKS,
    gain: 0.5,
    pitchVariance: 0.18,
    render: impact({
      frequency: 320,
      q: 1.3,
      decayRate: 28,
      noise: 0.5,
      thump: 0.7,
      thumpFrequency: 130,
      brightness: 0.35,
    }),
  };
  // Living-creature feedback. These are intentionally species-neutral at the
  // registry level; MobEntity varies pitch per event, which keeps the catalogue
  // compact while still giving a herd or combat encounter audible variation.
  catalogue['mob.hurt'] = {
    duration: 0.24,
    category: SoundCategory.BLOCKS,
    gain: 0.56,
    pitchVariance: 0.22,
    render: impact({
      frequency: 210,
      q: 1.15,
      decayRate: 21,
      noise: 0.5,
      thump: 0.65,
      thumpFrequency: 104,
      brightness: 0.36,
    }),
  };
  catalogue['mob.attack'] = {
    duration: 0.2,
    category: SoundCategory.BLOCKS,
    gain: 0.6,
    pitchVariance: 0.18,
    render: granular({
      brightness: 0.66,
      smoothing: 0.43,
      grainSeconds: 0.0035,
      gain: 1.4,
      decayRate: 31,
    }),
  };
  catalogue['mob.death'] = {
    duration: 0.46,
    category: SoundCategory.BLOCKS,
    gain: 0.68,
    pitchVariance: 0.2,
    render: impact({
      frequency: 128,
      q: 0.9,
      decayRate: 10,
      noise: 0.6,
      thump: 1.0,
      thumpFrequency: 62,
      brightness: 0.24,
    }),
  };
  // Ranged combat and shield feedback use their own transients rather than
  // silently falling through the catalogue. The bow is a woody snap with a
  // short string overtone; projectile impacts are deliberately tiny so a volley
  // does not overwhelm footsteps and combat cues.
  catalogue['item.bow_shoot'] = {
    duration: 0.22,
    category: SoundCategory.BLOCKS,
    gain: 0.56,
    pitchVariance: 0.1,
    render: impact({
      frequency: 880,
      q: 3.4,
      decayRate: 27,
      noise: 0.38,
      thump: 0.28,
      thumpFrequency: 168,
      brightness: 0.72,
    }),
  };
  catalogue['projectile.hit'] = {
    duration: 0.16,
    category: SoundCategory.BLOCKS,
    gain: 0.42,
    pitchVariance: 0.18,
    render: impact({
      frequency: 540,
      q: 1.5,
      decayRate: 36,
      noise: 0.48,
      thump: 0.44,
      thumpFrequency: 138,
      brightness: 0.5,
    }),
  };
  catalogue['projectile.hit_block'] = {
    duration: 0.14,
    category: SoundCategory.BLOCKS,
    gain: 0.34,
    pitchVariance: 0.22,
    render: impact({
      frequency: 1480,
      q: 4.2,
      decayRate: 41,
      noise: 0.32,
      thump: 0.18,
      thumpFrequency: 180,
      brightness: 0.82,
    }),
  };
  catalogue['item.shield_block'] = {
    duration: 0.24,
    category: SoundCategory.BLOCKS,
    gain: 0.72,
    pitchVariance: 0.12,
    render: impact({
      frequency: 1160,
      q: 5.2,
      decayRate: 23,
      noise: 0.4,
      thump: 0.7,
      thumpFrequency: 148,
      brightness: 0.66,
    }),
  };
  catalogue['item.shield_break'] = {
    duration: 0.34,
    category: SoundCategory.BLOCKS,
    gain: 0.82,
    pitchVariance: 0.12,
    render: impact({
      frequency: 720,
      q: 1.1,
      decayRate: 18,
      noise: 1.0,
      thump: 0.65,
      thumpFrequency: 112,
      brightness: 0.78,
    }),
  };
  // Tilling soil: a scrape followed by a soft settle.
  catalogue['block.till'] = {
    duration: 0.28,
    category: SoundCategory.BLOCKS,
    gain: 0.55,
    pitchVariance: 0.16,
    render: granular({
      brightness: 0.35,
      smoothing: 0.7,
      grainSeconds: 0.005,
      gain: 1.3,
      decayRate: 20,
    }),
  };
  catalogue['block.plant'] = {
    duration: 0.18,
    category: SoundCategory.BLOCKS,
    gain: 0.4,
    pitchVariance: 0.22,
    render: granular({
      brightness: 0.48,
      smoothing: 0.72,
      grainSeconds: 0.004,
      gain: 1.05,
      decayRate: 28,
    }),
  };
  catalogue['item.ignite'] = {
    duration: 0.22,
    category: SoundCategory.BLOCKS,
    gain: 0.56,
    pitchVariance: 0.18,
    render: impact({
      frequency: 1320,
      q: 1.4,
      decayRate: 24,
      noise: 1.15,
      thump: 0.12,
      thumpFrequency: 180,
      brightness: 0.92,
    }),
  };
  catalogue['item.bucket'] = {
    duration: 0.3,
    category: SoundCategory.BLOCKS,
    gain: 0.48,
    pitchVariance: 0.12,
    render: impact({
      frequency: 180,
      q: 1.1,
      decayRate: 14,
      noise: 0.72,
      thump: 0.35,
      thumpFrequency: 95,
      brightness: 0.55,
    }),
  };
  // A wooden creak for a chest lid.
  catalogue['chest.open'] = {
    duration: 0.34,
    category: SoundCategory.BLOCKS,
    gain: 0.5,
    pitchVariance: 0.18,
    render: impact({
      frequency: 260,
      q: 1.6,
      decayRate: 11,
      noise: 0.55,
      thump: 0.45,
      thumpFrequency: 120,
      brightness: 0.4,
    }),
  };
  // A soft chime for finishing a meal, so the action has a clear end.
  catalogue['player.burp'] = {
    duration: 0.2,
    category: SoundCategory.BLOCKS,
    gain: 0.34,
    pitchVariance: 0.14,
    render: blip({ startFrequency: 300, endFrequency: 170, gain: 0.6, decayRate: 18 }),
  };
  catalogue['player.levelup'] = {
    duration: 0.45,
    category: SoundCategory.UI,
    gain: 0.55,
    pitchVariance: 0.08,
    render: (data, sampleRate) => {
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const dur = data.length / sampleRate;
        const env = Math.exp(-t * 3) * (1 - 0.45 * (t / dur));
        const f0 = 520 * Math.pow(2, t * 1.2);
        const tone = Math.sin(2 * Math.PI * f0 * t) * 0.7 + Math.sin(4 * Math.PI * f0 * t) * 0.22;
        const chime = Math.sin(2 * Math.PI * 880 * t) * 0.18 * Math.exp(-t * 7);
        data[i] = clamp((tone + chime) * env * 0.8, -1, 1);
      }
    },
  };

  // Interface.
  catalogue['ui.click'] = {
    duration: 0.07,
    category: SoundCategory.UI,
    gain: 0.4,
    render: blip({ startFrequency: 900, endFrequency: 760, gain: 0.55, decayRate: 48 }),
  };
  catalogue['ui.select'] = {
    duration: 0.06,
    category: SoundCategory.UI,
    gain: 0.28,
    render: blip({ startFrequency: 1250, endFrequency: 1250, gain: 0.4, decayRate: 60 }),
  };
  // Fallback for the generated craft-success sound. It exists in the synthesized
  // catalogue so the event table stays valid — and so crafting keeps a sound when
  // the file library has not been generated or failed to load.
  catalogue['craft.complete'] = {
    duration: 0.26,
    category: SoundCategory.UI,
    gain: 0.38,
    pitchVariance: 0.05,
    render: impact({
      frequency: 430,
      q: 2.1,
      decayRate: 24,
      noise: 0.32,
      thump: 0.22,
      thumpFrequency: 168,
      brightness: 0.34,
    }),
  };
  catalogue['ui.back'] = {
    duration: 0.09,
    category: SoundCategory.UI,
    gain: 0.36,
    render: blip({ startFrequency: 700, endFrequency: 420, gain: 0.5, decayRate: 38 }),
  };

  // Loops.
  catalogue['ambient.wind'] = {
    duration: 6,
    category: SoundCategory.AMBIENT,
    loop: true,
    gain: 0.5,
    render: wind(),
  };
  catalogue['weather.rain'] = {
    duration: 4,
    category: SoundCategory.WEATHER,
    loop: true,
    gain: 0.7,
    render: rain(),
  };
  catalogue['ambient.underwater'] = {
    duration: 5,
    category: SoundCategory.AMBIENT,
    loop: true,
    gain: 0.55,
    render: (data, sampleRate, random) => {
      // Muffled rumble plus occasional bubbles.
      const lowPass = createLowPass(0.008);
      const bubble = createResonator(sampleRate, 480, 12);
      for (let i = 0; i < data.length; i++) {
        const white = random() * 2 - 1;
        let sample = lowPass(white) * 16;
        if (random() > 0.9994) sample += bubble(1) * 0.5;
        else sample += bubble(0) * 0.5;
        data[i] = clamp(sample * 0.55, -1, 1);
      }
      crossfadeLoop(data, sampleRate * 0.3);
    },
  };

  // Phase 4. The Nether replaces wind entirely: a low pressure rumble with
  // sporadic ember crackle. Deliberately quieter than wind so that ghast and
  // blaze cues still cut through it.
  catalogue['ambient.nether'] = {
    duration: 7,
    category: SoundCategory.AMBIENT,
    loop: true,
    gain: 0.48,
    render: (data, sampleRate, random) => {
      const rumble = createLowPass(0.0035);
      const crackle = createResonator(sampleRate, 1650, 26);
      const groan = createResonator(sampleRate, 88, 6);
      for (let i = 0; i < data.length; i++) {
        const white = random() * 2 - 1;
        let sample = rumble(white) * 22;
        sample += groan(white * 0.05) * 0.3;
        // Embers are rare and short, so they read as distant fire rather than static.
        if (random() > 0.9988) sample += crackle(1) * 0.34;
        else sample += crackle(0) * 0.34;
        data[i] = clamp(sample * 0.5, -1, 1);
      }
      crossfadeLoop(data, sampleRate * 0.4);
    },
  };

  // Phase 5. An airy, dissonant drone with distant bell partials gives the End
  // its own identity without borrowing copyrighted music or sample assets.
  catalogue['ambient.end'] = {
    duration: 8,
    category: SoundCategory.AMBIENT,
    loop: true,
    gain: 0.42,
    render: (data, sampleRate, random) => {
      const air = createLowPass(0.0018);
      const bellA = createResonator(sampleRate, 247, 34);
      const bellB = createResonator(sampleRate, 370, 42);
      for (let i = 0; i < data.length; i++) {
        const white = random() * 2 - 1;
        const impulse = random() > 0.99975 ? 1 : 0;
        const sample = air(white) * 24 + bellA(impulse) * .22 + bellB(impulse) * .14;
        data[i] = clamp(sample * .42, -1, 1);
      }
      crossfadeLoop(data, sampleRate * .5);
    },
  };

  catalogue['mob.ender_dragon.roar'] = {
    duration: 2.4,
    category: SoundCategory.AMBIENT,
    gain: 0.82,
    pitchVariance: 0.035,
    render: (data, sampleRate, random) => {
      const throat = createLowPass(0.018);
      const chest = createResonator(sampleRate, 71, 8);
      const rasp = createResonator(sampleRate, 510, 18);
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const envelope = Math.sin(Math.min(1, t / 0.22) * Math.PI * .5) * Math.exp(-t * .7);
        const pulse = Math.sin(t * Math.PI * 2 * (84 - t * 11));
        const noise = random() * 2 - 1;
        data[i] = clamp((chest(pulse) * 1.8 + throat(noise) * 7 + rasp(noise * .18)) * envelope * .52, -1, 1);
      }
    },
  };

  catalogue['music.dragon'] = {
    duration: 12,
    category: SoundCategory.MUSIC,
    loop: true,
    gain: 0.44,
    render: (data, sampleRate, random) => {
      const drone = createLowPass(0.0025);
      for (let i = 0; i < data.length; i++) {
        const t = i / sampleRate;
        const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 1.5)), 12);
        const bass = Math.sin(t * Math.PI * 2 * 55) * .25;
        const fifth = Math.sin(t * Math.PI * 2 * 82.5) * .11;
        const air = drone(random() * 2 - 1) * 12;
        data[i] = clamp((bass + fifth + air + beat * .18) * .62, -1, 1);
      }
      crossfadeLoop(data, sampleRate * .6);
    },
  };

  return catalogue;
}

/**
 * Renders one definition into an `AudioBuffer`.
 *
 * @param {BaseAudioContext} context
 * @param {string} name Used to seed the PRNG so the sound is reproducible.
 * @param {SoundDefinition} definition
 * @returns {AudioBuffer}
 */
export function renderSound(context, name, definition) {
  const sampleRate = context.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * definition.duration));
  const buffer = context.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);

  // Seed from the name so the same sound is identical across sessions and
  // devices, while different sounds are uncorrelated.
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const random = mulberry32(hash >>> 0);

  definition.render(data, sampleRate, random);
  return buffer;
}

/**
 * Maps a block's sound group to the catalogue key for an action.
 * @param {string} action `'break'`, `'place'` or `'step'`
 * @param {string} soundGroup
 */
export function soundKeyFor(action, soundGroup) {
  const group = MATERIALS[soundGroup] ? soundGroup : SoundGroup.STONE;
  return `${action}.${group}`;
}

export default createSoundCatalogue;
