// The mod menu's switches: what each one is, and what the player has set.
//
// Kept under a key of its own rather than in the save, so the save's shape
// never has to know the menu exists and resetting progress leaves the menu
// as it was. Nothing here touches the DOM; the menu (menu.ts) draws it and
// the game (game.ts) reads it.
//
// A mod marked `cheat` changes how the game plays. While one is on, and for
// the rest of an attempt it was on in, the attempt saves nothing: no best, no
// completion, no coins, no orbs, no attempt or jump counts.

import type { KeyValueStore } from "../save/store";

export const MODS_KEY = "gd:mods";

export type WindowId = "menu" | "player" | "speed" | "level" | "display" | "status" | "macro" | "universal";

/** The windows in the order they are laid out, with their titles. */
export const WINDOWS: ReadonlyArray<{ id: WindowId; title: string }> = [
  { id: "menu", title: "Mod Menu" },
  { id: "player", title: "Player" },
  { id: "speed", title: "Speedhack" },
  { id: "level", title: "Level" },
  { id: "display", title: "Display" },
  { id: "status", title: "Status" },
  { id: "macro", title: "Macro" },
  { id: "universal", title: "Universal" },
];

export interface ModValue {
  min: number;
  max: number;
  step: number;
  initial: number;
  suffix?: string;
}

export interface ModDef {
  id: string;
  label: string;
  window: WindowId;
  /** A switch, a press, a number on its own, or a line of text on its own. */
  kind: "toggle" | "action" | "value" | "text";
  /** What the player reads when they hover it. */
  tip: string;
  /** Changes how the game plays, so nothing saves while it is on. */
  cheat?: boolean;
  /** On for a fresh menu. */
  initial?: boolean;
  /** The number a switch carries, or the number a value row is. */
  value?: ModValue;
  /** The longest a text row can be. */
  maxLength?: number;
}

export const MODS: readonly ModDef[] = [
  // Player
  { id: "noclip", label: "Noclip", window: "player", kind: "toggle", cheat: true, tip: "Nothing can kill you." },
  { id: "jumpHack", label: "Jump Hack", window: "player", kind: "toggle", cheat: true, tip: "Jump again in mid-air." },
  {
    id: "autoClicker",
    label: "Auto Clicker",
    window: "player",
    kind: "toggle",
    cheat: true,
    tip: "Clicks for you, this many times a second.",
    value: { min: 1, max: 30, step: 1, initial: 10, suffix: "/s" },
  },
  { id: "frameStepper", label: "Frame Stepper", window: "player", kind: "toggle", cheat: true, tip: "Freezes the level. Press C to move it on one step." },
  { id: "instantComplete", label: "Instant Complete", window: "player", kind: "action", cheat: true, tip: "Finishes the level now. It won't be saved." },
  { id: "hidePlayer", label: "Hide Player", window: "player", kind: "toggle", tip: "You can't see your icon." },
  { id: "noDeathEffect", label: "No Death Effect", window: "player", kind: "toggle", tip: "No ring when you die." },
  { id: "noRespawnFlash", label: "No Respawn Flash", window: "player", kind: "toggle", tip: "No rings when you start over." },
  { id: "noWaveTrail", label: "No Wave Trail", window: "player", kind: "toggle", tip: "The wave leaves no trail." },
  { id: "sameDualColour", label: "Same Dual Colour", window: "player", kind: "toggle", tip: "Both icons in a dual wear your colours the same way round." },
  {
    id: "rainbowIcon",
    label: "Rainbow Icon",
    window: "player",
    kind: "toggle",
    tip: "Your icon's colours cycle. The number is how fast.",
    value: { min: 0.1, max: 3, step: 0.1, initial: 0.5 },
  },

  // Speedhack
  {
    id: "speedhack",
    label: "Speedhack",
    window: "speed",
    kind: "toggle",
    cheat: true,
    tip: "Runs the level faster or slower. At 1x it changes nothing.",
    value: { min: 0.1, max: 4, step: 0.05, initial: 1, suffix: "x" },
  },
  { id: "speedhackMusic", label: "Speed Up Music", window: "speed", kind: "toggle", initial: true, tip: "The music keeps pace with the speedhack." },

  // Level
  { id: "safeMode", label: "Safe Mode", window: "level", kind: "toggle", tip: "Nothing you do in a level is saved, with or without cheats." },
  { id: "practiceMusic", label: "Practice Music Hack", window: "level", kind: "toggle", tip: "Practice plays the level's own song." },
  {
    id: "respawnTime",
    label: "Respawn Time",
    window: "level",
    kind: "toggle",
    tip: "How long a death waits before you start over, in seconds.",
    value: { min: 0, max: 2, step: 0.1, initial: 0.3, suffix: "s" },
  },
  { id: "startposSwitcher", label: "StartPos Switcher", window: "level", kind: "toggle", tip: "Press Q and E to pick which start position you start from." },
  { id: "ignoreEscape", label: "Ignore Escape", window: "level", kind: "toggle", tip: "Escape doesn't pause the level." },
  { id: "noParticles", label: "No Particles", window: "level", kind: "toggle", tip: "Hides the level's particles." },
  { id: "noShaders", label: "No Screen Effects", window: "level", kind: "toggle", tip: "Turns off the level's screen effects." },
  { id: "noShake", label: "No Shake", window: "level", kind: "toggle", tip: "The screen doesn't shake." },
  { id: "noPulse", label: "No Pulse", window: "level", kind: "toggle", tip: "Nothing pulses to the music." },

  // Display
  { id: "showHitboxes", label: "Show Hitboxes", window: "display", kind: "toggle", tip: "Shows what you can hit." },
  { id: "hitboxesOnDeath", label: "Hitboxes on Death", window: "display", kind: "toggle", tip: "Shows what you hit when you die." },
  { id: "hitboxTrail", label: "Hitbox Trail", window: "display", kind: "toggle", tip: "Shows where your hitbox has been." },
  { id: "noclipFlash", label: "Noclip Flash", window: "display", kind: "toggle", initial: true, tip: "The screen flashes red when noclip saves you." },
  { id: "hideHud", label: "Hide HUD", window: "display", kind: "toggle", tip: "Hides the bar, the percentage and the buttons while you play." },
  { id: "hidePause", label: "Hide Pause Button", window: "display", kind: "toggle", tip: "Hides the pause button. Escape still pauses." },
  { id: "hideAttempts", label: "Hide Attempts", window: "display", kind: "toggle", tip: "Hides the attempt count in the level." },
  {
    id: "accuratePercent",
    label: "Accurate Percentage",
    window: "display",
    kind: "toggle",
    tip: "The percentage with decimals. The number is how many.",
    value: { min: 1, max: 4, step: 1, initial: 2 },
  },

  // Status
  { id: "cheatIndicator", label: "Cheat Indicator", window: "status", kind: "toggle", initial: true, tip: "A dot: green when your progress saves, red when it won't." },
  { id: "fps", label: "FPS", window: "status", kind: "toggle", tip: "Frames drawn a second." },
  { id: "cps", label: "CPS", window: "status", kind: "toggle", tip: "Clicks a second, and clicks this attempt." },
  { id: "noclipAccuracy", label: "Noclip Accuracy", window: "status", kind: "toggle", tip: "How much of the attempt you'd have survived without noclip." },
  { id: "noclipDeaths", label: "Noclip Deaths", window: "status", kind: "toggle", tip: "How many times noclip saved you this attempt." },
  { id: "attempts", label: "Attempts", window: "status", kind: "toggle", tip: "Attempts this visit." },
  { id: "jumps", label: "Jumps", window: "status", kind: "toggle", tip: "Jumps this visit." },
  { id: "bestRun", label: "Best Run", window: "status", kind: "toggle", tip: "Your longest run this visit, from where it started to where it ended." },
  { id: "runInfo", label: "Run Info", window: "status", kind: "toggle", tip: "Where you are, how fast you're going, and your game mode." },
  { id: "levelId", label: "Level ID", window: "status", kind: "toggle", tip: "The level's ID." },
  { id: "sessionTime", label: "Session Time", window: "status", kind: "toggle", tip: "How long you've been playing." },
  { id: "clock", label: "Clock", window: "status", kind: "toggle", tip: "The time of day." },
  { id: "message", label: "Message", window: "status", kind: "text", maxLength: 60, tip: "A line of your own." },
  { id: "statusSize", label: "Size", window: "status", kind: "value", tip: "How big the status text is.", value: { min: 0.5, max: 2, step: 0.1, initial: 1, suffix: "x" } },
  { id: "statusOpacity", label: "Opacity", window: "status", kind: "value", tip: "How see-through the status text is.", value: { min: 0.1, max: 1, step: 0.05, initial: 0.8 } },

  // Universal
  { id: "unlockIcons", label: "Unlock All Icons", window: "universal", kind: "toggle", tip: "Wear any icon or colour in the icon kit." },
  { id: "pauseOnUnfocus", label: "Pause When Unfocused", window: "universal", kind: "toggle", tip: "Pauses the level when you click away." },
  { id: "muteOnUnfocus", label: "Mute When Unfocused", window: "universal", kind: "toggle", tip: "Goes quiet when you click away." },
  { id: "menuSize", label: "Menu Size", window: "universal", kind: "value", tip: "How big this menu is.", value: { min: 0.6, max: 1.6, step: 0.05, initial: 1, suffix: "x" } },
];

const BY_ID: ReadonlyMap<string, ModDef> = new Map(MODS.map((m) => [m.id, m]));

export function modDef(id: string): ModDef | undefined {
  return BY_ID.get(id);
}

export interface WindowPlace {
  x: number;
  y: number;
}

export interface ModState {
  on: Record<string, boolean>;
  values: Record<string, number>;
  texts: Record<string, string>;
  /** Key code → mod id: pressing the key flips the switch, or presses the button. */
  keys: Record<string, string>;
  /** Where the player dragged each window; a window missing here is laid out by itself. */
  windows: Partial<Record<WindowId, WindowPlace>>;
  /** Windows folded down to their title. */
  folded: Partial<Record<WindowId, boolean>>;
}

export function defaultModState(): ModState {
  const state: ModState = { on: {}, values: {}, texts: {}, keys: {}, windows: {}, folded: {} };
  for (const m of MODS) {
    if (m.kind === "toggle") state.on[m.id] = m.initial === true;
    if (m.value) state.values[m.id] = m.value.initial;
    if (m.kind === "text") state.texts[m.id] = "";
  }
  return state;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const WINDOW_IDS: ReadonlySet<string> = new Set(WINDOWS.map((w) => w.id));

/** Whatever was stored, as a state: unknown mods dropped, bad values back to their defaults. */
export function mergeModState(raw: unknown): ModState {
  const state = defaultModState();
  if (!isObject(raw)) return state;
  const on = isObject(raw.on) ? raw.on : {};
  const values = isObject(raw.values) ? raw.values : {};
  const texts = isObject(raw.texts) ? raw.texts : {};
  for (const m of MODS) {
    if (m.kind === "toggle" && typeof on[m.id] === "boolean") state.on[m.id] = on[m.id] as boolean;
    const v = values[m.id];
    if (m.value && typeof v === "number" && Number.isFinite(v)) state.values[m.id] = clampValue(m.value, v);
    const t = texts[m.id];
    if (m.kind === "text" && typeof t === "string") state.texts[m.id] = t.slice(0, m.maxLength ?? 60);
  }
  if (isObject(raw.keys)) {
    for (const [code, id] of Object.entries(raw.keys)) {
      const def = typeof id === "string" ? BY_ID.get(id) : undefined;
      if (def && (def.kind === "toggle" || def.kind === "action") && /^[A-Za-z0-9]+$/.test(code)) state.keys[code] = def.id;
    }
  }
  for (const [field, out] of [["windows", state.windows], ["folded", state.folded]] as const) {
    const src = raw[field];
    if (!isObject(src)) continue;
    for (const [id, v] of Object.entries(src)) {
      if (!WINDOW_IDS.has(id)) continue;
      if (field === "folded" && typeof v === "boolean") (out as ModState["folded"])[id as WindowId] = v;
      if (field === "windows" && isObject(v) && Number.isFinite(v.x) && Number.isFinite(v.y)) {
        (out as ModState["windows"])[id as WindowId] = { x: Number(v.x), y: Number(v.y) };
      }
    }
  }
  return state;
}

/** A number held to its range and rounded to its step. */
export function clampValue(v: ModValue, n: number): number {
  const held = Math.min(v.max, Math.max(v.min, n));
  const steps = Math.round((held - v.min) / v.step);
  return Number((v.min + steps * v.step).toFixed(4));
}

const WRITE_DELAY_MS = 500;

/** The menu's state, kept in storage under MODS_KEY. */
export class ModStore {
  private state: ModState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: KeyValueStore) {
    let raw: unknown = null;
    try {
      const text = storage.getItem(MODS_KEY);
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = null;
    }
    this.state = mergeModState(raw);
  }

  get raw(): Readonly<ModState> {
    return this.state;
  }

  on(id: string): boolean {
    return this.state.on[id] === true;
  }

  value(id: string): number {
    return this.state.values[id] ?? modDef(id)?.value?.initial ?? 0;
  }

  text(id: string): string {
    return this.state.texts[id] ?? "";
  }

  setOn(id: string, on: boolean): void {
    if (modDef(id)?.kind !== "toggle" || this.on(id) === on) return;
    this.change((s) => void (s.on[id] = on));
  }

  setValue(id: string, n: number): void {
    const v = modDef(id)?.value;
    if (!v || !Number.isFinite(n)) return;
    this.change((s) => void (s.values[id] = clampValue(v, n)));
  }

  setText(id: string, text: string): void {
    const def = modDef(id);
    if (def?.kind !== "text") return;
    this.change((s) => void (s.texts[id] = text.slice(0, def.maxLength ?? 60)));
  }

  /** The mod a key is bound to, if any. */
  boundTo(code: string): string | undefined {
    return this.state.keys[code];
  }

  /** The key a mod is bound to, if any. */
  keyOf(id: string): string | undefined {
    for (const [code, bound] of Object.entries(this.state.keys)) if (bound === id) return code;
    return undefined;
  }

  /** Binds `code` to `id`, replacing whatever either had; null clears the mod's key. */
  bind(id: string, code: string | null): void {
    this.change((s) => {
      for (const [k, bound] of Object.entries(s.keys)) if (bound === id || k === code) delete s.keys[k];
      if (code) s.keys[code] = id;
    });
  }

  place(id: WindowId, at: WindowPlace | null): void {
    this.change((s) => {
      if (at) s.windows[id] = { x: Math.round(at.x), y: Math.round(at.y) };
      else delete s.windows[id];
    });
  }

  fold(id: WindowId, folded: boolean): void {
    this.change((s) => void (s.folded[id] = folded));
  }

  /** Every switch off; numbers, text, keys and windows stay. */
  allOff(): void {
    this.change((s) => {
      for (const id of Object.keys(s.on)) s.on[id] = false;
    });
  }

  resetLayout(): void {
    this.change((s) => {
      s.windows = {};
      s.folded = {};
    });
  }

  /**
   * The cheats switched on right now, by name. The speedhack at 1x changes
   * nothing, so it is not one.
   */
  activeCheats(): string[] {
    const out: string[] = [];
    for (const m of MODS) {
      if (!m.cheat || m.kind !== "toggle" || !this.on(m.id)) continue;
      if (m.id === "speedhack" && this.value(m.id) === 1) continue;
      out.push(m.label);
    }
    return out;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.storage.setItem(MODS_KEY, JSON.stringify(this.state));
    } catch {
      // A full or blocked store only loses the menu's settings.
    }
  }

  private change(mutate: (s: ModState) => void): void {
    mutate(this.state);
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    for (const l of this.listeners) l();
  }
}
