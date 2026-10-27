/**
 * Graphics presets.
 *
 * A preset is a *recommendation*: it seeds a group of individual settings that
 * the player can then override, at which point the preset id becomes `custom`.
 * Presets never touch gameplay-affecting values — render distance changes what
 * you can see, never how physics behaves.
 */

/** Ordered from cheapest to most expensive; `custom` is not orderable. */
export const PRESET_ORDER = Object.freeze(['potato', 'low', 'medium', 'high', 'ultra']);

/** Human-readable preset labels. */
export const PRESET_LABELS = Object.freeze({
  potato: 'Potato',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
  custom: 'Custom',
});

/**
 * The set of setting keys (within the `graphics` group, plus a few display
 * keys) that a preset controls. Anything not listed here survives a preset
 * change untouched.
 */
export const PRESET_CONTROLLED_KEYS = Object.freeze([
  'graphics.renderDistance',
  'graphics.verticalDistance',
  'graphics.uploadBudget',
  'graphics.workerCount',
  'graphics.clouds',
  'graphics.cloudQuality',
  'graphics.smoothLighting',
  'graphics.ambientOcclusion',
  'graphics.screenSpaceAmbientOcclusion',
  'graphics.shadows',
  'graphics.shadowQuality',
  'graphics.shadowDistance',
  'graphics.waterQuality',
  'graphics.waterAnimation',
  'graphics.leavesAnimation',
  'graphics.grassAnimation',
  'graphics.fog',
  'graphics.particles',
  'graphics.weatherQuality',
  'graphics.textureFiltering',
  'graphics.anisotropy',
  'graphics.mipmaps',
  'graphics.antialias',
  'graphics.fxaa',
  'graphics.bloom',
  'graphics.vignette',
  'graphics.starQuality',
  'display.resolutionScale',
  'display.maxPixelRatio',
  'display.dynamicResolution',
]);

/**
 * @typedef {Object} PresetValues
 * @property {number} renderDistance Horizontal chunk radius.
 * @property {number} verticalDistance Vertical mesh visibility in chunks.
 * @property {number} uploadBudget Chunk meshes uploaded to the GPU per frame.
 * @property {number} workerCount Upper bound on generation workers.
 */

/**
 * Preset definitions. `resolutionScale` is a multiplier on the CSS size and
 * `maxPixelRatio` caps the device pixel ratio, which is the single most
 * effective knob on high-DPR phones.
 */
export const GRAPHICS_PRESETS = Object.freeze({
  potato: Object.freeze({
    graphics: {
      renderDistance: 3,
      verticalDistance: 2,
      uploadBudget: 1,
      workerCount: 1,
      clouds: false,
      cloudQuality: 'low',
      smoothLighting: false,
      ambientOcclusion: false,
      screenSpaceAmbientOcclusion: false,
      shadows: false,
      shadowQuality: 'low',
      shadowDistance: 24,
      waterQuality: 'simple',
      waterAnimation: false,
      leavesAnimation: false,
      grassAnimation: false,
      fog: true,
      particles: 'off',
      weatherQuality: 'off',
      textureFiltering: 'nearest',
      anisotropy: 1,
      mipmaps: false,
      antialias: false,
      fxaa: false,
      bloom: false,
      vignette: false,
      starQuality: 'off',
    },
    display: { resolutionScale: 0.7, maxPixelRatio: 1, dynamicResolution: true },
  }),

  low: Object.freeze({
    graphics: {
      renderDistance: 5,
      verticalDistance: 3,
      uploadBudget: 1,
      workerCount: 2,
      clouds: false,
      cloudQuality: 'low',
      smoothLighting: true,
      ambientOcclusion: false,
      screenSpaceAmbientOcclusion: false,
      shadows: false,
      shadowQuality: 'low',
      shadowDistance: 32,
      waterQuality: 'simple',
      waterAnimation: true,
      leavesAnimation: false,
      grassAnimation: false,
      fog: true,
      particles: 'low',
      weatherQuality: 'off',
      textureFiltering: 'nearest',
      anisotropy: 1,
      mipmaps: true,
      antialias: false,
      fxaa: false,
      bloom: false,
      vignette: false,
      starQuality: 'low',
    },
    display: { resolutionScale: 0.85, maxPixelRatio: 1.25, dynamicResolution: true },
  }),

  medium: Object.freeze({
    graphics: {
      renderDistance: 8,
      verticalDistance: 4,
      uploadBudget: 2,
      workerCount: 3,
      clouds: true,
      cloudQuality: 'low',
      smoothLighting: true,
      ambientOcclusion: true,
      screenSpaceAmbientOcclusion: false,
      shadows: false,
      shadowQuality: 'medium',
      shadowDistance: 48,
      waterQuality: 'animated',
      waterAnimation: true,
      leavesAnimation: true,
      grassAnimation: false,
      fog: true,
      particles: 'medium',
      weatherQuality: 'low',
      textureFiltering: 'nearest',
      anisotropy: 2,
      mipmaps: true,
      antialias: false,
      fxaa: true,
      bloom: false,
      vignette: true,
      starQuality: 'medium',
    },
    display: { resolutionScale: 1, maxPixelRatio: 1.5, dynamicResolution: true },
  }),

  high: Object.freeze({
    graphics: {
      renderDistance: 11,
      verticalDistance: 6,
      uploadBudget: 3,
      workerCount: 4,
      clouds: true,
      cloudQuality: 'medium',
      smoothLighting: true,
      ambientOcclusion: true,
      screenSpaceAmbientOcclusion: true,
      shadows: true,
      shadowQuality: 'medium',
      shadowDistance: 64,
      waterQuality: 'animated',
      waterAnimation: true,
      leavesAnimation: true,
      grassAnimation: true,
      fog: true,
      particles: 'high',
      weatherQuality: 'medium',
      textureFiltering: 'nearest',
      anisotropy: 4,
      mipmaps: true,
      antialias: false,
      fxaa: true,
      bloom: false,
      vignette: true,
      starQuality: 'high',
    },
    display: { resolutionScale: 1, maxPixelRatio: 2, dynamicResolution: false },
  }),

  ultra: Object.freeze({
    graphics: {
      renderDistance: 14,
      verticalDistance: 8,
      uploadBudget: 4,
      workerCount: 6,
      clouds: true,
      cloudQuality: 'high',
      smoothLighting: true,
      ambientOcclusion: true,
      screenSpaceAmbientOcclusion: true,
      shadows: true,
      shadowQuality: 'high',
      shadowDistance: 96,
      waterQuality: 'reflective',
      waterAnimation: true,
      leavesAnimation: true,
      grassAnimation: true,
      fog: true,
      particles: 'high',
      weatherQuality: 'high',
      textureFiltering: 'nearest',
      anisotropy: 8,
      mipmaps: true,
      antialias: false,
      fxaa: true,
      bloom: true,
      vignette: true,
      starQuality: 'high',
    },
    display: { resolutionScale: 1, maxPixelRatio: 2, dynamicResolution: false },
  }),
});

/** Shadow map resolution per quality level. */
export const SHADOW_MAP_SIZES = Object.freeze({ low: 512, medium: 1024, high: 2048 });

/** Particle budget per quality level. */
export const PARTICLE_BUDGETS = Object.freeze({ off: 0, low: 48, medium: 160, high: 420 });

/** Rain particle counts per weather quality level. */
export const WEATHER_BUDGETS = Object.freeze({ off: 0, low: 900, medium: 2600, high: 6000 });

/** Star counts per star quality level. */
export const STAR_COUNTS = Object.freeze({ off: 0, low: 320, medium: 900, high: 1800 });

/** Cloud plane resolution / layer count per cloud quality level. */
// Coverage is deliberately high: the horror pass wants an overcast sky in every
// preset, not a cheerful blue one. The differences between tiers are resolution and
// layer count, not how much of the sky is covered.
export const CLOUD_QUALITY = Object.freeze({
  low: { segments: 24, layers: 1, coverage: 0.66, speed: 0.006 },
  medium: { segments: 48, layers: 2, coverage: 0.63, speed: 0.008 },
  high: { segments: 80, layers: 2, coverage: 0.6, speed: 0.01 },
});

/**
 * Returns a deep-ish copy of the preset payload so callers can mutate it.
 * @param {string} presetId
 * @returns {{graphics: Object, display: Object}|null}
 */
export function getPreset(presetId) {
  const preset = GRAPHICS_PRESETS[presetId];
  if (!preset) return null;
  return {
    graphics: { ...preset.graphics },
    display: { ...preset.display },
  };
}

/**
 * Finds the preset whose values exactly match the provided settings, or
 * `'custom'` when none does. Used to re-label the preset dropdown after the
 * player edits individual options.
 *
 * @param {Object} settings The full settings object.
 * @returns {string} A preset id or `'custom'`.
 */
export function matchPreset(settings) {
  for (const id of PRESET_ORDER) {
    const preset = GRAPHICS_PRESETS[id];
    let matches = true;
    for (const group of ['graphics', 'display']) {
      for (const [key, value] of Object.entries(preset[group])) {
        if (settings[group]?.[key] !== value) {
          matches = false;
          break;
        }
      }
      if (!matches) break;
    }
    if (matches) return id;
  }
  return 'custom';
}

/**
 * Clamps preset values against hardware limits so a preset can never ask for
 * something the driver cannot do (e.g. 8x anisotropy on a device that caps at 2).
 *
 * @param {{graphics: Object, display: Object}} presetValues Mutated in place.
 * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} caps
 */
export function constrainPresetToDevice(presetValues, caps) {
  const g = presetValues.graphics;
  g.anisotropy = Math.min(g.anisotropy, Math.max(1, Math.floor(caps.maxAnisotropy)));
  g.workerCount = Math.min(g.workerCount, Math.max(1, caps.cores - 1));
  if (!caps.workersSupported) g.workerCount = 0;
  if (caps.maxTextureSize < 1024) g.mipmaps = false;
  if (!caps.highpFragment) {
    g.shadows = false;
    g.bloom = false;
  }
  presetValues.display.maxPixelRatio = Math.min(
    presetValues.display.maxPixelRatio,
    Math.max(1, caps.devicePixelRatio)
  );
  return presetValues;
}
