/**
 * Main menu: world list, world creation, and save management.
 *
 * The seed field accepts anything. A number is used directly, and any other text
 * is hashed to a 32-bit seed — so "my favourite world" is a perfectly valid seed
 * and always produces the same terrain. An empty field picks a random one, which
 * is then shown to the player so they can write it down.
 *
 * Import and export work on a single JSON file containing the world record and its
 * block diffs. Import always creates a *new* world rather than overwriting, so a
 * mis-click can never destroy an existing save.
 */

import { PRESET_LABELS, PRESET_ORDER } from '../config/GraphicsPresets.js';
import { DIFFICULTY_ORDER, getDifficulty } from '../gameplay/Difficulty.js';
import { parseSeed } from '../utils/MathUtils.js';
import { el, setVisible, button, clear } from './dom.js';

export class MainMenu {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.root
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {Object} options.handlers
   * @param {(options: {name: string, seed: number, preset: string, mode: string, difficulty: string}) => void} options.handlers.onCreateWorld
   * @param {(worldId: string) => void} options.handlers.onPlayWorld
   * @param {(worldId: string) => void} options.handlers.onDeleteWorld
   * @param {(worldId: string) => void} options.handlers.onExportWorld
   * @param {(file: File) => void} options.handlers.onImportWorld
   * @param {() => void} options.handlers.onSettings
   */
  constructor({ root, settings, handlers }) {
    this._settings = settings;
    this._handlers = handlers;

    this._worldList = el('ul', { className: 'world-list' });
    this._storageNote = el('p', { className: 'settings-note', hidden: true });
    /** @type {Array<Object>} Last world list received from `setWorlds`. */
    this._worlds = [];

    this._nameInput = el('input', {
      className: 'text-input',
      type: 'text',
      value: 'New World',
      maxLength: 48,
      attrs: { 'aria-label': 'World name', autocomplete: 'off', spellcheck: 'false' },
    });

    this._seedInput = el('input', {
      className: 'text-input',
      type: 'text',
      placeholder: 'Leave blank for a random seed',
      maxLength: 48,
      attrs: { 'aria-label': 'World seed', autocomplete: 'off', spellcheck: 'false' },
    });

    this._presetSelect = el(
      'select',
      { className: 'select-input', attrs: { 'aria-label': 'Graphics preset' } },
      PRESET_ORDER.map((id) =>
        el('option', { value: id, text: PRESET_LABELS[id] })
      )
    );
    this._modeSelect = el(
      'select',
      {
        className: 'select-input',
        attrs: { 'aria-label': 'Game mode and difficulty' },
        on: { change: () => this._updateModeDescription() },
      },
      [
        el('option', { value: 'creative', text: 'Creative' }),
        ...DIFFICULTY_ORDER.map((id) =>
          el('option', { value: id, text: getDifficulty(id).label })
        ),
      ]
    );
    this._modeDescription = el('p', { className: 'settings-note mode-description' });

    this._fileInput = el('input', {
      type: 'file',
      accept: 'application/json,.json',
      hidden: true,
      on: {
        change: (event) => {
          const file = event.target.files?.[0];
          if (file) handlers.onImportWorld(file);
          // Reset so selecting the same file twice fires again.
          event.target.value = '';
        },
      },
    });

    this._createPanel = el('div', { className: 'panel dialog', hidden: true }, [
      el('h2', { className: 'dialog-title', text: 'Create a world' }),
      el('div', { className: 'dialog-body' }, [
        el('div', { className: 'field' }, [
          el('label', { text: 'World name', htmlFor: 'world-name' }),
          this._nameInput,
        ]),
        el('div', { className: 'field' }, [
          el('label', { text: 'Seed' }),
          el('div', { className: 'field-row' }, [
            this._seedInput,
            button('Random', () => {
              this._seedInput.value = String(Math.floor(Math.random() * 0xffffffff));
            }),
          ]),
        ]),
        el('div', { className: 'field' }, [
          el('label', { text: 'Graphics preset' }),
          this._presetSelect,
        ]),
        el('div', { className: 'field' }, [
          el('label', { text: 'Mode and difficulty' }),
          this._modeSelect,
          this._modeDescription,
        ]),
      ]),
      el('div', { className: 'dialog-actions' }, [
        button('Back', () => this._showList()),
        button('Import save', () => this._fileInput.click()),
        button('Create and play', () => this._create(), { className: 'ui-button--primary' }),
      ]),
    ]);

    this._listPanel = el('div', { className: 'panel dialog' }, [
      el('div', { className: 'menu-brand' }, [
        el('h1', { text: 'VOXEL SANDBOX' }),
        el('p', { text: 'An original browser voxel engine' }),
      ]),
      this._storageNote,
      el('div', { className: 'dialog-body' }, [this._worldList]),
      // One action. With saves it continues the most recent world; without one it
      // starts a survival world on medium difficulty and the medium preset.
      el('div', { className: 'menu-primary' }, [
        button('Play', () => this._play(), { className: 'ui-button--primary' }),
      ]),
      // Everything optional lives behind these two, so the main screen stays a
      // title and a single button.
      el('div', { className: 'menu-secondary' }, [
        button('World options', () => this._showCreate()),
        button('Settings', () => handlers.onSettings()),
      ]),
    ]);

    this.element = el(
      'div',
      { className: 'screen screen--menu', hidden: true },
      [this._listPanel, this._createPanel, this._fileInput]
    );

    root.appendChild(this.element);
    this._visible = false;
    this._syncFromSettings();
  }

  /** True while the menu is shown. */
  get visible() {
    return this._visible;
  }

  /**
   * Shows the menu with a list of stored worlds.
   * @param {Array<Object>} worlds
   * @param {{persistent: boolean, error: Error|null}} [storage]
   */
  show(worlds, storage = { persistent: true, error: null }) {
    this.setWorlds(worlds, storage);
    this._showList();
    setVisible(this.element, true);
    this._visible = true;
  }

  /** Hides the menu. */
  hide() {
    setVisible(this.element, false);
    this._visible = false;
  }

  /**
   * Rebuilds the world list.
   * @param {Array<Object>} worlds
   * @param {{persistent: boolean, error: Error|null}} storage
   */
  setWorlds(worlds, storage = { persistent: true, error: null }) {
    this._worlds = Array.isArray(worlds) ? worlds : [];
    clear(this._worldList);

    if (!storage.persistent) {
      this._storageNote.textContent =
        `Browser storage is unavailable${storage.error ? `: ${storage.error.message}` : ''}. ` +
        'You can still play, but worlds will not survive a reload.';
      setVisible(this._storageNote, true);
    } else {
      setVisible(this._storageNote, false);
    }

    if (!worlds || worlds.length === 0) {
      this._worldList.appendChild(
        el('li', {
          className: 'empty-state',
          text: 'No worlds yet. Press Play to start a survival run. World options lets you choose a seed, difficulty or a creative world.',
        })
      );
      return;
    }

    for (const world of worlds) {
      this._worldList.appendChild(this._buildWorldEntry(world));
    }
  }

  _buildWorldEntry(world) {
    const played = world.lastPlayed ? new Date(world.lastPlayed) : null;
    const defeated = Boolean(world.hardcoreDefeated);
    const modeLabel = world.mode === 'survival'
      ? getDifficulty(world.difficulty).label
      : 'Creative';
    const meta = [
      `Seed ${world.seed}`,
      modeLabel,
      defeated ? 'World lost' : null,
      played ? `Played ${formatRelativeTime(played)}` : null,
    ]
      .filter(Boolean)
      .join('  ·  ');

    return el(
      'li',
      {
        className: 'world-entry',
        attrs: {
          role: defeated ? 'group' : 'button',
          tabindex: defeated ? '-1' : '0',
          'aria-disabled': defeated ? 'true' : null,
        },
        on: {
          click: (event) => {
            // Ignore clicks that landed on one of the action buttons.
            if (event.target instanceof HTMLElement && event.target.closest('.world-entry-actions')) {
              return;
            }
            if (!defeated) this._handlers.onPlayWorld(world.id);
          },
          keydown: (event) => {
            if (!defeated && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              this._handlers.onPlayWorld(world.id);
            }
          },
        },
      },
      [
        el('div', { className: 'world-entry-info' }, [
          el('span', { className: 'world-entry-name', text: world.name }),
          el('span', { className: 'world-entry-meta', text: meta }),
        ]),
        el('div', { className: 'world-entry-actions' }, [
          button('Export', () => this._handlers.onExportWorld(world.id)),
          button('Delete', () => this._confirmDelete(world), { className: 'ui-button--danger' }),
        ]),
      ]
    );
  }

  _confirmDelete(world) {
    // Deleting a world is irreversible, so it is always confirmed by name.
    const confirmed =
      typeof window.confirm !== 'function' ||
      window.confirm(`Delete "${world.name}" permanently? This cannot be undone.`);
    if (confirmed) this._handlers.onDeleteWorld(world.id);
  }

  /**
   * The single main action.
   *
   * With saves it continues the most recently played world. Without one — or when
   * every save is a lost one-life world — it starts the horror defaults directly:
   * survival, normal difficulty, medium graphics. No dialog, no seed prompt: the
   * first click should put the player in the world.
   */
  _play() {
    const playable = (this._worlds ?? []).filter((world) => !world.hardcoreDefeated);
    if (playable.length > 0) {
      const recent = playable.reduce(
        (best, world) => ((world.lastPlayed ?? 0) > (best.lastPlayed ?? 0) ? world : best),
        playable[0]
      );
      this._handlers.onPlayWorld(recent.id);
      return;
    }
    // Medium unless the player already picked a preset of their own: the default
    // is medium, but a first click should not undo a deliberate graphics choice.
    const currentPreset = this._settings.get('graphics.preset');
    this._handlers.onCreateWorld({
      name: suggestWorldName(),
      seed: Math.floor(Math.random() * 0xffffffff),
      preset: PRESET_ORDER.includes(currentPreset) ? currentPreset : 'medium',
      mode: 'survival',
      difficulty: 'normal',
    });
  }

  _showCreate() {
    setVisible(this._listPanel, false);
    setVisible(this._createPanel, true);
    this._nameInput.value = suggestWorldName();
    this._seedInput.value = '';

    // Re-read the current settings so the dropdowns reflect any change made in
    // the settings menu since this panel was built. Without this, creating a world
    // would silently re-apply a stale preset and undo the player's choice.
    this._syncFromSettings();

    this._nameInput.focus({ preventScroll: true });
    this._nameInput.select();
  }

  /**
   * Points the preset and mode dropdowns at the live settings values.
   *
   * `custom` is not offered in this list — it is a state, not a choice — so a
   * customised configuration falls back to the device's suggested preset.
   */
  _syncFromSettings() {
    const preset = this._settings.get('graphics.preset');
    const suggested = this._settings.suggestedPreset;
    this._presetSelect.value = PRESET_ORDER.includes(preset)
      ? preset
      : PRESET_ORDER.includes(suggested)
        ? suggested
        : 'medium';
    this._modeSelect.value = this._settings.get('gameplay.mode') === 'creative'
      ? 'creative'
      : 'normal';
    this._updateModeDescription();
  }

  _showList() {
    setVisible(this._createPanel, false);
    setVisible(this._listPanel, true);
  }

  _create() {
    const name = this._nameInput.value.trim() || 'New World';
    const seed = parseSeed(this._seedInput.value.trim());
    const selection = this._modeSelect.value;
    this._handlers.onCreateWorld({
      name,
      seed,
      preset: this._presetSelect.value,
      mode: selection === 'creative' ? 'creative' : 'survival',
      difficulty: selection === 'creative' ? 'normal' : getDifficulty(selection).id,
    });
  }

  _updateModeDescription() {
    if (this._modeSelect.value === 'creative') {
      this._modeDescription.textContent =
        'Unlimited building, flight, no hunger and no permanent death.';
      return;
    }
    this._modeDescription.textContent = getDifficulty(this._modeSelect.value).description;
  }

  /** Removes the element. */
  destroy() {
    this.element.remove();
  }
}

/** Suggests a friendly default world name. */
function suggestWorldName() {
  const adjectives = ['Quiet', 'Distant', 'Hidden', 'Windy', 'Golden', 'Frozen', 'Deep', 'Wide'];
  const nouns = ['Valley', 'Ridge', 'Hollow', 'Expanse', 'Shore', 'Highlands', 'Basin', 'Reach'];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective} ${noun}`;
}

/**
 * Formats a date as a coarse relative time.
 * @param {Date} date
 */
function formatRelativeTime(date) {
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString();
}

export default MainMenu;
