# Area triggers, read out of the 2.206 decompile

The area triggers are a five-list system on `GJBaseGameLayer`, one `std::vector<EnterEffectInstance>`
per effect kind (move 0 at `layer+1240`, rotate 1 at `+1252`, scale/transform 2 at `+1264`,
fade 3 at `+1276`, tint 4 at `+1288`). Triggering 3006–3010 does not apply anything; it pushes a
212-byte `EnterEffectInstance` onto the matching list, and that instance is then re-evaluated from
scratch **every physics sub-step** (move/rotate/scale, via `processAreaActions`) or **once a frame**
(fade/tint, via `processAreaVisualActions`) until something removes it. Each tick the instance picks a
**centre point** (a group's main object, a player, or one of nine screen anchors), walks the objects of
**one group** — its `target_group` (key 51) — and for each object computes a scalar 0..1 from that
object's distance to the centre, eases it, and applies `payload * (1 - eased)`. So the answer to (A) is
*a group, plus a cheap section-index box used only as a spatial pre-filter*; the answer to (B) is
`v = clamp01(((dist * modFrontOrBack) / (length + length_pm*rand) - deadzone) / (1 - deadzone))`,
optionally inverted, then `strength = 1 - ease(v)`. Flowvix's key list is **correct in every entry I
could check**, and the second number of each pair is a **±variance multiplied by a per-object random
float in [-1,1]** drawn from a 2000-entry table on the layer and indexed by a random `uint16` baked
into each `GameObject` at creation. All motion is applied through an accumulate-and-undo scheme: an
object touched by an area effect stores the accumulated delta in dedicated fields, and every tick those
deltas are subtracted back out before the effects re-apply, which is why area effects are continuous
"fields" rather than one-shot commands. 3024 Area Stop erases instances by **Area Effect ID (key 225)**,
and 3011–3015 Edit Area retarget a *running* instance and tween its stored values over key 10 seconds,
using −99 as the "leave this one alone" sentinel for every field.

Conventions match `trigger-semantics.md`: float constants are decoded, level-file property keys are
written as "key N", struct offsets as `obj+N` / `inst+N`. Every cited range was read before being
written down.

---

## certain

### A — which objects are affected

- **An area trigger affects exactly one group: `target_group`, level key 51, stored at `obj+1276`. There is no radius-based object search; the radius only ever produces an integer section-index box that acts as a pre-filter on top of the group.**

  ```
  inst+172 = key 51 (target group)          // copied in the instance ctor from obj+1276
  per tick:  group = layer.getGroup(inst+172)      // when inst+192 == 0
  ```

  <sub>GJBaseGameLayer::processAreaEffects, gd-ida-decomp.cpp:469183-469189; EnterEffectObject::customObjectSetup, 300101-300104; EnterEffectInstance::EnterEffectInstance, 441838-441872</sub>

- **Key 226, if present and non-zero, overrides key 51 as the target group; key 342 overrides key 71 when positive and key 538 when negative. Both are applied at the end of the parse, after 51/71/538 have been read.**

  ```
  if (key226) { v = atoi(key226); if (v) obj+1276 = v; }
  if (key342) { v = atoi(key342); if (v) { if (v >= 0) obj+1280 = v; else obj+1352 = v; } }
  ```

  <sub>EnterEffectObject::customObjectSetup, gd-ida-decomp.cpp:300240-300259</sub>

- **The per-object test in move/rotate/scale is `object.isActive || (sectionX in [a5,a6] && sectionY in [a7,a8])`, where sectionX/sectionY are integers cached on the GameObject at `obj+528` / `obj+532`. Fade and tint get no box at all — their only test is `object.isActive`.**

  ```
  // move (identical shape in rotate and scale)
  if (obj[657])                       goto PROCESS;      // 657 = "activated" flag
  if (obj[528] <= a6 && obj[528] >= a5 &&
      obj[532] <= a8 && obj[532] >= a7) goto PROCESS;
  continue;
  ```

  <sub>processAreaMoveGroupAction, gd-ida-decomp.cpp:**437601-437608** (the file previously cited 437588-437596, which is the loop *setup*, not the test — the test is 13 lines later and reads `*((_DWORD *)v20 + 132)` / `+ 133`, i.e. dword indices, = obj+528 / obj+532); processAreaRotateGroupAction, 437412-437420; processAreaTransformGroupAction, 437132-437136; processAreaFadeGroupAction, 427010; processAreaTintGroupAction, 427188 and 427313; `obj+657` set by **GameObject::activateObject, 169451-169463** and zeroed in GameObject::init at 165538 / commonSetup at 166735 (the file previously cited 165172-165176, which is `EnhancedGameObject::deactivateObject` — that range only *reads* the byte)</sub>

- **`obj+528` / `obj+532` are the object's section indices, written by `addToSection` as `(int)(x * layer+11448)` and `(int)(y * layer+11452)`, i.e. world coordinate times the reciprocal section size.**

  ```
  sx = (x > 0) ? (int)(x * layer[11448]) : 0
  sy = (y > 0) ? (int)(y * layer[11452]) : 0
  obj+528 = sx ; obj+532 = sy
  ```

  <sub>GJBaseGameLayer::addToSection, gd-ida-decomp.cpp:444745-444767 and 444815-444816</sub>

- **The box is computed from a conservative reach radius `r = (float)(int)(key222 + key223 + key220 + key221) / min(|key263|, |key264|)`, converted to section indices around the (un-offset) centre. `key222+key223` is the falloff length plus its variance and `key220+key221` the centre offset plus its variance, so `r` is the furthest any object can be and still score below 1. The integer part is also cached on the trigger object at `obj+1856`.**

  ```
  total = inst+24 + inst+28 + inst+32 + inst+36      // keys 222,223,220,221 as floats
  m     = min(fabsf(inst+48), fabsf(inst+52))        // keys 263, 264
  r     = (float)(int)total * (1.0 / m)
  obj+1856 = (int)total
  loX = (cx - r > 0) ? (int)((cx - r) * layer[11448]) : 0
  hiX = (cx + r > 0) ? (int)((cx + r) * layer[11448]) : 0
  loY = (cy - r > 0) ? (int)((cy - r) * layer[11452]) : 0
  hiY = (cy + r > 0) ? (int)((cy + r) * layer[11452]) : 0
  UNBOUND_X = (int)(layer[11448] * 1000000000.0)     // used as "+infinity"
  UNBOUND_Y = (int)(layer[11452] * 1000000000.0)
  ```

  <sub>GJBaseGameLayer::processAreaEffects, gd-ida-decomp.cpp:469046-469101</sub>

- **Which of the four bounds is actually used depends on key 262 (axis mode), key 276 (invert) and key 283 (two-sided). In radial mode the full box is used; in axis mode the cross-axis is left unbounded and the near-side bound is dropped unless key 283 is set; when key 276 (invert) is on the region is opened up to the whole level, because an inverted falloff affects everything outside the radius too.**

  ```
  xlo, xhi, ylo, yhi = loX, UNBOUND_X, loY, UNBOUND_Y      // defaults

  key262 == 0 (radial):
      if (!key276)   { xhi = hiX; yhi = hiY }               // full box
      else           { xlo = 0; ylo = 0 }                   // whole level

  key262 == 1 (X axis):
      ylo = key283                                          // 0 or 1 -> effectively 0
      if (key276) { if (key283) { xlo = 0; ylo = 0 } }       // else keep xlo=loX, both hi unbound
      else { xhi = hiX; if (!key283) xlo = 0; else ylo = 0 } // key283 keeps the near bound loX

  key262 == 2 (Y axis):
      xlo = key283
      if (key276) { if (key283) { xlo = 0; ylo = 0 } }
      else { yhi = hiY; if (key283) xlo = 0; else { ylo = 0; xlo = 0 } }
  ```

  <sub>GJBaseGameLayer::processAreaEffects, gd-ida-decomp.cpp:469102-469145</sub>

- **The centre is chosen from `obj+1352` (key 538, or key 342 when negative) if non-zero, otherwise from `center_group` key 71 (`inst+176`). A non-negative value names a group whose main object supplies the point; negative values are special anchors.**

  ```
  c = obj+1352 ; if (!c) c = inst+176
  c >= 0 : mainObj = tryGetMainObject(c); centre = mainObj.getRealPosition(); delta = pos - lastPos
  c == -1: centre = player1.getPosition()
  c == -2: centre = (layer+870 ? player2 : player1).getPosition()
  c <= -3: w = winSize.width / layer[328] ; h = winSize.height / layer[328]
           -4 (0,0)  -5 (0,h/2)  -6 (0,h)  -7 (w/2,0)  -8 (w/2,h)
           -9 (w,0) -10 (w,h/2) -11 (w,h)  default (w/2,h/2)
           centre = layer+852 + anchor ; delta = (layer+852) - (layer+1028)
  ```

  <sub>GJBaseGameLayer::processAreaEffects, gd-ida-decomp.cpp:468953-469044</sub>

- **The centre is then shifted by `offset` (key 220) on X and `offset_y` (key 252) on Y, and in axis mode (key 262 != 0) `offset_y`/`offset_y_pm` are force-overwritten with `offset`/`offset_pm` first. The shift happens *after* the section box was computed, which is why the box radius includes the offset terms.**

  ```
  v43 = inst+32                              // key 220
  if (obj+1764 /* key 262 */) { inst+40 = v43 ; inst+44 = inst+36 }   // 252:=220, 253:=221
  centre.x += v43 ; centre.y += inst+40
  if (obj+1816 /* key 283 */) inst+48 = -fabsf(inst+48)               // mod_front goes negative
  ```

  <sub>GJBaseGameLayer::processAreaEffects, gd-ida-decomp.cpp:469163-469173</sub>

- **When the target group contains objects that belong to a group parent or a sticky group, the group is pre-flattened at level load into a pair of arrays and the instance runs TWO passes over it: pass 0 = loose objects, pass 1 = one representative per sub-group, and a representative's computed delta is applied rigidly to its whole sub-group.**

  ```
  n = inst+192                       // 0 when the group has no representatives
  passes = (n <= 0) ? 1 : 2
  for (p = 0; p < passes; p++) {
      grp = (n <= 0) ? layer.getGroup(inst+172)
                     : layer[2456].objectAtIndex(n + p - 1)
      isProxy = (p & 1)              // -> a10/a11 of the group-action functions
      dispatch by area type (0..4) with grp, isProxy
  }
  // when isProxy: getTargetGroup(inst+192, obj+772) -> the whole sub-group array
  //               getTargetGroupOrigin(...)          -> its pivot object (rotate/scale)
  ```

  <sub>GJBaseGameLayer::processAreaEffects, gd-ida-decomp.cpp:469174-469250; GJBaseGameLayer::generateTargetGroups builds the quadruple (loose, representatives, group dict, origin dict) at 457876-457887; getTargetGroup/getTargetGroupOrigin, 425821-425849</sub>

### B — the falloff arithmetic

- **`getAreaObjectValue` returns the raw 0..1 distance ratio. This is the whole falloff. `key262` selects the distance metric, `key263/264` scale the front/back side independently, `key222/223` set the length, `key282` is a dead zone that rescales the remaining range, and `key276` inverts the result.**

  ```
  objPos = obj.getRealPosition()
  R      = layer.randTable                      // 2000 floats in [-1,1], see below
  i      = *(uint16*)(obj+860)                  // per-object random index, 0..1899

  switch (key262) {
    case 1:  // X axis
      d = (objPos.x - centre.x) + key221 * R[i+659]
      d = d * ((d >= 0) ? key264 : key263)
      break
    case 2:  // Y axis
      d = (objPos.y - centre.y) + key221 * R[i+659]
      d = d * ((d >= 0) ? key264 : key263)
      break
    default: // radial
      p = ( centre.x + key221 * R[i+659] ,
            centre.y + key253 * R[i+660] )
      d = ccpDistance(objPos, p)                // always >= 0, so key263 never applies
  }

  len = (float)(int)( key222 + key223 * R[i+658] )
  ratio = d / len
  if (key282 == 0) v = (ratio > 0) ? ratio : 0
  else             v = (ratio - key282) / (1 - key282), clamped to 0 below
  if (v >= 1) v = 1
  if (key276) v = 1 - v
  return v
  ```

  <sub>GJBaseGameLayer::getAreaObjectValue, gd-ida-decomp.cpp:426694-426866</sub>

- **`key263` (mod_front) only ever applies when key 283 is on, because key 283 is what makes it negative — and a negative multiplier is the only thing that stops the "behind the centre" side scoring 0 (= full effect) everywhere. With key 283 off, everything on the negative side of an axis-mode trigger gets `d < 0`, so `ratio < 0`, so `v = 0`, so full strength; that is exactly why the near-side section bound is dropped to 0 in that case.**

  ```
  key283 on : inst+48 = -|key263|  ->  d(behind) = negative * negative = positive -> symmetric falloff
  key283 off: inst+48 = +|key263|  ->  d(behind) = negative              -> v = 0  -> full strength
  ```

  <sub>GJBaseGameLayer::processAreaEffects, gd-ida-decomp.cpp:469169-469173 (`if (v44) *(float *)(v14 + 48) = -fabsf(*(float *)(v14 + 48));`); consumed at getAreaObjectValue, 426760-426764 and 426800-426804</sub>

- **The effect strength is `1 - getEasedAreaValue(v)`, i.e. 1 at the centre falling to 0 at the outer edge, and objects scoring `v >= 1` are skipped entirely before any payload work. Fade is the one exception — it uses the raw un-eased `v` as a lerp factor and does not early-out.**

  ```
  v = getAreaObjectValue(...)
  if (v >= 1.0) { if (key261) cache[idx] = 0; skip object }      // move
  strength = 1.0 - getEasedAreaValue(obj, inst, v, sideFlag, idx)
  ```

  <sub>processAreaMoveGroupAction, gd-ida-decomp.cpp:437610-437619 and 437628-437634; rotate 437434-437447; scale 437148-437170; fade (no early-out, no easing) 427021-427022</sub>

- **`key242`/`key243` are an easing type + rate that are baked, at level load, into a 101-sample lookup buffer; `getEnterEasingValue` linearly interpolates that buffer. Easing type 0 means linear (sentinel −1) and types 3, 7, 8 and 9 bypass the buffer and call `GameToolbox::getEasedValue` directly (sentinel −2). `key248`/`key249` are the second easing pair and get their own buffer.**

  ```
  getEnterEasingKey(type, rate):
      type == 0                      -> -1                      // linear
      type == 3 || 7 || 8 || 9       -> -2                      // evaluate live
      else                           -> (int)(10000*type + rate*100)

  generateEnterEasingBuffer: for i in 0..100
      buf.push( GameToolbox::getEasedValue(i/100.0, type, rate) )
      returns the base index of the 101 samples

  getEnterEasingValue(t, type, rate, base):
      base == -1 -> t
      base == -2 -> GameToolbox::getEasedValue(t, type, rate)
      else       -> k = (int)(t*100)
                    lo = tbl[base+k] ; hi = tbl[base+k+1]
                    return lo + (hi - lo) * (t - k*0.01) * 100.0

  obj+1724 = buffer base for (key242, key243)
  obj+1736 = buffer base for (key248, key249)
  ```

  <sub>GJBaseGameLayer::getEnterEasingKey, gd-ida-decomp.cpp:419136-419157; generateEnterEasingBuffer, 466412-466493; generateEnterEasingBuffers, 466508-466520; getEnterEasingValue, 419172-419195</sub>

- **`key261` turns on dual easing: the object's side of the centre picks easing pair A (242/243) or pair B (248/249), and the choice is latched with one-frame hysteresis through a per-object slot in a vector sized to the group, so an object crossing the centre does not flicker between curves. With key 261 off, pair A is always used and the side flag is ignored entirely.**

  ```
  getEasedAreaValue(obj, inst, v, side, idx):
    if (obj+1769 /* key 261 */) {
        if (v > 0.01 && v < 0.99) {
            slot = inst+196                 // vector<int>, one entry per object in the group
            c    = inst+184                 // per-frame counter, += 2 every frame
            tag  = slot[idx]
            if      (tag == c - 2) side = 0
            else if (tag == c - 1) side = 1
            slot[idx] = c + side
        }
        (type, rate, base) = side ? (obj+1716, obj+1720, obj+1724)   // keys 242/243
                                  : (obj+1728, obj+1732, obj+1736)   // keys 248/249
    } else
        (type, rate, base) = (obj+1716, obj+1720, obj+1724)
    return getEnterEasingValue(v, type, rate, base)
  ```

  <sub>GJBaseGameLayer::getEasedAreaValue, gd-ida-decomp.cpp:426878-426945; the counter is bumped in processAreaEffects at 469148 (`*(_DWORD *)(v14 + 184) += 2;`); the vector is sized in the instance ctor at 441870</sub>

- **The "plus/minus" half of every pair is a ±variance multiplied by a per-object random float in [−1, 1]. The table is 2000 floats built once in `GJBaseGameLayer::init` at `layer+2632`, each object carries an index in `[0, 1900)` written at creation, and every property reads a DIFFERENT fixed slot offset from that index, so one object's variances are fixed for its lifetime but differ per property.**

  ```
  // table, layer+2632 .. layer+10632  (2000 floats)
  state = state * M + 2531011 ; r = (state >> 16) & 0x7FFF
  value = 2*(r / 32767.0) - 1                       // written as (r/32767 + r/32767) - 1

  // per object, GameObject::commonSetup
  *(uint16*)(obj+860) = (int)( ((rand>>16 & 0x7FFF)/32767.0) * 1900.0 )

  // slot offsets, in float indices from layer dword 658 (= layer+2632)
  i+658  key223 length_pm        i+659  key221 offset_pm      i+660  key253 offset_y_pm
  i+666  key238 move_x_pm        i+667  key240 move_y_pm
  i+668  key219 move_dist_pm     i+669  key232 move_angle_pm
  i+670  key234 scale_x_pm       i+671  key236 scale_y_pm
  i+676  key271 rotation_pm
  ```

  <sub>table built in GJBaseGameLayer::init, gd-ida-decomp.cpp:462058-462068; index assigned in GameObject::commonSetup, 166724; slot uses at getAreaObjectValue 426837 / 426714-426720 / 426775-426782, processAreaMoveGroupAction 437637-437639 and 437703 and 437739, processAreaTransformGroupAction 437151-437153, processAreaRotateGroupAction 437436</sub>

### C — the per-effect payloads

- **The complete level-key table for area triggers. The parse is one block guarded by `id - 3006 <= 0x12 && ((1 << (id-3006)) & 0x6FBFF)`, i.e. IDs 3006–3015, 3017–3021, 3023, 3024 all share it.** ~~and `getSaveString` emits exactly the same set for all of them~~ — **the `getSaveString` half is demoted, see "Not established".** `getSaveString` shares the same *candidate* set but writes each key only when the field is non-default (`if (*((float *)a2 + 450) != 0.0)` for key 275, `+ 451` for key 286, and so on), so the emitted set differs per object. A 3006 in an official level does carry key 286, which only the fade code reads — but it carries it because the field holds uninitialised garbage (`-4.31602e+008`), not because the writer is unconditional, and it does *not* carry key 275 at all. (Verified: the parse gate decodes to exactly 3006–3015, 3017–3021, 3023, 3024 — `0x6FBFF` sets bits 0–9, 11–15, 17, 18 — and every key→offset row below was re-read line by line and is correct.)

  ```
  key -> EnterEffectObject offset            (offset in the parse vector is always 4*key)
  217 -> 1636 int                  344 -> 1828 int, clamped to 0..100
  222 -> 1640 length               223 -> 1644 length_pm
  220 -> 1648 offset               221 -> 1652 offset_pm
  252 -> 1656 offset_y             253 -> 1660 offset_y_pm
  218 -> 1664 move_dist            219 -> 1668 move_dist_pm
  237 -> 1740 move_x               238 -> 1744 move_x_pm
  239 -> 1748 move_y               240 -> 1752 move_y_pm
  242 -> 1716 easing id            243 -> 1720 easing rate   (snapped: (int)(v*100)/100)
  248 -> 1728 easing id 2          249 -> 1732 easing rate 2 (same snap)
  231 -> 1688 move_angle           232 -> 1692 move_angle_pm
  287 -> 1708 bool  (relative dir) 288 -> 1712 float (soft radius at the centre)
  233 -> 1672 scale_x              234 -> 1676 scale_x_pm
  235 -> 1680 scale_y              236 -> 1684 scale_y_pm
  260 -> 1756 colour channel       224 -> 1760 int
  262 -> 1764 axis mode 0/1/2       51 -> 1276 target group    71 -> 1280 centre group
  538 -> 1352 centre override      241 -> 1768 bool (xy mode)  261 -> 1769 bool (dual easing)
  263 -> 1772 mod_front            264 -> 1776 mod_back
  265 -> 1780 tint amount          285 -> 1784 tint_pm
  225 -> 1788 AREA EFFECT ID       270 -> 1792 rotation        271 -> 1796 rotation_pm
  275 -> 1800 to_opacity           286 -> 1804 from_opacity
  276 -> 1808 bool (invert)        138 -> 1496  200 -> 1497   201 -> 1498
   65 -> 1445 main only             66 -> 1446 secondary only
  278 -> 1809 bool (hsv on)         49 -> 1424..1436 (hsv, parsed only when 278 is set)
  282 -> 1812 deadzone             283 -> 1816 bool (two-sided)
  341 -> 1820 int (sort priority)  355 -> 1832 bool (Edit Area: match by effect id)
  539 -> 1817 bool                  10 -> 1264 float (Edit Area tween duration)
  226 -> alias for 51              342 -> alias for 71 (positive) / 538 (negative)
  ```

  **Parse type matters and the table above does not record it.** The block mixes `atoi` and `atof`, and a port that reads them all as floats will silently accept level strings the game cannot produce. `atoi` (integer, stored as int and only widened to float in `loadValuesFromObject`): 217, 218, 219, 220, 221, 222, 223, 224, 231, 232, 237, 238, 239, 240, 242, 248, 252, 253, 260, 262, 225, 341, 344, 51, 71, 538, 226, 342, 534. `atof` (float): 243, 249 (both snapped to `(int)(v*100)/100`), 233, 234, 235, 236, 263, 264, 265, 270, 271, 275, 285, 286, 282, 288, 10. Booleans (`atoi(...) != 0`): 241, 261, 276, 278, 283, 287, 355, 539, 65, 66, 138, 200, 201, 280, 281. This matches the official levels exactly — every `atoi` key in the 44 placements holds an integer and every `atof` key that varies holds a non-integer somewhere (243 = 0.79, 263 = 1.2, 282 = 0.03, 233 = 0.5).

  <sub>EnterEffectObject::customObjectSetup, gd-ida-decomp.cpp:299879-300262 (ID gate at 299974-299977); key list confirmed against EnterEffectObject::getSaveString, 318516-319400</sub>

- **The instance is a flat copy of those fields. Offsets inside the 212-byte `EnterEffectInstance` (the ones the runtime reads) are:**

  ```
  inst+24  key222   inst+28  key223   inst+32  key220   inst+36  key221
  inst+40  key252   inst+44  key253   inst+48  key263   inst+52  key264
  inst+56  key282   inst+60  key218   inst+64  key219   inst+68  key231
  inst+72  key232   inst+76  key237   inst+80  key238   inst+84  key239
  inst+88  key240   inst+92  key288   inst+96  key233   inst+100 key234
  inst+104 key235   inst+108 key236   inst+112 key270   inst+116 key271
  inst+120 key265   inst+124 key285   inst+128 key275   inst+132 key286
  inst+136..148 key49 hsv (h,s,v,flags)   inst+152..160 live animated h,s,v
  inst+164 EnterEffectObject*   inst+172 key51   inst+176 key71   inst+180 unique id
  inst+184 frame counter (+=2)  inst+188/189 paused flags          inst+192 group pass base
  inst+196 vector<int> side cache          inst+208 key534 (control id)
  ```

  <sub>EnterEffectInstance::loadValuesFromObject, gd-ida-decomp.cpp:717794-717886; ctor, 441838-441872</sub>

- **Move, XY mode (key 241 set) — two independent axes, no direction vector at all.**

  ```
  dx = ( key237 + key238 * R[i+666] ) * strength
  dy = ( key239 + key240 * R[i+667] ) * strength
  if (dx == 0 && dy == 0) dx = dy = 0          // explicit early-out
  moveAreaObject(obj, dx, dy)
  ```

  <sub>processAreaMoveGroupAction, gd-ida-decomp.cpp:437621-437648</sub>

- **Move, distance+angle mode (key 241 clear) — a signed distance along a unit direction. Key 287 makes the direction radial (away from the centre) instead of a fixed angle; key 288 then softens the singularity by scaling the distance down inside that radius. Angle 0 points straight DOWN, because the conversion is `ccpForAngle((deg - 90) * pi/180)`.**

  ```
  dist = key218 + key219 * R[i+668]
  if (dist == 0) -> no move
  e = getEasedAreaValue(...)

  if (key287) {                                   // relative / radial
      d = objPos - centre ; L = |d|
      soft = max(key288, 0)
      if (L < soft) dist = dist * (L * (1/soft))
      if (L <= 0) dir = (0,0) else dir = d / L
  } else if (obj+1696) {                          // cached unit vector, valid when key232 == 0
      dir = obj+1700
  } else {
      dir = ccpForAngle( (key231 + key232 * R[i+669] - 90.0) * 0.017453 )
  }
  amount = dist * (1.0 - e)
  moveAreaObject(obj, amount * dir.x, amount * dir.y)
  ```

  <sub>processAreaMoveGroupAction, gd-ida-decomp.cpp:437649-437748 (`soft` is hoisted to the top of the function: `v14 = *(float *)(v12 + 1712); if (v14 <= 0.0) v14 = 0.0;` at 437577-437579, so `soft == 0` makes the `L < soft` branch unreachable and there is no divide-by-zero); the cached vector is filled in processAreaEffects at 469149-469161 (`0.017453` = pi/180; only when key232 == 0, and ~~only on the last physics sub-step~~ — **demoted, see "Not established"**: the guard is `if (!a3)` where `a3` is the *effect type* argument (0 = move), not the last-sub-step bool, which is `a5`. The vector is rebuilt on every sub-step, for the move list only.)</sub>

- **Rotate — one scalar added to four rotation fields on the object, with `obj+580`/`obj+588` acting as the undo accumulators.**

  ```
  amount = ( key270 + key271 * R[i+676] ) * strength
  if (amount != 0) { obj+576 += amount ; obj+580 += amount
                     obj+584 += amount ; obj+588 += amount
                     if (isLastSubStep) obj->vtable[732](obj, 0)     // slot unresolved
                     if (obj+776 != 7) { obj+724 = 1 ; obj+725 = 1
                                         if (!obj+636) GameObject::calculateOrientedBox(obj) } }
  // proxy pass instead calls rotateAreaObjects(originObject, subGroup, amount, isLastSubStep)
  ```

  ~~mark dirty; if last sub-step, `GameObject::calculateOrientedBox(obj)`~~ — **demoted, see "Not established".**
  The last-sub-step flag (`a11`) gates the *unresolved vtable slot 732*, not `calculateOrientedBox`.
  `calculateOrientedBox` runs on every sub-step whenever `obj+776 != 7` and the byte `obj+636` is
  clear. "Mark dirty" was a guess at what slot 732 does and is not established.

  <sub>processAreaRotateGroupAction, gd-ida-decomp.cpp:437436-437488</sub>

- **Scale — the two factors interpolate from 1 toward the target as strength rises, and `0` means "unset" (both zero collapses to identity, which is why the editor default of 0 is harmless).**

  ```
  sx = key233 + key234 * R[i+670]
  sy = key235 + key236 * R[i+671]
  if (sx == 0 && sy == 0) { fx = fy = 1.0 }
  else { e = getEasedAreaValue(...)
         fx = (sx - 1) * (1 - e) + 1
         fy = (sy - 1) * (1 - e) + 1 }
  ddx = obj[1000] * (fx - 1) ; ddy = obj[1004] * (fy - 1)
  obj+592 += ddx ; obj+600 += ddx ; obj+1000 += ddx
  obj+596 += ddy ; obj+604 += ddy ; obj+1004 += ddy
  // proxy pass instead calls transformAreaObjects(originObject, subGroup, fx, fy)
  ```

  <sub>processAreaTransformGroupAction, gd-ida-decomp.cpp:437141-437208</sub>

- **Fade — a plain lerp on the RAW distance ratio, not eased and not `1 - v`: key 286 is the opacity at the centre and key 275 the opacity at the edge. Overlapping fades resolve per frame by "closest centre wins".**

  ```
  op = key286 + (key275 - key286) * v            // v is the raw getAreaObjectValue result
  setAreaOpacity(obj, op, v, layer.frameCounter)

  GameObject::setAreaOpacity(obj, mul, v, frame):
      if (obj+1148 != frame || v < obj+1144) {
          base = obj+1140                         // the object's own opacity byte
          obj.setOpacity( (uint8)(mul * base) )
          obj+1140 = base ; obj+1148 = frame ; obj+1144 = v
      }
  ```

  <sub>processAreaFadeGroupAction, gd-ida-decomp.cpp:426993-427055; GameObject::setAreaOpacity, 167548-167562</sub>

- **Tint has two mutually exclusive modes. With key 278 set it multiplies the trigger's HSV (key 49) by the strength and applies it to the object's own colour; otherwise it blends the object's colour toward the colour channel named by key 260, with key 265 as the blend amount. Keys 65 / 66 gate the main and secondary colours — and they are wired the natural way round: 65 "main only" suppresses the secondary and 66 "secondary only" suppresses the main.**

  ```
  applyMain      = !key66
  applySecondary = !key65

  key278 set (HSV mode):
      hsv = getMultipliedHSV(inst+136, 1.0 - v)
          // h *= f ;  s = (satIsAbsolute ? f*s : (1-f) + f*s) ;  same shape for v
      colour = transformColor(objectBaseColour, hsv)

  key278 clear (colour mode):
      tint = key265
      f = (1.0 - tint) + v * tint                 // f = 1-tint at the centre, 1 at the edge
      target = effectManager.activeColorForIndex(key260)
      colour = multipliedColorValue(target, objectBaseColour, f)
          // f >= 1 -> object colour unchanged ; f <= 0 -> fully the target colour
          // else componentwise target + (object - target) * f
  ```

  <sub>processAreaTintGroupAction, gd-ida-decomp.cpp:427159-427208 (HSV) and 427295-427360 (colour); GameToolbox::getMultipliedHSV, 43304-43343; GameToolbox::multipliedColorValue, 43177-43217</sub>

### D — Area Stop, Edit Area, and lifecycle

- **3024 Area Stop calls `controlAreaEffectWithID(layer, key51, -1, 0)`. It matches the trigger's own key 51 against each running instance's SOURCE OBJECT key 225 (the Area Effect ID), not against a group, and command 0 erases the instance outright. Commands 1 and 2 (pause/resume, reachable through a control ID rather than 3024) just set or clear the two bytes at `inst+188`/`inst+189`, and a paused instance is skipped at the top of `processAreaEffects`.**

  ```
  controlAreaEffectWithID(layer, effectId, controlId, cmd):
    for each of the 5 vectors (layer+1240, +1252, +1264, +1276, +1288)
      for each instance:
        match = (controlId != -1) ? (inst+208 == controlId)
                                  : (inst.obj[1788] == effectId)
        if (!match) continue
        if (cmd == 0) erase(instance)
        if (cmd == 1) inst+188 = inst+189 = 1
        if (cmd == 2) inst+188 = inst+189 = 0
        if (effectId > 0 && controlId == -1) break      // ids are unique, stop after one
  ```

  <sub>trigger dispatch at gd-ida-decomp.cpp:315001; GJBaseGameLayer::controlAreaEffectWithID, 467943-468039; the skip is `if (*(_BYTE *)(v14 + 188)) goto LABEL_116;` in processAreaEffects, 468946-468947; also reached from controlTriggersWithControlID, 468081</sub>

- **Key 225 is the editor-assigned Area Effect ID, unique in `1..999`, and it is also a replace key: adding an effect whose object has a non-zero key 225 first erases any running instance whose source object shares that ID.**

  ```
  // addAreaEffect
  id = obj+1788
  if (id > 0) for each existing instance: if (inst.obj[1788] == id) { erase; break }

  // LevelEditorLayer::getNextFreeAreaEffectID
  collect obj+1788 of every object with obj+784 == 45 ; return the first unused j in 1..999
  ```

  <sub>GJBaseGameLayer::addAreaEffect, gd-ida-decomp.cpp:467783-467797; LevelEditorLayer::getNextFreeAreaEffectID, 189791-189817</sub>

- **3011–3015 Edit Area do NOT create anything. They find already-running instances and tween their stored values, which is the only place key 10 (duration) matters. Targeting is by the Edit trigger's key 51: normally that is a GROUP whose area triggers are edited, but if key 355 is set it is an Area Effect ID (key 225) instead.**

  ```
  triggerAreaEffectAnimation(obj):
    t = obj+1276                                  // key 51
    if (obj+1832 /* key 355 */)
        for each of the 5 vectors, for each instance:
            if (inst.obj[1788] == t) { loadTransitions(inst, obj, layer.time)
                                       if (t > 0) break }       // one per vector
    else
        for each object g in layer.getGroup(t):
            if (g.objectType == 45 && g.id in 3006..3010)
                for each instance in the matching vector:
                    if (inst.obj == g) loadTransitions(inst, obj, layer.time)
  ```

  <sub>GJBaseGameLayer::triggerAreaEffectAnimation, gd-ida-decomp.cpp:426494-426620; the ID switch is `0xBBE..0xBC2` = 3006..3010 at 426596-426608</sub>

- **An Edit Area trigger edits only the fields actually present in its level string, because `customSetup` pre-seeds every payload field of a 3011–3015 object with the sentinel −99 (ints) / −99.0f (floats, dword `-1027211264` = `0xC2C60000` = −99.0f) and `loadTransitions` skips every field still equal to −99.**

  ```
  // 0xC2C60000: sign 1, exp 0x85 = 133 -> 2^6 = 64, mantissa 0x460000/0x800000 = 0.546875
  //             (1 + 0.546875) * 64 = 99.0  ->  -99.0f
  EnterEffectObject::customSetup: if (id - 3011 <= 4) resetEnterAnimValues()
  loadTransitions(inst, obj, now):
      for each (slot, instField, objField):
          if (objField != -99) animateValue(inst, slot, instField, objField,
                                            obj+1264 /*key10*/, obj+1716 /*key242*/,
                                            obj+1720 /*key243*/, obj+1724 /*buffer*/)
      if (obj+1809 /*key278*/) animate slots 28,29,30 from obj+1424,1428,1432 (hsv)
  ```

  <sub>EnterEffectObject::customSetup, gd-ida-decomp.cpp:305515-305522; resetEnterAnimValues, 305463-305498; EnterEffectInstance::loadTransitions, 717409-717762</sub>

- **The full Edit Area slot table (slot index used by `animateValue`/`getValue`/`setValue`, and the key it edits):**

  ```
  0 key222   1 key223   2 key220   3 key221   4 key263   5 key264   6 key282
  7 key218   8 key219   9 key231  10 key232  11 key237  12 key238  13 key239  14 key240
 15 key233  16 key234  17 key235  18 key236  19 key270  20 key271  21 key265  22 key285
 23 key275  24 key286  25 key252  26 key253  27 key288  28/29/30 hsv h/s/v (key49, gated by key278)
  ```

  <sub>EnterEffectInstance::loadTransitions, gd-ida-decomp.cpp:717433-717761; slot->field mapping cross-checked against EnterEffectInstance::getValue, 717120-717190+</sub>

- **A transition is a simple from/to tween evaluated with the SAME easing machinery; when its clock passes the duration the target value is written exactly and the entry is destroyed.**

  ```
  // per instance, once per tick, before anything else in processAreaEffects
  for each transition e:
      e.elapsed (+36) += dt
      if (e.elapsed < e.duration (+32)) {
          f = getEnterEasingValue(e.elapsed / e.duration, e.type(+40), e.rate(+44), e.buffer(+48))
          setValue(inst, e.slot(+20), e.from(+24) + (e.to(+28) - e.from(+24)) * f)
      } else {
          setValue(inst, e.slot, e.to) ; erase e
      }
  inst+136..144 = inst+152..160          // publish the animated hsv
  ```

  <sub>EnterEffectInstance::updateTransitions, gd-ida-decomp.cpp:717056-717096; called first thing per instance in processAreaEffects, 468949</sub>

- **Every area effect is applied by accumulating into dedicated "area delta" fields and undoing them at the start of the next tick, guarded by a per-object frame stamp so the undo happens once even when many triggers hit the same object. This is the mechanism that makes an area trigger a continuous field rather than a one-shot offset.**

  ```
  resetAreaObjectValues(obj, registering):
      if (obj+1068 >= layer.frame) return 0                  // already reset this tick
      if (registering) updateAreaObjectLastValues(obj)
      dx = obj+568 ; if (dx) { obj+800 -= dx ; obj+568 = 0 }  // position X
      dy = obj+572 ; if (dy) { obj+808 -= dy ; obj+572 = 0 }  // position Y
      sx = obj+600 ; sy = obj+604                             // scale accumulators
      if (sx || sy) { obj+592 -= sx ; obj+1000 -= sx
                      obj+596 -= sy ; obj+1004 -= sy ; obj+600 = obj+604 = 0 }
      ra = obj+580 ; rb = obj+588                             // rotation accumulators
      if (ra || rb) { obj+576 -= ra ; obj+584 -= rb ; obj+580 = obj+588 = 0 }
      obj+1068 = layer.frame
      if (registering) push obj onto layer's "touched this tick" list (layer+2264)
      else             updateAreaObjectLastValues(obj)

  // and at the top of processAreaActions, every object that was touched LAST tick but
  // not this one gets the same reset with registering = 0, plus its dirty flags cleared.
  ```

  <sub>GJBaseGameLayer::resetAreaObjectValues, gd-ida-decomp.cpp:436707-436801; moveAreaObject, 436852-436887; the stale-object sweep in processAreaActions, 469293-469313; GJBaseGameLayer::updateAreaObjectLastValues, 426645-426678</sub>

- **Scheduling. Move/rotate/scale run once per PHYSICS SUB-STEP, in the order scale, rotate, move; fade and tint run once per FRAME from `processAreaVisualActions`. The `bool` reaching `processAreaActions` is "this is the last sub-step of the frame" and gates the visual-refresh side effects (the cached move-angle vector, the rotation/scale sprite updates).**

  ```
  processMoveActionsStep(dt, isLastSubStep):
      ... processFollowActions ...
      processAreaActions(dt, isLastSubStep):
          layer+820 = layer+816 - 1
          processAreaEffects(layer+1264, 2 /*scale*/,  dt, isLastSubStep)
          processAreaEffects(layer+1252, 1 /*rotate*/, dt, isLastSubStep)
          processAreaEffects(layer+1240, 0 /*move*/,   dt, isLastSubStep)
          ... stale sweep, swap touched lists ...

  processAreaVisualActions(dt):                    // once per frame, from updateVisibility
          processAreaEffects(layer+1276, 3 /*fade*/, dt, true)
          processAreaEffects(layer+1288, 4 /*tint*/, dt, true)
  ```

  <sub>GJBaseGameLayer::processAreaActions, gd-ida-decomp.cpp:469272-469352; processMoveActionsStep, 469368-469412; caller passing `v20 == v2 - 1`, 469892; processAreaVisualActions, 470151-470155, called from 96090 and 193128</sub>

- **Adding an effect reuses an existing instance instead of creating a second one when the source object, key 51, key 71 and key 534 all match; only then are the values reloaded in place. Otherwise a new instance is appended and the effect type is marked dirty so the list is re-sorted next tick.**

  ```
  addAreaEffect(obj, vec, type):
      for inst in vec:
          if (inst+164 == obj && inst+172 == obj[1276] &&
              inst+176 == obj[1280] && inst+208 == obj[1484])
              return loadValuesFromObject(inst, obj)
      ... erase same-key225 instance, look up the special key, push_back ...
      layer[1300-set].insert(type)                      // "needs re-sort"

  // processAreaEffects, first thing:
  if (layer[1300-set].contains(type)) { sort(vec, compEnterEffectSort) ; erase type }
  ```

  <sub>GJBaseGameLayer::addAreaEffect, gd-ida-decomp.cpp:467774-467869; the sort gate at processAreaEffects 468901-468940</sub>

- **Instances are sorted by key 341 DESCENDING (higher first), tie-broken by `obj+1824` ascending.**

  ```
  compEnterEffectSort(a, b):
      if (a.obj[1820] == b.obj[1820]) return a.obj[1824] < b.obj[1824]
      return a.obj[1820] > b.obj[1820]
  ```

  <sub>compEnterEffectSort, gd-ida-decomp.cpp:415080-415095</sub>

---

## likely

- **The random-table LCG is the MSVC `rand()` recurrence `state = state * 214013 + 2531011`. IDA printed the multiplier as a relocated symbol (`(unsigned int)&stru_343FC.st_name + 1`), so the literal is not in the listing; the increment 2531011 and the `(state >> 16) & 0x7FFF` extraction are the unmistakable MSVC form, and the same expression appears in both the table builder and the per-object index.**

  <sub>GJBaseGameLayer::init, gd-ida-decomp.cpp:462060-462062; GameObject::commonSetup, 166723-166724</sub>

- **`getSpecialKey(group, b1, b2) = 100000000 + 10000000*b1 + 1000000*b2 + group`, with b1 = key 280 and b2 = key 281. IDA rendered the two multipliers as string pointers, but the inverse function `parseSpecialKey` subtracts exactly `1000000*b2 + 10000000*b1 + 100000000`, which pins them.**

  ```
  getSpecialKey:  return K1*b1 + 100000000 + K2*b2 + group
  parseSpecialKey: *b2 = a1 / K2 % 10 == 1
                   *b1 = (a1 / K1) % 10 == 1
                   *group = a1 - 1000000*(*b2) - 10000000*(*b1) - 100000000
  => K1 = 10000000, K2 = 1000000
  ```

  <sub>GJBaseGameLayer::getSpecialKey, gd-ida-decomp.cpp:425771-425776; parseSpecialKey, 425787-425803; keys 280/281 parsed at EffectGameObject::customObjectSetup, 298714-298722</sub>

- **`key276` is "invert": it flips the computed ratio (`v = 1 - v`) and, correspondingly, opens the section box to the whole level. No separate name is in the binary, but the two uses are consistent and it is the only field that does both.**

  <sub>getAreaObjectValue, gd-ida-decomp.cpp:426863-426864; processAreaEffects, 469107, 469124, 469135</sub>

- **`key539` (obj+1817) marks the proxy object itself as already-handled so a representative that is also a member of its own sub-group is not moved twice. It sets `obj+1116 = 1` before the sub-group loop and clears it after, and the loop skips any object with that byte set.**

  ```
  if (obj+1817) target.obj[1116] = 1
  for each g in subGroup: if (!g[1116]) moveAreaObject(g, dx, dy)
  target.obj[1116] = 0
  ```

  <sub>processAreaMoveGroupAction, gd-ida-decomp.cpp:437656-437684; same shape in rotate 437484-437487 and scale 437183-437186</sub>

- **`obj+1852` is a "centre moved left this tick" flag, written from the sign of the centre's X delta but never read by any area-trigger code I could find; it is most plausibly consumed by the editor preview.**

  ```
  if (delta.x != 0) obj+1852 = (delta.x < 0)
  ```

  <sub>processAreaEffects, gd-ida-decomp.cpp:469146-469147</sub>

---

## Not established

- **The side flag returned by `getAreaObjectValue` compares mismatched coordinates in the RADIAL branch. In the X branch it is `centre.x <= obj.x` and in the Y branch `centre.y <= obj.y`, both sensible; in the radial branch the decompile literally reads `centre.x` against `obj.y` (`v19 = v32 == v42; v18 = v32 >= v42` with `v32 = *(float*)a4` and `v42 = obj.y`). This is either a genuine GD bug or an IDA register mix-up, and I cannot tell which. It only matters when key 261 (dual easing) is on, because otherwise the flag is never read.**

  <sub>getAreaObjectValue, gd-ida-decomp.cpp:426789-426795 (radial) versus 426765-426768 (X) and 426805-426808 (Y)</sub>

- **`inst+168`, the byte that selects which of the two comparison forms produces that side flag, is written to 0 by the constructor and copied by the copy constructors, and I found no code that ever sets it to 1. If something does set it, the flag becomes a strict `centre >= obj` instead of `centre <= obj`.**

  <sub>ctor `*((_BYTE *)this + 168) = 0;` at gd-ida-decomp.cpp:441855; copies at 103954 and 104056; read at getAreaObjectValue 426759 / 426798 / 426846-426848</sub>

- **`obj+1824`, the tie-break in `compEnterEffectSort`, has no writer for `EnterEffectObject` anywhere in the listing — `create` zeroes the surrounding dwords (455, 456, 457) and `customObjectSetup` writes only 1820 (key 341) and 1828 (key 344). If it really is always 0 the sort degenerates to "key 341 descending, ties in arbitrary introsort order", which would be a determinism hazard for a port; but I cannot rule out a writer outside the decompiled set.**

  <sub>EnterEffectObject::create, gd-ida-decomp.cpp:307814-307817; compEnterEffectSort, 415092</sub>

- **Keys 217 (`obj+1636`), 224 (`obj+1760`) and 344 (`obj+1828`) are parsed and saved for area triggers but no area-runtime function reads them. 217 and 344 are parsed OUTSIDE the ID gate, so they belong to the wider `EnterEffectObject` family (3017–3021 enter/exit effects), not to 3006–3015. What key 224 does is unknown.**

  <sub>parsed at EnterEffectObject::customObjectSetup, gd-ida-decomp.cpp:299958-299977 (217, 344) and 300093-300096 (224); no read found in 415000-470500</sub>

- **Keys 138 (`obj+1496`), 200 (`obj+1497`) and 201 (`obj+1498`) are re-parsed inside the area block but I did not trace where the area path reads them, if at all; they are generic `EffectGameObject` booleans also parsed elsewhere.**

  <sub>EnterEffectObject::customObjectSetup, gd-ida-decomp.cpp:300171-300187</sub>

- **Key 285 (tint_pm, `inst+124`) is parsed, saved and animatable by Edit Area, but `processAreaTintGroupAction` reads only `inst+120` (key 265). Either the variance is genuinely unused for tint or it is consumed somewhere I did not reach.**

  <sub>parse at gd-ida-decomp.cpp:300135-300140; the only tint read is `*(float *)(a3 + 120)` at 427326</sub>

- **The float table's LCG seed `qword_A9C810` is a process-global carried across level loads, so the per-object variance is deterministic within a run but I could not establish whether it is reseeded per attempt or per level. A port that wants bit-exact variance needs that answer.**

  <sub>GJBaseGameLayer::init, gd-ida-decomp.cpp:462059 and 462069</sub>

- **`layer+2456` entry `k+2` (the origin dictionary consumed by `getTargetGroupOrigin`) is populated from a second dictionary in `generateTargetGroups` whose selection rules involve object bytes `obj+998`, `obj+999` and `obj+1014`, which I did not decode. This only affects the pivot chosen when a rotate or scale hits a group-parented sub-group.**

  <sub>GJBaseGameLayer::generateTargetGroups, gd-ida-decomp.cpp:457727-457780</sub>

- **The exact meanings of `layer+11448` / `layer+11452` (the reciprocal section sizes) and `layer+328` (the zoom divisor applied to the window size for screen-anchor centres) were not chased to their writers; both are used consistently and their roles are unambiguous, but the numeric section width and the zoom source are not established here.**

  <sub>used at processAreaEffects gd-ida-decomp.cpp:468941, 469046, 469006-469008; addToSection, 444752 and 444765</sub>

### Demoted from "certain" by the 2.206 re-read

These three were written as certain and are wrong. They are kept here verbatim because work was
already built on them.

- **DEMOTED — "the cached move-angle vector is filled ... only on the last physics sub-step".**
  The guard in `processAreaEffects` is `if (!a3)`, and `a3` is the *effect type* parameter
  (`processAreaEffects(layer, vec, type, dt, isLastSubStep)`; `processAreaActions` passes `2u`,
  `1u`, `0` for scale/rotate/move and `processAreaVisualActions` passes `3u`/`4u`). The
  last-sub-step bool is the *fifth* argument, `a5`, and is not consulted here at all. So the
  cached unit vector at `obj+1700` and the flag at `obj+1696` are recomputed on **every** physics
  sub-step, for the **move** list only. The `key232 == 0` half of the original claim is correct.
  A port that only refreshed the vector on the last sub-step would use a stale direction for every
  sub-step but the last whenever the trigger's angle is animated by an Edit Area tween.

  <sub>processAreaEffects, gd-ida-decomp.cpp:469149-469161 (`if ( !a3 )`); the type argument is the
  third parameter, see processAreaActions 469288-469290 and processAreaVisualActions 470152-470153;
  the last-sub-step bool originates at `processMoveActionsStep(this, v28, v20 == v2 - 1)`, 469889</sub>

- **DEMOTED — "`getSaveString` emits exactly the same set for all of them".**
  It does not. Each key is written under its own non-default test, e.g. `if (*((float *)a2 + 450)
  != 0.0)` for key 275 and `if (*((float *)a2 + 451) != 0.0)` for key 286. The *parse* set is
  shared across 3006–3015 / 3017–3021 / 3023 / 3024 (that half is confirmed); the *emitted* set is
  per-object. The official levels show the difference directly: key 286 appears on 3006, 3007,
  3008 and 3010 placements, always holding `-4.31602e+008`, while key 275 appears on **no** 3006,
  3007, 3008 or 3010 at all — only on 3009 (Area Fade) and as the −99 sentinel on 3011. The
  conclusion the original bullet drew from this ("a 3006 carries keys only the fade code reads") is
  still true, but for a different reason: the field holds uninitialised garbage, not a default the
  writer emits anyway. A port that read key 286 off a 3006 and believed it would apply an opacity
  of about −431602000.

  <sub>EnterEffectObject::getSaveString, gd-ida-decomp.cpp:318990 and 319001 (offsets 450/451);
  measured over the official levels, see "Checked against the levels"</sub>

- **DEMOTED — rotate's "mark dirty; if last sub-step, `GameObject::calculateOrientedBox(obj)`".**
  Two errors in one clause. (a) The last-sub-step flag `a11` gates a call through **vtable slot
  732**, which IDA does not resolve; "mark dirty" is a guess at its identity and is not established.
  (b) `calculateOrientedBox` is *not* gated by the sub-step flag — it runs whenever
  `obj+776 != 7` and the byte `obj+636` is clear, on every sub-step. The same unresolved-slot
  pattern appears in scale (`if (a11) obj->vtable[720](obj, 1.0f)`) and in the stale-object sweep
  in `processAreaActions` (slots 732 and 720), so none of those three slots should be treated as
  known.

  <sub>processAreaRotateGroupAction, gd-ida-decomp.cpp:437454-437468; processAreaTransformGroupAction,
  437203-437205; processAreaActions, 469303-469304</sub>

- **DEMOTED (citation only, substance intact) — two line references in section A were wrong.**
  The per-object section-box test in `processAreaMoveGroupAction` was cited as 437588-437596; that
  range is the loop *setup* and contains no comparison. The test is at 437601-437608, and it is
  written with dword indices (`*((_DWORD *)v20 + 132)` / `+ 133`) rather than byte offsets, which
  is the sort of thing that makes 528/532 easy to misread. And `obj+657` was attributed to
  "`GameObject::activateObject`, 165172-165176"; that range is
  `EnhancedGameObject::deactivateObject`, which only reads the byte. The real setter is
  `GameObject::activateObject` at 169451-169463. Both bullets' claims are correct; only the
  citations were wrong.

---

## Checked against the levels

Every object with id 3006–3015 or 3024 was pulled out of the decoded official levels 22, 5001,
5002, 5003 and 5004, and each one's raw property keys were tallied. What is below is measured, not
inferred.

**44 placements, not 45.**

| level | placements | breakdown |
|---|---|---|
| 22 (Dash) | 6 | 3006 ×3, 3010 ×2, 3011 ×1 |
| 5001 (The Tower) | 14 | 3006 ×3, 3007 ×1, 3008 ×2, 3009 ×4, 3010 ×4 |
| 5002 (The Sewers) | 10 | 3006 ×6, 3008 ×2, 3009 ×2 |
| 5003 (The Cellar) | 7 | 3006 ×3, 3009 ×3, 3011 ×1 |
| 5004 (The Secret Hollow) | 7 | 3006 ×4, 3011 ×3 |
| **total** | **44** | 3006 ×19, 3007 ×1, 3008 ×4, 3009 ×9, 3010 ×6, 3011 ×5 |

**3012, 3013, 3014, 3015 and 3024 do not occur in any of these levels.** Everything this file says
about 3024 Area Stop, about `controlAreaEffectWithID` pause/resume, and about Edit Area ids other
than 3011 rests on the binary alone and has no level-data corroboration whatsoever.

### Key counts over all 44 placements

```
51(44) 222(44) 243(44) 249(44) 263(44) 264(44) 10(44) 36(44) 155(44) 71(31) 262(30) 286(29)
242(23) 283(17) 276(12) 241(11) 239(11) 265(11) 275(11) 223(10) 218(9) 232(9) 233(9) 235(9)
282(9) 538(8) 220(7) 221(7) 271(6) 219(6) 260(6) 231(5) 234(5) 236(5) 238(5) 240(5) 252(5)
253(5) 270(5) 285(5) 288(5) 225(4) 248(4) 287(4) 261(2) 281(2) 66(2) 280(1) 341(1) 355(1)
```

Ranges worth knowing (excluding the −99 sentinels that 3011 writes):
`222` 38..1500 · `223` 10..500 · `218` −150..700 · `219` 10..150 · `220` −50..100 · `221` 9..30 ·
`231` 200 · `232` 200 · `233`/`235` 0.5..2 · `237` ±40 · `239` −270..60 · `243` 0.79..2 ·
`249` 1.5..2 · `242`/`248` 1..6 · `260` 144..287 · `262` 1..2 · `263` 0.5..1.2 · `264` 0.2..1 ·
`265` 0.5..1 · `270`/`271` 75 · `282` 0.03..0.5 · `225` 1..2 · `341` 1 · `538` −1 ·
`51` 1..838 · `71` 124..839.

### Keys this file describes that appear on ZERO of the 44 placements

**217, 224, 344, 138, 200, 201, 65, 278, 49, 539, 226, 342, 534.**

Consequences, in order of how badly they would hurt a port that trusted the prose:

- **Key 278 + key 49 — the entire HSV branch of Area Tint is never exercised.** All six 3010
  placements use the colour-channel branch (key 260 on 6/6, key 265 on 6/6, key 278 on 0/6).
  The `getMultipliedHSV` path, and with it slots 28/29/30 of the Edit Area table, are binary-only.
- **Key 65 is never present; key 66 appears twice.** The "wired the natural way round" claim
  (`applyMain = !key66`, `applySecondary = !key65`) is confirmed in the binary at
  `processAreaTintGroupAction` 427163-427167 (`v61 = obj[1446] ^ 1`, `v62 = obj[1445] ^ 1`), but
  only the `!key66` half has ever run in a shipped level.
- **Keys 226 and 342, the alias overrides, never occur.** The parse is confirmed (300240-300259)
  but nothing in the official set depends on it.
- **Key 534 never occurs**, so `inst+208` is 0 on every real instance — which means the
  control-id matching arm of `controlAreaEffectWithID` (and the fourth term of the reuse test in
  `addAreaEffect`) has never been exercised by a shipped level either.
- **Keys 217, 224, 344, 138, 200, 201, 539 never occur**, consistent with this file already
  listing them as unread or unknown. Note in particular that the `key539` proxy-skip bullet under
  "likely" has no level-data support at all.
- **Key 288 (soft radius) occurs 5 times and all five are the −99 sentinel on 3011.** No shipped
  Area Move actually sets it, so the `L < soft` branch of the radial-direction path is binary-only.
  Key 287 (relative direction) does occur, 4 times, all on 3006.

### What the level data positively corroborates

- **The −99 / −99.0f sentinel scheme is real and visible in the file.** Every 3011 placement writes
  out the full payload set with `-99` in each field it is not editing — e.g. level 22's 3011 carries
  `218,700 219,150` and `-99` for all of 220, 221, 222, 223, 231–240, 252, 253, 263, 264, 265, 270,
  271, 275, 282, 285, 286, 288. That is exactly `resetEnterAnimValues` (305463-305498) round-tripped
  through `getSaveString`, and it confirms `loadTransitions` must skip on equality with −99.
- **Key 355 appears once, on a 3011**, matching the "target by Area Effect ID instead of group"
  branch of `triggerAreaEffectAnimation`.
- **Key 225 appears 4 times with values 1 and 2**, inside the documented 1..999 range.
- **Area Fade's key 275 / key 286 pair reads correctly at both ends.** On 3009, key 286 is 1 on 3
  placements and key 275 is 1 on 6; with the absent one defaulting to 0 that gives
  `op = 1 + (0−1)·v` (opaque at the centre, invisible at the edge) and `op = 0 + (1−0)·v`
  (invisible at the centre, opaque at the edge) — both sensible, and both only sensible under the
  documented "286 = centre, 275 = edge, raw un-eased `v`" formula.
- **Key 10 is present on all 44 placements**, at 0.5 on every 3006–3010 and at 0.15..0.8 on the
  3011s. The claim that only Edit Area reads it survives — the 0.5 on the plain area triggers is an
  editor default that nothing in the area runtime touches — but a port should not assume the key is
  absent on 3006–3010.
- **The atoi/atof split holds in the data**, as noted under the key table.

### Keys present in the data that this file's table does not mention at all

`1` (object id), `2`/`3` (x/y), `36`, `57`, `62`, `87`, `155`, `170`. These are generic
`GameObject`/`EffectGameObject` keys, not area-specific, and the area block does not parse them —
but `57` (36/44), `62` (26/44), `155` (44/44) and `87` (6/44) are common enough on area triggers
that leaving them out of the table makes it look more complete than it is.
