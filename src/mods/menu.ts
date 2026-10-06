// The mod menu: a row of small dark windows over the game, one per group of
// mods, as Mega Hack lays them out. Tab opens and closes it.
//
// Click a row to flip it, right-click it to give it a key. Drag a window by
// its title to move it, click the title to fold it.

import type { MacroDeck } from "./macro";
import { MODS, WINDOWS, type ModDef, type ModStore, type WindowId } from "./state";

/** What the menu needs from the game. */
export interface MenuHost {
  readonly store: ModStore;
  readonly macro: MacroDeck;
  /** Presses a button row. */
  action(id: string): void;
  /** Whether the run in progress will save, and if not, why. */
  saving(): { saves: boolean; why: string };
  /** The start position the next attempt uses, in words, or null outside a level with any. */
  startPosLabel(): string | null;
  /** The level's name, for a saved recording's file. */
  levelName(): string | null;
}

const WIDTH = 168;
const GAP = 8;

const CSS = `
.mods-root { position: fixed; inset: 0; pointer-events: none; z-index: 10; font: 13px/1.25 system-ui, -apple-system, "Segoe UI", sans-serif; color: #eee; }
.mods-root[hidden] { display: none; }
.mods-win { position: absolute; width: ${WIDTH}px; background: #161616f2; border: 1px solid #000; box-shadow: 0 2px 8px #0008; pointer-events: auto; user-select: none; }
.mods-head { background: #6a35c9; color: #fff; font-weight: 600; text-align: center; padding: 3px 6px; cursor: grab; }
.mods-head:active { cursor: grabbing; }
.mods-body { max-height: 70vh; overflow-y: auto; }
.mods-win.folded .mods-body { display: none; }
.mods-row { display: flex; align-items: center; gap: 4px; padding: 3px 6px; border-top: 1px solid #222; cursor: pointer; position: relative; min-height: 18px; }
.mods-row:hover { background: #262626; }
.mods-row.on { color: #b993ff; }
.mods-row.on::after { content: ""; position: absolute; right: 0; top: 0; bottom: 0; width: 3px; background: #8c5cf0; }
.mods-row.cheat .mods-label::before { content: ""; display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: #e04848; margin: 0 5px 1px 0; vertical-align: middle; }
.mods-row.plain { cursor: default; }
.mods-row.binding { background: #3a2a5a; }
.mods-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mods-key { font-size: 10px; color: #999; border: 1px solid #444; border-radius: 3px; padding: 0 3px; }
.mods-num { width: 46px; background: #0c0c0c; color: #eee; border: 1px solid #333; font: inherit; font-size: 12px; padding: 1px 3px; text-align: right; }
.mods-text, .mods-search { width: 100%; box-sizing: border-box; background: #0c0c0c; color: #eee; border: 1px solid #333; font: inherit; font-size: 12px; padding: 2px 4px; }
.mods-note { font-size: 11px; color: #aaa; padding: 3px 6px; border-top: 1px solid #222; white-space: normal; }
.mods-note.bad { color: #ff7a7a; }
.mods-note.good { color: #7aff9a; }
.mods-buttons { display: flex; gap: 4px; padding: 4px 6px; border-top: 1px solid #222; flex-wrap: wrap; }
.mods-btn { flex: 1; background: #2a2a2a; color: #eee; border: 1px solid #000; font: inherit; font-size: 12px; padding: 2px 4px; cursor: pointer; }
.mods-btn:hover { background: #3a3a3a; }
.mods-btn.active { background: #6a35c9; }
.mods-btn:disabled { opacity: 0.4; cursor: default; }
.mods-hitboxes { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 5; }
.mods-status { position: fixed; left: 6px; top: 4px; pointer-events: none; z-index: 6; font: 600 14px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; text-shadow: 0 0 2px #000, 1px 1px 1px #000; white-space: pre; }
.mods-flash { position: fixed; inset: 0; pointer-events: none; z-index: 4; background: #ff0000; opacity: 0; }
`;

export function installModStyles(): void {
  if (document.getElementById("mods-style")) return;
  const style = document.createElement("style");
  style.id = "mods-style";
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** A key code as a key cap shows it: KeyN → N, Digit1 → 1, ArrowLeft → Left. */
export function keyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Arrow")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num${code.slice(6)}`;
  return code;
}

interface Row {
  def: ModDef;
  el: HTMLElement;
  key?: HTMLElement;
  input?: HTMLInputElement;
}

export class ModMenu {
  private readonly root: HTMLDivElement;
  private readonly windows = new Map<WindowId, HTMLDivElement>();
  private readonly rows: Row[] = [];
  private readonly notes: Array<() => void> = [];
  private binding: Row | null = null;
  private filter = "";
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: MenuHost) {
    installModStyles();
    this.root = document.createElement("div");
    this.root.className = "mods-root";
    this.root.hidden = true;
    document.body.appendChild(this.root);
    for (const w of WINDOWS) this.buildWindow(w.id, w.title);
    host.store.subscribe(() => this.sync());
    this.sync();
    window.addEventListener("resize", () => {
      if (!this.root.hidden) this.layout();
    });
  }

  get open(): boolean {
    return !this.root.hidden;
  }

  /** Whether a key is being waited for, to bind to a row. */
  get isBinding(): boolean {
    return this.binding !== null;
  }

  toggle(): void {
    this.setOpen(this.root.hidden);
  }

  setOpen(open: boolean): void {
    this.root.hidden = !open;
    if (!open) {
      this.endBinding();
      if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) document.activeElement.blur();
      if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      return;
    }
    this.applyZoom();
    this.layout();
    this.refreshNotes();
    this.refreshTimer = setInterval(() => this.refreshNotes(), 250);
  }

  /**
   * A key while a row waits for one: Escape cancels, Backspace or Delete
   * clears the row's key, anything else becomes it. True when it was taken.
   */
  takeBindingKey(code: string): boolean {
    const row = this.binding;
    if (!row) return false;
    if (code === "Escape") this.endBinding();
    else if (code === "Backspace" || code === "Delete") this.host.store.bind(row.def.id, null);
    else if (code !== "Tab") this.host.store.bind(row.def.id, code);
    this.endBinding();
    return true;
  }

  private endBinding(): void {
    this.binding?.el.classList.remove("binding");
    if (this.binding?.key) this.binding.key.textContent = this.keyText(this.binding.def.id);
    this.binding = null;
  }

  private keyText(id: string): string {
    const code = this.host.store.keyOf(id);
    return code ? keyName(code) : "";
  }

  private buildWindow(id: WindowId, title: string): void {
    const win = document.createElement("div");
    win.className = "mods-win";
    const head = document.createElement("div");
    head.className = "mods-head";
    head.textContent = title;
    const body = document.createElement("div");
    body.className = "mods-body";
    win.append(head, body);
    this.root.appendChild(win);
    this.windows.set(id, win);
    this.dragBy(head, win, id);

    if (id === "menu") this.buildMenuWindow(body);
    for (const def of MODS) if (def.window === id) body.appendChild(this.buildRow(def));
    if (id === "level") this.buildStartPosNote(body);
    if (id === "macro") this.buildMacroWindow(body);
    if (id === "status" || id === "display") this.note(body, "Shows over the level while you play.", () => ({}));
  }

  private buildMenuWindow(body: HTMLElement): void {
    const search = document.createElement("input");
    search.className = "mods-search";
    search.placeholder = "Search";
    search.addEventListener("input", () => {
      this.filter = search.value.trim().toLowerCase();
      this.applyFilter();
    });
    const wrap = document.createElement("div");
    wrap.className = "mods-buttons";
    wrap.appendChild(search);
    body.appendChild(wrap);
    this.note(body, "", () => {
      const s = this.host.saving();
      return { text: s.saves ? "Your progress saves." : s.why, cls: s.saves ? "good" : "bad" };
    });
    this.note(body, "Tab opens and closes this menu. Right-click a row to give it a key.", () => ({}));
    this.buttons(body, [
      { label: "All Off", press: () => this.host.store.allOff() },
      {
        label: "Reset Layout",
        press: () => {
          this.host.store.resetLayout();
          this.layout();
        },
      },
    ]);
  }

  private buildStartPosNote(body: HTMLElement): void {
    this.note(body, "", () => {
      const label = this.host.startPosLabel();
      return label === null ? { hidden: true } : { text: label };
    });
  }

  private buildMacroWindow(body: HTMLElement): void {
    const macro = this.host.macro;
    this.note(body, "", () => {
      const m = macro.mode;
      const frames = macro.length;
      const seconds = (frames / 240).toFixed(1);
      if (m === "record") return { text: `Recording: ${macro.macro?.inputs.length ?? 0} presses, ${seconds}s. It starts over with each attempt.` };
      if (m === "play") return { text: `Playing back: ${seconds}s. It won't be saved.`, cls: "bad" };
      return { text: macro.macro ? `Ready: ${macro.macro.inputs.length} presses, ${seconds}s.` : "Record a run, then play it back from the start." };
    });
    const file = document.createElement("input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.hidden = true;
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      void f.text().then((text) => {
        try {
          macro.load(text);
        } catch {
          window.alert("That file isn't a recording.");
        }
        this.refreshNotes();
      });
    });
    body.appendChild(file);
    this.buttons(body, [
      { label: "Record", active: () => macro.mode === "record", press: () => (macro.mode === "record" ? macro.stop() : macro.record()) },
      { label: "Play", active: () => macro.mode === "play", enabled: () => macro.macro !== null, press: () => (macro.mode === "play" ? macro.stop() : macro.play()) },
      { label: "Stop", enabled: () => macro.mode !== "idle", press: () => macro.stop() },
    ]);
    this.buttons(body, [
      { label: "Save", enabled: () => macro.macro !== null, press: () => this.saveMacro() },
      { label: "Load", press: () => file.click() },
      { label: "Clear", enabled: () => macro.macro !== null, press: () => macro.clear() },
    ]);
    this.note(body, "Recording and playback start with your next attempt.", () => ({}));
  }

  private saveMacro(): void {
    const name = (this.host.levelName() ?? "recording").replace(/[^\w\- ]+/g, "").trim() || "recording";
    const blob = new Blob([this.host.macro.toJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.macro.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private buttons(
    body: HTMLElement,
    specs: Array<{ label: string; press: () => unknown; active?: () => boolean; enabled?: () => boolean }>,
  ): void {
    const wrap = document.createElement("div");
    wrap.className = "mods-buttons";
    for (const spec of specs) {
      const b = document.createElement("button");
      b.className = "mods-btn";
      b.textContent = spec.label;
      b.addEventListener("click", () => {
        spec.press();
        this.refreshNotes();
      });
      wrap.appendChild(b);
      this.notes.push(() => {
        b.classList.toggle("active", spec.active?.() ?? false);
        b.disabled = !(spec.enabled?.() ?? true);
      });
    }
    body.appendChild(wrap);
  }

  /** A line of small text that `read` rewrites while the menu is open. */
  private note(body: HTMLElement, text: string, read: () => { text?: string; cls?: string; hidden?: boolean }): void {
    const el = document.createElement("div");
    el.className = "mods-note";
    el.textContent = text;
    body.appendChild(el);
    this.notes.push(() => {
      const r = read();
      if (r.text !== undefined) el.textContent = r.text;
      el.className = `mods-note${r.cls ? ` ${r.cls}` : ""}`;
      el.hidden = r.hidden === true;
    });
  }

  private refreshNotes(): void {
    for (const n of this.notes) n();
  }

  private buildRow(def: ModDef): HTMLElement {
    const store = this.host.store;
    const el = document.createElement("div");
    el.className = `mods-row${def.cheat ? " cheat" : ""}${def.kind === "value" || def.kind === "text" ? " plain" : ""}`;
    el.title = def.cheat ? `${def.tip} Your progress won't save while it's on.` : def.tip;
    const label = document.createElement("span");
    label.className = "mods-label";
    label.textContent = def.label;
    el.appendChild(label);
    const row: Row = { def, el };

    if (def.kind === "text") {
      el.removeChild(label);
      const input = document.createElement("input");
      input.className = "mods-text";
      input.placeholder = def.label;
      input.maxLength = def.maxLength ?? 60;
      input.addEventListener("input", () => store.setText(def.id, input.value));
      el.appendChild(input);
      row.input = input;
    } else if (def.value) {
      const v = def.value;
      const input = document.createElement("input");
      input.className = "mods-num";
      input.type = "number";
      input.min = String(v.min);
      input.max = String(v.max);
      input.step = String(v.step);
      input.addEventListener("click", (e) => e.stopPropagation());
      input.addEventListener("change", () => store.setValue(def.id, Number(input.value)));
      el.appendChild(input);
      if (v.suffix) {
        const suffix = document.createElement("span");
        suffix.textContent = v.suffix;
        suffix.style.color = "#999";
        el.appendChild(suffix);
      }
      row.input = input;
    }

    if (def.kind === "toggle" || def.kind === "action") {
      const key = document.createElement("span");
      key.className = "mods-key";
      el.appendChild(key);
      row.key = key;
      el.addEventListener("click", () => {
        if (def.kind === "toggle") store.setOn(def.id, !store.on(def.id));
        else this.host.action(def.id);
        this.refreshNotes();
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.endBinding();
        this.binding = row;
        el.classList.add("binding");
        key.textContent = "Press a key";
      });
    }
    this.rows.push(row);
    return el;
  }

  /** Every row as the store has it now. */
  private sync(): void {
    const store = this.host.store;
    for (const row of this.rows) {
      const { def, el, key, input } = row;
      if (def.kind === "toggle") el.classList.toggle("on", store.on(def.id));
      if (key && row !== this.binding) {
        key.textContent = this.keyText(def.id);
        key.hidden = key.textContent === "";
      }
      if (input && document.activeElement !== input) input.value = def.kind === "text" ? store.text(def.id) : String(store.value(def.id));
    }
    for (const [id, win] of this.windows) win.classList.toggle("folded", store.raw.folded[id] === true);
    this.applyZoom();
    if (this.open) this.refreshNotes();
  }

  private applyZoom(): void {
    (this.root.style as CSSStyleDeclaration & { zoom: string }).zoom = String(this.host.store.value("menuSize"));
  }

  private get zoom(): number {
    return this.host.store.value("menuSize");
  }

  private applyFilter(): void {
    for (const row of this.rows) {
      row.el.hidden = this.filter !== "" && !row.def.label.toLowerCase().includes(this.filter);
    }
    for (const [id, win] of this.windows) {
      if (id === "menu") continue;
      const any = this.rows.some((r) => r.def.window === id && !r.el.hidden);
      win.hidden = this.filter !== "" && !any;
    }
  }

  /**
   * Puts every window the player has not moved where it goes by default:
   * left to right along the top, each in whichever column is shortest once
   * the screen runs out of width.
   */
  private layout(): void {
    const zoom = this.zoom;
    const width = window.innerWidth / zoom;
    const columns = Math.max(1, Math.floor((width - GAP) / (WIDTH + GAP)));
    const heights = new Array<number>(columns).fill(GAP);
    const placed = this.host.store.raw.windows;
    for (const { id } of WINDOWS) {
      const win = this.windows.get(id);
      if (!win) continue;
      const own = placed[id];
      if (own) {
        win.style.left = `${clamp(own.x, 0, width - 40)}px`;
        win.style.top = `${clamp(own.y, 0, window.innerHeight / zoom - 20)}px`;
        continue;
      }
      let col = 0;
      for (let i = 1; i < columns; i++) if (heights[i] < heights[col]) col = i;
      win.style.left = `${GAP + col * (WIDTH + GAP)}px`;
      win.style.top = `${heights[col]}px`;
      heights[col] += win.offsetHeight + GAP;
    }
  }

  /** Dragging the title moves the window; a click without a drag folds it. */
  private dragBy(head: HTMLElement, win: HTMLElement, id: WindowId): void {
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const zoom = this.zoom;
      const startX = e.clientX;
      const startY = e.clientY;
      const left = win.offsetLeft;
      const top = win.offsetTop;
      let moved = false;
      head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        win.style.left = `${left + dx}px`;
        win.style.top = `${top + dy}px`;
      };
      const up = () => {
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        head.removeEventListener("pointercancel", up);
        if (moved) {
          this.host.store.place(id, { x: win.offsetLeft, y: win.offsetTop });
        } else {
          this.host.store.fold(id, !(this.host.store.raw.folded[id] === true));
          this.layout();
        }
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
      head.addEventListener("pointercancel", up);
    });
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(Math.max(lo, hi), n));
}
