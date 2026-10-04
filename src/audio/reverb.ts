// The reverb an SFX trigger's key 407 sends its sound through.
//
// The game has one reverb for the level's sound: an FMOD SFXREVERB on the
// channel group a sound joins when its trigger sets key 407 (an SFX group's
// sounds included). An SFX trigger with key 503 switches it to key 502's
// preset as it plays, and every reset puts it back to preset 0. The presets
// are FMOD's own, in FMOD's order: 0 Generic, which any number outside 1-22
// falls back to, then Padded Cell to Underwater. The reverb's input is heard
// dry as well, at 0 dB, as FMOD's dry level defaults.
// [gdp FMODAudioEngine::updateReverb :64005-64070 (the fallback, then the
//  22-entry table unk_980BF4, nine floats a preset: decay, early delay, late
//  delay, HF decay, diffusion, density, high cut, early/late mix and wet;
//  HF reference 5000, low shelf 250 Hz at 0 dB for all); reverbToString
//  :64173-64253 names them; each value is in GeometryDash.exe's float pool]
//
// FMOD's reverb algorithm is not reproduced. The port convolves with an
// impulse built from the same numbers: discrete early reflections after the
// early delay, then a noise tail from the late delay on that dies 60 dB over
// the decay time, faster above 5 kHz by the HF decay ratio, thinned by the
// density, low-passed at the high cut, and split between the two by the
// early/late mix.

export interface ReverbPreset {
  /** ms for the tail to die 60 dB. */
  decay: number;
  /** ms from the sound to the first reflection. */
  earlyDelay: number;
  /** ms from the first reflection to the tail. */
  lateDelay: number;
  /** % of the decay time above the HF reference (5000 Hz). */
  hfDecay: number;
  diffusion: number;
  density: number;
  /** Hz: the wet signal's low-pass. */
  highCut: number;
  /** %: 0 all early reflections, 100 all tail. */
  earlyLateMix: number;
  /** dB */
  wet: number;
}

const P = (decay: number, earlyDelay: number, lateDelay: number, hfDecay: number, diffusion: number, density: number, highCut: number, earlyLateMix: number, wet: number): ReverbPreset => ({
  decay,
  earlyDelay,
  lateDelay,
  hfDecay,
  diffusion,
  density,
  highCut,
  earlyLateMix,
  wet,
});

/** FMOD_PRESET_GENERIC: preset 0, and any number without an entry. [updateReverb :64026-64036] */
export const GENERIC_REVERB = P(1500, 7, 11, 83, 100, 100, 14500, 96, -8);

/** Presets 1-22, FMOD's PADDEDCELL to UNDERWATER. [unk_980BF4, via updateReverb :64038-64049] */
export const REVERB_PRESETS: readonly ReverbPreset[] = [
  P(170, 1, 2, 10, 100, 100, 160, 84, -7.8), //  1 padded cell
  P(400, 2, 3, 83, 100, 100, 6050, 88, -9.4), //  2 room
  P(1500, 7, 11, 54, 100, 60, 2900, 83, 0.5), //  3 bathroom
  P(500, 3, 4, 10, 100, 100, 160, 58, -19), //  4 living room
  P(2300, 12, 17, 64, 100, 100, 7800, 71, -8.5), //  5 stone room
  P(4300, 20, 30, 59, 100, 100, 5850, 64, -11.7), //  6 auditorium
  P(3900, 20, 29, 70, 100, 100, 5650, 80, -9.8), //  7 concert hall
  P(2900, 15, 22, 100, 100, 100, 20000, 59, -11.3), //  8 cave
  P(7200, 20, 30, 33, 100, 100, 4500, 80, -9.6), //  9 arena
  P(10000, 20, 30, 23, 100, 100, 3400, 72, -7.4), // 10 hangar
  P(300, 2, 30, 10, 100, 100, 500, 56, -24), // 11 carpeted hallway
  P(1500, 7, 11, 59, 100, 100, 7800, 87, -5.5), // 12 hallway
  P(270, 13, 20, 79, 100, 100, 9000, 86, -6), // 13 stone corridor
  P(1500, 7, 11, 86, 100, 100, 8300, 80, -9.8), // 14 alley
  P(1500, 162, 88, 54, 79, 100, 760, 94, -12.3), // 15 forest
  P(1500, 7, 11, 67, 50, 100, 4050, 66, -26), // 16 city
  P(1500, 300, 100, 21, 27, 100, 1220, 82, -24), // 17 mountains
  P(1500, 61, 25, 83, 100, 100, 3400, 100, -5), // 18 quarry
  P(1500, 179, 100, 50, 21, 100, 1670, 65, -28), // 19 plain
  P(1700, 8, 12, 100, 100, 100, 20000, 56, -19.5), // 20 parking lot
  P(2800, 14, 21, 14, 80, 60, 3400, 66, 1.2), // 21 sewer pipe
  P(1500, 7, 11, 10, 100, 100, 500, 92, 7), // 22 underwater
];

/** Key 502's preset; anything but 1-22 is Generic. [updateReverb :64026 (a2 − 1 > 21)] */
export function reverbPreset(n: number): ReverbPreset {
  return n >= 1 && n <= REVERB_PRESETS.length ? REVERB_PRESETS[n - 1] : GENERIC_REVERB;
}

/** The HF reference every preset shares. [updateReverb :64059] */
const HF_REFERENCE = 5000;
/** The longest tail built, in seconds: the hangar's 10 s decay is 60 dB down by then. */
const MAX_TAIL = 10;

/** mulberry32: the same impulse every time for the same preset and rate. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A one-pole low-pass coefficient for a cut-off. */
function onePole(hz: number, rate: number): number {
  return 1 - Math.exp((-2 * Math.PI * Math.min(hz, rate / 2)) / rate);
}

/**
 * Two channels of impulse for one preset, wet level applied: what the
 * reverb adds to the dry sound. Energy-normalised before the wet level, so
 * 0 dB wet sounds about as loud as the dry sound.
 */
export function reverbImpulse(preset: ReverbPreset, rate: number, seed = 1): [Float32Array, Float32Array] {
  const early = preset.earlyDelay / 1000;
  const late = early + preset.lateDelay / 1000;
  const t60 = Math.max(0.01, preset.decay / 1000);
  const t60hf = Math.max(0.01, (t60 * preset.hfDecay) / 100);
  const length = Math.max(1, Math.ceil((late + Math.min(MAX_TAIL, t60)) * rate));
  const lateShare = Math.min(1, Math.max(0, preset.earlyLateMix / 100));
  const keep = Math.max(0.02, preset.density / 100);
  const hf = onePole(HF_REFERENCE, rate);
  const cut = onePole(preset.highCut, rate);
  const out: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];
  for (let c = 0; c < 2; c++) {
    const rand = prng(seed * 2 + c + 1);
    const data = out[c];
    // Early reflections: a dozen taps between the early and the late delay
    // (or 30 ms, whichever is longer), each quieter than the last.
    const span = Math.max(0.03, late - early);
    let earlyEnergy = 0;
    const taps: Array<[number, number]> = [];
    for (let k = 0; k < 12; k++) {
      const at = Math.min(length - 1, Math.round((early + span * rand()) * rate));
      const gain = (rand() < 0.5 ? -1 : 1) * Math.pow(0.8, k);
      taps.push([at, gain]);
      earlyEnergy += gain * gain;
    }
    // The tail: noise from the late delay on, the part under the HF
    // reference dying over the decay time and the part over it faster.
    let low = 0;
    let tailEnergy = 0;
    const tail = new Float32Array(length);
    const start = Math.min(length - 1, Math.round(late * rate));
    for (let i = start; i < length; i++) {
      const n = rand() < keep ? rand() * 2 - 1 : 0;
      low += hf * (n - low);
      const t = (i - start) / rate;
      const v = low * Math.exp((-6.9078 * t) / t60) + (n - low) * Math.exp((-6.9078 * t) / t60hf);
      tail[i] = v;
      tailEnergy += v * v;
    }
    const e = earlyEnergy > 0 ? Math.sqrt((1 - lateShare) / earlyEnergy) : 0;
    const l = tailEnergy > 0 ? Math.sqrt(lateShare / tailEnergy) : 0;
    for (const [at, gain] of taps) data[at] += gain * e;
    for (let i = start; i < length; i++) data[i] += tail[i] * l;
    // The high cut, and the diffusion as a little more smoothing on top.
    const smooth = cut * (0.5 + preset.diffusion / 200);
    let y = 0;
    let energy = 0;
    for (let i = 0; i < length; i++) {
      y += smooth * (data[i] - y);
      data[i] = y;
      energy += y * y;
    }
    const wet = Math.pow(10, preset.wet / 20);
    const norm = energy > 0 ? wet / Math.sqrt(energy) : 0;
    for (let i = 0; i < length; i++) data[i] *= norm;
  }
  return out;
}
