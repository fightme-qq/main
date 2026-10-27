/**
 * Optional post-processing chain.
 *
 * Order matters and is fixed: scene render, then bloom, then FXAA, then the
 * grade/vignette, then `OutputPass`. `OutputPass` must be last because it is
 * what applies tone mapping and the sRGB transfer — Three deliberately skips
 * both in materials when rendering into a render target, so without it the image
 * comes out washed out and linear.
 *
 * The whole chain is optional. When every effect is disabled the composer is not
 * created at all and `Renderer` draws straight to the canvas, which is one fewer
 * full-screen buffer and one fewer full-screen blit — a real saving on mobile,
 * not a theoretical one.
 *
 * Rebuilding is destructive by design: a settings change disposes the old
 * composer and its render targets rather than trying to patch the pass list,
 * because a half-mutated composer is far harder to reason about than a fresh one.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';

import { clamp } from '../utils/MathUtils.js';

/**
 * Vignette and final grade.
 *
 * Kept as one pass rather than two: both are a couple of instructions, and a
 * separate pass would mean another full-screen read/write for no benefit.
 */
const GradeShader = {
  name: 'VoxelGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uVignetteStrength: { value: 0.35 },
    uVignetteRadius: { value: 0.78 },
    uContrast: { value: 1.0 },
    uUnderwater: { value: 0.0 },
    uUnderwaterColor: { value: new THREE.Color(0.06, 0.28, 0.42) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignetteStrength;
    uniform float uVignetteRadius;
    uniform float uContrast;
    uniform float uUnderwater;
    uniform vec3 uUnderwaterColor;
    varying vec2 vUv;

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      // Contrast around mid grey.
      color.rgb = (color.rgb - 0.5) * uContrast + 0.5;

      // Underwater tint applied here as well as in the CSS overlay, so it is
      // present in the rendered image itself and survives a screenshot.
      color.rgb = mix(color.rgb, color.rgb * uUnderwaterColor * 2.4, uUnderwater * 0.55);

      if (uVignetteStrength > 0.001) {
        vec2 centred = vUv - 0.5;
        float distance = length(centred) * 1.4142;
        float vignette = smoothstep(uVignetteRadius, 1.0, distance);
        color.rgb *= 1.0 - vignette * uVignetteStrength;
      }

      gl_FragColor = color;
    }
  `,
};

export class PostProcessing {
  /**
   * @param {Object} options
   * @param {THREE.WebGLRenderer} options.renderer
   * @param {THREE.Scene} options.scene
   * @param {THREE.Camera} options.camera
   * @param {import('../core/SettingsManager.js').SettingsManager} options.settings
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} options.capabilities
   */
  constructor({ renderer, scene, camera, settings, capabilities }) {
    this._renderer = renderer;
    this._scene = scene;
    this._camera = camera;
    this._settings = settings;
    this._caps = capabilities;

    /** @type {EffectComposer|null} */
    this._composer = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._renderTarget = null;
    /** @type {UnrealBloomPass|null} */
    this._bloomPass = null;
    /** @type {SSAOPass|null} */
    this._ssaoPass = null;
    /** @type {FXAAPass|null} */
    this._fxaaPass = null;
    /** @type {ShaderPass|null} */
    this._gradePass = null;
    /** @type {RenderPass|null} */
    this._renderPass = null;
    /** @type {OutputPass|null} */
    this._outputPass = null;

    this._width = 1;
    this._height = 1;
    this._pixelRatio = 1;
    // Integer device-pixel size, derived in `setSize`. Every buffer in the chain
    // is created at this size.
    this._deviceWidth = 1;
    this._deviceHeight = 1;
    this._failed = false;

    this.rebuild();
  }

  /** True when the composer is active and should be used to draw. */
  get enabled() {
    return this._composer !== null;
  }

  /** True when composer construction failed and we fell back to direct render. */
  get failed() {
    return this._failed;
  }

  /** Number of passes in the chain, for the debug overlay. */
  get passCount() {
    return this._composer ? this._composer.passes.length : 0;
  }

  /**
   * Rebuilds the chain from the current settings.
   * Safe to call repeatedly; the previous chain is disposed first.
   */
  rebuild() {
    this.dispose();

    const graphics = this._settings.values.graphics;
    const wantBloom = Boolean(graphics.bloom) && this._caps.highpFragment;
    const wantSsao = Boolean(graphics.screenSpaceAmbientOcclusion) && this._caps.webglVersion === 2;
    const wantFxaa = Boolean(graphics.fxaa);
    const wantGrade = Boolean(graphics.vignette);

    if (!wantBloom && !wantSsao && !wantFxaa && !wantGrade) return;

    try {
      // MSAA has to be requested on the composer's own target: the canvas-level
      // `antialias` flag does nothing once we render into a buffer.
      const samples = graphics.antialias && this._caps.webglVersion === 2 ? 4 : 0;
      const target = new THREE.WebGLRenderTarget(
        this._deviceWidth,
        this._deviceHeight,
        {
          type: THREE.HalfFloatType,
          samples,
          depthBuffer: true,
          stencilBuffer: false,
          // Linear working space; `OutputPass` performs the sRGB conversion.
          colorSpace: THREE.LinearSRGBColorSpace,
        }
      );

      const composer = new EffectComposer(this._renderer, target);
      // Pixel ratio pinned to 1: this class does its own rounding, see `setSize`.
      composer.setPixelRatio(1);
      composer.setSize(this._deviceWidth, this._deviceHeight);

      this._renderPass = new RenderPass(this._scene, this._camera);
      composer.addPass(this._renderPass);

      if (wantSsao) {
        this._ssaoPass = new SSAOPass(
          this._scene, this._camera, this._deviceWidth, this._deviceHeight
        );
        this._ssaoPass.kernelRadius = 8;
        this._ssaoPass.minDistance = 0.002;
        this._ssaoPass.maxDistance = 0.085;
        composer.addPass(this._ssaoPass);
      }

      if (wantBloom) {
        this._bloomPass = new UnrealBloomPass(
          new THREE.Vector2(this._deviceWidth, this._deviceHeight),
          0.32, // strength: subtle. Voxel art turns to mush with strong bloom.
          0.5, // radius
          0.86 // threshold: only genuinely bright pixels (sun, glowstone)
        );
        composer.addPass(this._bloomPass);
      }

      if (wantFxaa) {
        this._fxaaPass = new FXAAPass();
        composer.addPass(this._fxaaPass);
      }

      if (wantGrade) {
        this._gradePass = new ShaderPass(GradeShader);
        composer.addPass(this._gradePass);
      }

      this._outputPass = new OutputPass();
      composer.addPass(this._outputPass);

      this._renderTarget = target;
      this._composer = composer;
      this._failed = false;
    } catch (error) {
      // A composer that cannot be built must never take the game down with it.
      console.warn('[PostProcessing] disabled after a construction failure:', error);
      this._failed = true;
      this.dispose();
    }
  }

  /**
   * Resizes the chain.
   *
   * The composer is driven in **integer device pixels** with its own pixel ratio
   * pinned to 1, rather than being handed CSS pixels plus a fractional ratio.
   * `EffectComposer.setSize` multiplies the two without rounding, so a scaled
   * resolution such as `800 x 0.616` produces a 492.8-pixel-wide render target —
   * a non-integer size is undefined for a framebuffer and yields a target that
   * reads back as empty. Rounding here keeps every buffer in the chain valid at
   * any resolution scale.
   *
   * @param {number} width CSS pixels.
   * @param {number} height CSS pixels.
   * @param {number} pixelRatio Effective device pixel ratio (including scale).
   */
  setSize(width, height, pixelRatio) {
    this._width = Math.max(1, Math.round(width));
    this._height = Math.max(1, Math.round(height));
    this._pixelRatio = Math.max(0.1, pixelRatio);
    this._deviceWidth = Math.max(1, Math.round(this._width * this._pixelRatio));
    this._deviceHeight = Math.max(1, Math.round(this._height * this._pixelRatio));

    if (!this._composer) return;
    this._composer.setPixelRatio(1);
    this._composer.setSize(this._deviceWidth, this._deviceHeight);
    if (this._bloomPass) {
      this._bloomPass.resolution.set(this._deviceWidth, this._deviceHeight);
    }
    this._ssaoPass?.setSize(this._deviceWidth, this._deviceHeight);
  }

  /**
   * Updates per-frame uniforms.
   * @param {Object} state
   * @param {number} state.underwater 0..1 submersion amount.
   * @param {number} [state.darkness] 0 by day, 1 in full night.
   */
  updateUniforms(state) {
    if (!this._gradePass) return;
    const graphics = this._settings.values.graphics;
    const uniforms = this._gradePass.uniforms;
    const darkness = clamp(state.darkness ?? 0, 0, 1);
    // The vignette is part of the horror pacing: a slim frame by day, a closed-in
    // one at night. It is still one uniform change, no extra pass.
    uniforms.uVignetteStrength.value = graphics.vignette ? 0.3 + darkness * 0.24 : 0;
    uniforms.uVignetteRadius.value = 0.82 - darkness * 0.08;
    uniforms.uContrast.value = clamp(0.94 + graphics.colorGrading * 0.06, 0.8, 1.2);
    uniforms.uUnderwater.value = clamp(state.underwater ?? 0, 0, 1);
  }

  /**
   * Draws the scene through the composer.
   * @param {number} dt
   * @returns {boolean} False when there is no composer and the caller must draw.
   */
  render(dt) {
    if (!this._composer) return false;
    this._composer.render(dt);
    return true;
  }

  /** Points the chain at a new camera (after a perspective change). */
  setCamera(camera) {
    this._camera = camera;
    if (this._renderPass) this._renderPass.camera = camera;
  }

  /** Disposes every pass and render target. */
  dispose() {
    if (this._composer) {
      for (const pass of this._composer.passes) {
        if (typeof pass.dispose === 'function') {
          try {
            pass.dispose();
          } catch {
            /* a pass that cannot dispose must not block the rest */
          }
        }
      }
      this._composer.passes.length = 0;
      // The composer owns two ping-pong targets derived from ours.
      try {
        this._composer.renderTarget1?.dispose();
        this._composer.renderTarget2?.dispose();
      } catch {
        /* ignore */
      }
      this._composer = null;
    }
    if (this._renderTarget) {
      this._renderTarget.dispose();
      this._renderTarget = null;
    }
    this._bloomPass = null;
    this._ssaoPass = null;
    this._fxaaPass = null;
    this._gradePass = null;
    this._renderPass = null;
    this._outputPass = null;
  }
}

export default PostProcessing;
