// Screen effects: the band of the scene the shader triggers reach, drawn
// through the game's own shader.
//
// The game does not put its effects over the finished frame. The setup
// trigger names a range of draw layers, and only that band of the scene is
// rendered into a texture and drawn back through the effect shader; what lies
// below the band is drawn first as it is, and what lies above it after. A band
// that holds the background covers the whole screen; any other is laid over
// what is below it, and a texel nothing in the band touched stays transparent
// however the colours are turned — which is how an invert of the player layer
// inverts the player and nothing else. The trigger state and the band tests
// are in src/triggers/shaderState.ts; the scene decides what goes where.
//
// The shader is the game's, word for word: one uber-shader that runs every
// effect in a fixed order, shipped out of the exe by the asset build
// (tools/assets/shaders.ts) and turned from GLSL ES 1.00 into 3.00 here.
// [gdp ShaderLayer::setupShader :659230-659380, ShaderLayer::visit
//  :659488-659560, performCalculations :659572-659605]
//
// The shader is built as the game loads, so the first effect does not stall
// its frame; the framebuffer waits until a level asks for it. With no effect
// on, the scene draws straight to the screen.

import type { GlContext } from "../engine/gl/context";
import { Program } from "../engine/gl/program";
import { UPLOAD_UNIT } from "../engine/gl/spriteBatch";
import { fetchAsset } from "../assets/paths";
import type { ShaderLayerFile } from "../assets/miscTypes";
import { designSize } from "../ui/viewport";
import { turnPoint } from "./camera";
import { colourUniforms, newColourUniforms, TWEEN, type ColourUniforms, type ShaderState } from "../triggers/shaderState";

/**
 * The game's GLSL ES 1.00 as WebGL2 wants it: the version line, `in` for
 * `varying`, `texture` for `texture2D`, and an output of its own for
 * `gl_FragColor`, declared after the precision statement because a fragment
 * shader has no default float precision to declare it with before.
 */
export function toGlsl300(source: string): string {
  const input = /\bvarying\s+vec2\s+v_texCoord\s*;/;
  if (!input.test(source)) throw new Error("the screen-effect shader does not read v_texCoord");
  const body = source
    .replace(input, "in vec2 v_texCoord;\nout vec4 fragColor;")
    .replace(/\bvarying\b/g, "in")
    .replace(/\btexture2D\s*\(/g, "texture(")
    .replace(/\bgl_FragColor\b/g, "fragColor");
  return `#version 300 es\n${body}`;
}

const VERTEX = `#version 300 es
// One triangle covering the screen, built from the vertex id: no buffers.
// v_texCoord runs 0..1 bottom to top, as the game's flipped render-texture
// sprite gives it.
out vec2 v_texCoord;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_texCoord = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** sqrt(960² + 640²) / 960: the 2.2074 build's chromatic divisor, which is also 1 / 0.83205. [exe VA 0x1400072a0] */
const G = Math.hypot(960, 640) / 960;
/** The design width screenScaleFactorW divides by. [CCDirector::updateScreenScale :801122-801165] */
const DESIGN_WIDTH = 480;
/** f[250] in the pre-passes: 1/G, so chromatic's f[250]/points.width matches. */
const SCREEN_SCALE = 1 / G;

/** Everything the band pass sets, beyond the colour effects. */
export interface BandUniforms extends ColourUniforms {
  /** Height over width of the frame. [exe VA 0x1404882c6-0x140488315] */
  screenAspect: number;
  textureScale: [number, number];
  textureScaleInv: [number, number];
  chromaticX: number;
  chromaticY: number;
  lensStrength: number;
  lensStart: number;
  lensEnd: number;
  lensOrigin: [number, number];
  lensTint: [number, number, number];
  lensAdditive: boolean;
  blurUseRef: boolean;
  blurRefColor: [number, number, number];
  blurIntensity: number;
  blurFade: number;
  blurOnlyEmpty: boolean;
  shockWaveTime: number;
  shockWaveTime1: number;
  shockWaveTime2: number;
  shockWaveTime3: number;
  shockWaveTime4: number;
  shockWaveStrength: number;
  shockWaveWaves: number;
  shockWaveCenter: [number, number];
  shockWaveInvert: boolean;
  shockWaveMinSize: number;
  shockWaveMaxSize: number;
  shockWaveMaxDistVal: number;
  shockLineTime: number;
  shockLineTime1: number;
  shockLineTime2: number;
  shockLineTime3: number;
  shockLineTime4: number;
  shockLineAxis: boolean;
  shockLineDirection: boolean;
  shockLineDual: boolean;
  shockLineWaves: number;
  shockLineStrength: [number, number];
  shockLineCenter: number;
  shockLineMaxDistVal: number;
  glitchBot: number;
  glitchTop: number;
  glitchXOffset: number;
  glitchColOffset: [number, number];
  glitchRnd: number;
  cGTime: number;
  cGRGBOffset: number;
  cGYOffset: number;
  cGStrength: number;
  cGHeight: number;
  cGLineStrength: number;
  cGLineThick: number;
  bulgeOrigin: [number, number];
  bulgeValue: number;
  bulgeValue2: number;
  bulgeRadius: number;
  pinchCenter: [number, number];
  pinchValue: [number, number];
  pinchCalc: [number, number];
  pinchRadius: number;
  radialBlurCenter: [number, number];
  radialBlurValue: number;
  motionBlurValue: [number, number];
  motionBlurMult: number;
  motionBlurDual: boolean;
  rowmod: number;
  colmod: number;
  rowmodCalc: number;
  colmodCalc: number;
  splitXStart: number;
  splitXRange: number;
  splitXRangeMult: number;
  splitYStart: number;
  splitYRange: number;
  splitYRangeMult: number;
}

export function newBandUniforms(): BandUniforms {
  return {
    ...newColourUniforms(),
    screenAspect: 9 / 16,
    textureScale: [1, 1],
    textureScaleInv: [1, 1],
    chromaticX: 0,
    chromaticY: 0,
    lensStrength: 0,
    lensStart: 0,
    lensEnd: 0,
    lensOrigin: [0.5, 0.28125],
    lensTint: [0, 0, 0],
    lensAdditive: false,
    blurUseRef: false,
    blurRefColor: [0, 0, 0],
    blurIntensity: 1,
    blurFade: 0,
    blurOnlyEmpty: false,
    shockWaveTime: 0,
    shockWaveTime1: 0,
    shockWaveTime2: 0,
    shockWaveTime3: 0,
    shockWaveTime4: 0,
    shockWaveStrength: 0,
    shockWaveWaves: 0,
    shockWaveCenter: [0.5, 0.28125],
    shockWaveInvert: false,
    shockWaveMinSize: 0,
    shockWaveMaxSize: 0,
    shockWaveMaxDistVal: 0,
    shockLineTime: 0,
    shockLineTime1: 0,
    shockLineTime2: 0,
    shockLineTime3: 0,
    shockLineTime4: 0,
    shockLineAxis: false,
    shockLineDirection: false,
    shockLineDual: false,
    shockLineWaves: 0,
    shockLineStrength: [0, 0],
    shockLineCenter: 0.5,
    shockLineMaxDistVal: 0,
    glitchBot: 0,
    glitchTop: 0,
    glitchXOffset: 0,
    glitchColOffset: [0, 0],
    glitchRnd: 0,
    cGTime: 0,
    cGRGBOffset: 0,
    cGYOffset: 0,
    cGStrength: 0,
    cGHeight: 1,
    cGLineStrength: 0,
    cGLineThick: 0,
    bulgeOrigin: [0.5, 0.28125],
    bulgeValue: 0,
    bulgeValue2: 0,
    bulgeRadius: 0,
    pinchCenter: [0.5, 0.28125],
    pinchValue: [0, 0],
    pinchCalc: [0, 0],
    pinchRadius: 0,
    radialBlurCenter: [0.5, 0.28125],
    radialBlurValue: 0,
    motionBlurValue: [0, 0],
    motionBlurMult: 1,
    motionBlurDual: false,
    rowmod: 1,
    colmod: 1,
    rowmodCalc: 0,
    colmodCalc: 0,
    splitXStart: 0,
    splitXRange: 1,
    splitXRangeMult: 1,
    splitYStart: 0,
    splitYRange: 1,
    splitYRangeMult: 1,
  };
}

/** What the uniforms need from the scene around the layer. */
export interface BandScene {
  /** The frame in device pixels. */
  width: number;
  height: number;
  /** The camera's zoom, which the "relative" switches scale by. */
  zoom: number;
  /**
   * The camera's turn this frame, in degrees clockwise. Follow centres and
   * fixed offsets turn about the screen middle by this, as
   * ShaderLayer::updateEffectOffsets does with the saved camera rotation.
   * [rotatePoint :656586-656608, updateEffectOffsets :656738-656756]
   */
  angle: number;
  /** A channel's colour as it stands now, 0..255, and whether it blends. */
  colourOf(channel: number): { r: number; g: number; b: number; blending?: boolean };
  /**
   * Where a shader target (-1 player 1, -2 player 2, a group) is on screen,
   * 0..1 from the bottom left with the view unturned, or false for one that
   * is not there. The band turns that point about the screen middle by
   * {@link BandScene.angle}.
   * [GJBaseGameLayer::positionForShaderTarget :424325-424361 →
   *  ShaderLayer::objectPosToShaderPos :656553-656570]
   */
  targetOnScreen(target: number, out: [number, number]): boolean;
}

const scratchPoint: [number, number] = [0, 0];

/**
 * Turn a centre in width-units about the screen middle by the camera's angle,
 * clockwise, matching how the level is drawn into the band.
 * [rotatePoint :656586-656608 — the game's formula with the sign the sprite
 *  shader uses for Camera Rotate]
 */
function turnCentre(x: number, y: number, angle: number, aspect: number, out: [number, number]): void {
  const midY = 0.5 * aspect;
  if (angle === 0) {
    out[0] = x;
    out[1] = y;
    return;
  }
  const [dx, dy] = turnPoint(x - 0.5, y - midY, angle);
  out[0] = dx + 0.5;
  out[1] = dy + midY;
}

/** Centre from keys 290/291 (−1..1), or a follow target when one is on screen. */
function centreOf(
  follow: boolean,
  target: number,
  x: number,
  y: number,
  aspect: number,
  scene: BandScene,
  out: [number, number],
): void {
  if (follow && target !== 0 && scene.targetOnScreen(target, scratchPoint)) {
    turnCentre(scratchPoint[0], scratchPoint[1] * aspect, scene.angle, aspect, out);
  } else {
    turnCentre(0.5 + 0.5 * x, (0.5 + 0.5 * y) * aspect, scene.angle, aspect, out);
  }
}

/** The game's random2d used by the glitch. [random2d :656409-656416] */
function random2d(x: number, y: number): number {
  const n = Math.sin(x * 12.99 + y * 4.1414) * 43758.5453;
  return n - Math.floor(n);
}

function randomRange(x: number, y: number, lo: number, hi: number): number {
  return lo + random2d(x, y) * (hi - lo);
}

/**
 * The band's uniforms from the layer's values. Lengths are the 2.2074 build's:
 * the chromatic offset is its value in points over G, and the lens circle's
 * radius its size times G / screenScaleFactorW in screen widths, the frame
 * being one screen wide and `screenAspect` high. Distortion pre-passes are
 * the 2.206 arithmetic with the same G scale the chromatic uses.
 * [2.2074 exe: chromatic VA 0x1404883b9-0x14048842d, lens 0x1404868f1-0x1404869a0;
 *  preShockWaveShader :657279-657423, preShockLineShader :657511-657656,
 *  preGlitchShader :657705-657788, preChromaticGlitchShader :657917-658009,
 *  preRadialBlurShader :658462-658505, preMotionBlurShader :658550-658652,
 *  updateEffectOffsets :656624-657191, preSplitScreenShader :659394-659471]
 */
export function bandUniforms(st: ShaderState, scene: BandScene, out: BandUniforms = newBandUniforms()): BandUniforms {
  colourUniforms(st, scene.colourOf, out);
  const v = st.v;
  const s = st.s;
  const w = Math.max(1, scene.width);
  const h = Math.max(1, scene.height);
  const aspect = h / w;
  out.screenAspect = aspect;
  const points = designSize(w / h);
  const zoom = Math.abs(scene.zoom);

  // Pixelate: the render-texture scale the game writes into f[100]/f[101].
  // [prePixelateShader :658048-658117]
  const px = Math.max(1, v[TWEEN.PIXELATE_X]);
  const py = Math.max(1, v[TWEEN.PIXELATE_Y]);
  const pixelating = px > 1 || py > 1;
  const pr = s.pixelateRelative && pixelating ? zoom : 1;
  const texX = pixelating ? px * pr : 1;
  const texY = pixelating ? py * pr : 1;
  out.textureScale[0] = texX;
  out.textureScale[1] = texY;
  out.textureScaleInv[0] = 1 / texX;
  out.textureScaleInv[1] = 1 / texY;
  const texMin = Math.min(out.textureScaleInv[0], out.textureScaleInv[1]);

  const cr = s.chromaticRelative ? zoom : 1;
  out.chromaticX = (v[TWEEN.CHROMATIC_X] / (G * points.width)) * cr * out.textureScaleInv[0];
  out.chromaticY = (v[TWEEN.CHROMATIC_Y] / (G * points.height)) * cr * out.textureScaleInv[1];

  out.lensStrength = v[TWEEN.LENS_STRENGTH] > 0 ? v[TWEEN.LENS_STRENGTH] : 0;
  const lr = s.lensRelative ? zoom : 1;
  const unit = G / (points.width / DESIGN_WIDTH);
  const end = lr * v[TWEEN.LENS_SIZE] * unit;
  out.lensStart = Math.max(0, end - Math.max(0, v[TWEEN.LENS_FADE]));
  out.lensEnd = Math.max(0, end);
  if (s.lensTarget !== 0 && scene.targetOnScreen(s.lensTarget, scratchPoint)) {
    turnCentre(scratchPoint[0], scratchPoint[1] * aspect, scene.angle, aspect, out.lensOrigin);
  } else {
    turnCentre(0.5 + 0.5 * v[TWEEN.LENS_X], (0.5 + 0.5 * v[TWEEN.LENS_Y]) * aspect, scene.angle, aspect, out.lensOrigin);
  }
  if (s.lensTint > 0) {
    const c = scene.colourOf(s.lensTint);
    out.lensTint[0] = c.r / 255;
    out.lensTint[1] = c.g / 255;
    out.lensTint[2] = c.b / 255;
    out.lensAdditive = c.blending === true;
  } else {
    out.lensTint[0] = out.lensTint[1] = out.lensTint[2] = 0;
    out.lensAdditive = false;
  }

  const ref = scene.colourOf(s.blurRefChannel > 0 ? s.blurRefChannel : 1000);
  out.blurRefColor[0] = ref.r / 255;
  out.blurRefColor[1] = ref.g / 255;
  out.blurRefColor[2] = ref.b / 255;
  out.blurUseRef = st.layerMin > 1;
  out.blurIntensity = v[TWEEN.BLUR_INTENSITY] + 1;
  out.blurOnlyEmpty = st.layerMin > 1 && s.blurOnlyEmpty;
  out.blurFade = 0;

  // --- shock wave -----------------------------------------------------------
  if (s.shockWaveStart > 0 && v[TWEEN.SW_STRENGTH] > 0) {
    const thick = v[TWEEN.SW_THICK];
    const thickScale = thick > 0.001 ? thick * 0.2 : 0.0002;
    const phase = s.shockWavePhase + v[TWEEN.SW_OFFSET] * 0.1;
    const ringScale = s.shockWaveInvert ? 1 : phase;
    const t2 = phase * ringScale - thickScale * v[TWEEN.SW_FADE_IN];
    let t1 = t2 - thickScale;
    if (t2 <= t1) t1 = t2;
    let t3 = t1 - thickScale * v[TWEEN.SW_FADE_OUT];
    if (t1 <= t3) t3 = t1;
    const waves = v[TWEEN.SW_WAVES];
    const waveMul = waves > 0.001 ? 22 / waves : 22000;
    const scale = (s.shockWaveRelative ? zoom : 1) * SCREEN_SCALE;
    out.shockWaveTime = phase * waveMul;
    out.shockWaveTime1 = (t2 + thickScale * v[TWEEN.SW_FADE_IN] + 0.001) * scale;
    out.shockWaveTime2 = t2 * scale;
    out.shockWaveTime3 = (t1 + 0.001) * scale;
    out.shockWaveTime4 = t3 * scale;
    out.shockWaveStrength = v[TWEEN.SW_STRENGTH] * 0.1 * texMin * scale;
    out.shockWaveWaves = waveMul / scale;
    out.shockWaveInvert = s.shockWaveInvert;
    out.shockWaveMinSize = scale * v[TWEEN.SW_MIN] * 0.5;
    out.shockWaveMaxSize = scale * v[TWEEN.SW_MAX];
    out.shockWaveMaxDistVal = v[TWEEN.SW_DIST] === 0 ? 0 : 1 / (v[TWEEN.SW_DIST] * 0.5 * scale);
    centreOf(s.shockWaveFollow || s.shockWaveMoving, s.shockWaveTarget, v[TWEEN.SW_X], v[TWEEN.SW_Y], aspect, scene, out.shockWaveCenter);
  } else {
    out.shockWaveTime = 0;
  }

  // --- shock line -----------------------------------------------------------
  if (s.shockLineStart !== 0 && v[TWEEN.SL_STRENGTH] > 0) {
    const thick = v[TWEEN.SL_THICK];
    let thickScale = thick <= 0.001 ? 0.0002 : 0.2;
    if (thick > 0.001) thickScale = thick * thickScale;
    const fadeIn = thickScale * v[TWEEN.SL_FADE_IN];
    const fadeOut = thickScale * v[TWEEN.SL_FADE_OUT];
    let t = s.shockLinePhase + v[TWEEN.SL_OFFSET] * 0.1;
    if (s.shockLineInvert) {
      const span = (s.shockLineDual ? 0.5 : 1) * (thickScale + fadeIn + fadeOut);
      t = span - t;
    }
    const t2 = t - fadeIn;
    let t1 = t2 - thickScale;
    if (t2 <= t1) t1 = t2;
    let t3 = t1 - fadeOut;
    if (t1 <= t3) t3 = t1;
    const waves = v[TWEEN.SL_WAVES];
    const waveMul = waves > 0.001 ? 22 / waves : 22000;
    const scale = (s.shockLineRelative ? zoom : 1) * SCREEN_SCALE;
    out.shockLineTime = t * waveMul;
    out.shockLineTime1 = (t2 + fadeIn + 0.001) * scale;
    out.shockLineTime2 = t2 * scale;
    out.shockLineTime3 = (t1 + 0.001) * scale;
    out.shockLineTime4 = t3 * scale;
    const str = v[TWEEN.SL_STRENGTH] * 0.01 * scale;
    out.shockLineStrength[0] = str * out.textureScaleInv[0];
    out.shockLineStrength[1] = str * out.textureScaleInv[1];
    out.shockLineWaves = waveMul / scale;
    out.shockLineAxis = s.shockLineAxis;
    out.shockLineDirection = s.shockLineDirection;
    out.shockLineDual = s.shockLineDual;
    out.shockLineMaxDistVal = v[TWEEN.SL_DIST] === 0 ? 0 : 1 / (v[TWEEN.SL_DIST] * 0.5 * scale);
    if ((s.shockLineFollow || s.shockLineMoving) && s.shockLineTarget !== 0 && scene.targetOnScreen(s.shockLineTarget, scratchPoint)) {
      turnCentre(scratchPoint[0], scratchPoint[1] * aspect, scene.angle, aspect, scratchPoint);
      out.shockLineCenter = s.shockLineAxis ? scratchPoint[1] : scratchPoint[0];
    } else {
      // A line's fixed centre is one axis; turn it as a point on that axis through the middle.
      turnCentre(
        s.shockLineAxis ? 0.5 : 0.5 + 0.5 * v[TWEEN.SL_POS],
        s.shockLineAxis ? (0.5 + 0.5 * v[TWEEN.SL_POS]) * aspect : 0.5 * aspect,
        scene.angle,
        aspect,
        scratchPoint,
      );
      out.shockLineCenter = s.shockLineAxis ? scratchPoint[1] : scratchPoint[0];
    }
  } else {
    out.shockLineTime = 0;
  }

  // --- glitch ---------------------------------------------------------------
  if (v[TWEEN.GLITCH] > 0) {
    const scale = (s.glitchRelative ? zoom : 1) * SCREEN_SCALE;
    const seed = Math.floor(s.glitchSpeed * st.time * 20);
    const bot = random2d(seed, 2345) * out.textureScaleInv[1] * scale;
    const top =
      bot +
      random2d(seed, 9035) * s.glitchSlice * v[TWEEN.GLITCH] * out.textureScaleInv[1] * scale;
    const xOff = randomRange(seed, 9625, -(v[TWEEN.GLITCH] * s.glitchMaxOffset * 0.02 * out.textureScaleInv[1] * scale), v[TWEEN.GLITCH] * s.glitchMaxOffset * 0.02 * out.textureScaleInv[1] * scale);
    const colX = randomRange(seed, 9545, -(v[TWEEN.GLITCH] * s.glitchMaxColX * 0.02 * out.textureScaleInv[0] * scale), v[TWEEN.GLITCH] * s.glitchMaxColX * 0.02 * out.textureScaleInv[0] * scale);
    const colY = randomRange(seed, 7205, -(v[TWEEN.GLITCH] * s.glitchMaxColY * 0.02 * out.textureScaleInv[1] * scale), v[TWEEN.GLITCH] * s.glitchMaxColY * 0.02 * out.textureScaleInv[1] * scale);
    out.glitchBot = bot;
    out.glitchTop = top + Math.floor(top);
    out.glitchXOffset = xOff;
    out.glitchColOffset[0] = colX;
    out.glitchColOffset[1] = colY;
    out.glitchRnd = random2d(seed, 9545);
  } else {
    out.glitchTop = 0;
  }

  // --- chromatic glitch -----------------------------------------------------
  const cgDrawn = s.cgOn && (v[TWEEN.CG_RGB] !== 0 || v[TWEEN.CG_STRENGTH] !== 0 || v[TWEEN.CG_LINE_STRENGTH] !== 0);
  if (cgDrawn) {
    const scale = (s.cgRelative ? zoom : 1) * SCREEN_SCALE;
    let rgb = v[TWEEN.CG_RGB] * 0.1;
    if (rgb === 0) rgb = 0.001;
    let line = 1 - scale * v[TWEEN.CG_LINE_THICK] * 0.2;
    if (line <= 0.001) line = 0.001;
    if (v[TWEEN.CG_LINE_STRENGTH] === 0) line = 0;
    out.cGRGBOffset = rgb * 0.1 * out.textureScaleInv[0] * scale;
    out.cGTime = s.cgPhase;
    out.cGStrength = v[TWEEN.CG_STRENGTH] * 0.02 * out.textureScaleInv[0] * scale;
    out.cGHeight = v[TWEEN.CG_HEIGHT] / (scale * out.textureScaleInv[1]);
    out.cGLineThick = line;
    out.cGLineStrength = v[TWEEN.CG_LINE_STRENGTH] * 0.05;
    if (s.cgFollow && scene.targetOnScreen(-1, scratchPoint)) {
      turnCentre(scratchPoint[0], scratchPoint[1] * aspect, scene.angle, aspect, scratchPoint);
      out.cGYOffset = scratchPoint[1] * out.textureScaleInv[1];
    } else {
      turnCentre(0.5, 0.5 * aspect, scene.angle, aspect, scratchPoint);
      out.cGYOffset = scratchPoint[1] * out.textureScaleInv[1];
    }
  } else {
    out.cGRGBOffset = 0;
  }

  // --- radial / motion blur -------------------------------------------------
  if (v[TWEEN.RADIAL] !== 0) {
    out.radialBlurValue = v[TWEEN.RADIAL] * (1 / 9) * 0.2;
    let fade = v[TWEEN.BLUR_FADE] * 0.2;
    if (fade > 0.2) fade = 0.2;
    else if (fade < 0) fade = 0;
    out.blurFade = fade;
    centreOf(s.radialFollow, s.radialTarget, v[TWEEN.RADIAL_X], v[TWEEN.RADIAL_Y], aspect, scene, out.radialBlurCenter);
    out.radialBlurCenter[0] *= out.textureScale[0];
    out.radialBlurCenter[1] *= out.textureScale[1];
    out.motionBlurValue[0] = out.motionBlurValue[1] = 0;
  } else if (v[TWEEN.MOTION_X] !== 0 || v[TWEEN.MOTION_Y] !== 0) {
    out.radialBlurValue = 0;
    const mr = s.motionRelative ? zoom : 1;
    let sx = s.motionTargetX !== 0 ? 1 : 1;
    let sy = s.motionTargetY !== 0 ? 1 : 1;
    if (sx === 0) sx = 0.001;
    if (sy === 0) sy = 0.001;
    out.motionBlurValue[0] = sx * v[TWEEN.MOTION_X] * 0.1 * out.textureScaleInv[0] * mr * SCREEN_SCALE;
    out.motionBlurValue[1] = sy * v[TWEEN.MOTION_Y] * 0.1 * out.textureScaleInv[1] * mr * SCREEN_SCALE;
    const dual = s.motionDual;
    out.motionBlurDual = dual;
    const cap = dual ? 0.2 : 0.1;
    let fade = cap * v[TWEEN.BLUR_FADE];
    if (fade > cap) fade = cap;
    else if (fade < -cap) fade = -cap;
    out.blurFade = fade;
    out.motionBlurMult = 1 / (9 - (dual ? 20 : 36) * fade);
  } else {
    out.radialBlurValue = 0;
    out.motionBlurValue[0] = out.motionBlurValue[1] = 0;
    out.motionBlurMult = 1;
    out.motionBlurDual = false;
  }

  // --- bulge ----------------------------------------------------------------
  if (v[TWEEN.BULGE] > 0) {
    const scale = (s.bulgeRelative ? zoom : 1) * SCREEN_SCALE;
    centreOf(s.bulgeTarget !== 0, s.bulgeTarget, v[TWEEN.BULGE_X], v[TWEEN.BULGE_Y], aspect, scene, out.bulgeOrigin);
    const half = scale * 0.5;
    const rx = half;
    const ry = half / aspect;
    const r = Math.hypot(rx, ry);
    let value = ((Math.PI * 2) / (r + r)) * 0.45 * v[TWEEN.BULGE];
    if (value <= 0.001) value = 0.001;
    out.bulgeValue = value;
    out.bulgeValue2 = r / Math.tan(r * value);
    out.bulgeRadius = scale * v[TWEEN.BULGE_RADIUS];
  } else {
    out.bulgeValue = 0;
  }

  // --- pinch ----------------------------------------------------------------
  if (v[TWEEN.PINCH_X] !== 0 || v[TWEEN.PINCH_Y] !== 0) {
    const scale = (s.pinchRelative ? zoom : 1) * SCREEN_SCALE;
    let pxv = v[TWEEN.PINCH_X];
    let pyv = v[TWEEN.PINCH_Y];
    if (pxv === 0) pxv = 0.001;
    if (pyv === 0) pyv = 0.001;
    out.pinchValue[0] = -(pxv * 0.1);
    out.pinchValue[1] = -(pyv * 0.1);
    const follow = s.pinchFollowX || s.pinchFollowY;
    const target = s.pinchFollowX ? s.pinchTargetX : s.pinchTargetY;
    centreOf(follow, target, v[TWEEN.PINCH_CX], v[TWEEN.PINCH_CY], aspect, scene, out.pinchCenter);
    let modX = v[TWEEN.PINCH_MOD_X];
    let modY = v[TWEEN.PINCH_MOD_Y];
    if (modX <= 0.001) modX = 0.001;
    if (modY <= 0.001) modY = 0.001;
    const ax = Math.atan(-(out.pinchValue[0] * 20) * modX);
    const ay = Math.atan(-(out.pinchValue[1] * 20) * modY);
    out.pinchCalc[0] = modX / ax;
    out.pinchCalc[1] = modY / ay;
    out.pinchRadius = scale * v[TWEEN.PINCH_RADIUS];
  } else {
    out.pinchValue[0] = out.pinchValue[1] = 0;
  }

  // --- split screen ---------------------------------------------------------
  const rows = v[TWEEN.SPLIT_ROWS];
  const cols = v[TWEEN.SPLIT_COLS];
  out.rowmod = rows + 1;
  out.colmod = cols + 1;
  out.rowmodCalc = (-out.rowmod + 1) * out.textureScaleInv[1];
  out.colmodCalc = (-out.colmod + 1) * out.textureScaleInv[0];
  if (rows !== 0 || cols !== 0) {
    out.splitXStart = 0;
    out.splitXRange = 1;
    out.splitXRangeMult = 1;
    out.splitYStart = 0;
    out.splitYRange = 1;
    out.splitYRangeMult = 1;
  }

  return out;
}

export class ShaderBand {
  private program: Program | null = null;
  private loading: Promise<void> | null = null;
  private failed = false;
  private fbo: WebGLFramebuffer | null = null;
  private texture: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private width = 0;
  private height = 0;
  private drawing = false;

  constructor(private readonly ctx: GlContext) {}

  /**
   * Fetches the game's shader and builds it, once. Until it is built, and if
   * it never is, `ready` is false and the scene draws without its effects.
   */
  load(): Promise<void> {
    this.loading ??= this.fetchAndBuild();
    return this.loading;
  }

  /**
   * Built as the game loads rather than on the frame the first effect turns
   * on: the uber-shader takes tens of milliseconds to compile and link, and
   * that frame, mid-level, would stall for all of them. Where the browser
   * can, the driver builds it in the background and `ready` waits for it.
   */
  private async fetchAndBuild(): Promise<void> {
    try {
      const file = await fetchAsset<ShaderLayerFile>("shaderlayer.json");
      this.program = new Program(this.ctx.gl, VERTEX, toGlsl300(file.fragment), "screen effects", true);
    } catch (e) {
      this.failed = true;
      console.warn("The screen effects could not be loaded", e);
    }
  }

  get ready(): boolean {
    if (!this.program || this.failed || this.ctx.isLost) return false;
    try {
      return this.program.linked();
    } catch (e) {
      this.failed = true;
      console.error(e);
      return false;
    }
  }

  /**
   * Redirects drawing into the band's texture and clears it: to the
   * background, opaque, for a band that holds it, and to nothing otherwise.
   * False when there is nothing to draw into, and drawing stays on screen.
   * [ShaderLayer::visit :659528, beginWithClear(0, 0, 0, 0)]
   */
  begin(width: number, height: number, r: number, g: number, b: number, a: number): boolean {
    const gl = this.ctx.gl;
    if (!this.ready || !this.ensure(width, height) || !this.fbo) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, width, height);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawing = true;
    return true;
  }

  /** Back to the screen. */
  end(): void {
    if (!this.drawing) return;
    this.drawing = false;
    const gl = this.ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
  }

  /**
   * Draws the band through the shader. An opaque band replaces what is on
   * screen; any other is laid over it with the render-texture sprite's own
   * blend, SRC_ALPHA / ONE_MINUS_SRC_ALPHA. [ShaderLayer::setupShader
   * :659327-659333, CCSprite::setTexture on a texture without premultiplied
   * alpha]
   */
  composite(u: BandUniforms, opaque: boolean): void {
    const gl = this.ctx.gl;
    const p = this.program;
    if (!p || !this.texture) return;
    p.use();
    // The scratch unit, bound here every pass rather than once: it is shared
    // with the second font page, the middleground and every texture upload.
    gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(p.location("CC_Texture0"), UPLOAD_UNIT);
    setUniforms(gl, p, u);
    gl.bindVertexArray(this.vao);
    if (opaque) gl.disable(gl.BLEND);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
    // Off the scratch unit again: next frame draws into this texture, and a
    // unit still holding it would be a feedback loop for the sprite shader,
    // which samples every unit.
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** The render texture and its framebuffer, made or resized to the frame. */
  private ensure(width: number, height: number): boolean {
    const gl = this.ctx.gl;
    this.vao ??= gl.createVertexArray();
    if (this.texture && this.width === width && this.height === height) return true;
    this.width = width;
    this.height = height;
    if (!this.texture) this.texture = gl.createTexture();
    // On the scratch unit, like every other allocation: a bare bindTexture
    // lands on whichever unit was left active, and resizing the window would
    // otherwise take a sheet out from under the renderer.
    gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // Linear, as the game's anti-aliased render texture is unless the player
    // turns that off (0155). [ShaderLayer::toggleAntiAlias]
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (!this.fbo) this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }
}

/**
 * Every uniform the shader reads, each frame. Booleans take a float, as the
 * game sets them. An unset uniform is zero, which for the split screen would
 * be "on", so `_colmod` / `_rowmod` default to 1 when the effect is off.
 */
function setUniforms(gl: WebGL2RenderingContext, p: Program, u: BandUniforms): void {
  f2(gl, p, "_textureScale", u.textureScale[0], u.textureScale[1]);
  f2(gl, p, "_textureScaleInv", u.textureScaleInv[0], u.textureScaleInv[1]);
  f1(gl, p, "_screenAspect", u.screenAspect);
  f1(gl, p, "_screenAspectInv", 1 / u.screenAspect);

  f1(gl, p, "_shockWaveTime", u.shockWaveTime);
  f1(gl, p, "_shockWaveTime1", u.shockWaveTime1);
  f1(gl, p, "_shockWaveTime2", u.shockWaveTime2);
  f1(gl, p, "_shockWaveTime3", u.shockWaveTime3);
  f1(gl, p, "_shockWaveTime4", u.shockWaveTime4);
  f1(gl, p, "_shockWaveStrength", u.shockWaveStrength);
  f1(gl, p, "_shockWaveWaves", u.shockWaveWaves);
  f2(gl, p, "_shockWaveCenter", u.shockWaveCenter[0], u.shockWaveCenter[1]);
  f1(gl, p, "_shockWaveInvert", u.shockWaveInvert ? 1 : 0);
  f1(gl, p, "_shockWaveMinSize", u.shockWaveMinSize);
  f1(gl, p, "_shockWaveMaxSize", u.shockWaveMaxSize);
  f1(gl, p, "_shockWaveMaxDistVal", u.shockWaveMaxDistVal);

  f1(gl, p, "_shockLineTime", u.shockLineTime);
  f1(gl, p, "_shockLineTime1", u.shockLineTime1);
  f1(gl, p, "_shockLineTime2", u.shockLineTime2);
  f1(gl, p, "_shockLineTime3", u.shockLineTime3);
  f1(gl, p, "_shockLineTime4", u.shockLineTime4);
  f1(gl, p, "_shockLineAxis", u.shockLineAxis ? 1 : 0);
  f1(gl, p, "_shockLineDirection", u.shockLineDirection ? 1 : 0);
  f1(gl, p, "_shockLineDual", u.shockLineDual ? 1 : 0);
  f1(gl, p, "_shockLineWaves", u.shockLineWaves);
  f2(gl, p, "_shockLineStrength", u.shockLineStrength[0], u.shockLineStrength[1]);
  f1(gl, p, "_shockLineCenter", u.shockLineCenter);
  f1(gl, p, "_shockLineMaxDistVal", u.shockLineMaxDistVal);

  f1(gl, p, "_glitchBot", u.glitchBot);
  f1(gl, p, "_glitchTop", u.glitchTop);
  f1(gl, p, "_glitchXOffset", u.glitchXOffset);
  f2(gl, p, "_glitchColOffset", u.glitchColOffset[0], u.glitchColOffset[1]);
  f1(gl, p, "_glitchRnd", u.glitchRnd);

  f1(gl, p, "_cGTime", u.cGTime);
  f1(gl, p, "_cGRGBOffset", u.cGRGBOffset);
  f1(gl, p, "_cGYOffset", u.cGYOffset);
  f1(gl, p, "_cGStrength", u.cGStrength);
  f1(gl, p, "_cGHeight", u.cGHeight);
  f1(gl, p, "_cGLineStrength", u.cGLineStrength);
  f1(gl, p, "_cGLineThick", u.cGLineThick);

  f2(gl, p, "_bulgeOrigin", u.bulgeOrigin[0], u.bulgeOrigin[1]);
  f1(gl, p, "_bulgeValue", u.bulgeValue);
  f1(gl, p, "_bulgeValue2", u.bulgeValue2);
  f1(gl, p, "_bulgeRadius", u.bulgeRadius);

  f2(gl, p, "_pinchCenterPos", u.pinchCenter[0], u.pinchCenter[1]);
  f2(gl, p, "_pinchValue", u.pinchValue[0], u.pinchValue[1]);
  f2(gl, p, "_pinchCalc1", u.pinchCalc[0], u.pinchCalc[1]);
  f1(gl, p, "_pinchRadius", u.pinchRadius);

  f1(gl, p, "_blurUseRef", u.blurUseRef ? 1 : 0);
  f3(gl, p, "_blurRefColor", u.blurRefColor);
  f1(gl, p, "_blurIntensity", u.blurIntensity);
  f1(gl, p, "_blurFade", u.blurFade);
  f1(gl, p, "_blurOnlyEmpty", u.blurOnlyEmpty ? 1 : 0);

  f2(gl, p, "_radialBlurCenter", u.radialBlurCenter[0], u.radialBlurCenter[1]);
  f1(gl, p, "_radialBlurValue", u.radialBlurValue);
  f2(gl, p, "_motionBlurValue", u.motionBlurValue[0], u.motionBlurValue[1]);
  f1(gl, p, "_motionBlurMult", u.motionBlurMult);
  f1(gl, p, "_motionBlurDual", u.motionBlurDual ? 1 : 0);

  f1(gl, p, "_chromaticXOff", u.chromaticX);
  f1(gl, p, "_chromaticYOff", u.chromaticY);
  f1(gl, p, "_lensCircleStrength", u.lensStrength);
  f1(gl, p, "_lensCircleStart", u.lensStart);
  f1(gl, p, "_lensCircleEnd", u.lensEnd);
  f2(gl, p, "_lensCircleOrigin", u.lensOrigin[0], u.lensOrigin[1]);
  f3(gl, p, "_lensCircleTint", u.lensTint);
  f1(gl, p, "_lensCircleAdditive", u.lensAdditive ? 1 : 0);

  f1(gl, p, "_grayscaleValue", u.grayscale);
  f1(gl, p, "_grayscaleUseLum", u.grayscaleUseLum ? 1 : 0);
  f3(gl, p, "_grayscaleTint", u.grayscaleTint);
  f1(gl, p, "_sepiaValue", u.sepia);
  gl.uniform4f(p.location("_invertColorValue"), u.invert[0], u.invert[1], u.invert[2], u.invert[3]);
  f1(gl, p, "_hueShiftCosA", u.hueCos);
  f1(gl, p, "_hueShiftSinA", u.hueSin);
  f3(gl, p, "_colorChangeC", u.colorChangeC);
  f3(gl, p, "_colorChangeB", u.colorChangeB);

  f1(gl, p, "_rowmod", u.rowmod);
  f1(gl, p, "_colmod", u.colmod);
  f1(gl, p, "_rowmodCalc", u.rowmodCalc);
  f1(gl, p, "_colmodCalc", u.colmodCalc);
  f1(gl, p, "_splitXStart", u.splitXStart);
  f1(gl, p, "_splitXRange", u.splitXRange);
  f1(gl, p, "_splitXRangeMult", u.splitXRangeMult);
  f1(gl, p, "_splitYStart", u.splitYStart);
  f1(gl, p, "_splitYRange", u.splitYRange);
  f1(gl, p, "_splitYRangeMult", u.splitYRangeMult);
}

function f1(gl: WebGL2RenderingContext, p: Program, name: string, x: number): void {
  gl.uniform1f(p.location(name), x);
}

function f2(gl: WebGL2RenderingContext, p: Program, name: string, x: number, y: number): void {
  gl.uniform2f(p.location(name), x, y);
}

function f3(gl: WebGL2RenderingContext, p: Program, name: string, c: readonly number[]): void {
  gl.uniform3f(p.location(name), c[0], c[1], c[2]);
}
