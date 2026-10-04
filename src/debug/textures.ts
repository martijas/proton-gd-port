// Asset viewer shell: one canvas, one viewport, one overlay, and a tab per
// thing worth looking at. It reads the built assets/ folder, never the original
// install, so what it shows is what the game will ship.

import { AtlasTab } from "./atlasTab";
import { IconTab } from "./iconTab";
import { ObjectTab } from "./objectTab";
import { ReportTab } from "./reportTab";
import type { TabView } from "./tabs";
import { Viewport } from "./viewport";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} is missing from the page`);
  return node as T;
}

const canvas = el<HTMLCanvasElement>("c");
const hud = el<HTMLDivElement>("hud");
const panel = el<HTMLDivElement>("panel");
const msg = el<HTMLSpanElement>("msg");
const context = canvas.getContext("2d");
if (!context) throw new Error("Canvas 2D is not available.");
const ctx: CanvasRenderingContext2D = context;

let messageTimer = 0;
function setMessage(text: string): void {
  msg.textContent = text;
  window.clearTimeout(messageTimer);
  if (text !== "") messageTimer = window.setTimeout(() => (msg.textContent = ""), 2500);
}

let queued = false;
function redraw(): void {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    draw();
  });
}

const viewport = new Viewport(canvas, redraw);
const params = new URLSearchParams(window.location.search);

const tabs: TabView[] = [
  new AtlasTab(
    viewport,
    {
      pick: el("atlas-pick"),
      res: el("atlas-res"),
      filter: el("atlas-filter"),
      outlines: el("atlas-outlines"),
      source: el("atlas-source"),
      rotated: el("atlas-rotated"),
      labels: el("atlas-labels"),
      checker: el("atlas-checker"),
      fit: el("atlas-fit"),
    },
    redraw,
    setMessage,
    params,
  ),
  new IconTab(
    viewport,
    {
      kind: el("icon-kind"),
      color1: el("icon-color1"),
      color2: el("icon-color2"),
      glow: el("icon-glow"),
      fit: el("icon-fit"),
    },
    redraw,
    setMessage,
  ),
  new ObjectTab(
    viewport,
    {
      id: el("object-id"),
      prev: el("object-prev"),
      next: el("object-next"),
      census: el("object-census"),
      hitbox: el("object-hitbox"),
      children: el("object-children"),
      glow: el("object-glow"),
      grid: el("object-grid"),
    },
    redraw,
    setMessage,
  ),
  new ReportTab(panel, setMessage),
];

let active: TabView = tabs[0];

function draw(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#101014";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  active.draw(ctx, viewport);
  hud.textContent = active.hud();
}

async function show(id: string): Promise<void> {
  const tab = tabs.find((t) => t.id === id) ?? tabs[0];
  active = tab;
  for (const t of tabs) {
    el(`tab-${t.id}`).setAttribute("aria-selected", String(t === tab));
    el(`ctl-${t.id}`).classList.toggle("hidden", t !== tab);
  }
  if (window.location.hash !== `#${tab.id}`) window.location.hash = tab.id;
  // The report is a document, not a drawing.
  panel.classList.toggle("hidden", tab.id !== "report");
  hud.classList.toggle("hidden", tab.id === "report");
  await tab.activate();
  redraw();
}

for (const tab of tabs) el(`tab-${tab.id}`).addEventListener("click", () => void show(tab.id));
window.addEventListener("hashchange", () => void show(window.location.hash.slice(1)));
canvas.addEventListener("click", () => {
  if (!viewport.pointer) return;
  active.click?.(viewport.toWorld(viewport.pointer.x, viewport.pointer.y));
  redraw();
});

void show(window.location.hash.slice(1) || "atlas");
