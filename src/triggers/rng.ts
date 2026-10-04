// The game's random numbers, and why a port can reproduce them.
//
// Everything random in a level — the Random trigger, Advanced Random, the
// spawn-delay jitter — draws from one global linear congruential generator.
// The important part is not the generator, it is that the game *seeds it per
// attempt and stores the seed in the replay string*, which is exactly what a
// recorded macro needs to replay identically. So this takes a seed rather than
// reading the clock, and the sim hands it one.
// [gdp GameToolbox::fast_rand, gd-ida-decomp.cpp:43866-43911; the per-attempt
// seeding and the replay seed field at PlayLayer :105790-105797 and :438492]

const MULTIPLIER = 214013n;
const INCREMENT = 2531011n;
const MASK = (1n << 64n) - 1n;
/** fast_rand returns 15 bits. */
export const RAND_MAX = 32767;

/**
 * The game's LCG. It is 64-bit and the output is bits 16..30, so the low bits
 * that a 32-bit LCG would expose are never seen. BigInt keeps the multiply
 * exact; it is called a handful of times per level, not per tick.
 */
export class Lcg {
  private s: bigint;

  constructor(seed: number) {
    this.s = BigInt(seed >>> 0) & MASK;
  }

  get seed(): number {
    // Only the low 32 bits are ever needed to restore a stream, because the
    // state above them can never reach the output window in one step.
    return Number(this.s & 0xffffffffn) >>> 0;
  }

  /** Restores a stream captured by `seed`. */
  setSeed(seed: number): void {
    this.s = BigInt(seed >>> 0) & MASK;
  }

  clone(): Lcg {
    const out = new Lcg(0);
    out.s = this.s;
    return out;
  }

  /** fast_rand: 0..32767. */
  next(): number {
    this.s = (this.s * MULTIPLIER + INCREMENT) & MASK;
    return Number((this.s >> 16n) & 0x7fffn);
  }

  /** fast_rand_0_1. */
  next01(): number {
    return this.next() / RAND_MAX;
  }

  /** fast_rand_minus1_1. */
  nextSigned(): number {
    return 2 * this.next01() - 1;
  }
}
