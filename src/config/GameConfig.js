/**
 * Immutable engine-wide constants.
 *
 * This module must stay free of any Three.js or DOM dependency: it is imported
 * by the world generation Web Worker as well as by the main thread.
 */

/** Blocks along the X axis of a chunk. */
export const CHUNK_SIZE_X = 16;
/** Blocks along the Z axis of a chunk. */
export const CHUNK_SIZE_Z = 16;
/** Total world height in blocks. Valid block Y range is `0 .. WORLD_HEIGHT - 1`. */
export const WORLD_HEIGHT = 128;
/** Number of voxels stored per chunk. */
export const CHUNK_VOLUME = CHUNK_SIZE_X * CHUNK_SIZE_Z * WORLD_HEIGHT;

/**
 * Bit shifts used for the flat voxel index `x | (z << 4) | (y << 8)`.
 * Kept as constants so the mesher and generators can inline the arithmetic.
 */
export const IDX_SHIFT_Z = 4;
export const IDX_SHIFT_Y = 8;

/** Y level that oceans and lakes fill up to. */
export const SEA_LEVEL = 56;
/** Y level below which bedrock is generated. */
export const BEDROCK_HEIGHT = 2;

/**
 * Padded volume dimensions used for meshing. One block of padding on every
 * side gives the mesher access to all 26 neighbours of every voxel in the
 * chunk, which is what correct ambient occlusion and face culling require.
 */
export const PAD = 1;
export const PADDED_SIZE_X = CHUNK_SIZE_X + PAD * 2; // 18
export const PADDED_SIZE_Z = CHUNK_SIZE_Z + PAD * 2; // 18
export const PADDED_SIZE_Y = WORLD_HEIGHT + PAD * 2; // 130
export const PADDED_VOLUME = PADDED_SIZE_X * PADDED_SIZE_Y * PADDED_SIZE_Z;

/** Maximum light level, matching the classic 0..15 voxel lighting range. */
export const MAX_LIGHT = 15;

/** Face directions in the canonical order used by the mesher and registry. */
export const FACE_PX = 0;
export const FACE_NX = 1;
export const FACE_PY = 2;
export const FACE_NY = 3;
export const FACE_PZ = 4;
export const FACE_NZ = 5;

/** Unit normals per face index, flattened. */
export const FACE_NORMALS = Object.freeze([
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
]);

/** Render layers. The mesher emits one geometry per layer. */
export const LAYER_OPAQUE = 0;
export const LAYER_CUTOUT = 1;
export const LAYER_TRANSLUCENT = 2;
export const LAYER_LIQUID = 3;
export const LAYER_COUNT = 4;
export const LAYER_NAMES = Object.freeze(['opaque', 'cutout', 'translucent', 'liquid']);

/** Physics tuning. All values are in blocks and seconds. */
export const PHYSICS = Object.freeze({
  /** Fixed simulation step. */
  timeStep: 1 / 60,
  /** Never run more than this many steps in one frame (anti death-spiral). */
  maxStepsPerFrame: 5,
  /** Frame deltas larger than this are discarded rather than simulated. */
  maxFrameDelta: 0.25,

  gravity: 32,
  terminalVelocity: 78,
  waterGravity: 8,
  waterTerminalVelocity: 6,

  // Calibrated against Java Edition: 4.317 m/s walking, 5.612 m/s sprinting
  // (a flat 1.3x), 1.295 m/s sneaking. Measured in-engine speeds land within
  // ~1% of these once the fixed step and friction are accounted for.
  walkSpeed: 4.32,
  sprintMultiplier: 1.3,
  crouchMultiplier: 0.3,
  swimSpeed: 3.4,
  flySpeed: 11,
  flySprintMultiplier: 2.6,

  // Java jump apex is 1.2522 blocks. With gravity 32 the analytic impulse is
  // 8.95, but the fixed-step integrator overshoots the apex by ~5.9%, so the
  // impulse is trimmed to land the *measured* apex on 1.25 blocks. That is what
  // keeps a single block step jumpable and a 1.5 block ledge not.
  jumpVelocity: 8.7,
  swimUpVelocity: 4.2,

  groundAcceleration: 60,
  airAcceleration: 14,
  groundFriction: 12,
  airFriction: 0.6,
  waterFriction: 5.5,

  playerWidth: 0.6,
  playerHeight: 1.8,
  playerCrouchHeight: 1.4,
  eyeHeightRatio: 0.9,
  /** Maximum ledge height the player is auto-stepped over. */
  stepHeight: 0.55,
  /** Small separation kept from surfaces to avoid re-penetration jitter. */
  skin: 1e-3,
});

/** Item/entity tuning. */
export const ENTITIES = Object.freeze({
  maxItemEntities: 160,
  itemPickupRadius: 1.35,
  itemPickupDelay: 0.45,
  itemLifetime: 300,
  itemMergeRadius: 0.75,
  maxFallingBlocks: 96,
  /** Total naturally simulated living creatures. */
  maxMobs: 56,
  /** Arrows from players and ranged mobs share one bounded pool. */
  maxProjectiles: 96,
  /** Separate ecological caps keep animals from crowding out threats. */
  passiveMobCap: 20,
  hostileMobCap: 32,
  /** Upper bound on chained gravity updates triggered by one block change. */
  maxGravityCascade: 192,
});

/** Chunk streaming behaviour. */
export const STREAMING = Object.freeze({
  /** Extra rings kept loaded beyond the render distance before unloading. */
  unloadMargin: 2,
  /** Hard cap on queued generation requests; the rest is re-queued next tick. */
  maxQueuedGenerations: 512,
  /** Hard cap on in-flight jobs per worker. */
  maxJobsPerWorker: 3,
  /** Chunks whose mesh may be uploaded to the GPU per frame (preset-scaled). */
  defaultUploadBudget: 2,
  /** Vertical render distance is expressed in chunks but the world is one
   * chunk tall, so this scales the mesh visibility cylinder height instead. */
  maxVerticalDistance: 8,
});

/** Save-system constants. */
export const SAVE = Object.freeze({
  databaseName: 'voxel-sandbox',
  // 2: added the `blockEntities` store for chests and furnaces.
  databaseVersion: 2,
  /** Bumped when the on-disk world format changes; drives migrations. */
  // 6: runtime block ids widened to 16 bits. Chunk edit payloads now use a
  //    versioned pair format `[magic, index, blockWord, ...]`, while readers
  //    continue to accept every older packed representation.
  // 5: chunk edits gained a backward-compatible per-voxel state byte for crops,
  //    fluids, facing and redstone. World records need no structural migration;
  //    legacy edit entries decode with state zero.
  // 4: survival foundation. The hotbar-only `hotbar: [{id: <blockId>, count}]`
  //    became a 41-entry `slots` array of item stacks keyed by string item id,
  //    and player health/hunger/air plus a spawn point are now persisted.
  //    `_migrateWorldRecord` upgrades v3 records in place.
  // 8: append-only End rendering/content additions and persisted live dragon
  //    fight state. Existing records need no structural reshaping.
  // 9: difficulty and one-life defeat state became world-owned record fields.
  //    Older worlds migrate to Normal and remain playable.
  worldFormatVersion: 9,
  storeWorlds: 'worlds',
  storeChunks: 'chunks',
  /**
   * Block entities (chests, furnaces), keyed `${worldId}:${cx},${cz}`.
   *
   * A separate store rather than a field on the chunk record because chunk edits
   * are a packed `Uint32Array` written on a hot path, whereas block entities are
   * structured objects written far less often. Mixing them would force the edit
   * array through a structured clone it does not need.
   */
  storeBlockEntities: 'blockEntities',
  defaultAutosaveSeconds: 45,
});

/** Deterministic block simulation. */
export const BLOCK_TICKS = Object.freeze({
  /** Canonical game ticks per real second. */
  ticksPerSecond: 20,
  /** Three samples per 16-block-tall section, across this 128-block world. */
  randomTicksPerChunk: 24,
  /** Hard cap so a redstone/fluid cascade cannot monopolise a frame. */
  maxScheduledPerTick: 512,
  /** Catch-up cap after a long frame or background-tab resume. */
  maxCatchUpTicks: 5,
});

/** Day/night cycle. */
export const TIME = Object.freeze({
  /** Real seconds for a full in-game day at speed 1.0. */
  // 20 minutes. With the LightingSystem keyframe split this is roughly 5.5 minutes
  // of daylight, 3.5 minutes of dusk and 9 minutes of night: the horror pass wants
  // the player to spend more time surviving the dark than enjoying the light.
  secondsPerDay: 1200,
  /**
   * Normalised time of day a new world starts at.
   *
   * Late afternoon, not dawn: a save should open on long shadows and rising tension,
   * with nightfall a couple of minutes away. Opening on a bright noon is the exact
   * opposite of what the game is about.
   */
  startTime: 0.62,
  /** Time the world is moved to when "start at dusk" rewrites a daylight save. */
  duskTime: 0.62,
  /** Morning the player wakes up to after sleeping through the night. */
  morningTime: 0.27,
});

/** Interaction limits. */
export const INTERACTION = Object.freeze({
  defaultReach: 5,
  minReach: 2,
  maxReach: 12,
  /** Repeat delay when a place action is held down. */
  placeRepeatSeconds: 0.22,
  /** Creative-mode break repeat delay. */
  creativeBreakRepeatSeconds: 0.16,
});

/** Local-storage key for the settings blob. */
export const SETTINGS_STORAGE_KEY = 'voxel-sandbox.settings.v3';
