/**
 * Persistent, validated settings store.
 *
 * Design notes:
 *  - The tree shape always comes from `DEFAULT_SETTINGS`. Loading a stored blob
 *    never introduces unknown keys and never drops new ones, so upgrading the
 *    game cannot leave a user stuck with a half-populated settings object.
 *  - Every write is validated against `SETTINGS_SCHEMA` (range clamped, select
 *    values checked, booleans coerced). A corrupt or hand-edited localStorage
 *    entry degrades to defaults for the offending key only.
 *  - Changes are emitted as a batch with a set of changed keys, which lets the
 *    renderer decide once per batch whether it needs to resize a render target
 *    or rebuild chunk meshes instead of reacting to every slider tick.
 */

import { SETTINGS_STORAGE_KEY } from '../config/GameConfig.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_BY_KEY,
  SETTINGS_SCHEMA,
  REMESH_SETTINGS,
} from '../config/SettingsSchema.js';
import {
  GRAPHICS_PRESETS,
  PRESET_CONTROLLED_KEYS,
  constrainPresetToDevice,
  getPreset,
  matchPreset,
} from '../config/GraphicsPresets.js';
import { Events } from './EventBus.js';
import { clamp } from '../utils/MathUtils.js';

export class SettingsManager {
  /**
   * @param {import('./EventBus.js').EventBus} bus
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} capabilities
   */
  constructor(bus, capabilities) {
    this._bus = bus;
    this._caps = capabilities;
    /** @type {typeof DEFAULT_SETTINGS} */
    this._values = clone(DEFAULT_SETTINGS);
    /** Keys whose new value only takes effect after a reload. */
    this._pendingReload = new Set();
    /** True once a stored blob has been read (or the first-run default chosen). */
    this._loaded = false;
    this._saveTimer = 0;
    this._storageAvailable = probeStorage();
  }

  /** The live settings tree. Treat as read-only; use `set()` to change values. */
  get values() {
    return this._values;
  }

  /** True when a setting was changed that needs a reload to take effect. */
  get needsReload() {
    return this._pendingReload.size > 0;
  }

  /** Keys awaiting a reload. */
  get pendingReloadKeys() {
    return Array.from(this._pendingReload);
  }

  /** True when settings can be persisted (private-mode Safari disables it). */
  get canPersist() {
    return this._storageAvailable;
  }

  /** The preset the device probe recommends, for UI that needs a sane default. */
  get suggestedPreset() {
    return this._caps.suggestedPreset;
  }

  // ---------------------------------------------------------------- load/save

  /**
   * Reads stored settings, or picks device-appropriate defaults on first run.
   * @returns {{firstRun: boolean}}
   */
  load() {
    let stored = null;
    if (this._storageAvailable) {
      try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (raw) stored = JSON.parse(raw);
      } catch (error) {
        console.warn('[Settings] stored settings were unreadable, using defaults:', error);
        stored = null;
      }
    }

    const firstRun = !stored || typeof stored !== 'object';
    if (firstRun) {
      // The game's first impression is the survival-horror one, so the default is
      // the medium preset rather than the device probe's recommendation. The probe
      // still clamps the preset to what the hardware can actually do.
      this.applyPreset('medium', { silent: true, persist: false });
    } else {
      this._values = mergeIntoDefaults(stored);
      this._sanitiseAll();
    }

    this._loaded = true;
    if (firstRun) this.save();
    return { firstRun };
  }

  /** Writes the settings tree to localStorage immediately. */
  save() {
    if (!this._storageAvailable) return false;
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this._values));
      return true;
    } catch (error) {
      // Quota or private-mode failure: keep running with in-memory settings.
      console.warn('[Settings] could not persist settings:', error);
      this._storageAvailable = false;
      return false;
    }
  }

  /** Debounced save, used while a slider is being dragged. */
  saveSoon(delayMs = 400) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = 0;
      this.save();
    }, delayMs);
  }

  // ------------------------------------------------------------------ get/set

  /**
   * Reads a setting by dotted path.
   * @param {string} key e.g. `'graphics.renderDistance'`
   * @returns {any}
   */
  get(key) {
    const dot = key.indexOf('.');
    if (dot < 0) return this._values[key];
    const group = this._values[key.slice(0, dot)];
    return group ? group[key.slice(dot + 1)] : undefined;
  }

  /**
   * Writes one setting, validating it first.
   *
   * @param {string} key Dotted path.
   * @param {any} rawValue
   * @param {{silent?: boolean, persist?: boolean, fromPreset?: boolean}} [options]
   * @returns {boolean} True when the stored value actually changed.
   */
  set(key, rawValue, options = {}) {
    const { silent = false, persist = true, fromPreset = false } = options;
    const dot = key.indexOf('.');
    if (dot < 0) return false;
    const groupName = key.slice(0, dot);
    const leaf = key.slice(dot + 1);
    const group = this._values[groupName];
    if (!group || !(leaf in group)) {
      console.warn(`[Settings] unknown key "${key}"`);
      return false;
    }

    const value = this._sanitise(key, rawValue, group[leaf]);
    if (group[leaf] === value) return false;
    group[leaf] = value;

    // Editing an option a preset controls demotes the preset to "custom".
    if (!fromPreset && PRESET_CONTROLLED_KEYS.includes(key)) {
      const detected = matchPreset(this._values);
      if (this._values.graphics.preset !== detected) {
        this._values.graphics.preset = detected;
      }
    }

    const schema = SETTINGS_BY_KEY[key];
    if (schema?.reloadRequired) this._pendingReload.add(key);

    if (persist) this.saveSoon();
    if (!silent) this._emitChange(new Set([key]));
    return true;
  }

  /**
   * Applies several settings as one batch, emitting a single change event.
   * @param {Record<string, any>} entries Dotted key to value.
   * @param {{silent?: boolean, fromPreset?: boolean}} [options]
   * @returns {Set<string>} The keys that changed.
   */
  setMany(entries, options = {}) {
    const changed = new Set();
    for (const [key, value] of Object.entries(entries)) {
      if (this.set(key, value, { ...options, silent: true, persist: false })) changed.add(key);
    }
    if (changed.size > 0) {
      this.saveSoon();
      if (!options.silent) this._emitChange(changed);
    }
    return changed;
  }

  // ------------------------------------------------------------------ presets

  /**
   * Applies a graphics preset, clamped to what the hardware can actually do.
   * @param {string} presetId One of the ids in `GRAPHICS_PRESETS`.
   * @param {{silent?: boolean, persist?: boolean}} [options]
   * @returns {boolean} False when the id is unknown.
   */
  applyPreset(presetId, options = {}) {
    if (presetId === 'custom') {
      return this.set('graphics.preset', 'custom', options);
    }
    const preset = getPreset(presetId);
    if (!preset) {
      console.warn(`[Settings] unknown preset "${presetId}"`);
      return false;
    }
    constrainPresetToDevice(preset, this._caps);

    const entries = {};
    for (const [key, value] of Object.entries(preset.graphics)) entries[`graphics.${key}`] = value;
    for (const [key, value] of Object.entries(preset.display)) entries[`display.${key}`] = value;

    const changed = this.setMany(entries, { silent: true, fromPreset: true });
    this._values.graphics.preset = presetId;
    changed.add('graphics.preset');

    if (options.persist !== false) this.saveSoon();
    if (!options.silent) this._emitChange(changed);
    return true;
  }

  /** Restores every setting to its device-appropriate default. */
  reset() {
    this._values = clone(DEFAULT_SETTINGS);
    this._pendingReload.clear();
    this.applyPreset(this._caps.suggestedPreset, { silent: true, persist: false });
    this.save();
    const allKeys = new Set(Object.keys(SETTINGS_BY_KEY));
    this._bus.emit(Events.SETTINGS_RESET, this._values);
    this._emitChange(allKeys);
  }

  /** Clears the reload-required markers (call right after a reload). */
  clearPendingReload() {
    this._pendingReload.clear();
  }

  // ------------------------------------------------------------- derived views

  /**
   * True when any changed key in a batch requires chunk meshes to be rebuilt.
   * @param {Set<string>} changedKeys
   */
  static requiresRemesh(changedKeys) {
    for (const key of changedKeys) if (REMESH_SETTINGS.has(key)) return true;
    return false;
  }

  /**
   * Returns the schema, filtered to the options this device supports.
   * @returns {Array<{id: string, label: string, items: Array<Object>}>}
   */
  getVisibleSchema() {
    return SETTINGS_SCHEMA.map((section) => ({
      id: section.id,
      label: section.label,
      items: section.items.filter((item) => !item.available || item.available(this._caps)),
    })).filter((section) => section.items.length > 0);
  }

  /** Exports the settings tree as a plain object (for save export). */
  toJSON() {
    return clone(this._values);
  }

  /**
   * Imports a settings tree, validating every field.
   * @param {Object} data
   */
  fromJSON(data) {
    if (!data || typeof data !== 'object') return false;
    this._values = mergeIntoDefaults(data);
    this._sanitiseAll();
    this.save();
    this._emitChange(new Set(Object.keys(SETTINGS_BY_KEY)));
    return true;
  }

  /** Cancels the pending debounced save. */
  destroy() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = 0;
    }
  }

  // ----------------------------------------------------------------- internals

  _emitChange(changedKeys) {
    this._bus.emit(Events.SETTINGS_CHANGED, this._values, changedKeys);
  }

  /**
   * Coerces a value into the shape the schema declares.
   * Falls back to `fallback` when the input cannot be salvaged.
   */
  _sanitise(key, value, fallback) {
    const schema = SETTINGS_BY_KEY[key];
    if (!schema) {
      // Not user-facing (e.g. `graphics.preset` handled above). Accept as-is if
      // the primitive type matches the current value.
      return typeof value === typeof fallback ? value : fallback;
    }

    switch (schema.type) {
      case 'toggle':
        return Boolean(value);

      case 'range': {
        const numeric = typeof value === 'number' ? value : Number.parseFloat(value);
        if (!Number.isFinite(numeric)) return fallback;
        const min = schema.min ?? -Infinity;
        const max = schema.max ?? Infinity;
        let clamped = clamp(numeric, min, max);
        if (schema.step) {
          // Snap to the step grid to avoid 0.30000000000000004 in storage.
          const steps = Math.round((clamped - min) / schema.step);
          clamped = clamp(min + steps * schema.step, min, max);
          clamped = Math.round(clamped * 1e6) / 1e6;
        }
        return clamped;
      }

      case 'select': {
        const options = schema.options || [];
        // Numeric selects arrive from <select> elements as strings.
        const candidates = [value];
        const numeric = Number(value);
        if (Number.isFinite(numeric)) candidates.push(numeric);
        candidates.push(String(value));
        for (const candidate of candidates) {
          if (options.some((option) => option.value === candidate)) return candidate;
        }
        return fallback;
      }

      default:
        return value;
    }
  }

  /** Re-validates the whole tree, used after loading or importing. */
  _sanitiseAll() {
    for (const section of SETTINGS_SCHEMA) {
      for (const item of section.items) {
        const dot = item.key.indexOf('.');
        const groupName = item.key.slice(0, dot);
        const leaf = item.key.slice(dot + 1);
        const group = this._values[groupName];
        const defaultGroup = DEFAULT_SETTINGS[groupName];
        if (!group || !defaultGroup) continue;
        group[leaf] = this._sanitise(item.key, group[leaf], defaultGroup[leaf]);
      }
    }
    // `graphics.preset` is not a plain schema value: verify it names a real
    // preset or `custom`, then re-derive it from the actual values.
    const preset = this._values.graphics.preset;
    if (preset !== 'custom' && !GRAPHICS_PRESETS[preset]) {
      this._values.graphics.preset = 'custom';
    }
    const detected = matchPreset(this._values);
    if (detected !== 'custom') this._values.graphics.preset = detected;
    else if (GRAPHICS_PRESETS[this._values.graphics.preset]) {
      this._values.graphics.preset = 'custom';
    }
  }
}

/** Structured deep copy of plain JSON-ish data. */
function clone(value) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through to JSON */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Copies known leaves out of `stored` onto a fresh copy of the defaults.
 * Unknown keys in `stored` are ignored; missing keys keep their default.
 */
function mergeIntoDefaults(stored) {
  const result = clone(DEFAULT_SETTINGS);
  for (const groupName of Object.keys(result)) {
    const storedGroup = stored?.[groupName];
    if (!storedGroup || typeof storedGroup !== 'object') continue;
    for (const leaf of Object.keys(result[groupName])) {
      if (storedGroup[leaf] !== undefined) result[groupName][leaf] = storedGroup[leaf];
    }
  }
  return result;
}

/** True when `localStorage` is present and writable. */
function probeStorage() {
  try {
    if (typeof localStorage === 'undefined') return false;
    const probeKey = '__voxel_probe__';
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
    return true;
  } catch {
    return false;
  }
}

export default SettingsManager;
