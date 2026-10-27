/**
 * Declarative settings model.
 *
 * `DEFAULT_SETTINGS` is the single source of truth for what a setting is called
 * and what type it holds; `SETTINGS_SCHEMA` describes how to present it. The
 * settings menu is generated from the schema, so adding an option is a one-line
 * change here plus the code that reads it — there is no hand-written form
 * markup to keep in sync.
 */

import { PRESET_ORDER, PRESET_LABELS } from './GraphicsPresets.js';
import { SAVE } from './GameConfig.js';

/**
 * Complete default settings tree. Presets overwrite a subset of `graphics` and
 * `display`; everything else is only ever changed by the player.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  display: {
    fov: 75,
    uiScale: 1,
    resolutionScale: 1,
    maxPixelRatio: 1.5,
    maxFps: 0, // 0 = uncapped (follow the display's refresh rate)
    dynamicResolution: true,
    showFps: false,
    showStats: false,
  },
  graphics: {
    preset: 'medium',
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
    fogDensity: 1,
    particles: 'medium',
    weatherQuality: 'low',
    textureFiltering: 'nearest',
    anisotropy: 2,
    mipmaps: true,
    antialias: false,
    fxaa: true,
    bloom: false,
    vignette: true,
    tonemapping: 'aces',
    colorGrading: 1,
    brightness: 1,
    starQuality: 'medium',
  },
  controls: {
    mouseSensitivity: 1,
    touchSensitivity: 1,
    gamepadSensitivity: 1,
    invertMouseY: false,
    invertGamepadY: false,
    joystickSize: 1,
    joystickOpacity: 0.5,
    joystickMode: 'fixed',
    buttonScale: 1,
    leftHanded: false,
    cameraBob: true,
    sprintFov: true,
    vibration: true,
    autoJump: false,
    sprintToggle: false,
    crouchToggle: false,
  },
  audio: {
    master: 0.8,
    music: 0.35,
    ambient: 0.6,
    blocks: 0.9,
    weather: 0.7,
    player: 0.8,
    creatures: 0.85,
    horror: 0.7,
    ui: 0.6,
    muteWhenUnfocused: true,
  },
  gameplay: {
    // Survival by default: this is a survival horror game, not a building toy.
    mode: 'survival',
    reach: 5,
    dayCycleSpeed: 1,
    pauseDayCycle: false,
    /**
     * Open every world in late afternoon instead of midday. On by default: the
     * horror pacing needs dusk as the first thing the player sees, and a bright
     * noon is the fastest way to make the game feel like a sandbox again.
     */
    startAtDusk: true,
    allowFly: true,
    showCoordinates: true,
    autosaveInterval: SAVE.defaultAutosaveSeconds,
    fallingBlocks: true,
    dropItems: true,
    // Off by default so a survival death has real weight; on, dying costs only
    // the walk back.
    keepInventory: false,
  },
});

const QUALITY_OFF_TO_HIGH = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const QUALITY_LOW_TO_HIGH = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const percent = (v) => `${Math.round(v * 100)}%`;
const multiplier = (v) => `${v.toFixed(2)}×`;
const chunks = (v) => `${v} chunk${v === 1 ? '' : 's'}`;
const blocks = (v) => `${v} blocks`;

/**
 * @typedef {Object} SettingItem
 * @property {string} key Dotted path into the settings tree.
 * @property {'toggle'|'range'|'select'} type
 * @property {string} label
 * @property {string} [hint]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {Array<{value: string|number, label: string}>} [options]
 * @property {(value: any) => string} [format]
 * @property {boolean} [reloadRequired] Marks options that only take effect on
 *   the next world load (the menu shows a badge).
 * @property {(caps: import('../utils/DeviceDetector.js').DeviceCapabilities) => boolean} [available]
 * @property {boolean} [presetControlled] Editing it switches the preset to Custom.
 */

/**
 * @typedef {Object} SettingsSection
 * @property {string} id
 * @property {string} label
 * @property {SettingItem[]} items
 */

/** @type {ReadonlyArray<SettingsSection>} */
export const SETTINGS_SCHEMA = Object.freeze([
  {
    id: 'display',
    label: 'Display',
    items: [
      {
        key: 'display.fov',
        type: 'range',
        label: 'Field of view',
        min: 60,
        max: 110,
        step: 1,
        format: (v) => `${v}°`,
      },
      {
        key: 'display.uiScale',
        type: 'range',
        label: 'UI scale',
        min: 0.7,
        max: 1.8,
        step: 0.05,
        format: multiplier,
      },
      {
        key: 'display.resolutionScale',
        type: 'range',
        label: 'Resolution scale',
        hint: 'Renders the 3D view at a fraction of the window size. The UI stays sharp.',
        min: 0.4,
        max: 1.4,
        step: 0.05,
        format: percent,
        presetControlled: true,
      },
      {
        key: 'display.maxPixelRatio',
        type: 'range',
        label: 'Max pixel ratio',
        hint: 'Caps the device pixel ratio. The most effective setting on high-DPI phones.',
        min: 1,
        max: 3,
        step: 0.25,
        format: multiplier,
        presetControlled: true,
      },
      {
        key: 'display.dynamicResolution',
        type: 'toggle',
        label: 'Dynamic resolution',
        hint: 'Slowly trades pixels for frame rate when the GPU falls behind.',
        presetControlled: true,
      },
      {
        key: 'display.maxFps',
        type: 'select',
        label: 'Frame rate limit',
        options: [
          { value: 0, label: 'Unlimited' },
          { value: 30, label: '30 FPS' },
          { value: 45, label: '45 FPS' },
          { value: 60, label: '60 FPS' },
          { value: 90, label: '90 FPS' },
          { value: 120, label: '120 FPS' },
        ],
      },
      { key: 'display.showFps', type: 'toggle', label: 'Show FPS' },
      {
        key: 'display.showStats',
        type: 'toggle',
        label: 'Show performance stats',
        hint: 'Adds frame time, draw calls and chunk queue depth next to the FPS counter.',
      },
    ],
  },
  {
    id: 'graphics',
    label: 'Graphics',
    items: [
      {
        key: 'graphics.preset',
        type: 'select',
        label: 'Preset',
        options: [
          ...PRESET_ORDER.map((id) => ({ value: id, label: PRESET_LABELS[id] })),
          { value: 'custom', label: PRESET_LABELS.custom },
        ],
      },
      {
        key: 'graphics.renderDistance',
        type: 'range',
        label: 'Render distance',
        min: 2,
        max: 20,
        step: 1,
        format: chunks,
        presetControlled: true,
      },
      {
        key: 'graphics.verticalDistance',
        type: 'range',
        label: 'Vertical distance',
        hint: 'How far above and below the player chunk meshes stay visible.',
        min: 1,
        max: 8,
        step: 1,
        format: chunks,
        presetControlled: true,
      },
      {
        key: 'graphics.uploadBudget',
        type: 'range',
        label: 'Chunk upload budget',
        hint: 'Chunk meshes handed to the GPU per frame. Lower is smoother but loads slower.',
        min: 1,
        max: 8,
        step: 1,
        format: (v) => `${v}/frame`,
        presetControlled: true,
      },
      {
        key: 'graphics.workerCount',
        type: 'range',
        label: 'Generation workers',
        min: 1,
        max: 8,
        step: 1,
        reloadRequired: true,
        presetControlled: true,
        available: (caps) => caps.workersSupported,
      },
      {
        key: 'graphics.smoothLighting',
        type: 'toggle',
        label: 'Smooth lighting',
        presetControlled: true,
      },
      {
        key: 'graphics.ambientOcclusion',
        type: 'toggle',
        label: 'Ambient occlusion',
        hint: 'Bakes corner shading into the chunk mesh. Requires a chunk rebuild.',
        presetControlled: true,
      },
      {
        key: 'graphics.screenSpaceAmbientOcclusion',
        type: 'toggle',
        label: 'Screen-space ambient occlusion',
        hint: 'Adds contact shadows around entities, structures and nearby terrain.',
        presetControlled: true,
        available: (caps) => caps.webglVersion === 2,
      },
      {
        key: 'graphics.shadows',
        type: 'toggle',
        label: 'Sun shadows',
        presetControlled: true,
      },
      {
        key: 'graphics.shadowQuality',
        type: 'select',
        label: 'Shadow quality',
        options: QUALITY_LOW_TO_HIGH,
        presetControlled: true,
      },
      {
        key: 'graphics.shadowDistance',
        type: 'range',
        label: 'Shadow distance',
        min: 16,
        max: 128,
        step: 8,
        format: blocks,
        presetControlled: true,
      },
      {
        key: 'graphics.waterQuality',
        type: 'select',
        label: 'Water quality',
        options: [
          { value: 'simple', label: 'Simple' },
          { value: 'animated', label: 'Animated' },
          { value: 'reflective', label: 'Reflective' },
        ],
        presetControlled: true,
      },
      {
        key: 'graphics.waterAnimation',
        type: 'toggle',
        label: 'Animate water',
        presetControlled: true,
      },
      {
        key: 'graphics.leavesAnimation',
        type: 'toggle',
        label: 'Waving leaves',
        presetControlled: true,
      },
      {
        key: 'graphics.grassAnimation',
        type: 'toggle',
        label: 'Waving grass',
        presetControlled: true,
      },
      { key: 'graphics.clouds', type: 'toggle', label: 'Clouds', presetControlled: true },
      {
        key: 'graphics.cloudQuality',
        type: 'select',
        label: 'Cloud quality',
        options: QUALITY_LOW_TO_HIGH,
        presetControlled: true,
      },
      {
        key: 'graphics.starQuality',
        type: 'select',
        label: 'Stars',
        options: QUALITY_OFF_TO_HIGH,
        presetControlled: true,
      },
      { key: 'graphics.fog', type: 'toggle', label: 'Distance fog', presetControlled: true },
      {
        key: 'graphics.fogDensity',
        type: 'range',
        label: 'Fog density',
        min: 0.3,
        max: 2,
        step: 0.05,
        format: multiplier,
      },
      {
        key: 'graphics.particles',
        type: 'select',
        label: 'Particles',
        options: QUALITY_OFF_TO_HIGH,
        presetControlled: true,
      },
      {
        key: 'graphics.weatherQuality',
        type: 'select',
        label: 'Weather quality',
        options: QUALITY_OFF_TO_HIGH,
        presetControlled: true,
      },
      {
        key: 'graphics.textureFiltering',
        type: 'select',
        label: 'Texture filtering',
        hint: 'Nearest keeps the pixel-art look. Linear blurs it.',
        options: [
          { value: 'nearest', label: 'Nearest (crisp)' },
          { value: 'linear', label: 'Linear (soft)' },
        ],
        presetControlled: true,
      },
      {
        key: 'graphics.mipmaps',
        type: 'toggle',
        label: 'Mipmaps',
        hint: 'Reduces shimmer on distant blocks.',
        presetControlled: true,
      },
      {
        key: 'graphics.anisotropy',
        type: 'select',
        label: 'Anisotropic filtering',
        options: [
          { value: 1, label: 'Off' },
          { value: 2, label: '2×' },
          { value: 4, label: '4×' },
          { value: 8, label: '8×' },
          { value: 16, label: '16×' },
        ],
        presetControlled: true,
      },
      {
        key: 'graphics.antialias',
        type: 'toggle',
        label: 'MSAA',
        hint: 'Hardware anti-aliasing. Takes effect after a reload.',
        reloadRequired: true,
        presetControlled: true,
      },
      { key: 'graphics.fxaa', type: 'toggle', label: 'FXAA', presetControlled: true },
      { key: 'graphics.bloom', type: 'toggle', label: 'Bloom', presetControlled: true },
      { key: 'graphics.vignette', type: 'toggle', label: 'Vignette', presetControlled: true },
      {
        key: 'graphics.tonemapping',
        type: 'select',
        label: 'Tone mapping',
        options: [
          { value: 'none', label: 'None' },
          { value: 'reinhard', label: 'Reinhard' },
          { value: 'cineon', label: 'Cineon' },
          { value: 'aces', label: 'ACES Filmic' },
          { value: 'agx', label: 'AgX' },
          { value: 'neutral', label: 'Khronos Neutral' },
        ],
      },
      {
        key: 'graphics.colorGrading',
        type: 'range',
        label: 'Colour saturation',
        min: 0,
        max: 1.6,
        step: 0.05,
        format: multiplier,
      },
      {
        key: 'graphics.brightness',
        type: 'range',
        label: 'Brightness',
        min: 0.6,
        max: 1.6,
        step: 0.02,
        format: multiplier,
      },
    ],
  },
  {
    id: 'controls',
    label: 'Controls',
    items: [
      {
        key: 'controls.mouseSensitivity',
        type: 'range',
        label: 'Mouse sensitivity',
        min: 0.2,
        max: 3,
        step: 0.05,
        format: multiplier,
      },
      {
        key: 'controls.touchSensitivity',
        type: 'range',
        label: 'Touch sensitivity',
        min: 0.2,
        max: 3,
        step: 0.05,
        format: multiplier,
      },
      {
        key: 'controls.gamepadSensitivity',
        type: 'range',
        label: 'Gamepad sensitivity',
        min: 0.2,
        max: 3,
        step: 0.05,
        format: multiplier,
      },
      { key: 'controls.invertMouseY', type: 'toggle', label: 'Invert mouse Y' },
      { key: 'controls.invertGamepadY', type: 'toggle', label: 'Invert gamepad Y' },
      {
        key: 'controls.joystickSize',
        type: 'range',
        label: 'Joystick size',
        min: 0.7,
        max: 1.6,
        step: 0.05,
        format: multiplier,
      },
      {
        key: 'controls.joystickOpacity',
        type: 'range',
        label: 'Touch control opacity',
        min: 0.15,
        max: 1,
        step: 0.05,
        format: percent,
      },
      {
        key: 'controls.joystickMode',
        type: 'select',
        label: 'Joystick mode',
        hint: 'Floating re-centres the stick wherever your thumb lands.',
        options: [
          { value: 'fixed', label: 'Fixed' },
          { value: 'floating', label: 'Floating' },
        ],
      },
      {
        key: 'controls.buttonScale',
        type: 'range',
        label: 'Button scale',
        min: 0.7,
        max: 1.6,
        step: 0.05,
        format: multiplier,
      },
      { key: 'controls.leftHanded', type: 'toggle', label: 'Left-handed layout' },
      { key: 'controls.cameraBob', type: 'toggle', label: 'Camera bob' },
      { key: 'controls.sprintFov', type: 'toggle', label: 'Sprint FOV shift' },
      {
        key: 'controls.vibration',
        type: 'toggle',
        label: 'Vibration',
        available: (caps) => caps.vibrationSupported,
      },
      {
        key: 'controls.autoJump',
        type: 'toggle',
        label: 'Auto jump',
        hint: 'Steps up single-block ledges without pressing jump.',
      },
      { key: 'controls.sprintToggle', type: 'toggle', label: 'Toggle sprint' },
      { key: 'controls.crouchToggle', type: 'toggle', label: 'Toggle crouch' },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    items: [
      { key: 'audio.master', type: 'range', label: 'Master', min: 0, max: 1, step: 0.05, format: percent },
      { key: 'audio.music', type: 'range', label: 'Music', min: 0, max: 1, step: 0.05, format: percent },
      { key: 'audio.ambient', type: 'range', label: 'Ambient', min: 0, max: 1, step: 0.05, format: percent },
      { key: 'audio.blocks', type: 'range', label: 'Blocks', min: 0, max: 1, step: 0.05, format: percent },
      { key: 'audio.weather', type: 'range', label: 'Weather', min: 0, max: 1, step: 0.05, format: percent },
      // Separate sliders are the point of the horror mix: a player who wants to
      // hear a creature breathing behind them can turn the creatures up without
      // raising the whole world.
      { key: 'audio.player', type: 'range', label: 'Player', min: 0, max: 1, step: 0.05, format: percent },
      { key: 'audio.creatures', type: 'range', label: 'Creatures', min: 0, max: 1, step: 0.05, format: percent },
      { key: 'audio.horror', type: 'range', label: 'Horror events', min: 0, max: 1, step: 0.05, format: percent },
      { key: 'audio.ui', type: 'range', label: 'Interface', min: 0, max: 1, step: 0.05, format: percent },
      { key: 'audio.muteWhenUnfocused', type: 'toggle', label: 'Mute when unfocused' },
    ],
  },
  {
    id: 'gameplay',
    label: 'Gameplay',
    items: [
      {
        key: 'gameplay.mode',
        type: 'select',
        label: 'Mode',
        hint: 'Creative breaks blocks instantly and gives unlimited blocks. Survival-like adds break times and dropped items.',
        options: [
          { value: 'creative', label: 'Creative' },
          { value: 'survival', label: 'Survival-like' },
        ],
      },
      {
        key: 'gameplay.reach',
        type: 'range',
        label: 'Reach',
        min: 2,
        max: 12,
        step: 0.5,
        format: blocks,
      },
      {
        key: 'gameplay.dayCycleSpeed',
        type: 'range',
        label: 'Day cycle speed',
        min: 0,
        max: 6,
        step: 0.1,
        format: multiplier,
      },
      { key: 'gameplay.pauseDayCycle', type: 'toggle', label: 'Freeze time of day' },
      { key: 'gameplay.startAtDusk', type: 'toggle', label: 'Open worlds at dusk' },
      { key: 'gameplay.allowFly', type: 'toggle', label: 'Allow flying' },
      { key: 'gameplay.showCoordinates', type: 'toggle', label: 'Show coordinates' },
      {
        key: 'gameplay.fallingBlocks',
        type: 'toggle',
        label: 'Falling sand and gravel',
      },
      {
        key: 'gameplay.keepInventory',
        type: 'toggle',
        label: 'Keep inventory on death',
        hint: 'When off, your items scatter where you died.',
      },
      {
        key: 'gameplay.dropItems',
        type: 'toggle',
        label: 'Drop items when breaking',
        hint: 'Survival-like mode only.',
      },
      {
        key: 'gameplay.autosaveInterval',
        type: 'select',
        label: 'Autosave interval',
        options: [
          { value: 0, label: 'Off' },
          { value: 20, label: '20 seconds' },
          { value: 45, label: '45 seconds' },
          { value: 120, label: '2 minutes' },
          { value: 300, label: '5 minutes' },
        ],
      },
    ],
  },
]);

/**
 * Settings that require chunk meshes to be rebuilt when they change, because
 * their result is baked into the geometry rather than evaluated per frame.
 */
export const REMESH_SETTINGS = Object.freeze(
  new Set(['graphics.ambientOcclusion', 'graphics.smoothLighting', 'graphics.waterQuality'])
);

/** Flat lookup of every schema item by key. */
export const SETTINGS_BY_KEY = Object.freeze(
  SETTINGS_SCHEMA.reduce((map, section) => {
    for (const item of section.items) map[item.key] = item;
    return map;
  }, /** @type {Record<string, SettingItem>} */ ({}))
);
