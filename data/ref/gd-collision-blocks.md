# Collision blocks, read out of the 2.206 decompile

Extracted from `data/ref/gd-ida-decomp.cpp` (41 MB of IDA pseudo-C from the GD 2.206 Android
binary). Line numbers are into that file, so every claim below can be checked:
`sed -n '426057,426372p' data/ref/gd-ida-decomp.cpp`. Confidence is the reader's own:
**certain** means the code was read and says this, **likely** means the structure says it but a
name or a field was inferred, **Not established** means IDA dropped it or I could not resolve it.

> **Re-read, hostile pass.** Every "certain" bullet was checked back against the cited lines, every
> level-file key was checked to be a key and not a struct offset, and the float constants were
> re-decoded. Six bullets moved down to "likely" and four were corrected in place; each says so
> where it sits. The property-key table in section D and all of section E survived unchanged. The
> claims were also checked against the official level data — see "Checked against the levels".

This file covers only collision blocks (1816), the Collision trigger (1815), Instant Collision
(3609) and the 3640 state block; scheduling, movement, colour and camera are in
`trigger-semantics.md` and are not repeated here.

The collision-block system in 2.206 is a **narrow-phase over ID pairs, not over objects**. Each
1816 object carries an integer `block id` (level key 80, struct offset obj+1492); a block is either
*static* or *dynamic* (key 94, obj+1489), and only dynamic blocks are in the layer's
`m_collisionBlocks` array. Once per physics sub-step `updateCollisionBlocks` sweeps every dynamic
block against the collision-block section grid, and for each overlapping pair calls
`objectsCollided(idA, idB)`. That hashes `max*10000 + min` into one `unordered_map<int,bool>` on
`GJEffectManager`: inserting the key is the *enter* event, refreshing its bool is *still touching*,
and `postCollisionCheck` erases every key whose bool was not refreshed this sub-step — that erase is
the *exit* event. Because the key is built from the two **ids**, not the two objects, ten blocks
sharing id 5 that all touch id 7 produce exactly one enter and one exit. The rectangle used is the
object's ordinary cached `CCRect` (base hitbox × scaleX/scaleY × custom scale, centred on
position + box offset, with a w/h swap flag for quarter turns), plus a two-way SAT test on an
oriented box whenever either side is flagged oriented — which needs a free-rotating object at a
rotation that is not a multiple of 90 with obj+756 <= 0, *or* is simply always true for the two
player blocks, which are rebuilt as oriented every sub-step. The player is in this system as
two ordinary 1816 GameObjects that track player 1 and player 2 each sub-step and carry the reserved
block ids **10000** and **10001**; `P1`/`P2`/`PP` on the triggers are literally substitutions of
those two numbers. Every property key the independent source listed for 1816, 1815 and 3609 is
confirmed against both the parser and the save-string writer. The 3640 block is a different
mechanism entirely — a touch-driven "powered" latch on the object, drained by
`processStateObjects`, that spawns group 51 while touched and group 71 on the sub-step it stops
being touched.

## certain

### A — how the rectangle is derived

- **The AABB used for collision blocks is `GameObject`'s ordinary cached rect at obj+708, recomputed lazily when the dirty byte obj+724 is set.** `getObjectRectPointer` recomputes through vtable+656 and then hands back `&obj[708]`, i.e. `{x@708, y@712, w@716, h@720}` as four floats.

  ```
  getObjectRectPointer(obj):
      if (obj[724]) obj->getObjectRect();      // vtable+656
      return (CCRect*)&obj[708];
  ```

  <sub>GameObject::getObjectRectPointer, gd-ida-decomp.cpp:167174-167179</sub>

- **The non-rotated form: size = baseHitbox * customScale * nodeScale, centred on position + boxOffset, with an unconditional w/h swap when obj+760 is set.** `obj+648`/`obj+652` are the base hitbox width/height from the object definition; `obj+1000`/`obj+1004` are the custom scale (absolute-valued when obj+729 is set); `obj+764`/`obj+768` are scaleX/scaleY. IDA passes the object as `a2` here and the two scales as `a3`/`a4`, with `this` as the sret buffer.

  ```
  sx2 = obj[1000]; sy2 = obj[1004];
  if (obj[729]) { sx2 = fabsf(sx2); sy2 = fabsf(sy2); }
  w = obj[648] * sx2 * scaleX;   h = obj[652] * sy2 * scaleY;
  off = getBoxOffset(obj);
  if (obj[760]) swap(w, h);
  c = obj->getPosition() + off;                       // vtable+672
  rect = CCRect(c.x - w*0.5, c.y - h*0.5, w, h);
  ```

  <sub>GameObject::getObjectRect(float,float), gd-ida-decomp.cpp:170812-170847; scales fed in by GameObject::getObjectRect() from obj+764/obj+768 at :163366-163372</sub>

- **An object becomes "oriented" only when it can rotate freely, its integer rotation is not a multiple of 90, and obj+756 is <= 0.** `calculateOrientedBox` sets obj+636 = 1 unconditionally and rebuilds the box; `updateIsOriented` is what decides whether to call it.

  ```
  updateIsOriented(obj):
      obj[636] = 0;
      if (obj[776] == 7) return;                 // object type 7 is excluded
      if (!canRotateFree(obj)) return;
      r = (int)obj->getRotation();                // vtable+176
      if (r % 90 != 0 && obj[756] <= 0.0) calculateOrientedBox(obj);   // sets obj[636] = 1
  ```

  <sub>GameObject::updateIsOriented, gd-ida-decomp.cpp:170705-170727; GameObject::calculateOrientedBox :170660-170666</sub>

- **The size terms fed to the OBB are the same as the plain rect's, but with no abs() and no 90° swap, and the degrees→radians factor in the binary is the truncated literal `0.017453`, not `M_PI/180` (= 0.01745329…); the sign is negated.** (What is *read* here is the arithmetic. Where the angle comes from is not — see "likely".)

  ```
  c = obj->getPosition() + getBoxOffset(obj);
  w = obj[648] * obj[764] * obj[1000];
  h = obj[652] * obj[768] * obj[1004];
  obb->calculateWithCenter(c, w, h, -(vtable_780(obj) * 0.017453));
  ```

  <sub>GameObject::updateOrientedBox, gd-ida-decomp.cpp:170862-170910</sub>

- **`computeAxes` normalises the two axes so the box projects onto exactly [origin, origin+1] on each.** It divides each edge vector by its *squared* length and stores `origin = axis · corner0` as a double at +360 and +368.

  ```
  axis0 = corner[1]-corner[0] @+328 ;  axis1 = corner[3]-corner[0] @+336
  axis_i /= |axis_i|^2 ;  origin_i = axis_i . corner[0]   (double @+360, @+368)
  ```

  <sub>OBB2D::computeAxes, gd-ida-decomp.cpp:49417-49441</sub>

- **`OBB2D::overlaps1Way` is one-directional SAT over those two axes, rejecting when the other box's projection is outside [origin, origin+1].** The `+ 1.0` is the normalisation above, not a fudge factor. A full overlap test needs both directions.

  ```
  for axis in (0,1):
      lo = hi = dot(axis, other.corner[0]);
      for k in 1..3: p = dot(axis, other.corner[k]); lo = min(lo,p); hi = max(hi,p);
      if (lo > origin[axis] + 1.0 || hi < origin[axis]) return false;
  return true;
  ```

  <sub>OBB2D::overlaps1Way, gd-ida-decomp.cpp:49717-49761</sub>

- **The per-pair test in `checkCollisionBlocks` is an inclusive AABB overlap first, a uniqueID inequality second, and a two-way SAT only if at least one side is oriented.** `&&` binds tighter than `||` in the decompiled condition, so the reading is `(!A.oriented && !B.oriented) || (SAT(A,B) && SAT(B,A))` — if *either* side is oriented, both SAT calls must pass.

  ```
  for each candidate B in cell (first `count` entries):
      if (B[550]) continue;                              // group-disabled
      rb = getObjectRectPointer(B);                      // {x,y,w,h}
      if (!(A.maxX >= rb.x && rb.x + rb.w >= A.minX)) continue;
      if (!(A.maxY >= rb.y && rb.y + rb.h >= A.minY)) continue;
      if (B[772] == A[772]) continue;                    // same object, by uniqueID
      if ((!A[636] && !B[636]) || (overlaps1Way(A.obb, B.obb) && overlaps1Way(B.obb, A.obb)))
          layer->vtable[604](layer, A[1492], B[1492]);   // the two BLOCK IDS
  ```

  <sub>GJBaseGameLayer::checkCollisionBlocks, gd-ida-decomp.cpp:421606-421658</sub>

- **The comparisons are `>=`, so blocks whose edges exactly touch count as overlapping.**

  <sub>GJBaseGameLayer::checkCollisionBlocks, gd-ida-decomp.cpp:421638-421641</sub>

### B — how pair state is tracked from tick to tick

- **It is a hash SET of pair keys, not a bitmask: one `std::unordered_map<int,bool>` on GJEffectManager (buckets @+428, bucket count @+432, before-begin @+436, size @+440), with 12-byte nodes `{next@0, key@4, bool@8}`.**

  <sub>GJEffectManager::objectsCollided, gd-ida-decomp.cpp:482446-482510; node shape visible at :482493-482497</sub>

- **The key is `10000*max(idA,idB) + min(idA,idB)` plus a fixed base, and the pair is rejected outright unless BOTH ids are <= 10001.** `getCollisionKey` returns `&aHttp2D[10000*a1 + a2]`; `splitCollisionKey` is its exact inverse around the base **10000000**, so key and split agree by construction and any port can use 10000000 (or 0) safely.

  ```
  key(a,b) = BASE + 10000 * max(a,b) + min(a,b)      // BASE = address of aHttp2D
  split(k) -> max = (k - 10000000) / 10000 ;  min = (k - 10000000) % 10000
  ```

  (The old text asserted "`aHttp2D` sits at 0x989680 = 10000000". That is **not** readable here: `aHttp2D` appears exactly once in the whole 41 MB file — its use at :473929 — with no definition, so its address is unverifiable from this decompile. 10000000 comes only from `splitCollisionKey`. The two functions must share the base or exits would name the wrong ids, so the arithmetic is safe; the address is a guess dressed as a reading.)

  <sub>getCollisionKey, gd-ida-decomp.cpp:473927-473930; splitCollisionKey :473945-473955; the `<= 10001` guard in GJEffectManager::objectsCollided :482467 (cited as :482462 before; re-checked)</sub>

- **Enter / still-touching / exit are exactly three lines of the same map.** Enter fires once, on insert; still-touching fires nothing; exit fires once, from `postCollisionCheck`, on the first sub-step the pair is absent.

  ```
  preCollisionCheck():                       // start of sub-step
      for node in map: node.bool = false;

  objectsCollided(a, b):                     // during updateCollisionBlocks
      if (a > 10001 || b > 10001) return;
      k = key(a,b);
      if (map.contains(k)) { map[k] = true; }                      // still touching: no event
      else { handleObjectCollision(ENTER=1, max, min); map[k] = true; }   // EVENT FIRST, then insert

  postCollisionCheck():                      // later in the same sub-step
      for node in map:
          if (node.bool) continue;
          (max,min) = split(node.key);
          handleObjectCollision(EXIT=0, max, min);
          erase node;
  ```

  (Note the order inside the miss branch: `handleObjectCollision` runs **before** `_M_insert_unique_node`, so during an enter the pair is not yet in the map. A handler that re-queried the map — e.g. an Instant Collision spawned by the same enter — would not see its own pair. The prose comment in the earlier version of this bullet said "insert, then event"; the code is the other way round.)

  <sub>GJEffectManager::preCollisionCheck :474044-474051; ::objectsCollided :482446-482510 (guard :482467, key :482477, still-touching write :482485, **event :482489**, **insert :482499**); ::postCollisionCheck :482367-482430 (split :482393, event :482394)</sub>

- **The key is built from block IDS, so the events are per-ID-pair, not per-object-pair.** Any number of object pairs sharing the same two ids collapse into one entry: one enter when the first pair starts overlapping, one exit when the last pair stops.

  <sub>GJBaseGameLayer::checkCollisionBlocks passes `A[1492]`/`B[1492]` :421648-421651; keyed in GJEffectManager::objectsCollided :482468-482477 (the getCollisionKey call is :482477)</sub>

- **Two distinct objects that share one block id generate a self-pair key (id,id), which a trigger with block_a == block_b will match.** The only self-exclusion in the sweep is by uniqueID, not by id.

  <sub>GJBaseGameLayer::checkCollisionBlocks, gd-ida-decomp.cpp:421641</sub>

- **Enter events fire inside `updateCollisionBlocks`; exit events fire later in the same sub-step, after the player has moved and after `checkSpawnObjects`.** Per sub-step the order is: `preCollisionCheck` → move actions → **`updateCollisionBlocks`** (enters) → player physics + `checkCollisions` → `checkSpawnObjects` → **`postCollisionCheck`** (exits) → `processStateObjects` → `processStateTriggers` → camera.

  <sub>GJBaseGameLayer::update, gd-ida-decomp.cpp:469857 (pre), :469895 (updateCollisionBlocks), :469984 (post), :469986-469987 (state passes)</sub>

- **The start-position warm-up runs the same three calls with no player physics in between.**

  <sub>GJBaseGameLayer::update warm-up loop, gd-ida-decomp.cpp:469483 (pre), :469497 (updateCollisionBlocks), :469501 (post)</sub>

- **Only DYNAMIC 1816 objects are swept; static ones are only ever found as the other side of a dynamic block's sweep, so static-vs-static is never tested.** Both the play path and the editor path gate the `m_collisionBlocks` array (layer+2212, i.e. `this+553`) on obj+1489.

  <sub>PlayLayer::addObject, gd-ida-decomp.cpp:89973-89976; LevelEditorLayer::recreateGroups :198838-198841</sub>

- **`updateCollisionBlocks` removes each dynamic block from the collision-block buckets right after testing it and re-adds them all in a second pass, so each unordered pair of dynamic blocks is tested exactly once per sub-step.**

  ```
  updatePlayerCollisionBlocks();
  for A in m_collisionBlocks:                      // pass 1
      if (!A[550]) {                               // skip group-disabled
          if (A[1157]) test A against UI list  (data @layer+11384, count @layer+11396)
          else {
              sweep the collision-block section grid (data @layer+11340, counts @layer+11424)
              then test A against the flat list  (data @layer+11368, count @layer+11380)
          }
      }
      swap-remove A from whichever bucket holds it, fixing the moved object's index at obj+524
  for A in m_collisionBlocks:                      // pass 2
      re-insert A into its bucket, writing its new index to obj+524
  ```

  <sub>GJBaseGameLayer::updateCollisionBlocks, gd-ida-decomp.cpp:426057-426372 (pass 1 :426134-426310, removal :426280-426309, pass 2 :426315-426366)</sub>

- **The section range swept is the block's own cell ±1 in x and y, except for a block flagged obj+536, which derives the range from its rect.** The x bounds are clamped to the grid width where they are computed; **the y upper bound is clamped per column inside the loop**, against that column's own row count.

  (Corrected. The earlier version of this bullet said "the ±1 form leaves the y upper bound unclamped", which would send a port straight off the end of a column's vector. The clamp is there, just at the use site: for each x the loop first computes `rows-1` for that column and takes `min` with yHi before iterating y. Re-read at :426240-426253.)

  ```
  sx = A[528]; sy = A[532];
  xLo = (sx > 1) ? sx - 1 : 0;      xHi = min(sx + 1, numCols - 1);
  yLo = (sy > 1) ? sy - 1 : 0;      yHi = sy + 1;                 // when !A[536]
  // when A[536]:
  r = getObjectRectPointer(A);
  xLo = max(0, (int)(r.minX * layer[11448] - 1.0));  xHi = min((int)(r.maxX * layer[11448] + 1.0), numCols-1);
  yLo = max(0, (int)(r.minY * layer[11452] - 1.0));  yHi =     (int)(r.maxY * layer[11452] + 1.0);

  // then, per column:
  for x in xLo..xHi:
      col = grid[x];
      yTop = col ? min(rowCount(col) - 1, yHi) : -1;    // <- the y clamp
      for y in yLo..yTop: checkCollisionBlocks(A, col[y].data, col[y].count)
  ```

  <sub>GJBaseGameLayer::updateCollisionBlocks, gd-ida-decomp.cpp:426152-426240; the per-column y clamp :426240-426253</sub>

- **Only objects whose objectID is 1816 are put into the collision-block section grid at all; everything else goes into the general grid.** Both the add and the remove key on `obj+884 == 1816`.

  <sub>GJBaseGameLayer::addToSection, gd-ida-decomp.cpp:444810-445009; GJBaseGameLayer::removeObjectFromSection :425909-425930</sub>

- **A collision block dropped onto the UI layer is moved out of the world grid into a separate flat list and thereafter only tested against that list.**

  <sub>GJBaseGameLayer::addUIObject, gd-ida-decomp.cpp:444334-444361; the obj+1157 branch of updateCollisionBlocks :426145-426152 and :426282-426289</sub>

- **A group-disabled block (obj+550, the sign bit of the toggle counter obj+1036) is skipped as both the A side and the B side, but is still removed from and re-added to its bucket.**

  <sub>GameObject::groupWasEnabled/groupWasDisabled, gd-ida-decomp.cpp:169882-169914; skips at :426143-426144 and :421635</sub>

- **A level reset wipes both the live-pair map and the registered collision triggers.**

  <sub>GJEffectManager::reset, gd-ida-decomp.cpp:488289-488298 (clears the map at this+428); GJEffectManager::resetEffects :488242-488244 (empties the CollisionTriggerAction vector)</sub>

### C — the player

- **Yes. The player is two ordinary GameObjects created with key 1816 and given the reserved block ids 10000 (player 1) and 10001 (player 2).** IDA renders the literal key as an address: `&stru_70C.st_info` is 0x70C + 12 = 1804 + 12 = **1816** (`st_info` is at offset 12 of `Elf32_Sym`, cross-checked against `&stru_2FC.st_value + 2` = 764 + 4 + 2 = 770 = GL_SRC_ALPHA at :34182). `createWithKey`'s first parameter really is the integer key — it is compared against 1819, 1818, 921, 142 inside the function.

  ```
  for i in (0, 1):
      b = GameObject::createWithKey(1816);
      b->addColorSprite("edit_eCollisionBlock01_001.png");
      b[373] = 10000 + i;        // 373*4 = 1492, the block id
      b->setPosition(player[i]->getPosition());
      b[471] = 1; b[1115] = 1;
      layer->vtable[644](layer, b);     // presumed addToSection — slot NOT resolved, see "likely"
      m_collisionBlocks->addObject(b);
  ```

  <sub>GJBaseGameLayer::createPlayerCollisionBlock, gd-ida-decomp.cpp:421527-421590; GameObject::createWithKey :182950-182985</sub>

- **They are created unconditionally during PlayLayer setup, whether or not the level uses collision triggers.**

  <sub>PlayLayer setup, gd-ida-decomp.cpp:106454</sub>

- **Each sub-step, before anything else in `updateCollisionBlocks`, the two blocks are snapped onto their players: position, rotation, scaleX/scaleY and custom scale are copied, the OBB dirty bit is set and the OBB is rebuilt.** Because `calculateOrientedBox` sets obj+636 = 1 unconditionally, the player blocks are *always* oriented, so every pair involving a player goes through the two-way SAT.

  ```
  for i in (0, 1):
      b = playerBlock[i]; p = player[i];
      b->setPosition(p->getPosition());              // vtable+676 from vtable+672
      b[207] = p->getRotation(); b[208] = p->getRotation();   // obj+828 / obj+832
      b[191] = p[191];  b[250] = p[250];             // scaleX, custom scale x
      b[192] = p[192];  b[251] = p[251];             // scaleY, custom scale y
      b[725] = 1;                                    // OBB dirty
      calculateOrientedBox(b);                       // sets b[636] = 1
      reorderObjectSection(b);
  ```

  <sub>GJBaseGameLayer::updatePlayerCollisionBlocks, gd-ida-decomp.cpp:426002-426039; called first thing at :426128</sub>

- **The player blocks therefore lag the player by one sub-step: they are positioned before the sub-step's `PlayerObject::update`, and the block sweep runs before the player moves.**

  <sub>GJBaseGameLayer::update, gd-ida-decomp.cpp:469895 (updateCollisionBlocks) vs :469914 (player update via vtable+20)</sub>

- **The 10001 cap in `objectsCollided` exists precisely because of these two ids: any collision block whose id exceeds 10001 is silently inert — it never registers a pair and never matches a trigger.**

  <sub>GJEffectManager::objectsCollided, gd-ida-decomp.cpp:482467 (cited as :482462 before); GJEffectManager::checkCollision :473985-473986 (cited as :473983-473984 before)</sub>

### D — the property keys, confirmed against the binary

- **Collision Block 1816: block_id = key 80 → obj+1492 (int); dynamic_block = key 94 → obj+1489 (bool). CONFIRMED, by both the parser and the save-string writer.** The writer emits `,80,<obj+1492>` and, only when obj+1489 is set, `,94,<obj+1489>`.

  <sub>EffectGameObject::customObjectSetup, gd-ida-decomp.cpp:299123-299134; GameObject::getSaveString :317371-317392</sub>

- **Collision trigger 1815: block_a = 80 → obj+1492; block_b = 95 → obj+1480; target = 51 → obj+1276; activate_group = 56 → obj+1449; trigger_on_exit = 93 → obj+1479; p1 = 138 → obj+1496; p2 = 200 → obj+1497; pp = 201 → obj+1498. ALL EIGHT CONFIRMED.** Keys 80/95/51/93 are parsed in the 1815 arm, 56 in the shared tail both 1815 and 3609 fall into, and 138/200/201 at the shared `LABEL_469`.

  <sub>EffectGameObject::customObjectSetup, gd-ida-decomp.cpp:299292-299314 (80, 95, 51, 10, 93), :299316-299320 (56, then LABEL_469), :298941-298953 (138, 200, 201)</sub>

- **Instant Collision 3609: block_a = 80 → obj+1492; block_b = 95 → obj+1480; true_id = 51 → obj+1276; false_id = 71 → obj+1280. ALL FOUR CONFIRMED.** 3609 also falls through the same tail, so it parses 56, 138, 200 and 201 as well.

  <sub>EffectGameObject::customObjectSetup, gd-ida-decomp.cpp:299007-299024, then :299316-299320 and :298941-298953</sub>

- **The remaining keys the official levels put on 1815 and 3609 are generic object/trigger keys, not collision keys: 1/2/3 (id, x, y), 36 → obj+1284 (touch-triggered), 57 (group list), 62 → obj+1285 (spawn-triggered), 87 → obj+1476 (multi-trigger), 534 → obj+1484 (control id), 155 → obj+1132.** Key 10 is parsed for 1815 into the generic float slot obj+1264.

  (Corrected: the earlier list named only 62/87/534/155. The levels also put 1, 2, 3, 36 and 57 on 1815, and 1, 2, 3, 36, 57, 62, 87 and 155 on 3609 — see "Checked against the levels". A port that treated the key set as closed at 62/87/534/155 would drop the group list.)

  <sub>EffectGameObject::customObjectSetup prologue, gd-ida-decomp.cpp:298681-298688 (62, 87) and :298709-298712 (534); GameObject::objectFromVector :184131-184134 (155); key 10 for 1815 at :299303-299310</sub>

- **A 1815 trigger, when it fires, appends a 44-byte `CollisionTriggerAction` to a vector on GJEffectManager (begin @+384, end @+388) with the two ids stored sorted max-then-min.** The 44-byte stride is written literally — `a1[97] += 44` at the end of the fast path (:485588) — and independently by the exact-division magic `-1171354717` = 3123612579, the modular inverse of 11 (11 × 3123612579 = 8·2³² + 1), applied to `(end-begin) >> 2`.

  ```
  CollisionTriggerAction, 44 bytes:
    +0   bool   paused       (set 0 on register; Stop trigger sets/clears it)
    +4   int    idMax        max(block_a, block_b)
    +8   int    idMin        min(block_a, block_b)
    +12  int    targetGroup  from obj+1276 (key 51)
    +16  int    onExit       from obj+1479 (key 93)
    +20  bool   activate     from obj+1449 (key 56)
    +24  int    spawnerUID   from obj+772
    +28  int    controlID    from obj+1484 (key 534)
    +32  std::vector<int> remap chain (12 bytes)
  ```

  <sub>GJEffectManager::registerCollisionTrigger, gd-ida-decomp.cpp:485517-485591; count arithmetic in GJEffectManager::handleObjectCollision :482326</sub>

- **The P1/P2/PP checkboxes are literal id substitutions, and checking both P1 and P2 registers the action twice.**

  ```
  if (obj[1498])                                   // PP
      register(group, 10000, 10001, onExit, activate, remap, uid, controlID);
  else {
      a = obj[1496] ? 10000 : obj[1497] ? 10001 : obj[1492];
      register(group, a, obj[1480], onExit, activate, remap, uid, controlID);
      if (obj[1496] && obj[1497])
          register(group, 10001, obj[1480], onExit, activate, remap, uid, controlID);
  }
  ```

  <sub>EffectGameObject::triggerObject, gd-ida-decomp.cpp:315294-315387</sub>

- **On an enter or exit, every matching non-paused action fires; the filter is `!paused && action.onExit != enterFlag && action.idMax == max && action.idMin == min`.** Enter passes `1`, exit passes `0`, so `onExit == 0` actions fire only on enter and `onExit == 1` actions fire only on exit.

  ```
  handleObjectCollision(enterFlag, idMax, idMin):
      for act in collisionActions:
          if (act.paused) continue;
          if (act.onExit == enterFlag) continue;
          if (act.idMax != idMax || act.idMin != idMin) continue;
          if (delegate) delegate->vtable[0](act.targetGroup, act.activate, act.remap,
                                            act.spawnerUID, act.controlID);
          else          toggleGroup(act.targetGroup, act.activate);
  ```

  <sub>GJEffectManager::handleObjectCollision, gd-ida-decomp.cpp:482313-482351</sub>

- **The delegate is the GJBaseGameLayer, installed as `effectManager[264] = (char*)layer + 316`, and `handleObjectCollision` calls slot 0 of that delegate's vtable with five arguments.** The install and the five arguments are read directly; *which* function slot 0 is, is not — see "likely".

  <sub>delegate install at gd-ida-decomp.cpp:462007; the five-argument call in GJEffectManager::handleObjectCollision :482332-482339</sub>

- **`registerCollisionTrigger` appends unconditionally — there is no dedup on (block_a, block_b, group).** A multi-trigger 1815 that fires twice ends up with two identical actions, and each collision then toggles the group twice.

  <sub>GJEffectManager::registerCollisionTrigger, gd-ida-decomp.cpp:485540-485590</sub>

- **A collision trigger registered while the pair is already overlapping will not fire until the pair separates and re-enters, because `handleObjectCollision` is only reached from the insert and erase paths.**

  <sub>GJEffectManager::objectsCollided :482487-482489 (only on the miss branch; cited as :482478-482482 before); ::postCollisionCheck :482393-482394</sub>

- **The Stop trigger reaches registered collision actions by uniqueID or by control id, with mode 0 = erase, 1 = pause (byte+0 = 1), 2 = resume (byte+0 = 0).**

  <sub>GJEffectManager::controlActionsForTrigger (matches +24), gd-ida-decomp.cpp:484870-484902; ::controlActionsForControlID (matches +28) :484377-484404</sub>

- **Instant Collision 3609 is a pure query with no registration: it asks the map whether the pair is currently present and spawns key 51 or key 71 accordingly.**

  ```
  if (obj[1498])  hit = checkCollision(10000, 10001);
  else {
      a = obj[1496] ? 10000 : obj[1497] ? 10001 : obj[1492];
      hit = checkCollision(a, obj[1480]);
      if (!hit && obj[1496] && obj[1497]) hit = checkCollision(10001, obj[1480]);
  }
  spawnGroup(hit ? obj[1276] : obj[1280], ...);     // vtable+616
  ```

  <sub>EffectGameObject::triggerObject, gd-ida-decomp.cpp:315062-315099; GJBaseGameLayer::checkCollision :421675-421690; GJEffectManager::checkCollision :473972-474028</sub>

- **`GJEffectManager::checkCollision` bails out on `blockA > 10001` before it sorts the pair, so the guard applies to block_a only; block_b is unchecked.** In practice an out-of-range block_b just misses, because no such pair was ever inserted.

  <sub>GJEffectManager::checkCollision, gd-ida-decomp.cpp:473984-473986 (the `blockA > 10001` test; range cited as :473983-473992 before)</sub>

### E — the 3640 state block

- **3640 is forced at setup to be touch-triggered and multi-trigger, and forced not spawn-triggered.**

  ```
  case 3640: obj[1284] = 1;   // touch triggered
             obj[1476] = 1;   // multi trigger
             obj[1285] = 0;   // spawn triggered off
  ```

  <sub>EffectGameObject::customSetup, gd-ida-decomp.cpp:302406-302418</sub>

- **When the player touches it, `playerTouchedTrigger` first "powers it on" for the current sub-step, before the ordinary touch-trigger path runs.** `layer+816` is a sub-step counter incremented once per `processCommands`.

  ```
  playerTouchedTrigger(player, trigger):
      if (trigger[884] == 3640) trigger->powerOnObject(layer[816]);   // vtable+904
      ... ordinary touch-trigger handling ...

  powerOnObject(frame): obj[1160] = frame; obj[1159] = 1; obj[644] = 1;
  ```

  <sub>GJBaseGameLayer::playerTouchedTrigger, gd-ida-decomp.cpp:456781-456793; EnhancedGameObject::powerOnObject :164059-164066; counter increment in GJBaseGameLayer::processCommands :464109</sub>

- **When it actually triggers, it spawns its target group (key 51 → obj+1276) and registers itself as a state object.**

  <sub>EffectGameObject::triggerObject, gd-ida-decomp.cpp:315029-315047; GJBaseGameLayer::registerStateObject :442591-442628</sub>

- **`processStateObjects` is the drain: once per sub-step it ages every registered state object, and the ones that were not powered this sub-step get their "off" hook called and are erased from the set.**

  ```
  processStateObjects():                          // hash set: buckets@layer+1084, head@layer+1092
      for node in stateObjects:
          obj = node.value;
          EnhancedGameObject::updateState(obj, layer[816]);
          if (obj[644]) continue;                 // still powered, keep
          obj->stateSensitiveOff(layer);          // vtable+912
          erase node;

  updateState(obj, frame):
      if (obj[1160] < frame) obj[1159] = 0;       // last powered sub-step is stale
      if (!obj[1159]) obj->powerOffObject();      // vtable+908 -> obj[1160]=0, obj[644]=0
  ```

  <sub>GJBaseGameLayer::processStateObjects, gd-ida-decomp.cpp:421383-421446; EnhancedGameObject::updateState :181603-181610; ::powerOffObject :164083-164093</sub>

- **`stateSensitiveOff` is a no-op on the base class; `EffectGameObject` overrides it to spawn the second group (key 71 → obj+1280) when the object is a 3640.** So 3640 = "spawn group 51 when the player starts touching me, spawn group 71 on the sub-step I stop being touched".

  ```
  EffectGameObject::stateSensitiveOff(layer):
      if (this[884] == 3640) layer->spawnGroup(this[1280], <empty remap>);   // vtable+616
  ```

  <sub>EffectGameObject::stateSensitiveOff, gd-ida-decomp.cpp:313871-313889; EnhancedGameObject::stateSensitiveOff (empty body) :163243-163246</sub>

- **`processStateObjects` runs after `postCollisionCheck` in the same sub-step, so a 3640's "off" spawn lands after all collision exits.**

  <sub>GJBaseGameLayer::update, gd-ida-decomp.cpp:469984-469987</sub>

- **`GJGameState::processStateTriggers` runs immediately after and is unrelated to collision blocks: it prunes a container on the layer's embedded GJGameState (at layer+328, container at GJGameState+668), erasing every entry whose int at node+24 is below the counter at GJGameState+488.**

  <sub>GJGameState::processStateTriggers, gd-ida-decomp.cpp:417693-417716; call site :469987</sub>

## likely

*Everything from here down is inference. The first six entries were demoted out of
"certain" on a re-read against the binary; each says what was found instead.*

- **(demoted from certain — A) Arbitrary rotation never widens the rect directly; instead an object flagged "oriented" (obj+636) replaces the rect with the bounding rect of its OBB.** `getObjectRect2` is the cache filler: dirty → oriented ? `getOuterObjectRect` (OBB bounding rect) : the plain rect.

  What is actually read is each function's body in isolation. The *chain* is three unresolved vtable slots: `getObjectRectPointer` calls **vtable+656**; the no-argument `GameObject::getObjectRect()` calls **vtable+664** with obj+764/obj+768; `getObjectRect2` calls **vtable+660** with those two scales. Nothing in the pseudo-C resolves 656, 660 or 664 — the reading that they are `getObjectRect()`, `getObjectRect(float,float)` and `getObjectRect2(float,float)` is a signature match, not a resolution. `getObjectRect2` really is the one that clears obj+724 and writes obj+708, and it really does branch on obj+636; that much is certain.

  <sub>GameObject::getObjectRect2, gd-ida-decomp.cpp:170950-170971; GameObject::getOuterObjectRect :170928-170934; GameObject::getObjectRect() :163366-163372</sub>

- **(demoted from certain — A) The OBB is built with the object's own rotation.** `updateOrientedBox` reads the angle through **vtable+780**, *not* through vtable+176, which is the slot `updateIsOriented` uses for `getRotation`. Two different slots, and 780 is unresolved, so "the raw rotation" is inferred from context. The arithmetic around it (size terms, the `0.017453` literal, the negated sign) is read directly and stays in "certain". Likewise `calculateOrientedBox` rebuilds through **vtable+776**, presumed `updateOrientedBox`, also unresolved.

  <sub>GameObject::updateOrientedBox, gd-ida-decomp.cpp:170862-170910 (angle at :170896); GameObject::updateIsOriented :170714 uses vtable+176</sub>

- **(demoted from certain — A) `OBB2D::calculateWithCenter` lays out the four corners at obj+264..+295 in the order C−X−Y, C+X−Y, C+X+Y, C−X+Y.**

  ```
  X = (cos a, sin a) * (w*0.5);  Y = (-sin a, cos a) * (h*0.5);
  corner[0] = C - X - Y   @+264      corner[1] = C + X - Y   @+272
  corner[2] = C + X + Y   @+280      corner[3] = C - X + Y   @+288
  center @+376
  ```

  It writes them in that order — but the function does not end there. It calls `computeAxes(a1)` and then **`OBB2D::orderCorners(a1)`**, which the earlier version of this bullet never mentioned and which can permute the four slots afterwards. So the mapping above holds only up to `computeAxes`; whatever `overlaps1Way` later reads as corners 0..3 is the post-`orderCorners` arrangement, which was not traced. `computeAxes` runs before the reorder, so the axis/origin bullet in "certain" is unaffected.

  <sub>OBB2D::calculateWithCenter, gd-ida-decomp.cpp:49580-49612 (orderCorners at :49610)</sub>

- **(demoted from certain — B/C) `layer->addToSection(b)` in `createPlayerCollisionBlock`.** That call is `vtable[644](layer, b)`. Slot 644 is not resolved anywhere in the decompile. `addToSection` is the obvious candidate — it takes exactly a layer and an object and is what would have to run for the block to land in the section grid, and `updatePlayerCollisionBlocks` later calls `reorderObjectSection` on the same blocks by direct call — but slot 644 itself is a guess.

  <sub>GJBaseGameLayer::createPlayerCollisionBlock, gd-ida-decomp.cpp:421583-421585</sub>

- **(demoted from certain — D) The delegate call reaches `GJBaseGameLayer::toggleGroupTriggered(int, bool, const vector<int>&, int, int)`, which toggles the group AND, when `activate` is true, also spawns it.**

  ```
  toggleGroupTriggered(group, activate):
      toggleGroup(group, activate);
      if (activate) vtable[616](this, group, 0);   // presumed spawnGroup
  ```

  The body is read correctly and the mangled signature (`EibRKSt6vectorIiSaIiEEii`) does match the five arguments `handleObjectCollision` passes. But this bullet sat in "certain" while the note's own entry below said the slot index is unreadable — it asserted the conclusion the other entry called unproven. Two further gaps: the spawn inside it goes through another unresolved slot (vtable+616), and IDA dropped `toggleGroupTriggered`'s last three parameters, rendering a five-argument function as `(a1, a2, a3)`. The evidence that the *object* at layer+316 is a GJBaseGameLayer secondary base is solid — exactly three `_ZThn316_N15GJBaseGameLayer` thunks exist (`toggleGroupTriggered` :423126, `spawnGroup` :443269, `spawnObject` :456106) — but which one is slot 0 is not.

  <sub>`non-virtual thunk to'GJBaseGameLayer::toggleGroupTriggered` :423126-423131; GJBaseGameLayer::toggleGroupTriggered :423103-423112</sub>

- **(demoted from certain — B) The key's base constant.** See the corrected bullet in B: the formula is safe, the claim that `aHttp2D` sits at 0x989680 is not readable from this file.

- **The layer vtable slot 604 that `checkCollisionBlocks` calls on overlap is `GJBaseGameLayer::objectsCollided(int, int)`.** That function exists, takes exactly two ints, forwards straight to `GJEffectManager::objectsCollided`, and has no direct caller anywhere in the decompile — while `GJBaseGameLayer::checkCollision` (the other two-int candidate) *is* called directly from the 3609 path. Slot 604 is not otherwise resolvable from pseudo-C.

  <sub>GJBaseGameLayer::objectsCollided, gd-ida-decomp.cpp:415881-415884; the slot-604 call in ::checkCollisionBlocks :421648-421651</sub>

- **The delegate vtable slot 0 at layer+316 is `toggleGroupTriggered`.** Only three thunks exist for that base (`toggleGroupTriggered`, `spawnGroup`, `spawnObject`), and only `toggleGroupTriggered`'s signature matches the five arguments passed. The index itself is not readable from pseudo-C.

  <sub>thunks at gd-ida-decomp.cpp:423126, :443269, :456106; the call in GJEffectManager::handleObjectCollision :482332-482339</sub>

- **The base hitbox of a 1816 object (obj+648 / obj+652) is 30 × 30 with a zero box offset, so the player collision blocks are 30 × 30 squares scaled by the player's scale — not the player's own hitbox, which is 27 × 27 in spider/robot.** The 30 × 30 comes from the third-party object table in `data/ref/gdclone-object.json`, not from the binary; the decompile loads hitbox sizes from a runtime table I did not trace. The 27 × 27 player figure is from the binary.

  <sub>PlayerObject spider hitbox `*(v4 + 648) = 1104674816` = 27.0f (**0x41D80000** — the earlier version of this line wrote 0x41D00000, which is a different float; re-decoded by hand, 1104674816 = 0x41D80000 = 27.0f, while 0x41D00000 = 26.0f), gd-ida-decomp.cpp:152722-152723; 1816 entry in data/ref/gdclone-object.json (hitbox 30 × 30, offset 0,0)</sub>

- **`obj+536` is a level property-511 flag meaning "do not bucket me by section".** For non-1816 objects it moves them into a flat always-checked list; for 1816 objects it keeps them in a flat list and makes their sweep range come from their rect. The key→offset mapping is read; the name is inferred from behaviour.

  <sub>key 511 → obj+536 in GameObject::objectFromVector, gd-ida-decomp.cpp:184186-184191; the 1816 branch of GJBaseGameLayer::addToSection :444992-445009; the general branch :444810-444826</sub>

- **The Instant Collision spawn passes an empty remap chain rather than inheriting the caller's, unlike 3640 which copies it.** The local `std::vector<int>` is explicitly zeroed right before the 3609 call and copied from the incoming chain before the 3640 call — but IDA dropped the trailing arguments of the vtable+616 call in both cases, so the vector reaching `spawnGroup` is inferred from the local, not read.

  <sub>EffectGameObject::triggerObject, gd-ida-decomp.cpp:315093-315098 (3609) vs :315032-315043 (3640)</sub>

## Not established

- **Which `CCArray` index the two player collision blocks occupy in `m_collisionBlocks` in play mode.** `createPlayerCollisionBlock` appends them and `PlayLayer::addObject` appends level blocks, but I did not trace whether level objects are added before or after setup calls `createPlayerCollisionBlock`. This decides the deterministic order in which enters fire within one sub-step when several pairs start overlapping at once. (In the editor path, `LevelEditorLayer::recreateGroups` clears the array and adds the two player blocks first, at :198781-198783.)

- **What key 155 (obj+1132) and key 57 mean.** 155's parse site is read (`GameObject::objectFromVector` :184131-184134, storing an int at obj+1132) but I found no reader. I did not locate where key 57 (the group list) is parsed at all; group membership is read back through `GameObject::getGroupID` with a count at obj+1012.

- **What key 10 (obj+1264) does on a 1815.** The 1815 arm parses it with `atof` into the generic float slot (:299303-299310) and nothing in the collision path reads obj+1264.

- **The exact source of `obj+648`/`obj+652` (the base hitbox size) per object id.** It is loaded from a runtime table rather than written by the parser; I did not find the writer for 1816.

- **What `obj+756` is.** `updateIsOriented` refuses to build an OBB when it is > 0, which is consistent with it being a circular-hitbox radius, but I did not read its writer.

- **Whether a multi-trigger 1815 can re-fire and thus accumulate duplicate `CollisionTriggerAction` entries in practice.** `registerCollisionTrigger` has no dedup, but the multi-trigger re-arm question is the same one `trigger-semantics.md` flags as unresolved for touch triggers generally, and I did not resolve it here either.

- **The node layout of the `processStateTriggers` container.** The comparison at node+24 against GJGameState+488 is read, but the container type and what the entries represent are not established, and I found no writer for it.

- **What the name obj+772 is.** The string "uniqueID" does not occur anywhere in the decompile. The *behaviour* is read and certain — it is a per-object identity used both for the self-exclusion in `checkCollisionBlocks` and as the `spawnerUID` the Stop trigger matches on — but the name is carried in from elsewhere, not from this file.

- **The 10001 cap, in practice.** No official level comes near it (the highest block id in the official set is 244), so the cap's behaviour is read from the binary only and never exercised by real data.

## Checked against the levels

Measured by decoding all 27 official levels through `loadOfficialLevel` (1–22, 3001, 5001–5004)
and reading the raw key→value map on every object. Counts as measured, not as remembered:

| | 1816 collision block | 1815 Collision trigger | 3609 Instant Collision |
|---|---|---|---|
| total | **72** | **20** | **7** |
| level 22 Dash | 2 | 1 | 0 |
| 5002 The Sewers | 1 | 2 | 0 |
| 5003 The Cellar | 24 | 2 | 0 |
| 5004 The Secret Hollow | 45 | 15 | 7 |

No 1815, 3609 or 1816 appears in any other official level.

**Block ids resolve.** The 27 triggers name 42 block ids between them (key 80 when neither P1
nor P2 is set, plus key 95 on every non-PP trigger). **All 42 resolve to a 1816 object carrying
that id in the same level. None dangle, and none is 0.** The port's assumption holds on the
official set.

**Keys actually present**, so a parser can be checked against real data rather than against the
binary alone:

- 1816 — `1 2 3 20 24 36 57 80 94 108 128 129 135 155`. Key 80 on all 72. Key 94 on 30 of 72 (42 blocks are static); its raw value is always the string `1`, never `0`, which matches the parser's `!= 0` bool read. Key 155 is on all 72 (values 1, 3, and a spread of 929–1142 in 5004) — still no reader found for it, see "Not established".
- 1815 — `1 2 3 10 36 51 56 57 62 80 87 93 95 138 155 534`. Key 56 on all 20; key 93 on 6; key 87 on 7; key 534 on 5.
- 3609 — `1 2 3 36 51 57 62 71 80 87 95 138 155`. Key 51 and key 71 on all 7.

**P1/P2/PP.** Key 138 (P1) appears on 6 of 20 1815s and 6 of 7 3609s, and **those are exactly the
objects that carry no key 80** — the editor omits block_a when a player substitutes for it, which
is what the trigger code's `p1 ? 10000 : p2 ? 10001 : obj[1492]` predicts. **Keys 200 (P2) and 201
(PP) never appear in any official level**, so those two bullets in section D rest on the binary
(parser and save-string writer both read) and on nothing else.

**Shapes that matter for the port:**

- Shared ids are real, not hypothetical: 5004 puts id 1 on 6 objects and id 22 on 6 objects, ids
  13/14/20/21 on 3 each, 8 and 19 on 2 each; 5003 puts 224/231/232 on 2 each. The per-ID-pair
  keying in section B is therefore load-bearing on real levels, not a corner case.
- **No official trigger names the same id on both sides**, so the self-pair case in section B is
  unexercised by real data.
- **No official trigger pairs two static blocks.** Every non-player pair has at least one side with
  key 94 set, which is what section B's "static-vs-static is never tested" requires to be true for
  these levels to work.
- The highest block id anywhere in the official set is **244** (5003), well under the 10001 cap.
