// Key 405: a pitch shift that keeps a sound's length.
//
// The game adds FMOD's pitch-shift DSP to the channel — an FFT shifter, 2048
// points with key 412 and 1024 without — while speed (key 404) changes rate
// and pitch together. Web Audio has no such node, so the port shifts the
// buffer once, when the level loads: resample by the ratio (which shifts the
// pitch and changes the length), then stretch back to the original length by
// overlapping windows that are each lined up with the last one by
// cross-correlation (WSOLA). The window follows key 412. The artefacts are not
// FMOD's (Q6), but the pitch and the length are.
// [gdp FMODAudioEngine::playEffectAdvanced :74110-74120]

/** Shifts every channel by `ratio`, keeping the length. Ratio 1 returns the input. */
export function pitchShift(channels: readonly Float32Array<ArrayBuffer>[], ratio: number, window: 1024 | 2048): Float32Array<ArrayBuffer>[] {
  if (ratio === 1 || !(ratio > 0)) return [...channels];
  return channels.map((ch) => stretch(resample(ch, ratio), ch.length, window));
}

/** Linear resampling: `ratio` 2 plays twice as fast, half as long. */
function resample(x: Float32Array, ratio: number): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.floor(x.length / ratio));
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const at = i * ratio;
    const k = Math.floor(at);
    const frac = at - k;
    const a = x[k] ?? 0;
    const b = x[k + 1] ?? a;
    y[i] = a + (b - a) * frac;
  }
  return y;
}

/** WSOLA: `y` stretched to `length` samples without changing its pitch. */
function stretch(y: Float32Array, length: number, n: number): Float32Array<ArrayBuffer> {
  const hopOut = n / 2;
  const hopIn = (hopOut * y.length) / length;
  const tolerance = n / 8;
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const out = new Float32Array(length + n);
  const norm = new Float32Array(length + n);
  const at = (i: number): number => (i >= 0 && i < y.length ? y[i] : 0);
  let prev = 0;
  for (let k = 0; k * hopOut < length; k++) {
    const nominal = Math.round(k * hopIn);
    let pos = nominal;
    if (k > 0) {
      // The window that best continues the one before it.
      const natural = prev + hopOut;
      let best = -Infinity;
      for (let d = -tolerance; d <= tolerance; d++) {
        const cand = nominal + d;
        let c = 0;
        for (let i = 0; i < hopOut; i++) c += at(cand + i) * at(natural + i);
        if (c > best) {
          best = c;
          pos = cand;
        }
      }
    }
    const o = k * hopOut;
    for (let i = 0; i < n; i++) {
      out[o + i] += at(pos + i) * win[i];
      norm[o + i] += win[i];
    }
    prev = pos;
  }
  const result = new Float32Array(length);
  for (let i = 0; i < length; i++) result[i] = norm[i] > 1e-6 ? out[i] / norm[i] : out[i];
  return result;
}
