/**
 * Sound ids for the horror roster's reactions.
 *
 * Kept beside the entities rather than inside the audio layer because these are
 * *creature* facts: which vocalisation a walker makes when hit. The audio manager
 * stays a mixer and does not need to know that "walker" exists.
 *
 * Every id here is a generated file already present in the manifest; the mapping is
 * covered by the horror self-test, so a rename cannot silently mute a creature.
 */

/** behaviour -> reaction -> library id. */
export const MOB_SOUNDS = Object.freeze({
  walker: Object.freeze({
    hurt: 'creature_walker_hurt_01',
    death: 'creature_walker_death_01',
    attack: 'creature_walker_attack_01',
  }),
  hunter: Object.freeze({
    hurt: 'creature_hunter_hurt_01',
    death: 'creature_hunter_death_01',
    attack: 'creature_hunter_attack_01',
  }),
  stalker: Object.freeze({
    hurt: 'creature_stalker_nearby_01',
    death: 'creature_stalker_disappear_01',
    attack: 'creature_stalker_nearby_01',
  }),
});

/**
 * @param {string|null|undefined} behavior
 * @param {'hurt'|'death'|'attack'} reaction
 * @returns {string|null}
 */
export function mobSound(behavior, reaction) {
  const set = MOB_SOUNDS[behavior];
  return set ? set[reaction] ?? null : null;
}

export default MOB_SOUNDS;
