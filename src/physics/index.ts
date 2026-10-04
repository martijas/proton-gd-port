// Physics core entry point: createSim(level, objects, opts?) plus the pieces
// other packages (renderer, autoplayer, debug view) read from.

export { createSim, SimImpl } from "./sim";
export { Player, MODE_BY_INDEX } from "./player";
export type { PlayerWorld } from "./player";
export { ObjectSet, SpatialHash, collideSolid, collideSlope } from "./collision";
export * from "./types";
export * from "./constants";
export { rectsTouch, rectHitsObb, obbsTouch, rectHitsCircle, rectCornersHitCircle, rectHitsTriangle, slopeOrientation, slerp2D, snap90, normDeg } from "./geometry";
