# mode portals, read out of the 2.206 decompile

All line numbers refer to `D:/Proxy/games-src/geometrydash/data/ref/gd-ida-decomp.cpp`.
Every range cited below was read directly before it was written down.

> **Verification pass, second reading.** Every bullet that was under **certain** was
> re-read against the cited lines, every float/double constant re-decoded, and every
> offset-to-meaning identification re-checked against an independent site. Seven claims
> did not survive and have been moved down into **likely** / **Not established** with a
> parenthetical saying what the code actually says; several survivors were corrected in
> place (one constant was mis-decoded, several citations pointed at the wrong function).
> Where this summary and a demoted bullet disagree, the demoted bullet is right.

## summary

A mode portal is two layers of work. `GJBaseGameLayer::switchToFlyMode` /
`switchToRollMode` / `switchToRobotMode` / `switchToSpiderMode` first call
`PlayerObject::switchedToMode(player, id)`, which turns **every mode except the one
being entered** off, and then call the one `toggle*Mode(player, 1, ...)` for the mode
being entered. So a single portal usually runs **two** toggles that actually fire
their guard: the old mode's "off" and the new mode's "on". A toggle whose flag
already equals the argument returns immediately and does nothing at all — the whole
body of each of the seven toggles sits inside `if (flag != a2) { ... }`.

Four of the seven toggles — fly, bird, dart, swing — contain
`*(double *)(this + 1936) = *(double *)(this + 1936) * 0.5;`, **inside** that guard.
Roll, robot and spider do not. `+1936` is the y velocity: `PlayerObject::setYVelocity`
writes it and `PlayerObject::getYVelocity` returns it. The halving is a raw write to
the double and therefore skips the 1/1000 quantisation that `setYVelocity` applies.

The consequence for the question that prompted this: **wave → ship halves the y
velocity twice**, once in `toggleDartMode(0)` (wave off) and once in
`toggleFlyMode(1)` (ship on). The surviving y velocity is a **quarter** of what it was.
(Verified — but only for a single player. `playerWillSwitchMode` runs *before*
`switchToFlyMode` and can itself call `PlayerObject::flipGravity` on the player in dual
mode, at 462594, which halves again. See the demoted bullet under **likely**.)
Rotation is not carried through at all — both toggles call `setRotation(0.0f)`, so the
player leaves the portal at 0°, not at the wave's 45°, and `updateShipRotation` then
slerps away from 0 on the following ticks.

`PlayerObject::stopRotation(this, a2, a3)` is *not* an angle reset. Its whole body
zeroes the continuous rotation **rate** at `+1472` and the three flags that drive it
(`+1480`, `+1481`, `+1376`). Both of its arguments are dead in this decompile. The
angle is reset separately, by the vtable call at slot `+172`.

Nothing in any of the seven toggles, or in `switchToFlyMode` and friends, touches the
player's position. The `CCPoint` the portal path writes (`+2032`) is the *last portal
location*, used to place the portal circle effect — not the player's position.

---

## certain

**`+1936` is the player's y velocity, as a `double`.**
`PlayerObject::setYVelocity` is the only writer through the normal path and it stores
its (quantised) argument at `+1936`; `PlayerObject::getYVelocity` returns
`*((_QWORD *)this + 242)`, and `242 * 8 == 1936`; `PlayerObject::addToYVelocity` reads
`+1936`, adds, and calls `setYVelocity`.
```c
// setYVelocity(this, a2, a3): quantises to 3 decimals, then stores
v5 = (double)(int)a2;
if ( a2 != v5 ) { LODWORD(this) = round(); v3 = v5 + this / 1000.0; }
*(double *)(v4 + 1936) = v3;
// getYVelocity(this): return *((_QWORD *)this + 242);   // 242*8 == 1936
```
<sub>PlayerObject::setYVelocity / getYVelocity / addToYVelocity, gd-ida-decomp.cpp:141991-142051</sub>

**The toggles bypass `setYVelocity`.**
Every halving site writes the double in place; none of them routes through
`setYVelocity`. (Re-read and confirmed: 152586, 152819, 152930, 153032 are all raw
`*(double *)(this + 1936) = *(double *)(this + 1936) * 0.5;`. What `setYVelocity`
itself *does* to its argument is no longer claimed here as certain — see the demoted
bullet under **likely** — but that it is not on the toggles' path is certain.)
<sub>PlayerObject::toggleFlyMode, gd-ida-decomp.cpp:152819; PlayerObject::setYVelocity, gd-ida-decomp.cpp:141992-142008</sub>

**`0x3FE0000000000000` is not what the toggles use — the literal is IDA's `0.5`, and the factor is exactly one half.**
The decompiler prints the double literal directly as `* 0.5`. Working, for the record:
`0x3FE0000000000000` → sign 0, exponent `0x3FE` = 1022 → `2^(1022-1023)` = `2^-1`,
mantissa bits all zero → significand `1.0`, so the value is `1.0 × 2^-1 = 0.5`.
<sub>PlayerObject::toggleFlyMode, gd-ida-decomp.cpp:152819</sub>

**Exactly four toggles halve the y velocity, and the halving is inside the "flag changed" guard in all four.**
Fly, bird, dart and swing halve. Roll, robot and spider contain no write to `+1936`
anywhere in their bodies.

| toggle | halves `+1936`? | line of the halving |
|---|---|---|
| `toggleSwingMode` | yes, ×0.5 | 152586 |
| `toggleFlyMode` | yes, ×0.5 | 152819 |
| `toggleBirdMode` | yes, ×0.5 | 152930 |
| `toggleDartMode` | yes, ×0.5 | 153032 |
| `toggleSpiderMode` | **no** | — |
| `toggleRollMode` | **no** | — |
| `toggleRobotMode` | **no** | — |

Each of those four lines sits between the guard `if (*(u8*)(this+FLAG) != a2) {` and
that block's closing brace, so it runs on **both** directions of the transition —
turning the mode on and turning it off alike.
<sub>PlayerObject::toggleSwingMode 152569-152640; toggleSpiderMode 152689-152780; toggleFlyMode 152796-152889; toggleBirdMode 152905-152987; toggleDartMode 153003-153097; toggleRollMode 153113-153175; toggleRobotMode 153191-153283</sub>

**`PlayerObject::stopRotation` zeroes the rotation *rate* and three rotation flags, and never touches the angle.**
The entire body:
```c
char *__fastcall PlayerObject::stopRotation(PlayerObject *this, bool a2, int a3)
{
  char *result = (char *)this + 1472;
  result[8] = 0;          // this + 1480
  result[9] = 0;          // this + 1481
  *(result - 96) = 0;     // this + 1376
  *(_DWORD *)result = 0;  // this + 1472, a float -> 0.0f
  return result;
}
```
<sub>PlayerObject::stopRotation, gd-ida-decomp.cpp:142347-142357</sub>

**Neither argument of `stopRotation` is used by its body.**
`a2` (a `bool`) and `a3` (an `int`) are both dead in the decompiled function. (This half
re-verified: the four statements at 142351-142355 use neither. The claim that every call
site passes a *distinct* tag is false and has been demoted — see **Not established**.)
<sub>PlayerObject::stopRotation 142347-142357; call sites 144584, 144882, 147595, 147968, 148585, 149947, 150174-150187, 151198, 152585, 152725, 152775, 152818, 152929, 153031, 153170, 153226, 153278, 153661, 157932, 159596, 421227, 421243; PlayerObject::setYVelocity 141992-142008</sub>

**`+1472` is a rotation rate in degrees per 60 units of step, integrated every tick.**
`PlayerObject::updateRotation(float)` reads the current angle through vtable slot
`+176`, adds `(step/60) * (+1472) * scale`, and writes it back through vtable slot
`+172`. `runBallRotation` and `runBallRotation2` load it. (Integration re-verified at
144904-144912. Correction: they are **not** the only two loaders — `boostPlayer` also
writes it, `*(float *)(v1 + 1472) = (float)(-180 * flipMod()) / v3` with `v3` 0.86667 at
normal scale and 0.66667 at mini, and sets `+1480 = 1` alongside, at 147595-147599. So
the rate is driven in cube mode too, not only by the ball.)
```c
if ( *(float *)(v2 + 1472) != 0.0 ) {
  v4 = (*(u8*)(v2+1376) && *(u8*)(v2+1963)) ? *(float *)(v2 + 1476) : 1.0;
  v5 = *(...)(*(_DWORD *)v2 + 172);                    // setRotation
  v6 = (*(...)(*(_DWORD *)v2 + 176))(v2);              // getRotation
  return v5(v2, v6 + (float)((float)((a2 / 60.0) * *(float *)(v2 + 1472)) * v4));
}
```
<sub>PlayerObject::updateRotation(float), gd-ida-decomp.cpp:144845-144915; runBallRotation 143719-143769; runBallRotation2 143785-143826</sub>

**Vtable slot `+172` is `setRotation(float degrees)` and slot `+176` is `getRotation()`.**
`updateShipRotation` reads slot `+176`, multiplies by `0.017453` (π/180, degrees →
radians), slerps in radians, then writes the result back through slot `+172` after
multiplying by `57.296` (180/π, radians → degrees). That fixes both slots beyond doubt.
```c
v11 = COERCE_FLOAT((*(...)(*(_DWORD *)v2 + 176))(v2));
v12 = v11 * 0.017453;
...
v20 = COERCE_FLOAT(Slerp2D(v12, v10, v19));
return COERCE_FLOAT((*(...)(*(_DWORD *)v2 + 172))(v2, v20 * 57.296));
```
<sub>PlayerObject::updateShipRotation, gd-ida-decomp.cpp:144607-144733 (slot reads at 144654 and 144732)</sub>

**`+1480`, `+1481` and `+1376` are the ball-rotation flags `stopRotation` clears.**
`runBallRotation` writes the rate into `+1472`, sets `+1376 = (a2 != 1.0)` and
`+1480 = 1`; `runBallRotation2` writes `+1472` and sets `+1481 = 1`. `+1376` gates the
extra `+1476` speed multiplier applied in `updateRotation`.
<sub>PlayerObject::runBallRotation 143719-143769; runBallRotation2 143785-143826; updateRotation 144845-144915</sub>

**Each toggle's `setRotation` call, exactly.** `0` is the float `0.0f` (bit pattern
`0x00000000`); `1127481344` = `0x43340000` → exponent `0x86` = 134 → `2^7` = 128,
mantissa `0x340000/0x800000` = 0.40625 → `1.40625 × 128` = **180.0f**.

| toggle | on entering the mode | on leaving the mode |
|---|---|---|
| fly | `setRotation(0.0f)` (152820, unconditional inside guard) | `setRotation(0.0f)` (same line) |
| bird | `setRotation(0.0f)` (152931, unconditional inside guard) | `setRotation(0.0f)` (same line) |
| dart | `setRotation(0.0f)` (153033, unconditional inside guard) | `setRotation(0.0f)` (same line) |
| swing | `setRotation(0.0f)` (152587) | `setRotation(0.0f)` (152587), then `setRotation(+1967 ? 180.0f : 0.0f)` (152633) |
| roll | nothing | `setRotation(+1967 ? 180.0f : 0.0f)` (153168) |
| spider | `setRotation(0.0f)` (152726, inside the `if (a2)` branch) | nothing |
| robot | `setRotation(0.0f)` (153227, inside the `if (a2)` branch) | nothing |

<sub>PlayerObject::toggleSwingMode 152569-152640; toggleSpiderMode 152689-152780; toggleFlyMode 152796-152889; toggleBirdMode 152905-152987; toggleDartMode 153003-153097; toggleRollMode 153113-153175; toggleRobotMode 153191-153283</sub>

**Each toggle's `stopRotation` call, exactly.**

| toggle | on entering | on leaving |
|---|---|---|
| fly | `stopRotation(this, 0, 7)` (152818) | same call, same line |
| bird | `stopRotation(this, 0, 8)` (152929) | same call, same line |
| swing | `stopRotation(this, 0, 9)` (152585) | same call, same line |
| dart | `stopRotation(this, 0, 10)` (153031) | same call, same line |
| roll | `stopRotation(this, 1, 11)` (153170) | same call, same line |
| robot | `stopRotation(this, 0, 12)` (153226, only when entering) **and** `stopRotation(this, 1, 13)` (153278) | `stopRotation(this, 1, 13)` only |
| spider | `stopRotation(this, 0, 14)` (152725, only when entering) **and** `stopRotation(this, 1, 15)` (152775) | `stopRotation(this, 1, 15)` only |

<sub>same function ranges as above</sub>

**`switchedToMode(player, id)` turns off every mode *except* the one named by `id`.**
The control flow is obfuscated by IDA's comma operators, but evaluating it for each id
gives a clean rule. The body:
```c
if ( (a2 != 5 && (toggleFlyMode(a1,0,0), a2 == 19)
   || (toggleBirdMode(a1,0,0), a2 != 16))
  && (toggleRollMode(a1,0,0), a2 == 26)
  || (toggleDartMode(a1,0,0), a2 != 27) )
{
  toggleRobotMode(a1,0,0);
  if ( a2 == 33 ) return toggleSwingMode((int)a1, 0, 0);
}
result = toggleSpiderMode(a1,0,0);
if ( a2 != 41 ) return toggleSwingMode((int)a1, 0, 0);
return result;
```
Worked through, with short-circuiting:

| `a2` | toggles called with `0`, in order | skipped |
|---|---|---|
| 5 | bird, roll, dart, robot, spider, swing | fly |
| 19 | fly, roll, dart, robot, spider, swing | bird |
| 16 | fly, bird, dart, robot, spider, swing | roll |
| 26 | fly, bird, roll, robot, spider, swing | dart |
| 27 | fly, bird, roll, dart, spider, swing | robot |
| 33 | fly, bird, roll, dart, robot, swing (early return) | spider |
| 41 | fly, bird, roll, dart, robot, spider | swing |
| 6 | **all seven** | none |
<sub>PlayerObject::switchedToMode, gd-ida-decomp.cpp:152656-152673</sub>

**A toggle whose flag already equals its argument does nothing whatsoever.**
The flags are one byte each: fly `+1961`, bird `+1962`, roll `+1963`, dart `+1964`,
robot `+1965`, spider `+1966`, swing `+1972`. Each toggle opens with
`if (*(u8 *)(this + FLAG) != a2) { ... }` and returns its `this`-ish value untouched
otherwise. `PlayerObject::copyAttributes` re-plays exactly these seven bytes through
the seven toggles, which independently confirms the flag-to-toggle mapping.
```c
PlayerObject::toggleFlyMode   (this, *((u8 *)a2 + 1961), 0);
PlayerObject::toggleBirdMode  (this, *((u8 *)a2 + 1962), 0);
PlayerObject::toggleRollMode  (this, *((u8 *)a2 + 1963), 0);
PlayerObject::toggleDartMode  (this, *((u8 *)a2 + 1964), 0);
PlayerObject::toggleRobotMode (this, *((u8 *)a2 + 1965), 0);
PlayerObject::toggleSpiderMode(this, *((u8 *)a2 + 1966), 0);
PlayerObject::toggleSwingMode (this, *((u8 *)a2 + 1972), 0);
```
<sub>PlayerObject::copyAttributes, gd-ida-decomp.cpp:153318-153324</sub>

**No toggle, and no `switchTo*Mode`, writes the player's position.**
The only `CCPoint` the mode-portal path assigns is `player + 2032`, written by
`GJBaseGameLayer::processCameraObject` from the *portal object's* position, alongside
`player + 2116 = portalObject`. Both are consumed by `spawnPortalCircle`, which places
the circle wave at `+2032` and attaches it to the node at `+2116`. So `+2032` is the
last-portal location, not the player's position. The player's own position lives at
`+2024` (written from `getPosition()` and read by `updateShipRotation` as the previous
frame's point).
```c
// processCameraObject
v7 = (*(...)(*(_DWORD *)a2 + 96))(a2);           // portal->getPosition()
cocos2d::CCPoint::CCPoint((cocos2d::CCPoint *)v9, v7);
cocos2d::CCPoint::operator=((char *)a3 + 2032, v9);
*((_DWORD *)a3 + 529) = v6;                       // 529*4 == 2116
```
<sub>GJBaseGameLayer::processCameraObject 420070-420102; PlayerObject::spawnPortalCircle 143138-143185; GJBaseGameLayer::switchToFlyMode 420198-420246; switchToRobotMode 420262-420275; switchToSpiderMode 420291-420304; switchToRollMode 420320-420333</sub>

**There is no grid snap and no snap to the portal's y anywhere in the mode-switch path.**
The one place in the whole object-collision dispatcher that assigns a `CCPoint` to the
player for a *mode* portal is the cube-portal case (`case 6`), and it assigns to
`+2032` — the same last-portal-location field — not to the position.
```c
case 6:   // cube portal
  GJBaseGameLayer::playerWillSwitchMode(a1, player, v73);
  v46 = portal->getPosition();
  cocos2d::CCPoint::operator=(player + 2032, v46);
  *(_DWORD *)(player + 2116) = v73;
  PlayerObject::switchedToMode(player, 6);
  PlayerObject::modeDidChange(player);
```
<sub>object-collision dispatcher, gd-ida-decomp.cpp:463551-463562</sub>

**State cleared by fly, bird, dart and swing (and by none of roll, robot, spider).**
All four clear, in order, immediately after the `setRotation(0)`:
`+2044 = 0`, `+1969 = 0`, `+1603 = 0`, then `removePendingCheckpoint()`.
- `+2044` is the on-ground flag: `PlayerObject::hitGround` sets it to `1`.
- `+1969` is the soft-landing flag: `hitGround` sets it to `1` only when the landing
  speed `v9 <= 5.0`, and stamps `+2048` at the same time.
- `+1603` is the boost-streak flag: `PlayerObject::boostPlayer` sets it to `1`, and
  `hitGround` deactivates the streak and clears it.
- `removePendingCheckpoint` releases and nulls the pending `CheckpointObject` at
  `+1732` (`433*4`).
```c
*(_BYTE *)(v4 + 2044) = 0;   // 152588 swing / 152821 fly / 152932 bird / 153034 dart
*(_BYTE *)(v4 + 1969) = 0;
*(_BYTE *)(v4 + 1603) = 0;
PlayerObject::removePendingCheckpoint((PlayerObject *)v4);
```
<sub>PlayerObject::hitGround 149979-150200 (sets +2044 at 150164, +1969 at 150168, clears +1603 at 150197); boostPlayer 147558-147604; removePendingCheckpoint 150611-150626; toggle bodies at 152588-152591, 152821-152824, 152932-152935, 153034-153037</sub>

**All seven toggles stamp the mode-change time: `*(double *)(this + 1592) = *(double *)(this + 2144)`.**
`+2144` is the player's running time accumulator (`MenuGameLayer` advances a float by
`dt` each frame and stores it there as a double). `PlayerObject::isSafeMode(this, a2)`
reads `+1592` and returns `v2 != 0.0 && *((double *)this + 268) - v2 < a2` — i.e.
"a mode change happened less than `a2` seconds ago". `isSafeHeadTest` calls it with 0.2.
```c
bool PlayerObject::isSafeMode(PlayerObject *this, float a2)
{ double v2 = *((double *)this + 199);          // 199*8 == 1592
  return v2 != 0.0 && *((double *)this + 268) - v2 < a2; }   // 268*8 == 2144
```
<sub>PlayerObject::isSafeMode 147888-147894; isSafeHeadTest 147910-147913; time accumulator write, MenuGameLayer, 237457-237468; stamps at 152581, 152713, 152814, 152925, 153026, 153130, 153217</sub>

**Spider and robot preload the double at `+1680` with 1.5.**
`0x3FF8000000000000` → exponent `0x3FF` = 1023 → `2^0`, mantissa
`0x8000000000000 / 0x10000000000000` = 0.5 → significand 1.5 → **1.5**. They are the
only two toggles that write it.
<sub>PlayerObject::toggleSpiderMode 152724; toggleRobotMode 153225</sub>

**Spider and dart resize the collision box, on entry only.**
Constants, decoded: `1104674816` = `0x41D00000` → exponent `0x83` = 131 → `2^4` = 16,
mantissa `0x500000/0x800000` = 0.625 → `1.625 × 16` = **26.0f**.
`1101004800` = `0x41A00000` → `2^4`, mantissa 0.25 → `1.25 × 16` = **20.0f**.
`1092616192` = `0x41200000` → exponent `0x82` = 130 → `2^3` = 8, mantissa 0.25 →
`1.25 × 8` = **10.0f**.
```c
// toggleSpiderMode, entering
*(_DWORD *)(v4 + 2160) = 1104674816;   // 26.0f
*(_DWORD *)(v4 + 648)  = 1104674816;   // 26.0f
*(_DWORD *)(v4 + 652)  = 1104674816;   // 26.0f
// toggleDartMode, entering
*(_DWORD *)(v3 + 2160) = 1101004800;   // 20.0f
*(_DWORD *)(v3 + 648)  = 1092616192;   // 10.0f
*(_DWORD *)(v3 + 652)  = 1092616192;   // 10.0f
```
`+648` and `+652` are the object's oriented-bounding-box width and height:
`GameObject::getObjectRect` feeds `(+648 * +764) * +1000` and `(+652 * +768) * +1004`
straight into `OBB2D::create` / `OBB2D::calculateWithCenter` as the box dimensions.
Neither value is restored when the mode is left — the other toggles overwrite them.
<sub>PlayerObject::toggleSpiderMode 152721-152723; toggleDartMode 153041-153043; GameObject::getObjectRect(float,float,float) 170812-170947</sub>

**`getGroundHeightForMode` constants, decoded, and the ids they map to.**
`1131413504` = `0x43700000` → exponent `0x86` = 134 → `2^7` = 128, mantissa
`0x700000/0x800000` = 0.875 → `1.875 × 128` = **240.0f**.
`1133903872` = `0x43960000` → exponent `0x87` = 135 → `2^8` = 256, mantissa
`0x160000/0x800000` = 0.171875 → `1.171875 × 256` = **300.0f**.
`1132920832` = `0x43870000` → `2^8` = 256, mantissa `0x070000/0x800000` = 0.0546875 →
`1.0546875 × 256` = **270.0f**.

Tracing every id through the loop: `16 → 240.0`; `5`, `19`, `26`, `41 → 300.0`;
`33 → 270.0`; `27 → 270.0` (falls past every test); `6` and `0 → 270.0`. Ids `23` and
`24` are special: the function overwrites `a2` with `*((_DWORD *)this + 270)` (offset
1080 in `GJBaseGameLayer`) and returns 270.0 if that is also 23 or 24, otherwise
re-enters the same decision tree with the substituted value.
<sub>GJBaseGameLayer::getGroundHeightForMode, gd-ida-decomp.cpp:419619-419650</sub>

**The mode ids are `GameObjectType` values, and the object-collision dispatcher maps them to the toggles directly.**

| id | hex | toggle it enters | ground height |
|---|---|---|---|
| 5 | 0x05 | `toggleFlyMode` (ship / jetpack) | 300.0 |
| 6 | 0x06 | none — `switchedToMode(6)` turns all seven off (cube) | 270.0 |
| 16 | 0x10 | `toggleRollMode` (ball) | 240.0 |
| 19 | 0x13 | `toggleBirdMode` (UFO) | 300.0 |
| 26 | 0x1A | `toggleDartMode` (wave) | 300.0 |
| 27 | 0x1B | `toggleRobotMode` (robot) | 270.0 |
| 33 | 0x21 | `toggleSpiderMode` (spider) | 270.0 |
| 41 | 0x29 | `toggleSwingMode` (swing) | 300.0 |

Proof of the dispatch, independent of the toggles' own names: `switchToFlyMode` takes
the id as `a5` and switches on it — `case 5` → `toggleFlyMode`, `case 19` →
`toggleBirdMode`, `case 41` → `toggleSwingMode`, `default` → `toggleDartMode`; and
`switchToRobotMode`/`switchToSpiderMode`/`switchToRollMode` hard-code 27/33/16 next to
their own toggle. `playerWillSwitchMode` reads the same ids back out of the portal
object to decide which flag of the *other* player to inspect: 5→`+1961`, 0x10→`+1963`,
19→`+1962`, 0x1B→`+1965`, 0x21→`+1966`, 0x29→`+1972`.
<sub>GJBaseGameLayer::switchToFlyMode 420198-420246; switchToRobotMode 420262-420275; switchToSpiderMode 420291-420304; switchToRollMode 420320-420333; playerWillSwitchMode 462507-462600; object-collision dispatcher cases 5/6/0x10/0x13 at 463543-463669</sub>

**A wave entering a ship portal comes out with a quarter of its y velocity and 0° of rotation.**
The chain, with only the toggles that actually fire their guard:
```
object-collision dispatcher, case 5 (ship portal)
  canBeActivatedByPlayer(...)
  GJBaseGameLayer::playerWillSwitchMode(layer, player, portal)
  GJBaseGameLayer::switchToFlyMode(layer, player, portal, 0, /*a5=*/5)
    PlayerObject::switchedToMode(player, 5)
      toggleBirdMode (0) -> flag +1962 already 0 -> returns, no effect
      toggleRollMode (0) -> flag +1963 already 0 -> returns, no effect
      toggleDartMode (0) -> flag +1964 IS 1  ==> GUARD FIRES
            +1592 = +2144                       (mode-change timestamp)
            +1964 = 0
            stopRotation(player, 0, 10)         (rotation rate -> 0)
            +1936 *= 0.5                        (** first halving **)
            setRotation(0.0f)                   (vtable +172)
            +2044 = 0; +1969 = 0; +1603 = 0
            removePendingCheckpoint()
            else-branch: updatePlayerFrame + resetPlayerIcon
            CCMotionStreak::setStroke(+1544, +1812 * +2016 * 1.0)
            a2 == 0, so NO modeDidChange
      toggleRobotMode (0) -> +1965 already 0 -> no effect
      toggleSpiderMode(0) -> +1966 already 0 -> no effect
      toggleSwingMode (0) -> +1972 already 0 -> no effect
    processCameraObject(layer, portal, player)  -> +2032 = portal pos, +2116 = portal
    PlayerObject::toggleFlyMode(player, 1, portal->+900)
                             -> flag +1961 is 0, arg is 1 ==> GUARD FIRES
            +1592 = +2144
            +1961 = 1
            switchedToMode(player, 5)  -- re-entered, but every flag now already
                                          matches, so all six inner toggles no-op
            stopRotation(player, 0, 7)
            +1936 *= 0.5                        (** second halving **)
            setRotation(0.0f)
            +2044 = 0; +1969 = 0; +1603 = 0
            removePendingCheckpoint()
            ship art, particles, streak, portal circle
            modeDidChange()  -> updatePlayerArt + updateDashArt
```
Result, on the first tick after the portal:
- **y velocity = 0.25 × the wave's y velocity**, sign unchanged, written raw (not
  quantised by `setYVelocity`).
- **rotation = 0.0°**, regardless of the wave's 45°. `updateRotation` then routes to
  `updateShipRotation` (because `isFlying()` is true for `+1961`), which slerps from 0
  toward `atan2` of the movement delta at rate `0.15 × step` for a plain ship.
- position unchanged; `+2044`, `+1969`, `+1603` cleared; pending checkpoint dropped;
  ball-rotation rate and flags zeroed twice.
<sub>dispatcher 463543-463550; switchToFlyMode 420198-420246; switchedToMode 152656-152673; toggleDartMode 153003-153097; toggleFlyMode 152796-152889; updateRotation 144845-144915; updateShipRotation 144607-144733</sub>

**`PlayerObject::isFlying()` is true for fly, bird, dart and swing — exactly the four modes that halve.**
```c
int PlayerObject::isFlying(PlayerObject *this)
{ if (this[1961]) return 1961; if (this[1962]) return 1962;
  if (this[1964]) return 1964; return this[1972]; }
```
<sub>PlayerObject::isFlying, gd-ida-decomp.cpp:144427-144443</sub>

**`modeDidChange` is art only; it is called only when the toggle is turning a mode ON.**
`if (a2) return PlayerObject::modeDidChange(...)` is the last statement of all seven
toggles, and the function is `updatePlayerArt(); updateDashArt();`. No physics.
<sub>PlayerObject::modeDidChange 145569-145573; tail calls at 152637, 152777, 152886, 152984, 153094, 153172, 153280</sub>

**`flipGravity` halves the y velocity too, guarded by `!*(u8 *)(this + 1601)`.**
Worth carrying into the port, because a portal pair often flips gravity in the same
frame as a mode change and the two halvings compose.
```c
if ( !*(_BYTE *)(v3 + 1601) )
{
  *(double *)(v3 + 1936) = *(double *)(v3 + 1936) * 0.5;
  ...
}
```
<sub>PlayerObject::flipGravity, gd-ida-decomp.cpp:151121-151203 (halving at 151158)</sub>

---

## likely

**`+1967` is the gravity-flipped flag, so "swing off" and "roll off" set the sprite upright-or-inverted.**
`flipGravity` writes `*(_BYTE *)(v3 + 1967) = a2` as its first act after the guard, and
`GJBaseGameLayer::flipGravity` guards on `*((u8 *)a2 + 1967) != a3`. The `setRotation`
in the off-branches of roll and swing therefore reads "180° if upside down, else 0°".
<sub>PlayerObject::flipGravity 151121-151140 (flag write at 151140); GJBaseGameLayer::flipGravity 420149-420180; toggleRollMode 153164-153168; toggleSwingMode 152629-152633 (both verified)</sub>

**`stopRotation`'s third argument is a call-site tag with no runtime effect in this build.**
It is unused in the body and every call site passes a different literal, exactly like
`setYVelocity`'s unused third argument. Most plausibly a debug/telemetry breadcrumb. I
cannot rule out that the original source used it in a build-gated assertion that the
release build compiled out.
<sub>PlayerObject::stopRotation 142347-142357</sub>

**`+2160` is the mode's nominal player height, separate from the collision box.**
Spider sets it to 26.0f and dart to 20.0f, alongside the box dimensions. The one read I
found scales it by `1.0 - playerScale(+2016)` and halves it to derive a vertical offset.
<sub>toggleSpiderMode 152721; toggleDartMode 153041; read at 237468-237472</sub>

**The community names for the ids follow from the code, with ship, ball and wave directly evidenced.**
"Fly" is the ship: its on-branch calls `updatePlayerShipFrame`, or
`updatePlayerJetpackFrame` when `+2336` is set. "Roll" is the ball: `updateRotation`
and `flipGravity` drive `runBallRotation` / `runBallRotation2` off the `+1963` flag.
"Dart" is the wave: its on-branch resets a `HardStreak` and places a streak point.
"Bird" as UFO rests on the community name only — the decompile calls it
`updatePlayerBirdFrame` and nothing more. "Robot" and "spider" are named by their own
sprite-frame format strings, `"robot_%02d_01_001.png"` and `"spider_%02d_01_001.png"`.
<sub>toggleFlyMode 152845-152847 (updatePlayerShipFrame) and 152834-152836 (updatePlayerJetpackFrame); toggleRollMode 153151; runBallRotation 143719-143769; toggleDartMode 153058-153059 (HardStreak::reset, placeStreakPoint); toggleBirdMode 152939-152941; toggleRobotMode 153234; toggleSpiderMode 152733</sub>

**`+1680` is a hold/charge accumulator that spider and robot enter pre-loaded at its cap.**
Elsewhere in `PlayerObject` the same double is compared against `1.5` and incremented
by `step * 0.1` while a button is held, incremented by `v27 / 12.94 * 1.5` on another
path, thresholded at `0.27` and `0.1`, and zeroed when a jump starts. Setting it to
1.5 on entry therefore looks like "the charge is already spent", but I have not traced
the owning function, so the meaning is inferred from the arithmetic, not read off a
name.
<sub>writes at 152724 and 153225; other uses at 155779, 155923-155926, 161181, 161222, 161424</sub>

---

## Not established

**What `stopRotation`'s second argument (`bool a2`) was meant to do.**
It is dead in the decompiled body. Call sites split it meaningfully-looking — fly,
bird, swing, dart, and the entry calls of robot and spider all pass `0`, while roll and
the exit calls of robot and spider pass `1` — but nothing in this decompile consumes
it. Do not model it.
<sub>PlayerObject::stopRotation 142347-142357</sub>

**Whether anything outside `PlayerObject` re-applies a rotation on the tick the portal fires.**
`switchToFlyMode` ends with `(*(...)(*(_DWORD *)this + 632))(this, 1)`, an unresolved
`GJBaseGameLayer` vtable slot, and `playerWillSwitchMode` calls the same slot with `0`
for every id that is *not* 5/19/26/41. I did not resolve slot `+632`, so I cannot say
it leaves rotation alone.
<sub>GJBaseGameLayer::switchToFlyMode 420245; playerWillSwitchMode 462532-462533</sub>

**Whether the jump-held / button state is cleared by a mode change.**
None of the seven toggles writes `+1858` (cleared by `handlePlayerCommand(543)` along
with `+2372`), and I did not locate the button-down member to check it. The toggles
clear the ground flags and the boost-streak flag, and that is all I can demonstrate.
<sub>PlayerObject::handlePlayerCommand 142373-142381; toggle bodies 152569-153283</sub>

**Whether dash state is cleared.**
`PlayerObject::stopDashing` exists at 149746 and no toggle calls it. Spider's on-branch
calls `playDynamicSpiderRun` and robot's runs an animation, and both toggles call an
unresolved vtable slot on `*((_DWORD *)this + 291)` — `+224` when entering and `+268`
when leaving — which I did not resolve. Dash could be stopped behind those slots.
<sub>toggleSpiderMode 152719 (slot +224) and 152764 (slot +268); toggleRobotMode 153223 (slot +224) and 153268 (slot +268)</sub>

**What `GJBaseGameLayer + 1080` (`*((_DWORD *)this + 270)`) holds, the field `getGroundHeightForMode` substitutes for ids 23 and 24.**
The function reads it and re-enters its own decision tree with the value. I did not
trace its writers, so the ground height for ids 23/24 is only known when that field is
itself 23 or 24 (→ 270.0).
<sub>GJBaseGameLayer::getGroundHeightForMode 419636-419638</sub>

**The exact wave rotation the player carries *into* the portal.**
Not needed for the answer — it is discarded — but for the record, `updateShipRotation`
slerps toward `atan2` of the movement delta at `0.25 × step` (or `0.4` when
`+2016 != 1.0`) while `+1964` is set, so it approaches but never exactly pins ±45°.
<sub>PlayerObject::updateShipRotation 144607-144733 (dart branch at 144689-144694)</sub>
