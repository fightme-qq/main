/**
 * Web Audio mixer and playback.
 *
 * ## Autoplay and the first gesture
 *
 * Browsers refuse to start an `AudioContext` before the user has interacted with
 * the page, and a context created too early lands in the `suspended` state where
 * it stays until resumed. So construction is deferred entirely: nothing is created
 * until `unlock()` is called from a real click, key press or touch. Every call
 * before that is a silent no-op rather than a queued sound, because a burst of
 * delayed sounds firing the moment audio unlocks is worse than silence.
 *
 * ## Mixer graph
 *
 * ```
 * source -> [voice gain] -> [category gain] -> [master gain] -> destination
 * ```
 *
 * Category gains map one-to-one onto the audio settings group, so a slider moves
 * exactly one node. Gain changes use short ramps rather than direct assignment:
 * setting `gain.value` mid-playback produces an audible click.
 *
 * ## Voices
 *
 * `AudioBufferSourceNode` is single-use by design — the correct pattern is one per
 * playback — but the *buffers* are rendered once at startup and shared, and the
 * number of simultaneous voices per category is capped. That is what stops a
 * cave-in from spawning two hundred overlapping impacts and clipping the mix.
 */

import { Events } from '../core/EventBus.js';
import { clamp } from '../utils/MathUtils.js';
import { phaseAt } from '../config/DayCycle.js';
import { SoundCategory, createSoundCatalogue, renderSound, soundKeyFor } from './SoundRegistry.js';
import { SoundEventThrottle, resolveSoundEvent } from './SoundEvents.js';
import {
  DIRECT_SOUND_IDS,
  FALLBACK_ALIASES,
  FILE_LOOP_MAP,
  FILE_SOUND_MAP,
  normaliseManifest,
  soundFileUrl,
} from './SoundLibrary.js';

/** Maximum simultaneous one-shot voices per category. */
const VOICE_LIMITS = {
  [SoundCategory.BLOCKS]: 10,
  [SoundCategory.UI]: 4,
  [SoundCategory.AMBIENT]: 4,
  [SoundCategory.WEATHER]: 3,
  [SoundCategory.PLAYER]: 6,
  [SoundCategory.CREATURES]: 6,
  [SoundCategory.HORROR]: 4,
  [SoundCategory.MUSIC]: 2,
};

/** Seconds over which volume changes are ramped. */
const RAMP_TIME = 0.06;
/** Minimum gap between two plays of the same sound, in seconds. */
const RETRIGGER_GAP = 0.02;

export class AudioManager {
  /**
   * @param {Object} options
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} options.capabilities
   * @param {string} [options.assetBaseUrl] Base path the manifest is served from.
   */
  constructor({ bus, settings, capabilities, assetBaseUrl = '' }) {
    this._bus = bus;
    this._settings = settings;
    this._caps = capabilities;
    this._assetBaseUrl = assetBaseUrl;

    /** @type {AudioContext|null} */
    this._context = null;
    /** @type {GainNode|null} */
    this._masterGain = null;
    /** @type {Record<string, GainNode>} */
    this._categoryGains = Object.create(null);
    /** @type {Record<string, AudioBuffer>} */
    this._buffers = Object.create(null);
    /** @type {Record<string, Object>} */
    this._catalogue = createSoundCatalogue();
    /** @type {Record<string, number>} Live voice count per category. */
    this._voiceCounts = Object.create(null);
    /** @type {Record<string, number>} Last play time per sound key. */
    this._lastPlayed = Object.create(null);
    /** @type {Map<string, {source: AudioBufferSourceNode, gain: GainNode}>} */
    this._loops = new Map();

    // --- generated library (optional) ---
    /** @type {{entries: Object, format: string}|null} */
    this._library = null;
    /** Variant ids per gameplay key: `step.grass -> [file1, file2, file3]`. */
    this._variants = new Map();
    /** Loop file id per gameplay loop key. */
    this._loopFiles = new Map();
    /** Normalisation gain per library file id. */
    this._fileGains = new Map();
    /** Live media-element loops, keyed by gameplay loop key. */
    this._fileLoops = new Map();
    /** In-flight `loadLibrary` promise, so repeated calls share one load. */
    this._libraryLoading = null;
    /** Number of library files decoded into buffers so far. */
    this._decodedCount = 0;
    /** Timestamp of the last ambience decision, used to throttle biome lookups. */
    this._lastAmbienceAt = 0;
    /** Currently requested music phase, e.g. `music.night`. */
    this._musicKey = null;
    /** Last chosen variant per key, so the same take does not repeat twice. */
    this._lastVariant = new Map();
    /** Live voices routed through a PannerNode, for the debug overlay. */
    this._spatialVoices = 0;

    this.available = Boolean(capabilities.webAudioSupported);
    this.unlocked = false;
    /** True while audio is deliberately silenced (tab hidden). */
    this.ducked = false;
    this._failed = false;
  }

  /** True when sound can currently be heard. */
  get isActive() {
    return this.unlocked && !this._failed && this._context?.state === 'running';
  }

  /** True when a generated library was loaded successfully. */
  get hasLibrary() {
    return this._library !== null;
  }

  /**
   * Creates the context and renders every buffer.
   *
   * Must be called from inside a user-gesture handler. Safe to call repeatedly;
   * subsequent calls only resume a suspended context.
   *
   * @returns {Promise<boolean>} True when audio is running.
   */
  async unlock() {
    if (!this.available || this._failed) return false;

    if (!this._context) {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this._context = new AudioContextClass({ latencyHint: 'interactive' });
        this._buildMixer();
        this._renderBuffers();
      } catch (error) {
        console.warn('[Audio] could not initialise Web Audio:', error);
        this._failed = true;
        this.available = false;
        return false;
      }
    }

    try {
      if (this._context.state === 'suspended' || this._context.state === 'interrupted') await this._context.resume();
    } catch (error) {
      // iOS in particular can reject a resume that is not close enough to the
      // gesture; the next gesture will try again.
      console.warn('[Audio] resume was rejected:', error);
      return false;
    }

    this.unlocked = this._context.state === 'running';
    if (this.unlocked) {
      this.applySettings(this._settings.values.audio);
      // The manifest may have been fetched before the context existed; decoding
      // needs the context, so it happens here.
      if (this._library) void this._decodeLibraryFiles();
    }
    return this.unlocked;
  }

  /**
   * Loads the generated ElevenLabs library, if one was shipped.
   *
   * Deliberately optional and non-throwing: the synthesized catalogue is the
   * fallback, so a missing manifest, a partial library or a failed decode degrades
   * the audio rather than breaking it. Every failure path logs once and leaves the
   * mixer on synthesis.
   *
   * @returns {Promise<boolean>} True when a usable manifest was applied.
   */
  async loadLibrary() {
    if (!this.available) return false;
    if (this._libraryLoading) return this._libraryLoading;

    this._libraryLoading = (async () => {
      try {
        const url = new URL(`${this._assetBaseUrl}assets/audio/manifest.json`, document.baseURI);
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) {
          console.info('[Audio] generated sound library not found; using synthesis');
          return false;
        }
        const parsed = normaliseManifest(await response.json());
        if (!parsed.ok) {
          console.warn('[Audio] sound manifest rejected:', parsed.errors.slice(0, 5).join('; '));
          return false;
        }
        this._library = parsed;
        this._buildLibraryCatalogue(parsed.entries);
        console.info(
          `[Audio] sound library: ${Object.keys(parsed.entries).length} generated files`
        );
        if (this._context) await this._decodeLibraryFiles();
        return true;
      } catch (error) {
        console.info('[Audio] generated sound library unavailable:', error.message);
        return false;
      }
    })();

    return this._libraryLoading;
  }

  /**
   * Merges library entries into the catalogue.
   *
   * Gameplay keys keep their names, so nothing in the rest of the game needs to
   * know whether a sound came from the generator or the synthesizer. Mapped keys
   * gain variants and per-file gain; unmapped files stay directly playable by id.
   *
   * @param {Record<string, Object>} entries Normalised manifest entries.
   */
  _buildLibraryCatalogue(entries) {
    const present = (id) => entries[id] ?? null;

    for (const [key, mapping] of Object.entries(FILE_SOUND_MAP)) {
      const ids = mapping.ids.filter((id) => present(id));
      if (ids.length === 0) continue;
      const first = present(ids[0]);
      this._variants.set(key, ids);
      this._catalogue[key] = {
        category: first.mixerCategory,
        gain: 1,
        pitchVariance: mapping.pitchVariance ?? 0.04,
        fileBacked: true,
      };
    }

    for (const [key, mapping] of Object.entries(FILE_LOOP_MAP)) {
      const present_ids = mapping.ids.filter((candidate) => present(candidate));
      if (present_ids.length === 0) continue;
      // A key with several takes picks one per session, so two night tracks
      // alternate between playthroughs rather than inside one night.
      const id = present_ids[Math.floor(Math.random() * present_ids.length)];
      this._loopFiles.set(key, id);
      this._catalogue[key] = {
        category: present(id).mixerCategory,
        gain: 1,
        loop: true,
        fileBacked: true,
      };
    }

    // Creature and horror one-shots are addressed directly by id until the AI stage
    // gives them gameplay events.
    for (const id of DIRECT_SOUND_IDS) {
      const entry = present(id);
      if (entry) {
        this._catalogue[id] = { category: entry.mixerCategory, gain: 1, pitchVariance: 0.03 };
      }
    }
  }

  /**
   * Fetches and decodes every one-shot file.
   *
   * Loops are *not* decoded: a 30-second stereo MP3 becomes ~10 MB of float samples
   * per file, and a dozen of those would dominate the game's memory for sound that
   * is always playing anyway. They stream through `Audio` elements instead.
   */
  async _decodeLibraryFiles() {
    if (!this._library || !this._context || this._decodingLibrary) return;
    this._decodingLibrary = true;
    const context = this._context;
    const queue = Object.values(this._library.entries).filter((entry) => !entry.loop);
    let decoded = 0;

    // Batches keep the decode peak bounded on low-memory devices.
    const BATCH = 6;
    for (let start = 0; start < queue.length; start += BATCH) {
      const batch = queue.slice(start, start + BATCH);
      await Promise.all(
        batch.map(async (entry) => {
          try {
            const url = soundFileUrl(entry, this._assetBaseUrl);
            const response = await fetch(new URL(url, document.baseURI), { cache: 'force-cache' });
            if (!response.ok) return;
            const data = await response.arrayBuffer();
            const buffer = await new Promise((resolve, reject) => {
              context.decodeAudioData(data, resolve, reject);
            });
            this._buffers[entry.id] = buffer;
            this._fileGains.set(entry.id, entry.gain);
            this._decodedCount++;
            decoded++;
          } catch (error) {
            console.warn(`[Audio] could not decode "${entry.id}":`, error.message);
          }
        })
      );
    }
    this._decodingLibrary = false;
    console.info(`[Audio] decoded ${decoded} generated one-shots`);
  }

  _buildMixer() {
    const context = this._context;
    this._masterGain = context.createGain();
    this._masterGain.gain.value = 0.0001;
    this._masterGain.connect(context.destination);

    for (const category of Object.values(SoundCategory)) {
      const gain = context.createGain();
      gain.gain.value = 1;
      gain.connect(this._masterGain);
      this._categoryGains[category] = gain;
      this._voiceCounts[category] = 0;
    }
  }

  /**
   * Renders every catalogue entry.
   *
   * Synchronous and measured in a few tens of milliseconds for the whole set,
   * which is acceptable inside the loading screen and far simpler than an async
   * pipeline that would have to handle partial availability.
   */
  _renderBuffers() {
    const context = this._context;
    const start = performance.now();
    let rendered = 0;

    for (const [name, definition] of Object.entries(this._catalogue)) {
      try {
        this._buffers[name] = renderSound(context, name, definition);
        rendered++;
      } catch (error) {
        // A single failed sound must not take the rest of the game's audio down.
        console.warn(`[Audio] could not render "${name}":`, error);
      }
    }

    const elapsed = performance.now() - start;
    console.info(`[Audio] rendered ${rendered} sounds in ${elapsed.toFixed(0)} ms`);
  }

  // ------------------------------------------------------------------ playback

  /**
   * Plays a one-shot sound.
   *
   * @param {string} name Catalogue key.
   * @param {Object} [options]
   * @param {number} [options.volume] 0..1, multiplied with the baseline gain.
   * @param {number} [options.pitch] Playback rate multiplier.
   * @param {boolean} [options.ignoreLimit] Bypass the per-category voice cap.
   * @returns {boolean} True when a voice was started.
   */
  /**
   * Advances the event throttle's clock. Call once per frame.
   *
   * The throttle keeps its own clock rather than reading `AudioContext.currentTime`
   * so cooldowns behave identically while the context is suspended or the game
   * is paused, and so the whole thing is testable without Web Audio.
   *
   * @param {number} dt Seconds.
   */
  tickEvents(dt) {
    if (!this._eventThrottle) this._eventThrottle = new SoundEventThrottle();
    this._eventThrottle.tick(dt);
  }

  /**
   * Plays a gameplay event.
   *
   * This is the entry point gameplay code should use. `play()` takes a raw
   * buffer name, which is how FinalV2 ended up with thirty synthesised sounds
   * and two call sites: nothing connected the moment to the buffer. An event
   * name is resolved through `SoundEvents`, which the self-test validates, so a
   * mistyped event fails a test instead of going silent.
   *
   * @param {string} event A `GameplayEvent` value.
   * @param {Object} [context]
   * @param {string} [context.soundGroup] Block sound group for material events.
   * @param {number} [context.volumeScale]
   * @param {number} [context.pitchScale]
   * @returns {boolean} True when a buffer was actually started.
   */
  playEvent(event, context = {}) {
    const resolved = resolveSoundEvent(event, context);
    if (!resolved) return false;
    // Per-event throttling, distinct from the per-buffer retrigger guard in
    // play(): footsteps on two different materials are two buffers but one
    // event, and should still be rate-limited as one.
    if (!this._eventThrottle) this._eventThrottle = new SoundEventThrottle();
    if (!this._eventThrottle.allow(event, resolved.cooldown)) return false;
    return this.play(resolved.name, {
      volume: resolved.volume,
      rate: resolved.pitch,
      pitch: resolved.pitch,
      position: context.position,
      occlusion: context.occlusion,
    });
  }

  /**
   * Resolves a gameplay key to a buffer, following variants and fallbacks.
   *
   * Variants are picked at random but never the same take twice in a row: with
   * three footstep files a plain random pick repeats about a third of the time,
   * which is exactly the mechanical rhythm the variants exist to remove.
   *
   * @param {string} name
   * @param {number} [depth] Alias recursion guard.
   * @returns {{name: string, definition: Object, buffer: AudioBuffer, gain: number}|null}
   */
  _resolveSound(name, depth = 0) {
    const variants = this._variants.get(name);
    if (variants) {
      const available = variants.filter((id) => this._buffers[id]);
      if (available.length > 0) {
        let index = Math.floor(Math.random() * available.length);
        if (available.length > 1 && available[index] === this._lastVariant.get(name)) {
          index = (index + 1) % available.length;
        }
        const id = available[index];
        this._lastVariant.set(name, id);
        return {
          name: id,
          definition: this._catalogue[name],
          buffer: this._buffers[id],
          gain: this._fileGains.get(id) ?? 1,
        };
      }
    }

    const definition = this._catalogue[name];
    const buffer = this._buffers[name];
    if (definition && buffer) {
      return { name, definition, buffer, gain: this._fileGains.get(name) ?? 1 };
    }

    const alias = FALLBACK_ALIASES[name];
    if (alias && depth < 2) return this._resolveSound(alias, depth + 1);
    return null;
  }

  play(name, options = {}) {
    if (!this.isActive || this.ducked) return false;

    const resolved = this._resolveSound(name);
    if (!resolved) return false;
    const { definition, buffer } = resolved;

    const context = this._context;
    const now = context.currentTime;

    // Retrigger guard: two identical impacts in the same millisecond just sound
    // like one louder impact, and they consume two voices. Keyed by the resolved
    // file so two variants of one event can still fire back to back.
    if (now - (this._lastPlayed[resolved.name] || -1) < RETRIGGER_GAP) return false;

    const category = definition.category;
    const limit = VOICE_LIMITS[category] ?? 8;
    if (!options.ignoreLimit && (this._voiceCounts[category] || 0) >= limit) return false;

    let source;
    let gain;
    let panner = null;
    try {
      source = context.createBufferSource();
      source.buffer = buffer;

      // Pitch variance makes repeated sounds (footsteps, mining) sound organic
      // instead of like a machine gun.
      const variance = definition.pitchVariance || 0;
      const pitch = (options.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * variance);
      source.playbackRate.value = clamp(pitch, 0.35, 3);

      gain = context.createGain();
      // Library files carry a measured normalisation gain, so a quiet footstep take
      // and a loud growl start at comparable loudness.
      gain.gain.value = clamp(
        (definition.gain ?? 1) * (options.volume ?? 1) * (resolved.gain ?? 1) *
          (options.occlusion ?? 1),
        0,
        4
      );

      source.connect(gain);
      if (options.position && typeof context.createPanner === 'function') {
        panner = this._createPanner(options);
        gain.connect(panner);
        panner.connect(this._categoryGains[category] || this._masterGain);
      } else {
        gain.connect(this._categoryGains[category] || this._masterGain);
      }
      source.start();
    } catch (error) {
      console.warn(`[Audio] could not play "${name}":`, error);
      return false;
    }

    this._lastPlayed[resolved.name] = now;
    this._voiceCounts[category] = (this._voiceCounts[category] || 0) + 1;
    if (panner) this._spatialVoices++;

    source.onended = () => {
      this._voiceCounts[category] = Math.max(0, (this._voiceCounts[category] || 1) - 1);
      if (panner) this._spatialVoices = Math.max(0, this._spatialVoices - 1);
      try {
        source.disconnect();
        gain.disconnect();
        panner?.disconnect();
      } catch {
        // Already torn down.
      }
    };

    return true;
  }

  /**
   * Builds a positional node for one voice.
   *
   * `HRTF` is used for creatures and horror accents because front/back matters for
   * "something is behind me"; cheap sounds (blocks, footstep of the player) stay
   * stereo, where the extra cost buys nothing audible.
   *
   * @param {Object} options
   * @returns {PannerNode}
   */
  _createPanner(options) {
    const context = this._context;
    const panner = context.createPanner();
    panner.panningModel = options.hrtf ? 'HRTF' : 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = options.refDistance ?? 2;
    panner.maxDistance = options.maxDistance ?? 48;
    panner.rolloffFactor = options.rolloff ?? 1.1;
    const { x = 0, y = 0, z = 0 } = options.position;
    const now = context.currentTime;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(x, now);
      panner.positionY.setValueAtTime(y, now);
      panner.positionZ.setValueAtTime(z, now);
    } else {
      panner.setPosition(x, y, z);
    }
    return panner;
  }

  /**
   * Updates the Web Audio listener from the camera.
   *
   * Called every frame; values are ramped rather than set so a fast camera turn
   * does not produce a zipper artefact in positional sounds.
   *
   * @param {{x: number, y: number, z: number}} position
   * @param {{x: number, y: number, z: number}} forward
   */
  setListener(position, forward) {
    if (!this._context) return;
    this._listener = { position, forward };
    const listener = this._context.listener;
    const now = this._context.currentTime;
    const ramp = 0.05;
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(position.x, now, ramp);
      listener.positionY.setTargetAtTime(position.y, now, ramp);
      listener.positionZ.setTargetAtTime(position.z, now, ramp);
      listener.forwardX.setTargetAtTime(forward.x, now, ramp);
      listener.forwardY.setTargetAtTime(forward.y, now, ramp);
      listener.forwardZ.setTargetAtTime(forward.z, now, ramp);
      listener.upX.setTargetAtTime(0, now, ramp);
      listener.upY.setTargetAtTime(1, now, ramp);
      listener.upZ.setTargetAtTime(0, now, ramp);
    } else {
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0);
    }
  }

  /**
   * Plays a generated library sound by id, optionally in space.
   *
   * This is the entry point for creature and horror audio until those systems emit
   * gameplay events of their own.
   *
   * @param {string} id Manifest id.
   * @param {Object} [options] Forwarded to `play`; `position` makes it spatial.
   * @returns {boolean}
   */
  playLibrarySound(id, options = {}) {
    if (!this._library?.entries[id]) return false;
    return this.play(id, {
      hrtf: options.hrtf ?? true,
      ...options,
    });
  }

  /**
   * Plays a block-material sound.
   * @param {string} action `'break'`, `'place'` or `'step'`
   * @param {string} soundGroup
   * @param {Object} [options]
   */
  playMaterial(action, soundGroup, options) {
    return this.play(soundKeyFor(action, soundGroup), options);
  }

  /**
   * Starts or updates a looping sound.
   *
   * @param {string} name Catalogue key; must be a looping definition.
   * @param {number} volume 0..1. Zero stops the loop.
   */
  setLoop(name, volume) {
    if (!this.isActive) return;
    // Generated ambience streams through a media element: decoding half a minute of
    // stereo ambience into memory per layer is not affordable, and a stream is
    // exactly what a long loop is.
    if (this._loopFiles.has(name)) {
      this._setFileLoop(name, volume);
      return;
    }
    const target = clamp(volume, 0, 1);
    const existing = this._loops.get(name);

    if (target <= 0.001) {
      if (existing) this._stopLoop(name);
      return;
    }

    if (existing) {
      existing.gain.gain.cancelScheduledValues(this._context.currentTime);
      existing.gain.gain.setTargetAtTime(target, this._context.currentTime, 0.25);
      return;
    }

    const definition = this._catalogue[name];
    const buffer = this._buffers[name];
    if (!definition || !buffer) return;

    try {
      const source = this._context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = this._context.createGain();
      // Fade in: a loop starting at full volume is jarring.
      gain.gain.value = 0.0001;
      gain.gain.setTargetAtTime(target, this._context.currentTime, 0.4);
      source.connect(gain);
      gain.connect(this._categoryGains[definition.category] || this._masterGain);
      source.start();
      this._loops.set(name, { source, gain });
    } catch (error) {
      console.warn(`[Audio] could not start loop "${name}":`, error);
    }
  }

  _stopLoop(name) {
    const loop = this._loops.get(name);
    if (!loop) return;
    this._loops.delete(name);
    const context = this._context;
    try {
      loop.gain.gain.cancelScheduledValues(context.currentTime);
      loop.gain.gain.setTargetAtTime(0.0001, context.currentTime, 0.2);
      // Stop after the fade so there is no click.
      loop.source.stop(context.currentTime + 0.8);
      loop.source.onended = () => {
        try {
          loop.source.disconnect();
          loop.gain.disconnect();
        } catch {
          /* already gone */
        }
      };
    } catch {
      /* the source may already have stopped */
    }
  }

  /**
   * Starts or updates a streamed file loop.
   *
   * The media element is connected through `MediaElementAudioSourceNode`, so the
   * category and master gains still apply and a settings change moves this loop
   * exactly like a synthesized one.
   */
  _setFileLoop(name, volume) {
    const target = clamp(volume, 0, 1);
    const existing = this._fileLoops.get(name);

    if (target <= 0.001) {
      if (existing) this._stopFileLoop(name);
      return;
    }
    if (existing) {
      const fileGain = this._fileGains.get(this._loopFiles.get(name)) ?? 1;
      existing.gain.gain.cancelScheduledValues(this._context.currentTime);
      existing.gain.gain.setTargetAtTime(target * fileGain, this._context.currentTime, 0.35);
      return;
    }

    const id = this._loopFiles.get(name);
    const entry = this._library?.entries[id];
    if (!entry) return;

    try {
      const audio = new Audio();
      audio.src = new URL(soundFileUrl(entry, this._assetBaseUrl), document.baseURI).href;
      audio.loop = true;
      audio.preload = 'auto';
      audio.crossOrigin = 'anonymous';

      const source = this._context.createMediaElementSource(audio);
      const gain = this._context.createGain();
      gain.gain.value = 0.0001;
      const fileGain = entry.gain ?? 1;
      gain.gain.setTargetAtTime(target * fileGain, this._context.currentTime, 0.6);
      source.connect(gain);
      gain.connect(this._categoryGains[entry.mixerCategory] || this._masterGain);

      this._fileLoops.set(name, { audio, source, gain, id });
      audio.play().catch(() => {
        // A rejected play (no gesture yet, or a decode problem) must not leave a
        // silent entry behind: dropping it lets the next setLoop retry.
        this._fileLoops.delete(name);
      });
    } catch (error) {
      console.warn(`[Audio] could not start file loop "${name}":`, error.message);
    }
  }

  _stopFileLoop(name) {
    const loop = this._fileLoops.get(name);
    if (!loop) return;
    this._fileLoops.delete(name);
    const context = this._context;
    try {
      loop.gain.gain.cancelScheduledValues(context.currentTime);
      loop.gain.gain.setTargetAtTime(0.0001, context.currentTime, 0.2);
      setTimeout(() => {
        try {
          loop.audio.pause();
          loop.source.disconnect();
          loop.gain.disconnect();
        } catch {
          /* already torn down */
        }
      }, 700);
    } catch {
      /* the element may already have stopped */
    }
  }

  /** Stops every looping sound. */
  stopAllLoops() {
    for (const name of Array.from(this._loops.keys())) this._stopLoop(name);
    for (const name of Array.from(this._fileLoops.keys())) this._stopFileLoop(name);
  }

  // ------------------------------------------------------------------ mixing

  /**
   * Applies the audio settings group.
   * @param {Object} audio
   */
  applySettings(audio) {
    if (!this._context || !this._masterGain) return;
    const now = this._context.currentTime;

    const master = this.ducked ? 0.0001 : Math.max(0.0001, clamp(audio.master, 0, 1));
    this._masterGain.gain.setTargetAtTime(master, now, RAMP_TIME);

    for (const category of Object.values(SoundCategory)) {
      const gain = this._categoryGains[category];
      if (!gain) continue;
      const value = Math.max(0.0001, clamp(audio[category] ?? 1, 0, 1));
      gain.gain.setTargetAtTime(value, now, RAMP_TIME);
    }
  }

  /**
   * Silences or restores audio, used when the tab is hidden or unfocused.
   * @param {boolean} ducked
   */
  setDucked(ducked) {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    if (this._context && this._masterGain) {
      const audio = this._settings.values.audio;
      const target = ducked ? 0.0001 : Math.max(0.0001, clamp(audio.master, 0, 1));
      this._masterGain.gain.setTargetAtTime(target, this._context.currentTime, 0.12);
    }
  }

  /**
   * Suspends the context entirely, freeing the audio thread while hidden.
   * @param {boolean} suspended
   */
  async setSuspended(suspended) {
    if (!this._context) return;
    try {
      if (suspended && this._context.state === 'running') await this._context.suspend();
      else if (!suspended && (this._context.state === 'suspended' || this._context.state === 'interrupted') && this.unlocked) {
        await this._context.resume();
      }
    } catch {
      // Suspension is an optimisation; failing to do it is not an error.
    }
  }

  /**
   * Drives the ambience loops from world state.
   *
   * Called once per frame. Wind fades with altitude and daylight; the underwater
   * loop replaces it entirely when submerged, because hearing wind while under a
   * lake is the kind of detail that quietly breaks immersion.
   *
   * @param {Object} state
   * @param {boolean} state.underwater
   * @param {number} state.altitude Player Y.
   * @param {number} state.daylight 0..1
   * @param {number} state.rainIntensity 0..1
   * @param {boolean} state.paused
   * @param {string} [state.dimension] Dimension id; 'nether' swaps the soundscape.
   */
  updateAmbience(state) {
    if (!this.isActive) return;

    // With a generated library the ambience is driven by biome and depth; without
    // one the synthesized wind/rain path below still works.
    if (this._library && this._updateLibraryAmbience(state)) return;

    if (state.paused) {
      // Keep loops alive but quiet, so resuming does not restart them.
      this.setLoop('ambient.wind', 0.02);
      this.setLoop('weather.rain', 0);
      this.setLoop('ambient.underwater', 0);
      this.setLoop('ambient.nether', 0);
      this.setLoop('ambient.end', 0);
      return;
    }

    // The Nether has no sky, so wind and rain are silenced outright and the
    // rumble takes over. Checked before water because there is none down there.
    if (state.dimension === 'nether') {
      this.setLoop('ambient.nether', 0.6);
      this.setLoop('ambient.end', 0);
      this.setLoop('ambient.wind', 0);
      this.setLoop('weather.rain', 0);
      this.setLoop('ambient.underwater', 0);
      return;
    }

    if (state.dimension === 'end') {
      this.setLoop('ambient.end', 0.62);
      this.setLoop('ambient.nether', 0);
      this.setLoop('ambient.wind', 0);
      this.setLoop('weather.rain', 0);
      this.setLoop('ambient.underwater', 0);
      return;
    }

    if (state.underwater) {
      this.setLoop('ambient.underwater', 0.75);
      this.setLoop('ambient.wind', 0);
      // Rain is heavily muffled from below the surface.
      this.setLoop('weather.rain', state.rainIntensity * 0.18);
      return;
    }

    this.setLoop('ambient.underwater', 0);
    this.setLoop('ambient.nether', 0);
    this.setLoop('ambient.end', 0);
    // Wind is stronger high up and at night.
    const altitudeFactor = clamp((state.altitude - 50) / 60, 0, 1);
    const windTarget = 0.16 + altitudeFactor * 0.5 + (1 - state.daylight) * 0.12;
    this.setLoop('ambient.wind', clamp(windTarget, 0, 0.85));
    this.setLoop('weather.rain', state.rainIntensity);
  }

  /** Diagnostics for the debug overlay. */
  getStats() {
    let voices = 0;
    for (const category of Object.values(SoundCategory)) voices += this._voiceCounts[category] || 0;
    return {
      available: this.available,
      unlocked: this.unlocked,
      state: this._context?.state ?? 'none',
      sampleRate: this._context?.sampleRate ?? 0,
      voices,
      loops: this._loops.size + this._fileLoops.size,
      buffers: Object.keys(this._buffers).length,
      library: this._library ? Object.keys(this._library.entries).length : 0,
      libraryLoops: this._fileLoops.size,
      music: this._musicKey,
      decoded: this._decodedCount,
      variants: this._variants.size,
      spatialVoices: this._spatialVoices,
    };
  }

  /** Loop keys the ambience mixer owns; music and heartbeat are driven elsewhere. */
  static AMBIENCE_PREFIXES = ['ambient.', 'weather.', 'world.fire'];

  /** True when the ambience mixer is allowed to set this loop's volume. */
  _isAmbienceKey(key) {
    return AudioManager.AMBIENCE_PREFIXES.some((prefix) => key.startsWith(prefix));
  }

  /**
   * Chooses the generated ambience layers for the current place and time.
   *
   * Decisions are throttled: the biome lookup behind `state.biome` samples noise
   * when the chunk is not resident, and this runs every frame. Volumes are eased by
   * `setLoop`, so a 0.4 s decision interval is inaudible.
   *
   * @param {Object} state
   * @returns {boolean} True when the file library handled the ambience.
   */
  _updateLibraryAmbience(state) {
    if (!this.isActive) return false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this._lastAmbienceAt < 400) return true;
    this._lastAmbienceAt = now;

    const targets = new Map();
    for (const key of this._loopFiles.keys()) {
      if (this._isAmbienceKey(key)) targets.set(key, 0);
    }

    const dimension = state.dimension ?? 'overworld';
    // The Nether and the End keep their synthesized soundscapes; the overworld
    // library is what these files describe.
    if (state.paused) {
      this._applyLoopTargets(targets, true);
      // Also quiet any synthesized layer that was started before the library
      // loaded: both paths share the mixer and one is not aware of the other.
      this.setLoop('ambient.wind', 0.02);
      this.setLoop('weather.rain', 0);
      this.setLoop('ambient.underwater', 0);
      return true;
    }
    if (dimension !== 'overworld' || state.underwater) {
      this._applyLoopTargets(targets, true);
      return false;
    }

    const daylight = clamp(state.daylight ?? 1, 0, 1);
    const night = daylight < 0.35;
    const biome = state.biome ?? 'Plains';
    const underground = state.underground === true;
    const rain = clamp(state.rainIntensity ?? 0, 0, 1);
    const forest = /Forest|Taiga|Jungle|Grove|Swamp|Mangrove/i.test(biome);
    const swamp = /Swamp|Mangrove|Marsh/i.test(biome);

    if (underground) {
      targets.set('ambient.cave.drone', 0.5);
      targets.set('ambient.cave.drips', 0.22);
      targets.set('ambient.cave.wind', 0.14);
    } else if (forest) {
      targets.set(night ? 'ambient.forest.night' : 'ambient.forest.day', night ? 0.55 : 0.4);
      targets.set(night ? 'ambient.wind.light' : 'ambient.wind.trees', night ? 0.12 : 0.16);
      if (night) targets.set('ambient.fog', swamp ? 0.26 : 0.14);
      if (swamp) targets.set('ambient.fog', night ? 0.3 : 0.22);
    } else {
      const high = clamp(((state.altitude ?? 64) - 80) / 70, 0, 1);
      const gust = clamp(high + (1 - daylight) * 0.18 + rain * 0.25, 0, 1);
      targets.set('ambient.wind.light', 0.24 * (1 - gust));
      targets.set('ambient.wind.strong', 0.3 * gust);
      if (night) targets.set('ambient.fog', 0.12);
    }

    // Rain is additive on top of whatever the biome plays: light rain crossfades
    // into heavy as the intensity passes the middle of its range.
    if (!underground) {
      targets.set('weather.rain.light', rain * (1 - rain * 0.45));
      targets.set('weather.rain.heavy', Math.max(0, rain - 0.45) * 1.6);
    }

    // A permanent low drone under everything. It is barely identifiable as a sound,
    // which is the point: the world always sounds like it is holding its breath.
    if (!underground) {
      const phase = phaseAt(state.timeOfDay ?? 0);
      const drone = phase === 'night' ? 0.18 : phase === 'dusk' ? 0.13 : 0.07;
      targets.set('ambient.fog', Math.max(targets.get('ambient.fog') ?? 0, drone));
    }

    this._applyLoopTargets(targets, false);
    return true;
  }

  /** Applies a full set of loop volumes, stopping every ambience key not in it. */
  _applyLoopTargets(targets, stopAll) {
    for (const key of this._loopFiles.keys()) {
      // Music and the heartbeat have their own directors; zeroing them here would
      // silence the soundtrack four times a second.
      if (!this._isAmbienceKey(key)) continue;
      const volume = stopAll ? 0 : (targets.get(key) ?? 0);
      this.setLoop(key, volume);
    }
  }

  /**
   * Crossfades the music bed to a phase.
   *
   * Only one phase is audible at a time; `setLoop` ramps over ~0.35 s, which is
   * short enough to follow a sunset and long enough not to click.
   *
   * @param {'menu'|'day'|'dusk'|'night'|'cave'} phase
   */
  setMusicPhase(phase) {
    if (!this.isActive) return;
    const target = `music.${phase}`;
    const keys = ['music.menu', 'music.day', 'music.dusk', 'music.night', 'music.cave'];
    const available = keys.some((key) => this._loopFiles.has(key));
    if (!available) return;
    this._musicKey = target;
    for (const key of keys) {
      this.setLoop(key, key === target ? 1 : 0);
    }
  }

  /** Stops the music bed entirely, used on death and on leaving the world. */
  stopMusic() {
    this._musicKey = null;
    for (const key of ['music.menu', 'music.day', 'music.dusk', 'music.night', 'music.cave']) {
      this.setLoop(key, 0);
    }
  }

  /**
   * Wires the manager to the event bus so gameplay does not have to call it
   * directly for common sounds.
   * @param {import('../core/EventBus.js').SubscriptionGroup} subscriptions
   */
  attachEvents(subscriptions) {
    subscriptions.on(this._bus, Events.BLOCK_BROKEN, (event) => {
      this.playMaterial('break', event.soundGroup);
    });
    subscriptions.on(this._bus, Events.BLOCK_PLACED, (event) => {
      this.playMaterial('place', event.soundGroup);
    });
    // Only audible damage gets a sound: starvation ticks every four seconds and
    // would otherwise turn into a metronome.
    subscriptions.on(this._bus, Events.PLAYER_DAMAGED, (event) => {
      if (event.cause === 'starvation') return;
      this.play('player.hurt', { volume: 0.9 });
    });
    subscriptions.on(this._bus, Events.PLAYER_STEP, (event) => {
      // Footsteps are the most-heard sound in the game, so they get the most
      // attention: water gets a stroke, ground gets a material take, and a sprint
      // is louder and slightly brighter than a walk.
      if (event.inWater) {
        this.play('player.swim', { volume: 0.38 });
        return;
      }
      const sprint = event.sprint === true;
      this.play(soundKeyFor('step', groupForBlock(event.blockId)), {
        volume: sprint ? 0.56 : 0.36,
        pitch: sprint ? 1.05 : 1,
      });
    });
    subscriptions.on(this._bus, Events.PLAYER_WATER_STATE, (event) => {
      if (event.underwater) this.play('player.splash');
    });
    // Interface screens: opening a bag and closing it should not sound like the
    // same click as selecting an item.
    subscriptions.on(this._bus, Events.UI_SCREEN_CHANGED, (screen, previous) => {
      if (screen === 'inventory' && previous !== 'inventory') {
        this.play('ui.inventory.open', { volume: 0.55 });
      } else if (previous === 'inventory') {
        this.play('ui.inventory.close', { volume: 0.5 });
      }
    });
    subscriptions.on(this._bus, Events.PLAY_SOUND, (event) => {
      if (event?.name) this.play(event.name, event);
    });
  }

  /** Closes the context and releases every buffer. */
  async destroy() {
    this.stopAllLoops();
    this._buffers = Object.create(null);
    this._variants.clear();
    this._loopFiles.clear();
    this._fileGains.clear();
    this._library = null;
    this._libraryLoading = null;
    if (this._context) {
      try {
        await this._context.close();
      } catch {
        /* already closed */
      }
    }
    this._context = null;
    this._masterGain = null;
    this._categoryGains = Object.create(null);
    this.unlocked = false;
  }
}

/**
 * Resolves a block id to its sound group without importing the whole registry
 * into the audio layer's hot path.
 */
function groupForBlock(blockId) {
  // Imported lazily through the registry module, which is already loaded.
  return blockSoundGroup(blockId);
}

/** @type {(blockId: number) => string} */
let blockSoundGroup = () => 'stone';

/**
 * Injects the block-id-to-sound-group lookup.
 *
 * Done as an injection rather than a direct import so `audio/` has no dependency
 * on `world/`, which keeps the audio layer usable in isolation (and testable
 * without the block registry).
 *
 * @param {(blockId: number) => string} resolver
 */
export function setBlockSoundGroupResolver(resolver) {
  if (typeof resolver === 'function') blockSoundGroup = resolver;
}

export default AudioManager;
