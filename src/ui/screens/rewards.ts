// The Rewards page behind the main menu's chest: the small and the large
// chest side by side on a blue window, with the free chest in the corner.
//
// The chests pay out in orbs, diamonds and keys, and nothing in this port
// spends any of them, so both chests sit ready and say so when tapped.
//
// [gdp RewardsPage::init, gd-ida-decomp.cpp:560723-561120: shade 150, a
//  GJ_square02 340×220, the label 32 below its top, a rewardCorner 145 and 85
//  out from the centre at each corner, the close button and the free chest 10
//  in from the top corners, the chests 70 either side of cy-10 with "Open"
//  at cy-74 under them at 0.5, the small one lowered by a tenth of the large one's
//  height. RewardsPage::updateTimers :560571: a ready chest is frame 02.]

import type { Game } from "../../game/game";
import { FRAMES } from "../art";
import { label, NO_ART, shade, spriteButton, type ArtLookup } from "../chrome";
import type { Screen } from "../screen";
import { rect, type UiViewport } from "../viewport";
import type { Widget } from "../widgets";

const BOX = { w: 340, h: 220 };
const CORNER = { x: 145, y: 85 };
const CHEST = { x: 70, y: -10, label: -74 };

/** The free chest breathes between full size and a tenth over, half a second each way, eased. [:561019-561025] */
const FREE_PULSE = { seconds: 0.5, grow: 0.1 };

export class RewardsScreen implements Screen {
  readonly name = "rewards";
  readonly opaque = false;
  readonly ticksBelow = false;

  constructor(private readonly game: Game) {}

  private get art(): ArtLookup {
    return this.game.ui?.art ?? NO_ART;
  }

  enter(): void {
    this.game.input.clear();
  }

  build(view: UiViewport): Widget[] {
    const art = this.art;
    const cx = view.width / 2;
    const cy = view.height / 2;
    const out: Widget[] = [
      shade(view, 150 / 255),
      { kind: "panel", rect: rect(cx - BOX.w / 2, cy - BOX.h / 2, BOX.w, BOX.h), frame: FRAMES.panelBlue },
      { kind: "sprite", x: cx, y: cy + BOX.h / 2 - 32, frame: FRAMES.rewardsLabel },
    ];
    for (const [sx, sy] of [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const) {
      out.push({ kind: "sprite", x: cx + sx * CORNER.x, y: cy + sy * CORNER.y, frame: FRAMES.rewardCorner, flipX: sx > 0, flipY: sy > 0 });
    }

    const bigH = art.quad(FRAMES.chestBig)?.h ?? 100;
    out.push(...spriteButton(art, "chest:small", cx - CHEST.x, cy + CHEST.y - bigH * 0.1, FRAMES.chestSmall));
    out.push(...spriteButton(art, "chest:big", cx + CHEST.x, cy + CHEST.y, FRAMES.chestBig));
    for (const side of [-1, 1]) out.push(label(art, "Open", cx + side * CHEST.x, cy + CHEST.label, { scale: 0.5 }));

    const t = (performance.now() / 1000 / FREE_PULSE.seconds) % 2;
    const leg = t < 1 ? t : 2 - t;
    const eased = leg < 0.5 ? 2 * leg * leg : 1 - 2 * (1 - leg) * (1 - leg);
    out.push(...spriteButton(art, "free", cx + BOX.w / 2 - 10, cy + BOX.h / 2 - 10, FRAMES.freeChest, { scale: 1 + FREE_PULSE.grow * eased, sizeMult: 1.6 }));
    out.push(...spriteButton(art, "close", cx - BOX.w / 2 + 10, cy + BOX.h / 2 - 10, FRAMES.close, { sizeMult: 1.6 }));
    return out;
  }

  onPress(id: string): boolean {
    if (id === "close") {
      this.game.stack.pop();
      return true;
    }
    if (id === "chest:small" || id === "chest:big" || id === "free") {
      this.game.say("Chest rewards aren't in this version yet.");
      return true;
    }
    return false;
  }

  onKey(code: string, down: boolean): boolean {
    if (down && code === "Escape") {
      this.game.stack.pop();
      return true;
    }
    return false;
  }
}
