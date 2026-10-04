// Level data model shared by the decoder, the physics sim, the renderer and
// the editor. Units are GD units: 1 block = 30 units, +y is up, object x/y is
// the object's centre exactly as stored in the level string.

export type GameMode =
  | "cube"
  | "ship"
  | "ball"
  | "ufo"
  | "wave"
  | "robot"
  | "spider"
  | "swing";

/** Speed portal index: 0 = 0.5x, 1 = 1x, 2 = 2x, 3 = 3x, 4 = 4x. */
export type Speed = 0 | 1 | 2 | 3 | 4;

export interface HsvShift {
  h: number; // -180..180
  s: number; // multiplier or additive depending on sChecked
  v: number;
  sChecked: boolean;
  vChecked: boolean;
}

export interface ColorChannel {
  id: number;
  r: number;
  g: number;
  b: number;
  opacity: number; // 0..1
  blending: boolean;
  copyId: number; // 0 = none
  copyHsv: HsvShift | null;
  copyOpacity: boolean;
  playerColor: 0 | 1 | 2; // 0 none, 1 = P1 colour, 2 = P2 colour
}

export interface LevelHeader {
  startMode: GameMode;
  startSpeed: Speed;
  startMini: boolean;
  startDual: boolean;
  startFlipped: boolean;
  /**
   * kA20 "Reverse Gameplay": the level starts going left.
   * [objectFromDict, gd-ida-decomp.cpp:196237-196239; setupLevelStart :462737]
   */
  startReversed: boolean;
  /**
   * kA29 "Rotate Gameplay": player 1 starts with its gameplay turned. Only
   * the flag is set — no velocity handover, no flip — and player 2 is not
   * turned. [objectFromDict :196265-196267; GJBaseGameLayer::setupLevelStart
   *  :462738 → PlayerObject::rotateGameplayOnly :145549-145553]
   */
  startRotated: boolean;
  /**
   * kA36 "Spawn Group": where the player spawns — the group's main object,
   * else one of its members. A platformer takes its x and y, a classic level
   * its y alone. 0 for none; a start position outranks it.
   * [objectFromDict :196301-196303; GJBaseGameLayer::resetPlayer
   *  :425044-425063]
   */
  spawnGroup: number;
  twoPlayer: boolean;
  platformer: boolean;
  /**
   * kA31 "Enable player squeeze": a player caught between a floor and a
   * ceiling closer than 0.7 of its height dies. A platformer does it anyway.
   * Dash and three Tower floors set it.
   * [LevelSettingsObject::objectFromDict, gd-ida-decomp.cpp:196269-196271;
   *  resetLevelVariables :462941-462955]
   */
  playerSqueeze: boolean;
  /**
   * kA32 "Fix gravity bug". Without it the game keeps its old falling test for
   * a player upside down and for both players in a dual. Dash and the Tower
   * floors after the first set it; levels 1–21 and The Challenge do not.
   * [LevelSettingsObject::objectFromDict, gd-ida-decomp.cpp:196273-196275;
   *  copied to both players at :462956-462959]
   */
  fixGravityBug: boolean;
  /**
   * kA34 "Fix robot jump": a pad ends a robot's held jump. Without it the hold
   * survives the yellow, pink, red and spider pads; the blue pad never ends it.
   * [objectFromDict :196281-196283; +2408 = !kA34 at :430562-430563, read in
   *  PlayerObject::bumpPlayer :157053]
   */
  fixRobotJump: boolean;
  /**
   * kA40 "Enable 2.2 Changes". The game also turns it on for the official
   * platformer levels and Dash whatever the file says (see Level.officialId).
   * Of what it gates, the sim reads one thing: without it a toggle orb spends
   * the press. [objectFromDict :196249-196251; resetLevelVariables
   *  :462937-462940, 462962-462964]
   */
  enable22Changes: boolean;
  /**
   * kA38: every group, not only those a Spawn trigger names, is put in x
   * order as the level loads (see triggers/spec.ts sortSpawnGroups).
   * [objectFromDict :196289-196291, settings +362]
   */
  sortAllGroupsX: boolean;
  /**
   * kA37: the level keeps its objects in rows as well as columns, as a
   * platformer does (see usesYSections in physics/constants.ts).
   * [objectFromDict :196285-196287, settings +361]
   */
  ySections: boolean;
  /**
   * kA39 "Fix Radius Collision": a round hazard is only ever circle against
   * circle, even once a trigger has turned it.
   * [objectFromDict :196293-196296, settings +363]
   */
  fixRadiusCollision: boolean;
  /**
   * kA27 "Allow Multi-Rotation": every rotate running on a target group turns
   * it. Without it only the newest does, and the others lose their share of
   * each step it runs. Dash and the Tower floors set it; levels 1–21 and The
   * Challenge do not, and none of them runs two rotates on one group at once.
   * [LevelSettingsObject::objectFromDict, gd-ida-decomp.cpp:196245-196247;
   *  +1064 = !kA27 at :462936, read by GJEffectManager::prepareMoveActions
   *  :486272-486289]
   */
  allowMultiRotation: boolean;
  /**
   * kA41 "Allow Static-Rotate": solids, breakables and slopes turn with a
   * rotate like everything else. Without it they only travel round the centre
   * and keep their own angle. No official level sets it.
   * [objectFromDict :196253-196255; +1548 at :462943 → applyLevelSettings
   *  :430498-430512 (+728 = canRotateFree unless kA41), read by
   *  processRotationActions :440008, :440043]
   */
  allowStaticRotate: boolean;
  /**
   * kA42 "Reverse Sync": a pad or orb that reverses the player also moves it,
   * a little each step, to where it would be had it turned at the object's
   * centre. No official level sets it. [objectFromDict :196257-196259; +1170
   *  at :462960-462961, read by PlayerObject::reversePlayer :148376-148389]
   */
  reverseSync: boolean;
  /**
   * kA33: an object's rect takes the size of its scale, whatever its sign.
   * Without it a negative scale makes a negative size, and the rect's two
   * ends trade places, which only a player spanning it all touches. Every
   * official level but The Tower sets it, and none has a negative scale
   * where it would count. [objectFromDict :196277-196280 (settings +359);
   *  resetLevelVariables :462944 (+1549) → applyLevelSettings :430513-430516
   *  (the object's +729); GameObject::getObjectRect :170826-170830]
   */
  fixNegativeScale: boolean;
  /**
   * kA44: the level's length in steps. When it is above 0 the percentage is
   * the steps run so far out of it, not player 1's x out of the level's
   * length. No official level sets it. [objectFromDict :196309-196312
   *  (intValue, settings +344); loadLevelSettings :430566-430567 (the
   *  level's +784 when that is not already set); PlayLayer::getCurrentPercent
   *  :91461-91487; the step count +824, GJBaseGameLayer::processCommands
   *  :464115, zeroed by resetLevel :105783]
   */
  lengthSteps: number;
  /**
   * kA45: a platformer's push slides out faster. Both players' +2072 is its
   * opposite, which the Options trigger's key 593 can set as well. No official
   * level sets it. [objectFromDict :196313-196316 (settings +367);
   *  loadLevelSettings :430564-430565, resetPlayer :425077-425078; read by
   *  PlayerObject::updateMove :149271-149281]
   */
  decreaseBoostSlide: boolean;
  /**
   * kA23 and kA24, the view's stop at the level's left end: unless kA24 is
   * set, the view's left edge goes no further left than x 15 — on a run from
   * the level's beginning, or on every run when kA23 is set. A run from a
   * start position has no stop without kA23. No official level sets either.
   * [objectFromDict :196187-196195 (settings +340, +341); updateCamera
   *  :449613-449619]
   */
  leftStopAlways: boolean;
  noLeftStop: boolean;
  songOffset: number; // seconds
  fadeIn: boolean;
  fadeOut: boolean;
  background: number; // 1-based bg index
  ground: number; // 1-based ground index
  groundLine: number;
  font: number;
  guidelines: number[]; // seconds
  colors: Map<number, ColorChannel>;
  /** Every raw header key, for anything the typed fields don't cover. */
  raw: Record<string, string>;
}

export interface LevelObject {
  /** Position in the level's object list; stable id for the sim/renderer. */
  index: number;
  id: number;
  x: number;
  y: number;
  rotation: number; // degrees, clockwise positive as stored in key 6
  flipX: boolean;
  flipY: boolean;
  scaleX: number;
  scaleY: number;
  groups: number[];
  zLayer: number | null; // key 24 when present
  zOrder: number | null; // key 25 when present
  /**
   * Key 21 as the game reads it: null when absent or 0 or less, which leaves
   * the object's own default channel, and 1101 for anything above 1100.
   * [GameObject::objectFromVector, gd-ida-decomp.cpp:184352-184378]
   */
  baseColor: number | null;
  /** Key 22, the same way. */
  detailColor: number | null;
  /**
   * Key 19, the 1.x colour: the channel it names (1-8 → 1005 P1, 1006 P2, 1,
   * 2, 1007 LBG, 3, 4, 1003 3DL), or null. Any value but 0 skips keys 21 and
   * 22, so both of those read null then. The channel goes on the detail
   * colour when the object has one and on the base otherwise, which only the
   * object's art knows (render/drawList.ts objectChannels).
   * [GameObject::objectFromVector, gd-ida-decomp.cpp:184334-184351; the
   *  table word_981690[30..37] is only in the exe, as the jump table at RVA
   *  0x19eca8]
   */
  legacyColor: number | null;
  /** Shift applied to whatever colour the base sprite ends up with; key 43, enabled by 41. */
  baseHsv: HsvShift | null;
  /** The same for the detail sprite; key 44, enabled by 42. */
  detailHsv: HsvShift | null;
  /**
   * The editor's own layer number, key 20. It does not affect drawing, but it
   * is how a level author groups decoration, so it is worth keeping.
   */
  editorLayer: number | null;
  /** Every raw key → string value, including the ones parsed above. */
  props: Record<number, string>;
  /**
   * The keys that are not numbers, or null when there are none. Only a start
   * position (31) has any: its own level-settings block, `kA2` to `kA45`.
   * [PlayLayer::init :106663-106668 → StartPosObject::loadSettingsFromString
   *  :310535-310546]
   */
  settings: Record<string, string> | null;
}

/**
 * A start position (object 31): where it is and the settings block it
 * carries, read as a level header is read. Only what the game uses from it is
 * kept: the start state (setupLevelStart), which one wins (kA19, kA20, kA21)
 * and how the warm-up to it runs (kA19, kA26, kA35).
 * [StartPosObject::loadSettingsFromString, gd-ida-decomp.cpp:310535-310546 →
 *  LevelSettingsObject::objectFromDict :196140-196320]
 */
export interface StartPosition {
  /** The object's index in Level.objects. */
  index: number;
  x: number;
  y: number;
  mode: GameMode;
  speed: Speed;
  mini: boolean;
  dual: boolean;
  flipped: boolean;
  reversed: boolean;
  rotated: boolean;
  /** kA22, which only the wave and swing rule reads: the level's own flag decides the rest. */
  platformer: boolean;
  /** kA21 "Disable": never started from. */
  disabled: boolean;
  /** kA19 "Target Order": the higher wins; also which pass the warm-up measures to. */
  targetOrder: number;
  /** kA26 "Target Channel": the channel the warm-up measures along. */
  targetChannel: number;
  /** kA35 "Reset Camera": the warm-up's camera moves are thrown away. */
  resetCamera: boolean;
}

export interface Level {
  header: LevelHeader;
  objects: LevelObject[];
  /** Highest object x + padding — where the level ends when no end object exists. */
  lengthUnits: number;
  /**
   * The id of an official level, loaded from the game's own level files.
   * The game marks those as its own (level type 1) and plays a few of them
   * differently from what their settings say. Absent for any other level.
   * [LevelTools::getLevel sets the type at gd-ida-decomp.cpp:121089; read in
   *  GJBaseGameLayer::resetLevelVariables :462939]
   */
  officialId?: number;
  /**
   * The level's capacity string (GJGameLevel +772): batch sizes the game
   * reserves, whose form also says whether the level was made before 2.0's
   * layers (batchNodes.legacyLayers). An official level's comes from the
   * game's own table (OFFICIAL_LEVELS), an online one's from the servers
   * (key 36 of a downloaded level). Absent, the level has none.
   * [LevelTools::getLevel :120696-121075; GJGameLevel::create :270438-270441;
   *  read by PlayLayer::init :106199-106201]
   */
  capacity?: string;
}
