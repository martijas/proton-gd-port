// Skeletal animation: the *_AnimDesc plists plus objectDefinitions.plist
// become one file per entity, and an index that says which exist.
//
// Split per entity because Robot_AnimDesc alone is 560 KB and a level with no
// beasts in it should not pay for them. Robot and Spider are the two the player
// can be, so they are the ones a scene always needs.
//
// Positions are the entity's own space in GD units, y up, exactly as the files
// write them. The player's robot and spider name icon-01 frames
// ("spider_01_02_001.png"); swapping the icon means replacing that "_01" with
// the chosen id, which is how the game does it too.

import { join } from "node:path";
import type { AnimEntity, AnimIndex, AnimSprite } from "../../src/assets/miscTypes";
import { fileSize, writeJson } from "./fsx";
import { bool, dict, num, point, readPlist, str, type PlistDict } from "./plist";
import type { StepContext, StepModule, StepResult } from "./step";

const OBJECT_DEFINITIONS = "objectDefinitions.plist";

function readEntity(src: string, name: string, animDescFile: string, definitions: PlistDict): AnimEntity {
  const root = dict(readPlist(join(src, animDescFile)), animDescFile);
  const used = dict(root.usedTextures, `${name}.usedTextures`);
  const textures = Object.keys(used).map((key) => {
    const t = dict(used[key], `${name}.${key}`);
    const out: { tex: string; tag: number; id?: string } = { tex: str(t.texture, key), tag: num(t.tag, key) };
    const id = t.customID;
    if (typeof id === "string" && id !== "") out.id = id;
    return out;
  });
  textures.sort((a, b) => a.tag - b.tag);

  const container = dict(root.animationContainer, `${name}.animationContainer`);
  const frames: Record<string, AnimSprite[]> = {};
  for (const frameName of Object.keys(container)) {
    const sprites = dict(container[frameName], frameName);
    const list: AnimSprite[] = [];
    for (const key of Object.keys(sprites)) {
      const s = dict(sprites[key], `${frameName}.${key}`);
      const pos = point(str(s.position, "position"));
      const scale = point(str(s.scale, "scale"));
      const flip = point(str(s.flipped, "flipped"));
      const sprite: AnimSprite = {
        tex: str(s.texture, "texture"),
        tag: num(s.tag, "tag"),
        x: pos.x,
        y: pos.y,
        sx: scale.x,
        sy: scale.y,
        rot: num(s.rotation, "rotation"),
        z: num(s.zValue, "zValue"),
      };
      if (flip.x !== 0) sprite.fx = 1;
      if (flip.y !== 0) sprite.fy = 1;
      list.push(sprite);
    }
    list.sort((a, b) => a.z - b.z);
    frames[frameName] = list;
  }

  const animations: AnimEntity["animations"] = {};
  const defs = definitions[name];
  if (defs) {
    const table = dict(dict(defs, name).animations, `${name}.animations`);
    for (const animName of Object.keys(table)) {
      const a = dict(table[animName], `${name}.${animName}`);
      // A "single frame" animation is a pose, not a sequence: it has no delay
      // or frame count, just the one frame to hold.
      const entry: AnimEntity["animations"][string] = {
        delay: a.delay === undefined ? 0 : num(a.delay, `${animName}.delay`),
        frames: a.frames === undefined ? 1 : num(a.frames, `${animName}.frames`),
        looped: a.looped === undefined ? 0 : bool(a.looped, `${animName}.looped`) ? 1 : 0,
        prio: a.prio === undefined ? 0 : num(a.prio, `${animName}.prio`),
        usesParts: a.usesParts === undefined ? 0 : bool(a.usesParts, `${animName}.usesParts`) ? 1 : 0,
      };
      if (a.other !== undefined) entry.other = num(a.other, `${animName}.other`);
      if (typeof a.singleFrame === "string") entry.singleFrame = a.singleFrame;
      animations[animName] = entry;
    }
  }

  const entity: AnimEntity = { name, textures, frames, animations };
  // The clip the sprite starts on. [gdp CCAnimatedSprite::loadType :30404-30407]
  const start = defs ? dict(defs, name).defaultAnimation : undefined;
  if (typeof start === "string" && start !== "") entity.defaultAnimation = start;
  return entity;
}

export const animsStep: StepModule = {
  name: "anims",

  inputs(ctx: StepContext): string[] {
    const definitions = dict(readPlist(join(ctx.src, OBJECT_DEFINITIONS)), OBJECT_DEFINITIONS);
    const files = [join(ctx.src, OBJECT_DEFINITIONS)];
    for (const name of Object.keys(definitions)) {
      const d = dict(definitions[name], name);
      if (typeof d.animDesc === "string") files.push(join(ctx.src, d.animDesc));
    }
    return files;
  },

  run(ctx: StepContext): StepResult {
    const definitions = dict(readPlist(join(ctx.src, OBJECT_DEFINITIONS)), OBJECT_DEFINITIONS);
    const index: AnimIndex = { version: 1, entities: {} };
    const outputs: string[] = [];
    let bytes = 0;
    let written = 0;
    let frameCount = 0;

    for (const name of Object.keys(definitions)) {
      const d = dict(definitions[name], name);
      const animDesc = typeof d.animDesc === "string" ? d.animDesc : null;
      if (!animDesc) {
        ctx.log.warn(`${name} has no animation file`);
        continue;
      }
      const entity = readEntity(ctx.src, name, animDesc, definitions);
      const rel = `anims/${name}.json`;
      if (!ctx.opts.verify) {
        const w = writeJson(join(ctx.out, rel), entity);
        bytes += w.bytes;
        if (w.written) written++;
      } else {
        bytes += fileSize(join(ctx.out, rel));
      }
      outputs.push(rel);
      frameCount += Object.keys(entity.frames).length;
      index.entities[name] = { file: rel, animations: Object.keys(entity.animations), frames: Object.keys(entity.frames).length };
    }

    if (ctx.opts.verify) {
      bytes += fileSize(join(ctx.out, "anims/index.json"));
    } else {
      const w = writeJson(join(ctx.out, "anims/index.json"), index, true);
      bytes += w.bytes;
      if (w.written) written++;
    }
    outputs.push("anims/index.json");

    return {
      files: written,
      bytes,
      skipped: outputs.length - written,
      summary: `${Object.keys(index.entities).length} entities  ${frameCount} animation frames`,
      outputs,
    };
  },
};
