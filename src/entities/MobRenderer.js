/**
 * Instanced renderer for living voxel creatures.
 *
 * Every mob type owns one merged geometry and one `InstancedMesh`; adding twenty
 * cows changes the instance count, not the draw-call count. Body boxes carry a
 * limb role and pivot, so walking/head animation happens in the vertex shader
 * without scene-graph nodes per creature.
 */

import * as THREE from 'three';

import { ENTITIES } from '../config/GameConfig.js';
import {
  MOB_FACE_RECT,
  MOB_SKIN_ROLES,
  mobEyeBoxes,
  mobSkinRoleForBone,
  mobSkinRoleForBox,
  mobSkinStyle,
  mobSkinTileName,
} from '../config/MobSkins.js';
import { TILE_UVS } from '../world/AtlasLayout.js';
import { TILE_INDEX } from '../world/BlockTypes.js';
import { MOB_DEFINITIONS } from './MobTypes.js';
import { MobAnimator } from './MobAnimator.js';
import { MOB_SKELETONS } from './MobSkeletons.js';
import { MobPoseBuffer } from '../rendering/MobPoseBuffer.js';

const MOB_VERTEX_SHADER = /* glsl */ `
  attribute float aShade;
  attribute float aBone;
  attribute float aFace;
  attribute float aInstanceRow;
  attribute vec4 aMobAnim; // hurt, alive, unused, unused

  uniform sampler2D uBones;
  uniform vec2 uBoneTexSize;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vViewDepth;
  varying float vShade;
  varying float vHurt;
  varying float vFace;

  vec4 boneRow(float bone, float row) {
    vec2 uv = vec2((bone * 3.0 + row + 0.5) / uBoneTexSize.x,
                    (aInstanceRow + 0.5) / uBoneTexSize.y);
    return texture2D(uBones, uv);
  }

  void main() {
    vec4 r0 = boneRow(aBone, 0.0);
    vec4 r1 = boneRow(aBone, 1.0);
    vec4 r2 = boneRow(aBone, 2.0);
    vec4 source = vec4(position, 1.0);
    vec3 localPosition = vec3(dot(r0, source), dot(r1, source), dot(r2, source));
    vec3 localNormal = normalize(vec3(dot(r0.xyz, normal), dot(r1.xyz, normal), dot(r2.xyz, normal)));

    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(localPosition, 1.0);
    vWorldPosition = worldPosition.xyz;
    mat3 normalMatrixWorld = mat3(modelMatrix) * mat3(instanceMatrix);
    vWorldNormal = normalize(normalMatrixWorld * localNormal);
    // The UVs are already baked into atlas space per body part, so every box can
    // sample its own tile: face on the front of a head, plain skin elsewhere.
    vUv = uv;
    vShade = aShade;
    vHurt = aMobAnim.x;
    vFace = aFace;

    vec4 viewPosition = viewMatrix * worldPosition;
    vViewDepth = -viewPosition.z;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const MOB_FRAGMENT_SHADER = /* glsl */ `
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
  uniform float uRimBoost;

  uniform vec4 uFaceRect;
  uniform vec4 uEyeBoxA;
  uniform vec4 uEyeBoxB;
  uniform vec3 uEyeColor;
  uniform float uEyeGlow;

  varying vec2 vUv;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vViewDepth;
  varying float vShade;
  varying float vHurt;
  varying float vFace;

  /** 1.0 when a face-relative coordinate lies inside one pupil box. */
  float eyeBox(vec2 faceUv, vec4 box) {
    vec2 lower = box.xy;
    vec2 upper = box.xy + box.zw;
    return step(lower.x, faceUv.x) * step(faceUv.x, upper.x)
         * step(lower.y, faceUv.y) * step(faceUv.y, upper.y);
  }

  void main() {
    vec4 texel = texture2D(uAtlas, vUv);
    if (texel.a < 0.4) discard;

    vec3 normal = normalize(vWorldNormal);
    float hemisphere = normal.y * 0.5 + 0.5;
    vec3 ambient = mix(uGroundAmbient, uSkyAmbient, hemisphere);
    float ndotl = max(dot(normal, uSunDirection), 0.0);
    vec3 lighting = ambient + uSunColor * ndotl * 0.82 + vec3(uCaveAmbient);

    // Sky rim light pops silhouettes out of dark backdrops, the way creatures
    // separate from the fog in modern Minecraft shader packs. The extra night
    // term is what keeps a hostile readable as a *shape* at midnight instead of
    // collapsing into an untextured black blob.
    vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
    float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0);
    lighting += uSkyAmbient * (rim * 0.4) + vec3(uRimBoost * rim);

    vec3 base = texel.rgb * vShade;
    base = mix(base, vec3(1.0, 0.16, 0.12), clamp(vHurt, 0.0, 0.72));
    vec3 color = base * lighting * uBrightness;
    // Creatures fade out later than terrain. The fog far plane is tuned for
    // landscape silhouettes; applying it verbatim to a 40-pixel-tall mob erases
    // it several blocks before the player could ever read its face. Pushing the
    // creature fade a third further keeps a hostile visible as it leaves the
    // mist, which is the difference between "a monster appeared" and "something
    // hit me from nowhere".
    float fog = smoothstep(uFogNear, uFogFar * 1.35, vViewDepth) * uFogStrength * 0.92;
    color = mix(color, uFogColor, fog);

    // Glowing eyes are drawn after the fog on purpose: the whole point of the
    // feature is that two points of light survive the dark and the mist even
    // when the rest of the creature does not.
    if (uEyeGlow > 0.5 && vFace > 0.5) {
      vec2 faceUv = (vUv - uFaceRect.xy) / uFaceRect.zw;
      float pupils = clamp(eyeBox(faceUv, uEyeBoxA) + eyeBox(faceUv, uEyeBoxB), 0.0, 1.0);
      color = mix(color, uEyeColor, pupils * 0.92);
    }

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** UV rect of one atlas tile, as `{u0, v0, u1, v1}` in atlas space. */
function rectForTile(tile) {
  const base = tile * 4;
  return {
    u0: TILE_UVS[base],
    v0: TILE_UVS[base + 1],
    u1: TILE_UVS[base + 2],
    v1: TILE_UVS[base + 3],
  };
}

/** Shrinks a tile rect to a sub-rect expressed as `0..1` fractions of the tile. */
function subRect(rect, fraction) {
  const width = rect.u1 - rect.u0;
  const height = rect.v1 - rect.v0;
  return {
    u0: rect.u0 + width * fraction.u0,
    v0: rect.v0 + height * fraction.v0,
    u1: rect.u0 + width * fraction.u1,
    v1: rect.v0 + height * fraction.v1,
  };
}

/**
 * Builds the per-role UV rects for one creature.
 *
 * A missing per-part tile falls back to the creature's original single tile, so
 * an unskinned mob still renders (with its old flat look) instead of throwing
 * inside the renderer. The horror self-test is what forbids shipping that state.
 *
 * @param {{id: string, tileName: string}} definition
 */
function skinRectsFor(definition) {
  const tiles = Object.create(null);
  for (const role of MOB_SKIN_ROLES) {
    const tile = TILE_INDEX[mobSkinTileName(definition.id, role)];
    if (tile !== undefined) tiles[role] = rectForTile(tile);
  }
  const fallbackTile = TILE_INDEX[definition.tileName];
  const fallback = fallbackTile === undefined ? null : rectForTile(fallbackTile);
  const body = tiles.body ?? tiles.head ?? fallback;
  if (!body) throw new Error(`Mob ${definition.id} has no atlas tile ${definition.tileName}`);

  const head = tiles.head ?? body;
  const rects = {
    body: { full: body },
    limb: { full: tiles.limb ?? body },
    accent: { full: tiles.accent ?? body },
    head: {
      // The back, sides, top and bottom of a head sample the body tile rather
      // than a strip of the face tile. The face tile only leaves a three-pixel
      // border around the face, and stretching that border over a whole cube
      // face produced visible smears; the body tile carries the same hide and
      // marking pattern without any facial features.
      full: body,
      face: subRect(head, MOB_FACE_RECT),
      side: body,
    },
  };
  return rects;
}

/**
 * Maps one box vertex to a UV inside its part's rect.
 *
 * The face is chosen from the vertex normal (box normals are axis-aligned) and
 * the coordinate is normalised against the box size, which gives a proper
 * unwrap with the tile's top row at the top of every face. Using the stock
 * `BoxGeometry` UVs instead would have needed a per-face flip and would have
 * made "front of the head" impossible to identify.
 *
 * @param {number[]} size Box size `[w, h, d]`.
 * @param {number} px Vertex X in box space.
 * @param {number} py Vertex Y in box space.
 * @param {number} pz Vertex Z in box space.
 * @param {number} nx Vertex normal X.
 * @param {number} ny Vertex normal Y.
 * @param {number} nz Vertex normal Z.
 * @returns {{u: number, w: number, front: boolean}}
 */
function faceCoordinates(size, px, py, pz, nx, ny, nz) {
  const [width, height, depth] = size;
  const halfWidth = width * 0.5;
  const halfHeight = height * 0.5;
  const halfDepth = depth * 0.5;
  // `w` is the vertical coordinate with 0 at the top of the face, matching the
  // atlas, whose v axis grows downwards.
  if (Math.abs(nz) > 0.5) {
    const front = nz > 0;
    return {
      u: front ? (px + halfWidth) / width : (halfWidth - px) / width,
      w: (halfHeight - py) / height,
      front,
    };
  }
  if (Math.abs(nx) > 0.5) {
    return {
      u: nx > 0 ? (halfDepth - pz) / depth : (pz + halfDepth) / depth,
      w: (halfHeight - py) / height,
      front: false,
    };
  }
  return {
    u: (px + halfWidth) / width,
    w: ny > 0 ? (pz + halfDepth) / depth : (halfDepth - pz) / depth,
    front: false,
  };
}

/**
 * Merges a skeleton's bone-local boxes and records one bone index per vertex.
 *
 * UVs are baked here rather than in the shader: each box picks the tile of its
 * skin role, and the front face of a head picks the face sub-rect. That is what
 * turns a single stretched block texture into a creature with eyes, a muzzle and
 * hooves.
 *
 * @param {{skeleton: {bones: ReadonlyArray<Object>}}} rig
 * @param {ReturnType<typeof skinRectsFor>} skinRects
 */
function buildMobGeometry(rig, skinRects) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const bones = [];
  const shades = [];
  const faceFlags = [];
  const indices = [];
  let vertexBase = 0;

  for (let boneIndex = 0; boneIndex < rig.skeleton.bones.length; boneIndex++) {
    const bone = rig.skeleton.bones[boneIndex];
    const boneRole = mobSkinRoleForBone(bone.name);
    let boxIndex = 0;
    for (const part of bone.boxes ?? []) {
      const role = mobSkinRoleForBox(boneRole, boxIndex++);
      const rects = skinRects[role] ?? skinRects.body;

      // Boxes are built by hand rather than with BoxGeometry so the vertex order
      // and the face-relative UV math stay explicit.
      const [width, height, depth] = part.size;
      const halfWidth = width * 0.5;
      const halfHeight = height * 0.5;
      const halfDepth = depth * 0.5;
      const faces = [
        { nx: 1, ny: 0, nz: 0, corners: [[halfWidth, -halfHeight, halfDepth], [halfWidth, -halfHeight, -halfDepth], [halfWidth, halfHeight, -halfDepth], [halfWidth, halfHeight, halfDepth]] },
        { nx: -1, ny: 0, nz: 0, corners: [[-halfWidth, -halfHeight, -halfDepth], [-halfWidth, -halfHeight, halfDepth], [-halfWidth, halfHeight, halfDepth], [-halfWidth, halfHeight, -halfDepth]] },
        { nx: 0, ny: 1, nz: 0, corners: [[-halfWidth, halfHeight, halfDepth], [halfWidth, halfHeight, halfDepth], [halfWidth, halfHeight, -halfDepth], [-halfWidth, halfHeight, -halfDepth]] },
        { nx: 0, ny: -1, nz: 0, corners: [[-halfWidth, -halfHeight, -halfDepth], [halfWidth, -halfHeight, -halfDepth], [halfWidth, -halfHeight, halfDepth], [-halfWidth, -halfHeight, halfDepth]] },
        { nx: 0, ny: 0, nz: 1, corners: [[-halfWidth, -halfHeight, halfDepth], [halfWidth, -halfHeight, halfDepth], [halfWidth, halfHeight, halfDepth], [-halfWidth, halfHeight, halfDepth]] },
        { nx: 0, ny: 0, nz: -1, corners: [[halfWidth, -halfHeight, -halfDepth], [-halfWidth, -halfHeight, -halfDepth], [-halfWidth, halfHeight, -halfDepth], [halfWidth, halfHeight, -halfDepth]] },
      ];

      for (const face of faces) {
        for (const corner of face.corners) {
          const [px, py, pz] = corner;
          positions.push(px + part.offset[0], py + part.offset[1], pz + part.offset[2]);
          normals.push(face.nx, face.ny, face.nz);
          const { u, w, front } = faceCoordinates(part.size, px, py, pz, face.nx, face.ny, face.nz);
          const rect = role === 'head' ? (front ? rects.face : rects.side) : rects.full;
          uvs.push(
            rect.u0 + (rect.u1 - rect.u0) * u,
            rect.v0 + (rect.v1 - rect.v0) * w
          );
          bones.push(boneIndex);
          shades.push(part.shade ?? 1);
          faceFlags.push(role === 'head' && front ? 1 : 0);
        }
        // Quad corners are pushed bottom-left, bottom-right, top-right, top-left
        // as seen from outside the box, so this winding faces the viewer. The
        // base has to advance per face: all six quads of a box were previously
        // indexed against the first quad's four vertices, which left every box
        // as a single +X card and made creatures vanish when seen from any other
        // direction.
        const base = vertexBase;
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        vertexBase += 4;
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aBone', new THREE.Float32BufferAttribute(bones, 1));
  geometry.setAttribute('aShade', new THREE.Float32BufferAttribute(shades, 1));
  geometry.setAttribute('aFace', new THREE.Float32BufferAttribute(faceFlags, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const animation = new THREE.InstancedBufferAttribute(
    new Float32Array(ENTITIES.maxMobs * 4),
    4
  );
  animation.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aMobAnim', animation);
  const rows = new THREE.InstancedBufferAttribute(new Float32Array(ENTITIES.maxMobs), 1);
  for (let i = 0; i < ENTITIES.maxMobs; i++) rows.setX(i, i);
  geometry.setAttribute('aInstanceRow', rows);
  return geometry;
}

function createMaterial(atlasTexture, poseTexture, poseBuffer, skin) {
  const faceRect = skin.faceRect;
  const eyeBoxes = skin.eyeBoxes;
  const eye = skin.eye.map((channel) => Math.min(255, Math.round(channel * (skin.eyeGlow ? 1.25 : 1))));
  return new THREE.ShaderMaterial({
    name: 'mob-skin',
    uniforms: {
      uAtlas: { value: atlasTexture },
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
      uRimBoost: { value: 0 },
      uFaceRect: { value: new THREE.Vector4(
        faceRect.u0,
        faceRect.v0,
        faceRect.u1 - faceRect.u0,
        faceRect.v1 - faceRect.v0
      ) },
      uEyeBoxA: { value: new THREE.Vector4(...eyeBoxes[0]) },
      uEyeBoxB: { value: new THREE.Vector4(...eyeBoxes[1]) },
      uEyeColor: { value: new THREE.Color().setRGB(
        eye[0] / 255,
        eye[1] / 255,
        eye[2] / 255,
        THREE.SRGBColorSpace
      ) },
      uEyeGlow: { value: skin.eyeGlow ? 1 : 0 },
      uBones: { value: poseTexture },
      uBoneTexSize: { value: new THREE.Vector2(poseBuffer.width, poseBuffer.height) },
    },
    vertexShader: MOB_VERTEX_SHADER,
    fragmentShader: MOB_FRAGMENT_SHADER,
    fog: false,
    toneMapped: true,
  });
}

export class MobRenderer {
  constructor({ scene, atlasTexture, resources }) {
    this._scene = scene;
    this._resources = resources;
    this._entries = new Map();
    this._matrix = new THREE.Matrix4();
    this._position = new THREE.Vector3();
    this._quaternion = new THREE.Quaternion();
    this._scale = new THREE.Vector3(1, 1, 1);
    this._shadowScale = new THREE.Vector3(1, 1, 1);
    this._shadowQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(-Math.PI / 2, 0, 0)
    );
    this._shadowMatrix = new THREE.Matrix4();
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._animators = new Map();
    this._animatorKeys = new WeakMap();
    this._nextAnimatorKey = 1;
    this._lastSync = null;

    // One translucent instance pool grounds every rig against the voxel terrain.
    // It adds a single draw call instead of a separate shadow mesh per creature.
    this._shadowGeometry = new THREE.CircleGeometry(1, 20);
    this._shadowMaterial = new THREE.MeshBasicMaterial({
      name:'mob-contact-shadows',
      color:0x000000,
      transparent:true,
      opacity:.2,
      depthWrite:false,
      polygonOffset:true,
      polygonOffsetFactor:-1,
    });
    this.shadowMesh = new THREE.InstancedMesh(
      this._shadowGeometry,
      this._shadowMaterial,
      ENTITIES.maxMobs
    );
    this.shadowMesh.name = 'mob-contact-shadows';
    this.shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shadowMesh.count = 0;
    this.shadowMesh.visible = false;
    this.shadowMesh.frustumCulled = false;
    scene.add(this.shadowMesh);
    resources.trackTransient(this._shadowGeometry);
    resources.trackTransient(this._shadowMaterial);

    for (const definition of MOB_DEFINITIONS) {
      const rig = MOB_SKELETONS[definition.id];
      if (!rig) throw new Error(`Mob ${definition.id} has no skeletal rig`);
      const skinRects = skinRectsFor(definition);
      const style = mobSkinStyle(definition.id);
      const geometry = buildMobGeometry(rig, skinRects);
      const poseBuffer = new MobPoseBuffer({ boneCount: rig.skeleton.bones.length, maxInstances: ENTITIES.maxMobs });
      const poseTexture = new THREE.DataTexture(
        poseBuffer.data,
        poseBuffer.width,
        poseBuffer.height,
        THREE.RGBAFormat,
        THREE.FloatType
      );
      poseTexture.name = `mob-bones-${definition.id}`;
      poseTexture.minFilter = THREE.NearestFilter;
      poseTexture.magFilter = THREE.NearestFilter;
      poseTexture.generateMipmaps = false;
      poseTexture.needsUpdate = true;
      const material = createMaterial(atlasTexture, poseTexture, poseBuffer, {
        faceRect: skinRects.head.face,
        eyeBoxes: mobEyeBoxes(style.face),
        eye: style.eye,
        eyeGlow: style.eyeGlow === true,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, ENTITIES.maxMobs);
      mesh.name = `mobs-${definition.id}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      resources.trackTransient(geometry);
      resources.trackTransient(material);
      this._entries.set(definition.id, { definition, geometry, material, mesh, poseBuffer, poseTexture });
    }
  }

  sync(mobs) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    const dt = this._lastSync === null ? 0 : Math.min(0.25, Math.max(0, now - this._lastSync));
    this._lastSync = now;
    const liveAnimatorKeys = new Set();
    let shadowCount = 0;
    for (const [id, entry] of this._entries) {
      counts.set(id, 0);
    }

    for (const mob of mobs) {
      if (!mob.alive || !mob.mobId) continue;
      const entry = this._entries.get(mob.mobId);
      if (!entry) continue;
      const index = counts.get(mob.mobId) ?? 0;
      if (index >= ENTITIES.maxMobs) continue;

      const deathProgress = mob.isDead
        ? 1 - Math.max(0, Math.min(1, mob.deathTimer / 0.65))
        : 0;
      this._position.set(mob.x, mob.y, mob.z);
      // The stock death tells a small creature's story: it topples sideways. At
      // sixty blocks the same rotation would swing the head a hundred blocks and
      // bury it in the terrain, so giants get their collapse from the authored
      // `death` clip instead.
      const deathTilt = entry.definition.giant ? 0 : deathProgress * Math.PI * 0.48;
      this._euler.set(0, mob.facing, -deathTilt, 'YXZ');
      this._quaternion.setFromEuler(this._euler);
      this._scale.setScalar(mob.ageScale ?? 1);
      this._matrix.compose(this._position, this._quaternion, this._scale);
      entry.mesh.setMatrixAt(index, this._matrix);

      // A giant's contact shadow would be a fourteen-block black disc, which
      // reads as a painted circle rather than as ground shadow at that size. Its
      // grounding comes from the fog and the terrain it stands in instead.
      if (shadowCount < ENTITIES.maxMobs && !mob.inLiquid && !entry.definition.giant) {
        const radius = Math.max(.2, (mob.halfSize ?? .35) * 1.18 * (mob.ageScale ?? 1));
        this._position.set(mob.x, mob.y + .018, mob.z);
        this._shadowScale.set(radius, radius, radius);
        this._shadowMatrix.compose(this._position, this._shadowQuaternion, this._shadowScale);
        this.shadowMesh.setMatrixAt(shadowCount++, this._shadowMatrix);
      }

      let objectKey = this._animatorKeys.get(mob);
      if (objectKey === undefined) {
        objectKey = this._nextAnimatorKey++;
        this._animatorKeys.set(mob, objectKey);
      }
      const animatorKey = `${mob.mobId}:${mob.uuid ?? objectKey}`;
      liveAnimatorKeys.add(animatorKey);
      let animator = this._animators.get(animatorKey);
      if (!animator || animator.mobId !== mob.mobId) {
        animator = new MobAnimator(mob.mobId);
        this._animators.set(animatorKey, animator);
      }
      animator.update(dt, {
        speed: Math.hypot(mob.velocityX ?? 0, mob.velocityZ ?? 0),
        isDead: mob.isDead,
        emote: mob.emote ?? null,
        attacking: mob.justAttacked || mob.attackCooldown > 0,
        casting: entry.definition.ranged && mob.attackCooldown > 0,
        onGround: mob.onGround,
        hurt: mob.justHurt || mob.hurtFlash > 0,
        headYaw: mob.headYaw,
      });
      entry.poseBuffer.writeSkeleton(index, animator.skeleton);

      const animation = entry.geometry.getAttribute('aMobAnim');
      animation.setXYZW(
        index,
        Math.min(1, mob.hurtFlash / 0.28),
        mob.isDead ? 0 : 1,
        0,
        0
      );
      counts.set(mob.mobId, index + 1);
    }

    for (const [id, entry] of this._entries) {
      const count = counts.get(id) ?? 0;
      entry.mesh.count = count;
      entry.mesh.visible = count > 0;
      if (count > 0) {
        entry.mesh.instanceMatrix.needsUpdate = true;
        entry.geometry.getAttribute('aMobAnim').needsUpdate = true;
        entry.poseTexture.needsUpdate = entry.poseBuffer.dirty;
        entry.poseBuffer.dirty = false;
      }
    }
    for (const key of this._animators.keys()) {
      if (!liveAnimatorKeys.has(key)) this._animators.delete(key);
    }
    this.shadowMesh.count = shadowCount;
    this.shadowMesh.visible = shadowCount > 0;
    if (shadowCount > 0) this.shadowMesh.instanceMatrix.needsUpdate = true;
  }

  applyLighting(state) {
    const daylight = Number.isFinite(state.daylight)
      ? Math.max(0, Math.min(1, state.daylight))
      : 1;
    const darkness = 1 - daylight;
    // A small floor keeps hides and faces readable after dusk. Without it a
    // creature at midnight is base-colour times an ambient of ~0.05, which reads
    // as an untextured black blob even though the atlas is painted correctly.
    const ambientFloor = 0.02 + 0.11 * darkness;
    for (const { material } of this._entries.values()) {
      const uniforms = material.uniforms;
      uniforms.uSunDirection.value.copy(state.sunDirection);
      uniforms.uSunColor.value.copy(state.sunColor);
      uniforms.uSkyAmbient.value.copy(state.skyAmbient);
      uniforms.uGroundAmbient.value.copy(state.groundAmbient);
      uniforms.uCaveAmbient.value = Math.max(state.caveAmbient, ambientFloor);
      uniforms.uFogColor.value.copy(state.fogColor);
      uniforms.uFogNear.value = state.fogNear;
      uniforms.uFogFar.value = state.fogFar;
      uniforms.uFogStrength.value = state.fogStrength;
      uniforms.uBrightness.value = state.brightness;
      uniforms.uRimBoost.value = 0.09 * darkness;
    }
  }

  clear() {
    for (const { mesh } of this._entries.values()) {
      mesh.count = 0;
      mesh.visible = false;
    }
    this.shadowMesh.count = 0;
    this.shadowMesh.visible = false;
  }

  destroy() {
    this.clear();
    for (const { mesh, geometry, material, poseTexture } of this._entries.values()) {
      this._scene.remove(mesh);
      this._resources.releaseTransient(geometry);
      this._resources.releaseTransient(material);
      mesh.dispose();
      poseTexture.dispose();
    }
    this._entries.clear();
    this._animators.clear();
    this._scene.remove(this.shadowMesh);
    this._resources.releaseTransient(this._shadowGeometry);
    this._resources.releaseTransient(this._shadowMaterial);
    this.shadowMesh.dispose();
  }
}

export default MobRenderer;
