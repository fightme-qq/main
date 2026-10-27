/** Version 9 gates: world difficulty, one-life saves and upgraded voxel rigs. */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';

import {
  DIFFICULTY_ORDER,
  DifficultyId,
  getDifficulty,
  isPermadeathDifficulty,
  normalizeDifficulty,
} from '../src/gameplay/Difficulty.js';
import { PlayerStats } from '../src/player/PlayerStats.js';
import { Player } from '../src/player/Player.js';
import { DamageType } from '../src/player/DamageTypes.js';
import { EventBus } from '../src/core/EventBus.js';
import { SaveManager, createEmptyWorldRecord } from '../src/core/SaveManager.js';
import {
  createVoxelPlayerModel,
  VOXEL_PLAYER_PROPORTIONS,
} from '../src/rendering/VoxelPlayerModel.js';
import { MobEntity } from '../src/entities/MobEntity.js';
import { MOB_SKELETONS } from '../src/entities/MobSkeletons.js';
import { MobSpawner } from '../src/entities/MobSpawner.js';
import { SAVE } from '../src/config/GameConfig.js';

let passed = 0;
const check = (name, condition) => {
  if (!condition) throw new Error(name);
  passed++;
  console.log(`  ok  ${name}`);
};
const section = (name) => console.log(`\n${name}`);

section('Persistent difficulty contract');
check('world format is version 9', SAVE.worldFormatVersion === 9);
check('all four survival difficulties are ordered and unique',
  DIFFICULTY_ORDER.length === 4 && new Set(DIFFICULTY_ORDER).size === 4);
check('unknown difficulties migrate safely to Normal', normalizeDifficulty('impossible') === DifficultyId.NORMAL);
check('Hardcore and Chug Tuff are one-life modes',
  isPermadeathDifficulty('hardcore') && isPermadeathDifficulty('chug_tuff'));
check('Easy and Normal allow respawning',
  !isPermadeathDifficulty('easy') && !isPermadeathDifficulty('normal'));
check('Chug Tuff is the strongest complete profile',
  getDifficulty('chug_tuff').incomingDamage > getDifficulty('hardcore').incomingDamage &&
  getDifficulty('chug_tuff').hostileHealth > getDifficulty('hardcore').hostileHealth &&
  getDifficulty('chug_tuff').hostileSpawnRate > getDifficulty('hardcore').hostileSpawnRate);

const chugWorld = createEmptyWorldRecord('One Life', 9, {
  mode:'survival', difficulty:'chug_tuff',
});
check('new saves own their difficulty and defeat marker',
  chugWorld.difficulty === 'chug_tuff' && chugWorld.hardcoreDefeated === false);
const migrated = new SaveManager(null)._migrateWorldRecord({
  name:'Legacy', seed:8, formatVersion:8, mode:'survival',
});
check('v8 worlds migrate to Normal without being locked',
  migrated.difficulty === 'normal' && migrated.hardcoreDefeated === false);

section('Survival balance');
const easyStats = new PlayerStats(null);
easyStats.setDifficulty('easy');
easyStats.addExhaustion(1);
const chugStats = new PlayerStats(null);
chugStats.setDifficulty('chug_tuff');
chugStats.addExhaustion(1);
check('Easy slows hunger pressure', Math.abs(easyStats.exhaustion - .62) < 1e-9);
check('Chug Tuff accelerates hunger pressure', Math.abs(chugStats.exhaustion - 1.7) < 1e-9);

const normalStarve = new PlayerStats(null);
normalStarve.setDifficulty('normal');
normalStarve.hunger = 0;
normalStarve.saturation = 0;
normalStarve.health = 1;
normalStarve.tick(4.1);
check('Normal starvation stops at half a heart', normalStarve.health === 1 && !normalStarve.isDead);
const lethalStarve = new PlayerStats(null);
lethalStarve.setDifficulty('chug_tuff');
lethalStarve.hunger = 0;
lethalStarve.saturation = 0;
lethalStarve.health = 1;
lethalStarve.tick(4.1);
check('Chug Tuff starvation can kill', lethalStarve.isDead && lethalStarve.health === 0);

const settings = {
  get(path) {
    return {
      'gameplay.mode':'survival',
      'controls.autoJump':false,
      'gameplay.allowFly':false,
    }[path];
  },
};
const world = {
  isCollidable:() => false,
  getBlock:() => 0,
  isLiquid:() => false,
};
const easyPlayer = new Player({ world, bus:new EventBus(), settings, difficulty:'easy' });
const chugPlayer = new Player({ world, bus:new EventBus(), settings, difficulty:'chug_tuff' });
easyPlayer.hurt(4, DamageType.MOB);
chugPlayer.hurt(4, DamageType.MOB);
check('incoming player damage is scaled by world difficulty',
  Math.abs(easyPlayer.stats.health - 17.4) < 1e-6 && chugPlayer.stats.health === 13);
check('difficulty survives player serialization', chugPlayer.toJSON().difficulty === 'chug_tuff');

section('Detailed original voxel avatar');
const avatar = createVoxelPlayerModel();
const scene = new THREE.Scene();
scene.add(avatar.group);
const names = new Set();
let meshCount = 0;
avatar.group.traverse((part) => {
  if (part.name) names.add(part.name);
  if (part.isMesh) meshCount++;
});
const bounds = new THREE.Box3().setFromObject(avatar.group);
check('avatar is a detailed articulated rig', meshCount >= 25 && names.has('player-head-pivot'));
check('avatar has readable face geometry',
  names.has('player-eye-left-white') && names.has('player-eye-right-iris') &&
  names.has('player-nose') && names.has('player-mouth'));
check('avatar has split clothing and footwear geometry',
  names.has('player-left-sleeve') && names.has('player-right-forearm') &&
  names.has('player-left-boot') && names.has('player-right-boot'));
check('avatar retains block-character proportions',
  VOXEL_PLAYER_PROPORTIONS.height === 1.8 && bounds.max.y - bounds.min.y > 1.75 &&
  bounds.max.y - bounds.min.y < 1.9);
check('avatar carries only its original procedural style marker',
  avatar.group.userData.avatarStyle === 'original-teal-voxel');
avatar.dispose();

section('Upgraded mobs and Chug Tuff pressure');
const normalZombie = new MobEntity().spawn('zombie', 0, 1, 0, 9);
normalZombie.applyDifficulty(getDifficulty('normal'), true, true);
const chugZombie = new MobEntity().spawn('zombie', 0, 1, 0, 9);
chugZombie.applyDifficulty(getDifficulty('chug_tuff'), true, true);
check('Chug Tuff raises hostile health', chugZombie.maxHealth === 31 && chugZombie.maxHealth > normalZombie.maxHealth);
check('Chug Tuff shortens hostile attack cooldowns',
  chugZombie.difficultyAttackRate === 1.42 && chugZombie.attackCooldown < normalZombie.attackCooldown);
chugZombie.health = chugZombie.maxHealth / 2;
const mobRecord = chugZombie.toJSON();
const restoredZombie = new MobEntity();
restoredZombie.fromJSON(mobRecord);
restoredZombie.applyDifficulty(getDifficulty('chug_tuff'));
check('scaled mob health ratio survives save and load',
  mobRecord.maxHealth === 31 && Math.abs(restoredZombie.health / restoredZombie.maxHealth - .5) < 1e-6);
const spawner = new MobSpawner(9, 'chug_tuff');
check('natural spawner owns the world difficulty profile', spawner._difficulty.id === 'chug_tuff');

const cowHead = MOB_SKELETONS.cow.skeleton.bones.find((bone) => bone.name === 'head');
const cowLeg = MOB_SKELETONS.cow.skeleton.bones.find((bone) => bone.name === 'legFrontLeft');
const huskHead = MOB_SKELETONS.husk.skeleton.bones.find((bone) => bone.name === 'head');
const huskLeg = MOB_SKELETONS.husk.skeleton.bones.find((bone) => bone.name === 'legLeft');
check('quadrupeds have modeled muzzle, ears and hooves', cowHead.boxes.length >= 4 && cowLeg.boxes.length >= 2);
check('bipeds have modeled face depth and feet', huskHead.boxes.length >= 2 && huskLeg.boxes.length >= 2);

section('Menu and permadeath wiring');
const menuSource = readFileSync(new URL('../src/ui/MainMenu.js', import.meta.url), 'utf8');
const deathSource = readFileSync(new URL('../src/ui/DeathScreen.js', import.meta.url), 'utf8');
const gameSource = readFileSync(new URL('../src/Game.js', import.meta.url), 'utf8');
const rendererSource = readFileSync(new URL('../src/entities/MobRenderer.js', import.meta.url), 'utf8');
check('world creation exposes every named mode',
  menuSource.includes("value: 'creative'") && menuSource.includes('DIFFICULTY_ORDER') &&
  menuSource.includes('Mode and difficulty'));
check('defeated one-life saves are disabled in the world list',
  menuSource.includes("role: defeated ? 'group' : 'button'") &&
  menuSource.includes("'aria-disabled': defeated ? 'true' : null") &&
  menuSource.includes("defeated ? 'World lost' : null"));
check('the main screen offers a single Play action',
  menuSource.includes("button('Play'") && !menuSource.includes("button('New world'"));
check('death screen removes respawn for one-life worlds',
  deathSource.includes('setVisible(this._respawnButton, !permadeath)'));
check('the game persists a one-life defeat before showing the result',
  gameSource.includes('this.worldRecord.hardcoreDefeated = true') && gameSource.includes('void this.save()'));
check('all creatures share one instanced contact-shadow pool',
  rendererSource.includes("this.shadowMesh.name = 'mob-contact-shadows'") &&
  rendererSource.includes('new THREE.InstancedMesh'));

console.log(`\nVersion 9 self-test: ${passed}/${passed} checks passed`);
