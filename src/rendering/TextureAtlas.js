/**
 * Procedurally painted texture atlas.
 *
 * Every tile is original pixel art generated with Canvas at load time. Nothing
 * is downloaded, nothing is copied from another game, and the whole atlas costs
 * one 256x256 RGBA texture (256 KB) and a few milliseconds to paint.
 *
 * ## Padding
 *
 * Each 16x16 tile sits in a 32x32 cell, and the 8-pixel border is filled by
 * *wrapping* the tile — the same tile drawn nine times, clipped to the cell.
 * Block textures tile seamlessly by construction, so when a mip level or an
 * anisotropic tap reaches past the tile edge it samples a continuation of the
 * same texture instead of the neighbouring tile. That is what prevents the
 * coloured fringes that otherwise appear on distant blocks.
 *
 * ## Determinism
 *
 * Each tile's noise comes from a PRNG seeded with its tile index, so the atlas is
 * byte-identical on every load and on every device. Textures are part of the
 * game's look; they must not shimmer differently each session.
 */

import * as THREE from 'three';
import { NETHER_STONE_PALETTES, NETHER_WOOD_PALETTES } from '../world/NetherBlocks.js';

import {
  ATLAS_COLUMNS,
  ATLAS_PIXELS,
  ATLAS_ROWS,
  TILE_PADDING,
  TILE_PIXELS,
  TILE_STRIDE,
  tilePixelRect,
} from '../world/AtlasLayout.js';
import { TILE_NAMES, TILE_INDEX, COLOUR_BLOCK_PALETTES } from '../world/BlockTypes.js';
import { RENDER_SHAPE, Shape, getBlock } from '../world/BlockRegistry.js';
import { getItem } from '../items/ItemRegistry.js';
import { MOB_SKIN_ROLES, MOB_SKIN_STYLES, mobSkinTileName } from '../config/MobSkins.js';
import { mulberry32, clamp } from '../utils/MathUtils.js';

/**
 * A 16x16 RGBA scratch surface with pixel-art drawing helpers.
 *
 * Working on a raw byte array rather than through canvas 2D calls keeps the
 * output exact: no antialiasing, no subpixel rounding, no device-dependent
 * rasterisation differences.
 */
class TilePainter {
  /**
   * @param {number} seed
   * @param {number} [size]
   */
  constructor(seed, size = TILE_PIXELS) {
    this.size = size;
    this.data = new Uint8ClampedArray(size * size * 4);
    this.random = mulberry32(seed);
  }

  /** Random float in `[0, 1)`. */
  next() {
    return this.random();
  }

  /** Random float in `[min, max)`. */
  range(min, max) {
    return min + this.random() * (max - min);
  }

  /** Random integer in `[0, max)`. */
  int(max) {
    return Math.floor(this.random() * max);
  }

  /** Writes a pixel, wrapping coordinates so patterns tile seamlessly. */
  set(x, y, r, g, b, a = 255) {
    const size = this.size;
    const wrappedX = ((x % size) + size) % size;
    const wrappedY = ((y % size) + size) % size;
    const index = (wrappedY * size + wrappedX) * 4;
    this.data[index] = r;
    this.data[index + 1] = g;
    this.data[index + 2] = b;
    this.data[index + 3] = a;
  }

  /** Reads a pixel as `[r, g, b, a]`. */
  get(x, y) {
    const size = this.size;
    const wrappedX = ((x % size) + size) % size;
    const wrappedY = ((y % size) + size) % size;
    const index = (wrappedY * size + wrappedX) * 4;
    return [this.data[index], this.data[index + 1], this.data[index + 2], this.data[index + 3]];
  }

  /** Fills the whole tile with one colour. */
  fill(r, g, b, a = 255) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) this.set(x, y, r, g, b, a);
    }
    return this;
  }

  /** Clears to fully transparent. */
  clear() {
    this.data.fill(0);
    return this;
  }

  /**
   * Adds per-pixel brightness variation, the backbone of every mineral texture.
   * @param {number} amount Maximum signed offset applied to each channel.
   * @param {number} [chance] Fraction of pixels affected.
   */
  grain(amount, chance = 1) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (chance < 1 && this.random() > chance) continue;
        const [r, g, b, a] = this.get(x, y);
        if (a === 0) continue;
        const shift = Math.round((this.random() * 2 - 1) * amount);
        this.set(x, y, r + shift, g + shift, b + shift, a);
      }
    }
    return this;
  }

  /**
   * Scatters soft blobs, used for ore inclusions, moss and pebbles.
   * @param {number} count
   * @param {number} radius
   * @param {[number,number,number]} colour
   * @param {number} [variance] Per-pixel brightness variation inside the blob.
   */
  blobs(count, radius, colour, variance = 12) {
    for (let i = 0; i < count; i++) {
      const centreX = this.random() * this.size;
      const centreY = this.random() * this.size;
      const blobRadius = radius * this.range(0.7, 1.3);
      const extent = Math.ceil(blobRadius) + 1;
      for (let dy = -extent; dy <= extent; dy++) {
        for (let dx = -extent; dx <= extent; dx++) {
          // Irregular edge: perturb the radius test per pixel.
          const distance = Math.hypot(dx, dy) + (this.random() - 0.5) * 0.9;
          if (distance > blobRadius) continue;
          const shift = Math.round((this.random() * 2 - 1) * variance);
          this.set(
            Math.round(centreX + dx),
            Math.round(centreY + dy),
            colour[0] + shift,
            colour[1] + shift,
            colour[2] + shift,
            255
          );
        }
      }
    }
    return this;
  }

  /** Draws a horizontal line. */
  hLine(y, fromX, toX, colour, alpha = 255) {
    for (let x = fromX; x <= toX; x++) this.set(x, y, colour[0], colour[1], colour[2], alpha);
    return this;
  }

  /** Draws a vertical line. */
  vLine(x, fromY, toY, colour, alpha = 255) {
    for (let y = fromY; y <= toY; y++) this.set(x, y, colour[0], colour[1], colour[2], alpha);
    return this;
  }

  /** Fills a rectangle. */
  rect(x, y, width, height, colour, alpha = 255) {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        this.set(x + dx, y + dy, colour[0], colour[1], colour[2], alpha);
      }
    }
    return this;
  }

  /** Multiplies a region's brightness, for shading and highlights. */
  shade(x, y, width, height, factor) {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const [r, g, b, a] = this.get(x + dx, y + dy);
        if (a === 0) continue;
        this.set(x + dx, y + dy, r * factor, g * factor, b * factor, a);
      }
    }
    return this;
  }
}

// ------------------------------------------------------------ icon shape helpers
//
// Item icons share a handful of silhouettes. Factoring them out is not just
// brevity: it is what keeps the four tool tiers reading as the *same* tool in a
// different material, which is the whole point of a visible progression.

/** Handle and head colours per tool tier. */
const TOOL_MATERIALS = Object.freeze({
  wood: { head: [150, 112, 66], light: [178, 138, 88], dark: [112, 82, 46] },
  stone: { head: [126, 126, 130], light: [156, 156, 160], dark: [92, 92, 96] },
  iron: { head: [208, 208, 214], light: [240, 240, 246], dark: [154, 154, 162] },
  diamond: { head: [86, 214, 208], light: [140, 240, 234], dark: [50, 162, 164] },
  netherite: { head: [74, 64, 68], light: [112, 100, 104], dark: [42, 35, 38] },
});

/** Colours shared by all four icons in an armour set. */
const ARMOUR_MATERIALS = Object.freeze({
  leather: { base: [138, 88, 52], light: [178, 122, 76], dark: [92, 56, 34] },
  gold: { base: [226, 178, 48], light: [255, 224, 98], dark: [166, 116, 24] },
  iron: { base: [202, 206, 214], light: [242, 244, 248], dark: [142, 148, 160] },
  diamond: { base: [70, 202, 198], light: [132, 238, 230], dark: [36, 142, 148] },
  netherite: { base: [68, 58, 62], light: [106, 94, 98], dark: [38, 32, 34] },
});

/** Wooden handle colours, shared by every tool. */
const HANDLE = Object.freeze({ base: [128, 94, 56], dark: [98, 70, 40] });

/**
 * Draws a two-pixel-wide diagonal shaft between two points.
 * @param {TilePainter} p
 */
function diagonalShaft(p, x0, y0, x1, y1, base, dark) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    p.set(x, y, base[0], base[1], base[2]);
    // Second pixel offset along the shaft's normal gives it visible thickness.
    p.set(x + 1, y, dark[0], dark[1], dark[2]);
  }
}

/**
 * Draws a filled circle with a light top-left and a dark bottom-right.
 * @param {TilePainter} p
 */
function ball(p, cx, cy, radius, base, light, dark) {
  const extent = Math.ceil(radius);
  for (let dy = -extent; dy <= extent; dy++) {
    for (let dx = -extent; dx <= extent; dx++) {
      if (Math.hypot(dx, dy) > radius) continue;
      // Diagonal gradient reads as a lit sphere without any real shading maths.
      const lit = dx + dy < -radius * 0.45;
      const shadowed = dx + dy > radius * 0.5;
      const colour = lit ? light : shadowed ? dark : base;
      p.set(cx + dx, cy + dy, colour[0], colour[1], colour[2]);
    }
  }
}

/**
 * An irregular mineral lump, used for coal and charcoal.
 * @param {TilePainter} p
 */
function mineralLump(p, base, light, dark) {
  ball(p, 8, 8, 4.6, base, light, dark);
  // Hard facets break up the circle so it reads as broken rock.
  for (let i = 0; i < 7; i++) {
    const x = 4 + p.int(8);
    const y = 4 + p.int(8);
    const [, , , a] = p.get(x, y);
    if (a === 0) continue;
    const shift = p.int(28) - 14;
    p.set(x, y, base[0] + shift, base[1] + shift, base[2] + shift);
  }
  p.set(6, 6, light[0], light[1], light[2]);
}

/**
 * A trapezoidal metal bar with a highlight along the top edge.
 * @param {TilePainter} p
 */
function ingot(p, base, light, dark) {
  // Narrower at the top than the bottom, which is what makes it read as a cast
  // bar rather than a rectangle.
  p.rect(4, 6, 8, 5, base);
  p.rect(5, 5, 6, 1, base);
  p.hLine(5, 5, 10, light);
  p.hLine(6, 4, 11, light);
  p.hLine(10, 4, 11, dark);
  p.set(4, 6, dark[0], dark[1], dark[2]);
  p.set(11, 6, dark[0], dark[1], dark[2]);
  p.set(6, 6, 255, 255, 255);
}

/**
 * A cut of meat: rounded mass, marbling and a highlight.
 * @param {TilePainter} p
 */
function meatCut(p, base, light, dark, marble) {
  ball(p, 8, 8, 5, base, light, dark);
  // Trim the silhouette so it is not a plain circle.
  p.rect(3, 3, 2, 2, [0, 0, 0], 0);
  p.rect(12, 12, 2, 2, [0, 0, 0], 0);
  for (let i = 0; i < 9; i++) {
    const x = 5 + p.int(7);
    const y = 5 + p.int(7);
    const [, , , a] = p.get(x, y);
    if (a === 0) continue;
    p.set(x, y, marble[0], marble[1], marble[2]);
  }
  p.grain(8);
}

/**
 * A metal pail, optionally filled with a fluid.
 * @param {TilePainter} p
 * @param {[number,number,number]|null} fluid
 */
function bucketBody(p, fluid) {
  const metal = [186, 190, 198];
  const light = [222, 226, 232];
  const dark = [134, 138, 148];

  // Tapered body.
  for (let y = 6; y <= 13; y++) {
    const inset = Math.floor((y - 6) / 4);
    p.hLine(y, 3 + inset, 12 - inset, metal);
  }
  // Rim and handle.
  p.hLine(5, 3, 12, light);
  p.hLine(13, 4, 11, dark);
  p.vLine(3, 6, 12, dark);
  p.vLine(12, 6, 12, light);
  p.set(5, 4, dark[0], dark[1], dark[2]);
  p.set(10, 4, dark[0], dark[1], dark[2]);

  if (fluid) {
    // Fluid sits inside the rim, so the pail is still legible.
    p.rect(5, 6, 6, 3, fluid);
    p.hLine(6, 5, 10, [
      Math.min(255, fluid[0] + 40),
      Math.min(255, fluid[1] + 40),
      Math.min(255, fluid[2] + 40),
    ]);
  }
  p.set(4, 7, light[0], light[1], light[2]);
}

/**
 * Draws one of the five tool silhouettes in a given material.
 *
 * All five share a diagonal wooden handle running bottom-left to top-right; only
 * the head differs. Keeping the handle identical is what makes a row of tools
 * read as a set.
 *
 * @param {TilePainter} p
 * @param {'pickaxe'|'axe'|'shovel'|'hoe'|'sword'} shape
 * @param {{head: number[], light: number[], dark: number[]}} material
 */
function toolIcon(p, shape, material) {
  p.clear();
  const { head, light, dark } = material;

  if (shape === 'sword') {
    // A sword has no separate handle: the blade *is* the diagonal.
    for (let i = 0; i < 9; i++) {
      const x = 5 + i;
      const y = 11 - i;
      p.set(x, y, head[0], head[1], head[2]);
      p.set(x - 1, y, light[0], light[1], light[2]);
      p.set(x, y + 1, dark[0], dark[1], dark[2]);
    }
    // Crossguard across the blade, then a short grip below it.
    p.set(4, 11, head[0], head[1], head[2]);
    p.set(3, 12, HANDLE.base[0], HANDLE.base[1], HANDLE.base[2]);
    p.set(4, 13, HANDLE.base[0], HANDLE.base[1], HANDLE.base[2]);
    p.set(3, 14, HANDLE.dark[0], HANDLE.dark[1], HANDLE.dark[2]);
    p.set(5, 12, head[0], head[1], head[2]);
    p.set(2, 11, head[0], head[1], head[2]);
    p.set(13, 2, light[0], light[1], light[2]);
    return;
  }

  // Shared handle for pickaxe, axe, shovel and hoe.
  diagonalShaft(p, 4, 13, 10, 7, HANDLE.base, HANDLE.dark);
  p.set(3, 14, HANDLE.dark[0], HANDLE.dark[1], HANDLE.dark[2]);

  if (shape === 'pickaxe') {
    // Wide head with two downturned points.
    p.hLine(4, 6, 13, head);
    p.hLine(3, 7, 12, light);
    p.set(5, 5, head[0], head[1], head[2]);
    p.set(6, 5, head[0], head[1], head[2]);
    p.set(13, 5, head[0], head[1], head[2]);
    p.set(4, 5, dark[0], dark[1], dark[2]);
    p.set(14, 4, dark[0], dark[1], dark[2]);
    p.set(11, 5, head[0], head[1], head[2]);
    p.set(11, 6, dark[0], dark[1], dark[2]);
  } else if (shape === 'axe') {
    // Bit on the left of the shaft, tall and slightly curved.
    for (let y = 3; y <= 8; y++) {
      const width = y <= 5 ? 4 : 3;
      p.hLine(y, 8 - width, 8 + (y <= 4 ? 3 : 2), head);
    }
    p.vLine(4, 4, 7, light);
    p.hLine(3, 6, 10, light);
    p.shade(9, 6, 3, 3, 0.86);
    p.set(11, 3, dark[0], dark[1], dark[2]);
  } else if (shape === 'shovel') {
    // Spade blade at the top of the shaft.
    p.rect(9, 2, 5, 5, head);
    p.hLine(2, 10, 13, light);
    p.vLine(9, 3, 6, light);
    p.set(9, 7, head[0], head[1], head[2]);
    p.set(10, 7, head[0], head[1], head[2]);
    p.hLine(7, 11, 13, dark);
    p.set(13, 6, dark[0], dark[1], dark[2]);
  } else {
    // Hoe: a short blade cantilevered off the top of the shaft.
    p.hLine(4, 6, 12, head);
    p.hLine(3, 8, 12, light);
    p.vLine(6, 4, 6, head);
    p.set(6, 6, dark[0], dark[1], dark[2]);
    p.set(5, 5, dark[0], dark[1], dark[2]);
    p.set(12, 5, dark[0], dark[1], dark[2]);
  }
}

/** Draws a compact readable silhouette for one armour slot. */
function armourIcon(p, slot, material) {
  p.clear();
  const { base, light, dark } = material;

  if (slot === 'helmet') {
    p.rect(4, 4, 8, 7, base);
    p.hLine(3, 5, 10, light);
    p.vLine(4, 5, 10, light);
    p.vLine(11, 5, 10, dark);
    p.hLine(10, 4, 11, dark);
    // Open face makes it unmistakably a helmet rather than a bucket.
    p.rect(6, 7, 5, 4, [0, 0, 0], 0);
    p.set(5, 10, base[0], base[1], base[2]);
    return;
  }

  if (slot === 'chestplate') {
    p.rect(5, 4, 6, 9, base);
    p.rect(3, 5, 2, 6, base);
    p.rect(11, 5, 2, 6, base);
    p.hLine(4, 5, 10, light);
    p.vLine(5, 5, 12, light);
    p.vLine(10, 5, 12, dark);
    p.hLine(12, 5, 10, dark);
    // Neck notch.
    p.rect(7, 4, 2, 2, [0, 0, 0], 0);
    return;
  }

  if (slot === 'leggings') {
    p.rect(4, 3, 8, 4, base);
    p.rect(4, 7, 3, 7, base);
    p.rect(9, 7, 3, 7, base);
    p.hLine(3, 4, 11, light);
    p.vLine(4, 4, 13, light);
    p.vLine(11, 4, 13, dark);
    p.hLine(13, 4, 6, dark);
    p.hLine(13, 9, 11, dark);
    return;
  }

  // Boots: two separate ankle-high pieces.
  p.rect(3, 7, 4, 6, base);
  p.rect(9, 7, 4, 6, base);
  p.rect(2, 11, 5, 3, base);
  p.rect(9, 11, 5, 3, base);
  p.hLine(7, 3, 6, light);
  p.hLine(7, 9, 12, light);
  p.hLine(13, 2, 6, dark);
  p.hLine(13, 9, 13, dark);
}

/** A chipped black flint shard. */
function flintIcon(p) {
  p.clear();
  const outline = [42, 46, 52];
  const base = [82, 88, 96];
  const light = [132, 138, 146];
  const points = [
    [5, 3], [9, 3], [12, 6], [11, 10], [8, 13], [4, 11], [3, 7],
  ];
  for (let y = 3; y <= 13; y++) {
    const left = y < 7 ? 5 - Math.floor((y - 3) / 2) : 3 + Math.floor((y - 7) / 4);
    const right = y < 7 ? 9 + Math.floor((y - 3) / 2) : 12 - Math.floor((y - 7) / 2);
    p.hLine(y, left, right, base);
  }
  for (const [x, y] of points) p.set(x, y, outline[0], outline[1], outline[2]);
  p.hLine(5, 5, 9, light);
  p.set(6, 6, light[0], light[1], light[2]);
}

/** Transparent crossed-plane flame texture. */
function fireTile(p) {
  p.clear();
  const outer = [236, 72, 18];
  const middle = [255, 146, 24];
  const core = [255, 232, 92];
  const ember = [184, 42, 12];
  const rows = [
    [7, 7], [6, 8], [5, 9], [4, 10], [3, 11], [2, 12],
    [1, 13], [0, 14], [0, 15], [1, 14], [2, 13], [3, 12],
    [4, 11], [5, 10], [6, 9], [7, 8], [8, 7], [9, 6],
    [10, 5], [11, 4], [12, 3], [13, 2], [14, 1], [15, 0],
  ];
  for (let y = 0; y < 16; y++) {
    const width = Math.max(1, 7 - Math.floor(y / 3));
    const wobble = ((y * 7) % 3) - 1;
    const centre = 8 + wobble;
    for (let x = centre - width; x <= centre + width; x++) {
      if (x < 0 || x > 15) continue;
      const distance = Math.abs(x - centre);
      const colour = distance <= Math.max(1, width - 3)
        ? core
        : distance <= Math.max(1, width - 1)
          ? middle
          : outer;
      p.set(x, 15 - y, colour[0], colour[1], colour[2], 238);
    }
  }
  for (const [x, y] of rows) {
    p.set(x, y, ember[0], ember[1], ember[2], 220);
  }
}

/** Flint-and-steel durability tool icon. */
function flintAndSteelIcon(p) {
  p.clear();
  const steel = [188, 194, 202];
  const shine = [238, 242, 246];
  const dark = [80, 86, 94];
  const flint = [54, 58, 64];
  // Steel C-shaped striker.
  p.hLine(3, 5, 12, steel);
  p.hLine(4, 4, 11, shine);
  p.vLine(4, 4, 10, steel);
  p.vLine(5, 5, 11, dark);
  p.hLine(11, 5, 10, steel);
  p.hLine(12, 6, 9, dark);
  // Flint shard in the lower-right jaw.
  p.set(10, 8, flint[0], flint[1], flint[2]);
  p.set(11, 8, flint[0], flint[1], flint[2]);
  p.set(12, 9, flint[0], flint[1], flint[2]);
  p.set(11, 10, 112, 118, 126);
  p.set(10, 10, flint[0], flint[1], flint[2]);
  // Tiny spark makes the action readable at inventory scale.
  p.set(13, 6, 255, 224, 88);
  p.set(14, 5, 255, 146, 32);
  p.set(14, 7, 255, 192, 52);
}

/** Arrow icon and projectile texture. */
function arrowIcon(p) {
  p.clear();
  const shaft = [142, 104, 62];
  const dark = [92, 66, 40];
  const stone = [170, 174, 182];
  diagonalShaft(p, 3, 13, 12, 4, shaft, dark);
  // Flint tip.
  p.set(12, 3, stone[0], stone[1], stone[2]);
  p.set(13, 3, stone[0], stone[1], stone[2]);
  p.set(13, 2, 220, 222, 226);
  p.set(12, 4, 112, 116, 124);
  // Feather fletching.
  p.set(2, 12, 232, 232, 226);
  p.set(2, 13, 208, 208, 202);
  p.set(3, 14, 232, 232, 226);
  p.set(4, 14, 208, 208, 202);
}

/** Curved bow with taut string. */
function bowIcon(p) {
  p.clear();
  const wood = [150, 104, 58];
  const light = [190, 138, 78];
  const string = [226, 226, 218];
  const curve = [
    [10, 2], [12, 3], [13, 5], [13, 8], [12, 11], [10, 13],
    [9, 3], [11, 4], [12, 6], [12, 8], [11, 10], [9, 12],
  ];
  for (const [x, y] of curve) p.set(x, y, wood[0], wood[1], wood[2]);
  p.set(10, 2, light[0], light[1], light[2]);
  p.set(12, 4, light[0], light[1], light[2]);
  // String from both tips to the grip.
  for (let i = 0; i <= 5; i++) {
    p.set(10 - Math.floor(i * 0.8), 2 + i, string[0], string[1], string[2]);
    p.set(6 + Math.floor(i * 0.8), 7 + i, string[0], string[1], string[2]);
  }
}

/** Iron-rimmed wooden shield. */
function shieldIcon(p) {
  p.clear();
  const rim = [172, 178, 188];
  const rimLight = [226, 230, 236];
  const wood = [132, 86, 46];
  const woodLight = [176, 122, 70];
  for (let y = 3; y <= 12; y++) {
    const inset = y >= 9 ? Math.floor((y - 8) / 2) : 0;
    p.hLine(y, 3 + inset, 12 - inset, rim);
    if (12 - inset - (3 + inset) > 2) p.hLine(y, 4 + inset, 11 - inset, wood);
  }
  p.hLine(3, 3, 12, rimLight);
  p.vLine(3, 3, 8, rimLight);
  p.vLine(12, 3, 8, [112, 118, 128]);
  p.vLine(7, 4, 11, woodLight);
  p.vLine(8, 4, 11, [102, 64, 36]);
  p.set(7, 6, rimLight[0], rimLight[1], rimLight[2]);
  p.set(8, 6, rim[0], rim[1], rim[2]);
}

/**
 * Tile painters, keyed by tile name. Adding a texture is a new entry here plus a
 * name in `TILE_NAMES`.
 * @type {Record<string, (painter: TilePainter) => void>}
 */
const TILE_PAINTERS = {
  stone(p) {
    p.fill(126, 126, 128).grain(13);
    p.blobs(4, 2.4, [112, 112, 116], 8);
    p.blobs(3, 1.6, [140, 140, 143], 8);
  },

  cobblestone(p) {
    p.fill(96, 96, 99);
    // A jittered grid of rounded stones with dark mortar between them.
    const cells = [
      [0, 0, 7, 7],
      [8, 0, 7, 6],
      [0, 8, 6, 7],
      [7, 7, 8, 8],
      [0, 15, 15, 1],
    ];
    for (const [x, y, w, h] of cells) {
      const base = 118 + p.int(24);
      for (let dy = 1; dy < h - 1; dy++) {
        for (let dx = 1; dx < w - 1; dx++) {
          const edge = dx === 1 || dy === 1 || dx === w - 2 || dy === h - 2;
          const shift = p.int(16) - 8 + (edge ? -14 : 0);
          p.set(x + dx, y + dy, base + shift, base + shift, base + 2 + shift);
        }
      }
    }
    p.grain(7);
  },

  mossy_cobblestone(p) {
    TILE_PAINTERS.cobblestone(p);
    p.blobs(7, 2.1, [86, 118, 66], 16);
    p.grain(8, 0.5);
  },

  dirt(p) {
    p.fill(122, 88, 58).grain(15);
    p.blobs(6, 1.8, [104, 74, 48], 10);
    p.blobs(4, 1.2, [138, 102, 68], 10);
  },

  grass_top(p) {
    p.fill(108, 168, 74).grain(16);
    p.blobs(7, 2.0, [96, 152, 66], 10);
    p.blobs(4, 1.3, [124, 184, 86], 10);
  },

  grass_side(p) {
    TILE_PAINTERS.dirt(p);
    // Jagged grass overhang, deeper in some columns than others.
    for (let x = 0; x < 16; x++) {
      const depth = 3 + p.int(3);
      for (let y = 0; y < depth; y++) {
        const shift = p.int(22) - 11;
        p.set(x, y, 104 + shift, 164 + shift, 70 + shift);
      }
    }
  },

  sand(p) {
    p.fill(219, 205, 155).grain(11);
    p.blobs(5, 1.4, [206, 191, 141], 7);
  },

  red_sand(p) {
    p.fill(190, 118, 68).grain(12);
    p.blobs(5, 1.5, [172, 102, 58], 8);
  },

  sandstone_top(p) {
    p.fill(222, 209, 162).grain(8);
    p.blobs(3, 2.0, [212, 198, 152], 5);
  },

  sandstone_side(p) {
    p.fill(220, 207, 160).grain(6);
    // Sedimentary banding.
    for (const y of [3, 4, 9, 10, 14]) p.hLine(y, 0, 15, [204, 190, 144]);
    p.hLine(0, 0, 15, [232, 220, 176]);
    p.grain(5);
  },

  gravel(p) {
    p.fill(122, 118, 116).grain(14);
    p.blobs(9, 1.9, [98, 95, 94], 14);
    p.blobs(7, 1.5, [148, 144, 141], 14);
  },

  clay(p) {
    p.fill(162, 166, 178).grain(7);
    p.blobs(4, 2.2, [152, 156, 170], 5);
  },

  bedrock(p) {
    p.fill(62, 62, 66);
    // Chaotic hard-edged chunks, the classic "you cannot mine this" read.
    for (let i = 0; i < 26; i++) {
      const x = p.int(16);
      const y = p.int(16);
      const w = 2 + p.int(4);
      const h = 2 + p.int(4);
      const value = 34 + p.int(70);
      p.rect(x, y, w, h, [value, value, value + 3]);
    }
    p.grain(10);
  },

  oak_log_side(p) {
    p.fill(112, 84, 52).grain(9);
    barkColumns(p, [96, 70, 42], [128, 96, 60]);
  },

  oak_log_top(p) {
    woodRings(p, [154, 120, 76], [116, 86, 52]);
  },

  oak_leaves(p) {
    leaves(p, [70, 128, 52], [96, 158, 66], 0.2);
  },

  spruce_log_side(p) {
    p.fill(78, 56, 38).grain(8);
    barkColumns(p, [62, 44, 30], [96, 70, 48]);
  },

  spruce_log_top(p) {
    woodRings(p, [126, 96, 62], [88, 64, 42]);
  },

  spruce_leaves(p) {
    leaves(p, [44, 88, 60], [62, 112, 76], 0.16);
  },

  birch_log_side(p) {
    p.fill(220, 216, 206).grain(7);
    // Dark dashes and a hint of pale bark texture.
    for (let i = 0; i < 9; i++) {
      const x = p.int(16);
      const y = p.int(16);
      const length = 2 + p.int(4);
      p.hLine(y, x, x + length, [92, 84, 74]);
      if (p.next() > 0.6) p.hLine(y + 1, x, x + Math.max(1, length - 2), [120, 110, 98]);
    }
    p.grain(5);
  },

  birch_log_top(p) {
    woodRings(p, [214, 206, 188], [166, 156, 138]);
  },

  birch_leaves(p) {
    leaves(p, [108, 156, 70], [138, 184, 92], 0.22);
  },

  ladder(p) {
    p.clear();
    const light = [184, 138, 78];
    const wood = [144, 100, 54];
    const shadow = [94, 62, 34];
    p.rect(2, 0, 3, 16, shadow);
    p.rect(3, 0, 2, 16, wood);
    p.rect(11, 0, 3, 16, shadow);
    p.rect(11, 0, 2, 16, wood);
    for (const y of [2, 6, 10, 14]) {
      p.hLine(y, 4, 11, shadow);
      p.hLine(y - 1, 4, 11, light);
    }
    p.grain(6, 0.35);
  },

  planks(p) {
    p.fill(158, 122, 78);
    // Four planks with a dark seam and lengthwise grain.
    for (let row = 0; row < 4; row++) {
      const y = row * 4;
      const base = 150 + p.int(20);
      for (let dy = 0; dy < 4; dy++) {
        for (let x = 0; x < 16; x++) {
          const grainShift = p.next() > 0.82 ? -14 : p.int(9) - 4;
          const value = base + grainShift;
          p.set(x, y + dy, value, value * 0.78, value * 0.5);
        }
      }
      p.hLine(y, 0, 15, [110, 82, 50]);
    }
  },

  bricks(p) {
    p.fill(168, 164, 158); // mortar
    for (let row = 0; row < 4; row++) {
      const y = row * 4 + 1;
      const offset = row % 2 === 0 ? 0 : 4;
      for (let column = 0; column < 2; column++) {
        const x = offset + column * 8;
        const base = 150 + p.int(24);
        for (let dy = 0; dy < 3; dy++) {
          for (let dx = 0; dx < 7; dx++) {
            const shift = p.int(14) - 7;
            p.set(x + dx, y + dy, base + shift, (base + shift) * 0.5, (base + shift) * 0.42);
          }
        }
      }
    }
  },

  glass(p) {
    p.clear();
    // A frame plus two diagonal highlights: enough to read as glass while
    // staying almost entirely see-through.
    const frame = [214, 232, 240];
    p.hLine(0, 0, 15, frame, 150);
    p.hLine(15, 0, 15, frame, 150);
    p.vLine(0, 0, 15, frame, 150);
    p.vLine(15, 0, 15, frame, 150);
    for (let i = 0; i < 6; i++) {
      p.set(2 + i, 3 + i, 255, 255, 255, 96);
      p.set(3 + i, 3 + i, 255, 255, 255, 60);
    }
    for (let i = 0; i < 3; i++) p.set(10 + i, 9 + i, 255, 255, 255, 70);
  },

  water(p) {
    p.fill(58, 118, 196);
    // Broad diagonal bands; the shader scrolls the tile so these become swell.
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const wave =
          Math.sin((x * 0.6 + y * 0.35) * 1.1) * 10 + Math.sin((x * 0.21 - y * 0.7) * 1.6) * 7;
        const shift = Math.round(wave) + p.int(6) - 3;
        p.set(x, y, 56 + shift, 116 + shift, 194 + shift * 0.6, 255);
      }
    }
  },

  lava(p) {
    p.fill(218, 72, 18);
    // Bright, broken convection bands. The water shader's bounded scrolling is
    // shared by liquids, so this pattern moves without sampling another tile.
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const band = Math.sin(x * 0.72 + y * 0.31) + Math.sin(x * 0.23 - y * 0.84);
        const hot = band > 0.55 || p.next() > 0.9;
        const dark = band < -0.75;
        if (hot) p.set(x, y, 255, 176 + p.int(52), 40 + p.int(30));
        else if (dark) p.set(x, y, 150 + p.int(34), 36 + p.int(24), 10);
        else p.set(x, y, 220 + p.int(25), 72 + p.int(35), 16 + p.int(15));
      }
    }
  },
  obsidian(p) {
    p.fill(24, 18, 38).grain(8);
    p.blobs(8, 1.4, [48, 33, 67], 10);
    p.blobs(5, 0.75, [78, 50, 91], 8);
    for (let i = 0; i < 6; i++) {
      const y = p.int(16);
      const x = p.int(13);
      p.hLine(y, x, x + 2 + p.int(3), [14, 10, 22]);
    }
  },

  ice(p) {
    p.fill(170, 204, 238, 225).grain(9);
    // Cracks.
    for (let i = 0; i < 5; i++) {
      let x = p.int(16);
      let y = p.int(16);
      const length = 4 + p.int(7);
      for (let step = 0; step < length; step++) {
        p.set(x, y, 214, 236, 255, 235);
        x += p.int(3) - 1;
        y += p.next() > 0.35 ? 1 : 0;
      }
    }
  },

  coal_ore(p) {
    TILE_PAINTERS.stone(p);
    p.blobs(4, 2.2, [38, 38, 42], 10);
    p.blobs(3, 1.2, [24, 24, 28], 6);
  },

  iron_ore(p) {
    TILE_PAINTERS.stone(p);
    p.blobs(4, 2.0, [188, 148, 116], 14);
    p.blobs(3, 1.1, [212, 176, 142], 10);
  },

  gold_ore(p) {
    TILE_PAINTERS.stone(p);
    p.blobs(4, 1.9, [226, 190, 74], 14);
    p.blobs(3, 1.0, [250, 224, 118], 10);
  },

  diamond_ore(p) {
    TILE_PAINTERS.stone(p);
    p.blobs(4, 1.8, [104, 216, 224], 14);
    p.blobs(3, 1.0, [168, 242, 246], 10);
  },

  snow(p) {
    p.fill(246, 249, 255).grain(6);
    p.blobs(4, 2.4, [238, 242, 252], 4);
  },

  grass_snow_side(p) {
    TILE_PAINTERS.dirt(p);
    for (let x = 0; x < 16; x++) {
      const depth = 3 + p.int(3);
      for (let y = 0; y < depth; y++) {
        const shift = p.int(12) - 6;
        p.set(x, y, 242 + shift, 246 + shift, 252 + shift);
      }
    }
  },

  cactus_side(p) {
    p.fill(52, 116, 62).grain(9);
    // Vertical ridges with spines on the ridge lines.
    for (const x of [2, 7, 12]) {
      p.vLine(x, 0, 15, [38, 92, 48]);
      p.vLine(x + 1, 0, 15, [70, 138, 78]);
    }
    for (let i = 0; i < 10; i++) {
      const x = [3, 8, 13][p.int(3)];
      const y = p.int(16);
      p.set(x, y, 226, 226, 200);
    }
  },

  cactus_top(p) {
    p.fill(60, 128, 70).grain(8);
    p.blobs(1, 4.2, [76, 148, 84], 6);
    for (let i = 0; i < 6; i++) p.set(4 + p.int(8), 4 + p.int(8), 224, 224, 198);
  },

  tall_grass(p) {
    p.clear();
    // Blades rising from the bottom edge, thinning as they go up.
    for (let i = 0; i < 11; i++) {
      const baseX = p.int(16);
      const height = 7 + p.int(8);
      const lean = p.next() > 0.5 ? 1 : -1;
      const tint = 96 + p.int(48);
      for (let step = 0; step < height; step++) {
        const y = 15 - step;
        const x = baseX + Math.round((step / height) * 2) * lean;
        p.set(x, y, tint * 0.55, tint + 42, tint * 0.5, 255);
        if (step < height * 0.5) p.set(x + lean, y, tint * 0.5, tint + 30, tint * 0.45, 255);
      }
    }
  },

  fern(p) {
    p.clear();
    // A central stem with paired fronds.
    const stemX = 8;
    for (let y = 15; y >= 3; y--) p.set(stemX, y, 62, 108, 54, 255);
    for (let y = 14; y >= 4; y -= 2) {
      const reach = Math.max(1, Math.round((y - 2) * 0.42));
      for (let d = 1; d <= reach; d++) {
        const shade = 78 + p.int(40);
        p.set(stemX - d, y - Math.floor(d / 2), shade * 0.55, shade + 30, shade * 0.5, 255);
        p.set(stemX + d, y - Math.floor(d / 2), shade * 0.5, shade + 24, shade * 0.45, 255);
      }
    }
  },

  dead_bush(p) {
    p.clear();
    // A few crooked twigs.
    for (let i = 0; i < 5; i++) {
      let x = 4 + p.int(8);
      let y = 15;
      const length = 6 + p.int(6);
      for (let step = 0; step < length; step++) {
        p.set(x, y, 122 + p.int(30), 90 + p.int(20), 48, 255);
        y--;
        x += p.int(3) - 1;
        if (y < 1) break;
      }
    }
  },

  flower_red(p) {
    flower(p, [206, 62, 58], [246, 208, 96]);
  },

  flower_yellow(p) {
    flower(p, [230, 202, 66], [250, 244, 190]);
  },

  torch(p) {
    p.clear();
    // Handle.
    for (let y = 15; y >= 6; y--) {
      const shift = p.int(20) - 10;
      p.rect(7, y, 2, 1, [122 + shift, 88 + shift, 52 + shift]);
    }
    // Ember and flame.
    p.rect(7, 4, 2, 2, [255, 216, 110]);
    p.rect(6, 3, 4, 1, [255, 176, 62], 235);
    p.rect(7, 2, 2, 1, [255, 232, 150], 220);
    p.set(6, 5, 255, 150, 48, 190);
    p.set(9, 5, 255, 150, 48, 190);
  },

  // ------------------------------------------------------------- item icons
  //
  // Item tiles differ from block tiles in one important way: they are drawn on
  // transparency and must *not* reach the tile edge. Block textures tile
  // seamlessly and rely on the wrapped padding; an icon that touched the border
  // would have its own opposite edge bleed into it at small mip levels. Every
  // painter below therefore starts with `clear()` and keeps a one-pixel margin.

  stick(p) {
    p.clear();
    diagonalShaft(p, 4, 12, 11, 4, [138, 100, 58], [104, 74, 42]);
  },

  coal(p) {
    p.clear();
    mineralLump(p, [38, 38, 42], [64, 64, 70], [18, 18, 20]);
  },

  charcoal(p) {
    p.clear();
    mineralLump(p, [52, 44, 38], [82, 70, 60], [28, 24, 20]);
  },

  iron_ingot(p) {
    p.clear();
    ingot(p, [206, 206, 212], [236, 236, 242], [150, 150, 158]);
  },

  gold_ingot(p) {
    p.clear();
    ingot(p, [232, 190, 66], [252, 226, 128], [174, 134, 34]);
  },

  netherite_ingot(p) {
    p.clear();
    ingot(p, [72, 62, 66], [110, 98, 102], [40, 34, 36]);
  },

  gunpowder(p) {
    p.clear();
    mineralLump(p, [72, 70, 74], [116, 114, 118], [38, 36, 40]);
  },

  blaze_rod(p) {
    p.clear();
    p.vLine(7, 2, 13, [242, 186, 58]);
    p.vLine(8, 2, 13, [255, 214, 96]);
    p.vLine(6, 4, 12, [186, 132, 26]);
    p.set(7, 2, 255, 244, 180);
  },

  blaze_powder(p) {
    p.clear();
    mineralLump(p, [226, 138, 34], [255, 190, 82], [158, 88, 18]);
  },

  nether_wart_item(p) {
    p.clear();
    mineralLump(p, [124, 30, 40], [176, 56, 66], [76, 16, 24]);
  },

  ghast_tear(p) {
    p.clear();
    p.hLine(5, 7, 8, [222, 246, 240]);
    p.hLine(6, 6, 9, [240, 255, 252]);
    p.hLine(7, 5, 10, [222, 246, 240]);
    p.hLine(8, 5, 10, [200, 232, 226]);
    p.hLine(9, 5, 10, [178, 212, 208]);
    p.hLine(10, 6, 9, [160, 196, 192]);
    p.set(7, 6, 255, 255, 255);
  },

  magma_cream(p) {
    p.clear();
    mineralLump(p, [188, 76, 26], [242, 138, 48], [104, 40, 14]);
    p.set(7, 7, 255, 208, 120);
  },

  gold_nugget(p) {
    p.clear();
    p.hLine(7, 6, 9, [236, 196, 74]);
    p.hLine(8, 5, 10, [252, 222, 122]);
    p.hLine(9, 6, 9, [186, 144, 38]);
    p.set(6, 7, 255, 244, 176);
  },

  glowstone_dust(p) {
    p.clear();
    mineralLump(p, [226, 202, 120], [252, 238, 178], [166, 140, 66]);
  },

  nether_star(p) {
    p.clear();
    const bright = [246, 250, 236];
    const mid = [206, 214, 190];
    p.vLine(8, 1, 14, mid);
    p.hLine(8, 1, 14, mid);
    for (let i = 0; i < 6; i++) {
      p.set(5 + i, 5 + i, ...bright);
      p.set(11 - i, 5 + i, ...bright);
    }
    p.hLine(7, 6, 10, bright);
    p.hLine(8, 5, 11, bright);
    p.hLine(9, 6, 10, bright);
    p.set(8, 8, 255, 255, 255);
  },

  wither_skeleton_skull(p) {
    p.clear();
    p.rect(4, 4, 9, 9, [46, 44, 44], 255);
    p.rect(5, 5, 7, 3, [28, 26, 26], 255);
    p.set(6, 7, 12, 12, 12);
    p.set(10, 7, 12, 12, 12);
    p.hLine(11, 6, 10, [24, 22, 22]);
    p.hLine(4, 5, 11, [66, 64, 64]);
  },

  warped_fungus_on_a_stick(p) {
    p.clear();
    for (let i = 0; i < 8; i++) p.set(4 + i, 12 - i, 128, 94, 56);
    p.hLine(3, 9, 12, [40, 156, 150]);
    p.hLine(4, 8, 13, [56, 190, 182]);
    p.hLine(5, 9, 12, [30, 128, 124]);
    p.set(10, 3, 120, 226, 218);
  },

  netherite_scrap(p) {
    p.clear();
    mineralLump(p, [96, 68, 58], [138, 102, 86], [52, 36, 32]);
  },

  diamond(p) {
    p.clear();
    // A faceted gem: bright core, darker lower facets, a single specular pixel.
    const light = [126, 234, 228];
    const mid = [78, 202, 200];
    const dark = [44, 154, 158];
    p.hLine(5, 6, 9, mid);
    p.hLine(6, 4, 11, light);
    p.hLine(7, 3, 12, light);
    p.hLine(8, 3, 12, mid);
    p.hLine(9, 4, 11, mid);
    p.hLine(10, 5, 10, dark);
    p.hLine(11, 7, 8, dark);
    p.set(6, 6, 226, 255, 255);
    p.set(5, 7, 200, 250, 250);
  },

  leather(p) {
    p.clear();
    // An irregular hide shape rather than a rectangle, so it does not read as a
    // block icon at a glance.
    p.rect(3, 4, 10, 8, [154, 106, 66]);
    p.rect(2, 6, 12, 4, [154, 106, 66]);
    p.set(2, 5, 0, 0, 0, 0);
    p.set(13, 5, 0, 0, 0, 0);
    p.grain(12);
    p.shade(3, 9, 10, 3, 0.82);
    p.hLine(4, 4, 11, [180, 132, 90]);
  },

  feather(p) {
    p.clear();
    // Quill running bottom-left to top-right with barbs on both sides.
    for (let i = 0; i < 10; i++) {
      const x = 4 + i;
      const y = 12 - i;
      p.set(x, y, 218, 220, 226);
      if (i > 1 && i < 9) {
        p.set(x - 1, y, 244, 246, 250);
        p.set(x, y + 1, 196, 198, 206);
      }
    }
    p.set(3, 13, 176, 160, 128);
    p.set(4, 13, 176, 160, 128);
  },

  bone(p) {
    p.clear();
    const light = [238, 236, 222];
    const dark = [198, 194, 176];
    p.rect(7, 4, 2, 8, light);
    // Knobbed ends.
    p.rect(5, 2, 2, 2, light);
    p.rect(9, 2, 2, 2, light);
    p.rect(5, 12, 2, 2, light);
    p.rect(9, 12, 2, 2, light);
    p.set(6, 4, dark[0], dark[1], dark[2]);
    p.set(9, 11, dark[0], dark[1], dark[2]);
    p.vLine(8, 5, 10, dark);
  },

  bone_meal(p) {
    p.clear();
    // A small heap of pale dust.
    p.hLine(11, 3, 12, [226, 224, 210]);
    p.hLine(10, 4, 11, [238, 236, 224]);
    p.hLine(9, 5, 10, [244, 242, 232]);
    p.hLine(8, 6, 9, [250, 248, 240]);
    p.grain(10);
    for (let i = 0; i < 8; i++) p.set(2 + p.int(12), 5 + p.int(3), 240, 238, 226);
  },

  string(p) {
    p.clear();
    // A loose thread with a couple of curls.
    const colour = [232, 232, 236];
    p.vLine(5, 2, 9, colour);
    p.set(6, 9, colour[0], colour[1], colour[2]);
    p.set(7, 10, colour[0], colour[1], colour[2]);
    p.set(8, 11, colour[0], colour[1], colour[2]);
    p.set(9, 11, colour[0], colour[1], colour[2]);
    p.set(10, 10, colour[0], colour[1], colour[2]);
    p.set(10, 9, colour[0], colour[1], colour[2]);
    p.set(9, 8, colour[0], colour[1], colour[2]);
    p.set(11, 4, colour[0], colour[1], colour[2]);
    p.set(11, 5, colour[0], colour[1], colour[2]);
  },

  clay_ball(p) {
    p.clear();
    ball(p, 8, 8, 4, [166, 170, 182], [190, 194, 204], [136, 140, 152]);
  },

  wheat(p) {
    p.clear();
    // A bundled sheaf: three stalks with grain heads.
    for (const x of [4, 8, 12]) {
      p.vLine(x, 5, 13, [190, 158, 74]);
      for (let y = 3; y < 8; y += 2) {
        p.set(x - 1, y, 226, 196, 96);
        p.set(x + 1, y, 226, 196, 96);
        p.set(x, y, 240, 214, 118);
      }
    }
    p.hLine(11, 3, 13, [168, 138, 62]);
  },

  wheat_seeds(p) {
    p.clear();
    // Scattered seeds, deliberately sparse so it reads differently to wheat.
    const spots = [
      [4, 6],
      [8, 4],
      [11, 7],
      [6, 10],
      [10, 11],
      [3, 9],
    ];
    for (const [x, y] of spots) {
      p.rect(x, y, 2, 2, [150, 168, 88]);
      p.set(x, y, 178, 196, 112);
    }
  },

  bread(p) {
    p.clear();
    // Rounded loaf with slashes across the crust.
    p.rect(3, 5, 10, 6, [186, 132, 66]);
    p.rect(4, 4, 8, 8, [186, 132, 66]);
    p.grain(10);
    p.hLine(4, 5, 10, [210, 158, 88]);
    for (const x of [5, 8, 11]) {
      p.set(x, 5, 156, 106, 50);
      p.set(x - 1, 6, 156, 106, 50);
    }
    p.shade(3, 9, 10, 3, 0.84);
  },

  apple(p) {
    p.clear();
    ball(p, 8, 9, 4.2, [198, 52, 48], [226, 88, 76], [150, 30, 32]);
    // Stalk and a leaf, which is what stops it reading as a generic red ball.
    p.vLine(8, 3, 4, [110, 78, 44]);
    p.set(9, 3, 96, 150, 70);
    p.set(10, 3, 110, 168, 80);
    p.set(6, 7, 244, 168, 158);
  },

  carrot(p) {
    p.clear();
    // Tapering root, widest at the top.
    for (let i = 0; i < 8; i++) {
      const y = 6 + i;
      const half = Math.max(0, 3 - Math.floor(i / 2.4));
      p.hLine(y, 8 - half, 8 + half, [226, 126, 42]);
    }
    p.vLine(8, 6, 12, [244, 152, 62]);
    // Green tops.
    for (const [dx, dy] of [
      [-2, 3],
      [0, 2],
      [2, 3],
    ]) {
      p.vLine(8 + dx, dy, 5, [92, 152, 62]);
    }
  },

  potato(p) {
    p.clear();
    ball(p, 8, 8, 4.4, [186, 152, 96], [212, 178, 122], [148, 118, 70]);
    // Eyes: the detail that separates it from a bread roll.
    for (const [x, y] of [
      [6, 6],
      [10, 9],
      [7, 10],
    ]) {
      p.set(x, y, 132, 104, 60);
    }
  },

  baked_potato(p) {
    p.clear();
    ball(p, 8, 8, 4.4, [154, 112, 60], [188, 144, 84], [116, 82, 42]);
    // A split top showing pale flesh.
    p.hLine(6, 6, 10, [226, 202, 148]);
    p.set(7, 5, 226, 202, 148);
    p.set(9, 5, 226, 202, 148);
  },

  raw_beef(p) {
    p.clear();
    meatCut(p, [190, 78, 78], [216, 108, 106], [150, 54, 58], [236, 176, 172]);
  },

  cooked_beef(p) {
    p.clear();
    meatCut(p, [138, 82, 48], [168, 108, 66], [102, 58, 32], [200, 150, 100]);
  },

  raw_porkchop(p) {
    p.clear();
    meatCut(p, [226, 142, 142], [244, 172, 170], [190, 106, 110], [248, 210, 206]);
    // Bone along one edge, which is what makes it a chop.
    p.vLine(3, 5, 10, [238, 236, 220]);
  },

  cooked_porkchop(p) {
    p.clear();
    meatCut(p, [186, 126, 74], [212, 152, 96], [148, 94, 50], [222, 178, 128]);
    p.vLine(3, 5, 10, [226, 222, 202]);
  },

  raw_chicken(p) {
    p.clear();
    meatCut(p, [232, 176, 158], [246, 202, 186], [198, 140, 126], [250, 224, 212]);
  },

  cooked_chicken(p) {
    p.clear();
    meatCut(p, [198, 146, 82], [222, 176, 112], [162, 112, 56], [234, 196, 142]);
  },

  raw_mutton(p) {
    p.clear();
    meatCut(p, [204, 96, 92], [226, 126, 120], [166, 68, 70], [240, 188, 180]);
  },

  cooked_mutton(p) {
    p.clear();
    meatCut(p, [150, 92, 54], [178, 118, 74], [114, 66, 36], [206, 158, 108]);
  },

  bucket(p) {
    p.clear();
    bucketBody(p, null);
  },

  water_bucket(p) {
    p.clear();
    bucketBody(p, [58, 118, 196]);
  },

  lava_bucket(p) {
    p.clear();
    bucketBody(p, [226, 106, 34]);
  },

  flint: flintIcon,
  fire: fireTile,
  flint_and_steel: flintAndSteelIcon,
  arrow: arrowIcon,
  bow: bowIcon,
  shield: shieldIcon,

  // ----------------------------------------------------------------- tools
  //
  // Generated from two shared shapes so a tier upgrade is a colour change and
  // nothing else. Writing twenty near-identical painters by hand is how tiers
  // end up subtly inconsistent.
  wood_pickaxe: (p) => toolIcon(p, 'pickaxe', TOOL_MATERIALS.wood),
  wood_axe: (p) => toolIcon(p, 'axe', TOOL_MATERIALS.wood),
  wood_shovel: (p) => toolIcon(p, 'shovel', TOOL_MATERIALS.wood),
  wood_hoe: (p) => toolIcon(p, 'hoe', TOOL_MATERIALS.wood),
  wood_sword: (p) => toolIcon(p, 'sword', TOOL_MATERIALS.wood),

  stone_pickaxe: (p) => toolIcon(p, 'pickaxe', TOOL_MATERIALS.stone),
  stone_axe: (p) => toolIcon(p, 'axe', TOOL_MATERIALS.stone),
  stone_shovel: (p) => toolIcon(p, 'shovel', TOOL_MATERIALS.stone),
  stone_hoe: (p) => toolIcon(p, 'hoe', TOOL_MATERIALS.stone),
  stone_sword: (p) => toolIcon(p, 'sword', TOOL_MATERIALS.stone),

  iron_pickaxe: (p) => toolIcon(p, 'pickaxe', TOOL_MATERIALS.iron),
  iron_axe: (p) => toolIcon(p, 'axe', TOOL_MATERIALS.iron),
  iron_shovel: (p) => toolIcon(p, 'shovel', TOOL_MATERIALS.iron),
  iron_hoe: (p) => toolIcon(p, 'hoe', TOOL_MATERIALS.iron),
  iron_sword: (p) => toolIcon(p, 'sword', TOOL_MATERIALS.iron),

  diamond_pickaxe: (p) => toolIcon(p, 'pickaxe', TOOL_MATERIALS.diamond),
  diamond_axe: (p) => toolIcon(p, 'axe', TOOL_MATERIALS.diamond),
  diamond_shovel: (p) => toolIcon(p, 'shovel', TOOL_MATERIALS.diamond),
  diamond_hoe: (p) => toolIcon(p, 'hoe', TOOL_MATERIALS.diamond),
  diamond_sword: (p) => toolIcon(p, 'sword', TOOL_MATERIALS.diamond),

  netherite_pickaxe: (p) => toolIcon(p, 'pickaxe', TOOL_MATERIALS.netherite),
  netherite_axe: (p) => toolIcon(p, 'axe', TOOL_MATERIALS.netherite),
  netherite_shovel: (p) => toolIcon(p, 'shovel', TOOL_MATERIALS.netherite),
  netherite_hoe: (p) => toolIcon(p, 'hoe', TOOL_MATERIALS.netherite),
  netherite_sword: (p) => toolIcon(p, 'sword', TOOL_MATERIALS.netherite),

  // ------------------------------------------------------------ new blocks

  farmland(p) {
    TILE_PAINTERS.dirt(p);
    // Tilled rows: darker furrows with raised ridges between them, which is what
    // makes a field read as worked ground from above.
    p.shade(0, 0, 16, 16, 0.94);
    for (const y of [2, 7, 12]) {
      p.hLine(y, 0, 15, [86, 60, 38]);
      p.hLine(y + 1, 0, 15, [74, 52, 32]);
      p.hLine(y + 2, 0, 15, [138, 102, 68]);
    }
    p.grain(9);
  },

  farmland_wet(p) {
    TILE_PAINTERS.farmland(p);
    // Hydrated soil is visibly darker and slightly cooler, but retains the same
    // furrows so state changes do not appear to reshape the block.
    p.shade(0, 0, 16, 16, 0.68);
    for (const y of [3, 8, 13]) p.hLine(y, 0, 15, [72, 52, 38]);
  },

  crafting_table_top(p) {
    TILE_PAINTERS.planks(p);
    // A 3x3 grid scored into the surface, which is the whole visual promise of
    // the block: you can see it holds nine slots.
    p.shade(0, 0, 16, 16, 0.9);
    const line = [88, 62, 36];
    for (const at of [5, 10]) {
      p.hLine(at, 1, 14, line);
      p.vLine(at, 1, 14, line);
    }
    p.rect(1, 1, 14, 1, [72, 50, 28]);
    p.rect(1, 14, 14, 1, [72, 50, 28]);
    p.vLine(1, 1, 14, [72, 50, 28]);
    p.vLine(14, 1, 14, [72, 50, 28]);
    p.grain(6);
  },

  crafting_table_side(p) {
    TILE_PAINTERS.planks(p);
    // Tool silhouettes hung on the side, dark enough to read as recessed.
    p.shade(0, 0, 16, 16, 0.86);
    const dark = [78, 54, 32];
    // A saw blade.
    p.hLine(4, 3, 12, dark);
    for (let x = 3; x <= 12; x += 2) p.set(x, 5, dark[0], dark[1], dark[2]);
    // A hammer.
    p.rect(4, 9, 6, 2, dark);
    p.vLine(11, 8, 12, dark);
    p.grain(6);
  },

  furnace_top(p) {
    TILE_PAINTERS.stone(p);
    p.shade(0, 0, 16, 16, 0.94);
    // A round vent in the centre.
    const dark = [72, 72, 76];
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > 3) continue;
        const shade = d > 2 ? dark : [52, 52, 56];
        p.set(8 + dx, 8 + dy, shade[0], shade[1], shade[2]);
      }
    }
    p.grain(7);
  },

  furnace_side(p) {
    TILE_PAINTERS.stone(p);
    // Cut stone banding, so the sides are clearly a built block rather than
    // natural rock.
    p.hLine(0, 0, 15, [146, 146, 150]);
    p.hLine(15, 0, 15, [92, 92, 96]);
    for (const y of [5, 10]) p.hLine(y, 0, 15, [104, 104, 108]);
    p.grain(8);
  },

  furnace_front(p) {
    TILE_PAINTERS.furnace_side(p);
    // A dark, empty firebox with a stone lintel above it.
    p.rect(3, 8, 10, 6, [40, 38, 38]);
    p.rect(4, 9, 8, 4, [26, 24, 24]);
    p.hLine(7, 3, 12, [118, 118, 122]);
    // Grate bars.
    for (const x of [5, 8, 11]) p.vLine(x, 9, 12, [58, 56, 56]);
  },

  furnace_front_lit(p) {
    TILE_PAINTERS.furnace_side(p);
    // The same firebox, filled with fire. Bright core, hotter at the base.
    p.rect(3, 8, 10, 6, [40, 38, 38]);
    p.rect(4, 9, 8, 4, [92, 32, 12]);
    p.hLine(12, 4, 11, [246, 196, 72]);
    p.hLine(11, 4, 11, [238, 148, 42]);
    p.hLine(10, 5, 10, [214, 96, 28]);
    // Irregular flame tips so it does not read as a flat orange rectangle.
    for (const x of [5, 7, 9, 11]) {
      p.set(x, 9, 244, 176, 60);
      if (x % 3 === 0) p.set(x, 8, 226, 130, 38);
    }
    p.hLine(7, 3, 12, [126, 118, 116]);
  },

  chest_top(p) {
    TILE_PAINTERS.planks(p);
    p.shade(0, 0, 16, 16, 0.95);
    // A lid rim plus the hinge line at the back.
    const edge = [84, 58, 32];
    p.rect(1, 1, 14, 1, edge);
    p.rect(1, 14, 14, 1, edge);
    p.vLine(1, 1, 14, edge);
    p.vLine(14, 1, 14, edge);
    p.hLine(3, 2, 13, [96, 68, 40]);
    p.grain(6);
  },

  chest_side(p) {
    TILE_PAINTERS.planks(p);
    p.shade(0, 0, 16, 16, 0.9);
    // The horizontal split between lid and body is what makes it a chest.
    const dark = [70, 48, 26];
    p.hLine(5, 0, 15, dark);
    p.hLine(6, 0, 15, [98, 70, 42]);
    p.hLine(0, 0, 15, [150, 112, 68]);
    p.hLine(15, 0, 15, dark);
    p.grain(6);
  },

  chest_front(p) {
    TILE_PAINTERS.chest_side(p);
    // A metal clasp centred on the split.
    const metal = [188, 168, 96];
    p.rect(7, 5, 3, 4, metal);
    p.set(8, 7, 96, 84, 44);
    p.rect(7, 4, 3, 1, [148, 132, 76]);
  },

  oak_sapling(p) {
    p.clear();
    // Thin stem with a small crown; cross-shaped blocks are drawn on
    // transparency, so most of the tile stays empty.
    p.vLine(8, 8, 15, [110, 84, 50]);
    const leaf = [86, 138, 62];
    const leafLight = [108, 164, 76];
    p.hLine(7, 6, 10, leaf);
    p.hLine(6, 5, 11, leaf);
    p.hLine(5, 6, 10, leafLight);
    p.hLine(4, 7, 9, leafLight);
    p.set(8, 3, leafLight[0], leafLight[1], leafLight[2]);
    p.grain(10);
  },

  glowstone(p) {
    p.fill(178, 140, 74).grain(12);
    p.blobs(8, 2.0, [246, 224, 132], 18);
    p.blobs(5, 1.1, [255, 246, 190], 10);
  },

  white_wool(p) {
    p.fill(238, 238, 240).grain(8);
    p.blobs(6, 2.2, [226, 226, 232], 6);
    p.blobs(4, 1.4, [248, 248, 252], 4);
  },

  mob_cow(p) {
    p.fill(110, 80, 52).grain(10);
    p.blobs(5, 2.8, [225, 220, 210], 12);
    p.blobs(2, 1.8, [60, 42, 28], 10);
  },

  mob_pig(p) {
    p.fill(235, 158, 158).grain(9);
    p.blobs(5, 2.2, [248, 182, 182], 8);
    p.blobs(3, 1.6, [212, 134, 134], 8);
  },

  mob_sheep(p) {
    p.fill(228, 226, 220).grain(10);
    p.blobs(6, 2.4, [210, 206, 198], 8);
    p.blobs(2, 2.0, [170, 150, 130], 10);
  },

  mob_chicken(p) {
    p.fill(242, 240, 232).grain(8);
    p.blobs(6, 1.8, [220, 215, 200], 10);
    p.blobs(3, 1.2, [180, 150, 110], 12);
    p.rect(7, 2, 2, 2, [210, 45, 45]);
  },

  mob_husk(p) {
    p.fill(130, 124, 96).grain(12);
    p.blobs(5, 2.2, [98, 92, 70], 12);
    p.blobs(3, 1.5, [158, 152, 120], 10);
  },

  mob_bonecaster(p) {
    p.fill(218, 214, 198).grain(10);
    p.blobs(4, 2.0, [180, 175, 160], 12);
    p.blobs(3, 1.5, [60, 55, 75], 14);
  },

  redstone_ore(p) {
    TILE_PAINTERS.stone(p);
    const bright = [196, 30, 30];
    const dark = [104, 12, 18];
    for (const [x, y] of [[2, 3], [5, 11], [9, 5], [13, 12], [12, 2], [2, 14]]) {
      p.rect(x, y, 2, 2, dark);
      p.set(x, y, bright[0], bright[1], bright[2]);
    }
  },

  lever_off(p) {
    p.clear();
    p.rect(4, 10, 8, 4, [104, 105, 110]);
    p.hLine(10, 4, 11, [152, 152, 156]);
    p.vLine(8, 4, 10, [118, 76, 42]);
    p.set(8, 3, 171, 118, 64);
  },

  lever_on(p) {
    p.clear();
    p.rect(4, 10, 8, 4, [104, 105, 110]);
    p.hLine(10, 4, 11, [152, 152, 156]);
    for (let i = 0; i < 6; i++) p.set(5 + i, 9 - i, 150, 96, 48);
    p.set(11, 3, 198, 142, 74);
  },

  redstone_torch(p) {
    p.clear();
    p.rect(7, 5, 2, 10, [112, 70, 38]);
    p.rect(6, 2, 4, 5, [196, 28, 30]);
    p.set(7, 2, 255, 116, 88);
    p.set(8, 3, 244, 72, 60);
  },

  redstone_torch_off(p) {
    p.clear();
    p.rect(7, 5, 2, 10, [100, 66, 40]);
    p.rect(6, 2, 4, 5, [72, 28, 32]);
    p.set(7, 3, 112, 42, 44);
  },

  redstone_lamp(p) {
    p.fill(58, 38, 24);
    for (let y = 1; y < 15; y += 4) {
      for (let x = 1; x < 15; x += 4) {
        p.rect(x, y, 3, 3, [82, 57, 30]);
        p.set(x + 1, y + 1, 112, 75, 35);
      }
    }
    p.hLine(0, 0, 15, [32, 24, 20]);
    p.vLine(0, 0, 15, [32, 24, 20]);
  },

  redstone_lamp_lit(p) {
    p.fill(116, 74, 28);
    for (let y = 1; y < 15; y += 4) {
      for (let x = 1; x < 15; x += 4) {
        p.rect(x, y, 3, 3, [228, 151, 49]);
        p.set(x + 1, y + 1, 255, 224, 126);
      }
    }
    p.hLine(0, 0, 15, [76, 43, 21]);
    p.vLine(0, 0, 15, [76, 43, 21]);
  },

  mob_lurker(p) {
    p.fill(42, 42, 48).grain(12);
    p.blobs(5, 2.2, [28, 28, 34], 10);
    p.blobs(4, 1.5, [72, 72, 82], 12);
    p.set(6, 4, 210, 35, 35);
    p.set(9, 4, 210, 35, 35);
    p.set(5, 5, 180, 30, 30);
    p.set(10, 5, 180, 30, 30);
  },
};

// ------------------------------------------------------- creature skin tiles
//
// Four tiles per creature instead of one, driven by `config/MobSkins.js`. The
// head tile carries a face in its middle; the border around that face is plain
// skin, which is what the back, sides and top of a head sample — so eyes cannot
// smear around the skull. Body tiles carry the marking pattern, limb tiles are
// darker with a hoof band, and accent tiles are the muzzle/beak/horn colour.

/** Scales a colour by `factor`, clamped to a byte. */
function tintColour(colour, factor) {
  return [
    clamp(Math.round(colour[0] * factor), 0, 255),
    clamp(Math.round(colour[1] * factor), 0, 255),
    clamp(Math.round(colour[2] * factor), 0, 255),
  ];
}

/** Perceived brightness, used to decide whether a face plate must be lighter. */
function colourLuma(colour) {
  return colour[0] * 0.299 + colour[1] * 0.587 + colour[2] * 0.114;
}

/**
 * Draws the marking pattern of a creature onto a tile.
 *
 * Every pattern is deliberately low-frequency: a 16x16 tile seen from ten blocks
 * away is a handful of screen pixels, so what has to read is the *pattern*, not
 * its detail. High-frequency noise would just alias into grey.
 *
 * @param {TilePainter} p
 * @param {import('../config/MobSkins.js').MobSkinStyle} style
 */
function paintMobPattern(p, style) {
  const base = style.base;
  const light = tintColour(base, 1.14);
  const dark = tintColour(base, 0.82);
  const deep = tintColour(base, 0.62);

  switch (style.pattern) {
    case 'wool':
      p.blobs(7, 2.1, light, 5);
      p.blobs(4, 1.5, dark, 5);
      break;
    case 'spots':
      p.blobs(4, 2.6, style.accent, 7);
      p.blobs(2, 1.5, deep, 7);
      break;
    case 'stripes':
      for (let x = 1; x < 16; x += 5) {
        p.rect(x, 0, 2, 16, deep, 255);
        p.vLine(x + 2, 0, 15, dark);
      }
      break;
    case 'feathers':
      for (let y = 1; y < 16; y += 3) {
        for (let x = (y % 6) - 2; x < 16; x += 3) {
          p.set(x, y, light[0], light[1], light[2]);
          p.set(x + 1, y + 1, dark[0], dark[1], dark[2]);
        }
      }
      break;
    case 'scales':
      for (let y = 1; y < 16; y += 3) {
        for (let x = (y % 6 === 1 ? 0 : 2); x < 16; x += 4) {
          p.rect(x, y, 2, 1, light);
          p.set(x + 1, y + 1, deep[0], deep[1], deep[2]);
        }
      }
      break;
    case 'bone':
      // Pale bone with dark seams: the lines matter more than the surface.
      for (const [x, y, horizontal] of [[2, 5, 1], [9, 3, 0], [4, 11, 1], [12, 9, 0]]) {
        if (horizontal) p.hLine(y, x, x + 4, dark);
        else p.vLine(x, y, y + 4, dark);
      }
      p.blobs(3, 1.3, light, 4);
      break;
    case 'rot':
      p.blobs(5, 2.2, tintColour(base, 0.72), 8);
      p.blobs(3, 1.4, [78, 44, 38], 8);
      p.blobs(2, 1.1, [52, 64, 44], 6);
      break;
    case 'slime':
      // A lighter, wetter core with a darker rim: reads as volume, not as noise.
      p.blobs(3, 3.1, tintColour(base, 1.2), 6);
      for (let i = 0; i < 10; i++) {
        const x = p.int(16);
        const y = p.int(16);
        p.set(x, y, deep[0], deep[1], deep[2]);
      }
      break;
    case 'cloth':
      // Belt and stitching: enough to read as a garment rather than a hide.
      p.rect(0, 10, 16, 2, deep);
      for (let x = 1; x < 16; x += 4) p.set(x, 10, light[0], light[1], light[2]);
      p.blobs(3, 1.8, dark, 5);
      break;
    case 'armour':
      p.hLine(0, 0, 15, light);
      p.rect(0, 4, 16, 1, dark);
      p.rect(0, 11, 16, 1, dark);
      for (const [x, y] of [[2, 2], [13, 2], [2, 9], [13, 9]]) p.rect(x, y, 1, 1, light);
      break;
    case 'glow':
      p.blobs(4, 2.4, tintColour(style.accent, 0.8), 10);
      p.blobs(3, 1.5, style.accent, 12);
      p.blobs(2, 0.9, [255, 240, 180], 10);
      break;
    case 'void':
      {
        const fleck = tintColour(style.accent, 1.8);
        p.blobs(3, 2.0, [42, 30, 58], 6);
        for (let i = 0; i < 5; i++) {
          p.set(p.int(16), p.int(16), fleck[0], fleck[1], fleck[2]);
        }
      }
      break;
    case 'fur':
    default:
      // Short vertical strokes: fur direction without high-frequency noise.
      for (let i = 0; i < 22; i++) {
        const x = p.int(16);
        const y = p.int(16);
        const colour = i % 3 === 0 ? light : dark;
        p.set(x, y, colour[0], colour[1], colour[2]);
        if (i % 4 === 0) p.set(x, y + 1, colour[0], colour[1], colour[2]);
      }
      break;
  }
}

/**
 * Draws the face inside the face region of a head tile.
 *
 * Feature placement is shared so every creature has eyes at roughly the same
 * height — which is what lets a player recognise "that is a face looking at me"
 * before they can resolve the species.
 *
 * @param {TilePainter} p
 * @param {import('../config/MobSkins.js').MobSkinStyle} style
 */
function paintMobFace(p, style) {
  const base = style.base;
  const eye = style.eye;
  const dark = tintColour(base, 0.6);
  // On dark hides a lighter plate separates the features; on pale hides a darker
  // one does. Without this, a sheep's white face and an enderman's black one
  // would both lose their eyes at night.
  const plateFactor = colourLuma(base) < 110 ? 1.22 : 0.9;
  const plate = tintColour(base, plateFactor);
  p.rect(4, 4, 8, 8, plate);

  const eyeCore = style.eyeGlow ? tintColour(eye, 1.25) : eye;

  switch (style.face) {
    case 'bird':
      p.rect(4, 5, 2, 2, eye);
      p.rect(10, 5, 2, 2, eye);
      if (!style.eyeGlow) p.set(4, 5, 255, 255, 255);
      // Beak: a triangle in the accent colour, narrowing downwards.
      p.rect(6, 8, 4, 2, style.accent);
      p.rect(7, 10, 2, 1, style.accent);
      p.hLine(8, 6, 9, tintColour(style.accent, 0.7));
      break;

    case 'skull':
      // Empty sockets, no catch-light: the absence of a glint is the point.
      p.rect(4, 6, 2, 3, [14, 12, 16]);
      p.rect(10, 6, 2, 3, [14, 12, 16]);
      p.rect(7, 9, 2, 2, [26, 22, 28]);
      p.hLine(12, 5, 10, dark);
      for (let x = 6; x <= 9; x += 2) p.rect(x, 12, 1, 1, [200, 196, 186]);
      if (style.eyeGlow) {
        p.set(5, 7, eyeCore[0], eyeCore[1], eyeCore[2]);
        p.set(11, 7, eyeCore[0], eyeCore[1], eyeCore[2]);
      }
      break;

    case 'insect':
      // Four eyes in two rows: instantly non-mammalian at any distance.
      p.rect(3, 5, 2, 2, eye);
      p.rect(11, 5, 2, 2, eye);
      p.set(6, 8, eyeCore[0], eyeCore[1], eyeCore[2]);
      p.set(9, 8, eyeCore[0], eyeCore[1], eyeCore[2]);
      p.rect(6, 11, 4, 1, dark);
      break;

    case 'slime':
      p.rect(4, 6, 2, 2, eye);
      p.rect(10, 6, 2, 2, eye);
      p.rect(5, 10, 6, 2, dark);
      p.rect(6, 11, 4, 1, tintColour(base, 1.25));
      break;

    case 'void':
      // Eyes only. A shape with no visible face beyond two points of light is
      // more unsettling than any amount of detail.
      p.rect(4, 6, 2, 2, eyeCore);
      p.rect(10, 6, 2, 2, eyeCore);
      p.set(4, 6, 255, 255, 255);
      p.set(11, 6, 255, 255, 255);
      break;

    case 'mask':
      // A flat, angular face: creeper-style. No catch-light, hard edges.
      p.rect(4, 6, 2, 2, eye);
      p.rect(10, 6, 2, 2, eye);
      p.rect(6, 9, 4, 2, eye);
      p.rect(5, 11, 2, 1, eye);
      p.rect(9, 11, 2, 1, eye);
      break;

    case 'humanoid':
      // Narrow eyes with a brow above them, plus a mouth line. This reads as a
      // person even in silhouette, which is what makes meeting one at night land.
      p.rect(4, 6, 2, 2, eyeCore);
      p.rect(10, 6, 2, 2, eyeCore);
      p.hLine(5, 3, 12, dark);
      p.hLine(10, 6, 9, dark);
      if (!style.eyeGlow) {
        p.set(4, 6, 255, 255, 255);
        p.set(10, 6, 255, 255, 255);
      }
      break;

    case 'mammal':
    default:
      p.rect(4, 6, 2, 2, eyeCore);
      p.rect(10, 6, 2, 2, eyeCore);
      if (!style.eyeGlow) {
        p.set(4, 6, 255, 255, 255);
        p.set(10, 6, 255, 255, 255);
      }
      // Muzzle and nose sit low so the head still reads as a snout from the side.
      p.rect(5, 10, 6, 3, tintColour(style.accent, 1));
      p.rect(7, 9, 2, 1, dark);
      p.hLine(12, 6, 9, dark);
      break;
  }
}

/**
 * Paints one atlas tile of a creature skin.
 *
 * @param {TilePainter} p
 * @param {import('../config/MobSkins.js').MobSkinStyle} style
 * @param {'head'|'body'|'limb'|'accent'} role
 */
function paintMobSkinTile(p, style, role) {
  if (role === 'accent') {
    // Extremities: muzzle, beak, horn, hoof. Slight grain so it is not a flat
    // colour patch, and a dark edge along the bottom that reads as an underside.
    p.fill(style.accent[0], style.accent[1], style.accent[2]).grain(7);
    p.shade(0, 0, 16, 3, 1.08);
    p.shade(0, 13, 16, 3, 0.82);
    return;
  }

  const baseFactor = role === 'limb' ? 0.84 : 1;
  const base = tintColour(style.base, baseFactor);
  p.fill(base[0], base[1], base[2]).grain(role === 'limb' ? 7 : 10);

  // Vertical falloff. Cheap, and it stops every box from looking like a decal.
  p.shade(0, 0, 16, 2, 1.08);
  p.shade(0, 13, 16, 3, 0.9);

  paintMobPattern(p, style);

  if (role === 'head') {
    paintMobFace(p, style);
  } else if (role === 'limb') {
    // A darker band at the bottom of a limb: hoof, paw or hand.
    const band = tintColour(style.accent, 0.9);
    p.rect(0, 12, 16, 3, band);
    p.hLine(12, 0, 15, tintColour(band, 0.7));
  }
}

for (const [mobId, style] of Object.entries(MOB_SKIN_STYLES)) {
  for (const role of MOB_SKIN_ROLES) {
    TILE_PAINTERS[mobSkinTileName(mobId, role)] = (p) => paintMobSkinTile(p, style, role);
  }
}


/** Paints one crop's age-dependent crossed-plant tile. */
function paintCropStage(p, crop, stage) {
  p.clear();
  const age = Math.max(0, Math.min(7, stage));
  const top = 14 - Math.round((age / 7) * 10);
  const stem = crop === 'wheat' ? [104, 142, 54] : [64, 132, 54];
  const leaf = crop === 'wheat' ? [126, 160, 60] : crop === 'carrot' ? [74, 154, 62] : [82, 142, 66];
  const light = crop === 'wheat' ? [154, 184, 72] : [104, 176, 78];

  const stems = age < 2 ? [8] : age < 5 ? [5, 9, 12] : [3, 6, 9, 12];
  for (let index = 0; index < stems.length; index++) {
    const x = stems[index];
    const offset = (index & 1) && age > 2 ? 1 : 0;
    p.vLine(x, top + offset, 15, stem);
    if (age >= 1) {
      const leafY = Math.min(14, top + 4 + (index % 2));
      p.set(x - 1, leafY, leaf[0], leaf[1], leaf[2]);
      p.set(x - 2, leafY - 1, light[0], light[1], light[2]);
    }
    if (age >= 3) {
      const leafY = Math.min(13, top + 7);
      p.set(x + 1, leafY, leaf[0], leaf[1], leaf[2]);
      p.set(x + 2, leafY - 1, light[0], light[1], light[2]);
    }

    if (crop === 'wheat' && age >= 5) {
      const gold = age === 7 ? [224, 184, 74] : [184, 170, 70];
      p.rect(x - 1, top, 3, Math.min(4, age - 3), gold);
      p.set(x - 2, top + 1, gold[0], gold[1], gold[2]);
      p.set(x + 2, top + 2, gold[0], gold[1], gold[2]);
    }
  }

  // Mature root crops develop a dense crown rather than a tall grain head.
  if (crop !== 'wheat' && age >= 5) {
    for (let x = 2; x <= 13; x += 2) {
      const y = 8 + ((x + age) % 3);
      p.set(x, y, light[0], light[1], light[2]);
      p.set(x + 1, y + 1, leaf[0], leaf[1], leaf[2]);
    }
  }
}

/** Paints the signal-strength version of a redstone wire cross. */
function paintRedstoneWire(p, power) {
  p.clear();
  const strength = Math.max(0, Math.min(15, power)) / 15;
  const red = Math.round(72 + strength * 183);
  const green = Math.round(8 + strength * 44);
  const blue = Math.round(12 + strength * 20);
  const colour = [red, green, blue];
  p.rect(6, 6, 4, 4, colour);
  p.rect(7, 0, 2, 16, colour);
  p.rect(0, 7, 16, 2, colour);
  if (power > 0) {
    p.set(7, 7, 255, Math.min(150, green + 55), Math.min(120, blue + 50));
    p.set(8, 8, 226, green + 20, blue + 16);
  }
}

/** Paints an oriented repeater; the atlas carries rotation, not the mesher. */
function paintRepeater(p, facing, powered) {
  p.fill(174, 174, 166).grain(7);
  p.rect(1, 1, 14, 14, [203, 202, 193]);
  p.hLine(1, 1, 14, [236, 235, 226]);
  p.vLine(1, 1, 14, [236, 235, 226]);
  p.hLine(14, 1, 14, [116, 116, 112]);
  p.vLine(14, 1, 14, [116, 116, 112]);

  const colour = powered ? [244, 48, 42] : [96, 20, 24];
  const rotate = (x, y) => {
    switch (facing) {
      case 'west': return [y, 15 - x];
      case 'north': return [15 - x, 15 - y];
      case 'east': return [15 - y, x];
      default: return [x, y];
    }
  };
  const pixel = (x, y, c = colour) => {
    const [rx, ry] = rotate(x, y);
    p.set(rx, ry, c[0], c[1], c[2]);
  };

  // Arrow points toward the output side (south in the unrotated tile).
  for (let y = 4; y <= 11; y++) pixel(7, y);
  pixel(6, 10); pixel(8, 10); pixel(5, 9); pixel(9, 9);
  for (const [x, y] of [[4, 5], [10, 5]]) {
    pixel(x, y, powered ? [255, 104, 80] : [126, 36, 40]);
    pixel(x, y + 1);
  }
}

for (let power = 0; power <= 15; power++) {
  TILE_PAINTERS[`redstone_wire_${power}`] = (p) => paintRedstoneWire(p, power);
}

for (const facing of ['south', 'west', 'north', 'east']) {
  TILE_PAINTERS[`repeater_${facing}_off`] = (p) => paintRepeater(p, facing, false);
  TILE_PAINTERS[`repeater_${facing}_on`] = (p) => paintRepeater(p, facing, true);
}

for (const crop of ['wheat', 'carrot', 'potato']) {
  for (let stage = 0; stage <= 7; stage++) {
    TILE_PAINTERS[`${crop}_stage_${stage}`] = (p) => paintCropStage(p, crop, stage);
  }
}

for (const material of ['leather', 'gold', 'iron', 'diamond', 'netherite']) {
  for (const slot of ['helmet', 'chestplate', 'leggings', 'boots']) {
    TILE_PAINTERS[`${material}_${slot}`] = (p) => armourIcon(p, slot, ARMOUR_MATERIALS[material]);
  }
}

for (const name of TILE_NAMES.filter((tile) => tile.startsWith('mob_'))) {
  if (TILE_PAINTERS[name]) continue;
  TILE_PAINTERS[name] = (p) => {
    let hash = 2166136261;
    for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const base = [72 + (hash & 127), 68 + ((hash >>> 8) & 127), 64 + ((hash >>> 16) & 127)];
    const light = base.map((value) => Math.min(240, value + 28));
    const dark = base.map((value) => Math.max(18, value - 38));
    p.fill(...base).grain(11);
    p.blobs(6, 2.2, light, 9);
    p.blobs(4, 1.5, dark, 11);
  };
}

for (const [colour, rgb] of Object.entries(COLOUR_BLOCK_PALETTES)) {
  for (const kind of ['wool', 'concrete', 'terracotta', 'stained_glass']) {
    const name = `${colour}_${kind}`;
    if (TILE_PAINTERS[name]) continue;
    TILE_PAINTERS[name] = (p) => {
      if (kind === 'stained_glass') {
        p.clear();
        p.rect(0, 0, 16, 16, rgb, 82);
        p.hLine(0, 0, 15, rgb);
        p.hLine(15, 0, 15, rgb);
        p.vLine(0, 0, 15, rgb);
        p.vLine(15, 0, 15, rgb);
        p.blobs(5, 1.2, rgb.map((value) => Math.min(255, value + 25)), 18);
      } else if (kind === 'terracotta') {
        p.fill(...rgb.map((value) => Math.round(value * 0.72))).grain(9);
        p.blobs(5, 2, rgb.map((value) => Math.round(value * 0.62)), 6);
      } else if (kind === 'wool') {
        p.fill(...rgb).grain(8);
        p.blobs(7, 2.1, rgb.map((value) => Math.max(0, value - 16)), 7);
      } else {
        p.fill(...rgb).grain(4);
        p.blobs(4, 1.4, rgb.map((value) => Math.min(255, value + 10)), 5);
      }
    };
  }
}

for (const name of [
  'enchanting_table','anvil','grindstone','smithing_table','brewing_stand',
  'piston','sticky_piston','hopper','dispenser','dropper','rail','powered_rail',
]) {
  if (TILE_PAINTERS[name]) continue;
  TILE_PAINTERS[name] = (p) => {
    let hash = 0;
    for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 0x45d9f3b) >>> 0;
    const metal = /anvil|hopper|rail|piston|dispenser|dropper/.test(name);
    const base = metal ? [92, 96, 101] : [92 + (hash & 31), 68 + ((hash >>> 8) & 35), 50 + ((hash >>> 16) & 28)];
    p.fill(...base).grain(12);
    p.rect(2, 2, 12, 12, base.map((v) => Math.min(220, v + 28)));
    p.hLine(2, 2, 13, [205, 205, 194]);
    p.vLine(2, 2, 13, [205, 205, 194]);
    p.hLine(13, 2, 13, base.map((v) => Math.max(12, v - 35)));
    p.vLine(13, 2, 13, base.map((v) => Math.max(12, v - 35)));
    if (/powered|enchanting|brewing/.test(name)) p.blobs(4, 1.3, [190, 45, 58], 12);
  };
}

// ------------------------------------------------ block family materials

/**
 * Palettes for the wood and stone families expanded by `BlockFamily.js`.
 *
 * One palette per family rather than one painter per tile: thirteen wood
 * variants all sample the same three colours, so a new wood type is a palette
 * entry, not thirteen hand-painted textures.
 */
const WOOD_PALETTES = {
  oak: { planks: [158, 122, 78], bark: [[86, 66, 38], [110, 85, 50]], stripped: [176, 141, 92] },
  spruce: { planks: [114, 84, 48], bark: [[58, 40, 22], [82, 58, 32]], stripped: [154, 118, 74] },
  birch: { planks: [192, 175, 121], bark: [[216, 214, 208], [166, 164, 152]], stripped: [196, 176, 121] },
  jungle: { planks: [160, 115, 81], bark: [[85, 67, 42], [107, 86, 54]], stripped: [171, 132, 84] },
  acacia: { planks: [168, 90, 50], bark: [[103, 96, 86], [76, 70, 62]], stripped: [202, 106, 60] },
  dark_oak: { planks: [66, 43, 20], bark: [[60, 46, 26], [44, 33, 18]], stripped: [79, 62, 36] },
  mangrove: { planks: [117, 54, 48], bark: [[77, 44, 40], [56, 32, 30]], stripped: [183, 96, 71] },
};

/** Base colour per stone family; polished and brick variants derive from it. */
const STONE_PALETTES = {
  granite: [149, 103, 86],
  diorite: [207, 207, 209],
  andesite: [136, 136, 136],
  deepslate: [77, 77, 82],
  tuff: [108, 112, 100],
  calcite: [223, 224, 219],
};

/** Four horizontal boards with a dark seam, tinted to the family palette. */
function paintFamilyPlanks(p, base) {
  p.fill(base[0], base[1], base[2]);
  for (let row = 0; row < 4; row++) {
    const y = row * 4;
    const shift = p.int(18) - 6;
    for (let dy = 0; dy < 4; dy++) {
      for (let x = 0; x < 16; x++) {
        const grainShift = p.next() > 0.82 ? -16 : p.int(9) - 4;
        const k = shift + grainShift;
        p.set(x, y + dy, base[0] + k, base[1] + k, base[2] + k);
      }
    }
    p.hLine(y, 0, 15, [base[0] * 0.66, base[1] * 0.66, base[2] * 0.66]);
  }
}

/** Bark, reusing the striping helper every existing log side already uses. */
function paintFamilyLog(p, palette) {
  p.fill(palette.bark[1][0], palette.bark[1][1], palette.bark[1][2]).grain(9);
  barkColumns(p, palette.bark[0], palette.bark[1]);
}

/** Stripped log: the bark gone, leaving smoother vertical heartwood grain. */
function paintStrippedLog(p, base) {
  p.fill(base[0], base[1], base[2]).grain(10);
  for (let x = 0; x < 16; x++) {
    if (p.next() > 0.35) continue;
    const k = p.next() > 0.5 ? -18 : 14;
    p.vLine(x, 0, 15, [base[0] + k, base[1] + k, base[2] + k]);
  }
}

/** Rough natural stone, mirroring the vanilla `stone` painter's structure. */
function paintFamilyStone(p, base) {
  p.fill(base[0], base[1], base[2]).grain(14);
  p.blobs(4, 2.4, [base[0] - 16, base[1] - 16, base[2] - 16], 8);
  p.blobs(3, 1.6, [base[0] + 16, base[1] + 16, base[2] + 16], 8);
}

/** Polished: near-flat with a lit top-left and shaded bottom-right bevel. */
function paintPolishedStone(p, base) {
  p.fill(base[0], base[1], base[2]).grain(4);
  p.hLine(0, 0, 15, [base[0] + 18, base[1] + 18, base[2] + 18]);
  p.vLine(0, 0, 15, [base[0] + 12, base[1] + 12, base[2] + 12]);
  p.hLine(15, 0, 15, [base[0] - 20, base[1] - 20, base[2] - 20]);
  p.vLine(15, 0, 15, [base[0] - 16, base[1] - 16, base[2] - 16]);
}

/** Running-bond brickwork in the family colour over darker mortar. */
function paintFamilyBricks(p, base) {
  p.fill(base[0] * 0.72, base[1] * 0.72, base[2] * 0.72);
  for (let row = 0; row < 4; row++) {
    const y = row * 4 + 1;
    const offset = row % 2 === 0 ? 0 : 4;
    for (let column = 0; column < 2; column++) {
      const x = offset + column * 8;
      const shift = p.int(20) - 10;
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 7; dx++) {
          const k = shift + p.int(7) - 3;
          p.set((x + dx) % 16, y + dy, base[0] + k, base[1] + k, base[2] + k);
        }
      }
    }
  }
}

for (const [wood, palette] of Object.entries(WOOD_PALETTES)) {
  // Oak's planks tile predates the families and keeps its original name.
  if (wood !== 'oak') {
    TILE_PAINTERS[`${wood}_planks`] = (p) => paintFamilyPlanks(p, palette.planks);
  }
  // Oak, spruce and birch log sides already ship; never overwrite them.
  const logTile = `${wood}_log_side`;
  if (!TILE_PAINTERS[logTile]) TILE_PAINTERS[logTile] = (p) => paintFamilyLog(p, palette);
  TILE_PAINTERS[`stripped_${wood}_log_side`] = (p) => paintStrippedLog(p, palette.stripped);
}

for (const [stone, base] of Object.entries(STONE_PALETTES)) {
  TILE_PAINTERS[stone] = (p) => paintFamilyStone(p, base);
  TILE_PAINTERS[`polished_${stone}`] = (p) => paintPolishedStone(p, base);
  TILE_PAINTERS[`${stone}_bricks`] = (p) => paintFamilyBricks(p, base);
}

// ----------------------------------------------------------- Phase 4: Nether
//
// Nether tiles reuse the Overworld family painters wherever the shape is the
// same, so crimson and warped wood are the same quality as oak rather than a
// second-class imitation. Shapes that do not exist in the Overworld -- columnar
// basalt, fluted pillars, fungi, hanging vines, the portal -- get real painters
// below. Palettes are imported from `NetherBlocks.js`, which is also what the
// block definitions were built from, so a texture and its block can never
// disagree about what colour a family is.

for (const [family, palette] of Object.entries(NETHER_WOOD_PALETTES)) {
  TILE_PAINTERS[`${family}_planks`] = (p) => paintFamilyPlanks(p, palette.planks);
  TILE_PAINTERS[`${family}_stem`] = (p) => paintFamilyLog(p, palette);
  TILE_PAINTERS[`stripped_${family}_stem`] = (p) => paintStrippedLog(p, palette.stripped);
  TILE_PAINTERS[`${family}_stem_top`] = (p) => woodRings(p, palette.stripped, palette.bark[0]);
}

/** Shorthand for the Nether stone palette table. */
const NP = NETHER_STONE_PALETTES;

/** Scales a colour by a factor and clamps it back into a byte. */
function netherShade(colour, factor) {
  return [
    Math.max(0, Math.min(255, Math.round(colour[0] * factor))),
    Math.max(0, Math.min(255, Math.min(255, Math.round(colour[1] * factor)))),
    Math.max(0, Math.min(255, Math.round(colour[2] * factor))),
  ];
}

// Families whose shape already has a painter.
TILE_PAINTERS.nether_bricks = (p) => paintFamilyBricks(p, NP.nether_bricks);
TILE_PAINTERS.red_nether_bricks = (p) => paintFamilyBricks(p, NP.red_nether_bricks);
TILE_PAINTERS.polished_blackstone_bricks = (p) => paintFamilyBricks(p, NP.polished_blackstone_bricks);
TILE_PAINTERS.quartz_bricks = (p) => paintFamilyBricks(p, NP.quartz_bricks);
TILE_PAINTERS.blackstone = (p) => paintFamilyStone(p, NP.blackstone);
TILE_PAINTERS.polished_blackstone = (p) => paintPolishedStone(p, NP.polished_blackstone);
TILE_PAINTERS.quartz_block = (p) => paintPolishedStone(p, NP.quartz_block);
TILE_PAINTERS.smooth_quartz = (p) => paintPolishedStone(p, NP.smooth_quartz);
TILE_PAINTERS.smooth_basalt = (p) => paintFamilyStone(p, NP.smooth_basalt);

/** Ordinary brickwork with a few split faces. */
TILE_PAINTERS.cracked_nether_bricks = (p) => {
  paintFamilyBricks(p, NP.cracked_nether_bricks);
  const crack = netherShade(NP.cracked_nether_bricks, 0.4);
  for (let i = 0; i < 5; i++) {
    let x = 1 + p.int(14);
    let y = 1 + p.int(12);
    const length = 4 + p.int(6);
    for (let step = 0; step < length; step++) {
      p.set(x, y, crack[0], crack[1], crack[2]);
      x += p.int(3) - 1;
      y += 1;
      if (x < 0 || x > 15 || y > 15) break;
    }
  }
};

/** A framed, inset panel: the shared base of the chiseled variants. */
function chiseledPanel(p, base) {
  const light = netherShade(base, 1.16);
  const dark = netherShade(base, 0.64);
  p.fill(base[0], base[1], base[2]).grain(6);
  // Outer frame, lit from the top-left as everything else in the atlas is.
  p.hLine(15, 0, 15, light);
  p.vLine(0, 0, 15, light);
  p.hLine(0, 0, 15, dark);
  p.vLine(15, 0, 15, dark);
  // Inset recess one step in.
  p.hLine(12, 3, 12, light);
  p.vLine(3, 3, 12, light);
  p.hLine(3, 3, 12, dark);
  p.vLine(12, 3, 12, dark);
}

TILE_PAINTERS.chiseled_nether_bricks = (p) => {
  chiseledPanel(p, NP.nether_bricks);
  const emblem = netherShade(NP.nether_bricks, 0.52);
  p.hLine(8, 6, 9, emblem);
  p.vLine(7, 6, 9, emblem);
  p.vLine(8, 6, 9, emblem);
};

TILE_PAINTERS.chiseled_quartz_block = (p) => {
  chiseledPanel(p, NP.quartz_block);
  const emblem = netherShade(NP.quartz_block, 0.8);
  // A centred diamond, drawn as two widening runs of rows.
  for (let i = 0; i < 4; i++) p.hLine(6 + i, 8 - i, 7 + i, emblem);
  for (let i = 0; i < 4; i++) p.hLine(13 - i, 8 - i, 7 + i, emblem);
};

/** Vertical fluting for a pillar's side faces. */
function pillarFluting(p, base) {
  const light = netherShade(base, 1.12);
  const dark = netherShade(base, 0.78);
  p.fill(base[0], base[1], base[2]).grain(5);
  for (let x = 1; x < 15; x += 4) {
    p.vLine(x, 0, 15, dark);
    p.vLine(x + 1, 0, 15, light);
  }
  p.hLine(0, 0, 15, dark);
  p.hLine(15, 0, 15, light);
}

/** Concentric cap for a pillar's top and bottom faces. */
function pillarCap(p, base) {
  const light = netherShade(base, 1.14);
  const dark = netherShade(base, 0.74);
  p.fill(base[0], base[1], base[2]).grain(5);
  p.hLine(13, 2, 13, light);
  p.vLine(2, 2, 13, light);
  p.hLine(2, 2, 13, dark);
  p.vLine(13, 2, 13, dark);
  p.hLine(9, 6, 9, light);
  p.vLine(6, 6, 9, light);
  p.hLine(6, 6, 9, dark);
  p.vLine(9, 6, 9, dark);
}

TILE_PAINTERS.quartz_pillar = (p) => pillarFluting(p, NP.quartz_block);
TILE_PAINTERS.quartz_pillar_top = (p) => pillarCap(p, NP.quartz_block);

/** Columnar basalt: tight vertical fractures running the full height. */
function columnarBasalt(p, base, contrast) {
  p.fill(base[0], base[1], base[2]).grain(10);
  const light = netherShade(base, 1 + contrast);
  const dark = netherShade(base, 1 - contrast);
  for (let x = 0; x < 16; x++) {
    if (p.next() > 0.58) continue;
    const colour = p.next() > 0.5 ? light : dark;
    let y = p.int(4);
    while (y < 16) {
      const length = 4 + p.int(7);
      for (let i = 0; i < length && y < 16; i++, y++) {
        p.set(x, y, colour[0], colour[1], colour[2]);
      }
      y += 1 + p.int(2);
    }
  }
}

/** Basalt end grain: the polygonal cells of a column seen end-on. */
function basaltCells(p, base) {
  p.fill(base[0], base[1], base[2]).grain(8);
  const edge = netherShade(base, 0.56);
  const face = netherShade(base, 1.14);
  // Three interlocking cells, drawn as explicit fracture lines.
  p.hLine(0, 0, 15, edge);
  p.hLine(7, 0, 15, edge);
  p.vLine(0, 0, 15, edge);
  p.vLine(9, 8, 15, edge);
  p.vLine(5, 0, 7, edge);
  p.hLine(12, 9, 15, edge);
  for (let i = 0; i < 12; i++) {
    p.set(p.int(16), p.int(16), face[0], face[1], face[2]);
  }
}

TILE_PAINTERS.basalt = (p) => columnarBasalt(p, NP.basalt, 0.16);
TILE_PAINTERS.basalt_top = (p) => basaltCells(p, NP.basalt);
TILE_PAINTERS.polished_basalt = (p) => columnarBasalt(p, NP.polished_basalt, 0.08);
TILE_PAINTERS.polished_basalt_top = (p) => basaltCells(p, NP.polished_basalt);

// ------------------------------------------------------- Nether natural stone

TILE_PAINTERS.netherrack = (p) => {
  p.fill(97, 43, 43).grain(14);
  p.blobs(7, 2.1, [122, 54, 54], 14);
  p.blobs(5, 1.2, [72, 30, 32], 10);
  // Fibrous horizontal striations, the feature that reads as netherrack.
  for (let i = 0; i < 7; i++) {
    const y = p.int(16);
    const x = p.int(11);
    p.hLine(y, x, x + 3 + p.int(4), [70, 28, 30]);
  }
};

TILE_PAINTERS.soul_sand = (p) => {
  p.fill(84, 64, 56).grain(12);
  p.blobs(6, 2.0, [66, 50, 44], 10);
  // Two hollow faces pressed into the surface.
  const hollow = [44, 33, 30];
  p.hLine(10, 3, 5, hollow);
  p.hLine(10, 10, 12, hollow);
  p.hLine(5, 5, 10, hollow);
  p.set(6, 6, 40, 30, 27);
  p.set(9, 6, 40, 30, 27);
};

TILE_PAINTERS.soul_soil = (p) => {
  p.fill(76, 58, 50).grain(13);
  p.blobs(7, 2.2, [58, 44, 38], 10);
  p.blobs(4, 1.2, [94, 74, 64], 10);
};

TILE_PAINTERS.magma_block = (p) => {
  p.fill(58, 30, 22).grain(10);
  p.blobs(6, 2.4, [40, 20, 16], 8);
  // A crust broken by glowing veins.
  const glow = [232, 108, 30];
  const hot = [255, 176, 62];
  p.hLine(4, 1, 7, glow);
  p.vLine(7, 4, 9, glow);
  p.hLine(9, 7, 14, glow);
  p.vLine(3, 9, 14, glow);
  p.hLine(12, 3, 6, hot);
  p.set(8, 9, hot[0], hot[1], hot[2]);
};

TILE_PAINTERS.crimson_nylium = (p) => {
  TILE_PAINTERS.netherrack(p);
  p.blobs(9, 2.6, [126, 27, 33], 12);
  p.blobs(6, 1.4, [156, 40, 44], 10);
};

TILE_PAINTERS.warped_nylium = (p) => {
  TILE_PAINTERS.netherrack(p);
  p.blobs(9, 2.6, [23, 118, 114], 12);
  p.blobs(6, 1.4, [44, 148, 140], 10);
};

TILE_PAINTERS.nether_wart_block = (p) => {
  p.fill(114, 10, 18).grain(12);
  p.blobs(8, 2.2, [86, 6, 14], 10);
  p.blobs(6, 1.2, [146, 24, 32], 12);
};

TILE_PAINTERS.warped_wart_block = (p) => {
  p.fill(22, 120, 116).grain(12);
  p.blobs(8, 2.2, [14, 88, 88], 10);
  p.blobs(6, 1.2, [40, 152, 142], 12);
};

TILE_PAINTERS.shroomlight = (p) => {
  p.fill(240, 158, 62).grain(10);
  p.blobs(7, 2.2, [255, 206, 108], 14);
  p.blobs(5, 1.1, [206, 106, 34], 10);
  p.blobs(3, 0.8, [255, 240, 176], 8);
};

// --------------------------------------------------------------- Nether ores

TILE_PAINTERS.nether_quartz_ore = (p) => {
  TILE_PAINTERS.netherrack(p);
  p.blobs(4, 2.0, [226, 220, 210], 14);
  p.blobs(3, 1.1, [248, 245, 238], 8);
};

TILE_PAINTERS.nether_gold_ore = (p) => {
  TILE_PAINTERS.netherrack(p);
  p.blobs(5, 1.8, [230, 188, 70], 14);
  p.blobs(3, 1.0, [250, 218, 110], 8);
};

TILE_PAINTERS.gilded_blackstone = (p) => {
  paintFamilyStone(p, NP.blackstone);
  p.blobs(4, 1.6, [220, 176, 62], 12);
  p.blobs(3, 0.9, [246, 210, 108], 8);
};

TILE_PAINTERS.ancient_debris = (p) => {
  p.fill(66, 46, 44).grain(12);
  p.blobs(6, 2.4, [46, 32, 32], 10);
  // Netherite scroll-work: the visual promise of the best gear in the game.
  const trim = [120, 88, 84];
  p.hLine(5, 3, 12, trim);
  p.hLine(10, 3, 12, trim);
  p.vLine(3, 5, 10, trim);
  p.vLine(12, 5, 10, trim);
  p.set(7, 7, 152, 116, 110);
  p.set(8, 8, 152, 116, 110);
};

TILE_PAINTERS.netherite_block = (p) => {
  p.fill(66, 60, 64).grain(10);
  p.blobs(7, 2.2, [48, 42, 46], 10);
  p.blobs(5, 1.2, [92, 82, 88], 12);
  p.hLine(3, 2, 13, [110, 98, 104]);
  p.hLine(12, 2, 13, [110, 98, 104]);
};

TILE_PAINTERS.crying_obsidian = (p) => {
  TILE_PAINTERS.obsidian(p);
  // Weeping veins. This is the one light source obtainable before glowstone.
  const tear = [92, 44, 214];
  const bright = [150, 108, 246];
  p.vLine(4, 6, 13, tear);
  p.vLine(11, 3, 9, tear);
  p.set(4, 5, bright[0], bright[1], bright[2]);
  p.set(11, 2, bright[0], bright[1], bright[2]);
  p.blobs(3, 1.1, tear, 10);
};

// ------------------------------------------------------ Nether special shapes

/** The portal interior: a translucent violet churn. */
TILE_PAINTERS.nether_portal = (p) => {
  p.fill(88, 22, 148, 205).grain(16);
  p.blobs(8, 2.6, [128, 44, 196], 22);
  p.blobs(6, 1.5, [176, 96, 226], 18);
  p.blobs(4, 0.9, [214, 160, 246], 12);
};

/**
 * Soul fire: the same flame silhouette as ordinary fire, remapped to a cold
 * palette by swapping the red and blue channels. Reusing `fireTile` keeps the
 * two fires animating identically instead of drifting apart.
 */
function coolFlame(p) {
  fireTile(p);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const [r, g, b, a] = p.get(x, y);
      if (a === 0) continue;
      p.set(x, y, Math.round(b * 0.85), Math.round(g * 0.92), r, a);
    }
  }
}
TILE_PAINTERS.soul_fire = coolFlame;

/** Two interlocking links running the height of the tile. */
TILE_PAINTERS.chain = (p) => {
  p.clear();
  const dark = [58, 58, 66];
  const light = [128, 130, 142];
  for (let y = 0; y < 16; y++) {
    const front = y % 8 < 4 ? 7 : 8;
    const back = front === 7 ? 8 : 7;
    p.set(front, y, light[0], light[1], light[2]);
    p.set(back, y, dark[0], dark[1], dark[2]);
  }
  for (let y = 1; y < 15; y += 8) {
    p.set(6, y + 1, dark[0], dark[1], dark[2]);
    p.set(9, y + 1, dark[0], dark[1], dark[2]);
  }
};

/** A hanging lantern: metal cage, bail above, glowing core. */
function lanternTile(p, glow, hot) {
  p.clear();
  const metal = [96, 84, 66];
  const metalDark = [58, 50, 40];
  // Bail and chain stub.
  p.vLine(8, 13, 15, metalDark);
  p.hLine(12, 6, 9, metal);
  // Cage body with a lit interior.
  for (let y = 4; y <= 11; y++) {
    for (let x = 5; x <= 10; x++) {
      const edge = x === 5 || x === 10 || y === 4 || y === 11;
      const colour = edge ? metal : glow;
      p.set(x, y, colour[0], colour[1], colour[2]);
    }
  }
  // Bright core and two cage bars.
  p.vLine(7, 6, 9, hot);
  p.vLine(8, 6, 9, hot);
  p.vLine(6, 5, 10, metalDark);
  p.vLine(9, 5, 10, metalDark);
  // Base plate.
  p.hLine(3, 5, 10, metalDark);
}
TILE_PAINTERS.lantern = (p) => lanternTile(p, [240, 176, 74], [255, 232, 150]);
TILE_PAINTERS.soul_lantern = (p) => lanternTile(p, [74, 200, 214], [176, 246, 252]);

/** A small fungus: slender stem under a domed cap. */
function fungusTile(p, cap, capDark, stem) {
  p.clear();
  for (let y = 1; y <= 7; y++) {
    p.set(7, y, stem[0], stem[1], stem[2]);
    p.set(8, y, stem[0], stem[1], stem[2]);
  }
  const rows = [[8, 5, 10], [9, 4, 11], [10, 3, 12], [11, 3, 12], [12, 4, 11], [13, 5, 10]];
  for (const [y, x0, x1] of rows) p.hLine(y, x0, x1, cap);
  p.hLine(8, 5, 10, capDark);
  p.set(5, 11, capDark[0], capDark[1], capDark[2]);
  p.set(10, 12, capDark[0], capDark[1], capDark[2]);
}
TILE_PAINTERS.crimson_fungus = (p) => fungusTile(p, [176, 46, 46], [122, 26, 30], [156, 136, 122]);
TILE_PAINTERS.warped_fungus = (p) => fungusTile(p, [56, 172, 160], [30, 116, 112], [222, 208, 148]);

/** A low tuft of roots or sprouts rising from the bottom edge. */
function tuftTile(p, dark, light, height) {
  p.clear();
  for (let x = 1; x < 15; x += 2) {
    const top = 1 + p.int(height);
    const colour = p.next() > 0.5 ? dark : light;
    for (let y = 0; y <= top; y++) p.set(x, y, colour[0], colour[1], colour[2]);
    if (top > 2) {
      const lean = p.next() > 0.5 ? 1 : -1;
      const bx = x + lean;
      if (bx >= 0 && bx <= 15) p.set(bx, top, light[0], light[1], light[2]);
    }
  }
}
TILE_PAINTERS.crimson_roots = (p) => tuftTile(p, [126, 20, 44], [176, 40, 68], 7);
TILE_PAINTERS.warped_roots = (p) => tuftTile(p, [20, 118, 112], [44, 168, 150], 7);
TILE_PAINTERS.nether_sprouts = (p) => tuftTile(p, [26, 138, 128], [70, 190, 172], 6);

/** Vines, hanging from the ceiling when `fromTop`, climbing when not. */
function vineTile(p, dark, light, fromTop) {
  p.clear();
  for (let x = 2; x < 15; x += 4) {
    const length = 8 + p.int(7);
    const colour = p.next() > 0.5 ? dark : light;
    for (let i = 0; i < length; i++) {
      const y = fromTop ? 15 - i : i;
      if (y < 0 || y > 15) break;
      const wobble = (((i / 4) | 0) % 2) === 0 ? 0 : 1;
      const px = x + wobble;
      if (px > 15) continue;
      p.set(px, y, colour[0], colour[1], colour[2]);
      if (i % 5 === 2 && px + 1 <= 15) p.set(px + 1, y, light[0], light[1], light[2]);
    }
  }
}
TILE_PAINTERS.weeping_vines = (p) => vineTile(p, [122, 16, 32], [166, 32, 52], true);
TILE_PAINTERS.twisting_vines = (p) => vineTile(p, [22, 122, 116], [48, 168, 156], false);

/** Nether wart: three stalks carrying clustered pods. */
TILE_PAINTERS.nether_wart = (p) => {
  p.clear();
  const stem = [96, 26, 40];
  const pod = [148, 32, 46];
  const podLight = [186, 56, 66];
  for (const x of [4, 8, 11]) {
    const top = 5 + p.int(5);
    for (let y = 0; y <= top; y++) p.set(x, y, stem[0], stem[1], stem[2]);
    p.set(x, top, pod[0], pod[1], pod[2]);
    p.set(x - 1, top - 1, pod[0], pod[1], pod[2]);
    p.set(x + 1, top - 1, podLight[0], podLight[1], podLight[2]);
    p.set(x, top - 2, podLight[0], podLight[1], podLight[2]);
  }
};

// ---------------------------------------------------------------- paint helpers

/** Vertical bark striping shared by every log side. */
function barkColumns(painter, dark, light) {
  for (let x = 0; x < 16; x++) {
    if (painter.next() > 0.62) continue;
    const colour = painter.next() > 0.5 ? dark : light;
    let y = painter.int(6);
    while (y < 16) {
      const length = 3 + painter.int(6);
      for (let i = 0; i < length && y < 16; i++, y++) painter.set(x, y, colour[0], colour[1], colour[2]);
      y += 1 + painter.int(3);
    }
  }
}

/** Concentric growth rings for a log's end grain. */
function woodRings(painter, lightColour, darkColour) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const distance = Math.hypot(x - 7.5, y - 7.5);
      const ring = Math.sin(distance * 2.1) * 0.5 + 0.5;
      const mix = ring * 0.75 + painter.next() * 0.25;
      painter.set(
        x,
        y,
        lightColour[0] * mix + darkColour[0] * (1 - mix),
        lightColour[1] * mix + darkColour[1] * (1 - mix),
        lightColour[2] * mix + darkColour[2] * (1 - mix)
      );
    }
  }
  // Bark rim.
  for (let x = 0; x < 16; x++) {
    painter.set(x, 0, darkColour[0] * 0.7, darkColour[1] * 0.7, darkColour[2] * 0.7);
    painter.set(x, 15, darkColour[0] * 0.7, darkColour[1] * 0.7, darkColour[2] * 0.7);
    painter.set(0, x, darkColour[0] * 0.7, darkColour[1] * 0.7, darkColour[2] * 0.7);
    painter.set(15, x, darkColour[0] * 0.7, darkColour[1] * 0.7, darkColour[2] * 0.7);
  }
}

/**
 * Leaf canopy: clumped foliage with punched-through holes.
 * The holes are what make a tree read as a tree rather than a green cube, and
 * they are why leaves render on the cutout layer.
 */
function leaves(painter, darkColour, lightColour, holeChance) {
  painter.clear();
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      // Two overlapping sine fields make irregular clumps that still tile.
      const clump =
        Math.sin(x * 1.1 + y * 0.7) * 0.5 + Math.sin(x * 0.5 - y * 1.3) * 0.5 + painter.next() * 0.6;
      if (painter.next() < holeChance && clump < 0.35) continue;
      const mix = clamp(clump * 0.5 + 0.5, 0, 1);
      const shift = painter.int(18) - 9;
      painter.set(
        x,
        y,
        darkColour[0] * (1 - mix) + lightColour[0] * mix + shift,
        darkColour[1] * (1 - mix) + lightColour[1] * mix + shift,
        darkColour[2] * (1 - mix) + lightColour[2] * mix + shift,
        255
      );
    }
  }
}

/** A stem with a small blossom on top. */
function flower(painter, petalColour, centreColour) {
  painter.clear();
  const stemX = 8;
  for (let y = 15; y >= 7; y--) {
    painter.set(stemX, y, 66, 116, 56, 255);
    if (y === 11) {
      painter.set(stemX - 1, y, 74, 128, 62, 255);
      painter.set(stemX - 2, y - 1, 74, 128, 62, 255);
    }
    if (y === 13) {
      painter.set(stemX + 1, y, 74, 128, 62, 255);
      painter.set(stemX + 2, y - 1, 74, 128, 62, 255);
    }
  }
  const petals = [
    [7, 4],
    [8, 4],
    [6, 5],
    [9, 5],
    [7, 6],
    [8, 6],
    [7, 3],
    [8, 3],
    [6, 4],
    [9, 4],
  ];
  for (const [x, y] of petals) {
    const shift = painter.int(24) - 12;
    painter.set(x, y, petalColour[0] + shift, petalColour[1] + shift, petalColour[2] + shift, 255);
  }
  painter.set(7, 5, centreColour[0], centreColour[1], centreColour[2], 255);
  painter.set(8, 5, centreColour[0], centreColour[1], centreColour[2], 255);
}

// ------------------------------------------------------------------ the atlas

export class TextureAtlas {
  /**
   * @param {import('../utils/DeviceDetector.js').DeviceCapabilities} capabilities
   */
  constructor(capabilities) {
    this._caps = capabilities;
    /** @type {HTMLCanvasElement|null} */
    this.canvas = null;
    /** @type {THREE.Texture|null} */
    this.texture = null;
    /** @type {Map<number, string>} Cached block icon data URLs. */
    this._iconCache = new Map();
    /** @type {Map<number, HTMLCanvasElement>} Per-tile 16x16 canvases. */
    this._tileCanvases = new Map();
  }

  /**
   * Paints the atlas and creates the GPU texture.
   * @returns {THREE.Texture}
   */
  build() {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_PIXELS;
    canvas.height = ATLAS_PIXELS;
    const context = canvas.getContext('2d', { willReadFrequently: false });
    if (!context) throw new Error('Could not obtain a 2D context to paint the texture atlas');

    // Magenta background: if a tile is ever missing it is glaringly obvious
    // rather than silently transparent.
    context.fillStyle = '#ff00ff';
    context.fillRect(0, 0, ATLAS_PIXELS, ATLAS_PIXELS);
    context.imageSmoothingEnabled = false;

    for (let tile = 0; tile < TILE_NAMES.length; tile++) {
      const name = TILE_NAMES[tile];
      const painter = new TilePainter(0x9e3779b1 ^ (tile * 0x85ebca6b));
      const paint = TILE_PAINTERS[name];
      if (!paint) throw new Error(`No painter registered for atlas tile "${name}"`);
      paint(painter);

      const tileCanvas = this._toCanvas(painter);
      this._tileCanvases.set(tile, tileCanvas);
      this._blitWithWrappedPadding(context, tileCanvas, tile);
    }

    this._neutraliseSpareCells(context);

    this.canvas = canvas;

    const texture = new THREE.Texture(canvas);
    // v increases downwards, matching `AtlasLayout`'s UV rects and canvas pixels.
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    this.texture = texture;

    return texture;
  }

  /** Copies a painter's pixels into a standalone 16x16 canvas. */
  _toCanvas(painter) {
    const canvas = document.createElement('canvas');
    canvas.width = painter.size;
    canvas.height = painter.size;
    const context = canvas.getContext('2d');
    const imageData = context.createImageData(painter.size, painter.size);
    imageData.data.set(painter.data);
    context.putImageData(imageData, 0, 0);
    return canvas;
  }

  /**
   * Overwrites the atlas cells that no declared tile occupies.
   *
   * The canvas starts life filled with magenta so a tile with no painter is
   * impossible to miss. That check is already enforced by the `throw` in
   * `build()`, which means the only magenta left after painting sits in the
   * *spare* cells at the end of the grid — and those are reachable by any UV
   * bug. The water shader used to drift into exactly this region and pin itself
   * there, which is what turned water pink.
   *
   * Repainting the spares in a dull slate keeps a genuine addressing mistake
   * visible (a uniform grey block is clearly wrong) while removing the failure
   * mode where a small UV error produces alarming full-saturation magenta.
   */
  _neutraliseSpareCells(context) {
    const total = ATLAS_COLUMNS * ATLAS_ROWS;
    if (TILE_NAMES.length >= total) return;

    context.save();
    context.globalCompositeOperation = 'source-over';
    context.fillStyle = '#2a2f3a';
    for (let tile = TILE_NAMES.length; tile < total; tile++) {
      const column = tile % ATLAS_COLUMNS;
      const row = Math.floor(tile / ATLAS_COLUMNS);
      const cellX = column * TILE_STRIDE;
      const cellY = row * TILE_STRIDE;
      context.clearRect(cellX, cellY, TILE_STRIDE, TILE_STRIDE);
      context.fillRect(cellX, cellY, TILE_STRIDE, TILE_STRIDE);
    }
    context.restore();
  }

  /**
   * Draws a tile into its cell and fills the padding by wrapping.
   *
   * The nine draws are clipped to the cell, so each cell's padding contains a
   * continuation of its own tile and never a neighbour's pixels.
   */
  _blitWithWrappedPadding(context, tileCanvas, tile) {
    const column = tile % ATLAS_COLUMNS;
    const row = Math.floor(tile / ATLAS_COLUMNS);
    const cellX = column * TILE_STRIDE;
    const cellY = row * TILE_STRIDE;
    const contentX = cellX + TILE_PADDING;
    const contentY = cellY + TILE_PADDING;

    // The cell must be cleared to transparent first. `drawImage` composites
    // source-over, so without this the magenta "missing tile" background would
    // show through every transparent pixel — turning the holes in leaves, the
    // gaps around plants and the middle of a glass pane into solid magenta
    // instead of transparency.
    context.clearRect(cellX, cellY, TILE_STRIDE, TILE_STRIDE);

    context.save();
    context.beginPath();
    context.rect(cellX, cellY, TILE_STRIDE, TILE_STRIDE);
    context.clip();
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        context.drawImage(tileCanvas, contentX + dx * TILE_PIXELS, contentY + dy * TILE_PIXELS);
      }
    }
    context.restore();
  }

  /**
   * Applies filtering settings to the texture.
   *
   * Nearest filtering is the default because the art is pixel art; enabling
   * mipmaps still uses nearest *within* a level so blocks stay crisp up close
   * while distant terrain stops shimmering.
   *
   * @param {Object} graphics The `graphics` settings group.
   */
  applySettings(graphics) {
    const texture = this.texture;
    if (!texture) return;

    const nearest = graphics.textureFiltering !== 'linear';
    const mipmaps = Boolean(graphics.mipmaps);

    texture.generateMipmaps = mipmaps;
    texture.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    if (mipmaps) {
      texture.minFilter = nearest ? THREE.NearestMipmapLinearFilter : THREE.LinearMipmapLinearFilter;
    } else {
      texture.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    }

    const maxAnisotropy = Math.max(1, Math.floor(this._caps.maxAnisotropy));
    texture.anisotropy = clamp(graphics.anisotropy, 1, maxAnisotropy);

    // Changing filtering or mipmap generation requires a re-upload.
    if (!mipmaps) texture.mipmaps = [];
    texture.needsUpdate = true;
  }

  /**
   * Renders an icon for any item.
   *
   * Items that place a block reuse `getBlockIcon`, so a stack of stone in the
   * inventory looks exactly like the block it becomes. Everything else — tools,
   * food, ingots — is a flat tile, which is how those are drawn anyway.
   *
   * @param {string} itemId
   * @param {number} [size] Output edge length in pixels.
   * @returns {string} A `data:` URL, or an empty string for an unknown item.
   */
  getItemIcon(itemId, size = 48) {
    const definition = getItem(itemId);
    if (!definition) return '';

    if (definition.placeableBlockId !== null) {
      return this.getBlockIcon(definition.placeableBlockId, size);
    }

    // Negative keys keep the item cache from colliding with the block cache,
    // which is keyed on `blockId * 1000 + size`.
    const cacheKey = -(definition.icon * 1000 + size);
    const cached = this._iconCache.get(cacheKey);
    if (cached) return cached;

    const tile = this._tileCanvases.get(definition.icon);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;
    if (tile) context.drawImage(tile, 0, 0, size, size);

    const url = canvas.toDataURL();
    this._iconCache.set(cacheKey, url);
    return url;
  }

  /**
   * Renders a small icon for a block, for the hotbar and inventory.
   *
   * Cube-shaped blocks get a 2.5D isometric composite of their top and side
   * tiles, which reads far better at 32 px than a flat square. Cross-shaped and
   * post-shaped blocks use their flat tile, since that *is* how they look.
   *
   * @param {number} blockId
   * @param {number} [size] Output edge length in pixels.
   * @returns {string} A `data:` URL.
   */
  getBlockIcon(blockId, size = 48) {
    const cacheKey = blockId * 1000 + size;
    const cached = this._iconCache.get(cacheKey);
    if (cached) return cached;

    const definition = getBlock(blockId);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.imageSmoothingEnabled = false;

    const topTile = this._tileCanvases.get(TILE_INDEX[definition.textureTop]);
    const sideTile = this._tileCanvases.get(TILE_INDEX[definition.textureSide]);

    if (RENDER_SHAPE[blockId] !== Shape.CUBE || !topTile || !sideTile) {
      const flat = sideTile || topTile;
      if (flat) context.drawImage(flat, 0, 0, size, size);
      const url = canvas.toDataURL();
      this._iconCache.set(cacheKey, url);
      return url;
    }

    // Isometric cube: top face as a rhombus, two side faces sheared.
    const half = size / 2;
    const quarter = size / 4;

    // Top face.
    drawParallelogram(
      context,
      topTile,
      [half, 0],
      [size, quarter],
      [half, half],
      [0, quarter],
      size,
      1
    );
    // Left face (darker).
    drawParallelogram(
      context,
      sideTile,
      [0, quarter],
      [half, half],
      [half, size],
      [0, size - quarter],
      size,
      0.72
    );
    // Right face (darkest).
    drawParallelogram(
      context,
      sideTile,
      [half, half],
      [size, quarter],
      [size, size - quarter],
      [half, size],
      size,
      0.55
    );

    const url = canvas.toDataURL();
    this._iconCache.set(cacheKey, url);
    return url;
  }

  /**
   * Returns the 16x16 HTMLCanvasElement for a given tile index.
   * @param {number} tileIndex
   * @returns {HTMLCanvasElement|null}
   */
  getTileCanvas(tileIndex) {
    return this._tileCanvases.get(tileIndex) ?? null;
  }

  /**
   * Returns a Three.js CanvasTexture for a single tile index.
   * @param {number} tileIndex
   * @returns {THREE.CanvasTexture|null}
   */
  getTileTexture(tileIndex) {
    const canvas = this._tileCanvases.get(tileIndex);
    if (!canvas) return null;
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** Releases the GPU texture and cached canvases. */
  dispose() {
    this.texture?.dispose();
    this.texture = null;
    this._tileCanvases.clear();
    this._iconCache.clear();
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas = null;
    }
  }
}

/**
 * Fills a quadrilateral with a tile, sampled per output pixel.
 *
 * Done by hand rather than with a canvas transform because a sheared
 * `drawImage` antialiases the edges, which destroys the pixel-art look. Bilinear
 * interpolation of the corner positions keeps the sampling nearest-neighbour.
 */
function drawParallelogram(context, tileCanvas, topLeft, topRight, bottomRight, bottomLeft, size, shade) {
  const source = tileCanvas.getContext('2d').getImageData(0, 0, tileCanvas.width, tileCanvas.height);
  const output = context.getImageData(0, 0, size, size);
  const steps = size * 2;

  for (let sy = 0; sy <= steps; sy++) {
    const v = sy / steps;
    for (let sx = 0; sx <= steps; sx++) {
      const u = sx / steps;
      // Bilinear position inside the quad.
      const left = [
        topLeft[0] + (bottomLeft[0] - topLeft[0]) * v,
        topLeft[1] + (bottomLeft[1] - topLeft[1]) * v,
      ];
      const right = [
        topRight[0] + (bottomRight[0] - topRight[0]) * v,
        topRight[1] + (bottomRight[1] - topRight[1]) * v,
      ];
      const x = Math.floor(left[0] + (right[0] - left[0]) * u);
      const y = Math.floor(left[1] + (right[1] - left[1]) * u);
      if (x < 0 || y < 0 || x >= size || y >= size) continue;

      const texelX = Math.min(tileCanvas.width - 1, Math.floor(u * tileCanvas.width));
      const texelY = Math.min(tileCanvas.height - 1, Math.floor(v * tileCanvas.height));
      const sourceIndex = (texelY * tileCanvas.width + texelX) * 4;
      const alpha = source.data[sourceIndex + 3];
      if (alpha === 0) continue;

      const destinationIndex = (y * size + x) * 4;
      output.data[destinationIndex] = source.data[sourceIndex] * shade;
      output.data[destinationIndex + 1] = source.data[sourceIndex + 1] * shade;
      output.data[destinationIndex + 2] = source.data[sourceIndex + 2] * shade;
      output.data[destinationIndex + 3] = alpha;
    }
  }
  context.putImageData(output, 0, 0);
}

export default TextureAtlas;

// ------------------------------------------------------------ Phase 5: The End
//
// The End's palette is deliberately narrow: pale yellow-green end stone and
// muted purple purpur. Both are low-contrast on purpose, so the bright cyan of
// an end rod and the magenta of a portal read as the only light in the dimension.

TILE_PAINTERS.end_stone = (p) => {
  p.fill(221, 223, 165).grain(10);
  // Faint mottling rather than the hard speckle of stone: end stone should look
  // like compacted dust, not granite.
  p.blobs(6, 2.6, [206, 208, 150], 8);
  p.blobs(4, 1.7, [232, 234, 180], 8);
};

TILE_PAINTERS.end_stone_bricks = (p) => {
  p.fill(206, 209, 150);
  const light = [224, 227, 170];
  const mortar = [178, 181, 128];
  // Two courses of offset bricks.
  for (const [y, offset] of [[0, 0], [4, 4], [8, 0], [12, 4]]) {
    p.hLine(y, 0, 15, mortar);
    for (let i = 0; i < 2; i++) {
      const x = (offset + i * 8) % 16;
      p.rect(x + 1, y + 1, 6, 3, light);
      p.vLine((x + 7) % 16, y + 1, y + 3, mortar);
    }
  }
  p.grain(6);
};

TILE_PAINTERS.purpur_block = (p) => {
  p.fill(169, 125, 169).grain(9);
  // Purpur reads as a coarse aggregate, so larger and darker blobs than usual.
  p.blobs(9, 2.2, [148, 106, 148], 12);
  p.blobs(6, 1.5, [190, 148, 190], 12);
};

TILE_PAINTERS.purpur_pillar = (p) => {
  TILE_PAINTERS.purpur_block(p);
  // Vertical banding: two carved grooves with highlights beside them.
  const groove = [136, 96, 136];
  const highlight = [196, 156, 196];
  for (const x of [3, 12]) {
    p.vLine(x, 0, 15, groove);
    p.vLine(x + 1, 0, 15, highlight);
  }
};

TILE_PAINTERS.purpur_pillar_top = (p) => {
  TILE_PAINTERS.purpur_block(p);
  // A ring, so the pillar cap differs from the plain block from above.
  const ring = [140, 100, 140];
  p.hLine(3, 3, 12, ring);
  p.hLine(12, 3, 12, ring);
  p.vLine(3, 3, 12, ring);
  p.vLine(12, 3, 12, ring);
};

TILE_PAINTERS.end_portal_frame = (p) => {
  p.fill(70, 92, 82).grain(8);
  p.blobs(5, 2.0, [58, 78, 70], 8);
  // A pale capstone band along the top edge, matching the frame's top face.
  p.rect(0, 0, 16, 4, [196, 200, 168]);
  p.hLine(4, 0, 15, [120, 132, 112]);
  p.grain(5, 0.6);
};

TILE_PAINTERS.end_portal_frame_top = (p) => {
  p.fill(196, 200, 168).grain(8);
  p.blobs(4, 2.2, [180, 184, 152], 8);
  // The socket that holds an eye of ender.
  const socket = [52, 64, 58];
  p.rect(5, 5, 6, 6, socket);
  p.rect(6, 6, 4, 4, [34, 44, 40]);
  p.set(7, 7, 86, 148, 132);
  p.set(8, 8, 74, 132, 118);
};

TILE_PAINTERS.end_portal = (p) => {
  // Near-black with a scatter of stars: the portal is a hole, not a surface.
  p.fill(10, 8, 22);
  for (let i = 0; i < 26; i++) {
    const x = p.int(16);
    const y = p.int(16);
    const bright = 120 + p.int(135);
    p.set(x, y, bright, bright, Math.min(255, bright + 20));
  }
  p.blobs(3, 2.4, [46, 26, 74], 14);
};

TILE_PAINTERS.dragon_egg = (p) => {
  p.fill(18, 14, 26);
  // An egg silhouette: narrow at the top, wide at the base.
  const shell = [38, 26, 54];
  const light = [72, 52, 96];
  for (let y = 2; y <= 14; y++) {
    const halfWidth = Math.min(6, 1 + Math.floor((y - 1) * 0.55));
    p.hLine(y, 8 - halfWidth, 7 + halfWidth, shell);
  }
  // Specular highlight up the left flank.
  p.vLine(5, 6, 12, light);
  p.set(6, 5, light[0], light[1], light[2]);
  p.set(4, 10, 96, 72, 124);
  p.grain(7, 0.5);
};

TILE_PAINTERS.chorus_plant = (p) => {
  p.clear();
  const stem = [94, 60, 94];
  const light = [126, 86, 126];
  const dark = [66, 40, 66];
  // A thick central stalk with two stubby side branches.
  p.rect(5, 0, 6, 16, stem);
  p.vLine(5, 0, 15, dark);
  p.vLine(9, 0, 15, light);
  p.rect(0, 5, 5, 4, stem);
  p.rect(11, 9, 5, 4, stem);
  p.hLine(5, 0, 4, light);
  p.hLine(12, 11, 15, dark);
};

TILE_PAINTERS.chorus_flower = (p) => {
  p.clear();
  const body = [206, 200, 206];
  const shade = [166, 158, 166];
  const core = [110, 74, 110];
  p.rect(3, 3, 10, 10, body);
  p.hLine(3, 3, 12, shade);
  p.vLine(12, 3, 12, shade);
  // Four petal notches and a dark centre.
  p.rect(6, 6, 4, 4, core);
  p.set(3, 3, 0, 0, 0, 0);
  p.set(12, 3, 0, 0, 0, 0);
  p.set(3, 12, 0, 0, 0, 0);
  p.set(12, 12, 0, 0, 0, 0);
};

TILE_PAINTERS.end_rod = (p) => {
  p.clear();
  // A slim vertical rod: pale shaft, bright tip, dark base cap.
  const shaft = [238, 236, 226];
  const glow = [180, 240, 244];
  const base = [122, 116, 138];
  p.rect(7, 2, 2, 12, shaft);
  p.vLine(7, 2, 13, [255, 255, 250]);
  p.rect(6, 12, 4, 3, base);
  p.rect(6, 1, 4, 2, glow);
  p.set(8, 0, glow[0], glow[1], glow[2]);
  p.set(7, 0, 226, 250, 252);
};

TILE_PAINTERS.ender_pearl = (p) => {
  p.clear();
  // A smooth teal sphere with a pale highlight: the only round item icon.
  const shell = [22, 84, 76];
  const mid = [42, 128, 114];
  const light = [126, 206, 188];
  for (let y = 3; y <= 12; y++) {
    const dy = y - 7.5;
    const half = Math.round(Math.sqrt(Math.max(0, 20.25 - (dy * dy))));
    p.hLine(y, 8 - half, 7 + half, shell);
  }
  for (let y = 5; y <= 10; y++) {
    const dy = y - 7.5;
    const half = Math.round(Math.sqrt(Math.max(0, 9 - (dy * dy))));
    p.hLine(y, 8 - half, 7 + half, mid);
  }
  p.set(6, 5, light[0], light[1], light[2]);
  p.set(5, 6, light[0], light[1], light[2]);
  p.set(6, 6, 200, 240, 230);
};

TILE_PAINTERS.eye_of_ender = (p) => {
  TILE_PAINTERS.ender_pearl(p);
  // The eye is a pearl with a vertical slit pupil burned through it.
  p.vLine(8, 5, 10, [246, 236, 168]);
  p.vLine(7, 6, 9, [252, 246, 200]);
  p.set(8, 7, 30, 24, 18);
  p.set(8, 8, 30, 24, 18);
};

TILE_PAINTERS.mob_enderman = (p) => {
  p.fill(12, 12, 18);
  p.grain(6);
  // Only the eyes read at this size, so they carry the whole silhouette.
  p.rect(3, 6, 4, 2, [186, 122, 232]);
  p.rect(9, 6, 4, 2, [186, 122, 232]);
  p.rect(4, 6, 2, 2, [226, 190, 250]);
  p.rect(10, 6, 2, 2, [226, 190, 250]);
  p.grain(4, 0.4);
};

TILE_PAINTERS.glass_bottle = (p) => {
  p.clear();
  const glass = [206, 226, 220];
  const edge = [156, 184, 178];
  p.rect(6, 2, 4, 3, edge);
  p.rect(5, 5, 6, 3, glass);
  p.rect(4, 8, 8, 6, glass);
  p.vLine(4, 8, 13, edge);
  p.vLine(11, 8, 13, edge);
  p.hLine(13, 4, 11, edge);
  p.set(6, 10, 246, 252, 250);
};

TILE_PAINTERS.dragon_breath = (p) => {
  TILE_PAINTERS.glass_bottle(p);
  // The same bottle, filled with a violet vapour.
  p.rect(5, 9, 6, 4, [138, 78, 176]);
  p.rect(5, 9, 6, 1, [186, 132, 216]);
  p.set(7, 11, 214, 176, 236);
};

TILE_PAINTERS.chorus_fruit = (p) => {
  p.clear();
  const flesh = [148, 96, 132];
  const light = [190, 140, 172];
  for (let y = 4; y <= 12; y++) {
    const dy = y - 8;
    const half = Math.round(Math.sqrt(Math.max(0, 16 - (dy * dy))));
    p.hLine(y, 8 - half, 7 + half, flesh);
  }
  p.set(6, 6, light[0], light[1], light[2]);
  p.set(5, 7, light[0], light[1], light[2]);
  p.rect(7, 2, 2, 2, [92, 60, 84]);
  p.grain(6, 0.5);
};

// ------------------------------------------------------- utility blocks (beacon)

TILE_PAINTERS.beacon = (p) => {
  p.clear();
  // Obsidian casing seen through glass, with the beam core glowing behind it.
  p.fill([46, 40, 66]);
  p.grain(6, 0.35);
  p.rect(3, 3, 10, 10, [72, 62, 104]);
  p.rect(4, 4, 8, 8, [24, 22, 34]);
  p.rect(6, 6, 4, 4, [126, 236, 226]);
  p.rect(7, 7, 2, 2, [226, 255, 252]);
  p.hLine(0, 0, 15, [88, 78, 122]);
  p.hLine(15, 0, 15, [22, 20, 30]);
  p.vLine(0, 0, 15, [78, 70, 110]);
  p.vLine(15, 0, 15, [26, 24, 36]);
};

TILE_PAINTERS.beacon_top = (p) => {
  p.clear();
  // Looking down the beam: concentric glass rings around a white-hot centre.
  p.fill([34, 32, 48]);
  p.rect(2, 2, 12, 12, [58, 54, 84]);
  p.rect(3, 3, 10, 10, [86, 176, 186]);
  p.rect(4, 4, 8, 8, [126, 236, 226]);
  p.rect(5, 5, 6, 6, [190, 250, 244]);
  p.rect(6, 6, 4, 4, [240, 255, 254]);
  p.set(7, 7, 255, 255, 255);
  p.set(8, 8, 255, 255, 255);
  p.grain(3, 0.25);
};

// ------------------------------------------------------------ version 7 End

TILE_PAINTERS.infested_stone = (p) => {
  TILE_PAINTERS.stone(p);
  p.hLine(5, 3, 8, [72, 70, 70]);
  p.vLine(8, 5, 9, [82, 78, 78]);
  p.hLine(10, 8, 12, [86, 82, 82]);
};

TILE_PAINTERS.infested_mossy_cobblestone = (p) => {
  TILE_PAINTERS.mossy_cobblestone(p);
  p.hLine(6, 2, 7, [56, 66, 48]);
  p.vLine(7, 6, 11, [62, 70, 52]);
};

TILE_PAINTERS.silverfish_spawner = (p) => {
  p.clear();
  for (let i = 1; i < 15; i += 4) {
    p.hLine(i, 1, 14, [68, 72, 76]);
    p.vLine(i, 1, 14, [68, 72, 76]);
  }
  p.rect(6, 6, 4, 4, [128, 134, 140]);
  p.set(7, 7, 212, 110, 74);
};

TILE_PAINTERS.shulker_box = (p) => {
  p.fill(102, 62, 116).grain(8);
  p.rect(1, 2, 14, 5, [132, 82, 146]);
  p.hLine(7, 1, 14, [48, 30, 58]);
  p.rect(6, 8, 4, 3, [70, 42, 82]);
};
TILE_PAINTERS.shulker_box_top = (p) => {
  p.fill(122, 74, 138).grain(7);
  p.rect(2, 2, 12, 12, [146, 92, 158]);
  p.rect(5, 5, 6, 6, [98, 56, 112]);
};

TILE_PAINTERS.elytra_display = (p) => {
  p.clear();
  p.rect(7, 2, 2, 13, [116, 82, 62]);
  p.rect(2, 4, 5, 8, [118, 124, 130]);
  p.rect(9, 4, 5, 8, [118, 124, 130]);
  p.vLine(2, 5, 11, [196, 202, 206]);
  p.vLine(13, 5, 11, [196, 202, 206]);
};

TILE_PAINTERS.end_gateway = (p) => {
  TILE_PAINTERS.end_portal(p);
  p.rect(6, 6, 4, 4, [194, 238, 242]);
  p.rect(7, 7, 2, 2, [255, 255, 255]);
};

// Version 8: narrow transparent lattice used around the tallest End crystals.
TILE_PAINTERS.iron_bars = (p) => {
  p.clear();
  p.rect(6, 0, 4, 16, [126, 134, 145]);
  p.rect(7, 0, 1, 16, [205, 213, 220]);
  p.rect(0, 5, 16, 3, [112, 120, 132]);
  p.rect(0, 6, 16, 1, [198, 206, 216]);
  p.rect(0, 12, 16, 2, [105, 112, 124]);
  p.set(8, 1, 236, 241, 244);
};

TILE_PAINTERS.shulker_shell = (p) => {
  p.clear();
  p.rect(3, 4, 10, 8, [126, 76, 142]);
  p.rect(4, 3, 8, 2, [158, 104, 170]);
  p.hLine(11, 4, 11, [72, 42, 84]);
};

TILE_PAINTERS.elytra = (p) => {
  p.clear();
  p.rect(2, 3, 5, 10, [128, 136, 142]);
  p.rect(9, 3, 5, 10, [128, 136, 142]);
  p.vLine(2, 4, 12, [206, 212, 216]);
  p.vLine(13, 4, 12, [206, 212, 216]);
  p.rect(7, 2, 2, 6, [80, 86, 90]);
};

TILE_PAINTERS.end_crystal = (p) => {
  p.clear();
  p.rect(6, 2, 4, 12, [224, 180, 246]);
  p.rect(3, 6, 10, 4, [166, 92, 210]);
  p.rect(7, 4, 2, 8, [255, 244, 255]);
};

TILE_PAINTERS.mob_silverfish = (p) => {
  p.fill(88, 92, 96).grain(9);
  p.hLine(7, 1, 14, [156, 160, 164]);
  p.hLine(8, 1, 14, [60, 64, 68]);
};

TILE_PAINTERS.mob_shulker = (p) => {
  TILE_PAINTERS.shulker_box(p);
  p.rect(5, 6, 6, 4, [210, 190, 214]);
  p.set(7, 7, 24, 18, 28);
  p.set(9, 7, 24, 18, 28);
};

TILE_PAINTERS.mob_ender_dragon = (p) => {
  p.fill(18, 14, 24).grain(6);
  p.rect(3, 5, 4, 2, [214, 110, 242]);
  p.rect(9, 5, 4, 2, [214, 110, 242]);
  p.hLine(11, 4, 11, [52, 38, 68]);
};
