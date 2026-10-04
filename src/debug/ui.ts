// One of every interface part on a page, so the layout arithmetic can be
// looked at rather than argued about: a panel grown well past its own art, the
// buttons at several sizes, text at several scales, a slider that moves, a
// toggle that flips and a list that scrolls.
//
// It is also the hit-test readout: whatever the pointer is over is named at the
// bottom of the screen, which is the quickest way to catch a widget whose
// drawn rectangle and pressable rectangle have drifted apart.

import { AtlasSet } from "../assets/atlas";
import { GlContext } from "../engine/gl/context";
import { GameLoop, InputState } from "../engine/loop";
import { SpriteBatch } from "../engine/gl/spriteBatch";
import { uploadTexture } from "../engine/gl/texture";
import { FRAMES, UiArt } from "../ui/art";
import { UiInput } from "../ui/input";
import { UiRenderer, UI_COLOURS } from "../ui/render";
import { ScreenStack, type Screen } from "../ui/screen";
import { rect, viewportFor, type UiViewport } from "../ui/viewport";
import { hitTest, sliderValueAt, type Widget } from "../ui/widgets";

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const msg = document.getElementById("msg") as HTMLDivElement;

let hovered = "—";
let pressed = "—";

class PartsScreen implements Screen {
  readonly name = "parts";
  readonly opaque = true;
  private volume = 0.7;
  private checked = true;
  private scroll = 0;
  private spin = 0;

  update(dt: number): void {
    this.spin = (this.spin + dt * 45) % 360;
  }

  build(view: UiViewport): Widget[] {
    const w = view.width;
    const h = view.height;
    const out: Widget[] = [];

    // A frame grown far past its own 80-unit art, which is the nine-slice's job.
    out.push({ kind: "panel", rect: rect(16, 16, w - 32, h - 32), frame: FRAMES.panelDark, alpha: 0.9 });
    out.push({ kind: "text", x: 32, y: h - 60, text: "Interface parts", scale: 0.55, tint: UI_COLOURS.gold });
    out.push({ kind: "text", x: 32, y: h - 86, text: `${Math.round(w)} x ${Math.round(h)} units`, font: "chatFont", scale: 0.5, tint: UI_COLOURS.dim });

    // Buttons at three sizes off one frame.
    const sizes = [
      { label: "Play", r: rect(32, h - 150, 120, 36) },
      { label: "A much longer label", r: rect(32, h - 196, 220, 36) },
      { label: "Off", r: rect(32, h - 242, 70, 28), enabled: false },
    ];
    for (const [i, s] of sizes.entries()) {
      out.push({ kind: "button", id: `btn${i}`, rect: s.r, label: { text: s.label, scale: 0.34 }, enabled: s.enabled });
    }

    // The sheet's own round buttons, drawn big enough to see whether the atlas
    // frames land where they should.
    const icons = [FRAMES.play, FRAMES.menu, FRAMES.options, FRAMES.garage, FRAMES.practice];
    for (const [i, frame] of icons.entries()) {
      out.push({ kind: "sprite", x: 300 + i * 44, y: h - 150, frame, scale: 0.4 });
    }

    // Something rotating, to prove the transform is not axis-locked.
    out.push({ kind: "sprite", x: 300, y: h - 210, frame: FRAMES.star, scale: 1 });
    out.push({ kind: "sprite", x: 344, y: h - 210, frame: FRAMES.secretCoin, scale: 0.6, rotation: this.spin });
    out.push({ kind: "sprite", x: 388, y: h - 210, frame: FRAMES.lock, scale: 1 });
    out.push({ kind: "sprite", x: 432, y: h - 210, frame: FRAMES.coin, scale: 1 });

    out.push({ kind: "slider", id: "volume", rect: rect(32, h - 300, 220, 12), value: this.volume });
    out.push({ kind: "text", x: 264, y: h - 306, text: `${Math.round(this.volume * 100)}%`, font: "chatFont", scale: 0.5 });
    out.push({ kind: "toggle", id: "check", rect: rect(32, h - 350, 24, 24), on: this.checked, label: { text: "A toggle with a label", scale: 0.32 } });

    // Text at a range of scales, to check nothing drifts off its baseline.
    for (const [i, scale] of [0.25, 0.35, 0.5, 0.7].entries()) {
      out.push({ kind: "text", x: 32, y: h - 400 - i * 34, text: `Stereo Madness ${scale}`, scale });
    }

    // A scrolling list against the right edge.
    const rows: Widget[][] = [];
    for (let i = 0; i < 40; i++) {
      rows.push([
        { kind: "panel", rect: rect(0, 4, 190, 34), frame: FRAMES.panelBlue, alpha: 0.85 },
        { kind: "button", id: `row${i}`, rect: rect(6, 8, 178, 26), label: { text: `Row ${i + 1}`, scale: 0.3 } },
      ]);
    }
    out.push({ kind: "list", id: "rows", rect: rect(w - 220, 40, 190, h - 130), rowSize: 42, rows, scroll: this.scroll });
    out.push({ kind: "text", x: w - 220, y: h - 70, text: "Drag to scroll", font: "chatFont", scale: 0.45, tint: UI_COLOURS.dim });
    return out;
  }

  onPress(id: string): boolean {
    pressed = id;
    if (id === "check") this.checked = !this.checked;
    return true;
  }

  onDrag(id: string, dx: number, dy: number, x: number): boolean {
    if (id === "volume") {
      const widget = this.build(view).find((w) => w.kind === "slider");
      if (widget && widget.kind === "slider") this.volume = sliderValueAt(widget, x);
      return true;
    }
    if (id === "rows") {
      this.scroll = Math.max(0, Math.min(40 * 42 - (view.height - 120), this.scroll + dy));
      return true;
    }
    return false;
  }
}

let view: UiViewport = viewportFor(canvas.clientWidth || 960, canvas.clientHeight || 540);

async function boot(): Promise<void> {
  const gl = new GlContext(canvas);
  const batch = new SpriteBatch(gl.gl);
  const atlas = await AtlasSet.load("uhd");
  // The interface reaches into the gameplay sheets for its round buttons, so
  // they have to be on their units like any level.
  const images = await Promise.all(atlas.atlases.map((_, i) => atlas.image(i)));
  batch.bindSheets(images.map((image) => uploadTexture(gl.gl, image)));

  const art = await UiArt.load(atlas);
  const ui = new UiRenderer(gl, art);
  await ui.load(["bigFont", "chatFont"]);

  const stack = new ScreenStack();
  stack.push(new PartsScreen());
  const input = new UiInput(stack, new InputState());
  input.attach(canvas);

  canvas.addEventListener("pointermove", (e) => {
    const box = canvas.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * view.width;
    const y = (1 - (e.clientY - box.top) / box.height) * view.height;
    hovered = hitTest(stack.interactive(view), x, y)?.id ?? "—";
  });

  const loop = new GameLoop(
    () => {},
    (_alpha, dt) => {
      gl.resize();
      view = viewportFor(gl.gl.drawingBufferWidth, gl.gl.drawingBufferHeight);
      input.setViewport(view);
      stack.update(dt);
      gl.clear(0.06, 0.07, 0.12);
      ui.draw(batch, view, stack.build(view));
      msg.textContent =
        `${Math.round(view.width)}x${Math.round(view.height)} units   ${batch.instances} sprites   ${batch.drawCalls} draw calls\n` +
        `over ${hovered}   pressed ${pressed}` +
        (ui.unresolved.length > 0 ? `\nmissing art: ${ui.unresolved.join(", ")}` : "");
    },
  );
  loop.start();
  (window as unknown as { gdUi: unknown }).gdUi = { stack, ui, view: () => view };
}

void boot().catch((e: unknown) => {
  msg.textContent = e instanceof Error ? e.message : "The interface could not be started.";
  console.error(e);
});
