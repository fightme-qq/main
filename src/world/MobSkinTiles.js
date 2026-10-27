/**
 * Atlas tile names for the per-part creature skins.
 *
 * Kept in `world/` rather than beside the palette because `BlockTypes.js` —
 * which fixes the atlas layout that the mesher worker also reads — imports it,
 * and that import must not reach into `rendering/` or `entities/`.
 *
 * The order here *is* atlas order. Roles follow `MOB_SKIN_ROLES`, so a creature
 * occupies four consecutive tiles and the tile index stays trivially derivable.
 *
 * Worker-safe: no imports beyond the palette table, which is pure data.
 */

import { MOB_SKIN_ROLES, MOB_SKIN_STYLES, mobSkinTileName } from '../config/MobSkins.js';

/**
 * Every creature skin tile, appended after the original catalogue.
 *
 * @type {ReadonlyArray<string>}
 */
export const MOB_SKIN_TILE_NAMES = Object.freeze(
  Object.keys(MOB_SKIN_STYLES).flatMap((mobId) =>
    MOB_SKIN_ROLES.map((role) => mobSkinTileName(mobId, role))
  )
);

export default MOB_SKIN_TILE_NAMES;
