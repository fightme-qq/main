/**
 * Creature skins: palette, marking pattern and facial layout per mob.
 *
 * ## Why this module exists
 *
 * Before this table every creature sampled *one* 16x16 atlas tile across its
 * whole body. The result was exactly what it sounds like: a cow, a zombie and a
 * creeper were the same noise blob stretched over a rig, with no face, no
 * muzzle, no hooves and no way to read which direction a creature was facing.
 * The models and animations were fine — the skin was the bug.
 *
 * A creature now owns four tiles:
 *
 *  - `head`   — carries the face (eyes, muzzle, beak, sockets) in its middle;
 *  - `body`   — the marking pattern, fur/feathers/scales/rot/cloth;
 *  - `limb`   — darker, with a band at the bottom that reads as a hoof or hand;
 *  - `accent` — muzzle, beak, horns, hooves, glowing core.
 *
 * `MobRenderer` bakes the matching atlas UVs per box, so a head box shows the
 * face on its front face and plain skin on the other five, while legs, arms and
 * tails use the limb tile. Nothing here knows about Three.js; the table is pure
 * data so `TextureAtlas` can paint it and `MobRenderer` can map it.
 *
 * ## Horror tone
 *
 * Palettes stay readable but sit darker and colder than a cheerful sandbox
 * palette, and `eyeGlow` marks the creatures whose eyes should catch the light
 * in a night fog — the single cheapest way to make a silhouette threatening.
 */

/** Roles a creature skin is cut into. Order is also atlas tile order. */
export const MOB_SKIN_ROLES = Object.freeze(['head', 'body', 'limb', 'accent']);

/**
 * Marking patterns understood by the atlas painter.
 * @see paintMobSkinTile in rendering/TextureAtlas.js
 */
export const MOB_PATTERNS = Object.freeze([
  'fur',
  'wool',
  'spots',
  'stripes',
  'feathers',
  'scales',
  'bone',
  'rot',
  'slime',
  'cloth',
  'armour',
  'glow',
  'void',
]);

/** Facial layouts understood by the atlas painter. */
export const MOB_FACES = Object.freeze([
  'mammal',
  'bird',
  'humanoid',
  'skull',
  'insect',
  'slime',
  'void',
  'mask',
]);

/**
 * @typedef {Object} MobSkinStyle
 * @property {[number, number, number]} base Main hide/mark colour.
 * @property {[number, number, number]} accent Extremities: hooves, beak, horns, cloth trim.
 * @property {[number, number, number]} eye Eye colour.
 * @property {string} pattern One of `MOB_PATTERNS`.
 * @property {string} face One of `MOB_FACES`.
 * @property {boolean} [eyeGlow] Eyes emit a bright core, readable in darkness.
 * @property {boolean} [pale] Lighten the face plate so features read at distance.
 */

/**
 * Skin per mob id. Keys must match `MOB_DEFINITIONS[].id`; the horror self-test
 * asserts both directions so a new creature cannot ship without a skin.
 *
 * @type {Readonly<Record<string, Readonly<MobSkinStyle>>>}
 */
export const MOB_SKIN_STYLES = Object.freeze({
  // ---------------------------------------------------------------- livestock
  cow: {
    base: [112, 82, 54], accent: [228, 222, 212], eye: [26, 20, 16],
    pattern: 'spots', face: 'mammal', pale: true,
  },
  pig: {
    base: [226, 152, 150], accent: [198, 118, 118], eye: [38, 24, 24],
    pattern: 'fur', face: 'mammal', pale: true,
  },
  sheep: {
    base: [228, 224, 214], accent: [166, 148, 128], eye: [38, 36, 34],
    pattern: 'wool', face: 'mammal', pale: true,
  },
  chicken: {
    base: [242, 239, 230], accent: [226, 158, 60], eye: [36, 28, 24],
    pattern: 'feathers', face: 'bird', pale: true,
  },
  horse: {
    base: [126, 90, 56], accent: [82, 58, 36], eye: [26, 20, 14],
    pattern: 'fur', face: 'mammal',
  },
  donkey: {
    base: [138, 130, 122], accent: [94, 88, 82], eye: [32, 28, 24],
    pattern: 'fur', face: 'mammal',
  },
  llama: {
    base: [202, 182, 146], accent: [156, 134, 102], eye: [38, 30, 22],
    pattern: 'wool', face: 'mammal', pale: true,
  },
  rabbit: {
    base: [172, 160, 144], accent: [220, 212, 198], eye: [44, 30, 32],
    pattern: 'fur', face: 'mammal',
  },
  fox: {
    base: [196, 106, 42], accent: [240, 238, 232], eye: [28, 24, 20],
    pattern: 'fur', face: 'mammal',
  },
  wolf: {
    base: [146, 146, 148], accent: [208, 206, 202], eye: [186, 174, 94],
    pattern: 'fur', face: 'mammal',
  },
  cat: {
    base: [110, 92, 76], accent: [184, 168, 148], eye: [150, 200, 90],
    pattern: 'fur', face: 'mammal',
  },
  bat: {
    base: [68, 56, 52], accent: [102, 84, 78], eye: [196, 120, 60],
    pattern: 'fur', face: 'mammal',
  },
  squid: {
    base: [86, 108, 130], accent: [138, 162, 184], eye: [230, 230, 220],
    pattern: 'scales', face: 'void',
  },
  turtle: {
    base: [84, 122, 72], accent: [188, 176, 118], eye: [38, 44, 28],
    pattern: 'scales', face: 'mammal',
  },
  bee: {
    base: [224, 174, 46], accent: [44, 40, 36], eye: [28, 24, 20],
    pattern: 'stripes', face: 'insect',
  },
  goat: {
    base: [202, 194, 178], accent: [118, 108, 96], eye: [38, 34, 28],
    pattern: 'fur', face: 'mammal', pale: true,
  },
  axolotl: {
    base: [230, 148, 166], accent: [246, 190, 202], eye: [38, 28, 32],
    pattern: 'scales', face: 'mammal', pale: true,
  },
  frog: {
    base: [94, 150, 70], accent: [194, 204, 118], eye: [240, 220, 80],
    pattern: 'scales', face: 'mammal',
  },

  // ------------------------------------------------------------- overworld undead
  zombie: {
    base: [86, 124, 86], accent: [56, 84, 58], eye: [206, 232, 176],
    pattern: 'rot', face: 'humanoid', eyeGlow: true,
  },
  skeleton: {
    base: [204, 200, 188], accent: [124, 118, 108], eye: [22, 20, 26],
    pattern: 'bone', face: 'skull', pale: true,
  },
  creeper: {
    base: [92, 156, 74], accent: [62, 118, 56], eye: [18, 24, 18],
    pattern: 'spots', face: 'mask',
  },
  spider: {
    base: [56, 46, 38], accent: [28, 22, 18], eye: [220, 58, 48],
    pattern: 'fur', face: 'insect', eyeGlow: true,
  },
  slime: {
    base: [108, 184, 108], accent: [56, 118, 58], eye: [28, 58, 28],
    pattern: 'slime', face: 'slime',
  },
  drowned: {
    base: [70, 118, 108], accent: [54, 86, 78], eye: [140, 220, 220],
    pattern: 'rot', face: 'humanoid', eyeGlow: true,
  },
  witch: {
    base: [94, 78, 118], accent: [62, 48, 82], eye: [28, 22, 34],
    pattern: 'cloth', face: 'humanoid',
  },
  pillager: {
    base: [108, 102, 94], accent: [68, 64, 58], eye: [38, 34, 30],
    pattern: 'cloth', face: 'humanoid',
  },
  ravager: {
    base: [94, 88, 82], accent: [58, 54, 50], eye: [208, 78, 48],
    pattern: 'fur', face: 'mammal', eyeGlow: true,
  },
  guardian: {
    base: [110, 150, 148], accent: [64, 100, 98], eye: [248, 148, 58],
    pattern: 'scales', face: 'insect', eyeGlow: true,
  },
  villager: {
    base: [136, 104, 84], accent: [94, 68, 56], eye: [38, 30, 24],
    pattern: 'cloth', face: 'humanoid',
  },
  iron_golem: {
    base: [170, 168, 156], accent: [108, 106, 98], eye: [198, 58, 48],
    pattern: 'armour', face: 'humanoid', pale: true,
  },

  // ------------------------------------------------------------------- nether
  zombified_piglin: {
    base: [136, 108, 94], accent: [94, 72, 64], eye: [208, 178, 118],
    pattern: 'rot', face: 'humanoid',
  },
  piglin: {
    base: [194, 138, 118], accent: [118, 84, 68], eye: [238, 198, 138],
    pattern: 'cloth', face: 'humanoid', pale: true,
  },
  wither_skeleton: {
    base: [56, 54, 58], accent: [28, 26, 30], eye: [218, 218, 228],
    pattern: 'bone', face: 'skull', eyeGlow: true,
  },
  blaze: {
    base: [224, 168, 58], accent: [148, 88, 28], eye: [255, 240, 180],
    pattern: 'glow', face: 'void', eyeGlow: true,
  },
  ghast: {
    base: [220, 216, 212], accent: [178, 174, 170], eye: [158, 58, 68],
    pattern: 'fur', face: 'void', pale: true,
  },
  magma_cube: {
    base: [102, 46, 30], accent: [230, 118, 38], eye: [255, 198, 78],
    pattern: 'glow', face: 'slime', eyeGlow: true,
  },
  hoglin: {
    base: [194, 138, 114], accent: [118, 74, 58], eye: [228, 88, 58],
    pattern: 'fur', face: 'mammal', eyeGlow: true,
  },
  strider: {
    base: [182, 64, 72], accent: [118, 38, 44], eye: [228, 178, 148],
    pattern: 'fur', face: 'mammal',
  },
  wither: {
    base: [38, 38, 42], accent: [84, 84, 90], eye: [198, 138, 238],
    pattern: 'bone', face: 'skull', eyeGlow: true,
  },

  // ---------------------------------------------------------------------- end
  enderman: {
    base: [22, 18, 26], accent: [14, 12, 18], eye: [198, 148, 252],
    pattern: 'void', face: 'void', eyeGlow: true,
  },
  silverfish: {
    base: [126, 122, 118], accent: [84, 82, 78], eye: [38, 34, 32],
    pattern: 'scales', face: 'insect',
  },
  shulker: {
    base: [134, 104, 144], accent: [94, 70, 104], eye: [234, 234, 118],
    pattern: 'armour', face: 'void',
  },
  ender_dragon: {
    base: [24, 22, 30], accent: [12, 10, 16], eye: [218, 138, 252],
    pattern: 'void', face: 'void', eyeGlow: true,
  },

  // ----------------------------------------------------- original horror roster
  husk: {
    base: [140, 130, 98], accent: [102, 94, 70], eye: [222, 202, 152],
    pattern: 'rot', face: 'humanoid', eyeGlow: true,
  },
  bonecaster: {
    base: [204, 198, 184], accent: [68, 62, 82], eye: [212, 118, 252],
    pattern: 'bone', face: 'skull', eyeGlow: true,
  },
  lurker: {
    base: [42, 42, 50], accent: [24, 24, 30], eye: [218, 38, 38],
    pattern: 'void', face: 'void', eyeGlow: true,
  },

  // The three horror roles. Their palettes are deliberately drained of colour so
  // the only saturated pixels on them are the eyes.
  walker: {
    base: [96, 92, 84], accent: [62, 58, 52], eye: [206, 226, 190],
    pattern: 'rot', face: 'humanoid', eyeGlow: true,
  },
  hunter: {
    base: [58, 52, 46], accent: [34, 30, 26], eye: [220, 116, 38],
    pattern: 'fur', face: 'mammal', eyeGlow: true,
  },
  stalker: {
    base: [26, 26, 32], accent: [14, 14, 18], eye: [238, 238, 242],
    pattern: 'void', face: 'void', eyeGlow: true,
  },
});

/** Canvas size the skin painters draw into. */
export const MOB_SKIN_TILE_PIXELS = 16;

/**
 * Region of the head tile that carries the face.
 *
 * Expressed in tile UV units (`0..1`). The border written by this rect is plain
 * skin, which is what the other five faces of the head sample — so the eyes can
 * never wrap around the skull.
 */
export const MOB_FACE_RECT = Object.freeze({
  u0: 3 / MOB_SKIN_TILE_PIXELS,
  v0: 3 / MOB_SKIN_TILE_PIXELS,
  u1: 13 / MOB_SKIN_TILE_PIXELS,
  v1: 13 / MOB_SKIN_TILE_PIXELS,
});

/** Plain band of the head tile, used for the back, sides, top and bottom. */
export const MOB_HEAD_SIDE_RECT = Object.freeze({ u0: 0, v0: 0, u1: 3 / 16, v1: 1 });

/** Full tile, used by every face of the body, limb and accent roles. */
export const MOB_FULL_RECT = Object.freeze({ u0: 0, v0: 0, u1: 1, v1: 1 });

/** Bone names whose main box is a head. */
const HEAD_BONES = Object.freeze(new Set(['head', 'skull', 'snout']));

/** Bone names that are always an extremity, whatever their size. */
const ACCENT_BONES = Object.freeze(
  new Set(['beak', 'wattle', 'core', 'horn', 'hornLeft', 'hornRight', 'tusk', 'nose', 'muzzle'])
);

/** Bone names that make up the trunk of a creature. */
const BODY_BONES = Object.freeze(new Set(['body', 'torso', 'shell', 'thorax', 'abdomen', 'hull']));

/**
 * Resolves the skin role of a bone by name.
 *
 * The names come from `MobSkeletons.js`, which reuses them across creatures
 * (`legFrontLeft`, `armLeft`, `wingRight`), so this mapping covers every rig
 * without a per-creature table.
 *
 * @param {string} boneName
 * @returns {'head'|'body'|'limb'|'accent'}
 */
export function mobSkinRoleForBone(boneName) {
  if (ACCENT_BONES.has(boneName)) return 'accent';
  if (HEAD_BONES.has(boneName)) return 'head';
  if (BODY_BONES.has(boneName)) return 'body';
  return 'limb';
}

/**
 * Resolves the skin role of one box inside a bone.
 *
 * The largest box of a bone carries its identity; smaller boxes are trim. That
 * turns the muzzle, ears and nose boxes of a quadruped head into accent parts
 * instead of painting a second face onto them, and it gives hooves and feet
 * their own colour for free.
 *
 * @param {string} boneRole Role of the owning bone.
 * @param {number} boxIndex Index of the box within the bone.
 * @returns {'head'|'body'|'limb'|'accent'}
 */
export function mobSkinRoleForBox(boneRole, boxIndex) {
  return boxIndex === 0 ? boneRole : 'accent';
}

/**
 * Atlas tile name for one role of one creature.
 * @param {string} mobId
 * @param {string} role
 * @returns {string}
 */
export function mobSkinTileName(mobId, role) {
  return `mob_${mobId}_${role}`;
}

/**
 * Style lookup with a deterministic fallback.
 *
 * The fallback keeps a freshly added creature renderable (grey-brown, fur,
 * mammal face) instead of throwing inside the renderer; the self-test is what
 * makes a missing style a build failure.
 *
 * @param {string} mobId
 * @returns {MobSkinStyle}
 */
export function mobSkinStyle(mobId) {
  const style = MOB_SKIN_STYLES[mobId];
  if (style) return style;
  let hash = 2166136261;
  for (const character of mobId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  const channel = (shift) => 70 + ((hash >>> shift) & 95);
  return {
    base: [channel(0), channel(8), channel(16)],
    accent: [channel(4), channel(12), channel(20)],
    eye: [30, 26, 24],
    pattern: 'fur',
    face: 'mammal',
  };
}

export default MOB_SKIN_STYLES;
