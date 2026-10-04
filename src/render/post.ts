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
// (tools/assets/shaders.ts) and turned from GLSL ES 1.00 into 3.00 here. The
// colour effects, the chromatic offset and the lens circle are given their
// values; the distortions (shock wave and line, glitch, chromatic glitch, the
// blurs, bulge, pinch, pixelate, split screen) are held at their off values
// until they are worked out, see src/triggers/registry.ts.
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

/** Everything the band pass sets, beyond the colour effects. */
export interface BandUniforms extends ColourUniforms {
  /** Height over width of the frame. [exe VA 0x1404882c6-0x140488315] */
  screenAspect: number;
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
  blurOnlyEmpty: boolean;
}

export function newBandUniforms(): BandUniforms {
  return {
    ...newColourUniforms(),
    screenAspect: 9 / 16,
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
    blurOnlyEmpty: false,
  };
}

/** What the uniforms need from the scene around the layer. */
export interface BandScene {
  /** The frame in device pixels. */
  width: number;
  height: number;
  /** The camera's zoom, which the "relative" switches scale by. */
  zoom: number;
  /** A channel's colour as it stands now, 0..255, and whether it blends. */
  colourOf(channel: number): { r: number; g: number; b: number; blending?: boolean };
  /**
   * Where a shader target (-1 player 1, -2 player 2, a group) is on screen,
   * 0..1 from the bottom left, or false for one that is not there.
   * [GJBaseGameLayer::positionForShaderTarget :424325-424361 →
   *  ShaderLayer::objectPosToShaderPos :656553-656570]
   */
  targetOnScreen(target: number, out: [number, number]): boolean;
}

const scratchPoint: [number, number] = [0, 0];

/**
 * The band's uniforms from the layer's values. Lengths are the 2.2074 build's:
 * the chromatic offset is its value in points over G, and the lens circle's
 * radius its size times G / screenScaleFactorW in screen widths, the frame
 * being one screen wide and `screenAspect` high.
 * [2.2074 exe: chromatic VA 0x1404883b9-0x14048842d, lens 0x1404868f1-0x1404869a0,
 *  the lens origin 0x1404834f9-0x1404835c0, the factor at +0x4a4 set at
 *  0x1404820b7-0x1404820d2; 2.206 decompile: preChromaticShader
 *  :657831-657865, preLensCircleShader :658364-658420, preCommonShader
 *  :656493-656550, updateEffectOffsets :657019-657040]
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

  const cr = s.chromaticRelative ? zoom : 1;
  out.chromaticX = (v[TWEEN.CHROMATIC_X] / (G * points.width)) * cr;
  out.chromaticY = (v[TWEEN.CHROMATIC_Y] / (G * points.height)) * cr;

  out.lensStrength = v[TWEEN.LENS_STRENGTH] > 0 ? v[TWEEN.LENS_STRENGTH] : 0;
  const lr = s.lensRelative ? zoom : 1;
  const unit = G / (points.width / DESIGN_WIDTH);
  const end = lr * v[TWEEN.LENS_SIZE] * unit;
  out.lensStart = Math.max(0, end - Math.max(0, v[TWEEN.LENS_FADE]));
  out.lensEnd = Math.max(0, end);
  // Centred on its target when it has one on screen; otherwise keys 290 and
  // 291 put it anywhere from one edge (-1) to the other (1).
  if (s.lensTarget !== 0 && scene.targetOnScreen(s.lensTarget, scratchPoint)) {
    out.lensOrigin[0] = scratchPoint[0];
    out.lensOrigin[1] = scratchPoint[1] * aspect;
  } else {
    out.lensOrigin[0] = 0.5 + 0.5 * v[TWEEN.LENS_X];
    out.lensOrigin[1] = (0.5 + 0.5 * v[TWEEN.LENS_Y]) * aspect;
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

  // The blurs' fill: their reference channel, or the background's.
  // [updateShaderLayer :424505-424519; preCommonShader :656493-656550]
  const ref = scene.colourOf(s.blurRefChannel > 0 ? s.blurRefChannel : 1000);
  out.blurRefColor[0] = ref.r / 255;
  out.blurRefColor[1] = ref.g / 255;
  out.blurRefColor[2] = ref.b / 255;
  out.blurUseRef = st.layerMin > 1;
  out.blurIntensity = v[TWEEN.BLUR_INTENSITY] + 1;
  out.blurOnlyEmpty = st.layerMin > 1 && s.blurOnlyEmpty;
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
 * Every uniform the shader reads, each frame. The distortions are set to the
 * values that skip them: the shader tests `_shockWaveTime > 0`,
 * `_colmod != 1` and the like, and an unset uniform is zero, which for the
 * split screen would be "on". Booleans take a float, as the game sets them.
 */
function setUniforms(gl: WebGL2RenderingContext, p: Program, u: BandUniforms): void {
  f2(gl, p, "_textureScale", 1, 1);
  f2(gl, p, "_textureScaleInv", 1, 1);
  f1(gl, p, "_screenAspect", u.screenAspect);
  f1(gl, p, "_screenAspectInv", 1 / u.screenAspect);
  // Off: the distortions.
  f1(gl, p, "_shockWaveTime", 0);
  f1(gl, p, "_shockLineTime", 0);
  f1(gl, p, "_bulgeValue", 0);
  f2(gl, p, "_pinchValue", 0, 0);
  f1(gl, p, "_glitchTop", 0);
  f1(gl, p, "_colmod", 1);
  f1(gl, p, "_rowmod", 1);
  f1(gl, p, "_cGRGBOffset", 0);
  f1(gl, p, "_radialBlurValue", 0);
  f2(gl, p, "_motionBlurValue", 0, 0);
  // Common.
  f1(gl, p, "_blurUseRef", u.blurUseRef ? 1 : 0);
  f3(gl, p, "_blurRefColor", u.blurRefColor);
  f1(gl, p, "_blurIntensity", u.blurIntensity);
  f1(gl, p, "_blurOnlyEmpty", u.blurOnlyEmpty ? 1 : 0);
  // Chromatic and the lens circle.
  f1(gl, p, "_chromaticXOff", u.chromaticX);
  f1(gl, p, "_chromaticYOff", u.chromaticY);
  f1(gl, p, "_lensCircleStrength", u.lensStrength);
  f1(gl, p, "_lensCircleStart", u.lensStart);
  f1(gl, p, "_lensCircleEnd", u.lensEnd);
  f2(gl, p, "_lensCircleOrigin", u.lensOrigin[0], u.lensOrigin[1]);
  f3(gl, p, "_lensCircleTint", u.lensTint);
  f1(gl, p, "_lensCircleAdditive", u.lensAdditive ? 1 : 0);
  // The colour tail.
  f1(gl, p, "_grayscaleValue", u.grayscale);
  f1(gl, p, "_grayscaleUseLum", u.grayscaleUseLum ? 1 : 0);
  f3(gl, p, "_grayscaleTint", u.grayscaleTint);
  f1(gl, p, "_sepiaValue", u.sepia);
  gl.uniform4f(p.location("_invertColorValue"), u.invert[0], u.invert[1], u.invert[2], u.invert[3]);
  f1(gl, p, "_hueShiftCosA", u.hueCos);
  f1(gl, p, "_hueShiftSinA", u.hueSin);
  f3(gl, p, "_colorChangeC", u.colorChangeC);
  f3(gl, p, "_colorChangeB", u.colorChangeB);
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
