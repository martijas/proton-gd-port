// Mana orbs: what a level pays for getting further into it.

/**
 * An online level's base by its stars, from 2 to 10; fewer pay nothing. The
 * game reads these from a table the decompile does not show (aD_0); these are
 * the amounts players have long recorded, a fifth under the totals the level
 * page shows. [gdp GameStatsManager::getBaseCurrency :342964-342968; guess]
 */
const ONLINE_BASE = [40, 60, 100, 140, 180, 220, 280, 340, 400];

/**
 * The orbs a level gives for its whole run, before the quarter more a
 * completion adds: an official level twenty a star and twenty more, or 400
 * for the three the game singles out; an online one by its stars.
 * [gdp GameStatsManager::getBaseCurrency :342949-342970]
 */
export function baseOrbs(id: number, stars: number, official: boolean): number {
  if (official) return id === 14 || id === 18 || id === 20 ? 400 : 20 * stars + 20;
  return ONLINE_BASE[stars - 2] ?? 0;
}

/** What a best of `best` % has paid in all. [gdp getAwardedCurrencyForLevel :343034-343075] */
export function awardedOrbs(base: number, best: number): number {
  return best > 99 ? Math.trunc(base * 0.25) + base : Math.floor(base * (best / 100));
}

/**
 * What reaching `percent` pays when `paid` % has been paid for already: the
 * share of the base the new percentage is worth, a quarter more at 100, less
 * what the old one was worth. An unrated level pays nothing.
 * [gdp GameStatsManager::awardCurrencyForLevel :356267-356340]
 */
export function orbsFor(base: number, stars: number, paid: number, percent: number): number {
  if (stars <= 0 || percent <= 0) return 0;
  const to = Math.min(100, percent);
  if (paid >= to) return 0;
  const b = Math.fround(base);
  const before = Math.floor(Math.fround(b * Math.fround(paid / 100)));
  let after = Math.floor(Math.fround(b * Math.fround(to / 100)));
  if (to === 100) after = Math.trunc(Math.fround(after + Math.fround(b * 0.25)));
  return Math.max(0, after - before);
}
