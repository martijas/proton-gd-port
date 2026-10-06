import type { LevelEnd, TriggerRuntime } from "../triggers/runtime";
import type { ShaderState } from "../triggers/shaderState";
import type { GameMode, Level, LevelObject, Speed } from "../level/types";

// ---------------------------------------------------------------------------
// Object table — what an object id *is* to the physics engine. Built from the
// bootstrap table + manual overrides (src/physics/objects.ts); the asset
// pipeline (goal 2) later regenerates the same shape from the real sheets.
// ---------------------------------------------------------------------------

export type ObjectKind =
  | "solid" // blocks: player lands on / dies from side or inner-hitbox contact
  | "hazard" // spikes, saws, animated monsters: main hitbox contact kills
  | "slope"
  | "orb"
  | "pad"
  | "portal"
  | "collectible" // coins, keys, items
  | "checkpoint" // 2063
  | "trigger"
  | "collision" // 1816 collision block, 3640 state block — no physical presence
  | "forceBlock" // 2069 / 3645
  | "startPos" // 31
  | "decoration"
  | "unknown";

/** All sizes in units, relative to the object centre, before the level object's flip/rotation/scale. */
export type Hitbox =
  | { type: "box"; w: number; h: number; ox: number; oy: number }
  | { type: "circle"; r: number; ox: number; oy: number }
  /** Right triangle. `w`/`h` is the unrotated bounding size. Base orientation:
   *  hypotenuse rises from bottom-left (-w/2,-h/2) to top-right (w/2,h/2), the
   *  right angle is at the bottom-right, the solid region is below the
   *  hypotenuse. Flips apply before rotation (key 6, clockwise positive). */
  | { type: "slope"; w: number; h: number }
  | null;

export type OrbType =
  | "yellow" // 36
  | "pink" // 141
  | "red" // 1333
  | "blue" // 84 gravity
  | "green" // 1022 gravity + jump
  | "black" // 1330 drop
  | "spider" // 3004
  | "dash" // 1704
  | "dashGravity" // 1751
  | "toggle" // 1594 (trigger orb), 3643 (toggle block)
  | "teleport"; // 3027

export type PadType = "yellow" | "pink" | "red" | "blue" | "spider";

export type PortalEffect =
  | { type: "mode"; mode: GameMode }
  | { type: "gravity"; flipped: boolean } // 10 normal / 11 flipped
  | { type: "gravityToggle" } // 2926
  | { type: "mirror"; mirrored: boolean }
  | { type: "size"; mini: boolean }
  | { type: "speed"; speed: Speed }
  | { type: "dual"; dual: boolean }
  | { type: "teleport"; kind: "linkedEntry" | "linkedExit" | "targetEntry" | "targetExit" };

export interface ObjectDef {
  id: number;
  kind: ObjectKind;
  hitbox: Hitbox;
  /** One-way platform (m_isPassable): enter from below, stand on top. Per-object key 134 can also set it. */
  passable?: boolean;
  /** 143 breakable brick: solid from the top, shatters instead of killing from side/below. */
  breakable?: boolean;
  /** Letter modifier blocks: D allow wave drag, J stop jump buffer, S stop dash, H allow head collision, F gravity flip. */
  special?: "D" | "J" | "S" | "H" | "F";
  orb?: OrbType;
  pad?: PadType;
  portal?: PortalEffect;
  collectible?: "secretCoin" | "userCoin" | "item" | "key" | "clock";
  forceShape?: "box" | "circle";
  /** Hazard that is a skeletal monster (hitbox may be a circle around the body). */
  animated?: boolean;
  /** Sprite footprint in blocks; the collision broadphase falls back to it. */
  gridW?: number;
  gridH?: number;
  /** Where the definition came from, so gaps stay visible. */
  source: "table" | "derived" | "manual";
}

export interface ObjectTable {
  get(id: number): ObjectDef;
  has(id: number): boolean;
  /** Every id the table knows, for reports. */
  ids(): number[];
}

// ---------------------------------------------------------------------------
// Input, player and sim state
// ---------------------------------------------------------------------------

export interface PlayerInput {
  /** Click / space / up: where the button is at the end of the step. */
  jump: boolean;
  /**
   * The button also went the other way and back since the last step — a click
   * shorter than a step, or a release and re-press inside one. The game runs
   * both commands in the same step, so a grounded jump still happens and a
   * flying player's tap does nothing. A recorded run sets it for a down and an
   * up on the same frame.
   */
  tap?: boolean;
  /** Platformer only. */
  left: boolean;
  right: boolean;
}

export const NO_INPUT: Readonly<PlayerInput> = Object.freeze({ jump: false, left: false, right: false });

/**
 * Velocities use the game's own units: `yVel` is m_yVelocity, in units per
 * 60 fps frame ("Vel"), which setYVelocity keeps to three decimals; position
 * advances by 0.225 * yVel per 240 Hz tick (see physics/constants.ts).
 * `xSpeed` is m_playerSpeed * m_speedMultiplier, also units per 60 fps frame
 * (5.193 at 1x → 1.29825 units per tick). `x` and `y` are the game's float
 * position, with y 90 lower than the game's (see floatY in physics/player.ts).
 */
export interface PlayerState {
  x: number;
  y: number;
  yVel: number;
  xSpeed: number;
  /** Platformer horizontal velocity (Vel); 0 in classic mode. */
  xVel: number;
  mode: GameMode;
  speed: Speed;
  mini: boolean;
  /** True when gravity points up (m_isUpsideDown). */
  flipped: boolean;
  mirrored: boolean;
  /** 2.2 reverse gameplay: moving right → left. */
  reversed: boolean;
  /** Gameplay turned a quarter: travelling along y, falling along x. */
  rotated: boolean;
  onGround: boolean;
  onSlope: boolean;
  /**
   * The world y the player was at when it last met the ground, or was
   * launched by a pad, or where a teleport with key 510 left it; NaN after a
   * reset, a respawn, any other teleport to a target, a turn of gameplay or
   * a red pad. Only the camera reads it, so it never changes what the player
   * does. [gdp PlayerObject +2076: set by hitGround :150189-150190,
   * propellPlayer :147715-147716 and teleportPlayer :462480-462485; cleared
   * by resetObject :153635, playerTeleported :148810 and bumpPlayer :157080]
   */
  lastGroundY: number;
  /** Sprite rotation in degrees, clockwise positive like cocos. */
  rotation: number;
  /** The button as the game sees it (+1909): a press sets it; the release and some game logic clear it. */
  holding: boolean;
  /** Ticks since the press (0 on the press tick), -1 when not holding. */
  holdTicks: number;
  dashing: boolean;
  /**
   * The dash's angle (+1200), the orb's rotation negated so counter-clockwise
   * counts up: clamped to ±70 in a classic level unless gameplay is rotated,
   * in −359..0 in a platformer, and half round after a gameplay turn.
   * Meaningful while dashing.
   */
  dashAngle: number;
  /** The player's own clock (+2144), in ticks; a slowed-down level runs it slower. */
  clock: number;
  /** When the dash started, on that clock. */
  dashClock: number;
  /** When updateDashArt last restarted the icon's spin, on that clock. */
  dashArtClock: number;
  /** The icon's spin while dashing, in degrees a second clockwise; 0 for a mode that does not spin. */
  dashSpinRate: number;
  dead: boolean;
  finished: boolean;
  /** Object index that killed the player, for hitbox debugging. */
  killedBy: number | null;
  /** Tick of the last gravity flip, for the post-flip snap grace. */
  lastFlipTick: number;
  /**
   * A ring the collision pass touches now would fire: a fresh press still
   * held, and not dashing. Flying players take rings only at the press.
   */
  orbReady: boolean;
}

export interface SimEvent {
  tick: number;
  type:
    | "jump"
    | "land"
    | "orb"
    | "pad"
    | "portal"
    | "flip"
    | "dashStart"
    | "dashEnd"
    | "die"
    | "finish"
    | "collect"
    | "checkpoint"
    | "break";
  player: 1 | 2;
  object?: number; // object index
  /**
   * For a "jump", what jumped: "ground" (a cube, ball or robot leaving the
   * ground), "ufo" (a flap), "swing" (a click) or "spider" (its teleport).
   * For an "orb", "pad" or "collect", the kind.
   */
  detail?: string;
}

/**
 * Why the game made a CCCircleWave: the function that made it. Each is called
 * at a moment the simulation knows and behind gates that read the game's
 * state — whether the mode really changed, the object's key 116 ("no
 * effects"), whether the ring had been taken before — so the simulation says
 * when; what the circle looks like, and the gates that read what is drawn
 * (the object's opacity, the setting that turns most of them off), are the
 * renderer's (render/circleWaves.ts).
 * [gdp CCCircleWave::create callers, gd-ida-decomp.cpp: PlayerObject::ringJump
 *  :160032, RingObject::spawnCircle :306730 (from powerOnObject :306767-306787),
 *  PlayerObject::playBumpEffect :147290, spawnPortalCircle :143166,
 *  spawnScaleCircle :143256, spawnDualCircle :143323, toggleDartMode :153065,
 *  GameObject::playShineEffect :168225, PlayerObject::playSpiderDashEffect
 *  :145795-145851, GameObject::spawnDefaultPickupParticle :622191,
 *  playDestroyObjectAnim :622632-622655, PlayerObject::playDeathEffect :685521,
 *  GJBaseGameLayer::playExitDualEffect :421163-421179]
 */
export type WaveCause =
  /** An orb taken: ringJump. */
  | "ring"
  /** An orb the player has just begun to touch: RingObject::powerOnObject. */
  | "ringPower"
  /** A pad: playBumpEffect. */
  | "bump"
  /** A portal that changed something, or a teleport's two ends: spawnPortalCircle. */
  | "portal"
  /** A size portal's second circle: spawnScaleCircle. */
  | "scale"
  /** Each player as a dual starts: spawnDualCircle. */
  | "dual"
  /** The ring the wave portal adds to its portal circle: toggleDartMode. */
  | "dart"
  /** A speed portal: playShineEffect. */
  | "speed"
  /** A spider's jump: playSpiderDashEffect. */
  | "spiderDash"
  /** A key, heart or other pickup: spawnDefaultPickupParticle. */
  | "pickup"
  /** A secret or user coin: playDestroyObjectAnim. */
  | "coin"
  /** The player's death, the default effect: playDeathEffect. */
  | "death"
  /** The player a dual leaves behind, as it ends: playExitDualEffect. */
  | "exitDual";

/** One circle cause, at the moment the game would make it. */
export interface SimWave {
  cause: WaveCause;
  player: 1 | 2;
  /**
   * The object it is for — the orb, pad, coin — or -1. A portal circle's is
   * the object the player last met (+2116), which is not always the portal
   * that made it.
   */
  object: number;
  /**
   * The circle stands on `object`'s linked exit, the object of the game's
   * own a linked teleport sends the player to, rather than on `object`.
   */
  exit: boolean;
  /**
   * Which one of its cause, as the colour and size are picked by it: the orb
   * or pad type, the portal's new mode, "gravityUp", "mirrorOn", "mini",
   * "solo", "teleportIn" or "teleportOut", the speed portal's speed,
   * "secret" or "user" for a coin, "reversed" for a spider travelling
   * backwards, "mirrored" for a dual ending in a mirrored view; "" when
   * there is no choice.
   */
  variant: string;
  /**
   * Where, in level space: the object's place (with `exit` still the
   * portal's; the renderer puts the exit beside it), or for the player's own
   * circles the player's. A spider's jump starts here.
   */
  x: number;
  y: number;
  /** Where a spider's jump landed; the same as x, y otherwise. */
  x2: number;
  y2: number;
  /** The player's size then (+2016): 1, or 0.6 mini. */
  size: number;
}

/**
 * Whether an event is one the game counts as a jump: a cube, ball or robot
 * leaving the ground, or any orb taken, by either player. A UFO flap, a
 * swing click and a spider's jump are not.
 * [gdp PlayerObject::incrementJumps :142239-142251, from updateJump :155855
 *  (the spider leaves before it, :155764-155767) and ringJump :159956-159961]
 */
export function countsAsJump(e: SimEvent): boolean {
  return e.type === "orb" || (e.type === "jump" && e.detail === "ground");
}

export interface SimSnapshot {
  readonly tick: number;
  readonly opaque: unknown;
}

export interface StartState {
  x: number;
  y: number;
  mode: GameMode;
  speed: Speed;
  mini: boolean;
  flipped: boolean;
  dual: boolean;
  mirrored: boolean;
  reversed: boolean;
  /** Player 1 starts with its gameplay turned (kA29). */
  rotated: boolean;
}

/**
 * Switches the mod menu can flip mid-run. None of them is the game's; a run
 * with any on keeps no progress (see hacks/state.ts).
 */
export interface SimCheats {
  /** Nothing kills the player. */
  noclip: boolean;
  /** A fresh press jumps in the air as it would on the ground. */
  jumpHack: boolean;
}

export interface SimOptions {
  /** Override the level's start (a debug jump). A start given here also skips the level's start positions. */
  start?: Partial<StartState>;
  /**
   * Which start position to begin from, by its object index, or -1 for the
   * level's own start. Absent, the one the game would pick.
   */
  startPosition?: number;
  /** Skip death detection (debug fly-through). */
  noclip?: boolean;
  /** Called on every event; events are also buffered in `sim.events`. */
  onEvent?: (e: SimEvent) => void;
  /**
   * Colours, pulses, the shake and the screen effects. None of them can change
   * what the player collides with, so the autoplayer turns them off and saves
   * the work; the game view leaves them on. The camera is not among them: a
   * corridor under a Static Camera is measured about it, so it always runs.
   */
  visuals?: boolean;
  /**
   * The player's two colours, which the colour table's P1 and P2 channels
   * start from. Absent, the table uses the game's own defaults.
   */
  player1?: { r: number; g: number; b: number };
  player2?: { r: number; g: number; b: number };
  /**
   * The attempt's random seed. The game draws one from the clock for a fresh
   * attempt and reads it back out of the replay string when replaying, which is
   * exactly what a saved macro needs, so this is never taken from the clock
   * here. [gdp PlayLayer reset, gd-ida-decomp.cpp:105790-105797]
   */
  seed?: number;
  /**
   * Which attempt this is, 1 for the first; an Item Compare can read it. The
   * game counts every reset, a practice respawn included.
   * [gdp PlayLayer::updateAttempts :92437-92457, from resetLevel :105983]
   */
  attempt?: number;
  /**
   * Practice mode, which the game keeps on the layer and not in a
   * checkpoint (+10908): a secret or user coin is not picked up in it. The
   * autoplayer never sets it. [gdp collisionCheckObjects :463676, :463781]
   */
  practice?: boolean;
  /**
   * The previous attempt's screen effects, on a restart from the start: the
   * game resets its one layer rather than making a new one, so some values
   * carry over. Only read with `visuals`. [gdp resetLevelVariables
   *  :462991-462996]
   */
  shader?: ShaderState;
}

/**
 * The deterministic core. One `step` advances exactly one 240 Hz tick with the
 * given inputs. Everything the renderer needs is readable from `state`;
 * nothing in here touches the DOM, WebGL or audio.
 */
export interface Sim {
  readonly level: Level;
  readonly objects: ObjectTable;
  /** Level logic: what has fired, what has moved, what colour everything is. */
  readonly triggers: TriggerRuntime;
  readonly tick: number;
  readonly state: PlayerState;
  /** Second player while in dual mode, else null. */
  readonly state2: PlayerState | null;
  readonly events: SimEvent[];
  /**
   * The circles the last step made, in the order it made them (SimWave).
   * Emptied at the start of every step and by a restore, so a caller reads it
   * after each step; nothing in the simulation reads it.
   */
  readonly waves: readonly SimWave[];
  /**
   * How an End trigger ended the level, once one has: where the players are
   * flown and the trigger's switches, which say among other things whether
   * the end sound plays. Null for a level that has not ended or ended by
   * running off its right edge.
   */
  readonly end: LevelEnd | null;
  /** Current floor and ceiling y of the play corridor (ceiling = Infinity when open). */
  readonly floorY: number;
  readonly ceilingY: number;
  /**
   * The corridor's ground layers, which stand on the screen rather than in
   * the level: how far apart they end up, in screen units, and how far they
   * have slid in from the screen's edges, 0 to 1. The ground and ceiling art
   * is drawn from these and the camera (corridorArt); floorY and ceilingY are
   * the band the player is held in, which can differ while the camera is on
   * its way to the corridor.
   */
  readonly corridorHeight: number;
  readonly corridorSlide: number;
  /**
   * The start position this run began from (its object index), or -1. The
   * game treats such a run as a test and keeps no progress from it.
   * [PlayLayer::addObject :90313-90314 (+10956); destroyPlayer :93199-93203;
   *  levelComplete :92666-92696]
   */
  readonly startPosition: number;
  /**
   * Seconds the warm-up to the start position ran the music clock (+800);
   * 0 without one. The music starts there. The level time (item type 4)
   * starts at 0 either way.
   */
  readonly startTime: number;
  /** The mod menu's switches, read every step. */
  readonly cheats: SimCheats;
  /** Ticks on which noclip kept the player alive, counted since the sim was made. */
  readonly noclipHits: number;
  /** Ends the level now, as reaching its end would; nothing when already over. */
  finishNow(): void;
  step(p1: PlayerInput, p2?: PlayerInput): void;
  snapshot(): SimSnapshot;
  /** Back to a snapshot exactly, as the autoplayer rewinds. */
  restore(s: SimSnapshot): void;
  /**
   * A practice respawn at a checkpoint's snapshot: as `restore`, but with the
   * rings a press would take and the letter blocks cleared, as the game's
   * respawn leaves them, and every secret coin given back. Returns how many
   * of `triggers.events` the checkpoint kept; any after them its key 448
   * spawn fired.
   */
  respawnFrom(s: SimSnapshot): number;
  /** Practice from the pause menu, mid-run. A snapshot does not carry it. */
  setPractice(on: boolean): void;
  /**
   * The secret coins this attempt has picked up, by their own number (key 12,
   * 1 to 3), in level order: what a completion outside practice keeps.
   * [gdp GJBaseGameLayer::processItems :420676-420763, getCoinKey :269911-269930]
   */
  coinsTaken(): number[];
  /**
   * The checkpoint a platformer's checkpoint object (2063) laid down in the
   * last step, once: a snapshot to respawn from, with player 1 moved to the
   * respawn point. Null otherwise, and always in a classic level.
   */
  takePlatformerCheckpoint(): SimSnapshot | null;
  /** Objects whose bounding boxes overlap the given world rect (debug drawing / the bot). */
  query(x0: number, y0: number, x1: number, y1: number): LevelObject[];
  /** World-space hitbox of a level object as the sim sees it right now, or null when it has none. */
  hitboxOf(index: number): WorldShape | null;
  /** Player main (outer) hitbox in world space. */
  playerRect(player?: 1 | 2): Rect;
  /** Player inner (solid-death) hitbox in world space. */
  playerInnerRect(player?: 1 | 2): Rect;
  /** 0..1 progress along the level. */
  progress(): number;
  /**
   * Cheap hash of state the player's position does not show (toggled groups,
   * the rings a press would take, letter blocks wearing off, etc.), for search
   * dedup.
   */
  stateHash(): number;
}

export interface Rect {
  x: number; // min x
  y: number; // min y
  w: number;
  h: number;
}

export type WorldShape =
  | { type: "rect"; rect: Rect; rotation: number } // rotation 0 → axis aligned
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "triangle"; ax: number; ay: number; bx: number; by: number; cx: number; cy: number };

export const TICK_RATE = 240;
export const TICK_DT = 1 / TICK_RATE;
export const SUBSTEPS_PER_FRAME = 4;
