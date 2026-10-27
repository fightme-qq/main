/**
 * The engine root: owns every subsystem and the frame loop.
 *
 * ## Two lifetimes
 *
 * Subsystems are split by how long they live, which is what makes quitting to the
 * menu and starting a new world clean rather than a source of leaks:
 *
 *  - **Session-scoped** (built once in `initialise`): renderer, shader manager,
 *    texture atlas, materials, input, saves, audio and UI. These survive world
 *    changes because rebuilding them would mean re-painting the atlas and
 *    re-validating shaders for no reason.
 *  - **World-scoped** (built in `_startWorld`, destroyed in `_teardownWorld`):
 *    world, lighting, sky, weather, entities, particles, player and interaction.
 *    Every one of these is disposed explicitly on teardown.
 *
 * ## Frame structure
 *
 * ```
 * fixedUpdate(step)  x0..5   physics and world cascades, at a constant rate
 * update(dt)                 input, camera, streaming, interaction, UI
 * render(dt)                 draw
 * ```
 *
 * Look input is applied in `update` at full frame rate so aiming is smooth, while
 * movement is consumed by `fixedUpdate` so it is frame-rate independent. Input edge
 * state is cleared at the very end of `update`, after every consumer has read it.
 */

import * as THREE from 'three';

import { INTERACTION, SEA_LEVEL, TIME } from './config/GameConfig.js';
import { Action } from './config/KeyBindings.js';
import { EventBus, Events, SubscriptionGroup } from './core/EventBus.js';
import { GameLoop } from './core/GameLoop.js';
import { InputManager } from './core/InputManager.js';
import { ResourceManager } from './core/ResourceManager.js';
import {
  SaveManager,
  createEmptyWorldRecord,
  describeStorageError,
} from './core/SaveManager.js';
import { SettingsManager } from './core/SettingsManager.js';
import { AudioManager, setBlockSoundGroupResolver } from './audio/AudioManager.js';import { EntityManager } from './entities/EntityManager.js';
import { BlockBreaker } from './interaction/BlockBreaker.js';
import { BlockParticles } from './interaction/BlockParticles.js';
import { BlockPlacer } from './interaction/BlockPlacer.js';
import { BlockRaycaster, createRaycastHit } from './interaction/BlockRaycaster.js';
import { SelectionOutline } from './interaction/SelectionOutline.js';
import { CameraController } from './player/CameraController.js';
import { Player } from './player/Player.js';
import { PlayerController } from './player/PlayerController.js';
import { LightingSystem, phaseAt } from './rendering/LightingSystem.js';
import { Materials } from './rendering/Materials.js';
import { Renderer } from './rendering/Renderer.js';
import { ShaderManager } from './rendering/ShaderManager.js';
import { SkySystem } from './rendering/SkySystem.js';
import { TextureAtlas } from './rendering/TextureAtlas.js';
import { ViewModelRenderer } from './rendering/ViewModelRenderer.js';
import { WaterRenderer } from './rendering/WaterRenderer.js';
import { Weather, WeatherRenderer } from './rendering/WeatherRenderer.js';
import { WeatherSystem, isPrecipitation } from './world/WeatherSystem.js';
import { GameplayEvent } from './audio/SoundEvents.js';
import { Screen, UIManager } from './ui/UIManager.js';
import { detectDevice } from './utils/DeviceDetector.js';
import { clamp, parseSeed } from './utils/MathUtils.js';
import { World } from './world/World.js';
import { getBlock } from './world/BlockRegistry.js';
import { Block } from './world/BlockTypes.js';
import {
  fluidIsFalling,
  fluidLevel,
  fluidState,
  pressurePlatePowered,
} from './world/BlockState.js';
import { fertilisePlant, plantCrop } from './world/behaviors/AgricultureBehaviors.js';
import { igniteBlock } from './world/behaviors/FireBehaviors.js';
import {
  PortalTracker,
  lightPortal,
  linkedDimension,
  linkedPosition,
  resolveDestination,
} from './world/NetherPortal.js';
import { isDimensionImplemented } from './world/DimensionGenerators.js';
import { Dimension } from './world/DimensionConfig.js';
import { END_ARRIVAL_PLATFORM } from './world/EndGenerator.js';
import {
  pressButton,
  rotateRepeaterDelay,
  toggleLever,
  touchPressurePlate,
} from './world/behaviors/RedstoneBehaviors.js';
import {
  bedSpawnPoint,
  toggleDoor,
  toggleFenceGate,
  toggleTrapdoor,
} from './world/behaviors/StructuralBehaviors.js';
import { getItem, getItemName } from './items/ItemRegistry.js';
import { ItemStack } from './items/ItemStack.js';
import { ToolType } from './items/ItemTypes.js';
import { CombatSystem } from './interaction/CombatSystem.js';
import { EXHAUSTION, MAX_HUNGER } from './player/PlayerStats.js';
import { SLOT } from './player/Inventory.js';
import { CraftingGrid } from './crafting/CraftingGrid.js';
import { recipesForStation } from './crafting/RecipeRegistry.js';
import { ingredientOptions } from './crafting/RecipeTypes.js';
import { playerToContainer } from './containers/ItemTransfer.js';
import { FURNACE_SLOT } from './world/blockentity/FurnaceBlockEntity.js';
import { button, el } from './ui/dom.js';
import { Phase3Runtime } from './progression/Phase3Runtime.js';
import { Phase4Runtime } from './progression/Phase4Runtime.js';
import { Phase5Runtime } from './progression/Phase5Runtime.js';
import { AdvancementSystem } from './progression/AdvancementSystem.js';
import { getDifficulty, isPermadeathDifficulty } from './gameplay/Difficulty.js';
import { TensionDirector } from './gameplay/TensionDirector.js';
import { NoiseSystem } from './gameplay/NoiseSystem.js';
import { EnderDragonRenderer } from './rendering/EnderDragonRenderer.js';
import { EyeOfEnderRenderer } from './rendering/EyeOfEnderRenderer.js';
import { combineOnAnvil, grindstone } from './progression/EnchantingSystem.js';

/** Load progress at which the world is considered playable. */
const READY_PROGRESS = 0.9;
/** Maximum seconds to wait for chunks before starting anyway. */
const LOADING_TIMEOUT = 22;
/** Seconds between weather rolls. */
const WEATHER_ROLL_INTERVAL = 95;
const PHASE3_STATIONS = new Set([
  Block.ENCHANTING_TABLE, Block.ANVIL, Block.GRINDSTONE, Block.SMITHING_TABLE, Block.BREWING_STAND,
]);

export class Game {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.capabilities = detectDevice();
    this.bus = new EventBus();
    this.subscriptions = new SubscriptionGroup();

    this.settings = new SettingsManager(this.bus, this.capabilities);
    this.resources = new ResourceManager();

    /** @type {World|null} */
    this.world = null;
    /** @type {Player|null} */
    this.player = null;
    /** Live Phase 3 progression and automation services for the active world. */
    this.phase3 = null;
    /** Live Phase 4 Nether services: Wither fights, bartering, strider steering. */
    this.phase4 = null;
    /** Live End campaign, dragon and portal state. */
    this.phase5 = null;
    /** Persistent achievements, statistics and death markers. */
    this.advancements = null;
    this.dragonRenderer = null;
    this.eyeOfEnderRenderer = null;
    this._lastStatPosition = null;
    /** @type {import('./core/SaveManager.js').WorldRecord|null} */
    this.worldRecord = null;

    this.paused = false;
    this.destroyed = false;
    this._loadingElapsed = 0;
    this._awaitingSpawn = false;
    this._autosaveTimer = 0;
    this._weatherTimer = 0;
    /** Last block column sampled for biome temperature. */
    this._weatherSampleX = Number.NaN;
    this._weatherSampleZ = Number.NaN;
    /** @type {WeatherSystem|null} */
    this.weatherSystem = null;
    this._playTime = 0;
    this._target = createRaycastHit();
    this._fluidTarget = createRaycastHit();
    this._forward = new THREE.Vector3(0, 0, -1);
    this._eye = new THREE.Vector3();
    /** Previous frame's water state, so entry can be detected as an edge. */
    this._wasInWater = false;
    /** Most recent frame delta, shared with the audio event throttle. */
    this._lastDelta = 0;
    this._bowCharge = 0;
    this._dragonRoarTimer = 0;
  }

  /**
   * Builds every session-scoped subsystem.
   *
   * @returns {Promise<void>}
   * @throws When WebGL is unavailable, which is the one failure the game cannot
   *   recover from and which `main.js` turns into a readable error screen.
   */
  async initialise() {
    if (!this.capabilities.webglAvailable) {
      throw new Error(
        'WebGL is not available in this browser. Enable hardware acceleration, or try a different browser.'
      );
    }

    UIManager.setBootProgress(0.1, 'Reading settings…');
    const { firstRun } = this.settings.load();

    UIManager.setBootProgress(0.2, 'Creating renderer…');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      this.settings.get('display.fov'),
      1,
      0.08,
      512
    );
    this.scene.add(this.camera);

    this.renderer = new Renderer({
      canvas: this.canvas,
      scene: this.scene,
      camera: this.camera,
      bus: this.bus,
      settings: this.settings,
      capabilities: this.capabilities,
    });

    UIManager.setBootProgress(0.35, 'Painting textures…');
    this.shaderManager = new ShaderManager(this.renderer.renderer);
    this.atlas = new TextureAtlas(this.capabilities);
    this.atlas.build();
    this.resources.acquireShared('atlas:texture', () => this.atlas);

    UIManager.setBootProgress(0.5, 'Compiling shaders…');
    this.materials = new Materials({
      shaderManager: this.shaderManager,
      atlas: this.atlas,
      settings: this.settings,
      resources: this.resources,
    });
    const shadersOk = this.materials.build();

    UIManager.setBootProgress(0.62, 'Preparing input…');
    this.input = new InputManager({
      canvas: this.canvas,
      bus: this.bus,
      settings: this.settings,
      capabilities: this.capabilities,
    });
    this.input.attach();

    UIManager.setBootProgress(0.72, 'Opening saves…');
    this.saveManager = new SaveManager(this.bus);
    this.storageStatus = await this.saveManager.open();

    UIManager.setBootProgress(0.82, 'Building interface…');
    this.audio = new AudioManager({
      bus: this.bus,
      settings: this.settings,
      capabilities: this.capabilities,
      // Vite rewrites BASE_URL at build time; the manifest lives beside the game.
      assetBaseUrl: import.meta.env?.BASE_URL ?? '/',
    });
    // Injected rather than imported so the audio layer stays independent of the
    // block registry.
    setBlockSoundGroupResolver((blockId) => getBlock(blockId).soundGroup);
    this.audio.attachEvents(this.subscriptions);
    // Short-lived record of how loud the player has been, consumed by the horror
    // roster's hearing checks.
    this.noise = new NoiseSystem();
    this._attachNoiseEvents();
    // Owns the pacing of distant scares, the heartbeat and the music phase.
    this.tension = new TensionDirector({ audio: this.audio });

    const uiRoot = document.getElementById('ui-root');
    if (!uiRoot) throw new Error('The UI root element is missing from the page');

    this.ui = new UIManager({
      root: uiRoot,
      bus: this.bus,
      settings: this.settings,
      input: this.input,
      capabilities: this.capabilities,
      atlas: this.atlas,
      handlers: this._createUiHandlers(),
    });

    this.loop = new GameLoop({
      fixedUpdate: (step) => this._fixedUpdate(step),
      update: (dt) => this._update(dt),
      render: (dt) => this._render(dt),
    });
    this.loop.setMaxFps(this.settings.get('display.maxFps'));

    this._attachLifecycleEvents();

    UIManager.setBootProgress(0.95, 'Loading worlds…');
    const worlds = await this.saveManager.listWorlds();

    this.ui.dismissBootScreen();
    this.ui.showMenu(worlds, {
      persistent: this.saveManager.isPersistent,
      error: this.saveManager.lastError,
    });

    if (!shadersOk) {
      this.ui.notifications.warning(
        'Your GPU rejected the custom voxel shader, so a simpler lighting path is being used. The world is fully playable.',
        { id: 'shader-fallback', duration: 9000 }
      );
    }
    // Reported separately from the world shader: losing only the water program
    // costs the animated surface, not the lighting, so the message must not
    // imply the whole world degraded. Either way the surface stays blue/teal —
    // never the magenta the fallback path used to be able to produce.
    if (this.materials.usingWaterFallback) {
      this.ui.notifications.warning(
        'The animated water shader was rejected by your GPU. Water is drawn with a simpler transparent material instead.',
        { id: 'water-shader-fallback', duration: 9000 }
      );
    }
    if (firstRun) {
      this.ui.notifications.info(
        `Graphics set to "${this.settings.get('graphics.preset')}" based on this device. Change it any time in Settings.`,
        { id: 'first-run-preset', duration: 7000 }
      );
    }
    if (!this.saveManager.isPersistent) {
      this.ui.notifications.warning(
        'Browser storage is unavailable, so worlds will not survive a reload.',
        { id: 'storage-unavailable', duration: 9000 }
      );
    }

    // The loop runs even in the menu: the renderer needs to keep presenting, and
    // it keeps the frame-time statistics warm for dynamic resolution.
    this.loop.start();
    this.bus.emit(Events.GAME_READY);
  }

  // -------------------------------------------------------------- UI handlers

  _createUiHandlers() {
    return {
      onCreateWorld: (options) => this._createWorld(options),
      onPlayWorld: (worldId) => this._loadWorld(worldId),
      onDeleteWorld: (worldId) => this._deleteWorld(worldId),
      onExportWorld: (worldId) => this._exportWorld(worldId),
      onImportWorld: (file) => this._importWorld(file),
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      onSaveNow: () => this.save({ manual: true }),
      onQuitToMenu: () => this.quitToMenu(),
      onToggleInventory: () => this._toggleInventory(),
      onSelectHotbarSlot: (slot) => {
        this.player?.inventory.selectSlot(slot);
        this.bus.emit(Events.PLAY_SOUND, { name: 'ui.select' });
      },
      onPickBlock: (blockId, targetSlot) => {
        if (typeof targetSlot === 'number' && targetSlot >= 0 && targetSlot < 9) {
          this.player?.inventory.selectSlot(targetSlot);
        }
        this.player?.inventory.pickBlock(blockId);
      },
      onRespawn: () => this._respawnPlayer(),
      onCloseContainer: () => this._closeContainer(),
      onToggleCamera: () => this._toggleCamera(),
      onShowProgress: () => this._showProgress(),
      onCloseStory: () => this._closeStory(),
      onCreditsFinished: () => {
        this.phase5?.markCreditsSeen();
        if (this.worldRecord) this.worldRecord.phase5 = this.phase5?.toJSON() ?? null;
      },
    };
  }

  // ------------------------------------------------------------------ combat

  /**
   * Swings at whatever the crosshair is on.
   *
   * @param {import('./interaction/BlockRaycaster.js').RaycastHit|null} target
   * @param {string|null} heldItemId
   * @returns {boolean} True when an entity was struck, so mining is skipped.
   */
  _tryAttack(target, heldItemId) {
    const player = this.player;
    const reach = clamp(
      this.settings.get('gameplay.reach'),
      INTERACTION.minReach,
      INTERACTION.maxReach
    );

    const result = this.combat.tryAttack({
      origin: this._eye,
      direction: this._forward,
      reach,
      itemId: heldItemId,
      // The targeted block bounds the search: anything beyond it is behind a wall.
      blockDistance: target?.hit ? target.distance : Infinity,
      candidates: this.entities.livingEntities(),
      creative: player.isCreative,
      damageMultiplier: player.attackDamageMultiplier,
    });

    // The swing itself is tiring whether or not it connected.
    if (this.combat.swingTimer > 0) {
      player.stats.addExhaustion(CombatSystem.swingExhaustion);
    }
    if (!result) return false;

    if (result.wears) player.inventory.damageSelected(result.cost);
    return true;
  }


  /** Feeds or grows the passive creature under the crosshair. */
  _tryUseEntity(target, heldItemId) {
    if (!heldItemId || !this.entities) return false;
    const reach = clamp(
      this.settings.get('gameplay.reach'),
      INTERACTION.minReach,
      INTERACTION.maxReach
    );
    const result = this.entities.tryFeedMob({
      origin: this._eye,
      direction: this._forward,
      reach,
      blockDistance: target?.hit ? target.distance : Infinity,
      itemId: heldItemId,
    });
    if (!result) return false;

    if (!this.player.isCreative) this.player.inventory.consumeSelected();
    const name = result.mob.definition?.displayName ?? 'Animal';
    this.ui.notifications.success(
      result.mode === 'tame' ? `${name} is now tamed.` :
        result.mode === 'grow' ? `${name} grew a little faster.` : `${name} is ready to breed.`,
      { id: 'animal-fed', duration: 1500 }
    );
    this.bus.emit(Events.PLAY_SOUND, { name: 'player.eat', volume: 0.42, pitch: 1.18 });
    return true;
  }

  /**
   * Records a mined block: charges tool wear and warns about a wasted swing.
   * @param {{blockId: number, dropped: boolean, itemId: string|null, wears: boolean}} broken
   */
  _onBlockMined(broken) {
    const player = this.player;
    player.stats.addExhaustion(EXHAUSTION.mine);

    if (broken.wears) player.inventory.damageSelected(1);

    const xpByBlock = {
      [Block.COAL_ORE]: 2,
      [Block.IRON_ORE]: 3,
      [Block.GOLD_ORE]: 5,
      [Block.DIAMOND_ORE]: 8,
      [Block.REDSTONE_ORE]: 4,
    };
    const xp = xpByBlock[broken.blockId];
    if (xp && broken.dropped) player.stats.addExperience(xp);

    // Tell the player when a block yielded nothing, and why. Silently destroying
    // an ore vein because the pickaxe was too weak is the single most confusing
    // thing a mining system can do.
    if (!broken.dropped && !player.isCreative && this.settings.get('gameplay.dropItems')) {
      const definition = getBlock(broken.blockId);
      if (definition.stackSize > 0) {
        this.ui.notifications.warning(
          `${definition.displayName} needs a better tool to harvest.`,
          { id: 'wrong-tool', duration: 2400 }
        );
      }
    }
  }

  /**
   * Item-specific right-click behaviour, for items that act on a block.
   *
   * Runs after `_tryUseBlock`, so a workstation always wins: right-clicking a
   * crafting table while holding a hoe should open the table.
   *
   * @param {import('./interaction/BlockRaycaster.js').RaycastHit|null} target
   * @param {string|null} heldItemId
   * @returns {boolean} True when the interaction was consumed.
   */
  _tryEat(heldItemId) {
    if (!heldItemId) return false;
    const definition = getItem(heldItemId);
    if (!definition || definition.foodValue <= 0) return false;
    if (!this.player.stats.enabled) return false;
    if (this.player.stats.hunger >= MAX_HUNGER && this.player.stats.saturation >= this.player.stats.hunger) return false;
    if (!this.player.stats.eat(definition.foodValue, definition.saturation)) return false;
    this.player.inventory.consumeSelected();
    if (definition.metadata.teleportsOnEat) {
      const radius = Number(definition.metadata.teleportsOnEat) || 8;
      const angle = (this._playTime * 7.31 + this.player.position.x * 0.17) % (Math.PI * 2);
      const x = this.player.position.x + Math.cos(angle) * radius;
      const z = this.player.position.z + Math.sin(angle) * radius;
      const spawn = this.world.findSpawnPosition(x, z);
      this.player.teleport(spawn.x, spawn.y, spawn.z);
    }
    this.bus.emit(Events.PLAY_SOUND, { name: 'player.eat', volume: 0.85 });
    return true;
  }

  /**
   * Item-specific right-click behaviour, for items that act on a block.
   *
   * Runs after `_tryUseBlock`, so a workstation always wins: right-clicking a
   * crafting table while holding a hoe should open the table.
   *
   * @param {import('./interaction/BlockRaycaster.js').RaycastHit|null} target
   * @param {string|null} heldItemId
   * @returns {boolean} True when the interaction was consumed.
   */
  _tryUseItem(target, heldItemId) {
    if (!heldItemId) return false;
    const definition = getItem(heldItemId);
    if (!definition) return false;

    if (definition.toolType === ToolType.BUCKET) {
      return this._useBucket(target, definition);
    }

    if (heldItemId === 'eye_of_ender' && (!target?.hit || target.blockId !== Block.END_PORTAL_FRAME)) {
      const throwResult = this.phase5?.throwEyeOfEnder(
        this.player.position.x, this.player.position.y + this.player.eyeHeight, this.player.position.z
      );
      if (!throwResult) return false;
      if (!this.player.isCreative) this.player.inventory.consumeSelected();
      this.eyeOfEnderRenderer?.launch(throwResult);
      const dx = throwResult.target.x - this.player.position.x;
      const dz = throwResult.target.z - this.player.position.z;
      this._notifyAdvancement(this.advancements?.trigger('locate:stronghold', {
        playTime:this._playTime, dimension:this.world.dimensionId,
      }));
      this.ui.notifications.info(
        `The Eye flies ${Math.round(Math.hypot(dx, dz))} blocks toward the stronghold${throwResult.shatters ? ' and shatters' : ''}.`,
        { id:'eye-of-ender', duration:4200 }
      );
      this.bus.emit(Events.PLAY_SOUND, { name:'projectile.hit', volume:.55, pitch:1.3 });
      return true;
    }

    if (heldItemId === 'ender_pearl') {
      const distance = target?.hit
        ? Math.min(16, Math.hypot(target.placeX-this.player.position.x, target.placeY-this.player.position.y, target.placeZ-this.player.position.z))
        : 16;
      const x = target?.hit ? target.placeX + .5 : this.player.position.x + this._forward.x * distance;
      const y = target?.hit ? target.placeY : this.player.position.y + this._forward.y * distance;
      const z = target?.hit ? target.placeZ + .5 : this.player.position.z + this._forward.z * distance;
      if (!this.player.isCreative) this.player.inventory.consumeSelected();
      this.player.teleport(x, Math.max(2, y), z);
      this.player.stats.applyDamage?.(2.5, 'ender_pearl');
      this.bus.emit(Events.PLAY_SOUND, { name:'projectile.hit', volume:.7 });
      return true;
    }

    if (heldItemId === 'glass_bottle' && this.phase5?.collectDragonBreath()) {
      this._exchangeSelectedItem('dragon_breath');
      this.ui.notifications.success('Dragon breath collected.', { id:'dragon-breath', duration:1800 });
      return true;
    }

    if (heldItemId === 'end_crystal' && target?.hit) {
      const placed = this.phase5?.placeRespawnCrystal(
        target.placeX, target.placeY, target.placeZ, this.world.dimensionId
      );
      if (placed) {
        if (!this.player.isCreative) this.player.inventory.consumeSelected();
        if (placed.ready) {
          this._notifyAdvancement(this.advancements?.trigger('respawn:ender_dragon', {
            playTime:this._playTime, dimension:this.world.dimensionId,
          }));
          this.ui.notifications.warning('The Ender Dragon has been resummoned.', { id:'dragon-respawn', duration:5000 });
        } else {
          this.ui.notifications.info(`Respawn crystals: ${placed.count}/4`, { id:'dragon-crystals', duration:1800 });
        }
        return true;
      }
    }

    if (!target || !target.hit) return false;

    if (heldItemId === 'eye_of_ender' && target.blockId === Block.END_PORTAL_FRAME) {
      const result = this.phase5?.placeEyeOfEnder(target.blockX, target.blockY, target.blockZ);
      if (!result) return false;
      if (!this.player.isCreative) this.player.inventory.consumeSelected();
      this.ui.notifications.info(
        result.lit ? 'The End portal opens.' : `Portal eyes: ${result.filled}/${result.total}`,
        { id:'portal-eyes', duration:2600 }
      );
      return true;
    }

    if (definition.metadata.ignites) {
      // A portal frame wins over a plain fire. Striking the inside of an
      // obsidian ring should open the portal, not light a fire inside it.
      if (lightPortal(this.world, target.placeX, target.placeY, target.placeZ)) {
        this.player.inventory.damageSelected(1);
        this.bus.emit(Events.PLAY_SOUND, { name: 'item.ignite', volume: 0.9 });
        return true;
      }
      if (!igniteBlock(this.world, target.placeX, target.placeY, target.placeZ)) return false;
      this.player.inventory.damageSelected(1);
      this.bus.emit(Events.PLAY_SOUND, { name: 'item.ignite', volume: 0.82 });
      return true;
    }

    if (definition.metadata.plantsCrop) {
      if (target.normalY !== 1) return false;
      if (!plantCrop(
        this.world,
        target.blockX,
        target.blockY + 1,
        target.blockZ,
        definition.metadata.plantsCrop
      )) return false;
      this.player.inventory.consumeSelected();
      this.bus.emit(Events.PLAY_SOUND, { name: 'block.plant', volume: 0.72 });
      return true;
    }
    if (heldItemId === 'bone_meal') {
      if (!fertilisePlant(this.world, target.blockX, target.blockY, target.blockZ, this._playTime | 0)) {
        return false;
      }
      this.player.inventory.consumeSelected();
      this.bus.emit(Events.PLAY_SOUND, { name: 'block.plant', volume: 0.78 });
      return true;
    }
    if (definition.toolType === ToolType.HOE) {
      return this._tillSoil(target);
    }
    return false;
  }

  /** Collects a source fluid or places the fluid carried by a bucket. */
  _useBucket(target, definition) {
    const carried = definition.metadata.fluid ?? null;

    if (carried === null) {
      const reach = clamp(
        this.settings.get('gameplay.reach'),
        INTERACTION.minReach,
        INTERACTION.maxReach
      );
      const liquid = this.raycaster.cast(this._eye, this._forward, reach, {
        includeLiquids: true,
        out: this._fluidTarget,
      });
      if (!liquid.hit || (liquid.blockId !== Block.WATER && liquid.blockId !== Block.LAVA)) {
        return false;
      }
      const state = this.world.getBlockState(liquid.blockX, liquid.blockY, liquid.blockZ);
      if (fluidLevel(state) !== 0 || fluidIsFalling(state)) return false;

      const filledItem = liquid.blockId === Block.WATER ? 'water_bucket' : 'lava_bucket';
      if (!this.world.setBlock(liquid.blockX, liquid.blockY, liquid.blockZ, Block.AIR, {
        cause: 'bucket-pickup',
      })) return false;
      this._exchangeSelectedItem(filledItem);
      this.bus.emit(Events.PLAY_SOUND, { name: 'item.bucket', volume: 0.82 });
      return true;
    }

    if (!target?.hit) return false;
    const fluidBlock = carried === 'water' ? Block.WATER : carried === 'lava' ? Block.LAVA : Block.AIR;
    if (fluidBlock === Block.AIR) return false;
    if (!this.world.placeBlock(target.placeX, target.placeY, target.placeZ, fluidBlock, {
      allowReplaceLiquid: true,
      state: fluidState(0, false),
    })) return false;

    this._exchangeSelectedItem(definition.metadata.emptiesTo ?? 'bucket');
    this.bus.emit(Events.PLAY_SOUND, { name: 'item.bucket', volume: 0.82 });
    return true;
  }

  /** Replaces one selected item and safely spills a container result if full. */
  _exchangeSelectedItem(resultItemId) {
    if (this.player.isCreative) return;
    const inventory = this.player.inventory;
    const selected = inventory.selectedStack;
    if (!selected) return;

    if (selected.quantity === 1) {
      inventory.setSlot(inventory.selectedSlot, new ItemStack(resultItemId, 1));
      return;
    }

    inventory.consumeSelected();
    const result = new ItemStack(resultItemId, 1);
    const remaining = inventory.addItem(result);
    if (remaining > 0 && this.entities) {
      this.entities.spawnItemStack(
        this.player.position.x,
        this.player.position.y + 1,
        this.player.position.z,
        result
      );
    }
  }

  /**
   * Turns dirt or grass into farmland.
   *
   * Only works on an upward face with air above: tilling the underside of a block,
   * or soil with something sitting on it, makes no sense and would let a player
   * destroy whatever was on top.
   *
   * @param {import('./interaction/BlockRaycaster.js').RaycastHit} target
   * @returns {boolean}
   */
  _tillSoil(target) {
    const { blockX: x, blockY: y, blockZ: z, blockId } = target;
    if (blockId !== Block.DIRT && blockId !== Block.GRASS) return false;
    // Must be hit from above, and have room for a crop.
    if (target.normalY !== 1) return false;
    if (this.world.getBlock(x, y + 1, z) !== Block.AIR) return false;

    if (!this.world.setBlock(x, y, z, Block.FARMLAND, { cause: 'player' })) return false;

    if (!this.player.isCreative) {
      this.player.inventory.damageSelected(1);
      this.player.stats.addExhaustion(EXHAUSTION.mine);
    }
    this.bus.emit(Events.BLOCK_TILLED, { x, y, z });
    this.bus.emit(Events.PLAY_SOUND, { name: 'block.till', volume: 0.8 });
    return true;
  }

  // -------------------------------------------------------------- containers

  /**
   * A searchable list of what a station can make.
   *
   * Clicking an entry lays the recipe out in the grid, pulling the ingredients
   * from the player's inventory. That is the whole point of a recipe book: not
   * documentation, but a way to skip remembering patterns. Anything the player
   * does not have is left blank, so a partially satisfiable recipe still shows what
   * is missing.
   *
   * @param {import('./crafting/CraftingGrid.js').CraftingGrid} grid
   * @returns {HTMLElement}
   */
  _buildRecipeBook(grid) {
    const list = el('div', { className: 'recipe-list' });
    const search = el('input', {
      className: 'text-input recipe-search',
      attrs: { type: 'search', placeholder: 'Search recipes', 'aria-label': 'Search recipes' },
    });

    const available = recipesForStation(grid.station).filter(
      (recipe) => recipe.kind !== 'smelting'
    );

    const render = () => {
      const query = search.value.trim().toLowerCase();
      const matches = available.filter((recipe) => {
        if (!query) return true;
        return (
          getItemName(recipe.result.id).toLowerCase().includes(query) ||
          recipe.id.includes(query)
        );
      });

      list.replaceChildren(
        ...matches.slice(0, 60).map((recipe) => {
          const canMake = this._canAssemble(recipe);
          const entry = el(
            'button',
            {
              className: `recipe-entry ui-button${canMake ? '' : ' is-unavailable'}`,
              attrs: {
                type: 'button',
                title: `${getItemName(recipe.result.id)} x${recipe.result.count}`,
              },
              on: {
                click: (event) => {
                  event.preventDefault();
                  this._layOutRecipe(grid, recipe);
                  this.ui.containerScreen.refresh();
                },
              },
            },
            [
              el('img', {
                className: 'recipe-icon',
                alt: '',
                attrs: {
                  src: this.atlas.getItemIcon(recipe.result.id, 32),
                  'aria-hidden': 'true',
                },
              }),
              el('span', {
                className: 'recipe-name',
                text:
                  getItemName(recipe.result.id) +
                  (recipe.result.count > 1 ? ` x${recipe.result.count}` : ''),
              }),
            ]
          );
          return entry;
        })
      );

      if (matches.length === 0) {
        list.appendChild(el('p', { className: 'recipe-empty', text: 'No matching recipes.' }));
      }
    };

    search.addEventListener('input', render);
    render();

    return el('details', { className: 'recipe-book', attrs: { open: '' } }, [
      el('summary', { text: `Recipe book (${available.length})` }),
      search,
      list,
    ]);
  }

  /**
   * Whether the player holds enough to assemble a recipe right now.
   * @param {import('./crafting/RecipeTypes.js').Recipe} recipe
   */
  _canAssemble(recipe) {
    const inventory = this.player.inventory;
    if (inventory.creative) return true;
    /** @type {Map<string, number>} */
    const needed = new Map();
    for (const ingredient of recipe.ingredients) {
      // Count against the first option the player actually has, which is a good
      // enough approximation for an availability hint.
      const options = ingredientOptions(ingredient);
      const held = options.find((id) => inventory.countOf(id) > (needed.get(id) ?? 0));
      if (!held) return false;
      needed.set(held, (needed.get(held) ?? 0) + 1);
    }
    return true;
  }

  /**
   * Moves a recipe's ingredients from the inventory into the grid.
   *
   * Anything already on the grid is reclaimed first, so clicking a second recipe
   * replaces the layout instead of mixing two together.
   *
   * @param {import('./crafting/CraftingGrid.js').CraftingGrid} grid
   * @param {import('./crafting/RecipeTypes.js').Recipe} recipe
   */
  _layOutRecipe(grid, recipe) {
    const inventory = this.player.inventory;

    for (const stack of grid.reclaim()) {
      inventory.addItem(stack);
      if (!stack.isEmpty) this._dropStackInWorld(stack);
    }

    const place = (slot, ingredient) => {
      if (!ingredient) return;
      const options = ingredientOptions(ingredient);
      const held = options.find((id) => inventory.countOf(id) > 0);
      if (!held) return;
      if (inventory.creative) {
        grid.container.setSlot(slot, new ItemStack(held, 1));
        return;
      }
      if (inventory.removeItem(held, 1) === 0) return;
      grid.container.setSlot(slot, new ItemStack(held, 1));
    };

    if (recipe.kind === 'shaped') {
      // Copy the pattern into the top-left of the grid.
      for (let y = 0; y < recipe.height; y++) {
        for (let x = 0; x < recipe.width; x++) {
          place(y * grid.size + x, recipe.grid[y * recipe.width + x]);
        }
      }
    } else {
      recipe.ingredients.forEach((ingredient, index) => place(index, ingredient));
    }
    grid.refresh(true);
  }

  /**
   * Right-click behaviour, in priority order.
   *
   * The spec's ordering matters: a player holding a stack of dirt and looking at a
   * furnace expects to open the furnace, not to bury it. So interacting with the
   * *targeted block* wins over placing the *held item*, and eating wins over
   * placing too.
   *
   * Returns true when the interaction was consumed, in which case `BlockPlacer`
   * must not also run — otherwise a single right-click would open a chest and
   * place a block.
   *
   * @param {import('./interaction/BlockRaycaster.js').RaycastHit} target
   * @returns {boolean}
   */
  _tryUseBlock(target) {
    if (!target || !target.hit) return false;

    const blockId = target.blockId;
    if (blockId === Block.CRAFTING_TABLE) {
      this._openCraftingTable(target.blockX, target.blockY, target.blockZ);
      return true;
    }
    if (blockId === Block.FURNACE || blockId === Block.FURNACE_LIT) {
      this._openFurnace(target.blockX, target.blockY, target.blockZ);
      return true;
    }
    if (blockId === Block.CHEST) {
      this._openChest(target.blockX, target.blockY, target.blockZ);
      return true;
    }
    if (blockId === Block.SHULKER_BOX) {
      this._openChest(target.blockX, target.blockY, target.blockZ);
      return true;
    }
    if (blockId === Block.END_GATEWAY && this.world.dimensionId === Dimension.END) {
      const destination = this.phase5?.outerEndDestination();
      if (!destination) return false;
      this.player.teleport(destination.x, destination.y + 2, destination.z);
      this._notifyAdvancement(this.advancements?.trigger('locate:end_city', {
        playTime:this._playTime, dimension:Dimension.END,
      }));
      this.ui.notifications.info('The gateway carries you to the outer End.', {
        id:'end-gateway', duration:3600,
      });
      return true;
    }
    if (PHASE3_STATIONS.has(blockId)) {
      this._openPhase3Station(blockId, target.blockX, target.blockY, target.blockZ);
      return true;
    }
    if (blockId === Block.PISTON || blockId === Block.STICKY_PISTON) {
      const direction = { x: target.normalX, y: target.normalY, z: target.normalZ };
      const plan = this.phase3.pistons.plan(this.world, { x:target.blockX, y:target.blockY, z:target.blockZ }, direction, blockId === Block.STICKY_PISTON);
      const moved = this.phase3.pistons.execute(this.world, plan);
      this.ui.notifications.info(moved ? 'Piston moved the block line.' : 'Piston is blocked.', { id:'piston', duration:1400 });
      return true;
    }
    if (blockId === Block.LEVER) {
      const active = toggleLever(this.world, target.blockX, target.blockY, target.blockZ);
      if (active === null) return false;
      this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.7 });
      return true;
    }
    if (blockId === Block.OAK_TRAPDOOR) {
      const open = toggleTrapdoor(this.world, target.blockX, target.blockY, target.blockZ);
      if (open === null) return false;
      this.bus.emit(Events.PLAY_SOUND, {
        name: 'ui.click',
        volume: 0.62,
        pitch: open ? 1.08 : 0.92,
      });
      return true;
    }
    if (blockId === Block.OAK_FENCE_GATE) {
      const open = toggleFenceGate(this.world, target.blockX, target.blockY, target.blockZ);
      if (open === null) return false;
      this.bus.emit(Events.PLAY_SOUND, {
        name: 'ui.click',
        volume: 0.62,
        pitch: open ? 1.08 : 0.92,
      });
      return true;
    }
    if (blockId === Block.OAK_DOOR) {
      const open = toggleDoor(this.world, target.blockX, target.blockY, target.blockZ);
      if (open === null) return false;
      this.bus.emit(Events.PLAY_SOUND, {
        name: 'ui.click',
        volume: 0.68,
        pitch: open ? 1.05 : 0.9,
      });
      return true;
    }
    if (blockId === Block.STONE_BUTTON) {
      if (!pressButton(this.world, target.blockX, target.blockY, target.blockZ)) return false;
      this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.55, pitch: 1.25 });
      return true;
    }
    if (blockId === Block.WHITE_BED) {
      return this._useBed(target.blockX, target.blockY, target.blockZ);
    }
    if (blockId === Block.REPEATER) {
      const delay = rotateRepeaterDelay(
        this.world,
        target.blockX,
        target.blockY,
        target.blockZ
      );
      if (delay === null) return false;
      this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.64 });
      this.ui.notifications.info(`Repeater delay: ${delay} tick${delay === 1 ? '' : 's'}`, {
        id: 'repeater-delay',
        duration: 1000,
      });
      return true;
    }
    return false;
  }

  _openPhase3Station(blockId, x, y, z) {
    const inventory=this.player.inventory;
    const title=getBlock(blockId)?.displayName ?? 'Workstation';
    const status=el('p',{className:'container-hint',text:'Select an item in the hotbar, then use the workstation action.'});
    const actions=[];
    const refresh=()=>this.ui.containerScreen.refresh();
    if(blockId===Block.ENCHANTING_TABLE){
      actions.push(button('Enchant selected item',()=>{
        const stack=inventory.selectedStack;if(!stack)return;
        const item=getItem(stack.itemId);const itemClass=item?.armourSlot?(item.armourSlot==='boots'?'boots':'armour'):(item?.toolType==='sword'||item?.toolType==='axe'?item.toolType:item?.metadata?.rangedWeapon?'bow':'tool');
        const offer=this.phase3.enchanting.offers({seed:this.world.seed^x^(z<<8),itemClass,bookshelves:15})[0];
        if(this.player.stats.level<offer.cost){status.textContent=`Need level ${offer.cost}.`;return;}
        const result=this.phase3.enchanting.apply(stack,offer,{levels:this.player.stats.level,lapis:offer.lapis});
        if(!result){status.textContent='This item cannot take that enchantment.';return;}
        this.player.stats.level-=result.levelsSpent;this.player.stats._emitXp();
        status.textContent=`Applied ${Object.keys(offer.enchantments).join(', ')}.`;refresh();
      }));
    } else if(blockId===Block.GRINDSTONE){
      actions.push(button('Disenchant selected item',()=>{const stack=inventory.selectedStack;if(!stack)return;const result=grindstone(stack);inventory.setSlot(inventory.selectedSlot,result.stack);this.player.stats.addExperience(result.experience);status.textContent=`Removed enchantments; recovered ${result.experience} XP.`;refresh();}));
    } else if(blockId===Block.ANVIL){
      actions.push(button('Combine selected + cursor',()=>{const left=inventory.selectedStack,right=inventory.cursor;const result=combineOnAnvil(left,right);if(!result){status.textContent='Hold the second item on the cursor.';return;}if(this.player.stats.level<result.levelCost){status.textContent=`Need level ${result.levelCost}.`;return;}inventory.setSlot(inventory.selectedSlot,result.stack);inventory.cursor=null;this.player.stats.level-=result.levelCost;this.player.stats._emitXp();status.textContent='Items combined.';refresh();}));
    } else if(blockId===Block.BREWING_STAND){
      const stand=this.phase3.registerBrewingStand(`${x},${y},${z}`);
      actions.push(button('Add brewing fuel',()=>{stand.addFuel();status.textContent=`Fuel: ${stand.fuel}/20.`;}));
      actions.push(button('Load selected ingredient',()=>{const stack=inventory.selectedStack;if(!stack)return;stand.ingredient=stack.itemId;stand.bottles=stand.bottles.map(p=>p??{effect:'water',duration:0,form:'drink'});if(!this.player.isCreative)inventory.consumeSelected();status.textContent=`Brewing ${stack.itemId}; fuel ${stand.fuel}/20.`;refresh();}));
    } else {
      status.textContent='Smithing upgrades preserve item metadata; advanced materials arrive through dimensional progression.';
    }
    this.ui.containerScreen.transferHandler=null;this.ui.containerScreen.dropHandler=(stack)=>this._dropStackInWorld(stack);
    this.ui.openContainer({title,inventory,panels:[],hint:'Phase 3 workstation',extra:[el('div',{className:'container-upper'},[status,...actions])]});
    this._openWorkstation={x,y,z};
  }

  /** Sets spawn at a bed and skips the night when sleeping is allowed. */
  _useBed(x, y, z) {
    const spawn = bedSpawnPoint(this.world, x, y, z);
    if (!spawn) return false;
    this.player.setSpawnPoint(spawn.x, spawn.y, spawn.z);
    const time = this.lighting?.timeOfDay ?? TIME.startTime;
    // Sleeping wakes the player in the morning, not at the default dusk start:
    // otherwise skipping the night would drop them straight back into sunset.
    const night = phaseAt(time) === 'night';
    if (night) {
      this.lighting.setTimeOfDay(TIME.morningTime);
      if (this.weather?.weather !== Weather.CLEAR) this.weather.setWeather(Weather.CLEAR);
      this.ui.notifications.success('Night skipped. Respawn point set.', {
        id: 'bed-sleep',
        duration: 2200,
      });
      this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.45, pitch: 0.75 });
    } else {
      this.ui.notifications.info('Respawn point set. You can sleep at night.', {
        id: 'bed-spawn',
        duration: 2200,
      });
    }
    return true;
  }

  /**
   * The survival inventory: 2x2 crafting, armour, offhand and storage.
   *
   * Creative keeps the searchable block palette instead — it needs a list of every
   * block, which is a different screen with different affordances.
   */
  _openInventoryScreen() {
    const inventory = this.player.inventory;
    const grid = this.playerCrafting;

    this.ui.containerScreen.transferHandler = (slot) => {
      // Shift-clicking in the inventory has nowhere special to go, so fall through
      // to the hotbar/main-grid move.
      void slot;
      return false;
    };
    this.ui.containerScreen.dropHandler = (stack) => this._dropStackInWorld(stack);

    this.ui.openContainer({
      title: 'Inventory',
      inventory,
      hint: 'Left click to move a stack, right click to split, shift-click to transfer. On touch: tap to lift, long-press to split, double-tap to transfer.',
      panels: [
        {
          id: 'crafting',
          label: 'Crafting',
          columns: 2,
          count: 4,
          className: 'slot-grid--crafting',
          read: (index) => grid.container.getSlot(index),
          act: (index, action) =>
            this.ui.containerScreen.actOnContainer(grid.container, index, action),
        },
        this._resultPanel(grid),
        {
          id: 'armour',
          label: 'Armour',
          columns: 4,
          count: 4,
          className: 'slot-grid--armour',
          read: (index) => inventory.getSlot(SLOT.ARMOUR_START + index),
          act: (index, action) =>
            this.ui.containerScreen._actOnInventory(SLOT.ARMOUR_START + index, action),
        },
        {
          id: 'offhand',
          label: 'Offhand',
          columns: 1,
          count: 1,
          className: 'slot-grid--offhand',
          read: () => inventory.getSlot(SLOT.OFFHAND),
          act: (_index, action) => this.ui.containerScreen._actOnInventory(SLOT.OFFHAND, action),
        },
      ],
    });
  }

  /**
   * The result panel shared by the 2x2 and 3x3 grids.
   *
   * Taking from it is the *only* thing that consumes ingredients, and shift-click
   * crafts as many times as the ingredients allow.
   *
   * @param {import('./crafting/CraftingGrid.js').CraftingGrid} grid
   */
  _resultPanel(grid) {
    return {
      id: 'result',
      label: 'Result',
      columns: 1,
      count: 1,
      className: 'slot-grid--result',
      takeOnly: true,
      read: () => {
        grid.refresh();
        return grid.result;
      },
      act: (_index, action) => {
        const inventory = this.player.inventory;

        if (action === 'transfer') {
          // Craft-all. Anything that will not fit is dropped at the player's feet
          // rather than discarded.
          const produced = grid.takeAll();
          for (const stack of produced) {
            this._notifyAdvancement(this.advancements?.craft(stack.itemId, stack.quantity, {
              playTime:this._playTime, dimension:this.world?.dimensionId,
            }));
            inventory.addItem(stack);
            if (!stack.isEmpty) this._dropStackInWorld(stack);
          }
          if (produced.length > 0) this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click' });
          return;
        }

        // A held stack can only absorb a compatible result; otherwise the click is
        // a no-op, because swapping would put the held item in a slot that is not
        // real storage.
        const cursor = inventory.cursor;
        grid.refresh();
        if (!grid.result) return;
        if (cursor && !cursor.canMergeWith(grid.result)) return;

        const produced = grid.takeResult();
        if (!produced) return;
        this._notifyAdvancement(this.advancements?.craft(produced.itemId, produced.quantity, {
          playTime:this._playTime, dimension:this.world?.dimensionId,
        }));
        if (cursor) cursor.merge(produced);
        if (!produced.isEmpty) {
          inventory.addItem(produced);
          if (!produced.isEmpty) this._dropStackInWorld(produced);
        }
        this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.5 });
      },
    };
  }

  /**
   * Opens a crafting table's 3x3 grid.
   *
   * The grid belongs to the *session*, not to the block: a crafting table holds no
   * state between uses, so a per-block grid would be state nobody expects to
   * persist. Contents are reclaimed on close.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  _openCraftingTable(x, y, z) {
    const grid = this.tableCrafting;
    const inventory = this.player.inventory;

    this.ui.containerScreen.transferHandler = (slot) =>
      playerToContainer(inventory, slot, grid.container) > 0;
    this.ui.containerScreen.dropHandler = (stack) => this._dropStackInWorld(stack);

    this.ui.openContainer({
      title: 'Crafting Table',
      inventory,
      hint: 'Shift-click the result to craft as many as your materials allow.',
      panels: [
        {
          id: 'crafting',
          label: 'Crafting',
          columns: 3,
          count: 9,
          className: 'slot-grid--crafting',
          read: (index) => grid.container.getSlot(index),
          act: (index, action) =>
            this.ui.containerScreen.actOnContainer(grid.container, index, action),
        },
        this._resultPanel(grid),
      ],
      extra: [this._buildRecipeBook(grid)],
    });
    this._openWorkstation = { x, y, z };
    this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.5 });
  }

  /**
   * Opens a furnace.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  _openFurnace(x, y, z) {
    const furnace = this.world.getBlockEntity(x, y, z);
    if (!furnace) return;
    const inventory = this.player.inventory;
    const container = furnace.container;

    // Shift-click routes fuel to the fuel slot and everything smeltable to the
    // input slot, which is what makes loading a furnace one gesture per stack.
    this.ui.containerScreen.transferHandler = (slot) => {
      const stack = inventory.getSlot(slot);
      if (!stack) return false;
      const isFuel = getItem(stack.itemId)?.fuelValue > 0;
      const target = isFuel ? [FURNACE_SLOT.FUEL] : [FURNACE_SLOT.INPUT];
      return playerToContainer(inventory, slot, container, target) > 0;
    };
    this.ui.containerScreen.dropHandler = (stack) => this._dropStackInWorld(stack);

    const gauges = el('div', { className: 'furnace-gauges' }, [
      el('div', { className: 'furnace-gauge' }, [
        el('span', { className: 'furnace-gauge-label', text: 'Fuel' }),
        el('div', { className: 'gauge-track' }, [
          el('div', { className: 'gauge-fill gauge-fill--fuel', dataset: { role: 'burn' } }),
        ]),
      ]),
      el('div', { className: 'furnace-gauge' }, [
        el('span', { className: 'furnace-gauge-label', text: 'Progress' }),
        el('div', { className: 'gauge-track' }, [
          el('div', { className: 'gauge-fill gauge-fill--cook', dataset: { role: 'cook' } }),
        ]),
      ]),
    ]);
    this._furnaceGauges = {
      burn: gauges.querySelector('[data-role="burn"]'),
      cook: gauges.querySelector('[data-role="cook"]'),
      furnace,
    };

    this.ui.openContainer({
      title: 'Furnace',
      inventory,
      hint: 'Shift-click sends fuel and ore to the right slots automatically. The furnace keeps working while this is closed.',
      panels: [
        {
          id: 'furnace-input',
          label: 'Smelt',
          columns: 1,
          count: 1,
          className: 'slot-grid--furnace',
          read: () => container.getSlot(FURNACE_SLOT.INPUT),
          act: (_i, action) =>
            this.ui.containerScreen.actOnContainer(container, FURNACE_SLOT.INPUT, action),
        },
        {
          id: 'furnace-fuel',
          label: 'Fuel',
          columns: 1,
          count: 1,
          className: 'slot-grid--furnace',
          read: () => container.getSlot(FURNACE_SLOT.FUEL),
          act: (_i, action) =>
            this.ui.containerScreen.actOnContainer(container, FURNACE_SLOT.FUEL, action),
        },
        {
          id: 'furnace-output',
          label: 'Result',
          columns: 1,
          count: 1,
          className: 'slot-grid--result',
          takeOnly: true,
          read: () => container.getSlot(FURNACE_SLOT.OUTPUT),
          act: (_i, action) => {
            const before = container.getSlot(FURNACE_SLOT.OUTPUT)?.quantity ?? 0;
            const result = this.ui.containerScreen.actOnContainer(container, FURNACE_SLOT.OUTPUT, action);
            const after = container.getSlot(FURNACE_SLOT.OUTPUT)?.quantity ?? 0;
            if (after < before) {
              const xp = furnace.takeStoredXp();
              if (xp > 0) this.player.stats.addExperience(Math.floor(xp));
            }
            return result;
          },
        },
      ],
      extra: [gauges],
    });
    this._openWorkstation = { x, y, z };
    this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.5 });
  }

  /**
   * Opens a chest.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  _openChest(x, y, z) {
    const chest = this.world.getBlockEntity(x, y, z);
    if (!chest) return;
    const inventory = this.player.inventory;
    const container = chest.container;

    this.ui.containerScreen.transferHandler = (slot) =>
      playerToContainer(inventory, slot, container) > 0;
    this.ui.containerScreen.dropHandler = (stack) => this._dropStackInWorld(stack);

    this.ui.openContainer({
      title: chest.type === 'shulker_box' ? 'Shulker Box' : 'Chest',
      inventory,
      hint: 'Shift-click to move a whole stack between the chest and your inventory.',
      panels: [
        {
          id: 'chest',
          label: 'Chest',
          columns: 9,
          count: container.size,
          className: 'slot-grid--chest',
          read: (index) => container.getSlot(index),
          act: (index, action) =>
            this.ui.containerScreen.actOnContainer(container, index, action),
        },
      ],
    });
    this._openWorkstation = { x, y, z };
    this.bus.emit(Events.PLAY_SOUND, { name: 'chest.open', volume: 0.7 });
  }

  /**
   * Returns crafting-grid contents and the cursor stack, then resumes play.
   *
   * The single exit path from every container, so there is no way to leave one with
   * items stranded in a grid or stuck to the cursor.
   */
  _closeContainer() {
    if (!this.world || !this.player) return;
    const inventory = this.player.inventory;

    for (const grid of [this.playerCrafting, this.tableCrafting]) {
      if (!grid) continue;
      for (const stack of grid.reclaim()) {
        inventory.addItem(stack);
        // No room? It goes on the floor rather than into nothing.
        if (!stack.isEmpty) this._dropStackInWorld(stack);
      }
    }

    if (inventory.cursor) {
      const held = inventory.cursor;
      inventory.cursor = null;
      inventory.addItem(held);
      if (!held.isEmpty) this._dropStackInWorld(held);
    }

    this._furnaceGauges = null;
    if (this._openWorkstation) {
      this.bus.emit(Events.PLAY_SOUND, { name: 'ui.back', volume: 0.5 });
      this._openWorkstation = null;
    }
    if (this.ui.screen === Screen.CONTAINER) this.ui.startPlaying();
  }

  /**
   * Throws the selected hotbar stack into the world.
   *
   * @param {boolean} wholeStack
   * @returns {boolean} True when something was dropped.
   */
  _dropHeld(wholeStack) {
    const dropped = this.player.inventory.dropSelected(wholeStack);
    if (!dropped) return false;
    this._dropStackInWorld(dropped);
    this.bus.emit(Events.PLAY_SOUND, { name: 'pickup', volume: 0.35, pitch: 0.8 });
    return true;
  }

  /**
   * Spawns a stack in the world in front of the player.
   * @param {import('./items/ItemStack.js').ItemStack} stack
   */
  _dropStackInWorld(stack) {
    if (!stack || stack.isEmpty || !this.entities) return;
    const eye = this.player.getEyePosition(this._eye);
    const forward = this.cameraController.forward;
    this.entities.spawnItemStack(
      eye.x + forward.x * 0.6,
      eye.y - 0.2,
      eye.z + forward.z * 0.6,
      stack,
      { x: forward.x * 4, y: 2, z: forward.z * 4 }
    );
  }

  /**
   * Respawns the player after a death and scatters anything they dropped.
   *
   * `Player.respawn` returns the stacks to drop rather than spawning them itself,
   * because the player has no reference to the entity manager — and giving it one
   * would couple the physics body to the renderer's entity pools.
   */
  _respawnPlayer() {
    if (!this.world || !this.player) return;
    if (this.player.difficultyProfile.oneLife) return;

    this._bowCharge = 0;

    const deathX = this.player.position.x;
    const deathY = this.player.position.y;
    const deathZ = this.player.position.z;

    const dropped = this.player.respawn();

    // Scatter at the place of death, not the respawn point.
    for (const stack of dropped) {
      this.entities.spawnItemStack(deathX, deathY + 0.4, deathZ, stack);
    }
    if (dropped.length > 0) {
      this.ui.notifications.info(
        `${dropped.length} stack${dropped.length === 1 ? '' : 's'} left where you died.`,
        { id: 'death-drops', duration: 5000 }
      );
    }

    this.ui.startPlaying();
    this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.6 });
  }

  // ------------------------------------------------------------ world lifecycle

  /**
   * Creates and starts a brand new world.
   * @param {{name: string, seed: number, preset: string, mode: string, difficulty: string}} options
   */
  async _createWorld(options) {
    // Deliberately not awaited: on some browsers `AudioContext.resume()` does not
    // settle until the page has real user activation, and awaiting it here would
    // mean the Play button appears to do nothing at all.
    void this._unlockAudio();

    if (options.preset && options.preset !== this.settings.get('graphics.preset')) {
      this.settings.applyPreset(options.preset);
    }
    if (options.mode) this.settings.set('gameplay.mode', options.mode);

    // The mode has to be known when the record is built, because it decides
    // whether the starting hotbar is a creative palette or empty.
    const mode = options.mode || 'creative';
    const record = createEmptyWorldRecord(options.name, parseSeed(options.seed), {
      mode,
      difficulty:options.difficulty,
    });
    record.timeOfDay = TIME.startTime;

    this.worldRecord = record;
    this._startWorld(record, null);

    // Persist immediately so a crash before the first autosave still leaves the
    // world in the list rather than losing it entirely.
    try {
      await this.saveManager.saveWorld(record, new Map());
    } catch (error) {
      this._reportSaveFailure(error);
    }
  }

  /**
   * Loads a stored world.
   * @param {string} worldId
   */
  async _loadWorld(worldId) {
    // See `_createWorld`: audio unlocking must never gate starting a world.
    void this._unlockAudio();

    let record = null;
    try {
      record = await this.saveManager.loadWorld(worldId);
    } catch (error) {
      this.ui.notifications.error(
        `That world could not be opened: ${error instanceof Error ? error.message : error}`,
        { id: 'load-failed' }
      );
      return;
    }
    if (!record) {
      this.ui.notifications.error('That world no longer exists.', { id: 'load-missing' });
      await this._refreshWorldList();
      return;
    }
    if (record.hardcoreDefeated && isPermadeathDifficulty(record.difficulty)) {
      this.ui.notifications.error(
        `${getDifficulty(record.difficulty).label} is a one-life mode. This world has been lost.`,
        { id:'world-defeated', duration:5000 }
      );
      await this._refreshWorldList();
      return;
    }

    this.worldRecord = record;
    if (record.mode) this.settings.set('gameplay.mode', record.mode, { silent: true });

    // Both reads happen before the world is built, so the block-entity snapshot
    // is already in place when the first chunks stream in and ask for it.
    let edits;
    let blockEntities;
    try {
      [edits, blockEntities] = await Promise.all([
        this.saveManager.loadChunkEdits(worldId),
        this.saveManager.loadBlockEntities(worldId),
      ]);
    } catch (error) {
      this.ui.notifications.error(
        `Could not read world data: ${error instanceof Error ? error.message : String(error)}`,
        { id: 'load-data-failed' }
      );
      return;
    }
    this._startWorld(record, edits, blockEntities);
  }

  /**
   * Builds every world-scoped subsystem and begins streaming.
   *
   * @param {import('./core/SaveManager.js').WorldRecord} record
   * @param {Map<string, Uint32Array>|null} edits
   * @param {Map<string, Array<Object>>|null} [blockEntities]
   */
  _startWorld(record, edits, blockEntities = null) {
    this._teardownWorld();

    this.ui.showLoading(`Generating "${record.name}"`);
    this._loadingElapsed = 0;
    this._awaitingSpawn = true;
    this._autosaveTimer = 0;
    this._weatherTimer = 0;
    this._playTime = Number(record.playTimeSeconds) || 0;

    this.world = new World({
      scene: this.scene,
      bus: this.bus,
      settings: this.settings,
      resources: this.resources,
      materials: this.materials,
      seed: record.seed,
    });

    this.lighting = new LightingSystem({
      scene: this.scene,
      settings: this.settings,
      materials: this.materials,
      world: this.world,
    });
    // A daylight save is moved to dusk when the player asked for the horror pacing:
    // opening on a bright noon defeats the point of the whole atmosphere pass.
    const storedTime = Number(record.timeOfDay) || TIME.startTime;
    this.lighting.setTimeOfDay(
      this.settings.get('gameplay.startAtDusk') && phaseAt(storedTime) === 'day'
        ? TIME.duskTime
        : storedTime
    );

    this.sky = new SkySystem({
      scene: this.scene,
      settings: this.settings,
      shaderManager: this.shaderManager,
      resources: this.resources,
    });

    this.water = new WaterRenderer({ world: this.world, lighting: this.lighting, bus: this.bus });

    this.weather = new WeatherRenderer({
      scene: this.scene,
      settings: this.settings,
      bus: this.bus,
      world: this.world,
      lighting: this.lighting,
      resources: this.resources,
      seed: record.seed,
    });

    // The model decides what the weather *is*; the renderer above only draws it.
    // Restoring from the record is what stops a storm evaporating across a
    // save/load, which it did in FinalV2 because nothing persisted it.
    this.weatherSystem = new WeatherSystem({ seed: record.seed });
    this.weatherSystem.deserialize(record.weather);

    this.particles = new BlockParticles({
      scene: this.scene,
      settings: this.settings,
      resources: this.resources,
      atlasTexture: this.atlas.texture,
    });

    this.entities = new EntityManager({
      scene: this.scene,
      world: this.world,
      bus: this.bus,
      settings: this.settings,
      resources: this.resources,
      atlasTexture: this.atlas.texture,
      difficulty: record.difficulty,
    });

    // The world asks the entity manager to take ownership of falling blocks and
    // drops; wiring it here keeps `World` free of an entity dependency.
    this.world.onFallingBlock = (x, y, z, blockId) =>
      this.entities.spawnFallingBlock(x, y, z, blockId);
    this.world.onBlockDrop = (x, y, z, blockId) => this.entities.spawnItem(x, y, z, blockId, 1);
    this.world.onItemDrops = (x, y, z, stacks) => {
      for (const stack of stacks) this.entities.spawnItemStack(x, y, z, stack);
    };
    // A broken chest or furnace scatters its contents. The world hands the stacks
    // over rather than spawning them, because it has no reference to the entity
    // manager and coupling world state to rendering would be a step backwards.
    this.world.onBlockEntityDrops = (x, y, z, stacks) => {
      for (const stack of stacks) this.entities.spawnItemStack(x, y, z, stack);
    };

    /**
     * The player's 2x2 grid and the shared 3x3 table grid.
     *
     * Session-scoped rather than per-block: a crafting table holds no state between
     * uses, so giving each one its own grid would create state nobody expects to
     * persist. Both are reclaimed whenever a container screen closes.
     */
    this.playerCrafting = new CraftingGrid({ size: 2 });
    this.tableCrafting = new CraftingGrid({ size: 3 });
    this._openWorkstation = null;
    this._furnaceGauges = null;

    /**
     * Melee attacks.
     *
     * Session-scoped state would leak a cooldown across worlds, so it is rebuilt
     * per world alongside everything else that holds gameplay state.
     */
    this.combat = new CombatSystem({ bus: this.bus, settings: this.settings });

    this.player = new Player({
      world:this.world,
      bus:this.bus,
      settings:this.settings,
      difficulty:record.difficulty,
    });
    this.phase3 = new Phase3Runtime({ world: this.world, player: this.player, seed: record.seed })
      .fromJSON(record.phase3);
    this.phase4 = new Phase4Runtime({ world: this.world, player: this.player, seed: record.seed })
      .fromJSON(record.phase4);
    this.phase5 = new Phase5Runtime({ world: this.world, player: this.player, seed: record.seed })
      .fromJSON(record.phase5);
    this.advancements = new AdvancementSystem().fromJSON(record.advancements);
    this.entities.registerLivingPool(this.phase5.attackables);
    this.dragonRenderer = new EnderDragonRenderer({
      scene: this.scene,
      resources: this.resources,
    });
    this.eyeOfEnderRenderer = new EyeOfEnderRenderer({ scene:this.scene });
    this.cameraController = new CameraController({ camera: this.camera, settings: this.settings });
    this.viewModel = new ViewModelRenderer({
      camera: this.camera,
      atlas: this.atlas,
      settings: this.settings,
    });
    // wire camera toggle to touch controls
    if (this.ui?.mobileControls) {
      this.ui.mobileControls._handlers.onCamera = () => this._toggleCamera();
      this.ui.mobileControls._handlers.getCameraMode = () => this.cameraController.personMode;
    }
    if (this.ui?.hud?.setCameraHandler) {
      this.ui.hud.setCameraHandler(() => this._toggleCamera(), () => this.cameraController.personMode);
    }
    this.playerController = new PlayerController({
      player: this.player,
      camera: this.cameraController,
      input: this.input,
      settings: this.settings,
      bus: this.bus,
    });

    this.raycaster = new BlockRaycaster(this.world);
    this.breaker = new BlockBreaker({
      world: this.world,
      bus: this.bus,
      settings: this.settings,
      particles: this.particles,
    });
    this.placer = new BlockPlacer({
      world: this.world,
      player: this.player,
      bus: this.bus,
      camera: this.cameraController,
    });
    this.outline = new SelectionOutline({ scene: this.scene, resources: this.resources });

    // Block entities go in before the edits, because applying edits can load
    // chunks, and a chunk loading asks the store for its chests.
    this.world.blockEntities.applyLoaded(blockEntities);
    if (edits && edits.size > 0) this.world.applyLoadedEdits(edits);

    // Restore the player, or place them at a generated spawn.
    if (record.playerPosition && Number.isFinite(record.playerPosition.y) && record.playerPosition.y > 0) {
      this.player.fromJSON({
        position: record.playerPosition,
        mode: record.mode,
        difficulty: record.difficulty,
        flying: record.flying,
        slots: record.slots,
        cursor: record.cursor,
        selectedSlot: record.selectedSlot,
        stats: record.stats,
        effects: record.effects,
        spawnPoint: record.spawnPoint,
      });
      this._awaitingSpawn = false;
    } else {
      const spawn = this.world.findSpawnPosition(0, 0);
      this.player.teleport(spawn.x, spawn.y, spawn.z);
      this.player.fromJSON({
        mode: record.mode,
        difficulty: record.difficulty,
        slots: record.slots,
        cursor: record.cursor,
        selectedSlot: record.selectedSlot,
        stats: record.stats,
        effects: record.effects,
        spawnPoint: record.spawnPoint,
      });
      // A brand new world's spawn is also the respawn point, so dying does not
      // teleport the player somewhere they have never been.
      this.player.setSpawnHere();
    }

    if (record.playerRotation) {
      this.cameraController.setRotation(
        Number(record.playerRotation.yaw) || 0,
        Number(record.playerRotation.pitch) || 0
      );
    }

    this.entities.fromJSON(record.entities);
    this._lastStatPosition = {
      x:this.player.position.x, y:this.player.position.y, z:this.player.position.z,
    };

    this.cameraController.applySettings(this.settings.values);
    this.camera.position.copy(this.player.getEyePosition(this._eye));
    this.player.attachBody(this.scene);
    // Prime streaming from the spawn point before the first frame so the loading
    // screen has something to report immediately.
    this.world.update(0, this.player.position, this.cameraController.forward);

    this.paused = false;
    this.bus.emit(Events.WORLD_READY, record);
  }

  /** Destroys every world-scoped subsystem. */
  _teardownWorld() {
    // Close any open container first, so its reclaim hook returns crafting-grid
    // contents and the cursor stack while the inventory still exists to take them.
    if (this.ui?.containerScreen?.isOpen) this.ui.containerScreen.close();

    this.audio?.setLoop('music.dragon', 0);
    this._dragonRoarTimer = 0;
    this.outline?.destroy();
    this.viewModel?.destroy();
    this.entities?.destroy();
    this.particles?.destroy();
    this.weather?.destroy();
    this.sky?.destroy();
    this.lighting?.destroy();
    this.phase3?.destroy();
    this.phase4?.destroy();
    this.phase5?.destroy();
    this.dragonRenderer?.destroy();
    this.eyeOfEnderRenderer?.destroy();
    this.world?.destroy();

    this.outline = null;
    this.player?.removeBody(this.scene);
    this.breaker = null;
    this.placer = null;
    this.raycaster = null;
    this.playerController = null;
    this.cameraController = null;
    this.viewModel = null;
    this.player = null;
    this.phase3 = null;
    this.phase4 = null;
    this.phase5 = null;
    this.advancements = null;
    this.dragonRenderer = null;
    this.eyeOfEnderRenderer = null;
    this._lastStatPosition = null;
    this.entities = null;
    this.particles = null;
    this.weather = null;
    this.water = null;
    this.sky = null;
    this.lighting = null;
    this.world = null;

    // Crafting grids are world-scoped. They are cleared rather than reclaimed: the
    // world they belonged to is gone, so there is no inventory left to hand items
    // back to. `_closeContainer` has already run via the screen transition, so
    // anything the player was holding was returned before we got here.
    this.playerCrafting = null;
    this.tableCrafting = null;
    this._openWorkstation = null;
    this._furnaceGauges = null;
    this.combat = null;
  }

  /** Saves and returns to the main menu. */
  async quitToMenu() {
    if (this.world) {
      try {
        await this.save({ manual: true });
      } catch {
        // The failure has already been reported; quitting anyway is better than
        // trapping the player in a world they cannot leave.
      }
    }
    this.audio.stopAllLoops();
    this._teardownWorld();
    this.worldRecord = null;
    await this._refreshWorldList();
  }

  async _refreshWorldList() {
    const worlds = await this.saveManager.listWorlds();
    this.ui.showMenu(worlds, {
      persistent: this.saveManager.isPersistent,
      error: this.saveManager.lastError,
    });
  }

  async _deleteWorld(worldId) {
    try {
      await this.saveManager.deleteWorld(worldId);
      this.ui.notifications.success('World deleted.', { id: 'world-deleted' });
    } catch (error) {
      this.ui.notifications.error(
        `Could not delete that world: ${error instanceof Error ? error.message : error}`,
        { id: 'delete-failed' }
      );
    }
    await this._refreshWorldList();
  }

  async _exportWorld(worldId) {
    try {
      const payload = await this.saveManager.exportWorld(worldId);
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const safeName = String(payload.world.name || 'world').replace(/[^\w\-]+/g, '-');
      link.href = url;
      link.download = `${safeName}.voxel.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoke on the next tick so the download has started.
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      this.ui.notifications.success('Save exported.', { id: 'export-done' });
    } catch (error) {
      this.ui.notifications.error(
        `Export failed: ${error instanceof Error ? error.message : error}`,
        { id: 'export-failed' }
      );
    }
  }

  async _importWorld(file) {
    try {
      if (!file || file.size > 2_000_000) {
        throw new Error('File too large — max 2 MB');
      }
      if (file.size === 0) throw new Error('File is empty');
      const text = await file.text();
      if (text.length > 2_000_000) throw new Error('File too large — max 2 MB');
      const payload = JSON.parse(text);
      const world = await this.saveManager.importWorld(payload);
      this.ui.notifications.success(`Imported "${world.name}".`, { id: 'import-done' });
      await this._refreshWorldList();
    } catch (error) {
      this.ui.notifications.error(
        `Import failed: ${error instanceof Error ? error.message : error}`,
        { id: 'import-failed' }
      );
    }
  }

  // ----------------------------------------------------------------- pause/save

  /** Pauses the simulation and opens the pause menu. */
  pause() {
    if (!this.world || this.paused) return;
    this.paused = true;
    this._bowCharge = 0;
    this.player?.setBlocking(false);
    this.world.setPaused(true);
    this.playerController?.reset();
    this.ui.mobileControls.releaseAll();
    this.ui.showPaused({
      worldName: this.worldRecord?.name,
      seed: this.worldRecord?.seed,
      persistent: this.saveManager.isPersistent,
      editedChunks: this.world.editedChunkCount,
    });
    this.bus.emit(Events.GAME_PAUSED);
    // Pausing is a natural save point and costs nothing the player will notice.
    this.save().catch(() => {});
  }

  /** Resumes the simulation. */
  resume() {
    if (!this.world || !this.paused) return;
    this.paused = false;
    this.world.setPaused(false);
    // Discard the time spent in the menu so the player does not fall a mile.
    this.loop.resetTiming();
    this.ui.startPlaying();
    this.bus.emit(Events.GAME_RESUMED);
  }

  /**
   * Writes the current world state.
   * @param {{manual?: boolean}} [options]
   */
  async save(options = {}) {
    if (!this.world || !this.worldRecord) return;

    const record = this.worldRecord;
    record.playerPosition = {
      x: this.player.position.x,
      y: this.player.position.y,
      z: this.player.position.z,
    };
    record.playerRotation = {
      yaw: this.cameraController.yaw,
      pitch: this.cameraController.pitch,
    };
    record.timeOfDay = this.lighting.timeOfDay;
    record.weather = this.weatherSystem ? this.weatherSystem.serialize() : null;
    record.playTimeSeconds = Math.round(this._playTime);
    // `Player.toJSON` covers mode, flying, inventory slots, survival stats and
    // the spawn point. Assigning the whole thing keeps one source of truth for
    // what a player is, rather than a list here that drifts as fields are added.
    Object.assign(record, this.player.toJSON());
    // `position` is the player's own key; the record's field is `playerPosition`,
    // already set above, so drop the duplicate to avoid two stored positions
    // that can disagree.
    delete record.position;
    record.entities = this.entities.toJSON();
    record.phase3 = this.phase3?.toJSON() ?? null;
    record.phase4 = this.phase4?.toJSON() ?? null;
    record.phase5 = this.phase5?.toJSON() ?? null;
    record.advancements = this.advancements?.toJSON() ?? null;

    // The first save of a session writes every edit; later ones only the dirty
    // chunks, which is what keeps autosave cheap in a heavily built world.
    const everything = options.manual === true || !this._hasSavedOnce;
    const dirty = this.world.collectEditsForSave(everything);
    const dirtyEntities = this.world.blockEntities.collectForSave(everything);

    try {
      // One call, one transaction: a chest's block lives in the edit array and its
      // contents in the entity store, so they must commit together or not at all.
      await this.saveManager.saveWorld(record, dirty, dirtyEntities);
      this.world.markEditsSaved();
      this.world.blockEntities.markSaved();
      this._hasSavedOnce = true;
      this.advancements?.recordSave();
      if (options.manual) {
        this.ui.notifications.success(
          this.saveManager.isPersistent ? 'World saved.' : 'World saved for this session only.',
          { id: 'save-done', duration: 2200 }
        );
      }
    } catch (error) {
      this._reportSaveFailure(error);
      throw error;
    }
  }

  _reportSaveFailure(error) {
    this.ui.notifications.error(describeStorageError(error), { id: 'save-failed' });
  }

  /** Moves loot from any Wither killed this tick into the player's inventory. */
  _collectBossRewards() {
    const rewards = this.phase4?.claimRewards();
    if (!rewards || rewards.length === 0) return;
    for (const reward of rewards) {
      this.player.inventory.addItem(reward.item, reward.count);
    }
    this.ui.notifications.info('The Wither is defeated!', {
      id: 'wither-defeated',
      duration: 5000,
    });
  }

  _collectDragonRewards() {
    const rewards = this.phase5?.claimRewards();
    if (!rewards?.length) return;
    for (const reward of rewards) {
      if (Number.isFinite(reward.experience) && reward.experience > 0) {
        this.player.addExperience?.(reward.experience);
      }
      if (typeof reward.item !== 'string') continue;
      const stack = new ItemStack(reward.item, reward.count);
      this.player.inventory.addItem(stack);
      if (!stack.isEmpty) this.entities?.spawnItemStack(
        this.player.position.x, this.player.position.y + 1, this.player.position.z, stack
      );
    }
    const unlock = this.advancements?.kill('ender_dragon', {
      playTime:this._playTime, dimension:this.world.dimensionId,
    });
    if (unlock) this._notifyAdvancement(unlock);
    this.ui.notifications.success('The Ender Dragon is defeated. The way home is open.', {
      id:'dragon-defeated', duration:7000,
    });
  }

  _notifyAdvancement(unlock) {
    if (!unlock) return;
    this.ui.notifications.success(`Advancement made: ${unlock.title}`, {
      id:`advancement-${unlock.id}`, duration:4200,
    });
  }

  _trackTravelStatistics() {
    if (!this.player || !this.advancements) return;
    const now = this.player.position;
    const previous = this._lastStatPosition;
    this._lastStatPosition = { x:now.x, y:now.y, z:now.z };
    if (!previous) return;
    const distance = Math.hypot(now.x - previous.x, now.y - previous.y, now.z - previous.z);
    // Portal teleports are events, not kilometres walked.
    if (!Number.isFinite(distance) || distance > 16) return;
    const medium = this.player.gliding ? 'fly' : this.player.inLiquid ? 'swim' : 'walk';
    this.advancements.move(distance, { dimension:this.world.dimensionId, medium });
  }

  _showProgress() {
    if (!this.advancements) return;
    this._storyReturnScreen = Screen.PAUSED;
    this.ui.showProgress(this.advancements.snapshot());
  }

  _showCredits() {
    if (!this.advancements) return;
    this._storyReturnScreen = Screen.PLAYING;
    this.paused = true;
    this.world?.setPaused(true);
    this.playerController?.reset();
    this.ui.showCredits(this.advancements.snapshot());
  }

  _closeStory() {
    if (this._storyReturnScreen === Screen.PAUSED) {
      this.ui.showPaused(this._pauseInfo || {
        worldName:this.worldRecord?.name, seed:this.worldRecord?.seed,
        persistent:this.saveManager.isPersistent,
        editedChunks:this.world?.editedChunkCount ?? 0,
      });
      return;
    }
    this.paused = false;
    this.world?.setPaused(false);
    this.loop?.resetTiming();
    this.ui.startPlaying();
  }

  // --------------------------------------------------------------------- frame

  _fixedUpdate(step) {
    if (this.destroyed || !this.world || this.paused) return;
    if (!this.ui.isPlaying) return;

    this.player.fixedUpdate(step);
    this.phase3?.fixedUpdate(step);
    this.phase4?.fixedUpdate(step);
    this.phase5?.fixedUpdate(step, {
      spawnMob:(mobId, x, y, z) => this.entities?.spawnMob(mobId, x, y, z),
      spawnProjectile:(x, y, z, direction, options) =>
        this.entities?.spawnProjectile(x, y, z, direction, options),
    });
    this._collectBossRewards();
    this._collectDragonRewards();
    this.advancements?.tick(step);
    this._trackTravelStatistics();
    this._updatePressurePlateContact();
    this.world.fixedUpdate(step);
    this._updatePortalTravel(step);
    this._playTime += step;
  }

  /**
   * Runs the portal dwell timer on the block clock.
   *
   * Standing in a portal for two seconds travels; brushing past one does
   * nothing. Driven from the fixed step so it behaves the same at 30 and 240
   * frames per second.
   */
  _updatePortalTravel(step) {
    if (!this.world || !this.player) return;

    this._portalTracker ??= new PortalTracker();
    this._portalAccumulator = (this._portalAccumulator ?? 0) + step;

    const tickSeconds = 1 / 20;
    let ticks = 0;
    while (this._portalAccumulator >= tickSeconds && ticks < 5) {
      this._portalAccumulator -= tickSeconds;
      ticks++;

      if (this._pendingArrival) {
        this._resolvePortalArrival();
        continue;
      }

      const position = this.player.position;
      const x = Math.floor(position.x);
      const z = Math.floor(position.z);
      const feet = Math.floor(position.y);
      // Which portal you are standing in decides where you go, so the block is
      // carried into travel rather than re-derived from the dimension.
      const feetBlock = this.world.getBlock(x, feet, z);
      const headBlock = this.world.getBlock(x, feet + 1, z);
      const portalBlock = this._portalBlockAt(feetBlock) || this._portalBlockAt(headBlock);

      if (this._portalTracker.tick(portalBlock !== 0)) this._beginPortalTravel(portalBlock);
    }
  }

  /** The portal block id if this is one, otherwise 0. */
  _portalBlockAt(blockId) {
    if (blockId === Block.NETHER_PORTAL || blockId === Block.END_PORTAL) return blockId;
    return 0;
  }

  /**
   * Takes the creatures standing in the portal with the player.
   *
   * Entities cannot simply be moved: the entity pool is rebuilt around the new
   * dimension, so a carried mob is recorded as an id plus an offset from the
   * player, killed here, and re-spawned at the same relative position on the
   * far side. Offsets rather than absolute coordinates are what make this work
   * across the Nether's eightfold coordinate scale.
   *
   * Capped at eight passengers so a mob farm built on a portal cannot stall a
   * crossing.
   */
  _collectPortalRiders(radius = 3, limit = 8) {
    if (!this.entities || !this.player) return [];
    const origin = this.player.position;
    const riders = [];
    for (const mob of this.entities.mobs) {
      if (!mob.alive || !mob.mobId || mob.isDead) continue;
      const dx = mob.x - origin.x;
      const dy = mob.y - origin.y;
      const dz = mob.z - origin.z;
      if ((dx * dx) + (dy * dy) + (dz * dz) > radius * radius) continue;
      riders.push({ mobId: mob.mobId, dx, dy, dz });
      mob.kill();
      if (riders.length >= limit) break;
    }
    return riders;
  }

  /** Re-spawns carried creatures around the player after a crossing. */
  _releasePortalRiders(riders) {
    if (!riders?.length || !this.entities || !this.player) return 0;
    const origin = this.player.position;
    let spawned = 0;
    for (const rider of riders) {
      const mob = this.entities.spawnMob(
        rider.mobId,
        origin.x + rider.dx,
        origin.y + rider.dy,
        origin.z + rider.dz
      );
      if (mob) spawned++;
    }
    return spawned;
  }

  /**
   * Crosses to or from the End.
   *
   * Arriving lands on the generated obsidian platform and wakes the dragon;
   * leaving returns to the world spawn, which is the only place guaranteed to
   * be solid ground after a fight fought a thousand blocks away.
   */
  _travelToEnd(from, to) {
    const riders = this._collectPortalRiders();
    if (!this.world.switchDimension(to)) {
      this._releasePortalRiders(riders);
      return;
    }

    if (to === Dimension.END) {
      this.player.teleport(
        END_ARRIVAL_PLATFORM.x + 0.5,
        END_ARRIVAL_PLATFORM.y + 1,
        END_ARRIVAL_PLATFORM.z + 0.5
      );
      if (this.phase5?.beginDragonFight(Dimension.END)) {
        this.ui.notifications.info('The Ender Dragon circles above the pillars.', {
          id: 'dragon-arrival',
          duration: 6000,
        });
      }
      this._notifyAdvancement(this.advancements?.trigger('dimension:end', {
        playTime:this._playTime, dimension:Dimension.END,
      }));
    } else {
      const spawn = this.world.findSpawnPosition(0, 0);
      this.player.teleport(spawn.x, spawn.y, spawn.z);
      if (from === Dimension.END && this.phase5?.dragonsDefeated > 0) {
        const story = this.phase5.completeStory();
        if (story.firstCredits) this._showCredits();
      }
    }

    this._releasePortalRiders(riders);
    this.advancements?.recordPortal();
    this._portalTracker.startCooldown();
    this.bus.emit(Events.PLAY_SOUND, { name: 'item.ignite', volume: 0.55 });
  }

  /** Switches dimension and queues arrival for when the far side exists. */
  _beginPortalTravel(portalBlock = Block.NETHER_PORTAL) {
    const from = this.world.dimensionId;
    const to = portalBlock === Block.END_PORTAL
      ? (from === Dimension.END ? Dimension.OVERWORLD : Dimension.END)
      : linkedDimension(from);

    if (!isDimensionImplemented(to)) {
      // Every dimension is implemented as of Phase 5, so this is now a guard
      // against a future one rather than a routine refusal.
      console.warn(`[Portal] "${to}" has no terrain generator yet`);
      this._portalTracker.startCooldown();
      return;
    }

    // An End crossing has nothing to build on the far side -- the arrival
    // platform and the spawn point already exist -- so it resolves at once
    // instead of queueing an arrival that waits for a portal to be dug.
    if (to === Dimension.END || from === Dimension.END) {
      this._travelToEnd(from, to);
      return;
    }

    const origin = {
      x: this.player.position.x,
      y: this.player.position.y,
      z: this.player.position.z,
    };

    const riders = this._collectPortalRiders();
    if (!this.world.switchDimension(to)) {
      // The crossing failed, so put the passengers back where they were.
      this._releasePortalRiders(riders);
      return;
    }

    // Move to the linked column straight away so chunk streaming starts around
    // the destination rather than around the portal the player just left.
    const target = linkedPosition(origin, from, to);
    this.player.teleport(target.x + 0.5, target.y, target.z + 0.5);

    this._pendingArrival = { from, to, origin, waited: 0, riders };
    this._portalTracker.startCooldown();
  }

  /**
   * Finishes a crossing once the destination chunk has voxels.
   *
   * The far-side portal cannot be found or built before the chunk generates,
   * and generation is asynchronous, so arrival is a small state machine rather
   * than one call at travel time.
   */
  _resolvePortalArrival() {
    const arrival = this._pendingArrival;
    if (!arrival) return;

    arrival.waited++;

    const target = linkedPosition(arrival.origin, arrival.from, arrival.to);
    // Ten seconds of grace for slow streaming, then place the portal anyway
    // rather than leaving the player floating in an unloaded world.
    if (!this.world.isLoaded(target.x, target.z) && arrival.waited < 200) return;

    const destination = resolveDestination(
      this.world,
      arrival.origin,
      arrival.from,
      arrival.to
    );
    this._pendingArrival = null;

    if (!destination) {
      console.warn('[Portal] could not place an arrival portal');
      return;
    }

    this.player.teleport(destination.x, destination.y, destination.z);
    this._releasePortalRiders(arrival.riders);
    this._portalTracker.startCooldown();
    this.bus.emit(Events.PLAY_SOUND, { name: 'item.ignite', volume: 0.55 });
  }

  /** Refreshes pressure-plate contact for the player, mobs and item entities. */
  _updatePressurePlateContact() {
    if (!this.world || !this.player) return;

    const touch = (position, entityKind) => {
      if (!position) return;
      const x = Math.floor(position.x);
      const z = Math.floor(position.z);
      // Feet-centred entities sit in the plate's voxel; item entities hover a
      // fraction above it, so probe both the current and immediately lower cell.
      const firstY = Math.floor(position.y + 0.03);
      for (const y of [firstY, firstY - 1]) {
        const blockId = this.world.getBlock(x, y, z);
        if (blockId !== Block.OAK_PRESSURE_PLATE && blockId !== Block.STONE_PRESSURE_PLATE) {
          continue;
        }
        const wasPowered = pressurePlatePowered(this.world.getBlockState(x, y, z));
        if (!touchPressurePlate(this.world, x, y, z, entityKind)) continue;
        if (!wasPowered) {
          this.bus.emit(Events.PLAY_SOUND, {
            name: 'ui.click',
            volume: 0.4,
            pitch: 1.12,
          });
        }
        break;
      }
    };

    touch(this.player.position, 'living');
    for (const mob of this.entities?.mobs ?? []) if (mob.alive) touch(mob.position, 'living');
    for (const item of this.entities?.items ?? []) if (item.alive) touch(item.position, 'item');
  }

  _update(dt) {
    if (this.destroyed) return;

    this.input.update(dt);
    this._handleGlobalActions();

    if (this.world) {
      if (this.ui.screen === Screen.LOADING) this._updateLoading(dt);
      else if (this.ui.isPlaying && !this.paused) this._updateGameplay(dt);
      else this._updatePassiveWorld(dt);

      // Menus keep the music bed alive even though gameplay audio is not running.
      if (!this.ui.isPlaying) {
        this.tension?.update(dt, {
          phase: 'menu',
          daylight: this.lighting?.daylight ?? 1,
          underground: false,
          position: this.player?.position,
          healthFraction: 1,
          paused: true,
        });
      }

      // Runs for any screen state, because a container is open *while* the world
      // is still simulating and its slots must track what the furnace is doing.
      this._updateOpenContainer();
    }

    this.ui.update(dt, this._collectDebugState());
    this.renderer.updateDynamicResolution(dt, this.loop.smoothedFrameTime);

    // Must be last: every consumer above reads the edge-triggered state.
    this.input.endFrame();
  }

  /** Streams the spawn area, then hands control to the player. */
  _updateLoading(dt) {
    this._loadingElapsed += dt;

    // Keep the camera at the spawn point and keep streaming.
    this.cameraController.update(dt, this.player, false);
    this.world.update(dt, this.player.position, this.cameraController.forward);
    this.lighting.update(dt, this.camera.position);
    this.sky.setDimension(this.world.dimensionId);
    this.sky.update(dt, this.camera.position, this.lighting);
    this.materials.update(dt);

    const progress = this.world.getLoadProgress();
    const timedOut = this._loadingElapsed > LOADING_TIMEOUT;
    this.ui.setLoadingProgress(
      Math.max(progress, Math.min(0.85, this._loadingElapsed / LOADING_TIMEOUT)),
      timedOut
        ? 'Still generating — starting anyway'
        : `Streaming chunks… ${Math.round(progress * 100)}%`
    );

    if (progress < READY_PROGRESS && !timedOut) return;

    // Now that real voxels exist, resolve the spawn against them so the player
    // never starts inside a tree or half a block underground.
    if (this._awaitingSpawn) {
      const spawn = this.world.findSpawnPosition(this.player.position.x, this.player.position.z);
      this.player.teleport(spawn.x, spawn.y, spawn.z);
      this._awaitingSpawn = false;
      this.bus.emit(Events.PLAYER_SPAWNED, this.player.position);
    } else {
      // A loaded save can still land inside geometry if the world format changed.
      this.player.collision.resolveStuck(this.player.position, this.player.width, this.player.height);
    }

    this.water.reset();
    this.loop.resetTiming();
    this.ui.setLoadingProgress(1, 'Ready');
    this.ui.startPlaying();
    this.ui.mobileControls.setFlyMode(this.player.flying);
  }

  /** The full gameplay update. */
  _updateGameplay(dt) {
    const player = this.player;

    this.playerController.update(dt);
    player.update(dt);

    // The camera must be updated before anything reads the eye position or the
    // look direction, including the raycast and chunk prioritisation.
    this.cameraController.update(dt, player, this.water.isUnderwater);
    player.getEyePosition(this._eye);
    player.updateBody(this.cameraController.personMode, this.cameraController.yaw, dt);
    this.water.update(dt, this._eye);
    this._forward.copy(this.cameraController.forward);
    player.setLookDirection(this._forward.x, this._forward.z);
    this._updateDefenceState();

    this.world.update(dt, player.position, this._forward);
    this.lighting.update(dt, this.camera.position);
    this.sky.setDimension(this.world.dimensionId);
    this.sky.update(dt, this.camera.position, this.lighting);
    this._lastDelta = dt;
    this._updateWeather(dt);
    this.materials.update(dt);

    this.noise.update(dt);
    this.entities.update(dt, player, {
      daylight: this.lighting.daylight,
      mobSpawning: this.ui.screen === Screen.PLAYING,
      attackables: this.phase5?.attackables ?? [],
      // Horror-roster inputs: what the player just heard is derived from these.
      noise: this.noise,
      playerLook: this.cameraController.forwardFlat,
      emitSound: (payload) => this.bus.emit(Events.PLAY_SOUND, payload),
    });
    this.dragonRenderer?.update(this.phase5?.activeFight ?? null, dt);
    this._updateDragonAudio(dt);
    const eyeCompletion = this.eyeOfEnderRenderer?.update(dt);
    if (eyeCompletion) {
      if (eyeCompletion.shatters) {
        this.bus.emit(Events.PLAY_SOUND, { name:'projectile.hit_block', volume:.72, pitch:1.35 });
      } else {
        this.entities.spawnItemStack(
          eyeCompletion.end.x,
          eyeCompletion.end.y,
          eyeCompletion.end.z,
          new ItemStack('eye_of_ender', 1)
        );
        this.bus.emit(Events.PLAY_SOUND, { name:'ui.select', volume:.45, pitch:1.15 });
      }
    }
    this.entities.applyLighting(this.lighting.lightingState);
    this.particles.update(dt, this.world);
    this.particles.setTint(this.lighting.skyAmbient);

    if (this.viewModel) {
      this.viewModel.setHeldItem(player.inventory.selectedItemId);
      const isMining = this.input.isDown(Action.BREAK_BLOCK);
      const isPlacing = this.input.isDown(Action.PLACE_BLOCK);
      this.viewModel.update(dt, player, isMining, isPlacing);
      this.viewModel.rootGroup.visible = this.cameraController.personMode === 0;
    }

    // Block interaction is suppressed while a UI owns the screen. The input
    // context already withholds BREAK_BLOCK and PLACE_BLOCK for those screens, so
    // this is belt-and-braces — but relying on a binding table to enforce "you
    // cannot mine through an open chest" is too subtle a guarantee to leave
    // implicit.
    if (this.ui.screen === Screen.PLAYING) this._updateInteraction(dt);
    else this.outline.hide();

    this._updateAudio();
    this._updateAutosave(dt);
  }

  /**
   * Keeps an open container's display in step with its live state.
   *
   * Polled rather than event-driven: a furnace's timers change every tick, and an
   * event per change would be sixty DOM writes a second for two progress bars.
   * `Container.revision` makes the slot refresh a cheap early-out.
   */
  _updateOpenContainer() {
    if (this.ui.screen !== Screen.CONTAINER) return;

    const gauges = this._furnaceGauges;
    if (gauges?.furnace && !gauges.furnace.removed) {
      const burn = `${Math.round(gauges.furnace.burnFraction * 100)}%`;
      const cook = `${Math.round(gauges.furnace.cookFraction * 100)}%`;
      if (gauges.burn.style.width !== burn) gauges.burn.style.width = burn;
      if (gauges.cook.style.width !== cook) gauges.cook.style.width = cook;
    }

    // If the block behind the open container is gone — broken, or its chunk
    // unloaded — the screen must close rather than editing a dead entity.
    const at = this._openWorkstation;
    if (at) {
      const blockId = this.world.getBlock(at.x, at.y, at.z);
      const stillThere =
        blockId === Block.CRAFTING_TABLE ||
        blockId === Block.FURNACE ||
        blockId === Block.FURNACE_LIT ||
        blockId === Block.CHEST ||
        blockId === Block.SHULKER_BOX ||
        PHASE3_STATIONS.has(blockId);
      if (!stillThere) {
        this.ui.containerScreen.close();
        return;
      }
    }

    this.ui.containerScreen.refresh();
  }

  /** Keeps the world presentable while paused or in a menu. */
  _updatePassiveWorld(dt) {
    this._bowCharge = 0;
    this.player?.setBlocking(false);
    // Time and streaming continue at a trickle so returning from a menu does not
    // show a frozen sky, but physics and interaction are stopped.
    this.cameraController.update(dt, this.player, this.water.isUnderwater);
    this.lighting.update(dt * 0.15, this.camera.position);
    this.sky.setDimension(this.world.dimensionId);
    this.sky.update(dt, this.camera.position, this.lighting);
    this.materials.update(dt * 0.4);
    this.world.update(dt, this.player.position, this.cameraController.forward);
    this.outline.hide();
  }

  /** Raycast, break, place and pick. */
  _updateInteraction(dt) {
    const reach = clamp(
      this.settings.get('gameplay.reach'),
      INTERACTION.minReach,
      INTERACTION.maxReach
    );

    const target = this.raycaster.cast(this._eye, this._forward, reach, { out: this._target });

    const breaking = this.input.isDown(Action.BREAK_BLOCK);
    const placing = this.input.isDown(Action.PLACE_BLOCK);

    const player = this.player;
    const heldItemId = player.inventory.selectedItemId;

    this.combat.update(dt);

    // Attacking takes precedence over mining: a click aimed at a mob standing in
    // front of a wall must hit the mob, not start chipping the wall behind it.
    // Only the initial press attacks, because holding to mine must not also hold
    // to attack.
    let attacked = false;
    if (this.input.justPressed(Action.BREAK_BLOCK)) {
      attacked = this._tryAttack(target, heldItemId);
      this.viewModel?.triggerSwing();
      this.player?.bodySwing();
    }

    if (attacked) {
      this.breaker.cancel();
    } else {
      const broken = this.breaker.update(dt, target, breaking, {
        creative: player.isCreative,
        itemId: heldItemId,
        // Mining is slower while swimming or in mid-air, which is what stops
        // hovering being the fastest way to dig.
        underwater: player.headInWater,
        airborne: !player.onGround && !player.flying && !player.inWater,
      });
      if (broken) this._onBlockMined(broken);
    }

    // "Use" priority mirrors block games: interact with the targeted block,
    // then let the held item act on it (planting/buckets/hoes), and only eat when
    // neither consumed the click. This lets a hungry player plant a carrot
    // instead of involuntarily eating it. Only the *initial* press is considered, so
    // holding the button to build a wall cannot repeatedly reopen a chest you
    // happen to sweep past.
    const heldDefinition = heldItemId ? getItem(heldItemId) : null;
    const usingBow = heldDefinition?.metadata.rangedWeapon === 'bow';
    let consumed = false;
    if (this.input.justPressed(Action.PLACE_BLOCK)) {
      consumed = this._tryUseEntity(target, heldItemId) || this._tryUseBlock(target);
    }

    if (!consumed && usingBow) {
      consumed = this._updateBowUse(dt, heldDefinition);
    } else if (!usingBow) {
      this._bowCharge = 0;
    }

    if (this.input.justPressed(Action.PLACE_BLOCK) && !consumed) {
      if (player.blocking) consumed = true;
      else consumed = this._tryUseItem(target, heldItemId) || this._tryEat(heldItemId);
      if (!player.blocking && !usingBow) this.viewModel?.triggerSwing();
    }
    if (!consumed) this.placer.update(dt, target, placing);
    else this.placer.reset();

    if (this.input.justPressed(Action.PICK_BLOCK)) {
      if (this.placer.pickBlock(target)) {
        this.bus.emit(Events.PLAY_SOUND, { name: 'ui.select' });
      }
    }

    this.outline.update(target, this.breaker.progress);
  }

  /** Charges and releases the selected bow. */
  _updateBowUse(dt, definition) {
    const player = this.player;
    const held = this.input.isDown(Action.PLACE_BLOCK);
    const released = this.input.justReleased(Action.PLACE_BLOCK);
    const maxCharge = Math.max(0.1, Number(definition.metadata.maxChargeSeconds) || 1);

    if (held) {
      if (!player.isCreative && !player.inventory.hasItems(definition.metadata.ammo ?? 'arrow')) {
        if (this.input.justPressed(Action.PLACE_BLOCK)) {
          this.ui.notifications.warning('You need arrows to use a bow.', {
            id: 'bow-no-ammo',
            duration: 1800,
          });
        }
        this._bowCharge = 0;
        return true;
      }
      this._bowCharge = Math.min(maxCharge, this._bowCharge + dt);
      player.setBlocking(false);
      return true;
    }

    if (!released || this._bowCharge <= 0) return false;
    const raw = Math.min(1, this._bowCharge / maxCharge);
    this._bowCharge = 0;
    const power = Math.min(1, (raw * raw + raw * 2) / 3);
    if (power < 0.1) return true;

    const ammo = definition.metadata.ammo ?? 'arrow';
    if (!player.isCreative && !player.inventory.hasItems(ammo)) return true;

    const origin = {
      x: this._eye.x + this._forward.x * 0.42,
      y: this._eye.y + this._forward.y * 0.42,
      z: this._eye.z + this._forward.z * 0.42,
    };
    const projectile = this.entities.spawnProjectile(origin.x, origin.y, origin.z, this._forward, {
      ownerKind: 'player',
      owner: player,
      sourceX: player.position.x,
      sourceY: player.position.y + player.eyeHeight,
      sourceZ: player.position.z,
      speed: 18 + power * 18,
      gravity: 7.5,
      damage: 2 + power * 7,
    });
    if (!projectile) return true;

    if (!player.isCreative) {
      player.inventory.removeItem(ammo, 1);
      player.inventory.damageSelected(1);
    }
    player.stats.addExhaustion(EXHAUSTION.attack);
    this.bus.emit(Events.PLAY_SOUND, {
      name: 'item.bow_shoot',
      volume: 0.82,
      pitch: 0.9 + power * 0.22,
    });
    return true;
  }

  /**
   * Resolves whether the use button belongs to a shield this frame.
   *
   * Main-hand use always wins over an offhand shield (food, buckets, blocks,
   * hoes and bows), while a selected shield is unambiguous. Interactive world
   * blocks are still allowed on the initial press in `_updateInteraction`.
   */
  _updateDefenceState() {
    const player = this.player;
    if (!player) return;
    if (!this.input.isDown(Action.PLACE_BLOCK)) {
      player.setBlocking(false);
      return;
    }

    const selected = player.inventory.selectedStack;
    if (selected?.definition.metadata.shield) {
      player.setBlocking(true);
      return;
    }
    if (!player.inventory.offhand?.definition.metadata.shield) {
      player.setBlocking(false);
      return;
    }

    const definition = selected?.definition ?? null;
    const primaryUse = Boolean(
      definition && (
        definition.placeableBlockId !== null ||
        definition.foodValue > 0 ||
        definition.toolType === ToolType.BUCKET ||
        definition.toolType === ToolType.HOE ||
        definition.metadata.plantsCrop ||
        definition.metadata.ignites ||
        definition.metadata.rangedWeapon
      )
    );
    player.setBlocking(!primaryUse);
  }

  /**
   * Advances the weather model and pushes its result at the renderer.
   *
   * The old version rolled `Math.random() < 0.55` every 95 seconds, which meant
   * weather was neither reproducible on a seed nor survivable across a reload,
   * and rained in deserts. `WeatherSystem` owns all three concerns now; this
   * method is only the bridge between it and the renderer.
   */
  _updateWeather(dt) {
    this.weather.update(dt, this.camera.position);

    const system = this.weatherSystem;
    if (!system) return;

    // "Off" disables the model rather than fighting it: previously the renderer
    // was forced clear every frame while the roll kept flipping underneath.
    system.enabled = this.settings.get('graphics.weatherQuality') !== 'off';

    // Resample the local biome only when the player crosses a block boundary.
    // sampleColumn generates noise, so calling it per frame is real work.
    const blockX = Math.floor(this.player.position.x);
    const blockZ = Math.floor(this.player.position.z);
    if (blockX !== this._weatherSampleX || blockZ !== this._weatherSampleZ) {
      this._weatherSampleX = blockX;
      this._weatherSampleZ = blockZ;
      const column = this.world?.sampleColumn?.(blockX, blockZ);
      if (column) system.setTemperature(column.temperature);
    }

    system.update(dt);
    if (system.lightningStruck) this.weather.triggerLightning();

    const state = system.visibleState;
    const raining = isPrecipitation(state);
    this.weather.setWeather(raining ? Weather.RAIN : Weather.CLEAR, system.intensity, state);
  }

  /**
   * Biome name for the ambience mixer, cached for a second.
   *
   * `World.getBiomeNameAt` falls back to sampling noise when the chunk is not
   * resident, and this is called from the frame loop. A second is far below the
   * time it takes to walk out of a biome, so the cache cannot be heard.
   *
   * @returns {string}
   */
  _ambientBiomeName() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this._ambientBiomeAt && now - this._ambientBiomeAt < 1000) return this._ambientBiomeValue;
    this._ambientBiomeAt = now;
    const player = this.player;
    this._ambientBiomeValue = player && this.world
      ? this.world.getBiomeNameAt(Math.floor(player.position.x), Math.floor(player.position.z))
      : 'Plains';
    return this._ambientBiomeValue;
  }

  _updateAudio() {
    // The listener follows the camera, so positional creature sounds pan the way
    // the player is looking rather than the way the body happens to face.
    if (!this._audioForward) this._audioForward = new THREE.Vector3();
    this.camera.getWorldDirection(this._audioForward);
    this.audio.setListener(this.camera.position, this._audioForward);

    this.audio.updateAmbience({
      underwater: this.water.isUnderwater,
      altitude: this.player.position.y,
      daylight: this.lighting.daylight,
      rainIntensity: this.weather.audibleIntensity,
      paused: false,
      // Phase 4. Drives the Nether rumble in place of wind and rain.
      dimension: this.world?.dimension?.id ?? 'overworld',
      // Horror pass: the generated library selects forest / cave / swamp layers
      // from these, and the synthesized path simply ignores them.
      biome: this.audio.hasLibrary ? this._ambientBiomeName() : 'Plains',
      underground: this.player.position.y < SEA_LEVEL - 22,
      // Lets the ambience pick the day/dusk/night drone without a second clock.
      timeOfDay: this.lighting.timeOfDay,
    });

    this.audio.tickEvents(this._lastDelta ?? 0);

    // The director owns the *feel* of the moment: music phase, heartbeat and the
    // pacing of distant scares. It is silent on menus and paused screens.
    const playing = this.ui.screen === Screen.PLAYING;
    const underground = this.player.position.y < SEA_LEVEL - 22;
    const phase = !playing
      ? 'menu'
      : phaseAt(this.lighting.timeOfDay, { underground });
    const stats = this.player.stats;
    this.tension.update(this._lastDelta ?? 0, {
      phase,
      daylight: this.lighting.daylight,
      underground,
      position: this.player.position,
      healthFraction: stats && stats.maxHealth > 0 ? stats.health / stats.maxHealth : 1,
      paused: !playing,
    });

    if (this.player.jumpedThisStep) this.audio.playEvent(GameplayEvent.PLAYER_JUMP);
    if (this.player.justLanded && this.player.landingImpact > 6) {
      this.audio.playEvent(GameplayEvent.PLAYER_LAND, {
        volumeScale: clamp(this.player.landingImpact / 18, 0.3, 1.4),
      });
    }
    // Entering and leaving water were silent in FinalV2 even though the buffers
    // existed. The transition is the interesting moment, not the state.
    if (this.player.inWater !== this._wasInWater) {
      this._wasInWater = this.player.inWater;
      if (this.player.inWater) this.audio.playEvent(GameplayEvent.PLAYER_SPLASH);
    } else if (this.player.inWater && !this.player.onGround) {
      this.audio.playEvent(GameplayEvent.PLAYER_SWIM);
    }
  }

  /**
   * Turns player actions into noise pulses.
   *
   * Radius is the gameplay-relevant number: a walk is heard at ~9 blocks, a sprint
   * at 18, mining at 22. The hunter's hearing is 22, so sprinting past one is a
   * decision, not a formality.
   */
  _attachNoiseEvents() {
    this.subscriptions.on(this.bus, Events.PLAYER_STEP, (event) => {
      const position = event?.position;
      if (!position || !this.noise) return;
      const sprint = event.sprint === true;
      this.noise.emit(position.x, position.y, position.z, sprint ? 18 : 9, sprint ? 'sprint' : 'step');
    });
    this.subscriptions.on(this.bus, Events.BLOCK_BROKEN, (event) => {
      if (!this.noise || event?.x === undefined) return;
      this.noise.emit(event.x, event.y ?? 0, event.z, 22, 'mine');
    });
  }

  _updateDragonAudio(dt) {
    const fight = this.world?.dimensionId === Dimension.END ? this.phase5?.activeFight : null;
    const alive = Boolean(fight && !fight.bar.dead);
    this.audio.setLoop('music.dragon', alive ? .46 : 0);
    if (!alive) {
      this._dragonRoarTimer = 0;
      return;
    }
    this._dragonRoarTimer -= Math.max(0, dt || 0);
    if (this._dragonRoarTimer > 0) return;
    this._dragonRoarTimer = 7.5 + ((this.world.seed ^ Math.floor(this._playTime)) & 7) * .45;
    this.audio.playEvent(GameplayEvent.DRAGON_ROAR);
  }

  _updateAutosave(dt) {
    const interval = Number(this.settings.get('gameplay.autosaveInterval')) || 0;
    if (interval <= 0) return;
    this._autosaveTimer += dt;
    if (this._autosaveTimer < interval) return;
    this._autosaveTimer = 0;
    if (!this.world.hasUnsavedChanges) return;
    this.save().catch(() => {
      // Already surfaced through the notification system; the previous save on
      // disk is untouched because the write is a single transaction.
    });
  }

  _render(dt) {
    if (this.destroyed) return;
    this.renderer.render(dt, {
      underwater: this.water ? this.water.getOverlayStrength() : 0,
      // Vignette closes in as the light goes: at night the screen edges darken
      // further, which narrows the usable field of view without a gameplay rule.
      darkness: this.lighting ? 1 - this.lighting.daylight : 0,
    });
  }

  // -------------------------------------------------------------- global actions

  /** Handles actions that work regardless of what is on screen. */
  _handleGlobalActions() {
    if (this.input.justPressed(Action.TOGGLE_DEBUG)) {
      this.ui.toggleDebugOverlay();
      this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click' });
    }

    if (this.input.justPressed(Action.TOGGLE_FULLSCREEN)) {
      this.ui.toggleFullscreen();
    }

    if (this.input.justPressed(Action.PAUSE)) {
      this._handleEscape();
    }

    if (this.input.justPressed(Action.OPEN_INVENTORY)) {
      this._toggleInventory();
    }

    if (this.input.justPressed(Action.SAVE_NOW) && this.world) {
      // Deliberately fire-and-forget: a failure is already reported through the
      // save-failed notification, and awaiting here would stall the frame.
      this.save({ manual: true }).catch(() => {});
    }

    // Dropping works during gameplay only. Inside a container the slot grid owns
    // Q, because there the player is pointing at a specific slot rather than
    // holding something.
    if (this.world && this.ui.screen === Screen.PLAYING) {
      if (this.input.justPressed(Action.DROP_STACK)) this._dropHeld(true);
      else if (this.input.justPressed(Action.DROP_ITEM)) this._dropHeld(false);
    }
  }

  /** Escape backs out one level at a time. */
  _handleEscape() {
    switch (this.ui.screen) {
      case Screen.INVENTORY:
        this.ui.closeInventory();
        this.bus.emit(Events.PLAY_SOUND, { name: 'ui.back' });
        break;
      case Screen.CONTAINER:
        // `close` runs the reclaim hook, so escaping out of a crafting grid gives
        // the ingredients back rather than destroying them.
        this.ui.containerScreen.close();
        break;
      case Screen.SETTINGS:
        this.ui.closeSettings();
        this.bus.emit(Events.PLAY_SOUND, { name: 'ui.back' });
        break;
      case Screen.PAUSED:
        this.resume();
        break;
      case Screen.PLAYING:
        this.pause();
        break;
      default:
        break;
    }
  }

  /**
   * Opens or closes the inventory.
   *
   * Which screen appears depends on the mode, because the two modes genuinely need
   * different things: creative wants a searchable palette of every block in the
   * game, survival wants slot management and a 2x2 crafting grid. One screen
   * serving both would be a mode flag threaded through all of it.
   */
  _toggleInventory() {
    if (!this.world) return;

    if (this.ui.screen === Screen.INVENTORY) {
      this.ui.closeInventory();
      return;
    }
    if (this.ui.screen === Screen.CONTAINER) {
      // Closing runs the reclaim hook, which returns anything on the grid.
      this.ui.containerScreen.close();
      return;
    }
    if (this.ui.screen !== Screen.PLAYING) return;

    this.playerController.reset();
    if (this.player.isCreative) this.ui.openInventory();
    else this._openInventoryScreen();
    this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click' });
  }

  _toggleCamera() {
    if (!this.cameraController) return;
    const mode = this.cameraController.togglePerson();
    const labels = ['First person', 'Third behind', 'Third front'];
    this.ui.notifications.info(labels[mode] ?? 'Camera', { id: 'camera-mode', duration: 1600 });
    if (this.ui?.hud?._updateCameraIcon) this.ui.hud._updateCameraIcon();
    // also update touch button label
    if (this.ui?.mobileControls?._cameraButton) {
      const l = ['◧', '◨', '◩'];
      this.ui.mobileControls._cameraButton.textContent = l[mode] ?? '◧';
    }
    this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 0.6 });
  }

  // --------------------------------------------------------- lifecycle plumbing

  _attachLifecycleEvents() {
    const group = this.subscriptions;

    group.on(this.bus, Events.SETTINGS_CHANGED, (values, changed) =>
      this._onSettingsChanged(values, changed)
    );

    /*
     * Death takes over the screen. Handled here rather than inside `Player`
     * because it is a session-level transition — it has to release the pointer
     * lock, change the input context and stop the interaction loop, none of which
     * a physics body should know about.
     */
    // Setting the third wither skull on a completed soul-sand frame is what
    // summons the boss, so the placement event is where the fight begins.
    group.on(this.bus, Events.BLOCK_PLACED, ({ x, y, z, blockId }) => {
      this.advancements?.place(getBlock(blockId)?.name ?? `block_${blockId}`);
      const fight = this.phase4?.onBlockPlaced(x, y, z, blockId);
      if (!fight) return;
      this.ui.notifications.info('The Wither awakens \u2014 it is invulnerable while it rises.', {
        id: 'wither-summon',
        duration: 4000,
      });
      this.bus.emit(Events.PLAY_SOUND, { name: 'ui.click', volume: 1 });
    });

    // Mining a beacon must stop its pulse. The registry is keyed by position, so
    // this is a map delete rather than a scan of anything.
    group.on(this.bus, Events.BLOCK_BROKEN, ({ x, y, z, blockId }) => {
      this.phase4?.onBlockBroken(x, y, z, blockId);
      this._notifyAdvancement(this.advancements?.mine(getBlock(blockId)?.name ?? `block_${blockId}`, {
        playTime:this._playTime, dimension:this.world?.dimensionId,
      }));
      if (blockId === Block.INFESTED_STONE || blockId === Block.INFESTED_MOSSY_COBBLESTONE || blockId === Block.SILVERFISH_SPAWNER) {
        const amount = blockId === Block.SILVERFISH_SPAWNER ? 3 : 1;
        for (let index = 0; index < amount; index++) {
          this.entities?.spawnMob('silverfish', x + .5 + index * .2, y + .2, z + .5);
        }
      }
      if (blockId === Block.ELYTRA_DISPLAY) {
        const stack = new ItemStack('elytra', 1);
        this.player?.inventory.addItem(stack);
        if (!stack.isEmpty) this.entities?.spawnItemStack(x + .5, y + .5, z + .5, stack);
        this._notifyAdvancement(this.advancements?.obtain('elytra', 1, {
          playTime:this._playTime, dimension:this.world?.dimensionId,
        }));
      }
    });

    group.on(this.bus, Events.PLAYER_DIED, ({ message, cause }) => {
      if (!this.world) return;
      const permadeath = this.player?.difficultyProfile?.oneLife === true;
      const difficultyLabel = this.player?.difficultyProfile?.label ?? 'Hardcore';
      this.advancements?.recordDeath(this.player?.position, this.world.dimensionId, cause ?? message, this._playTime);
      if (permadeath && this.worldRecord) {
        this.worldRecord.hardcoreDefeated = true;
        void this.save().catch(() => {
          // `save` has already surfaced the storage failure through the UI.
        });
      }
      this.breaker?.cancel();
      this.playerController?.reset();
      this.ui.showDeath({
        message,
        keptInventory:
          this.player.isCreative || Boolean(this.settings.get('gameplay.keepInventory')),
        permadeath,
        difficultyLabel,
      });
      this.bus.emit(Events.PLAY_SOUND, { name: 'ui.back', volume: 0.8 });
    });

    /*
     * Pickup messages. Coalesced by item so mining a vein of coal produces one
     * updating line rather than eight stacked toasts.
     */
    group.on(this.bus, Events.ITEM_PICKED_UP, ({ itemId, count, displayName }) => {
      this._notifyAdvancement(this.advancements?.obtain(itemId, count, {
        playTime:this._playTime, dimension:this.world?.dimensionId,
      }));
      const total = (this.player?.inventory.countOf(itemId) ?? count) || count;
      this.ui.notifications.show({
        level: 'info',
        message: `+${count} ${displayName} (${total})`,
        id: `pickup-${itemId}`,
        duration: 1600,
      });
    });

    group.on(this.bus, Events.MOB_DIED, ({ mobId, killedByPlayer }) => {
      if (!killedByPlayer) return;
      this._notifyAdvancement(this.advancements?.kill(mobId, {
        playTime:this._playTime, dimension:this.world?.dimensionId,
      }));
    });

    group.on(this.bus, Events.TOOL_BROKE, ({ itemId }) => {
      this.bus.emit(Events.PLAY_SOUND, { name: 'tool.break', volume: 0.9 });
      this.ui.notifications.warning(`Your ${getItemName(itemId)} broke`, {
        id: 'tool-broke',
        duration: 2600,
      });
    });

    group.on(this.bus, Events.ARMOUR_BROKE, ({ itemId, armourSlot }) => {
      this.bus.emit(Events.PLAY_SOUND, { name: 'tool.break', volume: 0.9, pitch: 0.82 });
      this.ui.notifications.warning(`Your ${getItemName(itemId)} broke`, {
        id: `armour-broke-${armourSlot ?? itemId}`,
        duration: 2600,
      });
    });

    /*
     * Pointer lock needs care.
     *
     * Only a genuine *release* (the player pressed Escape or alt-tabbed away while
     * holding the lock) should pause. A failed or refused *request* must not,
     * because browsers deny the request routinely — during the exit-lock cooldown,
     * without sufficient user activation, or under policy — and pausing on refusal
     * produces an unescapable resume/pause loop where the game can never be
     * entered at all.
     *
     * When the request fails the game simply stays playable without the lock, and
     * the next click on the canvas asks again.
     */
    group.on(this.bus, Events.POINTER_LOCK_CHANGED, (locked, reason) => {
      document.body.classList.toggle('pointer-locked', locked);
      if (locked) return;
      if (reason !== 'released') return;
      if (this.ui.screen !== Screen.PLAYING) return;
      if (this.capabilities.touch) return;
      this.pause();
    });

    // Re-acquire the lock on a click in the world. This is the recovery path for a
    // refused request, and it is also what makes clicking back into the game work
    // after the browser drops the lock on its own.
    group.dom(this.canvas, 'pointerdown', (event) => {
      if (event.pointerType === 'touch') return;
      if (this.ui.screen !== Screen.PLAYING) return;
      if (this.input.pointerLocked) return;
      this.input.requestPointerLock();
    });

    group.dom(document, 'keydown', (e) => {
      if (e.code === 'F5' || e.key === 'F5') { e.preventDefault(); this._toggleCamera(); }
    });

    group.on(this.bus, Events.CONTEXT_LOST, () => this._onContextLost());
    group.on(this.bus, Events.CONTEXT_RESTORED, () => this._onContextRestored());

    group.dom(document, 'visibilitychange', () => {
      if (document.hidden) this._onHidden();
      else this._onVisible();
    });

    group.dom(window, 'blur', () => {
      // Blur without a pointer lock change happens when a dialog or another window
      // takes focus; pausing is the safe response.
      if (this.ui.screen === Screen.PLAYING) this.pause();
    });

    // `pagehide` is the only event reliably delivered on mobile when the tab is
    // discarded, so it is the last chance to persist.
    group.dom(window, 'pagehide', () => this._saveOnExit());
    group.dom(window, 'beforeunload', () => this._saveOnExit());

    // The first gesture anywhere unlocks audio.
    const unlock = () => this._unlockAudio();
    group.dom(window, 'pointerdown', unlock, { once: false });
    group.dom(window, 'keydown', unlock, { once: false });
  }

  /**
   * Attempts to start audio. Never throws, and never blocks the caller.
   *
   * Guarded by `_audioUnlockPending` because it is wired to every pointer and key
   * event: without the guard a burst of input would queue dozens of overlapping
   * unlock attempts.
   */
  async _unlockAudio() {
    if (this.audio.unlocked || !this.audio.available || this._audioUnlockPending) return;
    this._audioUnlockPending = true;
    try {
      await this.audio.unlock();
      if (this.audio.unlocked) {
        this.audio.applySettings(this.settings.values.audio);
        // Fetching and decoding the generated library is deliberately after the
        // unlock and never awaited: audio must start on the first gesture, not
        // after a hundred file downloads.
        void this.audio.loadLibrary();
      }
    } catch (error) {
      console.warn('[Game] audio could not be started:', error);
    } finally {
      this._audioUnlockPending = false;
    }
  }

  _onHidden() {
    if (this.ui.screen === Screen.PLAYING) this.pause();
    this._bowCharge = 0;
    this.player?.setBlocking(false);
    this.input.clearAll();
    this.ui.mobileControls.releaseAll();
    if (this.settings.get('audio.muteWhenUnfocused')) this.audio.setDucked(true);
    this.audio.setSuspended(true);
    this.world?.setPaused(true);
  }

  _onVisible() {
    this.audio.setDucked(false);
    this.audio.setSuspended(false);
    // Throw away the time we were hidden for; the loop also clamps, but resetting
    // here means the very first frame back is a normal one.
    this.loop.resetTiming();
    if (!this.paused) this.world?.setPaused(false);
  }

  _saveOnExit() {
    if (!this.world || !this.worldRecord) return;
    // Fire and forget: the page may be gone before the transaction commits, and
    // IndexedDB guarantees the previous save is intact if it does not.
    this.save().catch(() => {});
  }

  _onContextLost() {
    if (this.ui.screen === Screen.PLAYING) this.pause();
    this.ui.notifications.warning(
      'The graphics context was lost. Waiting for the browser to restore it…',
      { id: 'context-lost', duration: 0 }
    );
  }

  _onContextRestored() {
    this.ui.notifications.dismiss('context-lost');
    this.ui.notifications.success('Graphics restored.', { id: 'context-restored' });

    // The atlas lives in a canvas, so the pixels survive; only the GPU copy is
    // gone and has to be re-uploaded.
    if (this.atlas.texture) this.atlas.texture.needsUpdate = true;

    // Programs are gone: rebuild and re-validate the materials, then re-point
    // every chunk mesh at the new instances.
    const ok = this.materials.build();
    this.world?.refreshMaterials();
    this.materials.applySettings(this.settings.values.graphics);
    if (!ok) {
      this.ui.notifications.warning('Falling back to simple materials after the context loss.', {
        id: 'shader-fallback',
      });
    }

    this.renderer.resize();
    this.loop.resetTiming();
  }

  /**
   * Routes a settings change to the systems it affects.
   *
   * Dispatching by key prefix keeps this readable and means a new setting only
   * needs a line here if it has a side effect beyond being read each frame.
   *
   * @param {Object} values
   * @param {Set<string>} changed
   */
  _onSettingsChanged(values, changed) {
    const has = (key) => changed.has(key);
    const anyStartingWith = (prefix) => {
      for (const key of changed) if (key.startsWith(prefix)) return true;
      return false;
    };

    if (has('display.maxFps')) this.loop.setMaxFps(values.display.maxFps);

    if (
      has('display.resolutionScale') ||
      has('display.maxPixelRatio') ||
      has('display.dynamicResolution') ||
      has('display.fov') ||
      has('graphics.renderDistance')
    ) {
      this.cameraController?.applySettings(values);
      this.renderer.applySettings(values);
    }

    if (
      has('graphics.bloom') ||
      has('graphics.screenSpaceAmbientOcclusion') ||
      has('graphics.fxaa') ||
      has('graphics.vignette') ||
      has('graphics.antialias')
    ) {
      this.renderer.rebuildPostProcessing();
    }

    if (has('graphics.tonemapping') || has('graphics.shadows') || has('graphics.shadowQuality')) {
      this.renderer.applySettings(values);
      this.lighting?.applySettings(values.graphics);
    }

    if (has('graphics.shadowDistance')) this.lighting?.applySettings(values.graphics);

    if (
      has('graphics.textureFiltering') ||
      has('graphics.mipmaps') ||
      has('graphics.anisotropy') ||
      has('graphics.waterQuality') ||
      has('graphics.waterAnimation') ||
      has('graphics.leavesAnimation') ||
      has('graphics.grassAnimation')
    ) {
      this.materials.applySettings(values.graphics);
    }

    if (has('graphics.clouds') || has('graphics.cloudQuality') || has('graphics.starQuality')) {
      this.sky?.applySettings(values.graphics);
    }

    if (has('graphics.particles')) this.particles?.applySettings(values.graphics);
    if (has('graphics.weatherQuality')) this.weather?.applySettings(values.graphics);

    // Ambient occlusion, smooth lighting and water quality are baked into chunk
    // geometry, so changing them means rebuilding every loaded mesh.
    if (SettingsManager.requiresRemesh(changed)) {
      this.world?.rebuildAllMeshes();
      this.ui.notifications.info('Rebuilding chunk meshes…', {
        id: 'remesh',
        duration: 1800,
      });
    }

    if (has('graphics.renderDistance') || has('graphics.verticalDistance')) {
      this.world?.chunks.requestRescan();
    }

    if (anyStartingWith('audio.')) this.audio.applySettings(values.audio);
    if (anyStartingWith('gameplay.')) this.player?.applySettings(values);
    if (anyStartingWith('controls.')) this.player?.applySettings(values);
  }

  // ---------------------------------------------------------------- debug state

  /** Assembles everything the HUD and debug overlay report. */
  _collectDebugState() {
    const rendererInfo = this.renderer.getInfo();
    const bufferSize = this.renderer.getDrawingBufferSize(TEMP_VECTOR2);
    const memory = performance.memory;

    const player = this.player;
    const surfaceY =
      player && this.world
        ? this.world.getSurfaceY(Math.floor(player.position.x), Math.floor(player.position.z))
        : -1;

    return {
      player,
      world: this.world,
      camera: this.cameraController || { yaw: 0, pitch: 0 },
      loop: this.loop,
      chunks: this.world ? this.world.chunks.stats : EMPTY_CHUNK_STATS,
      workers: this.world ? this.world.chunks.workerPool.getStats() : EMPTY_WORKER_STATS,
      entities: this.entities ? this.entities.getStats() : EMPTY_ENTITY_STATS,
      particles: {
        active: this.particles ? this.particles.activeCount : 0,
        capacity: this.particles ? this.particles.capacity : 0,
      },
      audio: this.audio.getStats(),
      settings: this.settings.values,
      boss: this.phase5?.activeFight
        ? { ...this.phase5.activeFight.bar, name:'Ender Dragon' }
        : null,
      target: this._target,
      breakProgress: this.breaker ? this.breaker.progress : 0,
      biomeName:
        player && this.world
          ? this.world.getBiomeNameAt(Math.floor(player.position.x), Math.floor(player.position.z))
          : '—',
      surfaceY,
      timeOfDay: this.lighting ? this.lighting.timeOfDay : 0,
      // Biome fog state: how far the player can actually see, and why. Useful in
      // the debug overlay and asserted by the horror visual check.
      atmosphere: this.lighting ? this.lighting.getAtmosphereStats() : null,
      weather: {
        ...(this.weatherSystem ? this.weatherSystem.getStats() : {}),
        state: this.weather ? this.weather.weather : 'clear',
        intensity: this.weather ? this.weather.intensity : 0,
        exposure: this.weather ? this.weather.exposure : 1,
        droplets: this.weather ? this.weather.dropletCount : 0,
      },
      underwaterStrength: this.water ? this.water.getOverlayStrength() : 0,
      liquidBlock: this.water?.overlayBlock ?? Block.AIR,
      suffocating: Boolean(
        player &&
          this.world &&
          this.world.isOpaque(
            Math.floor(this._eye.x),
            Math.floor(this._eye.y),
            Math.floor(this._eye.z)
          )
      ),
      usingFallbackShader: this.materials.usingFallback,
      water: this.materials.waterDiagnostics,
      mining: this.breaker
        ? {
            progress: this.breaker.progress,
            willDrop: this.breaker.willDrop,
            correctTool: this.breaker.usingCorrectTool,
          }
        : null,
      combat: this.combat ? { readiness: this.combat.readiness, swinging: this.combat.swingTimer > 0 } : null,
      debugVisible: this.ui.debugOverlay.visible,
      renderer: {
        info: rendererInfo,
        memory: this.renderer.estimateMemory(),
        shadowMemory: this.lighting ? this.lighting.getShadowMemory() : 0,
        bufferWidth: Math.round(bufferSize.x),
        bufferHeight: Math.round(bufferSize.y),
        pixelRatio: this.renderer.renderer.getPixelRatio(),
        dynamicScale: this.renderer.dynamicScale,
        isWebGL2: this.renderer.isWebGL2,
        postPasses: this.renderer.post.passCount,
      },
      heapUsed: memory ? memory.usedJSHeapSize : 0,
      heapLimit: memory ? memory.jsHeapSizeLimit : 0,
    };
  }

  // -------------------------------------------------------------------- teardown

  /**
   * Complete teardown: every listener, worker, GPU resource and DOM node.
   *
   * Written so that calling it leaves the page in a state where a fresh `Game`
   * could be constructed, which is the only real test of whether disposal is
   * complete.
   */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;

    this.loop?.stop();
    this.subscriptions.dispose();

    this._teardownWorld();

    this.ui?.destroy();
    this.input?.destroy();
    this.audio?.destroy();
    this.saveManager?.destroy();
    this.settings?.destroy();
    this.shaderManager?.destroy();

    // Chunk geometries and per-world resources are gone by now; this frees the
    // shared atlas, materials and any remaining tracked resource.
    this.resources.disposeAll();
    this.atlas?.dispose();

    this.renderer?.destroy();

    if (this.scene) {
      this.scene.clear();
      this.scene = null;
    }

    this.bus.emit(Events.GAME_DESTROYED);
    this.bus.destroy();
  }
}

/** Reused scratch vector for the drawing-buffer query. */
const TEMP_VECTOR2 = new THREE.Vector2();

const EMPTY_CHUNK_STATS = Object.freeze({
  loaded: 0,
  visible: 0,
  visibleLayers: 0,
  generating: 0,
  meshing: 0,
  queuedGeneration: 0,
  queuedMeshing: 0,
  queuedUpload: 0,
  triangles: 0,
  generatedTotal: 0,
  meshedTotal: 0,
  discardedTotal: 0,
  evictedTotal: 0,
  recoveredTotal: 0,
});

const EMPTY_WORKER_STATS = Object.freeze({
  workers: 0,
  inlineMode: false,
  inFlight: 0,
  queuedInline: 0,
});

const EMPTY_ENTITY_STATS = Object.freeze({
  items: 0,
  falling: 0,
  mobs: 0,
  babies: 0,
  projectiles: 0,
  itemCapacity: 0,
  fallingCapacity: 0,
  mobCapacity: 0,
  projectileCapacity: 0,
});

export default Game;
