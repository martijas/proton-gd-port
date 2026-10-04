// Backgrounds, grounds and foregrounds: the flat images behind and under a
// level, as opposed to the sheets everything else comes from.
//
// A background tile is 512 GD units square and a ground tile 128, both measured
// at 4 px per unit. Grounds from 8 upward carry a second image the game draws
// over the first.

import type { SceneryFile, SceneryImage } from "./miscTypes";
import { assetUrl, fetchAsset } from "./paths";

export class Scenery {
  private readonly images = new Map<string, Promise<HTMLImageElement>>();

  private constructor(readonly file: SceneryFile) {}

  static async load(): Promise<Scenery> {
    return new Scenery(await fetchAsset<SceneryFile>("scenery.json"));
  }

  get pxPerUnit(): number {
    return this.file.pxPerUnit;
  }

  /** Level headers are 1-based and write 0 for "the default", which is the first one. */
  background(id: number): SceneryImage | undefined {
    return this.file.backgrounds[id || 1] ?? this.file.backgrounds[1];
  }

  ground(id: number): { base: SceneryImage; detail?: SceneryImage } | undefined {
    return this.file.grounds[id || 1] ?? this.file.grounds[1];
  }

  foreground(id: number): { base: SceneryImage; detail?: SceneryImage } | undefined {
    return this.file.foregrounds[id];
  }

  image(entry: SceneryImage): Promise<HTMLImageElement> {
    let pending = this.images.get(entry.image);
    if (!pending) {
      pending = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`${entry.image} did not load`));
        img.src = assetUrl(entry.image);
      });
      this.images.set(entry.image, pending);
    }
    return pending;
  }
}
