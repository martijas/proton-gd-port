// Loading side of assets/icons/icons.json: every icon's layers, and the pages
// they live on.
//
// The game ships 1,207 icons as individual atlases; the asset build repacks
// them into 23 pages, one set per kind. A level only ever needs the pages the
// player's own icons sit on — at most two, because a ship or a UFO carries the
// cube inside it — so the pages load on demand rather than all at once.

import type { Atlas, AtlasFrame } from "./atlasTypes";
import type { IconDef, IconFile, IconKind, IconLayer } from "./iconTypes";
import { assetUrl, fetchAsset } from "./paths";

/** A frame located on one icon page, shaped so frameQuad can take it. */
export interface IconFrame {
  page: number;
  /** The page as an Atlas, which is what frameQuad wants. */
  atlas: Atlas;
  frame: AtlasFrame;
}

export class IconSet {
  private readonly images = new Map<number, Promise<HTMLImageElement>>();
  private readonly pageAtlas: Atlas[];

  private constructor(readonly file: IconFile) {
    this.pageAtlas = file.pages.map((p, i) => ({ name: `icons-${i}`, image: p.image, w: p.w, h: p.h, frames: p.frames }));
  }

  static async load(): Promise<IconSet> {
    return new IconSet(await fetchAsset<IconFile>("icons/icons.json"));
  }

  get pxPerUnit(): number {
    return this.file.pxPerUnit;
  }

  /** How many icons a kind has, so a picker knows the range. */
  count(kind: IconKind): number {
    return this.file.kinds[kind]?.count ?? 0;
  }

  /**
   * One icon by kind and number. Cube and ball number from 0, everything else
   * from 1, which is the game's own numbering; an id outside the range falls
   * back to the first icon rather than drawing nothing.
   */
  icon(kind: IconKind, id: number): IconDef | undefined {
    const set = this.file.kinds[kind];
    if (!set) return undefined;
    return set.icons.find((i) => i.id === id) ?? set.icons[0];
  }

  frame(name: string): IconFrame | undefined {
    const at = this.file.frames[name];
    if (!at) return undefined;
    const atlas = this.pageAtlas[at[0]];
    const frame = atlas?.frames[at[1]];
    if (!atlas || !frame) return undefined;
    return { page: at[0], atlas, frame };
  }

  /** The layers of one icon, in the order they are drawn. */
  layers(icon: IconDef): readonly IconLayer[] {
    return icon.layers;
  }

  image(page: number): Promise<HTMLImageElement> {
    const cached = this.images.get(page);
    if (cached) return cached;
    const entry = this.file.pages[page];
    if (!entry) return Promise.reject(new Error(`No icon page ${page}`));
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`${entry.image} could not be loaded`));
      img.src = assetUrl(entry.image);
    });
    this.images.set(page, promise);
    return promise;
  }
}
