#!/usr/bin/env node
// Bootstraps data/objects-bootstrap.json from the old fan port's allObjects.js
// (used strictly as a data reference). Run: node tools/bootstrap-objects.mjs [src] [out]
//
// Units in the output (all GD units, 1 block = 30, y up, positions are object centres):
//   gridW/gridH    sprite footprint in blocks, as given by the source table
//   hitbox         { shape:'rect', w, h, ox, oy } | { shape:'circle', r, ox, oy } | null
//                  ox/oy are always 0 - the source table carries no hitbox offsets.
//                  `source` records which source convention produced the shape:
//                    'hitbox_radius'  circle, radius already in GD units
//                    'hitboxScale'    rect = spriteW*hitboxScaleX by spriteH*hitboxScaleY
//                    'grid'           rect = gridW*30 by gridH*30 (solid/portal/pad/ring/coin/speed/trigger)
//                    'hazard-default' rect = 0.2*gridW*30 by 0.4*gridH*30, `estimated:true`
//                                     (the source table has no hitbox data for these hazards)
//   children[].dx/dy  converted from the source's localDx/localDy, which are the fan port's
//                  world pixels (2 px per GD unit, y down): dx = localDx/2, dy = -localDy/2.
//   raw            the untouched source entry, for anything the normalisation dropped.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A copy of the old fan port's table, kept here because the port itself was retired
// out of the served folder (data/games/content/_retired/webdashers/).
const DEFAULT_SRC = path.resolve(HERE, '..', 'data', 'ref', 'allObjects.js');
const SRC = process.argv[2] ?? DEFAULT_SRC;
const OUT = process.argv[3] ?? path.resolve(HERE, '..', 'data', 'objects-bootstrap.json');

const BLOCK = 30;
const FAN_PX_PER_UNIT = 2;
const HAZARD_DEFAULT_SCALE_X = 0.2;
const HAZARD_DEFAULT_SCALE_Y = 0.4;
const GRID_COLLIDABLE = new Set(['solid', 'portal', 'pad', 'ring', 'coin', 'speed', 'trigger']);
const NON_COLLIDABLE = new Set(['deco', 'soliddeco', 'pixel', 'particle']);

function loadTable(file) {
  const code = fs.readFileSync(file, 'utf8');
  const sandbox = Object.create(null);
  sandbox.window = {};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: path.basename(file), timeout: 10_000 });
  const fn = sandbox.window.allobjects;
  if (typeof fn !== 'function') throw new Error(`${file} did not define window.allobjects()`);
  const table = fn();
  if (!table || typeof table !== 'object') throw new Error('allobjects() did not return an object');
  return table;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const round = (v) => Math.round(v * 1000) / 1000;

function normaliseHitbox(e) {
  const gridW = num(e.gridW) ?? 0;
  const gridH = num(e.gridH) ?? 0;
  const r = num(e.hitbox_radius);
  if (r !== undefined && r > 0) {
    return { shape: 'circle', r: round(r), ox: 0, oy: 0, source: 'hitbox_radius' };
  }
  const sx = num(e.hitboxScaleX);
  const sy = num(e.hitboxScaleY);
  if (sx !== undefined && sy !== undefined) {
    const sw = num(e.spriteW) ?? gridW * BLOCK;
    const sh = num(e.spriteH) ?? gridH * BLOCK;
    if (sw > 0 && sh > 0) {
      return { shape: 'rect', w: round(sw * sx), h: round(sh * sy), ox: 0, oy: 0, source: 'hitboxScale' };
    }
  }
  if (e.type === 'hazard') {
    if (gridW > 0 && gridH > 0) {
      return {
        shape: 'rect',
        w: round(gridW * BLOCK * HAZARD_DEFAULT_SCALE_X),
        h: round(gridH * BLOCK * HAZARD_DEFAULT_SCALE_Y),
        ox: 0, oy: 0,
        source: 'hazard-default',
        estimated: true,
      };
    }
    return null;
  }
  if (GRID_COLLIDABLE.has(e.type) && gridW > 0 && gridH > 0) {
    return { shape: 'rect', w: round(gridW * BLOCK), h: round(gridH * BLOCK), ox: 0, oy: 0, source: 'grid' };
  }
  return null;
}

function normaliseChild(c) {
  const out = {
    frame: typeof c.frame === 'string' ? c.frame : null,
    dx: round((num(c.localDx) ?? 0) / FAN_PX_PER_UNIT),
    dy: round(-(num(c.localDy) ?? 0) / FAN_PX_PER_UNIT),
    z: num(c.z) ?? 0,
  };
  if (num(c.rot) !== undefined) out.rot = c.rot;
  if (num(c.tint) !== undefined) out.tint = c.tint;
  if (typeof c.blend === 'string') out.blend = c.blend;
  if (typeof c.glow_frame === 'string' && c.glow_frame !== 'none') out.glowFrame = c.glow_frame;
  if (typeof c.color_channel === 'string') out.colorChannel = c.color_channel;
  if (typeof c.type === 'string') out.type = c.type;
  if (c.portalGuide) out.portalGuide = true;
  if (c._portalFront) out.portalFront = true;
  if (c.orbGuide) out.orbGuide = true;
  if (c.audioScale) out.audioScale = true;
  if (c.cant_color || c.Cant_Color) out.cantColor = true;
  return out;
}

function normaliseEntry(e) {
  return {
    type: typeof e.type === 'string' ? e.type : 'unknown',
    frame: typeof e.frame === 'string' ? e.frame : null,
    glowFrame: typeof e.glow_frame === 'string' && e.glow_frame !== 'none' ? e.glow_frame : null,
    gridW: num(e.gridW) ?? 0,
    gridH: num(e.gridH) ?? 0,
    hitbox: normaliseHitbox(e),
    zLayer: num(e.default_z_layer) ?? null,
    zOrder: num(e.default_z_order) ?? num(e.z) ?? null,
    baseChannel: num(e.default_base_color_channel) ?? null,
    detailChannel: num(e.default_detail_color_channel) ?? null,
    children: Array.isArray(e.children) ? e.children.map(normaliseChild) : [],
    raw: e,
  };
}

const table = loadTable(SRC);
const ids = Object.keys(table).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
const out = {};
const stats = { entries: 0, byType: {}, hitbox: { rect: 0, circle: 0, null: 0 }, hitboxSource: {}, children: 0, withChildren: 0 };
for (const id of ids) {
  const n = normaliseEntry(table[id]);
  out[id] = n;
  stats.entries++;
  stats.byType[n.type] = (stats.byType[n.type] || 0) + 1;
  if (n.hitbox) {
    stats.hitbox[n.hitbox.shape]++;
    stats.hitboxSource[n.hitbox.source] = (stats.hitboxSource[n.hitbox.source] || 0) + 1;
  } else {
    stats.hitbox.null++;
  }
  if (n.children.length) { stats.withChildren++; stats.children += n.children.length; }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const json = JSON.stringify(out, null, 1);
fs.writeFileSync(OUT, json);
stats.bytes = Buffer.byteLength(json);
stats.out = OUT;
console.log(JSON.stringify(stats, null, 2));
