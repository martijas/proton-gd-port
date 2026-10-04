// Hand-written corrections to the generated art half of the object table, the
// render-side counterpart of objectData.ts.
//
// The generator merges two machine sources — the game's own table for ids up to
// 1911 (data/ref/gdclone-object.json) and the old fan port's table above that —
// and drops any frame name that no sheet actually contains. Almost everything
// the fan port got wrong is already fixed by the first source winning, so this
// map starts nearly empty. It exists so a correction has somewhere to live that
// is not a generated file.
//
// Each entry needs a comment saying what was observed and where.

import type { ObjectRecord } from "../assets/objectTypes";

export const RENDER_OVERRIDES: ReadonlyMap<number, Partial<ObjectRecord>> = new Map<number, Partial<ObjectRecord>>([
  [
    142,
    // The original secret coin is the only drawable object no source gives a z
    // to. Every other collectible in the table is layer 5, order 9 — all eleven
    // of them, from both machine sources, including id 1329, which is the 2.0
    // secret coin (secretCoin_2_01_001.png) and the closest thing this has to a
    // twin. [meas: assets/objects.json, every record with a `collectible` kind]
    { zl: 5, zo: 9 },
  ],
]);

/**
 * Object ids drawn by a skeletal animation rather than by a sprite frame. The
 * values are entity keys in objectDefinitions.plist, whose per-limb layout the
 * build writes to assets/anims/<entity>.json.
 *
 * Every mapping below is read off a frame name in one of the two machine
 * sources rather than guessed: the game's own table names GJBeast01_01_001.png
 * for 918, GJBeast04_01_001.png for 1584, GJBeast02/03 for 1327/1328 and
 * dA_blackSludge_01_001.png for 919, and the fan port's table names
 * GJBeast05_02_001.png for 2012, which is past the range the first source
 * covers.
 */
export const ANIM_ENTITY_IDS: ReadonlyMap<number, string> = new Map<number, string>([
  [918, "GJBeast01"],
  [919, "BlackSludge"],
  [1327, "GJBeast02"],
  [1328, "GJBeast03"],
  [1584, "GJBeast04"],
  [2012, "GJBeast05"],
]);
