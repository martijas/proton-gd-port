// A speed slider for a page that plays the simulation back.
//
// The slider moves in powers of two, so each step doubles or halves the rate
// and normal speed sits in the middle instead of being squeezed into one end.
// Double-clicking puts it back to normal speed.

import type { GameLoop } from "../engine/loop";

export const MIN_SPEED = 0.25;
export const MAX_SPEED = 16;

function clamp(speed: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

/** The playback rate for a slider position, which is a power of two. */
export function speedFromSlider(position: number): number {
  return clamp(2 ** position);
}

/** "0.25×", "1×", "1.4×", "16×": whole numbers plainly, the rest to two figures. */
export function formatSpeed(speed: number): string {
  if (Number.isInteger(speed)) return `${speed}×`;
  return `${Number(speed.toPrecision(2))}×`;
}

export function bindSpeedSlider(slider: HTMLInputElement, label: HTMLElement, loop: GameLoop): void {
  slider.min = String(Math.log2(MIN_SPEED));
  slider.max = String(Math.log2(MAX_SPEED));
  slider.step = "0.25";
  slider.value = String(Math.log2(clamp(loop.timeScale)));
  slider.title = "Double-click for normal speed";
  const show = (): void => {
    label.textContent = formatSpeed(loop.timeScale);
  };
  slider.addEventListener("input", () => {
    loop.timeScale = speedFromSlider(Number(slider.value));
    show();
  });
  slider.addEventListener("dblclick", () => {
    slider.value = "0";
    loop.timeScale = 1;
    show();
  });
  show();
}
