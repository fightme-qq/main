/**
 * The contract between the generated sound library and the game.
 *
 * ## Why a mapping table instead of renaming everything
 *
 * Gameplay already speaks in material keys — `step.grass`, `break.wood` — because
 * those are what the block registry and `SoundEvents` produce. The library, on the
 * other hand, was generated with descriptive ids (`player_footstep_grass_02`).
 * Renaming either side would touch dozens of call sites for no behavioural gain,
 * so this module is the single translation point:
 *
 * ```
 * gameplay key  ->  one or more library ids  ->  an AudioBuffer each
 * ```
 *
 * Several ids per key are *variants*: footsteps and hits pick one at random, which
 * is the difference between walking and a metronome.
 *
 * ## Categories
 *
 * The mixer has one gain per category, and the design asks for Player, Creatures
 * and Horror on their own sliders. Library categories are singular (`creature`),
 * mixer categories follow the settings schema (`creatures`); the table below is
 * the mapping, so a typo becomes a failed self-test rather than a silent sound.
 *
 * ## Validation
 *
 * `normaliseManifest` is deliberately strict: a malformed manifest disables the
 * file library as a whole and the synthesized fallback keeps working. Partial
 * trust would produce half-silent gameplay that is hard to diagnose.
 */

/** Mixer category for each library category. */
export const FILE_MIXER_CATEGORY = Object.freeze({
  environment: 'ambient',
  player: 'player',
  world: 'blocks',
  creature: 'creatures',
  horror: 'horror',
  ui: 'ui',
  music: 'music',
});

/** Library categories the generator may emit. */
export const FILE_CATEGORIES = Object.freeze(Object.keys(FILE_MIXER_CATEGORY));

/**
 * The five take ids of one footstep surface.
 * @param {string} surface
 * @returns {string[]}
 */
function footstepIds(surface) {
  return [1, 2, 3, 4, 5].map((index) => `player_footstep_${surface}_0${index}`);
}

/**
 * One-shot keys: gameplay name to library variants.
 *
 * `pitchVariance` is per key: variant selection already breaks repetition, so the
 * extra random detune only needs to be large enough to hide the remaining
 * sameness.
 *
 * @type {Readonly<Record<string, {ids: ReadonlyArray<string>, pitchVariance?: number}>>}
 */
export const FILE_SOUND_MAP = Object.freeze({
  // Footsteps: six surfaces, five variants each. Five is deliberate: at a sprint
  // stride of 0.34 s three takes cycle audibly. `sand` borrows the two gravelly
  // dirt takes, which are a different file from the damp-dirt step.
  'step.grass': { ids: footstepIds('grass'), pitchVariance: 0.05 },
  'step.dirt': { ids: footstepIds('dirt'), pitchVariance: 0.05 },
  'step.stone': { ids: footstepIds('stone'), pitchVariance: 0.05 },
  'step.wood': { ids: footstepIds('wood'), pitchVariance: 0.05 },
  'step.snow': { ids: footstepIds('snow'), pitchVariance: 0.05 },
  'step.liquid': { ids: footstepIds('water'), pitchVariance: 0.05 },
  'step.sand': { ids: ['player_footstep_dirt_04', 'player_footstep_dirt_05'], pitchVariance: 0.06 },

  // Mining and building. Break variants are material-specific, not random: stone
  // and wood genuinely sound different, and that difference is information.
  'break.stone': { ids: ['world_block_break_01'], pitchVariance: 0.07 },
  'break.wood': { ids: ['world_block_break_02'], pitchVariance: 0.07 },
  'break.dirt': { ids: ['world_block_break_03'], pitchVariance: 0.07 },
  'break.grass': { ids: ['world_block_break_03'], pitchVariance: 0.07 },
  'break.sand': { ids: ['world_block_break_03'], pitchVariance: 0.07 },
  'break.snow': { ids: ['world_block_break_03'], pitchVariance: 0.07 },
  'break.glass': { ids: ['world_block_break_glass_01'], pitchVariance: 0.05 },
  'break.metal': { ids: ['world_block_break_metal_01'], pitchVariance: 0.05 },
  'break.plant': { ids: ['world_block_break_plant_01'], pitchVariance: 0.07 },
  'place.stone': { ids: ['world_block_place_01'], pitchVariance: 0.05 },
  'place.wood': { ids: ['world_block_place_02'], pitchVariance: 0.05 },
  'place.dirt': { ids: ['world_block_place_01'], pitchVariance: 0.05 },
  'place.grass': { ids: ['world_block_place_01'], pitchVariance: 0.05 },
  'place.sand': { ids: ['world_block_place_01'], pitchVariance: 0.05 },
  'place.snow': { ids: ['world_block_place_01'], pitchVariance: 0.05 },

  // Player.
  'player.hurt': { ids: ['player_hurt_01', 'player_hurt_02'], pitchVariance: 0.04 },
  'player.death': { ids: ['player_death_01'], pitchVariance: 0.02 },
  'player.jump': { ids: ['player_jump_01'], pitchVariance: 0.05 },
  'player.land': { ids: ['player_land_01', 'player_land_02'], pitchVariance: 0.05 },
  'player.swim': { ids: ['player_swim_01', 'player_swim_02'], pitchVariance: 0.05 },
  'player.eat': { ids: ['player_eat_01'], pitchVariance: 0.04 },
  'player.levelup': { ids: ['player_levelup_01'], pitchVariance: 0.02 },
  'pickup': { ids: ['player_item_pickup_01'], pitchVariance: 0.06 },
  'player.splash': { ids: ['world_water_splash_01'], pitchVariance: 0.05 },

  // Combat.
  'attack.sharp': { ids: ['combat_swing_01'], pitchVariance: 0.06 },
  'attack.blunt': { ids: ['combat_swing_02'], pitchVariance: 0.06 },
  'combat.hitFlesh': { ids: ['combat_hit_flesh_01', 'combat_hit_flesh_02'], pitchVariance: 0.05 },
  'item.shield_block': { ids: ['shield_block_01'], pitchVariance: 0.04 },
  'item.shield_break': { ids: ['shield_break_01'], pitchVariance: 0.03 },
  'item.bow_shoot': { ids: ['bow_shoot_01'], pitchVariance: 0.04 },
  'projectile.hit': { ids: ['arrow_hit_flesh_01'], pitchVariance: 0.05 },
  'projectile.hit_block': { ids: ['arrow_hit_block_01'], pitchVariance: 0.05 },
  'tool.break': { ids: ['tool_break_01'], pitchVariance: 0.03 },

  // Generic creatures: farm animals and pets. The horror roster above keeps its own
  // dedicated vocalisations.
  'mob.hurt': { ids: ['mob_hurt_01'], pitchVariance: 0.08 },
  'mob.attack': { ids: ['mob_attack_01'], pitchVariance: 0.08 },
  'mob.death': { ids: ['mob_death_01'], pitchVariance: 0.05 },

  // Containers and fire.
  'chest.open': { ids: ['world_container_open_01'], pitchVariance: 0.03 },
  'chest.close': { ids: ['world_container_close_01'], pitchVariance: 0.03 },
  'item.ignite': { ids: ['world_fire_ignite_01'], pitchVariance: 0.03 },
  'world.fire.extinguish': { ids: ['world_fire_extinguish_01'], pitchVariance: 0.02 },
  'world.craft': { ids: ['world_craft_01'], pitchVariance: 0.02 },
  'world.switch': { ids: ['world_switch_01'], pitchVariance: 0.02 },

  // Interface. `craft.complete` is its own key so crafting does not borrow the
  // item-selection tick; the fallback below keeps the old sound if the library is
  // unavailable.
  'ui.select': { ids: ['ui_item_select_01'], pitchVariance: 0.02 },
  'ui.click': { ids: ['ui_item_select_01'], pitchVariance: 0.03 },
  'ui.back': { ids: ['ui_inventory_close_01'], pitchVariance: 0.02 },
  'ui.inventory.open': { ids: ['ui_inventory_open_01'], pitchVariance: 0.02 },
  'ui.inventory.close': { ids: ['ui_inventory_close_01'], pitchVariance: 0.02 },
  'ui.craft.complete': { ids: ['ui_craft_success_01'], pitchVariance: 0.02 },
  'craft.complete': { ids: ['ui_craft_success_01'], pitchVariance: 0.02 },
  'ui.error': { ids: ['ui_item_error_01'], pitchVariance: 0.02 },
  'ui.death': { ids: ['ui_player_death_01'], pitchVariance: 0.02 },
});

/**
 * Looping keys: gameplay name to library variants.
 *
 * A loop is one file per key in practice; the array exists so an alternative take
 * can be added without touching the mixer.
 *
 * @type {Readonly<Record<string, {ids: ReadonlyArray<string>, pitchVariance?: number}>>}
 */
export const FILE_LOOP_MAP = Object.freeze({
  'ambient.forest.day': { ids: ['amb_forest_day_01'] },
  'ambient.forest.night': { ids: ['amb_forest_night_01', 'amb_forest_night_02'] },
  'ambient.wind.light': { ids: ['amb_wind_light_01'] },
  'ambient.wind.strong': { ids: ['amb_wind_strong_01'] },
  'ambient.wind.trees': { ids: ['amb_wind_trees_01'] },
  'ambient.fog': { ids: ['amb_fog_low_01'] },
  'ambient.abandoned': { ids: ['amb_abandoned_place_01'] },
  'ambient.cave.drone': { ids: ['amb_cave_drone_01'] },
  'ambient.cave.drips': { ids: ['amb_cave_drips_01'] },
  'ambient.cave.wind': { ids: ['amb_cave_wind_01'] },
  'weather.rain.light': { ids: ['amb_rain_light_01'] },
  'weather.rain.heavy': { ids: ['amb_rain_heavy_01'] },
  'world.fire.crackle': { ids: ['world_fire_crackle_01'] },

  // Heartbeats are loops in the catalogue, not one-shots: the director raises and
  // lowers them with health and night depth, which only works for a ringing loop.
  'player.heartbeat.fast': { ids: ['player_heartbeat_fast_01'] },
  'player.heartbeat.calm': { ids: ['player_heartbeat_low_01'] },

  // Music layers. One track per phase, crossfaded by the mixer; the two night
  // tracks alternate so a long night does not loop the same thirty seconds.
  'music.day': { ids: ['music_day_01'] },
  'music.dusk': { ids: ['music_dusk_01'] },
  'music.night': { ids: ['music_night_01', 'music_night_02'] },
  'music.cave': { ids: ['music_cave_01'] },
  'music.menu': { ids: ['music_menu_01'] },
});

/**
 * Fallback names used when a library key has no files at all.
 *
 * Without this, shipping a build before the library is generated would silently
 * lose crafting and death sounds that used to exist.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const FALLBACK_ALIASES = Object.freeze({
  'player.death': 'player.hurt',
  'chest.close': 'chest.open',
  'craft.complete': 'ui.select',
  'ui.inventory.open': 'ui.select',
  'ui.inventory.close': 'ui.back',
  'ui.error': 'ui.back',
  'player.heartbeat.fast': 'player.heartbeat.calm',
});

/**
 * Library ids that are played directly, without a gameplay key.
 *
 * Creature and horror calls belong here until the AI stage gives them events; this
 * keeps the files usable for the first behavioural pass instead of shipping them
 * dead.
 *
 * @type {ReadonlyArray<string>}
 */
export const DIRECT_SOUND_IDS = Object.freeze([
  'creature_walker_idle_01', 'creature_walker_move_01', 'creature_walker_growl_01',
  'creature_walker_detect_01', 'creature_walker_attack_01', 'creature_walker_hurt_01',
  'creature_walker_death_01',
  'creature_hunter_breath_01', 'creature_hunter_move_01', 'creature_hunter_detect_01',
  'creature_hunter_chase_01', 'creature_hunter_attack_01', 'creature_hunter_hurt_01',
  'creature_hunter_death_01',
  'creature_stalker_whisper_01', 'creature_stalker_distant_01', 'creature_stalker_appear_01',
  'creature_stalker_disappear_01', 'creature_stalker_move_01', 'creature_stalker_nearby_01',
  'horror_sting_subtle_01', 'horror_sting_distant_01', 'horror_sting_reveal_01',
  'horror_impact_01', 'horror_whisper_distant_01', 'horror_branch_snap_01',
  'horror_footsteps_distant_01', 'horror_footsteps_behind_01', 'horror_knock_01',
  'horror_scrape_01', 'horror_roar_distant_01', 'horror_roar_close_01', 'horror_static_01',
  'amb_thunder_distant_01', 'amb_thunder_close_01',
  // Recorded but not yet wired to a gameplay event: mining-hit ticks, door leaf
  // and sprint breathing arrive with the survival/noise pass. Until then they stay
  // playable by id instead of being dead weight in the build.
  'world_wood_hit_01', 'world_wood_hit_02', 'world_stone_hit_01', 'world_stone_hit_02',
  'world_door_open_01', 'world_door_close_01', 'world_creaking_01',
  'player_sprint_breath_01', 'player_drink_01', 'player_item_use_01',
]);

const ID_PATTERN = /^[a-z0-9_]+$/;
const FILE_PATTERN = /^[a-z0-9_]+\/[a-z0-9_]+\.mp3$/;

/**
 * Validates and normalises a manifest read from disk.
 *
 * @param {unknown} raw Parsed JSON.
 * @returns {{ok: boolean, errors: string[], entries: Record<string, Object>, format: string}}
 */
export function normaliseManifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['manifest is not an object'], entries: {}, format: 'mp3' };
  }
  if (raw.version !== 1) errors.push(`unsupported manifest version ${raw.version}`);
  const format = typeof raw.format === 'string' ? raw.format : 'mp3';
  if (format !== 'mp3') errors.push(`unsupported audio format "${format}"`);
  const source = raw.entries;
  if (!source || typeof source !== 'object') {
    errors.push('manifest has no entries object');
    return { ok: false, errors, entries: {}, format };
  }

  const entries = {};
  for (const [id, value] of Object.entries(source)) {
    if (!ID_PATTERN.test(id)) {
      errors.push(`bad id "${id}"`);
      continue;
    }
    if (!value || typeof value !== 'object') {
      errors.push(`entry "${id}" is not an object`);
      continue;
    }
    if (typeof value.file !== 'string' || !FILE_PATTERN.test(value.file)) {
      errors.push(`entry "${id}" has an unusable file path`);
      continue;
    }
    if (!FILE_CATEGORIES.includes(value.category)) {
      errors.push(`entry "${id}" has unknown category "${value.category}"`);
      continue;
    }
    if (typeof value.loop !== 'boolean') {
      errors.push(`entry "${id}" has no loop flag`);
      continue;
    }
    const seconds = Number(value.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      errors.push(`entry "${id}" has no duration`);
      continue;
    }
    const gain = Number(value.gain);
    entries[id] = {
      id,
      file: value.file,
      category: value.category,
      loop: value.loop,
      seconds,
      gain: Number.isFinite(gain) ? Math.min(4, Math.max(0.2, gain)) : 1,
      mixerCategory: FILE_MIXER_CATEGORY[value.category],
    };
  }

  if (Object.keys(entries).length === 0 && errors.length === 0) {
    errors.push('manifest has no usable entries');
  }
  return { ok: errors.length === 0, errors, entries, format };
}

/**
 * Every id referenced by the mapping tables, for self-test coverage checks.
 * @returns {string[]}
 */
export function referencedLibraryIds() {
  const ids = new Set(DIRECT_SOUND_IDS);
  for (const mapping of [...Object.values(FILE_SOUND_MAP), ...Object.values(FILE_LOOP_MAP)]) {
    for (const id of mapping.ids) ids.add(id);
  }
  return [...ids];
}

/** Relative URL of a manifest entry, resolved against the game base. */
export function soundFileUrl(entry, baseUrl = '') {
  return `${baseUrl}assets/audio/${entry.file}`;
}

export default FILE_SOUND_MAP;
