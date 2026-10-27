/**
 * Entity pools and their rendering.
 *
 * ## One draw call per entity type
 *
 * Items and falling blocks are drawn with `InstancedMesh`. Each instance carries
 * its three atlas tile indices (top, side, bottom) as an instanced attribute, and
 * the vertex shader turns a tile index into a UV rect using the atlas layout
 * constants. So a hundred dropped items of thirty different block types is still
 * *one* draw call with *one* material — no per-block material, no per-entity mesh,
 * and correct per-face textures for blocks like grass whose faces differ.
 *
 * The alternative (a `Mesh` per entity) would mean a scene-graph insertion and
 * removal for every block broken, which is precisely the churn the spec warns
 * about.
 *
 * ## Pooling
 *
 * Both entity types come from fixed-size pools. When the pool is exhausted the
 * oldest entity is recycled rather than the spawn being dropped, so a cave-in
 * always looks right at the front even if the tail is truncated.
 */

import * as THREE from 'three';

import { ENTITIES, FACE_NY, FACE_PX, FACE_PY } from '../config/GameConfig.js';
import {
  ATLAS_COLUMNS,
  ATLAS_PIXELS,
  TILE_PADDING,
  TILE_PIXELS,
  TILE_STRIDE,
} from '../world/AtlasLayout.js';
import { FACE_TILES } from '../world/BlockRegistry.js';
import { ItemStack } from '../items/ItemStack.js';
import { blockIdForItem, getItem, itemIdForBlock } from '../items/ItemRegistry.js';
import { Events } from '../core/EventBus.js';
import { ItemEntity } from './ItemEntity.js';
import { FallingBlockEntity } from './FallingBlockEntity.js';
import { MobEntity } from './MobEntity.js';
import { MobRenderer } from './MobRenderer.js';
import { MobSpawner } from './MobSpawner.js';
import { mobSound } from './MobSounds.js';
import { ProjectileEntity } from './ProjectileEntity.js';
import { raycastBox } from '../interaction/CombatSystem.js';
import { getDifficulty } from '../gameplay/Difficulty.js';

/** Item cube edge length, in blocks. */
const ITEM_SCALE = 0.3;

const ENTITY_VERTEX_SHADER = /* glsl */ `
  // Per-vertex: which face class this vertex belongs to (0 side, 1 top, 2 bottom).
  attribute float aFaceClass;
  // Per-instance: atlas tile indices for [top, side, bottom].
  attribute vec3 aTiles;

  uniform float uAtlasColumns;
  uniform float uTileScale;    // tile size in UV units
  uniform float uStrideScale;  // cell stride in UV units
  uniform float uPaddingScale; // padding offset in UV units

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying float vViewDepth;

  void main() {
    float tile = aFaceClass < 0.5 ? aTiles.y : (aFaceClass < 1.5 ? aTiles.x : aTiles.z);

    // Tile index -> grid cell -> UV origin. Mirrors AtlasLayout exactly.
    float column = mod(tile, uAtlasColumns);
    float row = floor(tile / uAtlasColumns);
    vec2 origin = vec2(column, row) * uStrideScale + uPaddingScale;
    vUv = origin + uv * uTileScale;

    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);

    vec4 viewPosition = viewMatrix * worldPosition;
    vViewDepth = -viewPosition.z;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const ENTITY_FRAGMENT_SHADER = /* glsl */ `
  // Three's fragment prefix already defines the colour-space and tone-mapping
  // helpers; only the call-site chunks may be included here.
  #include <common>

  uniform sampler2D uAtlas;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uSkyAmbient;
  uniform vec3 uGroundAmbient;
  uniform float uCaveAmbient;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uFogStrength;
  uniform float uBrightness;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying float vViewDepth;

  void main() {
    vec4 texel = texture2D(uAtlas, vUv);
    if (texel.a < 0.4) discard;

    vec3 normal = normalize(vWorldNormal);
    float hemisphere = normal.y * 0.5 + 0.5;
    vec3 ambient = mix(uGroundAmbient, uSkyAmbient, hemisphere);
    float ndotl = max(dot(normal, uSunDirection), 0.0);

    vec3 lighting = ambient + uSunColor * ndotl * 0.85 + vec3(uCaveAmbient);
    vec3 color = texel.rgb * lighting * uBrightness;

    float fog = smoothstep(uFogNear, uFogFar, vViewDepth) * uFogStrength;
    color = mix(color, uFogColor, fog);

    gl_FragColor = vec4(color, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class EntityManager {
  /**
   * @param {Object} options
   * @param {THREE.Scene} options.scene
   * @param {import('../world/World.js').World} options.world
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../core/ResourceManager.js').ResourceManager} options.resources
   * @param {THREE.Texture} options.atlasTexture
   * @param {string} [options.difficulty]
   */
  constructor({ scene, world, bus, settings, resources, atlasTexture, difficulty = 'normal' }) {
    this._scene = scene;
    this._world = world;
    this._bus = bus;
    this._settings = settings;
    this._resources = resources;
    this._difficulty = getDifficulty(difficulty);

    /** @type {ItemEntity[]} */
    /**
     * Pools whose entities can be attacked.
     *
     * Empty for now: items and falling blocks are not valid targets. Mob pools
     * register themselves here, which keeps `CombatSystem` unaware of what kinds
     * of mob exist.
     * @type {Array<Array<import('./Entity.js').Entity>>}
     */
    this._livingPools = [];

    /**
     * Latch for the "inventory full" warning.
     *
     * Without it the message would fire every frame the player stands on a pile
     * they cannot pick up, which is a notification storm rather than a warning.
     */
    this._warnedFull = false;

    this.items = Array.from({ length: ENTITIES.maxItemEntities }, () => new ItemEntity());
    /** @type {FallingBlockEntity[]} */
    this.fallingBlocks = Array.from(
      { length: ENTITIES.maxFallingBlocks },
      () => new FallingBlockEntity()
    );
    /** @type {MobEntity[]} */
    this.mobs = Array.from({ length: ENTITIES.maxMobs }, () => new MobEntity());
    this.registerLivingPool(this.mobs);
    /** @type {ProjectileEntity[]} */
    this.projectiles = Array.from(
      { length: ENTITIES.maxProjectiles },
      () => new ProjectileEntity()
    );

    this._itemCursor = 0;
    this._fallingCursor = 0;
    this._mobCursor = 0;
    this._projectileCursor = 0;
    this._mobSpawnSerial = 0;
    this._entityIdSerial = 0;
    this._entitySessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    this._geometry = this._createCubeGeometry();
    this._material = this._createMaterial(atlasTexture);

    this.itemMesh = this._createInstancedMesh('item-entities', ENTITIES.maxItemEntities);
    this.fallingMesh = this._createInstancedMesh('falling-blocks', ENTITIES.maxFallingBlocks);
    this.projectileMesh = this._createInstancedMesh('projectiles', ENTITIES.maxProjectiles);
    scene.add(this.itemMesh);
    scene.add(this.fallingMesh);
    scene.add(this.projectileMesh);

    this.mobRenderer = new MobRenderer({ scene, atlasTexture, resources });
    this.mobSpawner = new MobSpawner(world.seed, this._difficulty);

    resources.acquireShared('entities:geometry', () => this._geometry);
    resources.acquireShared('entities:material', () => this._material);

    this._matrix = new THREE.Matrix4();
    this._quaternion = new THREE.Quaternion();
    this._position = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._forwardAxis = new THREE.Vector3(0, 0, 1);
    this._projectileDirection = new THREE.Vector3();

    /** Set by `Game` so items can be collected. */
    this.collectTarget = null;
  }

  /** Number of live items. */
  get liveItemCount() {
    let count = 0;
    for (const item of this.items) if (item.alive) count++;
    return count;
  }

  /** Number of live falling blocks. */
  get liveFallingCount() {
    let count = 0;
    for (const block of this.fallingBlocks) if (block.alive) count++;
    return count;
  }

  /** Number of live creatures, including a short death animation. */
  get liveMobCount() {
    let count = 0;
    for (const mob of this.mobs) if (mob.alive) count++;
    return count;
  }

  get liveProjectileCount() {
    let count = 0;
    for (const projectile of this.projectiles) if (projectile.alive) count++;
    return count;
  }

  // ------------------------------------------------------------------ geometry

  /**
   * A unit cube whose UVs run 0..1 per face, plus a per-vertex face class the
   * shader uses to pick between the top, side and bottom tiles.
   */
  _createCubeGeometry() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const normals = geometry.getAttribute('normal');
    const faceClass = new Float32Array(normals.count);
    for (let i = 0; i < normals.count; i++) {
      const normalY = normals.getY(i);
      // BoxGeometry emits axis-aligned faces, so the Y normal identifies them.
      faceClass[i] = normalY > 0.5 ? 1 : normalY < -0.5 ? 2 : 0;
    }
    geometry.setAttribute('aFaceClass', new THREE.BufferAttribute(faceClass, 1));
    return geometry;
  }

  _createMaterial(atlasTexture) {
    return new THREE.ShaderMaterial({
      name: 'entity-cubes',
      uniforms: {
        uAtlas: { value: atlasTexture },
        uAtlasColumns: { value: ATLAS_COLUMNS },
        uTileScale: { value: TILE_PIXELS / ATLAS_PIXELS },
        uStrideScale: { value: TILE_STRIDE / ATLAS_PIXELS },
        uPaddingScale: { value: TILE_PADDING / ATLAS_PIXELS },

        uSunDirection: { value: new THREE.Vector3(0.4, 0.85, 0.3).normalize() },
        uSunColor: { value: new THREE.Color(1, 0.97, 0.9) },
        uSkyAmbient: { value: new THREE.Color(0.42, 0.5, 0.62) },
        uGroundAmbient: { value: new THREE.Color(0.2, 0.19, 0.16) },
        uCaveAmbient: { value: 0.035 },
        uFogColor: { value: new THREE.Color(0.62, 0.74, 0.9) },
        uFogNear: { value: 40 },
        uFogFar: { value: 160 },
        uFogStrength: { value: 1 },
        uBrightness: { value: 1 },
      },
      vertexShader: ENTITY_VERTEX_SHADER,
      fragmentShader: ENTITY_FRAGMENT_SHADER,
      fog: false,
      toneMapped: true,
    });
  }

  _createInstancedMesh(name, capacity) {
    const mesh = new THREE.InstancedMesh(this._geometry, this._material, capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    // Per-instance tile indices. `InstancedBufferAttribute` on the shared geometry
    // would be wrong (both meshes would share it), so it is attached to a cloned
    // geometry per mesh.
    const tiles = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    tiles.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry = this._geometry.clone();
    mesh.geometry.setAttribute('aTiles', tiles);
    this._resources.trackTransient(mesh.geometry);

    return mesh;
  }

  // -------------------------------------------------------------------- spawning

  /**
   * Spawns a dropped item from a stack.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {import('../items/ItemStack.js').ItemStack} stack Handed to the entity.
   * @param {{x: number, y: number, z: number}} [impulse]
   * @returns {ItemEntity|null}
   */
  spawnItemStack(x, y, z, stack, impulse = null) {
    if (!stack || stack.isEmpty) return null;
    if (!this._settings.get('gameplay.dropItems')) return null;
    const item = this._takeFromPool(this.items, '_itemCursor');
    if (!item) return null;
    item.spawn(x, y, z, stack, impulse);
    item.uuid = this._newEntityId('item');
    return item;
  }

  /**
   * Spawns a dropped item addressed by block id.
   *
   * Kept because the world's `onBlockDrop` hook speaks in block ids; it resolves
   * to the placing item so the drop is a real `ItemStack` like any other.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} blockId
   * @param {number} [count]
   * @returns {ItemEntity|null}
   */
  spawnItem(x, y, z, blockId, count = 1) {
    const itemId = itemIdForBlock(blockId);
    // A block with no item (water, air) simply does not drop.
    if (!itemId) return null;
    return this.spawnItemStack(x, y, z, new ItemStack(itemId, count));
  }

  /**
   * Spawns a falling block.
   *
   * @param {number} blockX
   * @param {number} blockY
   * @param {number} blockZ
   * @param {number} blockId
   * @returns {boolean} False when the pool is exhausted, so the caller can leave
   *   the block in place rather than deleting it.
   */
  spawnFallingBlock(blockX, blockY, blockZ, blockId) {
    if (!this._settings.get('gameplay.fallingBlocks')) return false;
    const entity = this._takeFromPool(this.fallingBlocks, '_fallingCursor');
    if (!entity) return false;
    entity.spawn(blockX, blockY, blockZ, blockId);
    return true;
  }

  /**
   * Spawns one living creature from the fixed pool.
   * @returns {MobEntity|null}
   */
  spawnMob(mobId, x, y, z, seed = 0) {
    const entity = this._takeFromPool(this.mobs, '_mobCursor');
    if (!entity) return null;
    try {
      entity.spawn(
        mobId,
        x,
        y,
        z,
        seed || ((this._world.seed ^ ++this._mobSpawnSerial) >>> 0)
      );
      entity.applyDifficulty(this._difficulty, true, true);
      entity.uuid = this._newEntityId('mob');
    } catch (error) {
      entity.kill();
      console.warn('[EntityManager] refused mob spawn', error);
      return null;
    }
    this._bus.emit(Events.MOB_SPAWNED, { mob: entity, mobId, x, y, z });
    return entity;
  }

  /** Spawns an arrow from either a player or a mob. */
  spawnProjectile(x, y, z, direction, options = {}) {
    const projectile = this._takeFromPool(this.projectiles, '_projectileCursor');
    if (!projectile) return null;
    try {
      return projectile.spawn(x, y, z, direction, options);
    } catch (error) {
      projectile.kill();
      console.warn('[EntityManager] refused projectile spawn', error);
      return null;
    }
  }

  _newEntityId(kind) {
    this._entityIdSerial++;
    return `${kind}-${this._entitySessionId}-${this._entityIdSerial.toString(36)}`;
  }

  /**
   * Serialises persistent world entities. Projectiles and falling blocks are
   * intentionally transient; saving them mid-flight would duplicate impacts or
   * block settlement when a world is resumed.
   */
  toJSON() {
    const mobs = [];
    const items = [];
    for (const mob of this.mobs) {
      const record = mob.toJSON?.();
      if (record) mobs.push(record);
    }
    for (const item of this.items) {
      const record = item.toJSON?.();
      if (record) items.push(record);
    }
    return { version: 1, mobs, items };
  }

  /** Restores a bounded, validated entity snapshot from a world record. */
  fromJSON(data) {
    for (const item of this.items) item.kill();
    for (const mob of this.mobs) mob.kill();
    for (const projectile of this.projectiles) projectile.kill();
    for (const block of this.fallingBlocks) block.kill();

    let restoredMobs = 0;
    let restoredItems = 0;
    if (data && typeof data === 'object') {
      for (const record of Array.isArray(data.mobs) ? data.mobs : []) {
        if (restoredMobs >= this.mobs.length) break;
        const entity = this._takeFromPool(this.mobs, '_mobCursor');
        if (!entity?.fromJSON?.(record)) {
          entity?.kill();
          continue;
        }
        entity.applyDifficulty(this._difficulty);
        if (!entity.uuid) entity.uuid = this._newEntityId('mob');
        restoredMobs++;
      }
      for (const record of Array.isArray(data.items) ? data.items : []) {
        if (restoredItems >= this.items.length) break;
        const entity = this._takeFromPool(this.items, '_itemCursor');
        if (!entity?.fromJSON?.(record)) {
          entity?.kill();
          continue;
        }
        if (!entity.uuid) entity.uuid = this._newEntityId('item');
        restoredItems++;
      }
    }

    this._syncInstances();
    this.mobRenderer.sync(this.mobs);
    return { mobs: restoredMobs, items: restoredItems };
  }

  /**
   * Every entity that can be attacked.
   *
   * A generator rather than an array so the combat sweep allocates nothing per
   * swing.
   *
   * `_livingPools` holds `this.mobs`, so every spawned creature is attackable
   * through this one seam. Dropped items and falling blocks are deliberately not
   * in the pool — they are entities, but they are not `living` ones, and adding
   * them would make an area-of-effect swing destroy the drops it just created.
   * Future attackable things (boats, minecarts, the Ender Dragon's crystals) join
   * by being pushed into a pool here rather than by editing `CombatSystem`.
   *
   * @returns {Generator<import('./Entity.js').Entity>}
   */
  *livingEntities() {
    for (const pool of this._livingPools) {
      for (const entity of pool) {
        if (entity.alive) yield entity;
      }
    }
  }


  /**
   * Feeds the nearest compatible passive creature along the player's use ray.
   * The targeted block bounds the ray so animals cannot be fed through walls.
   *
   * @returns {{mob:MobEntity,mode:'grow'|'love'|'tame',distance:number}|null}
   */
  tryFeedMob({ origin, direction, reach, blockDistance = Infinity, itemId }) {
    if (!itemId) return null;
    const maxDistance = Math.max(0, Math.min(Number(reach) || 0, Number(blockDistance) || Infinity));
    if (maxDistance <= 0) return null;

    let best = null;
    let bestDistance = maxDistance;
    for (const mob of this.mobs) {
      const accepts = mob.definition?.breedingItems?.includes(itemId) ||
        (!mob.ownerId && mob.definition?.tamingItems?.includes(itemId));
      if (!mob.alive || mob.isDead || !accepts) continue;
      const distance = raycastBox(
        origin,
        direction,
        mob.x - mob.halfSize,
        mob.y,
        mob.z - mob.halfSize,
        mob.x + mob.halfSize,
        mob.y + mob.height,
        mob.z + mob.halfSize,
        bestDistance
      );
      if (distance === null || distance > bestDistance) continue;
      best = mob;
      bestDistance = distance;
    }
    if (!best) return null;
    const outcome = best.feed(itemId);
    if (!outcome.accepted) return null;
    return { mob: best, mode: outcome.mode, distance: bestDistance };
  }

  /**
   * Registers a pool as containing attackable entities.
   * @param {Array<import('./Entity.js').Entity>} pool
   */
  registerLivingPool(pool) {
    if (!this._livingPools.includes(pool)) this._livingPools.push(pool);
  }

  /**
   * Finds a free slot, or recycles the oldest entity when the pool is full.
   * Recycling the oldest keeps the most recent (and most visible) spawns alive.
   */
  _takeFromPool(pool, cursorField) {
    const start = this[cursorField];
    for (let offset = 0; offset < pool.length; offset++) {
      const index = (start + offset) % pool.length;
      if (!pool[index].alive) {
        this[cursorField] = (index + 1) % pool.length;
        return pool[index];
      }
    }

    // Pool exhausted: reuse the oldest.
    let oldestIndex = 0;
    let oldestAge = -1;
    for (let index = 0; index < pool.length; index++) {
      if (pool[index].age > oldestAge) {
        oldestAge = pool[index].age;
        oldestIndex = index;
      }
    }
    this[cursorField] = (oldestIndex + 1) % pool.length;
    return pool[oldestIndex];
  }

  // ---------------------------------------------------------------------- update

  /**
   * Advances every entity and refreshes the instance buffers.
   *
   * @param {number} dt
   * @param {import('../player/Player.js').Player|null} player
   */
  update(dt, player, context = {}) {
    const world = this._world;
    const collect = player && this._settings.get('gameplay.mode') === 'survival';
    // Reset the "inventory full" warning latch once there is room again, so the
    // message reappears the next time it is actually true.
    if (player && !player.inventory.isFull) this._warnedFull = false;
    const magnetTarget = collect ? player.position : null;

    // --- items ---
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (!item.alive) continue;
      item.update(dt, world, magnetTarget);
      if (!item.alive) continue;

      // Merge with a later item in the list, so each pair is only considered once.
      for (let j = i + 1; j < this.items.length; j++) {
        const other = this.items[j];
        if (other.alive) item.tryMerge(other);
      }

      if (collect && item.canBeCollectedBy(player.position.x, player.position.y, player.position.z)) {
        const before = item.stack.quantity;
        // `addItem` mutates the stack, removing whatever fitted. A partial
        // pickup therefore leaves the remainder in the world automatically,
        // with no arithmetic here to get wrong.
        const leftover = player.inventory.addItem(item.stack);
        if (leftover === 0) {
          item.kill();
          this._bus.emit(Events.PLAY_SOUND, { name: 'pickup', volume: 0.6 });
        } else if (leftover < before) {
          // Something was taken but not all of it: acknowledge the partial
          // pickup and let the rest keep sitting there.
          this._bus.emit(Events.PLAY_SOUND, { name: 'pickup', volume: 0.4 });
        } else if (!this._warnedFull) {
          // Nothing fitted. Tell the player once rather than every frame they
          // stand over the pile, and leave the item in the world — silently
          // failing to pick something up looks like the item is broken.
          this._warnedFull = true;
          this._bus.emit(Events.NOTIFY, {
            level: 'warning',
            message: 'Your inventory is full.',
            id: 'inventory-full',
            duration: 2600,
          });
        }
      }
    }

    // --- falling blocks ---
    for (const entity of this.fallingBlocks) {
      if (!entity.alive) continue;
      entity.update(dt, world);
      if (!entity.alive) continue;

      if (entity.settled) {
        const placed = world.settleFallingBlock(
          entity.settleX,
          entity.settleY,
          entity.settleZ,
          entity.blockId
        );
        if (!placed) {
          // Nowhere to land: drop it as an item rather than losing the block.
          this.spawnItem(entity.x, entity.y, entity.z, entity.blockId, 1);
        }
        entity.kill();
      }
    }

    // --- projectiles ---
    // Projectiles run before mob AI so a player-fired arrow can set hurt/death
    // flags that are consumed in the same frame.
    const projectileTargets = context.attackables?.length
      ? [...this.mobs, ...context.attackables]
      : this.mobs;
    for (const projectile of this.projectiles) {
      if (!projectile.alive) continue;
      projectile.update(dt, world, { mobs: projectileTargets, player });
      if (projectile.justHit) {
        this._bus.emit(Events.PROJECTILE_HIT, {
          projectile,
          hit: projectile.justHit,
        });
        this._bus.emit(Events.PLAY_SOUND, {
          name: projectile.justHit.type === 'block' ? 'projectile.hit_block' : 'projectile.hit',
          volume: 0.65,
        });
        projectile.justHit = null;
      }
    }

    // --- living mobs ---
    for (const mob of this.mobs) {
      if (!mob.alive) continue;
      // A player strike happens later in the frame than entity simulation. Consume
      // that event before the next AI step so a lethal hit cannot be lost when the
      // short death timer expires in a large frame.
      this._consumeMobEvents(mob, player);
      if (!mob.alive) continue;
      mob.updateMob(dt, world, player, context);
      this._consumeMobProjectile(mob);
      this._consumeMobEvents(mob, player);
    }

    this._updateBreeding();

    this.mobSpawner.update(dt, {
      world,
      player,
      daylight: context.daylight ?? 1,
      mobs: this.mobs,
      enabled: context.mobSpawning !== false,
      difficulty: this._difficulty,
      spawn: (mobId, x, y, z, seed) => this.spawnMob(mobId, x, y, z, seed),
    });

    this._syncInstances();
    this.mobRenderer.sync(this.mobs);
  }


  /** Pairs nearby adults in love mode and creates one persistent baby. */
  _updateBreeding() {
    if (this.liveMobCount >= this.mobs.length) return;
    for (let i = 0; i < this.mobs.length; i++) {
      const first = this.mobs[i];
      if (!first.canBreed) continue;
      for (let j = i + 1; j < this.mobs.length; j++) {
        const second = this.mobs[j];
        if (!second.canBreed || second.mobId !== first.mobId) continue;
        const dx = second.x - first.x;
        const dy = second.y - first.y;
        const dz = second.z - first.z;
        if (dx * dx + dy * dy + dz * dz > 9) continue;

        const x = (first.x + second.x) * 0.5;
        const y = Math.max(first.y, second.y);
        const z = (first.z + second.z) * 0.5;
        const baby = this.spawnMob(
          first.mobId,
          x,
          y,
          z,
          ((first._randomState ^ second._randomState ^ ++this._mobSpawnSerial) >>> 0) || 1
        );
        if (!baby) return;
        baby.setBaby();
        baby.persistent = true;
        first.finishBreeding();
        second.finishBreeding();
        this._bus.emit(Events.MOB_BRED, {
          parents: [first, second],
          baby,
          mobId: baby.mobId,
        });
        this._bus.emit(Events.PLAY_SOUND, { name: 'mob.breed', volume: 0.52, pitch: 1.15 });
        return;
      }
    }
  }

  _consumeMobProjectile(mob) {
    const request = mob.projectileRequest;
    if (!request) return;
    mob.projectileRequest = null;
    const direction = {
      x: request.targetX - request.x,
      y: request.targetY - request.y,
      z: request.targetZ - request.z,
    };
    this.spawnProjectile(request.x, request.y, request.z, direction, {
      ownerKind: 'mob',
      owner: mob,
      sourceX: request.x,
      sourceY: request.y,
      sourceZ: request.z,
      speed: 18,
      gravity: 4.5,
      damage: request.damage,
      statusEffect: request.statusEffect,
      effectDuration: request.effectDuration,
    });
  }

  _consumeMobEvents(mob, player) {
    // The horror roster has recorded voices; everyone else keeps the generic
    // synthesized reactions. Either way the sound is placed at the creature, so a
    // growl behind the player actually comes from behind the player.
    const behavior = mob.definition?.behavior ?? null;
    const voicePosition = behavior ? { x: mob.x, y: mob.y + mob.eyeHeight * 0.85, z: mob.z } : null;

    if (mob.justHurt) {
      mob.justHurt = false;
      this._bus.emit(Events.MOB_HURT, {
        mob,
        mobId: mob.mobId,
        health: mob.health,
        maxHealth: mob.maxHealth,
      });
      const hurtSound = mobSound(behavior, 'hurt');
      if (hurtSound) {
        this._bus.emit(Events.PLAY_SOUND, {
          name: hurtSound,
          volume: 0.85,
          position: voicePosition,
          maxDistance: 48,
        });
      } else {
        this._bus.emit(Events.PLAY_SOUND, {
          name: 'mob.hurt',
          volume: 0.58,
          pitch: 0.85 + Math.random() * 0.3,
        });
      }
    }

    if (mob.justAttacked) {
      mob.justAttacked = false;
      const attackSound = mobSound(behavior, 'attack');
      this._bus.emit(Events.PLAY_SOUND, attackSound
        ? { name: attackSound, volume: 0.9, position: voicePosition, maxDistance: 48 }
        : { name: 'mob.attack', volume: 0.62 });
    }

    if (!mob.justDied) return;
    mob.justDied = false;
    const drops = mob.pendingDrops ?? [];
    mob.pendingDrops = null;
    for (const drop of drops) {
      this.spawnItemStack(
        mob.x,
        mob.y + Math.min(0.7, mob.height * 0.5),
        mob.z,
        new ItemStack(drop.item, drop.count),
        {
          x: (Math.random() - 0.5) * 2.6,
          y: 2.2 + Math.random() * 1.6,
          z: (Math.random() - 0.5) * 2.6,
        }
      );
    }
    if (mob.killedByPlayer && player && !player.isCreative) {
      player.stats.addExperience(mob.xpReward);
    }
    this._bus.emit(Events.MOB_DIED, {
      mob,
      mobId: mob.mobId,
      drops,
      killedByPlayer: Boolean(mob.killedByPlayer),
    });
    const deathSound = mobSound(behavior, 'death');
    this._bus.emit(Events.PLAY_SOUND, deathSound
      ? { name: deathSound, volume: 0.9, position: voicePosition, maxDistance: 48 }
      : { name: 'mob.death', volume: 0.7 });
  }

  /** Writes live entity transforms into the instance buffers. */
  _syncInstances() {
    this._writeInstances(this.itemMesh, this.items, ITEM_SCALE, true);
    this._writeInstances(this.fallingMesh, this.fallingBlocks, 1, false);
    this._writeProjectileInstances();
  }

  _writeProjectileInstances() {
    const mesh = this.projectileMesh;
    const tiles = mesh.geometry.getAttribute('aTiles');
    const arrowTile = getItem('arrow')?.icon ?? 0;
    const fireballTile = getItem('dragon_breath')?.icon ?? arrowTile;
    let count = 0;
    for (const projectile of this.projectiles) {
      if (!projectile.alive) continue;
      this._position.set(projectile.x, projectile.y, projectile.z);
      this._projectileDirection
        .set(projectile.velocityX, projectile.velocityY, projectile.velocityZ)
        .normalize();
      this._quaternion.setFromUnitVectors(this._forwardAxis, this._projectileDirection);
      const fireball = projectile.visualKind === 'dragon_fireball';
      this._scale.set(fireball ? 0.56 : 0.08, fireball ? 0.56 : 0.08, fireball ? 0.56 : 0.72);
      this._matrix.compose(this._position, this._quaternion, this._scale);
      mesh.setMatrixAt(count, this._matrix);
      const tile = fireball ? fireballTile : arrowTile;
      tiles.array[count * 3] = tile;
      tiles.array[count * 3 + 1] = tile;
      tiles.array[count * 3 + 2] = tile;
      count++;
      if (count >= mesh.instanceMatrix.count) break;
    }
    mesh.count = count;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      tiles.needsUpdate = true;
    }
    mesh.visible = count > 0;
  }

  /**
   * @param {THREE.InstancedMesh} mesh
   * @param {Entity[]} pool
   * @param {number} scale
   * @param {boolean} spin
   */
  _writeInstances(mesh, pool, scale, spin) {
    const tiles = mesh.geometry.getAttribute('aTiles');
    let count = 0;

    for (const entity of pool) {
      if (!entity.alive) continue;

      // Items bob visually; falling blocks do not. Both cubes are centred on
      // their own origin, which sits at the bottom of the entity's box.
      const y = spin && entity.renderY !== undefined ? entity.renderY : entity.y;
      this._position.set(entity.x, y + scale * 0.5, entity.z);
      this._quaternion.setFromAxisAngle(this._yAxis, spin ? entity.rotation : 0);
      this._scale.setScalar(scale);
      this._matrix.compose(this._position, this._quaternion, this._scale);
      mesh.setMatrixAt(count, this._matrix);

      // Falling blocks always carry a block id. Dropped items carry a stack,
      // which may be a non-block item (a tool, a loaf of bread) with no block
      // faces at all — those use their flat icon tile on every face, so a
      // tumbling pickaxe still reads as a pickaxe.
      const blockId = entity.blockId ?? blockIdForItem(entity.itemId);
      if (blockId !== null && blockId !== undefined) {
        tiles.array[count * 3] = FACE_TILES[blockId * 6 + FACE_PY];
        tiles.array[count * 3 + 1] = FACE_TILES[blockId * 6 + FACE_PX];
        tiles.array[count * 3 + 2] = FACE_TILES[blockId * 6 + FACE_NY];
      } else {
        const icon = getItem(entity.itemId)?.icon ?? 0;
        tiles.array[count * 3] = icon;
        tiles.array[count * 3 + 1] = icon;
        tiles.array[count * 3 + 2] = icon;
      }

      count++;
      if (count >= mesh.instanceMatrix.count) break;
    }

    mesh.count = count;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      tiles.needsUpdate = true;
    }
    mesh.visible = count > 0;
  }

  /**
   * Applies the current lighting to the entity material.
   * @param {Object} state The same state object `Materials.applyLighting` takes.
   */
  applyLighting(state) {
    const uniforms = this._material.uniforms;
    uniforms.uSunDirection.value.copy(state.sunDirection);
    uniforms.uSunColor.value.copy(state.sunColor);
    uniforms.uSkyAmbient.value.copy(state.skyAmbient);
    uniforms.uGroundAmbient.value.copy(state.groundAmbient);
    uniforms.uCaveAmbient.value = state.caveAmbient;
    uniforms.uFogColor.value.copy(state.fogColor);
    uniforms.uFogNear.value = state.fogNear;
    uniforms.uFogFar.value = state.fogFar;
    uniforms.uFogStrength.value = state.fogStrength;
    uniforms.uBrightness.value = state.brightness;
    this.mobRenderer.applyLighting(state);
  }

  /** Removes every entity without spawning drops. */
  clear() {
    for (const item of this.items) item.kill();
    for (const block of this.fallingBlocks) block.kill();
    for (const mob of this.mobs) mob.kill();
    for (const projectile of this.projectiles) projectile.kill();
    this.itemMesh.count = 0;
    this.fallingMesh.count = 0;
    this.projectileMesh.count = 0;
    this.itemMesh.visible = false;
    this.fallingMesh.visible = false;
    this.projectileMesh.visible = false;
    this.mobRenderer.clear();
  }

  /** Diagnostics for the debug overlay. */
  getStats() {
    return {
      items: this.liveItemCount,
      falling: this.liveFallingCount,
      mobs: this.liveMobCount,
      babies: this.mobs.reduce((count, mob) => count + (mob.alive && mob.isBaby ? 1 : 0), 0),
      projectiles: this.liveProjectileCount,
      itemCapacity: this.items.length,
      fallingCapacity: this.fallingBlocks.length,
      mobCapacity: this.mobs.length,
      projectileCapacity: this.projectiles.length,
    };
  }

  /** Disposes the instanced meshes and shared resources. */
  destroy() {
    this.clear();
    this._scene.remove(this.itemMesh);
    this._scene.remove(this.fallingMesh);
    this._scene.remove(this.projectileMesh);
    this.mobRenderer.destroy();
    this._resources.releaseTransient(this.itemMesh.geometry);
    this._resources.releaseTransient(this.fallingMesh.geometry);
    this._resources.releaseTransient(this.projectileMesh.geometry);
    this.itemMesh.dispose();
    this.fallingMesh.dispose();
    this.projectileMesh.dispose();
    this._resources.releaseShared('entities:geometry');
    this._resources.releaseShared('entities:material');
  }
}

export default EntityManager;
