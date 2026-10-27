/**
 * Sound catalogue: every effect the horror pass ships.
 *
 * This is the single source of truth for three consumers:
 *
 *  - `scripts/audio/generate.mjs` turns each entry into one ElevenLabs request;
 *  - `public/assets/audio/manifest.json` is generated from it and read by the game;
 *  - `scripts/horror-selftest.mjs` asserts the ids stay stable and well formed.
 *
 * ## Why subjects instead of full prompts
 *
 * Every entry needs the same negative constraints (no music, no speech, no silence
 * padding). Repeating them 101 times invites drift — one entry eventually forgets
 * "no music" and ships a tiny soundtrack. The suffix is appended by the generator,
 * so the constraints are identical everywhere and can be tightened in one place.
 *
 * ## Duration
 *
 * `seconds` is a hint sent to the API, not a guarantee: the service returns what it
 * renders. `scripts/audio/qc.mjs` measures the real duration afterwards and the
 * manifest records it, so the game never trusts the request over the file.
 *
 * Prompts are English because the sound model follows English descriptions best;
 * the comments stay Russian, like the rest of the project docs.
 */

/** Shared negative constraints per category, appended to every subject. */
export const PROMPT_SUFFIXES = Object.freeze({
  environment:
    'realistic environmental sound design, no music, no voices, no intelligible speech, ' +
    'restrained volume, no long silence at the start or end, suitable as a background ' +
    'loop in a first-person survival horror game',
  player:
    'first-person perspective, close and dry, clean isolated sound effect, no music, ' +
    'no speech, no long reverb tail, no silence padding, survival horror game audio',
  world:
    'close perspective, clean isolated sound effect, no music, no speech, no silence ' +
    'padding, tactile and physical, survival horror game audio',
  creature:
    'original creature sound design, not based on any existing character, no music, no ' +
    'intelligible speech, clean ending, unsettling but not painfully loud, first-person ' +
    'survival horror game audio',
  horror:
    'restrained horror sound design, no music, no intelligible speech, no jump-scare ' +
    'clipping, clean ending, first-person survival horror game audio',
  ui:
    'short dry interface sound, no music, no speech, subtle, does not break atmosphere, ' +
    'clean ending',
  // Music is generated through a different endpoint, and it is *supposed* to be
  // music — the negative constraint used above would be exactly wrong here.
  music:
    'instrumental only, no vocals, no intelligible speech, cinematic and atmospheric, ' +
    'restrained dynamics, slow evolving texture, seamless loop, no abrupt ending',
});

/** Loop flag defaults per category. Short one-shots never loop. */
export const CATEGORY_DEFAULTS = Object.freeze({
  // The Sound Effects API caps one generation at 30 seconds, so ambience loops are
  // 30s rather than the 40-60s the design would otherwise prefer.
  environment: Object.freeze({ loop: true, seconds: 30 }),
  player: Object.freeze({ loop: false, seconds: 2 }),
  world: Object.freeze({ loop: false, seconds: 2 }),
  creature: Object.freeze({ loop: false, seconds: 3 }),
  horror: Object.freeze({ loop: false, seconds: 3 }),
  ui: Object.freeze({ loop: false, seconds: 1 }),
  music: Object.freeze({ loop: true, seconds: 30 }),
});

/**
 * @typedef {Object} SoundEntry
 * @property {string} id Manifest id, also the file name.
 * @property {string} category One of `PROMPT_SUFFIXES` keys.
 * @property {number} seconds Requested duration; the manifest records the real one.
 * @property {boolean} loop Whether the game should loop it.
 * @property {string} subject English description sent to the model.
 */

/**
 * Footstep variants, five per surface.
 *
 * The first batch sounded like a loop because each file was a second long and the
 * model sometimes rendered two steps in it; the prompt now says "one impact only,
 * no second step" and the duration is short. Five variants rather than three is the
 * difference between a walk and a machine gun once the stride is 0.34 s.
 *
 * @type {ReadonlyArray<SoundEntry>}
 */
const FOOTSTEPS = Object.freeze([
  ['grass', 'damp grass over soil', 'dry grass', 'thick mossy grass', 'short trampled grass', 'grass over loose earth'],
  ['dirt', 'packed dirt', 'dry dusty ground', 'wet mud', 'gravelly dirt', 'bare earth with small stones'],
  ['stone', 'rough stone', 'gravel over stone', 'smooth wet rock', 'cracked stone slabs', 'loose rubble'],
  ['wood', 'old wooden planks', 'loose wooden boards', 'solid timber floor', 'a wooden stair', 'a creaking wooden deck'],
  ['water', 'shallow water', 'a thin puddle', 'deeper water', 'wet mud at the waters edge', 'ankle deep water'],
  ['snow', 'fresh snow', 'packed snow', 'icy snow crust', 'deep powder snow', 'slushy snow'],
].flatMap(([surface, ...variants]) =>
  variants.map((variant, index) => ({
    id: `player_footstep_${surface}_0${index + 1}`,
    category: 'player',
    seconds: 0.8,
    loop: false,
    subject:
      `single boot step on ${variant}, exactly one impact with no second step, no echo and no trailing footstep, ` +
      'close and dry, short dead tail, natural body weight',
  }))
));

/** @type {ReadonlyArray<SoundEntry>} */
export const SOUNDS = Object.freeze([
  // ------------------------------------------------------------- environment
  { id: 'amb_forest_day_01', category: 'environment', seconds: 30, loop: true,
    subject: 'calm daytime forest ambience, soft wind through leaves, occasional distant birdsong, faint creaking branches, peaceful but slightly uneasy, clearly audible ambience level rather than near silence' },
  { id: 'amb_forest_night_01', category: 'environment', seconds: 30, loop: true,
    subject: 'dark forest at midnight, cold wind moving through dense trees, distant leaves rustling, occasional faint natural creaks, deep quiet atmosphere' },
  { id: 'amb_forest_night_02', category: 'environment', seconds: 30, loop: true,
    subject: 'night forest with almost no birds, low air pressure, sparse insect ticks, a hollow distant trunk knock, oppressive stillness' },
  { id: 'amb_wind_light_01', category: 'environment', seconds: 30, loop: true,
    subject: 'light breeze over open grass, soft air movement, subtle gusts, no leaves, calm' },
  { id: 'amb_wind_strong_01', category: 'environment', seconds: 30, loop: true,
    subject: 'strong wind gust sweeping across an exposed hillside, pressure changes, low whistle, dry grass hiss' },
  { id: 'amb_wind_trees_01', category: 'environment', seconds: 30, loop: true,
    subject: 'wind moving high inside tree canopies, layered leaf rustle and branch sway, dense forest' },
  { id: 'amb_fog_low_01', category: 'environment', seconds: 30, loop: true,
    subject: 'barely audible low atmospheric drone under fog, sub-bass air pressure, no melody, no rhythm' },
  { id: 'amb_rain_light_01', category: 'environment', seconds: 30, loop: true,
    subject: 'light rain on leaves and soft ground, steady gentle patter, no thunder' },
  { id: 'amb_rain_heavy_01', category: 'environment', seconds: 30, loop: true,
    subject: 'heavy rain on forest canopy and wet ground, dense patter, water running off leaves, no thunder' },
  { id: 'amb_thunder_distant_01', category: 'environment', seconds: 8, loop: false,
    subject: 'distant thunder rolling far beyond the trees, muffled low rumble, no rain in the foreground' },
  { id: 'amb_thunder_close_01', category: 'environment', seconds: 5, loop: false,
    subject: 'close thunder crack followed by a long low rumble, heavy but not deafening, no rain' },
  { id: 'amb_cave_drone_01', category: 'environment', seconds: 30, loop: true,
    subject: 'deep cave drone, airy sub-bass resonance, faint pressure waves in a large stone chamber' },
  { id: 'amb_cave_drips_01', category: 'environment', seconds: 30, loop: true,
    subject: 'water dripping in a quiet cave, irregular drops into shallow pools, long stone reflections' },
  { id: 'amb_cave_wind_01', category: 'environment', seconds: 30, loop: true,
    subject: 'wind moving through narrow underground passages, hollow filtered draught, occasional stone whisper' },
  { id: 'amb_abandoned_place_01', category: 'environment', seconds: 30, loop: true,
    subject: 'abandoned wooden structure at night, settling timber, faint draught through gaps, distant empty space' },

  // ------------------------------------------------------------------ player
  ...FOOTSTEPS,
  { id: 'player_sprint_breath_01', category: 'player', seconds: 4, loop: false,
    subject: 'heavy human breathing after a sprint, close perspective, exhausted, no voice' },
  { id: 'player_heartbeat_low_01', category: 'player', seconds: 4, loop: true,
    subject: 'slow calm heartbeat, low and close, steady rhythm, quiet' },
  { id: 'player_heartbeat_fast_01', category: 'player', seconds: 4, loop: true,
    subject: 'fast frightened heartbeat, close perspective, pulsing and tense' },
  { id: 'player_hurt_01', category: 'player', seconds: 1, loop: false,
    subject: 'short human grunt of pain from an impact, breathy, restrained, no words' },
  { id: 'player_hurt_02', category: 'player', seconds: 1, loop: false,
    subject: 'short sharp inhale of pain, quiet, suppressed, no words' },
  { id: 'player_death_01', category: 'player', seconds: 2, loop: false,
    subject: 'final breath and body falling to the ground, heavy and final, no words, no music' },
  { id: 'player_item_use_01', category: 'player', seconds: 1, loop: false,
    subject: 'small object being handled and used in hand, cloth and light material movement' },
  { id: 'player_item_pickup_01', category: 'player', seconds: 1, loop: false,
    subject: 'picking a small item up from the ground, short fabric and debris rustle' },
  { id: 'player_jump_01', category: 'player', seconds: 1, loop: false,
    subject: 'a person pushing off the ground to jump, cloth rustle and a short effort breath, no voice, no landing' },
  { id: 'player_land_01', category: 'player', seconds: 1, loop: false,
    subject: 'boots landing from a short fall, weight compression and a small ground impact, one landing only' },
  { id: 'player_land_02', category: 'player', seconds: 1, loop: false,
    subject: 'heavy landing on dirt, body weight absorbing the impact, short and physical' },
  { id: 'player_swim_01', category: 'player', seconds: 1, loop: false,
    subject: 'hands and feet pulling through water while swimming, close perspective, water displacement without a big splash' },
  { id: 'player_swim_02', category: 'player', seconds: 1, loop: false,
    subject: 'slow stroke through still water, muffled underwater movement and small bubbles' },
  { id: 'player_eat_01', category: 'player', seconds: 2, loop: false,
    subject: 'eating a piece of bread, dry chewing close to the ear, no voice' },
  { id: 'player_drink_01', category: 'player', seconds: 2, loop: false,
    subject: 'drinking water from a flask, two gulps and liquid settling, no voice' },
  { id: 'player_levelup_01', category: 'player', seconds: 2, loop: false,
    subject: 'soft rising shimmer accent for gaining a level, warm but restrained, no melody hook' },
  { id: 'combat_swing_01', category: 'player', seconds: 1, loop: false,
    subject: 'a blade cutting air in a fast swing, close whoosh with a short tail' },
  { id: 'combat_swing_02', category: 'player', seconds: 1, loop: false,
    subject: 'a heavy blunt weapon swung through air, low whoosh, close' },
  { id: 'combat_hit_flesh_01', category: 'player', seconds: 1, loop: false,
    subject: 'a blunt weapon striking a body, dull heavy impact with a wet edge' },
  { id: 'combat_hit_flesh_02', category: 'player', seconds: 1, loop: false,
    subject: 'a blade cutting into flesh, short sharp impact, restrained gore, no voice' },
  { id: 'shield_block_01', category: 'player', seconds: 1, loop: false,
    subject: 'a wooden shield taking a hit, hard knock and wood stress, no break' },
  { id: 'shield_break_01', category: 'player', seconds: 1, loop: false,
    subject: 'a shield breaking apart under impact, splintering wood and a falling piece' },
  { id: 'bow_shoot_01', category: 'player', seconds: 1, loop: false,
    subject: 'a bowstring released, taut snap and arrow leaving through air, clearly audible present level' },
  { id: 'arrow_hit_block_01', category: 'player', seconds: 1, loop: false,
    subject: 'an arrow striking wood, sharp thud with shaft vibration' },
  { id: 'arrow_hit_flesh_01', category: 'player', seconds: 1, loop: false,
    subject: 'an arrow striking a body, dull impact with a short wet tail, restrained' },
  { id: 'tool_break_01', category: 'player', seconds: 1, loop: false,
    subject: 'a hand tool breaking, metal snap and wooden handle cracking' },

  // ------------------------------------------------------------------- world
  { id: 'world_block_break_01', category: 'world', seconds: 1, loop: false,
    subject: 'stone block breaking apart, short crack and rubble, chunky and physical' },
  { id: 'world_block_break_02', category: 'world', seconds: 1, loop: false,
    subject: 'wooden block breaking, splintering crack with short debris scatter' },
  { id: 'world_block_break_03', category: 'world', seconds: 1, loop: false,
    subject: 'dirt block crumbling and collapsing, soft heavy crumble' },
  { id: 'world_block_break_glass_01', category: 'world', seconds: 1, loop: false,
    subject: 'glass block shattering, short bright shards and tinkle, close perspective' },
  { id: 'world_block_break_metal_01', category: 'world', seconds: 1, loop: false,
    subject: 'metal block breaking apart, hard clang with a metallic ring and debris' },
  { id: 'world_block_break_plant_01', category: 'world', seconds: 1, loop: false,
    subject: 'plant stems and leaves being torn, soft fibrous snapping, quiet' },
  { id: 'world_block_place_01', category: 'world', seconds: 1, loop: false,
    subject: 'solid block set down and settling into place, firm thud' },
  { id: 'world_block_place_02', category: 'world', seconds: 1, loop: false,
    subject: 'wooden block placed and knocked into position, hollow tap and creak' },
  { id: 'world_wood_hit_01', category: 'world', seconds: 1, loop: false,
    subject: 'axe chopping into wood, dry crack with fibre resistance' },
  { id: 'world_wood_hit_02', category: 'world', seconds: 1, loop: false,
    subject: 'dull repeated hit on a tree trunk, heavy impact and short creak, clearly audible impact level' },
  { id: 'world_stone_hit_01', category: 'world', seconds: 1, loop: false,
    subject: 'pickaxe striking stone, sharp metallic impact with grit' },
  { id: 'world_stone_hit_02', category: 'world', seconds: 1, loop: false,
    subject: 'pickaxe chipping rough rock, short chip and scatter' },
  { id: 'world_door_open_01', category: 'world', seconds: 2, loop: false,
    subject: 'old wooden door opening slowly, dry hinge creak, latch release' },
  { id: 'world_door_close_01', category: 'world', seconds: 2, loop: false,
    subject: 'old wooden door closing and latching, heavy wooden thud' },
  { id: 'world_creaking_01', category: 'world', seconds: 3, loop: false,
    subject: 'old wood creaking under weight, slow stress sound, no impact' },
  { id: 'world_container_open_01', category: 'world', seconds: 1, loop: false,
    subject: 'wooden chest lid opening, hinge creak and latch click' },
  { id: 'world_container_close_01', category: 'world', seconds: 1, loop: false,
    subject: 'wooden chest lid closing, solid hollow thud and latch' },
  { id: 'world_fire_ignite_01', category: 'world', seconds: 2, loop: false,
    subject: 'fire catching on dry tinder, flint spark, quick whoosh into flame' },
  { id: 'world_fire_crackle_01', category: 'world', seconds: 12, loop: true,
    subject: 'small campfire crackling at night, soft irregular wood pops, gentle flame texture, intimate close perspective' },
  { id: 'world_fire_extinguish_01', category: 'world', seconds: 2, loop: false,
    subject: 'fire being smothered, hiss and dying embers, ending in silence' },
  { id: 'world_craft_01', category: 'world', seconds: 2, loop: false,
    subject: 'crafting by hand, wooden tool work, light scraping and assembly clicks' },
  { id: 'world_switch_01', category: 'world', seconds: 1, loop: false,
    subject: 'mechanical lever switching with a solid click and spring return' },
  { id: 'world_water_splash_01', category: 'world', seconds: 1, loop: false,
    subject: 'object or foot entering shallow water, quick splash and drips' },

  // ---------------------------------------------------------------- creature
  { id: 'creature_walker_idle_01', category: 'creature', seconds: 4, loop: false,
    subject: 'almost inaudible presence of a breathing creature standing still nearby, wet shallow breaths, no movement' },
  { id: 'creature_walker_move_01', category: 'creature', seconds: 4, loop: false,
    subject: 'slow irregular dragging footsteps of a heavy humanoid creature on damp soil and dead leaves at night' },
  { id: 'creature_walker_growl_01', category: 'creature', seconds: 2, loop: false,
    subject: 'low guttural growl from a large humanoid throat, wet and strained' },
  { id: 'creature_walker_detect_01', category: 'creature', seconds: 2, loop: false,
    subject: 'inhuman creature noticing something, sharp intake of breath and a rising wet rasp' },
  { id: 'creature_walker_attack_01', category: 'creature', seconds: 1, loop: false,
    subject: 'heavy clawed swipe and impact, short and violent, organic texture' },
  { id: 'creature_walker_hurt_01', category: 'creature', seconds: 1, loop: false,
    subject: 'wounded humanoid creature reaction, guttural pain, short' },
  { id: 'creature_walker_death_01', category: 'creature', seconds: 3, loop: false,
    subject: 'large humanoid creature collapsing and exhaling its last breath, wet and final' },

  { id: 'creature_hunter_breath_01', category: 'creature', seconds: 4, loop: false,
    subject: 'fast heavy breathing of a predatory creature closing distance, ragged and eager' },
  { id: 'creature_hunter_move_01', category: 'creature', seconds: 3, loop: false,
    subject: 'fast four-limbed creature running across forest ground, quick scrambling steps' },
  { id: 'creature_hunter_detect_01', category: 'creature', seconds: 2, loop: false,
    subject: 'predator locking onto prey, sudden snarl and a fast inhale' },
  { id: 'creature_hunter_chase_01', category: 'creature', seconds: 2, loop: false,
    subject: 'short aggressive screech signalling a chase, sharp but not deafening' },
  { id: 'creature_hunter_attack_01', category: 'creature', seconds: 1, loop: false,
    subject: 'fast claw strike with snarl, short violent impact' },
  { id: 'creature_hunter_hurt_01', category: 'creature', seconds: 1, loop: false,
    subject: 'fast predator yelping in pain, short and sharp' },
  { id: 'creature_hunter_death_01', category: 'creature', seconds: 2, loop: false,
    subject: 'predator collapsing and choking out, short dying sound' },

  { id: 'creature_stalker_whisper_01', category: 'creature', seconds: 4, loop: false,
    subject: 'quiet breathy whispering with no intelligible words, close to the ear, unsettling' },
  { id: 'creature_stalker_distant_01', category: 'creature', seconds: 5, loop: false,
    subject: 'distant ambiguous non-human call deep in fog, spaced, no melody' },
  { id: 'creature_stalker_appear_01', category: 'creature', seconds: 2, loop: false,
    subject: 'subtle presence arriving, air pressure change and a soft dry rasp, no impact' },
  { id: 'creature_stalker_disappear_01', category: 'creature', seconds: 2, loop: false,
    subject: 'presence withdrawing, receding air and a faint fading hiss' },
  { id: 'creature_stalker_move_01', category: 'creature', seconds: 3, loop: false,
    subject: 'barely audible movement of something thin crossing dry leaves, slow and deliberate' },
  { id: 'creature_stalker_nearby_01', category: 'creature', seconds: 4, loop: false,
    subject: 'something standing very close and breathing shallowly, close intimate perspective' },

  // Generic animal reactions. Every ordinary creature used to share the same three
  // synthesized blips; these are the "own sounds" for the farm animals and pets,
  // while the horror roster keeps its dedicated sets above.
  { id: 'mob_hurt_01', category: 'creature', seconds: 1, loop: false,
    subject: 'short pained grunt of a four-legged animal taking a hit, no words, no music' },
  { id: 'mob_attack_01', category: 'creature', seconds: 1, loop: false,
    subject: 'an animal lunging and biting, short snarl and teeth snap, no words' },
  { id: 'mob_death_01', category: 'creature', seconds: 2, loop: false,
    subject: 'an animal collapsing and letting out a final breath, short and final, no words' },

  // ------------------------------------------------------------------ horror
  { id: 'horror_sting_subtle_01', category: 'horror', seconds: 3, loop: false,
    subject: 'subtle tension sting, single low string-like swell without melody, uneasy' },
  { id: 'horror_sting_distant_01', category: 'horror', seconds: 5, loop: false,
    subject: 'distant frightening accent far beyond the fog, ambiguous and hollow' },
  { id: 'horror_sting_reveal_01', category: 'horror', seconds: 3, loop: false,
    subject: 'moment of reveal, sudden low impact and rising airy texture, not a loud scream' },
  { id: 'horror_impact_01', category: 'horror', seconds: 2, loop: false,
    subject: 'short low-frequency impact with no metallic ring, felt more than heard' },
  { id: 'horror_whisper_distant_01', category: 'horror', seconds: 5, loop: false,
    subject: 'barely audible whisper far away, no intelligible words, airy and dry, the whisper begins immediately with no lead-in silence' },
  { id: 'horror_branch_snap_01', category: 'horror', seconds: 1, loop: false,
    subject: 'sudden dry branch snapping underfoot in a quiet forest' },
  { id: 'horror_footsteps_distant_01', category: 'horror', seconds: 6, loop: false,
    subject: 'distant footsteps of an unknown creature approaching through leaves, spaced and slow' },
  { id: 'horror_footsteps_behind_01', category: 'horror', seconds: 3, loop: false,
    subject: 'short sequence of footsteps directly behind the listener, close perspective, sudden' },
  { id: 'horror_knock_01', category: 'horror', seconds: 2, loop: false,
    subject: 'three slow knocks on old wood, dry and deliberate, from the other side' },
  { id: 'horror_scrape_01', category: 'horror', seconds: 4, loop: false,
    subject: 'something heavy scraping slowly across rough stone, long deliberate drag' },
  { id: 'horror_roar_distant_01', category: 'horror', seconds: 6, loop: false,
    subject: 'distant inhuman roar far across the forest, low and wide, spatial distance' },
  { id: 'horror_roar_close_01', category: 'horror', seconds: 3, loop: false,
    subject: 'close inhuman roar, raw and organic, moderate volume with headroom, no clipping, no limiter pumping, no distortion' },
  { id: 'horror_static_01', category: 'horror', seconds: 2, loop: false,
    subject: 'short abstract noise texture, dry static and tape flutter, rare event, no melody' },

  // ---------------------------------------------------------------------- ui
  { id: 'ui_inventory_open_01', category: 'ui', seconds: 1, loop: false,
    subject: 'soft leather and cloth opening of a bag, short and muted' },
  { id: 'ui_inventory_close_01', category: 'ui', seconds: 1, loop: false,
    subject: 'soft cloth closing of a bag, short and quiet' },
  { id: 'ui_item_select_01', category: 'ui', seconds: 1, loop: false,
    subject: 'single soft wooden tick for selecting an item, very short' },
  { id: 'ui_item_error_01', category: 'ui', seconds: 1, loop: false,
    subject: 'dull wooden double tap for a rejected action, muted and low' },
  { id: 'ui_craft_success_01', category: 'ui', seconds: 2, loop: false,
    subject: 'satisfying small assembly click with a light wooden settle, short, ends promptly after the click with no trailing silence' },
  { id: 'ui_player_death_01', category: 'ui', seconds: 2, loop: false,
    subject: 'low descending airy tone for a death screen transition, no melody, restrained' },

  // ------------------------------------------------------------------- music
  // Generated through `/v1/music` rather than the sound-effects endpoint, hence
  // `api: 'music'`. These are underscore, not songs: no hooks and no busy drums
  // that would fight gameplay, and a texture that survives being looped for ten
  // minutes on end.
  { id: 'music_day_01', category: 'music', api: 'music', seconds: 30, loop: true,
    subject: 'calm daytime exploration underscore for a survival horror game, sparse warm pad, distant soft air, gentle unease underneath, no percussion' },
  { id: 'music_dusk_01', category: 'music', api: 'music', seconds: 30, loop: true,
    subject: 'dusk tension underscore, low strings slowly rising, airy distant texture, a sense of something approaching, no percussion, no melody hook, the pad is already sounding in the first second with no silent intro' },
  { id: 'music_night_01', category: 'music', api: 'music', seconds: 30, loop: true,
    subject: 'deep night dread underscore, sustained sub drone, cold high air, faint irregular pulses, oppressive and slow, no percussion' },
  { id: 'music_night_02', category: 'music', api: 'music', seconds: 30, loop: true,
    subject: 'night forest underscore, hollow wind-like pads, distant metallic resonance, patient and threatening, no percussion, no melody' },
  { id: 'music_cave_01', category: 'music', api: 'music', seconds: 30, loop: true,
    subject: 'underground cave underscore, deep stone resonance, dripping space, low pressure waves, claustrophobic and slow' },
  { id: 'music_menu_01', category: 'music', api: 'music', seconds: 30, loop: true,
    subject: 'main menu theme for a survival horror game, cold ambient pads, slow distant pulse, mysterious and inviting, no percussion' },
]);

/** Ids grouped by category, in catalogue order. */
export function soundsByCategory(category) {
  return SOUNDS.filter((entry) => entry.category === category);
}

/** Hard limit reported by the Sound Effects API for the `text` field. */
export const MAX_PROMPT_LENGTH = 450;

/**
 * Composes the final prompt sent to the API.
 *
 * The endpoint rejects anything over 450 characters, and a rejection is a paid
 * round trip that produces nothing. Long subjects therefore lose their optional
 * hints first (duration is advisory, the loop hint is not) and are then trimmed at
 * a clause boundary. Trimming here means a wordy catalogue entry can never fail
 * the whole batch.
 */
export function promptFor(entry) {
  const suffix = PROMPT_SUFFIXES[entry.category];
  const loopHint = entry.loop ? ', seamless loop with no obvious seam' : '';
  const durationHint = entry.seconds >= 12
    ? `, approximately ${entry.seconds} seconds long`
    : '';

  const full = `${entry.subject}, ${suffix}${loopHint}${durationHint}`;
  if (full.length <= MAX_PROMPT_LENGTH) return full;

  const essential = `, ${suffix}${loopHint}`;
  const withLoopOnly = `${entry.subject}${essential}`;
  if (withLoopOnly.length <= MAX_PROMPT_LENGTH) return withLoopOnly;

  const available = Math.max(40, MAX_PROMPT_LENGTH - essential.length);
  const clipped = entry.subject
    .slice(0, available)
    // Never end mid-word or on a dangling comma.
    .replace(/[,\s]+[^,\s]*$/, '')
    .replace(/[,\s]+$/, '');
  return `${clipped}${essential}`;
}

export default SOUNDS;
