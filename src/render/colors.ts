// Colour channels: what the header says, what the triggers do to it, and what
// a sprite finally carries.
//
// A level names up to a thousand channels and every drawn sprite follows one of
// them. Channels can copy another channel with a hue shift, can be
// semi-transparent, can ask to be drawn additively, and — once triggers are
// live — can be faded to a new colour or pulsed several times at once.
//
// The game rebuilds the whole table from scratch every frame rather than
// mutating it in place, which is what makes pulses temporary and copy chains
// always current. This does the same: `base` is what the level and its colour
// triggers have settled on, `channels` is what this frame draws with, and
// `process()` is the rebuild. [gdp GJEffectManager::processColors,
// gd-ida-decomp.cpp:478423-478430; see data/ref/trigger-semantics.md]

import type { ColorChannel, HsvShift, LevelHeader } from "../level/types";

/** Highest channel id the game uses; 1000 and up are the named ones. */
export const CHANNEL_COUNT = 1016;
/** Ids past the end are clamped rather than rejected, as every accessor does. [gdp :473586] */
const MAX_CHANNEL = CHANNEL_COUNT - 1;

/**
 * The channels the game names rather than numbers. Six of these are already
 * decoded from the 1.x header keys in src/level/decode.ts; the rest are read
 * off what the object table uses them for.
 *
 * P1 and P2 are the two player colours: 63 objects default their base to 1005
 * and 39 to 1006, and they are the spikes, chains and clouds that follow the
 * icon in the real game. LBG is the light background used by the highlight
 * decorations. BLACK and WHITE are exactly what their art is — the beasts,
 * the black sludge, the pits, the newer sawblades and the fake spikes on one,
 * fire and the shiny-glass highlights on the other.
 * [meas: the bc/dc defaults in assets/objects.json, by frame name]
 */
export const CHANNEL = {
  BG: 1000,
  GROUND: 1001,
  LINE: 1002,
  THREE_D: 1003,
  OBJECT: 1004,
  P1: 1005,
  P2: 1006,
  LIGHT_BG: 1007,
  GROUND_2: 1009,
  BLACK: 1010,
  WHITE: 1011,
  LIGHTER: 1012,
  MIDDLEGROUND: 1013,
  MIDDLEGROUND_2: 1014,
} as const;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface ResolvedChannel extends Rgb {
  /** 0..1. */
  a: number;
  /** Drawn by adding to what is behind it rather than covering it. */
  blending: boolean;
}

/** What the renderer needs from a colour table; the draw list takes this, not the class. */
export interface ColorSource {
  get(id: number | null | undefined): ResolvedChannel;
  /** Pulses waiting on a group; a source without them has none. */
  pulsesForGroup?(group: number): PulseAction[] | undefined;
}

const WHITE: ResolvedChannel = { r: 255, g: 255, b: 255, a: 1, blending: false };

// --- primitives --------------------------------------------------------------

function clampByte(v: number): number {
  return v > 255 ? 255 : v <= 0 ? 0 : Math.trunc(v);
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvParts(h: number, s: number, v: number): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: r + m, g: g + m, b: b + m };
}

/**
 * The general converter, which rounds. The game's own conversion truncates —
 * see applyHsv — but rounding is what a round trip through rgbToHsv needs to
 * come back to the colour it started from, so this stays the one to reach for
 * outside the colour pipeline.
 */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const c = hsvParts(h, s, v);
  return {
    r: Math.round(Math.min(255, Math.max(0, c.r * 255))),
    g: Math.round(Math.min(255, Math.max(0, c.g * 255))),
    b: Math.round(Math.min(255, Math.max(0, c.b * 255))),
  };
}

/** Saturation and value are never allowed all the way to zero. [gdp :43040-43135] */
const HSV_FLOOR = 0.0000999999975;

/**
 * Applies a hue/saturation/value shift, exactly as the game does.
 *
 * Hue is added in degrees. Saturation and value multiply unless their checkbox
 * is set, in which case they add. The multiply reading is what the levels
 * themselves say: across the 12,392 shifts the official levels carry, the
 * saturation checkbox is never set and the value one is set seven times, while
 * the unchecked values run 0.30 to 1.84 and 0.00 to 2.00 — multiplier ranges,
 * not the -1..1 an additive reading would need. The rainbow runs that step hue
 * in tens all carry s = 1, v = 1, which means "leave it alone" only if those
 * multiply. [meas: keys 41-44 across the 27 official levels]
 *
 * Three details come from the decompile rather than from the levels, and each
 * is worth a unit on a channel: the identity shift returns the colour without a
 * round trip at all, s and v are floored just above zero rather than at zero,
 * and the result truncates rather than rounds.
 * [gdp GameToolbox::transformColor, gd-ida-decomp.cpp:43040-43135]
 */
export function applyHsv(colour: Rgb, shift: HsvShift | null): Rgb {
  if (isIdentityHsv(shift)) return colour;
  const s0 = shift as HsvShift;
  const { h, s, v } = rgbToHsv(colour.r, colour.g, colour.b);
  let h2 = h;
  if (s0.h !== 0) {
    h2 = h + s0.h;
    if (h2 > 360) h2 %= 360;
    if (h2 < 0) h2 += 360;
  }
  let s2 = s0.sChecked ? s + s0.s : s * s0.s;
  s2 = s2 >= 1 ? 1 : s2 <= HSV_FLOOR ? HSV_FLOOR : s2;
  let v2 = s0.vChecked ? v + s0.v : v * s0.v;
  v2 = v2 >= 1 ? 1 : v2 <= HSV_FLOOR ? HSV_FLOOR : v2;
  const c = hsvParts(h2, s2, v2);
  return { r: clampByte(c.r * 255), g: clampByte(c.g * 255), b: clampByte(c.b * 255) };
}

/** True when a shift would leave every colour untouched. */
export function isIdentityHsv(shift: HsvShift | null | undefined): boolean {
  return !shift || (shift.h === 0 && shift.s === 1 && shift.v === 1 && !shift.sChecked && !shift.vChecked);
}

/**
 * The lerp every colour fade and pulse is built from. It truncates, which is
 * why a fade that should land on 128 spends a frame on 127.
 * [gdp GameToolbox::multipliedColorValue, gd-ida-decomp.cpp:43177-43215]
 */
export function multipliedColorValue(from: Rgb, to: Rgb, t: number): Rgb {
  if (t >= 1) return to;
  if (t <= 0) return from;
  return {
    r: Math.trunc(from.r + (to.r - from.r) * t),
    g: Math.trunc(from.g + (to.g - from.g) * t),
    b: Math.trunc(from.b + (to.b - from.b) * t),
  };
}

/**
 * (1 - t) * b + t * a — note the argument order, which is the opposite way
 * round from a normal lerp. [gdp GJEffectManager::getMixedColor :474965-475020]
 */
export function mixColor(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: clampByte((1 - t) * b.r + t * a.r),
    g: clampByte((1 - t) * b.g + t * a.g),
    b: clampByte((1 - t) * b.b + t * a.b),
  };
}

/**
 * Scales a shift back toward "no shift" by t, which is how an HSV pulse fades
 * in smoothly instead of snapping. [gdp GameToolbox::getMultipliedHSV :43304-43350]
 */
export function multipliedHsv(shift: HsvShift, t: number): HsvShift {
  return {
    h: shift.h * t,
    s: shift.sChecked ? shift.s * t : 1 - t + shift.s * t,
    v: shift.vChecked ? shift.v * t : 1 - t + shift.v * t,
    sChecked: shift.sChecked,
    vChecked: shift.vChecked,
  };
}

/**
 * A channel's opacity as an object wears it: a byte, whole over 249, else
 * times 0.004. So 0.825 is 210, worn at 0.84, and 0.98 is 249, worn at
 * 0.996. The object's own sprites and its particle system both take this.
 * [GameObject::opacityModForMode :172788-172808 (the channel's +264 is its
 *  opacity times 255, :474223); updateVisibility :95919-95925 keeps it in
 *  +952+8, which GameObject::setOpacity :167631-167636 multiplies the
 *  sprite's opacity by]
 */
export function channelOpacityMod(a: number): number {
  const byte = Math.trunc(a * 255) & 255;
  return byte > 249 ? 1 : byte * 0.004;
}

/** What a channel is before the header says otherwise. */
function channelDefault(id: number): ResolvedChannel {
  if (id === CHANNEL.BLACK) return { r: 0, g: 0, b: 0, a: 1, blending: false };
  return { ...WHITE };
}

/**
 * Channels whose colour the level does not get to choose.
 *
 * Levels write a placeholder into these and the game ignores it: Fingerdash,
 * Dash and the Towers all store rgb(255,255,255) for 1010 and 1011, while 1010
 * is the default main colour of the objects that are black by default — the
 * beasts, the black sludge, the pits, the 1705-1710 blades and the fake
 * spikes 1889-1892 — wherever key 21 does not recolour them: 128 objects in
 * Geometrical Dominator, the beasts in Fingerdash. Taking the header at its
 * word paints every one of them white. The reads are hard-coded in the game,
 * so a colour trigger or a pulse aimed at one of these does nothing either;
 * only opacity lands.
 * [gdp GJEffectManager::activeColorForIndex :473619-473660]
 */
const FIXED_COLORS = new Map<number, Rgb>([
  [0, { r: 255, g: 255, b: 255 }],
  [CHANNEL.BLACK, { r: 0, g: 0, b: 0 }],
  [CHANNEL.WHITE, { r: 255, g: 255, b: 255 }],
]);

/**
 * The light-background channel, which a level never authors: it is computed
 * from the background colour every frame.
 *
 * Take the background, desaturate it a fifth and brighten it a fifth. Then, if
 * the background is very dark — the three components summing under 150 — slide
 * the result towards the player's own colour, all the way when the background
 * is pure black. That last clause is why it matters: Fingerdash has an almost
 * black background and 1,479 sprites on this channel, so getting it wrong
 * paints a fifth of the level the wrong colour. The sum is taken on the
 * original background, not on the shifted one.
 * [gdp GJEffectManager::calculateLightBGColor :475038-475075]
 */
const LIGHT_BG_SHIFT: HsvShift = { h: 0, s: -0.2, v: 0.2, sChecked: true, vChecked: true };
/** Below this, the background counts as dark enough to borrow the player's colour. */
const LIGHT_BG_DARK_SUM = 150;

export function lightBackgroundColor(background: Rgb, player1: Rgb): Rgb {
  const shifted = applyHsv(background, LIGHT_BG_SHIFT);
  const sum = background.r + background.g + background.b;
  if (sum >= LIGHT_BG_DARK_SUM) return shifted;
  return mixColor(shifted, player1, sum / LIGHT_BG_DARK_SUM);
}

/**
 * Channel 1012 is derived per object rather than per channel: it is the
 * object's own main colour, desaturated to 0.65 and lifted by 0.15.
 * [gdp GameObject::getActiveColorForMode :172972-173000]
 */
const LIGHTER_SHIFT: HsvShift = { h: 0, s: 0.65, v: 0.15, sChecked: false, vChecked: true };

export function lighterColor(main: Rgb): Rgb {
  return applyHsv(main, LIGHTER_SHIFT);
}

/**
 * An icon colour brightened until its strongest part is full, by at most half
 * again; one that already has a full part is left alone. The game keeps the
 * player's colours this way for everything but the icon itself.
 * [GameToolbox::strongColor, gd-ida-decomp.cpp:43436-43470 (float maths,
 *  truncated)]
 */
export function strongColor(c: Rgb): Rgb {
  if (c.r === 255 || c.g === 255 || c.b === 255) return { r: c.r, g: c.g, b: c.b };
  const max = Math.max(c.r, c.g, c.b);
  const k = Math.min(1.5, Math.fround(255 / max));
  return {
    r: Math.trunc(Math.fround(c.r * k)),
    g: Math.trunc(Math.fround(c.g * k)),
    b: Math.trunc(Math.fround(c.b * k)),
  };
}

/**
 * The two colours the level sees as the player's: player 1's first and
 * second icon colours, each strengthened. A black first colour hands over to
 * the second, and two black ones make both white.
 * [PlayerObject::updateGlowColor, gd-ida-decomp.cpp:146119-146173 (+2122 and
 *  +2125), for player 1 at GJBaseGameLayer::createPlayer :417905-417930]
 */
export function playerChannelColours(first: Rgb, second: Rgb): { p1: Rgb; p2: Rgb } {
  const lit = (c: Rgb): boolean => c.r !== 0 || c.g !== 0 || c.b !== 0;
  let a: Rgb;
  let b: Rgb;
  if (lit(first)) {
    a = first;
    b = lit(second) ? second : first;
  } else {
    a = b = lit(second) ? second : { r: 255, g: 255, b: 255 };
  }
  return { p1: strongColor(a), p2: strongColor(b) };
}

// --- live actions ------------------------------------------------------------

/** A colour trigger in flight. One per channel; a new trigger replaces it. */
export interface ColorFade {
  channel: number;
  elapsed: number;
  duration: number;
  from: Rgb;
  to: Rgb;
  fromOpacity: number;
  toOpacity: number;
  current: Rgb;
  currentOpacity: number;
  finished: boolean;
  /** The colour trigger that started it, and its control id, for Stop. */
  trigger?: number;
  controlId?: number;
  /** Paused by a Stop trigger: it holds where it is. */
  paused?: boolean;
}

/** One pulse, on a channel or on a group. */
export interface PulseAction {
  /** Channel id, or group id when this pulse lives in the group map. */
  target: number;
  fadeIn: number;
  hold: number;
  fadeOut: number;
  elapsed: number;
  /** Envelope 0..1, recomputed every frame. */
  value: number;
  /** 1 = shift the target's own colour, 2 = fade toward a colour. */
  mode: 1 | 2;
  colour: Rgb;
  hsv: HsvShift;
  /** Non-zero: shift that channel's colour instead of the target's own. */
  copyChannel: number;
  mainOnly: boolean;
  detailOnly: boolean;
  /** Ramp the shift in over the fade rather than applying it at full strength. */
  animateHsv: boolean;
  /** The Pulse trigger that started it, and its control id, for Stop. */
  trigger?: number;
  controlId?: number;
  /** Paused by a Stop trigger: it holds where it is. */
  paused?: boolean;
}

/**
 * The envelope: a straight ramp up, a hold, a straight ramp down. No easing.
 * A zero fade-in is not a division by zero — it takes the "past the ramp"
 * branch at t = 0. [gdp PulseEffectAction::valueForDelta :472676-472700]
 */
export function pulseEnvelope(t: number, fadeIn: number, hold: number, fadeOut: number): number {
  if (t < fadeIn) return t / fadeIn;
  if (t <= fadeIn + hold) return 1;
  if (fadeOut <= 0) return 0;
  return 1 - (t - fadeIn - hold) / fadeOut;
}

function pulseFinished(p: PulseAction): boolean {
  return p.elapsed >= p.fadeIn + p.hold + p.fadeOut;
}

/**
 * Whether a group pulse touches the main sprite or the detail one. Both flags
 * set behaves the same as neither. [gdp GJEffectManager::colorForGroupID :477480]
 */
export function pulseAppliesTo(p: PulseAction, isMain: boolean): boolean {
  if (p.mainOnly && p.detailOnly) return true;
  if (p.mainOnly) return isMain;
  if (p.detailOnly) return !isMain;
  return true;
}

/** What one pulse does to a colour. [gdp GJEffectManager::colorForPulseEffect :474297-474440] */
export function colorForPulse(base: Rgb, p: PulseAction, source: (channel: number) => Rgb): Rgb {
  const t = p.value;
  if (t <= 0) return base;
  if (p.mode === 2) return t >= 1 ? p.colour : multipliedColorValue(base, p.colour, t);
  const src = p.copyChannel !== 0 ? source(p.copyChannel) : base;
  if (t >= 1) return applyHsv(src, p.hsv);
  const shift = p.animateHsv ? multipliedHsv(p.hsv, t) : p.hsv;
  // The blend is back toward the target's own colour, not toward the source.
  return multipliedColorValue(base, applyHsv(src, shift), t);
}

/** A colour trigger's payload, as the runtime hands it over. */
export interface ColorChange {
  channel: number;
  r: number;
  g: number;
  b: number;
  duration: number;
  opacity: number;
  blending: boolean;
  copyId: number;
  copyHsv: HsvShift | null;
  copyOpacity: boolean;
  /** The colour trigger that started it, and its control id, for Stop. */
  trigger?: number;
  controlId?: number;
}

export interface ColorTableOptions {
  /** The player's two icon colours as chosen; the table strengthens them itself. */
  player1?: Rgb;
  player2?: Rgb;
}

// --- the table ---------------------------------------------------------------

/**
 * Every channel, live.
 *
 * `base` is the settled colour — what the header said, then whatever the last
 * colour trigger faded it to. `channels` is this frame's result, rebuilt from
 * `base` by process(): copy chains resolved, pulses folded in, the derived
 * channels overwritten. Pulses never touch `base`, which is exactly why they
 * are temporary.
 */
export class ColorTable implements ColorSource {
  private readonly channels: ResolvedChannel[] = [];
  private readonly base: Rgb[] = [];
  private readonly opacity = new Float32Array(CHANNEL_COUNT);
  private readonly blend = new Uint8Array(CHANNEL_COUNT);
  private readonly copyId = new Int32Array(CHANNEL_COUNT);
  private readonly copyHsv: (HsvShift | null)[] = new Array(CHANNEL_COUNT).fill(null);
  private readonly copyOpacity = new Uint8Array(CHANNEL_COUNT);
  private readonly resolving = new Uint8Array(CHANNEL_COUNT);
  private fades: ColorFade[] = [];
  private channelPulses: PulseAction[] = [];
  private groupPulses = new Map<number, PulseAction[]>();
  private p1: Rgb = { r: 0, g: 255, b: 119 };
  private p2: Rgb = { r: 0, g: 187, b: 255 };
  /** The icon colours as chosen, before `resolve` strengthens them into `p1` and `p2`. */
  private icon1: Rgb = { ...this.p1 };
  private icon2: Rgb = { ...this.p2 };
  /** Channels whose copy source formed a loop; the HUD can show them. */
  readonly cycles: number[] = [];

  private constructor() {
    for (let id = 0; id < CHANNEL_COUNT; id++) {
      const d = channelDefault(id);
      this.channels[id] = d;
      this.base[id] = { r: d.r, g: d.g, b: d.b };
      this.opacity[id] = 1;
    }
  }

  /** Builds the table the header describes and resolves it once. */
  static resolve(header: LevelHeader, options: ColorTableOptions = {}): ColorTable {
    const table = new ColorTable();
    table.icon1 = { ...(options.player1 ?? table.icon1) };
    table.icon2 = { ...(options.player2 ?? table.icon2) };
    const players = playerChannelColours(table.icon1, table.icon2);
    table.p1 = players.p1;
    table.p2 = players.p2;
    for (const [id, spec] of header.colors) table.setFromHeader(id, spec);
    // P1 and P2 are the player's colours and additive, whatever the header
    // stored for them: the game writes both over the level's own entries
    // before it loads the table. Their opacity and copy settings stay.
    // [PlayLayer::setupHasCompleted :106214-106234, then loadDefaultColors
    //  :106415 → :102387-102405]
    for (const [id, rgb] of [[CHANNEL.P1, table.p1], [CHANNEL.P2, table.p2]] as const) {
      table.base[id] = { ...rgb };
      table.blend[id] = 1;
    }
    table.process();
    return table;
  }

  /**
   * The player's colour 1 or 2 as the level sees it, strengthened. A colour
   * trigger with key 15 or 16 takes it. [PlayLayer::addObject :90024-90045]
   */
  playerColour(which: 1 | 2): Rgb {
    return { ...(which === 1 ? this.p1 : this.p2) };
  }

  /**
   * The player's colour 1 or 2 as chosen, which the player's own icon wears:
   * only the level's copies of the pair are strengthened.
   * [PlayerObject::updateGlowColor :146102-146112 reads them off the icon's
   *  sprites, which createPlayer colours :417905-417930]
   */
  iconColour(which: 1 | 2): Rgb {
    return { ...(which === 1 ? this.icon1 : this.icon2) };
  }

  private setFromHeader(id: number, spec: ColorChannel): void {
    if (id < 0 || id > MAX_CHANNEL) return;
    const player = spec.playerColor === 1 ? this.p1 : spec.playerColor === 2 ? this.p2 : null;
    const rgb = player ?? { r: spec.r, g: spec.g, b: spec.b };
    this.base[id] = { ...rgb };
    this.opacity[id] = spec.opacity;
    this.blend[id] = spec.blending ? 1 : 0;
    this.copyId[id] = spec.copyId > 0 ? Math.min(spec.copyId, MAX_CHANNEL) : 0;
    this.copyHsv[id] = spec.copyHsv;
    this.copyOpacity[id] = spec.copyOpacity ? 1 : 0;
  }

  get(id: number | null | undefined): ResolvedChannel {
    if (id === null || id === undefined || id < 0 || id > MAX_CHANNEL) return WHITE;
    return this.channels[id] ?? WHITE;
  }

  /** The un-pulsed colour, which is what a new fade starts from. */
  baseColor(id: number): Rgb {
    return this.base[Math.min(Math.max(id, 0), MAX_CHANNEL)];
  }

  /** How many channels the table holds. */
  get named(): number {
    return this.channels.length;
  }

  /** Pulses waiting on a group, for the draw list to fold in per object. */
  pulsesForGroup(group: number): PulseAction[] | undefined {
    return this.groupPulses.get(group);
  }

  get hasGroupPulses(): boolean {
    return this.groupPulses.size > 0;
  }

  /** Live pulse and fade count, for the HUD. */
  get activeEffects(): number {
    let n = this.channelPulses.length;
    for (const f of this.fades) if (!f.finished) n++;
    for (const list of this.groupPulses.values()) n += list.length;
    return n;
  }

  // --- what the triggers do ---

  /**
   * Starts a colour fade. The start colour is sampled now, from the channel's
   * base rather than from whatever a pulse is doing to it this instant.
   * [gdp GJBaseGameLayer::updateColor :415900-415985]
   */
  startFade(change: ColorChange): void {
    const id = change.channel;
    if (id < 0 || id > MAX_CHANNEL) return;
    this.blend[id] = change.blending ? 1 : 0;
    this.copyId[id] = change.copyId > 0 ? Math.min(change.copyId, MAX_CHANNEL) : 0;
    this.copyHsv[id] = change.copyHsv;
    this.copyOpacity[id] = change.copyOpacity ? 1 : 0;
    const from = { ...this.base[id] };
    const to = { r: change.r, g: change.g, b: change.b };
    const fade: ColorFade = {
      channel: id,
      elapsed: 0,
      duration: change.duration,
      from,
      to,
      fromOpacity: this.opacity[id],
      toOpacity: change.opacity,
      current: from,
      currentOpacity: this.opacity[id],
      finished: false,
      trigger: change.trigger,
      controlId: change.controlId,
    };
    this.fades = this.fades.filter((f) => f.channel !== id);
    this.fades.push(fade);
    this.stepFade(fade, 0);
    if (change.duration <= 0) {
      // An instant colour lands now rather than at the next rebuild.
      if (this.copyId[id] === 0) this.base[id] = { ...to };
      if (this.copyId[id] === 0 || !change.copyOpacity) this.opacity[id] = change.opacity;
    }
  }

  /** Adds a pulse. Pulses stack unless the trigger asked to be exclusive. */
  addPulse(p: PulseAction, isGroup: boolean, exclusive: boolean): void {
    p.elapsed = 0;
    p.value = pulseEnvelope(0, p.fadeIn, p.hold, p.fadeOut);
    if (isGroup) {
      const existing = exclusive ? [] : (this.groupPulses.get(p.target) ?? []);
      this.groupPulses.set(p.target, [...existing, p]);
    } else {
      if (exclusive) this.channelPulses = this.channelPulses.filter((q) => q.target !== p.target);
      this.channelPulses = [...this.channelPulses, p];
    }
  }

  /** Sets a channel's opacity directly, which is what the Alpha trigger does to a channel. */
  setOpacity(id: number, opacity: number): void {
    if (id < 0 || id > MAX_CHANNEL) return;
    this.opacity[id] = opacity;
    this.channels[id].a = opacity;
  }

  opacityOf(id: number): number {
    if (id < 0 || id > MAX_CHANNEL) return 1;
    return this.opacity[id];
  }

  /**
   * Stop (mode 0), Pause (1) or Resume (2) on the pulses `hit` picks. A
   * stopped pulse goes at once, so its colour is gone on the next rebuild.
   * [gdp GJEffectManager::controlActionsForTrigger :484941-485006]
   */
  controlPulses(hit: (p: PulseAction) => boolean, mode: number): void {
    const apply = (list: PulseAction[]): PulseAction[] => {
      if (mode !== 0) {
        for (const p of list) if (hit(p)) p.paused = mode === 1;
        return list;
      }
      return list.some(hit) ? list.filter((p) => !hit(p)) : list;
    };
    this.channelPulses = apply(this.channelPulses);
    for (const [group, list] of [...this.groupPulses]) {
      const kept = apply(list);
      if (kept.length === 0) this.groupPulses.delete(group);
      else if (kept !== list) this.groupPulses.set(group, kept);
    }
  }

  /**
   * Stop (mode 0), Pause (1) or Resume (2) on the colour fades `hit` picks.
   * A stopped fade finishes where it stands; a paused one holds until resumed.
   * [gdp GJEffectManager::controlActionsForTrigger :484919-484938
   *  (ColorAction +52 finished / +53 paused, matched by +124 unique id)]
   */
  controlFades(hit: (f: ColorFade) => boolean, mode: number): void {
    if (this.fades.length === 0) return;
    for (const f of this.fades) {
      if (!hit(f) || f.finished) continue;
      if (mode === 0) f.finished = true;
      else f.paused = mode === 1;
    }
  }

  /** Drops every pulse, as a respawn does. [gdp removeAllPulseActions :475853] */
  clearPulses(): void {
    this.channelPulses = [];
    this.groupPulses = new Map();
  }

  // --- the per-frame rebuild ---

  /**
   * Steps the fades and pulses by one frame. The game does this once per
   * rendered frame with the whole frame's delta, not once per physics tick, so
   * a trigger that fires mid-frame still advances by the full frame.
   * [gdp GJBaseGameLayer::update :470054]
   */
  update(dt: number): void {
    for (const fade of this.fades) this.stepFade(fade, dt);
    let live = false;
    for (const p of this.channelPulses) {
      this.stepPulse(p, dt);
      if (pulseFinished(p)) live = true;
    }
    if (live) this.channelPulses = this.channelPulses.filter((p) => !pulseFinished(p));
    if (this.groupPulses.size > 0) {
      for (const [group, list] of [...this.groupPulses]) {
        for (const p of list) this.stepPulse(p, dt);
        const kept = list.filter((p) => !pulseFinished(p));
        if (kept.length === 0) this.groupPulses.delete(group);
        else if (kept.length !== list.length) this.groupPulses.set(group, kept);
      }
    }
  }

  private stepFade(fade: ColorFade, dt: number): void {
    if (fade.finished || fade.paused) return;
    fade.elapsed += dt;
    const t = fade.elapsed;
    if (t >= fade.duration) {
      fade.current = fade.to;
      fade.currentOpacity = fade.toOpacity;
      fade.finished = true;
    } else if (t <= 0) {
      fade.current = fade.from;
      fade.currentOpacity = fade.fromOpacity;
    } else {
      const p = t / fade.duration;
      fade.current = multipliedColorValue(fade.from, fade.to, p);
      fade.currentOpacity = fade.fromOpacity + (fade.toOpacity - fade.fromOpacity) * p;
    }
    // A fade on a plain channel writes straight through to the base colour; a
    // copy channel leaves that to the inheritance pass. [gdp updateColorEffects :474242]
    if (this.copyId[fade.channel] === 0) {
      this.base[fade.channel] = fade.current;
      this.opacity[fade.channel] = fade.currentOpacity;
    }
  }

  private stepPulse(p: PulseAction, dt: number): void {
    if (!p.paused) p.elapsed += dt;
    p.value = pulseEnvelope(p.elapsed, p.fadeIn, p.hold, p.fadeOut);
  }

  private readonly source = (id: number): Rgb => this.channels[Math.min(Math.max(id, 0), MAX_CHANNEL)];

  /**
   * Rebuilds every channel's drawn colour from its base, in the game's order:
   * reset, channel pulses, copy chains, copy-source pulses, then the derived
   * channels.
   */
  process(): void {
    this.cycles.length = 0;

    // 1. Everything starts from its base, copy channels pre-shifted.
    for (let id = 0; id < CHANNEL_COUNT; id++) {
      const b = this.base[id];
      const c = this.channels[id];
      const shifted = this.copyId[id] > 0 ? applyHsv(b, this.copyHsv[id]) : b;
      c.r = shifted.r;
      c.g = shifted.g;
      c.b = shifted.b;
      c.a = this.opacity[id];
      c.blending = this.blend[id] === 1;
    }

    // 2. Plain channel pulses, in the order they were added, each stacking on
    //    the one before.
    for (const p of this.channelPulses) {
      if (p.copyChannel !== 0) continue;
      const id = p.target;
      if (id < 0 || id > MAX_CHANNEL || this.copyId[id] !== 0) continue;
      const out = colorForPulse(this.channels[id], p, this.source);
      this.channels[id].r = out.r;
      this.channels[id].g = out.g;
      this.channels[id].b = out.b;
    }

    // 3. Copy chains, parents first.
    this.resolving.fill(0);
    for (let id = 0; id < CHANNEL_COUNT; id++) {
      if (this.copyId[id] > 0 && this.resolving[id] === 0) this.resolveCopy(id, 0);
    }

    // 4. Pulses that shift another channel's colour commit together, so several
    //    on one channel in a frame leave only the last one's result.
    let anyCopySource = false;
    for (const p of this.channelPulses) {
      if (p.copyChannel !== 0) {
        anyCopySource = true;
        break;
      }
    }
    if (anyCopySource) {
      const staged = new Map<number, Rgb>();
      for (const p of this.channelPulses) {
        if (p.copyChannel === 0) continue;
        const id = Math.min(Math.max(p.target, 0), MAX_CHANNEL);
        staged.set(id, colorForPulse(this.channels[id], p, this.source));
      }
      for (const [id, rgb] of staged) {
        this.channels[id].r = rgb.r;
        this.channels[id].g = rgb.g;
        this.channels[id].b = rgb.b;
      }
    }

    // 5. The channels a level does not get to choose.
    for (const [id, rgb] of FIXED_COLORS) {
      const c = this.channels[id];
      c.r = rgb.r;
      c.g = rgb.g;
      c.b = rgb.b;
    }
    // LightBG is derived last, which is why a trigger aimed at it never shows.
    const light = lightBackgroundColor(this.channels[CHANNEL.BG], this.channels[CHANNEL.P1]);
    const lc = this.channels[CHANNEL.LIGHT_BG];
    lc.r = light.r;
    lc.g = light.g;
    lc.b = light.b;
  }

  private resolveCopy(id: number, depth: number): void {
    if (this.resolving[id] === 2) return;
    if (this.resolving[id] === 1 || depth > 12) {
      // A channel that copies itself, directly or round a ring. The game has to
      // break this somewhere too; leaving the pre-shifted base is the least
      // surprising answer and the cycle is reported rather than hidden.
      if (!this.cycles.includes(id)) this.cycles.push(id);
      this.resolving[id] = 2;
      return;
    }
    this.resolving[id] = 1;
    const from = this.copyId[id];
    if (this.copyId[from] > 0) this.resolveCopy(from, depth + 1);
    const src = this.channels[from];
    let c: Rgb = applyHsv({ r: src.r, g: src.g, b: src.b }, this.copyHsv[id]);
    for (const p of this.channelPulses) {
      if (p.target === id && p.copyChannel === 0) c = colorForPulse(c, p, this.source);
    }
    const out = this.channels[id];
    out.r = c.r;
    out.g = c.g;
    out.b = c.b;
    if (this.copyOpacity[id] === 1) out.a = src.a;
    this.base[id] = { r: c.r, g: c.g, b: c.b };
    this.resolving[id] = 2;
  }

  // --- save / restore ---

  /** A deep capture of everything a colour trigger can have changed. */
  capture(): ColorSnapshot {
    return {
      base: this.base.map((c) => ({ ...c })),
      opacity: this.opacity.slice(),
      blend: this.blend.slice(),
      copyId: this.copyId.slice(),
      copyHsv: this.copyHsv.slice(),
      copyOpacity: this.copyOpacity.slice(),
      fades: this.fades.map((f) => ({ ...f })),
      channelPulses: this.channelPulses.map((p) => ({ ...p })),
      groupPulses: new Map([...this.groupPulses].map(([g, l]) => [g, l.map((p) => ({ ...p }))])),
    };
  }

  restore(snap: ColorSnapshot): void {
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      this.base[i] = { ...snap.base[i] };
      this.copyHsv[i] = snap.copyHsv[i];
    }
    this.opacity.set(snap.opacity);
    this.blend.set(snap.blend);
    this.copyId.set(snap.copyId);
    this.copyOpacity.set(snap.copyOpacity);
    this.fades = snap.fades.map((f) => ({ ...f }));
    this.channelPulses = snap.channelPulses.map((p) => ({ ...p }));
    this.groupPulses = new Map([...snap.groupPulses].map(([g, l]) => [g, l.map((p) => ({ ...p }))]));
    this.process();
  }
}

export interface ColorSnapshot {
  base: Rgb[];
  opacity: Float32Array;
  blend: Uint8Array;
  copyId: Int32Array;
  copyHsv: (HsvShift | null)[];
  copyOpacity: Uint8Array;
  fades: ColorFade[];
  channelPulses: PulseAction[];
  groupPulses: Map<number, PulseAction[]>;
}

/** Describes a channel for a HUD line. */
export function describeChannel(c: ResolvedChannel): string {
  const hex = (n: number): string => n.toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${c.a < 1 ? ` ${Math.round(c.a * 100)}%` : ""}${c.blending ? " additive" : ""}`;
}
