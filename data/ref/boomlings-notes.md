# boomlings.dev, checked against the game (research, 2026-09-27)

boomlings.dev is a community reverse-engineering wiki for Geometry Dash: player physics, the level
and save formats, the server endpoints and their encryption, the song and SFX libraries, the shop
and the vaults. It is a VitePress site built from github.com/gd-docs/gd-docs (`docs/**/*.md`); the
four player-physics pages were added on 2026-04-01 and have barely changed since. Checked on
2026-09-27, page by page, against the 2.206 decompile (`gd-ida-decomp.cpp`, cited as `IDA:line`),
the PC `GeometryDash.exe` where the decompile hides a value, and the port's own level loader
(`test/helpers.ts` `loadOfficialLevel`).

**The wiki is a lead, not ground truth.** Where it and the decompile disagree, the decompile wins;
where the decompile agrees with the port, the wiki is the one that is wrong or out of date. The
port's `[boom]` constants came from its physics pages, and one of those measurements (the flying
"press delay") was already wrong: gd-discrepancies §2.

**Status: #2-#6, #8 and #33-#35 are fixed (trigger runtime, 2026-09-28); #1 and #7 are fixed (force
blocks and squeeze, 2026-09-28); #31 and open items 1-3 below are fixed (End trigger, channels and
teleports, 2026-09-28); #32, #36, #37 (bar kA33 and kA43-kA45) and #38 are fixed (level format and
start state, 2026-09-28); #23-#30 are fixed (rendering and colours, 2026-09-29; #26's types and
#30's live colours completed after review the same day); #14-#22 are fixed (audio, 2026-09-29);
#9-#13 are fixed (save, progression and HUD, 2026-09-29). The remainders the entries left open
were closed on 2026-09-29 (completeness pass): #1's +2372 slide, #5's moved members, #8's Event
trigger, #18's 0.2 s hold, #20's reverb, #26's 522/523, #30's object transform, #33's per-member
follow, #34's easing and padding, #36's single warm-up and #37's kA33, kA44 and kA45.**

**Final check, 2026-09-29: all 38 entries and the five open items are fixed**, each marked where
it starts. `tsc`, `npm test` (844 tests, 812 pass, 32 skipped by design: the 27 autoplayer searches
behind `GD_BOT=1` and the five levels with no finishing macro) and `npm run build` are clean. What is
still not done, by entry:
- #1: the rest of `updateMove` (ice, and the slope and boost slides +2240/+2248/+2312) is the port's
  measured ramp.
- #2: Dash's Item Compare #17924 waits on the Touch trigger (1595), which is not built.
- #4: the Secret Hollow's four Follows on group 563 copy two Advanced Follows (3016), not built.
- #7: moving solids still collide as static blocks where they now are; the moving-object branch of
  `collidedWithObjectInternal` waits for a port of the whole function.
- #8: the sim raises the button, coin and pickup events, not the landings, robot boosts, orbs and
  pads the tower floors also listen for.
- #13: Show Time (gv 0145), the platformer's HUD label, is not built.
- #16: the fixed 0.5 music level that pulses read in practice is not built (the port has no
  metering).
- #20: FMOD's reverb is approximated by convolution with an impulse built from the preset.
- #21: the physics half of the time warp (`registry.ts` 1935) is not built, so Dash's 0.2 warp at
  x 4535-4615 plays at full speed.
- #34: the platformer camera is not built. (The flying corridor's lock is the game's own since
  2026-10-01: the corridor takes the static y.)
- #37: kA43, which only a saved platformer score reads; the port saves none.

Found by the final re-solve and fixed in the final check: **a trigger orb (1594) did nothing to its
group.** `ringJump` hands a custom ring to `activateCustomRing` (IDA:159943-159945 →
439065-439098): with key 504 it spawns group 51, otherwise `toggleGroupTriggered` switches it on
and spawns it by key 56, or switches it off (keys from `RingObject::customObjectSetup`
IDA:302960-302990). The port fired the orb and dropped the group (`TriggerRuntime.customRingActivated`,
`test/items.test.ts`). It kept The Sewers' route shut at orb #1728 (1579.5, 1065), whose group 69
leads to the teleport into the tall room; Dash's nine orbs at x 3255-3675 switch its small spikes
off, and #11607 (x 13335) spawns group 369. The toggle block (3643) is the same custom ring, 30 × 30
and hidden in play (`GameObject::customSetup` IDA:178493-178499); the port had it as a kind of its
own that nothing read, and it now is a toggle orb. The Cellar places two (#3238, #3273 at y 1665)
and The Secret Hollow one (#9689 at x 9015). The object table changed with it, so the stamp of
every macro moved; the 22 finishing macros and the five best attempts were re-stamped, each with
its inputs and checkpoints unchanged.

"Port:" lines give the source as of 2026-09-27; paths are under `src/` unless they start with `tools/`, `test/` or `data/`. Level counts
come from scratch scripts run on the port's loader (session scratchpad `boom/*.mts`, which may not
survive). Every entry is a claim that was re-derived from the decompile and came out confirmed or
partly confirmed; where only part held, the entry says what is actually true.

---

## Port bugs

### Tier 1 — changes how levels play

#### 1. Force blocks (2069) and force circles (3645) do nothing
Confirmed. Not in gd-discrepancies. **Fixed 2026-09-28** (`test/force.test.ts`). Corrections of
detail: calculateForceToTarget's "0.017453" is π/180 as a float (the exe holds π/180 and no
0.017453), and the float 90° is a hair past π/2, so an upright block also pushes −4.4e-8 × F
sideways. The mini factors are the floats of 0.47/0.8, 0.58/0.8 and 0.4/0.65: the decompile prints
them to five figures, and the exe holds 3f166666, 3f399999 and 3f1d89d9 but neither 0.725's float
nor 0.61538's. The counter is set before the force-ID check (IDA:159679). Upside down a push away
from the floor is negative, so the robot-hold accumulator falls: the push gives the hold back
(IDA:161405-161424). In a platformer a sideways push over 0.1 also spins a cube that is not already
spinning (`runNormalRotation(1, 1.0)`, IDA:161419-161420), and the wave ignores its y velocity there
too. The platformer flag +2372 the x push sets (`Player.forceSlide`) was added on 2026-09-29: while
it is set `updateMove`'s branch replaces the port's measured ramp, the x velocity losing 0.05 of itself
per 60th of update's 0.9 step with boost slide (+2072 = !kA45) or a button held, 0.2 otherwise, a
held button steering only below the top speed and never clamping to it, and the flag clears under 0.5
(IDA:149234-149236, 149258-149286, 149433-149455). The rest of `updateMove` (ice, the slope and
boost slides +2240/+2248/+2312) is still the measured ramp.
- Game:
  - Setup (`ForceBlockGameObject::customObjectSetup` IDA:301266-301306): key 149 force, 526/527
    range min/max, 528 relative, 529 range mode, 530 force ID.
  - Both are type 40 (the port's own `gameObjectTypes.ts:2103, 3679` agree). The collision pass
    tests a rect, a circle for 3645, an OBB off 90° (IDA:463456-463478), then calls
    `touchedObject` (IDA:463812-463813): +2360 = 2; a force ID (> 0) already counted this pass is
    skipped; `calculateForceToTarget` is added to the vector at +2364, length capped at 9999
    (IDA:159676-159697).
  - `calculateForceToTarget` (IDA:312994-313089): angle 90 − rotation, +180 with flipY. Relative
    mode pushes away from the object (pulls with flipY). Range mode lerps key 526 → 527 across the
    object and ignores 149. The distance it lerps over (v8, IDA:313025-313036) is the radius for a
    circle, else half the longer side of `getObjectRect`, which for an oriented object is the
    bounding rect of its turned box (`getObjectRect2` IDA:170950-170967 via `getOuterObjectRect`
    IDA:170928-170934): 21.2 for a 30 block at 45°, not 15. No official level has a turned
    range-mode block; the two range-mode objects are circles.
  - `PlayerObject::update`, after `updateJump`, unless +2360 ≤ 0 (IDA:161032):
    `addToYVelocity(dt·0.9·Fy·factor)`; factor ship .47, UFO .58, swing .4, ball/spider .6, robot .9,
    cube/wave 1; mini ship .5875, UFO .725, swing .61538 (IDA:161358-161404). It sets the
    accelerating flag +1858, so a pushed ship, UFO or swing loses its caps. An up-push adds
    v/12.94·1.5 to the robot-hold accumulator +1680 (IDA:161424). In a platformer the x part goes to
    +2216 (IDA:161412-161420). `updateStateVariables` (IDA:153698-153718) counts +2360 down and
    clears the vector: a touch in pass N pushes in update N+1, and the push ends one update after
    contact.
  - Cube, 240 Hz: 0.225·F·cos θ per tick, rounded to 0.001 by `setYVelocity` (IDA:141992). The wave
    does not move vertically under it in classic (IDA:161045-161075). The push lands on yVel, which
    is world x while gameplay is rotated (IDA:161076-161081).
- Port: `physics/objects.ts:120-123` builds `kind: "forceBlock"`; `kindCode`
  (`physics/collision.ts:722-744`) has no case, so it is K_NONE and dropped (`collision.ts:389`,
  `sim.ts:747, 940`). No force step in `player.ts:843-917`; keys 149 and 526-530 are never read;
  `player.ts:1647-1652` says "not simulated".
- Levels: 15 objects, all in Dash and The Cellar.

  | Dash x | y | what | push per tick | mode there |
  |---|---|---|---|---|
  | 4665-4845 | 15 | seven 2069, F 1.2 | 0.108 up | 2x swing (portal at 4641) |
  | 18975 | 555, 675 | pair, F 1.5, one flipY | ±0.159 | ship, before the robot portal at 19005 |
  | 20085 | 1725 | 2069, F 1.4 | 0.28 | robot |
  | 20085 | 585 | 5.15 × 3.90 block, F 1.63 | 0.33 up (beats cube gravity 0.2156) | robot |
  | 21555 | 2544, 2604 | two blocks, F 4.2, force ID 1, overlapping | 0.945, once (not 1.89) | mini cube |
  | 2587 | 145 | 3645 × 1.78, rot 180, range 0 → 2 | up to 0.27 down | ball, first rotated section |

  The Cellar: one 3645 (× 5.57, radius ≈ 83.5) at x 1681, y 1641, rot −32, range 2.475 → 5, in
  group 137, which toggles switch on and off; its x part feeds the platformer x velocity.
  Dash's fields are on its route but cannot show yet: the best run goes wrong at the rotation
  triggers near x 2265, before the first force object. After channels, this is Dash's next blocker
  (untested). Final check, 2026-09-29: the re-solved best attempt (75.4 %) is pushed by the circle
  at x 2587 as a ball (tick 2107) and by the swing fields at x 4665-4845 (tick 3726), and lives
  through both.
- Wiki: https://boomlings.dev/reference/player_physics/force_blocks gives the cube case only.

#### 2. Item Compare (3620) and Item Edit (3619) read the wrong keys
Confirmed. **Fixed 2026-09-28.** Three corrections of detail: Edit's second operator (482) is
clamped up to 3, so it is only × or ÷; an Edit may target the points (478 = 3) with no id; and only
Compare's left-hand type defaults to 1 (item). Compare passes its remap chain to the spawn
(`ItemTriggerGameObject::triggerObject` IDA:315936-315949). The attempt number is the visit's own
counter (+10708, `updateAttempts` IDA:92457), counted on every reset including practice respawns.
- Game (`ItemTriggerGameObject::customObjectSetup` IDA:301001-301192):
  - Compare (`activateItemCompareTrigger` IDA:429330-429472): left = `getItemValue(type 476 (min 1),
    id 80)` combined with modifier 479 by operator 480 (0 = multiply); right the same from 477, 95,
    483, 481, or the constant 483 alone when 477 = 0 (or id 0 for types other than 3/4); rounding
    485/486 and sign 578/579 per side. Key 482 picks the test: 0 equal within tolerance 484, 1 >,
    2 ≥, 3 <, 4 ≤, 5 ≠. Spawns 51 when true, 71 when false.
  - `getItemValue` (IDA:429183-429210): type 1 item, 2 timer, 3 points, 4 level time, 5 attempts.
  - Edit (`activateItemEditTrigger` IDA:459103-459228): target 51 of type 478 (1 item, 2 timer, 3
    points); value = item(476, 80) op 481 (1 +, 2 −, 3 ×, 4 ÷) item(477, 95), then op 482 with
    modifier 479; key 480 assigns (0 set; 1-4 +, −, ×, ÷ onto the current value).
  - Key 88 belongs to the count triggers 1811/1817 (IDA:300820-300854); 3620 never reads it.
- Port: `triggers/runtime.ts:1849-1855` compares `items[key 476]` with `items[key 477]` (types, so
  normally item 1 against item 0) using key 88, which no official 3620 has (always ==).
  `runtime.ts:1839-1847` writes `items[key 80]` and reads 480 as if it were 481, shifted by one.
  `setItem`/`addItem` return for id ≤ 0 (`runtime.ts:1987-1988`).
- Levels: 30 compares (Dash 1, 5001 4, 5002 5, 5003 6, 5004 14) and one edit (5001 #8935). 27 of the
  30 can differ, 26 of them can run today:
  - 12 end-of-floor results, three per floor (item 2 ≥ 22/28/23/37, item 1 ≥ 3, level time ≤
    70/100/110/280 s), always pass: every floor shows full marks.
  - 2 first-attempt-only checks in 5002 (#2431, #5861) fire on every attempt.
  - 12 gate play: 5003 #3255 (a lever on item 3 == 0 that always moves one way) and #8224; 5004
    #5216 (a retry loop), #11688 (opens after the first of four), #11973, #13233, #13334 (its wait
    loop exits at once), #13870, #14041, #14000, #14107, #14141.
  - 3 agree by accident (attempt checks). Dash #17924 cannot run: its Touch trigger 1595 is not
    built (`triggers/registry.ts:99`).
  - #8935 should copy the level time into timer 1 (display only).
- The key fix alone is not enough: collectibles must feed items (§3), `getItemValue` needs types
  2-5, and Item Edit needs timer and points targets.

#### 3. Collectible pickups (type 30) never count or toggle
Confirmed. **Fixed 2026-09-28.**
- Game: `EffectGameObject::customObjectSetup`, type-30 branch (IDA:298721-298772): 79 = 1 or key 381
  → count (+1500); 79 = 2 or key 382 → toggle (+1501); 383 → points; 80 item, 78 subtract, 51/56
  target and activate. Touching one (case 0x1E, IDA:463762-463779) runs `triggerObject`
  (IDA:314855-314880): count → `collectedObject` (IDA:459006-459021: item +1, or −1 with key 78;
  key 77 is not read); toggle → `toggleGroupTriggered` (IDA:423103-423110: toggle to the flag, then
  spawn when activating); points → `addPoints`.
- Port: `physics/sim.ts:1337-1341` only emits `"collect"`, which only audio reads (it plays
  secretKey). Keys 78-80, 381 and 382 are never read on pickups; `addItem` is only called by 1817.
- Levels: 194 type-30 objects, 144 active (Fingerdash 11, the tower floors 133). Dash's 8 pixel
  items and Deadlocked's key carry no flags.
  - Fingerdash: 11 count item 1, so its Instant Counts (x 19411-21495) misfire and the counter
    display (group 221) moves and pulses wrongly. Cosmetic.
  - Tower, 110 small pickups (382, 56, target group 4): group 4 holds a Pickup trigger (item 2 +1)
    and SFX, so item 2 stays 0 and every end-of-floor count reads nothing.
  - Tower, 12 key pickups (381 + 382): never count item 1, never spawn groups 5 / 260 (SFX, glow off).
  - The Secret Hollow: 8 pixel items (4404) are the only way to groups 490/538 → items 5/6 → 3620
    checks → two hidden solid doors switched off (group 494 at x 10995, group 549 at x 11895). In the
    port both stay shut; not played through to see whether they block the only route. 3 × 4521
    drive the group 639/647 sequence.

#### 4. Follow (1347) copies only move-trigger deltas (open item 5)
Confirmed. **Fixed 2026-09-28**, and wider than Follow: the main object (`tryGetMainObject`) is also
what rotate and scale centres, the static camera and the camera edges use, and a rotate or scale
pivots on the centre's current position (`getUnmodifiedPosition` IDA:167217-167226: the position
now, less an area trigger's offset), not its place in the file. Follow and Follow Player Y have no
first-step hold and run one extra step after their time is up (`prepareMoveActions`
IDA:486372-486375, 486713-486718); Follows on the same pair of groups share one move a step with the
latest command's mods.
- Game: the trigger reads only keys 51, 71, 10, 72, 73 (IDA:298776-298826); there is no rotation
  key. Each step runs transform, rotation, dynamic, move, player-follow and advanced-follow actions,
  then `processFollowActions` (IDA:469395-469401, 428340-428420): delta = (the followed object's
  position − its snapshot from before this step's first change) × mod. The followed object is
  `tryGetMainObject` (IDA:423396-423405): the key-274 parent (IDA:184060-184071), else the group's
  only member (`getSingleGroupObject` IDA:423244-423251); with neither, Follow does nothing. So it
  follows motion from any cause, rotation included. Mods default to 0 and both 0 ends the command
  (IDA:716268-716277); every official Follow carries both.
- Port: `triggers/runtime.ts:968-974` adds `lastMove[group] × mods`. `lastMove` is written only by
  `translateGroup` (1008-1018), for that exact group id, never by rotate or scale (1025-1052), and is
  cleared every tick (1002). Commands step in creation order (906), so a Follow created before its
  Move copies nothing. `mainObjectOf` is the first member (1158-1162); key 274 is never read.
- Levels: 22 Follows in 4 levels; 20 copy motion in the game and the port gets essentially all of
  them wrong (≈ 285 objects):
  - The Tower, all 12: rotate triggers #3985, #4354, #4700 turn groups 146, 158, 173 360° over 8 s;
    each wheel has four one-member groups (id 1903) 120 units from the pivot, which the cars (10
    objects each) follow. In the port the cars stay put.
  - The Secret Hollow: #13663 (144 objects of group 722, following #12842, the only member of 588,
    which moves through group 563); #4664 (20 objects); the four on group 563 (#13112, #13136,
    #13727, #13881), which copy 7 moves and 2 advanced follows (3016, not implemented). Rotation
    does not move 563's parent: the rotates pivot on it.
  - The Sewers #5103. Dash #17827 copies nothing in the game either.
- Fix: resolve the main object; take its real position change after every other command has
  stepped; run Follows last. Group 563 also needs 3016.

#### 5. Groups are not sorted by x before a spawn
Confirmed. **Fixed 2026-09-28.**
- Game: at setup, `sortGroups` (IDA:453213-453279, via `updateSpecialGroupData` IDA:467051-467064,
  called at IDA:106195) qsorts every group a Spawn trigger (1268) targets by (int)x
  (`xCompPosition` IDA:415180-415187), in every level. With kA38 (settings +362,
  IDA:196289-196291) `sortAllGroupsX` (IDA:423269-423279) sorts every group. `spawnGroup` walks the
  sorted array (IDA:443163-443246). An ordered spawn (`spawnObjectsInOrder` IDA:421726-421805) takes
  its base x from the first member passing `isSpawnableTrigger`, an id test only (IDA:173769), so a
  non-spawn-triggered 1268 inside the group can be the base; the rest wait (x − x0)/311.58 − delay.
- Port: `triggers/spec.ts:171-182` builds groups in file order and nothing sorts them; kA38 is never
  read. `runtime.ts:1210-1228` fires in that order; an ordered spawn's base is the first member with
  any trigger spec (1217-1223). `data/ref/trigger-semantics.md:98` says load order, wrongly.
- Levels (1-18, 20 and 3001 have no Spawn triggers):
  - Ordered: 151 of 496 ordered spawns (44 of 214 target groups) start from the wrong member; 524
    member timings change. Worst: the Tower g192 (85 members, SFX up to 2.89 s early; members between
    x 7785 and 8685 fire at once), the Secret Hollow g345 1.31 s, the Sewers g82 0.87 s, Dash g527
    0.58 s, the Cellar 0.51 s. About half are off by only 0.006-0.1 s.
  - Unordered: visible only where order matters: the Tower g192 (two colours on channel 228, last
    wins) and g222 (alpha); the Secret Hollow g824 (33 pairs: rotate and scale on g563, colours on
    578, toggles on g665). Levels 19 and 21 have out-of-order members with no visible effect.
- Fix: after `buildTriggerIndex`, stable-sort by `Math.trunc(x)` every group named by a 1268's key
  51, or every group when kA38 = 1. qsort leaves ties undefined; file order is fine for them.
- 2026-09-29: the ordered spawn's distances are from where the members are now (`getPosition`,
  IDA:421760-421770), not their file x; only the load-time sort goes by the file. The Sewers' five
  ordered spawns of group 22, whose members sit in movable groups, stagger by their moved spacing.

#### 6. Count (1611) is tested once, when passed
Partly: the bug and the Dash impact hold; the Fingerdash example does not. **Fixed 2026-09-28.** The
listener also keeps the remap chain it was armed with (IDA:315810-315832), as Instant Count's test
does.
- Game: `triggerObject` (IDA:315813-315832) calls `runCountTrigger` (IDA:487736-487880), which
  registers a listener holding the item's current count and fires nothing. Every later change to the
  item goes through `updateCountForItem` (IDA:487384-487525; from `addCountToItem`,
  `collectedObject`, `addPickupTrigger`, Item Edit and persistent items), which fires, in sorted
  order, each listener whose target the count reaches or passes (IDA:487484-487497), and erases it
  unless key 104 (multi-activate) is set (IDA:487505). Instant Count (1811) is one-shot
  (`testInstantCountTrigger` IDA:429136), as in the port.
- Port: `triggers/runtime.ts:1824-1837` fires only if `have === want` at pass time, so it also fires
  when the item already holds the value, which the game does not. `addItem`/`setItem` (1981-1991)
  re-check nothing; key 104 is unread.
- Levels: Dash #18156 and #18161 (x 2835; item 2 reaching 4 and 5, fed by spawned Pickup triggers)
  never fire. In the game they play indicator pulses and fades and move group 555, Dash's first
  secret coin (#18118 at x 3919), 180 units up out of the floor. Collectibility in the port was not
  simulated. Fingerdash #18892 reads item 0 and never fires in either. No level ends differently.

#### 7. No squeeze death (kA31)
Confirmed; nothing measured reaches it yet. **Fixed 2026-09-28** (`test/squeeze.test.ts`).
Corrections: the put-back before the death is the editor's alone. It is behind +1604, which
`PlayerObject::init` sets to "not the editor" (IDA:162197, from `createPlayer` :417895-417900; the
editor flag +10732 is set by `LevelEditorLayer::init` :204650), so in play the player dies where
the pass left it. The platformer's slope nudge (IDA:158565-158590) is no rescue: it moves a player
on a slope with between 0.8 and all of its height to spare, whatever the direction test says; only
the eight sideways tries rescue a squeezed one. A gravity flip clears both contacts
(`flipGravity` IDA:151146-151147). The ground, the band's edges and slopes record contacts too
(IDA:464760, 464798, 464867; 157816, 157836). Which contact a solid block records follows canSnap
(v61, IDA:151786-151808), not the side the player is put on: with canSnap clear the block's top is a
floor, even met head first (a threshold over half the player's height, as a mini ball's or a mini
H-block cube's 10 is, or one raised by the slope extra); with it set the block's bottom is a
ceiling, even landed on (a thin block crossed in one step), and a breakable (type 21) or passable
(key 134) block then records nothing (IDA:151947-151980, 152155-152204). In rotated gameplay each object is turned about where the
player stands as its collision begins (IDA:154412-154413), so the stored floor and ceiling carry the
player's own movement between them. Still approximate: a moving solid that crushes the player, since
the port has no moving-object branch of `collidedWithObjectInternal` (IDA:151851-151910,
152058-152110) and treats a moved block as static where it now is. That branch is not a bolt-on: the
object's move since its last position (+1052, stamped only in a step it moves, so stale once it
stops) widens the snap threshold (IDA:151541-151620), feeds the player's ground-object velocity
(+1328, and +1336 a step later, which `postCollision` turns into a launch when a fast platform
stops, IDA:159068-159104), and gates both landing branches and the head-hit branch; the port's
`collideSolid` is a condensed reconstruction that does not follow that structure, so it waits for a
port of the whole function. The platformer's second test,
between walls (below), was left out of the first fix and added in review. The collision-log checks
after each test (IDA:158682-158715, 158831-158845) were added on 2026-09-29 (`Player.logTop` and the
rest): they destroy a player one object has met both as a floor and a ceiling, or in a platformer as
walls on both sides, since the step began (the log is emptied each step, `GJBaseGameLayer::update`
IDA:469854-469856, and by a gravity flip or a quarter turn). Unlike the squeeze tests they run in
every level, kA31 or not (only the editor's +2496 skips them), and they put the player back where its
update began before the death (LABEL_303, IDA:158694-158711).
- Game: `resetLevelVariables` (IDA:462941-462955) sets player +2492 = kA31 ? 0 : !platformer. When
  it is 0, `postCollision` (IDA:158529-158680) kills a player with both a floor contact (+1872,
  `updateCollideBottom` IDA:142767) and a ceiling contact (+1864, IDA:142817) in the same pass
  (cleared in `preCollision` IDA:154030-154031), closer than 0.7 × its height (0.8 in a platformer),
  after a direction test. A platformer first tries a slope nudge, then eight sideways nudges of ±3
  to ±12 (IDA:158593-158656); otherwise the player is put back and destroyed (IDA:158657-158673).
  - Then, in every platformer, whatever the first test did (a nudge jumps past its death to here),
    a second test between walls (IDA:158716-158830). The walls come only from the platformer's side
    push in `collidedWithObjectInternal`: `updateCollideLeft` with the block's maxX when the player
    is put right of it, `updateCollideRight` with its minX when put left (IDA:152313-152337).
    +1880 keeps the largest left, +1888 the smallest right (IDA:142864-142926); `preCollision`
    clears them (IDA:154032-154033), `flipGravity` does not. With both set and apart, the test is
    skipped when moving away (xVel < 0 ? left > x && left > lastX : right < x && right < lastX);
    closer than width − 5 × scale (25, mini 15) the player tries eight nudges of ±3 to ±12 in y, up
    first, with its rect a unit wider each side and a unit shorter each end; otherwise it is put
    back (editor only) and destroyed (IDA:158812-158826). The nudge test counts an object left of
    the player's x as a left side, and anything else as a right side unless its y is at or below
    the player's x (IDA:158799 reads +4, the y, where the x is meant), which shuts the place: past
    the first few hundred units, any object not left of the player shuts it. In rotated gameplay
    the object is turned a quarter about the player (x′ = x − dy), so the walls it stores run the
    other way from the port's mirror, and the sides trade.
- Port: kA31 is never read; nothing records both contacts (`sim.ts:1255-1256`,
  `collision.ts:807-936`), and platformer solids never kill.
- Levels: live in Dash (kA31 = 1) and all four tower floors (platformer). No reachable static pinch
  site and no squeeze pass in the saved runs (Dash 35.6 %, 5001 38.4 %, 5002 8.4 %, 5003 4.7 %,
  5004 10.9 %). The risk is moving solids in the unreplayed parts (Dash has 358 moving objects).

#### 8. Pickup trigger (1817) always adds, and defaults to 1
Confirmed; no effect today. **Fixed 2026-09-28.**
- Game: case 1817 (IDA:300830-300853) reads 77 (default 0), 139 override, 88 mode, 449 modifier.
  `addPickupTrigger` (IDA:459042-459086): mode 1 multiplies, mode 2 divides (skipped when 449 is
  0), otherwise override sets the item to the count, else adds it. Item ids clamp to 0..9999
  (`addCountToItem` IDA:487546-487563), so item 0 is valid.
- Port: `triggers/runtime.ts:1496-1497` is `addItem(80, num(77, 1))`; 139, 88 and 449 are ignored;
  id ≤ 0 returns.
- Levels: 2 of 16 differ, both in The Cellar: #3249 (sets item 3 to −1) and #3250 (sets it to 0).
  Only Event triggers on events 71/73, "Left Push" / "Right Push" (IDA:428767-428773), spawn them,
  and the port raises no events (`triggers/registry.ts:167`). Ship with the Event trigger and §2.
- 2026-09-29: the Event trigger listens (`TriggerRuntime.armEvent`/`gameEvent`): keys 430 (the
  events, a '.' list), 447 and 525 (the key, 525 + 10000 × 447), 431 (take away), 51 with the remap in
  force (`EventLinkTrigger::customObjectSetup` IDA:313952-314100, `activateEventTrigger`
  IDA:464167-464273, `gameEventTriggered` IDA:462225-462258: once a step per event and key, then the
  key with no player). The sim raises Jump Push/Release (69, 70) and, in a platformer, Left/Right
  Push/Release (71-74) as each button reaches a player (`handleButton` IDA:463975-463995), and User
  Coin and Pickup Item (62, 63) on a pickup (IDA:463687, 463778, 463799). The tower floors also
  listen for landings (2-5), robot boosts (13, 14), orbs (34-36) and pads (45-47), which the sim does
  not raise yet.

### Tier 2 — progression and save

#### 9. Normal and practice level achievements are swapped
Confirmed; the wiki is right. **Fixed 2026-09-29** (at the end).
- Game: `reportPercentageForLevel` (IDA:116718-117030) reports `levelNNa` in practice and `levelNNb`
  in normal mode (the normal branch also reports special01 at 95-99 % and tower01-04). Its callers
  pass PlayLayer+10908 (IDA:92809-92813, 93250-93254), the practice flag (`togglePracticeMode`
  IDA:107451-107465).
- Port: `save/unlocks.ts:112` has `practice: m[2] === "b"`; `describeAchievement` (165), the icon
  kit and the stats screen inherit it; `test/save.test.ts:233-234, 250-251` lock it in.
- Effect: all 42 per-level rewards of levels 1-21 sit on the wrong mode; beating Stereo Madness
  normally gives colour #4, not cube 5. Held back until a practice clear: cubes 5-11, 14, 16, 18, 27,
  35, 42, 44, 45, 74, ships 2 and 9, robots 3 and 5, colour2 #15. Given early by a normal clear:
  colour1 #4-10, 12-14, 16-18, 20, 21, 24, 25, 29, cubes 15 and 17, UFO 2. One character plus tests.
- Fixed 2026-09-29 (`save/unlocks.ts` `achievementLevel`, `ui/screens/play.ts`). Three additions.
  special01 (colour2 #18) is any normal-mode death at 95-99 % of an official classic level
  (IDA:116839-116843); the save keeps it as `totals.nearMiss`, since a completion turns the best
  into 100. tower01-04 are the floors' `b` (IDA:116855-116874), in no table until #12's fix. And
  the death's percentage is `getCurrentPercentInt`, a `floorf` of the float percent, capped at 99,
  and nothing at all in test mode or a platformer (`destroyPlayer` IDA:93198-93216): the port had
  recorded the attempt's highest float percentage for every death, a floor's included. The death
  screen shows +11932, the last normal-mode death's whole percentage, not the attempt's best
  (IDA:93277-93281, `RetryLevelLayer::setupLastProgress` IDA:383912-383924).

#### 10. Secret coins are never saved
Confirmed. **Fixed 2026-09-29** (at the end).
- Game: `levelComplete` (IDA:92815-92848), in normal mode and not an editor or test run, calls
  `processItems` (IDA:420676-420763): each coin picked up this run is stored as
  `unique_{levelId}_{index}` (`getCoinKey` IDA:269911, `getSecretCoinKey` IDA:342598) and adds to
  stat 8; `checkCoinAchievement` (IDA:342692-342830) reports demoncoin01-03 (all coins in 14 / 18 /
  20) and tower01Coin-04Coin. Coins are not picked up at all in practice (IDA:463675-463676), and a
  reset drops the run's pickups (IDA:463046). `verifySyncedCoins` (IDA:109397-109499) raises stat 8
  to the recount of completed 1-22 and 5001-5004 plus secret04/06/B03.
- The index is object key 12 (IDA:651703-651704), not file order: Dash stores its coins 2, 3, 1.
- Port: `recordAttempt` (`save/store.ts:142-160`) never touches `LevelProgress.coins`
  (`save/schema.ts:21`); `"collect"` (`physics/sim.ts:1337-1341`) only plays a sound. Every coin
  display reads 0: `totalCoins` (`schema.ts:111-117`), `countCoins` (`ui/screens/menu.ts:343-349`),
  level select (`levelSelect.ts:207, 242`), stats (`stats.ts:48`). The sim collects coins in practice.
- Effect: none of the 78 coins can be earned, and the coins01-25 rewards (25 icons no other
  achievement gives) stay locked. With the fix coins01-15 are reachable, and demoncoin01-03 once
  `achieved()` handles them (null today). coins16 (80) needs the extra coins, which the port lacks.
- Fixed 2026-09-29 (`physics/sim.ts` `coinsTaken`, `save/store.ts` `recordAttempt`,
  `test/coins.test.ts`). coins01-15, demoncoin01-03 and tower01Coin-04Coin are earnable. Two
  additions. A coin spawns its group: `customObjectSetup` reads key 51 into +1276 and key 12 into
  +1600 for 142 and 1329 (LABEL_126, IDA:299550-299560), and the pickup's `triggerObject` spawns
  +1276 (IDA:463678-463681 → 315158-315160 → LABEL_125 315442-315457). The twelve floor coins carry
  one (5001's group 281, 5002-5004's 279), each holding the floors' two coin-sound SFX triggers.
  And every reset gives the secret coins back, a checkpoint's included: `resetLevel` clears the
  picked-up items and resets every object (IDA:105781 → 463046; 105839-105843, `resetObject`
  169951-169964), and `loadFromCheckpoint` picks up again only user coins, which store a
  triggered id (IDA:105589-105610, 463780-463800). That reaches a normal platformer run, which
  respawns at checkpoints.

#### 11. The jump count counts the wrong actions
Confirmed; the wiki only says "Jumps". **Fixed 2026-09-29** (at the end).
- Game: stat 1 grows only through `PlayerObject::incrementJumps` (IDA:142239), from a ground jump
  as cube, ball or robot (IDA:155855; the spider leaves earlier, IDA:155766) and from every activated
  orb (`ringJump` IDA:159961). UFO flaps (IDA:155686-155729) and swing flips (IDA:155598-155627) do
  not count. The count is committed only at death (IDA:93168) or completion (IDA:92858) through
  `commitJumps` (IDA:92555-92562), so a quit attempt's jumps are lost.
- Port: `game/game.ts:352-360` counts every `"jump"` event, every tick: UFO flaps
  (`physics/player.ts:1078`), swing flips (1096), ground jumps (1161), spider teleports
  (`sim.ts:2317`), and no `"orb"` (`sim.ts:2059`).
- Effect: the 27 saved macros give 1,882 jumps where the game counts 2,133 (−12 %): low in orb-heavy
  levels (Clutterfunk −48), high in UFO-heavy ones (Electroman Adventures +23). The spider orb comes
  out right by accident. The jump achievements unlock late.
- Fixed 2026-09-29 (`physics/types.ts` `countsAsJump`, `game/game.ts` `commitJumps`,
  `test/jumps.test.ts`). Re-measured on the macros saved on 2026-09-29: the twenty that finish give
  1,625 jump events and 1,861 jumps by the game's rule (Clutterfunk 85 → 133, Electroman
  Adventures 112 → 89). Two additions. A restart from the pause menu does not commit or clear the
  pending jumps, so they carry into the next death or finish; only quitting loses them. And the end
  and death screens' "Attempts:" and "Jumps:" are the visit's +10708 and +11916 (IDA:369518-369529,
  383933-383935, 384043-384045; +11916 counts beside the pending +11924, IDA:92529-92531), zeroed
  by `PlayLayer::init` and `fullReset` (IDA:106960, 107523-107524), which the end screen's replay
  calls (`EndLevelLayer::onReplay` IDA:367255-367287) — ending practice too. The port showed the
  save's attempts and the jumps since the attempt began, and its replay did not start over.

#### 12. The achievement table is extracted wrongly
Partly: latent, except one side effect that is live. **Fixed 2026-09-29** (at the end).
- Game: `GameStatsManager::checkAchievement` (IDA:350163-352648) switches on the stat with hex case
  labels from 10 on (`case 0xAu` IDA:351850 onwards): 10 likes, 11 ratings, 12 user coins, 13
  diamonds, 15 dailies, 16-20 and 23-27 shards, 28 moons, 30-39 paths, 40 gauntlets, 41 lists.
  usercoins01, daily01, gauntlets01 and lists01 are reported at 100 % with no divisor (IDA:351903,
  352134, 352577, 352599).
- Port: `tools/assets/strings.ts:160` matches only `case (\d+)u?:`, so strings.json files 152
  achievements under stat 9 (4 of its 156 really are stat 9: secret02/02b/03/03b) and gives the four
  direct reports the previous case's divisor (2000, 25000, 10000, 15). The other 148 thresholds are
  right. `assets/stringTypes.ts:46-47` calls stat 9 "the miscellany"; it is menu icons destroyed.
  Harmless while `achieved()` counts only stats 1, 2, 5, 6, 8 — a trap for goal 6d.
- Live today: the extractor also drops 18 ids reported through a shared tail (IDA:352617-352621,
  e.g. jump11, attempt14, demon27, stars33, coins28) and gives a null stat to first-of-case direct
  reports (custom01, demon01, mappacks01, secret01). demon01's reward, cube 19, is "beat one demon",
  which the port can count, but it shows as earned elsewhere.
- Fixed 2026-09-29 (`tools/assets/strings.ts` `achievementThresholds`, `levelReports`; strings.json
  rebuilt, 395 → 431 entries, 166 changed). Corrections: the tails drop 28 ids, not 18 — 20 in no
  table at all (jump11, attempt14, custom14, demon27, stars33, coins28, secret18, like06,
  usercoins40, diamonds18, daily07, shardEarth05, shardBlood05, shardMetal05, shardLight05,
  shardSoul05, shardBonusB05, moons26, gauntlets04, lists07) and 8 with a null stat (mappacks10,
  rateDiff04, shardShadow05-Lava05, shardBonus05), reported through `v26`/`v814`/`v889`
  (IDA:351258-351262, 352272-352274, 352417-352421 and the like). "The other 148 thresholds are
  right" is wrong for six: demon02 is `v * 0.5` and demon04 `v * 0.25` (IDA:351419, 351427), which
  the extractor did not read, so demon02 had no stat and demon04 took demon03's 3 (cube 22 at three
  demons); shardBonusB01-04 are `(float)v / N` (IDA:352437-352449) and took shardSoul05's 100. The
  shard bonuses count the least of stats 16-20 and 23-27 (IDA:352275-352283, 352423-352436), so
  they carry no stat. And the per-level ids (level22a/b, special01, tower01-04, tower01Coin-04Coin,
  subzero.level001-003, mdlevel01b-03b) are only in `reportPercentageForLevel` and
  `checkCoinAchievement`, which the table now reads too.

#### 13. Show Percentage and the progress bar start on
Confirmed; cosmetic. **Fixed 2026-09-29** (at the end); Show Time is not built.
- Game: a fresh save (`firstLoad` IDA:114397-114426) never sets gv 0040 (Show Percentage) and sets
  the progress bar off (GameManager+668 = 0, IDA:114400); no `dataLoaded` migration touches 0040.
  With the bar hidden the label is centred (`toggleProgressbar` IDA:91629-91659). In a platformer
  the bar is always hidden and the label follows gv 0145, Show Time (IDA:91619-91624).
- Port: `save/schema.ts:69-70` default both on; `ui/screens/play.ts:168-169` always draws the label
  at w/2 + 110; the HUD (156-170) ignores platformer, so the tower floors show a bar and a percentage.
- Fixed 2026-09-29 (`save/schema.ts` `defaultSettings`, `ui/screens/play.ts`). A stored choice is
  kept. In a platformer the label is Show Time's (gv 0145), which the port does not have, so the
  floors show no progress at all; `updateProgressbar` skips a platformer (IDA:91522). The
  "Attempt N" label went with it: it counts the visit's +10708 (`updateAttempts`
  IDA:92457-92471), stands 85 above the camera's centre on a classic level's first attempt and 50
  right of that on every later one and any platformer attempt (`setupHasCompleted`
  IDA:106455-106461, `updateAttempts` 92478-92486, `fullReset` 107531-107537), and is drawn at
  opacity 50 in test mode (IDA:106462-106463). The port wrote the save's attempts + 1, always 50
  right and opaque.

### Tier 3 — audio

#### 14. Edit Song (3605) starts Stereo Madness
Confirmed; the wiki does not cover the trigger. **Fixed 2026-09-29** (at the end).
- Game: `activateSongEditTrigger` (IDA:447107-447128) never starts a track. It edits the music
  channel named by key 432 through `applySFXEditTrigger` (IDA:431769-431804): stop (key 417, or
  414), volume to key 406 over key 10 seconds (418), speed from key 404 (419); plus proximity volume.
- Port: `triggers/runtime.ts:1536-1538` treats 3605 as 1934 and emits song `int(392)` = 0 (no 3605
  has key 392); `audio/gameAudio.ts:128-137` plays official track 0, StereoMadness.mp3, stopping
  whatever was playing.
- Levels: 17, all on the tower floors (most are volume changes, 3 are stops, 5001 #5758 does
  nothing). The Cellar opens on Stereo Madness at tick 1 (in the game #1872 turns its track down to
  0.4) until x ≈ 1875; the Tower's #8874 (x 10097) leaves it on for the rest of the floor; the
  Secret Hollow and the Sewers get stretches of it.
- Fixed 2026-09-29 (`audio/levelAudio.ts`, `songEdit`). Correction: 5001 #5758 is not inert. Its
  key 51 = 187 adds a proximity volume effect on channel 0 (IDA:447126-447127 →
  `addProximityVolumeEffect` :447022-447092): the Tower's track fades from 1 to 0 as player 1 walks
  1050 units right of group 187 (x 6405), while #5760 brings channel 1 up from 0 to 0.9 by group
  188 (x 7305) under the song #5762 starts. A crossfade by distance, now played.

#### 15. The tower floors and The Challenge lose their song, difficulty and stars
Confirmed. **Fixed 2026-09-29** (at the end).
- Game: `LevelTools::getLevel` (IDA:120993-121063). The floors write track 0 and a song id that IDA
  prints as string pointers; the PC exe has the values:

  | floor | song id (exe VA) | difficulty / stars |
  |---|---|---|
  | 5001 The Tower | 10003039 (0x1403276ba) | 2 / 5 |
  | 5002 The Sewers | 10003129 (0x140327533) | 3 / 6 |
  | 5003 The Cellar | 10002875 (0x1403273ab) | 4 / 7 |
  | 5004 The Secret Hollow | 10006086 (0x140327216) | 4 / 7 |

  A non-zero song id plays `Resources/songs/{id}.ogg` (`getAudioFileName` IDA:270022-270039); all
  four files ship already. The Challenge (IDA:121053-121061, exe 0x14032704a) is track 26, "Secret"
  (DJRubRub.mp3, IDA:121198), difficulty 3, 3 stars.
- Port: `tools/assets/strings.ts:73-103` only recognises branches that open with `getAudioTitle`,
  so 5001-5004 land in the gaps and 3001 is filled from `data/audio/extra.json` (TheChallenge.mp3,
  song 1000, 0 / 0). `audio/gameAudio.ts:59-60, 71-72` then play nothing.
  `ui/screens/levelSelect.ts:193` says the floors have no entry in the binary; they do.
- Effect: the Tower is silent until x 6405 (then §14), the Sewers until x 2077, the Cellar plays
  Stereo Madness (§14) instead of its own track, the Secret Hollow starts its music by trigger at
  x −15 and is barely touched. All four floors show as unrated and their 25 stars are missing from
  totals. The Challenge awards no stars (`completedLevel` IDA:356160-356191 awards any level with
  stars) and is credited to RobTop. TheChallenge.mp3 is DJRubRub.mp3 re-encoded (same length,
  correlation 0.9994), a duplicate 560 KB.
- Fixed 2026-09-29: `tools/assets/strings.ts` `namedLevelFacts` reads the five branches that open
  with the level's name, the floors' song ids from the table above (`LevelFacts.songId`);
  `data/audio/` and TheChallenge.mp3 are gone. `songPath` routes by id range (`.ogg` above
  9,999,999, `.mp3` below, `pathForSong` :394118-394141).

#### 16. Practice plays the level song
Confirmed. **Fixed 2026-09-29** (at the end), but for the practice metering.
- Game: `togglePracticeMode` (IDA:107451-107486) stops the music and loops `getPracticeMusicFile`
  (IDA:108846-108870: StayInsideMe.mp3, or a downloaded custom practice song), unless practice sync
  is on (+10909, `toggleMusicInPractice` IDA:87472-87490: the Music Unlocker shop item 12/17, or
  gv 0125 on editor levels). Without sync the level song is never loaded (IDA:93598); Song, Edit
  Song, SFX and Edit SFX triggers do nothing (IDA:446513, 447113, 447166-447168, 447266, 431781);
  deaths, resets and checkpoint loads leave the practice track running (IDA:93285-93289,
  105776-105777, 105531).
- Port: StayInsideMe.mp3 ships and nothing plays it. Every death stops the music
  (`ui/screens/play.ts:112-115`); every respawn restarts the level song at the checkpoint's time
  (`game/game.ts:267-282`, `audio/gameAudio.ts:68-80`); audio triggers play in practice
  (`audio/events.ts:83-92`). (`tools/assets/strings.ts:224` dropping index −1 is not the cause: the
  game has no file entry for −1.)
- Effect: every practice run in all 27 levels; on the tower floors 512 audio triggers also play.
- Also: entering practice does not reset the level in the game (leaving it does), while the port
  restarts both ways (`play.ts:323-327`); without sync, pulsing objects use a fixed music level of
  0.5 in practice (`updateVisibility` IDA:95877-95892).
- Fixed 2026-09-29: practice plays StayInsideMe.mp3 on channel 0 and none of the level's audio
  triggers; deaths and respawns leave it running; startMusic's kA15 fade still runs on it
  (IDA:105406-105410). Entering practice goes on from where the level is; leaving it restarts. The
  fixed 0.5 metering is not built (the port has no audio metering).

#### 17. Finishing a level cuts the song
Partly: the cut is real; The Challenge is cut, not faded too briefly as first claimed.
**Fixed 2026-09-29** (at the end).
- Game: `showCompleteEffect` (IDA:88965-88974) sets the song's loop count to 0 and fades it over 2 s
  only when kA16 is set or the level is 3001; nothing stops the music (`levelComplete` IDA:92580;
  the end screen stops it only on Edit, ≈ IDA:367557-367580). It is skipped in practice and for an
  End trigger with key 460 (IDA:92649-92657, 92858-92904). Classic songs load unlooped; platformer
  songs loop until completion (loop = platformer flag, IDA:93587-93611, 71370-71374).
- Port: `audio/gameAudio.ts:89-92` fades over 1 s with kA16 and otherwise stops, called from
  `ui/screens/play.ts:103`, in practice too; no 3001 case; level music never loops
  (`audio/music.ts:44`).
- Levels: every official level writes kA16 = 0. Levels 1-22 lose the rest of their song under the
  complete screen; 3001 is cut instead of faded; platformer floors should loop (and cannot finish
  yet — open item 3).
- Fixed 2026-09-29. Two corrections. Key 460 does not skip the complete effect: `levelComplete`
  calls `showCompleteEffect` on every completion outside practice (IDA:92891-92904) and 460 only
  skips its flash (:88900-88947), so an End trigger's finish also ends channel 0's loop. And
  practice has no end sound either: endStart_02 is played only inside `showCompleteEffect`
  (:88863-88866).

#### 18. The song fade-in is 1 s and repeats on respawn
Confirmed. **Fixed 2026-09-29** (at the end).
- Game: `startMusic` fades in over 2 s (IDA:105409) only at level time ≤ 0 with kA15. A checkpoint
  load restores the audio state and, in a platformer only, fades the music bus in over 0.1 s
  (IDA:105530-105543). A platformer reset waits 0.2 s before restarting the music
  (IDA:106036-106050).
- Port: `audio/gameAudio.ts:77` fades over 1 s on every start, respawns included (`game/game.ts:281`).
- Levels: 5003 and 5004 (kA15 = 1), which have no music in the port yet (§15).
- Fixed 2026-09-29: the 2 s fade only on a fresh attempt at music time 0; a checkpoint replays the
  songs where they would be, and a platformer's music bus comes back over 0.1 s. The pause menu
  now suspends the sound (`pauseGame` → `pauseAudio` :93469) instead of muting a track that ran on.
  The 0.2 s hold was added in the completeness pass: a platformer's restart, and the end screen's
  replay, hold the level still (no step, no buttons) for 48 ticks and only then start the music;
  the first attempt of a visit and a checkpoint start at once (`Game.restart`; `resetLevel`
  :105994-105996, 106036-106050; `startGameDelayed` :105470-105474; +11736 from `delayedFullReset`).

#### 19. Song trigger (1934) settings are ignored
Confirmed. **Fixed 2026-09-29** (at the end).
- Game: keys (`SFXTriggerGameObject::customObjectSetup` IDA:309521-309760; song part
  IDA:309776-309800): 392 id, 404 speed, 405 pitch, 406 volume, 408 start ms, 409 fade in, 410 end,
  411 fade out, 413 loop, 416 unique id, 417 stop, 418 volume, 419 speed, 455 SFX group; 399 prep,
  400 load-prep, 432 channel. `activateSongTrigger` (IDA:446501-446556): with 400,
  `activateQueuedMusic(~channel)`; otherwise `queueStartMusic` with all of the above
  (IDA:72427-72500), which loads, seeks, and starts only without 399 (IDA:72334-72400). Starting
  stops only the same channel (`triggerQueuedMusic` IDA:71644-71700).
- Port: `triggers/runtime.ts:1538` passes only 392; `audio/gameAudio.ts:128-137` plays from 0,
  unlooped, at full volume, on one player that stops everything first (`audio/music.ts:38-63`).
- Levels: tower floors only, 19 triggers: 5 prep and 5 load-prep (the Sewers starts 10000104 at
  x 2475 and restarts it at 2955), 12 loops, 4 start offsets (the Secret Hollow's 15000, 22500,
  22500, 30000 ms), 4 end times, 11 volumes, 6 fade-ins, 5 on channel 1 (layers that replace the
  main track in the port).
- Fixed 2026-09-29. Corrections: key 405 never reaches a song (`activateSongTrigger` passes 0 as
  `queueStartMusic`'s pitch, :446539-446544); a load (400) plays the prepared trigger with the
  prep's settings, not its own (`activatedAudioTrigger` :447822-447830; `triggerQueuedMusic`
  :71645-71701). 15 triggers carry 413, 12 of them to effect (three are loads). A replayed song is
  loaded with its loop points and no fades or end (`processActivatedAudioTriggers` :454862-454917).

#### 20. SFX trigger (3602) volume and speed ignored; Edit SFX (3603) fetches s0.ogg
Confirmed. **Fixed 2026-09-29** (at the end); the reverb is approximated.
- Game: `playSFXTrigger` (IDA:108930-109007) → `playEffectAdvanced` (IDA:73942): speed =
  `pitchForIdx(404)` (a −12..12 table, IDA:64678) as the playback rate (IDA:74105-74106); volume =
  key 406, capped at 2 (IDA:74066, 74107), missing = 0 = silent (saved only when non-zero,
  IDA:322152-322157); pitch = `pitchForIdx(405)` as a pitch-shift DSP (IDA:74111-74114); loop 413;
  start, end and fades; SFX group 455; minimum interval 490. `activateSFXTrigger` returns for id ≤ 0
  (IDA:447169) and applies proximity volume when key 51 > 0 (volumes 421-423, distances 424-426).
  3603 only edits playing sounds (IDA:447241-447360, 431769): targets by 457 / 455 / 416; stop
  (417, 414), volume over key 10 (418), speed (419).
- Port: `audio/events.ts:84-87` plays with no volume or pitch. `triggers/runtime.ts:1540-1542`
  sends 3603 as SFX id 0, so `audio/gameAudio.ts:115-126` fetches the missing `audio/sfx/s0.ogg` on
  every firing (failures are not cached, `audio/library.ts:29-41, 81-89`). `SfxPlayer.stopGroup`
  (`audio/sfx.ts:71`) is never called.
- Levels: tower floors only. 411 of 455 SFX sound different (405 volumes, 234 speed indexes, mostly
  −2, 39 pitch indexes); 17 loops play once; 92 trims, 97 fades and 38 proximity volumes are
  ignored. The 21 Edit SFX do nothing (2 stops, 10 volume changes). The Cellar at x 5955: a looping
  sound starts at volume 0 and an Edit SFX fades it in; the port plays it once at full volume.
- Fixed 2026-09-29, pitch shift included (`audio/pitchShift.ts`, WSOLA; not FMOD's artefacts).
  Corrections: the minimum interval is key 434 (+1720, `playSFXTrigger` :109003 as
  `playEffectAdvanced`'s a19, :74266-74277); key 490 (+1748) is the sound's length as the editor
  stored it, read only by the start-position replay. An Edit SFX aimed at an SFX group (455) changes
  the group, which sounds started in it later inherit (:70852-70877; the group's channel group
  :74098). And a checkpoint does not replay SFX by key 490: SFX triggers are noted for replay only
  while a start position loads (`activateSFXTrigger` :447171-447174, `activateSFXEditTrigger`
  :447268), and `processActivatedAudioTriggers` empties that list when it is done (:455238). What a
  checkpoint brings back is the engine's own state: `saveAudioState` (:68887-68928) records each
  playing effect's position, loop points, fades and delay, and `loadAudioState` (:74331-74397)
  starts each again where it was. The port rebuilds the same from its log of what played.
- Reverb, added in the completeness pass (`audio/reverb.ts`): key 407 (+1676, `playSFXTrigger` :108974
  → `playEffectAdvanced`'s a8 → `getChannelGroup` :68395-68456) sends the sound through the reverb
  group (+404, or an SFX group's reverb twin, +1140), which plays it dry and adds an SFXREVERB; key 503
  (+1744) switches that to key 502's preset (+1740) once proximity has let the trigger through,
  before the interval and unique tests (`activateSFXTrigger` :447202-447206); every reset puts it
  back to preset 0 (`resetLevelVariables` :462921). The presets are FMOD's own: 0 Generic, the
  fallback for anything outside 1-22 (`updateReverb` :64026-64036), then Padded Cell to Underwater
  (unk_980BF4 via :64038-64049, named by `reverbToString` :64173-64253; each value is in
  GeometryDash.exe's float pool). Corrections: a checkpoint does not keep the preset (the reset has
  put it to 0, and `loadAudioState` restores each sound's 407 but not the preset, :74338-74346); a
  start position's replay re-fires the SFX triggers still sounding, so their 503s switch it in
  order (`processActivatedAudioTriggers` :455196). Official uses: 50 triggers set 407 (5001 ×10, 5002
  ×8, 5003 ×15, 5004 ×17) and 5002 has a 503. FMOD's reverb algorithm is not reproduced: the port
  convolves with an impulse built from the preset's numbers.

#### 21. Time warp slows the music
Confirmed (from the absence of any audio call). **Fixed 2026-09-29** (at the end) for the
music; the physics half of the warp is not built.
- Game: `updateTimeWarp` (IDA:415280-415298) and `applyTimeWarp` (IDA:416307-416320) only change the
  game clock (the scheduler time scale); no FMOD pitch or frequency call depends on the warp.
  `timeForPos` (IDA:123402-123437) counts a warped stretch as taking longer in song time: the song
  runs on in real time.
- Port: `audio/gameAudio.ts:101-105` and `audio/music.ts:96-102` set the music's playback rate from
  the warp (also at start, `gameAudio.ts:78, 136`). The physics warp is not implemented
  (`triggers/registry.ts:160`).
- Levels: Dash only, x 4535 (0.2) to 4615 (1): the port plays full-speed gameplay over music at
  0.2x (−28 semitones); the game does the opposite. Drop the audio rate when the physics warp lands.
  The goal-6 plan's `preservesPitch = false` line (`gd-goal6.md:281`) rests on the same mistake.
- Fixed 2026-09-29: the music's rate is only ever a Song trigger's speed.

#### 22. The death sound is too loud
Confirmed. **Fixed 2026-09-29** (at the end).
- Game: `destroyPlayer` plays explode_11.ogg at volume 0.65 (IDA:93293-93297) unless the Options
  trigger's no-death-sound byte (1044) is set. endStart_02 (IDA:88865) and secretKey (IDA:89553)
  play at 1.0.
- Port: `audio/names.ts:29`, `audio/events.ts:80` play it at 1.0, ≈ 3.7 dB louder on every death.
  Key 576 (no death sound) is parsed (`triggers/runtime.ts:236, 272`) and never read; no official
  level sets it.
- Fixed 2026-09-29 (0.65; key 576 silences it; key 575 keeps the music and sounds through a death,
  and now defaults off as the game's +1038 does). Correction: key 575 is used — 5004 #13472
  (x 14565, spawned with group 716) sets it with a 3 s respawn time. The pickup sound the port
  played (secretKey) is not the game's: `pickupItem` (:420607) and `collectedObject` (:459006) play
  nothing, and secretKey belongs to the new-best popup (:89553). An Options key of 0 leaves its
  setting alone and any value but 1 turns it off (`processOptionsTrigger` :429799-429860).

### Tier 4 — rendering

#### 23. Legacy colour key 19 is ignored
Confirmed. **Fixed 2026-09-29** (`test/decode.test.ts`, `test/colours.test.ts`): the decoder reads
it into `legacyColor`, and the draw list (`objectChannels`) puts it on the detail colour or the
base. "Has a detail colour" means +956 exists, which only `createSpriteColor` makes, for an object
with art on a colour sprite or colour child (IDA:166652-166680): the port asks for both a default
detail channel and a sprite on the D slot. The two proxies disagree on 147 key-19 objects (spikes
18/19 have a `dc` and no detail art; the balls 50, 54, 148 and 149 have D-slot art and no `dc`);
both go on the base. A negative or past-8 key 19 names nothing and still skips 21/22.
- Game: `objectFromVector` (IDA:184334-184351, 184379-184381): any non-zero key 19 skips keys 21/22;
  1-8 map to 1005 P1, 1006 P2, 1, 2, 1007 LBG, 3, 4, 1003 3DL (the table `word_981690` is only in the
  exe: jump table at RVA 0x19eca8), set on the detail colour if the object has one, else the base.
- Port: `level/decode.ts:232-233` reads 21/22 only; `render/drawList.ts:696, 719-722, 813, 911`
  fall back to defaults. The channels exist (`render/colors.ts:35-48`); it is a decode fix.
- Levels: Blast Processing 797 (790 drawn wrong), Theory of Everything 2 3,040 (2,908): decoration
  meant to follow the player colours or the light background.

#### 24. P1, P2 and the light background are always additive in the game
Confirmed, and wider. **Fixed 2026-09-29** (`test/colours.test.ts`): the draw list keeps per sprite
the channel whose flag decides (`blendChannelOf`), with P1, P2 and LBG always additive, 1012 asking
its base, and the no-blend objects (+727: the rods 15-17, `customSetup` IDA:180166-180170, and 650,
`setupCustomSprites` IDA:612179-612190) never. `setupHasCompleted` writes P1/P2's *colour* over the
header's 1005/1006 too, so the nine kS38 levels drew them in the file's stored colours (846 objects
in 19-21, 3001, 5004). That colour is `strongColor` of the icon's (IDA:43436-43470: scaled until the
largest part is 255, by at most 1.5, float maths truncated), with a black colour 1 handing over to
colour 2 and two black ones making white (`updateGlowColor` IDA:146119-146173); 69 of the 107
palette colours change. The player's own icon keeps the raw colours, but its outline (the glow
sprite) and its streak take the strong colour 2, fixed when the player is built; the wave's band
(HardStreak) takes the raw colour 1 unless the "Switch Wave Trail Color" option (0096) is on
(IDA:146213-146259, 162175-162176). The port has no such option. A sprite's own additivity (glow,
additive art) is the only part kept from the build, so a colour trigger can now turn a channel's
blending off as well as on. With #23: 16,325 objects and 20,777 sprites start drawing additively;
#24 alone 16,124 and 20,542.
- Game: `shouldBlendColor` (IDA:166453-166491): in play mode a sprite that resolves to 1005-1007
  always blends, whatever the colour table says; a 1012 (lighter) detail takes the base sprite's
  blend. `setupHasCompleted` also sets P1/P2 blending on (IDA:106212-106234).
- Port: channels start unblended (`render/colors.ts:213-217`); `resolve` sets only P1/P2's RGB
  (405-418); blending comes only from a header's `5_1`, and LBG never blends (670-674). Draw list:
  additive = `record.bl || channel.blending` (`drawList.ts:307, 748, 845, 937`).
- Levels: P1/P2 in levels 1-18, whose legacy headers never name them: 6,491 objects in 11 levels
  (Electrodynamix 2,012). LBG: 9,642 objects in levels 13-22. About 16,000 objects in levels 1, 3 and
  10-22, most visible on dark backgrounds. Fix it in the draw list; forcing the table would let a
  colour trigger switch it off.

#### 25. Legacy headers: the ground line is not forced additive
Confirmed; the wiki is silent. **Fixed 2026-09-29** (`test/decode.test.ts`, `test/colours.test.ts`).
More of the header changed with it. The header is read into a new `LevelSettingsObject`, whose
`init` gives BG (40,125,255), G1 and G2 (0,102,255), the line white and additive, MG and MG2
(40,125,255) (IDA:205263-205293); a channel the header leaves out keeps those (so G2 no longer
copies G1). kS38 is read alone; without it, kS29 means all nine 1.x keys are read, a missing one as
an empty entry (IDA:196317-196412). `ColorAction::setupFromMap` reads every field with atoi/atof, so a
missing colour is black and opacity 7 counts only when 8 is above 0 (IDA:480349-480501). The 1.x
Line trigger is made as a 915 and then forced additive (IDA:183928-183930, 184267-184270); a native
915 follows key 17. kS1-kS28 (`setupColorsFromLegacyMode`) is not ported; no official level has it.
- Game: the kS29-kS37 (and kS1) header branch turns 1002's blending on after parsing kS31
  (IDA:196357-196364, 196013-196014). A 1.x Line trigger (104) is forced additive after key 17 is
  read (IDA:184267-184270).
- Port: `level/decode.ts:123, 137-141` take key 5 (`5_0` in all of 1-18); `triggers/runtime.ts:1582`
  takes key 17 for 104. Floor and ceiling line: `render/scenery.ts:367, 428`.
- Levels: 1-18, mostly visible on 17's and 18's coloured lines; 15, 17 and 18 flip back and forth as
  their Line triggers fire. Fix both places.

#### 26. Warp angles (keys 131/132) are ignored
Confirmed. **Fixed 2026-09-29** in the draw list (`test/objects.test.ts`, `test/colours.test.ts`):
`loadAngles` applies both rules of `objectFromVector` (IDA:184214-184237), the warp and the cut of a
key-6 angle off the quarter turns (truncated first) for an object that may not rotate freely, and
`affineXY` draws the two axes (`nodeToParentTransform` IDA:788575-788617). The type test reads the
type after `EnhancedGameObject::customSetup` (IDA:181863-182790), which types 213 animated ids the
generated table leaves Solid (`ENHANCED_OBJECT_TYPES`: cogwheels, fire and the animations
Decoration, saws and blades Hazard), and a subclass's own type wins over both
(`SUBCLASS_OBJECT_TYPES`: coin 142 SecretCoin and 1329 UserCoin from `EffectGameObject::customSetup`
IDA:302347-302349, 302424-302425; 2065 Decoration from `ParticleGameObject::customSetup` IDA:298440;
the area triggers 3006-3015 EnterEffectObject from its `init` IDA:307736). Last comes
`setupCustomSprites`, which `objectFromVector` calls after every customSetup (IDA:184192-184201): it
makes the 3DL pieces 506-514 and the perspective blocks Decoration, which wins over all the rest
(`CUSTOM_SPRITES_OBJECT_TYPES`: 506-514 at IDA:613324-613375, every perspective path ending at
LABEL_1827, which sets type 7, IDA:613575-613582). The ids are the ones whose path through its
dispatch reaches LABEL_1827 (traced id by id): 506-640, 902, 943-951, 980-988, 1024-1032,
1063-1071, 1529, 1531-1540, 1552-1560, which is `perspectiveBlockFrame`'s set (IDA:384683) less
1530. That table was added after review on 2026-09-29; before it the 3DL pieces read as Solid, so
50 key-6 angles were cut to 0 (Geometrical Dominator 507 ×1 and 508 ×30, The Sewers 507 ×1, The
Secret Hollow 509 ×9 and 514 ×9) and Dash's 24 warped 508s (131 = 270 or −90, 132 = −89) drew flat,
none of which the game does. Counted with `loadAngles` over the port's loader: 1,102 objects ask for
a warp; 21 are triggers the draw list does not draw (1006 ×4, 1268 ×2, Custom Particles 2065 ×15), and
the other 1,081 are all warped (607 plain turns, 180/−180 included; 474 skews). No key-6 angle is cut
on an official level. A solid, breakable or slope that is cut has its hitbox at 0 too (`loadRotation`,
read by the object set), since the cut is to the object's own rotation. Otherwise collision still
turns hitboxes by key 6; the 36 warped hazards are symmetric under their turn, so no official hitbox
differs. Custom Particles objects are not drawn by the draw list and take no warp. The object
table follows the same last word since the completeness pass: `gameDef` makes every id
`setupCustomSprites` types Decoration a decoration with no hitbox, so the perspective slopes 522 and
523, Slope to customSetup, no longer collide or keep square under a rotate (Blast Processing's three
523s at x 1372-1420, y 1-50); they were the only ids whose table kind contradicted the type tables.
- Game: `objectFromVector` (IDA:184221-184237): if 131 ≠ 132 and the object may rotate freely (types
  0, 21, 25 only with key 121, IDA:168950-168959), rotation X = 131 and rotation Y = 132. Saves write
  these instead of key 6 (IDA:185099-185124).
- Port: `level/decode.ts:224` reads key 6 only.
- Levels: 1,102 objects in Dash (487) and the tower floors (14, 51, 129, 421). Of the 1,081 drawn,
  607 are plain rotations in disguise (270/−90, 180/−180: draw at 131) and 474 need a skew. The
  Secret Hollow's 13 spikes (id 8) at 180/−180 point down in the game and up in the port; collision
  is unchanged. None of them stays flat in the game: every warped object may rotate freely.

#### 27. A colour trigger without key 23 targets channel 1
Confirmed. **Fixed 2026-09-29** (`test/colours.test.ts`). Keys 7-9 read 0 when missing, and the
opacity (35) counts only when 36 is above 0, 0 when missing then (IDA:299746-299812).
`getTargetColorIndex` (IDA:310067-310090) is the editor's label, not the dispatch.
- Game: every object starts with target channel 1 (IDA:165584); setup overwrites it only when key 23
  > 1 (IDA:299793-299800); the colour dispatch passes it through (IDA:315152-315175).
- Port: `triggers/runtime.ts:1570-1572` makes it channel 0 and returns.
- Levels: 27 triggers: Geometrical Dominator 15 (its opening fade included), Deadlocked 7, Dash 1,
  the Sewers 4.

#### 28. Legacy colour trigger 900 targets channel 4 instead of the second ground
Confirmed. **Fixed 2026-09-29** (`test/colours.test.ts`). 221, 717, 718 and 743 are made as 899 and
pointed at channels 1-4 after key 23 is read, so key 23 does nothing on them; 104 is made as a 915
(IDA:183928-183945, 184244-184275). All five count as spawnable, as their 2.x forms do. 743 has
no bootstrap record, so it is a trigger by hand (`LEGACY_TRIGGER_IDS`, like 717 and 718), with
its `objects.json` record, catalogue entry and registry row (fixed later on 2026-09-29; before
that a placed 743 read as unknown and never fired). No official level places 743.
- Game: `customSetup` gives 900 channel 1009 (IDA:302332-302337); the legacy "Col 4" trigger is 743
  (IDA:184259-184261).
- Port: `triggers/runtime.ts:94` maps `900: 4` and has no 743; `triggers/catalogue.ts:44` labels
  900 "Col 4".
- Levels: 7 triggers without key 23 in Geometrical Dominator and Deadlocked. The ground detail never
  changes colour there, and in Deadlocked channel 4 (a copy of player colour 2) is overwritten, so 24
  pulses flash teal, maroon and black. Fingerdash's 900s carry key 23 and work.

#### 29. Colour triggers ignore Player Color 1/2 (keys 15/16)
Confirmed; the wiki is right. **Fixed 2026-09-29** (`test/colours.test.ts`): the pair is player 1's
strong colours (#24) in every mode, and header channels with key 4 take the same pair
(`updateCustomColor` IDA:473080-473098).
- Game: keys 15/16 (IDA:299778-299785); `PlayLayer::addObject` (IDA:90024-90045) overwrites the
  trigger's colour with player 1's colour 1 or 2 (key 15 wins) — `strongColor` of the icon colour
  (IDA:43436-43470, via `updateGlowColor` IDA:146100-146185), not the raw palette entry.
- Port: `triggers/runtime.ts:1568-1591` and `render/colors.ts:349-360` have no player-colour field.
- Levels: 82 triggers: Electrodynamix 69 (the background flashes), Theory of Everything 2 8, Blast
  Processing 2, Deadlocked 2, Hexagon Force 1.

#### 30. Custom particles: fields past token 55 ignored, fades unused
Confirmed. Tokens are 0-based; the wiki numbers from 1. **Fixed 2026-09-29**
(`test/particles.test.ts`). 56 is dynamic rotation (keeps turning toward the motion; 55 only turns
it at birth). The respawn path's caller is `PlayLayer::updateVisibility` (IDA:95982-95986), with
the layer clock (+792). `claimParticle` stops every emitter with a duration of 0 or more when it
comes on screen (IDA:306373-306379), and `updateSyncedAnimation` starts it again `respawn` seconds
later, then every duration + life + lifeVar + respawn, unless key 123 makes it wait for an Animate
trigger (1585, IDA:315512-315513 → 164755-164759). So all 151 finite emitters loop or wait. The
trigger calls `updateSyncedAnimation` itself (IDA:620435-620442), which asks only for key 123, so
it restarts a key-123 emitter that runs for ever as well (none in the official levels). A
duration of 0 with rate −1 is a one-frame burst of the whole pool (`update` fills before it checks
the duration, IDA:845480-845502): 111 emitters that drew nothing. Object keys 146 and 147 give the
start/end or the uniform colours from the object's channels (IDA:306240-306299), and again each time
the game colours the object, so a colour trigger or pulse reaches them while the emitter is on
screen: 146 through `setStartColor` / `setEndColor` with the alphas kept, which only new particles
read, and 147 straight into the ramp every particle reads each step (`setObjectColor`
IDA:298118-298160, `setChildColor` IDA:297876-297916; `update` IDA:845707-845725). The colour is the
object's as `colorForMode` makes it: the channel, each group's pulses, then the object's own hue
shift (IDA:173028-173089). That re-read was added after review on 2026-09-29; before it the colours
were read only when the emitter came on screen, which froze 12 official emitters on a channel or
group that a colour or pulse trigger changes (Dash 7, The Secret Hollow 5). A fade scales the
alpha, and an additive particle's colour too (IDA:848040-848063). A respawn starts the field over
without replaying Animate triggers from before it (the game side is not traced). Since the
completeness pass each emitter sits where its object is now (`GameObject::setPosition`
:164602-164627) and takes its turn and scale as its position type says: a grouped one (type 2, 861
of the 1,000) is a node turned and scaled with the object, flips as negative scales, particles out
included (`setRotation` :164465-164492, `setScaleX/Y` :164354-164455, `applyParticleSettings`
:306209-306232); a relative one (type 1, the other 139) is never turned, its emission angle is the
definition's less the object's turn, or through the object's transform when it is flipped
(`updateParticleAngle` :306105-306146), and it takes a scale only from a scale trigger while it is
on screen (`updateParticleScale` → `loadScaledDefaults` :846625-846642: sizes, spread and speed).
- Game (`particleFromStruct` IDA:44043-44063, `initParticle` IDA:844801-845003, `update`
  IDA:845515-845794): 56 turns particles to face their motion; 58 uniform colour (with object key
  147 the colours come from the object's channels, IDA:306008, 306290-306297); 59/60 and 68-71
  friction P, S, R and their variances (S damps the size change, not the speed; P damps gravity
  mode's direction, which radius mode never reads, so it does nothing there, IDA:845769-845775);
  61/62 respawn (`updateSyncedAnimation` IDA:301809-301848, caller not traced); 63
  order-sensitive; 66/67 start / end RGB variance sync. Fades (41-44) and rotation-is-direction (55) are applied too (IDA:848047,
  848056, 845070-845105).
- Port: `render/particles.ts:103-161` reads 0-55, 57, 64, 65; the emitter never uses the fades or
  55. `triggers/registry.ts:182` says friction and respawn are parsed; they are not.
- Levels: 1,000 emitters (object 2065), only in Dash and the tower floors. 236 set an ignored field:
  friction 191 (Dash's strongest two travel ≈ 450 units instead of ≈ 85), uniform colour 17, dynamic
  rotation 7, respawn 21 (8 in The Tower never emit at all). The bigger gap: fades are ignored on 912,
  rotation-is-direction on 64.

### Tier 5 — latent: no official level changes; matters for online and editor levels

#### 31. The teleport offset defaults to 90; the game uses 0 (open item 4)
Confirmed; the wiki gives no default. **Fixed 2026-09-28** (`test/teleport.test.ts`): key 54 falls
back to 0 and `TELEPORT_DEFAULT_OFFSET` is gone.
- Game: key 54 is read with a 0.0 fallback (IDA:303108-303113; `create` also starts it at 0,
  IDA:310589); `PlayLayer::addObject` builds the exit at portal y + that (IDA:89924-89937), with no
  other fallback. The only non-zero default is the editor's 100 for a new portal (`addSpecial`
  IDA:201251-201258). Saves always write key 54 (IDA:321269-321280).
- Port: `physics/collision.ts:541-543` falls back to `TELEPORT_DEFAULT_OFFSET = 90`
  (`constants.ts:559`). Its docstring (550-558) is half right: `teleportPlayer` does recompute the
  offset (IDA:462318-462323), but from an exit that was placed at +0.
- Levels: all 23 official 747s carry key 54 (−320 to 212). Fix: fall back to 0; the editor shows a
  new portal's exit 100 up.

#### 32. Key 21/22 of 0 or less draws white
Partly: real in code, invisible in the official levels. **Fixed 2026-09-28** (`test/decode.test.ts`):
the decoder clamps as the game reads, so `baseColor`/`detailColor` are null for 0 or less.
- Game: clamps as it reads (IDA:184352-184378, `sub_346CD4` IDA:165199): above 1100 → 1101, 0 or
  less → the default channel (`getColorMode` IDA:165461). Both keys go through `atoi`, so 7.9
  reads 7 and text reads 0; with key 19 set neither is read (#23).
- Port: `level/decode.ts:232-233` copies the raw value; `render/colors.ts:435-437` returns white
  below 0, and channel 0 is white (231).
- Levels: only Geometrical Dominator's 66 black sludges (919, key 21 = −1), which the "K" slot
  already draws black (`drawList.ts:673`).

#### 33. Follow Player Y (1814) reads key 105 as a multiplier
Confirmed; 0 official uses. **Fixed 2026-09-28**; since 2026-09-29 each member closes its own gap
from where it is now, as the game does (a per-object lift in `TriggerRuntime.objectTransform`,
carried by snapshots and the state hash).
- Game (IDA:299193-299231; `processPlayerFollowActions` IDA:427914-428015): 90 speed, 91 delay,
  92 offset (an int), 105 max speed, all default 0. Each tick each object moves toward (player y
  `delay` seconds ago + offset) by speed·dt·60 of the gap (clamped 0..1), limited to ±max·dt·60 when
  max > 0. Speed ≤ 0 ends the command at once.
- Port: `triggers/runtime.ts:1814-1822, 976-979` copies the player's y change × key 105 (default 1)
  onto the whole group; 90-92 are never read. The note at `triggers/registry.ts:106` is wrong too.

#### 34. Camera Mode (2925) reads key 1 for free mode
Confirmed; 0 official uses. **Fixed 2026-09-28** for the corridor: 111 is the layer's free-mode
flag (the port's `corridorFree`) and 370 its no-snap flag, set by a Camera Mode trigger and by mode
and dual portals alike (`playerWillSwitchMode` IDA:462525, `toggleDualMode` IDA:462688). The easing
and padding (113, 114) shape the camera's free follow since 2026-09-29: for a mode other than the cube
and robot with no corridor, the player may stray half the view less padding × (half − 32) + 30 from the
centre, and the easing divides the tick as the fixed 10 does, 1 or less snapping (`updateCamera`
:449705-449710, 450219-450236, 450572-450590). Since 2026-09-30 the rest of `updateCamera` is the
game's too (`render/camera.ts`): the 75 / zoom gameplay offset, the axes swapped in rotated gameplay,
the game's y 0 floor and level top, the edges' soft stop, the static camera's approach and hand-back,
all per tick. Since 2026-10-01 also the level's left stop at x 15 (kA23/kA24, :449613-449619), the
teleports' camera keys 55, 464 and 510 and checkCameraLimitAfterTeleport after a teleport or a
spider's jump (:450837-450857), and the platformer's soft stop into every limit (:450439, :450500).
Since 2026-10-01 the flying corridor is the game's too: its middle becomes the static y, eased in
over the ground layers' 0.5 s (0.4 s on a change), unless a Static Camera trigger holds y, and its
band is measured on the screen (`Sim.refreshBand`; `animateInDualGroundNew` :451047-451152,
`getMinPortalY`/`getMaxPortalY` :420443-420510, `updateCameraBGArt` :431194-431213). What is still
the port's own is the rest of the platformer camera (+10734: its 27.5 / 55 dead zone), which is not
built.
- Game: 111 free mode, 112 edit settings, 113 easing (float, clamped 1-40), 114 padding (0-1), 370
  (IDA:299720-299744; `updateCameraMode` IDA:451188-451232).
- Port: `triggers/runtime.ts:1481-1482` reads `flag(spec, 1)`, the object id, so it is always false,
  and `camera.freeMode` is never read anywhere. Portals read 111 correctly (`collision.ts:396`), but
  not 112-114 (one Dash swing portal sets them) or 370.

#### 35. Activate Group on Count, Instant Count and Collision only spawns
Confirmed; no official target group is ever off. **Fixed 2026-09-28**, collectibles included.
- Game: `toggleGroupTriggered` (IDA:423103-423110) turns the group on, then spawns it — from Instant
  Count through vtable+612 (IDA:429136-429166), from Count (IDA:487511) and Collision (IDA:482335)
  through the effect-manager delegate (both slots inferred from their signatures).
- Port: `triggers/runtime.ts:1835-1836` and `1280-1281` only spawn, and `spawnGroup` skips a
  disabled group (1200-1202).

#### 36. Start-position settings are dropped (goal-6 plan B1)
Partly: all 12 official start positions are disabled, so play is unchanged. **Fixed 2026-09-28**
(`test/startpos.test.ts`, `test/timetable.test.ts`): the decoder keeps a start position's block
(`LevelObject.settings`), `pickStartPosition` picks as `addObject` does, and the sim starts there.
What the entry below does not say, and the port now does:
- The game warms the level up to the start position before the run: `loadStartPosObject`
  (IDA:469534-469590) → `loadUpToPosition` (IDA:469428-469517) walks player 1 along the level's
  time table in float 1/60 s steps (`ceilf(T / step) + 1` of them, T capped at 3600 s), running the
  music clock (+800 and +792, IDA:469472-469474; the level time +11296 stays at the 0 `resetLevel`
  set, IDA:105896), the spawn queue, the moves and the pass-by check twice a step, the second on the
  channel `posForTime` reports (+728 = +732). T is `timeForPos((x, 0), kA19, kA26)` at the level's
  own speed, so kA19 is also the order the warm-up measures to. Song and SFX triggers do not play
  while loading (+11600) but are recorded with the music clock (`activatedAudioTrigger`
  IDA:447750-447840, +800 at IDA:448042), and `startMusic` replays them for a start position
  (IDA:105410-105415 → `processActivatedAudioTriggers` IDA:454746-454870), each song sought to
  where it would be now (`processSongState` IDA:432553ff). The port keeps the last Song trigger,
  sought the same way, and drops the one-shot sounds. A Teleport trigger does move player 1
  (`teleportPlayer` has no loading check), and each step's player delta is measured from where
  player 1 is (IDA:469476-469480). An End trigger on the way ends the run: `activatePlatformerEndTrigger`
  (IDA:93034-93065) has no loading check either, so it locks the players and stops the level time
  during the load, and the port finishes the run with the pass-by check after the warm-up. Then
  y velocity 0, kA35's camera reset and `setupLevelStart` again (`sim.warmUp`,
  `physics/timeTable.ts`).
- The time table: speed portals, Reverse, Song, Time Warp, Rotate Gameplay and teleports with key
  13, and any effect object with keys 117 and 13 (`addObject` IDA:90352-90360;
  `sortSpeedObjects` IDA:122945-123144, `timeForPos` IDA:123161-123449, `posForTimeInternal`
  IDA:122123-122345). The speeds are the floats 311.580109, 251.16008, 387.420136, 468.000153 and
  576.000183; a Time Warp without key 120 counts 0.
- A start position is used in normal play and makes the run a test (+10956): no best, no
  completion, the attempt still counted (`destroyPlayer` IDA:93199-93203, `levelComplete`
  IDA:92666-92696). The music starts at the warm-up's time. The game snapshots the start state at
  the first `startMusic` (IDA:105384-105425) and resets to it. The port did the warm-up again each
  attempt with a fresh seed, so a Random trigger on the way could decide differently each time;
  since 2026-09-29 `Game.restart` keeps the first attempt's warmed-up sim and snapshot for the visit
  and loads them back, with the new attempt's own seed and number (`resetLevel` :105790-105797,
  105898-105905, 105942-105944; released only with the layer :101875).
- The corridor hangs from the start position while no portal has set it
  (`getTargetFlyCameraY` IDA:420349-420385).
- Game: an object-31 string goes through `StartPosObject::loadSettingsFromString`
  (IDA:106661-106668, 310535-310546), with its own kA19 target order, kA21 disable, kA26 target
  channel and kA35 reset camera, and is written back by `getSaveString` (IDA:318484-318497,
  202339-202458). `addObject` skips a disabled one (IDA:90281-90315) and starts the run from the
  enabled one with the highest kA19, then by x (reversed with kA20), in test mode; the editor does
  the same (IDA:191606, 191653).
- Port: `level/decode.ts:204-207` drops non-numeric keys; `physics/sim.ts:254-261` keeps x and y
  only and never starts from one.
- Levels: 12 (Dash 10, the Secret Hollow 2), 364 kA pairs lost on a round-trip, all kA21 = 1.

#### 37. Start-state and compatibility keys are not applied
Partly: all true, and the port hard-codes the kA27 = 1 and kA33 = 1 behaviour.
**Fixed 2026-09-28 and 2026-09-29** (below), but for kA43.
- Game: `setupLevelStart` (IDA:462728-462810) applies kA29 (rotate) and turns a platformer wave or
  swing start into cube (IDA:462752-462756). kA36 also works in classic, setting only y (`resetPlayer`
  IDA:425044-425078; a random member if the group has several). kA41 and kA33 go to every object
  (IDA:430498-430520), kA42 to the players, kA45 to player +2072 = !kA45. With kA27 off, a newer
  rotate command on a target group suppresses older ones (`prepareMoveActions` IDA:486271-486279,
  `processRotationActions` IDA:439888-439901): per target group, not per (target, centre) pair.
- Port: `physics/sim.ts:466-523` ignores kA29, uses kA36 only in a platformer (`list[0]`), passes a
  wave or swing start straight through; kA27, 33, 41, 42, 43, 45 are never read. Rotates always stack
  (`triggers/runtime.ts:950-955`) and scale always takes `Math.abs` (`collision.ts:1266, 1279-1286`),
  which is right for Dash and the tower floors (kA27 = 1 everywhere, kA33 = 1 except 5001).
- Levels: none change. Pre-2.2 online levels without kA27 will diverge where two rotates share a
  target group.

**Fixed 2026-09-28** (`test/startpos.test.ts`, `test/compat.test.ts`), except kA33 and kA43-kA45,
which followed on 2026-09-29 but for kA43:
- kA33 (settings +359 → +1549 → the object's +729): without it `getObjectRect` keeps the scale's
  sign (IDA:170826-170830), so a negative scale turns an upright box inside out and CCRect's test only
  meets a player spanning it. The ObjectSet keeps the ends that way round for upright boxes, and the
  broadphase files them by their real extent; oriented boxes, circles and slopes are the same shape
  either way. The hitbox offset takes the sign in either case (`getBoxOffset` IDA:170768-170795).
  Official: none (no negative object scale; 5002-5004's mirroring scale triggers are all under kA33).
- kA44 (an int, settings +344 → the level's +784): the percentage is the steps run (+824) out of it
  (`getCurrentPercent` IDA:91461-91487).
- kA45 (+367): both players' +2072 = !kA45, which the Options trigger's key 593 also sets; read by the
  +2372 slide (#1).
- kA43 (+342) only spares a platformer's saved score the time penalty (`levelComplete`
  IDA:92795-92796 before `saveNewScore`); the port saves no platformer score, so it has nothing to
  act on.
Corrections:
- "Levels: none change" is wrong for kA41. No official level has kA41 = 1, so a solid, breakable or
  slope carried round a centre keeps its own angle (`applyLevelSettings` IDA:430498-430517,
  `canRotateFree` IDA:168950-168958 types 0/21/25, the gate in `processRotationActions`
  IDA:440008, 440043). Dash's three swaying pillars (x 525/645/765) and The Tower's three wheels of
  1903 platforms stay level in the game; the port turned them. The port now gives such an object a
  transform with no turn in it (`TriggerRuntime.objectTransform`), which the draw list uses too.
- kA28 "Mirror Mode" is read by nothing in 2.206: every access to settings +278 is a write, the
  save or the editor's toggle. The port mirrored the start with it and no longer does.
- kA36 takes the group's main object (key 274, else the only member) first, and only then a random
  member, drawn in `resetLevelVariables` before the attempt's `fast_srand` (IDA:105781, 105797):
  the port's first member loses nothing a replay could follow.
- kA29 sets the flag alone (`rotateGameplayOnly` IDA:145549-145553): no velocity handover, and
  player 2 starts unturned.
- kA42 charges `reversePlayer`'s offset (+1984, twice the gap to the object's point where it is now,
  `getRealPosition` through vtable +672, so a pad a group has moved counts where it is) and
  `update` pays it off at 2% of each forward step (IDA:148376-148389, 161082-161113); a checkpoint
  keeps it as a float.
- `resetLevel` runs a pass-by check before the first step when there is no start position or
  checkpoint (IDA:105954-105963), so triggers at or behind the start fire at time 0, not in step 1.
  After a start position's warm-up, `PlayLayer::init` runs one (IDA:106486), with player 1
  back on the start position; the warm-up's last point can stop a float short of it.
- Without kA27 a 0° rotate is still a command (`createRotateCommand` IDA:489608-489645 has no angle
  test). `runRotateCommand` makes it done at once (IDA:716195ff, +112 and +114), so it is listed
  for one step, as the newest on its group, and erased (`prepareMoveActions` IDA:486713-486718):
  an older rotate on that group loses that one step.

#### 38. The level-string decoder has no raw fallback
Confirmed. **Fixed 2026-09-28** (below).
- Game: `ZipUtils::decompressString` (IDA:882878-882963) returns its input unchanged when the base64
  (IDA:873710-873724) or inflate step fails; `PlayLayer::init` (IDA:107075-107093) runs every level
  through it and fails only on an empty result. cocos base64 skips bad characters, stops at the first
  `=` and drops an unpadded tail (IDA:873462-873575).
- Port: `level/decode.ts:66-74` treats only `kS`/`kA`-prefixed input as plain; other plain text
  decodes to garbage, and a bad gzip or zlib stream throws (leaving unhandled rejections, 45-46).
- Levels: all 27 decode identically. Fix: fall back to the input on failure; optionally stop at `=`.

**Fixed 2026-09-28** (`test/decode.test.ts`): the decoder is cocos2d's and falls back to the input.
The table is one static both alphabets fill (IDA:873487-873511), so either alphabet's characters
count, and the fill runs to index 64, each alphabet's NUL terminator: a NUL is a character worth 64.
Two differences remain: the port trims whitespace and a BOM before it starts, and
`DecompressionStream` rejects data after a complete stream (zlib ignores it) and decodes every gzip
member (zlib stops after the first). Neither occurs in an official file.

### The port's `[boom]` citations
- Backed by the decompile: `BALL_CLICK_FACTOR` (`physics/constants.ts:152`; IDA:155858-155859),
  `SWING_CLICK_FACTOR` (`constants.ts:206`; IDA:155610-155615), the `sim.ts:806` comment
  (IDA:160528-160531), and the untagged boomlings mentions at `constants.ts:145, 419` and
  `player.ts:1154`.
- `DASH_GRAVITY_QUICK_CLICK_FACTOR` (`constants.ts:514`) cites only the wiki and nothing uses it.
  The behaviour it names is real (IDA:160103-160134, 151156-151158, 159516-159524, 149747-149760).
  **Removed 2026-09-28**: the halving is `flipGravity`'s own `* 0.5` (IDA:151156-151158,
  `GRAVITY_FLIP_VELOCITY_FACTOR`), inside the flip rather than before it, and `stopDashing` has
  none (IDA:149747-149800).
- No `[boom]` value is contradicted by the decompile.
- Not a `[boom]` matter, found while checking them: the decompile prints a float literal to five
  significant figures (0.017453, 0.5875, 0.725, 0.61538 above). The four spin times
  `CUBE_SPIN_SECONDS` 0.43333, `CUBE_SPIN_SECONDS_MINI` 0.33333, `BOOST_SPIN_SECONDS` 0.86667 and
  `BOOST_SPIN_SECONDS_MINI` 0.66667 are such prints: the exe holds the floats of 13/30, 1/3, 26/30
  and 2/3 (3eddddde, 3eaaaaab, 3f5dddde, 3f2aaaab) and none of the four truncated values. The spin
  angle feeds the player's oriented box, so this can move an oriented-object contact by a hair. Not
  fixed; worth its own entry.

---

## Where the wiki is wrong or out of date

No claim was refuted outright; where only part of a claim held, the entry above says what is true.
One line each, by page.

### Player physics (https://boomlings.dev/reference/player_physics/…)
- hitboxes: the spider box is 27 (mini 16.2), not 27.5 / 16.5 (IDA:152721-152723, 150441-150442).
- hitboxes: the spider inner box is 8.1 (0.3 × 27), not 9 (IDA:170812-170848).
- hitboxes: the mini inner box is 9 (wave 3), not 10; the vehicle size does not scale it
  (IDA:167400-167455).
- orbs_and_pads: the spider pink orb is 0.72 × 0.7 = 0.504 j, not "spider yellow × 0.77"
  (IDA:160178-160182, 160348).
- orbs_and_pads: the swing green orb is 0.6 j, not 0.7 j (IDA:160282).
- orbs_and_pads: the spider black orb writes −16.5 (IDA:160366-160369); the next `updateJump` clamps
  it to −15 unless the spider is still in its post-jump state (IDA:155991-156008). Incomplete.
- orbs_and_pads: there is no "180 − θ" dash-orb mirror; the negated angle is clamped raw
  (IDA:148639-148690).
- orbs_and_pads: the swing yellow pad gives 9.6, then 8 on the next tick (IDA:157084, 155630-155631).
- gamemodes: "ticks held 2" for flying modes is not a delay (gd-discrepancies §2).
- gamemodes: the robot hold also ends when its accumulator reaches 1.5 (≈ 67 ticks, 0.28 s), on pads
  in kA34 / platformer levels, starts spent on entering robot or spider, and is eaten by an upward
  force (IDA:155924-155926, 157053-157054, 152724, 153225, 161424).
- gamemodes: gravity depends on speed only for cube and robot; the other modes use 0.9582 at every
  speed (IDA:155463-155464).
- gamemodes: the UFO is also capped at +8, and the ship's two caps apply every tick, held or not
  (IDA:155558-155593).
- gamemodes: the spider's hazard check is a strip 8 × size wide down its centre (4.8 mini), and its
  surface search runs to 1 unit past the leading edge, not the blue box (IDA:154751, 154844-154903).
- force_blocks: the formula is the cube's only (port bug §1 has the rest).

### Level components (https://boomlings.dev/resources/client/level-components/…)
- reference/keys is the XOR key table, not object keys; those are on level-string.
- level-string key 36 is not an X lock: every trigger saves it (IDA:316462) and it sets key 35's
  default (IDA:299802-299812); 150 object ids carry it.
- level-string key 13: on speed portals it enters the x-to-time table (IDA:90356-90360,
  87537-87545); on triggers it is a separate flag (+1576).
- level-string types: 28/29 and 113 are floats; 92 is an int (IDA:299213-299216).
- level-string key 54: no default given; it is 0 (IDA:303108-303113).
- level-string key 77 is not read on a pickup item (IDA:459006-459021); the key 79 enum is missing
  (1 count, 2 toggle; key 382 also toggles, IDA:298751-298760).
- level-string key 19: any non-zero value skips 21/22, and it lands on the detail colour when there
  is one (IDA:184334-184350).
- level-string keys 155/156 occur only in the 2.2-era levels and nothing in gameplay reads them
  (≈ IDA:184098-184105).
- level-start: kA26 is labelled "Target Order" (it is the target channel); kA16's text says "fade in"
  (it fades out).
- level-start kA38: spawn-targeted groups are sorted without it; it extends the sort to every group
  (IDA:453213-453279).
- level-start kA31: a platformer always has the squeeze check (IDA:462941-462955).
- level-start kA36: in classic it sets only the start y (IDA:425053-425063).
- level-start: kA1 is neither read nor written by 2.206; kA12 is read, as colour 3's blending in the
  pre-1.9 path (IDA:195995-195998).
- level-start: the pre-1.9 table omits kS21-kS26 and kS28 (IDA:195898-195925, 195989); kA23, kA24
  (a camera clamp, IDA:449614-449618) and kA44 are missing (IDA:196189-196195, 196309-196311).
- color-string: opacity (7) is used only when 8 > 0, and the writer always adds `8_1`
  (IDA:480437-480447, 483843-483848); 18 is written but never read; 19 (a flag) is missing; ids above
  1101 are dropped (IDA:480590-480592); kS38 beats kS29-kS37, and colours are skipped when kA9 = 1
  (IDA:196317-196333).
- level-colors: the LBG formula is wrong; the game shifts the BG by s −0.2, v +0.2 and blends toward
  P1 by sum/150 only when R + G + B < 150 (IDA:475037-475075). The port follows the game.
- guideline-string: 0 is stored as 0.8 (orange), other values under 0.8 are not drawn, and lines sit
  at time − kA13 (IDA:200040-200070, ≈ 194838-194860).
- topics/levelstring_encoding_decoding: out of date for 2.2; official levels are
  `Resources/levels/<id>.txt` holding the full `H4sIAAAAAAAA…` stream (IDA:380215), not
  LevelData.plist minus 13 characters.
- replay-string: says 5 metadata values and lists 6; the format is 2.208+ and not checkable here.
- particle-string: the three "start = end" toggles (55, 65, 66) make the end value a delta on the
  start, not a constant; FrictionS damps the size change, not the speed.

### Save, shop and vaults
- topics/vault_codes (and reference/salts): 2.206 compares plain lowercase literals with spaces
  removed (IDA:566675, 570570); the "ask2fpcaqCQ2" salt and XOR 19283 appear nowhere in it.
- topics/vault_codes: "gimmethecolor" is "gimmiethecolor"; "glubflub" is "glubfub" and needs UGV 3.
- topics/vault_codes leaves out the entry gates (The Vault 10 user coins, IDA:360799-360802; Vault of
  Secrets 50 diamonds, IDA:238566-238567; Chamber of Time UGVs 7/8 and the Master Emblem,
  IDA:337813), "a head" for "ahead", and "thechallenge".
- topics/shop lists 118 of 2.206's 283 listings: no Mechanic, Diamond Shopkeeper, paths or 2.2
  additions (IDA:354417-354730). Every row it does list is right.
- gamesave/GS_Value: stat 29 is the spendable diamond balance, not "Diamond Shards"
  (IDA:355252-355310, 357342-357344, 349086-349097).
- gamesave/valueKeeper omits the `item_` prefix (IDA:116198-116280).
- gamesave/GS_Value: coin keys are `unique_{levelId}_{coinIndex}` (plus gauntlet and daily forms).

### Songs and SFX
- reference/songs says 39 songs; there are 40 (0-39) plus practice (−1).
- reference/songs credits "Secret" to RobTop; the exe's artist switch gives it DJVI (VA 0x140329040)
  and has no RobTop (IDA:121280-121353). Possibly from outside the binary.
- resources/client/musiclibrary: 12 song fields; 2.206 reads 0-10 (IDA:397908-398230). Its four
  sections match 2.206; the goal-6 plan saw 7 in the live file (not rechecked).
- resources/server/song key 16 is newer than 2.206, which reads 1-7 and 10-15 (IDA:397300-397450).
- topics/cdn_token: the `=` padding is stripped, so the token is 22 characters (IDA:392720-392760).
- Spelling: the binary has "Back On Track", "Base After Base", "ForeverBound".

### Servers
- endpoints/levels/getGJLevels21: the songs segment is separated by `~:~`, not `:` (IDA:397762,
  270893).
- resources/server/hashes, downloadGJLevel hash 2: the 8 values are comma-joined (IDA:271840).
- endpoints/levels/getGJDailyLevel: 2.206 already sends `type` 0/1/2 and no chk (IDA:283656); `-2` is
  an undocumented no-level state (IDA:268434-268510).
- resources/server/level key 15: 5 means platformer (IDA:269836-269866).
- topics/encryption/chk, "download level": omits its salt xI25fpAapCQg and XOR key 41274
  (IDA:280233-280262).
- endpoints/generic `dvs`/`gdw` and getGJGauntlets21 `vkey` are newer than 2.206 (IDA:263730, 280060).
- endpoints/levels/downloadGJLevel22: 2.206 sends inc=1 without an account (IDA:280204-280263).

---

## Leads on the open items (gd-discrepancies, "Open")

### 1. Deadlocked at x ≈ 20860: teleport #11697 lands the ship on spikes
**Fixed 2026-09-28** (`test/teleport.test.ts`). The diagnosis first written here mixed frames; the
cause is the portal's box. Confirmed by the final re-solve: Deadlocked finishes (tick 24343), its
route through #11697 with no dead end on the way.
- The port's y is the level file's y, and the game's is 90 more. #11697 (20887, 153) carries only
  key 54 = −94, so the player keeps its x (IDA:419427-419431) and exits at file y 59 (game 149):
  59 *above* the ground, in the lane under the slabs at y 99, not under the floor. Spikes #11700
  (y 75), #11701 (y 45) and #11702 (y 15), id 421 turned 90 at x 20846, stand in that lane. The
  second pair has the same shape: #12510 at y 59 exits at 155 (key 54 = +96), spike #12512 at
  (22861.2, 109.675, turned 180).
- 747 and 2902 have a box offset of (12, 0) along their own x: `GameObject::customSetup` LABEL_961
  (IDA:179044-179052) sets type 28, m_width 25 and +612 = (12, 0); m_height stays the content size,
  90; `getBoxOffset` (IDA:170767-170800) turns the offset with the object. The port centred the box,
  so a ship going right met #11697 12 units early, its left edge at 20845.98, inside the spike column
  (x 20843.4-20848.6). With the offset it goes through at x 20872.28, clear of it, and lives; #12510
  the same (22870.65 → 22881.95).
- (a) Nothing puts a teleported player back inside a band: `checkCollisions` reads and clears +1168
  first (IDA:464675-464676) and skips only the band test (IDA:464763), and the hazards gathered in
  the pass are tested after the walk (IDA:465008-465057), so after a teleport in it. (b) 747 is
  25 × 90 plus the offset. (c) 421 is `m_width × 0.3, m_height × 0.4` with m_width/height the
  sprite's content size (`commonSetup` IDA:166725-166726, the scales in customSetup LABEL_911
  IDA:177741-177744): pit_05_001.png is 121 × 52 px at uhd, so 9.075 × 5.2; 9.15 × 5.2 at hd;
  9 × 5.2 at sd, which is the port's. Left as it is: every content-size box depends on the texture
  quality this way, and the port's hazard table takes the sd numbers throughout. (d) The route takes
  #11697; #11698 (y 453, key 54 = −208) is the upper lane's.

### 2. Trigger channels (Dash)
**Fixed 2026-09-28** (`test/channels.test.ts`). What the decompile adds to the leads below:
- The pass-by triggers queue once per channel (`sortChannelOrderObjects` IDA:122777-122920). A
  channel's way is that of the first pass-by Rotate Gameplay in the level that switches to it
  (key 171, key 173 naming it; `getObjectDirection` IDA:168867-168889 from its turn and flips, the
  same as the key 167 the editor writes), right when none does. Each queue sorts by key 115, then key
  115 plus the activation point's x, −x, y or −y (ground at 90) as floats cut to an integer, then the
  unique id (`compOrder` and its three siblings, IDA:120294-120449).
- `checkSpawnObjects` (IDA:454433-454549) pops the active channel (+728) only, comparing x, or y
  while player 1 is turned, and against the way on a channel a left or down turn switched to
  (`rotateGameplay` IDA:442819-442828). It reads the channel and the turn afresh for each trigger, so
  a turn popped in the loop counts for the next one. In a platformer the player does not count: the
  queue runs on the music clock, x ≤ time × 311.580109 as floats (IDA:454460-454464,
  122165-122166; the exe holds that float, not 311.58's).
- `canTouchObject` (IDA:421284-421300) hides every effect object on another non-zero channel while
  one is active: touch triggers, orbs, pads, portals, collectibles, checkpoints.
- Dash's un-rotate #1199 now waits on channel 1 until the player has come down to y 135, and #16973
  fires once channel 15 is live.
- Final re-solve, 2026-09-29: Dash's best attempt reaches 75.4 % (tick 15805, x 18176), through the
  rotated maze of channels 4-10, the teleports at x 15555 and 15765 and the tap section, whose Touch
  trigger only gates secret coin 3 (#17928). It dies as a ship in the wavy tunnel at x 17745-18975,
  on floor block #12974 (18195, 661) of group 387: still open, see gd-discrepancies "Open".

Leads, as first written:
- The wiki's only channel keys are the start position's kA19/kA26 (Dash's are all disabled,
  kA26 = 0) and key 115, queue order (Dash #6396 has 115 = 100). The 2.2 list it links names 170
  channel and 171-173 change / only / target channel.
- Keys: trigger channel 170 → +1584 (IDA:298701); `RotateGameplayGameObject::customObjectSetup`
  reads 171 → +1656, 173 → +1660 (IDA:301448-301460).
- Dash's 20 Rotate Gameplay triggers form a chain over channels 1 → 15, each with 171 = 1 and the
  next 173 (#1327 at x 2265 sets 1, 2 at 6735, … #17001 at x 21555, y 2568 sets 15). The un-rotate
  #1199 at x 2143.5 sits on channel 1 and has no 173. #11143 has 172 = 1 instead of 173. Channel 10
  holds 48 triggers, channels 11 and 12 hold 12 each.
- Dash's End trigger #16973 (21853, 2707) is x-activated on channel 15: Dash cannot end until
  channels work.
- Dash has kA38 = 1, so every group is x-sorted (port bug §5).
- The tap section (x ≈ 15285-15525, channels 9/10) chains Touch #17920 (not built), Pickup #17922 and
  Item Compare #17924; it needs channels, §2 and the Touch trigger together.
- After channels, Dash meets its force fields (§1, ported). A push lands on yVel, which is world x
  while gameplay is rotated (IDA:313053, 161399); the circle at x 2587 is in a rotated section.
- Not related: a Song trigger's key 432 "channel" is an audio channel.

### 3. A spawned End trigger (3600) does nothing (tower floors)
**Fixed 2026-09-28** (`test/end.test.ts`). +628 is `activatePlatformerEndTrigger`: 1931's
`triggerObject` calls +624 with `activateEndTrigger`'s (int, bool, bool) (IDA:314937-314941), and
the two are declared side by side (IDA:185656-185680). `PlayLayer::activateEndTrigger` is empty
(IDA:86727-86731), so 1931 does nothing in play. Key 461 is no end sound: `showCompleteEffect` skips
endStart_02.ogg with it (IDA:88846-88870). 3600 ends a classic level as well (Dash's #16973). The
port stops at the lock and books the completion at once, practice or normal, as `levelComplete`
does; the one-second flight, the effects and the sound are for whatever draws and plays the finish
(`sim.end`). Of what `levelComplete` books for a floor, the port's save keeps the completion; the
coins are #10, and the port's achievement table has no tower01-04 entries to report to.
Final re-solve, 2026-09-29: no floor has a finishing macro yet, and the End trigger is not why. The
Tower completes from the solver's own state at its end door (tick 11210), and The Secret Hollow
from a start beside its touch spawn at (14291, 881), its End firing about 3.4 s after the touch.
What stops all four is the autoplayer's platformer guide (`test/macros/README.md`); The Sewers also
needed its trigger orb, fixed in the final check (status above).

Leads, as first written:
- `EndTriggerGameObject::customObjectSetup` (IDA:309857-309885): 51 → +1276 (a group spawned at the
  end), 71 → +1280 (a group whose main object is the end position), 460/461/487 → +1635/+1636/+1637.
  The linked 2.2 list names them no end effects, no SFX, instant. 460 = no effects is confirmed
  (`levelComplete` then skips `showCompleteEffect`, IDA:92649-92657) and 487 = instant (below).
- `triggerObject` (IDA:315851-315875) calls layer vfunc +628, most likely
  `PlayLayer::activatePlatformerEndTrigger` (IDA:93034-93065; the slot is not confirmed). It returns
  if player 1 is dead (+1968) or +11304 is already set; otherwise it stores the trigger (+12120), sets
  +11304 (which also forces the time warp to 1, IDA:86939), spawns +1276 if set, and calls
  `playPlatformerEndAnimationToPos` (IDA:92922-93030), which goes straight to `levelComplete` when
  +1637 (key 487) is set. The editor opens `SetupPlatformerEndPopup` for 3600 (IDA:213473).
- All four tower End triggers are spawn-triggered (62 = 1) with 460 = 461 = 487 = 1 and no 51/71: an
  instant, silent end at the trigger's own position (5001: 13215, 795; 5002: 5415, 465; 5003:
  10252.5, 712.5; 5004: 15573, 1502.9). The music is left alone (§17).
- It has to reach `levelComplete`, the only place tower rewards are booked: tower01-04 (normal mode,
  IDA:116850-116875), tower01Coin-04Coin (IDA:342692), coins (IDA:420676), the stat-8 recount of
  completed 5001-5004 (IDA:109456-109484). The Floor 1 dialog sets UGV 33 (IDA:685940-685964).
- Fix direction: 3600 in the trigger index as an effect object, not a 30 × 30 end block. 1931 is an
  effect trigger too (vtable +624 with keys 51/118/59), not an end block; no official uses.

### 4. `TELEPORT_DEFAULT_OFFSET`
Settled: the game uses 0. Port bug §31, fixed.

### 5. Follow (1347) copies no rotation
Settled: the game follows the main object's real position change, whatever moved it. Port bug §4,
fixed.

### Not on the list
Force blocks (§1) are Dash's next blocker once channels work. They were not: Dash's best attempt
lives through the circle at x 2587 and the swing fields at x 4665-4845 (§1).

---

## Digests for goal 6

### Save, progression, shop and vaults (6d)
Pages: https://boomlings.dev/resources/client/gamesave (and GLM, GS_Value, achievement, gv, kCEK,
quests, valueKeeper), /topics/shop, /topics/vault_codes, /topics/localfiles_encrypt_decrypt,
/reference/secrets. The full store table was extracted to scratch `boom/save/store_items.csv`.
- Save file: XOR 11, url-safe base64, gzip, which is enough to import a real CCGameManager.dat.
- Free unlocks (IDA:116305-116334, 116440-116466): cubes 1-4, the first of every other kind (death
  effects and trails too), colours 0-3, colour 1 and colour 2 unlocked separately. Defaults 0 and 3.
  The port matches.
- Stats: 1 jumps, 2 attempts, 5 demons, 6 stars, 8 secret coins, 9 menu icons destroyed, 10 likes,
  11 ratings, 12 user coins, 13 lifetime diamonds, 14 orbs, 15 dailies, 16-20 and 23-27 shards, 21
  demon keys, 22 lifetime orbs, 28 moons, 29 spendable diamonds, 30-39 paths, 40 gauntlets, 41 list
  rewards. Unlock keys also use `item_` (type 100), `special_` (99), `shipstreak_` (101).
- Shop (`createStoreItems` IDA:354417-354730; rows of listing, item, unlock type, price, shop).
  Unlock types: 1 cube, 2 colour1, 3 colour2, 4 ship, 5 ball, 6 UFO, 7 wave, 8 robot, 9 spider,
  10 trail, 11 death effect, 12 item, 13 swing, 14 jetpack, 15 ship fire. Shops:
  - 0 Shopkeeper: 42 items, 500-7000 orbs, 108,000 in all.
  - 1 Scratch: 39, 1000-15000, 131,000; includes the Master Emblem (item 4, 1000).
  - 2 Potbor: 72 at 2000/4000/6000/8000, 316,000.
  - 3 Mechanic: 40, 5000-40000, 378,000; ship fires 2-6, items 16 and 18-20, death effect 19.
  - 4 Diamond Shopkeeper: 80, 100-2000 diamonds, 34,800; item 17 (music unlocker).
  - 5 the ten paths: items 6-15 at 25,000 each (`isPathUnlocked` IDA:355135).
  - Shop 4 charges stat 29, every other shop orbs, stat 14 (`getCurrencyKey` IDA:349086).
    `purchaseItem` (IDA:352940) records listing → price in GS_6.
- Treasure Room doors (`SecretRewardsLayer::onShop` IDA:715329): Scratch (UGV 11), Potbor (20),
  Mechanic (35), Diamond (34), each after a dialogue once lifetime diamonds reach 500, 200, 2000 and
  1000 (IDA:714300, 714641, 714927, 715183).
- Orbs: a main level's base is 20 × stars + 20; levels 14, 18 and 20 pay 400 (`getBaseCurrency`
  IDA:342949). Paid in normal mode on death and completion (IDA:93263-93268, 92829) as
  floor(base × best % / 100) minus what was already paid; 100 % pays base + 25 %
  (`awardCurrencyForLevel` IDA:356267). One demon key per 500 lifetime orbs (IDA:355430, granted at
  IDA:92838-92842). Diamonds only from daily and gauntlet levels (IDA:356389): none offline.
- Vaults: input is lowercased with spaces removed (IDA:531590-531620).
  - The Vault (IDA:531436; needs 10 user coins): lenny cube 62; sparky coin secret06; spooky cube 51;
    blockbite UFO 11; robotop robot 2; ahead / "a head" wave 8; mule ship 20; neverending UFO 12;
    gandalfpotter trail 4; your own name cube 64; 8, 16, 30, 32, 46, 84 in sequence wave 13;
    finalboss a swing.
  - Vault of Secrets (IDA:566675; 50 lifetime diamonds): brainpower cube 80; cod3breaker (a 7-digit
    puzzle) cube 78; glubfub (UGV 3) coin secretB03; octocube cube 81; your star count cube 76; seven
    cube 108; gimmiethecolor colour1 37; thechickenisonfire colour2 33; d4shg30me7ry a cube;
    thechickenisready a ship; thechallenge opens The Challenge; unicorn, rubrubpowah123, battop,
    kappa, robtop dialogue only.
  - Chamber of Time (IDA:570570; UGVs 7 and 8 and the Master Emblem): darkness cube 91; silence cube
    89; river / "a river" colour2 38; hunger cube 90; volcano / "a volcano" wave 23; backontrack a
    spider; givemehelper a robot.
  - The Wraith is server-side.
- Secret coins: port bug §10. Extras: secret04 (tap the coin on the "−1" level page, within 30 units,
  IDA:339848-339885), secret06, secretB03. Offline maximum 79 coins → coins15.
- Chests: the Treasure Room needs 5 demon keys (IDA:238658-238710, sets UGV 5), i.e. 2,500 lifetime
  orbs. Rewards: `createSecretChestRewards` (IDA:345350-348347); special chests 0001-0024
  (`createSpecialChestItems` IDA:357686). Reward ids (kCEK): 1-5 shards, 6 demon key, 7 orbs, 8
  diamonds, 9 unlock, 10-14 tier-2 shards, 15 gold key. Menu chests are server-driven.
- Tower UGVs: 28 clicked (IDA:337781), 29 entered (IDA:685894), 33 floor 1 complete (IDA:685964).
- For the plan: "offline-buildable except the menu chests" is too hopeful. The Vault needs user coins,
  and the other two vaults and four of the shops need diamonds. Offline: the main Shopkeeper, the
  Treasure Room and the Tower.

### Audio
Pages: https://boomlings.dev/reference/songs, /resources/client/musiclibrary,
/resources/client/sfxlibrary, /endpoints/songs/*, /resources/server/song, /topics/cdn_token.
- Official songs: −1 practice (Stay Inside Me), 0-39 level songs; levels 1-22 use id − 1. The artist
  column matches the exe's `artistForAudio` for all but 26 and can fill the port's missing
  song-to-artist table (`tools/assets/strings.ts:220`). The PC install lacks 16 official tracks
  (22 Explorers, 23-25, 27-38); unknown indexes fall back to BackOnTrack.mp3.
- Files: ids ≥ 10,000,000 are library songs, `{id}.ogg` (CDN `/music/{id}.ogg`, `Resources/songs`);
  below that, Newgrounds `{id}.mp3` (`pathForSong` IDA:394118-394150). SFX `s{id}.ogg`
  (IDA:393881-393900); the port ships 260, all in the exe's table, and the tower uses 233.
- musiclibrary.dat: base64url + zlib; `version|artists|songs|tags`, records `;`-separated. Artist
  `id,name,urlencoded site,YouTube channel` (a space = empty); song
  `id,name,artistID,bytes,seconds,.tags.,platform (1 NCS),extra artists '.'-joined,link,new,priority[,number]`;
  tag `id,name`. 2.206 reads four sections and song fields 0-10 (IDA:397908-398230): parse tolerantly.
- sfxlibrary.dat: `files|credits`; file `id,name,isFolder,parent,bytes,centiseconds`; entry 1 is the
  root, named with the version; credits `name,link` (IDA:395316 onwards).
- CDN: base from getCustomContentURL.php (today https://geometrydashfiles.b-cdn.net);
  `/music/musiclibrary_02.dat` + `/music/musiclibrary_version_02.txt`, `/sfx/sfxlibrary.dat` +
  `/sfx/sfxlibrary_version.txt`. Optional token: `?token=&expires=`, expires = now + 3600, token =
  base64url(raw MD5(secret + path + expires)) without `=`, secret
  8501f9c2-75ba-4230-8188-51037c4da102 (IDA:392659-392780).
- In levels: port bugs §14-22 (song and SFX trigger keys, Edit Song edits a channel, the pitch table,
  the volume cap of 2, practice muting, the 0.65 death sound), fixed 2026-09-29.
- The pitch table (`pitchForIdx`, IDA:64678-64686) is only in the exe: a jump table at VA
  0x140056aec for the function at 0x1400569e0, float32 2^(k/12) for k = −12…12 but for +2, which is
  1.122562050819397 (2^(2/12) is 1.1224620…). `audio/pitch.ts`.
- A Song trigger's id is always a custom song (`activateSongTrigger` → `pathForSong`
  :446535-446537); `songPath` now routes by id range and `GameAudio.song` is gone.

### Level format, for the editor
Pages: https://boomlings.dev/resources/client/level, /resources/client/level-components/*,
/topics/levelstring_encoding_decoding; 2.2 keys on https://flowvix.github.io/gd-info-explorer/props.
- Container: base64 (url-safe or standard) of gzip or zlib. Decoding falls back to the raw string (§38).
- Level string: a header object, then `;`-separated objects of `,`-separated key/value pairs. Values:
  int, bool 0/1, float, `.`-separated int arrays, HSV `h a s a v a sChecked a vChecked`, base64 text
  (key 31).
- Header write order (`getSaveString` IDA:202324-202780): kS38, kA13, kA15, kA16, kA14, kA6, kA7,
  kA25, kA17, kA18, kS39, then kA2, kA3, kA8, kA4, kA9, kA10, kA22, kA23, kA24, kA27, kA40, kA41,
  kA42, kA28, kA29, kA31, kA32, kA36, kA43, kA44, kA45, kA33, kA34, kA35, kA37, kA38, kA39, kA19,
  kA26, kA20, kA21, kA11. A start position's header (kA9 = 1) leaves out colours, song, guidelines
  and art.
- New-level defaults (`LevelSettingsObject::init` IDA:205230-205314): kA27, kA31-34, kA37-42 and kA45
  on; BG (40,125,255), G1/G2 (0,102,255), line white and additive, MG/MG2 (40,125,255). Missing keys
  read as 0, so the editor must write these.
- Header keys: kA2 mode 0-7, kA3 mini, kA4 speed (0 1x, 1 0.5x, 2-4 2x-4x), kA6/kA7/kA25 textures
  (0 = first), kA8 dual, kA9 start-position flag, kA10 two-player, kA11 flipped, kA13 song offset (s),
  kA14 guidelines, kA15/kA16 fades, kA17 line, kA18 font, kA20 reverse, kA22 platformer, kA28 mirror
  (read by nothing in 2.206), kA29 rotate, kA36 spawn group. Start positions only: kA19 target order
  (also the order the warm-up measures to), kA21 disable, kA26 target channel, kA35 reset camera (the
  camera's turn and static camera after the warm-up). Compatibility: kA27 rotates on one target group
  stack (off: the newest wins); kA31 squeeze (always on in platformer); kA32 gravity-bug fix; kA33
  negative-scale hitboxes; kA34 robot pad jump; kA37 y-sections; kA38 sort every group; kA39 circle
  hazards; kA40 2.2 changes; kA41 static objects may rotate; kA42 reverse sync; kA43 no time penalty
  (platformer points, `levelComplete` IDA:92795-92796); kA44 the verified completion's frame count,
  which makes the percentage time-based (IDA:92689-92690, `getCurrentPercent` IDA:91461-91487);
  kA45 decrease boost slide. kA23/kA24 camera clamp. Switches are read with `CCString::boolValue`
  (anything but missing, empty, "0" or "false" is on), numbers with `atoi`.
- Start state (`setupLevelStart` IDA:462728-462810): kA11, kA20, kA29 (the flag alone), kA8, kA3,
  then the mode (wave or swing → cube in a platformer, the start position's own kA22 counting too),
  then the speed. With no start position or checkpoint, `resetLevel` then runs the pass-by check
  once (IDA:105954-105963).
- Object keys: level-string has 1-132 in their 2.1 meanings; the 2.2 list adds 170 channel, 171-173
  channel switching, 274 parent groups, 279 area parent, 131/132 warp, 155/156 colour indexes, the
  Item Edit/Compare, Pickup, Player Control (540-543), Teleport (345-354, 443, 464, 510, 591) and End
  (51, 71, 460, 461, 487) keys. Key 12 is the secret coin's index.
- Enums: mode 0-7 cube, ship, ball, UFO, wave, robot, spider, swing; speed 0 1x (311.58 u/s),
  1 0.5x (251.16), 2 2x (387.42), 3 3x (468), 4 4x (576); easing 0-18; pulse mode 0 colour, 1 HSV;
  pulse target 0 channel, 1 group; touch toggle 0/1/2; instant count 0 =, 1 >, 2 <; player colour
  −1/1/2; length 0-5.
- Colour string: `|` entries of `_` pairs: 1-3 RGB, 4 player colour, 5 blending, 6 id, 7 opacity
  (only if 8 > 0), 8 (always written 1), 9 copy id, 10 copy HSV, 11-13 target RGB, 14 delta, 15 target
  opacity, 16 duration, 17 copy opacity, 18 written but never read, 19 a flag. Channels: 1-999 custom,
  1000 BG, 1001 G1, 1002 line, 1003 3DL, 1004 obj, 1005/1006 P1/P2, 1007 LBG, 1009 G2, 1010 black,
  1011 white, 1012 lighter, 1013/1014 MG/MG2; ids above 1101 dropped. Legacy headers: kS29-kS37 (1000,
  1001, 1002, 1004, 1, 2, 3, 4, 1003) with the line forced additive, and kS1-kS28 before that.
- Guidelines: `~` time/colour pairs; 0 orange (stored 0.8), 0.9 yellow, 1.0 green; drawn at time −
  kA13. The port keeps only the times.
- Particles: object 2065 key 145, 72 `a`-separated fields.
- Capacity string: k67 on the saved level, 54 `_`-separated batch sizes. Carry it through unchanged.
- Saved level: k1-k125 plus kI1-kI7; 2.206 writes the subset in `encodeWithCoder` (IDA:272172-272378:
  no k39, k40 or k51-54, nothing past k112). k95 is the verification time in 240 Hz ticks.
- Replay string (2.208+, not checkable in 2.206): `;`-separated deltas in 480 Hz half-steps, negative =
  release; `,2`/`,3` P1 left/right, `,6`/`,7`/`,8` P2 jump/left/right; a leading `0` or `-0` for the
  initial hold; after `#`, seed, attempts, version 22, binary 47/48, 1, item-persistence data. Stored
  in k34/k119/k120, uploaded as `lrs`. Maps onto the port's macros (frame + buttons 1-3 + player 2): a
  converter halves the deltas to ticks and folds a same-tick press and release into `tap`.

### Online, read-only (6c)
Pages: https://boomlings.dev/endpoints (levels, lists, songs), /resources/server/*,
/topics/encryption/*, /reference/secrets, /reference/salts.
- Transport: POST to `https://www.boomlings.com/database/<name>.php` (the `www.` is required, else
  Cloudflare error 1020), form-urlencoded, empty User-Agent (Node's fetch sends its own; override it).
  No CORS, so a server proxy. Send `gameVersion=22&binaryVersion=42&secret=Wmfd2893gb7` (IDA:263730;
  binaryVersion ≥ 42 or no song segments); never accountID or gjp2. `-1` means error or no results.
  Rate limits (wiki only, Nov 2023): ≈ 20 downloads a minute, ≈ 2 requests a second elsewhere.
- Search, getGJLevels21: type, str, diff (`-` or a list: −1 N/A, −2 demon, −3 auto, 1-5), len (`-`
  or 0-5, 5 platformer), page (0-based), total, uncompleted, onlyCompleted, featured, original,
  twoPlayer, coins; optional epic/legendary/mythic, star/noStar, demonFilter 1-5 with diff −2, song
  (1-based official index) or song = id with customSong=1. Types: 0 search (text or id), 1
  downloads, 2 likes, 3 trending, 4 recent, 5 by user, 6 featured, 7 magic, 10 id list, 11 awarded,
  16 hall of fame, 21-23 daily/weekly/event history, 25 a list's contents. Response
  `levels#creators#songs#page#hash`: levels `|`-separated `k:v:…` (no key 4); creators
  `userID:username:accountID`; songs `~:~`-separated `k~|~v`; page `total:offset:10`; hash = SHA-1
  of each level's first id digit, last id digit, stars and verified coins, + salt `xI25fpAapCQg`
  (IDA:270802-270930; checking it is optional).
- Download, downloadGJLevel22: levelID (−1 daily, −2 weekly, −3 event), inc=0 (then no rs/chk).
  Response `level#hash1#hash2#user#songs#extraArtistNames`. hash1 = SHA-1 of 40 characters of key 4
  taken at step floor(len/40), + salt; hash2 = SHA-1 of the 8 values comma-joined, + salt
  (IDA:271790-271840). With inc=1: rs 10 characters, chk = base64url(XOR-cycle(SHA-1 hex of levelID,
  inc, rs, accountID, udid, uuid, salt; "41274")).
- Daily: getGJDailyLevel type 0/1/2 → `index|secondsLeft`; the level itself from downloadGJLevel22
  with −1/−2/−3.
- Map packs (getGJMapPacks21, page) → `packs#total:offset:10#hash`; keys 1 id, 2 name, 3 level ids, 4
  stars, 5 coins, 6 face (0-10), 7/8 RGB. Gauntlets (getGJGauntlets21, special=1) → `gauntlets#hash`;
  keys 1 id, 3 five level ids; names by id on /resources/server/gauntlet.
- Lists (getGJLevelLists): str, type, page, filters → `lists#creators#page#hash` (hash unchecked).
  Keys 1 id, 2 name, 3 base64 description, 5 version, 7 face, 10 downloads, 14 likes, 19 rated, 28/29
  times, 49 accountID, 50 username, 51 level ids, 55 diamonds, 56 required. Contents via
  getGJLevels21 type 25.
- Level object (/resources/server/level; IDA:270126-270560): 1 id, 2 name, 3 base64 description (may
  hold `<cX>` colour tags), 5 version, 6 playerID, 10 downloads, 14 likes, 45 object count, 18 stars,
  19 feature score, 42 epic/legendary/mythic, 37/38 coins/verified, 15 length (5 platformer), 12
  official track (0-based), 35 custom song (0 = use 12), 30 original, 31 two-player, 28/29 relative
  times. Download only: 4 level string, 27 password (base64 → XOR "26364" → int; 0 no copy, 1 free
  copy), 40 low detail, 41 daily id (+100000 weekly), 52/53 song and SFX ids used, 54 size, 57
  verification frames. Face: 25 auto; else 17 demon, with 43 = 3 easy, 4 medium, 5 insane, 6 extreme,
  anything else hard; else key 8 > 4 → lround(key 9 / key 8); else N/A.
- Songs: getGJSongInfo (songID) → 1 id, 2 name, 3 artist id, 4 artist, 5 MB, 6/7 YouTube, 8 (meaning
  unclear), 10 URL (percent-encoded), 11 NONG type, 12-15 extra artists and new flags; `-2` = not
  allowed. Newgrounds ids are mp3s at key 10 (seen on audio.ngfiles.com and geometrydashcontent.com;
  fallback newgrounds.com/audio/download/<id>, IDA:395879): allowlist those hosts. getGJTopArtists:
  `4:name[:7:channel]|…#total:offset:20`.
- Keys: level salt xI25fpAapCQg; XOR 41274 (level chk), 26364 (password), 57709 (CDN secret), 59182
  (chests), 19847 (daily). Accounts (gjp2 = SHA-1(password + "mI29fmAnxgTs"), secret Wmfv3899gc9) and
  uploads are out of scope.
- Physics for online levels: 2.206 gates only replay decompression on the level's key 13
  (IDA:106937); older behaviour comes from the kA flags, which the port reads. No version switch.
- Plan corrections (`gd-goal6.md`, 6c): add the `www.` and the rate limits; the daily level comes from
  downloadGJLevel22; this wiki already documents `type` and `.ogg`; the "7 sections" is not what 2.206
  parses; the response grammar is richer than `:` and `#` (`~|~`, `~:~`, `|`, base64, XOR,
  percent-encoding); song audio needs three hosts besides the CDN.

---

## Not covered, and not verified

### Not covered
- Account, social, upload, rating and moderation endpoints and resources (skimmed at most; 6c is
  read-only).
- topics/encryption/zip is empty upstream (a 0-byte source file).
- The gamemodes page's Desmos gravity graph (only the 1x cube 0.216 per tick was checked).

### Claims left unverified
- kA23/kA24 beyond the camera clamp (the clamp itself: the view's left edge stays at x 15 or right
  of it unless kA24, on a run from the level's beginning or with kA23 on any run; updateCamera
  IDA:449613-449619).
- Key 440 on the tower pickups (value 100) and key 13 on triggers: no meaning found.
- Time warp: inferred from the absence of an audio call; Dash x 4535 was not heard in the real game.
- Practice Music Sync = shop item 12/17 and gv 0125 = the editor option: inferred from UI strings.
- 10006555: Android's resource list has it, the PC table does not; the port ships all 9 songs.
- The Challenge's credit in the real game (DJVI, RobTop or blank).
- Not simulated: The Cellar's force circle (Dash's are, §1); squeeze in moving-block sections
  (approximate, §7); whether the Secret Hollow's doors 494/549 block the only route; whether Dash's
  coin 1 is collectable (§6).
- Online (server behaviour, not in the decompile): the rate limits, CDN token enforcement, a daily
  type=2 chk on the live server, the legendary/mythic swap, song key 8's meaning, getGJSongInfo's
  error codes, the level password's +1,000,000 storage, musiclibrary_02.dat's seven sections (not
  downloaded), the tag colour values.
- Save: rewards of achievements missing from the reward table (v2.secret09/10, v3.secret06/07,
  secret18/19; kinds only); which special chest 0001-0024 holds which bundle; the Treasure Room's
  count (325 reward constructions against the plan's 69); shop 5's currency; GJItem 16; the
  cod3breaker rule; the 2.2 glow colour (playerColor3). Attempts: the game counts one at every reset,
  practice respawns included (IDA:105985), the port at death and finish; they differ only on a quit,
  not treated as a bug.
- The replay string's half-step to 240 Hz tick mapping.
- getLevel's +135 = 5 (tower) and +196 = 21940 (Dash): meaning not traced.
- Physics: whether the swing click's 0.8 is a float or double multiply (moot after rounding);
  whether the wiki's dash-orb "rotation 180 − θ" describes the sprite (`updateDashArt` not read).

### Leads found in passing, worth their own check
- Platformer checkpoints (2063): `physics/sim.ts:1346` emits `"checkpoint"`, which `game/game.ts`
  never uses, and `ui/screens/play.ts:133` restarts any non-practice death from the start, so a normal
  platformer run never respawns at a checkpoint (game side not traced). **Fixed 2026-09-28**
  (`test/checkpoint.test.ts`): `PlayLayer::postUpdate` lays the checkpoint practising or not
  (IDA:105311-105362) and `resetLevel` loads the last one (IDA:105893-105903); keys 138 and 71 pick
  the respawn point, 51 spawns after it is laid, 448 on each respawn, and loading one lets go of the
  buttons and stops the fall (IDA:161737-161743). A spawned 2063 counts too.
- Dash's teleports use options the port ignores: 747 #6132 has static force 18 (345/346) and gravity
  normal (354); 2902 #6395/#6407 keep the player's x (352) and have 354. `teleportPlayer`
  (IDA:462337-462470) applies them; `sim.ts` `teleportToGroup` moves to the target's x and never
  touches gravity. **Fixed 2026-09-28** (`test/teleport.test.ts`), with 351, 353 and 443: a group
  teleport lands on its target where it is now, key 345 without 346 is a stop, and key 347 (the force
  redirect, not built) takes 345's place.
- Objects on the "K" (black) slot that carry an explicit key 21 (Fingerdash sludges on 197 and 44,
  The Challenge on 2, others in Dash and 5004) are pinned black by the port; whether their art follows
  the channel in the game is unchecked.
- G2's default is (0,102,255) in the game (IDA:205276-205277); the port copies G1
  (`level/decode.ts:150`, `render/colors.ts:663-669`). Invisible in official levels. **Fixed
  2026-09-29** with #25: the header starts from the settings object's colours.
- **Fixed 2026-09-30** (per-object render settings): keys 64 and 67 are read as objectFromVector
  reads them (`level/decode.ts` `OBJECT_KEY.dontFade`/`dontEnter`, +899 → +891 and +898 → +890,
  IDA:184028-184213), and the draw list keeps such an object at full opacity or out of its enter
  effect (`render/drawList.ts` `O_KEEP_OPACITY`, `O_KEEP_POSE`). As first written:
  Keys 64/67 (don't fade, don't enter) are ignored on ≈ 4.7k objects in Deadlocked, Fingerdash and
  Dash: a visual difference not assessed.
- A Collision trigger (1815) only listens once it has been activated (`triggerObject`
  IDA:315294-315330 → `registerCollisionTrigger`); the port treats every 1815 as armed from the start
  (`triggers/runtime.ts` `checkCollisionPairs`).
- Random (1912), Advanced Random (2068) and Sequence (3607) spawn without the remap chain they were
  fired with; the game passes it to `spawnGroupTriggered` (IDA:315409, 315708, 316113).
- Letter blocks are type 40 like the force blocks, and `canRotateFree` (IDA:168950-168958) lets
  type 40 turn freely, so one placed off the right angles should be an oriented box
  (`updateIsOriented` IDA:170702-170722). The port snaps K_SPECIAL to 90° (`physics/collision.ts`
  `rigid`) and tests it with a plain rect. Official levels not counted.
- **Fixed 2026-09-30** (per-object render settings): `DrawList.worn` folds in the groups' pulses
  first and shifts the hue after, as `colorForMode` does. As first written:
  The draw list shifts an object's hue before it folds in its groups' pulses (`render/drawList.ts`
  `shade`); the game pulses first and shifts the result (`colorForMode` IDA:173028-173089:
  `groupColor` :173063, then `transformColor` :173079). The two differ only on an object with both;
  78 official objects carry a hue shift and sit in a pulsed group (Dash 19, The Tower 1, The Sewers
  50, The Cellar 8), whether a pulse reaches them while they are drawn not checked. The particle
  colours (#30) use the game's order.
- Custom Particles (2065) has a detail sprite in the game: `addColorSprite` reaches LABEL_468 for it
  (IDA:172354-172365), and `edit_eCParticleBtn_color_001.png` is in GJ_GameSheet02. That sprite's
  default channel is 1 (`createSpriteColor` IDA:166652-166665 writes colour id 0, default 1), and no
  customSetup sets another for 2065, so without key 22 the end colour a 146/147 emitter takes is
  channel 1, where the port (`render/particles.ts` `objectColours`) uses the main colour. The main
  sprite's default (the port reads 1004) was not traced. Every official emitter with 146 or 147
  names both channels, so none changes.
- A secret coin's look: a taken one is destroyed with its pickup animation (`destroyObject` →
  `playDestroyObjectAnim` IDA:463125-463148), and one already saved draws its "collected" frames
  (+1258 from `updateUserCoin` IDA:181643-181646, the animation id negated in
  `updateSyncedAnimation` IDA:621136-621147). The port draws every coin, always, whether taken or
  saved.
- A platformer's end screen shows only the time, as m:ss.mmm, and no attempts or jumps
  (`EndLevelLayer::customSetup` IDA:369424, 369510-369584); a classic one's time is the level time
  (+808), not the wall clock the port uses. Show Time (gv 0145), the platformer's HUD label
  (`toggleProgressbar` IDA:91618-91633, `updatePlatformerTime` IDA:446122-446145), is not built.
- Needed by several fixes above and not built yet: advanced follow (3016), the Touch trigger (1595,
  `triggers/registry.ts:99`), Event trigger listeners (3604, `registry.ts:167`), the physics time warp
  (`registry.ts:160`). As of the final check the Event trigger listens (#8), with only some events
  raised; the other three are still not built.

---

## Matches (checked, no difference)
- Physics pages: cube jumps 10.62 / 11.18 / 11.42 / 11.23 / 11.23 (IDA:150522-150560); robot 0.5x
  and ball 0.3x (IDA:155787, 155858-155859); UFO 7 at every speed (IDA:155692-155706); wave vertical
  speed = horizontal; the swing click keeping 0.8 (IDA:155610-155615); the ±15, +8/−6.4 and ±8 caps;
  a click's first tick 10.964 against a buffered 11.18 (IDA:160528-160531, 155910-155935;
  `sim.ts:798-808`); every outer box but the spider's, wave inner 3; every pad value
  (IDA:421316-421366, 147666-147712); every orb factor but the three listed; black orb −14
  ship/swing, −11.2 UFO; the accelerating flag set only by the red pad, red orb and black orb; the
  spider-orb direction test with flipY (`geometry.ts:44-75`); the dash orbs' ±70 clamp, green-dash
  tap and pink-dash tap.
- Level format: the container, object and header syntax; kA2/kA4 enums; kA3, kA8, kA10, kA11, kA22,
  kA6/kA7, kA13, kA17/18/25, kA20/kA28, kA32/34/37/39/40 with the official-level overrides;
  colour-string keys 1-6, 9, 10, 17 and the player-colour enum; the kS29-kS37 map; guidelines as `~`
  pairs; the 72-token particle layout; key 54's meaning; object keys 1-6, 10, 11, 14, 17, 20-25, 30,
  31, 32, 35, 41-52, 56 on toggles, 57-60, 62, 63, 65-71, 75/84, 85 (0 or absent = rate 2), 86, 87,
  93-95, 99-101, 110, 115, 117, 120, 121, 128/129 with 32 as fallback, plus 134, 351 and
  445/511/586-590. About 31 object keys, 12 header keys and colour-string keys 8, 11-16 and 18 are
  ignored with no official effect. Easing 0-18 (`easing.ts`), the instant-count enum, and the speed
  values 251.16 / 311.58 / 387.42 / 468 / 576 (SPEED_PARAMS × 60).
- Save: the free-unlock rule; stats 1, 2, 5, 6, 8; stars and demons only from normal-mode
  completions; the 118 shop rows it lists; the vault codes and reward kinds; secret04/06/B03; GS_6;
  the kCEK ids; special chest ids 0001-0024; UGVs 1, 3, 5, 10/11, 20/21, 28, 29, 33-37; save XOR 11;
  the common secret; the goal-6 plan's orb formula and "official levels pay no diamonds".
- Audio: the song enum −1..39, level n → song n − 1, file names, artists but 26; `s{id}.ogg`;
  ids ≥ 10,000,000 → `.ogg`; kA13 added to the start (IDA:93587-93612, `audio/gameAudio.ts:76`); music
  stopped on death outside practice (IDA:93288); the CDN paths, token secret and library encodings.
- Online: almost everything; the digest above lists what differs.
