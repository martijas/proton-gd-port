# The custom-particle string, read out of the 2.206 decompile

The Custom Particles trigger (object id 2065) keeps its whole particle definition in one
`"a"`-separated list under property key 145. `GameToolbox::particleStringToStruct` splits that list
and writes token *i* into a `cocos2d::ParticleStruct`, picking `atoi` or `atof` per token;
`GameToolbox::particleFromStruct` then pushes the struct into a `CCParticleSystemQuad`, mostly
through vtable-slot calls. Neither function names anything, so the names below come from three
independent bridges that all agree. The first is cocos2d's own `CCParticleSystem::initWithDictionary`,
which parses a Particle Designer `.plist` by string key and writes the same member offsets that the
setters write, giving *plist key → member offset*. The second is each setter's one-line body, giving
*setter name → member offset*. The third, and the decisive one, is Geometry Dash's own particle
editor: `CreateParticlePopup::titleForParticleValue` maps a `gjParticleValue` enum to the on-screen
label, `valueForParticleValue` maps the same enum to a getter slot or a raw offset, and
`updateParticleValueForType` maps it to the setter slot or offset. Composing those with
`particleFromStruct` pins every slot to a name without guessing at vtable ordering, and
`CreateParticlePopup::particleValueIsInt` independently reproduces the exact int/float split that
`particleStringToStruct` uses. The enum has 72 members and the string has 72 tokens, and they cover
each other exactly.

> **Correction (audit).** "Pins every slot to a name" is not what happens. `titleForParticleValue`
> returns `"None"` for enums 56–68 and `valueForParticleValue` has no case for them at all, so
> thirteen tokens (51–58 and 63–67) get nothing from that pair. They are named instead by the
> *demangled handler symbols* on the popup — `onEmitterMode`, `onPosType`, `onToggleBlending`,
> `onToggleStartSpinEqualToEnd`, `onToggleStartRotationIsDir`, `onDynamicRotation`,
> `onSelectParticleTexture`, `onUniformColor`, `onOrderSensitive`,
> `onToggleStartSizeEqualToEnd`, `onToggleStartRadiusEqualToEnd`, `onStartRGBVarSync`,
> `onEndRGBVarSync` — each of which calls `updateParticleValueForType` with exactly one enum. That
> is a *stronger* source than the one claimed, so the names survive; the stated chain does not.
> Separately, nothing in the decompile ties a vtable **slot number** to a named
> `cocos2d::CCParticleSystem::set*` function: those symbols appear only as their own definitions
> and are never called by name, and there is no vtable in the dump. See "Not established" below.

Two things worth knowing before reading the table. The layout is *not* start-block then end-block:
it is start size / start spin / start colour (21–28, value and variance interleaved per channel),
then end size / end spin / end colour (29–40, same interleaving). And there is **no texture-name
token** — token 57 is an integer texture index, and `particleStringToStruct` synthesises the sprite
frame name `particle_%02d_001.png` from it into the struct's own string field at byte offset 264,
which is the `a1[66]` that `particleFromStruct` hands to `spriteFrameByName`. `a1[66]` is a struct
index, not a string index.

A complete string is 72 tokens, indices 0–71. `particleStringToStruct` refuses anything with 63 or
fewer tokens (`if (v5 > 62)`) *(off by one: `v5 > 62` accepts 63, so it refuses **62** or fewer —
the rest of the sentence is right and the "certain" bullet below states it correctly)*,
so 63 tokens — indices 0–62 — is the minimum it will parse; indices
63–71 are each read only if the token count reaches them and default to 0/false otherwise. The
"vtable slot or offset" column gives the setter slot used by `particleFromStruct`; where it writes
the system directly instead, the byte offset on `CCParticleSystemQuad` is given as `sys+N`.

| index | type | name | vtable slot or offset | notes |
|---|---|---|---|---|
| 0 | int | maxParticles | slot 744 `setTotalParticles` | member 568; editor "Max Particles". On a fresh system this is the `createWithTotalParticles` capacity instead |
| 1 | float | duration | slot 456 `setDuration` | member 372; seconds. `-1` = forever (`onDurationForever` writes `-1.0`) |
| 2 | float | particleLifespan | slot 480 `setLife` | member 392; editor "Lifetime" |
| 3 | float | particleLifespanVariance | slot 488 `setLifeVar` | member 396; editor "+-" |
| 4 | int | emission rate | slot 736 `setEmissionRate` | member 564; editor "Emission". No plist key — Particle Designer derives it from maxParticles/lifespan, GD stores it outright. **Add:** `-1` is a real, common value meaning "max" — `onMaxEmission` writes `-1.0` and `onCalcEmission` writes `totalParticles/(life+lifeVar)`; 111 of 1000 official placements store `-1` |
| 5 | int | angle | slot 496 `setAngle` | member 400. The editor shows and accepts the *negated* value; the string holds the cocos2d sign |
| 6 | int | angleVariance | slot 504 `setAngleVar` | member 404 |
| 7 | int | speed | slot 524 `setSpeed` | member 284; gravity mode only |
| 8 | int | speedVariance | slot 532 `setSpeedVar` | member 288; gravity mode only |
| 9 | int | sourcePositionVariancex | slot 472 `setPosVar`, `.x` | member 384; editor "PosVar X" |
| 10 | int | sourcePositionVariancey | slot 472 `setPosVar`, `.y` | member 388; editor "Y" |
| 11 | int | gravityx | slot 516 `setGravity`, `.x` | member 276; gravity mode only |
| 12 | int | gravityy | slot 516 `setGravity`, `.y` | member 280; gravity mode only |
| 13 | int | radialAcceleration | slot 556 `setRadialAccel` | member 300; editor "AccelRad" |
| 14 | int | radialAccelVariance | slot 564 `setRadialAccelVar` | member 304 |
| 15 | int | tangentialAcceleration | slot 540 `setTangentialAccel` | member 292; editor "AccelTan" |
| 16 | int | tangentialAccelVariance | slot 548 `setTangentialAccelVar` | member 296 |
| 17 | int | startParticleSize | slot 640 `setStartSize` | member 468 |
| 18 | int | startParticleSizeVariance | slot 648 `setStartSizeVar` | member 472 |
| 19 | int | rotationStart | slot 704 `setStartSpin` | member 548; editor "StartSpin" |
| 20 | int | rotationStartVariance | slot 712 `setStartSpinVar` | member 552 |
| 21 | float | startColorRed | slot 672 `setStartColor`, `.r` | colour block starts at member 484 |
| 22 | float | startColorVarianceRed | slot 680 `setStartColorVar`, `.r` | variance block at member 500 |
| 23 | float | startColorGreen | slot 672, `.g` | |
| 24 | float | startColorVarianceGreen | slot 680, `.g` | |
| 25 | float | startColorBlue | slot 672, `.b` | |
| 26 | float | startColorVarianceBlue | slot 680, `.b` | |
| 27 | float | startColorAlpha | slot 672, `.a` | |
| 28 | float | startColorVarianceAlpha | slot 680, `.a` | |
| 29 | int | finishParticleSize | slot 656 `setEndSize` | member 476. ~~`-1` is cocos2d's "end size equals start size" sentinel, paired with token 64~~ — **WRONG, see "Checked against the levels" below.** GD's `initParticle` has no `-1` test at all. Token 64 (byte 457) switches this token between *absolute end size* (flag clear) and *a delta added to the start size* (flag set), which is why negative values other than `-1` occur |
| 30 | int | finishParticleSizeVariance | slot 664 `setEndSizeVar` | member 480 |
| 31 | int | rotationEnd | slot 720 `setEndSpin` | member 556; editor "EndSpin" |
| 32 | int | rotationEndVariance | slot 728 `setEndSpinVar` | member 560 |
| 33 | float | finishColorRed | slot 688 `setEndColor`, `.r` | colour block at member 516 |
| 34 | float | finishColorVarianceRed | slot 696 `setEndColorVar`, `.r` | variance block at member 532 |
| 35 | float | finishColorGreen | slot 688, `.g` | |
| 36 | float | finishColorVarianceGreen | slot 696, `.g` | |
| 37 | float | finishColorBlue | slot 688, `.b` | |
| 38 | float | finishColorVarianceBlue | slot 696, `.b` | |
| 39 | float | finishColorAlpha | slot 688, `.a` | |
| 40 | float | finishColorVarianceAlpha | slot 696, `.a` | |
| 41 | float | fade in | sys+408 | GD-only, no cocos2d setter. Editor "Fade in" |
| 42 | float | fade in variance | sys+412 | editor "+-" |
| 43 | float | fade out | sys+416 | editor "Fade out" |
| 44 | float | fade out variance | sys+420 | editor "+-" |
| 45 | int | maxRadius | slot 580 `setStartRadius` | member 312; editor "StartRad". Radius mode only |
| 46 | int | maxRadiusVariance | slot 588 `setStartRadiusVar` | member 316 |
| 47 | int | minRadius | slot 596 `setEndRadius` | member 320; editor "EndRad". ~~Paired with token 65~~ — token 65 (byte 458) is the absolute/relative switch for this token, the same shape as 64 for size and 54 for spin; no `-1` sentinel. Never exercised: token 47 is 0..90 and token 65 is 0 in all 1000 official placements |
| 48 | int | endRadiusVariance | slot 604 `setEndRadiusVar` | member 324. No plist key — `initWithDictionary` hard-zeroes this member; GD exposes it as a slider. **It is read at runtime**: `initParticle` loads member 324 in the radius branch (gd-ida-decomp.cpp:845042), and 71 of 1000 official placements set it |
| 49 | int | rotatePerSecond | slot 612 `setRotatePerSecond` | member 328; editor "RotSec", shown negated like the angle |
| 50 | int | rotatePerSecondVariance | slot 620 `setRotatePerSecondVar` | member 332 |
| 51 | int | emitterType | slot 792 `setEmitterMode` | member 596; 0 = Gravity, 1 = Radius |
| 52 | int | positionType | slot 776 `setPositionType` | member 588; 0 = Free, 1 = Relative, 2 = Grouped |
| 53 | bool | blend additive | slot 632 `setBlendAdditive` | editor "Additive". Stands in for the plist's blendFuncSource/blendFuncDestination pair (members 576/580) |
| 54 | bool | startSpinEqualToEnd | sys+456 | editor "Start Spin\n= End" (handler `onToggleStartSpinEqualToEnd`, enum 59). The name is the button's, not the behaviour's: `initParticle` branches on `!byte 456` right after loading endSpin/endSpinVar (members 556/560), i.e. it switches tokens 31/32 between absolute and relative, same as 64 does for size |
| 55 | bool | rotationIsDir | slot 572 `setRotationIsDir` | member 308; editor "Start rot is dir" |
| 56 | bool | dynamic rotation | sys+459 | GD-only; editor "Dynamic rotation" |
| 57 | int | texture index | sys+724 (word) | Also expanded to the sprite frame name `particle_%02d_001.png` in struct field 66 (byte 264) |
| 58 | bool | uniform object color | sys+644 | GD-only; editor "Uniform obj color". When set, colour edits are mirrored into members 612–640 |
| 59 | float | FrictionP | sys+424 | GD-only |
| 60 | float | FrictionP variance | sys+428 | editor "+-" |
| 61 | float | Respawn | sys+448 | GD-only |
| 62 | float | Respawn variance | sys+452 | editor "+-" |
| 63 | bool | order sensitive | sys+460 | GD-only; editor "Order Sensitive". Optional — absent means false |
| 64 | bool | startSizeEqualToEnd | sys+457 | editor "Start Size\n= End" (handler `onToggleStartSizeEqualToEnd`, enum 65). Optional. **Behaviour, not the label:** set → token 29 is a size *delta* added to the start size and clamped so the final size is ≥ 0; clear → token 29 is the absolute end size, clamped to ≥ 0, and the delta is `end − start` (gd-ida-decomp.cpp:844958-844974) |
| 65 | bool | startRadiusEqualToEnd | sys+458 | editor "Start Rad\n= End" (handler `onToggleStartRadiusEqualToEnd`, enum 66). Optional. Same absolute/relative switch for tokens 47/48 (gd-ida-decomp.cpp:845038-845046) |
| 66 | bool | startRGBVarSync | sys+461 | editor "StartRGB Var Sync". Optional |
| 67 | bool | endRGBVarSync | sys+462 | editor "EndRGB Var Sync". Optional |
| 68 | float | FrictionS | sys+432 | GD-only. Optional, defaults to 0 |
| 69 | float | FrictionS variance | sys+436 | Optional, defaults to 0 |
| 70 | float | FrictionR | sys+440 | GD-only. Optional, defaults to 0 |
| 71 | float | FrictionR variance | sys+444 | Optional, defaults to 0 |

## certain

- **Every index 0–71 is named; none are UNKNOWN.** *(Conclusion survives; the stated route does
  not — see the correction at the top.)* Token → struct dword index is exact in
  `particleStringToStruct`: indices 0–52 land at `a2 + 4*i`, 53–56 are bytes 212–215, 57 is dword
  216 (plus the frame-name string at 264), 58 is byte 220, 59–62 are dwords 224–236, 63–67 are
  bytes 240–244, 68–71 are floats 248–260. `particleFromStruct` then reads exactly those in order.
  For the 59 numeric tokens the name comes from `titleForParticleValue` via the enum; for tokens
  51–58 and 63–67 it comes from the popup's handler symbols, because `titleForParticleValue`
  returns `"None"` and `valueForParticleValue` has no case for enums 56–68.
  <sub>GameToolbox::particleStringToStruct, gd-ida-decomp.cpp:44861-45137</sub>
  <sub>GameToolbox::particleFromStruct, gd-ida-decomp.cpp:43926-44069</sub>
  <sub>CreateParticlePopup::valueForParticleValue, gd-ida-decomp.cpp:627459-627649</sub>
  <sub>CreateParticlePopup::updateParticleValueForType, gd-ida-decomp.cpp:627714-628129</sub>
  <sub>toggle handlers, gd-ida-decomp.cpp:628144, 628168, 628193, 628218, 628243, 628269, 628292, 628315, 628338, 628361, 628408, 628469, 629604</sub>

- **The getter/setter pairing is real, but only over enums 1–55 and 69–72.** `valueForParticleValue`
  reads slot *N*−4 wherever `updateParticleValueForType` writes slot *N*, for all 33 paired slots
  (456/452, 480/476, 488/484, 736/732, 496/492, 504/500, 524/520, 532/528, 472/468, 516/512,
  556/552, 564/560, 540/536, 548/544, 640/636, 648/644, 656/652, 664/660, 704/700, 712/708,
  720/716, 728/724, 672/668, 680/676, 688/684, 696/692, 580/576, 588/584, 596/592, 604/600,
  612/608, 620/616). It is *not* observed for enums 56–68: `valueForParticleValue` falls through to
  `result = 0.0` for every one of them, so thirteen tokens have no getter in that function at all.
  <sub>CreateParticlePopup::valueForParticleValue, gd-ida-decomp.cpp:627459-627649</sub>

- **The int/float split is confirmed twice over.** `particleStringToStruct` uses `atoi` for 0, 4–20,
  29–32, 45–58 and 63–67, and `atof` for 1–3, 21–28, 33–44, 59–62 and 68–71. The editor's
  `particleValueIsInt` returns true for exactly enum 1, enums 5–25 and enums 50–55 (`if (a2 <= 0x19)
  return a2 >= 5 || a2 == 1; return a2 - 50 <= 5;`), which map to
  tokens 0, 4–20, 29–32 and 45–50 — the same set, minus the booleans and the two mode enums that
  never go through a numeric input field *(and minus token 57, the texture index — it is `atoi`'d
  like the rest but reaches the system through the texture picker, `onSelectParticleTexture`/enum
  63, not a numeric field. The original sentence's enumeration missed it)*.
  <sub>GameToolbox::particleStringToStruct, gd-ida-decomp.cpp:44950-45132</sub>
  <sub>CreateParticlePopup::particleValueIsInt, gd-ida-decomp.cpp:628603-628610</sub>

- **The plist bridge.** `CCParticleSystem::initWithDictionary` parses `"angle"` into member 400,
  `"angleVariance"` into 404, `"duration"` into 372, `"particleLifespan"`/`"…Variance"` into
  392/396, `"startColorRed"`… into the block at 484, `"startColorVarianceRed"`… into 500,
  `"finishColor…"` into 516/532, `"startParticleSize"`/`"…Variance"` into 468/472,
  `"finishParticleSize"`/`"…Variance"` into 476/480, `"sourcePositionVariancex/y"` into 384/388,
  `"rotationStart"`/`"rotationStartVariance"`/`"rotationEnd"`/`"rotationEndVariance"` into 548–560,
  `"emitterType"` into 596, `"maxRadius"`/`"maxRadiusVariance"`/`"minRadius"` into 312/316/320
  (with 324 forced to 0), `"rotatePerSecond"`/`"…Variance"` into 328/332,
  `"gravityx"`/`"gravityy"` into 276/280, `"speed"`/`"speedVariance"` into 284/288,
  `"radialAcceleration"`/`"radialAccelVariance"` into 300/304,
  `"tangentialAcceleration"`/`"tangentialAccelVariance"` into 292/296, and `"rotationIsDir"` into
  the byte at 308. Each of those offsets is the offset the correspondingly named setter writes.
  *(Re-checked key by key against the decompile: every offset above is right. The named setter
  bodies confirm them independently — `setTotalParticles`→568, `setDuration`→372, `setLife`→392,
  `setLifeVar`→396, `setEmissionRate`→564, `setAngle`→400, `setAngleVar`→404, `setSpeed`→284,
  `setSpeedVar`→288, `setPosVar`→384, `setGravity`→276, `setRadialAccel`→300, `…Var`→304,
  `setTangentialAccel`→292, `…Var`→296, `setStartSize`→468, `…Var`→472, `setEndSize`→476,
  `…Var`→480, `setStartSpin`→548, `…Var`→552, `setEndSpin`→556, `…Var`→560, `setStartColor`→484,
  `…Var`→500, `setEndColor`→516, `…Var`→532, `setStartRadius`→312, `…Var`→316, `setEndRadius`→320,
  `…Var`→324, `setRotatePerSecond`→328, `…Var`→332, `setEmitterMode`→596, `setPositionType`→588,
  `setRotationIsDir`→byte 308, `setOpacityModifyRGB`→byte 584, `setBlendAdditive`→576/580. And
  `initParticle` reads modeA 284–308 only inside the gravity branch and modeB 312–332 only inside
  the radius branch, which closes the loop on the two blocks.)*
  <sub>cocos2d::CCParticleSystem::initWithDictionary, gd-ida-decomp.cpp:845914-846444</sub>
  <sub>setter bodies, gd-ida-decomp.cpp:842266-844290</sub>
  <sub>cocos2d::CCParticleSystem::initParticle, gd-ida-decomp.cpp:844618-845110</sub>

- **Tokens 7 and 8 are speed and speed variance.** *(Demoted in part — the token-level claim is
  certain, the function-name claim is not; see "Not established: slot → setter name".)* Token 7 →
  slot 524 → enum 8 → `titleForParticleValue` "Speed"; token 8 → slot 532 → enum 9 → "+-". The
  behavioural argument below is sound and agrees, but it identifies a *slot pair*, not a symbol.
  <sub>CreateParticlePopup::titleForParticleValue, gd-ida-decomp.cpp:627250-627444</sub>

- **There is no texture-name token.** Token 57 is `atoi`'d into struct byte 216, then
  `CCString::createWithFormat("particle_%02d_001.png", …)` builds the frame name into the struct's
  string at byte 264. `particleFromStruct` passes that string (`a1[66]`) to
  `CCSpriteFrameCache::spriteFrameByName` and separately stores the raw index as a word at system
  offset 724, which is what the editor's texture picker (enum 63) writes.
  *(Holds up hard against the levels: across 1000 official placements not one of the 63,000+
  tokens is non-numeric, and all 27 distinct values of token 57 resolve to a real
  `particle_NN_001.png` frame in `GJ_ParticleSheet.plist`, which runs 0–212. `%02d` is a minimum
  width, so indices ≥ 100 print three digits and still match.)*
  <sub>GameToolbox::particleStringToStruct, gd-ida-decomp.cpp:45082-45086</sub>
  <sub>GameToolbox::particleFromStruct, gd-ida-decomp.cpp:44043-44050</sub>

- **A complete string is 72 tokens; a parsable one is at least 63.** The whole body is guarded by
  `if (v5 > 62)`, so 62 or fewer tokens parse to nothing. Tokens 63–67 are each gated on the count
  reaching them and fall back to `false`; tokens 68–71 fall back to `0.0f`. Everything up to and
  including token 62 is mandatory.
  *(Confirmed, and the levels only ever use the two endpoints: of 1000 official placements, 151
  strings have exactly 63 tokens and 849 have exactly 72 — no intermediate length occurs, so the
  per-token gating is never exercised by shipped data. Note the guard on token 63 is written
  `v5 != 63`, not `v5 > 63`; identical given the outer `v5 > 62`, but a port that copies the
  expression literally must keep the outer guard too.)*
  <sub>GameToolbox::particleStringToStruct, gd-ida-decomp.cpp:44948-45132</sub>

- **Sanity checks against the Dash example all pass.** `10a0.51a1a0.3a115a90a0a451a227a70a…` gives
  maxParticles 10, duration 0.51, lifespan 1 ± 0.3, emission 115, angle 90, speed 451 ± 227,
  posVar.x 70; tokens 17–20 are 20, 7, 0, 0 (start size 20 ± 7, no spin); tokens 21–28 are
  1, 0, 0.933333, 0, 0, 0, 1, 0 — an opaque orange start colour with zero variance, read as
  R, Rvar, G, Gvar, B, Bvar, A, Avar; token 29 is `-1`, ~~cocos2d's "end size = start size"
  sentinel~~.
  *(Token-for-token re-read out of level 22 and all of it matches — the interleaved colour reading
  in particular is corroborated by the whole corpus, where the "var" slots 22/24/26 span 0..0.1,
  0..0.5 and 0..0 while the value slots 21/23/25 all span 0..1. Two nits: `1, 0.933333, 0` is
  yellow, not orange; and the `-1` **is not a sentinel** — this is one of only two 63-token
  strings where token 64 does not exist, so `initParticle` takes the `byte 457 == 0` branch,
  clamps the end size to 0 and the particle shrinks away. Reading it as "end size = start size"
  draws the wrong picture.)*

- **Two mode flags gate two blocks of the table.** `CreateParticlePopup::toggleGravityMode` enables
  editor enums 8–17 (tokens 7–16: speed, posVar, gravity, radial and tangential accel) when
  `getEmitterMode()` is 0, and enums 50–55 (tokens 45–50: the radius block) when it is 1. So token
  51 selects which of those two groups is live.
  *(Confirmed twice more. `onEmitterMode` computes `__clz(getEmitterMode()) >> 5`, which is 1 only
  when the mode is 0, and passes that to `toggleGravityMode`; it also toggles the "Gravity" button
  on mode 0 and "Radius" on mode 1, matching the label order in the popup's init. And
  `initParticle` reads members 284–308 only in the gravity branch and 312–332 only in the radius
  branch. **But do not infer the mode from the data:** all 86 radius-mode placements still carry a
  nonzero token 7 and token 9, because the editor keeps the values behind a disabled control. Read
  token 51 and nothing else.)*
  <sub>CreateParticlePopup::toggleGravityMode, gd-ida-decomp.cpp:629412-629487</sub>
  <sub>CreateParticlePopup::onEmitterMode, gd-ida-decomp.cpp:629604-629625</sub>

- **The object's opacity dims the particles; it never stops the system.** *(Added 2026-10-01.)*
  `ParticleGameObject::updateParticleOpacity` is empty, so a Custom Particles object is never
  stopped by its opacity, unlike an object's own system, which `GameObject::updateParticleOpacity`
  stops at 50 of 255 or less and resumes above it. Instead `updateMainParticleOpacity` writes the
  opacity to the system (member 726), and `updateQuadWithParticle` multiplies every particle's
  colour and alpha by it, the ones already out included. With object key 146 it also replaces the
  start alpha (member 496), so the definition's own start alpha counts for nothing. The opacity is
  the main colour's, as the byte the game keeps (whole over 249, else times 0.004), times its
  groups'; the screen-edge fade never reaches it (member 891). Whether a particle's colour is
  premultiplied (member 584) is settled by the blend the system had when it took its texture, so
  an object that switches its blending later changes the blend function and nothing else. Ported
  in `render/particles.ts`.
  <sub>ParticleGameObject::updateParticleOpacity / updateMainParticleOpacity, gd-ida-decomp.cpp:297208-297211, 297309-297327</sub>
  <sub>ParticleGameObject::customSetup, gd-ida-decomp.cpp:298428-298446</sub>
  <sub>GameObject::updateParticleOpacity, gd-ida-decomp.cpp:165124-165150</sub>
  <sub>CCParticleSystem::updateBlendFunc / setBlendAdditive, gd-ida-decomp.cpp:844213-844239, 844274-844296</sub>

## likely

- **Slot 768 is `setOpacityModifyRGB`.** The additive-blend path (editor enum 58) calls slot 632
  with the new flag and then slot 768 with a constant `1`, and `setOpacityModifyRGB` is the only
  remaining bool setter in that region of the vtable. No token maps to it, so nothing in the table
  depends on this being right.
  *("The only remaining bool setter in that region" could not be checked — there is no vtable in
  the dump. What is checkable: `setOpacityModifyRGB` does write a single byte (584), and
  `initWithDictionary` zeroes byte 584 just before loading the texture, so it is a bool setter and
  584 is its member. Citation corrected: the two calls are at 628038-628041, not 628024-628028.)*
  <sub>CreateParticlePopup::updateParticleValueForType, gd-ida-decomp.cpp:628038-628041</sub>
  <sub>cocos2d::CCParticleSystem::setOpacityModifyRGB, gd-ida-decomp.cpp:843794-843800</sub>

- **`setSpeed` is slot 524 / `setSpeedVar` is slot 532, proved without the editor.** *(Moved down
  from "certain": the behaviour is confirmed, the symbol name is not.)*
  `saveDefaults` reads slots 520 and 528 into members 668 and 672 only when the emitter is in
  gravity mode, `loadDefaults` writes them back through slots 524 and 532, and
  `loadScaledDefaults` multiplies both by the node scale — the behaviour of speed and its variance,
  and of nothing else in gravity mode. The editor independently labels the same pair "Speed"/"+-".
  *(All four cited functions read as described — `saveDefaults` guards on `!*(this+149)`, i.e.
  member 596 == 0, which is `setEmitterMode`'s member, so "gravity mode only" is exact. The
  argument still stops one step short of a name: it shows slot 524 behaves like speed, not that
  slot 524 *is* `cocos2d::CCParticleSystem::setSpeed`.)*
  <sub>cocos2d::CCParticleSystem::saveDefaults, gd-ida-decomp.cpp:845869-845898</sub>
  <sub>cocos2d::CCParticleSystem::loadDefaults, gd-ida-decomp.cpp:846585-846614</sub>
  <sub>cocos2d::CCParticleSystem::loadScaledDefaults, gd-ida-decomp.cpp:846624-846654</sub>

- **"FrictionP" is friction applied to the particle's own motion**, and 68/70 ("FrictionS",
  "FrictionR") are the size and rotation analogues. That is a reading of the three-letter suffixes
  against their editor page, not something the decompile states; all three are GD additions with no
  cocos2d setter, written straight to system offsets 424/432/440 and consumed inside GD's patched
  `CCParticleSystem::update`.
  *(One correction and one addition. They are consumed in **`initParticle`**, not `update`:
  it loads 424 and 428 (FrictionP and its variance) and 432/436/440/444 (FrictionS, FrictionR and
  their variances) per spawned particle, alongside the fade fields at 408–420. And the levels
  cannot arbitrate the meaning of the letters: tokens 68–71 are `0` in all 849 official strings
  that have them, so FrictionS and FrictionR are never exercised by shipped data. FrictionP is —
  token 59 is nonzero in 24 placements and token 60 in 177.)*
  <sub>CreateParticlePopup::titleForParticleValue, gd-ida-decomp.cpp:627250-627444</sub>
  <sub>cocos2d::CCParticleSystem::initParticle, gd-ida-decomp.cpp:844944-844951</sub>

## Not established

- **Which named `CCParticleSystem` function any vtable slot is.** *(New, from the audit.)* The
  whole "slot NNN `setFoo`" column is an inference. There is no vtable anywhere in
  `gd-ida-decomp.cpp` (no `_ZTV…CCParticleSystem…`), and each of the 48 named
  `cocos2d::CCParticleSystem::set*` / 43 `get*` symbols appears exactly once — as its own
  definition, never as a call site. So nothing in the binary equates, say, slot 640 with
  `setStartSize`. What *is* established is the part a port needs: token → struct index
  (`particleStringToStruct`), struct index → slot or system offset (`particleFromStruct`), slot →
  editor enum (`updateParticleValueForType`), enum → label (`titleForParticleValue`) or handler
  symbol. The names in the column come from the N/N−4 get/set regularity plus cocos2d-x
  declaration order, which agree but are not proof. Treat "member NNN" as solid (each named
  setter's one-line body was re-read) and "slot NNN `setFoo`" as a label of convenience.

- **What slots 508 and 624 are.** Both are single unpaired virtuals that break the get/set phase of
  the vtable — 508 sits between `setAngleVar` (504) and `setGravity` (516), 624 between
  `setRotatePerSecondVar` (620) and `setBlendAdditive` (632). `initWithDictionary` calls slot 508
  with no arguments right after parsing the lifespan keys and just before `saveDefaults`. Neither
  is reachable from any string token.
  <sub>cocos2d::CCParticleSystem::initWithDictionary, gd-ida-decomp.cpp:846329-846338</sub>

- **The semantics of tokens 41–44, 59–62 and 68–71 beyond their editor labels.** Fade in/out,
  Respawn and the three frictions are GD inventions stored directly on the particle system at
  offsets 408–452, and none of them appear in `initWithDictionary`, so there is no plist key to
  match them against. The names in the table are the editor's own labels, verbatim.
  *(Still not established, and the levels cannot help — but they are all read per particle:
  `initParticle` loads 408/412/416/420, 424/428 and 432/436/440/444. Respawn (448/452) is the one
  block `initParticle` does not touch, so where it is consumed is unknown.)*
  *(Resolved 2026-09-29, and ported in `render/particles.ts`. Fades: `initParticle` holds each
  inside what is left of the life (0 when it or the room is 0 or less), and
  `updateQuadWithParticle` scales the quad by `age/fadeIn`, then `lifeLeft/fadeOut` — the alpha
  alone for a normal particle, colour and alpha for an additive one. Frictions P, S and R take
  that share per second of the speed (members 108/112), the size change (52) and the spin (60),
  after the move. 56 zeroes the spin and keeps turning the particle toward its motion at 10× the
  gap per second (all at once in its first 0.1 s in radius mode). 58 runs every particle on one
  ramp, members 612-636, by age/life. 63 keeps order on removal, normal blend only. 66/67 move
  g and b by red's random amount. Respawn is read by `ParticleGameObject::updateSyncedAnimation`,
  from `PlayLayer::updateVisibility` with the layer clock (+792): `claimParticle` stops an emitter
  with a duration of 0 or more as it comes on screen, and it starts again `respawn` (± its
  variance, at least 0) seconds later, then every duration + life + lifeVar + respawn; with
  object key 123 it waits for an Animate trigger instead.)*
  <sub>CreateParticlePopup::valueForParticleValue, gd-ida-decomp.cpp:627601-627649</sub>
  <sub>cocos2d::CCParticleSystem::initParticle, gd-ida-decomp.cpp:844618-845110</sub>
  <sub>cocos2d::CCParticleSystem::update, gd-ida-decomp.cpp:845383-845834</sub>
  <sub>CCParticleSystemQuad::updateQuadWithParticle, gd-ida-decomp.cpp:848040-848063</sub>
  <sub>ParticleGameObject::claimParticle / updateSyncedAnimation, gd-ida-decomp.cpp:306373-306379, 301799-301846</sub>

- **~~Whether the "+-" for token 48 does anything at runtime.~~ Resolved: it does.**
  `setEndRadiusVar` writes member 324,
  which cocos2d's own plist loader explicitly sets to zero and which no code in the decompile was
  observed to read back. GD gives it a slider and a string slot regardless.
  *(The read was missed: `initParticle` loads member 324 at gd-ida-decomp.cpp:845042, inside the
  radius branch, right after 312/316/320 — so end-radius variance is applied per particle. 71 of
  1000 official placements set token 48 nonzero, up to 10. Only `initWithDictionary` ignores it,
  because there is no plist key for it.)*
  <sub>cocos2d::CCParticleSystem::initWithDictionary, gd-ida-decomp.cpp:846277-846281</sub>
  <sub>cocos2d::CCParticleSystem::initParticle, gd-ida-decomp.cpp:845038-845046</sub>

- **Four editor toggles are not in this string.** "Animate on Trigger", "Animate Active Only",
  "Quick Start" and "Use obj color" write to the popup and to `ParticleGameObject` (e.g. byte 669
  on the object), never to the `ParticleStruct`. They must be stored as separate object properties
  in the level string, and that mapping was not investigated here.
  *(Holds. None of those four handlers calls `updateParticleValueForType`, so none of them owns a
  `gjParticleValue`; the labels exist as `"Animate\non Trigger"`, `"Animate\nActive Only"`,
  `"Quick\nStart"` and `"Use\nobj color"`. Related, for whoever picks this up: `ParticleGameObject`
  keeps the raw property-145 string at `obj+1260` with a dirty flag at `obj+1264`, and
  `updateParticleStruct` parses it into the `ParticleStruct` at `obj+1268` — so the level-file
  **key** 145 and the object **byte offset** 1260 are different things and must not be mixed.)*
  *(Partly settled 2026-09-29: `ParticleGameObject::customObjectSetup` reads key 146 into +669
  ("Use obj color": the object's main and detail colours become the start and end rgb) and key
  147 into +1536 (the uniform ramp token 58 runs), IDA:305981-306012, applied by
  `applyParticleSettings` IDA:306240-306299. "Animate on Trigger" is key 123 (+1229, IDA:181814-181818).)*
  <sub>ParticleGameObject::updateParticleStruct, gd-ida-decomp.cpp:305925-305941</sub>
  <sub>CreateParticlePopup::onAnimateOnTrigger, gd-ida-decomp.cpp:626818-626852</sub>
  <sub>CreateParticlePopup::onDynamicColor, gd-ida-decomp.cpp:626209-626255</sub>

## Checked against the levels

Every object with id 2065 in levels 22 and 5001–5004, property 145 split on `"a"`. This is the
check that matters: the port decodes these 1,000 strings with the table above, and a misaligned
index produces a silently wrong picture rather than an error.

**Corpus.** 1000 placements — level 22: 427, 5001: 104, 5002: 66, 5003: 199, 5004: 204. All 1000
carry property 145; none is missing or empty.

**Field count is not fixed, but it is bimodal.** 151 strings have exactly 63 tokens (level 22: 136,
level 5002: 15), 849 have exactly 72. No other length occurs. That is exactly what
`particleStringToStruct` allows, so the table is not invalidated — but a decoder must handle 63 and
must not index past `length`.

**Type claims.** Of the 63,000+ tokens, **zero** are non-numeric. Every index the table calls an
`int` is integral in all 1000 strings — no exceptions. Every index the table calls a `bool` holds
only `0` or `1`. Token 51 (emitterType) is only ever `0` (914) or `1` (86). Token 52 (positionType)
is only ever `1` or `2` — `0` (Free) never ships.

**Colours.** All sixteen colour components (21–28, 33–40) are within 0..1 in all 1000 strings. The
interleaving in the table is corroborated by the corpus, not just the decompile: the value channels
21/23/25 each span the full 0..1, while the variance channels 22/24/26 span 0..0.1, 0..0.5 and
0..0 — if the layout were value-block-then-variance-block, token 22 would look like a green
channel and span 0..1. It does not.

**Texture.** No token anywhere is a string, so the "there is no texture-name token" claim holds
against the data as well as the code. Token 57 is integral, 0..209, 27 distinct values, and every
one resolves to a real frame in `GJ_ParticleSheet.plist` (which runs `particle_00_001.png` to
`particle_212_001.png`). None of the `textureFileName` values in `particles.json` (`sun.png` and
friends) appears in any level string — those 51 effects are a separate, Particle-Designer-style
asset path and share no token with the trigger format.

**Range comparison against the 51 effects in `particles.json`.** 46 of the table's names also
exist as plist keys. 26 table names have no plist key (4, 41–44, 48, 52–71) and 5 plist keys have
no table index (`blendFuncSource`, `blendFuncDestination`, `sourcePositionx`, `sourcePositiony`,
`textureFileName`) — all of which the table already predicts. Of the 46 shared names, none shows
the signature of a misaligned index. Nine were flagged by a naive order-of-magnitude test but all
nine are an artefact of one side being degenerate (all-zero), not a disagreement:

| field | levels | particles.json | reading |
|---|---|---|---|
| 13 radialAcceleration | 0..0 | −1200..100 | levels never use it; ratio is ∞ only because the level side is all zero |
| 14 radialAccelVariance | 0..6 | 0..0 | plist side all zero |
| 15 tangentialAcceleration | 0..0 | −144.74..0 | level side all zero |
| 16 tangentialAccelVariance | 0..68 | 0..957.03 | both non-degenerate; ratio 14. Same sign, same kind of magnitude, one plist effect is an outlier — not a misalignment |
| 19 rotationStart | 0..360 | 0..0 | plist side all zero; 0..360 is exactly right for a start angle |
| 26 startColorVarianceBlue | 0..0 | 0..0.25 | level side all zero |
| 36 finishColorVarianceGreen | 0..0 | 0..0.5 | level side all zero |
| 38 finishColorVarianceBlue | 0..0 | 0..0.2 | level side all zero |
| 40 finishColorVarianceAlpha | 0..0.49 | 0..0 | plist side all zero |
| 49 rotatePerSecond | 0..0 | 0..360 | level side all zero (tokens 49 and 50 are `0` in all 1000) |

Every other shared field agrees within a factor of 10, and the tight ones are the informative ones:
speed 0..1000 vs 0..1000, rotationStartVariance 0..360 vs 0..360, all eight colour value channels
0..1 vs 0..1, emitterType 0..1 vs 0..1, sourcePositionVariancey 0..150 vs 0..160.

**What the data refuted.** Token 29 was described as using cocos2d's `-1` "end size = start size"
sentinel, paired with token 64. Neither holds:

- Token 29 is `-1` in only 2 of 1000 placements, and both are 63-token strings where token 64 does
  not exist.
- Token 29 takes other negative values — `-50, -10, -5, -2` — which a `-1`-only sentinel cannot
  explain.
- Among the 849 strings that have token 64: all 14 with a negative token 29 have token 64 **set**,
  and every one of the 555 with token 64 clear has token 29 ≥ 0. Token 64 set → token 29 ∈
  {−50, −10, −5, −2, 0, 1, 4}; clear → {0, 1, 2, 3, 4, 5, 6, 10, 12, 20, 28, 44}.
- 294 placements set token 64 while token 29 is not `-1`, and none has both.

This matches `initParticle` exactly: byte 457 switches token 29 between a signed delta on the start
size and an absolute end size. GD's `initParticle` contains no `-1` comparison at all.

**Other measurements worth keeping.**

- Token 1 (duration) is `-1` (forever) in 849 of 1000.
- Token 4 (emission) is `-1` ("max") in 111 of 1000; range otherwise 0..150.
- Token 0 (maxParticles) 1..84.
- Token 47 (minRadius) 0..90, never negative; token 65 is `0` in all 849.
- Token 63 (order sensitive) is `0` in all 849; tokens 68–71 are `0` in all 849. Those four names
  and that one are unexercised by official data.
- Tokens 41/43 (fade in/out) are nonzero in 531 and 905 placements — the most-used GD-only fields.
- In the 86 radius-mode placements, tokens 7 and 9 are nonzero in all 86. Mode must be read from
  token 51, never inferred from which block is zero.
