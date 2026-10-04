// Everything the interface draws with, as quads the batch can write.
//
// Three sources, one lookup:
//   - the gameplay sheets, which already hold the 152 `GJ_*Btn` frames, the
//     difficulty faces, the coins, the locks and the stars;
//   - `ui.json`, the packed page of window frames, buttons, sliders, the logo,
//     one font's glyphs and the loose PNGs the install keeps outside a sheet;
//   - `fonts.json`, whose pages are separate images with their own units —
//     except the face the build packed onto the page, which is read from there.
//
// A name is looked up in the interface page first and the sheets second, so a
// packed piece always wins over a same-named frame.

import { AtlasSet } from "../assets/atlas";
import type { Font, FontFile, UiArtFile } from "../assets/miscTypes";
import { fetchAsset } from "../assets/paths";
import { SHEET_FONT, SHEET_FONT_2, SHEET_UI } from "../engine/gl/spriteBatch";
import { frameQuad } from "../render/frameQuad";
import type { UiQuad } from "./draw";
import { measure, scaleToFit, type TextOptions } from "./text";

export type FontName = "bigFont" | "goldFont" | "chatFont";

/**
 * The units the font pages get, in order. A font past the end of this list is
 * not drawn at all rather than taking a turn on a unit another font is using —
 * two fonts are all the units allow, and a page swapped out halfway through a
 * frame draws one font's glyphs out of the other's image. The third face the
 * menus use is packed onto the interface page and never asks for a unit.
 */
const FONT_UNITS: readonly number[] = [SHEET_FONT, SHEET_FONT_2];

/** Which unit each of `fonts` draws from. Fixed once, at load. */
export function assignFontUnits(fonts: readonly FontName[]): Map<FontName, number> {
  const out = new Map<FontName, number>();
  for (const name of fonts) {
    if (out.has(name)) continue;
    const unit = FONT_UNITS[out.size];
    if (unit === undefined) break;
    out.set(name, unit);
  }
  return out;
}

/** A glyph's place on a page, for a face whose page is packed onto the interface page. */
export function packedGlyphQuad(
  page: { pageWidth: number; pageHeight: number },
  packed: { x: number; y: number },
  char: { x: number; y: number; w: number; h: number },
  pxPerUnit: number,
  unit: number,
): UiQuad {
  return {
    u0: (packed.x + char.x) / page.pageWidth,
    v0: (packed.y + char.y) / page.pageHeight,
    du: char.w / page.pageWidth,
    dv: char.h / page.pageHeight,
    unit,
    w: char.w / pxPerUnit,
    h: char.h / pxPerUnit,
  };
}

export class UiArt {
  private readonly quads = new Map<string, UiQuad | null>();

  private constructor(
    private readonly atlas: AtlasSet,
    readonly page: UiArtFile,
    readonly fonts: FontFile,
  ) {}

  static async load(atlas: AtlasSet): Promise<UiArt> {
    const [page, fonts] = await Promise.all([
      fetchAsset<UiArtFile>("ui.json"),
      fetchAsset<FontFile>("fonts/fonts.json"),
    ]);
    return new UiArt(atlas, page, fonts);
  }

  /** The packed page's own image path, for the renderer to upload. */
  get pageImage(): string {
    return this.page.page;
  }

  /** The main menu's backdrop tile and ground tile, when the build shipped them. */
  get menu(): UiArtFile["menu"] {
    return this.page.menu;
  }

  /** True for a face whose glyphs are on the interface page rather than a unit. */
  isPacked(name: FontName): boolean {
    return (this.page.packedFonts ?? []).includes(name) && name in this.page.images;
  }

  /** The page a font wants uploaded, or null for one that is packed. */
  fontImage(name: FontName): string | null {
    if (this.isPacked(name)) return null;
    return this.fonts.fonts[name]?.image ?? null;
  }

  font(name: FontName): Font | undefined {
    return this.fonts.fonts[name];
  }

  get fontPxPerUnit(): number {
    return this.fonts.pxPerUnit;
  }

  /** The box a run of text takes up, for a screen laying things out beside it. */
  measure(name: FontName, text: string, opts: TextOptions = {}): { width: number; height: number } {
    const font = this.fonts.fonts[name];
    if (!font) return { width: 0, height: 0 };
    return measure(font, this.fonts.pxPerUnit, text, opts);
  }

  /**
   * The largest scale up to `max` at which `text` fits in `maxWidth`, which
   * is how the game sizes a level's name to its panel.
   * [gdp CCLabelBMFont::limitLabelWidth]
   */
  fit(name: FontName, text: string, maxWidth: number, max = 1): number {
    const font = this.fonts.fonts[name];
    if (!font) return max;
    return scaleToFit(font, this.fonts.pxPerUnit, text, maxWidth, max);
  }

  /**
   * A named piece of art. Null when neither source has it, so a screen shows
   * nothing rather than a wrong sprite — and the caller can say so.
   */
  quad(name: string): UiQuad | null {
    const cached = this.quads.get(name);
    if (cached !== undefined) return cached;
    const built = this.build(name);
    this.quads.set(name, built);
    return built;
  }

  /**
   * One glyph of a font. `unit` is the unit the font's page is bound to; it is
   * ignored for a packed face, whose glyphs are on the interface page.
   */
  glyph(name: FontName, unit: number, code: number): UiQuad | null {
    const font = this.fonts.fonts[name];
    const char = font?.chars[code];
    if (!font || !char) return null;
    const packed = this.isPacked(name) ? this.page.images[name] : undefined;
    if (packed) return packedGlyphQuad(this.page, packed, char, this.fonts.pxPerUnit, SHEET_UI);
    return {
      u0: char.x / font.scaleW,
      v0: char.y / font.scaleH,
      du: char.w / font.scaleW,
      dv: char.h / font.scaleH,
      unit,
      w: char.w / this.fonts.pxPerUnit,
      h: char.h / this.fonts.pxPerUnit,
    };
  }

  private build(name: string): UiQuad | null {
    const packed = this.page.images[name];
    if (packed) {
      return {
        u0: packed.x / this.page.pageWidth,
        v0: packed.y / this.page.pageHeight,
        du: packed.w / this.page.pageWidth,
        dv: packed.h / this.page.pageHeight,
        unit: SHEET_UI,
        w: packed.w / packed.pxPerUnit,
        h: packed.h / packed.pxPerUnit,
      };
    }
    const located = this.atlas.frame(name);
    if (!located) return null;
    const q = frameQuad(located.atlas, located.frame, this.atlas.pxPerUnit);
    return {
      // A rotated frame's `du` is negative and its u0 sits at the far edge;
      // subQuad and the shader both already understand that pairing.
      u0: q.u0,
      v0: q.v0,
      du: q.du,
      dv: q.dv,
      unit: located.atlasIndex,
      w: q.hw * 2,
      h: q.hh * 2,
      offsetX: q.cx,
      offsetY: q.cy,
      rotated: q.rotated,
    };
  }
}

/**
 * The frames the interface is built from, in one place so a missing one is a
 * single edit and a screen never spells a name inline.
 *
 * Every entry was checked against the built atlas and `ui.json`; `npm test`
 * checks them again, because a name that resolves to nothing draws nothing and
 * says nothing. The comments say which of the game's screens each one is
 * taken from, so a frame is never guessed at from its name.
 */
export const FRAMES = {
  // --- window frames, packed. The eight GJ_square* are the game's own popups,
  // one colour each; the two plain squares are what the level page and the
  // pause menu tint.
  panel: "GJ_square01",
  panelBlue: "GJ_square02",
  panelGreen: "GJ_square03",
  panelPurple: "GJ_square04",
  panelDark: "GJ_square05",
  panelGrey: "GJ_square06",
  panelWhite: "GJ_square07",
  panelTall: "GJ_squareB_01",
  squareBlack: "square02_001",
  squareWhite: "square04_001",
  rewardsLabel: "rewardsLabel_001.png",
  rewardCorner: "rewardCorner_001.png",
  freeChest: "GJ_freeChestBtn_001.png",
  chestSmall: "chest_01_02_001.png",
  chestBig: "chest_02_02_001.png",
  squareTight: "square02b_001",
  squareTightSmall: "square02b_small",
  button: "GJ_button_01",
  buttonGreen: "GJ_button_02",
  buttonRed: "GJ_button_04",
  /** The vertical wash under every menu but the first; tinted per screen. */
  gradient: "GJ_gradientBG",
  logo: "GJ_logo_001.png",
  white: "square",
  /** A plain white disc. */
  circle: "circle",

  // --- the main menu [MenuLayer::init]
  play: "GJ_playBtn_001.png",
  garage: "GJ_garageBtn_001.png",
  creator: "GJ_creatorBtn_001.png",
  achievements: "GJ_achBtn_001.png",
  options: "GJ_optionsBtn_001.png",
  stats: "GJ_statsBtn_001.png",
  newgrounds: "GJ_ngBtn_001.png",
  daily: "GJ_dailyRewardBtn_001.png",
  moreGames: "GJ_moreGamesBtn_001.png",
  robtop: "robtoplogo_small.png",
  developedBy: "developedBy_001.png",
  poweredBy: "poweredBy_001.png",
  cocosLogo: "cocos2DxLogo.png",
  facebook: "gj_fbIcon_001.png",
  twitter: "gj_twIcon_001.png",
  youtube: "gj_ytIcon_001.png",
  twitch: "gj_twitchIcon_001.png",
  discord: "gj_discordIcon_001.png",
  /** The bright line along the top of the menu's ground. */
  floorLine: "floorLine_001.png",

  // --- chrome shared by the level select, the kit and the creator page
  /** The stair-step blocks in the corners. Drawn flipped for the right side. */
  sideArt: "GJ_sideArt_001.png",
  /** The block strip hanging from the top of the level select. */
  topBar: "GJ_topBar_001.png",
  /** The green arrow: back on the level select, paging in the kit. */
  arrowGreen: "GJ_arrow_01_001.png",
  arrowGreenRight: "GJ_arrow_02_001.png",
  /** The pink arrow: back on the kit and the creator page. */
  arrowPink: "GJ_arrow_03_001.png",
  /** The big white page arrow on the level select; flipped for the right one. */
  navArrow: "navArrowBtn_001.png",
  /** The Tower's page on the level select: the door and the pixel label over it. */
  towerDoor: "theTowerDoor_001.png",
  towerLabel: "theTowerLabel_001.png",
  infoIcon: "GJ_infoIcon_001.png",
  close: "GJ_closeBtn_001.png",
  /** The small white arrows either side of a value you step through. */
  stepLeft: "edit_leftBtn_001.png",
  stepRight: "edit_rightBtn_001.png",
  /** The folder on the Audio options page, and the face on the Other page. */
  savedSongs: "GJ_savedSongsBtn_001.png",
  profileButton: "GJ_profileButton_001.png",
  /** The dark field the music offset is typed into. */
  offsetField: "square02_small",

  // --- the green table the settings drop down in [GJListLayer::init, GJDropDownLayer::init]
  tableTop: "GJ_table_top_001.png",
  tableBottom: "GJ_table_bottom_001.png",
  /** The left side; flipped for the right. */
  tableSide: "GJ_table_side_001.png",
  chain: "chain_01_001.png",
  dotOn: "gj_navDotBtn_on_001.png",
  dotOff: "gj_navDotBtn_off_001.png",

  // --- currency and progress
  star: "GJ_starsIcon_001.png",
  starGrey: "GJ_starsIcon_gray_001.png",
  moon: "GJ_moonsIcon_001.png",
  coin: "GJ_coinsIcon_001.png",
  coinGrey: "GJ_coinsIcon_gray_001.png",
  userCoin: "GJ_coinsIcon2_001.png",
  orb: "currencyOrbIcon_001.png",
  diamond: "GJ_diamondsIcon_001.png",
  secretCoin: "secretCoin_01_001.png",
  lock: "GJ_lock_001.png",
  lockGrey: "GJ_lockGray_001.png",
  lockOpen: "GJ_lock_open_001.png",
  /** The square frame the game puts round the chosen icon. */
  select: "GJ_select_001.png",
  /** The cell behind every icon in the kit's grid. */
  playerSquare: "playerSquare_001.png",
  checkOn: "GJ_checkOn_001.png",
  checkOff: "GJ_checkOff_001.png",
  progressBar: "GJ_progressBar_001",
  sliderGroove: "slidergroove",
  sliderThumb: "sliderthumb",
  sliderThumbHeld: "sliderthumbsel",
  sliderBar: "sliderBar",
  /** The level's own progress bar along the top of the screen, and its fill. */
  hudGroove: "slidergroove2",
  hudFill: "sliderBar2",

  // --- the icon kit [GJGarageLayer::init]
  paint: "GJ_paintBtn_001.png",
  /** "Tap (lock) for more info!", drawn as one picture. */
  unlockText: "GJ_unlockTxt_001.png",
  tabCubeOn: "gj_iconBtn_on_001.png",
  tabCubeOff: "gj_iconBtn_off_001.png",
  tabShipOn: "gj_shipBtn_on_001.png",
  tabShipOff: "gj_shipBtn_off_001.png",
  tabBallOn: "gj_ballBtn_on_001.png",
  tabBallOff: "gj_ballBtn_off_001.png",
  tabUfoOn: "gj_birdBtn_on_001.png",
  tabUfoOff: "gj_birdBtn_off_001.png",
  tabWaveOn: "gj_dartBtn_on_001.png",
  tabWaveOff: "gj_dartBtn_off_001.png",
  tabRobotOn: "gj_robotBtn_on_001.png",
  tabRobotOff: "gj_robotBtn_off_001.png",
  tabSpiderOn: "gj_spiderBtn_on_001.png",
  tabSpiderOff: "gj_spiderBtn_off_001.png",
  tabSwingOn: "gj_swingBtn_on_001.png",
  tabSwingOff: "gj_swingBtn_off_001.png",
  tabJetpackOn: "gj_jetpackBtn_on_001.png",
  tabJetpackOff: "gj_jetpackBtn_off_001.png",

  // --- the creator page [CreatorLayer::init]
  tileCreate: "GJ_createBtn_001.png",
  tileSaved: "GJ_savedBtn_001.png",
  tileScores: "GJ_highscoreBtn_001.png",
  tileQuests: "GJ_challengeBtn_001.png",
  tileVersus: "GJ_versusBtn_001.png",
  tileMap: "GJ_mapBtn_001.png",
  tileDaily: "GJ_dailyBtn_001.png",
  tileWeekly: "GJ_weeklyBtn_001.png",
  tileEvent: "GJ_eventBtn_001.png",
  tileGauntlets: "GJ_gauntletsBtn_001.png",
  tileFeatured: "GJ_featuredBtn_001.png",
  tileLists: "GJ_listsBtn_001.png",
  tilePaths: "GJ_pathsBtn_001.png",
  tileMapPacks: "GJ_mapPacksBtn_001.png",
  tileSearch: "GJ_searchBtn_001.png",
  secretDoor: "secretDoorBtn_closed_001.png",

  // --- online levels [LevelBrowserLayer, LevelCell, LevelInfoLayer, LevelSearchLayer]
  /** Behind a rated level's face: featured, then epic, legendary and mythic. */
  featuredCoin: "GJ_featuredCoin_001.png",
  epicCoin: "GJ_epicCoin_001.png",
  legendaryCoin: "GJ_epicCoin2_001.png",
  mythicCoin: "GJ_epicCoin3_001.png",
  downloads: "GJ_downloadsIcon_001.png",
  likes: "GJ_likesIcon_001.png",
  dislikes: "GJ_dislikesIcon_001.png",
  length: "GJ_timeIcon_001.png",
  smallStar: "GJ_sStarsIcon_001.png",
  completed: "GJ_completesIcon_001.png",
  /** The trophy an achievement shows when it gives nothing. */
  achievementImage: "GJ_achImage_001.png",
  trash: "GJ_trashBtn_001.png",
  find: "gj_findBtn_001.png",

  // --- in the level [UILayer::init, PauseLayer, EndLevelLayer, RetryLevelLayer]
  pause: "GJ_pauseBtn_clean_001.png",
  checkpoint: "GJ_checkpointBtn_001.png",
  removeCheckpoint: "GJ_removeCheckBtn_001.png",
  resume: "GJ_playBtn2_001.png",
  menu: "GJ_menuBtn_001.png",
  replay: "GJ_replayBtn_001.png",
  replayFull: "GJ_replayFullBtn_001.png",
  practice: "GJ_practiceBtn_001.png",
  normal: "GJ_normalBtn_001.png",
  practiceText: "GJ_practiceTxt_001.png",
  optionsText: "GJ_optionsTxt_001.png",
  levelComplete: "GJ_levelComplete_001.png",
  practiceComplete: "GJ_practiceComplete_001.png",
  newBest: "GJ_newBest_001.png",
} as const;

export type FrameName = keyof typeof FRAMES;

/** The level page's difficulty face for a rating; the page uses its own set. */
export function levelPageFace(facts: { difficulty: number; demon: boolean }): string {
  const n = facts.demon ? 6 : Math.max(0, Math.min(5, facts.difficulty));
  return `diffIcon_${String(n).padStart(2, "0")}_btn_001.png`;
}

/**
 * How far in each window frame's own border runs, in design units, so a panel
 * can be grown to any size without smearing its corners. Measured off the art:
 * the `GJ_square*` frames are 320 px at uhd, 80 units, with a 12-unit border;
 * the two plain squares are the same size with an 8-unit corner radius.
 * [meas]
 */
export const INSETS: Record<string, { left: number; right: number; top: number; bottom: number }> = {
  GJ_square01: { left: 12, right: 12, top: 12, bottom: 12 },
  GJ_square02: { left: 12, right: 12, top: 12, bottom: 12 },
  GJ_square03: { left: 12, right: 12, top: 12, bottom: 12 },
  GJ_square04: { left: 12, right: 12, top: 12, bottom: 12 },
  GJ_square05: { left: 12, right: 12, top: 12, bottom: 12 },
  GJ_square06: { left: 12, right: 12, top: 12, bottom: 12 },
  GJ_square07: { left: 12, right: 12, top: 12, bottom: 12 },
  GJ_squareB_01: { left: 14, right: 14, top: 14, bottom: 14 },
  square02_001: { left: 10, right: 10, top: 10, bottom: 10 },
  square04_001: { left: 10, right: 10, top: 10, bottom: 10 },
  square02b_001: { left: 12, right: 12, top: 12, bottom: 12 },
  square02b_small: { left: 6, right: 6, top: 6, bottom: 6 },
  // 160 px at uhd, 40 units, with the corner turning opaque 12 px in. [meas]
  square02_small: { left: 4, right: 4, top: 4, bottom: 4 },
  GJ_button_01: { left: 10, right: 10, top: 10, bottom: 10 },
  GJ_button_02: { left: 10, right: 10, top: 10, bottom: 10 },
  GJ_button_03: { left: 10, right: 10, top: 10, bottom: 10 },
  GJ_button_04: { left: 10, right: 10, top: 10, bottom: 10 },
  GJ_button_05: { left: 10, right: 10, top: 10, bottom: 10 },
  GJ_button_06: { left: 10, right: 10, top: 10, bottom: 10 },
};

export function insetsFor(frame: string): { left: number; right: number; top: number; bottom: number } {
  return INSETS[frame] ?? { left: 8, right: 8, top: 8, bottom: 8 };
}

/**
 * How much a pressed button grows, which is how the game shows a press.
 * [gdp CCMenuItemSpriteExtra's default scale multiplier]
 */
export const PRESS_SCALE = 1.26;
