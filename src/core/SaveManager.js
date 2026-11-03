/**
 * Persistence layer backed by IndexedDB.
 *
 * What is stored
 * -------------
 * Terrain is a pure function of the seed, so the world itself is never
 * serialised. Only *differences* from the generated terrain are written: for
 * each modified chunk we keep a versioned `Uint32Array` of index/block-word
 * pairs. The current block word uses a 16-bit runtime id plus an 8-bit state.
 * Readers also accept the two historical one-word layouts, so existing worlds
 * migrate without losing edits. A chunk the player never touched costs zero bytes.
 *
 * Atomicity
 * ---------
 * A save writes the world record and every dirty chunk inside a single
 * IndexedDB transaction. If anything fails — quota exceeded, tab killed
 * mid-write — the transaction aborts and the previous save is left completely
 * intact. That is the "a failed autosave must not destroy the last valid save"
 * requirement, enforced by the database rather than by hopeful ordering.
 *
 * Fallback
 * --------
 * When IndexedDB is missing or blocked (private browsing on some engines) an
 * in-memory backend is substituted. The game stays fully playable; it simply
 * reports that progress will not survive a reload.
 */

import { CHUNK_VOLUME, SAVE } from '../config/GameConfig.js';
import { DEFAULT_HOTBAR } from '../world/BlockTypes.js';
import { itemIdForBlock } from '../items/ItemRegistry.js';
import { packBlockWord } from '../world/BlockState.js';
import { SLOT, migrateLegacyHotbar } from '../player/Inventory.js';
import { Events } from './EventBus.js';
import { normalizeDifficulty, isPermadeathDifficulty } from '../gameplay/Difficulty.js';

/**
 * Marker written into exported save files.
 *
 * Exports made before the rename say `voxel-sandbox-save`; those files still
 * have to import, so the reader accepts both and only the writer moved on.
 */
const SAVE_FILE_KIND = 'titancraft-save';
const LEGACY_SAVE_FILE_KINDS = Object.freeze(new Set(['voxel-sandbox-save']));

/**
 * @typedef {Object} WorldRecord
 * @property {string} id
 * @property {string} name
 * @property {number} seed
 * @property {number} formatVersion
 * @property {number} createdAt
 * @property {number} lastPlayed
 * @property {number} playTimeSeconds
 * @property {{x:number,y:number,z:number}} playerPosition
 * @property {{yaw:number,pitch:number}} playerRotation
 * @property {Array<{id:number,count:number}|null>} hotbar
 * @property {number} selectedSlot
 * @property {number} timeOfDay
 * @property {string} mode
 * @property {string} difficulty
 * @property {boolean} hardcoreDefeated
 * @property {boolean} flying
 * @property {{version:number,mobs:Array<Object>,items:Array<Object>}|null} entities
 */

export class SaveManager {
  /**
   * @param {import('./EventBus.js').EventBus} bus
   */
  constructor(bus) {
    this._bus = bus;
    /** @type {IDBDatabase|null} */
    this._db = null;
    this._openPromise = null;
    this._available = false;
    this._usingMemoryFallback = false;
    /** @type {{worlds: Map<string, WorldRecord>, chunks: Map<string, {id:string, worldId:string, cx:number, cz:number, data:Uint32Array}>}} */
    this._memory = { worlds: new Map(), chunks: new Map(), blockEntities: new Map() };
    this._lastError = null;
    this._saveInFlight = null;
  }

  /** True when a real IndexedDB is backing the store. */
  get isPersistent() {
    return this._available && !this._usingMemoryFallback;
  }

  /** The most recent storage error, for display in the UI. */
  get lastError() {
    return this._lastError;
  }

  /**
   * Opens (and upgrades) the database. Resolves even on failure, after
   * switching to the in-memory backend, so callers never have to branch.
   * @returns {Promise<{persistent: boolean, error: Error|null}>}
   */
  async open() {
    if (this._openPromise) return this._openPromise;

    this._openPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined' || indexedDB === null) {
        this._useMemoryFallback(new Error('IndexedDB is not available in this browser'));
        resolve({ persistent: false, error: this._lastError });
        return;
      }

      let request;
      try {
        request = indexedDB.open(SAVE.databaseName, SAVE.databaseVersion);
      } catch (error) {
        this._useMemoryFallback(error);
        resolve({ persistent: false, error: this._lastError });
        return;
      }

      // Some engines never fire any event when storage is disabled; a timeout
      // keeps the loading screen from hanging forever.
      const timeout = setTimeout(() => {
        if (this._db || this._usingMemoryFallback) return;
        this._useMemoryFallback(new Error('Opening the save database timed out'));
        resolve({ persistent: false, error: this._lastError });
      }, 6000);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const oldVersion = event.oldVersion || 0;
        this._migrate(db, oldVersion, request.transaction);
      };

      request.onsuccess = () => {
        clearTimeout(timeout);
        this._db = request.result;
        this._available = true;
        this._db.onversionchange = () => {
          // Another tab is upgrading. Release our handle so it can proceed.
          this._db?.close();
          this._db = null;
          this._available = false;
        };
        resolve({ persistent: true, error: null });
      };

      request.onerror = () => {
        clearTimeout(timeout);
        this._useMemoryFallback(request.error || new Error('Could not open the save database'));
        resolve({ persistent: false, error: this._lastError });
      };

      request.onblocked = () => {
        clearTimeout(timeout);
        this._useMemoryFallback(
          new Error('The save database is locked by another tab. Close other copies of the game.')
        );
        resolve({ persistent: false, error: this._lastError });
      };
    });

    return this._openPromise;
  }

  /**
   * Creates the object stores. Written as a switch on the previous version so
   * new versions can add stores or indices without destroying existing saves.
   */
  _migrate(db, oldVersion, transaction) {
    if (oldVersion < 1) {
      const worlds = db.createObjectStore(SAVE.storeWorlds, { keyPath: 'id' });
      worlds.createIndex('lastPlayed', 'lastPlayed');

      // Chunk keys are `${worldId}:${cx},${cz}` strings rather than a compound
      // key so a whole world can be dropped by walking one index.
      const chunks = db.createObjectStore(SAVE.storeChunks, { keyPath: 'id' });
      chunks.createIndex('worldId', 'worldId');
    }
    if (oldVersion < 2) {
      // Block entities. Nothing to transform: worlds saved before this existed
      // simply had no chests or furnaces, so an absent record is correct.
      const entities = db.createObjectStore(SAVE.storeBlockEntities, { keyPath: 'id' });
      entities.createIndex('worldId', 'worldId');
    }
    // Future migrations go here, e.g.:
    // if (oldVersion < 3) { ...transform existing records via `transaction`... }
    void transaction;
  }

  _useMemoryFallback(error) {
    this._lastError = error instanceof Error ? error : new Error(String(error));
    this._available = true;
    this._usingMemoryFallback = true;
    console.warn('[SaveManager] falling back to in-memory saves:', this._lastError.message);
  }

  // ------------------------------------------------------------------- reading

  /**
   * Lists stored worlds, most recently played first.
   * @returns {Promise<WorldRecord[]>}
   */
  async listWorlds() {
    await this.open();
    if (this._usingMemoryFallback) {
      return Array.from(this._memory.worlds.values()).sort((a, b) => b.lastPlayed - a.lastPlayed);
    }
    try {
      const records = await this._withStore(SAVE.storeWorlds, 'readonly', (store) =>
        promisifyRequest(store.getAll())
      );
      return records
        .filter((record) => this._isReadableWorld(record))
        .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    } catch (error) {
      this._lastError = error;
      console.warn('[SaveManager] listWorlds failed:', error);
      return [];
    }
  }

  /**
   * Loads a world record.
   * @param {string} worldId
   * @returns {Promise<WorldRecord|null>}
   */
  async loadWorld(worldId) {
    await this.open();
    if (this._usingMemoryFallback) return this._memory.worlds.get(worldId) || null;
    try {
      const record = await this._withStore(SAVE.storeWorlds, 'readonly', (store) =>
        promisifyRequest(store.get(worldId))
      );
      if (!record) return null;
      if (!this._isReadableWorld(record)) {
        throw new Error(`Save "${record.name || worldId}" uses an unsupported format`);
      }
      return this._migrateWorldRecord(record);
    } catch (error) {
      this._lastError = error;
      throw error;
    }
  }

  /**
   * Loads every stored chunk diff for a world.
   * @param {string} worldId
   * @returns {Promise<Map<string, Uint32Array>>} Keyed by `"cx,cz"`.
   */
  async loadChunkEdits(worldId) {
    await this.open();
    const result = new Map();
    const prefix = `${worldId}:`;

    if (this._usingMemoryFallback) {
      for (const record of this._memory.chunks.values()) {
        if (record.worldId === worldId) result.set(`${record.cx},${record.cz}`, record.data);
      }
      return result;
    }

    try {
      const records = await this._withStore(SAVE.storeChunks, 'readonly', (store) =>
        promisifyRequest(store.index('worldId').getAll(worldId))
      );
      for (const record of records) {
        if (!record || typeof record.id !== 'string' || !record.id.startsWith(prefix)) continue;
        const data = normaliseChunkEditPayload(record.data);
        if (data && data.length > 0) result.set(`${record.cx},${record.cz}`, data);
      }
    } catch (error) {
      this._lastError = error;
      console.warn(`[SaveManager] could not read chunk edits for ${worldId}:`, error);
    }
    return result;
  }

  /**
   * Loads every block entity for a world, keyed by chunk.
   *
   * Read in full at world load rather than per chunk: the whole set is small
   * (structured records for chests and furnaces only), and one bulk read is far
   * cheaper than an IndexedDB round trip every time a chunk streams in.
   *
   * A read failure yields an empty map rather than throwing, matching
   * `loadChunkEdits`: losing container contents is bad, but failing to open the
   * world is worse.
   *
   * @param {string} worldId
   * @returns {Promise<Map<string, Array<Object>>>}
   */
  async loadBlockEntities(worldId) {
    await this.open();
    /** @type {Map<string, Array<Object>>} */
    const result = new Map();

    if (this._usingMemoryFallback) {
      for (const record of this._memory.blockEntities.values()) {
        if (record.worldId === worldId) result.set(record.key, record.list);
      }
      return result;
    }

    try {
      const records = await this._withStore(SAVE.storeBlockEntities, 'readonly', (store) =>
        promisifyRequest(store.index('worldId').getAll(worldId))
      );
      for (const record of records) {
        if (!record || typeof record.key !== 'string') continue;
        if (!Array.isArray(record.list) || record.list.length === 0) continue;
        result.set(record.key, record.list);
      }
    } catch (error) {
      this._lastError = error;
      console.warn(`[SaveManager] could not read block entities for ${worldId}:`, error);
    }
    return result;
  }

  // ------------------------------------------------------------------- writing

  /**
   * Persists a world record plus a batch of dirty chunk diffs atomically.
   *
   * @param {WorldRecord} world
   * @param {Map<string, Uint32Array>} dirtyChunks Keyed by `"cx,cz"`. An empty
   *   `Uint32Array` means "this chunk is back to its generated state" and the
   *   record is deleted.
   * @returns {Promise<{written: number}>}
   */
  async saveWorld(world, dirtyChunks = new Map(), dirtyBlockEntities = new Map()) {
    // Serialise concurrent saves so an autosave and a manual save cannot
    // interleave and write half of each other's state.
    const run = async () => {
      await this.open();
      this._bus.emit(Events.SAVE_STARTED, { worldId: world.id });

      const record = {
        ...world,
        formatVersion: SAVE.worldFormatVersion,
        lastPlayed: Date.now(),
      };

      try {
        if (this._usingMemoryFallback) {
          this._memory.worlds.set(record.id, record);
          for (const [key, data] of dirtyChunks) {
            const id = `${record.id}:${key}`;
            if (!data || data.length === 0) {
              this._memory.chunks.delete(id);
            } else {
              const [cx, cz] = key.split(',').map(Number);
              this._memory.chunks.set(id, { id, worldId: record.id, cx, cz, data });
            }
          }
          for (const [key, list] of dirtyBlockEntities) {
            const id = `${record.id}:${key}`;
            if (!list || list.length === 0) {
              this._memory.blockEntities.delete(id);
            } else {
              this._memory.blockEntities.set(id, { id, worldId: record.id, key, list });
            }
          }
        } else {
          await this._transaction(
            [SAVE.storeWorlds, SAVE.storeChunks, SAVE.storeBlockEntities],
            'readwrite',
            (transaction) => {
              transaction.objectStore(SAVE.storeWorlds).put(record);
              const chunkStore = transaction.objectStore(SAVE.storeChunks);
              for (const [key, data] of dirtyChunks) {
                const id = `${record.id}:${key}`;
                if (!data || data.length === 0) {
                  chunkStore.delete(id);
                } else {
                  const [cx, cz] = key.split(',').map(Number);
                  // Copy: the caller keeps using its live array after this
                  // returns, and IndexedDB clones asynchronously.
                  chunkStore.put({ id, worldId: record.id, cx, cz, data: data.slice() });
                }
              }

              // Block entities go in the same transaction as the chunk edits.
              // That atomicity is load-bearing: a chest's *block* lives in the
              // edit array and its *contents* live here, so committing one
              // without the other would produce either an empty chest or a
              // ghost chest with items and no block.
              const entityStore = transaction.objectStore(SAVE.storeBlockEntities);
              for (const [key, list] of dirtyBlockEntities) {
                const id = `${record.id}:${key}`;
                if (!list || list.length === 0) {
                  entityStore.delete(id);
                } else {
                  entityStore.put({ id, worldId: record.id, key, list });
                }
              }
            }
          );
        }

        this._bus.emit(Events.SAVE_COMPLETED, {
          worldId: record.id,
          chunks: dirtyChunks.size,
          blockEntities: dirtyBlockEntities.size,
          persistent: this.isPersistent,
        });
        return { written: dirtyChunks.size, blockEntities: dirtyBlockEntities.size };
      } catch (error) {
        this._lastError = error;
        const message = describeStorageError(error);
        this._bus.emit(Events.SAVE_FAILED, { worldId: record.id, error, message });
        throw error;
      }
    };

    this._saveInFlight = (this._saveInFlight || Promise.resolve()).then(run, run);
    return this._saveInFlight;
  }

  /**
   * Deletes a world and every chunk diff belonging to it.
   * @param {string} worldId
   */
  async deleteWorld(worldId) {
    await this.open();
    if (this._usingMemoryFallback) {
      this._memory.worlds.delete(worldId);
      for (const [id, record] of this._memory.chunks) {
        if (record.worldId === worldId) this._memory.chunks.delete(id);
      }
      for (const [id, record] of this._memory.blockEntities) {
        if (record.worldId === worldId) this._memory.blockEntities.delete(id);
      }
      return true;
    }
    await this._transaction(
      [SAVE.storeWorlds, SAVE.storeChunks, SAVE.storeBlockEntities],
      'readwrite',
      (transaction) => {
        transaction.objectStore(SAVE.storeWorlds).delete(worldId);

        // Every per-world store is swept by its `worldId` index, so deleting a
        // world cannot leave orphaned rows behind that would then be counted
        // against the storage quota forever.
        for (const storeName of [SAVE.storeChunks, SAVE.storeBlockEntities]) {
          const store = transaction.objectStore(storeName);
          const cursorRequest = store.index('worldId').openKeyCursor(IDBKeyRange.only(worldId));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            store.delete(cursor.primaryKey);
            cursor.continue();
          };
        }
      }
    );
    return true;
  }

  // ------------------------------------------------------------ export/import

  /**
   * Serialises a whole world to a JSON-safe object suitable for download.
   * @param {string} worldId
   */
  async exportWorld(worldId) {
    const world = await this.loadWorld(worldId);
    if (!world) throw new Error('That world no longer exists');
    const edits = await this.loadChunkEdits(worldId);
    /** @type {Record<string, number[]>} */
    const chunks = {};
    for (const [key, data] of edits) chunks[key] = Array.from(data);

    // Container contents travel with the export. Omitting them would produce a
    // file that restores every chest as an empty one, which is a silent data loss
    // the player would only discover much later.
    const entities = await this.loadBlockEntities(worldId);
    /** @type {Record<string, Array<Object>>} */
    const blockEntities = {};
    for (const [key, list] of entities) blockEntities[key] = list;

    return {
      kind: SAVE_FILE_KIND,
      formatVersion: SAVE.worldFormatVersion,
      exportedAt: new Date().toISOString(),
      world,
      chunks,
      blockEntities,
    };
  }

  /**
   * Restores a world from an exported object, always under a fresh id so an
   * import can never clobber an existing world.
   * @param {any} payload
   * @returns {Promise<WorldRecord>}
   */
  async importWorld(payload) {
    const kind = payload?.kind;
    if (!payload || (kind !== SAVE_FILE_KIND && !LEGACY_SAVE_FILE_KINDS.has(kind)) || !payload.world) {
      throw new Error('That file is not a TitanCraft save');
    }
    if (Number(payload.formatVersion) > SAVE.worldFormatVersion) {
      throw new Error('That save was made by a newer version of the game');
    }

    const source = payload.world;
    if (!Number.isFinite(Number(source.seed))) throw new Error('The save has no valid seed');

    /** @type {WorldRecord} */
    const world = {
      ...createEmptyWorldRecord(String(source.name || 'Imported world'), Number(source.seed)),
      ...source,
      id: createWorldId(),
      formatVersion: SAVE.worldFormatVersion,
      createdAt: Number(source.createdAt) || Date.now(),
      lastPlayed: Date.now(),
    };
    world.difficulty = normalizeDifficulty(source.difficulty);
    world.hardcoreDefeated = isPermadeathDifficulty(world.difficulty) && source.hardcoreDefeated === true;

    const chunks = new Map();
    for (const [key, values] of Object.entries(payload.chunks || {})) {
      if (!/^-?\d+,-?\d+$/.test(key)) continue;
      const normalised = normaliseChunkEditPayload(values);
      // A current payload containing only the magic header represents no edits.
      if (!normalised || normalised.length <= 1) continue;
      chunks.set(key, normalised);
    }

    /** @type {Map<string, Array<Object>>} */
    const blockEntities = new Map();
    for (const [key, list] of Object.entries(payload.blockEntities || {})) {
      if (!/^-?\d+,-?\d+$/.test(key)) continue;
      if (!Array.isArray(list) || list.length === 0) continue;
      blockEntities.set(key, list);
    }

    await this.saveWorld(world, chunks, blockEntities);
    return world;
  }

  /**
   * Best-effort storage usage report for the UI.
   * @returns {Promise<{usage: number, quota: number}|null>}
   */
  async estimateUsage() {
    try {
      if (navigator?.storage?.estimate) {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        return { usage, quota };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /** Closes the database handle. */
  destroy() {
    try {
      this._db?.close();
    } catch {
      /* ignore */
    }
    this._db = null;
    this._openPromise = null;
    this._available = false;
  }

  // ----------------------------------------------------------------- internals

  _isReadableWorld(record) {
    if (!record || typeof record !== 'object') return false;
    if (!Number.isFinite(Number(record.seed))) return false;
    const version = Number(record.formatVersion) || 0;
    return version <= SAVE.worldFormatVersion;
  }

  /**
   * Brings an older world record up to the current shape.
   * Older versions simply lacked fields, so filling defaults is sufficient.
   */
  _migrateWorldRecord(record) {
    const incomingVersion = Number(record.formatVersion) || 1;
    const base = createEmptyWorldRecord(record.name, Number(record.seed), {
      mode: typeof record.mode === 'string' ? record.mode : 'creative',
      difficulty:record.difficulty,
    });
    const merged = { ...base, ...record };
    merged.formatVersion = SAVE.worldFormatVersion;
    merged.difficulty = normalizeDifficulty(merged.difficulty);
    merged.hardcoreDefeated = isPermadeathDifficulty(merged.difficulty) && merged.hardcoreDefeated === true;

    if (!merged.playerPosition || typeof merged.playerPosition.y !== 'number') {
      merged.playerPosition = base.playerPosition;
    }
    if (!merged.playerRotation) merged.playerRotation = base.playerRotation;

    // --- v3 -> v4: hotbar of block ids becomes a slot array of item stacks ---
    //
    // Done here rather than in `Inventory.fromJSON` so the upgraded shape is what
    // gets written back on the next save; leaving the translation to load time
    // would keep every old world on the legacy shape forever.
    if (incomingVersion < 4 || !Array.isArray(merged.slots)) {
      merged.slots = migrateLegacyHotbar(Array.isArray(record.hotbar) ? record.hotbar : base.slots);
      // The old field is intentionally dropped: keeping both would mean two
      // sources of truth for the same items, which is how duplication bugs start.
      delete merged.hotbar;
    }
    if (!Array.isArray(merged.slots)) merged.slots = base.slots;

    // Survival state did not exist before v4. A null here makes `PlayerStats`
    // start at full health, which is the right outcome for a world that was
    // played entirely in creative.
    if (merged.stats === undefined) merged.stats = null;
    if (!Array.isArray(merged.effects)) merged.effects = [];
    if (merged.spawnPoint === undefined) merged.spawnPoint = null;
    if (merged.cursor === undefined) merged.cursor = null;
    if (!merged.entities || typeof merged.entities !== 'object') merged.entities = null;
    if (!merged.phase3 || typeof merged.phase3 !== 'object') merged.phase3 = null;
    if (!merged.phase4 || typeof merged.phase4 !== 'object') merged.phase4 = null;
    if (!merged.phase5 || typeof merged.phase5 !== 'object') merged.phase5 = null;
    // v8 extends the optional Phase 5 payload in place. End block ids are an
    // append-only addition, so older chunks and phase records require no rewrite.
    // v7 adds story progression, aggregate statistics and bounded death markers.
    // It is intentionally a nullable companion record so every v1-v6 world opens
    // with a clean tree without rewriting or discarding any older field.
    if (!merged.advancements || typeof merged.advancements !== 'object') merged.advancements = null;

    return merged;
  }

  /** Runs `body` inside a transaction and resolves when it commits. */
  _transaction(storeNames, mode, body) {
    return new Promise((resolve, reject) => {
      if (!this._db) {
        reject(new Error('The save database is not open'));
        return;
      }
      let transaction;
      try {
        transaction = this._db.transaction(storeNames, mode);
      } catch (error) {
        reject(error);
        return;
      }
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('Transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
      try {
        result = body(transaction);
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          /* already aborting */
        }
        reject(error);
      }
    });
  }

  /** Convenience wrapper for single-store operations. */
  async _withStore(storeName, mode, body) {
    let output;
    await this._transaction([storeName], mode, (transaction) => {
      output = body(transaction.objectStore(storeName));
    });
    return output;
  }
}

/** Wraps an `IDBRequest` in a promise. */
function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Historical high bit distinguishing the v5 stateful one-word layout. */
const STATEFUL_EDIT_MARKER = 0x80000000;
/** Magic header for the v6 pair layout: `magic, index, blockWord, ...`. */
export const EDIT_PAIR_MAGIC = 0x5632_4544; // "V2ED"

/** True when an arbitrary value can be a voxel index. */
function isValidEditIndex(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) < CHUNK_VOLUME;
}

/**
 * True when a current block word uses only the defined 16-bit id and 8-bit
 * state fields. Unknown ids remain round-trippable so future data packs and
 * forward-compatible worlds are not silently destroyed by an older client.
 */
function isValidBlockWord(word) {
  return ((Number(word) >>> 0) & 0xff00_0000) === 0;
}

/** True when a historical one-word edit entry has a valid voxel index. */
function isValidLegacyPackedEdit(entry) {
  const value = Number(entry) >>> 0;
  const stateful = (value & STATEFUL_EDIT_MARKER) !== 0;
  const index = stateful ? (value >>> 16) & 0x7fff : value >>> 8;
  return index < CHUNK_VOLUME;
}

/**
 * Coerces an arbitrary stored/exported chunk payload into the current pair
 * representation. Invalid indices, truncated pairs and unknown block ids are
 * discarded independently so one corrupt entry cannot destroy the rest of a
 * player's build.
 *
 * @param {unknown} data
 * @returns {Uint32Array|null}
 */
export function normaliseChunkEditPayload(data) {
  let arr = null;
  if (data instanceof Uint32Array) arr = data;
  else if (ArrayBuffer.isView(data)) {
    const length = Math.floor(data.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    arr = new Uint32Array(data.buffer, data.byteOffset, length);
  } else if (data instanceof ArrayBuffer) arr = new Uint32Array(data);
  else if (Array.isArray(data)) {
    arr = Uint32Array.from(data.filter((value) => Number.isFinite(value)));
  } else return null;

  return packChunkEdits(unpackChunkEdits(arr));
}

/** Turns a storage exception into something worth showing a player. */
export function describeStorageError(error) {
  const name = error?.name || '';
  if (name === 'QuotaExceededError' || /quota/i.test(error?.message || '')) {
    return 'Storage is full. Delete an old world or free up space, then save again.';
  }
  if (name === 'InvalidStateError') {
    return 'The save database was closed. Reload the page to keep saving.';
  }
  if (name === 'AbortError') {
    return 'The save was interrupted. Your previous save is still intact.';
  }
  return error?.message || 'Saving failed for an unknown reason.';
}

/** Generates a collision-resistant world id without needing crypto APIs. */
export function createWorldId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      /* fall through */
    }
  }
  return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Builds a fresh world record with sane defaults.
 * @param {string} name
 * @param {number} seed
 * @returns {WorldRecord}
 */
export function createEmptyWorldRecord(name, seed, { mode = 'creative', difficulty = 'normal' } = {}) {
  return {
    id: createWorldId(),
    name: String(name || 'New world').slice(0, 48) || 'New world',
    seed: seed >>> 0,
    formatVersion: SAVE.worldFormatVersion,
    createdAt: Date.now(),
    lastPlayed: Date.now(),
    playTimeSeconds: 0,
    playerPosition: { x: 0.5, y: 0, z: 0.5 },
    playerRotation: { yaw: 0, pitch: 0 },
    // Creative starts with a building palette; survival starts empty, because
    // the first tree is the start of the progression chain.
    slots: mode === 'creative' ? creativeStartingSlots() : emptySlots(),
    selectedSlot: 0,
    cursor: null,
    stats: null,
    effects: [],
    spawnPoint: null,
    timeOfDay: 0.32,
    // Weather is three numbers because `WeatherSystem` derives everything else
    // from the seed. Null means "start at cycle zero", which is what every world
    // saved before this field existed will deserialize to.
    weather: null,
    mode,
    difficulty:normalizeDifficulty(difficulty),
    hardcoreDefeated:false,
    flying: false,
    entities: null,
    phase3: null,
    phase4: null,
    phase5: null,
    advancements: null,
  };
}

/** A full-length array of empty slots. */
function emptySlots() {
  return new Array(SLOT.TOTAL).fill(null);
}

/**
 * The creative starting hotbar, expressed as item stacks.
 *
 * Blocks are mapped through `itemIdForBlock` rather than hard-coding item ids, so
 * a renamed block cannot leave a dangling reference here.
 */
function creativeStartingSlots() {
  const slots = emptySlots();
  DEFAULT_HOTBAR.forEach((blockId, index) => {
    if (index >= SLOT.HOTBAR_SIZE) return;
    const itemId = itemIdForBlock(blockId);
    if (itemId) slots[index] = { id: itemId, n: 1 };
  });
  return slots;
}

/**
 * Packs a sparse chunk edit map into the v6 pair representation.
 *
 * A header makes detection unambiguous. Each edit then occupies two words:
 * voxel index followed by the current 16-bit-id/8-bit-state block word. Invalid
 * entries are skipped instead of corrupting the whole chunk record.
 *
 * @param {Map<number, number>} edits voxel index -> block word
 * @returns {Uint32Array}
 */
export function packChunkEdits(edits) {
  const output = new Uint32Array(1 + edits.size * 2);
  output[0] = EDIT_PAIR_MAGIC;
  let offset = 1;
  for (const [index, word] of edits) {
    const packedWord = Number(word) >>> 0;
    if (!isValidEditIndex(index) || !isValidBlockWord(packedWord)) continue;
    output[offset++] = index >>> 0;
    output[offset++] = packedWord;
  }
  return offset === output.length ? output : output.slice(0, offset);
}

/**
 * Unpacks the v6 pair format plus both historical one-word representations.
 *
 * Historical stateful entries used `(marker | index<<16 | state<<8 | id)` and
 * legacy entries used `(index<<8 | id)`. Both are upgraded to current block
 * words as they enter memory.
 *
 * @param {Uint32Array} packed
 * @returns {Map<number, number>}
 */
export function unpackChunkEdits(packed) {
  const edits = new Map();
  if (!packed || packed.length === 0) return edits;

  if ((packed[0] >>> 0) === EDIT_PAIR_MAGIC) {
    for (let i = 1; i + 1 < packed.length; i += 2) {
      const index = packed[i] >>> 0;
      const word = packed[i + 1] >>> 0;
      if (!isValidEditIndex(index) || !isValidBlockWord(word)) continue;
      edits.set(index, word);
    }
    return edits;
  }

  for (let i = 0; i < packed.length; i++) {
    const entry = packed[i] >>> 0;
    const stateful = (entry & STATEFUL_EDIT_MARKER) !== 0;
    const index = stateful ? (entry >>> 16) & 0x7fff : entry >>> 8;
    if (!isValidEditIndex(index)) continue;
    const blockId = entry & 0xff;
    const state = stateful ? (entry >>> 8) & 0xff : 0;
    edits.set(index, packBlockWord(blockId, state));
  }
  return edits;
}

export default SaveManager;
