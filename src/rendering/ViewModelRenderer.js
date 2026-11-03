/**
 * First-person view model: player hand, arm, and held blocks / items.
 *
 * Attached to the camera to render the player's arm and held item in
 * bottom-right first-person view, with realistic bobbing, item switching,
 * camera sway, landing impact cushion, and fluid swing / mining / attack animations.
 */

import * as THREE from 'three';
import { getBlock } from '../world/BlockRegistry.js';
import { getItem } from '../items/ItemRegistry.js';
import { TILE_INDEX } from '../world/BlockTypes.js';
import { ToolType, ToolTier } from '../items/ItemTypes.js';
import { clamp, damp } from '../utils/MathUtils.js';

/** Base camera-space offset for the arm/hand. */
const BASE_POSITION = new THREE.Vector3(0.34, -0.18, -0.32);
/** Base rotation for the arm (Euler: pitch, yaw, roll). */
const BASE_ROTATION = new THREE.Euler(0.08, -0.18, 0.04, 'YXZ');

/**
 * Smoothing constants for `damp`.
 *
 * `damp()` takes the fraction of the distance that is *still left after one
 * second*, so every value here has to be strictly between 0 and 1. The view
 * model used to pass speed-like numbers (10, 12, 15), which makes
 * `Math.pow(smoothing, dt)` greater than one: the lerp factor leaves `[0, 1]`,
 * the value overshoots the target, and each frame multiplies the overshoot by
 * another 1.04. Three seconds of camera movement were enough to push the sway
 * term from ±0.08 to about -270, which is the arm flying off the screen.
 */
const SPEED_SMOOTHING = 1e-6;
const VERTICAL_SMOOTHING = 1e-5;
const SWAY_SMOOTHING = 0.002;

/** Flat per-face-tinted material, the same trick the voxel textures use. */
function tint(colour) {
  return new THREE.MeshBasicMaterial({ color: colour });
}

/** Tier color palettes for 3D tools. */
const TIER_COLORS = {
  [ToolTier.WOOD]: 0x8b5a2b,
  [ToolTier.STONE]: 0x7f8c8d,
  [ToolTier.IRON]: 0xe2e8f0,
  [ToolTier.GOLD]: 0xf59e0b,
  [ToolTier.DIAMOND]: 0x06b6d4,
  [ToolTier.NONE]: 0xa0a0a0,
};

export class ViewModelRenderer {
  /**
   * @param {Object} options
   * @param {THREE.PerspectiveCamera} options.camera
   * @param {import('./TextureAtlas.js').TextureAtlas} options.atlas
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   */
  constructor({ camera, atlas, settings }) {
    this._camera = camera;
    this._atlas = atlas;
    this._settings = settings;

    /** Root group added to the camera. */
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'viewModelRoot';
    this.rootGroup.renderOrder = 999;
    this.rootGroup.onBeforeRender = (renderer) => {
      renderer.clearDepth();
    };
    this._camera.add(this.rootGroup);

    /** Main arm group holding arm & held item. */
    this.armGroup = new THREE.Group();
    this.armGroup.position.copy(BASE_POSITION);
    this.armGroup.rotation.copy(BASE_ROTATION);
    this.rootGroup.add(this.armGroup);

    /** Group attached to the hand holding the current item. */
    this.heldItemGroup = new THREE.Group();
    // Positioned at the wrist / palm area of the hand
    this.heldItemGroup.position.set(0, 0.02, -0.16);
    this.armGroup.add(this.heldItemGroup);

    /** Currently held item ID. */
    this._currentItemId = null;
    this._targetItemId = null;

    /** Material cache to prevent memory leaks. */
    this._disposables = [];

    /** Swing animation state. */
    this.swingProgress = 0;
    this.isSwinging = false;
    this._swingDuration = 0.22; // seconds per swing
    this._isPlaceSwing = false;

    /** Item switch equip / dip animation. */
    this._equipProgress = 1; // 1 = fully equipped, 0 = lowest dip point
    this._isEquipping = false;

    /** Movement bobbing phases & smoothed values. */
    this._bobPhase = 0;
    this._idlePhase = 0;
    this._smoothedSpeed = 0;
    this._verticalVelOffset = 0;

    /** Camera look sway tracking. */
    this._prevCamEuler = new THREE.Euler().copy(this._camera.rotation);
    this._swayYaw = 0;
    this._swayPitch = 0;

    /** Build base arm and hand model. */
    this._buildArm();
  }

  /**
   * Builds the first-person arm: a teal sleeve, a skin hand and a thumb.
   *
   * Replaces a single unlit `0xffffff` box. That box had two problems: pure white
   * with no shading reads as a missing material rather than as a sleeve, and its
   * skin-toned face was the *+Z* one -- the end nearest the camera -- so the hand
   * was the part hidden behind the near plane while the player looked at a white
   * bar. Here the boxes run from the camera outwards along -Z, the hand is the far
   * box, and each face carries a tint so the silhouette reads as a solid arm
   * without a light being involved.
   *
   * Colours are the third-person avatar's own palette, so the first- and
   * third-person bodies are the same character.
   */
  _buildArm() {
    const shirtShade = tint(0x0f666d);
    const shirt = tint(0x168f91);
    const shirtLight = tint(0x31b8b1);
    const skin = tint(0xc98f67);
    const skinShade = tint(0xaa704e);
    const skinLight = tint(0xe0aa7e);

    // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z.
    const sleeveMaterials = [shirt, shirt, shirtLight, shirtShade, shirt, shirtShade];
    const handMaterials = [skin, skin, skinLight, skinShade, skin, skin];

    const sleeveGeometry = new THREE.BoxGeometry(0.13, 0.13, 0.24);
    const sleeve = new THREE.Mesh(sleeveGeometry, sleeveMaterials);
    sleeve.name = 'viewmodel-sleeve';
    // The near end stops at z = -0.11 in camera space, just outside the 0.08
    // near plane, so the sleeve never gets clipped into a hard-edged hole.
    sleeve.position.set(0, 0, 0.09);

    const handGeometry = new THREE.BoxGeometry(0.16, 0.16, 0.15);
    const hand = new THREE.Mesh(handGeometry, handMaterials);
    hand.name = 'viewmodel-hand';
    hand.position.set(0, -0.005, -0.105);

    const thumbGeometry = new THREE.BoxGeometry(0.055, 0.07, 0.09);
    const thumb = new THREE.Mesh(thumbGeometry, handMaterials);
    thumb.name = 'viewmodel-thumb';
    thumb.position.set(-0.09, 0.015, -0.08);

    this._disposables.push(
      sleeveGeometry, handGeometry, thumbGeometry,
      shirtShade, shirt, shirtLight, skin, skinShade, skinLight
    );
    this.armGroup.add(sleeve, hand, thumb);
  }

  /**
   * Sets or updates the currently held item.
   * @param {string|null} itemId
   */
  setHeldItem(itemId) {
    if (this._currentItemId === itemId && this._targetItemId === itemId) return;

    this._targetItemId = itemId;

    // Initial load: instant swap without lowering
    if (this._currentItemId === null && !this._isEquipping) {
      this._applyHeldItem(itemId);
      return;
    }

    // Start equip transition dip
    this._isEquipping = true;
  }

  /** Actually constructs the 3D geometry for a given item ID. */
  _applyHeldItem(itemId) {
    this._currentItemId = itemId;
    this._clearHeldItemMesh();

    if (!itemId) return; // Bare hand

    const definition = getItem(itemId);
    if (!definition) return;

    // Blocks without solid textures (fern, etc.) use generic sprite fallback
    if (definition.placeableBlockId !== null) {
      const block = getBlock(definition.placeableBlockId);
      if (!block || block.textureSide == null) {
        this._buildHeldGenericItemMesh(definition);
        return;
      }
      this._buildHeldBlockMesh(definition.placeableBlockId);
    } else if (definition.toolType && definition.toolType !== ToolType.NONE) {
      this._buildHeldToolMesh(definition);
    } else {
      this._buildHeldGenericItemMesh(definition);
    }
  }

  /** Clears existing held item meshes and disposes their materials. */
  _clearHeldItemMesh() {
    while (this.heldItemGroup.children.length > 0) {
      const child = this.heldItemGroup.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    }
  }

  /** Builds 3D mini block mesh for placeable blocks. */
  _buildHeldBlockMesh(blockId) {
    const block = getBlock(blockId);
    if (!block) return;

    const size = 0.18;
    const geometry = new THREE.BoxGeometry(size, size, size);

    // Look up textures for top, side, and bottom faces
    const topTile = TILE_INDEX[block.textureTop ?? block.textureSide];
    const sideTile = TILE_INDEX[block.textureSide];
    const bottomTile = TILE_INDEX[block.textureBottom ?? block.textureSide];

    const topTex = this._atlas.getTileTexture(topTile);
    const sideTex = this._atlas.getTileTexture(sideTile);
    const bottomTex = this._atlas.getTileTexture(bottomTile);

    const matTop = topTex ? new THREE.MeshBasicMaterial({ map: topTex }) : new THREE.MeshBasicMaterial({ color: 0x888888 });
    const matSide = sideTex ? new THREE.MeshBasicMaterial({ map: sideTex }) : new THREE.MeshBasicMaterial({ color: 0x888888 });
    const matBottom = bottomTex ? new THREE.MeshBasicMaterial({ map: bottomTex }) : new THREE.MeshBasicMaterial({ color: 0x888888 });

    // Set transparency if glass / liquid
    if (block.id === 8 || block.id === 9 || block.id === 20) { // Water or Glass
      [matTop, matSide, matBottom].forEach((m) => {
        m.transparent = true;
        m.opacity = 0.75;
      });
    }

    const materials = [
      matSide,   // +X
      matSide,   // -X
      matTop,    // +Y
      matBottom, // -Y
      matSide,   // +Z
      matSide,   // -Z
    ];

    const mesh = new THREE.Mesh(geometry, materials);
    // Position held block right in front of hand
    mesh.position.set(-0.02, 0.06, -0.04);
    // Rotate block so top, side, and front are visible
    mesh.rotation.set(0.2, 0.45, 0.1);

    this.heldItemGroup.add(mesh);
  }

  /** Builds 3D model for tools (pickaxes, swords, axes, shovels, hoes). */
  _buildHeldToolMesh(definition) {
    const toolGroup = new THREE.Group();
    const tierColor = TIER_COLORS[definition.toolTier] ?? 0xcccccc;

    const handleMat = new THREE.MeshBasicMaterial({ color: 0x654321 }); // dark wood handle
    const headMat = new THREE.MeshBasicMaterial({ color: tierColor });

    // Handle stick
    const handleGeo = new THREE.BoxGeometry(0.02, 0.32, 0.02);
    const handleMesh = new THREE.Mesh(handleGeo, handleMat);
    handleMesh.position.set(0, 0, 0);
    handleMesh.rotation.z = -0.4;
    toolGroup.add(handleMesh);

    // Head / Blade geometry depending on ToolType
    let headMesh = null;
    switch (definition.toolType) {
      case ToolType.SWORD: {
        const bladeGeo = new THREE.BoxGeometry(0.032, 0.34, 0.012);
        headMesh = new THREE.Mesh(bladeGeo, headMat);
        headMesh.position.set(-0.08, 0.12, 0);
        headMesh.rotation.z = -0.4;

        // Crossguard
        const guardGeo = new THREE.BoxGeometry(0.09, 0.02, 0.02);
        const guardMesh = new THREE.Mesh(guardGeo, headMat);
        guardMesh.position.set(-0.03, -0.01, 0);
        guardMesh.rotation.z = -0.4;
        toolGroup.add(guardMesh);
        break;
      }
      case ToolType.PICKAXE: {
        const headGeo = new THREE.BoxGeometry(0.22, 0.032, 0.032);
        headMesh = new THREE.Mesh(headGeo, headMat);
        headMesh.position.set(-0.06, 0.12, 0);
        headMesh.rotation.z = 0.2;
        break;
      }
      case ToolType.AXE: {
        const headGeo = new THREE.BoxGeometry(0.09, 0.12, 0.025);
        headMesh = new THREE.Mesh(headGeo, headMat);
        headMesh.position.set(-0.09, 0.11, 0);
        headMesh.rotation.z = -0.4;
        break;
      }
      case ToolType.SHOVEL: {
        const headGeo = new THREE.BoxGeometry(0.08, 0.11, 0.015);
        headMesh = new THREE.Mesh(headGeo, headMat);
        headMesh.position.set(-0.08, 0.12, 0);
        headMesh.rotation.z = -0.4;
        break;
      }
      case ToolType.HOE: {
        const headGeo = new THREE.BoxGeometry(0.10, 0.035, 0.025);
        headMesh = new THREE.Mesh(headGeo, headMat);
        headMesh.position.set(-0.08, 0.12, 0);
        headMesh.rotation.z = -0.1;
        break;
      }
      default: {
        const defaultGeo = new THREE.BoxGeometry(0.08, 0.08, 0.08);
        headMesh = new THREE.Mesh(defaultGeo, headMat);
        headMesh.position.set(-0.06, 0.12, 0);
      }
    }

    if (headMesh) toolGroup.add(headMesh);

    toolGroup.position.set(-0.02, 0.04, -0.05);
    toolGroup.rotation.set(0.2, 0.3, -0.2);

    this.heldItemGroup.add(toolGroup);
  }

  /** Builds 2D sprite plane for generic items / food. */
  _buildHeldGenericItemMesh(definition) {
    const tileIndex = definition.icon;
    const tex = this._atlas.getTileTexture(tileIndex);

    const size = 0.18;
    const geometry = new THREE.PlaneGeometry(size, size);
    const material = tex
      ? new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
      : new THREE.MeshBasicMaterial({ color: 0xffa500 });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(-0.02, 0.04, -0.05);
    mesh.rotation.set(0.1, 0.3, 0);

    this.heldItemGroup.add(mesh);
  }

  /** Triggers a hand swing animation (e.g. mining, placing, attacking). */
  triggerSwing(isPlace = false) {
    this.swingProgress = 0.001;
    this.isSwinging = true;
    this._isPlaceSwing = isPlace;
    this._swingDuration = isPlace ? 0.16 : 0.22;
  }

  /**
   * Updates hand animation state each frame.
   * @param {number} dt Delta time in seconds.
   * @param {import('../player/Player.js').Player} player
   * @param {boolean} isMining Whether break action is currently held.
   * @param {boolean} isPlacing Whether place action is currently held.
   */
  update(dt, player, isMining = false, isPlacing = false) {
    // If mining or placing and not currently swinging, trigger a new swing cycle
    if (isMining && !this.isSwinging) {
      this.triggerSwing(false);
    } else if (isPlacing && !this.isSwinging) {
      this.triggerSwing(true);
    }

    // --- Item Equip Transition (Dip & Raise) ---
    let equipDipY = 0;
    if (this._isEquipping) {
      if (this._currentItemId !== this._targetItemId) {
        // Lowering item
        this._equipProgress = Math.max(0, this._equipProgress - dt * 6.0);
        if (this._equipProgress === 0) {
          // At lowest point, swap 3D mesh
          this._applyHeldItem(this._targetItemId);
        }
      } else {
        // Raising item
        this._equipProgress = Math.min(1, this._equipProgress + dt * 6.0);
        if (this._equipProgress === 1) {
          this._isEquipping = false;
        }
      }
      equipDipY = (1 - Math.sin(this._equipProgress * Math.PI * 0.5)) * -0.14;
    }

    // --- Swing Animation Curve ---
    let swingPitch = 0;
    let swingYaw = 0;
    let swingRoll = 0;
    let swingOffsetX = 0;
    let swingOffsetY = 0;
    let swingOffsetZ = 0;

    if (this.swingProgress > 0) {
      this.swingProgress += dt / this._swingDuration;
      if (this.swingProgress >= 1) {
        // If still holding mine/place, immediately restart swing for seamless loop
        if (isMining) {
          this.swingProgress = 0.001;
          this.isSwinging = true;
          this._isPlaceSwing = false;
        } else if (isPlacing) {
          this.swingProgress = 0.001;
          this.isSwinging = true;
          this._isPlaceSwing = true;
        } else {
          this.swingProgress = 0;
          this.isSwinging = false;
        }
      }

      if (this.swingProgress > 0) {
        const t = this.swingProgress;
        if (this._isPlaceSwing) {
          // Quick subtle forward place tap
          const placeCurve = Math.sin(t * Math.PI);
          swingPitch = -0.3 * placeCurve;
          swingOffsetZ = -0.06 * placeCurve;
          swingOffsetY = 0.02 * placeCurve;
        } else {
          // Fluid Minecraft arc swing
          const swingSin = Math.sin(t * Math.PI);
          const sqrtSin = Math.sin(Math.sqrt(t) * Math.PI);
          swingPitch = -1.15 * sqrtSin;
          swingYaw = -0.45 * swingSin;
          swingRoll = 0.35 * swingSin;
          swingOffsetX = -0.05 * swingSin;
          swingOffsetY = 0.04 * swingSin;
          swingOffsetZ = -0.10 * sqrtSin;
        }
      }
    }

    // --- Walking, Sprinting & Airborne Bobbing ---
    let bobX = 0;
    let bobY = 0;
    let bobPitch = 0;
    let bobRoll = 0;

    const controls = this._settings.values.controls;
    const rawSpeed = player ? Math.hypot(player.velocity.x, player.velocity.z) : 0;
    this._smoothedSpeed = damp(this._smoothedSpeed, rawSpeed, SPEED_SMOOTHING, dt);

    const isSprinting = player?.intent?.sprint && this._smoothedSpeed > 2.0;
    const isCrouching = player?.intent?.crouch;

    // Vertical velocity impact cushion (jumping / falling)
    const targetVertOffset = player ? clamp(-player.velocity.y * 0.006, -0.08, 0.08) : 0;
    this._verticalVelOffset = damp(this._verticalVelOffset, targetVertOffset, VERTICAL_SMOOTHING, dt);

    if (controls.cameraBob && this._smoothedSpeed > 0.3 && player?.onGround && !player?.flying) {
      const bobFreq = (isSprinting ? 4.2 : 3.4) * (this._smoothedSpeed / 4.3);
      this._bobPhase += dt * bobFreq;

      const footstepSin = Math.sin(this._bobPhase);
      const bobAmpX = isSprinting ? 0.022 : 0.015;
      const bobAmpY = isSprinting ? 0.016 : 0.011;

      bobX = Math.cos(this._bobPhase * 0.5) * bobAmpX;
      bobY = -Math.abs(footstepSin) * bobAmpY;
      bobPitch = footstepSin * 0.025;
      bobRoll = Math.cos(this._bobPhase * 0.5) * 0.03;
    } else {
      // Gentle idle breathing sway when standing still
      this._idlePhase += dt * 1.8;
      bobX = Math.sin(this._idlePhase * 0.8) * 0.0025;
      bobY = Math.sin(this._idlePhase * 1.6) * 0.003;
      bobRoll = Math.cos(this._idlePhase * 0.8) * 0.004;
    }

    // --- Camera Turn Inertia / Look Sway ---
    const currYaw = this._camera.rotation.y;
    const currPitch = this._camera.rotation.x;
    const deltaYaw = currYaw - this._prevCamEuler.y;
    const deltaPitch = currPitch - this._prevCamEuler.x;
    this._prevCamEuler.set(currPitch, currYaw, this._camera.rotation.z, 'YXZ');

    const targetSwayYaw = clamp(-deltaYaw * 0.2, -0.08, 0.08);
    const targetSwayPitch = clamp(-deltaPitch * 0.2, -0.08, 0.08);

    this._swayYaw = clamp(damp(this._swayYaw, targetSwayYaw, SWAY_SMOOTHING, dt), -0.25, 0.25);
    this._swayPitch = clamp(damp(this._swayPitch, targetSwayPitch, SWAY_SMOOTHING, dt), -0.25, 0.25);

    // Crouch offset
    const crouchOffsetY = isCrouching ? -0.03 : 0;

    // --- Apply final combined transforms to armGroup ---
    this.armGroup.position.set(
      BASE_POSITION.x + bobX + swingOffsetX + this._swayYaw * 0.5,
      BASE_POSITION.y + equipDipY + bobY + swingOffsetY + crouchOffsetY + this._verticalVelOffset + this._swayPitch * 0.5,
      BASE_POSITION.z + swingOffsetZ
    );

    this.armGroup.rotation.set(
      BASE_ROTATION.x + swingPitch + bobPitch + this._swayPitch,
      BASE_ROTATION.y + swingYaw + this._swayYaw,
      BASE_ROTATION.z + swingRoll + bobRoll,
      'YXZ'
    );
  }

  /** Cleans up resources. */
  destroy() {
    if (this.rootGroup && this._camera) {
      this._camera.remove(this.rootGroup);
    }
    this._clearHeldItemMesh();
    this._disposables.forEach((d) => d.dispose?.());
    this._disposables = [];
  }
}

export default ViewModelRenderer;
