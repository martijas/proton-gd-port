// Loading side of assets/atlas/<res>.json: one name index across every sheet,
// and the images on demand.

import type { Atlas, AtlasFile, AtlasFrame, FrameLocation } from "./atlasTypes";
import { assetUrl, fetchAsset } from "./paths";

export class AtlasSet {
  private readonly index = new Map<string, [number, number]>();
  private readonly images = new Map<number, Promise<HTMLImageElement>>();

  private constructor(readonly file: AtlasFile) {
    for (const [name, at] of Object.entries(file.frames)) this.index.set(name, at);
  }

  static async load(res: "sd" | "hd" | "uhd"): Promise<AtlasSet> {
    return new AtlasSet(await fetchAsset<AtlasFile>(`atlas/${res}.json`));
  }

  get res(): string {
    return this.file.res;
  }

  get pxPerUnit(): number {
    return this.file.pxPerUnit;
  }

  get atlases(): readonly Atlas[] {
    return this.file.atlases;
  }

  get frameCount(): number {
    return this.index.size;
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  /** Undefined for an unknown name; callers decide whether that is a gap or a fallback. */
  frame(name: string): FrameLocation | undefined {
    const at = this.index.get(name);
    if (!at) return undefined;
    const atlas = this.file.atlases[at[0]];
    const frame: AtlasFrame | undefined = atlas?.frames[at[1]];
    if (!atlas || !frame) return undefined;
    return { atlas, frame, atlasIndex: at[0] };
  }

  names(): IterableIterator<string> {
    return this.index.keys();
  }

  /** Decoded sheet image, cached. Rejects with the atlas name in the message. */
  image(atlasIndex: number): Promise<HTMLImageElement> {
    const cached = this.images.get(atlasIndex);
    if (cached) return cached;
    const atlas = this.file.atlases[atlasIndex];
    if (!atlas) return Promise.reject(new Error(`No atlas at index ${atlasIndex}`));
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`${atlas.name} could not be loaded`));
      img.src = assetUrl(atlas.image);
    });
    this.images.set(atlasIndex, promise);
    return promise;
  }
}
