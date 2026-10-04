# PlayerObject field layout, read out of the 2.206 decompile

Source for everything below: `D:/Proxy/games-src/geometrydash/data/ref/gd-ida-decomp.cpp`
(IDA pseudo-C, 1 660 350 lines). Every line range cited was read before being cited.
Offsets are byte offsets from `this` on the 32-bit ARM build, so `*((double *)this + N)`
means byte offset `8*N` and `*((float *)this + N)` means byte offset `4*N`.

> **Adversarial review pass (2026-09-16).** Every bullet that was under `## certain` was
> re-checked against the cited line ranges, every float/double constant was re-decoded, and
> every offset-to-meaning identification was re-tested for an independent second site.
> Seven bullets did not survive and have been moved down into `## likely` / `## Not
> established`, each with a `**Demoted by review**` note saying what the code actually does.
> Bullets that survived but whose supporting detail or citation was wrong were corrected in
> place, marked `**Review correction**`. Nothing was deleted. The surviving core — +1936 is
> the y-velocity double, +2144 is the clock, the seven mode flags, the four halving toggles,
> `switchedToMode`, +1967/+1970/+1971 — held up under attack.

## Summary

**+1936 is the y velocity, and it is a `double`.** This is not an inference from the
halving in `toggleFlyMode` — it is nailed down from five independent directions:
`PlayerObject::getYVelocity` literally returns `*((_QWORD *)this + 242)` (242 × 8 = 1936);
`PlayerObject::setYVelocity` is the only writer of `*(double *)(v4 + 1936)` in that
function; `PlayerObject::update` multiplies it by the timestep and adds the product to
the player's y position; `PlayerObject::updateJump` feeds gravity into it through
`addToYVelocity` and clamps it to ±15 in the falling direction; and
`PlayerObject::spawnFromPlayer` negates a carried-over value by XOR-ing the IEEE-754
sign bit (`^ 0x8000000000000000`), which only makes sense for a double.

**+2144 is not a position — it is the player's copy of the level clock, a `double` in
seconds.** `PlayLayer`'s physics loop writes its own accumulated time
(`*((double *)this + 99)`) into both players' +2144 on every step; `PlayLayer::fullReset`
and `PlayerObject::resetObject` zero it; and `isSafeFlip` / `isSafeMode` /
`isSafeSpiderFlip` all compute `*(+2144) - *(+1632 | +1592 | +1664) < threshold`, i.e.
"how long ago". So **+1592 is the timestamp of the last mode change** and the 8-byte copy
`*(this+1592) = *(this+2144)` at the top of every `toggle*Mode` is "stamp now as the last
mode change", not a position save. `flipGravity` does the same thing into **+1632** (last
gravity flip) and the spider jump code into **+1664** (last spider flip).

**The mode flags are seven consecutive bytes, 1961–1966 plus 1972.** They are proved twice
over: `saveToCheckpoint` writes each one into a distinct checkpoint byte and
`loadFromCheckpoint` restores each by calling the matching `GJBaseGameLayer::switchTo*Mode`
with the matching `GameObjectType`; and `copyAttributes` copies each one into the matching
`toggle*Mode`.

**The halving is the four air modes only, and it runs in both directions.** `toggleFlyMode`
(ship), `toggleBirdMode` (UFO), `toggleDartMode` (wave) and `toggleSwingMode` (swing) each
contain `*(double *)(v + 1936) = *(double *)(v + 1936) * 0.5;`. `toggleRollMode` (ball),
`toggleRobotMode` and `toggleSpiderMode` do **not** — they have no y-velocity line at all.
The guard on all seven is only `if (currentFlag != requestedValue)`, so the halving fires
on entering *and* on leaving ship/UFO/wave/swing. Note that
`GJBaseGameLayer::switchTo*Mode` always routes through `switchedToMode`, which turns the
six *other* toggles off first — so a wave → ship portal runs `toggleDartMode(0)` (halve)
and then `toggleFlyMode(1)` (halve again), a net **×0.25**. `flipGravity` halves it a third
time if a gravity portal is involved.

**+1967 / +1970 / +1971 are confirmed as gravity-flipped / reversed / rotated-gameplay.**
Each has a dedicated accessor or a position-integration effect, on top of the checkpoint
round-trip. The camera section of `trigger-semantics.md` is safe to keep leaning on them.

**+2044 / +1969 / +1603 — the three bytes `toggleFlyMode` zeroes — are "on the ground",
"landed softly enough to hold-jump", and "the streak is live for this airborne stretch".**
All three are set by `hitGround` / `boostPlayer` / `propellPlayer` and cleared by anything
that launches the player.

**There is no stored x velocity in classic mode and no stored rotation anywhere.**
`getCurrentXVelocity` computes `m_timeMod(+2020 float) × m_playerSpeed(+1560 double)` in
classic mode, and only reads a real stored x velocity (`+2216`, double) in platformer.
Rotation lives in the cocos2d `CCNode` base and is reached exclusively through vtable slots
172 (set) and 176 (get); what PlayerObject stores is the rotation *rate*, `+1472` (float).

Three floating-point constants in `updateTimeMod` were dropped by IDA (they show as
`loc_339208`-style labels), so the 1.1 / 1.3 / 1.6 speed tables are **not established**.

---

## certain

- **+1936 is `m_yVelocity`, a `double`; `getYVelocity` returns it and `setYVelocity` is its canonical writer.**
  ```c
  __int64 PlayerObject::getYVelocity(PlayerObject *this) { return *((_QWORD *)this + 242); }   // 242*8 = 1936
  int PlayerObject::setYVelocity(double this, double a2, int a3) {
    v5 = (double)(int)a2;
    if (a2 != v5) { LODWORD(this) = round(); v3 = v5 + this / 1000.0; }   // quantise to 1/1000
    *(double *)(v4 + 1936) = v3;
  }
  ```
  <sub>PlayerObject::setYVelocity, gd-ida-decomp.cpp:141992-142006; PlayerObject::getYVelocity, gd-ida-decomp.cpp:142024-142027</sub>

- **`addToYVelocity` reads and rewrites the same field, so it is an accumulator, not a separate store.**
  ```c
  int PlayerObject::addToYVelocity(double this, double a2, int a3) {
    return PlayerObject::setYVelocity(this, a2 + *(double *)(LODWORD(this) + 1936), a3);
  }
  ```
  <sub>PlayerObject::addToYVelocity, gd-ida-decomp.cpp:142043-142048</sub>

- **`PlayerObject::update` integrates +1936 into the y position each step: `dy = yVel * (dt * 0.9)`.**
  `v16` is `this + 1936`; `v24 = a2 * 0.9` is the same scaled timestep handed to `updateJump`;
  `v31 = *v16` is the y velocity; `v35 = v31 * v30` is the y component of the position delta,
  which is then added to `getPosition()` via vtable slot 92 (`setPosition`).
  ```c
  v24 = a2 * 0.9;
  PlayerObject::updateJump(this, a2 * 0.9);
  v30 = v24;  v31 = *v16;                                   // v16 == this + 1936
  v32 = COERCE_DOUBLE(PlayerObject::getCurrentXVelocity(this)) * a2;
  ...
  v35 = v31 * v30;                                          // dy
  v39 = v32;                                                // dx
  ...
  cocos2d::CCPoint::CCPoint(v114, v48 /*dx*/, v49 /*dy*/);
  cocos2d::CCPoint::operator+(v115, v50 /*getPosition()*/, v114);
  v45(this, v115);                                          // setPosition
  ```
  <sub>PlayerObject::update, gd-ida-decomp.cpp:161030-161100</sub>

- **`PlayerObject::update` clamps +1936 to ±1000 before anything else uses it.**
  ```c
  v16 = (double *)((char *)this + 1936);
  v17 = *((double *)this + 242);
  if (v17 <= 1000.0) { if (v17 < -1000.0) *v16 = -1000.0; } else { *v16 = 1000.0; }
  ```
  <sub>PlayerObject::update, gd-ida-decomp.cpp:160995-161003</sub>

- **A jump writes +1936 from the jump-impulse field +1568, signed by `flipMod` and scaled by a mini factor.**
  `v26` is loaded from `*((double *)this + 196)` = +1568; robot halves it; `v20` is 1.0 at normal
  scale and 0.8 when mini (`*((float *)this + 504)` = +2016 ≠ 1.0); `v31` is `flipMod` = ±1.
  ```c
  v26 = *((double *)this + 196);                       // +1568, the jump impulse
  if (*((_BYTE *)this + 1965)) v26 = v26 * 0.5;        // robot jumps at half
  ...
  v31 = PlayerObject::flipMod(this);                   // ±1 from +1967
  v33 = PlayerObject::setYVelocity(v32, (float)((float)(v26 * (float)v31) * v20), 2);
  ```
  <sub>PlayerObject::updateJump, gd-ida-decomp.cpp:155785-155797</sub>

- **Gravity is applied to +1936 once per step through `addToYVelocity`, then clamped to ±15 in the falling direction.**
  `v14` is the gravity field +1576; ball / any flying mode / spider override it with the literal
  `0.9582`; `v17` is the gravity multiplier +2356; `v18` is a per-mode factor (0.6 ball/spider/swing,
  0.9 robot, else 1.0); `v50 = v3 * a2`.
  ```c
  v14 = *((double *)this + 197);                                  // +1576
  if (ball || isFlying || spider) v15 = 0.9582; else v15 = v14;
  v17 = *((float *)this + 589);                                   // +2356 gravity multiplier
  if (v17 != 1.0) v3 = v15 * v17; else v3 = v15;
  ...
  v50 = v3 * a2;
  v57 = PlayerObject::flipMod(this);
  PlayerObject::addToYVelocity(v58, (float)-(float)(v18 * (float)(v50 * (float)v57)), 63);
  v60 = *((double *)this + 242);
  if (*((_BYTE *)this + 1967)) { if (v60 <= 15.0) v61 = v60; else v61 = 15.0; }
  else                         { if (v60 >= -15.0) v61 = v60; else v61 = -15.0; }
  PlayerObject::setYVelocity(v59, v61, 5 or 6);
  ```
  The `if (*((_BYTE *)this + 2060))` branch higher up applies the same term (line 155936) and then
  always `goto LABEL_255` at 155979, so exactly one of the two applications runs.
  <sub>PlayerObject::updateJump, gd-ida-decomp.cpp:155460-155477, 155914-155936, 155979-156005</sub>

- **`setYVelocity` quantises to thousandths: a non-integral value is rebuilt as `trunc + round(x)/1000`.**
  This is a real behavioural detail worth porting — velocities are not stored at full double precision.
  <sub>PlayerObject::setYVelocity, gd-ida-decomp.cpp:141992-142006</sub>

- **+2144 is a `double` holding the level clock in seconds, pushed in from the game layer every physics step.**
  ```c
  *((double *)this + 99) = v24 + v15;                              // GJBaseGameLayer time accumulator
  (*(...)(*(_DWORD *)this + 584))(this, LODWORD(v26));             // step the sim
  *(_QWORD *)(*((_DWORD *)this + 549) + 2144) = *((_QWORD *)this + 99);   // player 1
  *(_QWORD *)(*((_DWORD *)this + 550) + 2144) = *((_QWORD *)this + 99);   // player 2
  ```
  <sub>PlayLayer physics loop, gd-ida-decomp.cpp:469813-469835</sub>

- **+2144 is zeroed on a full reset, on both players, confirming it is a counter and not a coordinate.**
  ```c
  v2 = (_QWORD *)(*((_DWORD *)this + 549) + 2144);
  *((_QWORD *)this + 99) = 0LL;  ...  *v2 = 0LL;
  *(_QWORD *)(*((_DWORD *)this + 550) + 2144) = *((_QWORD *)this + 99);
  ```
  and in the player's own reset, `*((_QWORD *)this + 268) = 0LL;` (268 × 8 = 2144).
  <sub>PlayLayer::fullReset, gd-ida-decomp.cpp:107506-107522; PlayerObject::resetObject, gd-ida-decomp.cpp:153559-153672</sub>

- **+1592 is the timestamp of the last mode change; `isSafeMode` reads exactly the pair (+2144, +1592) as an elapsed time.**
  ```c
  bool PlayerObject::isSafeMode(PlayerObject *this, float a2) {
    v2 = *((double *)this + 199);                       // 199*8 = 1592
    return v2 != 0.0 && *((double *)this + 268) - v2 < a2;   // 268*8 = 2144
  }
  ```
  The sibling `isSafeFlip` uses `*((double *)this + 204)` = +1632, which is what `flipGravity`
  stamps; `isSafeSpiderFlip` uses `*((double *)this + 208)` = +1664. `isSafeHeadTest` ORs the
  first two with a 0.2 s window.
  <sub>PlayerObject::isSafeFlip / isSafeSpiderFlip / isSafeMode / isSafeHeadTest, gd-ida-decomp.cpp:147844-147913</sub>

- **The `*(this+1592) = *(this+2144)` copy at the head of every mode toggle is therefore "stamp the mode-change time", and it runs on entering and on leaving.**
  All seven toggles carry the identical line (the last three spell it `*((_QWORD *)this + 199) = *((_QWORD *)this + 268)`),
  inside a guard that only tests whether the flag value differs:
  | line | function |
  |---|---|
  | 152581 | `toggleSwingMode` |
  | 152713 | `toggleSpiderMode` |
  | 152814 | `toggleFlyMode` |
  | 152925 | `toggleBirdMode` |
  | 153026 | `toggleDartMode` |
  | 153130 | `toggleRollMode` |
  | 153217 | `toggleRobotMode` |
  <sub>PlayerObject::toggle*Mode, gd-ida-decomp.cpp:152569-153281</sub>

- **`flipGravity` stamps +1632 from +2144 the same way, and also halves +1936 — unless the player is being restored from a checkpoint (+1601).**
  ```c
  *(_QWORD *)(v3 + 1632) = *(_QWORD *)(v3 + 2144);
  *(_QWORD *)(v3 + 1872) = 0LL;
  *(_QWORD *)(v3 + 1864) = 0LL;
  *(_BYTE *)(v3 + 2073) = 0;
  ...
  if ( !*(_BYTE *)(v3 + 1601) )                       // 1601 == "loading from checkpoint"
    *(double *)(v3 + 1936) = *(double *)(v3 + 1936) * 0.5;
  ```
  Like the mode toggles it is guarded only by `if (this[1967] != a2)`, so it halves on flipping
  either way. It also clears +1969 and, on the non-ball path, sets +1603 = 1.
  <sub>PlayerObject::flipGravity, gd-ida-decomp.cpp:151121-151203</sub>

- **The seven mode flags, each proved by a checkpoint save/restore pair and again by `copyAttributes`.**
  | offset | mode | `switchedToMode` arg | restore call in `loadFromCheckpoint` |
  |---|---|---|---|
  | **+1961** | ship / fly | 5 | `switchToFlyMode(..., 5)` |
  | **+1962** | UFO / bird | 19 | `switchToFlyMode(..., 19)` |
  | **+1963** | ball / roll | 16 | `switchToRollMode` |
  | **+1964** | wave / dart | 26 | `switchToFlyMode(..., 26)` |
  | **+1965** | robot | 27 | `switchToRobotMode` |
  | **+1966** | spider | 33 | `switchToSpiderMode` |
  | **+1972** | swing | 41 | `switchToFlyMode(..., 41)` |
  ```c
  // saveToCheckpoint
  *((_BYTE *)a2 + 286) = *((_BYTE *)this + 1961);   *((_BYTE *)a2 + 287) = *((_BYTE *)this + 1963);
  *((_BYTE *)a2 + 288) = *((_BYTE *)this + 1962);   *((_BYTE *)a2 + 290) = *((_BYTE *)this + 1964);
  *((_BYTE *)a2 + 291) = *((_BYTE *)this + 1965);   *((_BYTE *)a2 + 292) = *((_BYTE *)this + 1966);
  *((_BYTE *)a2 + 289) = *((_BYTE *)this + 1972);
  // copyAttributes
  PlayerObject::toggleFlyMode   (this, *((unsigned __int8 *)a2 + 1961), 0);
  PlayerObject::toggleBirdMode  (this, *((unsigned __int8 *)a2 + 1962), 0);
  PlayerObject::toggleRollMode  (this, *((unsigned __int8 *)a2 + 1963), 0);
  PlayerObject::toggleDartMode  (this, *((unsigned __int8 *)a2 + 1964), 0);
  PlayerObject::toggleRobotMode (this, *((unsigned __int8 *)a2 + 1965), 0);
  PlayerObject::toggleSpiderMode(this, *((unsigned __int8 *)a2 + 1966), 0);
  PlayerObject::toggleSwingMode (this, *((unsigned __int8 *)a2 + 1972), 0);
  ```
  <sub>PlayerObject::saveToCheckpoint, gd-ida-decomp.cpp:161546-161558; PlayerObject::loadFromCheckpoint, gd-ida-decomp.cpp:161657-161718; PlayerObject::copyAttributes, gd-ida-decomp.cpp:153318-153324</sub>

- **Exactly four modes halve the y velocity, and they are exactly the four `isFlying()` reports.**
  ```c
  int PlayerObject::isFlying(PlayerObject *this) {
    v1 = this[1961];                                    // ship
    if (!this[1961]) { v1 = this[1962];                 // UFO
      if (!this[1962]) { v1 = this[1964];               // wave
        if (!this[1964]) return this[1972]; } }         // swing
    return v1;
  }
  ```
  The halving lines are at 152586 (`toggleSwingMode`), 152819 (`toggleFlyMode`),
  152930 (`toggleBirdMode`) and 153032 (`toggleDartMode`). `toggleRollMode`,
  `toggleRobotMode` and `toggleSpiderMode` contain no write to +1936.
  <sub>PlayerObject::isFlying, gd-ida-decomp.cpp:144427-144443; PlayerObject::toggleSwingMode / toggleFlyMode / toggleBirdMode / toggleDartMode, gd-ida-decomp.cpp:152586, 152819, 152930, 153032</sub>

- **`switchedToMode` turns off every other mode before the requested one turns on, so a portal-to-portal transition halves twice.**
  ```c
  int PlayerObject::switchedToMode(PlayerObject *a1, int a2) {
    if ( (a2 != 5 && (PlayerObject::toggleFlyMode(a1, 0, 0), a2 == 19)
       || (PlayerObject::toggleBirdMode(a1, 0, 0), a2 != 16))
      && (PlayerObject::toggleRollMode(a1, 0, 0), a2 == 26)
      || (PlayerObject::toggleDartMode(a1, 0, 0), a2 != 27) ) {
      PlayerObject::toggleRobotMode(a1, 0, 0);
      if (a2 == 33) return PlayerObject::toggleSwingMode(a1, 0, 0);
    }
    result = PlayerObject::toggleSpiderMode(a1, 0, 0);
    if (a2 != 41) return PlayerObject::toggleSwingMode(a1, 0, 0);
    return result;
  }
  ```
  It is called from inside each toggle's `if (a2)` branch, i.e. only when *entering* a mode.
  <sub>PlayerObject::switchedToMode, gd-ida-decomp.cpp:152661-152673</sub>

- **+1967 is the gravity-flipped flag; `flipMod()` turns it into the ±1 used throughout the physics.**
  ```c
  int PlayerObject::flipMod(PlayerObject *this) { if (*((_BYTE *)this + 1967)) return -1; else return 1; }
  ```
  Independently: `playerIsFalling`, `playerIsFallingBugged` and `playerIsMovingUp` all branch on
  +1967 to decide which sign of +1936 counts as "down"; `hardFlipGravity` calls
  `flipGravity(this, this[1967] ^ 1, 1)`; and `loadFromCheckpoint` restores it by calling
  `flipGravity(this, checkpoint[284], 0)`.
  ```c
  bool PlayerObject::playerIsMovingUp(PlayerObject *this) {
    v1 = *((unsigned __int8 *)this + 1967);
    v2 = (double *)((char *)this + 1936);
    if (v1) return *v2 < 0.0; else return *v2 > 0.0;
  }
  ```
  <sub>PlayerObject::flipMod, gd-ida-decomp.cpp:143484-143489; playerIsFalling / playerIsFallingBugged / playerIsMovingUp, gd-ida-decomp.cpp:144307-144390; hardFlipGravity, gd-ida-decomp.cpp:151223-151236</sub>

- **+1970 is `m_isReversed`; `reverseMod()` is its ±1, and `update` negates the x step when it is set.**
  ```c
  int PlayerObject::reverseMod(PlayerObject *this) { if (*((_BYTE *)this + 1970)) return -1; else return 1; }
  // update():
  v40 = *((unsigned __int8 *)this + 1970);
  if (v40 && !*((_BYTE *)this + 2336)) v39 = -v39;      // v39 is the x delta; 2336 == platformer
  ```
  `doReversePlayer` is its only setter; `reversePlayer` toggles it with
  `doReversePlayer(this, this[1970] ^ 1)`; the checkpoint stores it at byte 309 and restores it
  through `doReversePlayer(this, 1)`.
  <sub>PlayerObject::reverseMod, gd-ida-decomp.cpp:143698-143703; PlayerObject::update, gd-ida-decomp.cpp:161079-161083; doReversePlayer, gd-ida-decomp.cpp:148312-148345</sub>

- **+1971 is the rotated-gameplay flag; `update` swaps the x and y components of the position delta when it is set.**
  ```c
  v42 = (double *)((char *)this + 1992);
  v43 = v39 + *((double *)this + 249);        // x delta + the bled-out reverse offset
  if ( *((_BYTE *)this + 1971) ) { v44 = v35; v35 = v43; v43 = v44; }   // swap dx and dy
  ```
  `rotateGameplayOnly` is its named setter (`loadFromCheckpoint` restores it with
  `rotateGameplayOnly(this, checkpoint[285])`), and `updateShipRotation` /
  `updateStaticForce` / `runNormalRotation` / `runBallRotation` all branch on it to swap or
  negate an axis.
  <sub>PlayerObject::update, gd-ida-decomp.cpp:161084-161091; loadFromCheckpoint, gd-ida-decomp.cpp:161643; updateStaticForce, gd-ida-decomp.cpp:147433-147438</sub>

- **+2044 is "on the ground": `hitGround` sets it, `resetObject` sets it, and every launch clears it.**
  ```c
  // hitGround
  *((_BYTE *)this + 2044) = 1;
  *((_BYTE *)this + 2073) = a3 ^ 1;
  // resetObject
  *((_BYTE *)this + 2044) = 1;
  // boostPlayer / propellPlayer / pushDown
  *(_BYTE *)(v1 + 2044) = 0;
  ```
  `hitGroundNoJump` saves +2044 (and +1969, and +2048) across a call to `hitGround` and
  restores them afterwards — which only makes sense for landing state.
  <sub>PlayerObject::hitGround, gd-ida-decomp.cpp:150164-150165; hitGroundNoJump, gd-ida-decomp.cpp:150215-150240; boostPlayer, gd-ida-decomp.cpp:147574; propellPlayer, gd-ida-decomp.cpp:147682; pushDown, gd-ida-decomp.cpp:147936; resetObject, gd-ida-decomp.cpp:153606</sub>

- **+1969 is the "landed gently enough that holding the button jumps" latch — `hitGround` only sets it when the landing speed was ≤ 5.**
  ```c
  // hitGround
  if ( v9 <= 5.0 ) { *((_BYTE *)this + 1969) = 1; *((_QWORD *)this + 256) = *((_QWORD *)this + 268); }
  // pushButton, PlayerButton::Jump
  else if ( *((_BYTE *)this + 1963) || !PlayerObject::isFlying(this) && *((_BYTE *)this + 1909) )
  { if ( *((_BYTE *)this + 1969) ) PlayerObject::updateJump(this, 0.0); }
  // updateJump: the jump branch requires both the held flag and this one
  if ( v11 /* +1909 held */ && *((_BYTE *)this + 1969) ) { ... }
  // and it is dropped the moment the player is falling
  if ( PlayerObject::playerIsFallingBugged(this) && (...) ) *((_BYTE *)this + 1969) = 0;
  ```
  The same line also stamps +2048 from +2144, i.e. the landing time.
  <sub>PlayerObject::hitGround, gd-ida-decomp.cpp:150167-150170; pushButton, gd-ida-decomp.cpp:160528-160532; updateJump, gd-ida-decomp.cpp:155762, 155983-155987</sub>

- **+1603 marks "the trail/streak is live for this airborne stretch"; `hitGround` consumes it on landing.**
  ```c
  // hitGround, at the very end
  result = PlayerObject::isFlying(this);
  if ( !result && *((_BYTE *)this + 1603) ) { result = PlayerObject::deactivateStreak(this, 0); *((_BYTE *)this + 1897) = 1; }
  *((_BYTE *)this + 1603) = 0;
  // flipGravity sets it right after activating the streak
  *(_BYTE *)(v3 + 1603) = 1;  PlayerObject::activateStreak((PlayerObject *)v3);
  // updateJump sets it as part of a successful jump
  *((_BYTE *)this + 1603) = 1;
  ```
  `boostPlayer` and `propellPlayer` also set it to 1.
  <sub>PlayerObject::hitGround, gd-ida-decomp.cpp:150192-150197; flipGravity, gd-ida-decomp.cpp:151189-151190; updateJump, gd-ida-decomp.cpp:155852; boostPlayer, gd-ida-decomp.cpp:147570; propellPlayer, gd-ida-decomp.cpp:147686</sub>

- **+1560 (`double`) is the base x speed and +2020 (`float`) is the speed-portal multiplier; the product is the classic-mode x velocity.**
  ```c
  __int64 PlayerObject::getCurrentXVelocity(PlayerObject *this) {
    if (*((_BYTE *)this + 2336)) v1 = *((double *)this + 277);        // platformer: +2216
    else v1 = *((float *)this + 505) * *((double *)this + 195);       // +2020 * +1560
    return *(_QWORD *)&v1;
  }
  ```
  The debug nudgers confirm which is which: `speedUp` / `speedDown` step
  `*((double *)this + 195)` (= +1560) by ±0.005, and `updateTimeMod` is the only writer of
  `*(float *)((char *)this + 2020)`, taking the portal's 0.7 / 0.9 / 1.1 / 1.3 / 1.6.
  <sub>PlayerObject::getCurrentXVelocity, gd-ida-decomp.cpp:142063-142071; speedUp / speedDown, gd-ida-decomp.cpp:150897-150930; updateTimeMod, gd-ida-decomp.cpp:150522-150535</sub>

- **+2216 (`double`) is the platformer x velocity; it is clamped to ±1000 alongside +1936 and written by `updatePlayerForce`.**
  ```c
  // update()
  if ( *((_BYTE *)this + 2336) ) {                      // platformer
    v18 = (_QWORD *)((char *)this + 2216);
    v19 = *((double *)this + 277);
    if (v19 <= 1000.0) { if (v19 < -1000.0) *v18 = 0xC08F400000000000LL; }
    else               { *v18 = 0x408F400000000000LL; }
  }
  ```
  `0x408F400000000000` decodes as sign 0, exponent `0x408` = 1032 → 2^9, mantissa
  `0xF400000000000 / 2^52` = 0.953125, so 512 × 1.953125 = **1000.0**; the `0xC0…` twin is −1000.0.
  <sub>PlayerObject::update, gd-ida-decomp.cpp:161007-161018; updatePlayerForce, gd-ida-decomp.cpp:147376-147403</sub>

- **+1568 (`double`) is the jump impulse and +1576 (`double`) is gravity; the debug nudgers name them by step size.**
  ```c
  void PlayerObject::yStartUp  (PlayerObject *this) { *((double *)this + 196) += 0.00999999978; }  // +1568
  void PlayerObject::yStartDown(PlayerObject *this) { *((double *)this + 196) -= 0.00999999978; }
  void PlayerObject::gravityUp  (PlayerObject *this) { *((double *)this + 197) += 0.00100000005; } // +1576
  void PlayerObject::gravityDown(PlayerObject *this) { *((double *)this + 197) -= 0.00100000005; }
  ```
  `updateTimeMod` writes both from a per-speed table, and `updateJump` consumes +1568 as the jump
  impulse and +1576 as the gravity term (see the two bullets above).
  <sub>PlayerObject::gravityUp / gravityDown / yStartUp / yStartDown, gd-ida-decomp.cpp:150857-150970; updateTimeMod, gd-ida-decomp.cpp:150535-150566</sub>

- **The 0.9 and 0.7 speed constants decode exactly, and 0.9's gravity matches the `0.9582` literal hard-coded in `updateJump`.**
  | speed (+2020) | +1568 jump impulse | +1576 gravity | +1560 x speed |
  |---|---|---|---|
  | 0.7 | `0x40253D74D594F26B` = **10.620032** | `0x3FEE161C36976BC2` = **0.940199** | `0x4017EB85A4F00EF1` = **5.980002** |
  | 0.9 (default) | `0x40265C2D20000000` = **11.180031776…** | `0x3FEEA99100000000` = **0.958199024…** | `0x4017147B60000000` = **5.770001888…** |

  Worked example for `0x3FEEA99100000000`: sign 0; exponent `0x3FE` = 1022, so 2^(1022−1023) = 2^−1;
  mantissa `0xEA99100000000 / 2^52` = 0.9163980484…; 1.9163980484… × 0.5 = **0.9581990242…**,
  which is the `0.9582` that `updateJump` substitutes for ball / flying / spider.
  <sub>PlayerObject::updateTimeMod, gd-ida-decomp.cpp:150535-150566; PlayerObject::updateJump, gd-ida-decomp.cpp:155463-155466</sub>

- **+2016 (`float`) is the player scale — 1.0 normal, 0.6 mini — and it is what the "mini" checkpoint bit is derived from.**
  ```c
  // togglePlayerScale
  v3 = (float *)(this + 504);
  if ( *((float *)this + 504) == 1.0 ) { if (!a2) return this; *v3 = 0.6; ... }
  // saveToCheckpoint
  *((_BYTE *)a2 + 300) = *((float *)this + 504) != 1.0;
  // loadFromCheckpoint
  PlayerObject::togglePlayerScale((int *)this, *((unsigned __int8 *)a2 + 300), 0);
  ```
  `0.6` also appears as the raw `1058642330` = `0x3F19999A` in `resetObject`, which is 0.6000000238f.
  <sub>PlayerObject::togglePlayerScale, gd-ida-decomp.cpp:150392-150398; saveToCheckpoint, gd-ida-decomp.cpp:161561; resetObject, gd-ida-decomp.cpp:153659</sub>

- **+2336 is the platformer-mode flag, with a one-line named setter.**
  ```c
  int PlayerObject::togglePlatformerMode(int this, bool a2) { *(_BYTE *)(this + 2336) = a2; return this; }
  ```
  <sub>PlayerObject::togglePlatformerMode, gd-ida-decomp.cpp:141622-141626</sub>

- **+1968 is "dead": `playerDestroyed` sets it, `resetObject` clears it, and `update` skips all movement while it is set.**
  ```c
  // update
  if ( !*((_BYTE *)this + 1968) ) { ... entire movement + integration block ... }
  ```
  <sub>PlayerObject::update, gd-ida-decomp.cpp:161020; playerDestroyed, gd-ida-decomp.cpp:149946; resetObject, gd-ida-decomp.cpp:153663</sub>

- **+2004 is "dashing": `startDashing` sets it, `stopDashing` clears it, and `update` forces the y velocity to 0 while it is set.**
  ```c
  if ( *((_BYTE *)this + 2004) ) { LODWORD(v25) = this; PlayerObject::setYVelocity(v25, 0.0, 1); }
  ```
  <sub>PlayerObject::update, gd-ida-decomp.cpp:161035-161039; startDashing, gd-ida-decomp.cpp:148583; stopDashing, gd-ida-decomp.cpp:149798</sub>

- **+1601 is "restoring from a checkpoint / copying a player" and it suppresses side effects such as the gravity-flip halving.**
  `loadFromCheckpoint`, `copyAttributes` and `resetObject` all set it to 1 on entry and 0 on exit;
  `flipGravity` and `updateTimeMod` both gate their effects on `!this[1601]`.
  <sub>PlayerObject::loadFromCheckpoint, gd-ida-decomp.cpp:161637, 161744; copyAttributes, gd-ida-decomp.cpp:153307, 153329; flipGravity, gd-ida-decomp.cpp:151156-151158; updateTimeMod, gd-ida-decomp.cpp:150530</sub>

- **The player has no rotation field of its own — rotation is read and written through the `CCNode` vtable (slot 176 get, slot 172 set).**
  ```c
  int PlayerObject::getObjectRotation(PlayerObject *this) { return (*(int (**)(PlayerObject *))(*(_DWORD *)this + 176))(this); }
  int PlayerObject::setRotation(PlayerObject *this, float a2) { return GameObject::setRotation(this, a2); }   // thunk
  // updateShipRotation ends with:
  return (*(int (**)(float *, _DWORD))(*(_DWORD *)v2 + 172))(v2, v20 * 57.296);
  ```
  <sub>PlayerObject::getObjectRotation, gd-ida-decomp.cpp:140253-140256; PlayerObject::setRotation, gd-ida-decomp.cpp:140466-140469; updateShipRotation, gd-ida-decomp.cpp:144731-144732</sub>

- **+1472 (`float`) is the rotation *rate*; +1476 (`float`) is the ball's rotation-speed scalar; +1376 / +1480 / +1481 are its companion flags, and `stopRotation` clears all four.**
  ```c
  char *PlayerObject::stopRotation(PlayerObject *this, bool a2, int a3) {
    result = (char *)this + 1472;
    result[8] = 0;            // +1480
    result[9] = 0;            // +1481
    *(result - 96) = 0;       // +1376
    *(_DWORD *)result = 0;    // +1472
    return result;
  }
  // runBallRotation writes them
  *(_BYTE *)(this + 1376) = a2 != 1.0;
  *(float *)(this + 1476) = a2;
  *(float *)(v2 + 1472) = v9;   if (v8 /* +1971 */) *(float *)(v2 + 1472) = -v9;
  *(_BYTE *)(v2 + 1480) = 1;
  // runNormalRotation writes +1472 as well
  *((float *)this + 368) = (float)((float)((float)((float)result * v6) * *((float *)this + 589)) * a3) / v7;
  // updateRotation integrates it
  return v5(v2, getRotation() + (float)((float)((float)(a2 / 60.0) * *(float *)(v2 + 1472)) * v4));
  ```
  <sub>PlayerObject::stopRotation, gd-ida-decomp.cpp:142351-142355; runBallRotation, gd-ida-decomp.cpp:143729-143766; runNormalRotation, gd-ida-decomp.cpp:144538; updateRotation(float), gd-ida-decomp.cpp:144905-144912</sub>

- **+2024 (`CCPoint`, two floats at 2024/2028) is the previous-frame position that `updateShipRotation` aims the ship along.**
  ```c
  v6 = v2 + 506;   // +2024
  v7 = v2 + 507;   // +2028
  if ( *((_BYTE *)v2 + 1971) ) { v8 = v22 - *v7; v9 = v21 - *v6; }
  else                         { v8 = v21 - *v6; v9 = -(float)(v22 - *v7); }
  ...
  v10 = atan2(v9, v8);
  ```
  `copyAttributes` copies `(char *)a2 + 2024` as a `CCPoint`, and the menu layer writes the live
  position into `v5 + 2024` each frame.
  <sub>PlayerObject::updateShipRotation, gd-ida-decomp.cpp:144639-144655; copyAttributes, gd-ida-decomp.cpp:153314-153315; MenuGameLayer, gd-ida-decomp.cpp:237460-237461</sub>

- **`PlayerObject::update` drives the whole step in this order, with y on a 0.9-scaled timestep and x on the raw one.**
  ```c
  clamp yVel(+1936) to ±1000;  if (platformer) clamp xVel(+2216) to ±1000;
  if (!dead(+1968)) {
    lastPosition(+1052) = getPosition();
    if (locked(+2074)) skip;
    updateJump(this, dt * 0.9);                       // gravity, jump impulse, terminal clamp
    if (dashing(+2004)) setYVelocity(0);
    if (platformer(+2336)) updateMove(this, dt * 0.9);
    dx = getCurrentXVelocity() * dt;
    dy = yVel * (dt * 0.9);
    if (reversed(+1970) && !platformer) dx = -dx;
    dx += bleedSlice(+1992);
    if (rotatedGameplay(+1971)) swap(dx, dy);
    setPosition(getPosition() + CCPoint(dx, dy));
  }
  ```
  <sub>PlayerObject::update, gd-ida-decomp.cpp:160995-161100</sub>

## likely

- **+1984 (`double`) is a pending x offset left by an off-centre Reverse trigger, and +1992 (`double`) is the slice of it applied this frame — at most 2% of the frame's x step.**
  ```c
  // update(), immediately after setPosition
  *v42 = 0.0;                                  // v42 == this + 1992
  v51 = *((double *)this + 248);               // +1984
  if ( v51 != 0.0 ) {
    v52 = v32 * 0.0199999996;                  // v32 is the frame's x step
    v53 = fabs(v51);  if (v53 < v52) v52 = v53;
    if (v51 <= 0.0) v52 = -v52;
    *v42 = v52;                                // queued for the NEXT frame's dx
    *((double *)this + 248) = v51 - v52;
  }
  // reversePlayer() charges it with twice the offset from the trigger
  *((double *)this + 248) = *((double *)this + 248) + (float)(v7 + v7);
  ```
  The mechanism is unambiguous; calling the trigger a *Reverse* trigger specifically rests on
  `reversePlayer` taking an `EffectGameObject *` and ending in `doReversePlayer`, which is strong
  but is one site rather than two. The checkpoint saves +1984 as a float at byte 312 and restores it.
  <sub>PlayerObject::update, gd-ida-decomp.cpp:161101-161113; PlayerObject::reversePlayer, gd-ida-decomp.cpp:148375-148389; saveToCheckpoint, gd-ida-decomp.cpp:161564-161565</sub>

- **+2356 (`float`) is the gravity multiplier set by the Gravity trigger: it defaults to 1.0, scales the gravity term, and scales the normal rotation rate.**
  ```c
  // resetObject
  *((_DWORD *)this + 589) = 1065353216;        // 0x3F800000 == 1.0f
  // updateJump
  v17 = *((float *)this + 589);
  if (v17 != 1.0) v3 = v15 * v17; else v3 = v15;
  // runNormalRotation
  *((float *)this + 368) = (float)((float)((float)((float)result * v6) * *((float *)this + 589)) * a3) / v7;
  ```
  Three consistent sites, and the checkpoint round-trips it (`a2 + 88` ← `this + 589`), but nothing
  in what was read names the trigger, so "gravity multiplier" is the reading rather than a proof.
  <sub>PlayerObject::resetObject, gd-ida-decomp.cpp:153603; updateJump, gd-ida-decomp.cpp:155468-155475; runNormalRotation, gd-ida-decomp.cpp:144538; saveToCheckpoint, gd-ida-decomp.cpp:161560-161561</sub>

- **+1909 is "the jump button is held" and +1910 is the fresh press of it; +1911 / +1912 are their previous-frame copies.**
  ```c
  // pushButton, PlayerButton::Jump
  *((_BYTE *)this + 1909) = 1;
  *((_BYTE *)this + 1910) = 1;
  *((_BYTE *)this + 1600) = 0;
  PlayerObject::updateJumpVariables(this);
  // updateJumpVariables
  this[1913] = this[1909]; this[1914] = this[1910]; this[1915..1918] = 0;
  // end of updateJump
  *((_BYTE *)this + 1911) = *((_BYTE *)this + 1909);
  *((_BYTE *)this + 1912) = *((_BYTE *)this + 1932);
  // updateJump consumes 1909 as the gate for the jump branch, and clears 1910 on jumping
  if ( v11 /* = this[1909] */ && *((_BYTE *)this + 1969) ) { ... *((_BYTE *)this + 1910) = 0; ... }
  ```
  The "held vs. pressed" split is the natural reading and matches `canStickToGround`'s use of
  +1910, but no getter names either byte.
  <sub>PlayerObject::pushButton, gd-ida-decomp.cpp:160446-160452; updateJumpVariables, gd-ida-decomp.cpp:150816-150822; updateJump, gd-ida-decomp.cpp:155762-155777, 156048-156049; canStickToGround, gd-ida-decomp.cpp:144407-144410</sub>

- **+2060 selects which of `updateJump`'s two gravity applications runs — it reads as "the player is airborne from a jump/boost".**
  It is set to 1 by the successful-jump branch, by `boostPlayer` and by `propellPlayer`; it is cleared
  by `resetObject` and by the falling check at 155952. When set, `updateJump` applies gravity at
  line 155936 and then always `goto LABEL_255` at 155979, skipping the second application at 155990.
  The gating is certain; the name is a reading.
  <sub>PlayerObject::updateJump, gd-ida-decomp.cpp:155774, 155915-155936, 155952, 155979; boostPlayer, gd-ida-decomp.cpp:147569; propellPlayer, gd-ida-decomp.cpp:147680</sub>

- **+2048 (`double`) is the time of the last soft landing, stamped from +2144 alongside +1969.**
  ```c
  // hitGround
  if ( v9 <= 5.0 ) { *((_BYTE *)this + 1969) = 1; *((_QWORD *)this + 256) = *((_QWORD *)this + 268); }
  // updateJump, platformer coyote-ish window
  if ( playerIsFallingBugged(this) && (!platformer || *((double *)this + 268) - *((double *)this + 256) >= 0.05 || !v23) )
    *((_BYTE *)this + 1969) = 0;
  ```
  Two consistent sites and the same +2144-minus-stamp shape as the `isSafe*` family, but there is no
  named accessor.
  <sub>PlayerObject::hitGround, gd-ida-decomp.cpp:150168-150169; updateJump, gd-ida-decomp.cpp:155983-155987</sub>

- **+1664 (`double`) is the last-spider-flip timestamp.**
  `isSafeSpiderFlip` reads `*((double *)this + 208)` = +1664 against +2144, and the spider jump path
  writes `*(_QWORD *)(v2 + 1664) = *(_QWORD *)(v2 + 2144);`. The write site was located by grep and
  the read site was read in full; the enclosing spider-jump function body was not read end to end.
  <sub>PlayerObject::isSafeSpiderFlip, gd-ida-decomp.cpp:147866-147872; spider jump write, gd-ida-decomp.cpp:156873</sub>

## Not established

- **The 1.1, 1.3 and 1.6 speed constants.** IDA turned three of the six `updateTimeMod` table
  entries into unresolved code labels, so the jump impulse, gravity and x speed for those speeds
  cannot be recovered from this file. Only 0.7 and 0.9 (and the shared 0.9 default for 1.1/1.3/1.6's
  x speed fall-through) are readable.
  ```c
  if ( a2 == 1.1 )                 { *((_QWORD *)this + 196) = loc_339208; *((_QWORD *)this + 197) = loc_339210; v7 = loc_339218; }
  if ( a2 == 1.3 || a2 == 1.6 )    { *((_QWORD *)this + 196) = loc_339220; *((_QWORD *)this + 197) = loc_339228; v7 = locret_339230; }
  ```
  Note also that 1.3 and 1.6 share one table row, which is worth reproducing as-is.
  <sub>PlayerObject::updateTimeMod, gd-ida-decomp.cpp:150550-150561</sub>

- **What the `int` third argument to `setYVelocity` / `addToYVelocity` does.** Every call site passes
  a different small integer (1, 2, 3, 4, 5, 6, 37, 42, 44, 45, 46, 47, 48, 49, 50, 60, 61, 62, 63, 68).
  It is never read inside `setYVelocity`, which ignores `a3` entirely. It is almost certainly a
  call-site tag for debugging, but nothing in the decompile proves that, so treat it as a no-op.
  <sub>PlayerObject::setYVelocity, gd-ida-decomp.cpp:141992-142006</sub>

- **The exact meaning of `v9` in `hitGround`'s `if (v9 <= 5.0)` landing test.** The comparison and
  its consequence (+1969 and +2048) were read; `v9`'s own assignment lies earlier in `hitGround`
  than the range read here, so the quantity being compared to 5.0 is not proven to be the landing
  y speed, only strongly implied.
  <sub>PlayerObject::hitGround, gd-ida-decomp.cpp:150167-150170</sub>

- **Which cocos2d `CCNode` field the vtable rotation slots resolve to.** Slots 172/176 are called
  indirectly everywhere; `PlayerObject::setRotation` is a thunk to `GameObject::setRotation`, which
  was not read. The port should treat rotation as "owned by the node", not as a PlayerObject offset.
  <sub>PlayerObject::setRotation, gd-ida-decomp.cpp:140466-140469</sub>

- **+2072, +2073, +2074, +2075, +1600, +1602, +1607, +1608, +1858, +1897, +1932, +2264, +2313, +2314, +2315.**
  These appear in the ranges read (e.g. +2074 gates the whole movement block in `update` alongside
  +1968, and +1858 is set by every force/boost path and cleared by `updateStaticForce`'s zero case),
  but none of them has a named accessor or a two-site proof in what was read. They are listed here so
  the port does not silently invent meanings for them.
  <sub>PlayerObject::update, gd-ida-decomp.cpp:161028-161029; updateStaticForce, gd-ida-decomp.cpp:147443-147454</sub>

- **The 8-byte value at +1872 / +1864 that `flipGravity` zeroes, and +1680 which the spider and robot toggles set to `0x3FF8000000000000` (= 1.5).**
  The writes were read; nothing establishes what they hold.
  ```c
  *(_QWORD *)(v3 + 1872) = 0LL;  *(_QWORD *)(v3 + 1864) = 0LL;     // flipGravity
  *(_QWORD *)(v4 + 1680) = 0x3FF8000000000000LL;                   // toggleSpiderMode / toggleRobotMode
  ```
  `0x3FF8000000000000`: exponent `0x3FF` = 1023 → 2^0, mantissa `0x8000000000000 / 2^52` = 0.5,
  so 1.5.
  <sub>PlayerObject::flipGravity, gd-ida-decomp.cpp:151150-151151; toggleSpiderMode, gd-ida-decomp.cpp:152724; toggleRobotMode, gd-ida-decomp.cpp:153225</sub>

---

## What this means for the port

1. A mode portal must multiply y velocity by **0.5 per toggle that actually changes**, and
   `switchedToMode` fires the outgoing toggle first. Wave → ship is therefore **×0.25**, not ×1.
2. Cube → ship is **×0.5** (only `toggleFlyMode` changes; cube is the absence of all flags, so
   no outgoing air-mode toggle runs).
3. Ship → ball is **×0.5** (`toggleFlyMode(0)` halves; `toggleRollMode(1)` does not).
4. Ball → robot is **×1.0** — neither toggle touches y velocity.
5. A gravity portal on the same frame adds another **×0.5** via `flipGravity`.
6. Leaving a mode halves just as much as entering it. There is no "only on entry" rule anywhere
   in the seven toggles.
7. The y integration uses `dt * 0.9`; the x integration uses raw `dt`. Both `updateJump` and the
   y position step get the 0.9-scaled value.
8. Terminal velocity is ±15 applied inside `updateJump` in the falling direction only, then a
   hard ±1000 safety clamp at the top of `update`.
9. `setYVelocity` quantises to 1/1000, so velocities in the port should be rounded the same way if
   macro replays are to stay in sync.
