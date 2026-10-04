// The semitone table the audio triggers index with.

/**
 * The ratios the game's SFX and Song triggers index with keys 404 (speed) and
 * 405 (pitch), −12 to 12, as the float32 constants the exe returns. They are
 * 2^(k/12) but for +2, where the game has 1.122562 (2^(2/12) is 1.122462).
 * [gdp FMODAudioEngine::pitchForIdx, gd-ida-decomp.cpp:64678-64686; the table
 *  is only in the exe: GeometryDash.exe 0x1400569e0, jump table 0x140056aec]
 */
export const PITCH_RATIOS: readonly number[] = [
  0.5, 0.5297315716743469, 0.5612310171127319, 0.5946035385131836, 0.6299605369567871,
  0.6674199104309082, 0.7071067690849304, 0.7491535544395447, 0.7937005162239075,
  0.8408964276313782, 0.8908987045288086, 0.9438742995262146, 1,
  1.0594631433486938, 1.122562050819397, 1.1892070770263672, 1.2599210739135742,
  1.3348398208618164, 1.4142135381698608, 1.4983071088790894, 1.587401032447815,
  1.6817928552627563, 1.7817974090576172, 1.8877485990524292, 2,
];

/** 1 for 0 and anything outside −12…12. [gdp FMODAudioEngine::pitchForIdx :64678-64686] */
export function pitchForIdx(idx: number): number {
  return idx === 0 || idx < -12 || idx > 12 ? 1 : PITCH_RATIOS[idx + 12];
}
