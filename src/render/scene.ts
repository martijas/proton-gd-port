// One level on screen: the sheets as textures, the level as a baked draw list,
// and a camera. Everything that decides what a frame looks like is assembled
// here so the debug page stays a page.
//
// A scene can be driven by a simulation or stand on its own. With one attached
// it reads the trigger runtime every frame — the live colour table, the group
// transforms, the camera triggers and the shake — and without one it draws the
// level exactly as its header describes it.

import { GlContext } from "../engine/gl/context";
import { SpriteBatch, MAX_SHEETS, SHEET_PLAYER, SHEET_PLAYER_2, UPLOAD_UNIT } from "../engine/gl/spriteBatch";
import { AnimSet, type AnimEntity } from "../assets/anims";
import { IconSet } from "../assets/icons";
import { PlayerRenderer } from "./player";
import type { Scenery } from "../assets/scenery";
import { BACKGROUND_SPEED, BackdropDrift, MIDDLEGROUND_SPEED, SceneryRenderer, groundLineFrame, groundLineScale, type GroundLine } from "./scenery";
import { uploadTexture } from "../engine/gl/texture";
import { AtlasSet } from "../assets/atlas";
import type { ObjectRecord } from "../assets/objectTypes";
import type { GameMode, Level } from "../level/types";
import { TICK_RATE, type PlayerState, type Sim } from "../physics/types";
import { MINI_SCALE } from "../physics/constants";
import { lerp, lerpAngle } from "../engine/math";
import { Camera, corridorArt, turnPoint } from "./camera";
import { GRADIENT_SLOT, GradientPainter } from "./gradients";
import { applyHsv, CHANNEL, ColorTable, describeChannel, playerChannelColours, type Rgb } from "./colors";
import { DrawList, linkedExitOffset, objectChannels, type DrawListStats, type LiveScene } from "./drawList";
import { batchZ, drawLayerRuns, drawParticleRuns, parentMode, type CountedRuns } from "./batchNodes";
import { CircleWaves, shownOpacity, spawnEffectWaves, wavesFor, type WaveContext, type WaveScene } from "./circleWaves";
import { ShaderBand, bandUniforms, newBandUniforms, type BandScene } from "./post";
import {
  effectiveZLayer,
  effectiveZOrder,
  LAYERS_BEHIND,
  layerOfPart,
  OBJECT_Z,
  SCENE_PART,
  SCENE_PARTS,
  sceneOrder,
  SHADER_LAYER,
  shaderActive,
  type BandSide,
  type ShaderState,
} from "../triggers/shaderState";
import type { LevelFont } from "./text";
import { ParticleField } from "./particles";
import { frameQuad } from "./frameQuad";
import { EFFECT_FRAMES, type EffectArt } from "./effects";
import { HardStreak, StreakBlend } from "./hardStreak";
import { GhostTrail, type GhostPlayer } from "./ghostTrail";
import { PlayerParticles, defFromPlist } from "./playerParticles";
import { fetchAsset } from "../assets/paths";
import type { ParticleFile } from "../assets/miscTypes";

export interface FrameStats {
  sprites: number;
  drawCalls: number;
  buildMs: number;
  gatherMs: number;
}

/** How fast the shake re-rolls when the trigger asks for no interval. [gdp applyShake :431250] */
const SHAKE_DEFAULT_INTERVAL = 0;

/** B1's draw layer: the last behind the player, whose top the streak and the objects' own particle systems share. */
const B1_SLOT = LAYERS_BEHIND - 1;

/**
 * The ground line's art, looked up in the sheets. The game clamps the header's
 * index into 1..3 before it uses it, so a level that leaves the key at zero
 * still gets a line — which is most of them.
 */
function groundLineFor(index: number, atlas: AtlasSet): GroundLine | null {
  const clamped = Math.min(3, Math.max(1, Math.round(index)));
  const found = atlas.frame(groundLineFrame(clamped));
  if (!found) return null;
  const quad = frameQuad(found.atlas, found.frame, atlas.pxPerUnit);
  return {
    u0: quad.u0,
    v0: quad.v0,
    du: quad.du,
    dv: quad.dv,
    unit: found.atlasIndex,
    height: quad.hh * 2,
    rotated: quad.rotated,
    scaleY: groundLineScale(clamped),
  };
}

export class Scene {
  readonly camera = new Camera();
  private batch: SpriteBatch | null = null;
  private textures: (WebGLTexture | null)[] = [];
  private list: DrawList | null = null;
  private scenery: SceneryRenderer | null = null;
  private sceneryFile: Scenery | null = null;
  private band: ShaderBand | null = null;
  readonly player = new PlayerRenderer();
  private icons: IconSet | null = null;
  private anims: AnimSet | null = null;
  private font: LevelFont | null = null;
  private fontTexture: WebGLTexture | null = null;
  private effects: EffectArt | null = null;
  private effectsTexture: WebGLTexture | null = null;
  /** The wave's band, one per player. */
  readonly bands = [new HardStreak(), new HardStreak()] as const;
  /** The Ghost Trail's copies of both players. */
  readonly ghosts = new GhostTrail();
  /** The bands' blend, made when the level's first tick sees the player's colours. */
  private streakBlend: StreakBlend | null = null;
  /**
   * Seconds since the player died or finished, while the simulation stands
   * still: the band's fade and the Ghost Trail's run on it, as the game's
   * actions go on running under the death. A pause holds it.
   */
  private afterlife = 0;
  readonly playerParticles = new PlayerParticles();
  /** The player's own effects, which the settings screen can turn off. */
  particlesEnabled = true;
  /** The shader triggers' screen effects, which the settings screen can turn off. */
  effectsEnabled = true;
  /** The circles alive in the level (circleWaves.ts). */
  private readonly waves = new CircleWaves();
  /**
   * The corner of the view (+852) and the zoom (+328) the last tick's step
   * ran under, before the tick's follow moved the camera on: where the game
   * puts a circle it adds to its own layer (WaveContext.toScreen).
   */
  private readonly stepView = { x: 0, y: 0, zoom: 1 };
  /** Skeletal entities this level's objects need, loaded before the bake. */
  private readonly entities = new Map<string, AnimEntity>();
  private iconTextures = new Map<number, WebGLTexture | null>();
  /** Icon page uploads still loading, so a page is only ever uploaded once. */
  private readonly iconUploads = new Map<number, Promise<void>>();
  /** Pages whose image would not load. Not retried: the icon set keeps the failure too. */
  private readonly failedPages = new Set<number>();
  private boundPages: number[] = [];
  /** The pages the players last needed, and the modes that answer was for. */
  private wantedPages: readonly number[] = [];
  private lastMode2: GameMode | null = null;
  private particles: ParticleField | null = null;
  private sim: Sim | null = null;
  private lastMode: GameMode | null = null;
  private colors: ColorTable | null = null;
  private live: LiveScene | null = null;
  /** The music pulse (audio/pulse.ts) this frame draws with; 0.5 when nothing sets it. */
  pulse = 0.5;
  private level: Level | null = null;
  private background = { r: 0.1, g: 0.11, b: 0.16 };
  private shakeX = 0;
  private shakeY = 0;
  private shakeAt = 0;
  private shakeSeed = 0x2545f491;
  private lastDelta = 0;
  /** Wall clock, for a scene with no simulation to take the time from. */
  private wallClock = 0;
  /** The player's pose at the end of the previous tick, for interpolation. */
  private readonly prevPose = { x: 0, y: 0, rotation: 0, has: false };
  private readonly pose = { x: 0, y: 0, rotation: 0 };
  readonly stats: FrameStats = { sprites: 0, drawCalls: 0, buildMs: 0, gatherMs: 0 };

  constructor(readonly gl: GlContext) {}

  /** Uploads every sheet once. Safe to call again after a context loss. */
  async loadSheets(atlas: AtlasSet): Promise<void> {
    const gl = this.gl.gl;
    this.batch ??= new SpriteBatch(gl);
    const count = Math.min(atlas.atlases.length, MAX_SHEETS);
    if (atlas.atlases.length > MAX_SHEETS) {
      console.warn(`${atlas.atlases.length} sheets but only ${MAX_SHEETS} texture units are used`);
    }
    const images = await Promise.all(Array.from({ length: count }, (_, i) => atlas.image(i)));
    this.textures = images.map((image) => uploadTexture(gl, image));
    this.batch.bindSheets(this.textures);
    this.scenery ??= new SceneryRenderer(gl);
    this.band ??= new ShaderBand(this.gl);
    void this.band.load();
  }

  /**
   * The player's icons and the two skeletal animations. Separate from the
   * sheets because the icon pages are bound per mode rather than for good:
   * there are 23 of them and only two units to hold them.
   */
  async loadPlayer(): Promise<void> {
    const icons = await IconSet.load();
    const anims = await AnimSet.load();
    this.icons = icons;
    this.anims = anims;
    await this.player.load(icons, anims);
  }

  /**
   * Puts one icon page on the GPU, once. A second request while the first is
   * still loading shares it, so a page is never uploaded twice.
   */
  private uploadPage(page: number): Promise<void> {
    const icons = this.icons;
    if (!icons || this.iconTextures.has(page) || this.failedPages.has(page)) return Promise.resolve();
    let pending = this.iconUploads.get(page);
    if (!pending) {
      pending = icons
        .image(page)
        .then((img) => {
          this.iconTextures.set(page, uploadTexture(this.gl.gl, img));
        })
        // A page that will not load leaves that mode's player undrawn, which
        // is all there is to do without the image; it must not also throw from
        // a draw call that did not wait for it.
        .catch((e: unknown) => {
          this.failedPages.add(page);
          console.warn(`Icon page ${page} could not be loaded`, e);
        })
        .finally(() => this.iconUploads.delete(page));
      this.iconUploads.set(page, pending);
    }
    return pending;
  }

  /**
   * Binds up to two icon pages to the two units kept for them — immediately,
   * and only if every one of them is already on the GPU. When one is not,
   * this starts its upload and binds nothing, rather than binding a page that
   * is missing and leaving whatever was there before in its place.
   *
   * Immediate matters because the old version awaited the upload before it
   * bound, so two requests could finish in the wrong order and leave the older
   * one's pages bound — a player drawing against a page it does not have,
   * which draws nothing at all.
   */
  private bindUploaded(pages: readonly number[]): boolean {
    const wanted = pages.length > 2 ? pages.slice(0, 2) : pages;
    if (samePages(wanted, this.boundPages)) return true;
    let ready = true;
    for (const page of wanted) {
      if (this.iconTextures.has(page)) continue;
      ready = false;
      void this.uploadPage(page);
    }
    if (!ready || !this.batch) return false;
    const gl = this.gl.gl;
    const units = new Map<number, number>();
    const slots = [SHEET_PLAYER, SHEET_PLAYER_2];
    for (let i = 0; i < wanted.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + slots[i]);
      gl.bindTexture(gl.TEXTURE_2D, this.iconTextures.get(wanted[i]) ?? null);
      units.set(wanted[i], slots[i]);
    }
    this.player.setUnits(units);
    this.iconUnits = units;
    this.boundPages = [...wanted];
    return true;
  }

  /**
   * Binds up to two icon pages, loading them first if they need it, and says
   * which unit each landed on. For the menus and the icon kit, which share the
   * two units with the player; the level puts the player's own pages back on
   * the very next frame it draws, so a menu can no longer leave it without.
   */
  async bindPages(pages: readonly number[]): Promise<ReadonlyMap<number, number>> {
    if (!this.icons || !this.batch) return this.iconUnits;
    const wanted = pages.slice(0, 2);
    await Promise.all(wanted.map((p) => this.uploadPage(p)));
    this.bindUploaded(wanted);
    return this.iconUnits;
  }

  /**
   * Loads every icon page a level can ask for before its first attempt, so the
   * player never blinks out on entering a mode for the first time while that
   * mode's image downloads. Only the modes the level actually uses: each page
   * is a 2048-square texture, and holding all of them would cost 16 MB apiece.
   */
  async preloadPlayerPages(modes: Iterable<GameMode>): Promise<void> {
    const pages = new Set<number>();
    for (const mode of modes) for (const page of this.player.pagesFor(mode)) pages.add(page);
    await Promise.all([...pages].map((p) => this.uploadPage(p)));
  }

  /** Which unit each bound icon page is on right now. */
  iconUnits: ReadonlyMap<number, number> = new Map();

  /**
   * Forgets which pages the player has, so the next frame binds them again —
   * for after the icon kit has changed the choice while the pages the level
   * last asked for are still the ones bound.
   */
  refreshPlayerPages(): void {
    this.forgetPlayerPages();
    this.boundPages = [];
  }

  /** Drops the cached answer to "which pages do the players need". */
  private forgetPlayerPages(): void {
    this.lastMode = null;
    this.lastMode2 = null;
  }

  /**
   * The icon pages both players need, player 1's first. Worked out again only
   * when a mode changes, because the draw path runs every frame and this
   * allocates. Two units hold them, so a dual whose two players need three
   * pages between them — a ship's rider plus a ball, say — loses the third,
   * and player 1 always keeps its own.
   */
  private playerPages(mode1: GameMode, mode2: GameMode | null): readonly number[] {
    if (mode1 === this.lastMode && mode2 === this.lastMode2) return this.wantedPages;
    const pages = this.player.pagesFor(mode1);
    if (mode2 !== null) for (const page of this.player.pagesFor(mode2)) if (!pages.includes(page)) pages.push(page);
    this.lastMode = mode1;
    this.lastMode2 = mode2;
    this.wantedPages = pages;
    return pages;
  }

  /** The skeletal animations, for a menu that wants to pose a robot. */
  get animations(): AnimSet | null {
    return this.anims;
  }

  /** The backgrounds and grounds, loaded once and shared by every level. */
  useScenery(scenery: Scenery): void {
    this.sceneryFile = scenery;
  }

  /**
   * Attaches the simulation whose triggers drive this scene. Passing null goes
   * back to drawing the level as its header describes it.
   */
  useSim(sim: Sim | null): void {
    this.sim = sim;
    this.forgetPlayerPages();
    // Forget which pages are bound: a level change rebinds the sheets, and the
    // icon units have to be claimed again after it.
    this.boundPages = [];
    this.particles?.reset();
    this.list?.reset();
    this.waves.clear();
    this.live = sim
      ? { colors: sim.triggers.colors, triggers: sim.triggers, playerDead: () => sim.state.dead, pulse: () => this.pulse }
      : null;
    if (sim) this.colors = sim.triggers.colors;
  }

  /**
   * The face a level's text objects draw in, shared with the interface. Has to
   * be set before a level is built: the glyphs are baked into the same sorted
   * array as every other sprite.
   */
  setFont(supplied: { levelFont: LevelFont; texture: WebGLTexture } | null): void {
    this.font = supplied?.levelFont ?? null;
    this.fontTexture = supplied?.texture ?? null;
  }

  /** The packed page the trail and the other loose art come off. */
  setEffects(supplied: { art: EffectArt; texture: WebGLTexture } | null): void {
    this.effects = supplied?.art ?? null;
    this.effectsTexture = supplied?.texture ?? null;
    void this.loadPlayerParticles();
  }

  /**
   * The player's own four effects. They come out of `particles.json`, which the
   * asset build has been writing all along with nothing reading it, and they
   * are drawn with the flat square on the interface's page.
   */
  private async loadPlayerParticles(): Promise<void> {
    const art = this.effects;
    if (!art || this.playerParticles.ready) return;
    const quad = art.quad(EFFECT_FRAMES.white);
    if (!quad) return;
    this.particleFile = await fetchAsset<ParticleFile>("particles.json");
    this.playerParticles.load(this.particleFile, quad);
    this.addBuiltInParticles();
  }

  /** particles.json, once loaded: the player's effects and the objects' built-in systems come from it. */
  private particleFile: ParticleFile | null = null;
  /** The level's object table, for the built-in systems. */
  private levelRender: ((id: number) => ObjectRecord | undefined) | null = null;

  /**
   * The systems the level's objects carry of their own (ParticleField.
   * addBuiltIn), once the level, particles.json and the interface's page,
   * whose square and circle they are drawn with, are all in hand.
   */
  private addBuiltInParticles(): void {
    const field = this.particles;
    const file = this.particleFile;
    const art = this.effects;
    const level = this.level;
    const render = this.levelRender;
    if (!field || !file || !art || !level || !render || field.hasBuiltIn) return;
    field.addBuiltIn(
      level,
      render,
      (name) => {
        const p = file.effects[name];
        return p ? { def: defFromPlist(p), texture: String(p.textureFileName ?? "") } : null;
      },
      (texture) => {
        const q = art.quad(texture.replace(/\.png$/, ""));
        return q ? { u0: q.u0, v0: q.v0, du: q.du, dv: q.dv, sheet: q.unit, rotated: 0 } : null;
      },
    );
  }

  /** Loads the skeletal entities this level places, once each. */
  private async loadEntitiesFor(level: Level, render: (id: number) => ObjectRecord | undefined): Promise<void> {
    const anims = this.anims;
    if (!anims) return;
    const wanted = new Set<string>();
    for (const object of level.objects) {
      const name = render(object.id)?.ent;
      if (name && !this.entities.has(name) && anims.has(name)) wanted.add(name);
    }
    await Promise.all(
      [...wanted].map(async (name) => {
        const entity = await anims.entity(name);
        if (entity) this.entities.set(name, entity);
      }),
    );
  }

  /** Expands a level into sprites. The slow part of changing level, about a frame's worth. */
  async setLevel(level: Level, render: (id: number) => ObjectRecord | undefined, atlas: AtlasSet, sim?: Sim | null): Promise<DrawListStats> {
    const started = performance.now();
    this.level = level;
    this.useSim(sim ?? null);
    // A new level builds its players afresh, and their bands' blend with them.
    this.streakBlend = null;
    // A new level makes its background afresh, at the screen's foot.
    this.backgroundDrift.reset();
    this.middlegroundDrift.reset();
    this.colors ??= ColorTable.resolve(level.header);
    const index = sim?.triggers.index;
    // The beasts have to be in hand before the bake: their limbs are baked into
    // the same sorted array as everything else, so they cannot arrive later
    // without rebuilding it.
    await this.loadEntitiesFor(level, render);
    this.list = DrawList.build(level, render, atlas, this.colors, index?.movingGroups, this.entities, this.font);
    // Custom Particles carry their own definition in the level string, so the
    // emitters come out of the level rather than out of the asset build.
    this.particles = new ParticleField(
      level,
      atlas,
      (o) => effectiveZLayer(o.zLayer, render(o.id)?.zl),
      (o) => effectiveZOrder(o.zOrder, render(o.id)?.zo),
    );
    this.levelRender = render;
    this.addBuiltInParticles();
    if (this.particles.missingFrames > 0) {
      console.warn(`${this.particles.missingFrames} particle emitter(s) had no frame`);
    }
    const bg = this.colors.get(CHANNEL.BG);
    this.background = { r: bg.r / 255, g: bg.g / 255, b: bg.b / 255 };
    this.stats.buildMs = performance.now() - started;
    if (this.scenery && this.sceneryFile) {
      this.scenery.setLine(groundLineFor(level.header.groundLine, atlas));
      // kA25 picks the middleground; it shares the scratch unit, so nothing
      // may assume its binding survives a frame and each pass rebinds it.
      await this.scenery.setMiddleground(this.sceneryFile, Number(level.header.raw.kA25 ?? 0), UPLOAD_UNIT);
      const extra = await this.scenery.setLevel(this.sceneryFile, level.header);
      for (let i = 0; i < extra.length; i++) if (extra[i] !== undefined) this.textures[i] = extra[i];
      this.batch?.bindSheets(this.textures);
    }
    return this.list.stats;
  }

  /**
   * One simulation tick's worth of camera and player bookkeeping.
   *
   * Called from the fixed-step tick rather than from the frame, so the camera
   * follows at a rate that does not depend on the refresh rate, and so the
   * previous pose is there for the frame to interpolate from.
   */
  tick(sim: Sim): void {
    this.prevPose.x = this.pose.x;
    this.prevPose.y = this.pose.y;
    this.prevPose.rotation = this.pose.rotation;
    const p = sim.state;
    this.pose.x = p.x;
    this.pose.y = p.y;
    this.pose.rotation = p.rotation;
    if (!this.prevPose.has) {
      this.prevPose.x = p.x;
      this.prevPose.y = p.y;
      this.prevPose.rotation = p.rotation;
      this.prevPose.has = true;
    }
    // The camera triggers' tweens have been stepped in the sim's tick; the
    // follow needs this tick's zoom for the gameplay offset and the padding.
    this.camera.applyTriggers(sim.triggers.camera);
    const before = this.camera.centre();
    this.stepView.x = before.x - this.camera.unitsWide / 2;
    this.stepView.y = before.y - this.camera.unitsHigh / 2;
    this.stepView.zoom = this.camera.zoom;
    this.camera.follow(p);
    // The background and the middleground move by the camera's step, on the
    // screen. [gdp updateCameraBGArt :431053-431165]
    const after = this.camera.centre();
    const zoom = this.camera.zoom;
    const scenery = this.scenery;
    if (scenery) {
      this.backgroundDrift.step(after.x - before.x, after.y - before.y, zoom, BACKGROUND_SPEED.x, BACKGROUND_SPEED.y, scenery.backgroundWidth(this.camera));
      this.middlegroundDrift.step(after.x - before.x, 0, zoom, MIDDLEGROUND_SPEED.x, 0, scenery.middlegroundWidth(zoom));
    }
    this.trackStreaks(sim);
    // The circles this tick's step made.
    if (sim.waves.length > 0) {
      const ctx = this.waveContext(sim);
      for (const w of sim.waves) for (const made of wavesFor(w, ctx)) this.waves.add(made);
    }
  }

  /**
   * The rings a player makes as it is put back after a reset — any attempt
   * but the level's first, and a practice respawn — around each player there
   * is. [gdp PlayLayer::resetLevel :105947-105951 (+10958, set only by the
   *  load's own reset: setupHasCompleted :106344, resetLevelVariables
   *  :463044); PlayerObject::playSpawnEffect :143028-143070]
   */
  playSpawnEffect(): void {
    const sim = this.sim;
    if (!sim) return;
    const ctx = this.waveContext(sim);
    for (const made of spawnEffectWaves(1, sim.state.x, sim.state.y, ctx)) this.waves.add(made);
    const p2 = sim.state2;
    if (p2) for (const made of spawnEffectWaves(2, p2.x, p2.y, ctx)) this.waves.add(made);
  }

  /** What the circles read off the scene when they are made. */
  private waveContext(sim: Sim): WaveContext {
    const colours = this.colors;
    const level = sim.level;
    const render = this.levelRender;
    const visual = sim.triggers.visual;
    const view = this.stepView;
    return {
      // The game's Low Detail Mode (GameManager +669, "performanceMode"),
      // which leaves out most of the circles. The port has no switch for it,
      // so it is off, as the game's is unless the player turns it on.
      // [gdp GameManager +669, saved as "performanceMode" :118927, :119711;
      //  SupportLayer::onLowDetail :372726-372742]
      performanceMode: false,
      playerColour: (which, slot) => {
        // Player 2 wears the pair the other way round. [gdp spawnPlayer2's
        //  colours, gd-ida-decomp.cpp:417963-417976]
        const own: 1 | 2 = which === 1 ? slot : slot === 1 ? 2 : 1;
        return colours ? colours.iconColour(own) : own === 1 ? DEFAULT_ICON_1 : DEFAULT_ICON_2;
      },
      channelColour: (id) => (colours ? colours.get(id) : WHITE_RGB),
      objectColour: (i) => {
        const o = level.objects[i];
        const record = o ? render?.(o.id) : undefined;
        if (!o || !record || !colours) return WHITE_RGB;
        // getColor: the colour sprite's (+748) when the object has one, the
        // object's own otherwise. [PlayerObject::ringJump :159983-159987;
        //  GameObject::spawnDefaultPickupParticle :622192]
        const channels = objectChannels(o, record);
        const slot = record.ch?.some((c) => c.ct === "D") ? "D" : (record.ct ?? "B");
        if (slot === "K") return { r: 0, g: 0, b: 0 };
        return applyHsv(colours.get(slot === "D" ? channels.detail : channels.base), slot === "D" ? o.detailHsv : o.baseHsv);
      },
      objectPosition: (i) => sim.triggers.objectPosition(i),
      objectBatchZ: (i) => {
        const o = level.objects[i];
        return batchZ(effectiveZLayer(o.zLayer, render?.(o.id)?.zl), false, parentMode(o.id));
      },
      linkedExitOffset: (i) => linkedExitOffset(level.objects[i]),
      playerShown: (which) => !(visual.hidePlayer || (which === 1 ? visual.options.hidePlayer1 : visual.options.hidePlayer2)),
      spriteOpacity: (i, detail) => {
        const o = level.objects[i];
        if (!o) return detail ? -1 : 255;
        const record = render?.(o.id);
        // The colour sprite (+748) is the child the detail colour is on.
        if (detail && !record?.ch?.some((c) => c.ct === "D")) return -1;
        const channels = record ? objectChannels(o, record) : { base: o.baseColor ?? 0, detail: o.detailColor ?? 0 };
        const channel = detail ? channels.detail : channels.base;
        const alpha = channel > 0 && colours ? colours.get(channel).a : 1;
        return shownOpacity(alpha, o.groups, (g) => sim.triggers.groupAlphaOf(g));
      },
      toScreen: (x, y) => [(x - view.x) * view.zoom, (y - view.y) * view.zoom],
    };
  }

  /**
   * The wave's bands and the Ghost Trail, a tick on: each band takes the
   * player's position, the Ghost Trail takes a copy when one is due.
   */
  private trackStreaks(sim: Sim): void {
    const seconds = sim.tick / TICK_RATE;
    const visual = sim.triggers.visual;
    const colours = this.colors;
    const icon1 = colours ? colours.iconColour(1) : DEFAULT_ICON_1;
    const icon2 = colours ? colours.iconColour(2) : DEFAULT_ICON_2;
    this.streakBlend ??= new StreakBlend(isBlack(icon1));
    const additive = this.streakBlend.follow(visual.options.streakAdditive);
    const view = this.camera.coverBounds(0);
    const players = [sim.state, sim.state2] as const;
    for (let i = 0; i < 2; i++) {
      const p = players[i];
      // Player 2 wears the pair the other way round.
      const own = i === 0 ? icon1 : icon2;
      const other = i === 0 ? icon2 : icon1;
      const hidden = visual.hidePlayer || (i === 0 ? visual.options.hidePlayer1 : visual.options.hidePlayer2);
      const band = this.bands[i];
      if (p) {
        band.track(
          { x: p.x, y: p.y, laying: p.mode === "wave" && !p.dead && !hidden, reversed: p.reversed },
          seconds,
          view,
          p.mini ? MINI_SCALE : 1,
          additive,
          own,
        );
      } else if (!band.empty) {
        band.track({ x: 0, y: 0, laying: false, reversed: false }, seconds, view, 1, additive, own);
      }
      const ghost: GhostPlayer | null = p && visual.ghostTrail
        ? { x: p.x, y: p.y, rotation: p.rotation, mode: p.mode, scale: p.mini ? MINI_SCALE : 1, dead: p.dead, icon: own, strong: playerChannelColours(own, other).p1 }
        : null;
      this.ghosts.step(i as 0 | 1, visual.ghostTrail, ghost, 1 / TICK_RATE, seconds, this.player);
    }
  }

  /**
   * Forgets the previous pose, so a restart does not slide into place, and
   * what the level's objects carried from frame to frame, as the game's reset
   * starts them afresh.
   */
  resetInterpolation(): void {
    this.prevPose.has = false;
    this.afterlife = 0;
    for (const band of this.bands) band.reset();
    this.ghosts.reset();
    this.playerParticles.reset();
    this.list?.reset();
  }

  /**
   * Advances everything that moves with wall-clock time rather than with the
   * simulation: the colour fades, the pulses, the screen effects, the shake
   * and, at the next draw, the particles. The camera moves with the
   * simulation's ticks (`tick`).
   *
   * A `dt` of 0 is a frozen frame, which is what a caller passes while the
   * level is paused: nothing moves, nothing is rolled again, and the next
   * draw shows the same picture. The game pauses the whole level layer, so
   * none of these run under its pause menu.
   * [PlayLayer::pauseGame :93439-93477 ends in the layer's own onExit
   *  (vfunc 352, as CCNode::detachChild :789946 calls it), which stops its
   *  scheduler and with it GJBaseGameLayer::update :469606ff — the colours,
   *  the shader and, through updateVisibility, the particles; PlayLayer::
   *  resume :93497ff calls onEnter (344) to start them again]
   */
  update(dt: number): void {
    this.lastDelta = Math.max(0, dt);
    if (dt <= 0) return;
    this.wallClock += dt;
    this.waves.update(dt);
    const sim = this.sim;
    if (sim && (sim.state.dead || sim.state.finished)) this.afterlife += dt;
    const live = this.live;
    if (!live) return;
    live.triggers.updateVisuals(dt);
    const v = live.triggers.visual;
    if (v.shakeRemaining > 0 && v.shakeStrength > 0) {
      const interval = v.shakeInterval > SHAKE_DEFAULT_INTERVAL ? v.shakeInterval : 0;
      this.shakeAt -= dt;
      if (interval <= 0 || this.shakeAt <= 0) {
        this.shakeAt = interval;
        // The game's own shake uses libc rand and is not reproducible, so this
        // may use anything; it never feeds back into the simulation.
        // [gdp GJBaseGameLayer::applyShake :431250-431295]
        this.shakeX = (this.nextRandom() * 2 - 1) * v.shakeStrength;
        this.shakeY = (this.nextRandom() * 2 - 1) * v.shakeStrength;
      }
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  private nextRandom(): number {
    let s = this.shakeSeed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.shakeSeed = s;
    return ((s >>> 0) % 65536) / 65536;
  }

  draw(alpha = 1): void {
    const { gl } = this;
    if (gl.isLost || !this.batch) return;
    const size = gl.dimensions;
    this.camera.setAspect(size.width, size.height);
    // The background channel is one a colour trigger changes constantly, so the
    // clear colour is read now rather than at load.
    if (this.colors) {
      const bg = this.colors.get(CHANNEL.BG);
      this.background = { r: bg.r / 255, g: bg.g / 255, b: bg.b / 255 };
    }
    gl.clear(this.background.r, this.background.g, this.background.b);
    if (!this.list) return;

    // Bound every frame rather than remembered: a menu borrows the two scenery
    // units for its own sky and ground while no level is drawing, and the
    // interface's rule — bind what you use, every time — is the one that has
    // held up. Eleven bind calls a frame is nothing.
    this.batch.bindSheets(this.textures);

    const started = performance.now();
    // A turned view culls to the box its corners reach, as the game grows its
    // cull rect. [gdp GJBaseGameLayer::preUpdateVisibility :452608-452650]
    const view = this.camera.coverBounds(30, alpha);
    // The simulation's clock drives every animation, so a pause holds them and
    // two runs of one macro draw the same frames.
    const seconds = this.sim ? this.sim.tick / TICK_RATE : this.wallClock;
    // The cull box is padded; the enter effects measure from the real edge,
    // of the view as it would be unturned. [:452589-452592]
    const data = this.list.visible(view, this.live, seconds, this.camera.bounds(0, alpha));
    this.stats.gatherMs = performance.now() - started;

    this.bindLevelPages();

    const centre = this.camera.centre(alpha);
    this.frameCentreX = centre.x + this.shakeX;
    this.frameCentreY = centre.y + this.shakeY;
    this.frameAlpha = alpha;
    // The whole level turns about the screen's centre, after the zoom, the
    // scroll and the shake; the interface does not. [gdp GJBaseGameLayer::
    // visit :434055-434079 (setRotation on the three game-layer wrappers;
    // the UILayer is a child of its own, :462107-462109)]
    this.frameTurn = this.camera.rotationAt(alpha);
    // The size part-way too: a zoom steps once a tick, like the centre and
    // the turn.
    this.batch.beginFrame(this.frameCentreX, this.frameCentreY, this.camera.unitsWideAt(alpha), this.camera.unitsHighAt(alpha), this.frameTurn);

    // Every particle system is stepped once, before anything is drawn: their
    // runs are drawn at different depths below.
    this.frameParticles = this.stepPlayerParticles(alpha);
    this.frameUnder = Math.min(this.frameParticles, this.playerParticles.underCount);
    this.frameCustom = this.stepCustomParticles(view, seconds);
    this.frameOverlay = this.frameCustom ? this.particles : null;
    this.buildWaves(view, alpha);
    this.frameData = data;
    this.frameSeconds = seconds;
    this.placeGradients(alpha);

    // The screen effects, when any is on: the band of layers they reach is
    // drawn into a texture of its own and back through the shader, between
    // what lies below it and what lies above.
    const st = this.effectsEnabled && this.band?.ready ? this.live?.triggers.visual.shader : undefined;
    this.split = st && shaderActive(st) ? st : null;
    this.phase = 0;

    // Back to front, in the game's order (SCENE_PART): the background, the
    // middleground, the object layer, the ground. Inside the object layer the
    // nine batch layers, with the player's own things at their z between B1
    // and T1 — the streak, the dust and dash spray under the player, the
    // Ghost Trail's copies just under it, the landing puffs and exhaust over
    // it — and inside each layer its batches
    // with its particle systems between them by z (batchNodes.ts). The
    // objects' own particle systems sit over the streak, still in B1. The
    // ground covers the whole object layer, which is what hides decoration
    // placed below the floor. With a band, sceneOrder puts what is below it
    // first and what is above it last.
    // [gdp GJBaseGameLayer::createBackground :418114-418117 (z -60),
    //  createMiddleground :418229-418236 (z -39), the object layer
    //  :434837-434838 (z 1), createGroundLayer :418297-418309 (z 40);
    //  the batch z orders :434848-435720; createPlayer :417925-417928]
    try {
      const split = this.split;
      if (split) sceneOrder(split, this.order, this.orderSides);
      for (let i = 0; i < SCENE_PARTS; i++) {
        if (split) this.moveTo(this.orderSides[i] as BandSide);
        this.drawPart(split ? this.order[i] : i);
      }
    } finally {
      // Never left drawing into the band's texture, even by a draw that
      // throws: the interface draws straight after this.
      if (this.phase === 1) this.closeBand();
      this.split = null;
    }
    // The game layer's own circles, over the whole level and outside any
    // band: the layers the level is in are its children at z -1, and the
    // circle is added at z 0. [gdp GJBaseGameLayer::init :461958-461960
    //  (+624 at -1); playExitDualEffect :421177]
    const game = this.waves.gameCount;
    if (game > 0) this.batch.draw(this.waves.buffer, game, this.waves.gameStart);
    this.stats.sprites = this.batch.instances;
    this.stats.drawCalls = this.batch.drawCalls;
  }

  /** The layer being split this frame, or null to draw straight to the screen. */
  private split: ShaderState | null = null;
  /** 0 below the band, 1 inside it, 2 above it. */
  private phase = 0;
  /** This frame's draw order and each part's side, from sceneOrder while a band splits the scene. */
  private readonly order = new Uint8Array(SCENE_PARTS);
  private readonly orderSides = new Int8Array(SCENE_PARTS);
  private frameCentreX = 0;
  private frameCentreY = 0;
  private frameAlpha = 1;
  /** The view's turn this frame, in degrees clockwise. */
  private frameTurn = 0;
  /** What the parts draw from this frame: the level's sprites, the particle runs, the clock. */
  private frameData: Float32Array | null = null;
  private frameCustom: Float32Array | null = null;
  /** frameCustom's runs: the particle systems'. */
  private frameOverlay: CountedRuns | null = null;
  /** The circles' object-layer runs this frame, drawn among the batches with the particle systems; null for none. */
  private frameWaves: CountedRuns | null = null;
  private frameSeconds = 0;
  /** The player's particle instances, and how many of them go under the player. */
  private frameParticles = 0;
  private frameUnder = 0;
  private readonly uniforms = newBandUniforms();
  /** What the band's uniforms read from the scene; built once and refreshed per frame. */
  private readonly bandScene: BandScene = {
    width: 1,
    height: 1,
    zoom: 1,
    colourOf: (channel) => (this.colors ? this.colors.get(channel) : { r: 255, g: 255, b: 255, blending: false }),
    targetOnScreen: (target, out) => this.targetOnScreen(target, out),
  };

  /** Where the background and the middleground have got to on the screen (BackdropDrift). */
  private readonly backgroundDrift = new BackdropDrift();
  private readonly middlegroundDrift = new BackdropDrift();

  /** The Gradient triggers' layers this frame, placed for the view; drawn by drawPart after their parts. */
  private readonly gradients = new GradientPainter();

  private placeGradients(alpha: number): void {
    const live = this.live;
    const white = this.effects?.quad(EFFECT_FRAMES.white);
    const level = this.level;
    if (!live || !white || !level || !this.colors) {
      this.gradients.layerCount.fill(0);
      return;
    }
    const v = this.camera.bounds(0, alpha);
    this.gradients.update(live.triggers.visual.gradients, { level, triggers: live.triggers, colors: this.colors, view: v }, white);
  }

  /** The gradients whose layer draws after slot `slot` (GRADIENT_SLOT). */
  private drawGradients(slot: number): void {
    const g = this.gradients;
    if (!this.batch || g.layerCount[slot] === 0) return;
    if (this.effects && this.effectsTexture) {
      const gl2 = this.gl.gl;
      gl2.activeTexture(gl2.TEXTURE0 + this.effects.unit);
      gl2.bindTexture(gl2.TEXTURE_2D, this.effectsTexture);
    }
    this.batch.draw(g.buffer, g.layerCount[slot], g.layerStart[slot]);
  }

  /** One of the scene's parts, by SCENE_PART, from what this frame gathered. */
  private drawPart(part: number): void {
    const batch = this.batch;
    if (!batch) return;
    switch (part) {
      case SCENE_PART.BACKGROUND:
        this.drawBackdrop();
        this.drawGradients(GRADIENT_SLOT.BACKGROUND);
        return;
      case SCENE_PART.MIDDLEGROUND:
        this.drawMiddleground();
        this.drawGradients(GRADIENT_SLOT.MIDDLEGROUND);
        return;
      case SCENE_PART.STREAK:
        // The streak at −3, then what of B1 lies over it: the objects' own
        // particle systems (−2 to 4) and B1's gradients (38, give or take
        // their z order). No band edge falls between −3 and 38, so they
        // always go together.
        // [GJBaseGameLayer::claimParticle :431656-431700; triggerGradientCommand
        //  :436394-436486 (added to the object layer, the containers' parent,
        //  at maxZOrderForShaderZ plus its z order held to ±5)]
        this.drawBands(this.frameSeconds + this.afterlife);
        drawParticleRuns(this.frameOverlay, B1_SLOT, OBJECT_Z.STREAK, this.drawRun, this.frameWaves);
        this.drawGradients(GRADIENT_SLOT.BEHIND + B1_SLOT);
        return;
      case SCENE_PART.PARTICLES_UNDER:
        batch.draw(this.playerParticles.data, this.frameUnder);
        return;
      case SCENE_PART.PLAYER:
        // The Ghost Trail's copies at 58, then the player at 59. No band edge
        // falls between them, so the copies always go with the player.
        this.drawGhosts(this.frameSeconds + this.afterlife);
        this.drawPlayer(this.frameAlpha);
        return;
      case SCENE_PART.PARTICLES_OVER:
        batch.draw(this.playerParticles.data, this.frameParticles - this.frameUnder, this.frameUnder);
        this.drawGradients(GRADIENT_SLOT.PLAYER);
        return;
      case SCENE_PART.GROUND:
        this.drawGround();
        this.drawGradients(GRADIENT_SLOT.GROUND);
        return;
      default: {
        const slot = layerOfPart(part);
        this.drawLayer(slot);
        // B1's gradients go over the streak, with its last particle systems.
        if (slot >= 0 && slot !== B1_SLOT) {
          this.drawGradients(slot < LAYERS_BEHIND ? GRADIENT_SLOT.BEHIND + slot : GRADIENT_SLOT.FRONT + slot - LAYERS_BEHIND);
        }
      }
    }
  }

  /**
   * One batch layer: the level's sprites in it batch by batch, with its
   * particle systems between them at their own z (drawLayerRuns). B1's from
   * the streak up wait for the streak (drawPart).
   */
  private drawLayer(slot: number): void {
    const list = this.list;
    if (!this.batch || !list || !this.frameData || slot < 0) return;
    drawLayerRuns(list, this.frameOverlay, slot, this.drawRun, slot === B1_SLOT ? OBJECT_Z.STREAK : undefined, this.frameWaves);
  }

  /** Draws one run of this frame's sprites (0), particles (1) or circles (2); made once, as it runs nine times a frame. */
  private readonly drawRun = (buffer: 0 | 1 | 2, count: number, start: number): void => {
    const data = buffer === 0 ? this.frameData : buffer === 1 ? this.frameCustom : this.waves.buffer;
    if (data && this.batch) this.batch.draw(data, count, start);
  };

  /**
   * Moves the draw on to the side of the band the next part falls on.
   * sceneOrder sorts the parts by side, so the sides only ever go forward —
   * below, in, above; a band nothing falls in is skipped.
   */
  private moveTo(side: BandSide): void {
    const st = this.split;
    if (!st) return;
    const want = side + 1;
    if (want <= this.phase) return;
    if (this.phase === 0 && want === 1) {
      this.openBand(st);
      return;
    }
    if (this.phase === 1) this.closeBand();
    this.phase = want;
  }

  private openBand(st: ShaderState): void {
    const band = this.band;
    const size = this.gl.dimensions;
    // A band that holds the background is opaque; any other starts empty.
    const opaque = st.layerMin <= 1;
    const bg = this.background;
    if (!band || !this.batch || !band.begin(size.width, size.height, opaque ? bg.r : 0, opaque ? bg.g : 0, opaque ? bg.b : 0, opaque ? 1 : 0)) {
      // Nothing to draw into: go on drawing the scene as it is.
      this.split = null;
      return;
    }
    this.batch.bandAlpha = !opaque;
    this.phase = 1;
  }

  private closeBand(): void {
    const st = this.split;
    const band = this.band;
    this.phase = 2;
    if (!st || !band || !this.batch) return;
    band.end();
    this.batch.bandAlpha = false;
    const size = this.gl.dimensions;
    const bs = this.bandScene;
    bs.width = size.width;
    bs.height = size.height;
    bs.zoom = this.camera.zoomAt(this.frameAlpha);
    band.composite(bandUniforms(st, bs, this.uniforms), st.layerMin <= 1);
    this.batch.resume();
    // The composite took the scratch unit, which the second font page may
    // be on.
    this.bindLevelPages();
  }

  /**
   * Where a shader target is on screen, 0..1 from the bottom left: player 1
   * for -1, player 2 for -2 (player 1 when there is none), a group's main
   * object for a group. [GJBaseGameLayer::positionForShaderTarget
   * :424325-424361]
   */
  private targetOnScreen(target: number, out: [number, number]): boolean {
    const sim = this.sim;
    const triggers = this.live?.triggers;
    let x: number;
    let y: number;
    if (target === -1 || target === -2) {
      if (!sim) return false;
      const p = target === -2 && sim.state2 ? sim.state2 : this.interpolated(sim.state, this.frameAlpha);
      x = p.x;
      y = p.y;
    } else if (target > 0 && triggers) {
      const main = triggers.mainObjectOf(target);
      if (main < 0) return false;
      [x, y] = triggers.objectPosition(main);
    } else {
      return false;
    }
    this.viewPoint(x, y, out);
    return true;
  }

  /** The alpha the last frame was drawn at: how far it fell between the last two ticks. */
  get drawnAlpha(): number {
    return this.frameAlpha;
  }

  /**
   * Where a world point is in the frame last drawn, 0..1 from the bottom
   * left: through that frame's centre, shake, turn and size, so whatever is
   * placed there moves exactly with the level.
   */
  viewPoint(x: number, y: number, out: [number, number]): void {
    const [dx, dy] = turnPoint(x - this.frameCentreX, y - this.frameCentreY, this.frameTurn);
    out[0] = dx / this.camera.unitsWideAt(this.frameAlpha) + 0.5;
    out[1] = dy / this.camera.unitsHighAt(this.frameAlpha) + 0.5;
  }

  /**
   * The font page and the interface's packed page, bound here rather than
   * trusted: the interface binds them too but draws after this does, so last
   * frame's binding is all there would be.
   */
  private bindLevelPages(): void {
    const gl2 = this.gl.gl;
    if (this.font && this.fontTexture) {
      gl2.activeTexture(gl2.TEXTURE0 + this.font.unit);
      gl2.bindTexture(gl2.TEXTURE_2D, this.fontTexture);
    }
    if (this.effects && this.effectsTexture) {
      gl2.activeTexture(gl2.TEXTURE0 + this.effects.unit);
      gl2.bindTexture(gl2.TEXTURE_2D, this.effectsTexture);
    }
  }

  /** The sky. */
  private drawBackdrop(): void {
    if (!this.scenery || !this.colors || !this.batch) return;
    const n = this.scenery.buildBackground(this.camera, this.colors, this.backgroundDrift, this.frameAlpha);
    this.batch.draw(this.scenery.data, n);
  }

  /**
   * The middleground, over the sky and under the level. Its two images take
   * turns on one unit, so each is bound immediately before its pass.
   */
  private drawMiddleground(): void {
    if (!this.scenery || !this.colors || !this.batch) return;
    if (this.live?.triggers.visual.options.hideMiddleground) return;
    const gl2 = this.gl.gl;
    for (const pass of this.scenery.middlegroundPasses) {
      const offset = this.live?.triggers.camera.mgOffsetY ?? 0;
      const count = this.scenery.buildMiddleground(this.camera, this.colors, pass.detail, this.middlegroundDrift, offset, this.frameAlpha);
      if (count === 0) continue;
      gl2.activeTexture(gl2.TEXTURE0 + UPLOAD_UNIT);
      gl2.bindTexture(gl2.TEXTURE_2D, pass.texture);
      this.batch.draw(this.scenery.data, count);
    }
  }

  /** The ground and, when the mode has one, the ceiling. */
  private drawGround(): void {
    if (!this.scenery || !this.colors || !this.batch) return;
    if (this.live?.triggers.visual.options.hideGround) return;
    // The corridor's ground layers, where they stand on the screen: a flying
    // corridor can sit above the ground, and its layers slide in from the
    // screen's edges and stay centred on it, so the art can lead the band
    // while the camera makes its way to the corridor.
    const sim = this.sim;
    const art = sim ? corridorArt(this.camera, sim.corridorHeight, sim.corridorSlide, this.frameAlpha) : { floor: 0, ceiling: null };
    const n = this.scenery.buildGround(this.camera, this.colors, art.floor, this.frameAlpha);
    this.batch.draw(this.scenery.data, n);
    // The corridor's ceiling, when it is on the screen. Drawn with the ground
    // and for the same reason: it is what hides everything above the play
    // area, and the option that hides one hides both.
    const ceiling = art.ceiling ?? Number.POSITIVE_INFINITY;
    const c = this.scenery.buildCeiling(this.camera, this.colors, ceiling, this.frameAlpha);
    if (c > 0) this.batch.draw(this.scenery.data, c);
  }

  /**
   * Bakes the circles. The object layer's are drawn among its batches by z,
   * between the particle systems' runs (frameWaves); the game layer's over
   * the whole level once it is drawn. The circles are drawn on the flat white
   * square, whose page the effects art binds; without it they are not
   * drawn. A ring's line is so many pixels of the target wide, whatever the
   * zoom.
   */
  private buildWaves(view: { x0: number; y0: number; x1: number; y1: number }, alpha: number): void {
    this.frameWaves = null;
    const white = this.effects?.quad(EFFECT_FRAMES.white);
    if (!white || !this.sim || this.waves.size === 0) {
      this.waves.clearBuild();
      return;
    }
    const scene = this.waveScene;
    scene.view = view;
    const wide = this.camera.unitsWideAt(alpha);
    scene.unitsPerPixel = wide / Math.max(1, this.gl.dimensions.width);
    scene.zoom = this.camera.zoomAt(alpha);
    this.waveScreenWide = wide * scene.zoom;
    this.waveScreenHigh = this.camera.unitsHighAt(alpha) * scene.zoom;
    this.waveAlpha = alpha;
    this.waves.build(white, scene);
    if (this.waves.runs > 0) this.frameWaves = this.waves;
  }

  /** The frame alpha the circles that follow a player are placed at. */
  private waveAlpha = 1;
  /** The screen's size in the game layer's units this frame. */
  private waveScreenWide = 1;
  private waveScreenHigh = 1;
  /** Where an object is, for the circles; one pair, refilled per call. */
  private readonly wavePoint: [number, number] = [0, 0];
  /** Where the circles' followed things are this frame; one object, refilled per frame. */
  private readonly waveScene: WaveScene = {
    objectPosition: (i) => {
      const p = this.wavePoint;
      if (this.sim) this.sim.triggers.objectPositionTo(i, p);
      else p[0] = p[1] = 0;
      return p;
    },
    playerPosition: (which) => {
      const sim = this.sim;
      if (!sim) return null;
      return which === 1 ? this.interpolated(sim.state, this.waveAlpha) : sim.state2;
    },
    // The batch draws d = R(world − centre) × zoom about the screen's centre
    // (spriteBatch's vertex shader, R the turn clockwise), the shake in the
    // centre; this is that undone.
    screenToLevel: (sx, sy, out) => {
      const zoom = this.waveScene.zoom;
      const dx = (sx - this.waveScreenWide / 2) / zoom;
      const dy = (sy - this.waveScreenHigh / 2) / zoom;
      const r = (this.frameTurn * Math.PI) / 180;
      const c = Math.cos(r);
      const sn = Math.sin(r);
      out[0] = this.frameCentreX + dx * c - dy * sn;
      out[1] = this.frameCentreY + dx * sn + dy * c;
    },
    zoom: 1,
    unitsPerPixel: 1,
    view: { x0: 0, y0: 0, x1: 0, y1: 0 },
  };

  /**
   * The level's own particle systems, stepped and baked in z order: the
   * buffer, whose runs `particles.runZ`, `runStart` and `runCount` give, or
   * null for a level with none.
   */
  private stepCustomParticles(view: { x0: number; y0: number; x1: number; y1: number }, seconds: number): Float32Array | null {
    const field = this.particles;
    if (!field) return null;
    const triggers = this.live?.triggers;
    const list = this.list;
    return field.update(this.lastDelta, view, {
      levelTime: seconds,
      colors: this.colors,
      animationsOf: (i) => triggers?.animationsOf(i) ?? 0,
      objectTransform: (i, out) => triggers?.objectTransform(i, out) ?? false,
      objectDisabled: (i) => (triggers ? triggers.hasToggles && triggers.objectDisabled(i) : false),
      // What this frame's gather showed each object at, so its own system
      // starts and stops with it.
      objectFade: list ? (i) => list.objectFade(i) : undefined,
      groupAlphaOf: triggers ? (g) => triggers.groupAlphaOf(g) : undefined,
    }).data;
  }

  /**
   * The wave's bands, at the streak's z (−3), drawn under the player so it is
   * never hidden by its own trail; player 1's first, as it was built first.
   * Each wears its player's colour 1 as chosen, set when the player is built,
   * so a colour trigger on P1 changes neither. The game's "Switch Wave Trail
   * Color" option (0096) gives the band the strengthened colour 2 instead;
   * the port has no such option. [gdp PlayerObject::setupStreak
   *  :160808-160811 (z -3); updateGlowColor :146213-146224 (the band's
   *  colour read off the icon :146100-146105); 0096 at :162175-162176]
   */
  private drawBands(seconds: number): void {
    const art = this.effects;
    const sim = this.sim;
    if (!art || !this.batch || !sim) return;
    const quad = art.quad(EFFECT_FRAMES.white);
    if (!quad) return;
    const heads = [this.interpolated(sim.state, this.frameAlpha), sim.state2] as const;
    for (let i = 0; i < 2; i++) {
      const band = this.bands[i];
      if (band.empty) continue;
      const head = heads[i];
      const n = band.build(quad, seconds, this.pulse, head ? { x: head.x, y: head.y } : undefined);
      if (n > 0) this.batch.draw(band.data, n);
    }
  }

  /**
   * The Ghost Trail's copies. Each goes into the object layer one under the
   * player's own z of 59 — z 58, over B1 with its particle systems and
   * gradients, the particles under the player and the dash sprite, and just
   * under the player (OBJECT_Z). [GhostTrailEffect::trailSnapshot
   *  :59230-59233, :59276-59281 (the PlayerObject's z − 1);
   *  GJBaseGameLayer::createPlayer :417928-417931 (z 59)]
   */
  private drawGhosts(seconds: number): void {
    if (!this.batch || !this.player.ready) return;
    const n = this.ghosts.build(seconds, this.player);
    if (n > 0) this.batch.draw(this.ghosts.data, n);
  }

  /**
   * The dust, the landing puff, the exhaust and the dash spray, stepped and
   * baked: how many instances there are, `playerParticles.underCount` of them
   * drawn under the player and the rest over it.
   */
  private stepPlayerParticles(alpha: number): number {
    const sim = this.sim;
    if (!sim || !this.playerParticles.ready) return 0;
    const visual = this.live?.triggers.visual;
    if (visual?.hidePlayer || visual?.options.hidePlayer1) return 0;
    if (!this.particlesEnabled) return 0;
    const state = this.interpolated(sim.state, alpha);
    return this.playerParticles.update(state, this.lastDelta, state.flipped);
  }

  /**
   * The player, at its own z among the object layer's children: over B1 and
   * its streak, under T1 to T4, and under the ground, which the game draws
   * over the whole object layer. [gdp GJBaseGameLayer::createPlayer
   * :417925-417928 (z 59); createGroundLayer :418297-418309]
   */
  private drawPlayer(alpha: number): void {
    const sim = this.sim;
    if (!sim || !this.batch || !this.player.ready) return;
    if (this.live?.triggers.visual.hidePlayer) return;
    const state = this.interpolated(sim.state, alpha);
    const second = sim.state2;
    // Every frame, not only when the mode changes. The menus and the icon kit
    // bind their own pages into the same two units, and a level that only
    // looked on a mode change never took them back: the main menu's running
    // cube, still alive under the level, kept swapping in a random icon's page
    // and the player drew nothing for seconds at a time. When the right pages
    // are already bound this returns at once.
    this.bindUploaded(this.playerPages(state.mode, second ? second.mode : null));
    // The icon wears the colours as chosen, not the level's P1 and P2, which
    // are strengthened copies; only its outline is strengthened, which the
    // renderer works out from the pair. [gdp createPlayer :417905-417930]
    const colours = this.colors;
    const p1 = colours ? colours.iconColour(1) : { r: 0, g: 255, b: 119 };
    const p2 = colours ? colours.iconColour(2) : { r: 0, g: 187, b: 255 };
    const seconds = sim.tick / TICK_RATE;
    const options = this.live?.triggers.visual.options;
    if (!options?.hidePlayer1) {
      const n = this.player.build(state, p1, p2, seconds);
      if (n > 0) this.batch.draw(this.player.data, n);
    }
    if (second && !options?.hidePlayer2) {
      // Player 2 wears the same icons with the two colours the other way round:
      // its first colour is the player's second and its second the first. The
      // game builds it from the same two lookups in the opposite order.
      // [gdp GJBaseGameLayer's player setup, gd-ida-decomp.cpp:417905-417918
      //  for player 1 and :417963-417976 for player 2]
      const n = this.player.build(second, p2, p1, seconds);
      if (n > 0) this.batch.draw(this.player.data, n);
    }
  }

  /**
   * The player as it looks part-way between the last two ticks. Only the three
   * fields that move are blended; everything else is this tick's, because a
   * mode or a flip is a step change rather than something to slide through.
   */
  private readonly lerpedState = { } as PlayerState;

  private interpolated(state: PlayerState, alpha: number): PlayerState {
    if (alpha >= 1 || !this.prevPose.has) return state;
    Object.assign(this.lerpedState, state);
    this.lerpedState.x = lerp(this.prevPose.x, this.pose.x, alpha);
    this.lerpedState.y = lerp(this.prevPose.y, this.pose.y, alpha);
    this.lerpedState.rotation = lerpAngle(this.prevPose.rotation, this.pose.rotation, alpha);
    return this.lerpedState;
  }

  /** Background colour, so the page can clear to it before the first frame. */
  get backgroundColor(): { r: number; g: number; b: number } {
    return this.background;
  }

  /** One line for the debug HUD. */
  describe(): string {
    if (!this.list || !this.colors) return "no level";
    const cycles = this.colors.cycles.length;
    const shader = this.live?.triggers.visual.shader;
    return [
      `${this.stats.sprites.toLocaleString()} of ${this.list.count.toLocaleString()} sprites  ${this.stats.drawCalls} draw call${this.stats.drawCalls === 1 ? "" : "s"}`,
      `gather ${this.stats.gatherMs.toFixed(2)} ms  build ${this.stats.buildMs.toFixed(0)} ms  ${this.list.stats.dynamic} movable  ${this.list.stats.animated} animated  ${this.list.stats.spinning} turning  ${this.list.stats.hidden} hidden  ${this.list.stats.skeletons} beasts  ${this.list.stats.texts} texts`,
      this.particles && this.particles.emitterCount > 0
        ? `${this.particles.particleCount} particles from ${this.particles.emitterCount} emitters`
        : "",
      `bg ${describeChannel(this.colors.get(CHANNEL.BG))}  obj ${describeChannel(this.colors.get(CHANNEL.OBJECT))}`,
      this.live ? this.live.triggers.describe() : "",
      shader && shaderActive(shader) ? `screen effects on ${layerName(shader.layerMin)} to ${layerName(shader.layerMax)}` : "",
      cycles > 0 ? `${cycles} colour channel(s) copy in a loop` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/** The icon colours a scene with no colour table falls back on: the game's defaults. */
const DEFAULT_ICON_1: Rgb = { r: 0, g: 255, b: 119 };
const DEFAULT_ICON_2: Rgb = { r: 0, g: 187, b: 255 };
const WHITE_RGB: Rgb = { r: 255, g: 255, b: 255 };

function isBlack(c: Rgb): boolean {
  return c.r === 0 && c.g === 0 && c.b === 0;
}

/** A draw layer's name as the editor shows it: BG, MG, B5 … T4, G, UI, Max. */
function layerName(layer: number): string {
  for (const [name, n] of Object.entries(SHADER_LAYER)) if (n === layer) return name === "MAX" ? "Max" : name;
  return String(layer);
}

/** Whether two short page lists name the same pages in the same order. */
function samePages(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
