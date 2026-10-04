# Advanced follow, read out of the 2.206 decompile

Advanced Follow is not a spring and not a PID. It is a **steering model with an explicit
velocity state per followed object**, run once per physics tick in units of 240 Hz ticks.
`GJBaseGameLayer::processAdvancedFollowActions` scales the frame delta by 240, sorts the live
instance list by the trigger's key-365 priority, and calls
`GJBaseGameLayer::processAdvancedFollowAction` for each instance; that function walks the
follower group, fetches the target position out of the position-history ring
(`getSavedPosition`, so a follow can lag its target by a configurable delay), and then updates a
`GameObjectPhysics` record — a velocity `CCPoint`, a heading `CCPoint`, a latched aim angle and
a smoothed turn rate — before applying `velocity * dt_ticks` through `moveObject`/`moveObjects`.
Key 367 selects one of three integrators: **0** = a pure lag filter (`velocity = delta /
max(1, smooth)`), **1** = accelerate along the normalised delta with a drag term and a
near-field blend, **2** = a turn-rate steering model that rotates the velocity vector towards
the target and brakes when the heading error is large. Almost every float property comes in a
`base` + `mod` pair, where `mod` is multiplied by a per-object random number drawn from a
2000-entry bank of `[-1, 1]` floats built once in `GJBaseGameLayer::init`; the per-object index
into that bank is a random `[0, 1900]` integer (inclusive — `(int)(rand01 * 1900.0)` with
`rand01` reaching exactly 1.0) stored at `GameObject+860` and assigned in
`GameObject::commonSetup`. Trigger 3660 (Edit) scales an existing velocity and can inject extra
start speed; trigger 3661 (Re-Target) rewrites the *followed target* field of running instances
in place. There is one state vector **per follower object** (keyed by the object's unique id) —
not one per (target group, follow group) pair — and it is garbage-collected at the end of every
tick if nothing touched it.

## certain

- **The tick delta handed to the solver is `dt * 240`, so the whole subsystem works in 240 Hz ticks.**
  <sub>GJBaseGameLayer::processAdvancedFollowActions, gd-ida-decomp.cpp:465992</sub>

- **`AdvancedFollowInstance` is a 28-byte POD in a `std::vector` at `GJBaseGameLayer+1332 / +1336 / +1340` (begin/end/capacity), with a dirty flag at `GJBaseGameLayer+1328`.**
  ```
  +0   AdvancedFollowTriggerObject*   the trigger that spawned this instance
  +4   int  followerGroup   = trigger+1276  (key 51,  "Target")
  +8   int  followedTarget  = trigger+1280  (key 71,  "Target 2"),
                               overridden by -1 / -2 / -3 when trigger+1496 / +1497 / +1498
                               (keys 138 / 200 / 201) is set
  +12  int  controlID       = trigger+1484  (key 534)
  +16  int  rangeRefObject  = 0 at creation; NO writer exists anywhere in the decompile
  +20  int  actionOrdinal   = ++GJBaseGameLayer+840 (never read by the sort)
  +24  u8   paused
  +25  u8   runOneSettlePass
  +26  u8   removeMe
  +27  u8   hasStarted
  ```
  Re-triggering an instance with the same (trigger, +4, +8, +12) tuple clears `+24`/`+25` and
  refreshes `+20` instead of appending a second instance.
  <sub>GJBaseGameLayer::triggerAdvancedFollowCommand, gd-ida-decomp.cpp:421969-422135</sub>

- **The instance list is sorted, descending, by the trigger's key-365 value only; the declared tiebreak field `trigger+1860` is zeroed by the constructor and is never written by the parser, the save string or any runtime code.**
  ```
  compAdvFollowSort(a, b):
      if a.trigger[1856] == b.trigger[1856]:  return a.trigger[1860] < b.trigger[1860]
      return a.trigger[1856] > b.trigger[1856]
  ```
  The sort only runs when `GJBaseGameLayer+1328` is set (i.e. after a trigger fires).
  <sub>compAdvFollowSort, gd-ida-decomp.cpp:415110-415126; AdvancedFollowTriggerObject::AdvancedFollowTriggerObject, gd-ida-decomp.cpp:305380-305384; GJBaseGameLayer::processAdvancedFollowActions, gd-ida-decomp.cpp:465993-466028</sub>

- **The driver picks the `settlePass` argument per instance: paused instances are skipped unless `+25` is set (then one settle pass), otherwise the pass flag is `+26` (the removal tick).**
  ```
  for inst in instances:
      if inst.paused:
          if !inst.runOneSettlePass: continue
          inst.runOneSettlePass = 0
          processAdvancedFollowAction(inst, settlePass = 1, dt240)
      else:
          processAdvancedFollowAction(inst, settlePass = inst.removeMe, dt240)
  # then: erase every instance with removeMe != 0 (std::remove_if-style compaction)
  ```
  <sub>GJBaseGameLayer::processAdvancedFollowActions, gd-ida-decomp.cpp:466029-466128</sub>

- **`settlePass = 1` does not steer: it issues a zero-length `moveObject`/`moveObjects` once per object per frame and returns.**
  ```
  ph = gameState.getGameObjectPhysics(obj)
  if ph.lastMoveFrame /*+32*/ < layer.frame /*+816*/:
      ph.lastMoveFrame = layer.frame
      if i == 1: moveObjects(getTargetGroup(v16, obj.uniqueID /*obj+772*/), 0, 0, 0)
      else:      moveObject(obj, 0, 0, 0)
  ```
  (Corrected on review: an earlier revision called `getTargetGroup`'s second argument
  `obj.groupParent`. It is `*(int *)(obj + 772)`, the same sequential unique id the physics map
  is keyed by — `getTargetGroup` does `objectAtIndex(layer+2456, v16+1)->objectForKey(uniqueID)`.)
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:453820-453849</sub>

- **The per-object state vector is a `GameObjectPhysics` value in `std::unordered_map<int, GameObjectPhysics>` at `GJBaseGameLayer+920` (= `GJGameState+592`, `GJGameState` being `GJBaseGameLayer+328`), keyed by `GameObject+772`, the object's sequential unique id. There is exactly one record per follower object — nothing is keyed by (target group, follow group).**
  ```
  GameObjectPhysics (40 bytes, allocated inside a 0x30 hash node at node+8):
    +0   GameObject*   owner
    +4   float  vel.x
    +8   float  vel.y
    +12  float  dir.x     unit heading
    +16  float  dir.y
    +20  float  aimAngle  latched atan2 of the velocity
    +24  float  turnRate  smoothed, mode 2 only
    +28  int    stamp written by getGameObjectPhysics from GJGameState+488
    +32  int    lastMoveFrame
    +36  int    lastStepFrame  (only written when key 571 is set)
  ```
  All fields start at zero; `getGameObjectPhysics` inserts a record on first use.
  <sub>GJGameState::getGameObjectPhysics, gd-ida-decomp.cpp:451797-451871; GameObject::assignUniqueID, gd-ida-decomp.cpp:165744-165754</sub>

- **At the end of every tick, `processAdvancedFollowActions` deletes every `GameObjectPhysics` record whose `+32` is older than the current frame, so velocity state does not survive a tick in which the object was not moved by a follow.**
  ```
  for node in hashtable(layer+920):
      if node.value[+32] < layer.frame: erase(node)
  ```
  <sub>GJBaseGameLayer::processAdvancedFollowActions, gd-ida-decomp.cpp:466129-466171</sub>

- **Float "mod" properties are multiplied by a per-object random number read out of a fixed bank: `bank[i] = layer + 2632 + 4*i`, 2000 entries, filled once in `GJBaseGameLayer::init` from the MSVC LCG and mapped to `[-1, 1]`.**
  ```
  seed = seed * 214013 + 2531011          # IDA prints 214013 as "&stru_343FC.st_name + 1";
                                          # 0x343FC == 214012, +1 == 214013
  v    = (seed >> 16) & 0x7FFF
  bank[i] = (v/32767) + (v/32767) - 1     # exactly as emitted, i.e. 2*v/32767 - 1
  # i runs over layer+2632 .. layer+10632 exclusive  ->  2000 floats
  ```
  The per-object index is `objRand = *(int16*)(GameObject + 860)`, set in `GameObject::commonSetup`
  to `(int)(rand01 * 1900.0)` from the same global LCG. A property reads `bank[objRand + slot]`,
  where `slot` is a small constant that differs per property, so one object gets a different
  (but frame-stable) draw for each property.
  <sub>GJBaseGameLayer::init, gd-ida-decomp.cpp:462057-462066; GameObject::commonSetup, gd-ida-decomp.cpp:166690-166724 (the write is at 166724)</sub>

- **Every level-file key of trigger 3016 maps 1:1 to a struct offset; the parser indexes its two vectors by `key * 4`, and `getSaveString` emits the same pairs. Verified list (offset, key, and the random-bank slot used by the paired mod where one exists):**
  ```
  key 51   -> +1276  int    follower group        (setTargetID, clamped to 0..9999)
  key 71   -> +1280  int    followed target       (setTargetID2, clamped to 0..9999)
  key 138  -> +1496  bool   follow player 1  (target becomes -1)
  key 200  -> +1497  bool   follow player 2  (target becomes -2)
  key 201  -> +1498  bool   follow "-3"
  key 292  -> +1636  float  follow delay, seconds        (mod: key 293 -> +1640, slot 0)
  key 298  -> +1668  float  max speed                    (mod: key 299 -> +1672, slot 1)
  key 334  -> +1696  float  acceleration, x0.01          (mod: key 335 -> +1700, slot 2)
  key 308  -> +1680  float  max range                    (mod: key 309 -> +1684, slot 3)
  key 306  -> +1676  bool   X only
  key 307  -> +1677  bool   Y only
  key 305  -> +1800  bool   mode-2: push along heading instead of straight at the target
  key 336  -> +1801  bool   skip objects whose GameObject+550 byte is set
  key 339  -> +1802  bool   rotate the object to its heading
  key 340  -> +1804  float  rotation offset, degrees
  key 300  -> +1644  float  start speed              (random range: key 301 -> +1648)
  key 563  -> +1656  float  start-speed angle, deg   (random range: key 564 -> +1660)
  key 560  -> +1652  int    start-speed reference object A
  key 565  -> +1664  int    start-speed reference object B
  key 572  -> +1876  int    start-speed apply mode (see below)
  key 571  -> +1872  bool   claim the object for this tick (writes ph+36)
  key 367  -> +1868  int    integrator select: 2, 1, or anything else = 0
  key 365  -> +1856  int    sort priority (descending)
  key 363  -> +1848  float  heading turn divisor, floored at 1
  key 364  -> +1852  float  min distance before the aim angle is re-latched
  # mode 2 only
  key 316  -> +1720  float  turn rate, x0.01             (mod: key 317 -> +1724, slot 9)
  key 337  -> +1728  bool   enable the "slow" branch
  key 318  -> +1732  float  slow turn rate, x0.01        (mod: key 319 -> +1736, slot 10)
  key 322  -> +1752  float  slow speed threshold         (mod: key 323 -> +1756, slot 12)
  key 338  -> +1740  bool   enable the "fast" branch
  key 320  -> +1744  float  fast turn rate, x0.01        (mod: key 321 -> +1748, slot 11)
  key 324  -> +1760  float  fast speed threshold         (mod: key 325 -> +1764, slot 13)
  key 326  -> +1768  float  brake strength, x0.01        (mod: key 327 -> +1772, slot 14)
  key 328  -> +1776  float  brake angle threshold, deg   (mod: key 329 -> +1780, slot 15)
  key 330  -> +1784  float  turn rate while braking      (mod: key 331 -> +1788, slot 16)
  key 332  -> +1792  float  brake speed threshold        (mod: key 333 -> +1796, slot 16)
  # mode 1 only
  key 558  -> +1832  float  drag, x0.01                  (mod: key 559 -> +1836, slot 7)
  key 359  -> +1816  float  near distance                (mod: key 360 -> +1820, slot 6)
  key 357  -> +1808  float  near acceleration, x0.01     (mod: key 358 -> +1812, slot 8)
  key 561  -> +1824  float  near drag, x0.01             (mod: key 562 -> +1828, slot 9)
  # mode 0 only
  key 361  -> +1840  float  smoothing divisor            (mod: key 362 -> +1844, slot 6)
  # written by the parser and saved, but never read at runtime in this binary
  key 310  -> +1688, key 311 -> +1692, key 312 -> +1704, key 313 -> +1708,
  key 314  -> +1712, key 315 -> +1716, key 366 -> +1864
  ```
  <sub>AdvancedFollowTriggerObject::customObjectSetup, gd-ida-decomp.cpp:309023-309448; AdvancedFollowTriggerObject::getSaveString, gd-ida-decomp.cpp:319797-320570</sub>

- **Keys 331 and 333 both read random-bank slot 16 (`objRand + 674`), so their two mods are never independent.**
  ```
  454091:  v33 = bank[objRand + 674]   // key 331's mod
  454102:  v6  = key333 * bank[objRand + 674]
  ```
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:454083-454102</sub>

- **The per-tick update, with every constant named. `dt` below is `dt_ticks = frameDelta * 240`.**
  ```
  # ---- per instance ----------------------------------------------------------
  trig       = inst.trigger
  specialKey = getSpecialKey(inst.followerGroup, trig+1632 /*key 280*/, trig+1633 /*key 281*/)
  v16        = map(layer+2460)[specialKey].first   or 0 if absent
  passes     = (v16 <= 0) ? 1 : 2
  rotateToHeading = trig[1802]                     # key 339

  for i in 0 .. passes-1:
      group = (v16 <= 0) ? getGroup(inst.followerGroup)
                         : ((CCArray*)layer[614])->objectAtIndex(v16 - 1 + i)
      for obj in group:
          ph = physics[obj.uniqueID]
          if ph.lastStepFrame >= layer.frame: continue      # key 571 on an earlier instance

          # ---- target ------------------------------------------------------
          delay  = key292 + (key293 ? key293 * bank[objRand+0] : 0)
          target = getSavedPosition(inst.followedTarget, delay)
          if (trig[1801] and obj[550]) or target == (0,0): continue

          delta  = target - obj.position
          dist   = |delta|
          maxSpeed = key298 + (key299 ? key299 * bank[objRand+1] : 0)
          accel    = (key334 + (key335 ? key335 * bank[objRand+2] : 0)) * 0.01
          maxRange = key308 + (key309 ? key309 * bank[objRand+3] : 0)

          # inst.rangeRefObject is always 0 in practice, so rangeDist == dist
          rangeDist = (inst.rangeRefObject > 0 and tryGetMainObject(...))
                      ? |target - refObj.position| : dist
          if key306: delta.y = 0
          elif key307: delta.x = 0
          if maxRange != 0 and rangeDist > maxRange: continue

          # ---- one-shot start speed ---------------------------------------
          if not inst.hasStarted:
              speed = key300 + key301 * fast_rand_0_1()
              if speed != 0:
                  angle = key563 + key564 * fast_rand_0_1()
                  kick  = getFollowSpeedVal(obj, key560, key565, angle, speed)
                  if ph.lastMoveFrame != 0 and key572 != 1:
                      if key572 == 2:
                          if not key306: ph.vel.y += kick.y
                          if not key307: ph.vel.x += kick.x
                      # key572 == 0 or >2 with an existing record: keep the velocity
                  else:
                      if not key306: ph.vel.y = kick.y
                      if not key307: ph.vel.x = kick.x
          inst.hasStarted = 1
          ph.lastMoveFrame = layer.frame
          if key571: ph.lastStepFrame = layer.frame

          # ---- integrator --------------------------------------------------
          if key367 == 2:
              pushDir = ph.dir
              dirN    = normalize(delta)
              if ph.dir.isZero(): ph.dir = dirN
              turn      = (key316 + key317*bank[objRand+9])  * 0.01
              slowTurn  = (key318 + key319*bank[objRand+10]) * 0.01
              fastTurn  = (key320 + key321*bank[objRand+11]) * 0.01
              slowThr   =  key322 + key323*bank[objRand+12]
              fastThr   =  key324 + key325*bank[objRand+13]
              brake     = (key326 + key327*bank[objRand+14]) * 0.01
              brakeAng  = (key328 + key329*bank[objRand+15]) * 0.017453   # pi/180
              brakeTurn = (key330 + key331*bank[objRand+16]) * 0.01
              brakeThr  =  key332 + key333*bank[objRand+16]
              speed = |ph.vel|
              if key337 and speed <= slowThr:      turn = slowTurn
              elif key338 and speed >= fastThr and fastThr > 0: turn = fastTurn
              err = convertToClosestDirection(angleOf(dirN) - angleOf(ph.dir), 3.1416)
              if brake > 0 and |err| > brakeAng and speed > brakeThr: turn = brakeTurn
              ph.turnRate += (turn - ph.turnRate) / 10.0                 # first-order lag
              w = clamp ph.turnRate towards err, never overshooting err's sign/magnitude
              if w != 0:
                  c = cos(w*dt); s = sin(w*dt)
                  vx0 = ph.vel.x; vy0 = ph.vel.y        # both read BEFORE either write
                  if not key306: ph.vel.y = vx0*s + vy0*c
                  if not key307: ph.vel.x = vx0*c - vy0*s
                  ph.dir = ccpForAngle(angleOf(ph.dir) + w*dt)
              if brake > 0 and |err - w| - brakeAng > 0:
                  bx = min(|brake * ph.dir.x * dt|, |ph.vel.x|) with sign of ph.vel.x
                  by = min(|brake * ph.dir.y * dt|, |ph.vel.y|) with sign of ph.vel.y
                  if not key306: ph.vel.y -= by
                  if not key307: ph.vel.x -= bx
                  accel = 0
              push = key305 ? dirN : ph.dir
              if not key306: ph.vel.y += accel * push.y * dt
              if not key307: ph.vel.x += accel * push.x * dt
              # mode 2 skips the aim-angle / heading block below

          elif key367 == 1:
              nearDist = key359 + key360*bank[objRand+6]
              drag     = (key558 + key559*bank[objRand+7]) * 0.01
              dirN     = normalize(delta)
              if nearDist > 0 and dist < nearDist:
                  t        = 1.0 - dist/nearDist
                  nearAcc  = (key357 + key358*bank[objRand+8]) * 0.01
                  nearDrag = (key561 + key562*bank[objRand+9]) * 0.01
                  accel += t * (nearAcc  - accel)
                  drag  += t * (nearDrag - drag)
              if drag != 0:
                  v = ph.vel - ph.vel * (drag * dt)
                  if not key306: ph.vel.y = v.y
                  if not key307: ph.vel.x = v.x
              v = ph.vel + dirN * (accel * dt)
              if not key306: ph.vel.y = v.y
              if not key307: ph.vel.x = v.x

          else:                                    # key367 == 0 (or anything else)
              smooth = key361 + key362*bank[objRand+6]
              if smooth <= 1.0: smooth = 1.0
              v = delta * (1.0 / smooth)
              if not key306: ph.vel.y = v.y
              if not key307: ph.vel.x = v.x

          # ---- heading (modes 0 and 1 only) ---------------------------------
          if dist >= key364: ph.aimAngle = angleOf(ph.vel)
          turnDiv = max(1.0, key363)
          step    = convertToClosestDirection(ph.aimAngle - angleOf(ph.dir), 3.1416) / turnDiv
          ph.dir  = ccpForAngle(angleOf(ph.dir) + step)

          # ---- rotation -----------------------------------------------------
          if rotateToHeading:
              want  = (90.0 - angleOf(ph.dir) * 57.296) + key340   # 57.296 == 180/pi
              rot   = convertToClosestDirection(want - obj.rotation, 180.0) * 0.25
          else: rot = 0

          # ---- speed clamp --------------------------------------------------
          mag = key306 ? |ph.vel.x| : key307 ? |ph.vel.y| : |ph.vel|
          if mag > maxSpeed and maxSpeed > 0:
              s = maxSpeed / mag
              if key306: ph.vel.x *= s
              elif key307: ph.vel.y *= s
              else: ph.vel = ph.vel * s

          # ---- apply ---------------------------------------------------------
          step = ph.vel * dt
          if key306: step.y = 0
          elif key307: step.x = 0
          if step != (0,0):
              if i == 1: moveObjects(getTargetGroup(v16, obj.uniqueID), step.x, step.y, 0)
              else:      moveObject(obj, step.x, step.y, 0)
          if rot != 0:
              if i != 0: rotateObjects(getTargetGroup(v16, obj.uniqueID), rot,
                                       obj.getUnmodifiedPosition(),
                                       (rot!=0 && i==1 ? step : (0,0)), 0)   # 5 args, last is 0
              else:      rotateObject(obj, rot)
  ```
  Re-read line by line against 453626-454417: the three integrators, every `* 0.01`, every
  random-bank slot, the speed clamp, the axis masks and the heading block all match the
  decompile exactly. Two things were wrong and are corrected above — `obj.groupParent` (it is
  `obj+772`, the unique id) and the mode-2 rotation, which reads both velocity components into
  registers before writing either, so it *is* a clean rigid rotation.
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:453626-454417</sub>

- **`convertToClosestDirection(x, m)` folds `x` into `[-m, m]` in steps of `2m`, and is used with `m = 3.1416` (pi) for radians and `m = 180.0` for degrees.**
  ```
  if x < -m:  x += ceil(floor(|x|/m) * 0.5) * (m+m)
  elif x > m: x -= ceil(floor(|x|/m) * 0.5) * (m+m)
  ```
  <sub>GJBaseGameLayer::convertToClosestDirection, gd-ida-decomp.cpp:428040-428062</sub>

- **`getFollowSpeedVal` turns the start-speed block into a vector: an angle measured clockwise from +Y, optionally rotated by a reference direction, times the magnitude.**
  ```
  a = (90.0 - angleDeg) * 0.017453
  d = (0,0)
  if key560 > 0:
      o = tryGetObject(key560);  if o: d = o.getLastPosition() - o.position
  if d still unset and key565 > 0:
      o = tryGetObject(key565);  if o: d = thisObject.position - o.position
  if d != (0,0): a += atan2(d.y, d.x) + 1.57079633
  return ccpForAngle(a) * magnitude
  ```
  <sub>GJBaseGameLayer::getFollowSpeedVal, gd-ida-decomp.cpp:428157-428215</sub>

- **`getSpecialKey(group, b1, b2) = 100000000 + 10000000*b1 + 1000000*b2 + group`; the two bools are keys 280 and 281 (`EffectGameObject+1632 / +1633`). IDA prints the two multipliers as string addresses, but `parseSpecialKey` subtracts the same values as literals, which pins them.**
  <sub>GJBaseGameLayer::getSpecialKey, gd-ida-decomp.cpp:425770-425774; parseSpecialKey, gd-ida-decomp.cpp:425789-425805; EffectGameObject::customObjectSetup, gd-ida-decomp.cpp:298713-298720</sub>

- **Trigger 3660 (`AdvancedFollowEditObject`, `SetupAdvFollowEditPhysicsPopup`) edits an existing `GameObjectPhysics` in place: it scales each velocity component and optionally adds another start-speed kick. It uses `find`, never `insert`, so it cannot start a follow.**
  ```
  modifyObjectPhysics(edit, ph):
      ph.vel.x *= key566 + key567 * fast_rand_0_1()
      ph.vel.y *= key568 + key569 * fast_rand_0_1()
      speed = key300 + key301 * fast_rand_0_1()
      if speed != 0:
          kick = getFollowSpeedVal(ph.owner, key560, key565,
                                   key563 + key564*fast_rand_0_1(), speed)
          if not key306: ph.vel.y += kick.y
          if not key307: ph.vel.x += kick.x
  ```
  New keys on 3660: `566 -> +1880`, `567 -> +1884`, `568 -> +1888`, `569 -> +1892`,
  `570 -> +1896` (bool, parsed but never read), `535 -> +1488` (bool, the selector below).
  It inherits every 3016 key through `AdvancedFollowTriggerObject::customObjectSetup`.
  <sub>GJBaseGameLayer::modifyObjectPhysics, gd-ida-decomp.cpp:428230-428284; GJBaseGameLayer::modifyGroupPhysics, gd-ida-decomp.cpp:439506-439546; AdvancedFollowEditObject::customObjectSetup, gd-ida-decomp.cpp:309463-309505</sub>

- **Trigger 3661 (`SetupAdvFollowRetargetPopup`, same `AdvancedFollowEditObject` class) rewrites `inst+8`, the followed target, of running instances. The new target is key 71, overridden to -1/-2/-3 by keys 138/200/201; if it resolves to 0 the trigger does nothing.**
  ```
  if key535:
      for inst in instances:
          if inst.controlID /*+12*/ == key51: inst.followedTarget /*+8*/ = newTarget
  else:
      for obj in getGroup(key51):
          if obj.objectID == 3016:
              for inst in instances:
                  if inst.trigger == obj: inst.followedTarget = newTarget
  ```
  It changes nothing else — no velocity reset, no restart, no `hasStarted` clear.
  <sub>GJBaseGameLayer::triggerAdvancedFollowEditCommand, gd-ida-decomp.cpp:442373-442440</sub>

- **Object ids map to classes as: 3016 -> `AdvancedFollowTriggerObject` / `SetupAdvFollowPopup`, 3660 -> `AdvancedFollowEditObject` / `SetupAdvFollowEditPhysicsPopup`, 3661 -> `AdvancedFollowEditObject` / `SetupAdvFollowRetargetPopup`.**
  <sub>the editor setup-popup switch, gd-ida-decomp.cpp:213503-213521</sub>

- **`processAdvancedFollowActions` runs inside `processMoveActionsStep`, after `processMoveActions` and `processPlayerFollowActions` and before `processFollowActions` and `processAreaActions`.**
  <sub>GJBaseGameLayer::processMoveActionsStep, gd-ida-decomp.cpp:469394-469402</sub>

### Gameplay Rotation, trigger 2900

- **Keys 166 and 167 are overwritten from the object's placement whenever `updateStartValues` runs, so the saved values are only a cache of the editor's orientation.**
  ```
  determineSlopeDirection(); switch (obj+940):
      1 -> key166 = 1, key167 = 4
      2 -> key166 = 2, key167 = 3
      3 -> key166 = 1, key167 = 3
      4 -> key166 = 3, key167 = 2
      5 -> key166 = 4, key167 = 1
      6 -> key166 = 3, key167 = 1
      7 -> key166 = 4, key167 = 2
      default -> key166 = 2, key167 = 4
  ```
  <sub>RotateGameplayGameObject::updateGameplayRotation, gd-ida-decomp.cpp:313494-313546; RotateGameplayGameObject::updateStartValues, gd-ida-decomp.cpp:313562-313566</sub>

## likely

*Everything from here to "Not established" that carries a "demoted on review" note was written
as **certain** in an earlier revision and did not survive a second read of the cited lines. The
original wording is kept so that anything already built on it can be found.*

- **`controlAdvancedFollowCommand(trigger, controlID, command)` is the only writer of the three control bytes: command 0 = stop (queues removal), 1 = pause, 2 = resume. It selects instances by trigger pointer when `controlID == -1`, otherwise by `inst+12`.**
  ```
  0 -> paused = 0; runOneSettlePass = 0; removeMe = 1
  1 -> paused = 1; runOneSettlePass = 1
  2 -> paused = 0; runOneSettlePass = 0
  ```
  (Demoted on review. The three command mappings and the `controlID == -1` selector are exactly
  right at 422150-422188. "The only writer" is not: `triggerAdvancedFollowCommand` clears `+24`
  and `+25` when it re-triggers an existing instance (422032-422037), and
  `processAdvancedFollowActions` clears `+25` itself when it spends a settle pass (466039). Any
  port that treats those bytes as owned solely by the control command will get re-triggering and
  pause/settle wrong.)
  <sub>GJBaseGameLayer::controlAdvancedFollowCommand, gd-ida-decomp.cpp:422150-422188</sub>

- **`getSavedPosition(id, delaySeconds)` reads a per-target ring of recorded positions and lerps between two samples; with `delaySeconds <= 0` it returns the live position, and it returns `(0,0)` when the requested sample is older than the recorded history.**
  ```
  if delaySeconds <= 0:
      id == -1 -> player1.getPosition()   (layer+2196)
      id == -2 -> player2.getPosition()   (layer+2200)
      id == -3 -> the CCPoint at layer+852
      else     -> tryGetMainObject(id), vtable+672 (its position); (0,0) if absent
  else:
      frames = max(0, delaySeconds/(1/240) - (layer[208]-layer[207])/1000.0)
      n      = ceil(frames)
      if n >= layer[241] /*samples recorded so far*/: return (0,0)
      base   = (player or object)+1152          # this target's slot in the ring
      len    = map(layer+11240)[uniqueID]       # this target's ring length
      j      = (layer[241] % len) - n;  if j < 0: j += len
      k      = (j+1 >= len) ? 0 : j+1
      p0 = ring[base + j]; p1 = ring[base + k]  # ring at layer[237], 8 bytes per entry
      return p0 + (p1 - p0) * (n - frames)
  ```
  `0.00416666667` in the source is 1/240; `unk_A9C828` is the constant point `(0,0)`.
  (Demoted on review. The ring arithmetic, the `ceil`, the early `(0,0)`, the 1/240 and the
  zero point are all exactly as written. Four things are not:
  **(a)** `base` is not an address — it is the **int value stored at** `+1152`, an index into the
  one shared ring at `layer[237]`, and it is used as `ring[base + j]` with 8 bytes per entry.
  Reading `+1152` as a pointer gives garbage.
  **(b)** For the two player ids the ring-length map is keyed by **the id itself** (`-1` / `-2`),
  not by a unique id; only the object branch keys it by `obj+772`.
  **(c)** The `-1 / -2 / -3` dispatch is **inferred, not read**. IDA prints all three tests as
  `a3 == NAN` because the parameter is typed `float` and compared as an int; the constants are
  not visible. The ordering matches the `1496 / 1497 / 1498 -> -1 / -2 / -3` override in
  `triggerAdvancedFollowCommand`, which is why it is probably right, but nothing in this function
  pins it.
  **(d)** The player position comes from **vtable slot +96**, not the `+672` the object branch
  uses. Slot 96 was not resolved, so "player1.getPosition()" is a guess at what it returns.)
  <sub>GJBaseGameLayer::getSavedPosition, gd-ida-decomp.cpp:453471-453611; the zero point, gd-ida-decomp.cpp:12244</sub>

- **3660's selector: with key 535 clear it edits every object of group key-51; with key 535 set it walks the instance list, matches `inst+12` (key 534) against the trigger's key-51 value, and edits each matched instance's follower group.**
  (Demoted on review. The key-535-clear branch is right: `getGroup(key51)` straight into
  `modifyGroupPhysics`. The key-535-set branch is not just "the follower group" — for each
  matched instance it re-runs the whole special-key resolution on **that instance's own trigger**
  (`getSpecialKey(inst+4, instTrigger+1632, instTrigger+1633)`, then `map(layer+2460)`), and when
  there is an entry it walks the `layer+2456` copy array over one or two passes exactly as the
  solver does. A port that skips that resolution will silently miss group copies.)
  <sub>GJBaseGameLayer::triggerAdvancedFollowEditCommand, gd-ida-decomp.cpp:442315-442364</sub>

- **Object id 2900 is a `RotateGameplayGameObject`, edited through `SetupRotateGameplayPopup`, and its full key set is 166, 167, 169, 171, 172, 173, 368, 582, 583, 584, 585. Key 174 is *not* read by it — the only consumer of key 174 in the binary is `GradientTriggerObject`.**
  ```
  key 166 -> +1636 int   rotation state
  key 167 -> +1640 int   reverse state
  key 169 -> +1644 bool  override the player's velocity after the rotation
  key 582 -> +1648 float velocity value A
  key 583 -> +1652 float velocity value B
  key 584 -> +1645 bool  velocity values are absolute (else they multiply)
  key 171 -> +1656 bool  also switch the active spawn channel
  key 173 -> +1660 int   the spawn channel id
  key 172 -> +1657 bool  do not touch the players at all
  key 368 -> +1664 bool  reset layer+596 and layer+600 to 1.0f
  key 585 -> +1665 bool  also issue player command 543
  ```
  (`1065353216` = `0x3F800000`: sign 0, exponent 127 -> 2^0, zero mantissa -> `1.0f`.)
  (Demoted on review. Every one of the eleven offsets re-derived clean from
  `RotateGameplayGameObject::customObjectSetup` — the parser indexes by `key * 4`, so
  `664 -> 166`, `2328 -> 582`, `2336 -> 584`, `2340 -> 585`, and so on. `1065353216 = 1.0f`
  re-decoded by hand and independently confirmed at `sub_2ADCD0`. What fails is **"its full key
  set"**: those are the keys `RotateGameplayGameObject::customObjectSetup` reads *of its own*,
  after it has already called `EffectGameObject::customObjectSetup`. In the real levels, 14 of
  the 20 object-2900s in level 22 carry **key 170**, which the base class parses to
  `EffectGameObject+1584` — plus keys 13, 57, 62, 87, 115, 135 and 155. Reading the list as the
  object's whole key set drops key 170 on 70% of the real instances.)
  <sub>RotateGameplayGameObject::customObjectSetup, gd-ida-decomp.cpp:301400-301469; RotateGameplayGameObject::getSaveString, gd-ida-decomp.cpp:325233-325379; GradientTriggerObject::customObjectSetup, gd-ida-decomp.cpp:300295-300299; key 170, EffectGameObject::customObjectSetup, gd-ida-decomp.cpp:298702-298704</sub>

- **`GJBaseGameLayer::rotateGameplay` does three separable things and nothing else.**
  ```
  if key171:
      layer[182] /*layer+728, the active spawn channel*/ = key173
      map(layer+764)[key173] = (key167 == 2 or key167 == 3)
  if not key172:
      PlayerObject::rotateGameplay(player1, key166, key167, key169, key582, key583, key584, key585)
      if layer[870]: same for player2
      # it then computes player1.position - trigger.position into a temp that is discarded,
      # and calls vtable slot 700 on the layer
  if key368:
      layer[149] = 1.0f   # layer+596
      layer[150] = 1.0f   # layer+600
  ```
  (Demoted on review. All three blocks, the eight arguments and both `1.0f` writes are exactly as
  the decompile has them. **"and nothing else" is not established**: the unresolved vtable slot
  700 call inside the `!key172` branch is a fourth thing, and it is the one that would actually
  rotate the world. Whatever it does is what gameplay rotation *looks* like. Also, the discarded
  `player1.position` in front of it comes from vtable slot **+96**, not `+672`.)
  <sub>GJBaseGameLayer::rotateGameplay, gd-ida-decomp.cpp:442807-442862</sub>

- **`PlayerObject::rotateGameplay` rotates gameplay by setting two independent flags from the two enums, then, only if the 90-degree flag actually changed, swaps the player's X and Y velocity components.**
  ```
  yVel = player[242 as double]  /*player+1936*/;  xVel = getCurrentXVelocity()
  was90 = player[1971]
  player[1971] = (key166 == 3 or key166 == 4)          # "gameplay rotated 90 degrees"
  flipGravity(player, (key166 == 1 or key166 == 4), 1)
  wasRev = player[1970]
  doReversePlayer(player, player[2336] ? player[1970] : (key167 == 2 or key167 == 3))
  updatePlayerArt()
  if player[1971] != was90:
      if player[1970] == wasRev: reset the dart streak / hard streak
      reset the trail particle, resetCollisionLog(1)
      force = (yVel, xVel)                              # components swapped
      if key169:
          force = key584 ? (key582, key583) : (yVel*key582, xVel*key583)
      updatePlayerForce(force, 0); player[2060] = 1; playerTeleported()
      if key585: handlePlayerCommand(543)
      if isInNormalMode() and not player[1480]: runRotateAction(0, 4)
      if player[2004]:
          swap player+1184 and player+1192; player+1200 = (player+1200 + 180) mod 360
          updateDashArt()
  ```
  So the rotation amount is fixed: key 166 selects among "nothing" (2 or 0), "flip gravity"
  (1), "rotate 90" (3) and "rotate 90 + flip gravity" (4); there is no free-angle option.
  (Demoted on review. The flag derivation, the `was90` gate, the component swap, the
  `key584`/`key582`/`key583` force and the fixed key-166 enum all re-verify at 152444-152553.
  Three details in the tail are wrong or glossed:
  **(a)** `player+1200 = (… + 180) mod 360` is **not** a modulo — the code is
  `v = p1200 + 180.0; if (v > 360.0) v -= 360.0`, a single conditional subtraction, which differs
  from `mod` for any value that is negative or already above 360.
  **(b)** "swap player+1184 and player+1192" is not a symmetric swap: `+1184` takes `+1192`'s
  double verbatim, but the value written back to `+1192` is the old `+1184` **round-tripped
  through `float`**.
  **(c)** "reset the dart streak / hard streak" hides two further gates — `player+1964` guards
  `createFadeOutDartStreak`, and `player+1896` guards `HardStreak::reset` + `placeStreakPoint`.
  The trail-particle reset is behind an unresolved vtable slot +624 on `player[441]`, so what it
  tests is not established.)
  <sub>PlayerObject::rotateGameplay, gd-ida-decomp.cpp:152444-152553</sub>

- **Key 571 is a per-object claim: setting it stamps `ph+36` with the current frame, and the gate at the top of the solver (`if ph+36 < frame`) then makes every *lower-priority* instance skip that object for the rest of the tick. Since the list is sorted by key 365 descending, this is how overlapping follows are arbitrated.**
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:453852 and 453986-453991</sub>

- **Key 572 reads as "what to do with an existing velocity when the start-speed kick fires": 1 = leave it alone, 2 = add, anything else = overwrite. The `ph.lastMoveFrame != 0` test in front of it means a brand-new physics record always takes the overwrite path regardless of key 572.**
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:453939-453985 (the key-572 test is at 453959)</sub>

- **The `i == 1` second pass and the `layer[614]` array are the group-copy mechanism shared with Enter effects: when `map(layer+2460)[specialKey]` has an entry, the follower group is resolved to a copy array instead of the plain group, and moves go through `getTargetGroup(v16, obj.groupParent)` so each copy moves its own instance of the group.**
  (Corrected on review: the second argument is `obj+772`, the object's **unique id**, not a group
  parent. `getTargetGroup(v16, uid)` is `objectAtIndex(layer+2456, v16+1)->objectForKey(uid)` —
  a `CCDictionary` keyed by unique id, not a group lookup. The rest of the bullet — the
  `map(layer+2460)` gate, `passes = v16 <= 0 ? 1 : 2`, and the `v16 - 1 + i` index into
  `layer+2456` — is exactly right. Whether this really is the Enter-effect copy array is still
  only likely; `addCustomEnterEffect` writes the same map but the link was not followed through.)
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:453786-453818 and 454369-454384;</sub>
  <sub>GJBaseGameLayer::getTargetGroup, gd-ida-decomp.cpp:425820-425828; GJBaseGameLayer::addCustomEnterEffect, gd-ida-decomp.cpp:467441-467456</sub>

- **`GameObject+550` (gated by key 336) is very likely the "is a player object" / "don't follow me" marker, since key 336 reads as an opt-out applied per follower; the byte itself was not traced to its writer.**
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:453870</sub>

- **In mode 2 the X update at line 454146 uses `vel.y` *after* the Y update at 454144 has already written it when neither axis mask is set, so the rotation is not a clean rigid rotation of the velocity vector. IDA's temporaries `v84`/`v85` are read before both writes, which suggests the compiler kept the originals in registers and the rotation is in fact correct; I could not settle this from the pseudo-C alone.**
  (Settled on review, against the first reading. Lines 454142-454146 are, verbatim:
  `v84 = *((float *)v22 + 1); v85 = *((float *)v22 + 2);` and only then the two masked writes to
  `v22 + 2` and `v22 + 1`. Both components are read into locals **before** either store, so the
  update *is* a clean rigid rotation and there is no ordering hazard. The `certain` pseudocode
  has been rewritten to name `vx0` / `vy0` so it cannot be misread as sequential.)
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:454139-454146</sub>

## Not established

- **The `-1 / -2 / -3` target constants are inferred everywhere they appear, never read.**
  IDA renders every comparison against them as `a3 == NAN` in `getSavedPosition`, because the id
  is passed in a float register and compared as an int. The three branches are distinguished only
  by the order they appear in and by the matching order of the `1496 / 1497 / 1498` overrides in
  `triggerAdvancedFollowCommand`. Which of player 1, player 2 and the `layer+852` point gets which
  number is therefore a strong guess, not a fact.
  <sub>GJBaseGameLayer::getSavedPosition, gd-ida-decomp.cpp:453516-453604; GJBaseGameLayer::triggerAdvancedFollowCommand, gd-ida-decomp.cpp:422008-422020</sub>

- **The player-position vtable slot `+96`.** Both `getSavedPosition` (for ids `-1` / `-2`) and
  `GJBaseGameLayer::rotateGameplay` fetch a player's position through vtable slot **96**, while
  every object path uses slot **672**. Slot 96 was not resolved, so whether it is the same
  "position" the follow solver subtracts from is not established. Two different slots on two
  different classes is exactly the sort of thing that silently offsets a whole subsystem.
  <sub>GJBaseGameLayer::getSavedPosition, gd-ida-decomp.cpp:453597; GJBaseGameLayer::rotateGameplay, gd-ida-decomp.cpp:442850</sub>

- **`rotateObjects`' fifth argument.** The apply block calls
  `rotateObjects(group, rot, unmodifiedPosition, point, 0)` — five arguments, the last a literal
  `0`. An earlier revision wrote the call with four and no trailing zero. What the `0` selects was
  not traced, and `rotateObject` (the single-object path) takes a different shape entirely.
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:454386-454394</sub>

- **`inst+16` (the reference object for the max-range test) has no writer.** It is set to 0 at
  instance creation and nothing in the decompile ever assigns it, so `rangeDist` always equals
  the follower's own distance. Either the field is set by code that did not decompile into a
  recognisable form, or the feature is dead in 2.206.
  <sub>GJBaseGameLayer::triggerAdvancedFollowCommand, gd-ida-decomp.cpp:422053 and 422095</sub>

- **`trigger+1860`, the tiebreak field in `compAdvFollowSort`, has no writer either** — the
  constructor zeroes it and neither `customObjectSetup` nor `getSaveString` mentions it, so the
  tiebreak is always false. It sits in the gap between key 365 (+1856) and key 366 (+1864).
  <sub>compAdvFollowSort, gd-ida-decomp.cpp:415123; AdvancedFollowTriggerObject::AdvancedFollowTriggerObject, gd-ida-decomp.cpp:305380-305384</sub>

- **Keys 310, 311, 312, 313, 314, 315 and 366 on trigger 3016, and key 570 on 3660, are parsed
  and saved but never read.** Their meaning is only guessable from their neighbours.
  <sub>AdvancedFollowTriggerObject::customObjectSetup, gd-ida-decomp.cpp:309187-309222 and 309431-309434; AdvancedFollowEditObject::customObjectSetup, gd-ida-decomp.cpp:309496-309499</sub>

- **Units.** The `* 0.01` on the acceleration, drag and turn-rate properties and the `* 240`
  on the frame delta fix the scale factors exactly, but I did not calibrate what an editor
  "speed" of 1 means in world units per second, and `getFollowSpeedVal`'s magnitude is passed
  straight through without a 0.01, so the start-speed field is on a different scale from the
  acceleration fields.
  <sub>GJBaseGameLayer::processAdvancedFollowAction, gd-ida-decomp.cpp:453993, 454012, 454218; GJBaseGameLayer::getFollowSpeedVal, gd-ida-decomp.cpp:428212</sub>

- **The `- (layer[208] - layer[207]) / 1000.0` term inside `getSavedPosition`** is subtracted
  from a frame count although its two operands look like millisecond timestamps
  (`GJBaseGameLayer+832` and `+828`). I did not find where those two fields are written, so I
  cannot say whether this is a sub-frame interpolation term or a scaling bug.
  <sub>GJBaseGameLayer::getSavedPosition, gd-ida-decomp.cpp:453503-453506</sub>

- **`GJBaseGameLayer+596` and `+600`** (the pair key 368 resets to `1.0f`) are read only inside
  `updateCamera`, where the surrounding control flow did not resolve into anything nameable.
  They are not the camera zoom fields the existing notes cover.
  <sub>GJBaseGameLayer::rotateGameplay, gd-ida-decomp.cpp:442857-442859; the reads at gd-ida-decomp.cpp:450043 and 450050</sub>

- **The vtable slot 700 call at the end of `GJBaseGameLayer::rotateGameplay`** was not
  followed, so whatever the gameplay rotation does to the camera or to the level's transform is
  unresolved. The `player1.position - trigger.position` point computed just before it is
  written to a stack temporary that nothing reads, which is probably an inlining artefact.
  <sub>GJBaseGameLayer::rotateGameplay, gd-ida-decomp.cpp:442850-442855</sub>

- **`GameObject+940`, the value `updateGameplayRotation` switches on**, comes out of
  `GameObject::determineSlopeDirection`, which I did not read, so the mapping from an editor
  rotation/flip to the 0-7 code is unknown.
  <sub>RotateGameplayGameObject::updateGameplayRotation, gd-ida-decomp.cpp:313504-313506</sub>

- **`PlayerObject+2336`, `+2060`, `+2004`, `+1480` and the doubles at `+1184/+1192/+1200`**
  that `PlayerObject::rotateGameplay` touches were not traced; only the writes are recorded
  above.
  <sub>PlayerObject::rotateGameplay, gd-ida-decomp.cpp:152486-152552</sub>

## Checked against the levels

Measured by decoding every official level (1-22, 3001, 5001-5004) with `loadOfficialLevel` and
listing the raw `props` of each matching object. Counts are objects, not triggers fired.

**Where they are.** 15 advanced-follow objects in total, all in the platformer levels plus one in
Dash; 20 gameplay-rotation objects, all in Dash.

```
3016  10   level 22 Dash 1 | 5002 Sewers 1 | 5003 Cellar 2 | 5004 Secret Hollow 6
3660   1   level 5004 Secret Hollow 1
3661   4   level 5004 Secret Hollow 4
2900  20   level 22 Dash 20
```

**Keys actually carried, with measured ranges.** Generic keys (1 id, 2 x, 3 y, 4/5 flip, 6 rot,
13, 20 editor layer, 36 trigger, 57 groups, 62 spawn-triggered, 87, 115, 135, 155) are listed
because a key set read off `customObjectSetup` alone will not predict them.

```
3016  (10)  51 on 10  [249..779]        71 on  5  [563..772]     138 on  5  = 1
            298 on  9  [5..999]          300 on  1  = 0.7         306 on  3  = 1
            307 on  2  = 1               316 on  3  = 5           334 on  6  [0.5..1.5]
            359 on  6  [60..120]         361 on  7  [10..200]     367 on  3  = 1
            558 on  6  [0.1..1]          560 on  1  = 563         561 on  6  [0.5..5]
            generic: 1, 2 [1125..27225], 3 [-1155..465], 36, 57, 62, 87, 155

3660  (1)   51 = 709   300 = 0.5   301 = 0.25   564 = 106   566 = 1   568 = 1
            generic: 1, 2, 3, 36, 57, 62, 87, 155

3661  (4)   51 on 4 = 731   71 on 4 [709..830]   566 on 4 = 1   568 on 4 = 1
            generic: 1, 2 [24615..29265], 3 [-1171..-375], 36, 57, 62, 87, 155

2900 (20)   166 on 20 [1..4]   167 on 20 [1..4]   169 on  7 = 1
            170 on 14 [1..14]  171 on 20 = 1      172 on  1 = 1
            173 on 15 [1..15]  582 on 18 = 1      583 on 18 [-1.21..1.1]
            generic: 1, 2 [2143.5..22603], 3 [135..2568], 4, 5, 6 [-270..90], 13,
                     20, 36, 57, 87, 115, 135, 155
```

**What this refutes or narrows.**

- **Key 170 breaks the "full key set" claim for 2900.** It is on 14 of the 20 real objects with
  values 1..14, and `RotateGameplayGameObject::customObjectSetup` never mentions it — the base
  `EffectGameObject::customObjectSetup` parses it to `+1584`. It travels alongside key 173 (the
  spawn channel, 1..15) on the same objects, so it is very likely part of the same channel
  feature, but nothing here says what it does. See the demoted bullet under **likely**.
- **Keys 584, 585 and 368 on 2900 appear on zero real objects.** Their offsets re-derive fine
  from the parser, but no shipped level exercises them; a port can get them wrong and every
  official level will still look right.
- **Mode 2 is never used.** Key 367 appears on only 3 of the 10 real 3016s and its value is
  always `1`. The entire turn-rate steering model — keys 316-333, the brake block, the
  `slot 16` collision between keys 331 and 333 — has no coverage in official content.
- **The arbitration keys are never used either.** Keys 365 (sort priority), 534 (control id),
  571 (per-object claim) and 572 (start-speed apply mode) appear on no official 3016, and no
  official 3660 or 3661 carries key 535. So the sorted instance list, the `ph+36` claim gate and
  both 535-set selector branches are unexercised by the shipped levels; they can only be checked
  against the binary.
- **Keys 363 and 364 are absent too**, so the heading turn divisor always falls through its
  `max(1.0, …)` floor and the aim angle is always re-latched, in every official use.
- **The "parsed but never read" keys never appear.** None of 310-315, 366, or 570 is on any
  official object, which is consistent with them being dead, though it does not prove it.
