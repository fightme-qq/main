/**
 * Mob definitions: what each creature is, how it behaves, and what it drops.
 *
 * Data only, and free of DOM and Three.js, so the whole roster — every stat, every
 * drop table, every spawn rule — can be asserted by the Node self-test. Behaviour
 * lives in `ai/MobBrain.js`; rendering in `MobRenderer.js`.
 *
 * ## Original creatures
 *
 * These are voxel animals of my own design, not copies of anyone's art. Each is a
 * handful of boxes with a distinct silhouette and palette: the cow is broad and
 * low with a wide head, the chicken is small and narrow with a beak, the spider is
 * flat and wide with eight legs. Silhouette does the identification work, which is
 * what makes them readable at distance in a blocky world.
 *
 * ## The body plan
 *
 * A mob's shape is a list of boxes, each tagged with a `limb` role. `MobRenderer`
 * merges them into one geometry per type and animates the limbs in the vertex
 * shader from a per-instance phase, so a herd of cows is one draw call and one
 * geometry however many there are.
 *
 * Boxes are described in *model space*: units are blocks, the origin is the point
 * between the feet, and +Z is forward. `MobRenderer` needs no per-type knowledge.
 */

import { independentDropTable, rollLootTable } from '../loot/LootTable.js';

/** Roles a box can play. Drives which vertex-shader animation applies. */
export const Limb = Object.freeze({
  /** Static relative to the body. */
  BODY: 0,
  /** Bobs slightly and turns to look. */
  HEAD: 1,
  /** Swings fore-and-aft with the walk cycle. */
  LEG_A: 2,
  /** Swings in antiphase to `LEG_A`. */
  LEG_B: 3,
  /** Static decoration: horns, beak, tail. */
  DETAIL: 4,
});

/** Broad behaviour families. */
export const MobFamily = Object.freeze({
  PASSIVE: 'passive',
  HOSTILE: 'hostile',
  /**
   * Neutral: wanders freely and ignores the player until attacked, then
   * retaliates. Declared and honoured by `MobBrain`, but no creature ships with
   * this family yet — villagers arrive in Phase 2 and wolves in Phase 3. Kept
   * here because the brain already branches on it.
   */
  NEUTRAL: 'neutral',
});

/**
 * Builds one box.
 *
 * @param {number[]} size `[width, height, depth]` in blocks.
 * @param {number[]} offset Centre of the box relative to the feet origin.
 * @param {number} limb A `Limb` value.
 * @param {number} [shade] Brightness multiplier, so parts read as separate.
 * @returns {{size: number[], offset: number[], limb: number, shade: number}}
 */
function box(size, offset, limb, shade = 1) {
  return Object.freeze({
    size: Object.freeze([...size]),
    offset: Object.freeze([...offset]),
    limb,
    shade,
  });
}

/**
 * A quadruped body plan, shared by the cow, pig and sheep.
 *
 * Parameterised rather than written three times: the three animals differ in
 * proportion and palette, not in structure, and a shared builder means a fix to
 * the leg placement fixes all of them.
 *
 * @param {Object} options
 * @returns {ReadonlyArray<Object>}
 */
function quadruped({ bodyLength = 1.0, bodyWidth = 0.6, bodyHeight = 0.6, legHeight = 0.5, headSize = 0.45 }) {
  const legY = legHeight / 2;
  const bodyY = legHeight + bodyHeight / 2;
  const legInsetX = bodyWidth / 2 - 0.1;
  const legInsetZ = bodyLength / 2 - 0.12;
  const legThickness = 0.16;

  return Object.freeze([
    box([bodyWidth, bodyHeight, bodyLength], [0, bodyY, 0], Limb.BODY, 1),
    box(
      [headSize, headSize, headSize * 0.85],
      [0, bodyY + bodyHeight * 0.25, bodyLength / 2 + headSize * 0.4],
      Limb.HEAD,
      1.08
    ),
    // Diagonal pairs share a phase, which is what makes the gait read as a walk
    // rather than a hop.
    box([legThickness, legHeight, legThickness], [-legInsetX, legY, legInsetZ], Limb.LEG_A, 0.86),
    box([legThickness, legHeight, legThickness], [legInsetX, legY, -legInsetZ], Limb.LEG_A, 0.86),
    box([legThickness, legHeight, legThickness], [legInsetX, legY, legInsetZ], Limb.LEG_B, 0.86),
    box([legThickness, legHeight, legThickness], [-legInsetX, legY, -legInsetZ], Limb.LEG_B, 0.86),
  ]);
}

/**
 * A biped body plan, shared by the zombie-like and skeleton-like mobs.
 * @returns {ReadonlyArray<Object>}
 */
function biped({ shoulderWidth = 0.5, torsoHeight = 0.62, legHeight = 0.72, headSize = 0.46, limbThickness = 0.16 }) {
  const torsoY = legHeight + torsoHeight / 2;
  const armX = shoulderWidth / 2 + limbThickness / 2 - 0.02;

  return Object.freeze([
    box([shoulderWidth, torsoHeight, 0.28], [0, torsoY, 0], Limb.BODY, 1),
    box([headSize, headSize, headSize], [0, legHeight + torsoHeight + headSize / 2, 0], Limb.HEAD, 1.1),
    // Arms held forward, which is the silhouette that reads as "coming for you".
    box([limbThickness, torsoHeight * 0.95, limbThickness], [-armX, torsoY + 0.02, 0.12], Limb.LEG_B, 0.92),
    box([limbThickness, torsoHeight * 0.95, limbThickness], [armX, torsoY + 0.02, 0.12], Limb.LEG_A, 0.92),
    box([limbThickness, legHeight, limbThickness], [-limbThickness * 0.7, legHeight / 2, 0], Limb.LEG_A, 0.84),
    box([limbThickness, legHeight, limbThickness], [limbThickness * 0.7, legHeight / 2, 0], Limb.LEG_B, 0.84),
  ]);
}

/**
 * @typedef {Object} MobDefinition
 * @property {string} id
 * @property {string} displayName
 * @property {string} family One of `MobFamily`.
 * @property {number} maxHealth Half-hearts.
 * @property {number} halfSize Collision half-width.
 * @property {number} height Collision height.
 * @property {number} eyeHeight Where sight lines originate.
 * @property {number} walkSpeed Blocks per second while wandering.
 * @property {number} chaseSpeed Blocks per second while pursuing.
 * @property {number} attackDamage Half-hearts per hit; 0 for passive mobs.
 * @property {number} attackCooldown Seconds between attacks.
 * @property {number} attackRange Blocks, centre to centre.
 * @property {number} detectRange How far it notices the player.
 * @property {number} loseRange Beyond this it gives up.
 * @property {boolean} ranged Attacks with projectiles.
 * @property {boolean} burnsInDaylight Reserved for the day/night cycle.
 * @property {number} maxLightToSpawn Highest light level it will spawn in.
 * @property {number} tile Atlas tile index, resolved by `MobRegistry`.
 * @property {string} tileName Atlas tile name.
 * @property {ReadonlyArray<Object>} shape Body plan boxes.
 * @property {ReadonlyArray<{item: string, min: number, max: number, chance: number}>} drops
 * @property {boolean} despawns Whether it vanishes when far from the player.
 * @property {number} spawnGroupMin
 * @property {number} spawnGroupMax
 * @property {ReadonlyArray<string>} breedingItems Items that tempt/feed/breed this mob.
 * @property {number} babyScale Visual and collision scale while young.
 * @property {number} growthSeconds Seconds for a newborn to reach adulthood.
 */

/**
 * Normalises a definition, filling defaults and validating.
 *
 * Throws rather than warns: a mob with no drops or a negative detection range is
 * a programming error, and finding it by wondering why nothing drops meat is far
 * worse than a boot failure.
 *
 * @param {Partial<MobDefinition> & {id: string}} definition
 * @returns {MobDefinition}
 */
function mob(definition) {
  const id = definition.id;
  if (typeof id !== 'string' || !/^[a-z0-9_]+$/.test(id)) {
    throw new Error(`Mob id "${id}" must be lower_snake_case`);
  }
  const family = definition.family ?? MobFamily.PASSIVE;
  if (!Object.values(MobFamily).includes(family)) {
    throw new Error(`Mob "${id}" has unknown family "${family}"`);
  }
  if (!Array.isArray(definition.shape) || definition.shape.length === 0) {
    throw new Error(`Mob "${id}" has no body plan`);
  }

  const hostile = family === MobFamily.HOSTILE;
  const resolved = {
    id,
    displayName:
      definition.displayName ??
      id
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' '),
    family,
    maxHealth: definition.maxHealth ?? 10,
    halfSize: definition.halfSize ?? 0.4,
    height: definition.height ?? 1.2,
    eyeHeight: definition.eyeHeight ?? (definition.height ?? 1.2) * 0.85,
    walkSpeed: definition.walkSpeed ?? 1.6,
    chaseSpeed: definition.chaseSpeed ?? (hostile ? 2.6 : 2.2),
    attackDamage: definition.attackDamage ?? (hostile ? 3 : 0),
    attackCooldown: definition.attackCooldown ?? 1.0,
    attackRange: definition.attackRange ?? 1.5,
    detectRange: definition.detectRange ?? (hostile ? 18 : 8),
    loseRange: definition.loseRange ?? (hostile ? 28 : 12),
    ranged: definition.ranged ?? false,
    burnsInDaylight: definition.burnsInDaylight ?? false,
    // 7 is the light level below which hostile spawning is allowed: bright enough
    // that a torched-up base is safe, dark enough that caves are not.
    maxLightToSpawn: definition.maxLightToSpawn ?? (hostile ? 7 : 15),
    // Phase 4. Which dimension this creature belongs to. The string matches
    // `Dimension.*` in world/DimensionConfig.js; the Phase 4 self-test asserts
    // the two agree so this cannot drift into a silent no-spawn.
    dimension: definition.dimension ?? 'overworld',
    // Phase 5. Most creatures live in exactly one dimension, but the Enderman
    // genuinely belongs to two: it must spawn in the Overworld or pearls are
    // unobtainable, and in the End or the dragon's arena is empty. `dimension`
    // stays as the primary home so nothing that reads it has to change.
    dimensions: Object.freeze([
      ...(definition.dimensions ?? [definition.dimension ?? 'overworld']),
    ]),
    // Present only on the horror roster. `null` means the legacy brain in
    // `ai/MobBrain.js` steers the creature; the three role values switch it to
    // `ai/HorrorBrain.js`.
    behavior: definition.behavior ?? null,
    // Relative chance of being chosen when the spawner picks a hostile mob.
    spawnWeight: Math.max(0.01, Number(definition.spawnWeight) || 1),
    tileName: definition.tileName ?? `mob_${id}`,
    tile: -1,
    shape: Object.freeze([...definition.shape]),
    drops: Object.freeze(
      (definition.drops ?? []).map((drop) =>
        Object.freeze({
          item: drop.item,
          min: drop.min ?? 1,
          max: drop.max ?? drop.min ?? 1,
          chance: drop.chance ?? 1,
        })
      )
    ),
    // Hostiles despawn when the player leaves; farm animals do not, or a player
    // would return to an empty pen.
    despawns: definition.despawns ?? hostile,
    spawnGroupMin: definition.spawnGroupMin ?? 1,
    spawnGroupMax: definition.spawnGroupMax ?? (hostile ? 2 : 3),
    breedingItems: Object.freeze([...(definition.breedingItems ?? [])]),
    tamingItems: Object.freeze([...(definition.tamingItems ?? [])]),
    rideable: definition.rideable === true,
    // Phase 4. Bosses are built by a summon ritual, so the spawner must skip
    // them even though they are hostile and belong to a dimension.
    boss: definition.boss === true,
    babyScale: Math.max(0.25, Math.min(0.9, Number(definition.babyScale) || 0.55)),
    growthSeconds: Math.max(30, Number(definition.growthSeconds) || 1200),
    lootTable: independentDropTable(definition.drops ?? []),
  };

  if (resolved.maxHealth <= 0) throw new Error(`Mob "${id}" has non-positive health`);
  if (resolved.loseRange <= resolved.detectRange) {
    // A lose range at or below the detect range makes a mob flicker between
    // chasing and idling at exactly the detection boundary.
    throw new Error(`Mob "${id}" must lose interest further away than it detects`);
  }
  if (hostile && resolved.attackDamage <= 0) {
    throw new Error(`Hostile mob "${id}" deals no damage`);
  }
  if (resolved.spawnGroupMin > resolved.spawnGroupMax) {
    throw new Error(`Mob "${id}" has an inverted spawn group range`);
  }
  for (const breedingItem of resolved.breedingItems) {
    if (typeof breedingItem !== 'string' || !/^[a-z0-9_]+$/.test(breedingItem)) {
      throw new Error(`Mob "${id}" has invalid breeding item "${breedingItem}"`);
    }
  }
  for (const drop of resolved.drops) {
    if (drop.min > drop.max) throw new Error(`Mob "${id}" has an inverted drop range`);
    if (drop.chance <= 0 || drop.chance > 1) {
      throw new Error(`Mob "${id}" has an out-of-range drop chance`);
    }
  }

  return Object.freeze(resolved);
}

const SMALL_QUADRUPED = quadruped({bodyLength:.62,bodyWidth:.4,bodyHeight:.38,legHeight:.32,headSize:.34});
const LARGE_QUADRUPED = quadruped({bodyLength:1.35,bodyWidth:.72,bodyHeight:.75,legHeight:.85,headSize:.5});
const SPIDER_SHAPE = Object.freeze([
  box([.85,.28,.9],[0,.28,0],Limb.BODY), box([.55,.34,.48],[0,.32,.55],Limb.HEAD,1.08),
  ...[-1,1].flatMap((side)=>[-.38,-.13,.13,.38].map((z,index)=>box([.72,.09,.1],[side*.58,.24,z],index%2?Limb.LEG_A:Limb.LEG_B,.86))),
]);
const FISH_SHAPE = Object.freeze([box([.38,.34,.78],[0,.38,0],Limb.BODY),box([.32,.3,.3],[0,.4,.48],Limb.HEAD,1.08),box([.12,.5,.34],[0,.4,-.48],Limb.DETAIL,.9)]);
const BEE_SHAPE = Object.freeze([box([.5,.42,.62],[0,.48,0],Limb.BODY),box([.46,.08,.42],[-.3,.68,0],Limb.LEG_A,.94),box([.46,.08,.42],[.3,.68,0],Limb.LEG_B,.94)]);
const SLIME_SHAPE = Object.freeze([box([.8,.8,.8],[0,.4,0],Limb.BODY),box([.48,.48,.48],[0,.45,.18],Limb.HEAD,1.12)]);
const WITHER_SHAPE = Object.freeze([
  box([.6,1.3,.5],[0,1.6,0],Limb.BODY),
  box([1.9,.32,.34],[0,2.5,0],Limb.DETAIL,.95),
  box([.62,.62,.62],[0,3.1,0],Limb.HEAD,1.1),
  box([.5,.5,.5],[-.78,2.86,0],Limb.LEG_A,1),
  box([.5,.5,.5],[.78,2.86,0],Limb.LEG_B,1),
  box([.34,.7,.3],[0,.75,0],Limb.DETAIL,.9),
]);

const EXPANDED_MOBS = Object.freeze([
  mob({id:'horse',family:MobFamily.PASSIVE,maxHealth:24,height:1.65,halfSize:.55,walkSpeed:1.8,chaseSpeed:4,breedingItems:['apple','carrot'],tamingItems:['apple'],rideable:true,shape:LARGE_QUADRUPED,drops:[{item:'leather',min:0,max:2}]}),
  mob({id:'donkey',family:MobFamily.PASSIVE,maxHealth:22,height:1.55,halfSize:.52,walkSpeed:1.6,breedingItems:['apple','carrot'],tamingItems:['apple'],rideable:true,shape:LARGE_QUADRUPED,drops:[{item:'leather',min:0,max:2}]}),
  mob({id:'llama',family:MobFamily.NEUTRAL,maxHealth:22,height:1.85,halfSize:.48,walkSpeed:1.5,attackDamage:2,breedingItems:['wheat'],tamingItems:['wheat'],rideable:true,shape:LARGE_QUADRUPED,drops:[{item:'leather',min:0,max:2}]}),
  mob({id:'rabbit',family:MobFamily.PASSIVE,maxHealth:3,height:.55,halfSize:.22,walkSpeed:2.1,breedingItems:['carrot'],shape:SMALL_QUADRUPED,drops:[]}),
  mob({id:'fox',family:MobFamily.PASSIVE,maxHealth:10,height:.72,halfSize:.3,walkSpeed:2.2,breedingItems:['apple'],shape:SMALL_QUADRUPED,drops:[]}),
  mob({id:'wolf',family:MobFamily.NEUTRAL,maxHealth:16,height:.82,halfSize:.32,walkSpeed:1.9,chaseSpeed:3.5,attackDamage:4,breedingItems:['bone'],tamingItems:['bone'],shape:SMALL_QUADRUPED,drops:[]}),
  mob({id:'cat',family:MobFamily.PASSIVE,maxHealth:10,height:.7,halfSize:.27,walkSpeed:2,breedingItems:['raw_chicken'],tamingItems:['raw_chicken'],shape:SMALL_QUADRUPED,drops:[]}),
  mob({id:'bat',family:MobFamily.PASSIVE,maxHealth:6,height:.45,halfSize:.28,walkSpeed:2.2,breedingItems:['apple'],shape:BEE_SHAPE,drops:[],despawns:true}),
  mob({id:'squid',family:MobFamily.PASSIVE,maxHealth:10,height:.8,halfSize:.45,walkSpeed:1.4,breedingItems:['raw_chicken'],shape:FISH_SHAPE,drops:[]}),
  mob({id:'turtle',family:MobFamily.PASSIVE,maxHealth:20,height:.5,halfSize:.5,walkSpeed:.7,breedingItems:['wheat_seeds'],shape:SMALL_QUADRUPED,drops:[]}),
  mob({id:'bee',family:MobFamily.NEUTRAL,maxHealth:10,height:.55,halfSize:.3,walkSpeed:2.4,chaseSpeed:3.2,attackDamage:2,breedingItems:['red_flower','yellow_flower'],shape:BEE_SHAPE,drops:[]}),
  mob({id:'goat',family:MobFamily.NEUTRAL,maxHealth:10,height:1.25,halfSize:.42,walkSpeed:1.7,chaseSpeed:3.4,attackDamage:3,breedingItems:['wheat'],shape:quadruped({bodyLength:.95,bodyWidth:.58,bodyHeight:.58,legHeight:.62,headSize:.4}),drops:[]}),
  mob({id:'axolotl',family:MobFamily.PASSIVE,maxHealth:14,height:.42,halfSize:.3,walkSpeed:1.2,breedingItems:['raw_chicken'],shape:FISH_SHAPE,drops:[]}),
  mob({id:'frog',family:MobFamily.PASSIVE,maxHealth:10,height:.5,halfSize:.3,walkSpeed:1.4,breedingItems:['wheat_seeds'],shape:SMALL_QUADRUPED,drops:[]}),
  mob({id:'zombie',family:MobFamily.HOSTILE,maxHealth:20,height:1.85,halfSize:.32,walkSpeed:1.05,chaseSpeed:2.4,attackDamage:3,burnsInDaylight:true,shape:biped({}),drops:[{item:'bone',min:0,max:1}]}),
  mob({id:'skeleton',family:MobFamily.HOSTILE,maxHealth:20,height:1.8,halfSize:.3,walkSpeed:1.1,chaseSpeed:2,attackDamage:3,ranged:true,burnsInDaylight:true,shape:biped({limbThickness:.14}),drops:[{item:'bone',min:0,max:2},{item:'arrow',min:0,max:2}]}),
  mob({id:'creeper',family:MobFamily.HOSTILE,maxHealth:20,height:1.7,halfSize:.34,walkSpeed:1.05,chaseSpeed:2.5,attackDamage:12,attackCooldown:2,shape:quadruped({bodyLength:.55,bodyWidth:.55,bodyHeight:.9,legHeight:.55,headSize:.55,tail:false}),drops:[]}),
  mob({id:'spider',family:MobFamily.HOSTILE,maxHealth:16,height:.8,halfSize:.72,walkSpeed:1.5,chaseSpeed:3,attackDamage:3,shape:SPIDER_SHAPE,drops:[{item:'string',min:0,max:2}]}),
  mob({id:'slime',family:MobFamily.HOSTILE,maxHealth:12,height:.9,halfSize:.45,walkSpeed:1,chaseSpeed:2.2,attackDamage:2,shape:SLIME_SHAPE,drops:[{item:'clay_ball',min:0,max:1}]}),
  mob({id:'drowned',family:MobFamily.HOSTILE,maxHealth:20,height:1.85,halfSize:.32,walkSpeed:1,chaseSpeed:2.2,attackDamage:3,shape:biped({}),drops:[{item:'bone',min:0,max:1}]}),
  mob({id:'witch',family:MobFamily.HOSTILE,maxHealth:26,height:1.85,halfSize:.34,walkSpeed:1.1,chaseSpeed:1.8,attackDamage:3,ranged:true,shape:biped({}),drops:[{item:'string',min:0,max:2}]}),
  mob({id:'pillager',family:MobFamily.HOSTILE,maxHealth:24,height:1.85,halfSize:.34,walkSpeed:1.15,chaseSpeed:2.1,attackDamage:4,ranged:true,shape:biped({}),drops:[{item:'arrow',min:0,max:3}]}),
  mob({id:'ravager',family:MobFamily.HOSTILE,maxHealth:60,height:2.1,halfSize:.72,walkSpeed:1.1,chaseSpeed:3,attackDamage:8,shape:LARGE_QUADRUPED,drops:[]}),
  mob({id:'guardian',family:MobFamily.HOSTILE,maxHealth:30,height:.9,halfSize:.5,walkSpeed:1.2,chaseSpeed:2.4,attackDamage:5,ranged:true,shape:FISH_SHAPE,drops:[]}),
  mob({id:'villager',family:MobFamily.NEUTRAL,maxHealth:20,height:1.85,halfSize:.34,walkSpeed:1.1,attackDamage:1,shape:biped({}),drops:[],despawns:false}),
  mob({id:'iron_golem',family:MobFamily.NEUTRAL,maxHealth:100,height:2.7,halfSize:.68,walkSpeed:.8,chaseSpeed:2.2,attackDamage:9,shape:biped({torsoHeight:1.05,torsoWidth:.8,armLength:1.15,armThickness:.28,legLength:1.05,legThickness:.3,headSize:.62}),drops:[{item:'iron_ingot',min:2,max:5}],despawns:false}),
]);

/**
 * Phase 4. The Nether roster.
 *
 * These never appear in the Overworld: the spawner filters on `dimension`, so
 * adding a creature here is enough to make it Nether-only. Hostiles here ignore
 * light level, because the Nether has no sky and a torch would otherwise turn a
 * fortress into a safe room.
 */
const NETHER_MOBS = Object.freeze([
  mob({
    id: 'zombified_piglin', displayName: 'Zombified Piglin', family: MobFamily.NEUTRAL,
    dimension: 'nether', maxHealth: 20, height: 1.85, halfSize: 0.32,
    walkSpeed: 1.1, chaseSpeed: 2.5, attackDamage: 5, detectRange: 12, loseRange: 22,
    shape: biped({}), drops: [{ item: 'gold_ingot', min: 0, max: 1 }, { item: 'bone', min: 0, max: 1 }],
    spawnGroupMin: 2, spawnGroupMax: 4,
  }),
  mob({
    id: 'piglin', displayName: 'Piglin', family: MobFamily.NEUTRAL,
    dimension: 'nether', maxHealth: 16, height: 1.8, halfSize: 0.32,
    walkSpeed: 1.2, chaseSpeed: 2.6, attackDamage: 5, detectRange: 14, loseRange: 24,
    shape: biped({}), drops: [{ item: 'gold_nugget', min: 0, max: 3 }, { item: 'arrow', min: 0, max: 1 }],
    spawnGroupMin: 2, spawnGroupMax: 3,
  }),
  mob({
    id: 'wither_skeleton', displayName: 'Wither Skeleton', family: MobFamily.HOSTILE,
    dimension: 'nether', maxHealth: 20, height: 2.2, halfSize: 0.32,
    walkSpeed: 1.15, chaseSpeed: 2.5, attackDamage: 7, maxLightToSpawn: 15,
    shape: biped({ torsoHeight: 0.85, legLength: 0.95, limbThickness: 0.14 }),
    drops: [{ item: 'bone', min: 0, max: 2 }, { item: 'coal', min: 0, max: 1 },
      { item: 'wither_skeleton_skull', min: 1, max: 1, chance: 0.05 }],
    spawnGroupMin: 1, spawnGroupMax: 3,
  }),
  mob({
    id: 'blaze', displayName: 'Blaze', family: MobFamily.HOSTILE,
    dimension: 'nether', maxHealth: 20, height: 1.6, halfSize: 0.3,
    walkSpeed: 1.3, chaseSpeed: 2.4, attackDamage: 6, ranged: true, maxLightToSpawn: 15,
    detectRange: 20, loseRange: 30,
    shape: SLIME_SHAPE, drops: [{ item: 'blaze_rod', min: 0, max: 2 }, { item: 'glowstone_dust', min: 0, max: 1 }],
    spawnGroupMin: 1, spawnGroupMax: 2,
  }),
  mob({
    id: 'ghast', displayName: 'Ghast', family: MobFamily.HOSTILE,
    dimension: 'nether', maxHealth: 10, height: 3.6, halfSize: 1.8,
    walkSpeed: 0.9, chaseSpeed: 1.4, attackDamage: 6, ranged: true, maxLightToSpawn: 15,
    detectRange: 48, loseRange: 64, attackRange: 32,
    shape: FISH_SHAPE, drops: [{ item: 'ghast_tear', min: 0, max: 1 }, { item: 'gunpowder', min: 0, max: 2 }],
    spawnGroupMin: 1, spawnGroupMax: 1,
  }),
  mob({
    id: 'magma_cube', displayName: 'Magma Cube', family: MobFamily.HOSTILE,
    dimension: 'nether', maxHealth: 16, height: 0.9, halfSize: 0.45,
    walkSpeed: 1, chaseSpeed: 2.3, attackDamage: 4, maxLightToSpawn: 15,
    shape: SLIME_SHAPE, drops: [{ item: 'magma_cream', min: 0, max: 1 }],
    spawnGroupMin: 1, spawnGroupMax: 3,
  }),
  mob({
    id: 'hoglin', displayName: 'Hoglin', family: MobFamily.HOSTILE,
    dimension: 'nether', maxHealth: 40, height: 1.7, halfSize: 0.62,
    walkSpeed: 1.2, chaseSpeed: 3, attackDamage: 8, maxLightToSpawn: 15,
    shape: LARGE_QUADRUPED,
    drops: [{ item: 'raw_porkchop', min: 2, max: 4 }, { item: 'leather', min: 0, max: 1 }],
    spawnGroupMin: 1, spawnGroupMax: 3,
  }),
  mob({
    id: 'strider', displayName: 'Strider', family: MobFamily.PASSIVE,
    dimension: 'nether', maxHealth: 20, height: 1.5, halfSize: 0.45,
    walkSpeed: 0.9, rideable: true, breedingItems: ['warped_fungus'],
    shape: quadruped({ bodyLength: 0.9, bodyWidth: 0.7, bodyHeight: 0.85, legHeight: 0.85, headSize: 0.45 }),
    drops: [{ item: 'string', min: 0, max: 2 }],
    spawnGroupMin: 1, spawnGroupMax: 2,
  }),
  // Summon-only: see progression/WitherBoss.js for the soul-sand ritual. The
  // Nether Star it drops is the reward that gates the beacon.
  mob({
    id: 'wither', displayName: 'Wither', family: MobFamily.HOSTILE, boss: true,
    dimension: 'nether', maxHealth: 300, height: 3.5, halfSize: 0.45,
    walkSpeed: 1.2, chaseSpeed: 2.4, attackDamage: 8, ranged: true,
    detectRange: 40, loseRange: 60, attackRange: 24, despawns: false,
    shape: WITHER_SHAPE, drops: [{ item: 'nether_star', min: 1, max: 1 }],
    spawnGroupMin: 1, spawnGroupMax: 1,
  }),
]);

/** Every mob in the game. */
/**
 * Phase 5: the End roster.
 *
 * Tall, fast and fragile: 40 HP with a 0.3 half-size means an Enderman dies
 * quickly once cornered, but its reach and speed make it dangerous in the open.
 */
const END_MOBS = [
  mob({
    id: 'enderman', displayName: 'Enderman', family: MobFamily.HOSTILE,
    dimension: 'end', dimensions: ['overworld', 'end'],
    maxHealth: 40, height: 2.9, halfSize: 0.3, eyeHeight: 2.55,
    walkSpeed: 1.5, chaseSpeed: 3.2, attackDamage: 7, attackRange: 2.2,
    detectRange: 24, loseRange: 34, maxLightToSpawn: 7,
    shape: biped({ torsoHeight: 1.15, legLength: 1.35, limbThickness: 0.12 }),
    drops: [{ item: 'ender_pearl', min: 0, max: 1 }],
    spawnGroupMin: 1, spawnGroupMax: 2,
  }),
  mob({
    id: 'silverfish', displayName: 'Silverfish', family: MobFamily.HOSTILE,
    dimension: 'overworld', maxHealth: 8, height: 0.32, halfSize: 0.34,
    walkSpeed: 1.8, chaseSpeed: 3.5, attackDamage: 1, attackRange: 1.05,
    detectRange: 12, loseRange: 20, maxLightToSpawn: 15,
    shape: Object.freeze([
      box([0.62, 0.24, 0.34], [0, 0.14, 0], Limb.BODY, 1),
      box([0.24, 0.18, 0.24], [0, 0.16, 0.28], Limb.HEAD, 1.08),
    ]),
    drops: [], spawnGroupMin: 1, spawnGroupMax: 3,
  }),
  mob({
    id: 'shulker', displayName: 'Shulker', family: MobFamily.HOSTILE,
    dimension: 'end', maxHealth: 30, height: 1, halfSize: 0.48,
    walkSpeed: 0.05, chaseSpeed: 0.1, attackDamage: 4, ranged: true,
    attackCooldown: 2.5, attackRange: 16, detectRange: 18, loseRange: 28,
    maxLightToSpawn: 15, despawns: false,
    shape: SLIME_SHAPE,
    drops: [{ item: 'shulker_shell', min: 0, max: 1, chance: 0.5 }],
    spawnGroupMin: 1, spawnGroupMax: 1,
  }),
  // Rendering catalogue entry for the dedicated boss runtime. `boss:true`
  // prevents the ambient spawner from ever creating a second dragon.
  mob({
    id: 'ender_dragon', displayName: 'Ender Dragon', family: MobFamily.HOSTILE,
    boss: true, dimension: 'end', maxHealth: 200, height: 4, halfSize: 3.2,
    walkSpeed: 3, chaseSpeed: 12, attackDamage: 10, ranged: true,
    attackRange: 32, detectRange: 96, loseRange: 160, maxLightToSpawn: 15,
    despawns: false,
    shape: Object.freeze([
      box([3.2, 1.4, 5.4], [0, 2.2, 0], Limb.BODY, 1),
      box([1.5, 1.3, 1.8], [0, 2.4, 3.2], Limb.HEAD, 1.08),
      box([6.5, 0.2, 2.4], [-3.5, 2.8, 0], Limb.LEG_A, 0.86),
      box([6.5, 0.2, 2.4], [3.5, 2.8, 0], Limb.LEG_B, 0.86),
      box([0.9, 0.9, 5.5], [0, 2.2, -5], Limb.DETAIL, 0.9),
    ]),
    drops: [], spawnGroupMin: 1, spawnGroupMax: 1,
  }),
];

export const MOB_DEFINITIONS = Object.freeze([
  // ------------------------------------------------------------------ passive
  mob({
    id: 'cow',
    displayName: 'Meadow Cow',
    family: MobFamily.PASSIVE,
    maxHealth: 10,
    halfSize: 0.45,
    height: 1.3,
    walkSpeed: 1.1,
    breedingItems: ['wheat'],
    shape: quadruped({ bodyLength: 1.15, bodyWidth: 0.68, bodyHeight: 0.62, legHeight: 0.6, headSize: 0.5 }),
    drops: [
      { item: 'raw_beef', min: 1, max: 3 },
      { item: 'leather', min: 0, max: 2 },
    ],
    spawnGroupMin: 2,
    spawnGroupMax: 4,
  }),
  mob({
    id: 'pig',
    displayName: 'Bristle Pig',
    family: MobFamily.PASSIVE,
    maxHealth: 10,
    halfSize: 0.42,
    height: 1.0,
    walkSpeed: 1.3,
    breedingItems: ['carrot', 'potato'],
    shape: quadruped({ bodyLength: 1.0, bodyWidth: 0.6, bodyHeight: 0.55, legHeight: 0.42, headSize: 0.42 }),
    drops: [{ item: 'raw_porkchop', min: 1, max: 3 }],
    spawnGroupMin: 2,
    spawnGroupMax: 4,
  }),
  mob({
    id: 'sheep',
    displayName: 'Fleece Sheep',
    family: MobFamily.PASSIVE,
    maxHealth: 8,
    halfSize: 0.42,
    height: 1.2,
    walkSpeed: 1.2,
    breedingItems: ['wheat'],
    shape: quadruped({ bodyLength: 1.05, bodyWidth: 0.66, bodyHeight: 0.66, legHeight: 0.5, headSize: 0.42 }),
    drops: [
      { item: 'raw_mutton', min: 1, max: 2 },
      // Wool is the reason to keep sheep rather than eat them.
      { item: 'white_wool', min: 1, max: 1 },
    ],
    spawnGroupMin: 2,
    spawnGroupMax: 4,
  }),
  mob({
    id: 'chicken',
    displayName: 'Speckled Hen',
    family: MobFamily.PASSIVE,
    maxHealth: 4,
    halfSize: 0.22,
    height: 0.7,
    walkSpeed: 1.5,
    breedingItems: ['wheat_seeds'],
    babyScale: 0.48,
    shape: Object.freeze([
      box([0.34, 0.34, 0.42], [0, 0.42, 0], Limb.BODY, 1),
      box([0.26, 0.26, 0.24], [0, 0.68, 0.2], Limb.HEAD, 1.1),
      // A beak, which is most of what makes it read as a bird.
      box([0.08, 0.07, 0.12], [0, 0.66, 0.36], Limb.DETAIL, 0.8),
      box([0.06, 0.1, 0.12], [0, 0.8, 0.18], Limb.DETAIL, 0.7),
      box([0.08, 0.26, 0.08], [-0.09, 0.13, 0], Limb.LEG_A, 0.78),
      box([0.08, 0.26, 0.08], [0.09, 0.13, 0], Limb.LEG_B, 0.78),
      // Wings.
      box([0.06, 0.24, 0.3], [-0.19, 0.44, 0], Limb.LEG_B, 0.9),
      box([0.06, 0.24, 0.3], [0.19, 0.44, 0], Limb.LEG_A, 0.9),
    ]),
    drops: [
      { item: 'raw_chicken', min: 1, max: 1 },
      { item: 'feather', min: 0, max: 2 },
    ],
    spawnGroupMin: 2,
    spawnGroupMax: 4,
  }),

  // ------------------------------------------------------------------ hostile
  mob({
    id: 'husk',
    displayName: 'Hollow Husk',
    family: MobFamily.HOSTILE,
    maxHealth: 20,
    halfSize: 0.32,
    height: 1.85,
    walkSpeed: 1.0,
    chaseSpeed: 2.3,
    attackDamage: 3,
    attackCooldown: 1.1,
    attackRange: 1.7,
    detectRange: 18,
    loseRange: 30,
    burnsInDaylight: true,
    shape: biped({ shoulderWidth: 0.52, torsoHeight: 0.66, legHeight: 0.78, headSize: 0.48 }),
    drops: [{ item: 'bone', min: 0, max: 2 }],
    spawnGroupMin: 1,
    spawnGroupMax: 3,
  }),
  mob({
    id: 'bonecaster',
    displayName: 'Bonecaster',
    family: MobFamily.HOSTILE,
    maxHealth: 16,
    halfSize: 0.3,
    height: 1.8,
    walkSpeed: 1.1,
    chaseSpeed: 2.0,
    attackDamage: 3,
    // Slower than melee, because a ranged attacker that fires as fast as a melee
    // mob swings is strictly better and makes melee mobs pointless.
    attackCooldown: 1.8,
    // Keeps its distance and shoots.
    attackRange: 12,
    detectRange: 20,
    loseRange: 32,
    ranged: true,
    burnsInDaylight: true,
    shape: biped({ shoulderWidth: 0.46, torsoHeight: 0.6, legHeight: 0.76, headSize: 0.44, limbThickness: 0.12 }),
    drops: [
      { item: 'bone', min: 1, max: 3 },
      { item: 'stick', min: 0, max: 1 },
    ],
    spawnGroupMin: 1,
    spawnGroupMax: 2,
  }),
  mob({
    id: 'lurker',
    displayName: 'Cave Lurker',
    family: MobFamily.HOSTILE,
    maxHealth: 12,
    // Wide and flat, so it reads as a spider from any angle.
    halfSize: 0.6,
    height: 0.7,
    eyeHeight: 0.55,
    walkSpeed: 1.6,
    // Fast: the threat is that it closes distance, not that it hits hard.
    chaseSpeed: 3.6,
    attackDamage: 2,
    attackCooldown: 0.9,
    attackRange: 1.5,
    detectRange: 16,
    loseRange: 26,
    // Does not burn: it lives in caves.
    burnsInDaylight: false,
    shape: Object.freeze([
      box([0.7, 0.36, 0.5], [0, 0.34, -0.1], Limb.BODY, 1),
      box([0.44, 0.3, 0.36], [0, 0.34, 0.36], Limb.HEAD, 1.08),
      // Eight legs in four phase pairs, splayed wide.
      box([0.5, 0.1, 0.1], [-0.5, 0.3, 0.2], Limb.LEG_A, 0.8),
      box([0.5, 0.1, 0.1], [0.5, 0.3, 0.2], Limb.LEG_B, 0.8),
      box([0.5, 0.1, 0.1], [-0.5, 0.3, 0.02], Limb.LEG_B, 0.8),
      box([0.5, 0.1, 0.1], [0.5, 0.3, 0.02], Limb.LEG_A, 0.8),
      box([0.5, 0.1, 0.1], [-0.5, 0.3, -0.16], Limb.LEG_A, 0.8),
      box([0.5, 0.1, 0.1], [0.5, 0.3, -0.16], Limb.LEG_B, 0.8),
      box([0.5, 0.1, 0.1], [-0.5, 0.3, -0.34], Limb.LEG_B, 0.8),
      box([0.5, 0.1, 0.1], [0.5, 0.3, -0.34], Limb.LEG_A, 0.8),
    ]),
    drops: [{ item: 'string', min: 0, max: 2 }],
    spawnGroupMin: 1,
    spawnGroupMax: 2,
  }),

  // ------------------------------------------------------- horror roster roles
  // Three creatures the horror pass is built around. They share the mob pipeline
  // (physics, pools, saves, rendering) and differ only in `behavior`, which hands
  // their decisions to `ai/HorrorBrain.js`.
  mob({
    id: 'walker',
    displayName: 'The Walker',
    family: MobFamily.HOSTILE,
    // A patient stalker: it does not outrun the player, it outlasts them.
    maxHealth: 34,
    halfSize: 0.34,
    height: 2.05,
    walkSpeed: 0.85,
    chaseSpeed: 1.95,
    attackDamage: 6,
    attackCooldown: 1.5,
    attackRange: 1.9,
    detectRange: 15,
    loseRange: 32,
    behavior: 'walker',
    spawnWeight: 1.5,
    shape: biped({ shoulderWidth: 0.46, torsoHeight: 0.8, legHeight: 0.98, headSize: 0.44, limbThickness: 0.14 }),
    drops: [{ item: 'bone', min: 0, max: 2 }],
    spawnGroupMin: 1,
    spawnGroupMax: 2,
  }),
  mob({
    id: 'hunter',
    displayName: 'The Hunter',
    family: MobFamily.HOSTILE,
    // Built to punish running in a straight line: much faster than a sprint, but
    // fragile, so a prepared player can turn and fight.
    maxHealth: 26,
    halfSize: 0.44,
    height: 1.3,
    eyeHeight: 1.02,
    walkSpeed: 1.7,
    // Slightly faster than a sprint (5.62 m/s): running in a straight line is
    // supposed to be the wrong answer.
    chaseSpeed: 5.8,
    attackDamage: 5,
    attackCooldown: 0.95,
    attackRange: 1.8,
    detectRange: 20,
    loseRange: 40,
    behavior: 'hunter',
    spawnWeight: 1.1,
    shape: quadruped({ bodyLength: 1.5, bodyWidth: 0.48, bodyHeight: 0.52, legHeight: 0.82, headSize: 0.44 }),
    drops: [
      { item: 'leather', min: 0, max: 1 },
      { item: 'bone', min: 0, max: 1 },
    ],
    spawnGroupMin: 1,
    spawnGroupMax: 1,
  }),
  mob({
    id: 'stalker',
    displayName: 'The Stalker',
    family: MobFamily.HOSTILE,
    // Barely a combatant: it watches from the fog and is gone when you look
    // straight at it. The damage exists so the hostile contract stays valid.
    maxHealth: 18,
    halfSize: 0.3,
    height: 2.15,
    walkSpeed: 1.25,
    chaseSpeed: 4.6,
    attackDamage: 2,
    attackCooldown: 2.4,
    attackRange: 1.6,
    detectRange: 26,
    loseRange: 44,
    behavior: 'stalker',
    spawnWeight: 0.85,
    shape: biped({ shoulderWidth: 0.3, torsoHeight: 0.95, legHeight: 1.15, headSize: 0.38, limbThickness: 0.1 }),
    drops: [{ item: 'string', min: 0, max: 2 }],
    spawnGroupMin: 1,
    spawnGroupMax: 1,
  }),
  ...EXPANDED_MOBS,
  ...NETHER_MOBS,
  ...END_MOBS,
]);

/** Ids of every mob, in definition order. */
export const MOB_IDS = Object.freeze(MOB_DEFINITIONS.map((definition) => definition.id));

/** Mobs by family, for the spawner's caps. */
export const PASSIVE_MOBS = Object.freeze(
  MOB_DEFINITIONS.filter((d) => d.family === MobFamily.PASSIVE).map((d) => d.id)
);
export const HOSTILE_MOBS = Object.freeze(
  MOB_DEFINITIONS.filter((d) => d.family === MobFamily.HOSTILE).map((d) => d.id)
);

/** @type {Map<string, MobDefinition>} */
const BY_ID = new Map(MOB_DEFINITIONS.map((definition) => [definition.id, definition]));

/**
 * @param {string} id
 * @returns {MobDefinition|null}
 */
export function getMob(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidMobId(id) {
  return typeof id === 'string' && BY_ID.has(id);
}

/**
 * Rolls a mob's drops.
 *
 * Takes a random function so the caller controls the stream, which is what lets
 * the self-test assert bounds deterministically instead of relying on luck.
 *
 * @param {string} mobId
 * @param {() => number} random
 * @returns {Array<{item: string, count: number}>}
 */
export function rollDrops(mobId, random = Math.random) {
  const definition = BY_ID.get(mobId);
  if (!definition) return [];

  return rollLootTable(definition.lootTable, { random });
}

/** Snapshot for the debug overlay and the audit. */
export function describeMobs() {
  return {
    total: MOB_DEFINITIONS.length,
    passive: PASSIVE_MOBS.length,
    hostile: HOSTILE_MOBS.length,
    ranged: MOB_DEFINITIONS.filter((d) => d.ranged).length,
  };
}

export default MOB_DEFINITIONS;
