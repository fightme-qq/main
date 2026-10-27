/**
 * Block and texture-tile definitions.
 *
 * This module is data only and deliberately free of imports beyond constants,
 * because it is loaded inside the world generation worker as well as on the
 * main thread. `BlockRegistry` turns these declarations into the flat typed
 * arrays the mesher walks.
 *
 * Textures are referenced by *tile name*. `TILE_NAMES` fixes the atlas layout,
 * and `rendering/TextureAtlas.js` paints the tiles in exactly that order, so
 * the worker can compute UVs without ever seeing a canvas.
 */

import { LAYER_CUTOUT, LAYER_LIQUID, LAYER_OPAQUE, LAYER_TRANSLUCENT } from '../config/GameConfig.js';

/**
 * Atlas tile order. Index in this array *is* the tile index baked into UVs, so
 * new tiles must be appended rather than inserted.
 * @type {ReadonlyArray<string>}
 */
import { ALL_FAMILIES, allocateIds, buildFamilies } from './BlockFamily.js';
import { NETHER_BLOCK_DESCRIPTORS, NETHER_TILE_NAMES } from './NetherBlocks.js';
import { END_BLOCK_DESCRIPTORS, END_TILE_NAMES } from './EndBlocks.js';
import { UTILITY_BLOCK_DESCRIPTORS, UTILITY_TILE_NAMES } from './UtilityBlocks.js';
import { V7_BLOCK_DESCRIPTORS, V7_TILE_NAMES } from './V7Blocks.js';
import { V8_BLOCK_DESCRIPTORS, V8_TILE_NAMES } from './V8Blocks.js';
import { MOB_SKIN_TILE_NAMES } from './MobSkinTiles.js';

/** Shared dye palette used by colour blocks and their procedural atlas painters. */
export const COLOUR_BLOCK_PALETTES = Object.freeze({
  white:[238,238,238], orange:[226,97,18], magenta:[178,49,181], light_blue:[58,179,218],
  yellow:[241,175,21], lime:[94,168,24], pink:[215,101,143], gray:[55,58,62],
  light_gray:[125,125,115], cyan:[21,137,145], purple:[121,42,172], blue:[44,47,143],
  brown:[101,62,32], green:[73,91,36], red:[160,39,34], black:[25,25,29],
});
const COLOUR_BLOCK_KINDS = Object.freeze(['wool','concrete','terracotta','stained_glass']);
const COLOUR_TILE_NAMES = Object.freeze(
  Object.keys(COLOUR_BLOCK_PALETTES).flatMap((colour) =>
    COLOUR_BLOCK_KINDS.map((kind) => `${colour}_${kind}`)
  ).filter((name) => name !== 'white_wool')
);
const PHASE3_TILE_NAMES = Object.freeze([
  'enchanting_table','anvil','grindstone','smithing_table','brewing_stand',
  'piston','sticky_piston','hopper','dispenser','dropper','rail','powered_rail',
]);

export const TILE_NAMES = Object.freeze([
  'stone',
  'cobblestone',
  'mossy_cobblestone',
  'dirt',
  'grass_top',
  'grass_side',
  'sand',
  'red_sand',
  'sandstone_top',
  'sandstone_side',
  'gravel',
  'clay',
  'bedrock',
  'oak_log_side',
  'oak_log_top',
  'oak_leaves',
  'spruce_log_side',
  'spruce_log_top',
  'spruce_leaves',
  'birch_log_side',
  'birch_log_top',
  'birch_leaves',
  'planks',
  'bricks',
  'glass',
  'water',
  'ice',
  'coal_ore',
  'iron_ore',
  'gold_ore',
  'diamond_ore',
  'snow',
  'grass_snow_side',
  'cactus_side',
  'cactus_top',
  'tall_grass',
  'fern',
  'dead_bush',
  'flower_red',
  'flower_yellow',
  'torch',
  'glowstone',

  // --- item icons -----------------------------------------------------------
  // Items are not voxels, but their icons live in the same atlas so the
  // inventory UI and the held-item renderer can share one texture. Tile names
  // match item ids exactly, which is what lets `ItemRegistry` resolve an icon
  // without a hand-written lookup table.
  'stick',
  'coal',
  'charcoal',
  'iron_ingot',
  'gold_ingot',
  'diamond',
  'leather',
  'feather',
  'bone',
  'bone_meal',
  'string',
  'clay_ball',
  'wheat',
  'wheat_seeds',
  'bread',
  'apple',
  'carrot',
  'potato',
  'baked_potato',
  'raw_beef',
  'cooked_beef',
  'raw_porkchop',
  'cooked_porkchop',
  'raw_chicken',
  'cooked_chicken',
  'raw_mutton',
  'cooked_mutton',
  'bucket',
  'water_bucket',
  'lava_bucket',

  // --- tools ----------------------------------------------------------------
  // Ordered tier-major so the atlas reads like the progression itself.
  'wood_pickaxe',
  'wood_axe',
  'wood_shovel',
  'wood_hoe',
  'wood_sword',
  'stone_pickaxe',
  'stone_axe',
  'stone_shovel',
  'stone_hoe',
  'stone_sword',
  'iron_pickaxe',
  'iron_axe',
  'iron_shovel',
  'iron_hoe',
  'iron_sword',
  'diamond_pickaxe',
  'diamond_axe',
  'diamond_shovel',
  'diamond_hoe',
  'diamond_sword',

  // --- new blocks -----------------------------------------------------------
  'oak_sapling',

  // Workstations and containers. Each needs distinct top/side/front art so the
  // interactive face is obvious without a tooltip.
  'crafting_table_top',
  'crafting_table_side',
  'furnace_top',
  'furnace_side',
  'furnace_front',
  'furnace_front_lit',
  'chest_top',
  'chest_side',
  'chest_front',
  'farmland',
  'white_wool',

  // --- creature skins -------------------------------------------------------
  // One tile per mob. `MobRenderer` samples the same tile for every box in a
  // body, with per-part brightness separating the parts, so a whole creature is
  // one texture lookup and the atlas stays small.
  'mob_cow',
  'mob_pig',
  'mob_sheep',
  'mob_chicken',
  'mob_husk',
  'mob_bonecaster',
  'mob_lurker',

  // Appended stateful/simulation tiles. Atlas indices are a compatibility
  // contract, so new entries always live after the original catalogue.
  'farmland_wet',
  'lava',
  'obsidian',
  'wheat_stage_0',
  'wheat_stage_1',
  'wheat_stage_2',
  'wheat_stage_3',
  'wheat_stage_4',
  'wheat_stage_5',
  'wheat_stage_6',
  'wheat_stage_7',
  'carrot_stage_0',
  'carrot_stage_1',
  'carrot_stage_2',
  'carrot_stage_3',
  'carrot_stage_4',
  'carrot_stage_5',
  'carrot_stage_6',
  'carrot_stage_7',
  'potato_stage_0',
  'potato_stage_1',
  'potato_stage_2',
  'potato_stage_3',
  'potato_stage_4',
  'potato_stage_5',
  'potato_stage_6',
  'potato_stage_7',

  // Wearable equipment. Appended to preserve every previously published atlas
  // index; item ids and tile names intentionally match one-to-one.
  'leather_helmet',
  'leather_chestplate',
  'leather_leggings',
  'leather_boots',
  'gold_helmet',
  'gold_chestplate',
  'gold_leggings',
  'gold_boots',
  'iron_helmet',
  'iron_chestplate',
  'iron_leggings',
  'iron_boots',
  'diamond_helmet',
  'diamond_chestplate',
  'diamond_leggings',
  'diamond_boots',

  // --- redstone power system -----------------------------------------------
  'redstone_ore',
  ...Array.from({ length: 16 }, (_, power) => `redstone_wire_${power}`),
  'lever_off',
  'lever_on',
  'redstone_torch',
  'redstone_torch_off',
  'redstone_lamp',
  'redstone_lamp_lit',
  'repeater_south_off',
  'repeater_west_off',
  'repeater_north_off',
  'repeater_east_off',
  'repeater_south_on',
  'repeater_west_on',
  'repeater_north_on',
  'repeater_east_on',

  // --- ranged combat and defence -----------------------------------------
  'flint',
  'arrow',
  'bow',
  'shield',

  // --- complex block models (append-only atlas contract) -------------------
  'ladder',

  // --- environment and utility additions ----------------------------------
  'fire',
  'flint_and_steel',

  // --- block family materials (Phase 2 catalogue expansion) ----------------
  // Appended, never inserted: tile indices are baked into meshed chunks the
  // same way block ids are baked into saved ones.
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',

  'jungle_log_side',
  'acacia_log_side',
  'dark_oak_log_side',
  'mangrove_log_side',

  'stripped_oak_log_side',
  'stripped_spruce_log_side',
  'stripped_birch_log_side',
  'stripped_jungle_log_side',
  'stripped_acacia_log_side',
  'stripped_dark_oak_log_side',
  'stripped_mangrove_log_side',

  'granite',
  'diorite',
  'andesite',
  'deepslate',
  'tuff',
  'calcite',

  'polished_granite',
  'polished_diorite',
  'polished_andesite',
  'polished_deepslate',
  'polished_tuff',
  'polished_calcite',

  'granite_bricks',
  'diorite_bricks',
  'andesite_bricks',
  'deepslate_bricks',
  'tuff_bricks',
  'calcite_bricks',
  ...[
    'horse','donkey','llama','rabbit','fox','wolf','cat','bat','squid','turtle','bee','goat',
    'axolotl','frog','zombie','skeleton','creeper','spider','slime','drowned','witch','pillager',
    'ravager','guardian','villager','iron_golem',
    // Phase 4 Nether roster.
    'zombified_piglin','piglin','wither_skeleton','blaze','ghast','magma_cube','hoglin','strider',
    'wither',
  ].map((id) => `mob_${id}`),
  ...COLOUR_TILE_NAMES,
  ...PHASE3_TILE_NAMES,
  ...NETHER_TILE_NAMES,
  // Phase 4 netherite tier. Item icons only -- appended last so existing atlas
  // indices stay stable (tile indices are a save-compatibility contract).
  'netherite_scrap',
  'netherite_ingot',
  'netherite_pickaxe',
  'netherite_axe',
  'netherite_shovel',
  'netherite_hoe',
  'netherite_sword',
  'netherite_helmet',
  'netherite_chestplate',
  'netherite_leggings',
  'netherite_boots',
  // Phase 4 Nether item catalogue: the brewing and boss gates.
  'blaze_rod',
  'blaze_powder',
  'nether_wart_item',
  'ghast_tear',
  'magma_cream',
  'gold_nugget',
  'glowstone_dust',
  'nether_star',
  'warped_fungus_on_a_stick',
  'gunpowder',
  // Phase 5 The End. Appended last, again: tile indices are baked into UVs and
  // into save files, so a new dimension may only ever grow the tail.
  ...END_TILE_NAMES,
  ...UTILITY_TILE_NAMES,
  // Phase 5 item icons, plus the Enderman's mob tile.
  'ender_pearl',
  'eye_of_ender',
  'mob_enderman',
  'glass_bottle',
  'dragon_breath',
  'chorus_fruit',
  // Version 7 append-only world content. These tiles come after every 6.6 tile
  // so atlas indices already persisted or baked into old bundles never move.
  ...V7_TILE_NAMES,
  ...V8_TILE_NAMES,
  'shulker_shell',
  'elytra',
  'end_crystal',
  'mob_silverfish',
  'mob_shulker',
  'mob_ender_dragon',
  // Per-part creature skins. One tile per body role (head, body, limb, accent)
  // instead of one stretched tile per creature, so faces, hooves and markings
  // exist at all. Appended last for the same compatibility reason as everything
  // above, and derived from the palette table so the two can never drift.
  ...MOB_SKIN_TILE_NAMES,
  // Legacy single-tile names for the horror roster. The renderer uses the per-role
  // tiles above, but `MobTypes` still exposes `tileName` for every creature and the
  // atlas contract requires that name to exist.
  'mob_walker',
  'mob_hunter',
  'mob_stalker',
]);

/** Fast tile-name to index lookup. */
export const TILE_INDEX = Object.freeze(
  TILE_NAMES.reduce((map, name, index) => {
    map[name] = index;
    return map;
  }, /** @type {Record<string, number>} */ ({}))
);

/**
 * Numeric block ids. Ids are persisted inside save files, so existing values
 * must never be reused for a different block.
 * @enum {number}
 */
const BASE_BLOCK_IDS = Object.freeze({
  AIR: 0,
  STONE: 1,
  GRASS: 2,
  DIRT: 3,
  SAND: 4,
  GRAVEL: 5,
  OAK_LOG: 6,
  OAK_LEAVES: 7,
  PLANKS: 8,
  GLASS: 9,
  WATER: 10,
  COAL_ORE: 11,
  IRON_ORE: 12,
  GOLD_ORE: 13,
  DIAMOND_ORE: 14,
  BEDROCK: 15,
  SNOW_BLOCK: 16,
  SNOWY_GRASS: 17,
  CACTUS: 18,
  TALL_GRASS: 19,
  FLOWER_RED: 20,
  FLOWER_YELLOW: 21,
  TORCH: 22,
  COBBLESTONE: 23,
  SANDSTONE: 24,
  SPRUCE_LOG: 25,
  SPRUCE_LEAVES: 26,
  BIRCH_LOG: 27,
  BIRCH_LEAVES: 28,
  ICE: 29,
  CLAY: 30,
  MOSSY_COBBLESTONE: 31,
  DEAD_BUSH: 32,
  GLOWSTONE: 33,
  RED_SAND: 34,
  BRICKS: 35,
  FERN: 36,
  OAK_SAPLING: 37,
  CRAFTING_TABLE: 38,
  FURNACE: 39,
  /**
   * A furnace that is currently burning.
   *
   * A separate block id rather than per-block metadata: the mesher runs in a
   * worker and only ever receives voxel ids, so a lit face has to *be* a
   * different block for the texture to change. The two ids share one block
   * entity, and `FurnaceBlockEntity` swaps between them as the fire starts and
   * stops.
   */
  FURNACE_LIT: 40,
  CHEST: 41,
  /**
   * Tilled soil.
   *
   * Its own block rather than metadata on dirt, because the mesher only receives
   * voxel ids and a tilled surface has to look different. Crops (Prompt 7) will
   * require this beneath them.
   */
  FARMLAND: 42,
  /** Sheared from sheep. A building block, and the reason to keep a flock. */
  WHITE_WOOL: 43,
  WHEAT_CROP: 44,
  CARROT_CROP: 45,
  POTATO_CROP: 46,
  LAVA: 47,
  OBSIDIAN: 48,
  REDSTONE_ORE: 49,
  REDSTONE_WIRE: 50,
  LEVER: 51,
  REDSTONE_TORCH: 52,
  REDSTONE_TORCH_OFF: 53,
  REDSTONE_LAMP: 54,
  REDSTONE_LAMP_LIT: 55,
  REPEATER: 56,
  OAK_SLAB: 57,
  COBBLESTONE_SLAB: 58,
  OAK_STAIRS: 59,
  COBBLESTONE_STAIRS: 60,
  OAK_TRAPDOOR: 61,
  LADDER: 62,
  OAK_FENCE: 63,
  COBBLESTONE_WALL: 64,
  OAK_FENCE_GATE: 65,
  OAK_DOOR: 66,
  GLASS_PANE: 67,
  WHITE_BED: 68,
  STONE_BUTTON: 69,
  OAK_PRESSURE_PLATE: 70,
  STONE_PRESSURE_PLATE: 71,
  FIRE: 72,
});

/**
 * Family variants the hand-written catalogue already provides.
 *
 * Oak and the first two log types were authored before `BlockFamily.js`
 * existed. Regenerating them would mint a second block with the same name and
 * a different id, which is exactly the sort of thing that silently corrupts a
 * save. `selftest.mjs` asserts every entry here really does exist in the base
 * catalogue and that no generated name collides with one.
 */
const PRE_EXISTING_FAMILY_BLOCKS = Object.freeze([
  'oak_log',
  'oak_planks',
  'oak_slab',
  'oak_stairs',
  'oak_fence',
  'oak_fence_gate',
  'oak_door',
  'oak_trapdoor',
  'oak_pressure_plate',
  'spruce_log',
  'birch_log',
]);

/**
 * The generated half of the catalogue.
 *
 * Ids are allocated from the first free slot upward in the families' stable
 * declaration order, so the same source produces the same numbers on every
 * run. That determinism is what lets saved chunks keep meaning: ids 0-72 are
 * untouched, and the generated blocks occupy 73 upward as a pure append.
 */
export const FAMILY_BLOCKS = Object.freeze(
  allocateIds(
    buildFamilies(ALL_FAMILIES).filter((entry) => !PRE_EXISTING_FAMILY_BLOCKS.includes(entry.name)),
    Object.values(BASE_BLOCK_IDS)
  ).assignments
);

const FAMILY_BLOCK_IDS = {};
for (const entry of FAMILY_BLOCKS) FAMILY_BLOCK_IDS[entry.name.toUpperCase()] = entry.id;

const COLOUR_BLOCK_IDS = {};
const COLOUR_BLOCKS = [];
let nextColourBlockId = Math.max(...FAMILY_BLOCKS.map((entry) => entry.id)) + 1;
for (const name of COLOUR_TILE_NAMES) {
  COLOUR_BLOCK_IDS[name.toUpperCase()] = nextColourBlockId;
  COLOUR_BLOCKS.push(Object.freeze({ id: nextColourBlockId, name }));
  nextColourBlockId++;
}

const PHASE3_BLOCK_IDS = {};
const PHASE3_BLOCKS = [];
let nextPhase3BlockId = nextColourBlockId;
for (const name of PHASE3_TILE_NAMES) {
  PHASE3_BLOCK_IDS[name.toUpperCase()] = nextPhase3BlockId;
  PHASE3_BLOCKS.push(Object.freeze({ id: nextPhase3BlockId, name }));
  nextPhase3BlockId++;
}

/**
 * Phase 4: the Nether set, allocated as a pure append starting at the first id
 * after the Phase 3 range.
 *
 * This ordering is load-bearing for save compatibility. Ids 0..72 (hand-written),
 * 73..188 (families) and the colour and Phase 3 ranges up to 263 all keep the
 * numbers V5 and V6.1 wrote into save files; the Nether occupies 264 upward.
 */
const NETHER_BLOCK_IDS = {};
const NETHER_BLOCKS = [];
let nextNetherBlockId = nextPhase3BlockId;
for (const descriptor of NETHER_BLOCK_DESCRIPTORS) {
  NETHER_BLOCK_IDS[descriptor.name.toUpperCase()] = nextNetherBlockId;
  NETHER_BLOCKS.push(Object.freeze({ id: nextNetherBlockId, descriptor }));
  nextNetherBlockId++;
}

/**
 * Phase 5: the End set, allocated as a pure append after the Nether range.
 *
 * Same contract as every range before it -- the End starts at the first free id
 * and never reuses one, so a world saved in 6.5 still reads correctly in 6.6.
 */
const END_BLOCK_IDS = {};
const END_BLOCKS = [];
let nextEndBlockId = nextNetherBlockId;
for (const descriptor of END_BLOCK_DESCRIPTORS) {
  END_BLOCK_IDS[descriptor.name.toUpperCase()] = nextEndBlockId;
  END_BLOCKS.push(Object.freeze({ id: nextEndBlockId, descriptor }));
  nextEndBlockId++;
}

/**
 * Neutral utility blocks, appended after the End so no existing id moves.
 */
const UTILITY_BLOCK_IDS = {};
const UTILITY_BLOCKS = [];
let nextUtilityBlockId = nextEndBlockId;
for (const descriptor of UTILITY_BLOCK_DESCRIPTORS) {
  UTILITY_BLOCK_IDS[descriptor.name.toUpperCase()] = nextUtilityBlockId;
  UTILITY_BLOCKS.push(Object.freeze({ id: nextUtilityBlockId, descriptor }));
  nextUtilityBlockId++;
}

/** Version 7 blocks append after the beacon, preserving ids 0..364 exactly. */
const V7_BLOCK_IDS = {};
const V7_BLOCKS = [];
let nextV7BlockId = nextUtilityBlockId;
for (const descriptor of V7_BLOCK_DESCRIPTORS) {
  V7_BLOCK_IDS[descriptor.name.toUpperCase()] = nextV7BlockId;
  V7_BLOCKS.push(Object.freeze({ id: nextV7BlockId, descriptor }));
  nextV7BlockId++;
}

/** Version 8 blocks append after all Version 7 ids. */
const V8_BLOCK_IDS = {};
const V8_BLOCKS = [];
let nextV8BlockId = nextV7BlockId;
for (const descriptor of V8_BLOCK_DESCRIPTORS) {
  V8_BLOCK_IDS[descriptor.name.toUpperCase()] = nextV8BlockId;
  V8_BLOCKS.push(Object.freeze({ id:nextV8BlockId, descriptor }));
  nextV8BlockId++;
}

/**
 * Numeric block ids: the hand-written catalogue plus every generated family
 * variant. Ids are persisted inside save files, so existing values must never
 * be reused for a different block.
 * @enum {number}
 */
export const Block = Object.freeze({ ...BASE_BLOCK_IDS, ...FAMILY_BLOCK_IDS, ...COLOUR_BLOCK_IDS, ...PHASE3_BLOCK_IDS, ...NETHER_BLOCK_IDS, ...END_BLOCK_IDS, ...UTILITY_BLOCK_IDS, ...V7_BLOCK_IDS, ...V8_BLOCK_IDS });

/** Mesh shapes a block can take. */
export const RenderShape = Object.freeze({
  /** Standard full cube. */
  CUBE: 'cube',
  /** Two intersecting quads, used for grass, flowers and saplings. */
  CROSS: 'cross',
  /** A thin centred column, used for torches and levers. */
  POST: 'post',
  /** A paper-thin top surface, used for wire and repeaters. */
  PLATE: 'plate',
  /** One or more state-dependent cuboids, used by slabs, stairs and doors. */
  BOXES: 'boxes',
});

/** Sound groups drive footstep, break and place sounds. */
export const SoundGroup = Object.freeze({
  STONE: 'stone',
  DIRT: 'dirt',
  GRASS: 'grass',
  WOOD: 'wood',
  SAND: 'sand',
  GLASS: 'glass',
  PLANT: 'plant',
  SNOW: 'snow',
  LIQUID: 'liquid',
  METAL: 'metal',
});

/**
 * Shorthand builder so each definition only states what differs from the
 * "ordinary opaque cube" baseline.
 *
 * @param {Object} definition
 * @returns {Object}
 */
function block(definition) {
  const textureAll = definition.textureAll;
  const resolved = {
    // --- identity ---
    id: definition.id,
    name: definition.name,
    displayName: definition.displayName || toDisplayName(definition.name),

    // --- physics / gameplay ---
    solid: definition.solid ?? true,
    collidable: definition.collidable ?? definition.solid ?? true,
    breakable: definition.breakable ?? true,
    hardness: definition.hardness ?? 1,
    liquid: definition.liquid ?? false,
    gravityAffected: definition.gravityAffected ?? false,
    /** Blocks that a cross/post block can be attached to must be `supportive`. */
    needsSupport: definition.needsSupport ?? false,
    stackSize: definition.stackSize ?? 64,
    dropId: definition.dropId ?? definition.id,

    // --- rendering ---
    /** Opaque blocks hide the faces of their neighbours. */
    transparent: definition.transparent ?? false,
    renderLayer: definition.renderLayer ?? LAYER_OPAQUE,
    renderShape: definition.renderShape ?? RenderShape.CUBE,
    /** Skip the shared face between two identical blocks (glass, leaves, water). */
    cullSameNeighbour: definition.cullSameNeighbour ?? false,
    /** Vertex animation class consumed by the voxel shader. */
    sway: definition.sway ?? 'none',
    /** 0..15 light emitted by the block itself. */
    lightLevel: definition.lightLevel ?? 0,
    emissive: (definition.lightLevel ?? 0) > 0,
    /**
     * How much sky light this block removes from the column beneath it.
     * 15 fully blocks the sky, 0 is perfectly clear.
     */
    lightAttenuation: definition.lightAttenuation ?? 15,
    /** Multiplied into the block's vertex colour, for cheap tinting. */
    tint: definition.tint ?? null,

    // --- textures, resolved to atlas tile indices ---
    textureTop: definition.textureTop ?? textureAll,
    textureBottom: definition.textureBottom ?? textureAll,
    textureSide: definition.textureSide ?? textureAll,
    /** Default state byte assigned when the block is placed. */
    defaultState: definition.defaultState ?? 0,
    /**
     * Optional state -> texture override table. A value may be a tile-name
     * string (all faces) or `{top,bottom,side}`. `BlockRegistry` flattens this
     * into a typed lookup so the mesher never performs object work per face.
     */
    stateTextures: definition.stateTextures ?? null,
    /** Optional state -> visual height for cross/liquid-like geometry. */
    stateHeights: definition.stateHeights ?? null,

    soundGroup: definition.soundGroup ?? SoundGroup.STONE,

    // --- harvesting ---------------------------------------------------------
    /**
     * The kind of tool this block is meant to be broken with.
     *
     * `null` means any tool is equally good, which is the right answer for glass
     * and for decorative plants. A preferred tool grants its speed bonus; the
     * wrong tool gains nothing.
     */
    preferredTool: definition.preferredTool ?? null,
    /**
     * Lowest tool tier that yields a drop, as a `ToolTier` name.
     *
     * `'hand'` (level 0) means bare hands suffice. This is the progression gate:
     * iron ore at `'stone'` is what forces a stone pickaxe before iron.
     */
    minimumHarvestTier: definition.minimumHarvestTier ?? 'hand',
    /**
     * Whether the *kind* of tool matters for getting a drop at all.
     *
     * Separate from `minimumHarvestTier` because the two gates are independent: a
     * wooden pickaxe is the correct kind for iron ore but too weak, whereas a
     * diamond shovel is strong enough for stone but the wrong kind. Both must
     * pass.
     */
    requiresCorrectTool: definition.requiresCorrectTool ?? false,
    /**
     * Always drops, whatever broke it.
     *
     * Overrides both gates. Dirt, sand and plants do not care what dug them, and
     * expressing that as data avoids a pile of special cases in the calculator.
     */
    dropsWithoutCorrectTool: definition.dropsWithoutCorrectTool ?? false,

    /**
     * Extra recipe tags for the item this block generates.
     *
     * Declared on the block rather than as an item override because the tag is a
     * property of the material ("this is a plank", "this is a log"), and keeping
     * it here means adding a new wood type is one block entry with no second edit
     * in the item list. `ItemRegistry` merges these into the generated item's
     * tags. Tags are what let one recipe accept any plank instead of needing four
     * near-identical copies.
     */
    recipeTags: Object.freeze(definition.recipeTags ? [...definition.recipeTags] : []),
  };

  if (!resolved.textureTop && resolved.id !== Block.AIR) {
    throw new Error(`Block "${resolved.name}" has no texture assigned`);
  }
  return resolved;
}

function toDisplayName(name) {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Every block definition, in id order.
 * @type {ReadonlyArray<Object>}
 */
const BASE_BLOCK_DEFINITIONS = Object.freeze([
  block({
    id: Block.AIR,
    name: 'air',
    solid: false,
    collidable: false,
    breakable: false,
    transparent: true,
    lightAttenuation: 0,
    renderShape: RenderShape.CUBE,
    hardness: 0,
    stackSize: 0,
  }),

  block({
    id: Block.STONE,
    name: 'stone',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    recipeTags: ['stone_material', 'furnace_material'],
    textureAll: 'stone',
    hardness: 2.2,
    dropId: Block.COBBLESTONE,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.GRASS,
    name: 'grass_block',
    preferredTool: 'shovel',
    displayName: 'Grass Block',
    textureTop: 'grass_top',
    textureSide: 'grass_side',
    textureBottom: 'dirt',
    hardness: 0.7,
    dropId: Block.DIRT,
    soundGroup: SoundGroup.GRASS,
  }),
  block({
    id: Block.DIRT,
    name: 'dirt',
    preferredTool: 'shovel',
    textureAll: 'dirt',
    hardness: 0.6,
    soundGroup: SoundGroup.DIRT,
  }),
  block({
    id: Block.SAND,
    name: 'sand',
    preferredTool: 'shovel',
    textureAll: 'sand',
    hardness: 0.55,
    gravityAffected: true,
    soundGroup: SoundGroup.SAND,
  }),
  block({
    id: Block.GRAVEL,
    name: 'gravel',
    preferredTool: 'shovel',
    textureAll: 'gravel',
    hardness: 0.7,
    gravityAffected: true,
    soundGroup: SoundGroup.SAND,
  }),
  block({
    id: Block.OAK_LOG,
    name: 'oak_log',
    preferredTool: 'axe',
    recipeTags: ['logs'],
    textureTop: 'oak_log_top',
    textureBottom: 'oak_log_top',
    textureSide: 'oak_log_side',
    hardness: 1.6,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.OAK_LEAVES,
    name: 'oak_leaves',
    textureAll: 'oak_leaves',
    hardness: 0.3,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    cullSameNeighbour: true,
    sway: 'leaves',
    lightAttenuation: 2,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.PLANKS,
    name: 'oak_planks',
    preferredTool: 'axe',
    textureAll: 'planks',
    recipeTags: ['planks'],
    hardness: 1.4,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.GLASS,
    name: 'glass',
    textureAll: 'glass',
    hardness: 0.4,
    transparent: true,
    renderLayer: LAYER_TRANSLUCENT,
    cullSameNeighbour: true,
    lightAttenuation: 0,
    soundGroup: SoundGroup.GLASS,
  }),
  block({
    id: Block.WATER,
    name: 'water',
    textureAll: 'water',
    solid: false,
    collidable: false,
    breakable: false,
    liquid: true,
    transparent: true,
    renderLayer: LAYER_LIQUID,
    cullSameNeighbour: true,
    // Water removes an extra light level beyond distance falloff, so deep
    // pools visibly darken while light can still propagate through them.
    lightAttenuation: 2,
    hardness: 0,
    stackSize: 0,
    soundGroup: SoundGroup.LIQUID,
  }),

  block({
    id: Block.COAL_ORE,
    name: 'coal_ore',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    minimumHarvestTier: 'wood',
    textureAll: 'coal_ore',
    hardness: 2.6,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.IRON_ORE,
    name: 'iron_ore',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    minimumHarvestTier: 'stone',
    textureAll: 'iron_ore',
    hardness: 2.9,
    soundGroup: SoundGroup.METAL,
  }),
  block({
    id: Block.GOLD_ORE,
    name: 'gold_ore',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    minimumHarvestTier: 'iron',
    textureAll: 'gold_ore',
    hardness: 3.1,
    soundGroup: SoundGroup.METAL,
  }),
  block({
    id: Block.DIAMOND_ORE,
    name: 'diamond_ore',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    minimumHarvestTier: 'iron',
    textureAll: 'diamond_ore',
    hardness: 3.6,
    soundGroup: SoundGroup.METAL,
  }),
  block({
    id: Block.BEDROCK,
    name: 'bedrock',
    textureAll: 'bedrock',
    breakable: false,
    hardness: Infinity,
    soundGroup: SoundGroup.STONE,
  }),

  block({
    id: Block.SNOW_BLOCK,
    name: 'snow_block',
    preferredTool: 'shovel',
    textureAll: 'snow',
    hardness: 0.5,
    soundGroup: SoundGroup.SNOW,
  }),
  block({
    id: Block.SNOWY_GRASS,
    name: 'snowy_grass_block',
    preferredTool: 'shovel',
    displayName: 'Snowy Grass',
    textureTop: 'snow',
    textureSide: 'grass_snow_side',
    textureBottom: 'dirt',
    hardness: 0.7,
    dropId: Block.DIRT,
    soundGroup: SoundGroup.SNOW,
  }),
  block({
    id: Block.CACTUS,
    name: 'cactus',
    textureTop: 'cactus_top',
    textureBottom: 'cactus_top',
    textureSide: 'cactus_side',
    hardness: 0.8,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    lightAttenuation: 15,
    soundGroup: SoundGroup.PLANT,
  }),

  block({
    id: Block.TALL_GRASS,
    name: 'tall_grass',
    textureAll: 'tall_grass',
    solid: false,
    collidable: false,
    hardness: 0.05,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    sway: 'grass',
    needsSupport: true,
    lightAttenuation: 0,
    dropId: Block.TALL_GRASS,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.FLOWER_RED,
    name: 'red_flower',
    textureAll: 'flower_red',
    solid: false,
    collidable: false,
    hardness: 0.05,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    sway: 'grass',
    needsSupport: true,
    lightAttenuation: 0,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.FLOWER_YELLOW,
    name: 'yellow_flower',
    textureAll: 'flower_yellow',
    solid: false,
    collidable: false,
    hardness: 0.05,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    sway: 'grass',
    needsSupport: true,
    lightAttenuation: 0,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.TORCH,
    name: 'torch',
    textureAll: 'torch',
    solid: false,
    collidable: false,
    hardness: 0.05,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.POST,
    needsSupport: true,
    lightLevel: 14,
    lightAttenuation: 0,
    soundGroup: SoundGroup.WOOD,
  }),

  block({
    id: Block.COBBLESTONE,
    name: 'cobblestone',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    recipeTags: ['stone_material', 'furnace_material'],
    textureAll: 'cobblestone',
    hardness: 2.4,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.SANDSTONE,
    name: 'sandstone',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    textureTop: 'sandstone_top',
    textureBottom: 'sandstone_top',
    textureSide: 'sandstone_side',
    hardness: 1.6,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.SPRUCE_LOG,
    name: 'spruce_log',
    preferredTool: 'axe',
    recipeTags: ['logs'],
    textureTop: 'spruce_log_top',
    textureBottom: 'spruce_log_top',
    textureSide: 'spruce_log_side',
    hardness: 1.6,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.SPRUCE_LEAVES,
    name: 'spruce_leaves',
    textureAll: 'spruce_leaves',
    hardness: 0.3,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    cullSameNeighbour: true,
    sway: 'leaves',
    lightAttenuation: 3,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.BIRCH_LOG,
    name: 'birch_log',
    preferredTool: 'axe',
    recipeTags: ['logs'],
    textureTop: 'birch_log_top',
    textureBottom: 'birch_log_top',
    textureSide: 'birch_log_side',
    hardness: 1.6,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.BIRCH_LEAVES,
    name: 'birch_leaves',
    textureAll: 'birch_leaves',
    hardness: 0.3,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    cullSameNeighbour: true,
    sway: 'leaves',
    lightAttenuation: 2,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.ICE,
    name: 'ice',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    textureAll: 'ice',
    hardness: 0.6,
    transparent: true,
    renderLayer: LAYER_TRANSLUCENT,
    cullSameNeighbour: true,
    lightAttenuation: 2,
    soundGroup: SoundGroup.GLASS,
  }),
  block({
    id: Block.CLAY,
    name: 'clay',
    preferredTool: 'shovel',
    textureAll: 'clay',
    hardness: 0.8,
    soundGroup: SoundGroup.DIRT,
  }),
  block({
    id: Block.MOSSY_COBBLESTONE,
    name: 'mossy_cobblestone',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    textureAll: 'mossy_cobblestone',
    hardness: 2.4,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.DEAD_BUSH,
    name: 'dead_bush',
    textureAll: 'dead_bush',
    solid: false,
    collidable: false,
    hardness: 0.05,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    sway: 'grass',
    needsSupport: true,
    lightAttenuation: 0,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.GLOWSTONE,
    name: 'glowstone',
    preferredTool: 'pickaxe',
    textureAll: 'glowstone',
    hardness: 0.5,
    lightLevel: 15,
    soundGroup: SoundGroup.GLASS,
  }),
  block({
    id: Block.RED_SAND,
    name: 'red_sand',
    preferredTool: 'shovel',
    textureAll: 'red_sand',
    hardness: 0.55,
    gravityAffected: true,
    soundGroup: SoundGroup.SAND,
  }),
  block({
    id: Block.BRICKS,
    name: 'bricks',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    textureAll: 'bricks',
    hardness: 2.4,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.FERN,
    name: 'fern',
    textureAll: 'fern',
    solid: false,
    collidable: false,
    hardness: 0.05,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    sway: 'grass',
    needsSupport: true,
    lightAttenuation: 0,
    dropId: Block.FERN,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.OAK_SAPLING,
    name: 'oak_sapling',
    displayName: 'Oak Sapling',
    textureAll: 'oak_sapling',
    solid: false,
    collidable: false,
    hardness: 0.05,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    sway: 'grass',
    needsSupport: true,
    lightAttenuation: 0,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.CRAFTING_TABLE,
    name: 'crafting_table',
    preferredTool: 'axe',
    displayName: 'Crafting Table',
    textureTop: 'crafting_table_top',
    textureSide: 'crafting_table_side',
    textureBottom: 'planks',
    hardness: 2.5,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.FURNACE,
    name: 'furnace',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    displayName: 'Furnace',
    textureTop: 'furnace_top',
    textureSide: 'furnace_side',
    textureBottom: 'furnace_top',
    // `textureFront` is not a concept the mesher knows about, so the lit and
    // unlit states differ by block id and the "front" is simply the side art.
    // Rotation-aware faces would need a per-block facing value, which the
    // one-byte voxel format cannot carry.
    hardness: 3.5,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.FURNACE_LIT,
    name: 'furnace_lit',
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    displayName: 'Furnace',
    textureTop: 'furnace_top',
    textureSide: 'furnace_front_lit',
    textureBottom: 'furnace_top',
    hardness: 3.5,
    // The fire glows. Not full brightness — a furnace should light its corner,
    // not the whole room.
    lightLevel: 13,
    // Breaking a lit furnace yields an ordinary one; nobody expects to collect a
    // burning block.
    dropId: Block.FURNACE,
    // `stackSize: 0` marks it unobtainable, the same marker water uses. Without
    // it `ItemRegistry` would generate a placeable "furnace_lit" item, giving two
    // different items that both look like a furnace and putting a burning one in
    // the creative palette. The lit state is only ever set by the block entity.
    stackSize: 0,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.CHEST,
    name: 'chest',
    preferredTool: 'axe',
    displayName: 'Chest',
    textureTop: 'chest_top',
    textureSide: 'chest_side',
    textureBottom: 'chest_top',
    hardness: 2.5,
    // Slightly transparent classification so the mesher does not cull the faces
    // of an adjacent chest against it, which would make a row of chests look
    // like one solid block.
    cullSameNeighbour: false,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.FARMLAND,
    name: 'farmland',
    displayName: 'Farmland',
    textureTop: 'farmland',
    textureSide: 'dirt',
    textureBottom: 'dirt',
    stateTextures: {
      1: { top: 'farmland_wet' },
      2: { top: 'farmland_wet' },
      3: { top: 'farmland_wet' },
      4: { top: 'farmland_wet' },
      5: { top: 'farmland_wet' },
      6: { top: 'farmland_wet' },
      7: { top: 'farmland_wet' },
    },
    preferredTool: 'shovel',
    hardness: 0.55,
    // Breaking tilled soil gives back plain dirt, not farmland: the tilling is
    // labour, not a material.
    dropId: Block.DIRT,
    soundGroup: SoundGroup.DIRT,
  }),
  block({
    id: Block.WHITE_WOOL,
    name: 'white_wool',
    displayName: 'White Wool',
    textureAll: 'white_wool',
    preferredTool: 'shears',
    hardness: 0.8,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.WHEAT_CROP,
    name: 'wheat_crop',
    displayName: 'Wheat Crop',
    textureAll: 'wheat_stage_0',
    stateTextures: Object.fromEntries(
      Array.from({ length: 8 }, (_, age) => [age, `wheat_stage_${age}`])
    ),
    stateHeights: [0.24, 0.31, 0.39, 0.48, 0.59, 0.7, 0.82, 0.94],
    solid: false,
    collidable: false,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    lightAttenuation: 0,
    hardness: 0.05,
    dropId: Block.AIR,
    stackSize: 0,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.CARROT_CROP,
    name: 'carrot_crop',
    displayName: 'Carrot Crop',
    textureAll: 'carrot_stage_0',
    stateTextures: Object.fromEntries(
      Array.from({ length: 8 }, (_, age) => [age, `carrot_stage_${age}`])
    ),
    stateHeights: [0.2, 0.27, 0.34, 0.42, 0.51, 0.6, 0.7, 0.8],
    solid: false,
    collidable: false,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    lightAttenuation: 0,
    hardness: 0.05,
    dropId: Block.AIR,
    stackSize: 0,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.POTATO_CROP,
    name: 'potato_crop',
    displayName: 'Potato Crop',
    textureAll: 'potato_stage_0',
    stateTextures: Object.fromEntries(
      Array.from({ length: 8 }, (_, age) => [age, `potato_stage_${age}`])
    ),
    stateHeights: [0.2, 0.27, 0.35, 0.43, 0.52, 0.61, 0.71, 0.82],
    solid: false,
    collidable: false,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    lightAttenuation: 0,
    hardness: 0.05,
    dropId: Block.AIR,
    stackSize: 0,
    soundGroup: SoundGroup.PLANT,
  }),
  block({
    id: Block.LAVA,
    name: 'lava',
    displayName: 'Lava',
    textureAll: 'lava',
    solid: false,
    collidable: false,
    liquid: true,
    breakable: false,
    hardness: Infinity,
    transparent: true,
    renderLayer: LAYER_LIQUID,
    cullSameNeighbour: true,
    lightLevel: 15,
    lightAttenuation: 2,
    stackSize: 0,
    soundGroup: SoundGroup.LIQUID,
  }),
  block({
    id: Block.OBSIDIAN,
    name: 'obsidian',
    displayName: 'Obsidian',
    textureAll: 'obsidian',
    preferredTool: 'pickaxe',
    minimumHarvestTier: 'diamond',
    requiresCorrectTool: true,
    hardness: 50,
    blastResistance: 1200,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.REDSTONE_ORE,
    name: 'redstone_ore',
    displayName: 'Redstone Ore',
    textureAll: 'redstone_ore',
    preferredTool: 'pickaxe',
    minimumHarvestTier: 'iron',
    requiresCorrectTool: true,
    hardness: 3,
    dropId: Block.AIR,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.REDSTONE_WIRE,
    name: 'redstone_dust',
    displayName: 'Redstone Dust',
    recipeTags: ['redstone'],
    textureAll: 'redstone_wire_0',
    stateTextures: Object.fromEntries(
      Array.from({ length: 16 }, (_, power) => [power, `redstone_wire_${power}`])
    ),
    solid: false,
    collidable: false,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.PLATE,
    needsSupport: true,
    lightAttenuation: 0,
    hardness: 0.05,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.LEVER,
    name: 'lever',
    displayName: 'Lever',
    textureAll: 'lever_off',
    stateTextures: { 0: 'lever_off', 1: 'lever_on' },
    solid: false,
    collidable: false,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.POST,
    needsSupport: true,
    lightAttenuation: 0,
    hardness: 0.5,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.REDSTONE_TORCH,
    name: 'redstone_torch',
    displayName: 'Redstone Torch',
    textureAll: 'redstone_torch',
    solid: false,
    collidable: false,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.POST,
    needsSupport: true,
    lightLevel: 7,
    lightAttenuation: 0,
    hardness: 0.05,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.REDSTONE_TORCH_OFF,
    name: 'redstone_torch_off',
    displayName: 'Redstone Torch',
    textureAll: 'redstone_torch_off',
    solid: false,
    collidable: false,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.POST,
    needsSupport: true,
    lightAttenuation: 0,
    hardness: 0.05,
    dropId: Block.REDSTONE_TORCH,
    stackSize: 0,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.REDSTONE_LAMP,
    name: 'redstone_lamp',
    displayName: 'Redstone Lamp',
    textureAll: 'redstone_lamp',
    preferredTool: 'pickaxe',
    hardness: 0.3,
    soundGroup: SoundGroup.GLASS,
  }),
  block({
    id: Block.REDSTONE_LAMP_LIT,
    name: 'redstone_lamp_lit',
    displayName: 'Redstone Lamp',
    textureAll: 'redstone_lamp_lit',
    preferredTool: 'pickaxe',
    hardness: 0.3,
    lightLevel: 15,
    dropId: Block.REDSTONE_LAMP,
    stackSize: 0,
    soundGroup: SoundGroup.GLASS,
  }),
  block({
    id: Block.REPEATER,
    name: 'repeater',
    displayName: 'Redstone Repeater',
    textureAll: 'repeater_south_off',
    stateTextures: Object.fromEntries(
      Array.from({ length: 32 }, (_, state) => {
        const facing = state & 0x03;
        const powered = (state & 0x10) !== 0;
        const direction = ['south', 'west', 'north', 'east'][facing];
        return [state, `repeater_${direction}_${powered ? 'on' : 'off'}`];
      })
    ),
    solid: false,
    collidable: false,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.PLATE,
    needsSupport: true,
    lightAttenuation: 0,
    hardness: 0.1,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.OAK_SLAB,
    name: 'oak_slab',
    displayName: 'Oak Slab',
    textureAll: 'planks',
    preferredTool: 'axe',
    recipeTags: ['wooden', 'slab'],
    transparent: true,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 1.5,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.COBBLESTONE_SLAB,
    name: 'cobblestone_slab',
    displayName: 'Cobblestone Slab',
    textureAll: 'cobblestone',
    preferredTool: 'pickaxe',
    recipeTags: ['stone_material', 'slab'],
    transparent: true,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 2,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.OAK_STAIRS,
    name: 'oak_stairs',
    displayName: 'Oak Stairs',
    textureAll: 'planks',
    preferredTool: 'axe',
    recipeTags: ['wooden', 'stairs'],
    transparent: true,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 1.5,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.COBBLESTONE_STAIRS,
    name: 'cobblestone_stairs',
    displayName: 'Cobblestone Stairs',
    textureAll: 'cobblestone',
    preferredTool: 'pickaxe',
    recipeTags: ['stone_material', 'stairs'],
    transparent: true,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 2,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.OAK_TRAPDOOR,
    name: 'oak_trapdoor',
    displayName: 'Oak Trapdoor',
    textureAll: 'planks',
    preferredTool: 'axe',
    transparent: true,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 1.5,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.LADDER,
    name: 'ladder',
    displayName: 'Ladder',
    textureAll: 'ladder',
    solid: false,
    collidable: false,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 0.4,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.OAK_FENCE,
    name: 'oak_fence',
    displayName: 'Oak Fence',
    textureAll: 'planks',
    preferredTool: 'axe',
    transparent: true,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 1.5,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.COBBLESTONE_WALL,
    name: 'cobblestone_wall',
    displayName: 'Cobblestone Wall',
    textureAll: 'cobblestone',
    preferredTool: 'pickaxe',
    transparent: true,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 2,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.OAK_FENCE_GATE,
    name: 'oak_fence_gate',
    displayName: 'Oak Fence Gate',
    textureAll: 'planks',
    preferredTool: 'axe',
    transparent: true,
    renderShape: RenderShape.BOXES,
    needsSupport: true,
    lightAttenuation: 0,
    hardness: 1.5,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.OAK_DOOR,
    name: 'oak_door',
    displayName: 'Oak Door',
    textureAll: 'planks',
    preferredTool: 'axe',
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 1.5,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.GLASS_PANE,
    name: 'glass_pane',
    displayName: 'Glass Pane',
    textureAll: 'glass',
    transparent: true,
    renderLayer: LAYER_TRANSLUCENT,
    renderShape: RenderShape.BOXES,
    cullSameNeighbour: true,
    lightAttenuation: 0,
    hardness: 0.3,
    soundGroup: SoundGroup.GLASS,
  }),
  block({
    id: Block.WHITE_BED,
    name: 'white_bed',
    displayName: 'White Bed',
    textureTop: 'white_wool',
    textureBottom: 'planks',
    textureSide: 'white_wool',
    preferredTool: 'axe',
    transparent: true,
    renderShape: RenderShape.BOXES,
    needsSupport: true,
    lightAttenuation: 0,
    hardness: 0.2,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.STONE_BUTTON,
    name: 'stone_button',
    displayName: 'Stone Button',
    textureAll: 'stone',
    solid: false,
    collidable: false,
    transparent: true,
    renderShape: RenderShape.BOXES,
    lightAttenuation: 0,
    hardness: 0.5,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.OAK_PRESSURE_PLATE,
    name: 'oak_pressure_plate',
    displayName: 'Oak Pressure Plate',
    textureAll: 'planks',
    solid: false,
    collidable: false,
    transparent: true,
    renderShape: RenderShape.BOXES,
    needsSupport: true,
    lightAttenuation: 0,
    hardness: 0.5,
    soundGroup: SoundGroup.WOOD,
  }),
  block({
    id: Block.STONE_PRESSURE_PLATE,
    name: 'stone_pressure_plate',
    displayName: 'Stone Pressure Plate',
    textureAll: 'stone',
    solid: false,
    collidable: false,
    transparent: true,
    renderShape: RenderShape.BOXES,
    needsSupport: true,
    lightAttenuation: 0,
    hardness: 0.5,
    soundGroup: SoundGroup.STONE,
  }),
  block({
    id: Block.FIRE,
    name: 'fire',
    displayName: 'Fire',
    textureAll: 'fire',
    solid: false,
    collidable: false,
    breakable: true,
    hardness: 0,
    transparent: true,
    renderLayer: LAYER_CUTOUT,
    renderShape: RenderShape.CROSS,
    cullSameNeighbour: true,
    lightLevel: 15,
    lightAttenuation: 0,
    stackSize: 0,
    dropId: Block.AIR,
    soundGroup: SoundGroup.PLANT,
  }),
]);

/**
 * Generated family definitions, in id order.
 *
 * `renderLayer` is deliberately left to the default so slabs, stairs and fences
 * behave exactly like the hand-written `oak_slab` they were modelled on.
 */
const FAMILY_DEFINITIONS = FAMILY_BLOCKS.map((entry) =>
  block({
    id: entry.id,
    name: entry.name,
    displayName: entry.displayName,
    textureAll: entry.textureAll,
    solid: entry.solid,
    collidable: entry.collidable,
    transparent: entry.transparent,
    renderShape: entry.renderShape,
    lightAttenuation: entry.lightAttenuation,
    hardness: entry.hardness,
    soundGroup: entry.soundGroup,
    preferredTool: entry.preferredTool,
    // Stone needs a pickaxe to drop anything; wood is happy to be punched out.
    requiresCorrectTool: entry.preferredTool === 'pickaxe',
    minimumHarvestTier: entry.preferredTool === 'pickaxe' ? 'wood' : 'hand',
    recipeTags: entry.recipeTags,
  })
);

const COLOUR_DEFINITIONS = COLOUR_BLOCKS.map((entry) => {
  const glass = entry.name.endsWith('_stained_glass');
  const wool = entry.name.endsWith('_wool');
  return block({
    id: entry.id,
    name: entry.name,
    textureAll: entry.name,
    hardness: glass ? 0.4 : wool ? 0.8 : 1.8,
    preferredTool: glass ? null : wool ? 'shears' : 'pickaxe',
    transparent: glass,
    renderLayer: glass ? LAYER_TRANSLUCENT : LAYER_OPAQUE,
    cullSameNeighbour: glass,
    lightAttenuation: glass ? 0 : 15,
    soundGroup: glass ? SoundGroup.GLASS : wool ? SoundGroup.PLANT : SoundGroup.STONE,
    recipeTags: ['colour_block'],
  });
});

const PHASE3_DEFINITIONS = PHASE3_BLOCKS.map((entry) => {
  const thin = entry.name === 'rail' || entry.name === 'powered_rail';
  return block({
    id: entry.id,
    name: entry.name,
    textureAll: entry.name,
    hardness: entry.name === 'obsidian' ? 5 : 2.5,
    preferredTool: 'pickaxe',
    requiresCorrectTool: true,
    minimumHarvestTier: 'wood',
    solid: !thin,
    collidable: !thin,
    transparent: thin,
    renderShape: thin ? RenderShape.PLATE : RenderShape.CUBE,
    renderLayer: thin ? LAYER_CUTOUT : LAYER_OPAQUE,
    lightAttenuation: thin ? 0 : 15,
    soundGroup: SoundGroup.STONE,
    recipeTags: ['phase3_utility'],
  });
});

/** Maps the Nether catalogue's neutral layer names onto the numeric layers. */
const NETHER_LAYER_BY_NAME = Object.freeze({
  opaque: LAYER_OPAQUE,
  cutout: LAYER_CUTOUT,
  translucent: LAYER_TRANSLUCENT,
});

/**
 * Phase 4 Nether definitions, in id order.
 *
 * `NetherBlocks.js` describes each block in a small vocabulary of plain strings
 * so that it can be loaded without this module (and therefore without the atlas
 * or the config). The translation to real constants happens here, which is the
 * only place that knows what a "cutout" layer actually is.
 */
const NETHER_DEFINITIONS = NETHER_BLOCKS.map(({ id, descriptor }) =>
  block({
    id,
    name: descriptor.name,
    displayName: descriptor.displayName,
    textureTop: descriptor.top,
    textureSide: descriptor.side,
    textureBottom: descriptor.bottom,
    renderShape: descriptor.shape,
    renderLayer: NETHER_LAYER_BY_NAME[descriptor.layer],
    hardness: descriptor.hardness,
    preferredTool: descriptor.tool,
    minimumHarvestTier: descriptor.tier,
    requiresCorrectTool: descriptor.correctTool,
    dropsWithoutCorrectTool: descriptor.dropsAlways,
    lightLevel: descriptor.light,
    lightAttenuation: descriptor.attenuation,
    solid: descriptor.solid,
    collidable: descriptor.collidable,
    breakable: descriptor.breakable,
    transparent: descriptor.transparent,
    cullSameNeighbour: descriptor.cull,
    sway: descriptor.sway,
    soundGroup: descriptor.sound,
    needsSupport: descriptor.needsSupport,
    gravityAffected: descriptor.gravity,
    recipeTags: descriptor.tags,
  })
);

/**
 * Phase 5 End definitions, in id order.
 *
 * The End reuses `NETHER_LAYER_BY_NAME` rather than declaring its own map. That
 * is deliberate: `EndBlocks.js` and `NetherBlocks.js` speak the same three-word
 * layer vocabulary, and duplicating the translation table would let the two
 * dimensions silently disagree about what "cutout" means.
 */
const END_DEFINITIONS = END_BLOCKS.map(({ id, descriptor }) =>
  block({
    id,
    name: descriptor.name,
    displayName: descriptor.displayName,
    textureTop: descriptor.top,
    textureSide: descriptor.side,
    textureBottom: descriptor.bottom,
    renderShape: descriptor.shape,
    renderLayer: NETHER_LAYER_BY_NAME[descriptor.layer],
    hardness: descriptor.hardness,
    preferredTool: descriptor.tool,
    minimumHarvestTier: descriptor.tier,
    requiresCorrectTool: descriptor.correctTool,
    dropsWithoutCorrectTool: descriptor.dropsAlways,
    lightLevel: descriptor.light,
    lightAttenuation: descriptor.attenuation,
    solid: descriptor.solid,
    collidable: descriptor.collidable,
    breakable: descriptor.breakable,
    transparent: descriptor.transparent,
    cullSameNeighbour: descriptor.cull,
    sway: descriptor.sway,
    soundGroup: descriptor.sound,
    needsSupport: descriptor.needsSupport,
    gravityAffected: descriptor.gravity,
    recipeTags: descriptor.tags,
  })
);

/** Neutral utility definitions, in id order. Same translation as the End. */
const UTILITY_DEFINITIONS = UTILITY_BLOCKS.map(({ id, descriptor }) =>
  block({
    id,
    name: descriptor.name,
    displayName: descriptor.displayName,
    textureTop: descriptor.top,
    textureSide: descriptor.side,
    textureBottom: descriptor.bottom,
    renderShape: descriptor.shape,
    renderLayer: NETHER_LAYER_BY_NAME[descriptor.layer],
    hardness: descriptor.hardness,
    preferredTool: descriptor.tool,
    minimumHarvestTier: descriptor.tier,
    requiresCorrectTool: descriptor.correctTool,
    dropsWithoutCorrectTool: descriptor.dropsAlways,
    lightLevel: descriptor.light,
    lightAttenuation: descriptor.attenuation,
    solid: descriptor.solid,
    collidable: descriptor.collidable,
    breakable: descriptor.breakable,
    transparent: descriptor.transparent,
    cullSameNeighbour: descriptor.cull,
    sway: descriptor.sway,
    soundGroup: descriptor.sound,
    needsSupport: descriptor.needsSupport,
    gravityAffected: descriptor.gravity,
    recipeTags: descriptor.tags,
  })
);

/** Version 7 append-only definitions. */
const V7_DEFINITIONS = V7_BLOCKS.map(({ id, descriptor }) =>
  block({
    id,
    name: descriptor.name,
    displayName: descriptor.displayName,
    textureTop: descriptor.top,
    textureSide: descriptor.side,
    textureBottom: descriptor.bottom,
    renderShape: descriptor.shape,
    renderLayer: NETHER_LAYER_BY_NAME[descriptor.layer],
    hardness: descriptor.hardness,
    preferredTool: descriptor.tool,
    minimumHarvestTier: descriptor.tier,
    requiresCorrectTool: descriptor.correctTool,
    dropsWithoutCorrectTool: descriptor.dropsAlways,
    lightLevel: descriptor.light,
    lightAttenuation: descriptor.attenuation,
    solid: descriptor.solid,
    collidable: descriptor.collidable,
    breakable: descriptor.breakable,
    transparent: descriptor.transparent,
    cullSameNeighbour: descriptor.cull,
    sway: descriptor.sway,
    soundGroup: descriptor.sound,
    needsSupport: descriptor.needsSupport,
    gravityAffected: descriptor.gravity,
    stackSize: descriptor.stackSize,
    recipeTags: descriptor.tags,
  })
);

/** Version 8 append-only definitions. */
const V8_DEFINITIONS = V8_BLOCKS.map(({ id, descriptor }) => block({
  id, name:descriptor.name, displayName:descriptor.displayName,
  textureTop:descriptor.top, textureSide:descriptor.side, textureBottom:descriptor.bottom,
  renderShape:descriptor.shape, renderLayer:NETHER_LAYER_BY_NAME[descriptor.layer],
  hardness:descriptor.hardness, preferredTool:descriptor.tool,
  minimumHarvestTier:descriptor.tier, requiresCorrectTool:descriptor.correctTool,
  dropsWithoutCorrectTool:descriptor.dropsAlways, lightLevel:descriptor.light,
  lightAttenuation:descriptor.attenuation, solid:descriptor.solid,
  collidable:descriptor.collidable, breakable:descriptor.breakable,
  transparent:descriptor.transparent, cullSameNeighbour:descriptor.cull,
  sway:descriptor.sway, soundGroup:descriptor.sound, needsSupport:descriptor.needsSupport,
  gravityAffected:descriptor.gravity, stackSize:descriptor.stackSize, recipeTags:descriptor.tags,
}));

export const V8_BLOCK_LIST = Object.freeze(
  V8_BLOCKS.map(({ id, descriptor }) => Object.freeze({ id, name:descriptor.name }))
);

export const V7_BLOCK_LIST = Object.freeze(
  V7_BLOCKS.map(({ id, descriptor }) => Object.freeze({ id, name: descriptor.name }))
);

/** Every utility block, exposed for the self-test. */
export const UTILITY_BLOCK_LIST = Object.freeze(
  UTILITY_BLOCKS.map(({ id, descriptor }) => Object.freeze({ id, name: descriptor.name }))
);

/** Every End block, exposed for the generator and the self-test. */
export const END_BLOCK_LIST = Object.freeze(
  END_BLOCKS.map(({ id, descriptor }) => Object.freeze({ id, name: descriptor.name }))
);

/** Every Nether block, exposed for the generator and the self-test. */
export const NETHER_BLOCK_LIST = Object.freeze(
  NETHER_BLOCKS.map(({ id, descriptor }) => Object.freeze({ id, name: descriptor.name }))
);

/**
 * Every block definition, in id order.
 * @type {ReadonlyArray<Object>}
 */
export const BLOCK_DEFINITIONS = Object.freeze([
  ...BASE_BLOCK_DEFINITIONS,
  ...FAMILY_DEFINITIONS,
  ...COLOUR_DEFINITIONS,
  ...PHASE3_DEFINITIONS,
  ...NETHER_DEFINITIONS,
  ...END_DEFINITIONS,
  ...UTILITY_DEFINITIONS,
  ...V7_DEFINITIONS,
  ...V8_DEFINITIONS,
]);

/**
 * Tags that mark a Nether block as a building material rather than a natural
 * one, used to split the catalogue across the two creative groups below.
 */
const NETHER_BUILDING_TAGS = Object.freeze(['stone_material', 'wooden', 'planks', 'logs']);

/** True when a Nether descriptor belongs in the "Nether Built" palette. */
function isNetherBuildingMaterial(descriptor) {
  return NETHER_BUILDING_TAGS.some((tag) => descriptor.tags.includes(tag));
}

/**
 * Blocks offered in the creative palette, grouped for the inventory UI.
 */
export const CREATIVE_GROUPS = Object.freeze([
  {
    label: 'Natural',
    blocks: Object.freeze([
      Block.GRASS,
      Block.DIRT,
      Block.STONE,
      Block.COBBLESTONE,
      Block.MOSSY_COBBLESTONE,
      Block.SAND,
      Block.RED_SAND,
      Block.SANDSTONE,
      Block.GRAVEL,
      Block.CLAY,
      Block.SNOW_BLOCK,
      Block.SNOWY_GRASS,
      Block.ICE,
      Block.BEDROCK,
    ]),
  },
  {
    label: 'Wood',
    blocks: Object.freeze([
      Block.OAK_LOG,
      Block.OAK_LEAVES,
      Block.SPRUCE_LOG,
      Block.SPRUCE_LEAVES,
      Block.BIRCH_LOG,
      Block.BIRCH_LEAVES,
      Block.PLANKS,
      Block.OAK_SLAB,
      Block.OAK_STAIRS,
      Block.OAK_FENCE,
      Block.OAK_FENCE_GATE,
      Block.OAK_DOOR,
      Block.OAK_TRAPDOOR,
      Block.OAK_PRESSURE_PLATE,
      Block.LADDER,
      Block.WHITE_BED,
    ]),
  },
  {
    label: 'Ores',
    blocks: Object.freeze([
      Block.COAL_ORE,
      Block.IRON_ORE,
      Block.GOLD_ORE,
      Block.DIAMOND_ORE,
      Block.REDSTONE_ORE,
      Block.GLOWSTONE,
    ]),
  },
  {
    label: 'Built',
    blocks: Object.freeze([
      Block.BRICKS,
      Block.OBSIDIAN,
      Block.GLASS,
      Block.GLASS_PANE,
      Block.COBBLESTONE_SLAB,
      Block.COBBLESTONE_STAIRS,
      Block.COBBLESTONE_WALL,
      Block.STONE_BUTTON,
      Block.STONE_PRESSURE_PLATE,
      Block.TORCH,
    ]),
  },
  {
    label: 'Redstone',
    blocks: Object.freeze([
      Block.REDSTONE_WIRE,
      Block.LEVER,
      Block.REDSTONE_TORCH,
      Block.REDSTONE_LAMP,
      Block.REPEATER,
    ]),
  },
  {
    label: 'Workstations',
    blocks: Object.freeze([Block.CRAFTING_TABLE, Block.FURNACE, Block.CHEST]),
  },
  {
    label: 'Plants',
    blocks: Object.freeze([
      Block.TALL_GRASS,
      Block.FERN,
      Block.FLOWER_RED,
      Block.FLOWER_YELLOW,
      Block.DEAD_BUSH,
      Block.CACTUS,
    ]),
  },
  // Generated rather than listed: a new family should appear in the palette
  // automatically, or the blocks exist but no player can ever reach them.
  {
    label: 'Wood Families',
    blocks: Object.freeze(
      FAMILY_BLOCKS.filter((entry) => entry.preferredTool === 'axe').map((entry) => entry.id)
    ),
  },
  {
    label: 'Stone Families',
    blocks: Object.freeze(
      FAMILY_BLOCKS.filter((entry) => entry.preferredTool === 'pickaxe').map((entry) => entry.id)
    ),
  },
  {
    label: 'Colours',
    blocks: Object.freeze(COLOUR_BLOCKS.map((entry) => entry.id)),
  },
  {
    label: 'Phase 3 Utilities',
    blocks: Object.freeze(PHASE3_BLOCKS.map((entry) => entry.id)),
  },
  // Phase 4: partitioned from the catalogue's own tags rather than listed by
  // hand, so a Nether block added to `NetherBlocks.js` cannot be unreachable in
  // creative — it lands in exactly one of these two groups automatically.
  {
    label: 'Nether',
    blocks: Object.freeze(
      NETHER_BLOCKS.filter(({ descriptor }) => !isNetherBuildingMaterial(descriptor))
        .map((entry) => entry.id)
    ),
  },
  {
    label: 'Nether Built',
    blocks: Object.freeze(
      NETHER_BLOCKS.filter(({ descriptor }) => isNetherBuildingMaterial(descriptor))
        .map((entry) => entry.id)
    ),
  },
  {
    label: 'The End',
    blocks: Object.freeze([
      ...END_BLOCKS.map((entry) => entry.id),
      ...V7_BLOCKS.map((entry) => entry.id),
      ...V8_BLOCKS.map((entry) => entry.id),
    ]),
  },
]);

/**
 * Blocks offered on a creative player's starting hotbar.
 *
 * Survival players start with nothing — see `SURVIVAL_STARTING_ITEMS` in
 * `items/ItemTypes.js` — because the first tree is the beginning of the
 * progression chain. This list is therefore only consulted for creative worlds.
 */
export const DEFAULT_HOTBAR = Object.freeze([
  Block.GRASS,
  Block.DIRT,
  Block.STONE,
  Block.COBBLESTONE,
  Block.PLANKS,
  Block.OAK_LOG,
  Block.GLASS,
  Block.SAND,
  Block.TORCH,
]);
