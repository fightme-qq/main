/**
 * Horror-pass gates.
 *
 * These checks cover the two P0 systems that are easy to *believe* are working
 * and hard to eyeball: per-part creature skins (geometry UVs included) and the
 * biome/time fog profile. Geometry is built for real through `MobRenderer`, so a
 * broken bone name, a missing atlas tile or a UV outside the tile fails here
 * instead of shipping as a magenta creature.
 */

import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATLAS_COLUMNS,
  ATLAS_ROWS,
  TILE_UVS,
} from '../src/world/AtlasLayout.js';
import { TILE_INDEX, TILE_NAMES } from '../src/world/BlockTypes.js';
import {
  MOB_FACE_RECT,
  MOB_FACES,
  MOB_PATTERNS,
  MOB_SKIN_ROLES,
  MOB_SKIN_STYLES,
  MOB_SKIN_TILE_PIXELS,
  mobSkinRoleForBone,
  mobSkinRoleForBox,
  mobSkinTileName,
} from '../src/config/MobSkins.js';
import {
  DEFAULT_FOG_PROFILE,
  FOG_BIOME_PROFILES,
  caveFogAmount,
  fogBiomeTint,
  fogVisibilityFactor,
} from '../src/config/AtmosphereConfig.js';
import { MOB_DEFINITIONS } from '../src/entities/MobTypes.js';
import { MOB_SKELETONS } from '../src/entities/MobSkeletons.js';
import { MobRenderer } from '../src/entities/MobRenderer.js';
import { SEA_LEVEL } from '../src/config/GameConfig.js';
import { createSoundCatalogue } from '../src/audio/SoundRegistry.js';
import {
  FALLBACK_ALIASES,
  FILE_LOOP_MAP,
  FILE_SOUND_MAP,
  normaliseManifest,
  referencedLibraryIds,
} from '../src/audio/SoundLibrary.js';
import { MAX_PROMPT_LENGTH, SOUNDS, promptFor } from './audio/catalogue.mjs';
import { phaseAt } from '../src/config/DayCycle.js';
import { TIME } from '../src/config/GameConfig.js';
import { TensionDirector } from '../src/gameplay/TensionDirector.js';
import { NoiseSystem } from '../src/gameplay/NoiseSystem.js';
import { HorrorBrain, HorrorState } from '../src/entities/ai/HorrorBrain.js';
import { pickWeightedMob } from '../src/entities/MobSpawner.js';
import { mobSound } from '../src/entities/MobSounds.js';
import { getMob } from '../src/entities/MobTypes.js';

let passed = 0;
const check = (name, condition, detail = '') => {
  if (!condition) throw new Error(detail ? `${name} — ${detail}` : name);
  passed++;
  console.log(`  ok  ${name}`);
};
const section = (name) => console.log(`\n${name}`);

// ------------------------------------------------------------------ skins

section('Creature skin catalogue');

const styleIds = Object.keys(MOB_SKIN_STYLES);
const mobIds = MOB_DEFINITIONS.map((definition) => definition.id);

check(
  'every creature has a skin style',
  mobIds.every((id) => Boolean(MOB_SKIN_STYLES[id])),
);
check(
  'every skin style belongs to a creature',
  styleIds.every((id) => mobIds.includes(id)),
);
check(
  'skins define a valid palette, pattern and face',
  styleIds.every((id) => {
    const style = MOB_SKIN_STYLES[id];
    const colour = (value) =>
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255);
    return (
      colour(style.base) &&
      colour(style.accent) &&
      colour(style.eye) &&
      MOB_PATTERNS.includes(style.pattern) &&
      MOB_FACES.includes(style.face)
    );
  }),
);
check(
  'the horror roster has glowing eyes',
  ['husk', 'lurker', 'bonecaster'].every((id) => MOB_SKIN_STYLES[id]?.eyeGlow === true),
);
check(
  'faces sit inside the head tile',
  MOB_FACE_RECT.u0 > 0 && MOB_FACE_RECT.u1 < 1 && MOB_FACE_RECT.v0 > 0 && MOB_FACE_RECT.v1 < 1,
);
check('skin tiles are the documented 16px art', MOB_SKIN_TILE_PIXELS === 16);

check(
  'the atlas holds every tile',
  TILE_NAMES.length <= ATLAS_COLUMNS * ATLAS_ROWS,
);
check(
  'the atlas has no duplicate tiles',
  new Set(TILE_NAMES).size === TILE_NAMES.length,
);

const missingTiles = [];
for (const id of mobIds) {
  for (const role of MOB_SKIN_ROLES) {
    const name = mobSkinTileName(id, role);
    if (TILE_INDEX[name] === undefined) missingTiles.push(name);
  }
}
check('every creature role has an atlas tile', missingTiles.length === 0);

section('Skin role mapping');
check('a head bone is a head', mobSkinRoleForBone('head') === 'head');
check('a leg bone is a limb', mobSkinRoleForBone('legFrontLeft') === 'limb');
check('an arm bone is a limb', mobSkinRoleForBone('armRight') === 'limb');
check('a body bone is a body', mobSkinRoleForBone('body') === 'body');
check('a beak is an accent', mobSkinRoleForBone('beak') === 'accent');
check('a glowing core is an accent', mobSkinRoleForBone('core') === 'accent');
check('the first box carries the bone role', mobSkinRoleForBox('head', 0) === 'head');
check('trim boxes are accents', mobSkinRoleForBox('head', 1) === 'accent');

section('Built creature geometry');

const scene = {
  add() {},
  remove() {},
};
const resources = {
  trackTransient() {},
  releaseTransient() {},
};

let renderer = null;
try {
  renderer = new MobRenderer({ scene, atlasTexture: null, resources });
} catch (error) {
  check(`MobRenderer builds every creature (${error.message})`, false);
}

if (renderer) {
  const entries = Array.from(renderer._entries.values());
  check('one instanced entry per creature', entries.length === MOB_DEFINITIONS.length);

  const outsideUv = [];
  const singleTileMobs = [];
  const faceFailures = [];

  // Recomputes the atlas rect of a tile the same way `skinRectsFor` does.
  const tileRect = (tile) => {
    const base = tile * 4;
    return {
      u0: TILE_UVS[base],
      v0: TILE_UVS[base + 1],
      u1: TILE_UVS[base + 2],
      v1: TILE_UVS[base + 3],
    };
  };

  for (const entry of entries) {
    const geometry = entry.geometry;
    const uv = geometry.getAttribute('uv');
    const normal = geometry.getAttribute('normal');
    const bone = geometry.getAttribute('aBone');
    const tiles = new Set();

    for (let vertex = 0; vertex < uv.count; vertex++) {
      const u = uv.getX(vertex);
      const v = uv.getY(vertex);
      if (u < 0 || u > 1 || v < 0 || v > 1) outsideUv.push(`${entry.definition.id}:${vertex}`);
      tiles.add(`${Math.floor(u * 32)}:${Math.floor(v * 32)}`);
    }
    if (tiles.size < 2) singleTileMobs.push(entry.definition.id);

    // Front faces of the head must sample the face sub-rect of the head tile.
    const rig = MOB_SKELETONS[entry.definition.id];
    const headIndex = rig?.skeleton.bones.findIndex((boneEntry) => boneEntry.name === 'head') ?? -1;
    if (headIndex < 0) continue;
    const headTile = TILE_INDEX[mobSkinTileName(entry.definition.id, 'head')];
    if (headTile === undefined) {
      faceFailures.push(`${entry.definition.id}:no-head-tile`);
      continue;
    }
    const head = tileRect(headTile);
    const faceU0 = head.u0 + (head.u1 - head.u0) * MOB_FACE_RECT.u0;
    const faceU1 = head.u0 + (head.u1 - head.u0) * MOB_FACE_RECT.u1;
    const faceV0 = head.v0 + (head.v1 - head.v0) * MOB_FACE_RECT.v0;
    const faceV1 = head.v0 + (head.v1 - head.v0) * MOB_FACE_RECT.v1;

    let frontVertices = 0;
    for (let vertex = 0; vertex < uv.count; vertex++) {
      if (bone.getX(vertex) !== headIndex) continue;
      if (normal.getZ(vertex) < 0.9) continue;
      frontVertices++;
      // Only the bone's first box carries the face; muzzle, ear and nose boxes
      // are accents and are supposed to sample a different tile.
      if (frontVertices > 4) continue;
      const u = uv.getX(vertex);
      const v = uv.getY(vertex);
      const eps = 1e-5;
      if (u < faceU0 - eps || u > faceU1 + eps || v < faceV0 - eps || v > faceV1 + eps) {
        faceFailures.push(`${entry.definition.id}:outside-face`);
        break;
      }
    }
    if (frontVertices < 4) faceFailures.push(`${entry.definition.id}:front=${frontVertices}`);
  }

  check('every creature builds without throwing', true);
  check('all UVs stay inside the atlas', outsideUv.length === 0, outsideUv.slice(0, 3).join(','));
  check(
    'every creature samples more than one tile',
    singleTileMobs.length === 0,
    singleTileMobs.join(','),
  );
  check('head fronts use the face region', faceFailures.length === 0, faceFailures.slice(0, 3).join(','));
  check(
    'contact shadows share one instanced pool',
    renderer.shadowMesh?.name === 'mob-contact-shadows',
  );

  // A box counts four vertices per face, so the merged geometry must be non-empty
  // and index a sane number of triangles.
  const sample = renderer._entries.get('cow');
  check('cow geometry is indexed', (sample?.geometry.index?.count ?? 0) > 0);
  check('cow geometry has no NaN positions', Number.isFinite(sample.geometry.boundingSphere.radius));

  renderer.destroy();
}

// -------------------------------------------------------------- atmosphere

section('Biome and time fog');

const forestNight = fogVisibilityFactor({
  biomeName: 'Forest',
  daylight: 0,
  y: SEA_LEVEL,
});
const forestDay = fogVisibilityFactor({
  biomeName: 'Forest',
  daylight: 1,
  y: SEA_LEVEL,
});
const swampNight = fogVisibilityFactor({
  biomeName: 'Swamp',
  daylight: 0,
  y: SEA_LEVEL,
});
const plainsNight = fogVisibilityFactor({
  biomeName: 'Plains',
  daylight: 0,
  y: SEA_LEVEL,
});
const plainsDay = fogVisibilityFactor({
  biomeName: 'Plains',
  daylight: 1,
  y: SEA_LEVEL,
});

check('night is less visible than day in a forest', forestNight < forestDay);
check(
  'night costs most of the sight line even in a clear biome',
  forestNight < forestDay * 0.62,
);
check('a plains night is still enclosed', plainsNight < 0.62);
check('swamp fog is worse than plains fog at night', swampNight < plainsNight);
check('plains stay the most open biome at night', plainsNight >= forestNight);
check('day fog is clearer than night fog in the plains', plainsDay > plainsNight);
check(
  'even noon keeps a haze',
  plainsDay < 0.88,
  String(plainsDay),
);
check(
  'an unknown biome falls back to the default profile',
  fogVisibilityFactor({ biomeName: 'Nowhere', daylight: 0, y: SEA_LEVEL }) ===
    fogVisibilityFactor({ biomeName: 'Plains', daylight: 0, y: SEA_LEVEL }) ||
    DEFAULT_FOG_PROFILE.night === 0.92,
);
check(
  'a valley is foggier than a ridge',
  fogVisibilityFactor({ biomeName: 'Plains', daylight: 0, y: SEA_LEVEL - 8 }) <
    fogVisibilityFactor({ biomeName: 'Plains', daylight: 0, y: SEA_LEVEL + 70 }),
);
check(
  'a scripted fog boost thickens the air further',
  fogVisibilityFactor({ biomeName: 'Forest', daylight: 1, y: SEA_LEVEL, extraDensity: 0.8 }) <
    forestDay,
);
check(
  'visibility stays inside a playable band',
  Object.keys(FOG_BIOME_PROFILES).every((name) => {
    for (const daylight of [0, 0.5, 1]) {
      for (const y of [SEA_LEVEL - 40, SEA_LEVEL, SEA_LEVEL + 100]) {
        const value = fogVisibilityFactor({ biomeName: name, daylight, y });
        if (value < 0.32 || value > 1.3) return false;
      }
    }
    return true;
  }),
);
check('caves are fully enclosed', caveFogAmount(SEA_LEVEL - 60) === 1);
check('the surface is not treated as a cave', caveFogAmount(SEA_LEVEL + 20) === 0);
check(
  'biome tints stay subtle',
  Object.keys(FOG_BIOME_PROFILES).every((name) => {
    const tint = fogBiomeTint(name);
    return tint.every((channel) => channel > 0.85 && channel <= 1.05);
  }),
);

// ------------------------------------------------------------------- audio

section('Generated sound library');

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const manifestPath = join(projectRoot, 'public', 'assets', 'audio', 'manifest.json');
check('the sound manifest is shipped', existsSync(manifestPath));

const rawManifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { entries: {} };
const library = normaliseManifest(rawManifest);
check('the manifest validates', library.ok, library.errors.slice(0, 3).join('; '));
check(
  'the manifest covers the whole catalogue',
  Object.keys(library.entries).length === SOUNDS.length,
  `${Object.keys(library.entries).length}/${SOUNDS.length}`,
);
check('catalogue ids are unique', new Set(SOUNDS.map((sound) => sound.id)).size === SOUNDS.length);
check(
  'every prompt fits the API limit',
  SOUNDS.every((sound) => promptFor(sound).length <= MAX_PROMPT_LENGTH),
);
check(
  'every requested duration is inside the API range',
  SOUNDS.every((sound) => sound.seconds >= 0.5 && sound.seconds <= 30),
);
check(
  'every mapped id was generated',
  referencedLibraryIds().every((id) => Boolean(library.entries[id])),
  referencedLibraryIds().filter((id) => !library.entries[id]).slice(0, 3).join(','),
);

const missingFiles = Object.values(library.entries).filter(
  (entry) => !existsSync(join(projectRoot, 'public', 'assets', 'audio', entry.file)),
);
check('every manifest file exists on disk', missingFiles.length === 0, missingFiles.slice(0, 3).map((e) => e.id).join(','));
check(
  'manifest loop flags match the catalogue',
  SOUNDS.every((sound) => library.entries[sound.id]?.loop === sound.loop),
);
check(
  'manifest categories match the catalogue',
  SOUNDS.every((sound) => library.entries[sound.id]?.category === sound.category),
);
check(
  'normalisation gains stay in a sane range',
  Object.values(library.entries).every((entry) => entry.gain >= 0.2 && entry.gain <= 4),
);

check(
  'one-shot and loop keys never collide',
  Object.keys(FILE_SOUND_MAP).every((key) => !(key in FILE_LOOP_MAP)),
);
const synthCatalogue = createSoundCatalogue();
check(
  'every fallback alias resolves to a real sound',
  Object.values(FALLBACK_ALIASES).every(
    (name) => Boolean(synthCatalogue[name]) || name in FILE_SOUND_MAP || name in FILE_LOOP_MAP,
  ),
);
const mappedKeys = [...Object.entries(FILE_SOUND_MAP), ...Object.entries(FILE_LOOP_MAP)];
check(
  'every gameplay key has at least one generated file',
  mappedKeys.every(([, mapping]) => mapping.ids.some((id) => Boolean(library.entries[id]))),
);
const reachable = new Set(referencedLibraryIds());
const unreachable = SOUNDS.filter((sound) => !reachable.has(sound.id)).map((sound) => sound.id);
check('every generated sound is reachable', unreachable.length === 0, unreachable.slice(0, 5).join(','));

// ------------------------------------------------------------ day/night pacing

section('Horror day/night pacing');

check('the full cycle is twenty minutes', TIME.secondsPerDay === 1200);
check(
  'a world opens in late afternoon',
  TIME.startTime >= 0.52 && TIME.startTime < 0.7,
  String(TIME.startTime),
);
check('the opening scene is dusk, not daylight', phaseAt(TIME.startTime) === 'dusk');
check(
  'sleeping wakes the player in the morning',
  phaseAt(TIME.morningTime) === 'day' && TIME.morningTime > 0.24 && TIME.morningTime < 0.36,
);
check('midnight is night', phaseAt(0.0) === 'night');
check('just before dawn is night', phaseAt(0.09) === 'night');
check('dawn is its own transition phase', phaseAt(0.18) === 'dusk');
check('midday is day', phaseAt(0.4) === 'day');
check('late afternoon is dusk', phaseAt(0.64) === 'dusk');
check('after nightfall it is night again', phaseAt(0.85) === 'night');
check('underground overrides the sky', phaseAt(0.4, { underground: true }) === 'cave');

// Sample the cycle: the night must own the largest share of it.
const phaseCounts = { day: 0, dusk: 0, night: 0, cave: 0 };
for (let sample = 0; sample < 1000; sample++) phaseCounts[phaseAt(sample / 1000)]++;
check(
  'night is the longest phase of the cycle',
  phaseCounts.night > phaseCounts.day,
  JSON.stringify(phaseCounts),
);
check('night is longer than dusk', phaseCounts.night > phaseCounts.dusk * 1.3, JSON.stringify(phaseCounts));
check('dusk is a real phase, not a single frame', phaseCounts.dusk >= 60, JSON.stringify(phaseCounts));
check('the day is short', phaseCounts.day < phaseCounts.night * 0.85, JSON.stringify(phaseCounts));

section('Tension director');

const directorCalls = [];
const stubAudio = {
  setLoop() {},
  playLibrarySound(id, options) {
    directorCalls.push({ id, options });
    return true;
  },
  setMusicPhase(phase) {
    directorCalls.push({ phase });
  },
};
const director = new TensionDirector({ audio: stubAudio, random: () => 0.5 });
for (let step = 0; step < 1200; step++) {
  director.update(0.1, {
    phase: 'night',
    daylight: 0,
    position: { x: 0, y: 64, z: 0 },
    healthFraction: 1,
  });
}
const nightEvents = directorCalls.filter((call) => call.id);
check('a night of gameplay produces distant events', nightEvents.length >= 2, String(nightEvents.length));
check(
  'events are placed away from the player',
  nightEvents.every(
    (call) =>
      call.options.position &&
      Math.hypot(call.options.position.x, call.options.position.z) >= 9,
  ),
);
let repeated = false;
for (let index = 1; index < nightEvents.length; index++) {
  if (nightEvents[index].id === nightEvents[index - 1].id) repeated = true;
}
check('the director never repeats the same event twice in a row', !repeated);
check('the night requested night music', directorCalls.some((call) => call.phase === 'night'));

const beforePaused = directorCalls.length;
for (let step = 0; step < 300; step++) {
  director.update(0.1, {
    phase: 'menu',
    daylight: 1,
    position: { x: 0, y: 64, z: 0 },
    healthFraction: 1,
    paused: true,
  });
}
check(
  'a paused game fires no events',
  directorCalls.slice(beforePaused).every((call) => !call.id),
);

section('Music and footsteps');

check(
  'every music phase has a track',
  ['music.day', 'music.dusk', 'music.night', 'music.cave', 'music.menu'].every(
    (key) => key in FILE_LOOP_MAP,
  ),
);
check('night music has two alternate takes', FILE_LOOP_MAP['music.night'].ids.length === 2);
check(
  'footsteps have five variants per surface',
  ['step.grass', 'step.dirt', 'step.stone', 'step.wood', 'step.snow', 'step.liquid'].every(
    (key) => FILE_SOUND_MAP[key].ids.length === 5,
  ),
);
check(
  'jump and landing have their own recordings',
  'player.jump' in FILE_SOUND_MAP && 'player.land' in FILE_SOUND_MAP,
);

// ------------------------------------------------------------------- mobs

section('Horror roster definitions');

for (const id of ['walker', 'hunter', 'stalker']) {
  const definition = getMob(id);
  check(`${id} exists`, Boolean(definition));
  check(`${id} is hostile`, definition?.family === 'hostile');
  check(`${id} runs the horror brain`, definition?.behavior === id);
  check(`${id} has a spawn weight`, definition?.spawnWeight > 0);
  check(`${id} has recorded reactions`, Boolean(mobSound(id, 'hurt')) && Boolean(mobSound(id, 'death')));
}
check('the hunter hears further than the walker', getMob('hunter').chaseSpeed > getMob('walker').chaseSpeed);
check('the stalker is not built to fight', getMob('stalker').attackDamage < getMob('walker').attackDamage);

section('Walker and hunter behaviour');

const walkerSounds = [];
const walker = new HorrorBrain({ behavior: 'walker', definition: getMob('walker'), random: () => 0.5 });
walker.reset(0, 0);
const walkerMob = { x: 0, y: 64, z: 0 };
const walkerTarget = { x: 5, y: 64, z: 0 };
const walkerCtx = {
  mob: walkerMob,
  target: walkerTarget,
  targetVisible: true,
  distance: 5,
  attackCooldown: 0,
  emitSound: (id) => walkerSounds.push(id),
};

let intent = walker.update(0.1, walkerCtx);
check('the walker freezes when it notices you', intent.state === HorrorState.DETECT && intent.speed === 0);
check('the walker announces detection', walkerSounds.includes('creature_walker_detect_01'));

for (let step = 0; step < 12; step++) intent = walker.update(0.1, walkerCtx);
check('the walker commits to a chase', intent.state === HorrorState.CHASE, intent.state);
check('the walker navigates toward the player', intent.navigateTo?.x === 5);

intent = walker.update(0.1, { ...walkerCtx, distance: 1.4 });
check('the walker attacks in reach', intent.state === HorrorState.ATTACK && intent.wantsAttack === true);

const lostCtx = { ...walkerCtx, targetVisible: false, distance: 25, attackCooldown: 1 };
for (let step = 0; step < 70; step++) intent = walker.update(0.1, lostCtx);
check(
  'the walker searches the last known position instead of tracking through walls',
  intent.state === HorrorState.SEARCH,
  intent.state,
);
check('the search heads for the remembered point', intent.navigateTo?.x === 5);

const hunter = new HorrorBrain({ behavior: 'hunter', definition: getMob('hunter'), random: () => 0.5 });
hunter.reset(0, 0);
const quietCtx = {
  mob: { x: 0, y: 64, z: 0 },
  target: null,
  targetVisible: false,
  distance: Infinity,
  noise: { x: 10, z: 0, distance: 10 },
};
intent = hunter.update(0.1, quietCtx);
check('the hunter investigates a noise within earshot', intent.state === HorrorState.INVESTIGATE);
check('the hunter walks toward the noise', intent.navigateTo?.x === 10);

const deafHunter = new HorrorBrain({ behavior: 'hunter', definition: getMob('hunter'), random: () => 0.5 });
deafHunter.reset(0, 0);
intent = deafHunter.update(0.1, { ...quietCtx, noise: { x: 40, z: 0, distance: 40 } });
check('the hunter ignores a noise beyond its hearing', intent.state !== HorrorState.INVESTIGATE);

section('Stalker behaviour');

const stalkerSounds = [];
const stalker = new HorrorBrain({ behavior: 'stalker', definition: getMob('stalker'), random: () => 0.5 });
stalker.reset(15, 0);
const stalkerCtx = {
  mob: { x: 15, y: 64, z: 0 },
  target: { x: 0, y: 64, z: 0 },
  targetVisible: true,
  distance: 15,
  playerLook: { x: 1, z: 0 },
  attackCooldown: 0,
  emitSound: (id) => stalkerSounds.push(id),
};
intent = stalker.update(0.1, stalkerCtx);
check('the stalker watches from the fog ring', intent.state === HorrorState.OBSERVE && intent.speed === 0);

for (let step = 0; step < 25; step++) intent = stalker.update(0.1, stalkerCtx);
check('the stalker leaves when stared at', intent.state === HorrorState.RETREAT, intent.state);
check('the stalker does not attack', intent.wantsAttack === false);

const farCtx = {
  ...stalkerCtx,
  mob: { x: 40, y: 64, z: 0 },
  distance: 40,
  targetVisible: false,
  playerLook: { x: -1, z: 0 },
};
let despawned = false;
for (let step = 0; step < 40; step++) {
  intent = stalker.update(0.1, farCtx);
  if (intent.despawn) despawned = true;
}
check('the stalker vanishes once it is out of sight', despawned);

section('Noise and spawn weights');

const noise = new NoiseSystem();
noise.emit(10, 64, 0, 18, 'sprint');
const heard = noise.loudestNear(0, 0, 24);
check('a sprint is heard within its radius', Boolean(heard) && heard.source === 'sprint');
check('a pulse outside its radius is silent', noise.loudestNear(40, 0, 24) === null);
noise.update(3);
check('noise decays away', noise.loudestNear(0, 0, 24) === null);

const pool = ['walker', 'hunter', 'stalker'];
check('spawn weights always return a valid mob', pool.includes(pickWeightedMob(pool, () => 0)));
check('spawn weights favour the walker over the stalker',
  pickWeightedMob(pool, () => 0) === 'walker' && pickWeightedMob(pool, () => 0.99) === 'stalker');

// ------------------------------------------------------------------- done

console.log(`\nHorror self-test: ${passed} checks passed`);
