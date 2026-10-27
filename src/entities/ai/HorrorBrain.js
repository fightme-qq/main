/**
 * The horror roster's decision layer.
 *
 * ## Why a separate brain
 *
 * `ai/MobBrain.js` is a compact "notice, run, swing" machine that is correct for a
 * zombie or a spider. The three horror roles are defined by *pacing*: a walker that
 * waits and then does not stop, a hunter that reacts instantly and punishes running,
 * a stalker that must never behave like a normal enemy. Expressing that inside the
 * generic brain would mean three `if (definition.id === ...)` branches in code every
 * creature shares.
 *
 * ## States
 *
 * ```
 * idle -> roam -> investigate -> detect -> chase -> attack
 *                                  |         |
 *                                  +-> search +-> retreat -> roam
 * ```
 *
 * Plus `observe` for the stalker's "it is standing there, looking at me" state.
 *
 * ## Purity
 *
 * No world access, no Three.js: the caller passes distance, visibility, the
 * player's look vector and the loudest nearby noise. That keeps the awkward parts
 * (lost target, search timeout, stalker eye contact) testable in Node.
 */

/** Decision states. Kept as strings so they read well in the debug overlay. */
export const HorrorState = Object.freeze({
  IDLE: 'idle',
  ROAM: 'roam',
  INVESTIGATE: 'investigate',
  DETECT: 'detect',
  CHASE: 'chase',
  ATTACK: 'attack',
  SEARCH: 'search',
  RETREAT: 'retreat',
  OBSERVE: 'observe',
});

/**
 * Per-role tuning.
 *
 * `hearing` is the radius of the noise pulse a creature reacts to. The walker is
 * nearly deaf (it patrols instead), the hunter is exactly who the noise mechanic
 * exists for, and the stalker ignores sound so it stays a sight-based threat.
 */
const ROLE_TUNING = Object.freeze({
  walker: {
    detectDelay: 0.9,
    loseSightSeconds: 5,
    searchSeconds: 10,
    hearing: 10,
    investigateSeconds: 8,
    attackSound: 'creature_walker_attack_01',
    detectSound: 'creature_walker_detect_01',
    voiceSound: 'creature_walker_growl_01',
    voiceInterval: [7, 13],
    idleSound: 'creature_walker_idle_01',
    moveSound: 'creature_walker_move_01',
  },
  hunter: {
    detectDelay: 0.25,
    loseSightSeconds: 2.5,
    searchSeconds: 6,
    hearing: 22,
    investigateSeconds: 6,
    attackSound: 'creature_hunter_attack_01',
    detectSound: 'creature_hunter_detect_01',
    voiceSound: 'creature_hunter_chase_01',
    voiceInterval: [4, 8],
    idleSound: 'creature_hunter_breath_01',
    moveSound: 'creature_hunter_move_01',
  },
  stalker: {
    detectDelay: 0,
    loseSightSeconds: 3,
    searchSeconds: 4,
    hearing: 0,
    investigateSeconds: 4,
    attackSound: 'creature_stalker_nearby_01',
    detectSound: 'creature_stalker_appear_01',
    voiceSound: 'creature_stalker_whisper_01',
    voiceInterval: [9, 18],
    idleSound: 'creature_stalker_distant_01',
    moveSound: 'creature_stalker_move_01',
  },
});

/** Stalker distances, in blocks. */
const STALKER = Object.freeze({
  /** Closer than this and it breaks and runs. */
  panic: 8,
  /** Preferred observation ring. */
  near: 12,
  far: 17,
  /** Beyond this it despawns once it is out of sight. */
  vanish: 30,
  /** Seconds of direct eye contact before it leaves. */
  stareLimit: 1.4,
  /** Minimum dot product between the player's look and the direction to it. */
  lookDot: 0.55,
});

function pickInterval(range, random) {
  return range[0] + random() * (range[1] - range[0]);
}

export class HorrorBrain {
  /**
   * @param {Object} options
   * @param {'walker'|'hunter'|'stalker'} options.behavior
   * @param {import('../MobTypes.js').MobDefinition} options.definition
   * @param {() => number} [options.random]
   */
  constructor({ behavior, definition, random = Math.random }) {
    this.behavior = behavior;
    this.definition = definition;
    this.tuning = ROLE_TUNING[behavior] ?? ROLE_TUNING.walker;
    this._random = random;

    this.state = HorrorState.IDLE;
    this._timer = 0;
    this._lostSight = 0;
    this._lastKnown = null;
    this._investigatePoint = null;
    this._home = null;
    this._voiceTimer = pickInterval(this.tuning.voiceInterval, random);
    this._idleTimer = pickInterval([8, 18], random);
    this._stepTimer = 0;
    this._watched = 0;
    this._vanishing = 0;
    this._roamX = 0;
    this._roamZ = 0;
    this._announced = new Set();
  }

  /** Records where the creature spawned, so it can return there. */
  reset(x, z) {
    this._home = { x, z };
    this._lastKnown = null;
    this._investigatePoint = null;
    this.state = HorrorState.IDLE;
    this._timer = 0;
    this._lostSight = 0;
    this._watched = 0;
    this._vanishing = 0;
  }

  _canAnnounce(key) {
    return !this._announced.has(key);
  }

  _announce(key) {
    this._announced.add(key);
  }

  /**
   * Advances one decision step.
   *
   * @param {number} dt
   * @param {Object} ctx
   * @param {{x:number,y:number,z:number}} ctx.mob
   * @param {{x:number,y:number,z:number,isDead?:boolean,isCreative?:boolean}|null} ctx.target
   * @param {boolean} ctx.targetVisible
   * @param {number} ctx.distance Horizontal distance to the target.
   * @param {{x:number,z:number}|null} [ctx.playerLook] Normalised look vector.
   * @param {{x:number,z:number,strength?:number,distance?:number}|null} [ctx.noise] Loudest nearby pulse.
   * @param {number} [ctx.attackCooldown] Seconds until the next strike is allowed.
   * @param {(id:string, options?:Object) => void} [ctx.emitSound]
   * @returns {{state: string, directionX: number, directionZ: number, speed: number,
   *   wantsAttack: boolean, navigateTo: {x:number,z:number}|null,
   *   faceTarget: boolean, despawn: boolean}}
   */
  update(dt, ctx) {
    this._voiceTimer -= dt;
    this._idleTimer -= dt;
    if (this._timer > 0) this._timer = Math.max(0, this._timer - dt);

    if (this.behavior === 'stalker') return this._updateStalker(dt, ctx);
    return this._updatePredator(dt, ctx);
  }

  // ------------------------------------------------------------- walker/hunter

  _updatePredator(dt, ctx) {
    const definition = this.definition;
    const tuning = this.tuning;
    const target = ctx.target;
    const valid = Boolean(target && !target.isDead && !target.isCreative);
    const distance = ctx.distance;

    switch (this.state) {
      case HorrorState.DETECT:
        if (!valid || !ctx.targetVisible) {
          this.state = HorrorState.SEARCH;
          this._timer = tuning.searchSeconds;
          break;
        }
        if (this._timer <= 0) {
          this.state = HorrorState.CHASE;
          this._lostSight = 0;
          this._voiceTimer = 0;
          ctx.emitSound?.(tuning.voiceSound, { volume: 0.9 });
        }
        // Freeze and stare during the warning beat: the player gets a moment to
        // realise they were seen, which is scarier than an instant lunge.
        return this._intent(HorrorState.DETECT, 0, 0, 0, false, null, true);

      case HorrorState.CHASE:
      case HorrorState.ATTACK: {
        if (valid && ctx.targetVisible && distance <= definition.loseRange) {
          this._lostSight = 0;
          this._remember(ctx);
          if (distance <= definition.attackRange) {
            this.state = HorrorState.ATTACK;
            const wantsAttack = (ctx.attackCooldown ?? 0) <= 0;
            if (wantsAttack) {
              if (this._canAnnounce('attack')) {
                this._announce('attack');
                ctx.emitSound?.(tuning.attackSound, { volume: 0.9 });
              }
            } else {
              this._announced.delete('attack');
            }
            return this._intent(HorrorState.ATTACK, 0, 0, 0, wantsAttack, null, true);
          }
          this.state = HorrorState.CHASE;
          this._announced.delete('attack');
          this._tickVoice(ctx);
          this._tickSteps(dt, ctx);
          return this._intent(
            HorrorState.CHASE,
            0,
            0,
            definition.chaseSpeed,
            false,
            { x: target.x, z: target.z },
            true,
          );
        }

        // Lost sight. Chase the last place the player was actually seen for a
        // moment, then search there — never track the live position through walls.
        this._lostSight += dt;
        if (this._lostSight >= tuning.loseSightSeconds || distance > definition.loseRange) {
          this.state = HorrorState.SEARCH;
          this._timer = tuning.searchSeconds;
          return this._intent(
            HorrorState.SEARCH,
            0,
            0,
            definition.walkSpeed * 1.15,
            false,
            this._lastKnown,
            false,
          );
        }
        return this._intent(
          HorrorState.CHASE,
          0,
          0,
          definition.chaseSpeed,
          false,
          this._lastKnown,
        );
      }

      case HorrorState.SEARCH: {
        if (valid && ctx.targetVisible && distance <= definition.detectRange) {
          this._remember(ctx);
          this.state = HorrorState.DETECT;
          this._timer = tuning.detectDelay;
          ctx.emitSound?.(tuning.detectSound, { volume: 0.9 });
          return this._intent(HorrorState.DETECT, 0, 0, 0, false, null, true);
        }
        if (this._timer <= 0 || !this._lastKnown) {
          this.state = HorrorState.RETREAT;
          break;
        }
        return this._intent(
          HorrorState.SEARCH,
          0,
          0,
          definition.walkSpeed * 1.15,
          false,
          this._lastKnown,
        );
      }

      case HorrorState.RETREAT: {
        const home = this._home;
        if (home) {
          const dx = home.x - ctx.mob.x;
          const dz = home.z - ctx.mob.z;
          if (Math.hypot(dx, dz) > 2.5) {
            return this._intent(
              HorrorState.RETREAT,
              0,
              0,
              definition.walkSpeed,
              false,
              home,
            );
          }
        }
        this.state = HorrorState.IDLE;
        this._timer = 2 + this._random() * 3;
        break;
      }

      case HorrorState.INVESTIGATE: {
        if (valid && ctx.targetVisible && distance <= definition.detectRange) {
          this._remember(ctx);
          this.state = HorrorState.DETECT;
          this._timer = tuning.detectDelay;
          ctx.emitSound?.(tuning.detectSound, { volume: 0.9 });
          return this._intent(HorrorState.DETECT, 0, 0, 0, false, null, true);
        }
        if (this._timer <= 0 || !this._investigatePoint) {
          this.state = HorrorState.ROAM;
          this._timer = 0;
          break;
        }
        return this._intent(
          HorrorState.INVESTIGATE,
          0,
          0,
          definition.walkSpeed * 1.2,
          false,
          this._investigatePoint,
        );
      }

      default:
        break;
    }

    // --- nothing active: notice, hear, wander ---------------------------------
    if (valid && ctx.targetVisible && distance <= definition.detectRange) {
      this._remember(ctx);
      this.state = HorrorState.DETECT;
      this._timer = tuning.detectDelay;
      ctx.emitSound?.(tuning.detectSound, { volume: 0.9 });
      return this._intent(HorrorState.DETECT, 0, 0, 0, false, null, true);
    }

    const noise = ctx.noise;
    if (
      noise &&
      tuning.hearing > 0 &&
      (noise.distance ?? Infinity) <= tuning.hearing
    ) {
      this.state = HorrorState.INVESTIGATE;
      this._timer = tuning.investigateSeconds;
      this._investigatePoint = { x: noise.x, z: noise.z };
      return this._intent(
        HorrorState.INVESTIGATE,
        0,
        0,
        definition.walkSpeed * 1.2,
        false,
        this._investigatePoint,
      );
    }

    this._tickIdleSound(ctx);

    if (this.state !== HorrorState.ROAM && this.state !== HorrorState.IDLE) {
      this.state = HorrorState.IDLE;
      this._timer = 1.5 + this._random() * 2.5;
    }
    if (this.state === HorrorState.IDLE && this._timer <= 0) {
      const angle = this._random() * Math.PI * 2;
      this.state = HorrorState.ROAM;
      this._roamX = Math.sin(angle);
      this._roamZ = Math.cos(angle);
      this._timer = 3 + this._random() * 4;
    }
    if (this.state === HorrorState.ROAM && this._timer <= 0) {
      this.state = HorrorState.IDLE;
      this._timer = 1.5 + this._random() * 2.5;
    }

    if (this.state === HorrorState.ROAM) {
      return this._intent(
        HorrorState.ROAM,
        this._roamX,
        this._roamZ,
        definition.walkSpeed,
        false,
        null,
      );
    }
    return this._intent(HorrorState.IDLE, 0, 0, 0, false, null);
  }

  // ------------------------------------------------------------------ stalker

  _updateStalker(dt, ctx) {
    const definition = this.definition;
    const target = ctx.target;
    const valid = Boolean(target && !target.isDead && !target.isCreative);
    const distance = ctx.distance;

    if (!valid) {
      this.state = HorrorState.IDLE;
      return this._intent(HorrorState.IDLE, 0, 0, 0, false, null);
    }

    if (this.state === HorrorState.RETREAT) {
      const awayX = ctx.mob.x - target.x;
      const awayZ = ctx.mob.z - target.z;
      const length = Math.hypot(awayX, awayZ) || 1;
      this._vanishing += dt;
      const gone = distance >= STALKER.vanish || (distance > 18 && !ctx.targetVisible);
      if (gone && this._vanishing > 1.2) {
        ctx.emitSound?.('creature_stalker_disappear_01', { volume: 0.8 });
        return {
          ...this._intent(HorrorState.RETREAT, 0, 0, 0, false, null),
          despawn: true,
        };
      }
      return this._intent(
        HorrorState.RETREAT,
        awayX / length,
        awayZ / length,
        definition.chaseSpeed,
        false,
        null,
      );
    }

    const looking = this._playerIsLooking(ctx);
    const watchedRecently = looking && ctx.targetVisible && distance < 26;
    this._watched = watchedRecently
      ? this._watched + dt
      : Math.max(0, this._watched - dt * 1.5);

    // Panic or eye contact: leave, but walk away like a physical creature rather
    // than teleporting. Vanishing only happens once it is out of sight.
    if (distance < STALKER.panic || this._watched >= STALKER.stareLimit) {
      this.state = HorrorState.RETREAT;
      this._vanishing = 0;
      ctx.emitSound?.('creature_stalker_disappear_01', { volume: 0.75 });
      return this._intent(
        HorrorState.RETREAT,
        (ctx.mob.x - target.x) / Math.max(0.001, distance),
        (ctx.mob.z - target.z) / Math.max(0.001, distance),
        definition.chaseSpeed,
        false,
        null,
      );
    }

    this._voiceTimer -= dt;
    if (this._voiceTimer <= 0) {
      this._voiceTimer = pickInterval(this.tuning.voiceInterval, this._random);
      const sound = this._random() < 0.5 ? this.tuning.voiceSound : this.tuning.idleSound;
      ctx.emitSound?.(sound, { volume: 0.6 });
    }

    if (distance > STALKER.far) {
      this.state = HorrorState.ROAM;
      return this._intent(
        HorrorState.ROAM,
        0,
        0,
        definition.walkSpeed * 1.35,
        false,
        { x: target.x, z: target.z },
      );
    }
    if (distance < STALKER.near) {
      const awayX = ctx.mob.x - target.x;
      const awayZ = ctx.mob.z - target.z;
      const length = Math.hypot(awayX, awayZ) || 1;
      this.state = HorrorState.ROAM;
      return this._intent(
        HorrorState.ROAM,
        awayX / length,
        awayZ / length,
        definition.walkSpeed,
        false,
        null,
      );
    }

    if (this.state !== HorrorState.OBSERVE) {
      this.state = HorrorState.OBSERVE;
      if (this._canAnnounce('appear')) {
        this._announce('appear');
        ctx.emitSound?.('creature_stalker_appear_01', { volume: 0.5 });
      }
    }
    return this._intent(HorrorState.OBSERVE, 0, 0, 0, false, null, true);
  }

  /** True when the player's look vector points roughly at the creature. */
  _playerIsLooking(ctx) {
    const look = ctx.playerLook;
    const target = ctx.target;
    if (!look || !target) return false;
    const dx = ctx.mob.x - target.x;
    const dz = ctx.mob.z - target.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.001) return true;
    const dot = (dx / length) * look.x + (dz / length) * look.z;
    return dot > STALKER.lookDot;
  }

  // ----------------------------------------------------------------- helpers

  _remember(ctx) {
    if (!ctx.target) return;
    this._lastKnown = { x: ctx.target.x, z: ctx.target.z };
  }

  _intent(state, directionX, directionZ, speed, wantsAttack, navigateTo, faceTarget = false) {
    return {
      state,
      directionX,
      directionZ,
      speed,
      wantsAttack,
      navigateTo: navigateTo ?? null,
      faceTarget,
      despawn: false,
    };
  }

  /** Occasional growl while chasing, so the player can track it by ear. */
  _tickVoice(ctx) {
    if (this._voiceTimer > 0) return;
    this._voiceTimer = pickInterval(this.tuning.voiceInterval, this._random);
    ctx.emitSound?.(this.tuning.voiceSound, { volume: 0.75 });
  }

  /** Footsteps while running, positional so they can be located. */
  _tickSteps(dt, ctx) {
    this._stepTimer -= dt;
    if (this._stepTimer > 0) return;
    this._stepTimer = 0.42 + this._random() * 0.18;
    ctx.emitSound?.(this.tuning.moveSound, { volume: 0.6 });
  }

  /** Idle breathing/distant calls while nothing is happening. */
  _tickIdleSound(ctx) {
    if (this._idleTimer > 0) return;
    this._idleTimer = pickInterval([14, 30], this._random);
    ctx.emitSound?.(this.tuning.idleSound, { volume: 0.45 });
  }

  getStats() {
    return {
      behavior: this.behavior,
      state: this.state,
      lostSight: Math.round(this._lostSight * 100) / 100,
      watched: Math.round(this._watched * 100) / 100,
    };
  }
}

export default HorrorBrain;
