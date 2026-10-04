# Port vs game — verified physics discrepancies (research, 2026-09-22)

Where the port's physics differed from GD 2.2, found by reading open-source GD code and checked
against the 2.206 decompile (`gd-ida-decomp.cpp`, cited as `IDA:line`). Every entry below
survived an adversarial re-read of the decompile.

**Status (2026-09-25): all seventeen are fixed** — groups A–F of the fix plan, then a follow-up
for the two gaps a completeness check found (the §17 platformer dash and the §11 gate for round
hazards a trigger has turned). Each heading below says which. The "Port:" bullets describe the
port as it was before the fix, with the line numbers of that time.

Every macro was then re-solved against the fixed physics. 21 of the 27 official levels finish
(1–19, 21 and 3001), including Clubstep and Geometrical Dominator, which the solver had never
finished, and Fingerdash, whose only earlier run flew over the level. The six that do not — 20, 22 and the four
tower floors — are held up by what is under "Found while re-solving" at the end, not by these
seventeen; `test/macros/README.md` has each level.

Sources: camila314/gdp, Kusm1c/GDMod (2.2081 ground-truth doc), StarryDawn72/open-source-gd-project
(2.2081 hand-cleaned PlayerObject/GJBaseGameLayer), geode-sdk/bindings, Click Between Frames,
ToastyReplay, xdBot, zBot, QOLMod, Alphalaneous/hsaD-yrtemoeG, the GD wiki. OpenGD, gdclone,
gd-simulate and matcool/gd-clone are 2.1-era or fitted and were only used as cross-checks.

**Macro impact** was measured before the fixes, by replaying the 17 macros solved at the time
(1–13, 16, 17, 18, 3001) and the `.best` runs, once as-is and once with only that rule patched in
at runtime. "Breaks" = no longer finishes. Almost every fix broke some macro, because the macros
were solved against the port's physics, which is why they were re-solved once, after all of them.

Already known before this research, and now fixed: spider jump search strip (Dash, group D), blue
pad / orb doing nothing when gravity already matches (Clubstep, group A), saw circle-vs-box rule
(group D; its gate for round hazards a trigger has turned, in the follow-up — see §11).

---

## Tier 1 — changes how whole sections play

### 1. Orbs are taken by the press, before the move; flying modes never take them on contact
Status: fixed (group B).
- Game: `playerTouchedRing` (IDA:463276-463292) only fires an orb from the collision pass when
  the player is **not flying**. Every mode also fires orbs from `pushButton` (IDA:160446-160532):
  at the press, before that step's movement, it takes the rings touched in the last two collision
  passes (`resetTouchedRings` IDA:153480-153500, 469851), at most one per family, and skips the
  grounded jump whenever that list is non-empty.
- Port: orbs fire only in the collision pass after the move (`sim.ts:870-875`); a grounded press
  jumps first and loses the orb (`player.ts:429-431, 638`). UFO and swing consume the press in
  their own jump (`player.ts:583-584, 605-607`), so **they can never take an orb**; ship and wave
  take any orb they fly into while still holding.
- Levels: 269 of 360 orb activations in the solved runs fire a tick late; 2 grounded presses inside
  an orb (8 cube/yellow, 17 ball/blue). Breaks 3, 9, 10, 11, 13, 16, 17, 18, 3001.

### 2. Ship, UFO, wave and swing react to a press a tick late
Status: fixed (group B).
- Game: the press sets the held bytes and the same step's `updateJump` reads them
  (IDA:160450 → 469914 → 161031 → 155495-155706). No latch in any mode.
- Port: `FLY_MODE_PRESS_TICKS = 2` (`constants.ts:176`, `player.ts:420`) delays presses only, so
  every flying hold is a tick short and one-tick taps vanish. The boomlings "2 ticks" is a minimum
  hold length (a flying tap does nothing because flying acts only inside `updateJump`), not a delay.
- Levels: 7,130 flying presses; level 8 has 26 one-tick ship taps that do nothing. Breaks all 16
  flying macros.

### 3. Levels without "fix gravity bug" (kA32) keep the old falling test — levels 1–21 and 3001
Status: fixed (group C).
- Game: `playerIsFallingBugged` (IDA:144334-144360) is symmetric only for rotated, platformer,
  swing, or kA32 (+1169, IDA:462958). Otherwise upside-down "falling" is `yVel > 2g` in world terms,
  and in dual (+2137, set by `toggleDualMode` IDA:462648) the normal-gravity player uses `yVel < −2g`.
  Only Dash (22) has kA32.
- Effects: upside-down, and both players while dual, stay grounded after leaving a ledge — coyote
  time of cube 9 ticks, robot 10, ball and spider 15. In the ±2g hover band a held flipped ship
  thrusts with 0.4 (port 0.5) and a released flipped ship or UFO falls with 1.2 (port 0.8).
- Port: always the fixed rule (`player.ts:401-403`).
- Breaks 7, 8, 9, 10, 11, 16, 18 (upside-down or dual ships, one dual-cube coyote jump in 16);
  12 changes but finishes.

### 4. Dual gravity is linked
Status: fixed (group C).
- Game: `GJBaseGameLayer::flipGravity` (IDA:420149-420178) — in dual, not two-player, not unlinked
  by an Options trigger (layer+1512, IDA:429825), and both players in the same mode: flipping one
  flips the other to the opposite gravity. Every gravity portal (IDA:463509, 463535, 463847), the
  blue pad (IDA:463254) and green/blue/dash-gravity orbs (IDA:160108-160313) go through it.
  `playerWillSwitchMode` (IDA:462507-462595) also forces opposite gravity when a mode portal makes
  both players the same mode.
- Port: flips only the player that touched it; `unlinkDualGravity` is parsed
  (`triggers/runtime.ts:217`) and never read.
- Levels: the five dual sections (16 ×3, 17, 20). Macro impact not yet measured.

### 5. The player's position is a 32-bit float
Status: fixed (group F).
- Game: each step is converted to float and set through `setPosition` (IDA:161084-161100); the
  double `m_positionX/Y` belongs to trigger-moved objects only.
- Port: doubles (`player.ts:477-483`). x drifts −0.5 to −13 units at 1x over a level, 1–6 ticks.
- Breaks all 17 solved macros (desync, not difficulty). Needed to replay real-game macros.

## Tier 2 — specific modes and objects

### 6. Spider box is 27 (mini 16.2, inner 8.1); the wave rides 10 units off the floor
Status: fixed (group D).
- Game: `toggleSpiderMode` writes 27 to +648/+652/+2160 (IDA:152721-152723); `toggleDartMode`
  writes box 10 but +2160 = 20 (IDA:153041-153043). Ground and dual-band snaps use
  `vehicleSize × (+2160)/2` (IDA:464684-464866); block landings use the real box. The same term sets
  the out-of-bounds slack (game 0, mini 4; port 10, mini 12).
- Port: `hitboxSize()` is 30 for spider (`player.ts:306-309`); `floorCeiling` uses the box half
  (`sim.ts:967-978`), so the wave rides 5 off the floor or band, not 10.
- Breaks 17 (wave, dies at 19.4%).

### 7. The mini inner (solid-death) box is 9×9
Status: fixed (group D).
- Game: `getObjectRect(0.3, 0.3)` (IDA:170812-170840) never reads the vehicle scale: inner box 9
  at both sizes, wave 3, spider 8.1.
- Port: `innerSize() = hitboxSize() × 0.3` (`player.ts:312-315`) → 5.4 for mini.
- Breaks 11, 12, 18 (18: a mini cube scrapes 5 units into a block's underside for 14 ticks).

### 8. Orb and pad strengths, and the "accelerating" flag
Status: fixed (group A).
Values at 1x, jump velocity j = 11.18. From `ringJump` (IDA:159960-160385), `getBumpMod`
(IDA:421316-421366), `bumpPlayer` (IDA:157048-157090).

| | game | port (`constants.ts`) |
|---|---|---|
| red pad, mini ship / mini UFO | 16×0.95×0.8 = 12.16 / 16×0.98×0.8 = 12.54 | 8.06 / 7.68 |
| red orb, mini ship / mini UFO | 1.4 j×0.8 / 1.36 j×0.8 | 1.0 j×0.8 / 1.02 j×0.8 |
| yellow and green orb, ship/UFO | j×(0.8 mini), then the fly cap (8 / 9.41 mini) | flat 8 |
| yellow pad, mini ship/UFO | 12.8, capped next tick at 9.41 | second tick 6.4 |
| pink orb, spider | 0.72 × 0.7 j | 0.77 × 0.7 j |
| green orb, robot / swing | 1.0 j / 0.6 j | 0.9 j / 0.7 j |
| black orb, spider | −16.5 | −15 |

- Accelerating flag (+1858, lets a flying player exceed the speed cap): set only by the red pad, the
  red orb and the black orb; every other pad clears it; mode portals never touch it
  (IDA:157077-157083, 160344, 160380). Port `boostPlayer` (`player.ts:762-767`) sets it for every
  pad and orb, and `applyPortal` sets it on every mode change (`sim.ts:1020`).
- Ship thrust base is 0.5 only while holding and falling (IDA:155527-155531); port uses 0.5 whenever
  accelerating or platformer (`player.ts:571-579`). A released platformer ship falls 25% faster.
- Levels: mini flying sections with red/yellow pads and orbs. With the game's flag writers, xStep
  (10) dies at x≈10211.

### 9. Running off a slope
Status: fixed (group D).
- Game (`postCollision`, IDA:158447-158503): the launch test reads the slope's floor-top byte (+1859),
  not the player's gravity; it is skipped while a jump is active; running off the bottom of a
  downhill slope sets yVel = −(slope y speed)·flipMod (−5.19 on a 45° slope at 1x).
- Port: `sim.ts:824-834` tests `p.flipped` and has no downhill branch.
- 67 slope exits in the solved runs: 13 launches only in the game, 2 only in the port, 2 downhill
  snaps. Breaks 16 (13%, a ship) and 18 (40.6%).

### 10. Collision pass order
Status: fixed (group D).
- Game (IDA:464880-465060): portals, pads, orbs, slopes and letter blocks, then solids (box refreshed
  after each), then hazards against the refreshed box.
- Port: hazards, slopes, solids, then orbs/pads/portals (`sim.ts:763-896`).
- The hazard/solid swap changes nothing measured. Portals/pads/orbs before solids breaks 10, 12, 18
  (likely: a pad and a landing on the same tick; a gravity portal hit while riding a ceiling).

### 11. Rotated objects collide with the player's rotated box; spin rates
Status: fixed (group E; the round-hazard gate in the follow-up).
- Game: objects rotated off 90° multiples need the player's OBB, rotated by its own visual rotation,
  to overlap theirs (hazards IDA:465009-465056, interactables IDA:463466-463478, player OBB
  IDA:170865-170900 / 140253). Air spin is 180° per 0.43333 s = 415.4°/s, mini 540°/s, scaled by
  the gravity modifier (IDA:144512-144540); pads and orbs use the same spin; slope launches spin
  backwards at −207.7°/s (mini −270) (IDA:147590-147598).
- Port: upright player box (`sim.ts:574-575`); 420°/s at both sizes (`constants.ts:184`); pads and
  orbs 270 / 207.7 forwards (`constants.ts:201-202`).
- 1,199 odd-angle hazards, 40 portals, 6 pads, 2 orbs (levels 16–22, 3001). No change along today's
  solved paths.
- Also decided by that angle, and fixed with it: the ball's rolls, which share the spin's rate
  (+1472) — 600°/s on the ground (IDA:143720-143769), −340/0.8 = −425°/s in the air after a flip
  or an orb, turned by the new gravity (runBallRotation2 IDA:143785-143826; flipGravity
  IDA:151196-151199; ringJump IDA:160263-160266, 160374-160377), and rolled afresh by a landing
  (IDA:150173-150187), a reverse or a gameplay turn (doReversePlayer IDA:148342-148343, called on
  every turn IDA:152490) and a speed change (IDA:150569-150570); a ball portal rolls nothing until
  the landing (IDA:153170). In a platformer, steering sets the facing that turns the spin, starts
  the spin of a cube that jumped standing still, and settles one in the air with nothing held
  (updateMove IDA:149483-149559). What is oriented: `(int)rotation % 90 ≠ 0` (IDA:170702-170722),
  and anything a trigger has turned, at any angle (calculateOrientedBox IDA:170660-170664 from
  fastRotateObject IDA:170742-170750) — round hazards included, which a placed angle never
  orients. A turned one kills only where its circle and its own box (+648 × +652, the sprite's
  size, not the radius) both meet the player, unless kA39 (IDA:465038-465052, 463462-463478).
  Fingerdash has 106 in rotating groups (1582, 1583, 918); The Tower and The Sewers a handful.

### 12. Pads fire once per player
Status: fixed (group A).
- Game: an activated non-multi pad is skipped (IDA:463439, 456752-456765); a blue pad that doesn't
  flip doesn't use its activation (IDA:463232-463239).
- Port: fires on every re-entry (`sim.ts:867-869`). No multi-activate pads exist in the official levels.
- Re-entries: 18 (3), 3001 (1), 21.best (4). Breaks 18.

### 13. The jump latch is only set by a landing at ≤ 5
Status: fixed (group B).
- Game: `hitGround` arms +1969 only when yVel·flipMod ≤ 5 (IDA:150025, 150166-150170).
- Port: always (`player.ts:782-797`, also on slopes and head contacts).
- Breaks 12 (a flipped cube snapped at ~10 then jumps) and 18 (a ball hitting a ceiling at 6.5 flips).

### 14. Dual spawn and exit
Status: fixed (group C).
- Player 2 is stepped on the tick it spawns in the port (`sim.ts:478-482`); the game waits a step
  (IDA:469860, 469926), and player 2 stays one tick ahead (1.05–1.61 units in x) for the whole dual
  section. Fixing it breaks Hexagon Force's dual ball section.
- When player 2 touches the solo portal, the game copies player 2 into player 1
  (`toggleDualMode` IDA:462672-462676, `copyAttributes` IDA:153299-153330); the port keeps player 1
  (`sim.ts:1154-1160`). Every current case is player 2 first only because of the one-tick lead
  above; fix both together. Deadlocked's rotated solo portal is the real case (no macro yet).

### 15. Head hits on dual band edges and the upside-down floor
Status: fixed (group C).
- Game (IDA:464684-464866, `destroyFromHitHead` 145615, `isSafeHeadTest` 147910): cube and robot
  hitting a dual band edge head-first, or touching the plain floor upside down, are out of bounds
  (dead on the second tick) unless they flipped or changed mode within 0.2 s (0.1 s for the plain
  floor) or hold an H block.
- Port: both are safe ceilings (`sim.ts:967-978`), and the player can jump off them.
- Jumper (7) grazes the floor upside down at x≈24875 and would die there.

### 16. Releasing ends a dash before the move
Status: fixed (group B).
- Game: `releaseButton` calls `stopDashing` at the start of the step (IDA:159516-159524).
- Port: one more dash step first (`player.ts:457, 466-468`, `sim.ts:643`).
- 15 dash orbs (21, 22, 3001). 3001 changes but finishes.

### 17. Minor
Status: fixed — the robot hold and facing in group A, letter blocks in B, the grown-back snap in D,
setYVelocity in F, the platformer dash and the classic dash angle in the follow-up.
- Robot hold survives pads unless kA34 or platformer; the blue pad never ends it (IDA:157053,
  430562). Port always ends it (`sim.ts:1199`). Only 19 and 21 have robot pads; no run reaches them.
- Letter blocks last one extra collision pass (IDA:159667-159716, 153691-153705). No run changes.
- `isFacingDown`/`isFacingLeft` invert with flipY (IDA:170986-171050): spider orb (IDA:160082),
  spider pad (IDA:157059), blue pad (IDA:463234). 95 of 236 blue pads are flipY — the blue pad fix
  must read it. One flipY spider orb, in Dash at x 14325.
- `setYVelocity` rounds to 0.001 on every write, gravity included (IDA:141992-142007).
- Platformer snap threshold 15 after growing back from mini (IDA:150417, 151523). Platformer only.
- A platformer dash moves by its own velocity pair, which `startDashing` works out from the orb's
  angle (+1184 x, +1192 y, IDA:148586-148619); each dash step writes the y half raw over
  `setYVelocity(0)` and the x half into +2216 (IDA:161036-161056), so the dash ends carrying both.
  Port: the classic `dashSlope × velX` in both modes, ending the dash at a y velocity of 0.
  Platformer only. The end hands the pair over times the orb's end boost (key 588) through
  `updatePlayerForce` and spins a cube, forced (IDA:149800-149812, 149888-149898); keys 587 (a wall
  does not end it), 589 (stop slide) and 590 (longest time) belong to it too.
- Found after the list: the classic dash reads the orb's placed angle (+828) negated and clamps it
  raw — (70, 180) → 70, ≥ 180 → −70, the mirror below −70 — and runs straight in rotated gameplay
  (IDA:148639-148690); the slope multiplies the forward step before the reverse turns it
  (IDA:161044, 161060, 161082-161083). Port: angles in 90..270 mirrored, the live rotation clamped
  to ±70, sloped in rotated gameplay too, and a reversed dash sloped the other way. Every official
  dash orb is at 0° or −45°, so no official level changes.

## Found while re-solving (2026-09-25)

Not part of the list above: the re-solve turned these up where a level could not be finished.
The first three were fixed in the final check; the five struck out under "Open" were fixed on
2026-09-28 (`boomlings-notes.md`, open items 1-5). What is still open is at the end of "Open".

### Fixed in the final check
- **A spawned trigger without multi-trigger never fired.** `TriggerRuntime.spawnObject` made the
  once-only check and marked the trigger, then called `activate`, which checked again, saw that
  mark and returned. The game checks once (`GJBaseGameLayer::spawnObject` IDA:456038-456089).
  It stopped every once-only spawn chain: Geometrical Dominator's door at x≈27700 (group 85,
  fired by spawn #13190), The Tower's Ferris wheels and house door, and many more in 22 and
  5002–5004. None of the saved macros moves. Test: `triggers.test.ts`, "a spawned trigger
  without multi-trigger still fires".
- **Upside down, a ceiling slope let go at its top edge.** In `collideSlope` the still-attached
  test for a flipped player fell through to the upright player's top-edge test; the game nests
  it, so a flipped player only lets go past the bottom edge (IDA:157381-157391). A flipped ball
  meeting a ceiling slope let go on the next tick, landed again and started the ride over, so it
  left the far end short: Blast Processing's intended UFO → ship → ball route missed the blue orb
  at x 24255 by it (−2.78 for −5.55). Hexagon Force's dual mini ball meets one at x 19840 and now
  leaves it at −4.60 for −4.03; its macro still finishes. Test: `slopes.test.ts`, "upside down, a
  ceiling slope is ridden in one go".
- **A linked teleport (747) keeps the player's x and takes the partner's y.** The partner is made
  key 54 above the portal, not rotated with it (IDA:89924-89934); `teleportPlayer` stores
  `partner.y − portal.y` (IDA:462316-462324) and `getPortalTargetPos` returns (player x,
  portal y + that) (IDA:419427-419431). The port added key 54 to the player's own y, which put
  Deadlocked's player under the floor at x 16035 (portal at y 345, key 54 = −320, only reachable
  from below at y 317–321) and killed it two ticks later. Key 351 keeps the player's offset from
  the portal instead, x included (IDA:462337-462344); no official 747 carries it. Fingerdash's
  first teleport now lands 31 units lower; its macro still finishes. Test: `numerics.test.ts`,
  "a teleport moves the player to its partner's y in the world".

### Open
- ~~**A spawned End trigger (3600) does nothing.**~~ Fixed 2026-09-28 (boomlings-notes, open
  item 3): 3600 is a trigger that ends the level through `activatePlatformerEndTrigger`, however it
  is fired. As first written: the object table makes 3600 a 30×30 end block
  (`objects.ts`), so the trigger index never holds it and a spawn skips it. In the game it is an
  effect object whose `triggerObject` hands the level its end (IDA:315851-315875). All four tower
  floors park it in empty space and fire it only from a touch-triggered spawn, so none of them can
  be finished.
- ~~**Trigger channels.**~~ Fixed 2026-09-28 (boomlings-notes, open item 2), with each channel
  sorted along its own way, the platformer's queue on the music clock and `canTouchObject`. As
  first written: x-activated triggers queue per channel (key 170, IDA:298700-298704) and
  only the active channel fires — by the player's y instead of x while gameplay is rotated, and
  with ≥ for a reversed channel (`checkSpawnObjects` IDA:454433-454530). A Rotate Gameplay
  trigger with key 171 makes key 173 the active channel and marks it reversed for key 167 = 2 or
  3 (`rotateGameplay` IDA:442808-442830). The port parses `channel` and never reads it, so Dash's
  un-rotate trigger at x 2143.5 fires before the turn it is meant to undo and the player stays
  turned. Needs a queue per channel, carried in the snapshot and the state hash.
- ~~**Follow (1347) copies move-trigger motion only**~~ Fixed 2026-09-28 (boomlings-notes §4): a
  Follow copies its followed group's main object's real movement, so The Tower's wheel cars ride
  their wheels.
- ~~**Deadlocked at x≈20860.**~~ Fixed 2026-09-28 (boomlings-notes, open item 1): 747 and 2902
  have their box 12 along their own x, so the ship meets #11697 after the spike wall. As first
  written: with the teleport fixed, a runtime patch of it took the solver to
  58.5 %, where a ship teleported by #11697 (key 54 = −94) lands on spikes #11700/#11701; the
  pair at x 22897 (#12510/#12511) has spikes closer still. Not diagnosed: the ship's box on the
  teleport tick, or obj 421's hitbox.
- ~~`TELEPORT_DEFAULT_OFFSET` is 90~~ Fixed 2026-09-28 (boomlings-notes §31). As first written: the
  game writes 0 when key 54 is absent
  (`TeleportPortalObject::customObjectSetup` IDA:303108-303111). Every official 747 carries
  key 54, so nothing plays differently.
- ~~**A trigger orb (1594) does nothing to its group.**~~ Found by the final re-solve (2026-09-29)
  and fixed in its final check (boomlings-notes, status): `activateCustomRing` spawns group 51
  with key 504, or switches it on and spawns it by key 56, or off (IDA:439065-439098). The toggle
  block (3643) is the same custom ring, 30 × 30. It kept The Sewers' route shut at orb #1728.

- ~~**The corridor's band was a fixed span of the level.**~~ Fixed 2026-10-01 (a side-by-side of Dash at
  4 %): the game's two ground layers stand on the screen, `h` design units apart about its middle, so
  the band they bound is `h` / zoom units of the level. While the corridor holds the camera's y (it
  takes the static y with its middle) the band is that middle plus the camera offset, ± h / 2 / zoom;
  while a Static Camera trigger holds y the band is read off the layers about the camera's centre and
  follows them as they slide in from the screen's edges (`getMinPortalY`/`getMaxPortalY`
  IDA:420443-420510; `updateCameraBGArt` IDA:431194-431213). Dash's spider under its Static Camera and
  0.909 zoom is 16.5..313.5 around the camera's 165, not 0..270. The sim follows its own 16:9 camera
  for this (`Sim.refreshBand`), and the camera triggers now run with the visuals off. Every finishing
  macro still finishes with its checkpoints unchanged; Dash's best attempt, solved on the old band,
  now stops at x 1085 (4.5 %): its spider walked the pit floor at y 0, and the floor sliding in
  under the Static Camera lifts it into the hidden spike #5332 on the far wall.
- ~~**The flat ceiling was 2,688.**~~ Fixed 2026-10-01 (the camera work): the level top a classic
  level kills above is the float `updateMaxGameplayY` writes, 1160667136 = 0x452E6000 = 2790.0
  (IDA:430650), which the camera's top also reads (`updateCamera` IDA:449595). The port had 2,688.
  No saved run reaches either height, so no macro moves, but `physics/constants.ts` is part of the
  macro stamp, so every stamp reads stale until re-stamped.

Still open after the final re-solve (2026-09-29):
- ~~**Dash's ship in the wavy tunnel, x 17745-18975.**~~ Closed 2026-10-02: Dash finishes, tunnel
  included, on the band fix above. The Area Move triggers were not needed: both centre on player 1
  (key 538 = −1) with a 90-unit dead zone (key 282 = 0.2 of 450) and key 276 inverts the falloff,
  so every block within 90 units of the player is skipped and stands where it was placed; only the
  far parts of the tunnel open. The old note follows. (After the band fix above, the first suspect
  below, the band's source under a Static Camera, is the game's. The attempt described here predates
  that fix and replays only to 4.5 % on the new band. Dash was solved again on it: the saved best
  attempt now clears that pit and dies at 67.7 % on block #10655 (16305, 675) in the rotated climb,
  before the tunnel, so the tunnel still waits on a run that reaches it.) The old best attempt
  (75.4 %) entered ship mode through the channel-10 teleport onto ship portal #6409 (15765, 555), so
  the port holds the ship to
  y 390-690, and it dies on floor block #12974 (18195, 661, group 387) with the ship against the 690
  ceiling. The tunnel's floor (group 387) and ceiling (group 391) open from about y 416-614 at
  x 18795 to about 718-894 at x 18285-18345, which no fixed 300-unit band holds at both ends. Two
  suspects, neither checked: the band's source once the ground is off screen (the second branch of
  `getMinPortalY`/`getMaxPortalY`, IDA:420443-420510, which reads the ground layers and the camera
  y at +1032), and the two Area Move triggers on those groups (#11663, #13551, id 3006), which the
  port does not build; both have key 276 = 1, which by `gd-areas.md` leaves the blocks near the
  centre where they were placed.
- Not port bugs, but why the four tower floors have no macro: the autoplayer's `PlatformerGuide`
  aims at the End trigger instead of the touch spawn that fires it, treats one-way blocks,
  switched groups and doors as solid for good and the space outside the level as open, and knows
  nothing of teleports (`test/macros/README.md`).
- Possibly correct, not checked: a cube sliding down a wall of stacked blocks lands on a block's
  top with no horizontal overlap (touching edges count) and then cannot jump for 20+ ticks unless
  it holds away from the wall (The Sewers, x 825).
- Not physics, for the record (2026-10-01): a second side-by-side of Dash at 4 % fixed the draw
  order inside a layer (the per-sheet batch nodes of `setupLayers`/`parentForZLayer`), particle
  systems ignoring their object's opacity (`updateParticleOpacity`), additive art adding too much
  and channel opacity applied twice, and the level running on under the pause menu. None of it
  touches the sim: every finishing macro still finishes with its checkpoints unchanged, and no
  stamp moved. What that comparison still shows — the middleground's base height, the missing
  `CCCircleWave`, the spider portal's lingering particles — is under "Known wrong" in the README.

## Not port bugs
- A press and release inside one step is kept: live, macro and bot inputs carry it as
  `PlayerInput.tap`, which the sim runs as two commands in that step, as the game does (§2).
- The `hitGround` "ceiling" argument is cosmetic (particles), not part of the gravity bug.
- The hazard-before-solid order alone changes nothing measured.
- Refuted web claims: Geode's `getModifiedSlopeYVel` body, OpenHack/GDMegaOverlay's 0.25/0.4
  inner box, GDMod's "slopes never kill" and "no inner box in classic", a four-corners-only saw rule.

## Matches (checked, no difference)
Speed table (`updateTimeMod`), per-mode gravity and factors, ±15 terminal velocity, flying caps,
ground/robot/ball jumps, robot hold window, UFO jump and gravity, swing flip and gravity, wave
velocity, slope launch velocity and ramp, big-size pad and orb values, input routing for two-player,
normal-size inner box 9, wave box 10/6.
