// Which game modes a level can put the player in.

import { pickStartPosition } from "../level/decode";
import type { GameMode, Level, StartPosition } from "../level/types";
import type { ObjectTable } from "./types";

/**
 * The mode a run starts in: its start position's, or the header's without
 * one, and a cube for a wave or swing start in a platformer, the start
 * position's own kA22 counting as well as the level's. `sp` is the start
 * position the run begins from, null for none.
 * [gdp GJBaseGameLayer::setupLevelStart :462752-462756 (+281 is the block's
 *  kA22, +10734 the level's)]
 */
export function startModeOf(level: Level, sp: StartPosition | null = pickStartPosition(level)): GameMode {
  const mode = sp ? sp.mode : level.header.startMode;
  const flying = mode === "wave" || mode === "swing";
  return flying && (level.header.platformer || sp?.platformer === true) ? "cube" : mode;
}

/**
 * Every mode a level can put the player in: the one it starts in (startModeOf)
 * and the one behind each of its mode portals. What a renderer needs to load
 * the player's icons before the first attempt rather than at the first portal.
 */
export function modesOf(level: Level, table: ObjectTable): Set<GameMode> {
  const modes = new Set<GameMode>([startModeOf(level)]);
  const seen = new Set<number>();
  for (const o of level.objects) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const portal = table.get(o.id).portal;
    if (portal?.type === "mode") modes.add(portal.mode);
  }
  return modes;
}
