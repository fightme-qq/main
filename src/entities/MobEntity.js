/**
 * A living voxel creature.
 *
 * `MobEntity` owns health, AI state and the bridge between an intent and the
 * shared voxel physics in `Entity`. Rendering is intentionally elsewhere: the
 * pool can be simulated and tested in Node, and `MobRenderer` can batch every
 * creature of one type into a single draw call.
 */

import { DamageType } from '../player/DamageTypes.js';
import { Block } from '../world/BlockTypes.js';
import { Entity } from './Entity.js';
import { getMob, MobFamily, rollDrops } from './MobTypes.js';
import {
  decideMobIntent,
  hasVoxelLineOfSight,
  MobBrainState,
} from './ai/MobBrain.js';
import { findVoxelPath, nextPathDirection } from './ai/VoxelNavigator.js';
import { StatusEffectController } from './StatusEffects.js';
import { GoalSelector, passiveAnimalGoals, hostileMeleeGoals } from './ai/MobGoals.js';
import { HorrorBrain, HorrorState } from './ai/HorrorBrain.js';

const HURT_COOLDOWN = 0.45;
const DEATH_SECONDS = 0.65;
const FLEE_SECONDS = 4.2;
const SIGHT_REFRESH_SECONDS = 0.2;
const DAYLIGHT_BURN_INTERVAL = 1;
const FIRE_CONTACT_INTERVAL = 1;
const DESPAWN_DISTANCE = 96;
const HARD_DESPAWN_DISTANCE = 144;
const MOVE_RESPONSE = 8;
const MOB_JUMP_SPEED = 7.1;
const NAV_REPATH_SECONDS = 0.72;
const NAV_WAYPOINT_REACH = 0.32;

/** Seconds an adult remains ready to breed after being fed. */
export const LOVE_SECONDS = 30;
/** Parent cooldown after producing a baby. */
export const BREED_COOLDOWN_SECONDS = 300;
/** Growth removed when a baby is fed. */
export const BABY_FEED_GROWTH_SECONDS = 60;

function mixSeed(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** One xorshift32 sample in [0,1). */
function nextRandom(entity) {
  let x = entity._randomState || 0x6d2b79f5;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  entity._randomState = x >>> 0;
  return (entity._randomState >>> 0) / 4294967296;
}

export class MobEntity extends Entity {
  constructor() {
    super();
    this.mobId = null;
    this.definition = null;
    this.health = 0;
    this.maxHealth = 0;
    this.isDead = false;
    this.deathTimer = 0;
    this.hurtCooldown = 0;
    this.hurtFlash = 0;
    this.attackCooldown = 0;
    this.difficultyAttackRate = 1;
    this.justAttacked = false;
    this.justHurt = false;
    this.justDied = false;
    this.pendingDrops = null;
    this.xpReward = 0;
    this.killedByPlayer = false;
    this.projectileRequest = null;
    /** Player-given and future data-pack metadata. */
    this.customName = null;
    this.ownerId = null;
    this.riderId = null;
    this.persistent = false;
    this.babyAge = 0;
    this.loveTime = 0;
    this.breedCooldown = 0;
    this.effects = new StatusEffectController();
    this.goalSelector = new GoalSelector();
    this.activeGoals = [];

    this.brainState = MobBrainState.IDLE;
    this.wanderTime = 0;
    this.wanderDirectionX = 0;
    this.wanderDirectionZ = 0;
    this.fleeTime = 0;
    this.fleeFrom = null;
    this._targetVisible = false;
    this._sightTimer = 0;
    this._burnTimer = 0;
    this._fireContactTimer = 0;
    this._randomState = 1;
    this._path = null;
    this._pathIndex = 0;
    this._pathTimer = 0;
    this._pathGoal = '';

    this.facing = 0;
    this.animationPhase = 0;
    this.movementAmount = 0;
    this.headYaw = 0;
    this.enderAngry = false;
    this.enderTeleportCooldown = 0;
    this.carriedBlockId = Block.AIR;
    this.enderBlockTimer = 6;

    // Living creatures should retain steering authority rather than receiving
    // the heavy skid-prevention drag used by dropped blocks.
    this.groundDrag = 1.5;
    this.airDrag = 0.3;
    this.restitution = 0;
  }

  /**
   * Reinitialises a pooled creature.
   * @param {string} mobId
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} [seed]
   */
  spawn(mobId, x, y, z, seed = 1) {
    const definition = getMob(mobId);
    if (!definition) throw new Error(`Unknown mob type "${mobId}"`);

    super.reset(x, y, z);
    this.mobId = mobId;
    this.definition = definition;
    this.halfSize = definition.halfSize;
    this.height = definition.height;
    this.health = definition.maxHealth;
    this.maxHealth = definition.maxHealth;
    this.isDead = false;
    this.deathTimer = 0;
    this.hurtCooldown = 0;
    this.hurtFlash = 0;
    this.attackCooldown = Math.min(0.35, definition.attackCooldown * 0.35);
    this.difficultyAttackRate = 1;
    this.justAttacked = false;
    this.justHurt = false;
    this.justDied = false;
    this.pendingDrops = null;
    this.xpReward = Math.max(1, Math.floor(definition.maxHealth / 4));
    this.killedByPlayer = false;
    this.projectileRequest = null;
    this.customName = null;
    this.ownerId = null;
    this.persistent = false;
    this.babyAge = 0;
    this.loveTime = 0;
    this.breedCooldown = 0;
    this.effects.clear();
    this.goalSelector = new GoalSelector(
      definition.family === MobFamily.HOSTILE ? hostileMeleeGoals() : passiveAnimalGoals()
    );
    this.activeGoals = [];

    this.brainState = MobBrainState.IDLE;
    this.wanderTime = 0;
    this.wanderDirectionX = 0;
    this.wanderDirectionZ = 0;
    this.fleeTime = 0;
    this.fleeFrom = null;
    this._targetVisible = false;
    this._sightTimer = 0;
    this._burnTimer = 0;
    this._fireContactTimer = 0;
    this._randomState = mixSeed(
      (seed >>> 0) ^
        Math.imul(Math.floor(x * 31), 0x9e3779b1) ^
        Math.imul(Math.floor(z * 31), 0x85ebca77)
    ) || 1;
    this._path = null;
    this._pathIndex = 0;
    this._pathTimer = nextRandom(this) * NAV_REPATH_SECONDS;
    this._pathGoal = '';

    // The horror roster runs on its own decision layer; everything else keeps the
    // legacy brain. `null` is the common case and costs nothing.
    this.horrorBrain = definition.behavior
      ? new HorrorBrain({
          behavior: definition.behavior,
          definition,
          random: () => nextRandom(this),
        })
      : null;
    this.horrorBrain?.reset(x, z);

    this.facing = nextRandom(this) * Math.PI * 2;
    this.animationPhase = nextRandom(this) * Math.PI * 2;
    this.movementAmount = 0;
    this.headYaw = 0;
    this.enderAngry = false;
    this.enderTeleportCooldown = 0;
    this.carriedBlockId = Block.AIR;
    this.enderBlockTimer = 4 + nextRandom(this) * 8;
    return this;
  }

  get family() {
    return this.definition?.family ?? MobFamily.PASSIVE;
  }

  /** Applies the active world's hostile health and attack cadence. */
  applyDifficulty(profile, preserveHealthRatio = true, adjustActiveCooldown = false) {
    if (!this.definition) return this;
    const hostile = this.definition.family === MobFamily.HOSTILE;
    const healthRatio = preserveHealthRatio && this.maxHealth > 0
      ? Math.max(0.001, Math.min(1, this.health / this.maxHealth))
      : 1;
    const nextMax = hostile
      ? Math.max(1, Math.ceil(this.definition.maxHealth * (profile?.hostileHealth ?? 1)))
      : this.definition.maxHealth;
    this.maxHealth = nextMax;
    this.health = Math.max(0.01, Math.min(nextMax, nextMax * healthRatio));
    this.difficultyAttackRate = hostile
      ? Math.max(0.1, Number(profile?.hostileAttackRate) || 1)
      : 1;
    if (adjustActiveCooldown) this.attackCooldown /= this.difficultyAttackRate;
    this.xpReward = Math.max(1, Math.floor(nextMax / 4));
    return this;
  }

  get isBaby() {
    return this.babyAge > 0;
  }

  get ageScale() {
    if (!this.definition || !this.isBaby) return 1;
    const duration = Math.max(1, this.definition.growthSeconds);
    const progress = 1 - Math.min(1, this.babyAge / duration);
    return this.definition.babyScale + (1 - this.definition.babyScale) * progress;
  }

  get eyeHeight() {
    const base = this.definition?.eyeHeight ?? this.height * 0.85;
    return base * this.ageScale;
  }

  get canBreed() {
    return Boolean(
      this.alive &&
      !this.isDead &&
      !this.isBaby &&
      this.loveTime > 0 &&
      this.breedCooldown <= 0 &&
      this.definition?.breedingItems?.length
    );
  }

  /** Marks this creature as a newborn and updates its collision bounds. */
  setBaby(seconds = this.definition?.growthSeconds ?? 1200) {
    this.babyAge = Math.max(0, Number(seconds) || 0);
    this.loveTime = 0;
    this._updateAgeShape();
    return this;
  }

  /**
   * Feeds a passive creature. Babies grow faster; ready adults enter love mode.
   * @returns {{accepted:boolean,mode:'grow'|'love'|null}}
   */
  feed(itemId, ownerId = 'local-player') {
    if (!this.ownerId && this.definition?.tamingItems?.includes(itemId)) {
      this.ownerId = String(ownerId || 'local-player').slice(0, 96);
      this.persistent = true;
      return { accepted: true, mode: 'tame' };
    }
    if (!this.alive || this.isDead || !this.definition?.breedingItems?.includes(itemId)) {
      return { accepted: false, mode: null };
    }
    if (this.isBaby) {
      this.babyAge = Math.max(0, this.babyAge - BABY_FEED_GROWTH_SECONDS);
      this._updateAgeShape();
      this.persistent = true;
      return { accepted: true, mode: 'grow' };
    }
    if (this.breedCooldown > 0) return { accepted: false, mode: null };
    this.loveTime = LOVE_SECONDS;
    this.persistent = true;
    return { accepted: true, mode: 'love' };
  }

  mount(riderId = 'local-player') {
    if (!this.alive || this.isDead || !this.definition?.rideable || !this.ownerId) return false;
    this.riderId = String(riderId).slice(0, 96);
    this.persistent = true;
    return true;
  }

  dismount(riderId = 'local-player') {
    if (this.riderId !== String(riderId)) return false;
    this.riderId = null;
    return true;
  }

  /** Called after a successful pair produces a baby. */
  finishBreeding() {
    this.loveTime = 0;
    this.breedCooldown = BREED_COOLDOWN_SECONDS;
  }

  _updateAgeShape() {
    if (!this.definition) return;
    const scale = this.ageScale;
    this.halfSize = this.definition.halfSize * scale;
    this.height = this.definition.height * scale;
  }

  /**
   * Applies damage with a short target-side invulnerability window.
   *
   * @param {number} amount Half-hearts.
   * @param {{x?:number,y?:number,z?:number,bypassCooldown?:boolean}|null} [source]
   * @returns {boolean}
   */
  hurt(amount, source = null) {
    if (!this.alive || this.isDead) return false;
    const damage = Math.max(0, Number(amount) || 0);
    if (damage <= 0) return false;
    if (this.hurtCooldown > 0 && !source?.bypassCooldown) return false;

    this.health = Math.max(0, this.health - damage);
    if (!source?.bypassCooldown) this.hurtCooldown = HURT_COOLDOWN;
    this.hurtFlash = 0.28;
    this.justHurt = true;
    if (source?.attacker === 'player') this.killedByPlayer = true;
    if (this.mobId === 'enderman') this.enderAngry = true;

    if (Number.isFinite(source?.x) && Number.isFinite(source?.z)) {
      this.fleeFrom = { x: source.x, z: source.z };
      if (this.family !== MobFamily.HOSTILE) this.fleeTime = FLEE_SECONDS;
    }

    if (this.health <= 0) this._die();
    return true;
  }

  _die() {
    if (this.isDead) return;
    this.isDead = true;
    this.deathTimer = DEATH_SECONDS;
    this.velocityX *= 0.35;
    this.velocityZ *= 0.35;
    this.pendingDrops = rollDrops(this.mobId, () => nextRandom(this));
    this.justDied = true;
  }

  /**
   * Advances AI, combat and shared voxel physics.
   *
   * @param {number} dt
   * @param {import('../world/World.js').World|Object} world
   * @param {import('../player/Player.js').Player|null} player
   * @param {{daylight?:number,allowSpawning?:boolean}} [context]
   */
  updateMob(dt, world, player, context = {}) {
    if (!this.alive) return;
    this.justAttacked = false;

    if (this.hurtCooldown > 0) this.hurtCooldown = Math.max(0, this.hurtCooldown - dt);
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    if (this.attackCooldown > 0) this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (this.fleeTime > 0) this.fleeTime = Math.max(0, this.fleeTime - dt);
    if (this.wanderTime > 0) this.wanderTime = Math.max(0, this.wanderTime - dt);
    if (this.loveTime > 0) this.loveTime = Math.max(0, this.loveTime - dt);
    if (this.breedCooldown > 0) this.breedCooldown = Math.max(0, this.breedCooldown - dt);
    if (this.babyAge > 0) {
      this.babyAge = Math.max(0, this.babyAge - dt);
      this._updateAgeShape();
    }

    this.effects.tick(dt, {
      heal: (amount) => { this.health = Math.min(this.maxHealth, this.health + amount); },
      damage: (amount) => this.hurt(amount, { bypassCooldown: true }),
      health: () => this.health,
      dead: () => this.isDead,
    });

    if (this.isDead) {
      this.deathTimer -= dt;
      // Keep gravity active during the short death animation so a creature hit
      // on a ledge does not freeze in mid-air.
      super.update(dt, world);
      this.movementAmount = 0;
      if (this.deathTimer <= 0) this.kill();
      return;
    }

    const target = player
      ? {
          x: player.position.x,
          y: player.position.y,
          z: player.position.z,
          eyeHeight: player.eyeHeight,
          isDead: player.stats?.isDead ?? false,
          isCreative: player.isCreative ?? false,
        }
      : null;

    this._sightTimer -= dt;
    if (this._sightTimer <= 0) {
      this._sightTimer = SIGHT_REFRESH_SECONDS + nextRandom(this) * 0.08;
      this._targetVisible = target
        ? hasVoxelLineOfSight(
            world,
            { x: this.x, y: this.y + this.eyeHeight, z: this.z },
            { x: target.x, y: target.y + (target.eyeHeight ?? 1.6), z: target.z }
          )
        : false;
    }

    if (this.mobId === 'enderman') {
      this._tickEndermanSpecial(dt, world, player, target);
      this._targetVisible = this._targetVisible && this.enderAngry;
    }

    const targetDistance = target ? Math.hypot(target.x - this.x, target.z - this.z) : Infinity;

    let intent;
    if (this.horrorBrain) {
      // Horror roles own their own pacing. The brain never sees the world: it gets
      // distance, visibility, the player's look vector and the loudest nearby noise.
      const noise = context.noise?.loudestNear?.(
        this.x,
        this.z,
        this.definition.behavior === 'hunter' ? 24 : 12,
      ) ?? null;
      // The simulation steps at 60 Hz, but a laggy frame hands this method the whole
      // frame delta. A brain that ages its own timers by 0.5 s in one go can skip
      // the detect beat entirely, so horror decisions see a bounded step.
      const loopDt = Math.min(dt, 0.06);
      intent = this.horrorBrain.update(loopDt, {
        mob: this,
        target,
        targetVisible: this._targetVisible,
        distance: targetDistance,
        playerLook: context.playerLook ?? null,
        noise,
        attackCooldown: this.attackCooldown,
        emitSound: (id, options = {}) => {
          context.emitSound?.({
            name: id,
            volume: options.volume ?? 0.8,
            position: { x: this.x, y: this.y + this.eyeHeight * 0.85, z: this.z },
            maxDistance: 48,
          });
        },
      });
      if (intent.despawn) {
        // The stalker leaves when it is out of sight. No drops, no death event: as
        // far as the world is concerned it was never quite there.
        this.kill();
        return;
      }
    } else {
      intent = decideMobIntent({
        definition: this.definition,
        mob: this,
        target,
        currentState: this.brainState,
        wanderDirectionX: this.wanderDirectionX,
        wanderDirectionZ: this.wanderDirectionZ,
        wanderTime: this.wanderTime,
        fleeTime: this.fleeTime,
        fleeFrom: this.fleeFrom,
        targetVisible: this._targetVisible,
        random: () => nextRandom(this),
      });
    }

    // Goal components now run in the live AI loop. The legacy brain continues
    // producing the low-level steering vector while the selector arbitrates
    // reusable high-level controls (float, panic, attack, wander, look).
    this.goalSelector.update({
      mob: this,
      target: this.family === MobFamily.HOSTILE && this._targetVisible ? target : null,
      targetAlive: target ? !target.isDead : false,
      distanceToTarget: targetDistance,
      distanceToPlayer: targetDistance,
      recentlyHurt: this.justHurt,
      inWater: this.inLiquid,
      random: () => nextRandom(this),
      swimUp: () => { this.velocityY = Math.max(this.velocityY, 2.8); },
      facePlayer: () => { if (target) this.headYaw = Math.atan2(target.x - this.x, target.z - this.z) - this.facing; },
      faceTarget: () => {}, moveToTarget: () => {}, strikeTarget: () => {},
      pickWanderTarget: () => {}, moveToDestination: () => {}, clearDestination: () => {},
    }, dt);
    this.activeGoals = this.goalSelector.activeNames();

    this.brainState = intent.state;
    this.wanderDirectionX = intent.directionX;
    this.wanderDirectionZ = intent.directionZ;
    this.wanderTime = intent.nextWanderTime ?? 0;

    let movementX = intent.directionX;
    let movementZ = intent.directionZ;
    // The horror brain asks for a destination (`navigateTo`) rather than a raw
    // direction, so searching and investigating can path around walls instead of
    // pressing into them.
    const navigationTarget = intent.navigateTo
      ?? (intent.state === MobBrainState.CHASE ? target : null);
    if (navigationTarget && intent.speed > 0) {
      let directX = movementX;
      let directZ = movementZ;
      if (Math.hypot(directX, directZ) < 1e-5) {
        const dx = navigationTarget.x - this.x;
        const dz = navigationTarget.z - this.z;
        const length = Math.hypot(dx, dz) || 1;
        directX = dx / length;
        directZ = dz / length;
      }
      const navigation = this._navigationDirection(dt, world, navigationTarget, directX, directZ);
      movementX = navigation ? navigation.x : directX;
      movementZ = navigation ? navigation.z : directZ;
    } else {
      this._pathTimer = Math.max(0, this._pathTimer - dt);
      if (intent.state !== MobBrainState.FLEE) this._clearPath();
    }

    const effectSpeed = this.effects.movementSpeedMultiplier;
    const desiredX = movementX * intent.speed * effectSpeed;
    const desiredZ = movementZ * intent.speed * effectSpeed;
    const response = Math.min(1, MOVE_RESPONSE * dt);
    this.velocityX += (desiredX - this.velocityX) * response;
    this.velocityZ += (desiredZ - this.velocityZ) * response;

    const desiredLength = Math.hypot(movementX, movementZ);
    if (desiredLength > 1e-5) {
      const desiredFacing = Math.atan2(movementX, movementZ);
      let delta = desiredFacing - this.facing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.facing += delta * Math.min(1, dt * 9);
      this._jumpObstacle(world, movementX, movementZ);
    } else if (intent.faceTarget && target) {
      // Standing still but watching: a stalker that freezes should still track the
      // player with its whole body, not just its head.
      const desiredFacing = Math.atan2(target.x - this.x, target.z - this.z);
      let delta = desiredFacing - this.facing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      this.facing += delta * Math.min(1, dt * 4);
    }

    if (this.inLiquid && intent.speed > 0) this.velocityY = Math.max(this.velocityY, 2.8);

    super.update(dt, world);

    const horizontalSpeed = Math.hypot(this.velocityX, this.velocityZ);
    this.movementAmount = Math.min(1, horizontalSpeed / Math.max(0.1, this.definition.chaseSpeed));
    this.animationPhase += dt * (2.2 + horizontalSpeed * 3.8);

    if (target) {
      const dx = target.x - this.x;
      const dz = target.z - this.z;
      const targetFacing = Math.atan2(dx, dz);
      let headDelta = targetFacing - this.facing;
      while (headDelta > Math.PI) headDelta -= Math.PI * 2;
      while (headDelta < -Math.PI) headDelta += Math.PI * 2;
      this.headYaw = Math.max(-0.75, Math.min(0.75, headDelta));
    } else {
      this.headYaw *= Math.max(0, 1 - dt * 4);
    }

    if (intent.wantsAttack && player && this.attackCooldown <= 0) {
      if (this.definition.ranged) {
        this.projectileRequest = {
          x: this.x,
          y: this.y + this.eyeHeight,
          z: this.z,
          targetX: target.x,
          targetY: target.y + (target.eyeHeight ?? 1.6) * 0.72,
          targetZ: target.z,
          damage: this.definition.attackDamage * this.effects.attackDamageMultiplier,
          statusEffect: this.mobId === 'shulker' ? 'levitation' : null,
          effectDuration: this.mobId === 'shulker' ? 10 : 0,
        };
        this.attackCooldown = this.definition.attackCooldown / this.difficultyAttackRate;
        this.justAttacked = true;
      } else {
        const applied = player.hurt?.(
          this.definition.attackDamage * this.effects.attackDamageMultiplier,
          DamageType.MOB,
          { x: this.x, y: this.y + this.eyeHeight * 0.5, z: this.z }
        );
        if (applied) {
          this.attackCooldown = this.definition.attackCooldown / this.difficultyAttackRate;
          this.justAttacked = true;
        }
      }
    }

    this._tickDaylight(dt, world, context.daylight ?? 0);
    this._tickFireContact(dt, world);
    this._tickDespawn(player);
  }

  _tickEndermanSpecial(dt, world, player, target) {
    this.enderTeleportCooldown = Math.max(0, this.enderTeleportCooldown - dt);
    this.enderBlockTimer = Math.max(0, this.enderBlockTimer - dt);
    if (!player || !target) return;

    const dx = this.x - player.position.x;
    const dz = this.z - player.position.z;
    const distance = Math.hypot(dx, dz) || 1;
    const look = player.lookDirection ?? { x:0, z:-1 };
    const stare = (look.x * dx / distance) + (look.z * dz / distance) > 0.965 && distance < 32;
    if (stare && this._targetVisible && !player.isCreative) this.enderAngry = true;

    if (this.inLiquid) {
      this.hurt(1, { bypassCooldown:true });
      this._teleportEnderman(world, player.position.x, player.position.z, 18);
      return;
    }

    if (this.enderAngry && this.enderTeleportCooldown <= 0 && (!this._targetVisible || distance > 15)) {
      this._teleportEnderman(world, player.position.x, player.position.z, 8);
    }

    if (this.enderBlockTimer > 0 || this.enderAngry) return;
    this.enderBlockTimer = 8 + nextRandom(this) * 12;
    const x = Math.floor(this.x + (nextRandom(this) - .5) * 6);
    const z = Math.floor(this.z + (nextRandom(this) - .5) * 6);
    const y = world.getSurfaceY?.(x, z) ?? Math.floor(this.y - 1);
    if (this.carriedBlockId === Block.AIR) {
      const candidate = world.getBlock(x, y, z);
      if (![Block.DIRT, Block.GRASS, Block.SAND, Block.RED_SAND, Block.NETHERRACK, Block.END_STONE].includes(candidate)) return;
      if (world.setBlock(x, y, z, Block.AIR, { cause:'enderman-pickup' })) this.carriedBlockId = candidate;
    } else if (world.getBlock(x, y + 1, z) === Block.AIR) {
      if (world.setBlock(x, y + 1, z, this.carriedBlockId, { cause:'enderman-place' })) this.carriedBlockId = Block.AIR;
    }
  }

  _teleportEnderman(world, centreX, centreZ, radius) {
    const angle = nextRandom(this) * Math.PI * 2;
    const distance = 3 + nextRandom(this) * Math.max(1, radius - 3);
    const x = Math.floor(centreX + Math.cos(angle) * distance);
    const z = Math.floor(centreZ + Math.sin(angle) * distance);
    const y = world.getSurfaceY?.(x, z);
    if (!Number.isFinite(y) || world.isCollidable(x, y + 1, z) || world.isCollidable(x, y + 2, z)) return false;
    this.x = x + .5;
    this.y = y + 1;
    this.z = z + .5;
    this.velocityX = this.velocityY = this.velocityZ = 0;
    this.enderTeleportCooldown = 2 + nextRandom(this) * 3;
    this._clearPath();
    return true;
  }

  _clearPath() {
    this._path = null;
    this._pathIndex = 0;
    this._pathGoal = '';
  }

  _movementProbeBlocked(world, directionX, directionZ) {
    const length = Math.hypot(directionX, directionZ);
    if (length < 1e-6) return false;
    const reach = this.halfSize + 0.42;
    const x = Math.floor(this.x + (directionX / length) * reach);
    const z = Math.floor(this.z + (directionZ / length) * reach);
    const y = Math.floor(this.y + 0.08);
    return world.isCollidable(x, y, z) && world.isCollidable(x, y + 1, z);
  }

  /** Returns a cached local A* steering direction when direct pursuit is blocked. */
  _navigationDirection(dt, world, target, directX, directZ) {
    this._pathTimer -= dt;
    const goalX = Math.floor(target.x);
    const goalY = Math.floor(target.y);
    const goalZ = Math.floor(target.z);
    const goalKey = `${goalX},${goalY},${goalZ}`;
    const blocked = this._movementProbeBlocked(world, directX, directZ);
    const needsRoute = blocked || !this._targetVisible || Boolean(this._path?.length);

    if (!needsRoute) {
      this._clearPath();
      return null;
    }

    if (this._pathTimer <= 0 || this._pathGoal !== goalKey) {
      this._pathTimer = NAV_REPATH_SECONDS + nextRandom(this) * 0.28;
      this._pathGoal = goalKey;
      this._path = findVoxelPath(
        world,
        { x: this.x, y: this.y, z: this.z },
        { x: goalX, y: goalY, z: goalZ },
        {
          entityHeight: this.height,
          maxNodes: 320,
          maxDistance: Math.min(30, this.definition.loseRange + 2),
          maxStepUp: 1,
          maxDrop: 3,
          canSwim: true,
          avoidHazards: true,
          goalRadius: this.definition.ranged ? 3 : 1,
        }
      );
      this._pathIndex = 0;
    }

    const direction = nextPathDirection(this, this._path, this._pathIndex, NAV_WAYPOINT_REACH);
    this._pathIndex = direction.index;
    if (direction.reachedEnd) {
      this._clearPath();
      return null;
    }
    return { x: direction.x, z: direction.z };
  }

  _jumpObstacle(world, directionX, directionZ) {
    if (!this.onGround || this.velocityY > 0.1) return;
    const reach = this.halfSize + 0.28;
    const probeX = Math.floor(this.x + directionX * reach);
    const probeZ = Math.floor(this.z + directionZ * reach);
    const feetY = Math.floor(this.y + 0.08);
    if (!world.isCollidable(probeX, feetY, probeZ)) return;
    if (world.isCollidable(probeX, feetY + 1, probeZ)) return;
    this.velocityY = MOB_JUMP_SPEED;
    this.onGround = false;
  }

  _tickDaylight(dt, world, daylight) {
    if (!this.definition.burnsInDaylight || daylight < 0.72 || this.effects.fireImmune) {
      this._burnTimer = 0;
      return;
    }
    const surface = world.getSurfaceY?.(Math.floor(this.x), Math.floor(this.z));
    const exposed = surface === undefined || surface < this.y + this.height * 0.45;
    if (!exposed) {
      this._burnTimer = 0;
      return;
    }

    this._burnTimer += dt;
    if (this._burnTimer >= DAYLIGHT_BURN_INTERVAL) {
      this._burnTimer -= DAYLIGHT_BURN_INTERVAL;
      this.hurt(1, { bypassCooldown: true });
    }
  }

  _tickFireContact(dt, world) {
    if (this.effects.fireImmune) {
      this._fireContactTimer = 0;
      return;
    }
    const x = Math.floor(this.x);
    const z = Math.floor(this.z);
    const feetY = Math.floor(this.y + 0.08);
    const torsoY = Math.floor(this.y + Math.max(0.4, this.height * 0.55));
    const touching = world.getBlock(x, feetY, z) === Block.FIRE ||
      world.getBlock(x, torsoY, z) === Block.FIRE;
    if (!touching) {
      this._fireContactTimer = 0;
      return;
    }
    this._fireContactTimer += dt;
    while (this._fireContactTimer >= FIRE_CONTACT_INTERVAL && this.alive && !this.isDead) {
      this._fireContactTimer -= FIRE_CONTACT_INTERVAL;
      this.hurt(1, { bypassCooldown: true });
    }
  }

  _tickDespawn(player) {
    if (this.persistent || !player || !this.definition.despawns || this.age < 20) return;
    const distanceSquared = this.distanceSquaredTo(
      player.position.x,
      player.position.y,
      player.position.z
    );
    if (distanceSquared > HARD_DESPAWN_DISTANCE * HARD_DESPAWN_DISTANCE) {
      this.pendingDrops = null;
      this.kill();
      return;
    }
    if (distanceSquared > DESPAWN_DISTANCE * DESPAWN_DISTANCE && nextRandom(this) < 0.0025) {
      this.pendingDrops = null;
      this.kill();
    }
  }

  /** Serialises a live creature without renderer or pool state. */
  toJSON() {
    if (!this.alive || !this.mobId || this.isDead) return null;
    return {
      kind: 'mob',
      version: 2,
      ...this.toBaseJSON(),
      mobId: this.mobId,
      health: this.health,
      maxHealth: this.maxHealth,
      attackCooldown: this.attackCooldown,
      hurtCooldown: this.hurtCooldown,
      brainState: this.brainState,
      wanderTime: this.wanderTime,
      wanderDirectionX: this.wanderDirectionX,
      wanderDirectionZ: this.wanderDirectionZ,
      fleeTime: this.fleeTime,
      randomState: this._randomState >>> 0,
      facing: this.facing,
      customName: this.customName,
      ownerId: this.ownerId,
      riderId: this.riderId,
      persistent: this.persistent,
      babyAge: this.babyAge,
      loveTime: this.loveTime,
      breedCooldown: this.breedCooldown,
      effects: this.effects.toJSON(),
    };
  }

  /** Restores one validated creature record into this pooled instance. */
  fromJSON(data) {
    if (!data || data.kind !== 'mob' || !getMob(data.mobId)) return false;
    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    this.spawn(data.mobId, x, y, z, Number(data.randomState) >>> 0 || 1);
    this.restoreBaseJSON(data);
    const savedMaxHealth = Math.max(0.01, Number(data.maxHealth) || this.maxHealth);
    const savedHealth = Math.max(0.01, Number(data.health) || savedMaxHealth);
    const savedHealthRatio = Math.max(0.001, Math.min(1, savedHealth / savedMaxHealth));
    this.health = this.maxHealth * savedHealthRatio;
    this.attackCooldown = Math.max(0, Number(data.attackCooldown) || 0);
    this.hurtCooldown = Math.max(0, Number(data.hurtCooldown) || 0);
    if (
      Object.values(MobBrainState).includes(data.brainState) ||
      Object.values(HorrorState).includes(data.brainState)
    ) {
      this.brainState = data.brainState;
    }
    this.wanderTime = Math.max(0, Number(data.wanderTime) || 0);
    this.wanderDirectionX = Math.max(-1, Math.min(1, Number(data.wanderDirectionX) || 0));
    this.wanderDirectionZ = Math.max(-1, Math.min(1, Number(data.wanderDirectionZ) || 0));
    this.fleeTime = Math.max(0, Number(data.fleeTime) || 0);
    this._randomState = Number(data.randomState) >>> 0 || 1;
    this.facing = Number.isFinite(Number(data.facing)) ? Number(data.facing) : 0;
    this.customName = typeof data.customName === 'string' ? data.customName.slice(0, 64) : null;
    this.ownerId = typeof data.ownerId === 'string' ? data.ownerId.slice(0, 96) : null;
    this.riderId = typeof data.riderId === 'string' ? data.riderId.slice(0, 96) : null;
    this.persistent = Boolean(data.persistent || this.customName || this.ownerId);
    this.babyAge = Math.max(0, Number(data.babyAge) || 0);
    this.loveTime = Math.max(0, Math.min(LOVE_SECONDS, Number(data.loveTime) || 0));
    this.breedCooldown = Math.max(0, Math.min(BREED_COOLDOWN_SECONDS, Number(data.breedCooldown) || 0));
    this._updateAgeShape();
    this.effects.fromJSON(data.effects ?? null);
    return true;
  }

  /** Clears references before returning to the pool. */
  kill() {
    super.kill();
    this.pendingDrops = null;
    this.definition = null;
    this.mobId = null;
    this.fleeFrom = null;
    this.projectileRequest = null;
    this.loveTime = 0;
    this.breedCooldown = 0;
    this.babyAge = 0;
    this.riderId = null;
    this.difficultyAttackRate = 1;
    this.effects.clear();
    this.goalSelector.reset();
    this.activeGoals = [];
    this._clearPath();
  }
}

export default MobEntity;
