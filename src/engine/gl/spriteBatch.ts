// The instanced sprite batcher.
//
// One unit quad, no vertex buffer at all — the corner comes from gl_VertexID —
// and one instance buffer holding 48 bytes per sprite:
//
//   0  aXform  vec4  float          the 2x2 of rotation x scale x flip x half-size
//   16 aPos    vec2  float          world centre in GD units
//   24 aUv     vec4  float          u0, v0, du, dv, normalised (du is negative when turned)
//   40 aTint   vec4  ubyte, normed  final colour, already resolved on the cpu
//   44 aFlags  vec4  ubyte, integer sheet index, rotated | grey (FLAG_*), blend (BLEND), shape (SHAPE)
//
// Every sheet is bound to its own texture unit for the whole frame — the game
// has eight and the smallest WebGL2 guarantee is sixteen — so a change of sheet
// never splits a batch. Blending does not split one either: the art is uploaded
// premultiplied and drawn with ONE / ONE_MINUS_SRC_ALPHA, and an additive
// sprite is written with an output alpha of zero, which turns that same
// equation into addition, glow and all. How much it adds depends on how the
// game draws that kind of sprite, which is what the blend byte says (BLEND).
// The scene splits the level at its draw layers, so the player can go between
// them, and inside a layer wherever a particle system's z falls between its
// batches.

import { Program } from "./program";

/** Bytes per instance. Kept a multiple of 16 because drivers prefer it. */
export const INSTANCE_BYTES = 48;
export const INSTANCE_FLOATS = INSTANCE_BYTES / 4;
/** Where in an instance its blend byte, aFlags.z, sits. */
const BLEND_BYTE = 46;

/**
 * The blend byte: how an instance meets what is under it.
 *
 * The game draws its additive art with GL_SRC_ALPHA / GL_ONE, which adds the
 * colour it hands GL times that colour's own alpha. What colour it hands GL
 * depends on what is being drawn, so the same blend adds different amounts:
 *
 * - A sprite in one of the object layer's additive batches (every blending
 *   object and every glow) has premultiplied art and a colour cocos has
 *   already multiplied by the sprite's opacity (opacityModifyRGB). So the
 *   art's own alpha and the opacity both count twice: a soft glow, or a
 *   blending object at part opacity or part faded in at the screen's edge,
 *   adds a good deal less than its colour times its opacity.
 * - A particle the system made additive keeps its colour as it is, alpha
 *   apart, so the alpha counts once more than the colour does, and the art's
 *   alpha once more again.
 *
 * - A flat colour with no art behind it — a CCDrawNode's polygons, a
 *   CCLayerGradient's quad — is handed over as it is, alpha apart, so it
 *   adds its colour times its alpha. These are drawn on the flat white
 *   square, where that is ADD.
 *
 * Covering goes three ways. A sprite, or a particle whose system was made
 * normal, hands GL its colour already times its alpha and draws with
 * ONE / ONE_MINUS_SRC_ALPHA: NORMAL, which is also what a flat colour under
 * GL_SRC_ALPHA / GL_ONE_MINUS_SRC_ALPHA comes to. A particle whose system
 * was made additive, and which its object has since switched to normal,
 * still hands GL its colour without its alpha, under that same ONE /
 * ONE_MINUS_SRC_ALPHA: it covers as much as a normal one but lays its whole
 * colour down, STRAIGHT. And art drawn GL_SRC_ALPHA / GL_ONE_MINUS_SRC_ALPHA
 * with its colour as it is — a CCMotionStreak made normal — is weighed by
 * the art's alpha and its own as an additive particle is, and covers by
 * the same: COVER_STRAIGHT.
 * [cocos2d::CCSprite::updateColor (2.2074 libcocos2d.dll VA 0x18008d450;
 *  gd-ida-decomp.cpp:863976-864005: rgb × opacity when +468);
 *  CCImage::_initWithPngData premultiplies (VA 0x18007b5c0ff, :855371ff);
 *  GJBaseGameLayer::setupLayers :434825-435546 and createTextLayers
 *  :419212-419420 (every additive batch 770 / 1);
 *  CCParticleSystemQuad::updateQuadWithParticle :848005-848063 (+584, the
 *  premultiplied path, is only set by updateBlendFunc :844213-844239 for a
 *  normal blend on premultiplied art); CCParticleSystem::setBlendAdditive
 *  :844274-844296 (false on premultiplied art is 1 / 771, +584 untouched);
 *  CCDrawNode and CCLayerGradient: position and colour, no texture, the
 *  colour as given (CCLayerGradient::updateColor :820617-820690);
 *  CCMotionStreak's vertex colour is its colour with the fade as alpha]
 */
export const BLEND = {
  /** Covers what is under it. */
  NORMAL: 0,
  /** Adds as a flat colour drawn GL_SRC_ALPHA / GL_ONE: its colour times its alpha. */
  ADD: 1,
  /** Adds as a sprite in the game's additive batches: art alpha and opacity count twice. */
  ADD_SPRITE: 2,
  /** Adds as an additive particle: its colour as given, times the art's alpha and its own. */
  ADD_PARTICLE: 3,
  /** Covers as NORMAL does, but with its colour as given: its alpha does not dim it. */
  STRAIGHT: 4,
  /** Covers as GL_SRC_ALPHA / GL_ONE_MINUS_SRC_ALPHA on its colour as given: weighed as ADD_PARTICLE is. */
  COVER_STRAIGHT: 5,
} as const;

/** Where in an instance its shape byte, aFlags.w, sits. */
export const SHAPE_BYTE = 47;

/**
 * The shape byte: what an instance's corners make. A sprite is a
 * parallelogram, the pos ± x ± y of its transform. The flat shapes cocos
 * draws straight from GL primitives — a CCCircleWave's filled circle is a
 * triangle fan — are triangles, which no parallelogram is; a TRIANGLE folds
 * the fourth corner onto the third, so the strip's second triangle has no
 * area and the instance is the triangle (pos − x + y, pos + x + y,
 * pos − x − y). [cocos2d::ccDrawFilledCircle, 2.2074 libcocos2d.dll VA
 *  0x180011230 (GL_TRIANGLE_FAN)]
 */
export const SHAPE = {
  QUAD: 0,
  TRIANGLE: 1,
} as const;

/**
 * Bits of aFlags.y. A frame the packer turned 90°, and art drawn in grey
 * before its tint, as a CCSpriteGrayscale is.
 */
export const FLAG_TURNED = 1;
export const FLAG_GREY = 2;

/** Whether a blend byte (BLEND) adds to what is under it rather than covering it. */
export function blendAdds(blend: number): boolean {
  return blend !== BLEND.NORMAL && blend !== BLEND.STRAIGHT && blend !== BLEND.COVER_STRAIGHT;
}
/**
 * Texture units the shader can reach. Units 0-7 hold the eight gameplay
 * sheets, which never change; 8 to 10 hold the level's background and ground,
 * which are separate images rather than atlas pages; 11 and 12 hold the icon
 * pages the player's own modes need — two, because a ship carries a cube
 * inside it. WebGL2 guarantees at least sixteen fragment units.
 */
export const MAX_SHEETS = 16;
/** Where the scenery textures live, past the atlas pages. */
export const SHEET_BACKGROUND = 8;
export const SHEET_GROUND = 9;
export const SHEET_GROUND_DETAIL = 10;
/** The icon pages, rebound whenever the player changes mode. */
export const SHEET_PLAYER = 11;
export const SHEET_PLAYER_2 = 12;
/**
 * The interface's packed art page, and two font pages beside it, bound on
 * demand the way the icon pages are. Sixteen units is the WebGL2 minimum, so
 * this is the whole budget rather than a starting point: anything new shares a
 * page instead of taking a unit.
 */
export const SHEET_UI = 13;
export const SHEET_FONT = 14;
export const SHEET_FONT_2 = 15;
/**
 * The scratch unit, which is the last one because the budget is exactly full.
 *
 * Four things use it: the second font page, the middleground's two images, the
 * screen-effect band's texture, and every texture upload — `texImage2D` has to
 * bind somewhere, and the unit it binds to is whichever one happens to be
 * active. Sending uploads here is what keeps them off units 0-14, where an
 * upload used to wipe whatever the last caller had left bound; the interface's
 * font pages went black or drew a background image's pixels as glyphs
 * depending on what had loaded last.
 *
 * So: nothing may assume a binding on this unit survives. Each of them binds
 * it again immediately before it samples it.
 */
export const UPLOAD_UNIT = MAX_SHEETS - 1;

const VERTEX_SOURCE = `#version 300 es
layout(location = 0) in vec4 aXform;
layout(location = 1) in vec2 aPos;
layout(location = 2) in vec4 aUv;
layout(location = 3) in vec4 aTint;
layout(location = 4) in uvec4 aFlags;

// camera: centre x, centre y, and the scale that takes units to clip space
uniform vec4 uCamera;
// the view's turn as cos, sin: clockwise, about the centre, before the scale
uniform vec2 uTurn;

out vec2 vUv;
out vec4 vTint;
flat out int vSheet;
flat out uint vBlend;
flat out uint vGrey;

void main() {
  // 0,0  1,0  0,1  1,1 as a triangle strip; y runs down the sprite. A
  // triangle (SHAPE.TRIANGLE) puts its fourth corner on its third.
  int id = aFlags.w == ${SHAPE.TRIANGLE}u && gl_VertexID == 3 ? 2 : gl_VertexID;
  vec2 corner = vec2(float(id & 1), float(id >> 1));
  vec2 unit = vec2(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0);
  vec2 world = vec2(aXform.x * unit.x + aXform.z * unit.y,
                    aXform.y * unit.x + aXform.w * unit.y) + aPos;
  // Turned in units, before the scale: the scale is not the same both ways.
  vec2 d = world - uCamera.xy;
  d = vec2(d.x * uTurn.x + d.y * uTurn.y, -d.x * uTurn.y + d.y * uTurn.x);
  gl_Position = vec4(d * uCamera.zw, 0.0, 1.0);

  bool turned = (aFlags.y & ${FLAG_TURNED}u) != 0u;
  vec2 t = turned ? corner.yx : corner;
  vUv = aUv.xy + t * aUv.zw;
  vTint = aTint;
  vSheet = int(aFlags.x);
  vBlend = aFlags.z;
  vGrey = aFlags.y & ${FLAG_GREY}u;
}
`;

const FRAGMENT_SOURCE = `#version 300 es
precision mediump float;

in vec2 vUv;
in vec4 vTint;
flat in int vSheet;
flat in uint vBlend;
flat in uint vGrey;

uniform sampler2D uSheet0;
uniform sampler2D uSheet1;
uniform sampler2D uSheet2;
uniform sampler2D uSheet3;
uniform sampler2D uSheet4;
uniform sampler2D uSheet5;
uniform sampler2D uSheet6;
uniform sampler2D uSheet7;
uniform sampler2D uSheet8;
uniform sampler2D uSheet9;
uniform sampler2D uSheet10;
uniform sampler2D uSheet11;
uniform sampler2D uSheet12;
uniform sampler2D uSheet13;
uniform sampler2D uSheet14;
uniform sampler2D uSheet15;

// 1 for the second pass over a partial screen-effect band: see bandAlpha.
uniform float uAddAlpha;

out vec4 fragColor;

// GLSL ES 3.00 will not index an array of samplers with a varying, so this is
// spelled out. A sheet array would need every page the same size; the game's
// pages are not.
vec4 sampleSheet(int i, vec2 uv) {
  if (i == 0) return texture(uSheet0, uv);
  if (i == 1) return texture(uSheet1, uv);
  if (i == 2) return texture(uSheet2, uv);
  if (i == 3) return texture(uSheet3, uv);
  if (i == 4) return texture(uSheet4, uv);
  if (i == 5) return texture(uSheet5, uv);
  if (i == 6) return texture(uSheet6, uv);
  if (i == 7) return texture(uSheet7, uv);
  if (i == 8) return texture(uSheet8, uv);
  if (i == 9) return texture(uSheet9, uv);
  if (i == 10) return texture(uSheet10, uv);
  if (i == 11) return texture(uSheet11, uv);
  if (i == 12) return texture(uSheet12, uv);
  if (i == 13) return texture(uSheet13, uv);
  if (i == 14) return texture(uSheet14, uv);
  return texture(uSheet15, uv);
}

void main() {
  bool covers = vBlend == ${BLEND.NORMAL}u || vBlend == ${BLEND.STRAIGHT}u || vBlend == ${BLEND.COVER_STRAIGHT}u;
  // The alpha pass has nothing to add for a sprite that covers, so it does
  // not sample the sheet for one.
  if (uAddAlpha > 0.5 && covers) discard;
  vec4 texel = sampleSheet(vSheet, vUv);   // premultiplied
  float a = texel.a * vTint.a;
  if (uAddAlpha > 0.5) {
    // Only an additive sprite's own coverage, squared, as its batch's
    // SRC_ALPHA / ONE blend leaves it in the game's render texture.
    fragColor = vec4(0.0, 0.0, 0.0, a * a);
    return;
  }
  vec3 art = texel.rgb;
  // Even luminance: the three channels weigh the same.
  if (vGrey != 0u) art = vec3((art.r + art.g + art.b) / 3.0);
  vec3 rgb = art * vTint.rgb;
  if (vBlend == ${BLEND.ADD_PARTICLE}u || vBlend == ${BLEND.COVER_STRAIGHT}u) {
    // An additive particle's colour is not premultiplied; SRC_ALPHA weighs it
    // by the art's alpha and its own, adding or covering.
    // (BLEND.ADD_PARTICLE, BLEND.COVER_STRAIGHT)
    rgb *= a;
  } else if (vBlend != ${BLEND.STRAIGHT}u) {
    // Tinting premultiplied colour scales rgb by the tint and by its own
    // alpha, as cocos does to a sprite's colour. A straight particle's colour
    // is not premultiplied, and ONE takes it as it is. (BLEND.STRAIGHT)
    rgb *= vTint.a;
    // A sprite in the game's additive batches: SRC_ALPHA weighs that again.
    // (BLEND.ADD_SPRITE)
    if (vBlend == ${BLEND.ADD_SPRITE}u) rgb *= a;
  }
  // Writing zero alpha for an additive sprite makes the blend add instead of
  // cover, which is how one blend state serves both.
  fragColor = vec4(rgb, covers ? a : 0.0);
}
`;

export class SpriteBatch {
  private readonly program: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private capacity: number;
  private readonly sheetLocations: (WebGLUniformLocation | null)[] = [];
  private readonly cameraLocation: WebGLUniformLocation | null;
  private readonly turnLocation: WebGLUniformLocation | null;
  private readonly addAlphaLocation: WebGLUniformLocation | null;
  /** Draw calls and instances issued since the last `beginFrame`. */
  drawCalls = 0;
  instances = 0;
  /**
   * Set while the scene draws into a screen-effect band that does not hold
   * the background. Such a band is laid over the screen by its alpha, and
   * the zero alpha an additive sprite writes would make a glow over nothing
   * vanish there; the game's additive batches add their coverage squared to
   * the alpha instead. So each draw that holds an additive sprite is
   * followed by a second pass over the same instances that writes only
   * alpha, only for the additive ones, with ONE / ONE.
   * [GJBaseGameLayer's additive batches, blend 770 / 1
   *  (GL_SRC_ALPHA, GL_ONE): parentForZLayer :435785ff]
   */
  bandAlpha = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    capacity = 8192,
  ) {
    this.program = new Program(gl, VERTEX_SOURCE, FRAGMENT_SOURCE, "sprites");
    this.capacity = capacity;

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error("could not create the sprite batch");
    this.vao = vao;
    this.buffer = buffer;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, capacity * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
    const stride = INSTANCE_BYTES;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, stride, 40);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribIPointer(4, 4, gl.UNSIGNED_BYTE, stride, 44);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);

    this.program.use();
    this.cameraLocation = this.program.location("uCamera");
    this.turnLocation = this.program.location("uTurn");
    this.addAlphaLocation = this.program.location("uAddAlpha");
    for (let i = 0; i < MAX_SHEETS; i++) {
      const at = this.program.location(`uSheet${i}`);
      this.sheetLocations.push(at);
      if (at) gl.uniform1i(at, i);
    }
  }

  /**
   * Binds the given sheets to units 0 upward, once; nothing rebinds them per
   * draw. Only the units the caller actually has a texture for are touched —
   * the icon pages live past the end of this list and are bound separately, and
   * walking the whole range would unbind them every time a level loads.
   */
  bindSheets(textures: readonly (WebGLTexture | null)[]): void {
    const gl = this.gl;
    // Stops before the icon pages, which is also what keeps it off the
    // interface's units and the scratch unit: a level with a long sheet list
    // would otherwise unbind them and take the menu's text with it.
    const count = Math.min(textures.length, SHEET_PLAYER);
    for (let i = 0; i < count; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, textures[i] ?? null);
    }
  }

  /**
   * Sets the view for the frame: its centre, its size in units, and the
   * degrees it is turned by, clockwise about its centre as cocos turns a node.
   * The interface passes no turn.
   */
  beginFrame(centreX: number, centreY: number, unitsWide: number, unitsHigh: number, degrees = 0): void {
    this.drawCalls = 0;
    this.instances = 0;
    this.program.use();
    if (this.cameraLocation) {
      this.gl.uniform4f(this.cameraLocation, centreX, centreY, 2 / unitsWide, 2 / unitsHigh);
    }
    if (this.turnLocation) {
      const r = (degrees * Math.PI) / 180;
      this.gl.uniform2f(this.turnLocation, Math.cos(r), Math.sin(r));
    }
  }

  /**
   * Makes this batch's program current again, with the camera `beginFrame`
   * set, after another program has drawn in the middle of a frame.
   */
  resume(): void {
    this.program.use();
  }

  /**
   * Draws `count` instances from `data`, which must be laid out as above,
   * starting at instance `start`.
   */
  draw(data: Float32Array, count: number, start = 0): void {
    if (count <= 0) return;
    const gl = this.gl;
    if (count > this.capacity) this.grow(count);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    // Orphan the old storage so the driver never waits on the previous frame.
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, start * INSTANCE_FLOATS, count * INSTANCE_FLOATS);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    // Only additive sprites add to the band's alpha, so a run without one
    // has no second pass.
    if (this.bandAlpha && this.hasAdditive(data, start, count)) {
      gl.colorMask(false, false, false, true);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(this.addAlphaLocation, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.uniform1f(this.addAlphaLocation, 0);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.colorMask(true, true, true, true);
      this.drawCalls++;
    }
    gl.bindVertexArray(null);
    this.drawCalls++;
    this.instances += count;
  }

  /** Byte views of the arrays handed to `draw`, made once per array rather than per draw. */
  private readonly byteViews = new WeakMap<ArrayBufferLike, Uint8Array>();

  /** Whether any of the run's instances adds (aFlags.z, BLEND) rather than covers. */
  private hasAdditive(data: Float32Array, start: number, count: number): boolean {
    let bytes = this.byteViews.get(data.buffer);
    if (!bytes) {
      bytes = new Uint8Array(data.buffer);
      this.byteViews.set(data.buffer, bytes);
    }
    let at = data.byteOffset + start * INSTANCE_BYTES + BLEND_BYTE;
    for (let i = 0; i < count; i++, at += INSTANCE_BYTES) if (blendAdds(bytes[at])) return true;
    return false;
  }

  private grow(needed: number): void {
    this.capacity = Math.max(needed, Math.ceil(this.capacity * 1.5));
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
  }
}
