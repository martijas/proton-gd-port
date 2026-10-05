# Autoplayer macros

One `<levelId>.json` per official level the autoplayer (`test/bot.ts`) has
finished, written by

```
npm run bot -- <levelId|all> --save
```

`test/levels.test.ts` replays every macro here on each `npm test` run and fails
when one stops finishing. It also prints the first 60-tick checkpoint whose
`(x, y)` is more than 0.01 units off, whether or not the run still finishes —
that pinpoints where a physics change first moved it. The search itself only
runs with `GD_BOT=1`.

`<levelId>.best.json` is the furthest attempt at a level the autoplayer could
not finish, written by `--save-best`. Nothing tests it; watch it with
`debug.html?level=<id>&macro=best`. With `--save-best` a run also writes its
furthest death so far to `test/deadends/<id>.json` at every dead end, so a
long run that is stopped keeps what it found. Watch a running solve with
`npm run dev` and `debug.html?level=<id>&macro=deadend`: it replays the last
5 s before that death (`&tail=<seconds>` changes it, 0 plays it all) and
loads each new one as the solve writes it. `macro=best` reloads the same way,
and `level` also takes an online level saved in `test/levels/`.

`--from=<tick>` replays `<id>.best.json` (or the macro) up to that tick and
searches on from there, keeping those inputs in front of whatever it saves.
It resumes a long run from its last dead end, or takes a route the search
keeps passing by: write the inputs that take it into `<id>.best.json` and
start after them.

`--threads=<n>` spreads the search over `n` worker threads
(`test/botParallel.ts`). Each worker keeps its own sim and the snapshots of
the nodes it expanded; the main thread keeps the beam and moves snapshots
between workers when one holds well over its share. It saves the same
inputs as one thread for the same settings (checked on levels 3, 9 and 13
with 3 to 12 threads), only reaching them about 2x faster with 8 threads.
Each worker also holds its own copy of the level, about 1 GB for Society.

A level can also be played by hand: `npm run dev`, then
`manualmacro.html?level=<id>`. "Start from" plays the furthest attempt or
the saved run up to a chosen tick, so only the hard part needs playing (or
add `&from=<tick>` to start there from the furthest attempt). C sets a
practice checkpoint and R goes back to it, the recording rewinding with the
player. A run that finishes is sent to `test/record-manual.ts`, which
replays it as the tests do and only then writes `<id>.json` (its
`botInfo.name` is `manualmacro`). The furthest-attempt file goes with it,
and the macro it replaces is kept as `test/_bak-<id>-before-manual.json`.
The page uses the macro's seed, or 1 if it has none.

## Format: `pcgd-macro` v1

A superset of GDR (`gdr2`), so the `inputs` block can be fed to xdBot/zBot to
check a run against the real game (`toGdr()` in `bot.ts` strips the extras).

```json
{
  "format": "pcgd-macro",
  "version": 1,
  "levelId": 1,
  "levelName": "Stereo Madness",
  "framerate": 240,
  "simHash": "8c1f2a90",
  "botInfo": { "name": "pcgd-autoplayer", "version": "1" },
  "inputs": [
    { "frame": 412, "button": 1, "player2": false, "down": true },
    { "frame": 416, "button": 1, "player2": false, "down": false }
  ],
  "completedFrame": 21432,
  "checkpoints": [{ "frame": 240, "x": 1246.5, "y": 105, "yVel": 0, "mode": "cube" }]
}
```

- `frame` is the 240 Hz tick the input first applies to; `button` 1 = jump,
  2 = left, 3 = right (platformer only).
- `simHash` hashes the physics constants (`PHYSICS` in
  `src/physics/constants.ts`) and the object table: each id's kind, hitbox,
  special block, orb and pad. A mismatch on replay
  prints a warning: the macro may still pass, but if it fails, re-solve rather
  than chase the divergence.
- `checkpoints` are the player's state before stepping every 60th tick.
- `completedFrame` is null in a `.best.json`.

Regenerate a macro with `npm run bot -- <levelId> --save`; replay one without
searching with `npm run bot -- <levelId> --replay`.

After a physics change, replay everything first. A macro that still finishes only
needs its stamp refreshed:

```
node --import tsx test/restamp-macro.ts <levelId> [levelId...]
```

which keeps the inputs and rebuilds the checkpoints and `simHash`. Only macros
that stop finishing need the solver again — and the solver failing on a level
whose old macro still replays is a search limit, not a physics regression.

## Where each level stands

The physics accuracy pass (`data/ref/gd-discrepancies.md`) broke every macro,
and all of them were solved again from nothing on 2026-09-25. Goal 6's fixes
from `data/ref/boomlings-notes.md` came next, and on 2026-09-29 every level
was checked again: the twenty macros that still finished were re-stamped,
Deadlocked and Fingerdash were solved again, and Dash and the four tower
floors were searched again for up to two hours each. Unless a note says
otherwise, the default search finished the level on its first run.

| id | level | macro | notes |
|---|---|---|---|
| 1 | Stereo Madness | finishes, tick 20576 | |
| 2 | Back On Track | finishes, tick 19516 | |
| 3 | Polargeist | finishes, tick 21547 | |
| 4 | Dry Out | finishes, tick 19435 | |
| 5 | Base After Base | finishes, tick 20022 | |
| 6 | Cant Let Go | finishes, tick 19283 | |
| 7 | Jumper | finishes, tick 20684 | |
| 8 | Time Machine | finishes, tick 22963 | |
| 9 | Cycles | finishes, tick 18931 | |
| 10 | xStep | finishes, tick 19508 | |
| 11 | Clutterfunk | finishes, tick 22957 | |
| 12 | Theory of Everything | finishes, tick 19928 | |
| 13 | Electroman Adventures | finishes, tick 20308 | |
| 14 | Clubstep | finishes, tick 20774 | the solver's first finish; see below |
| 15 | Electrodynamix | finishes, tick 19429 | |
| 16 | Hexagon Force | finishes, tick 21235 | two dead ends at tick 13204, cleared by backing off and widening |
| 17 | Blast Processing | finishes, tick 23875 | `--D=2`; see below |
| 18 | Theory of Everything 2 | finishes, tick 21346 | |
| 19 | Geometrical Dominator | finishes, tick 23255 | first finish; `--W=512 --maxW=8192`, 21 minutes |
| 20 | Deadlocked | finishes, tick 24343 | first finish; `--W=512 --maxW=8192 --ticks=2e9 --ms=1800000`, 19 minutes, no dead end |
| 21 | Fingerdash | finishes, tick 20610 | `--ticks=2e9 --ms=900000`, about 450 s; the default 90 s was too short |
| 22 | Dash | finishes, tick 21462 | first finish; `--N=101 --D=8 --W=384 --maxW=2048 --ticks=4e9 --ms=5400000`, 12 minutes; see below |
| 3001 | The Challenge | finishes, tick 5576 | |
| 5001 | The Tower | best 38.5 % | the platformer guide; see below |
| 5002 | The Sewers | best 4.6 % | the same |
| 5003 | The Cellar | best 1.6 % | the same |
| 5004 | The Secret Hollow | best 14.1 % | the same |

Every `.best.json` above was recorded on 2026-09-29. The final check then
made the toggle block (3643) a custom ring, which changed the object table and
so every stamp: all 27 files were re-stamped, each with its inputs and
checkpoints unchanged, and the best attempts still end where they did.
The Tower's and The Sewers' were recorded again on 2026-10-02.

## Levels with a story

- **14, Clubstep.** Its earlier macro was never the solver's: goal 1 produced
  it by re-stamping older inputs, because the search dead-ended at 40.1 %,
  where a mini cube meets a seven-block wall at x = 10851. Once those inputs
  stopped finishing it was retired. On the new physics the default search
  finished the level first time.
- **17, Blast Processing.** Every other setting that ran to the end
  dead-ended at 78.2 %, a flipped ball in the ceiling spikes at x 24234. The finishing run stays a
  wave from x≈13323 to the end and passes the late UFO, ship and ball portals
  without taking them; the other settings lost that route when UFO nodes
  filled the beam after the UFO portal. The intended route through those
  portals was impossible then: a flipped ball let go of the ceiling slopes at
  x≈24086 and left them too slowly to reach the blue orb at x 24255. That is
  the slope fix above, so a re-solve could now find it.
- **19, Geometrical Dominator.** Its door at x 27690 (groups 82 and 83) is
  opened by a touch-triggered spawn through group 85's two once-only moves,
  which never fired until the spawn fix; the best run died against it at
  85.4 %. Solved again afterwards, it finishes for the first time.
- **20, Deadlocked.** Two port bugs stopped it in turn. A linked teleport put
  the player at its own height plus the offset, which dropped it under the
  floor at x 16035; then a ship teleported by #11697 at x≈20860 landed on
  spikes #11700/#11701 at 58.5 %, because the teleport portals' box sat 12
  units off. With both fixed it finishes for the first time. The default 90 s
  ran out at 33.8 % with the beam still alive; the wider run never needed more
  than W=512 and met no dead end. Its route stays inside the level: the lowest
  checkpoint is a mini wave at y 9 in a teleport section, the highest a ball
  at y 407, and it ends as a cube on the ground.
- **21, Fingerdash.** Its first macro finished the level from thousands of
  units up in empty sky, before the level had a ceiling, and was retired when
  the ceiling went in. The next finished honestly, but its inputs went stale
  under goal 6's fixes: it died at 8.0 % on hazard #1403 at x≈2205. Solved again, it
  needed only the time — the default 90 s stopped at 32.4 % against the block
  wall at x 8910 with no dead end.
- **22, Dash.** Trigger channels, the force fields, the corridor's band under
  a Static Camera and the rotated climb each stopped it in turn (the climb at
  x≈16131 needs `--N=101`, because walking up the wall scores below nodes
  about to die). The last best attempt died at 67.7 % in that climb; with the
  beam's slots spread over each mode, size and gravity, the same settings
  finish the level for the first time, wavy ship tunnel included. The tunnel's
  two Area Move triggers centre on the player with a 90-unit dead zone and
  only bend the walls away from it, so the blocks the player can touch stand
  where they were placed. Area triggers are built now, and the same macro
  still finishes at tick 21462 with the walls moving.

## Physics root causes found by hard levels

A dead end where every branch dies, on a level people have beaten, is read
as a physics fault. Each one found that way:

- **Slope edges (Society, x 8590).** A slope's straight sides were met as the
  whole slope box, a stand-in for `preSlopeCollision`. The game meets them as
  one-unit strips: the vertical side only for a player moving toward it, the
  flat side only for a player past it, and the slope the player last stood on
  skips both. The old box pushed a UFO down off the tip of a ceiling slope it
  was moving away from, and the squeeze test killed it. Hexagon Force, Blast
  Processing and Theory of Everything 2 had leaned on the old box and were
  solved again.
- **Platformer boost.** A boost now also ends in a platformer once the player
  stops rising (`playerIsMovingUp`, which was taken to be missing).
- **Ship on a downhill floor slope.** The few units of attach tolerance above
  the surface caught a ship only while the button was held; the game catches
  it only while it is released (`+1961 ? !+1909`). Found while checking the
  wave branch for Sonic Wave; Bloodbath's ship moved 0.14 units and its macro
  was re-stamped.
- **Still on a slope.** A player that was on a slope last tick meets every
  slope by the relaxed edge test, as the game does, not only the one it was
  riding. The narrower rule was added for a Hexagon Force fall that the
  slope-edge fix has since removed; every macro replays unchanged.
- **Not every dead end is physics.** Sonic Wave's 57.8 % came from the solver
  running out of memory while reopening before the gravity portal at x 20865.
  A narrow search shows the upright wave clears the slope corridor
  (x 24000-25500) and reaches the cube at x 26265, which needs it upright.
  The slope orientation (`determineSlopeDirection`, all sixteen flip and
  quarter-turn cases) and the wave's slope death were checked against the
  game and match.
- **Moving platforms.** Blocks and slopes moved by triggers did not carry the
  player at all. Now a block or slope rising under the feet widens the catch
  by its speed and the player takes that speed (`+1328`). When it stops or
  slows by more than 0.5, the player is launched with its last speed, capped
  at 20, unless the object has "don't boost Y". A block moving away from the
  head pins the player under it. Deadlocked's ship now takes the speed of a
  rising block it bumps, so its route was solved again. Every other macro was
  re-stamped.
- **A move counts only in the step it happens.** Read literally, the game
  never refreshes an object's last position (`+1052`) while it stands still,
  so every object would carry its last move for good. The first version did
  that, and Yatagarasu fell from 80 % to 6 %. That level moves a whole section
  750 down at once (x 2775), so every slope in it kept catching the UFO from
  1.25 farther, right onto the spikes lying on the slopes at x 3700. A
  platform moving at a steady speed would also never launch the player when
  it stopped. A move now counts only in its own step, and a silent move (key
  544) leaves no motion at all (`moveObjectsSilent` puts the last position
  where the object lands). Geometrical Dominator moved 0.07 and was
  re-stamped.
- **A decoy route is not physics either (Yatagarasu, x 59900).** The best
  run died at a column of overlapping saws from the floor to above the
  ceiling, which nothing gets through. The level's route leaves the ball
  corridor at x 37643: a cube portal and a teleport (exit 1226 lower) sit in
  the middle of the corridor, and a ball riding the ceiling passes over both.
  That ceiling ride goes on for 22,000 units before the saw wall, far past
  any backoff. Any single tap from tick 25456 to 25530 (x 37567-37645)
  takes the portals and lands alive on the real route at y 0-300, but even
  with the beam's slots spread over each mode, a run started at tick 25280
  rode the ceiling past them again and reached 99.2 % at the same wall. The
  route is now forced with `--from`: the best attempt's inputs up to tick
  25480 plus that tap, and the search runs on from tick 25700.
- **Time Warp (Dash, first swing portal).** The trigger's value was stored
  and nothing read it, so Dash's slow-motion spotlight before the swing
  portal played at full speed. In the game a warp below 1 does not skip
  frames. Each 240th-of-a-second step covers only `warp × 0.0041667` seconds
  of game time (`getModifiedDelta`). The player, collisions, rotation, camera,
  moves, spawns and tweens all take that shorter step, while the music and
  the level timer keep real time. Timers measured in ticks (dash orbs, landing
  and flip grace, slope ends, spider flips) now read the player's game clock
  instead. A warp above 1 adds steps per frame, which the sim does not do;
  no level here needs it. Only Dash and Society use the trigger. Society's
  warp at x 40541 lies past its best run; every other macro replays
  unchanged. Dash's old macro no longer finished, and a 90-minute solve from
  tick 3500 stopped at 83.7 % in the robot section at x 20175. Its macro is
  now a run played by hand on `manualmacro.html`, finishing at tick 21707.

## Online levels

`node --import tsx test/fetch-online-level.ts <id>` saves an online level to
`test/levels/`, after which `run-bot.ts <id>` solves it like an official one.
Nothing in `npm test` replays these.

- **10565740, Bloodbath** (Riot, extreme demon): finishes, tick 27487, with
  `--W=512 --maxW=8192 --ticks=4e9 --ms=2400000 --normalSizeAfter=35560`, in
  136 s. The default route dead-ends at 99.1 %: the search skims a mini ship
  over the flat normal-size portal at x 35505, and the end's invisible triple
  spike (x 38952-39018) is 84 units long, where a mini cube's jump stays clear
  for only 74 — the level means it for a full-size cube. With mini nodes
  dropped past the portal, the run takes it and finishes by the Easter-egg
  route: a jump after Ggb0y's blue pad onto the GG sign, which reveals
  "Michigun". The game ships it as a playable last level-select page, the
  online demo level (`src/game/demoLevel.ts`), and `macroverify.html` lists
  this run with the official ones.
- **127323087, Society** (Neomarbilan, extreme demon): finishes, tick 32693,
  solved in stages with `--seed=12345` and `--from`, the last from tick 22680
  with `--W=384 --maxW=2048 --threads=4` in 35 minutes. The first Advanced Random (#149921, weights
  149:1, 150:666) takes its rare trap path on seed 1 — group 151, and with it
  the opening teleport, stays off — so the run is solved and replayed with
  seed 12345 (the macro's `seed` field). Without the seed the run dies at
  tick 61 with the controls off, which looks like a physics fault but is the
  trap. Its first dead end, the spike "M" floor and "V" ceiling at x 8590,
  was the slope-edge fault above. The next, the mini-UFO zigzag at x 9100,
  was the solver's: the band between the spikes is lower than a tap's arc
  unless a second tap comes two ticks after the first, which peaks 7 units
  lower, and the beam merged the two because it bucketed y velocity in
  eights. A UFO, ship or swing is now bucketed in halves. An exhaustive search
  of every tap timing from tick 6330 finds the way through, onto the red orb
  at x 9206. The dead end after it, at x 9316, was the solver's too: one exact
  line gets through, and a full beam kept pruning it. At a new furthest death
  the search now first reopens from that death's own line 120 ticks back,
  alone (`focusBack`). The next one, at x 9954, was a route the search
  committed to 216 ticks earlier. The lower lane under the wall at x 10020
  fits only a big UFO that turns mini at the portal inside it (x 10013), so
  the player has to touch the small normal-size portal at x 9549, beside the
  gravity portal. The mini lines that ducked under it outscored the big ones
  and filled the beam. The beam now spreads its slots over each mode, size
  and gravity separately, and from tick 6550 the search takes the portal and
  passes x 13300. Its next wall, x 29722, was the solver's: an exhaustive
  search from tick 16450 got through to x 30300, and with those inputs
  written into `127323087.best.json` the solve reached 80.7 % (tick 23024,
  x 40485, a spike on the ground after a long cube run), and from there it
  finishes. Society is heavy: at `--W=384 --maxW=2048` the search settles at
  about 18 GB, most of it the trigger state each kept node's snapshot
  copies, with or without `--threads`.
- **28220417, Yatagarasu** (TrusTa, extreme demon): finishes, tick 42243, with
  `--from=25700 --W=512 --maxW=4096 --ticks=20e9 --ms=10800000` and a 6 GB
  heap, in 115 minutes. The start is the forced tap into the cube portal and
  teleport at x 37643 (see the decoy route above); without it the run rides
  the ceiling to the saw wall at 99.2 %.
- **26681070, Sonic Wave** (Cyclic, extreme demon): finishes, tick 29764, with
  `--W=512 --maxW=4096 --ticks=1e10 --ms=10800000 --backoff=8000
  --ringSize=60` and a 10 GB heap, in 43 minutes. The earlier runs at
  `--maxW=8192 --ringSize=110` ran out of memory while reopening before the
  gravity portal at x 20865.
- **4284013, Nine Circles** (Zobros, extreme demon): finishes, tick 20938,
  with `--W=512 --maxW=4096 --ticks=4e9 --ms=3600000`, in 95 s, but by a skip.
  Five portals stand on one spot at x 29265 (cube, blue gravity, normal size,
  2x speed, dual off). Player 1 comes down onto the stack and its edge reaches
  only the size and dual-off portals, which are 2 units taller than the cube
  portal. Ending the dual in player 1's pass means player 2 is never moved or
  checked that step, as in the game (`v106 && +870`, gd-ida-decomp.cpp
  :469926), so nobody takes the cube portal. The run finishes the last 15 %
  as a flipped 3x wave along the top of the corridor, above the cube section.
- **42584142, Bloodlust** (Knobbelboy, extreme demon): in progress. Its long
  wall at x 28196 was a trap the search kept walking into, not physics. At
  x 27470 the dual starts with both mini balls on one spot, and both take
  the blue gravity portal at x 27493 in the same step, so the linked dual
  leaves player 1 upside down (each player's touch turns the other over).
  Player 1 rises into a teleport at x 27525 that, like the tunnel of blue
  orbs and slabs it leads to, sits in group 802, which an Alpha trigger at
  x 26144 hides. Up there the ball is held at y 501 between the slabs and
  the dual band's ceiling (240-510), and the tunnel ends in a wall at
  x 28200: it is only somewhere to keep player 1. Player 2 has to cross the
  lower lane alone, without a press that sends it into the same teleport,
  and reach the solo portal at x 28109, where player 1 takes its place
  (`toggleDualMode`), then the cube portal and the teleport down to y 175.
  Both players share one x, so a line with player 2 also in the tunnel
  lives until the wall and outscores every line where player 2 dies in
  the lane; the search never kept one. A search over player 2 alone (taps
  every 2 ticks from tick 20672, any line with player 2 above y 470 dropped)
  finds the way to the solo portal at tick 21208, and from there the solve
  carries on with `--from=21210`. That run stopped at 66.3 % (tick 29952,
  x 40637): a mini cube on a block top at y 270 meets three floating
  spikes at x 40575-40635 that a mini jump cannot clear. It is the same
  trap as Bloodbath's end: the mini wave from x 36712 is meant to drop
  through a flat normal-size portal (with a gravity portal) at
  (37125, 105), whose turned hitbox spans y 90-120, and the search kept a
  line that zigzags above it at y 134 and up. With `--from=26800
  --normalSizeAfter=37150` the wave takes the portal and reaches x 37603 at
  normal size, and the solve stops at 68.7 % (tick 30948, x 42122): an
  upside-down ship crosses four orbs, three of them scaled 2x (72-unit
  hitboxes), where any press fires one, and then needs a 60-unit gap
  between spikes at x 42075-42107. The game is right there (scale counts
  in `getObjectRect`, and a flying player only takes a ring on a fresh
  press); the search just ranked the few lines that leave the orbs slowly
  out of the beam. A search that merges only equal states (height, speed,
  hold, which orbs were used) from tick 30800 finds one through to x 42451,
  and the solve carries on with `--from=30960`. It stops at 69.3 % (tick
  31121, x 42459). Past the gap, ceiling slopes push the ship down to the
  floor at y 153 whatever it does, two 63° slopes lift it, and a blue orb
  at x 42255 turns it over. The way on is the upside-down yellow pad in the
  flat mini portal at (42345, 328): it throws a turned-over ship down into
  the pocket at x 42390-42540 (checked: -12.8, then the mini cap). The ship
  has to touch it, centre at y 317 or more by x 42366, and the best line
  any search finds is at about 311. The pieces on the way, which are the
  slope's corner snap, its exit speed (`getModifiedSlopeYVel`), the pad's
  rect and the caps, all match the decomp, so the missing height is still
  open.

- **149992717, GRIEF** (IcEDCave, extreme demon): in progress. A two-player
  wave start, 189,416 objects, about 55,700 units long, with three dual
  sections (from x 14093, 30165 and 36090). The search steps both players
  with the same input, so a dual that needs them apart is out of its reach.
  The first run (`--maxW=2048 --ticks=2e10 --ms=10800000`, 8 GB heap) took
  18 minutes to its first dead end at tick 2804 (x 3210, 5.8 %): every wave
  line meets slope #4889 (obj 326) at (3210-3240, 90-120), among blocks and
  slopes moved by groups 81, 82 and 86. The sim runs at about 3,600 ticks/s
  here; the search's width is what makes it about a level-second every six
  minutes.

## Levels with no macro

- **5001-5004, the tower floors.** The End trigger works — each floor ends
  when its touch-triggered spawn fires it — and none of the four fails on
  the physics or the triggers as far as was checked. They fail on the
  autoplayer's `PlatformerGuide`, a search over 30-unit cells that aims at
  the End object rather than the spawn that fires it, counts the space
  outside the level as open, counts one-way platforms, doors and switched
  walls as solid for good, and knows nothing of teleports. More width, depth
  or time does not change how it scores a cell. With the default `--D=4`,
  walking right ties with jumping in place until the next cell, so the beam
  barely moves; `--D=16` to `--D=28` avoids that. Per floor:
  - 5001, The Tower: a three-hour run on 2026-10-02 saved 38.5 % (tick 5251,
    small spike #4765 at x 6158) over an earlier 39.0 % (tick 8622, spike
    #4792 at x 6255); `--save-best` now keeps the further file. That file
    only keeps the furthest death: the live
    beam of the same run reached x 13290 (tick 11648) without finishing. The
    end door at x 9930-9960 (group 237) opens by toggle #8622 on the music
    clock at about 31 s; the guide counts it solid for good, so only a step of
    30 units or more crosses it, which needs `--D` of about 24, while `--D=30`
    and up stalls at the house door (x 8280). Only `--D=28` with W=256 or 512
    gets past both. The finish is touch spawn #8587 at (10151, 591) behind the
    door, whose ordered spawn fires End trigger #8876 about 10 s later; the
    beam held nodes that had touched it and pruned the last of them, outscored
    by nodes heading for the End object itself. From the solver's own state at
    the door, holding right finishes the level at tick 11210.
  - 5002, The Sewers: runs died at 8.4 % (tick 1333, spike #1323 at
    x 1515); a three-hour run on 2026-10-02 did worse, 4.6 % (tick 652,
    spike #679 at x 825), and its file replaced the old one. The guide's path runs down into the spike pits and under the
    level to the End object; the route climbs instead, under the crusher
    pillars and up the pad shaft at x 1455/1515 to trigger orb #1728 at
    (1579.5, 1065), whose group leads to the teleport into the tall room at
    (1845, 135). That orb did nothing until the final check fixed it (see
    `data/ref/boomlings-notes.md`); what comes after the tall room is not
    checked.
  - 5003, The Cellar: 1.6 %. The guide's shortest path goes over the start
    room's left wall, so the cube jumps against it at x 90-150 and never dies.
    The route goes right, up the stairs at x 495-555, through robot portal
    #1476 at (1145, 255) and up the tower at x 1200-1710, whose one-way ledges
    and moving parts (groups 12-18) read as solid; the End trigger is fired by
    touch spawn #7029 at (8866.5, 1220.5). Played by hand, holding right and
    jump climbs the stairs, turns robot and walks the tower floor to x 1695.
  - 5004, The Secret Hollow: 14.1 % (tick 22962, spike #2641 in the pit at
    x 4665). The route climbs a ladder of one-way blocks at x 4548-4578 and
    walks the box roof to a touch spawn at (5025, 615) that teleports the
    player to (5505, 585); the guide scores every spot on the ladder 0, so the
    beam never keeps a climber. Scripted by hand from the run's own state, that
    climb and teleport work, and a start beside the finish's touch spawn at
    (14291, 881) completes the level.

  What the guide needs: aim at the touch spawn that fires the End and keep a
  node that has touched it alive for the spawn's delay; treat one-way blocks
  and groups a toggle or move switches off as passable; stop counting the
  space outside the level as open; follow teleports.
