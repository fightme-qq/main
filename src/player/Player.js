/**
 * The player: state, dimensions and the per-step update.
 *
 * `Player` holds only state and delegates behaviour: `PlayerPhysics` moves it,
 * `PlayerCollision` decides where it can go, `PlayerController` fills in `intent`
 * from input, `CameraController` looks through its eyes. That split is what keeps
 * each piece testable and stops the movement code from growing an input branch.
 *
 * ## Crouching and the box
 *
 * Crouching shrinks the collision box from the top. Standing back up is only
 * allowed when there is room, which is checked before the height changes — so
 * crawling under a one-block gap does not let you stand up inside the ceiling.
 */

import * as THREE from 'three';

import { PHYSICS, WORLD_HEIGHT } from '../config/GameConfig.js';
import { Events } from '../core/EventBus.js';
import { clamp, damp } from '../utils/MathUtils.js';
import { IS_LIQUID } from '../world/BlockRegistry.js';
import { Block } from '../world/BlockTypes.js';
import { PlayerCollision } from './PlayerCollision.js';
import { PlayerPhysics } from './PlayerPhysics.js';
import { Inventory } from './Inventory.js';
import { PlayerStats } from './PlayerStats.js';
import { DamageType, getDamageSource } from './DamageTypes.js';
import { EXHAUSTION } from './PlayerStats.js';
import { isInsideShieldArc, shieldDurabilityLoss } from './Shield.js';
import { classifyLiquidContact } from './LiquidContact.js';
import { StatusEffectController } from '../entities/StatusEffects.js';
import { DamagePipeline } from '../progression/DamagePipeline.js';
import { getDifficulty } from '../gameplay/Difficulty.js';
import { createVoxelPlayerModel, VOXEL_PLAYER_PROPORTIONS } from '../rendering/VoxelPlayerModel.js';

/** Y below which the player is considered to have fallen out of the world. */
const VOID_Y = -12;
/** Neutral vertical origin of the third-person torso hierarchy. */
const BODY_TORSO_Y = VOXEL_PLAYER_PROPORTIONS.torsoY;

export class Player {
  /**
   * @param {Object} options
   * @param {import('../world/World.js').World} options.world
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {string} [options.difficulty]
   */
  constructor({ world, bus, settings, difficulty = 'normal' }) {
    this._world = world;
    this._bus = bus;
    this._settings = settings;

    /** Feet position, centred horizontally on the collision box. */
    this.position = new THREE.Vector3(0.5, 70, 0.5);
    this.velocity = new THREE.Vector3(0, 0, 0);
    /** Position at the start of the current frame, for render interpolation. */
    this.previousPosition = new THREE.Vector3().copy(this.position);

    this.width = PHYSICS.playerWidth;
    /** Current collision height; shrinks while crouching. */
    this.height = PHYSICS.playerHeight;
    /** Smoothed eye height so crouching is not an instant snap. */
    this._smoothedHeight = PHYSICS.playerHeight;

    /**
     * What the player is trying to do this step. Written by `PlayerController`
     * and read by `PlayerPhysics`; nothing else should touch it.
     */
    this.intent = {
      moveX: 0,
      moveZ: 0,
      jump: false,
      sprint: false,
      crouch: false,
      flyUp: false,
      flyDown: false,
    };

    // --- state flags, written by physics ---
    this.onGround = false;
    this.hitCeiling = false;
    this.steppedUp = false;
    this.justLanded = false;
    this.jumpedThisStep = false;
    this.landingImpact = 0;

    /** True when the collision box overlaps water. */
    this.inWater = false;
    /** True when the collision box overlaps lava. */
    this.inLava = false;
    /** True when the collision box overlaps any liquid. */
    this.inLiquid = false;
    /** True when the head is submerged in water. */
    this.headInWater = false;
    /** True when the head is submerged in lava. */
    this.headInLava = false;
    /** Blocks of the box that are below the liquid surface. */
    this.submergedDepth = 0;
    /** True while the body overlaps a climbable ladder. */
    this.onLadder = false;

    /** True while flying. */
    this.flying = false;
    /** Survival glide state supplied by an equipped elytra. */
    this.gliding = false;
    this._glideWear = 0;
    /** Game mode: `'creative'` or `'survival'`. */
    this.mode = settings.get('gameplay.mode');
    this.difficulty = getDifficulty(difficulty).id;
    this.difficultyProfile = getDifficulty(this.difficulty);
    /** Auto-step over one-block ledges without jumping. */
    this.autoStep = settings.get('controls.autoJump');

    /** Distance fallen since leaving the ground, for landing effects. */
    this.fallDistance = 0;
    /** Total distance walked, for footstep timing. */
    this.travelDistance = 0;
    /** Seconds since the last footstep sound. */
    this._stepAccumulator = 0;

    this.collision = new PlayerCollision(world);
    this.physics = new PlayerPhysics(world, this.collision);
    this.inventory = new Inventory(bus);
    this.inventory.setCreative(this.mode === 'creative');

    /**
     * Health, hunger, air and death state.
     *
     * Separate from the physics body so it can be tested without a world, and so
     * the very different update cadences (physics per 1/60 s, hunger per minute)
     * do not have to share a method.
     */
    this.stats = new PlayerStats(bus);
    this.stats.setDifficulty(this.difficultyProfile);
    this.damagePipeline = new DamagePipeline();
    this.stats.setDamageResolver((amount, source) => this.damagePipeline.resolve({
      amount:source?.id === DamageType.VOID ? amount : amount * this.difficultyProfile.incomingDamage,
      type: source?.id ?? source?.type ?? 'generic',
      target: this,
      bypassesArmour: !source?.reducedByArmour,
    }, {
      armour: (incoming) => this.inventory.resolveDamage(incoming, source),
      resistanceLevel: this.effects?.resistanceLevel ?? 0,
    }).amount);
    this.stats.setEnabled(this.mode === 'survival');

    /** Shared timed buffs/debuffs, persisted with the player. */
    this.effects = new StatusEffectController();

    /**
     * Where a respawn puts the player. Null means "recompute from terrain".
     * @type {{x: number, y: number, z: number}|null}
     */
    this.spawnPoint = null;

    /** Raised-shield state and the horizontal direction it protects. */
    this.blocking = false;
    this.lookDirection = { x: 0, z: -1 };

    /** Distance travelled since the last exhaustion charge, in blocks. */
    this._exhaustionDistance = 0;

    this._scratchPosition = new THREE.Vector3();
    this._bodyGroup = null;
    this._bodyYaw = 0;
    this._walkPhase = 0;
    this._miningSwing = 0;
    this._prevBodyPos = new THREE.Vector3();
    this._avatar = null;
  }

  /** Creates the detailed original block-character with joint pivots for animation. */
  attachBody(scene) {
    if (this._bodyGroup) return;
    this._avatar = createVoxelPlayerModel();
    this._bodyGroup = this._avatar.group;
    this._torsoGroup = this._avatar.torsoGroup;
    this._headGroup = this._avatar.headGroup;
    this._armL = this._avatar.armLeft;
    this._armR = this._avatar.armRight;
    this._legL = this._avatar.legLeft;
    this._legR = this._avatar.legRight;
    this._bodyGroup.visible = false;
    scene.add(this._bodyGroup);
    this._prevBodyPos.copy(this.position);
  }

  updateBody(cameraMode, yaw, dt = 0.016) {
    if (!this._bodyGroup) return;
    const isFirst = cameraMode === 0;
    this._bodyGroup.visible = !isFirst;
    if (isFirst) return;

    // Position at feet + center offset, yaw lerp
    this._bodyGroup.position.set(this.position.x, this.position.y, this.position.z);
    this._bodyYaw += (yaw - this._bodyYaw) * 0.18;
    this._bodyGroup.rotation.y = this._bodyYaw;
    if (this._avatar?.shadow) this._avatar.shadow.visible = this.onGround && !this.flying;

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const moving = speed > 0.15 && this.onGround && !this.flying;
    const sprinting = moving && this.intent.sprint;
    const crouching = this.intent.crouch && this.onGround;

    // Walk phase
    if (moving) {
      const freq = sprinting ? 12 : 8;
      this._walkPhase += dt * freq;
    } else {
      this._walkPhase += dt * 1.2;
      // settle to neutral
      if (!moving) this._walkPhase *= 0.92;
    }

    const swing = moving ? Math.sin(this._walkPhase) * (sprinting ? 0.85 : 0.55) : 0;
    const swing2 = moving ? Math.sin(this._walkPhase + Math.PI) * (sprinting ? 0.85 : 0.55) : 0;

    // Mining override — right arm does quick arc even when walking
    const isMining = this._miningSwing > 0;
    if (isMining) {
      this._miningSwing -= dt * 5;
      if (this._miningSwing < 0) this._miningSwing = 0;
      const t = 1 - this._miningSwing;
      const arc = Math.sin(t * Math.PI) * -1.6;
      this._armR.rotation.x = arc;
      this._armL.rotation.x = swing * 0.5;
    } else {
      this._armL.rotation.x = swing;
      this._armR.rotation.x = swing2;
    }
    this._legL.rotation.x = swing2;
    this._legR.rotation.x = swing;

    // Subtle arm z when sprinting (pumping)
    if (sprinting) {
      this._armL.rotation.z = 0.15;
      this._armR.rotation.z = -0.15;
    } else {
      this._armL.rotation.z *= 0.9;
      this._armR.rotation.z *= 0.9;
    }

    // Crouch pose. Position always approaches the model's neutral origin; the
    // old `position.y *= 0.85` decayed 0.95 toward zero every standing frame and
    // slowly buried the whole body in the ground.
    const torsoTilt = crouching ? 0.32 : 0;
    const torsoZ = crouching ? 0.08 : 0;
    const headTilt = crouching ? -0.18 : 0;
    this._torsoGroup.rotation.x = damp(this._torsoGroup.rotation.x, torsoTilt, 0.0005, dt);
    this._torsoGroup.position.y = damp(this._torsoGroup.position.y, BODY_TORSO_Y, 0.0005, dt);
    this._torsoGroup.position.z = damp(this._torsoGroup.position.z, torsoZ, 0.0005, dt);
    this._headGroup.rotation.x = damp(this._headGroup.rotation.x, headTilt, 0.0005, dt);
    if (crouching) {
      this._legL.rotation.x = -0.2 + swing2 * 0.4;
      this._legR.rotation.x = -0.2 + swing * 0.4;
    }

    // Fall / jump tuck
    if (!this.onGround && !this.flying && !this.inLiquid) {
      this._legL.rotation.x = 0.4;
      this._legR.rotation.x = 0.4;
    }
  }

  /** Call to trigger mining arm swing on the body model. */
  bodySwing() { this._miningSwing = 1; }

  removeBody(scene) {
    if (!this._bodyGroup) return;
    scene.remove(this._bodyGroup);
    this._avatar?.dispose();
    this._avatar = null;
    this._bodyGroup = null;
    this._torsoGroup = null;
    this._headGroup = null;
    this._armL = null;
    this._armR = null;
    this._legL = null;
    this._legR = null;
  }

  /** Eye height above the feet, following the crouch transition. */
  get eyeHeight() {
    return this._smoothedHeight * PHYSICS.eyeHeightRatio;
  }

  /** Eye position in world space. */
  getEyePosition(out = new THREE.Vector3()) {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** World reference used by camera and interaction helpers. */
  get world() {
    return this._world;
  }

  /** True when the player is in creative mode. */
  get isCreative() {
    return this.mode === 'creative';
  }

  /** Horizontal speed in blocks per second. */
  get horizontalSpeed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Active status-effect multiplier consumed by every movement medium. */
  get movementSpeedMultiplier() {
    return this.effects.movementSpeedMultiplier;
  }

  /** Active Strength/Weakness multiplier consumed by the combat system. */
  get attackDamageMultiplier() {
    return this.effects.attackDamageMultiplier;
  }

  // --------------------------------------------------------------------- update

  /**
   * Fixed-step update. Called from the game loop's fixed update.
   * @param {number} step Seconds.
   */
  fixedUpdate(step) {
    this.previousPosition.copy(this.position);
    this.jumpedThisStep = false;

    this._updateLiquidState();
    this._updateClimbState();
    this._updateCrouch();

    // Flying is disabled the moment the setting is revoked, so a settings change
    // cannot leave the player hovering.
    if (this.flying && (this.mode === 'survival' || !this._settings.get('gameplay.allowFly'))) {
      this.setFlying(false);
    }

    this.physics.step(this, step);

    // Landing on the ground while flying drops out of fly mode, which is what
    // players expect after descending onto terrain.
    if (this.flying && this.onGround && this.velocity.y <= 0 && this.intent.flyDown) {
      this.setFlying(false);
    }

    this._updateFallDistance();
    this._updateFootsteps(step);
    this.effects.tick(step, {
      heal: (amount) => this.stats.heal(amount),
      damage: (amount) => this.stats.applyDamage(amount, DamageType.POISON),
      health: () => this.stats.health,
      dead: () => this.stats.isDead,
    });
    this._updateSurvival(step);
    this._guardAgainstFalling();
  }

  /**
   * Advances survival state: movement exhaustion, air, suffocation, fall damage.
   *
   * Ordered so fall damage is applied from `landingImpact` — which the physics
   * step has just computed — before `_updateFallDistance` resets the counter.
   *
   * @param {number} step Seconds.
   */
  _updateSurvival(step) {
    const stats = this.stats;

    // A dead player keeps ticking cooldowns but stops accruing costs; the death
    // screen holds them in place until they choose to respawn.
    if (!stats.enabled || stats.isDead) {
      stats.tick(step, {});
      return;
    }

    if (!stats.canSprint) {
      this.intent.sprint = false;
    }

    // Movement cost, charged per block travelled rather than per tick so it is
    // independent of frame rate.
    const speed = this.horizontalSpeed;
    if (!this.flying && speed > 0.05) {
      this._exhaustionDistance += speed * step;
      if (this._exhaustionDistance >= 1) {
        const blocks = Math.floor(this._exhaustionDistance);
        this._exhaustionDistance -= blocks;
        let perBlock = EXHAUSTION.walk;
        if (this.inLiquid) perBlock = EXHAUSTION.swim;
        else if (this.intent.sprint && this.onGround) perBlock = EXHAUSTION.walk + EXHAUSTION.sprint;
        stats.addExhaustion(perBlock * blocks);
      }
    }

    if (this.jumpedThisStep) {
      stats.addExhaustion(this.intent.sprint ? EXHAUSTION.sprintJump : EXHAUSTION.jump);
    }

    // Fall damage on the frame the physics reports a landing. `landingImpact` is
    // the downward speed at contact; `fallDistance` is the height fallen, which
    // is the number players reason about.
    if (this.justLanded && !this.flying && !this.inLiquid) {
      const distance = this.fallDistance;
      if (distance > 0) stats.applyFallDamage(distance);
    }

    stats.tick(step, {
      headInWater: this.headInWater && !this.effects.breathesWater,
      inLava: this.inLava && !this.effects.fireImmune,
      inFire: this._isInFire() && !this.effects.fireImmune,
      suffocating: this._isSuffocating(),
      inVoid: this.position.y < VOID_Y,
    });
  }

  /**
   * Whether the player's head is inside a solid block.
   *
   * Checked at the eye rather than the feet: standing in a one-block gap with
   * solid ground underfoot is normal, whereas a block occupying the head space
   * means something was placed into the player or a chunk loaded around them.
   *
   * @returns {boolean}
   */
  _isInFire() {
    const x = Math.floor(this.position.x);
    const z = Math.floor(this.position.z);
    const feetY = Math.floor(this.position.y + 0.08);
    const torsoY = Math.floor(this.position.y + Math.max(0.5, this.height * 0.55));
    return this._world.getBlock(x, feetY, z) === Block.FIRE ||
      this._world.getBlock(x, torsoY, z) === Block.FIRE;
  }

  _isSuffocating() {
    const eyeY = Math.floor(this.position.y + this.eyeHeight);
    return this._world.isCollidable(
      Math.floor(this.position.x),
      eyeY,
      Math.floor(this.position.z)
    );
  }

  /** Per-frame update for things that do not need the fixed step. */
  update(dt) {
    // Smooth the collision height towards the target so the eye glides during a
    // crouch instead of teleporting.
    const target = this.intent.crouch && this.onGround && !this.flying
      ? PHYSICS.playerCrouchHeight
      : this.height;
    this._smoothedHeight = damp(this._smoothedHeight, target, 0.0000001, dt);
    if (Math.abs(this._smoothedHeight - target) < 0.002) this._smoothedHeight = target;
  }

  /**
   * Determines how much of the player is in liquid.
   *
   * Samples the collision box's own vertical span rather than a single point, so
   * standing in shallow water (feet wet, head dry) is distinguishable from
   * swimming — which the physics needs, because only the latter should switch to
   * the swimming model.
   */
  _updateLiquidState() {
    const world = this._world;
    const blockX = Math.floor(this.position.x);
    const blockZ = Math.floor(this.position.z);

    const feetY = Math.floor(this.position.y + 0.1);
    const midY = Math.floor(this.position.y + this.height * 0.5);
    const headY = Math.floor(this.position.y + this._smoothedHeight * PHYSICS.eyeHeightRatio);

    const feetBlock = world.getBlock(blockX, feetY, blockZ);
    const midBlock = world.getBlock(blockX, midY, blockZ);
    const headBlock = world.getBlock(blockX, headY, blockZ);
    const contact = classifyLiquidContact(feetBlock, midBlock, headBlock, this.velocity.y);
    this.inWater = contact.inWater;
    this.inLava = contact.inLava;
    this.inLiquid = contact.inLiquid;
    this.headInWater = contact.headInWater;
    this.headInLava = contact.headInLava;

    if (contact.feetLiquid) {
      // Find the surface above the feet to measure submersion depth.
      let surface = feetY;
      while (
        surface < WORLD_HEIGHT - 1 &&
        IS_LIQUID[world.getBlock(blockX, surface + 1, blockZ)] === 1
      ) {
        surface++;
      }
      this.submergedDepth = clamp(surface + 0.875 - this.position.y, 0, 24);
    } else {
      this.submergedDepth = 0;
    }
  }

  /** Updates the climbable contact flag from the feet and torso voxels. */
  _updateClimbState() {
    const x = Math.floor(this.position.x);
    const z = Math.floor(this.position.z);
    const feetY = Math.floor(this.position.y + 0.1);
    const torsoY = Math.floor(this.position.y + this.height * 0.55);
    this.onLadder =
      this._world.getBlock(x, feetY, z) === Block.LADDER ||
      this._world.getBlock(x, torsoY, z) === Block.LADDER;
  }

  /**
   * Applies the crouch state to the collision box.
   *
   * Shrinking is always allowed; growing back is gated on there being room, which
   * is checked with the *full* height before committing.
   */
  _updateCrouch() {
    const wantsCrouch = this.intent.crouch && !this.flying;
    const targetHeight = wantsCrouch ? PHYSICS.playerCrouchHeight : PHYSICS.playerHeight;
    if (targetHeight === this.height) return;

    if (targetHeight < this.height) {
      this.height = targetHeight;
      return;
    }

    // Standing up: only if the taller box fits.
    this._scratchPosition.copy(this.position);
    if (!this.collision.isBlocked(this._scratchPosition, this.width, targetHeight)) {
      this.height = targetHeight;
    }
  }

  _updateFallDistance() {
    if (this.onGround || this.flying || this.inLiquid || this.onLadder) {
      this.fallDistance = 0;
      return;
    }
    if (this.velocity.y < 0) this.fallDistance += -this.velocity.y * PHYSICS.timeStep;
  }

  /** Emits a footstep event at a distance-based cadence. */
  _updateFootsteps(step) {
    const speed = this.horizontalSpeed;
    this.travelDistance += speed * step;

    if (!this.onGround || this.flying || speed < 0.6) {
      this._stepAccumulator = 0;
      return;
    }

    // One step per ~2.1 blocks travelled, so the cadence follows speed naturally.
    this._stepAccumulator += speed * step;
    const stride = this.intent.crouch ? 3.0 : this.intent.sprint ? 1.9 : 2.3;
    if (this._stepAccumulator >= stride) {
      this._stepAccumulator = 0;
      const groundBlock = this.collision.getGroundBlock(this.position, this.width);
      this._bus.emit(Events.PLAYER_STEP, {
        blockId: groundBlock,
        inWater: this.inWater,
        position: this.position,
        // The mixer uses this to make a sprint audible over a walk without a
        // second set of recordings.
        sprint: this.intent.sprint === true,
      });
    }
  }

  /**
   * Catches a player who has fallen out of the world.
   *
   * This should be impossible — bedrock is generated at y=0 and `isCollidable`
   * treats everything below y=0 as solid — but a corrupted save or an unloaded
   * chunk under the feet could still do it, and silently falling forever is a much
   * worse outcome than a respawn.
   */
  _guardAgainstFalling() {
    if (this.position.y > VOID_Y) return;
    console.warn('[Player] fell out of the world; respawning');
    this.respawn();
  }

  // ---------------------------------------------------------------- state changes

  /**
   * Places the player at a position, clearing motion.
   * @param {number} x
   * @param {number} y Feet height.
   * @param {number} z
   */
  teleport(x, y, z) {
    this.position.set(x, y, z);
    this.previousPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.fallDistance = 0;
    this.onGround = false;
    // A teleport can land inside geometry (a save from inside a tree that has
    // since changed); push out rather than trapping the player.
    if (!this.collision.resolveStuck(this.position, this.width, PHYSICS.playerHeight)) {
      console.warn('[Player] could not find clear space at the teleport target');
    }
  }

  /**
   * Moves the player to a spawn point and restores survival state.
   *
   * Prefers the recorded spawn point but re-validates it: terrain around it may
   * have changed since it was stored (a player can mine out their own spawn), and
   * dropping someone into a wall on respawn is worse than moving them.
   *
   * @returns {ItemStack[]} Items to scatter, when survival death drops them.
   */
  respawn() {
    const dropped = this._collectDeathDrops();

    let target = null;
    if (this.spawnPoint) {
      const { x, y, z } = this.spawnPoint;
      if (this._world.isSpawnClear(Math.floor(x), Math.floor(y), Math.floor(z))) {
        target = { x, y, z };
      }
    }
    if (!target) target = this._world.findSpawnPosition(this.position.x, this.position.z);

    this.teleport(target.x, target.y, target.z);
    this.stats.respawn();
    this.effects.clear();
    this.setFlying(false);
    this.setBlocking(false);
    this._exhaustionDistance = 0;

    this._bus.emit(Events.PLAYER_SPAWNED, this.position);
    this._bus.emit(Events.PLAYER_RESPAWNED, { position: this.position });
    return dropped;
  }

  /**
   * Empties the inventory on a survival death.
   *
   * Creative keeps everything: the inventory is notional there, and wiping it
   * would be a punishment in a mode that has none.
   *
   * @returns {ItemStack[]}
   */
  _collectDeathDrops() {
    if (!this.stats.isDead) return [];
    if (this.isCreative) return [];
    if (!this._settings.get('gameplay.keepInventory')) return this.inventory.dropEverything();
    return [];
  }

  /**
   * Records the current position as the respawn point.
   * @returns {{x: number, y: number, z: number}}
   */
  setSpawnHere() {
    return this.setSpawnPoint(this.position.x, this.position.y, this.position.z);
  }

  /** Records an explicit safe respawn position, such as the top of a bed. */
  setSpawnPoint(x, y, z) {
    const next = { x: Number(x), y: Number(y), z: Number(z) };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y) || !Number.isFinite(next.z)) {
      return this.spawnPoint;
    }
    this.spawnPoint = next;
    return this.spawnPoint;
  }

  /** Updates the horizontal direction used by shields and directional actions. */
  setLookDirection(x, z) {
    const length = Math.hypot(x, z);
    if (length <= 1e-6) return this.lookDirection;
    this.lookDirection.x = x / length;
    this.lookDirection.z = z / length;
    return this.lookDirection;
  }

  /** Raises or lowers the active shield. */
  setBlocking(blocking) {
    const next = Boolean(blocking && !this.stats.isDead && this.inventory.hasShield);
    if (this.blocking === next) return this.blocking;
    this.blocking = next;
    if (next) this.intent.sprint = false;
    return this.blocking;
  }

  /**
   * Applies damage from an external source, such as a mob.
   *
   * @param {number} amount Half-hearts.
   * @param {string} [cause] A `DamageType`.
   * @param {{x: number, y: number, z: number}|null} [knockbackFrom]
   * @returns {boolean} True when the damage landed.
   */
  hurt(amount, cause = DamageType.GENERIC, knockbackFrom = null) {
    if (this.effects.fireImmune && (cause === DamageType.FIRE || cause === DamageType.LAVA)) {
      return false;
    }
    const source = getDamageSource(cause);
    if (
      this.blocking &&
      source.blockable &&
      this.inventory.hasShield &&
      isInsideShieldArc(this.position, this.lookDirection, knockbackFrom)
    ) {
      const broken = this.inventory.damageShield(shieldDurabilityLoss(amount));
      this.blocking = !broken && this.inventory.hasShield;
      this._bus.emit(Events.SHIELD_BLOCKED, {
        cause,
        amount: Math.max(0, Number(amount) || 0),
        source: knockbackFrom,
        broken,
      });
      this._bus.emit(Events.PLAY_SOUND, {
        name: broken ? 'item.shield_break' : 'item.shield_block',
        volume: 0.9,
      });
      // The hit was handled, so attackers still enter their cooldown even
      // though health and invulnerability frames were untouched.
      return true;
    }

    const applied = this.stats.applyDamage(amount, cause);
    if (!applied) return false;

    if (knockbackFrom) {
      // Push away from the source, with a fixed upward component so the hit
      // reads as a blow rather than a shove.
      const dx = this.position.x - knockbackFrom.x;
      const dz = this.position.z - knockbackFrom.z;
      const length = Math.hypot(dx, dz) || 1;
      const strength = 6;
      this.velocity.x += (dx / length) * strength;
      this.velocity.z += (dz / length) * strength;
      this.velocity.y = Math.max(this.velocity.y, 4.2);
      this.onGround = false;
    }
    return true;
  }

  /**
   * Enables or disables fly mode.
   * @param {boolean} flying
   * @returns {boolean} The resulting state.
   */
  setFlying(flying) {
    if (flying && (this.mode === 'survival' || !this._settings.get('gameplay.allowFly'))) {
      return false;
    }
    if (this.flying === flying) return this.flying;
    this.flying = flying;
    if (flying) {
      // Cancel any fall so toggling flight mid-drop stops you dead rather than
      // letting terminal velocity carry through.
      this.velocity.y = 0;
      this.fallDistance = 0;
      this.onGround = false;
    }
    this._bus.emit(Events.PLAYER_MODE_CHANGED, { flying: this.flying, mode: this.mode });
    return this.flying;
  }

  /** Toggles fly mode. */
  toggleFlying() {
    return this.setFlying(!this.flying);
  }

  /**
   * Switches game mode.
   * @param {string} mode `'creative'` or `'survival'`.
   */
  setMode(mode) {
    const next = mode === 'survival' ? 'survival' : 'creative';
    if (this.mode === next) return;
    this.mode = next;
    this.inventory.setCreative(next === 'creative');
    this.stats.setEnabled(next === 'survival');
    if (next === 'survival') this.setFlying(false);
    if (next !== 'survival') this.setBlocking(false);
    this._bus.emit(Events.PLAYER_MODE_CHANGED, { flying: this.flying, mode: this.mode });
  }

  /** Applies the immutable difficulty profile owned by this world. */
  setDifficulty(value) {
    this.difficultyProfile = getDifficulty(value);
    this.difficulty = this.difficultyProfile.id;
    this.stats.setDifficulty(this.difficultyProfile);
    return this.difficultyProfile;
  }

  /** Applies settings that affect the player. */
  applySettings(settings) {
    this.autoStep = settings.controls.autoJump;
    this.setMode(settings.gameplay.mode);
    if (!settings.gameplay.allowFly && this.flying) this.setFlying(false);
  }

  // ----------------------------------------------------------------- persistence

  /** Serialises the player for saving. */
  toJSON() {
    return {
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      flying: this.flying,
      mode: this.mode,
      difficulty: this.difficulty,
      stats: this.stats.toJSON(),
      effects: this.effects.toJSON(),
      spawnPoint: this.spawnPoint,
      ...this.inventory.toJSON(),
    };
  }

  /**
   * Restores a saved player.
   * @param {Object} data
   */
  fromJSON(data) {
    if (!data) return;
    const position = data.position || data.playerPosition;
    if (position && Number.isFinite(position.y)) {
      this.position.set(
        Number(position.x) || 0.5,
        clamp(Number(position.y) || 70, 1, WORLD_HEIGHT - 3),
        Number(position.z) || 0.5
      );
      this.previousPosition.copy(this.position);
    }
    if (typeof data.mode === 'string') this.setMode(data.mode);
    if (typeof data.difficulty === 'string') this.setDifficulty(data.difficulty);
    if (typeof data.flying === 'boolean') this.setFlying(data.flying && this.isCreative);

    const spawn = data.spawnPoint;
    this.spawnPoint =
      spawn && Number.isFinite(spawn.y)
        ? { x: Number(spawn.x), y: Number(spawn.y), z: Number(spawn.z) }
        : null;

    // Order matters: `setMode` above has already enabled or disabled survival, so
    // restoring stats afterwards keeps a saved health value instead of having it
    // reset by the mode switch.
    this.stats.fromJSON(data.stats ?? null);
    this.stats.setEnabled(this.mode === 'survival');
    this.effects.fromJSON(data.effects ?? null);

    this.inventory.fromJSON(data);
    this.velocity.set(0, 0, 0);
    this._exhaustionDistance = 0;
  }
}

export default Player;
