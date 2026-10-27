/**
 * Skeletons and animation clips for every creature.
 *
 * ## What changed and why
 *
 * `MobTypes.js` describes each creature as a flat list of boxes tagged with a
 * `Limb` value, and `MobRenderer` decides what a `Limb.LEG` does. The consequence
 * is visible in-game: a chicken, a cow and a skeleton all walk with the same
 * sine-wave pendulum, because the gait lives in the renderer and there is only
 * one of it.
 *
 * Here the hierarchy and the motion are both data. A cow's plod, a chicken's
 * quick step with a wing flap and the lurker's drifting hover are three different
 * authored clips over three different bone trees, and adding a fourth creature
 * means adding data rather than branching the renderer.
 *
 * ## Bone naming
 *
 * Names are shared across creatures wherever the anatomy matches — every
 * quadruped has `legFrontLeft`, every biped has `armLeft`. That is what lets a
 * generic clip such as `hurt` be authored once and reused, and it is why the
 * self-test can assert that a clip's tracks resolve against its skeleton.
 *
 * All rotations are radians. All distances are blocks.
 */

import { LoopMode } from '../rendering/AnimationController.js';

/** Degrees to radians, for readable authoring below. */
const d = (degrees) => (degrees * Math.PI) / 180;

/**
 * Builds a box attached to a bone.
 * @param {number[]} size `[w, h, d]`
 * @param {number[]} offset Centre relative to the bone pivot.
 * @param {number} [shade]
 */
function box(size, offset, shade = 1) {
  return { size, offset, shade };
}

// --------------------------------------------------------------- body plans

/**
 * A four-legged animal.
 *
 * The body is the root and the legs hang from it, so tilting the body for a
 * gallop carries the legs with it — the thing the old flat list could not do.
 *
 * @param {Object} spec
 */
function quadruped({
  bodyLength = 1.1,
  bodyHeight = 0.7,
  bodyWidth = 0.65,
  bodyY = 0.75,
  headSize = 0.5,
  headForward = 0.72,
  headUp = 0.2,
  legLength = 0.6,
  legThickness = 0.22,
  tail = true,
} = {}) {
  const halfLength = bodyLength * 0.5 - legThickness * 0.6;
  const halfWidth = bodyWidth * 0.5 - legThickness * 0.5;
  const legPivotY = bodyY - bodyHeight * 0.5;

  const bones = [
    {
      name: 'body',
      parent: null,
      pivot: [0, bodyY, 0],
      boxes: [box([bodyWidth, bodyHeight, bodyLength], [0, 0, 0], 1)],
    },
    {
      name: 'head',
      parent: 'body',
      pivot: [0, headUp, headForward],
      boxes: [
        box([headSize, headSize, headSize], [0, 0, headSize * 0.4], 1.08),
        box([headSize * .72, headSize * .42, headSize * .38], [0, -headSize * .08, headSize * .82], 1.15),
        box([headSize * .22, headSize * .28, headSize * .14], [-headSize * .46, headSize * .25, headSize * .38], .92),
        box([headSize * .22, headSize * .28, headSize * .14], [headSize * .46, headSize * .25, headSize * .38], .92),
      ],
    },
  ];

  const legs = [
    ['legFrontLeft', -halfWidth, halfLength],
    ['legFrontRight', halfWidth, halfLength],
    ['legBackLeft', -halfWidth, -halfLength],
    ['legBackRight', halfWidth, -halfLength],
  ];
  for (const [name, x, z] of legs) {
    bones.push({
      name,
      parent: 'body',
      // Pivot at the shoulder, box hanging below it, so rotation swings the leg
      // rather than spinning it about its middle.
      pivot: [x, legPivotY - bodyY, z],
      boxes: [
        box([legThickness, legLength, legThickness], [0, -legLength * 0.5, 0], 0.92),
        box([legThickness * 1.08, legThickness * .3, legThickness * 1.35], [0, -legLength + legThickness * .04, legThickness * .13], .78),
      ],
    });
  }

  if (tail) {
    bones.push({
      name: 'tail',
      parent: 'body',
      pivot: [0, bodyHeight * 0.3, -bodyLength * 0.5],
      boxes: [box([0.12, 0.12, 0.3], [0, 0, -0.15], 0.9)],
    });
  }
  return bones;
}

/**
 * A humanoid. Arms hang from the torso; the head is a separate bone so it can be
 * driven by an additive look-at layer while the body walks.
 */
function biped({
  torsoHeight = 0.75,
  torsoWidth = 0.5,
  torsoDepth = 0.28,
  hipY = 0.75,
  headSize = 0.5,
  armLength = 0.7,
  armThickness = 0.2,
  legLength = 0.75,
  legThickness = 0.2,
} = {}) {
  const torsoY = hipY + torsoHeight * 0.5;
  return [
    {
      name: 'root',
      parent: null,
      pivot: [0, hipY, 0],
      boxes: [],
    },
    {
      name: 'torso',
      parent: 'root',
      pivot: [0, torsoHeight * 0.5, 0],
      boxes: [
        box([torsoWidth, torsoHeight, torsoDepth], [0, 0, 0], 1),
        box([torsoWidth * .72, torsoHeight * .18, torsoDepth * .06], [0, torsoHeight * .18, torsoDepth * .53], 1.12),
      ],
    },
    {
      name: 'head',
      parent: 'torso',
      pivot: [0, torsoHeight * 0.5 + headSize * 0.5, 0],
      boxes: [
        box([headSize, headSize, headSize], [0, 0, 0], 1.08),
        box([headSize * .18, headSize * .2, headSize * .12], [0, -headSize * .04, headSize * .55], 1.16),
      ],
    },
    {
      name: 'armLeft',
      parent: 'torso',
      pivot: [-(torsoWidth * 0.5 + armThickness * 0.5), torsoHeight * 0.5 - armThickness * 0.5, 0],
      boxes: [box([armThickness, armLength, armThickness], [0, -armLength * 0.5, 0], 0.95)],
    },
    {
      name: 'armRight',
      parent: 'torso',
      pivot: [torsoWidth * 0.5 + armThickness * 0.5, torsoHeight * 0.5 - armThickness * 0.5, 0],
      boxes: [box([armThickness, armLength, armThickness], [0, -armLength * 0.5, 0], 0.95)],
    },
    {
      name: 'legLeft',
      parent: 'root',
      pivot: [-legThickness * 0.55, 0, 0],
      boxes: [
        box([legThickness, legLength, legThickness], [0, -legLength * 0.5, 0], 0.9),
        box([legThickness * 1.05, legThickness * .42, legThickness * 1.45], [0, -legLength + legThickness * .08, legThickness * .2], .78),
      ],
    },
    {
      name: 'legRight',
      parent: 'root',
      pivot: [legThickness * 0.55, 0, 0],
      boxes: [
        box([legThickness, legLength, legThickness], [0, -legLength * 0.5, 0], 0.9),
        box([legThickness * 1.05, legThickness * .42, legThickness * 1.45], [0, -legLength + legThickness * .08, legThickness * .2], .78),
      ],
    },
  ];
}

/** A small two-legged bird with wings. */
function bird() {
  return [
    { name: 'body', parent: null, pivot: [0, 0.45, 0], boxes: [box([0.32, 0.34, 0.42], [0, 0, 0], 1)] },
    { name: 'head', parent: 'body', pivot: [0, 0.22, 0.16], boxes: [box([0.26, 0.26, 0.24], [0, 0.05, 0.02], 1.08)] },
    { name: 'beak', parent: 'head', pivot: [0, 0.02, 0.14], boxes: [box([0.1, 0.08, 0.12], [0, 0, 0.06], 1.15)] },
    { name: 'wattle', parent: 'head', pivot: [0, -0.08, 0.12], boxes: [box([0.08, 0.1, 0.04], [0, -0.03, 0], 1.2)] },
    { name: 'wingLeft', parent: 'body', pivot: [-0.17, 0.06, 0], boxes: [box([0.06, 0.24, 0.32], [-0.02, -0.1, 0], 0.95)] },
    { name: 'wingRight', parent: 'body', pivot: [0.17, 0.06, 0], boxes: [box([0.06, 0.24, 0.32], [0.02, -0.1, 0], 0.95)] },
    { name: 'legLeft', parent: 'body', pivot: [-0.09, -0.17, 0], boxes: [box([0.06, 0.28, 0.06], [0, -0.14, 0], 0.85)] },
    { name: 'legRight', parent: 'body', pivot: [0.09, -0.17, 0], boxes: [box([0.06, 0.28, 0.06], [0, -0.14, 0], 0.85)] },
  ];
}

/** A floating creature with no legs. Tentacles trail from the body. */
function floater() {
  const bones = [
    { name: 'body', parent: null, pivot: [0, 1.1, 0], boxes: [box([0.7, 0.7, 0.7], [0, 0, 0], 1)] },
    { name: 'core', parent: 'body', pivot: [0, 0, 0], boxes: [box([0.34, 0.34, 0.34], [0, 0, 0], 1.4)] },
  ];
  const offsets = [
    ['tentacleA', -0.22, -0.22],
    ['tentacleB', 0.22, -0.22],
    ['tentacleC', -0.22, 0.22],
    ['tentacleD', 0.22, 0.22],
  ];
  for (const [name, x, z] of offsets) {
    bones.push({
      name,
      parent: 'body',
      pivot: [x, -0.35, z],
      boxes: [box([0.09, 0.5, 0.09], [0, -0.25, 0], 0.9)],
    });
  }
  return bones;
}

// -------------------------------------------------------------------- clips

/** Two keyframes at the extremes plus a matching end frame, so the loop closes. */
function swing(amplitude, duration, phase = 0) {
  // A four-key cosine approximation. Cheaper to author than a full curve and
  // indistinguishable at these amplitudes.
  const a = phase === 0 ? amplitude : -amplitude;
  return [
    { time: 0, value: [a, 0, 0] },
    { time: duration * 0.25, value: [0, 0, 0] },
    { time: duration * 0.5, value: [-a, 0, 0] },
    { time: duration * 0.75, value: [0, 0, 0] },
    { time: duration, value: [a, 0, 0] },
  ];
}

/** A gentle vertical bob, for idle and hover. */
function bob(amplitude, duration) {
  return [
    { time: 0, value: [0, 0, 0] },
    { time: duration * 0.5, value: [0, amplitude, 0] },
    { time: duration, value: [0, 0, 0] },
  ];
}

/** Walk and run gaits for a quadruped: diagonal pairs move together. */
function quadrupedGaits(amplitude, walkDuration, runAmplitude, runDuration) {
  const gait = (amp, duration) => ({
    legFrontLeft: { rotation: swing(amp, duration, 0) },
    legFrontRight: { rotation: swing(amp, duration, 1) },
    legBackLeft: { rotation: swing(amp, duration, 1) },
    legBackRight: { rotation: swing(amp, duration, 0) },
  });
  return {
    walk: { name: 'walk', duration: walkDuration, loop: LoopMode.LOOP, tracks: gait(amplitude, walkDuration) },
    run: {
      name: 'run',
      duration: runDuration,
      loop: LoopMode.LOOP,
      tracks: {
        ...gait(runAmplitude, runDuration),
        // The body pitches forward and bounces at speed. This is the part a flat
        // limb list cannot express, because the legs must inherit it.
        body: { rotation: [{ time: 0, value: [d(-6), 0, 0] }, { time: runDuration, value: [d(-6), 0, 0] }], position: bob(0.05, runDuration * 0.5) },
      },
    },
  };
}

/** Clips every creature shares. */
function commonClips(rootBone) {
  return {
    hurt: {
      name: 'hurt',
      duration: 0.3,
      loop: LoopMode.CLAMP,
      tracks: {
        [rootBone]: {
          rotation: [
            { time: 0, value: [0, 0, 0] },
            { time: 0.08, value: [d(-12), 0, d(8)] },
            { time: 0.3, value: [0, 0, 0] },
          ],
        },
      },
    },
    death: {
      name: 'death',
      duration: 0.9,
      loop: LoopMode.CLAMP,
      tracks: {
        [rootBone]: {
          rotation: [
            { time: 0, value: [0, 0, 0] },
            { time: 0.9, value: [0, 0, d(90)] },
          ],
          position: [
            { time: 0, value: [0, 0, 0] },
            { time: 0.9, value: [0, -0.35, 0] },
          ],
        },
      },
    },
  };
}

// --------------------------------------------------------------- creatures

/**
 * Skeleton and clip set per mob id.
 *
 * Keys match `MOB_DEFINITIONS[].id`, which the self-test asserts so a creature
 * can never be added to one table and forgotten in the other.
 */
const BASE_MOB_SKELETONS = {
  cow: {
    skeleton: { name: 'cow', scale: 1, bones: quadruped({ bodyLength: 1.2, bodyHeight: 0.75, bodyWidth: 0.7, bodyY: 0.8, headSize: 0.55, legLength: 0.62 }) },
    clips: {
      idle: { name: 'idle', duration: 3.4, loop: LoopMode.LOOP, tracks: { body: { position: bob(0.02, 3.4) }, head: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 1.4, value: [d(18), 0, 0] }, { time: 2.4, value: [d(18), d(9), 0] }, { time: 3.4, value: [0, 0, 0] }] } } },
      ...quadrupedGaits(d(26), 1.1, d(40), 0.62),
      ...commonClips('body'),
    },
  },
  pig: {
    skeleton: { name: 'pig', scale: 1, bones: quadruped({ bodyLength: 1, bodyHeight: 0.6, bodyWidth: 0.6, bodyY: 0.62, headSize: 0.45, headForward: 0.62, legLength: 0.42, legThickness: 0.2 }) },
    clips: {
      idle: { name: 'idle', duration: 2.8, loop: LoopMode.LOOP, tracks: { body: { position: bob(0.018, 2.8) }, tail: { rotation: swing(d(16), 2.8) } } },
      ...quadrupedGaits(d(30), 0.9, d(46), 0.52),
      ...commonClips('body'),
    },
  },
  sheep: {
    skeleton: { name: 'sheep', scale: 1, bones: quadruped({ bodyLength: 1.05, bodyHeight: 0.72, bodyWidth: 0.68, bodyY: 0.78, headSize: 0.46, legLength: 0.56 }) },
    clips: {
      idle: { name: 'idle', duration: 3.1, loop: LoopMode.LOOP, tracks: { body: { position: bob(0.02, 3.1) }, head: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 1.2, value: [d(26), 0, 0] }, { time: 2.2, value: [d(26), 0, 0] }, { time: 3.1, value: [0, 0, 0] }] } } },
      ...quadrupedGaits(d(24), 1.15, d(38), 0.66),
      ...commonClips('body'),
    },
  },
  chicken: {
    skeleton: { name: 'chicken', scale: 1, bones: bird() },
    clips: {
      idle: {
        name: 'idle',
        duration: 2.2,
        loop: LoopMode.LOOP,
        tracks: {
          head: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.6, value: [0, d(-32), 0] }, { time: 1.3, value: [0, d(28), 0] }, { time: 2.2, value: [0, 0, 0] }] },
          wattle: { rotation: swing(d(9), 2.2) },
        },
      },
      // Chickens step fast and short, and the head bobs against the body.
      walk: { name: 'walk', duration: 0.5, loop: LoopMode.LOOP, tracks: { legLeft: { rotation: swing(d(34), 0.5, 0) }, legRight: { rotation: swing(d(34), 0.5, 1) }, body: { position: bob(0.03, 0.25) } } },
      run: { name: 'run', duration: 0.32, loop: LoopMode.LOOP, tracks: { legLeft: { rotation: swing(d(46), 0.32, 0) }, legRight: { rotation: swing(d(46), 0.32, 1) }, wingLeft: { rotation: swing(d(30), 0.16, 0) }, wingRight: { rotation: swing(d(30), 0.16, 1) }, body: { position: bob(0.05, 0.16) } } },
      // Played while falling: the flap is what makes a chicken's slow descent read
      // as deliberate rather than as a physics bug.
      flap: { name: 'flap', duration: 0.24, loop: LoopMode.LOOP, tracks: { wingLeft: { rotation: [{ time: 0, value: [0, 0, d(-8)] }, { time: 0.12, value: [0, 0, d(-72)] }, { time: 0.24, value: [0, 0, d(-8)] }] }, wingRight: { rotation: [{ time: 0, value: [0, 0, d(8)] }, { time: 0.12, value: [0, 0, d(72)] }, { time: 0.24, value: [0, 0, d(8)] }] } } },
      ...commonClips('body'),
    },
  },
  husk: {
    skeleton: { name: 'husk', scale: 1, bones: biped({ hipY: 0.78, torsoHeight: 0.78 }) },
    clips: {
      idle: { name: 'idle', duration: 3.6, loop: LoopMode.LOOP, tracks: { torso: { rotation: swing(d(2.5), 3.6) }, armLeft: { rotation: swing(d(4), 3.6, 0) }, armRight: { rotation: swing(d(4), 3.6, 1) } } },
      // Arms held forward: the classic shambling pose, authored rather than coded.
      walk: { name: 'walk', duration: 1, loop: LoopMode.LOOP, tracks: { legLeft: { rotation: swing(d(30), 1, 0) }, legRight: { rotation: swing(d(30), 1, 1) }, armLeft: { rotation: [{ time: 0, value: [d(-82), 0, 0] }, { time: 0.5, value: [d(-88), 0, 0] }, { time: 1, value: [d(-82), 0, 0] }] }, armRight: { rotation: [{ time: 0, value: [d(-88), 0, 0] }, { time: 0.5, value: [d(-82), 0, 0] }, { time: 1, value: [d(-88), 0, 0] }] } } },
      run: { name: 'run', duration: 0.62, loop: LoopMode.LOOP, tracks: { legLeft: { rotation: swing(d(48), 0.62, 0) }, legRight: { rotation: swing(d(48), 0.62, 1) }, armLeft: { rotation: [{ time: 0, value: [d(-78), 0, 0] }, { time: 0.31, value: [d(-95), 0, 0] }, { time: 0.62, value: [d(-78), 0, 0] }] }, armRight: { rotation: [{ time: 0, value: [d(-95), 0, 0] }, { time: 0.31, value: [d(-78), 0, 0] }, { time: 0.62, value: [d(-95), 0, 0] }] }, torso: { rotation: [{ time: 0, value: [d(-9), 0, 0] }, { time: 0.62, value: [d(-9), 0, 0] }] } } },
      attack: { name: 'attack', duration: 0.44, loop: LoopMode.CLAMP, tracks: { armLeft: { rotation: [{ time: 0, value: [d(-82), 0, 0] }, { time: 0.14, value: [d(-140), 0, 0] }, { time: 0.28, value: [d(-30), 0, 0] }, { time: 0.44, value: [d(-82), 0, 0] }] }, armRight: { rotation: [{ time: 0, value: [d(-82), 0, 0] }, { time: 0.14, value: [d(-140), 0, 0] }, { time: 0.28, value: [d(-30), 0, 0] }, { time: 0.44, value: [d(-82), 0, 0] }] }, torso: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.14, value: [d(-14), 0, 0] }, { time: 0.44, value: [0, 0, 0] }] } } },
      ...commonClips('root'),
    },
  },
  bonecaster: {
    skeleton: { name: 'bonecaster', scale: 1, bones: biped({ hipY: 0.8, torsoHeight: 0.76, armThickness: 0.16, legThickness: 0.16 }) },
    clips: {
      idle: { name: 'idle', duration: 3.2, loop: LoopMode.LOOP, tracks: { torso: { rotation: swing(d(2), 3.2) }, head: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 1.6, value: [0, d(-14), 0] }, { time: 3.2, value: [0, 0, 0] }] } } },
      walk: { name: 'walk', duration: 0.9, loop: LoopMode.LOOP, tracks: { legLeft: { rotation: swing(d(32), 0.9, 0) }, legRight: { rotation: swing(d(32), 0.9, 1) }, armLeft: { rotation: swing(d(24), 0.9, 1) }, armRight: { rotation: swing(d(24), 0.9, 0) } } },
      run: { name: 'run', duration: 0.56, loop: LoopMode.LOOP, tracks: { legLeft: { rotation: swing(d(50), 0.56, 0) }, legRight: { rotation: swing(d(50), 0.56, 1) }, armLeft: { rotation: swing(d(38), 0.56, 1) }, armRight: { rotation: swing(d(38), 0.56, 0) } } },
      // A ranged wind-up: both arms raise and hold, so the player gets a read on
      // the incoming shot. Clamped, because the AI holds the pose until release.
      cast: { name: 'cast', duration: 0.7, loop: LoopMode.CLAMP, tracks: { armLeft: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.25, value: [d(-100), 0, d(-18)] }, { time: 0.7, value: [d(-92), 0, d(-10)] }] }, armRight: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.25, value: [d(-100), 0, d(18)] }, { time: 0.7, value: [d(-92), 0, d(10)] }] }, head: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.7, value: [d(-10), 0, 0] }] } } },
      attack: { name: 'attack', duration: 0.4, loop: LoopMode.CLAMP, tracks: { armRight: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.12, value: [d(-135), 0, 0] }, { time: 0.26, value: [d(-20), 0, 0] }, { time: 0.4, value: [0, 0, 0] }] } } },
      ...commonClips('root'),
    },
  },
  lurker: {
    skeleton: { name: 'lurker', scale: 1, bones: floater() },
    clips: {
      // A floater has no gait, so idle and walk are the same hover at different
      // rates. Keeping both names means the state machine does not special-case it.
      idle: { name: 'idle', duration: 3.8, loop: LoopMode.LOOP, tracks: { body: { position: bob(0.09, 3.8), rotation: swing(d(4), 3.8) }, tentacleA: { rotation: swing(d(11), 3.8, 0) }, tentacleB: { rotation: swing(d(11), 3.8, 1) }, tentacleC: { rotation: swing(d(11), 3.8, 1) }, tentacleD: { rotation: swing(d(11), 3.8, 0) } } },
      walk: { name: 'walk', duration: 2.2, loop: LoopMode.LOOP, tracks: { body: { position: bob(0.13, 2.2), rotation: swing(d(7), 2.2) }, tentacleA: { rotation: swing(d(20), 2.2, 0) }, tentacleB: { rotation: swing(d(20), 2.2, 1) }, tentacleC: { rotation: swing(d(20), 2.2, 1) }, tentacleD: { rotation: swing(d(20), 2.2, 0) } } },
      run: { name: 'run', duration: 1.2, loop: LoopMode.LOOP, tracks: { body: { position: bob(0.16, 1.2), rotation: swing(d(12), 1.2) }, tentacleA: { rotation: swing(d(34), 1.2, 0) }, tentacleB: { rotation: swing(d(34), 1.2, 1) }, tentacleC: { rotation: swing(d(34), 1.2, 1) }, tentacleD: { rotation: swing(d(34), 1.2, 0) } } },
      // Tentacles flare and the core flashes forward as it lunges.
      attack: { name: 'attack', duration: 0.5, loop: LoopMode.CLAMP, tracks: { body: { position: [{ time: 0, value: [0, 0, 0] }, { time: 0.16, value: [0, 0, 0.28] }, { time: 0.5, value: [0, 0, 0] }] }, tentacleA: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.16, value: [d(-46), 0, 0] }, { time: 0.5, value: [0, 0, 0] }] }, tentacleB: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.16, value: [d(-46), 0, 0] }, { time: 0.5, value: [0, 0, 0] }] }, tentacleC: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.16, value: [d(46), 0, 0] }, { time: 0.5, value: [0, 0, 0] }] }, tentacleD: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.16, value: [d(46), 0, 0] }, { time: 0.5, value: [0, 0, 0] }] } } },
      ...commonClips('body'),
    },
  },
  // -------------------------------------------------- horror roster rigs
  // The three roles are readable by silhouette alone: a lanky shambler, a long
  // low predator, and a too-tall watcher with hands that hang past its knees.
  walker: {
    skeleton: {
      name: 'walker',
      scale: 1,
      bones: biped({
        hipY: 0.92,
        torsoHeight: 0.82,
        torsoWidth: 0.42,
        torsoDepth: 0.26,
        headSize: 0.44,
        armLength: 1.05,
        armThickness: 0.13,
        legLength: 1,
        legThickness: 0.15,
      }),
    },
    clips: {
      idle: { name: 'idle', duration: 4.2, loop: LoopMode.LOOP, tracks: {
        torso: { rotation: swing(d(2.2), 4.2, 1) },
        armLeft: { rotation: [{ time: 0, value: [d(-6), 0, 0] }, { time: 2.1, value: [d(-11), 0, 0] }, { time: 4.2, value: [d(-6), 0, 0] }] },
        armRight: { rotation: [{ time: 0, value: [d(-9), 0, 0] }, { time: 2.1, value: [d(-4), 0, 0] }, { time: 4.2, value: [d(-9), 0, 0] }] },
        head: { rotation: [{ time: 0, value: [d(6), 0, 0] }, { time: 1.4, value: [d(2), d(18), 0] }, { time: 2.8, value: [d(7), d(-12), 0] }, { time: 4.2, value: [d(6), 0, 0] }] },
      } },
      walk: { name: 'walk', duration: 1.45, loop: LoopMode.LOOP, tracks: {
        legLeft: { rotation: swing(d(24), 1.45, 0) },
        legRight: { rotation: swing(d(24), 1.45, 1) },
        armLeft: { rotation: [{ time: 0, value: [d(-64), 0, d(-4)] }, { time: 0.72, value: [d(-72), 0, d(-2)] }, { time: 1.45, value: [d(-64), 0, d(-4)] }] },
        armRight: { rotation: [{ time: 0, value: [d(-70), 0, d(4)] }, { time: 0.72, value: [d(-62), 0, d(2)] }, { time: 1.45, value: [d(-70), 0, d(4)] }] },
        torso: { rotation: [{ time: 0, value: [d(-4), 0, 0] }, { time: 1.45, value: [d(-4), 0, 0] }] },
      } },
      run: { name: 'run', duration: 0.82, loop: LoopMode.LOOP, tracks: {
        legLeft: { rotation: swing(d(40), 0.82, 0) },
        legRight: { rotation: swing(d(40), 0.82, 1) },
        armLeft: { rotation: swing(d(26), 0.82, 1) },
        armRight: { rotation: swing(d(26), 0.82, 0) },
        torso: { rotation: [{ time: 0, value: [d(-11), 0, 0] }, { time: 0.82, value: [d(-11), 0, 0] }] },
      } },
      attack: { name: 'attack', duration: 0.72, loop: LoopMode.CLAMP, tracks: {
        armLeft: { rotation: [{ time: 0, value: [d(-64), 0, 0] }, { time: 0.18, value: [d(-150), 0, d(-10)] }, { time: 0.4, value: [d(-18), 0, 0] }, { time: 0.72, value: [d(-64), 0, 0] }] },
        armRight: { rotation: [{ time: 0, value: [d(-70), 0, 0] }, { time: 0.18, value: [d(-140), 0, d(10)] }, { time: 0.4, value: [d(-14), 0, 0] }, { time: 0.72, value: [d(-70), 0, 0] }] },
        torso: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.18, value: [d(-16), 0, 0] }, { time: 0.72, value: [0, 0, 0] }] },
      } },
      ...commonClips('root'),
    },
  },
  hunter: {
    skeleton: {
      name: 'hunter',
      scale: 1,
      bones: quadruped({
        bodyLength: 1.5,
        bodyHeight: 0.52,
        bodyWidth: 0.48,
        bodyY: 0.82,
        headSize: 0.44,
        headForward: 0.98,
        headUp: 0.14,
        legLength: 0.82,
        legThickness: 0.14,
        tail: true,
      }),
    },
    clips: {
      idle: { name: 'idle', duration: 2.6, loop: LoopMode.LOOP, tracks: {
        body: { position: bob(0.02, 2.6) },
        head: { rotation: [{ time: 0, value: [d(-4), 0, 0] }, { time: 1.3, value: [d(4), d(14), 0] }, { time: 2.6, value: [d(-4), 0, 0] }] },
      } },
      // Low, long strides rather than a trot: the silhouette should read as
      // something that runs on four legs and closes distance fast.
      ...quadrupedGaits(d(34), 0.58, d(52), 0.34),
      attack: { name: 'attack', duration: 0.5, loop: LoopMode.CLAMP, tracks: {
        head: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.14, value: [d(26), 0, 0] }, { time: 0.3, value: [d(-16), 0, 0] }, { time: 0.5, value: [0, 0, 0] }] },
        body: { position: [{ time: 0, value: [0, 0, 0] }, { time: 0.14, value: [0, 0.04, 0.16] }, { time: 0.5, value: [0, 0, 0] }] },
      } },
      ...commonClips('body'),
    },
  },
  stalker: {
    skeleton: {
      name: 'stalker',
      scale: 1,
      bones: biped({
        hipY: 1.02,
        torsoHeight: 0.96,
        torsoWidth: 0.3,
        torsoDepth: 0.22,
        headSize: 0.38,
        armLength: 1.28,
        armThickness: 0.09,
        legLength: 1.16,
        legThickness: 0.1,
      }),
    },
    clips: {
      // Almost no motion: a standing figure that only tilts its head. The lack of
      // idle animation is the point — it looks like it is waiting for you.
      idle: { name: 'idle', duration: 5.4, loop: LoopMode.LOOP, tracks: {
        head: { rotation: [{ time: 0, value: [d(4), 0, 0] }, { time: 1.8, value: [d(2), d(22), d(3)] }, { time: 3.6, value: [d(6), d(-16), d(-2)] }, { time: 5.4, value: [d(4), 0, 0] }] },
        armLeft: { rotation: [{ time: 0, value: [d(-3), 0, d(-2)] }, { time: 5.4, value: [d(-3), 0, d(-2)] }] },
      } },
      walk: { name: 'walk', duration: 1.7, loop: LoopMode.LOOP, tracks: {
        legLeft: { rotation: swing(d(19), 1.7, 0) },
        legRight: { rotation: swing(d(19), 1.7, 1) },
        armLeft: { rotation: swing(d(8), 1.7, 1) },
        armRight: { rotation: swing(d(8), 1.7, 0) },
      } },
      run: { name: 'run', duration: 0.7, loop: LoopMode.LOOP, tracks: {
        legLeft: { rotation: swing(d(44), 0.7, 0) },
        legRight: { rotation: swing(d(44), 0.7, 1) },
        armLeft: { rotation: swing(d(30), 0.7, 1) },
        armRight: { rotation: swing(d(30), 0.7, 0) },
        torso: { rotation: [{ time: 0, value: [d(-14), 0, 0] }, { time: 0.7, value: [d(-14), 0, 0] }] },
      } },
      attack: { name: 'attack', duration: 0.6, loop: LoopMode.CLAMP, tracks: {
        armRight: { rotation: [{ time: 0, value: [0, 0, 0] }, { time: 0.16, value: [d(-120), 0, 0] }, { time: 0.6, value: [0, 0, 0] }] },
      } },
      ...commonClips('root'),
    },
  },
  // Dedicated final-boss rig: articulated neck, independent wings and a
  // three-segment tail. This is intentionally not an alias to a biped.
  ender_dragon: {
    skeleton: {
      name: 'ender_dragon', scale: 1,
      bones: [
        { name:'body', parent:null, pivot:[0,2.4,0], boxes:[box([3.2,1.5,5.2],[0,0,0],1)] },
        { name:'neckA', parent:'body', pivot:[0,0.15,2.55], boxes:[box([1.25,1.1,1.8],[0,0,0.8],.98)] },
        { name:'neckB', parent:'neckA', pivot:[0,0,1.55], boxes:[box([1.05,.95,1.55],[0,0,.7],1)] },
        { name:'head', parent:'neckB', pivot:[0,0,1.35], boxes:[box([1.7,1.35,2],[0,0,.8],1.08)] },
        { name:'jaw', parent:'head', pivot:[0,-.45,.75], boxes:[box([1.45,.35,1.5],[0,0,.55],.86)] },
        { name:'wingLeft', parent:'body', pivot:[-1.55,.35,.35], boxes:[box([6.2,.18,2.5],[-2.8,0,.2],.86)] },
        { name:'wingRight', parent:'body', pivot:[1.55,.35,.35], boxes:[box([6.2,.18,2.5],[2.8,0,.2],.86)] },
        { name:'tailA', parent:'body', pivot:[0,0,-2.55], boxes:[box([1.25,1.05,2.2],[0,0,-1],.94)] },
        { name:'tailB', parent:'tailA', pivot:[0,0,-2], boxes:[box([.95,.8,2.1],[0,0,-1],.9)] },
        { name:'tailC', parent:'tailB', pivot:[0,0,-1.9], boxes:[box([.55,.5,2.4],[0,0,-1.1],.84)] },
      ],
    },
    clips: {
      idle: { name:'idle', duration:2.4, loop:LoopMode.LOOP, tracks:{
        body:{position:bob(.18,2.4)}, wingLeft:{rotation:swing(d(16),2.4)},
        wingRight:{rotation:swing(d(-16),2.4)}, tailA:{rotation:swing(d(8),2.4)},
      } },
      walk: { name:'walk', duration:1.2, loop:LoopMode.LOOP, tracks:{
        wingLeft:{rotation:swing(d(34),1.2)}, wingRight:{rotation:swing(d(-34),1.2)},
        tailA:{rotation:swing(d(12),1.2)}, tailB:{rotation:swing(d(15),1.2,1)},
        tailC:{rotation:swing(d(18),1.2)},
      } },
      run: { name:'run', duration:.58, loop:LoopMode.LOOP, tracks:{
        wingLeft:{rotation:swing(d(58),.58)}, wingRight:{rotation:swing(d(-58),.58)},
        body:{position:bob(.28,.58)}, tailA:{rotation:swing(d(18),.58)},
        tailB:{rotation:swing(d(24),.58,1)}, tailC:{rotation:swing(d(30),.58)},
      } },
      attack: { name:'attack', duration:.8, loop:LoopMode.CLAMP, tracks:{
        neckA:{rotation:[{time:0,value:[0,0,0]},{time:.28,value:[d(-28),0,0]},{time:.8,value:[0,0,0]}]},
        jaw:{rotation:[{time:0,value:[0,0,0]},{time:.25,value:[d(38),0,0]},{time:.8,value:[0,0,0]}]},
      } },
      cast: { name:'cast', duration:1.1, loop:LoopMode.CLAMP, tracks:{
        jaw:{rotation:[{time:0,value:[0,0,0]},{time:.3,value:[d(32),0,0]},{time:1.1,value:[d(32),0,0]}]},
        neckB:{rotation:[{time:0,value:[0,0,0]},{time:.3,value:[d(18),0,0]},{time:1.1,value:[d(18),0,0]}]},
      } },
      ...commonClips('body'),
    },
  },
};

// The expanded Phase 2 roster reuses the proven body-plan rigs. Each entry has
// its own registry key while sharing immutable authored clips with the closest
// anatomy; this keeps every live creature on the skeletal animation path.
const RIG_ALIASES = Object.freeze({
  horse: 'cow', donkey: 'cow', llama: 'cow', ravager: 'cow', iron_golem: 'husk',
  rabbit: 'pig', fox: 'pig', wolf: 'pig', cat: 'pig', turtle: 'pig', goat: 'sheep', frog: 'pig',
  bat: 'chicken', bee: 'chicken',
  squid: 'lurker', axolotl: 'lurker', guardian: 'lurker', spider: 'lurker', slime: 'lurker',
  zombie: 'husk', drowned: 'husk', creeper: 'husk', villager: 'husk',
  skeleton: 'bonecaster', witch: 'bonecaster', pillager: 'bonecaster',
  // Phase 4 Nether roster. Same reasoning as above: each creature gets its own
  // registry key while sharing the authored clips of the closest anatomy, so
  // every Nether mob animates through the skeletal path from the first frame.
  zombified_piglin: 'husk', piglin: 'husk', hoglin: 'cow', strider: 'pig',
  wither_skeleton: 'bonecaster', blaze: 'lurker', ghast: 'lurker', magma_cube: 'lurker',
  // The Wither is a floating torso with three heads, but its limb hierarchy is
  // still bipedal, so the husk rig drives it correctly.
  wither: 'husk',
  // Phase 5. Long limbs, but still a biped hierarchy.
  enderman: 'husk',
  silverfish: 'lurker',
  shulker: 'lurker',
});

export const MOB_SKELETONS = Object.freeze({
  ...BASE_MOB_SKELETONS,
  ...Object.fromEntries(Object.entries(RIG_ALIASES).map(([id, source]) => {
    const rig = BASE_MOB_SKELETONS[source];
    return [id, Object.freeze({
      skeleton: Object.freeze({ ...rig.skeleton, name: id }),
      clips: rig.clips,
    })];
  })),
});

/**
 * The additive look-at layer, shared by everything with a `head` bone.
 *
 * Authored as a clip so it composes through the same path as everything else;
 * the AI drives it by setting the layer weight and sampling at a time derived
 * from the yaw to the target, rather than by writing the bone directly.
 */
export const HEAD_TRACK_CLIP = Object.freeze({
  name: 'headTrack',
  duration: 1,
  loop: LoopMode.CLAMP,
  tracks: {
    head: {
      rotation: [
        { time: 0, value: [0, d(-70), 0] },
        { time: 0.5, value: [0, 0, 0] },
        { time: 1, value: [0, d(70), 0] },
      ],
    },
  },
});

/** Every clip name the animation state machine may request. */
export const CLIP_NAMES = Object.freeze(['idle', 'walk', 'run', 'attack', 'cast', 'flap', 'hurt', 'death']);

/** Clips every creature must define, whatever its body plan. */
export const REQUIRED_CLIPS = Object.freeze(['idle', 'walk', 'run', 'hurt', 'death']);

/**
 * @param {string} mobId
 * @returns {Object|null}
 */
export function getMobSkeleton(mobId) {
  return MOB_SKELETONS[mobId] ?? null;
}

/**
 * Picks the clip for a movement state.
 *
 * Falls back down the chain rather than returning null: a creature without a
 * `run` clip should walk quickly, not freeze.
 *
 * @param {string} mobId
 * @param {string} desired A `CLIP_NAMES` entry.
 * @returns {string|null}
 */
export function resolveClip(mobId, desired) {
  const entry = MOB_SKELETONS[mobId];
  if (!entry) return null;
  const clips = entry.clips;
  if (clips[desired]) return desired;
  const fallbacks = { run: 'walk', flap: 'idle', cast: 'attack', attack: 'idle', walk: 'idle' };
  let cursor = fallbacks[desired];
  let guard = 0;
  while (cursor && guard++ < 8) {
    if (clips[cursor]) return cursor;
    cursor = fallbacks[cursor];
  }
  return clips.idle ? 'idle' : null;
}

export default MOB_SKELETONS;
