# Keyframe animation, read out of the 2.206 decompile

Both web sources are right about their own half and wrong about the conclusion they draw.
`KeyframeGameObject` (object id **3032**) reads *all* of the keys flowvix lists **and** keys 373/374
from the Geode bindings, and it is 373/374 that build the ordered list: `GJBaseGameLayer::addKeyframe`
uses key 373 as the key into a `CCDictionary` of `CCArray`s hanging off the layer, and key 374 as the
*insert index* into that array; `updateKeyframeOrder` then rewrites every element's 374 from its array
position, so the index is an authored-and-maintained ordinal, not a derived one. Key 71 is not a chain
pointer at all — the popup's own help text calls it **SpawnGID**, "lets you spawn a group at the
keyframe". At trigger time `GJEffectManager::createKeyframeCommand` walks that `CCArray` once and bakes
it into a `std::vector<KeyframeObject>` of 336-byte PODs stored inside a normal 488-byte
`GroupCommandObject2` with command type **5**, converting every keyframe into a *delta* from its
predecessor (position, scale ratio, rotation degrees) and a per-segment duration. Sampling is linear
per segment by default — accumulate `t * nextKeyframe.delta` — except where the author set **Curve**,
which builds a genuine natural cubic `tk::spline` (spline_type 30, second-derivative boundaries at 0)
of cumulative-Δx and cumulative-Δy against cumulative duration and samples that instead. The six
multipliers on trigger 3033 do not scale the values; they scale each keyframe's *offset from the first
keyframe*, so the whole path stretches about keyframe 0, and Time Mod scales every segment duration.
Everything below is from `GJBaseGameLayer`, `GJEffectManager` and the two `customObjectSetup`
overrides; field names for `GroupCommandObject2` follow the map already in `trigger-semantics.md:563`.

> **Correction pass.** Every "certain" bullet below was re-read against the cited
> decompile lines, and the 373/374-vs-spawn-chain question was settled against the
> keyframe objects in levels 22 and 5001-5004 (see *Checked against the levels*).
> The sentence above — "`GJBaseGameLayer::addKeyframe` uses key 373 as the key … and
> key 374 as the *insert index*" — is **wrong for level loading**. `addKeyframe` is
> the editor's incremental path (`LevelEditorLayer::addKeyframe` is its only caller).
> At level load `GJBaseGameLayer::refreshKeyframeAnims` rebuilds the dictionary from
> scratch: it *appends* every id-3032 object in object-list order and then `qsort`s
> each array by `+1648` (key 374) with `compShadowCopy`. Real levels need that sort —
> 26 of the 71 keyframe groups in the official levels are stored out of index order,
> and insert-at-374 does not reconstruct them. Six other bullets were demoted; the
> details are in each one.

## certain

- **Object id 3032 is `KeyframeGameObject` and 3033 is `KeyframeAnimTriggerObject`; 3029-3031 are `ArtTriggerGameObject`.** In the object factory the 3033 case is taken first (IDA renders the literal as `&stru_BCC.st_other`), then within the remaining window `3029 <= id <= 3032` the test `id > 3031` selects `KeyframeGameObject`, leaving 3029/3030/3031 for `ArtTriggerGameObject`. The id is written to `obj+884` (dword index 221) immediately afterwards, and `playKeyframeAnimation` filters group members with exactly `obj[221] == 3032`.
  ```
  if (id == 3033) return KeyframeAnimTriggerObject::create();
  if (id > 3033) ...
  if (id <= 3027 || id < 3029) ...
  result = (id > 3031) ? KeyframeGameObject::create() : ArtTriggerGameObject::create();
  result[221] = id;                       // obj+884 = object id
  ```
  <sub>GameObject::createWithKey (object factory), gd-ida-decomp.cpp:183705-183752; confirmed at GJBaseGameLayer::playKeyframeAnimation, 451965</sub>
  (Checked. The `&stru_BCC.st_other` literal is *not* resolved by IDA, so the factory alone
  does not prove it is 3033 — but 3033 is confirmed independently twice: `EffectGameObject::triggerObject`
  tests `v11 != 3033` before falling through to `playKeyframeAnimation` (314986), and
  `EffectGameObject::customObjectSetup` has a literal `v30 == 3033` arm (298836). `result[221] = id`
  and the `id > 3031` split are exactly as quoted, and `v9[221] == 3032` is literal at 451965.)

- **The keyframe object's property parser reads 19 keys; here is the full key -> byte-offset table, read off `customObjectSetup` and cross-checked against `getSaveString`, which writes exactly the same pairs.** In `customObjectSetup` the third argument is a `vector<void*>` indexed *by property key* (`v6[373]` is byte `*a3+1492`), so the index is the key and the string is `a2[key]`.
  ```
  51  -> +1276 int    GroupID        (the group that is animated; "needs to contain a group parent")
  373 -> +1644 int    keyframe group (animation id — the dictionary key)
  374 -> +1648 int    keyframe index (the insert position in that group's array)
  375 -> +1652 bool   Ref Only
  30  -> +1308 int    easing type
  85  -> +1312 float  easing rate    (absent or <= 0 -> 2.0f)
  10  -> +1264 float  Duration       (seconds to the NEXT keyframe)
  71  -> +1280 int    SpawnGID
  377 -> +1653 bool   Prox
  557 -> +1664 float  SpawnDelay     ... then key 63 overwrites +1664 if it is non-zero
  378 -> +1654 bool   Curve
  379 -> +1656 int    time mode      (0 Time, 1 Even, 2 Dist)
  376 -> +1655 bool   Close Loop
  380 -> +1668 bool   Preview Art
  459 -> +1670 bool   Auto Layer
  536 -> +1672 int    CCW/CW
  537 -> +1676 int    x360
  524 -> +1680 float  LineOpacity
  ```
  <sub>KeyframeGameObject::customObjectSetup, gd-ida-decomp.cpp:300634-300766; KeyframeGameObject::getSaveString, 321860-322083</sub>
  (Checked key by key against both functions, including the `key*4` byte indices — 373→`a2+1492`,
  374→`a2+1496`, 375→`1500`, 376→`1504`, 377→`1508`, 378→`1512`, 379→`1516`, 380→`1520`, 459→`1836`,
  536→`2144`, 537→`2148`, 524→`2096`, 557→`2228`, 63→`252`, 51→`204`, 71→`284`, 30→`120`, 85→`340`,
  10→`40`. `getSaveString` writes the same 18 and omits 63, as stated. These are level-file property
  keys on the left and byte offsets into the object on the right; no confusion found.
  **One caveat:** +1644 and +1648 hold the authored 373/374 only until the level finishes loading —
  `refreshKeyframeAnims` overwrites both with dense ordinals, see the new bullet below.)

- **At level load the ordered list is built by `GJBaseGameLayer::refreshKeyframeAnims`, which APPENDS every id-3032 object in object-list order and then SORTS each array by `+1648` (key 374) with `compShadowCopy`.** This is the replacement for the demoted `addKeyframe` bullet (now under *likely*). It also renumbers: after the sort it writes each element's array position into `+1648` and a running dense counter into `+1644`, and it uses that counter — not the authored key 373 — as the `CCDictionary` key. The group ids are themselves visited in ascending authored order (`qsort` of `allKeys` with `compKeyframeID`), so a level whose 373 values are `0,1,2,…` renumbers to itself; a level with gaps compacts.
  ```
  refreshKeyframeAnims():
    layer.keyframeGroups(+11272).removeAllObjects() ; layer.nextAnimID(+11276) = 0
    tmp = CCDictionary::create()
    for (obj in layer.objects(+2208)):
       if (obj.objectID(+884) != 3032) continue
       arr = tmp[obj[+1644]] or (CCArray::create(), setTag(obj[+1644]), tmp[obj[+1644]] = arr)
       arr.addObject(obj)                               // APPEND, key 374 not consulted yet
    keys = tmp.allKeys() ; qsort(keys, compKeyframeID)  // by the authored 373 value
    for (k in keys):
       arr = tmp[k]
       qsort(arr, compShadowCopy)                       // by +1648, i.e. KEY 374
       arr.setTag(layer.nextAnimID)
       layer.keyframeGroups[layer.nextAnimID] = arr
       for (i, e in arr): e[+1648] = i ; e[+1644] = layer.nextAnimID
       ++layer.nextAnimID

  compShadowCopy(a, b) = a[+1648] - b[+1648]            // key 374
  compKeyframeID(a, b) = a[+52]   - b[+52]              // the CCString key's int
  ```
  The sort is load-bearing, not belt-and-braces: 26 of the 71 keyframe groups in the official levels are stored out of index order (e.g. level 5003 group 2 is `[7 6 5 4 2 1 0 3]` in file order).
  <sub>GJBaseGameLayer::refreshKeyframeAnims, gd-ida-decomp.cpp:428962-429043; compShadowCopy/compKeyframeID, 415142 and 415161; callers: GJBaseGameLayer::updateSpecialGroupData, 467062, and the editor's level load, 205003; createNewKeyframeAnim (where the +11276 counter is also used), 428812-428821</sub>

  (The demoted `addKeyframe` bullet that used to stand here is now the first entry under **likely**,
  with its original text intact.)

- **Key 71 on a keyframe is a group to SPAWN when that keyframe is passed, with key 557 as its delay — it is not what orders the keyframes.** The popup help string spells this out, and the runtime honours it: when a keyframe is crossed, `{uniqueID, spawnDelay, spawnGroup}` is pushed onto a scratch list and flushed at the end of the tick through `spawnGroup` (delay > 0) or, when the delay is <= 0, an unresolved vtable slot `+4` on whatever object sits at `GJEffectManager+264` (see *Not established* — "the layer" was an assumption, not a resolved symbol).
  ```
  "<cp>SpawnGID</c> lets you spawn a group at the keyframe."
  "<cg>Prox</c> will spawn the group when close to the keyframe."
  ```
  <sub>SetupKeyframePopup::init, gd-ida-decomp.cpp:694867-695256 (help text at 694951-694962); spawn flush in GJEffectManager::prepareMoveActions, 486688-486706</sub>
  (Checked. Both help lines are literal at 694955-694956, and the flush is
  `spawnGroup(this, group, delay, 0, remap, kf.uniqueID, cmd.controlID(+348))` for `delay > 0`.
  Confirmed against real data as well: key 71 rides 18 of 468 keyframe objects and key 557 rides 3 —
  far too sparse to be an ordering mechanism, and they never form a chain. See *Checked against the levels*.)

- **A trigger-3033 fire resolves to one `createKeyframeCommand` per distinct animation group found inside the trigger's Animation Group (key 76), deduped by a hash set.** `triggerObject` routes id 3033 straight to `playKeyframeAnimation`, passing the remap vector along. The keyframe *objects* are found by scanning the members of group key 76 for object id 3032 and taking their key-373 value; that value indexes the keyframe dictionary to get the ordered `CCArray`.
  ```
  playKeyframeAnimation(trigger, remap):
    grp = getGroup(trigger.animGroup(+1464, key 76)); seen = {}
    for (obj in grp):
      if (obj.objectID(+884) != 3032) continue
      animID = obj.keyframeGroup(+1644, key 373)
      if (animID in seen) continue
      seen.insert(animID)
      arr    = layer.keyframeGroups[animID]                 // layer+11272
      parent = tryGetMainObject(trigger.parentGroup(+1280, key 71))
      target = trigger.targetGroup(+1276, key 51) or obj.groupID(+1276, key 51) if 0
      effectManager.createKeyframeCommand(
          target, arr, parent,
          trigger.uniqueID(+772), trigger.controlID(+1484), /*temp=*/false,
          posXMod(+1640), posYMod(+1644), rotMod(+1648),
          sclXMod(+1652), sclYMod(+1656), timeMod(+1636), remap)
  ```
  <sub>EffectGameObject::triggerObject, gd-ida-decomp.cpp:314792-315547 (3033 case at 315005-315016); GJBaseGameLayer::playKeyframeAnimation, 451932-451997</sub>
  (Checked, with one wording fix: by the time this runs, `obj+1644` no longer holds the authored key 373 —
  `refreshKeyframeAnims` has replaced it with the dense animation ordinal, and the dictionary is keyed by
  the same ordinal, so the lookup is self-consistent. Read "the object's `+1644`", not "its key-373 value".
  Everything else is literal: `v9[221] == 3032`, the `_Hashtable<int,int>` dedupe, `tryGetMainObject(a2+1280)`,
  and the `v12 = a2+1276; if (!v12) v12 = v9[319]` fallback. The argument order in the call is
  `(mgr, target, arr, parent, uniqueID(+772), controlID(+1484), temp=0, +1640, +1644, +1648, +1652, +1656, +1636, remap)`.)

- **The six multiplier keys on trigger 3033 map to offsets 1636-1656 in this order, and key 545/546 fall back to key 521/523 when they are zero.** The parser writes them in save order, then patches Y from X. `getSaveString` writes each key only when its float is non-zero, and the neutral value in the editor preview path is `1.0`.
  ```
  520 -> +1636 Time Mod          (editor range 0 .. 1)
  521 -> +1640 Position X Mod    (editor range -2 .. 2)
  545 -> +1644 Position Y Mod    (-2 .. 2)   if 0 after parse -> copy +1640
  522 -> +1648 Rotation Mod      (-2 .. 2)
  523 -> +1652 Scale X Mod       (-2 .. 2)
  546 -> +1656 Scale Y Mod       (-2 .. 2)   if 0 after parse -> copy +1652
  ```
  The range constants are the literal min/max passed to `createValueControlAdvanced`; `0xC0000000` is `-2.0f` (sign 1, exponent 0x80 = 2^1, zero mantissa).
  <sub>KeyframeAnimTriggerObject::customObjectSetup, gd-ida-decomp.cpp:300463-300556; KeyframeAnimTriggerObject::getSaveString, 321061-321152; SetupKeyframeAnimPopup::init, 694478-694717 (labels and ranges at 694586-694700)</sub>

- **Trigger 3033's own base keys are 51 -> +1276 (Target ID), 71 -> +1280 (Parent ID), 76 -> +1464 (Animation Group ID).** Parsed in `EffectGameObject::customObjectSetup`'s per-id switch: the 3033 arm reads 51 and 71 and then falls through to the shared `LABEL_345` that reads key 76 into +1464. The popup labels confirm all three, including that Parent ID is the rotation/scale centre.
  ```
  "By default, objects choose their own center for scaling and rotation,
   but you can set one using <cp>Parent ID</c>."
  ```
  <sub>EffectGameObject::customObjectSetup, gd-ida-decomp.cpp:298836-298847 and 299285-299290; SetupKeyframeAnimPopup::init, 694505-694511</sub>

- **The six multipliers rescale each keyframe's OFFSET FROM KEYFRAME 0, and Time Mod scales every segment duration.** Keyframe 0 is the anchor: it stores the raw first position/scale/rotation and emits scale 1.0. Every later keyframe is pulled toward or pushed away from keyframe 0 by the multiplier, and only when the multiplier differs from exactly 1.0. Scale is then converted to a *ratio* against the first keyframe's scale.
  ```
  // per keyframe, src = the KeyframeGameObject
  pos = src.getPosition(); sx = src.scaleX; sy = src.scaleY
  rx  = src.rotationX;     ry = src.rotationY
  normalizeKeyframeValues(sx, sy, rx, ry)         // negative-scale / 180-flip fixup
  if (i == 0) { first = {pos, sx, sy, rx}; sx = 1.0; sy = 1.0; rot = rx }
  else {
    if (posXMod != 1) pos.x = first.pos.x + (pos.x - first.pos.x) * posXMod
    if (posYMod != 1) pos.y = first.pos.y + (pos.y - first.pos.y) * posYMod
    if (sclXMod != 1) sx    = first.sx    + (sx    - first.sx)    * sclXMod
    if (sclYMod != 1) sy    = first.sy    + (sy    - first.sy)    * sclYMod
    if (rotMod  != 1) rot   = first.rx    + (rx    - first.rx)    * rotMod
    sx /= first.sx ;  sy /= first.sy                // scale becomes a ratio
  }
  kf.duration(+0)  = max(timeMod, 0.0001) * src.duration(+1264, key 10)
  kf.rotation(+312)= rot + 360 * src.x360(+1676, key 537)
  ```
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:489788-490244 (multiplier block 489995-490010, duration/rotation 490029-490036)</sub>

- **`normalizeKeyframeValues(scaleX, scaleY, rotX, rotY)` rewrites a negative-scale / mirrored transform into an equivalent positive-scale-plus-180-degree one before the keyframe is baked.** It is the only place a keyframe's raw transform is touched before deltas are taken.
  ```
  d = fabs(rotX - rotY)
  if (179.999 < d < 180.001) {                     // exactly mirrored on one axis
     if (fabs(rotX) > fabs(rotY)) { rotX -= sign(rotX)*180 ; scaleY = -scaleY }
     else                        { rotY -= sign(rotY)*180 ; scaleX = -scaleX }
  } else if (scaleX < 0 && scaleY < 0) {           // both flipped == a 180 turn
     rotX -= sign(rotX)*180 ; rotY -= sign(rotY)*180
     scaleX = -scaleX ; scaleY = -scaleY
  }
  ```
  (`sign(v)*180` here means `v <= 0 ? v + 180 : v - 180`.)
  <sub>normalizeKeyframeValues, gd-ida-decomp.cpp:474066-474119; called from createKeyframeCommand:489993</sub>

- **Keyframes are stored as DELTAS from the previous keyframe, so the runtime never needs absolute coordinates.** After the multipliers, every field except keyframe 0's is replaced by its difference from the previous keyframe; the absolute position is kept alongside at +288 purely so the Dist time mode can measure segment lengths.
  ```
  kf.deltaPos(+280) = pos - prevPos      kf.absPos(+288) = pos
  kf.dScaleX(+296) -= prevScaleX         kf.dScaleY(+304) -= prevScaleY
  kf.dRot(+312)    -= prevRot
  ```
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:490025-490026 (absolute) and 490068-490074 (deltas)</sub>

- **CCW/CW (key 536) forces the sign of a rotation delta; x360 (key 537) adds whole turns that the wrap-around must not eat.** The wrap test subtracts the `360 * x360` term first, so the forced turns survive.
  ```
  d    = rot_i - rot_(i-1)                 // already includes + 360*x360
  test = d - 360 * x360
  if (test >  180 || (test > 0 && cwccw == 2)) d -= 360
  if (test < -180 || (test < 0 && cwccw == 1)) d += 360
  kf.dRot(+312) = d
  ```
  Value 1 forces the delta positive, value 2 forces it negative; 0 takes the shortest arc. The popup exposes this as two toggles labelled "CCW" and "CW".
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:490072-490084; labels at SetupKeyframePopup::init, 695046-695061</sub>

- **Close Loop (key 376) re-processes keyframe 0 as an extra trailing keyframe, so the path returns to its start.** The loop counter is set to -1 at the last real keyframe and a one-shot latch breaks out after the duplicate is emitted. It also forces the "in-between" eligibility test true at the wrap.
  ```
  if (i == last) {
      if (closeLoop) { next = -1 ; latch = 1 }     // ++ makes it 0: re-emit keyframe 0
      else           { next = i  ; latch = 0 }
  } else next = i
  prev = src ; i = next + 1 ; if (latch after emit) break
  ```
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:490094-490115</sub>

- **Ref Only (key 375) marks a keyframe as an in-between: it is still a path point but it is skipped as an easing/segment boundary.** The flag is only honoured for a keyframe that is genuinely interior — index > 0 and (close-loop, or not the last).
  ```
  interior = (i > 0) && (closeLoop || i < count - 1)
  kf.inBetween(+16) = src.refOnly(+1652, key 375) && interior
  ```
  Downstream, `+16` suppresses that keyframe's own easing in both sampling loops.
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:490051-490065; reads at prepareMoveActions 486452 and 486559</sub>

- *(The "SpawnGID, SpawnDelay and Prox are written onto runtime keyframe `i-1`" bullet stood here. **Demoted** — it is now under "likely / demoted from certain", with the Close Loop exception noted.)*

- **Time mode (key 379) rewrites the durations of a run of Ref-Only keyframes: 0 = Time (leave them alone), 1 = Even (split equally), 2 = Dist (split by arc length).** A second pass over the baked vector collects each maximal run `[anchor, ref..., terminator]`, where the anchor is the last non-ref keyframe, and redistributes the anchor's duration across the run. The three toggle labels in the popup are literally "Time", "Even", "Dist".
  ```
  span = [anchor] + all consecutive refOnly kfs + [next non-ref kf]
  T    = anchor.duration ; j = span.length - 1
  mode 1 (Even): for (k = 0; k < j; ++k) span[k].duration = T / j
  mode 2 (Dist): for (k = 0; k < j; ++k) span[k].duration = ccpDistance(span[k].absPos, span[k+1].absPos)
                 total = sum of those ; for each: d = (total == 0) ? T/j : d / total * T
  mode 0 (Time): durations untouched
  anchor.easedSpan(+264) = (mode == 0) ? T + sum(refOnly durations) : T   // only if anchor.easing > 0
  ```
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:490120-490193; labels at SetupKeyframePopup::init, 695204-695218</sub>

- **The command's total duration is the sum of every keyframe's duration except the last one's.** The last keyframe's duration field is never consumed as a segment length.
  ```
  cmd.duration(+24) = sum(kf[i].duration for i in 0 .. n-2)
  ```
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:490194-490202</sub>

- *(The Curve run-grouping bullet stood here. **Demoted** — it is now under "likely / demoted from certain"; the run grouping is right, but the zero-length clear hits the PREVIOUS keyframe's flag.)*

- **`setupSpline` fits two independent natural cubic splines — cumulative Δx vs cumulative time and cumulative Δy vs cumulative time — and stores them on the FIRST keyframe of the run.** The parameter is cumulative duration, each segment clamped to at least 1e-5 so a zero-duration keyframe cannot produce a repeated knot.
  ```
  setupSpline(dst = run[0], run):
    n = run.length ; if (n <= 2) return
    X[0] = Y[0] = T[0] = 0
    for (k = 1; k < n; ++k):
       X[k] = X[k-1] + run[k].deltaPos.x(+280)
       Y[k] = Y[k-1] + run[k].deltaPos.y(+284)
       T[k] = T[k-1] + max(run[k-1].duration(+0), 0.00001)
    dst.splineX(+32)  = tk::spline(T, X, /*type*/30, /*monotonic*/false, 2, 0.0, 2, 0.0)
    dst.splineY(+144) = tk::spline(T, Y, 30, false, 2, 0.0, 2, 0.0)
    dst.splineLen(+256) = T[n-1]
  ```
  <sub>KeyframeObject::setupSpline, gd-ida-decomp.cpp:712204-712287</sub>

- **`tk::spline` type 30 with boundary type 2 and value 0 on both ends is the library's `cspline` with `second_deriv = 0` — a natural cubic spline — and `make_monotonic` is off.** The constructor stores `type` at +72, left bd_type at +76, left value at +88, right bd_type at +80, right value at +96, and only calls `make_monotonic` when its bool argument is set, which `setupSpline` passes as 0.
  <sub>tk::spline::spline(vector,vector,spline_type,bool,bd_type,double,bd_type,double), gd-ida-decomp.cpp:712074-712101</sub>
  (Checked for the numbers: `+72 = a4`, `+76 = a6`, `+80 = a8`, `+88 = a7`, `+96 = a9`, and
  `if (a5) make_monotonic(...)` with `setupSpline` passing `0`. Caveat on the *names*: `cspline` and
  `second_deriv` come from the upstream `tk::spline` header, not from the binary. What the binary shows
  is that `set_points` branches on `type == 10` (the linear case) and on `bd_type == 1` / `== 3`, with
  `2` falling through to the path that writes `boundary_value * 0.5` into `m_c[0]` / `m_c[n-1]` —
  which is the natural-spline behaviour when the value is 0. Consistent, but the enum spelling is
  borrowed, not read.)

- *(The `tk::spline::operator()(x)` bullet stood here. **Demoted** — it is now under "likely / demoted from certain"; the right-hand extrapolation drops the `m_c[n-1] * h` term and is quadratic, not linear. The corrected formula is `m_y[n-1] + (m_b[n-1] + m_c[n-1] * h) * h`.)*

- **A keyframe command is an ordinary `GroupCommandObject2` with type 5 at +208, and its target group is written to BOTH +40 and +44, so the animated group is also its own centre group.** It is appended to the same `GJEffectManager+792` vector every move/rotate/scale command lives in, so ordering and teardown are the existing machinery.
  ```
  cmd[+208] = 5
  cmd[+40]  = cmd[+44] = targetGroup
  cmd[+344] = trigger uniqueID      cmd[+348] = controlID
  cmd[+464] = remap vector<int>
  cmd[+456] = parent GameObject*    cmd[+460] = parent->vtable[176]()   (only if parent != null)
  cmd[+436/+440/+444] = vector<KeyframeObject>, element stride 336
  ```
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:489921-489935; type-5 dispatch in GJEffectManager::prepareMoveActions, 486201 and 486386</sub>

- **`KeyframeObject` is a 336-byte POD; this is its full layout.** Offsets are confirmed by cross-referencing the constructor's zero-fill, the writes in `createKeyframeCommand`, the reads in `prepareMoveActions`, and the two `tk::spline` sub-objects the destructor frees at +32 and +144.
  ```
  +0    double  duration of the segment that STARTS here   (key 10 * Time Mod)
  +8    int     easing type                                (key 30)
  +12   float   easing rate                                (key 85, default 2.0)
  +16   bool    in-between (Ref Only, interior)            (key 375)
  +20   int     spawn group id                             (key 71)
  +24   float   spawn delay                                (key 557, or 63)
  +28   bool    proximity spawn                            (key 377)
  +29   bool    runtime latch: this keyframe already fired its spawn
  +32   tk::spline  X(t)      (112 bytes)
  +144  tk::spline  Y(t)      (112 bytes)
  +256  double  spline parameter length (0 when there is no spline)
  +264  double  eased-span duration (0 unless this keyframe anchors an eased Ref-Only span)
  +272  int     time mode 0/1/2                            (key 379)
  +276  int     source KeyframeGameObject uniqueID (obj+772)
  +280  CCPoint delta position from the previous keyframe
  +288  CCPoint absolute position
  +296  double  delta of the scaleX ratio       (keyframe 0 holds 1.0)
  +304  double  delta of the scaleY ratio       (keyframe 0 holds 1.0)
  +312  double  delta rotation in degrees       (keyframe 0 holds its absolute rotation)
  +320  8 bytes, zeroed by the constructor, no read or write found
  +328  float   line opacity = (obj.opacity/255) * key 524
  +30   bool    curve                                      (key 378)
  ```
  The constructor's non-zero defaults decode as: `+296 = +304 = 0x3FF0000000000000` = `1.0` (double), `+328 = 1065353216` = `0x3F800000` = `1.0f`, and `+104/+108/+112` = `30/2/2` and `+216/+220/+224` = `30/2/2` are the two splines' own `spline_type` / left `bd_type` / right `bd_type` fields at sub-object offset +72/+76/+80.
  <sub>KeyframeObject::KeyframeObject, gd-ida-decomp.cpp:475572-475637; writes in createKeyframeCommand, 489981 and 490024-490038; destructor frees splines at +144 and +32, 480625-480634</sub>

- **Sampling runs in two passes each tick: pass one finds WHERE on the path we are (applying per-keyframe easing), pass two walks from keyframe 0 accumulating deltas.** `cmd+32` is the raw elapsed time; `pathT` is the eased position along the path in un-eased units; `rem` is the leftover inside the landing keyframe.
  ```
  cmd.elapsed(+32) += dt
  rem = cmd.elapsed ; pathT = 0 ; land = null
  for (i = 0; i < n - 1; ++i):
     k = kf[i]
     if (k.easedSpan(+264) > 0 && rem < k.easedSpan):
         rem = getEasedValue(rem / k.easedSpan, k.easing(+8), k.easeRate(+12)) * k.easedSpan
     if (rem < k.duration || i == n - 2) { pathT += rem ; land = k ; break }
     rem   -= k.duration
     pathT += k.duration
  ```
  <sub>GJEffectManager::prepareMoveActions, gd-ida-decomp.cpp:486403-486421 (getEasedValue at 486411)</sub>

- *(The "pass two produces an ABSOLUTE accumulated position" bullet stood here. **Demoted** — it is now under "likely / demoted from certain"; the loop body survives, but the transform emit has a second gate (`fabs(sx) >= 0.01 && fabs(sy) >= 0.01`) and `+216/+224` are not updated when it is skipped.)*

- **When a keyframe run has a spline, the spline REPLACES the linear position accumulation for that whole run; scale and rotation stay linear-per-segment either way.** The spline is evaluated at a path time that is itself remapped by the landing keyframe's easing, so easing and curving compose.
  ```
  if (k.splineLen(+256) > 0 && pathT < k.splineLen):
     if (land == null || rem >= land.duration || land.easing <= 0
         || land.inBetween(+16) || land.easedSpan(+264) > 0)
          u = pathT ; prox = false
     else {
          e = getEasedValue(rem / land.duration, land.easing, land.easeRate)
          u = pathT - rem + e * land.duration
          prox = land.proximity(+28) ? (e > 0.95) : land.proximity
     }
     p.x += k.splineX(+32)(u)
     p.y += k.splineY(+144)(u)
     usedSpline = true
  ```
  <sub>GJEffectManager::prepareMoveActions, gd-ida-decomp.cpp:486447-486496</sub>

- **Prox (key 377) makes a keyframe fire its spawn early — at 95% of the segment — instead of on arrival.** The same 0.95 test appears on both the spline branch and the linear branch.
  ```
  if ((k.proximity(+28) && f > 0.95) || prox) goto fireSpawn
  ```
  and on the fire path, guarded by a one-shot latch:
  ```
  fireSpawn:
    f = 1.0
    if (!k.fired(+29)) {
       k.fired = 1
       if (k.spawnGroup(+20) > 0) pending.push({k.uniqueID(+276), k.spawnDelay(+24), k.spawnGroup(+20)})
    }
  ```
  At the end of the tick each pending triple becomes `spawnGroup(group, delay, false, remap, keyframeUniqueID, cmd.controlID(+348))` when the delay is > 0, or an immediate layer call when it is <= 0.
  <sub>GJEffectManager::prepareMoveActions, gd-ida-decomp.cpp:486484-486494, 486502-486556, 486688-486706</sub>

- *(The editor-preview bullet stood here. **Demoted** — it is now under "likely / demoted from certain"; the six `1.0`s are literal, but the target group argument is the literal `0`, not the target group.)*

- **`Time Mod` is clamped once, at command build time, to a minimum of 0.0001, and it multiplies every keyframe's duration.** There is no clamp on the other five.
  ```
  timeScale = (timeMod < 0.0001) ? 0.0001 : timeMod
  kf.duration = timeScale * src.duration(+1264)
  ```
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:489906-489910 and 490031</sub>

### what the correction pass re-read and left standing

Every bullet still in this section was checked against the exact cited range. The ones without their
own "(Checked…)" note came through verbatim; the notable confirmations:

- The key -> offset tables for **both** classes were cross-checked in *four* places each
  (`customObjectSetup` reading `a2[key*4]`, `getSaveString` emitting the key, the popup's
  `createValueControlAdvanced(key, …)` calls, and the consumer in `createKeyframeCommand`).
  No level-file key was confused with a struct byte offset anywhere in the file.
- Float constants re-decoded by hand: `0xC0000000` = `-2.0f` (sign 1, exponent 0x80 → 2^1, zero
  mantissa); `1065353216` = `0x3F800000` = `1.0f` at `KeyframeObject+328`;
  `0x3FF0000000000000` = `1.0` double at `+296` and `+304`. All three are as the file says.
  The editor ranges are also literal: key 520 is `(0, 1.0)`, keys 521/545/522/523/546 are
  `(0xC0000000, 2.0)`.
- `normalizeKeyframeValues` matches line for line, including the `179.999 < d < 180.001` window and
  the `v <= 0 ? v + 180 : v - 180` sign convention. Its four parameters are `double*`, so IDA did
  not drop anything — but the vtable slots that *fill* them (+68/+76/+184/+192/+672) are still
  unresolved, which is why that identification stays under *likely*.
- The CCW/CW mapping is confirmed from both ends: `createKeyframeCommand` tests `obj[+1672] == 2` to
  force the delta negative and `== 1` to force it positive, and `SetupKeyframePopup::init` creates
  the "CCW" toggle with value `2` and the "CW" toggle with value `1`.
- The Time/Even/Dist redistribution, the `anchor.easedSpan = T + sum(refOnly durations)` for mode 0
  versus `T` for modes 1/2, the `n-1`-term total duration, the Close Loop latch, the Ref Only
  interior test, the delta bake, `setupSpline`, the `GroupCommandObject2` offsets and the type-5
  stride of 488 / `KeyframeObject` stride of 336 are all exactly as written.

## likely

### demoted from "certain" by the correction pass

- **The ordered list is built from key 373 (group) and key 374 (index), not from key 71.** `addKeyframe` looks up `layer+11272` (`CCDictionary`, dword index 2818) by the object's key-373 value, then inserts at the key-374 position, appending instead when that index is past the end. `updateKeyframeOrder` re-walks the array and writes each element's array position back into `+1648`, so key 374 is normalised to a dense 0..n-1 ordinal every time the set changes.
  ```
  addKeyframe(kf):
    kf[+1669] = 1                                  // "registered" flag
    arr = layer.keyframeGroups[kf.keyframeGroup(+1644)]
    if (!arr) return
    if (kf.keyframeIndex(+1648) >= arr.count) arr.addObject(kf)
    else arr.insertObject(kf, kf.keyframeIndex)
    updateKeyframeOrder(kf.keyframeGroup)

  updateKeyframeOrder(group):
    arr = layer.keyframeGroups[group]; if (!arr || !arr.count) return
    first = arr[0]; baseZ = first[+1030] (i16); autoLayer = first[+1670]
    for (i = 0; i < arr.count; ++i):
       arr[i][+1648] = i                           // key 374 rewritten from position
       arr[i][+1670] = autoLayer
       if (autoLayer) { arr[i][+1032] = baseZ + 1 + i ; arr[i][+1030] = baseZ }
  ```
  <sub>GJBaseGameLayer::addKeyframe, gd-ida-decomp.cpp:428895-428917; GJBaseGameLayer::updateKeyframeOrder, 428838-428880; GJBaseGameLayer::removeKeyframe, 428932-428950</sub>
  (**Demoted.** The two pseudocode blocks are transcribed correctly — I re-read all three functions
  and every offset matches. What does not survive is the *scope*: `addKeyframe`'s only caller is
  `LevelEditorLayer::addKeyframe` (186089), so this is the editor's incremental path, and it is not
  how a loaded level's arrays are built. Worse, insert-at-374 does not even reproduce the right order
  from a level file: feeding level 5003's group 2 in its stored order `[7 6 5 4 2 1 0 3]` through
  `insertObject(kf, 374)` yields `[0 7 1 3 6 2 5 4]`, and `updateKeyframeOrder` would then bake that
  wrong order in by rewriting 374 from position. The load path is the new *certain* bullet above:
  `refreshKeyframeAnims` appends and then `qsort`s by key 374. Also note `addKeyframe` returns early
  when the dictionary has no array for that key — it never creates one — which is another sign it is
  an editor-only helper sitting behind `createNewKeyframeAnim`.)

- **SpawnGID, SpawnDelay and Prox are read from source keyframe `i` but written onto runtime keyframe `i-1`, which is what makes a spawn fire on ARRIVAL at the keyframe that carries it.** The runtime fires `kf[j]`'s spawn when segment `j` completes, i.e. on reaching keyframe `j+1`; shifting the fields back by one lines the two up. The consequence is that a SpawnGID authored on keyframe 0 is silently dropped, because there is no keyframe -1 to hold it.
  ```
  // inside the bake loop, prev = keyframes[i-1], src = source object i
  if (i > 0) {
     prev.spawnGroup(+20) = src.key71(+1280)
     prev.proximity(+28)  = src.key377(+1653)
     prev.spawnDelay(+24) = src.key557(+1664)
  }
  ```
  The uniqueID that accompanies the spawn is taken from the *firing* keyframe's own `+276` (its own source object's `+772`), not from the object that supplied the group id.
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:490086-490088 and 489981; fire site at GJEffectManager::prepareMoveActions, 486516-486518 and 486547-486549</sub>
  (**Demoted for the last sentence only.** The shift itself is real and the offsets check out: the
  writes go to `v58 = keyframes.begin + 336 * v14`, and `v14` is the *previous* loop index, set by
  `v14 = v37` at the bottom of the iteration. The guard is not `if (i > 0)` but `if (v38)`, where
  `v38` is the previous source object pointer — the same thing on the first pass, but **not** at a
  Close Loop wrap: when Close Loop re-runs source index 0 as the trailing duplicate, `v38` is still
  the last real object, so keyframe 0's key 71 / 377 / 557 *are* consumed and land on the **last**
  runtime keyframe. So "silently dropped" holds only when Close Loop is off. In the official levels
  this is nearly moot — key 71 appears on 18 of 468 keyframe objects and 557 on 3.)

- **Curve (key 378) groups consecutive curve-flagged keyframes into one natural cubic spline; a run that is too short is silently demoted back to linear.** A curve flag on the last keyframe is ignored. A curve flag is also cleared when a keyframe and its predecessor share a position, because a zero-length segment would break the parameterisation.
  ```
  run = []
  for (i = 0; i < n; ++i):
     if (kf[i].curve(+30) && i < n - 1) { run.push(&kf[i]); continue }
     if (run.empty()) continue
     if (run.length <= 1)  for (k in run) k.curve = 0          // demote, stay linear
     else { run.push(&kf[i]) ; KeyframeObject::setupSpline(run[0], run) }
     run.clear()
  ```
  `<= 1` is written as a byte comparison `(end - begin) <= 7` on a vector of 4-byte pointers, so a run needs at least two curve-flagged keyframes (three points with the terminator) — exactly the `> 2` guard inside `setupSpline`.
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:490203-490240; zero-length clear at 490040-490045</sub>
  (**Demoted for the zero-length sentence.** The run-grouping block, the `(end - begin) <= 7` reading
  and the `i < n - 1` guard are all exactly as written — verified line by line, and `setupSpline`'s
  guard really is `if (v3 > 2)`. But the zero-length clear at 490039-490045 writes
  `*(_BYTE *)(v58 + 30) = 0` where `v58 = begin + 336 * v14` — the **previous** keyframe, not the
  current one. So when keyframe `i` and keyframe `i-1` share a position it is keyframe `i-1`'s curve
  flag that is cleared, which is what splits the run *before* the degenerate segment rather than
  after it. Anyone implementing "clear this keyframe's flag" gets a different run split.)

- **`tk::spline::operator()(x)` is the stock piecewise cubic with linear/quadratic extrapolation outside the knots.**
  ```
  i = find_closest(x) ; h = x - m_x[i]
  if (x < m_x[0])        return m_y[0]   + (m_b[0]   + m_c0  * h) * h
  if (x > m_x[n-1])      return m_y[n-1] + (m_b[n-1]        ) * h
  else                   return m_y[i]   + (m_b[i]   + (m_c[i] + m_d[i] * h) * h) * h
  ```
  (Field offsets in the object: m_x at +0, m_y at +12, m_b at +24, m_c at +36, m_d at +48, m_c0 at +64.)
  <sub>tk::spline::operator()(double) const, gd-ida-decomp.cpp:727327-727370</sub>
  (**Demoted — the right-hand branch is wrong.** The offsets and the interior branch are right, and
  the left branch is right. But the `x > m_x[n-1]` case reads
  `v12 = *(double *)((char *)v8 + v14) + v11 * *(double *)(v15 + v14)` where `v8` is `m_b` and `v15`
  is `m_c`, so the real formula is
  `m_y[n-1] + (m_b[n-1] + m_c[n-1] * h) * h` — **quadratic on both sides**, not linear on the right.
  Since `setupSpline` stores the spline's parameter length at `+256` and the sampler only evaluates
  while `pathT < splineLen`, the right branch is normally unreachable; but the two branches were
  described as different when they are the same shape, and a port that copies the block as written
  will drift at the end of a curve run.)

- **Pass two produces an ABSOLUTE accumulated position, scale and rotation, which is then differenced against the previous tick's values and handed to the normal move / rotate / transform machinery.** Position starts at `CCPointZero`, scales at 1.0, rotation at 0.
  ```
  p = (0,0) ; sx = 1.0 ; sy = 1.0 ; rot = 0.0 ; t = pathT ; usedSpline = false
  for (i = 0; i < n - 1; ++i):
     k = kf[i] ; nxt = kf[i+1]
     ... spline branch (see below) ...
     last = (i == n - 2) && cmd.elapsed < cmd.duration(+24)
     if (t >= k.duration && !last) f = 1.0
     else {
        f = t / k.duration
        if (k.easing > 0 && !k.inBetween(+16) && k.easedSpan(+264) <= 0)
            f = getEasedValue(f, k.easing, k.easeRate)
     }
     if (!usedSpline) { p.x += f * nxt.deltaPos.x ; p.y += f * nxt.deltaPos.y }
     sx  += f * nxt.dScaleX(+296)
     sy  += f * nxt.dScaleY(+304)
     rot += f * nxt.dRot(+312)
     if (t < k.duration) break
     t -= k.duration

  moveDelta = p - cmd.lastPos(+448) ; cmd.lastPos = p
  rotDelta  = rot - cmd.lastRot(+232) ; cmd.lastRot = rot
  if (sx != cmd.lastScaleX(+216) || sy != cmd.lastScaleY(+224)) emit a transform command
  if (cmd.elapsed >= cmd.duration) cmd.finished(+112) = 1
  ```
  Note the deltas come from `kf[i+1]`, never `kf[i]` — keyframe `i` owns the *duration* of the segment, keyframe `i+1` owns the *displacement*.
  <sub>GJEffectManager::prepareMoveActions, gd-ida-decomp.cpp:486422-486680 (getEasedValue at 486464 and 486563)</sub>
  (**Demoted for the scale line.** The loop body, the `kf[i+1]` observation, the `last` test, the
  easing guard, `+448`, `+232` and `+112` all check out. The scale emit is gated twice, not once:
  ```
  if (cmd.temp(+114) || (fabs(sx) >= 0.01 && fabs(sy) >= 0.01)) {
     if (sx != cmd.lastScaleX(+216) || sy != cmd.lastScaleY(+224) || cmd.temp) emit
     ...
  } else skip = 1
  cmd.lastPos(+448) = p
  if (!skip) { cmd.lastScaleX(+216) = sx ; cmd.lastScaleY(+224) = sy }   // NOT updated when skipped
  ```
  A run whose accumulated scale ratio passes through |value| < 0.01 on either axis emits nothing
  *and* leaves `+216/+224` stale, so the next tick diffs against an old value. Also the move branch
  is gated on `moveDelta != (0,0) || cmd.temp`, and the rotate branch on `rotDelta != 0 || cmd.temp`,
  neither of which the block mentions.)

- **The editor's own preview builds the identical command with all six multipliers hard-coded to 1.0 and the temp-command flag set.** This is the reference for "neutral" multiplier values.
  ```
  createKeyframeCommand(targetGroup, /*arr*/kfArray, /*parent*/null, 0, 0, /*temp*/true,
                        1.0, 1.0, 1.0, 1.0, 1.0, 1.0, emptyVector)
  ```
  <sub>LevelEditorLayer keyframe preview, gd-ida-decomp.cpp:198003-198018</sub>
  (**Demoted for the first argument.** The six `1.0`s and `temp = true` are literal in the call, so
  the "neutral is 1.0" conclusion stands. But the target group passed is the literal `0`, not the
  target group: the call is `createKeyframeCommand(this[+1644], 0, v35, 0, 0, 0, 1, 1.0 x6, &v200)`.
  The preview therefore drives no group at all — it reads the baked `KeyframeObject` vector straight
  out of the returned command, which is what the loop at 198020 onwards does.)

### originally filed as likely

- **Vtable slot +68 is `getScaleX`, +76 `getScaleY`, +184 `getRotationX`, +192 `getRotationY`, and +672 returns the keyframe object's position as a `CCPoint`.** The identification comes from `normalizeKeyframeValues`'s use of its four arguments — the first two are compared against 0 for sign and negated, the last two are shifted by +/-180 degrees and tested for a 180-degree separation — plus the fact that the third argument (slot +184) is the value that becomes the keyframe's rotation and the fourth is discarded after normalisation. I did not resolve the vtable itself.
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:489983-489993; normalizeKeyframeValues, 474066-474119</sub>

- **An absent multiplier key parses as 0.0, not 1.0, and 0.0 is NOT treated as neutral at runtime — a hand-written 3033 trigger with no 520/521/522/523/545/546 would collapse its animation.** `customObjectSetup` writes `0.0` whenever the key is missing, `getSaveString` omits any multiplier that is exactly `0.0`, and `createKeyframeCommand` guards each multiplier with `!= 1.0`, so a 0 multiplier is applied as a real zero (durations clamp to 0.0001, positions/scales collapse onto keyframe 0). In practice every editor-saved trigger carries all six because the popup's controls are seeded to 1.0 — but I did not find the code that seeds them, so I cannot rule out a defaulting step somewhere in `SetupTriggerPopup`.
  <sub>KeyframeAnimTriggerObject::customObjectSetup, gd-ida-decomp.cpp:300463-300556; KeyframeAnimTriggerObject::getSaveString, 321061-321152; guards at createKeyframeCommand, 489999-490021</sub>

- **`+328` (line opacity, key 524) is written for the editor's path-line rendering and is not read by the gameplay sampler.** It is computed as `(obj.opacity(+1140) / 255) * key524` in `createKeyframeCommand`, but no read appears anywhere in the type-5 branch of `prepareMoveActions`. The popup control is labelled "LineOpacity", which fits a path-preview line.
  <sub>GJEffectManager::createKeyframeCommand, gd-ida-decomp.cpp:490038; label at SetupKeyframePopup::init, 695174</sub>

- **`Preview Art` (key 380, +1668) and `Auto Layer` (key 459, +1670) are editor-only.** +1668 is read only inside `KeyframeGameObject::updateShadowObjects` (the editor's ghost-object preview), and +1670 is read only by `updateKeyframeOrder` to assign z-order. Neither appears in `createKeyframeCommand` or `prepareMoveActions`.
  <sub>KeyframeGameObject::updateShadowObjects, gd-ida-decomp.cpp:311724-311800 (+1668 test at 311752); GJBaseGameLayer::updateKeyframeOrder, 428859-428872</sub>

- **When the keyframe command has a parent object that is itself rotated or scaled, the position delta is routed through `addMoveCalculation` so the parent's transform is applied to it.** The gate reads three floats on the parent object (+576, +592, +596) and only takes the path when one is non-zero; `trigger-semantics.md:627` already covers what `addMoveCalculation` does. I did not identify those three fields by name.
  <sub>GJEffectManager::prepareMoveActions, gd-ida-decomp.cpp:486388-486392 and 486596-486602</sub>

## Not established

- **What `KeyframeObject+320` holds.** The constructor zeroes it (`*((_QWORD *)this + 40) = 0`) and I found no other write and no read anywhere in `createKeyframeCommand`, `setupSpline` or `prepareMoveActions`. It sits between the rotation delta at +312 and the line opacity at +328, so it is probably a fourth transform channel that was never wired up, but that is a guess.

- **What `GroupCommandObject2+460` is for.** `createKeyframeCommand` fills it from `parent->vtable[176]()` when a parent object exists, and nothing in the type-5 branch reads it back. The vtable slot is unresolved.

- **The initial values of `GroupCommandObject2+216` and `+224` (previous scaleX/scaleY).** The command is default-constructed by `std::vector<GroupCommandObject2>::emplace_back` and `createKeyframeCommand` never writes those two, so the first tick's `sx != cmd+216` test depends on a constructor I did not read. If they are zero, the first tick always emits a transform command; if they are 1.0, it does not.

- **Whether the trigger's Target ID (key 51) can address a group that does not contain the keyframe objects.** `playKeyframeAnimation` falls back to the *keyframe object's* key 51 when the trigger's is 0, which implies the keyframe object's GroupID is the normal way to name the animated group and the trigger's Target ID is an override — the help text says as much — but I did not trace what happens when the two disagree.

- **`GroupCommandObject2+232`'s role in the emitted transform command.** Pass two copies `kf[0].dRot(+312)` (which for keyframe 0 is its absolute rotation, not a delta) into the transform command at its +232 when `i == 0`. Given `trigger-semantics.md:505`, that slot is plausibly the angle the scale axes are taken along, but I did not confirm it against `stepTransformCommand`.

- **How key 63 and key 557 are meant to differ for SpawnDelay.** The parser writes key 557 into +1664 and then *overwrites* it from key 63 whenever key 63 parses non-zero, so 63 wins. Only 557 is written back out by `getSaveString`. I did not find the migration that would explain the pair.
  (Still unresolved. Neither key is common enough in the official levels to settle it from data: 557
  appears on 3 of 468 keyframe objects and 63 on none.)

- **What the immediate (delay <= 0) spawn call actually reaches.** `prepareMoveActions` does
  `v106 = *((_DWORD *)this + 66)` — `GJEffectManager+264` — and then calls `(*(vtable + 4))(v106, group, 0)`.
  Neither the object's type nor the slot is resolved. The earlier text called it "the layer"; that was
  a guess, and it is treated here as not established. *(Added by the correction pass.)*

- **Whether `refreshKeyframeAnims`'s renumbering can ever change behaviour.** It rewrites `+1644` from
  the authored key 373 to a dense counter, so a level whose 373 values have gaps is compacted. Every
  official level's 373 values already form `0..m-1`, so the renumbering is the identity there and I
  could not observe the gapped case. It matters if anything else reads `+1644` expecting the authored
  value. *(Added by the correction pass.)*

## Checked against the levels

The two web sources disagreed about how keyframes are indexed: Geode's bindings say property **373**
(keyframe group) and **374** (keyframe index); flowvix's property explorer says ordering comes from a
`spawn_gid` / `spawn_delay` chain with no index key at all. Settled here against the real level files
(`D:/Proxy/Geometry Dash/Resources/levels/*.txt`, read through `loadOfficialLevel`), scanning every
official level for object id **3032** (keyframe object) and **3033** (Keyframe Animation trigger).

**Geode is right. flowvix is wrong.** Key 374 is present, it is a dense per-group index, and it is
what the runtime sorts on. There is no spawn chain.

Keyframe objects exist in exactly five official levels — 22 and 5001-5004 — for **468** keyframe
objects and **85** trigger-3033 objects in total.

| level | 3032 | 3033 | 373 | 374 | 51 | 71 | 557 | 537 | 378 | 536 | 379 | 377 | 375 | 376 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 22 Dash | 10 | 1 | 0 | 9 | 10 | 0 | 0 | 0 | 10 | 0 | 10 | 0 | 9 | 0 |
| 5001 The Tower | 16 | 11 | 13 | 11 | 16 | 0 | 0 | 0 | 14 | 0 | 10 | 0 | 11 | 6 |
| 5002 The Sewers | 37 | 6 | 29 | 31 | 37 | 0 | 0 | 0 | 33 | 0 | 30 | 0 | 31 | 2 |
| 5003 The Cellar | 243 | 36 | 234 | 204 | 243 | 2 | 0 | 0 | 205 | 0 | 225 | 2 | 184 | 16 |
| 5004 The Secret Hollow | 162 | 31 | 139 | 142 | 162 | 16 | 3 | 1 | 66 | 1 | 138 | 6 | 96 | 7 |
| **total** | **468** | **85** | **415** | **397** | **468** | **18** | **3** | **1** | **328** | **1** | **413** | **8** | **331** | **31** |

Counts are "how many of that level's keyframe objects carry the key at all". Values observed:

- **373** keyframe group: `1 … 38`. Absent means 0 (`getSaveString` omits a zero), so every object has
  a group. 71 distinct groups across the five levels.
- **374** keyframe index: `1 … 22`. Absent means 0, again by omission. **In all 71 groups the set of
  374 values is exactly `0 … n-1` with no duplicates and no gaps** — a dense authored ordinal, as the
  binary says.
- **51** GroupID: on 100% of keyframe objects (468/468). This is the group that gets animated.
- **71** SpawnGID: 18/468, values are unrelated group ids (8, 12, 95, 96, 332, 333, 369, 383-388,
  515, 518, 521, 524). **They do not chain** — no keyframe's 71 points at another keyframe, and the
  values do not form a path. **557** SpawnDelay: 3/468 (`0.1`, `0.3`). **377** Prox: 8/468.
- **378** Curve: 328/468, always `1`. **375** Ref Only: 331/468, always `1`. **376** Close Loop:
  31/468, always `1`. **379** time mode: 413/468, values `1` (Even) and `2` (Dist).
- **536** CCW/CW: 1/468, value `2` (CCW). **537** x360: 1/468, value `-1`.
- Other keys these objects carry: `1,2,3,4,5,6,10,20,30,36,57,61,85,108,128,129,131,132,135,155,380,459,524`.
- Trigger 3033 objects carry `76` (Animation Group) on all of them, `51` on a few, `71` on a few, and
  all six multipliers `520/521/545/522/523/546` written explicitly — normally all `1`, with a handful
  in 5003 at `0.2 / 0.4 / 0.7 / 0.8`. That is consistent with the *likely* bullet that says an absent
  multiplier parses as `0.0` and would collapse the animation: the editor never omits them.

**The detail that decides the mechanism.** 26 of the 71 groups are stored in the level file in an
order that is *not* their 374 order. Examples:

```
5001  373=1   file order [2 1 0]
5003  373=2   file order [7 6 5 4 2 1 0 3]
5003  373=25  file order [10 9 8 7 6 5 4 3 2 1 0 11 14 13 12]
5004  373=0   file order [0 3 4 5 6 2 7 8 9 10 14 11 13 15 16 17 19 12 18 20 21 22 1]
```

So the runtime cannot be using file order, and it cannot be using the `addKeyframe` insert-at-374 path
either: running `5003 373=2` through `insertObject(kf, kf[374])` in file order produces
`[0 7 1 3 6 2 5 4]`. Only a sort by key 374 reproduces the authored path — which is exactly what
`refreshKeyframeAnims` does with `compShadowCopy`. That is the correction at the top of this file.
