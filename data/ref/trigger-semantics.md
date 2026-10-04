# Trigger semantics, read out of the 2.206 decompile

Extracted from `data/ref/gd-ida-decomp.cpp` (CallocGD/GD-2.206-Decompiled, 41 MB of IDA
pseudo-C from the GD 2.206 Android binary). Line numbers are into that file, so every claim
below can be checked: `sed -n '454433,454549p' data/ref/gd-ida-decomp.cpp`.

Confidence is the reader's own: **certain** means the code was read and says this,
**likely** means the structure says it but a name or a field was inferred, **inferred**
means it was reasoned from surrounding code rather than read directly. Treat anything
below "certain" as a thing to confirm against the game before trusting it.

This file is a reference, not a plan. When one of these rules becomes code it should move
into a named constant with a `[gdp]` tag, and this file is where that tag points.


## Scheduling: when a trigger fires, and in what order

Trigger firing in GD 2.206 runs down two separate paths per physics sub-step. Non-touch triggers fire from GJBaseGameLayer::checkSpawnObjects (:454433), which is a monotonic queue pop, not an overlap test: triggers are pre-sorted per gameplay channel by (ordering property 115, truncated cached x or y, uniqueID) and popped while their CACHED position (obj+1592, frozen at load time) is at or behind the player — or, in platformer mode, behind a time-derived virtual playhead from posForTime. Touch triggers instead fire from the ordinary collision pass (collisionCheckObjects, object types 20 and 45) with cells walked in section order and objects inside a cell sorted by uniqueID, which is the determinism anchor. The Spawn trigger's delay is property 63 in SECONDS, stepped by a per-tick SpawnTriggerAction; a delay <= 0 resolves synchronously and depth-first inside the same sub-step, a positive one queues, and the overshoot (timer - target) is carried down the chain through obj+1664 so fractional-tick error does not accumulate. Re-entrancy is bounded by a per-sub-step set keyed (last remap key, spawner uid or 0, group id). Spawn-ordered staggering divides x distance by 311.580109 units/sec. Toggling is a signed per-object counter (obj+1036; hidden when negative) that stops drawing, colliding and triggering at once, and a disabled group cannot be spawned at all. Randomness comes from one global LCG (seed = seed*214013 + 2531011, output (seed>>16)&0x7FFF) that IS seeded per attempt — from wall-clock time normally, but from a stored seed in replay mode, with the seed written into the replay string itself; that is the exact precedent the port should copy for macro replay. The one thing I could not resolve is how multi-trigger re-arms a touch-triggered trigger: the map it depends on is never pruned in this build, so the literal reading says it fires once per attempt. That is flagged rather than guessed.

### certain

- **A non-touch trigger fires from GJBaseGameLayer::checkSpawnObjects, not from any overlap test. Per physics sub-step it walks an ordered array for the currently active 'spawn channel' and pops entries while the queue head has been passed. Pseudocode: ref = player1.isPlatformer ? this->posForTime(m_unwarpedTime) : player1.getPosition(); loop { arr = orderedArrayFor(activeChannel); i = channelIndex[activeChannel]; rev = channelReversed[activeChannel]; if (i >= arr.count) break; obj = arr[i]; ... pass-test ... ; if (!obj.groupDisabled && !skip) obj.triggerObject(layer, playerIdx=0, remap=null); channelIndex[activeChannel]++ }. The index only ever moves forward; there is no un-firing.**

  ```
  fire condition per entry (non-touch): !rev ? (obj.cachedPos.x <= ref.x) : (obj.cachedPos.x >= ref.x); when player1.m_rotatedGameplay(+1971) is set the same test uses .y instead of .x. In platformer mode (layer+10734) the plain x<=ref.x form is always used. Lines :454494-454525.
  ```

  <sub>GJBaseGameLayer::checkSpawnObjects, gd-ida-decomp.cpp:454433-454549; called from GJBaseGameLayer::update at :469942 and from the start-pos warm-up at :469502</sub>

- **The x compared against the player is NOT the trigger's live position. It is a CCPoint cached in obj+1592, written once by GJBaseGameLayer::orderSpawnObjects (which runs on level load / full reset, not per frame). Moving a trigger at runtime does not change where it activates.**

  <sub>GJBaseGameLayer::orderSpawnObjects :432836-432871 (calls obj vtable+900 -> stores into obj+1592); read in checkSpawnObjects :454494 and in all four comparators :120309-120443</sub>

- **Ordering of the activation queue. LevelTools::sortChannelOrderObjects buckets every ordered trigger by its channel (obj+1584, property 170) and qsorts each bucket with one of four comparators picked by the channel's gameplay direction: 1 -> compOrderY (+y), 2 -> compOrderYInv (-y), 3 -> compOrderXInv (-x), anything else (default 4) -> compOrder (+x). All four use the same three-level key.** (Added 2026-09-28: a channel's direction is getObjectDirection of the first Rotate Gameplay in the ordered array with key 171 whose key 173 names that channel, :122830-122844; a channel no turn switches to is 4. The second key is (int) of a float add, so two triggers less than a unit apart fall to the uniqueID.)

  ```
  compare(a,b): 1) a.ordering(+1580, property 115) - b.ordering; if equal 2) (int)((float)ordering + a.cachedPos.x) - (int)((float)ordering + b.cachedPos.x)  [note: the SAME 'ordering' float is added to both sides; XInv subtracts, Y/YInv use .y]; if still equal 3) a.uniqueID(+772) - b.uniqueID. Third key makes the order total, so qsort's instability is harmless — deterministic.
  ```

  <sub>LevelTools::sortChannelOrderObjects :122777-122920 (comparator select :122893-122908); comparators :120294-120460</sub>

- **Touch-triggered triggers fire from the collision pass instead: GJBaseGameLayer::collisionCheckObjects, object-type cases 0x14 (20) and 0x2D (45), call playerTouchedTrigger after the ordinary AABB (or OBB / circle) overlap test against the player rect and after canTouchObject(obj).**

  <sub>GJBaseGameLayer::collisionCheckObjects :463309-463674 (overlap tests :463457-463487, type switch case 0x14/0x2D at :463671-463674)</sub>

- **canTouchObject gates touch activation by channel: if the layer's active spawn channel (layer+728) is 0 every object is touchable; otherwise a trigger (obj+1076==1) with a non-zero channel (obj+1584) is touchable only when its channel equals the active one.** (Added 2026-09-28: +1076 == 1 is every EffectGameObject, not only triggers — orbs, pads, the mode, gravity, speed, size, mirror, dual and teleport portals, collectibles and checkpoints, per GameObject::createWithKey :182950-183752 — and the gate sits in the same test as the overlap, :463487, so a gated object is simply not touched.)

  <sub>GJBaseGameLayer::canTouchObject :421284-421300</sub>

- **Within one collision cell the objects are sorted by uniqueID (obj+772) ascending before collisionCheckObjects runs, via std::__sort with mIDCompSort, and only when that cell's dirty bit is set; each object's index in the cell is then written back to obj+524. Cells are visited in (sectionX ascending, sectionY ascending) order. This is the determinism anchor for same-frame trigger order on the touch path.**

  <sub>GJBaseGameLayer::checkCollisions :464922-464959; mIDCompSort :415061-415063</sub>

- **Spawn Trigger (1268) property layout, from SpawnTriggerGameObject::customObjectSetup: property 51 -> target group (obj+1276); property 63 -> spawn delay, parsed with atof into a float at obj+1672, i.e. SECONDS not frames; property 556 -> delay randomness (float, obj+1676); property 441 -> 'spawn ordered' bool (obj+1478); property 442 -> remap pair list parsed into std::vector<ChanceObject> at obj+1636; property 581 -> obj+1680 (suppresses inheriting the caller's remap chain); property 102 -> obj+1477 (editor/preview only).**

  <sub>SpawnTriggerGameObject::customObjectSetup :314465-314535</sub>

- **Spawn Trigger firing. delay = obj.spawnDelay; if obj.delayRandom != 0 and the layer exists and (!layer.isPlatformer || layer+1540 == 1): delay += fast_rand_minus1_1() * delayRandom, clamped at >= 0. Then delay -= obj.carry (a double at obj+1664), spawnGroupTriggered(layer, targetGroup, delay, ordered, remapChain, obj.uniqueID, obj+1484) is called, and obj.carry is reset to 0.**

  ```
  effectiveDelay = max(0, spawnDelay + rand[-1,1]*delayRandom) - carry ; carry := 0
  ```

  <sub>SpawnTriggerGameObject::triggerObject :302543-302566</sub>

- **Delay dispatch: GJBaseGameLayer::spawnGroupTriggered queues only when the delay is strictly > 0. delay <= 0 calls GJBaseGameLayer::spawnGroup synchronously in the same sub-step, so a 0-delay spawn chain resolves fully inside one tick, depth-first.**

  <sub>GJBaseGameLayer::spawnGroupTriggered :421704-421710 (if (a3 > 0.0) GJEffectManager::spawnGroup(...) else vtable+616 == GJBaseGameLayer::spawnGroup)</sub>

- **Queued spawns live in GJEffectManager's std::vector<SpawnTriggerAction> (56 bytes each: +0 finished flag, +1 paused flag, +8 double targetDelay, +16 double timer, +24 group id, +28 spawner uniqueID, +32 spawner control id, +36 ordered flag, +40 GameObject* for the single-object form, +44 std::vector<int> remap chain). They are appended in call order and stepped in index order.**

  ```
  step(dt): if (!finished && !paused) { timer += dt; finished = (timer >= targetDelay); }  — dt is the per-sub-step seconds value
  ```

  <sub>GJEffectManager::spawnGroup :485943-486010 and GJEffectManager::spawnObject :485850-485925 (field writes); SpawnTriggerAction::step :472755-472767</sub>

- **GJEffectManager::updateSpawnTriggers(dt) snapshots the action count BEFORE the loop, so actions appended by a firing action are NOT stepped in the same tick — they wait one sub-step at minimum. Finished actions fire in ascending vector index (= insertion) order, then a single remove_if compaction erases all finished entries at the end.**

  <sub>GJEffectManager::updateSpawnTriggers :484048-484175 (count snapshot at :484069, loop :484071-484098, compaction :484100-484170)</sub>

- **Sub-frame carry: when a queued action fires, the overshoot (timer - targetDelay) is handed to the callback as its own 'delay' argument. GJBaseGameLayer::spawnObject stores that overshoot into a spawned Spawn trigger's obj+1664 carry, which that trigger then subtracts from its own delay. This propagates fractional-tick error down a whole spawn chain.**

  ```
  overshoot = action.timer - action.targetDelay ; spawnedSpawnTrigger.carry = overshoot ; its next delay = ownDelay - carry
  ```

  <sub>GJEffectManager::updateSpawnTriggers :484077 (v7 = *(double*)(act+16) - *(double*)(act+8)); GJBaseGameLayer::spawnObject :456063 and :456077 (*((_QWORD *)this + 208) = a3, i.e. obj+1664 = delay); consumed in SpawnTriggerGameObject::triggerObject :302556</sub>

- **GJBaseGameLayer::spawnGroup has a per-sub-step re-entrancy guard: a std::set<tuple<int,int,int>> at layer+2604 keyed (remapKey, spawnerKey, groupID). If the key is already present the whole call is a no-op. remapKey = remapChain.empty() ? 0 : -(last element of the remap chain). spawnerKey = layer+1547 ? spawnerUniqueID : 0. The set is cleared twice per sub-step in GJBaseGameLayer::update, so a group can only be spawned once per (key) per sub-step — this is what stops infinite spawn loops.**

  <sub>GJBaseGameLayer::spawnGroup :443163-443230 (key build :443184-443199, set probe/insert :443200-443221); set cleared in GJBaseGameLayer::update at :469806 and :469836</sub>

- **spawnGroup also refuses outright if the target group is toggled off: the very first statement is GJEffectManager::isGroupEnabled(groupID) and it returns immediately when false.**

  <sub>GJBaseGameLayer::spawnGroup :443182-443183</sub>

- **Unordered spawn: the members of the target group are triggered in the group array's own order, each via GJBaseGameLayer::spawnObject(obj, delay, remapChain). That order is not load order for a spawn target: once, as the level finishes loading, every group some Spawn trigger (1268) names in key 51 — every group at all when the level sets kA38 — is qsorted by integer x ((int)getPosition().x). It is never re-sorted after objects move, and qsort leaves ties in no defined order.**

  <sub>GJBaseGameLayer::spawnGroup :443228-443246; sortGroups :453213-453279 (from updateSpecialGroupData :467051-467064, PlayLayer::setupHasCompleted :106195), sortAllGroupsX :423269-423279, xCompPosition :415180-415187</sub>

- **Ordered spawn ('Spawn Ordered', property 441) staggers the group members by their x distance from the first spawnable trigger in the (x-sorted) group — the first member whose id passes GameObject::isSpawnableTrigger (an id test only, whether or not that member opted in to being spawned; a particle object 2065 counts with key 123), converted to time at 1x scroll speed. The first spawnable member fires immediately and defines x0; every later member i gets t = (x_i - x0)/311.580109 - baseDelay, and fires immediately if t <= 0, otherwise is queued with delay t. The x values are where the members stand now (getPosition, :421760-421770), so a moved group staggers by its moved spacing; only the load-time sort goes by the file.**

  ```
  t_i = (obj_i.getPositionX() - x0) / 311.580109 - baseDelay  (311.580109 GD units/sec = 1x speed)
  ```

  <sub>GJBaseGameLayer::spawnObjectsInOrder :421726-421805; the constant is at :421771</sub>

- **GJBaseGameLayer::spawnObject gating: non-triggers (obj+1076 != 1) get vtable[752] instead. A trigger is spawned only if !obj.groupDisabled(+550) AND (obj.multiTrigger(+1476) || !obj->vtable[768]() /*has not already been activated*/) AND obj.spawnTriggered(+1285) AND GameObject::isSpawnableTrigger(obj). A trigger without property 62 set can never be fired by a Spawn trigger.**

  <sub>GJBaseGameLayer::spawnObject :456038-456090 (gating at :456043-456052); GameObject::isSpawnableTrigger :173769+</sub>

- **Trigger flag property map, from EffectGameObject::customObjectSetup: property 11 -> obj+1284 touchTriggered (only assigned if not already set, because EffectGameObject::firstSetup forces it to 1 for object id 2063); property 62 -> obj+1285 spawnTriggered; property 87 -> obj+1476 multiTrigger; property 284 -> obj+1548 (forces the per-player key to 0, i.e. both players share one activation record); property 115 -> obj+1580 ordering; property 170 -> obj+1584 channel; property 534 -> obj+1484 (control id, passed alongside uniqueID everywhere); property 51 -> obj+1276 target group; property 56 -> obj+1449 'activate group' bool; property 71 -> obj+1280 secondary group; property 10 -> obj+1264 (chance/float slot).**

  <sub>EffectGameObject::customObjectSetup :298669-298780; EffectGameObject::firstSetup :297434-297438</sub>

- **Touch activation bookkeeping (GJBaseGameLayer::playerTouchedTrigger): the function returns immediately unless obj.touchTriggered(+1284). key = {obj.uniqueID, obj+1548 ? 0 : player.index(+772)}. If obj.multiTrigger(+1476): when the key is NOT yet in the layer's touch map (layer+992, std::map<pair<int,int>,int>) call GJEffectManager::removeTriggeredID(key) to re-arm, then write touchMap[key] = layer.frameCounter(+816). Then, if !GJEffectManager::hasBeenTriggered(key): storeTriggeredID(key), refresh remap keys if the object id is 1268, and call obj->triggerObject(layer, player.index, null).**

  <sub>GJBaseGameLayer::playerTouchedTrigger :456781-456824</sub>

- **The 'has been triggered' record is a std::set<pair<int,int>> at GJEffectManager+692 keyed (objectUniqueID, playerIndex). It is wiped only by GJEffectManager::resetTriggeredIDs (called from resetEffects, i.e. level reset) and per-object by the Reset trigger.**

  <sub>GJEffectManager::hasBeenTriggered :476828-476875, storeTriggeredID :476890+, removeTriggeredID :476713+, resetTriggeredIDs :476211-476220, called from resetEffects :488248</sub>

- **The Reset trigger clears activation records for a whole group: for every member of its target group it calls removeTriggeredID(uid, player1.index), removeTriggeredID(uid, player2.index) and removeTriggeredID(uid, 0) (object id 2063 gets all three; object types 30 and 21 get the (uid,0) form plus vtable[748]).**

  <sub>GJBaseGameLayer::activateResetTrigger :429061-429115</sub>

- **canBeActivatedByPlayer (used by pads/orbs/portals, not by triggers) returns true only when EnhancedGameObject::activatedByPlayer reports the object had not yet been activated by that player; the per-player latches are obj+1256 (player 1) / obj+1257 (player 2) plus obj+1255 (any), all cleared by EnhancedGameObject::resetObject.**

  <sub>GJBaseGameLayer::canBeActivatedByPlayer :456752-456766; playerWasTouchingObject :440600-440612; playerTouchedObject :456726-456737; EnhancedGameObject::activatedByPlayer :165225-165245; resetObject :170040-170065</sub>

- **Toggle Trigger (1049) calls GJBaseGameLayer::toggleGroup(targetGroup = obj+1276 (property 51), enable = obj+1449 (property 56)) directly. It does NOT go through toggleGroupTriggered, so it has no spawn side-effect.**

  <sub>EffectGameObject::triggerObject, case 1049, :315483-315484</sub>

- **GJBaseGameLayer::toggleGroup(gid, enable) is a no-op when isGroupEnabled(gid) already equals enable. Otherwise it walks the group array calling GameObject::groupWasEnabled / groupWasDisabled on every member, then flips the manager's bit.**

  <sub>GJBaseGameLayer::toggleGroup :423020-423085</sub>

- **Per-object toggle state is a signed counter, not a boolean: GameObject::groupWasEnabled does ++obj.counter(+1036), groupWasDisabled does --obj.counter, and both set obj.groupDisabled(+550) = (counter < 0). resetGroupDisabled zeroes both. An object in several groups therefore needs net-negative toggles to hide.**

  <sub>GameObject::groupWasEnabled :169882-169892, groupWasDisabled :169906-169916, getGroupDisabled :169863-169866, resetGroupDisabled :169926-169932</sub>

- **obj.groupDisabled stops BOTH drawing and colliding, and also stops the object acting as a trigger. Drawing: preUpdateVisibility refuses to add it to the draw list. Collision: collisionCheckObjects skips it at the top of the loop and checkCollisions guards its two extra loops with getGroupDisabled. Triggering: checkSpawnObjects will not fire it (but still advances the queue index past it), and spawnObject refuses it.**

  <sub>draw: preUpdateVisibility :452787, :452826, :452867, :452902 (all '!*(_BYTE *)(x + 550)' guards); collide: collisionCheckObjects :463390, checkCollisions :464981 and :465026; trigger: checkSpawnObjects :454529, spawnObject :456044</sub>

- **Group enable state lives in GJEffectManager as a 10000-bit vector<bool> (indices clamped to [0,9999]) plus a hash-set of disabled groups for save state. resetToggledGroups fills the bit vector with TRUE, so every group is enabled by default.**

  <sub>GJEffectManager::isGroupEnabled :474852-474861, GJEffectManager::toggleGroup :482093-482115, resetToggledGroups :476072-476090; checkpoint restore loops j = 0..9999 at PlayLayer :105612-105620</sub>

- **The RNG is a single global 64-bit LCG in GameToolbox, shared by every consumer. fast_rand(): seed = seed * 214013 + 2531011; return (seed >> 16) & 0x7FFF. fast_rand_0_1() = fast_rand() / 32767.0f. fast_rand_minus1_1() = 2*fast_rand_0_1() - 1. (IDA prints the multiplier as '&stru_343FC.st_name + 1'; 0x343FC = 214012, so the constant is 214013 — the MSVC rand pair with 2531011.)**

  ```
  seed = (seed * 214013 + 2531011) mod 2^64 ; out = (seed >> 16) & 0x7FFF
  ```

  <sub>GameToolbox::fast_rand :43866-43870, fast_rand_0_1 :43886-43889, fast_rand_minus1_1 :43905-43911, fast_srand :43827-43830</sub>

- **The RNG IS seeded per attempt, and the seed is stored. On level start/reset: if (!layer+10852 /*replay mode*/ || (seed = layer+11088) == 0) { gettimeofday(&tv); seed = tv.tv_sec * tv.tv_usec; } layer+11080 = seed; fast_srand(seed). So a normal attempt gets a wall-clock seed, but a replay supplies its own stored seed and reproduces exactly. Replay strings carry the seed as a trailing field: the button-command parser ends with fast_srand(atoi(field)) and stores it in layer+11088.**

  ```
  seed = replayMode && storedSeed != 0 ? storedSeed : (tv_sec * tv_usec)
  ```

  <sub>PlayLayer reset/start :105790-105797; replay/button-command loader :438492-438497</sub>

- **Random Trigger (1912): one fast_rand_0_1() draw per activation. if (fast_rand_0_1() * 100.0f > obj.chance /*float at obj+1264, property 10*/) target = obj+1280 (group B) else target = obj+1276 (group A); then spawnGroupTriggered(layer, target, delay=0, ordered=false, remapChain, obj.uniqueID, obj+1484). So 'chance' percent of the time group A wins.**

  ```
  pick = (fast_rand_0_1()*100.0f > chance) ? groupB : groupA
  ```

  <sub>EffectGameObject::triggerObject, case 1912, :315391-315406</sub>

- **Advanced Random (2068) = RandTriggerGameObject::triggerObject: groupID = getRandomGroupID(); spawnGroupTriggered(layer, groupID, delay=0, ordered=false, remapChain, obj.uniqueID, obj+1484). getRandomGroupID does total = sum of all entry weights, r = lroundf(fast_rand_0_1() * total), then walks the entries accumulating weights and returns the first entry whose running sum >= r (0 if none). Entries are ChanceObject, 16 bytes: {int groupID @0, int @4, int weight @8, int @12}; the returned id is field 0. Exactly one RNG draw per activation, and the walk is in stored entry order.**

  ```
  r = lroundf(fast_rand_0_1() * totalWeight); acc = 0; for e in entries { acc += e.weight; if (acc >= r) return e.groupID } return 0
  ```

  <sub>RandTriggerGameObject::triggerObject :315696-315710; getRandomGroupID :311478-311505; getTotalChance :311444-311462; ChanceObject layout from SequenceTriggerGameObject::addTarget :311540+</sub>

- **Per-sub-step execution order inside GJBaseGameLayer::update, which fixes when spawns resolve relative to physics: m_time += dt; vtable[584]; clear the spawn guard set; GJEffectManager::updateSpawnTriggers(dt); updateTimeMod; processCommands(dt) (this increments the frame counter layer+816 and dispatches replay buttons); resetTouchedRings; resetCollisionLog; preCollisionCheck; clear guard set again; updateTimers; prepareMoveActions; processMoveActionsStep; postMoveActions; updateCollisionBlocks; PlayerObject::update; checkCollisions (touch triggers fire here); updateSpecial; [player 2 same]; checkSpawnObjects (pass-by triggers fire here); updateRotation; save positions; postCollisionCheck; checkRepellPlayer; processStateObjects; processStateTriggers; updateTweenActions; updateCamera.**

  <sub>GJBaseGameLayer::update :469606-469990 (sub-step loop body :469800-469975)</sub>

### likely

- **Membership of the ordered queue is decided once, when an object is added to the layer: an object joins only if it is a trigger (obj+1080 set AND obj+1076 == 1) AND ((!touchTriggered && !spawnTriggered) || obj->vtable[836]()). So plain spawn-triggered and touch-triggered triggers are normally absent from the pass-by queue entirely.**

  <sub>GJBaseGameLayer::addToSection-style add path, :89916-89921; mirrored in LevelEditorLayer reload at :199111-199114</sub>

- **If the queue head IS a touch-triggered trigger, the scan STOPS until that object has been touched at least once (obj+1255 'activatedByPlayer' latch); once touched, the entry is skipped (never fired from here) and the index advances. This can stall every later trigger on that channel.**

  <sub>GJBaseGameLayer::checkSpawnObjects :454484-454492; obj+1255 is set by EnhancedGameObject::activatedByPlayer :165231 and cleared by EnhancedGameObject::resetObject :170056</sub>

- **toggleGroupTriggered (the variant used by pickup items with obj+1501 set, vtable slot 612) does toggleGroup(gid, enable) and then, when enable is true, ALSO calls spawnGroup on the same group. Do not use this path for the plain 1049 Toggle trigger.**

  <sub>GJBaseGameLayer::toggleGroupTriggered :423103-423110; caller EffectGameObject::triggerObject :314856-314876</sub>

- **Sub-step sizing: getModifiedDelta quantises the frame delta to a fixed step of 1/240 s (literal 0.00416666688) when timeWarp >= 1, or timeWarp*0.0041667 when timeWarp < 1, carrying the remainder in a double at layer+10984. update() then splits the returned delta into n = max(1, round(...)) equal sub-steps, and hands PlayerObject::update a delta expressed in 60 Hz frames (dt*60/n).**

  ```
  step = (timeWarp >= 1) ? 0.00416666688 : timeWarp * 0.0041667 ; out = round(accum/step) * step ; leftover = accum - out
  ```

  <sub>GJBaseGameLayer::getModifiedDelta :430223-430248; sub-step split in GJBaseGameLayer::update :469727-469742</sub>

- **Starting from a StartPos (or fast-forwarding) runs a separate warm-up loop at a FIXED 1/60 s step (literal 0.016667, count = (int)(ceilf(t/0.016667) + 1.0), t clamped to 3600 s). Each warm-up step teleports the player via posForTime, clears the spawn guard set, runs updateSpawnTriggers, move actions, then checkSpawnObjects twice — once on the current channel and once after layer+728 = layer+732, the channel posForTime's walk is on. A port that warms up at 240 Hz will diverge from the real game.** Ported as `sim.warmUp` over `physics/timeTable.ts`.

  <sub>GJBaseGameLayer::loadUpToPosition :469428-469517, called by loadStartPosObject :469534-469590; +732 written by PlayLayer::posForTime :87537-87547</sub>

- **Without a start position or a checkpoint, resetLevel runs checkSpawnObjects once before the first step, with the song and SFX triggers deferred (+1550): whatever sits at or behind the player's start fires at time 0, not in the first step.** Ported as `sim.checkPassedAtReset`.

  <sub>PlayLayer::resetLevel :105954-105963</sub>

- **Spawn remaps: each Spawn trigger with a non-empty property-442 pair list is assigned an index (obj+1648) into a layer-level vector<unordered_map<int,int>> at layer+1604 by generateSpawnRemap/registerSpawnRemap (index 0 is a dummy empty map, so <= 0 means 'no remap'). SpawnTriggerGameObject::updateRemapKeys maintains a std::vector<int> chain at obj+1652: with no own remap and obj+1680 clear it copies the incoming chain; with an own remap it extends it. GJBaseGameLayer::spawnObject applies the chain with applyRemap before triggering a spawned object and restoreRemap afterwards; the chain's last element is what feeds the spawnGroup re-entrancy key.**

  <sub>generateSpawnRemap :460146-460200; registerSpawnRemap :460107-460130; SpawnTriggerGameObject::updateRemapKeys :325395-325520; apply/restore in GJBaseGameLayer::spawnObject :456065-456085</sub>

### Not established

- MULTI-TRIGGER (property 87) ON TOUCH-TRIGGERED TRIGGERS DOES NOT RE-ARM in the code as decompiled, and I could not find the missing piece. playerTouchedTrigger only calls removeTriggeredID when the (objUID, playerIdx) key is absent from the layer's touch map (layer+992), but that map is never pruned: its only writers are playerTouchedObject (:456726) and playerTouchedTrigger itself (:456808), and its only clear is in resetLevelVariables (:462990). I grepped every reference to offsets 992/996 and to std::map<pair<int,int>,int> — there is no per-frame erase. Taken literally, a touch trigger fires once per attempt even with multi-trigger, and only a Reset trigger re-arms it. Either the prune lives somewhere I did not find (e.g. behind a vtable call I did not resolve) or the real semantics differ; do NOT ship the literal reading without testing against the game.
- The exact argument lists of several calls were dropped by IDA and had to be reconstructed from data/ref/GJBaseGameLayer.cpp / GJEffectManager.cpp signatures: GJBaseGameLayer::spawnGroupTriggered (:421704-421710 shows only 4 of 7 args), the effect-manager delegate callbacks in updateSpawnTriggers (:484082-484090, vtable slots 1 and 2 of the interface at GJBaseGameLayer+316), and toggleGroupTriggered's spawnGroup call (:423108). The argument ORDER is inferred, not read.
- lroundf()/roundf() call sites lost their arguments. getModifiedDelta (:430245) is almost certainly lroundf(accum/step) and update (:469727) roundf(dt/step), and getRandomGroupID (:311489) is lroundf(rand01 * totalWeight), but none of the three is directly readable. If the port's tick count is ever off by one at a frame boundary, this is the first place to re-check.
- vtable slot 836 — the predicate that lets SOME touch/spawn-triggered triggers into the ordered pass-by queue (:89918, :199112) — is unidentified. Without it I cannot say which touch triggers end up in the queue and can stall it (see the checkSpawnObjects finding).
- vtable slot 900, which orderSpawnObjects (:432861) calls to produce the cached CCPoint at obj+1592, is unidentified. EffectGameObject::spawnXPosition (:302641) shows a related rule (touch/spawn-triggered triggers report obj+1468 instead of their node x) but it returns a scalar and so is a different slot. I could not confirm whether obj+1592 is the design-time position or a start-position field.
- PlayerObject+1971, the flag that switches checkSpawnObjects' pass test from x to y (:454504), is unnamed. Context (:144344) makes 'rotated/vertical gameplay' the obvious reading, but it is inferred.
- layer+1547, which decides whether the spawnGroup re-entrancy key includes the spawner's uniqueID (:443188), comes from LevelSettingsObject+364 and is forced true in platformer mode plus one hard-coded level check (:462937-462940). I could not identify which level setting that is. It materially changes behaviour: with it clear, two different Spawn triggers hitting the same group in one sub-step collapse into one spawn.
- How the active spawn channel (layer+728) is switched at runtime: the Gameplay Direction trigger (2900) dispatches through vtable slot 696 (:314911) and I did not follow it, so the rules for which channel becomes active, and for the per-channel 'reversed' flag read at checkSpawnObjects :454500 (map at layer+764), are unresolved beyond resetSpawnChannelIndex zeroing them all (:454562).
- Object-id special cases seen but not investigated: 3640 (extra vtable[904] call at the top of playerTouchedTrigger, :456792), 2063 (firstSetup forces touchTriggered=1, :297437; Reset trigger treats it specially, :429100), 2065 (spawnObjectsInOrder gates it on obj+1229, :421787), and 2900's per-object direction field at obj+1660.
- I did not verify the 62/36 property pairing named in the brief. In this binary the touch-triggered byte (obj+1284) is written ONLY from property 11 (:298673) and 'spawn triggered' (obj+1285) only from property 62 (:298683). Property 36 appears once, at :299802, controlling an unrelated float at obj+1268 together with property 35. If the port currently reads 36 as touch-triggered, that is worth re-checking against real level strings.


## Movement and easing

Movement and easing in GD 2.206 run through one easing function and one command struct. GameToolbox::getEasedValue(t, type, rate) (gd-ida-decomp.cpp:44226) is a straight port of the cocos2d CCEase family with the easing rate doubling as the exponent for EaseIn/Out/InOut and as the PERIOD for the three elastic modes; rate <= 0 becomes 2.0, type 0 or out-of-range returns t. The 18 modes map exactly onto the editor names (confirmed at GameToolbox::easeToText, 44085). Every timed group action is a 488-byte GroupCommandObject2 in a vector on GJEffectManager; move, rotate and scale all share the same machinery, differing only in the "slot" they register (1 = X, 2 = Y, 3 = rotation degrees, 4 = 0..1 progress). Motion is an absolute eased curve sampled each tick and consumed as the delta since the previous tick, so simultaneous move commands on one group simply add (they all feed one CCMoveCNode keyed on target group id), whereas simultaneous rotate commands are merged by claimRotationAction into a single application. Three determinism-critical details: a freshly created command skips its first step() (the +432 flag), so nothing moves on the trigger tick and a duration-0 move lands on the second tick; teardown takes two further ticks and is what writes the group's permanent offset map; and rotate/scale run before move in the sub-step and consume the group's move delta via claimMoveAction, so ordering cannot be swapped. Rotation and scaling both pivot on the unmodified position of the centre group's main object — with no centre object a rotate only spins objects in place and a scale only changes each object's own scale with no position change. The static/optimized group split is pure batching and collapses to a no-op at one sub-step per tick, which is what a fixed 240 Hz port has.

### certain

- **The single easing function is GameToolbox::getEasedValue(float t, int easingType, float easingRate) -> float. IDA renders it with a spurious 4th arg (a4) that is never read, and misattributes `t` to `this`; the mangled name _ZN11GameToolbox13getEasedValueEfif confirms exactly (float, int, float). It is the ONLY easing entry point used by move/rotate/scale/keyframe/dynamic-move.**

  ```
  getEasedValue(t, type, rate) — see the full branch table in the next finding
  ```

  <sub>gd-ida-decomp.cpp:44226-44426 (GameToolbox::getEasedValue); call sites at 716476 (GroupCommandObject2::updateAction), 486411/486464/486563 (keyframe path in prepareMoveActions), 445471 (processDynamicObjectActions), 417589, 419190, 466449</sub>

- **Easing rate is clamped once, before the switch: if (rate <= 0) rate = 2.0. This applies to every mode (including elastic, where the rate IS the period). There is a dead `if (rate == 0) rate = 0.45` inside the ElasticInOut branch that can never fire because of the earlier clamp. easingType == 0, and any type outside 1..18, return t unchanged (linear).**

  ```
  r = (rate <= 0) ? 2.0 : rate ; type<=0 or type>18 => return t
  ```

  <sub>gd-ida-decomp.cpp:44255-44262 (`if (a2 == 0.0) goto LABEL_59; LODWORD(v7)=LODWORD(a2)-1; if (a3 <= 0.0) v6 = 2.0;`) and 44420-44422 (`default: goto LABEL_59` -> return t)</sub>

- **Complete easing branch table. t is the already-clamped progress in [0,1]; r is the clamped rate; bounce() is GameToolbox::bounceTime. Mode numbering confirmed against GameToolbox::easeToText. All arithmetic in the binary is float32; pi is the float constant (float)M_PI (IDA prints float literals at ~5 significant digits, hence '3.1416'/'1.5708'; double literals print in full, e.g. '0.363636364', '57.2957795').**

  ```
  0 None: f = t
  1 EaseInOut: u=2t; f = (u<1) ? 0.5*pow(u,r) : 1 - 0.5*pow(2-u, r)
  2 EaseIn: f = pow(t, r)
  3 EaseOut: f = pow(t, 1/r)
  4 ElasticInOut: if(t==0||t==1) f=t else { u=2t-1; s=r*0.25; f = (u<0) ? -0.5*pow(2,10u)*sin(2*PI*(u-s)/r) : 0.5*pow(2,-10u)*sin(2*PI*(u-s)/r) + 1 }
  5 ElasticIn: if(t==0) f=0 else if(t==1) f=1 else { u=t-1; f = -( pow(2,10u) * sin(2*PI*(u - r*0.25)/r) ) }
  6 ElasticOut: if(t==0) f=0 else if(t==1) f=1 else f = pow(2,-10t)*sin(2*PI*(t - r*0.25)/r) + 1
  7 BounceInOut: f = (t<0.5) ? 0.5*(1 - bounce(1-2t)) : 0.5*bounce(2t-1) + 0.5
  8 BounceIn: f = 1 - bounce(1-t)
  9 BounceOut: f = bounce(t)
  10 ExponentialInOut: u=2t-1; f = 0.5 * ((u<0) ? pow(2,10u) : 2 - pow(2,-10u))
  11 ExponentialIn: f = (t==0) ? 0 : pow(2, 10*(t-1)) - 0.001
  12 ExponentialOut: f = (t==1) ? 1 : 1 - pow(2,-10t)
  13 SineInOut: f = -0.5*(cos(PI*t) - 1)
  14 SineIn: f = 1 - cos(t*PI/2)
  15 SineOut: f = sin(t*PI/2)
  16 BackInOut: s=2.5949095 (=1.70158*1.525); u=2t; f = (u<1) ? 0.5*u*u*((s+1)*u - s) : (w=u-2, 1 + 0.5*w*w*((s+1)*w + s))
  17 BackIn: s=1.70158; f = t*t*((s+1)*t - s)
  18 BackOut: s=1.70158; w=t-1; f = w*w*((s+1)*w + s) + 1
  ```

  <sub>gd-ida-decomp.cpp:44263-44420 (switch body, case 0..0x11 == type 1..18); names confirmed at 44085-44152 (GameToolbox::easeToText)</sub>

- **GameToolbox::bounceTime(float x) is the stock cocos2d CCEaseBounce::bounceTime, byte-identical to cocos2d::CCEaseBounce::bounceTime in the same binary. The three thresholds are compared in DOUBLE precision (the float x is widened first).**

  ```
  bounce(x): if (x < 1/2.75) return 7.5625*x*x;
  else if (x < 2/2.75) { y = x - 1.5/2.75;  return 7.5625*y*y + 0.75; }
  else if (x < 2.5/2.75) { y = x - 2.25/2.75; return 7.5625*y*y + 0.9375; }
  else { y = x - 2.625/2.75; return 7.5625*y*y + 0.984375; }
  Literals as IDA printed them: 0.363636364, 0.727272727, 0.909090909 (doubles), 0.54545, 0.81818, 0.95455 (floats), 0.75, 0.9375, 0.98438
  ```

  <sub>gd-ida-decomp.cpp:44171-44208 (GameToolbox::bounceTime); identical body at 766990-767030 (cocos2d::CCEaseBounce::bounceTime)</sub>

- **Move is an ABSOLUTE eased curve consumed as per-tick deltas, not a per-frame accumulation. GroupCommandObject2::step stores the total offset in 'easing slots' (+400/+408 and +404/+416) and each tick computes the eased absolute displacement, then hands updateEffectAction only the difference from the last tick. X and Y always share one eased t.**

  ```
  per tick, per slot s (value V = slot total):
    elapsed = cmd.easingClock (+428)
    d = max(cmd.duration, 1.1920929e-7)          // FLT_EPSILON
    t = clamp(elapsed / d, 0, 1)
    f = getEasedValue(t, cmd.easingType, cmd.easingRate)
    absNow = V - V*(1 - f)                        // written exactly this way in float
    step = absNow - cmd.lastAbs[s]                // lastAbs = +48 (X) / +56 (Y) / +144 (rot,progress)
    cmd.lastAbs[s] = absNow
    cmd.pendingDelta[s] += step                   // +64 (X) / +72 (Y) / +152 (rot,progress)
    cmd.cumulative[s]  += step                    // +352 (X) / +360 (Y)
  ```

  <sub>gd-ida-decomp.cpp:716436-716490 (updateAction), 716378-716418 (updateEffectAction), 716494-716555 (step)</sub>

- **A freshly created command does NOT advance its easing clock on the first step(): reset() sets the byte at +432 to 1 and step() consumes it instead of adding dt. Consequence: a move/rotate/scale applies zero displacement on the tick it is triggered and the first real motion lands on the following tick. A duration-0 move therefore teleports on the SECOND tick after the trigger fires, not the first.**

  ```
  step(dt): totalElapsed(+32) += dt ALWAYS; easingClock(+428) += dt only when the +432 flag was already cleared
  ```

  <sub>gd-ida-decomp.cpp:716879 (`*((_BYTE *)this + 432) = 1;` in GroupCommandObject2::reset) and 716512-716516 (`if (*(_BYTE *)(this+432)) *(_BYTE *)(this+432)=0; else *(float*)(this+428) += a2;`)</sub>

- **Completion test. For commands that have an easing slot (move/rotate/scale) the test is on the easing clock; for slotless commands (follow, player-follow) it is on total elapsed and duration == -1.0 means never finish.**

  ```
  if (slot1 != 0) { ...updateAction...; if (easingClock > 0 && easingClock >= duration) finished = 1 }
  else { if (totalElapsed >= duration && duration != -1.0) finished = 1 }
  ```

  <sub>gd-ida-decomp.cpp:716519-716545 (GroupCommandObject2::step)</sub>

- **Command teardown takes two extra ticks and is what writes the group's permanent 'loaded move offset'. On the tick step() sets finished(+112), prepareMoveActions then sets +114. On the NEXT tick the command takes the flush branch (dumps its cumulative +352/+360 into the node and sets node+120), then sets +433. postMoveActions then folds the command's total into the per-group offset map (GJEffectManager+804, unordered_map<int, pair<double,double>>) and erases it from the vector.**

  ```
  postMoveActions total: dx = anyLockX ? cmd(+96) : cmd(+48);  dy = anyLockY ? cmd(+104) : cmd(+56);  map[cmd.targetGroupID] += (dx, dy)   — only for command types 0 (move) and 2 (follow)
  ```

  <sub>gd-ida-decomp.cpp:486712-486720 (tail of prepareMoveActions: resetDelta then `if (+114) +433 = 1; else if (+112) +114 = 1;`), 486180-486192 (case 0 flush branch), 480933-480975 (postMoveActions)</sub>

- **Two or more move commands on the same group at the same time SUM. GJEffectManager::getMoveCommandNode keys a CCMoveCNode purely by cmd.targetGroupID (+40); every command targeting that group pushes itself into the node's vector<GroupCommandObject2*> and adds its own per-tick delta into the node's accumulators. processMoveActions then applies the summed delta once. There is no claiming, replacing or cancelling between simultaneous move commands — re-firing a running Move trigger genuinely doubles the motion.**

  <sub>gd-ida-decomp.cpp:478893-478930 (getMoveCommandNode, hashes on `*((_DWORD *)a2 + 10)` == cmd+40), 486230-486240 (`node+56 += v12; node+64 += v13; node+144 += v14; node+152 += v15;`), 427790-427840 (processMoveActions)</sub>

- **Rotate commands, unlike move commands, ARE merged: claimRotationAction sums every unclaimed command sharing the same (targetGroupID, centerGroupID) pair into one rotation and marks them all claimed (+424), so the group is rotated once per tick by the total angle.**

  ```
  for each unclaimed cmd in map[(group, center)]:
    cmd.claimed = 1
    delta = useApplied ? (cmd(+168) - cmd(+280)) : (cmd(+160) - cmd(+272))
    orbitAngle += delta
    if (!cmd.lockObjectRotation) selfSpinAngle += delta
  ```

  <sub>gd-ida-decomp.cpp:439607-439720 (claimRotationAction; map<pair<int,int>, vector<GroupCommandObject2*>> at GJEffectManager+1016), 439930-439950 (processRotationActions calls it with cmd+40, cmd+44)</sub>

- **Per-tick move application. processMoveActions walks every CCMoveCNode twice: first the 'static' half (getStaticGroup(groupID), delta = node+56/+64), then the 'optimized' half (getOptimizedGroup(groupID), delta = node+144/+152). A node whose +204 flag is set (claimed by a rotate/scale this tick) is skipped entirely. The move is applied only if dx != 0 || dy != 0 || node+120 (force-apply).**

  <sub>gd-ida-decomp.cpp:427790-427840 (processMoveActions), 423146-423196 (getStaticGroup / getOptimizedGroup, both clamp the group id to [0,9999])</sub>

- **Lock-to-player / lock-to-camera REPLACES the eased move delta on that axis rather than adding to it; the axis's easing slot is never even created. The per-tick source deltas live on GJEffectManager as floats: +1040 player dx, +1044 player dy, +1048 camera dx, +1052 camera dy (indices 260..263).**

  ```
  if (cmd.lockToPlayerX)      dx = em.playerDX * cmd.modX
  else if (cmd.lockToCameraX) dx = em.cameraDX * cmd.modX
  else                        dx = cmd.pendingDelta X (+64)
  if (cmd.lockToPlayerY)      { dy = em.playerDY * cmd.modY ; node(+24) = 13 }
  else if (cmd.lockToCameraY) dy = em.cameraDY * cmd.modY
  else                        dy = cmd.pendingDelta Y (+72)
  modX/modY default to 1.0 when the trigger value is exactly 0 (runMoveCommand, 44226-style guard at 716120-716128).
  em.cameraDX/DY are stored NEGATED: em[262] = -layer[243], em[263] = -layer[244].
  ```

  <sub>gd-ida-decomp.cpp:486196-486228 (prepareMoveActions case 0), 716130-716146 (runMoveCommand sets +119 = lockPlayerX||lockCamX, +120 = lockPlayerY||lockCamY and skips the slot when set), 469875-469884 (GJBaseGameLayer::update fills em[260..263])</sub>

- **Move trigger (901) field/key map on EffectGameObject. All offsets are byte offsets into the object.**

  ```
  key 10  -> +1264 float duration
  key 28  -> +1300 float moveX      key 29 -> +1304 float moveY
  key 30  -> +1308 int easingType   key 85 -> +1312 float easingRate
  key 51  -> +1276 int targetGroupID (via setTargetID)
  key 71  -> +1280 int targetPosGroupID (via setTargetID2)
  key 58  -> +1316 lockToPlayerX    key 59  -> +1317 lockToPlayerY
  key 141 -> +1318 lockToCameraX    key 142 -> +1319 lockToCameraY
  key 143 -> +1328 float modX       key 144 -> +1332 float modY
  key 100 -> +1320 useTarget        key 101 -> +1324 int targetCoordMode (0 both, 1 X only, 2 Y only)
  key 138 -> +1496 target is Player1 key 200 -> +1497 target is Player2
  key 393 -> +1336 'small step'     key 394 -> +1337 direction mode
  key 395 -> +1340 int centerGroupID  key 396 -> +1344 float distance
  key 397 -> +1348 dynamic mode     key 401 -> +1368 int rotation/aim target group
  key 544 -> +1349 silent
  ```

  <sub>gd-ida-decomp.cpp:443531-443630 (triggerMoveCommand) plus the property-key switch at 651700-652900 (case 10, 28, 29, 30, 51, 58, 59, 71, 85, 100, 101, 138, 141, 142, 143, 144, 200, 393, 394, 395, 396, 397, 401, 544)</sub>

- **triggerMoveCommand validity gate. A move trigger whose X offset divided by max(duration, 1.0) falls outside the integer range, or whose mod value is absurd on a locked axis, is silently dropped and no command is created. Only the X component is range-checked; Y is not.**

  ```
  d = (duration > 1.0) ? duration : 1.0
  reject unless (uint32)((int)(float)(moveX / d) + 999999) <= 0x1E847E  // i.e. (int)(moveX/d) in [-999999, 999999]
  reject unless ((!lockPlayerX && !lockCameraX) || |modX| <= 99999)
  reject unless ((!lockPlayerY && !lockCameraY) || |modY| <= 99999)
  ```

  <sub>gd-ida-decomp.cpp:443556-443562 (triggerMoveCommand)</sub>

- **createMoveCommand drops the command entirely if the offset is (0,0) AND no lock flag is set, or if targetGroupID <= 0. Separately, runMoveCommand immediately marks a zero-offset, unlocked command finished (+112 = 1, +114 = 1).**

  <sub>gd-ida-decomp.cpp:489574 (`if ((*a2 != zero || a2[1] != zero || a7||a8||a9||a10) && a3 > 0)`), 716148-716160 (runMoveCommand)</sub>

- **Move trigger TARGET MODE (key 100). The trigger's own moveX/moveY are discarded and replaced by the vector from the source object to the target object, computed once at trigger time (not re-evaluated during the move, unless dynamic mode is also on). Target coord mode then zeroes one axis. Setting target mode also clears all four lock flags.**

  ```
  getMoveTargetDelta(trigger, useMainObject):
    fromGroup = (trigger+1340 > 0) ? trigger+1340 : trigger+1276
    fromObj = useMainObject ? tryGetMainObject(fromGroup) : tryGetObject(fromGroup)
    if (trigger+1496)      toObj = player1
    else if (trigger+1497) toObj = (twoPlayerMode ? player2 : player1)
    else                   toObj = tryGet(Main)Object(trigger+1280)
    if (fromObj && toObj && fromObj.uniqueID(+772) != toObj.uniqueID) return toObj.getPosition() - fromObj.getPosition()
    else return (0,0)
  then in triggerMoveCommand:
    if (targetCoordMode == 1) offset.y = 0        // X only
    else if (targetCoordMode == 2) offset.x = 0   // Y only
    lockToPlayerX = lockToPlayerY = lockToCameraX = lockToCameraY = false
  ```

  <sub>gd-ida-decomp.cpp:443604-443628 (triggerMoveCommand LABEL_16), 425096-425145 (getMoveTargetDelta)</sub>

- **Move trigger DIRECTION MODE (key 394) reuses the target-mode delta but renormalises it to a fixed distance. It runs after (and can be combined with) target mode; when direction mode is on, target mode's axis-zeroing still applies afterwards.**

  ```
  offset = normalize(getMoveTargetDelta(...)) * trigger.distance(+1344)   // ccpNormalize of a zero vector yields NaN — guard this in the port
  ```

  <sub>gd-ida-decomp.cpp:443604-443614 (triggerMoveCommand: ccpNormalize then CCPoint::operator* by trigger+1344)</sub>

- **Move trigger SILENT mode (key 544) bypasses the whole command system: the offset is applied to every object of the group in one shot on the trigger tick and recorded straight into the group's loaded-move-offset map. No easing, no duration, no CCMoveCNode.**

  ```
  for each obj in getGroup(targetGroupID): if (!obj[608]) obj.x += dx; obj.y += dy; (then refresh last-position cache)
  saveCompletedMove(targetGroupID, dx, dy)   // map at GJEffectManager+804
  ```

  <sub>gd-ida-decomp.cpp:443578-443580 (triggerMoveCommand `if (*((_BYTE *)a2 + 1349)) moveObjectsSilent(...)`), 427860-427905 (moveObjectsSilent), 479249-479265 (saveCompletedMove)</sub>

- **Rotate trigger (1346) angle and field map. The rotation applied is degrees + times360*360, with the sign convention of GameObject::addRotation (clockwise positive, the same units as the object's own rotation field).**

  ```
  angle = obj(+1356, key 68 'degrees') + obj(+1360, key 69 'times360') * 360.0
  createRotateCommand(angle, duration(+1264), targetGroup(+1276), centerGroup(+1280), easingType(+1308), easingRate(+1312), lockObjectRotation(+1364, key 70), rotateMode, uniqueID(+772), controlID(+1484))
  runRotateCommand stores: cmd(+176)=angle (0 if rotateMode != 0), cmd(+24)=duration, cmd(+12)=easingType, cmd(+16)=easingRate, cmd(+184)=lockObjectRotation, cmd(+188)=rotateMode, cmd(+208)=1, slot: cmd(+400)=3, cmd(+408)=angle.
  A rotate with angle 0 and rotateMode 0 is marked finished immediately.
  ```

  <sub>gd-ida-decomp.cpp:443855-443920 (triggerRotateCommand), 489608-489650 (createRotateCommand), 716195-716230 (runRotateCommand), key switch at 651900-651940 (keys 68, 69, 70)</sub>

- **Rotation CENTRE is the *unmodified position* of the main object of the centre group (cmd+44). Unmodified position = (obj.x(+800) - obj.posOffsetX(+568), obj.y(+808) - obj.posOffsetY(+572)). If that object does not exist, no orbit happens at all and only the per-object self-spin is applied.**

  <sub>gd-ida-decomp.cpp:439905 (tryGetMainObject(cmd+44)), 439947 (GameObject::getUnmodifiedPosition), 167217-167227 (GameObject::getUnmodifiedPosition), 440040-440078 (the `else if (selfRot != 0)` spin-only branch)</sub>

- **Per-object rotate application. The group's own move delta for this tick is consumed inside the rotate loop via claimMoveAction (which also marks the CCMoveCNode +204 so processMoveActions will not apply it again), so a group that is both moved and rotated on the same tick composes correctly and is not double-moved.**

  ```
  C = centreObj.getUnmodifiedPosition()
  M = claimMoveAction(targetGroupID, useApplied)   // the group's pending move delta, consumed
  A = total orbit angle from claimRotationAction (degrees, clockwise positive)
  S = total self-spin angle (same, minus the lockObjectRotation contributions)
  for each obj in group:
    off = (obj[+568], obj[+572])
    p   = obj.pos - off
    q   = C + RotCW(A) * (p - C)          // built in the binary as a cocos node with position=C, rotation=A
    obj.pos = q + M + off
    if (S != 0 && obj[+728]) { obj[+576] += S; obj[+584] += S; GameObject::addRotation(obj, S); }
  claimMoveAction(group, useApplied): if node exists and !node[204] and !node[205] -> node[204] = 1 and return useApplied ? (node+144, node+152) : (node+56, node+64); when !useApplied it also zeroes +352/+360 on every contributing command. Otherwise returns (0,0).
  ```

  <sub>gd-ida-decomp.cpp:439948-440032 (processRotationActions per-object loop), 427624-427680 (claimMoveAction), 427810-427814 (processMoveActions skips nodes with +204)</sub>

- **'Lock Object Rotation' (key 70, cmd+184) removes that command's contribution from the self-spin accumulator only; the orbit around the centre still happens. Objects whose GameObject+728 flag is clear never self-spin regardless.**

  <sub>gd-ida-decomp.cpp:439712-439718 (claimRotationAction: `if (!cmd[184]) *a5 += delta;`), 439936-439938 (`if (lockObjRot) selfRot = 0`), 427428-427437 (rotateObject guards on obj+728)</sub>

- **Scale trigger (2067) goes through TransformTriggerGameObject -> createTransformCommand -> command type 4. Scale is interpolated linearly from 1 to the target under the eased progress; there is no separate 'from' scale stored, which is why re-triggering compounds multiplicatively.**

  ```
  trigger fields: scaleX = obj(+1636, key 150; 0 -> 1.0), scaleY = obj(+1640, key 151; 0 -> 1.0)
  if (obj[+1653], key 153 'divide X') scaleX = 1/scaleX ;  if (obj[+1654], key 154) scaleY = 1/scaleY
  if (obj[+1656], key 171 'relative scale') { m = tryGetMainObject(centerGroup); fx = m[+1000]/m[+836]; fy = m[+1004]/m[+840];
      if (fx != 0) scaleX = (scaleX - 1)/fx + 1 ;  if (fy != 0) scaleY = (scaleY - 1)/fy + 1 }
  createTransformCommand(scaleX, scaleY, skewX(+1644), skewY(+1648), onlyMove(+1652), duration(+1264), targetGroup(+1276), centerGroup(+1280), easingType(+1308), easingRate(+1312), 0, relativeRotation(+1655), uniqueID(+772), controlID(+1484))
  runTransformCommand: cmd(+24)=duration, cmd(+12)=easingType, cmd(+16)=easingRate, cmd(+208)=4, slot cmd(+400)=4 with cmd(+408)=1.0  -> the eased slot value is the progress t itself, accumulated into cmd(+160)/(+168)
  ```

  <sub>gd-ida-decomp.cpp:423422-423467 (triggerTransformCommand), 489662-489700 (createTransformCommand), 716243-716258 (runTransformCommand), 440190-440210 (processTransformActions scale interpolation)</sub>

- **SCALE CENTRE: with NO centre-group object, each object scales about its own centre and does not move; the per-tick update is a multiplicative ratio applied to the object's custom scale. With a centre-group object present, the whole group is scaled about that object's unmodified position and each object's own scale/rotation/skew is re-derived by decomposing the resulting affine matrix.**

  ```
  t = useOptimized ? cmd(+168) : cmd(+160) ;  tPrev = useOptimized ? cmd(+280) : cmd(+272)
  sx = (cmd(+240) - 1)*t + 1 ;  sy = (cmd(+248) - 1)*t + 1
  if (cmd(+296) == 0) { psx = (cmd(+240)-1)*tPrev + 1 ; psy = (cmd(+248)-1)*tPrev + 1 } else { psx = cmd(+296) ; psy = cmd(+304) }
  clamp each of sx, sy, psx, psy: if (|v| < 0.01) v = (v < 0 ? -0.01 : 0.01)
  NO CENTRE OBJECT (and cmd(+288) onlyMove == 0):
    for each obj: addToCustomScaleX(obj, obj[+1000]*(sx/psx) - obj[+1000]); addToCustomScaleY(obj, obj[+1004]*(sy/psy) - obj[+1004])
    // addToCustomScaleX(d) does obj[+592] += d and obj[+1000] += d ; positions are untouched
  WITH CENTRE OBJECT:
    C = centreObj.getUnmodifiedPosition()
    rotBase = cmd(+290) ? centreObj.getRotation() : 0
    T = nodeToParent( position=C, scaleX=sx, scaleY=sy, skewX=cmd(+256)*t, skewY=cmd(+264)*t, rotation=rotBase + claimedOrbitRotation )
        concat with the inverse-of-previous node ( scaleX=1/psx, scaleY=1/psy, skewX=-(cmd(+256)*tPrev), skewY=-(cmd(+264)*tPrev), rotation=-rotBase )
    M = claimMoveAction(targetGroup, useOptimized)
    for each obj: local = obj.pos - off - C, apply the object's own scale/rotation node, concat with T, take (tx,ty);
                  obj.pos += (tx + M) - (obj.pos - off)
                  if (cmd(+288) onlyMove) { if (selfSpin != 0) GameObject::fastRotateObject(obj, selfSpin) }
                  else decompose: sxNew = hypot(m.a, m.b), syNew = hypot(m.c, m.d);
                       obj[+576] += -(atan2(m.d, m.c)*57.2957795 - 90) - preRotX ; obj[+584] += -(atan2(m.b, m.a)*57.2957795) - preRotY
                       addToCustomScaleX(obj, sxNew - obj[+1000] + obj[+600]) ; addToCustomScaleY(obj, syNew - obj[+1004] + obj[+604])
  ```

  <sub>gd-ida-decomp.cpp:440494-440530 (no-centre branch of processTransformActions), 440265-440490 (centre branch), 167392-167430 (addToCustomScaleX / addToCustomScaleY)</sub>

- **Fixed ordering inside one physics sub-step. This ordering is load-bearing: a rotate or scale runs BEFORE the move for the same group and consumes the group's move delta, so swapping them changes results.**

  ```
  per sub-step:
   1. GJEffectManager::updateTimers(dt, timeMod)
   2. GJEffectManager::prepareMoveActions(dt, moreSubStepsFollow)   // steps every GroupCommandObject2, fills the CCMoveCNodes
   3. processMoveActionsStep(dt, isLastSubStep):
        a. mark CCMoveCNode(+205) for every group with a pending dynamic move action
        b. processDynamicObjectActions(1, dt)    // dynamic rotate
        c. processTransformActions(isLastSubStep)
        d. processRotationActions()
        e. processDynamicObjectActions(0, dt)    // dynamic move
        f. processMoveActions()                  // runs processMoveCalculations first
        g. processPlayerFollowActions(dt)
        h. processAdvancedFollowActions(dt)
        i. processFollowActions()
        j. processAreaActions(dt, isLastSubStep)
   4. GJEffectManager::postMoveActions()
  ```

  <sub>gd-ida-decomp.cpp:469390-469402 (GJBaseGameLayer::processMoveActionsStep) and 469890-469893 (the update loop: updateTimers -> prepareMoveActions -> processMoveActionsStep -> postMoveActions)</sub>

- **The static/optimized split is a batching optimisation only, and at one sub-step per tick it collapses. prepareMoveActions' bool arg is 'more sub-steps follow': when true the eased delta still goes to the static group but the optimized group's share is parked in cmd+352/+360 and flushed on the last sub-step. GJBaseGameLayer::optimizeMoveGroups forces any object that is the main object of a group used as a move/rotate/scale reference into the static list, so reference positions are always exact.**

  ```
  optimizeMoveGroups collects reference group ids per trigger type: 901 -> keys at +1280 and +1340; 1346 -> +1280 and +1368; 1347/2067/3016/3661 -> +1280; 2915 -> +1276. Each such group's MAIN object is moved from the optimized array into the static array and its GameObject+1102 flag is cleared.
  ```

  <sub>gd-ida-decomp.cpp:486196-486240 and 486712 (prepareMoveActions, `if (a3) v14 = 0 else v14 = cmd+352`, and resetDelta(cmd, a3)), 716346-716377 (resetDelta zeroes +352/+360 only when !a2), 469891-469892 (`prepareMoveActions(dt, i < n-1)` paired with `processMoveActionsStep(dt, i == n-1)`), 452260-452380 (optimizeMoveGroups)</sub>

- **GJEffectManager::getLoadedMoveOffset(map&) yields the total offset each group currently sits at: it copies the completed-move map (GJEffectManager+804) and then adds every in-flight command's applied displacement. Use this when spawning or repositioning an object into an already-moved group.**

  ```
  out = copy(map at em+804)
  for each live GroupCommandObject2 cmd:
    dx = cmd(+119) ? cmd(+96)  : cmd(+48)
    dy = cmd(+120) ? cmd(+104) : cmd(+56)
    out[cmd.targetGroupID] += (dx, dy)
  ```

  <sub>gd-ida-decomp.cpp:479326-479370 (getLoadedMoveOffset), 479249-479265 (saveCompletedMove)</sub>

### likely

- **Every timed group command (move, rotate, scale/transform, follow, player-follow) is one GroupCommandObject2, a 488-byte POD held in a std::vector at GJEffectManager+792. Commands are appended on trigger, iterated in vector index order every tick, and erased in postMoveActions. Iteration order is therefore creation order and is fully deterministic. Field map (byte offsets) used by movement: +0 unique id (from a global incrementing counter), +4/+8 CCPoint raw offset, +12 int easingType, +16 double easingRate, +24 double duration, +32 double totalElapsed, +40 int targetGroupID, +44 int centerGroupID, +48/+56 double last-applied eased absolute X/Y, +64/+72 double pending delta X/Y this sub-step, +80/+88 previous sub-step delta, +96/+104 double total applied X/Y (all modes), +112 byte finished, +113 byte disabled, +114 byte finished-flush, +115 lockToPlayerX, +116 lockToPlayerY, +117 lockToCameraX, +118 lockToCameraY, +119 anyLockX, +120 anyLockY, +128/+136 double modX/modY, +144 double last-applied eased rotation/progress, +152 double pending rotation/progress delta, +160/+168 double accumulated / applied rotation-or-progress, +176 double rotate degrees, +184 byte lockObjectRotation, +188 int rotate mode, +208 int command type (0 move, 1 rotate, 2 follow, 3 playerFollow, 4 transform), +240/+248/+256/+264 double scaleX/scaleY/skewX/skewY, +272/+280 double previous accumulated/applied rotation-or-progress, +288 byte transform onlyMove, +290 byte transform relative-rotation, +344 int trigger uniqueID, +348 int controlID, +352/+360 double cross-sub-step cumulative X/Y, +400/+404 int easing slot types, +408/+416 double easing slot totals, +424 byte rotation-claimed, +428 float easing clock, +432 byte skip-first-step, +433 byte erase-me.**

  <sub>gd-ida-decomp.cpp:716088-716178 (runMoveCommand), 716195-716230 (runRotateCommand), 716243-716258 (runTransformCommand), 716346-716377 (resetDelta), 716378-716418 (updateEffectAction), 716436-716490 (updateAction), 716494-716555 (step), 716798-716893 (reset), 489553-489590 (createMoveCommand), 475249 (`back() = end - 488`)</sub>

- **GJBaseGameLayer::moveObjects applies the delta directly to the object's double position at GameObject+800 (x) and +808 (y). X is skipped for objects with GameObject+608 set (that byte is written from GameObject::shouldLockX, i.e. lock-to-camera-X objects); Y has no such guard. Zero components are skipped for X but Y is also guarded by `a4 != 0.0`.**

  ```
  if (dx != 0 && !obj[608]) obj.x += dx;
  if (dy != 0) obj.y += dy;
  ```

  <sub>gd-ida-decomp.cpp:427700-427745 (moveObjects), 181244 and 201370 (`*((_BYTE *)this + 608) = shouldLockX` / `GameObject::shouldLockX(a2)`)</sub>

- **Move trigger 'Small Step' (key 393, EffectGameObject+1336) is parsed, saved and exposed by the property getter but is never read by any gameplay path in this binary. It appears inert in 2.206.**

  <sub>all references to `+ 1336` on EffectGameObject: writes at gd-ida-decomp.cpp:299485, 305206 (init 0), 652397 (key 393); reads only at 318173/318182 (level-string save) and 649109 (generic float getter). No read in triggerMoveCommand, prepareMoveActions, processMoveActions or GroupCommandObject2.</sub>

- **Move trigger DYNAMIC mode (key 397) does not create a GroupCommandObject2 at all; it pushes a 60-byte DynamicObjectAction onto GJBaseGameLayer's vector at +1344 and is re-evaluated every tick, closing a fraction of the remaining gap so it lands exactly on target. Dynamic rotate uses the parallel vector at +1356.**

  ```
  per tick (dur = trigger+1264, dt = tick):
    if (!(dur - elapsed > 0 || dur == -1 || firstFrame) || stopped) -> force-apply flag on node and end
    if (firstFrame) firstFrame = 0 else if (dur != -1) elapsed += min(dt, dur - elapsed)
    f = getEasedValue(elapsed/dur, trigger.easingType(+1308), trigger.easingRate(+1312))
    if (f == 1.0 && (durBefore - elapsedBefore) > dt) f = 1 + (lastF >= 1 ? -0.0001 : +0.0001)
    lastF = f
    prevD = rec[+36]; remaining = dur - prevD; newD = f * dur; rec[+36] = newD
    frac = (remaining == 0) ? 0 : (newD - prevD) / remaining ; if (dur <= 0) frac = 1
    delta = toObj.getPosition() - fromObj.getPosition()
    if (trigger.directionMode(+1337)) { s = (dur > 0) ? remaining/dur : 1.0 ; delta = normalize(delta) * (s * trigger.distance(+1344)) }
    node(+56) += frac*delta.x ; node(+64) += frac*delta.y ; node(+144) += frac*delta.x ; node(+152) += frac*delta.y
  ```

  <sub>gd-ida-decomp.cpp:443541-443552 (triggerMoveCommand routes to triggerDynamicMoveCommand when +1348 and (+1320 or +1337)), 443330 (triggerDynamicMoveCommand), 445336-445530 (processDynamicObjectActions, a2==0 branch)</sub>

- **GJBaseGameLayer::rotateObjects (the CCArray-taking helper, used by area/enter effects rather than the 1346 trigger path) rotates about an explicit centre with an extra translation, using the same clockwise convention.**

  ```
  for each obj: p = obj.pos - (obj[+568], obj[+572]);  newP = centre + RotCW(deg)*(p - centre) + extraOffset;  obj.pos += newP - p;  then rotateObject(obj, deg)
  ```

  <sub>gd-ida-decomp.cpp:427487-427610 (rotateObjects); mangled signature _ZN15GJBaseGameLayer13rotateObjectsEPN7cocos2d7CCArrayEfNS0_7CCPointES3_bb</sub>

- **The simulation step really is 1/240 s. GJBaseGameLayer::getModifiedDelta quantises the frame delta to whole 1/240 ticks and carries the remainder; GJBaseGameLayer::update then splits that into that many sub-steps. At one tick per update the sub-step count is 1, so isLastSubStep is always true and moreSubStepsFollow is always false — the port can ignore the static/optimized distinction entirely and apply every delta every tick.**

  ```
  step = (timeMod >= 1.0) ? 0.00416666688 : (float)(timeMod * 0.0041667)   // note the two different literals in the binary
  dt_frame = lroundf(rawDelta + carry) * step ; carry = (rawDelta + carry) - dt_frame
  subSteps = max(1, round(dt_frame / step)) ; dt_sub = dt_frame / subSteps
  ```

  <sub>gd-ida-decomp.cpp:430223-430248 (getModifiedDelta), 469763-469775 (update: `v13 = roundf(...); v2 = (v13 <= 1.0) ? 1 : (int)v13; v15 = dt / v2;`)</sub>

- **GJEffectManager::processMoveCalculations applies the group-parent correction: when a moved group sits under a rotated/scaled parent, the raw delta is rotated by the parent's negated rotation and scaled, and only the DIFFERENCE from the raw delta is added to the node (the raw delta having already been accounted for). It also clears the node's +205 lock. This runs at the top of processMoveActions.**

  ```
  rad = -(parent.rotation(+576) * 0.017453)     // 0.017453 = (float)(PI/180)
  c = cos(rad), s = sin(rad)
  rx = (d.x*c - d.y*s) * (parent[+592] + 1.0)
  ry = (d.y*c + d.x*s) * (parent[+596] + 1.0)
  corr = (rx, ry) - d
  node(+56) += corr.x ; node(+64) += corr.y ; node(+144) += corr.x ; node(+152) += corr.y ; node(+205) = 0
  ```

  <sub>gd-ida-decomp.cpp:474135-474190 (processMoveCalculations), 477036-477060 (addMoveCalculation, records {node, delta, parentObject})</sub>

### Not established

- The exact argument to `roundf` that produces the sub-step count in GJBaseGameLayer::update (gd-ida-decomp.cpp:469763) was dropped by IDA (`v13 = COERCE_FLOAT(roundf());`). I inferred `roundf(dt_frame / (1/240))` from getModifiedDelta quantising the delta to whole 1/240 units immediately beforehand, but I did not read it.
- GJBaseGameLayer::moveObjects takes a 4th bool parameter (mangled ...EPN7cocos2d7CCArrayEddb) that is never referenced in the decompiled body (gd-ida-decomp.cpp:427700-427745). processMoveActions passes `node(+24) == 13` for it, and prepareMoveActions sets node(+24) = 13 exactly when lockToPlayerY is on. I could not determine what the flag actually does or why the sentinel is 13.
- GroupCommandObject2::runMoveCommand's IDA signature has 11 parameters but createMoveCommand's call site was decompiled through a 5-parameter cast (gd-ida-decomp.cpp:489584), so the mapping of createMoveCommand's a7..a12 (the four lock booleans and modX/modY) onto runMoveCommand's a6..a11 is my reading of the body's stores, not a confirmed call-site match. The field assignments inside runMoveCommand are unambiguous, so the risk is limited to argument order.
- GJBaseGameLayer::claimRotationAction's last bool parameter (a7) is never read in the decompiled body (gd-ida-decomp.cpp:439607-439790). processRotationActions passes 1 and processTransformActions passes 0, so it may matter in the real code.
- getRotateCommandAngleDelta — the angle computation for the rotate trigger's aim/follow modes (trigger+1337 direction mode and the 4 extra object slots at +1636..+1648) — I located the call sites (gd-ida-decomp.cpp:443908, 445466) but did not read its body. Rotate modes 1 and 2 (cmd+188, derived from createRotateCommand's a8/a9 bools) are likewise unexplored beyond the fact that a nonzero mode forces cmd+176 to 0 and still creates an easing slot.
- I could not confirm which level-string keys carry skewX/skewY for the Scale/Transform trigger. The fields are EffectGameObject+1644/+1648 (read as floats by triggerTransformCommand) but the property-key switch writes those offsets from several different key numbers (161/162 as ints, 191, 223, 300/301 as floats, 450/451 as floats), because those bytes are a union shared across trigger types. The Scale trigger 2067 itself may never set them.
- The precise semantics of TransformTriggerGameObject+1652 ('onlyMove', cmd+288) and +1655 (cmd+290, which I call 'relative rotation' because it makes the transform node adopt the centre object's rotation) are inferred from how the flags are used, not from any name in the binary. +1652 is written by keys 55, 133, 375 and +1655 by keys 376 and 452 depending on trigger type, so I cannot say which key the Scale trigger uses.
- CCMoveCNode's full field layout is only partially recovered. I am confident about +24 (int, set to 13 for lock-to-player-Y), +56/+64 (static dx/dy), +120 (force-apply), +144/+152 (optimized dx/dy), +204 (claimed), +205 (dynamic-calculation lock), +208/+212 (vector<GroupCommandObject2*>), but I did not enumerate the rest.
- All arithmetic in the reference is float32 (with a few doubles for positions and accumulators, noted per-field above). A TypeScript port using JS doubles throughout will diverge from real GD in the low bits of every eased value. That is fine for internal determinism but means the port will not bit-match the original; if bit-matching matters, the easing math and the per-object position updates need explicit Math.fround.
- The IDA output prints float literals at roughly 5 significant digits, so '3.1416' is (float)M_PI and '1.7016'/'2.7016'/'2.5949'/'3.5949' are 1.70158/2.70158/2.5949095/3.5949095. I established this by contrast with the double literals in the same file (3.14159265, 1.57079633, 57.2957795, 0.363636364) rather than by reading the raw constant pool, so the exact float bit patterns are inferred.


## Colour and pulse

Full colour pipeline extracted from the 2.206 decomp. The blocking item is solved: channel 1007 (LightBG) is derived every frame from channel 1000 (BG) and channel 1005 (P1) as hsvShift(bg, dh=0, ds=-0.2, dv=+0.2, both additive), then, only when bg.r+bg.g+bg.b < 150, mixed toward the P1 colour by (1 - sum/150) — so a black background makes LightBG exactly the player colour, which is why the port's white is so wrong. Channel 1010 is confirmed immutable: activeColorForIndex and GameObject::getActiveColorForMode both hard-return black for 1010 (and white for 1011 and 0), so the header's rgb(255,255,255) is parsed, stored and never read. Colour triggers fade linearly per RGB channel with C truncation, and the start colour is sampled at fire time from the channel's BASE (un-pulsed) colour. Pulses use a linear fadeIn/hold/fadeOut envelope with no easing, and by default they LAYER — each pulse in the vector composites on the running result of the previous — unless the exclusive flag (level key 86, not key 210 as the field order first suggests) erases the existing ones at fire time. Group pulses live in a separate per-group map and are applied per object at draw time with the main-only/detail-only filter. The whole processColors chain (base reset, channel pulses, inherited colours, copy-source pulses) is rebuilt from scratch every frame. Two determinism notes matter most for the port: effects are stepped once per rendered frame with the full frame delta, not per 240 Hz sub-step, so a trigger firing mid-frame still advances by the whole frame; and copy-source pulses commit simultaneously rather than layering, so last-writer-wins within a frame.

### certain

- **Per-frame order in GJBaseGameLayer::update: all physics sub-steps run first, THEN GJEffectManager::updateEffects(mgr, frameDelta) is called ONCE with the whole frame's delta, then the vtable+568 postUpdate hook runs, which calls GJEffectManager::processColors() and then GJEffectManager::calculateLightBGColor(activeColorForIndex(1005)) and GJBaseGameLayer::updateLevelColors(). Colour/pulse actions are NOT stepped per 240 Hz sub-step. Consequence to replicate: a colour or pulse trigger that fires in sub-step k of n still advances by the FULL frame delta at the end of that frame (it is constructed, given step(0.0), then given step(frameDelta)).**

  ```
  frame: for(i<n) substep(dt/n); updateEffects(dt); postUpdate(dt) -> processColors(); calculateLightBGColor(activeColor(1005)); updateLevelColors()
  ```

  <sub>GJBaseGameLayer::update lines 469606-470070 (updateEffects at 470054, postUpdate vtable+568 at 470065); PlayLayer::postUpdate lines 95815-95860 (processColors 95827, calculateLightBGColor 95832); LevelEditorLayer::postUpdate 203520-203540</sub>

- **GJEffectManager::updateEffects(dt) = updateColorEffects(dt), then updatePulseEffects(dt), then updateOpacityEffects(dt), in that exact order.**

  <sub>GJEffectManager::updateEffects lines 481405-481412</sub>

- **GJEffectManager::processColors() = calculateBaseActiveColors(); processPulseActions(); processInheritedColors(); processCopyColorPulseActions(); in that exact order. This whole chain runs every frame from scratch, so inherited (copy) colours ARE recomputed every frame.**

  <sub>GJEffectManager::processColors lines 478423-478430</sub>

- **ColorActionSprite layout (byte offsets used by every colour consumer): +264 float opacity stored 0..255; +268..270 ccColor3B m_color (the BASE, un-pulsed colour); +271..273 ccColor3B m_activeColor (what objects actually render with); +276 int channel index; +280..282 a scratch ccColor3B used only by processCopyColorPulseActions; +284 ColorAction*. init() sets color=activeColor=(255,255,255) and opacity=255.0f.**

  <sub>ColorActionSprite::init lines 491427-491440; getColorSprite 473580-473604; activeColorForIndex 473619-473660; processCopyColorPulseActions 478355-478400</sub>

- **COLOUR TRIGGER (899) — the start colour IS sampled at fire time, and it is sampled from the channel's BASE colour (ColorActionSprite+268..270), not its pulsed active colour. GJBaseGameLayer::updateColor writes: action.fromColor = sprite.color(+268..270); action.toColor = the trigger's colour; action.duration = p1; action.fromOpacity = sprite.opacity(+264)/255; action.toOpacity = p4; action.blending = p3; action.copyHSV = *p5; action.animateCopyHSV = trigger->byte(+1448); action.copyID = p6; action.copyOpacity = p7; then resetAction() (elapsed=0, finished=0, paused=0) and step(0.0). So a colour trigger fired while the channel is mid-pulse still starts from the un-pulsed colour.**

  <sub>GJBaseGameLayer::updateColor lines 415900-415985 (fromColor at 415938-415942, fromOpacity at 415952-415955, resetAction/step at 415968-415970)</sub>

- **COLOUR TRIGGER fade is LINEAR per RGB channel with C truncation, not gamma/HSV interpolated, and opacity is a plain float lerp. ColorAction::step(dt): if(!finished && !paused){ elapsed += dt; t = elapsed + offset148; if (t >= duration) { color = toColor; opacity = toOpacity; } else if (t <= 0) { color = fromColor; opacity = fromOpacity; } else { p = t/duration; if (p >= 1) snap to 'to'; else { color = multipliedColorValue(fromColor, toColor, p); opacity = fromOpacity + (toOpacity-fromOpacity)*p; } } finished = (t >= duration); }. Once finished is set, step() is a no-op and the channel holds the target colour forever.**

  ```
  c[i] = trunc(from[i] + (to[i] - from[i]) * p), p = clamp(elapsed/duration); opacity = fromA + (toA - fromA)*p
  ```

  <sub>ColorAction::step lines 472959-473020; GameToolbox::multipliedColorValue lines 43177-43215</sub>

- **GameToolbox::multipliedColorValue(from, to, t) — the lerp primitive used by both the colour trigger and pulses: if t >= 1 return to; if t <= 0 return from; else per channel result = (unsigned char)(float)(from[i] + (float)((int)to[i] - (int)from[i]) * t). The conversion is a C cast, i.e. TRUNCATION toward zero, not rounding. Reproduce with Math.trunc, not Math.round, or colours will be one unit off everywhere.**

  ```
  out[i] = trunc(from[i] + (to[i] - from[i]) * t)
  ```

  <sub>GameToolbox::multipliedColorValue lines 43177-43215</sub>

- **COLOUR TRIGGER with duration <= 0 also writes the sprite immediately inside updateColor (not just at the next processColors): if copyID == 0 -> sprite.color(+268..270) = target colour and sprite.opacity(+264) = opacity*255. If copyID != 0, the colour is NOT written here (processInheritedColors will do it) and opacity is written only when copyOpacity is false.**

  <sub>GJBaseGameLayer::updateColor lines 415972-415986</sub>

- **GJEffectManager::updateColorEffects(dt) steps EVERY ColorAction in the m_colorActions dictionary and, only for actions with copyID == 0, copies action.currentColor(+54..56) -> sprite.color(+268..270) and action.currentOpacity(+60)*255 -> sprite.opacity(+264). Copy channels are skipped here entirely.**

  <sub>GJEffectManager::updateColorEffects lines 474242-474290</sub>

- **PulseEffectAction is a 72-byte POD, stored by value in vectors. Layout: +0 bool stepSkip (never set true in any path read); +4 float fadeIn; +8 float hold; +12 float fadeOut; +16 float elapsed; +20 int targetID (channel or group, clamped to 0..9999); +24 float value (current envelope 0..1); +28..30 ccColor3B pulse colour; +32 int mode (1 = HSV, 2 = Colour); +36/40/44 float hsv h,s,v; +48 int hsv flags (byte0 = sAdditive, byte1 = vAdditive); +52 int copyColorChannel; +56 bool mainOnly; +57 bool detailOnly; +58 bool animateHSVOverFade; +60 int (from obj+772); +64 int (from obj+1484); +68 float timeOffset (set only by the editor preview path, 0 in gameplay).**

  <sub>new_allocator<PulseEffectAction>::construct lines 481632-481710; runPulseEffect 481838-482010; colorForPulseEffect 474297-474440; PulseEffectAction::step 472716-472745</sub>

- **PULSE ENVELOPE is piecewise LINEAR with no easing. PulseEffectAction::step(dt): if(!stepSkip){ elapsed += dt; value = valueForDelta(elapsed + timeOffset, fadeIn, hold, fadeOut); }. valueForDelta(t, fi, ho, fo): if (t < fi) return t/fi; if (t <= fi+ho) return 1.0; if (fo <= 0) return 0.0; return 1.0 - ((t - fi) - ho)/fo. Note fadeIn == 0 takes the t >= fi branch at t == 0 and yields 1.0, so there is no division by zero.**

  ```
  v(t) = t<fi ? t/fi : (t<=fi+ho ? 1 : (fo<=0 ? 0 : 1-((t-fi)-ho)/fo))
  ```

  <sub>PulseEffectAction::valueForDelta lines 472676-472700; PulseEffectAction::step lines 472716-472745</sub>

- **PULSE LIFETIME: isFinished() is (elapsed + timeOffset) >= (fadeIn + hold + fadeOut). GJEffectManager::updatePulseEffects(dt) walks the channel-pulse vector, calls step(dt) on each, and ERASES finished ones in place (index not advanced on erase, so the vector compacts and preserves relative order). It then does the same per group bucket, and finally sets or clears that group's bit in the 10000-bit 'group has pulses' bitset at field+480 based on whether its vector is now empty.**

  <sub>PulseEffectAction::isFinished lines 472655-472662; GJEffectManager::updatePulseEffects lines 475333-475390</sub>

- **A SECOND PULSE ON AN ALREADY-PULSING TARGET LAYERS by default; it neither replaces nor queues. runPulseEffect appends a new PulseEffectAction to the target's vector, and processPulseActions applies every pulse in the vector IN VECTOR ORDER, each one taking the running result of the previous as its base colour. Only the 'exclusive' flag changes this: when exclusive is set, for a CHANNEL target every existing pulse whose targetID matches is erased from the vector first; for a GROUP target the whole per-group hash-map node (and its entire vector) is deleted first. Immediately after emplacing, the new action is given step(0.0) so its value is initialised before any rendering.**

  <sub>GJEffectManager::runPulseEffect lines 481838-482010 (exclusive branch at 481921-481936 for channels, 481942-481990 for groups; step(0.0) at 482006); processPulseActions lines 474450-474480</sub>

- **GJEffectManager::colorForPulseEffect(base, action) — how one pulse composites onto a colour. Let t = action.value. If t <= 0 return base unchanged. If mode == 2 (Colour): if t == 1 return action.colour; else return multipliedColorValue(base, action.colour, t). If mode == 1 (HSV): src = (action.copyColorChannel != 0) ? activeColorForIndex(copyColorChannel) : base; if t == 1 return transformColor(src, h, s, v, flags); else { hsv2 = action.animateHSVOverFade ? getMultipliedHSV(hsv, t) : hsv; c = transformColor(src, hsv2); return multipliedColorValue(base, c, t); }. Note the final blend uses the ORIGINAL base, not src, so a copy-source pulse transforms the copied channel's colour but fades in from the target's own colour. Any other mode value returns base unchanged.**

  <sub>GJEffectManager::colorForPulseEffect lines 474297-474440</sub>

- **Pulse mode value: EffectGameObject+1416 (level key 48) is the HSV toggle; the dispatcher stores 1 into PulseEffectAction+32 when it is non-zero and 2 when it is zero. So in the stored action 1 = HSV pulse and 2 = Colour pulse (NOT the raw 0/1 from the level file).**

  <sub>GJBaseGameLayer trigger dispatch, case 1006, lines 315194-315199 and the 1006 parse at 299354</sub>

- **GJEffectManager::processPulseActions() applies a channel pulse only when BOTH the pulse has no copy-colour source (action.copyColorChannel == 0) AND the target channel's ColorAction is not itself a copy channel (colorAction.copyID == 0). It reads sprite.activeColor(+271..273) as the base and writes the result straight back to +271..273, so successive pulses in the vector stack. Pulses excluded here are handled by calculateInheritedColor (copy channel) or processCopyColorPulseActions (copy-source pulse).**

  <sub>GJEffectManager::processPulseActions lines 474450-474480</sub>

- **GJEffectManager::processCopyColorPulseActions() (pulses that have a copy-colour source) does a DEFERRED, SIMULTANEOUS commit, unlike ordinary pulses. Pass 1: for each pulse with copyColorChannel != 0, compute colorForPulseEffect from activeColorForIndex(target) and store the result in the sprite's scratch bytes +280..282, pushing the sprite into a local vector. Pass 2: for every collected sprite, copy +280..282 into +271..273. Because +271..273 is untouched during pass 1, all such pulses read the same pre-pass base, and when several target the same channel in one frame only the LAST one's value survives.**

  <sub>GJEffectManager::processCopyColorPulseActions lines 478309-478400</sub>

- **GROUP pulses are stored separately from channel pulses. Channel pulses live in one std::vector<PulseEffectAction> at GJEffectManager fields 69/70/71 (offsets 276/280/284). Group pulses live in an unordered_map<int, vector<PulseEffectAction>> at field 72 (offset 288), plus a 10000-bit bitset at field 120 (offset 480) that flags which groups currently have any pulse. runPulseEffect picks the container from its bool p1 ('target is a group'), which the dispatcher computes as (EffectGameObject+1420 == 1), i.e. level key 52 == 1.**

  <sub>runPulseEffect lines 481920-482010; updatePulseEffects 475360-475385; hasPulseEffectForGroupID 477407-477420; the 1006 dispatch at 315203; the 1006 parse at 299361-299365</sub>

- **GROUP pulses are applied at object-draw time, not in processColors. For each rendered object the channel colour is fetched (activeColorForIndex(mode)), then for every group ID on that object colorForGroupID(groupID, runningColor, isMain) is called in group-index order, each call folding in every pulse in that group's vector in vector order. The bitset is checked first, so a group with no pulses costs nothing. This is done once for the main colour and once for the detail colour.**

  <sub>GJEffectManager::colorForGroupID lines 477436-477520; the object colour loop at 189248-189270 (main) and 189330-189345 (detail); GameObject::groupColor 172898-172918</sub>

- **MAIN-ONLY / DETAIL-ONLY: colorForGroupID's third parameter is 'is this the MAIN colour' (the main-colour loop passes !object->byte894, the detail loop passes literal 0). A pulse is applied when (mainOnly && isMain) || (detailOnly && !isMain) || (!mainOnly && !detailOnly). Both flags set behaves the same as neither set (applies to both). mainOnly is PulseEffectAction+56 (level key 65), detailOnly is +57 (key 66).**

  ```
  apply = (m && isMain) || (d && !isMain) || (!m && !d)
  ```

  <sub>GJEffectManager::colorForGroupID lines 477480-477505; callers at 189263 and 189344; the 1006 parse at 299355-299360</sub>

- **calculateLightBGColor — the exact channel-1007 formula, which is fully derived and overwrites both +268..270 and +271..273 of the 1007 sprite every frame: bg = activeColorForIndex(1000); p1 = activeColorForIndex(1005) (the caller always passes this); t = transformColor(bg, dh = 0.0, ds = -0.2, dv = +0.2, sAdditive = true, vAdditive = true); sum = bg.r + bg.g + bg.b (integers, 0..765); if (sum < 150) result = getMixedColor(t, p1, sum/150.0) else result = t. Note the sum uses the ORIGINAL bg, not the transformed colour. Because calculateLightBGColor runs AFTER processColors every frame, colour triggers and pulses aimed at channel 1007 are always clobbered; only its OPACITY (+264) survives, since this function never touches it.**

  ```
  lightBG = (bg.r+bg.g+bg.b < 150) ? mix(p1, hsvShift(bg, 0, -0.2, +0.2), (bg.r+bg.g+bg.b)/150) : hsvShift(bg, 0, -0.2, +0.2)
  ```

  <sub>GJEffectManager::calculateLightBGColor lines 475038-475075; call sites 95832, 190358-190361, 192871-192874, 203533-203536, 204150-204154 (all pass activeColorForIndex(..., 1005)); channel 1005 = P1 confirmed at 190309-190340</sub>

- **GJEffectManager::getMixedColor(a, b, t) is per channel (1-t)*b + t*a — the arguments are in the opposite order to a normal lerp. Each channel is then clamped: if value > 255 -> 255, else if value <= 0 -> 0, else truncate to int. In calculateLightBGColor a = the HSV-shifted background and b = the P1 colour, so t = 0 (black background) yields the P1 colour exactly and t -> 1 yields the shifted background.**

  ```
  out[i] = clampTrunc((1-t)*b[i] + t*a[i], 0, 255)
  ```

  <sub>GJEffectManager::getMixedColor lines 474965-475020</sub>

- **GameToolbox::transformColor(colour, dh, ds, dv, flags) — the HSV primitive behind LightBG, channel 1012, copy-colour HSV and HSV pulses. Steps: (1) if (dh, ds, dv, flags) == (0.0f, 1.0f, 1.0f, 0) return the colour untouched (identity fast path). (2) r,g,b -> /255 -> HSVfromRGB. (3) if dh != 0: h += dh; if h >= 0 and h > 360 then h = (double)((int)h % 360); if h < 0 then h += 360. (4) s = flags.byte0 ? s + ds : s * ds, then if s >= 1 -> 1, else if s <= 0.0000999999975 -> 0.0000999999975. (5) v = flags.byte1 ? v + dv : v * dv, same clamp. (6) RGBfromHSV, then each channel = (unsigned int)(x * 255.0) — truncation, not rounding. The 4-argument overload calls this with flags = 257 (0x0101), i.e. both additive.**

  <sub>GameToolbox::transformColor lines 43040-43135 (5-arg) and 43155-43162 (4-arg, flags = 257); identity globals initialised at 9612-9615 to 0.0f / 1.0f / 1.0f / 0</sub>

- **The HSV conversions are stock cocos2d CCControlUtils. HSVfromRGB: mx = max(r,g,b), mn = min(r,g,b), v = mx, d = mx - mn; if mx <= 0 then s = 0 and h = -1; else s = d/mx and h = (r >= mx) ? (d == 0 ? 0 : (g-b)/d) : (g >= mx ? 2 + (b-r)/d : 4 + (r-g)/d), then h *= 60 and if h < 0 h += 360. RGBfromHSV: if s <= 0 then r=g=b=v; else { if h >= 360 h = 0; f = h/60; i = (int)f; fr = f - i; p = v*(1-s); q = v*(1-s*fr); t = v*(1-s*(1-fr)); switch(i){0:(v,t,p) 1:(q,v,p) 2:(p,v,t) 3:(p,q,v) 4:(t,p,v) default:(v,p,q)} }. The i = (int)f truncates toward zero, so a negative hue (-1, produced for pure black) lands in case 0.**

  <sub>CCControlUtils::HSVfromRGB lines 743070-743128; CCControlUtils::RGBfromHSV lines 743144-743215</sub>

- **GameToolbox::getMultipliedHSV(hsv, t) scales an HSV toward identity by t: h' = h*t; s' = sAdditive ? s*t : (1-t) + s*t; v' = vAdditive ? v*t : (1-t) + v*t; flags copied unchanged. This is what makes an HSV pulse or an animated copy-HSV ramp in smoothly from 'no transform'.**

  ```
  h*=t; s = additive ? s*t : 1-t+s*t; v = additive ? v*t : 1-t+v*t
  ```

  <sub>GameToolbox::getMultipliedHSV lines 43304-43350</sub>

- **CHANNEL 1010 IS GENUINELY IMMUTABLE — confirmed, the level header's stored value is ignored at every read point. GJEffectManager::activeColorForIndex short-circuits: id == 1010 returns (0,0,0); id == 1011 or id == 0 returns (255,255,255); anything else reads sprite+271..273. GameObject::getActiveColorForMode does the same: 1010 returns the static black triple, 0 and 1011 return the static white triple. So a level writing rgb(255,255,255) into 1010 still renders black. ColorAction::setupFromMap does parse and store the header value for 1010 into a ColorAction, but nothing ever reads it back.**

  <sub>GJEffectManager::activeColorForIndex lines 473619-473660; GameObject::getActiveColorForMode lines 172950-172975 (algn_981693 = the 3 black bytes at 0x981693, word_981690 = the 3 white bytes at 0x981690); ColorAction::setupFromMap 480349-480540 (no 1010 special case)</sub>

- **GJEffectManager::calculateBaseActiveColors() runs first every frame and resets EVERY colour sprite's activeColor from its base colour: for each ColorActionSprite, c = sprite.color(+268..270); if its ColorAction exists and copyID > 0 and its loop flag (+122) is false, c = transformColor(c, action.copyHSV); sprite.activeColor(+271..273) = c. This is what makes pulses non-persistent — they are rebuilt from the base every frame. (The +122 loop flag it tests is written by processInheritedColors later in the same frame, so it is one frame stale; irrelevant unless a level has a copy-colour cycle.)**

  <sub>GJEffectManager::calculateBaseActiveColors lines 473421-473485</sub>

- **GJEffectManager::calculateInheritedColor(channelID, action) resolves one copy channel, at most once per frame (guarded by action+120, set to 1 on exit and cleared at the start of processInheritedColors). Body: if (action.resolved || action.copyID == 0) skip. src = getColorSprite(copyID); c = src.activeColor; a = src.opacity(+264). If duration > 0 and (elapsed + offset148) < duration: p = clamp((elapsed+offset148)/duration, 0, 1); c = multipliedColorValue(action.fromColor, c, p); a = ((1-p)*action.fromOpacity + (a/255)*p) * 255. Then if copyHSV != identity: if (action.animateCopyHSV && duration > 0 && p2 = (elapsed - action.f144)/duration < 1) c = transformColor(c, getMultipliedHSV(copyHSV, max(p2,0))) else c = transformColor(c, copyHSV). Then every channel pulse whose targetID == action.channelID and whose copyColorChannel == 0 is folded in with colorForPulseEffect, in pulse-vector order. Finally sprite.activeColor(+271..273) = c AND sprite.color(+268..270) = c, and sprite.opacity(+264) = action.currentOpacity(+60) * (action.copyOpacity ? a : 255.0).**

  <sub>GJEffectManager::calculateInheritedColor lines 474493-474635</sub>

- **GJEffectManager::processInheritedColors() resolves copy chains in dependency order, parents before children, every frame. It (1) resets every InheritanceNode's flags, (2) for each ColorAction with copyID > 0 clears its resolved(+120) and loop(+122) flags, clamps channelID and copyID to 0..9999, creates/links InheritanceNodes for both, and calls wouldCreateLoop — if a cycle is found the action's +122 is set to 1 and the link is not made, otherwise node.parent is set, and (3) for each root node (not visited, flag+64 set) calls traverseInheritanceChain. traverseInheritanceChain pushes the node and all its ancestors into an array, then iterates that array BACKWARDS (topmost ancestor first) calling calculateInheritedColor for each. wouldCreateLoop walks at most two parent links looking for the child id.**

  <sub>GJEffectManager::processInheritedColors lines 474689-474830; traverseInheritanceChain 474640-474680; wouldCreateLoop 473551-473570</sub>

- **GJEffectManager::addAllInheritedColorActions(array) simply walks the m_colorActions CCDictionary (field 67) and appends every ColorAction whose copyID (+116) > 0 to the array, creating the array if it was null. It does no ordering or resolution itself. The companion GJEffectManager::colorActionChanged(action) keeps a second dictionary (field 102) in sync: copyID > 0 adds the action under its channel key, copyID <= 0 removes it — that dictionary is what processInheritedColors iterates.**

  <sub>GJEffectManager::addAllInheritedColorActions lines 473501-473545; GJEffectManager::colorActionChanged lines 473876-473890</sub>

- **Channel index clamping is uniform: every accessor does id = (id > 1100) ? 1101 : (id < 0 ? 0 : id), and the backing arrays hold 1102 entries (reset() zeroes 4408 bytes = 1102 pointers). GJBaseGameLayer::updateColor is the exception — it maps any id > 1101 (unsigned compare, so negatives too) to 0 rather than clamping. Pulse and group ids clamp to 0..9999 instead.**

  <sub>getColorSprite 473586-473590, getColorAction 473737-473741, setColorAction 473703-473707, removeColorAction 473828-473832, colorExists 473857-473861, shouldBlend 473396-473400; GJEffectManager::reset 488303-488305; GJBaseGameLayer::updateColor 415935-415936; runPulseEffect 481920-481924</sub>

- **Special channel map confirmed from updateLevelColors and the P1/P2 setup: 1000 = BG, 1001 = Ground 1, 1002 = Line (also carries an opacity and a blending flag), 1005 = Player 1, 1006 = Player 2, 1007 = LightBG (derived), 1009 = Ground 2, 1010 = black (immutable), 1011 = white (immutable), 1012 = 'Lighter' (derived per object, see below), 1013 = MG 1, 1014 = MG 2. Channel 0 also reads as white.**

  <sub>GJBaseGameLayer::updateLevelColors lines 418679-418790; P1/P2 sprite setup at 190309-190356; activeColorForIndex 473619-473660; getActiveColorForMode 172950-173010</sub>

- **Channel 1012 ('Lighter') is derived per object, not stored: the object's own MAIN active colour is passed through transformColor with h = 0, s = 0.65 MULTIPLICATIVE, v = 0.15 ADDITIVE (flags = 256 = 0x0100, so byte0 = 0 and byte1 = 1). The float constants appear as 1059481190 = 0x3F266666 = 0.65f and 1041865114 = 0x3E19999A = 0.15f.**

  ```
  lighter = transformColor(mainActiveColor, 0.0, 0.65, 0.15, flags = 0x0100)
  ```

  <sub>GameObject::getActiveColorForMode lines 172972-173000; the detail-colour path at 189306-189326; GJEffectManager::colorForEffect 473901-473912</sub>

- **GJEffectManager::removeAllPulseActions() (called from resetEffects on respawn) sets the channel-pulse vector's end pointer equal to its begin pointer, clears the group-pulse hash map, and clears all 10000 bits of the group-pulse bitset. Colour actions are NOT touched by it; they are cleared separately by GJEffectManager::reset(), which empties the colour-action dictionary, the inherited-action dictionary, the inheritance-node dictionary and the 1102-entry pointer array.**

  <sub>GJEffectManager::removeAllPulseActions lines 475853-475880; GJEffectManager::resetEffects 488221-488240; GJEffectManager::reset 488289-488320</sub>

- **Level-file key map for the Pulse trigger (object 1006): 51 -> targetID, 45 -> fadeIn, 46 -> hold, 47 -> fadeOut, 48 -> HSV mode (non-zero means HSV, stored as type 1; zero stores type 2), 52 -> target type (1 = group, anything else = colour channel), 65 -> mainOnly, 66 -> detailOnly, 86 -> exclusive, 210 -> animate-HSV-over-fade, 49 -> the copied HSV string, 50 -> copy colour channel (both read a few lines below the excerpt into obj+1424..1436 and obj+1440). Absent keys default to 0 / 0.0.**

  <sub>the object 1006 parse at lines 299326-299380 (key index N is read as array element N, i.e. byte offset 4*N)</sub>

- **Level-file key map for the Colour trigger (899 and friends): 7/8/9 -> r/g/b (obj+1260..1262), 10 -> duration (obj+1264), 17 -> blending (obj+1299), 23 -> target channel (obj+880, only applied when the parsed value is > 1), 35/36 -> opacity (obj+1268; key 36 gates it, key 35 is the value, default 1.0), 49 -> copied HSV (obj+1424..1436), 50 -> copy channel (obj+1440), 60 -> copy opacity (obj+1444), 210 -> animate copy HSV (obj+1448), 14 -> 'also tint ground' (obj+1296). Object ids that route to updateColor are 29, 30, 105, 744, 899, 900 and 915. For ids 29, 30, 105 and 900 blending is forced to 0 and opacity to 1.0. Additionally, for the legacy BG trigger (id 29) with key 14 set, updateColor is called a SECOND time with the same colour and duration targeting channel 1001 with blending 0 and opacity 1.0.**

  <sub>the colour trigger parse at lines 299760-299850; the trigger dispatch LABEL_130 at 315168-315192; the id-29 second call at 315180-315192</sub>

  *(Added 2026-09-29.)* The target without key 23 above 1 is the object's own: every object starts at 1 (:165584), and customSetup gives 29 → 1000, 30 → 1001, 105 → 1004, 744 → 1003, 900 → 1009 (the second ground) and 915 → 1002 with blending on (:302332-302449). The 1.x ids are made as other ids by objectFromVector: 221, 717, 718 and 743 as 899, pointed at 1, 2, 3 and 4 after key 23 is read, so key 23 does nothing on them; 104 as 915, then forced additive whatever key 17 says (:183928-183945, :184244-184275). Keys 7-9 and 35 read 0 when missing (35 only counts when 36 is above 0). Keys 15/16 (obj+1297/1298, 15 first) replace the colour at load with player 1's strengthened colour 1 or 2 (PlayLayer::addObject :90024-90045). `getTargetColorIndex` (:310067-310090) is the editor's label, not the dispatch.

- **GJEffectManager::activeOpacityForIndex(id) returns sprite.opacity(+264)/255.0 with no 1010/1011 special case (so opacity on those channels does work even though their colour is fixed). GJEffectManager::shouldBlend(id) returns colorAction.blending(+80), or 0 when no ColorAction exists for that channel.**

  <sub>activeOpacityForIndex lines 473672-473690; shouldBlend lines 473392-473410</sub>

### likely

- **ColorAction layout: +52 bool finished; +53 bool paused; +54..56 current ccColor3B; +60 float current opacity (0..1); +64 float elapsed; +68..70 ccColor3B fromColor; +71..73 ccColor3B toColor; +76 float duration; +80 bool blending; +84 int playerColorSelector (1=P1, 2=P2); +88 int channelID; +92 float fromOpacity (0..1); +96 float toOpacity (0..1); +100..115 ccHSVValue copy-HSV (h f32, s f32, v f32, then byte sAdditive, byte vAdditive); +116 int copyID; +120 bool per-frame 'already resolved' flag; +121 bool copyOpacity; +122 bool 'inheritance loop detected'; +124 int; +132 bool animate-copy-HSV-over-duration; +136 ColorActionSprite*; +140 InheritanceNode*; +144 float; +148 float extra time offset (editor scrub only).**

  <sub>ColorAction::init 472803-472820, ColorAction::step 472959-473020, ColorAction::setupFromMap 480349-480540, GJBaseGameLayer::updateColor 415900-415990, calculateInheritedColor 474493-474630</sub>

- **The 'exclusive' flag is the 4th bool parameter (p12) of runPulseEffect and is NOT stored in PulseEffectAction; it only decides whether existing pulses are erased at fire time. Tracing the varargs, it is the 12th vararg = EffectGameObject+1447 = level key 86. The bool stored at PulseEffectAction+58 comes from the 13th vararg = EffectGameObject+1448 = level key 210, which is the 'scale the HSV by the pulse value' toggle, not exclusive.**

  <sub>GJEffectManager::runPulseEffect lines 481884-481918 (va_copy chain) and the emplace_back argument list at 481991-482005; new_allocator<PulseEffectAction>::construct 481632-481710; the 1006 dispatch at 315196-315216; ColorAction+132 write in updateColor 415963-415966</sub>

- **One asymmetry worth guarding against: GJEffectManager::calculateInheritedColor reads its SOURCE channel with getColorSprite(copyID) and takes +271..273 directly, bypassing the 1010/1011/0 short-circuit in activeColorForIndex. So a channel that COPIES 1010 gets whatever raw value the 1010 sprite holds (white, if the header wrote 255,255,255), not black. Copy-source pulses (colorForPulseEffect with copyColorChannel) do go through activeColorForIndex and therefore do see black.**

  <sub>calculateInheritedColor line 474540 (getColorSprite then read of +271/+273) vs colorForPulseEffect line 474360 (activeColorForIndex)</sub>

- **ColorAction::updateCustomColor, driven by GJEffectManager::updateColors(p1Colour, p2Colour), overwrites the action's fromColor (+68..70) — not its current colour — when the action's playerColorSelector (+84, level key 4) is 1 (P1) or 2 (P2). Since ColorAction::step is a no-op once finished, this only takes visible effect on an action that is subsequently reset or is mid-fade.**

  <sub>ColorAction::updateCustomColor lines 473080-473100; GJEffectManager::updateColors lines 473349-473378; setupFromMap key 4 at 480437-480441</sub>

### Not established

- Dictionary iteration order. calculateBaseActiveColors, updateColorEffects, addAllInheritedColorActions and the first/third loops of processInheritedColors all walk cocos2d CCDictionary (a uthash table) in hash-bucket order, which this file does not let me reconstruct. For calculateBaseActiveColors and updateColorEffects the operations are independent per channel, so order is not observable. For processInheritedColors it decides which InheritanceNode is picked as a chain root and therefore the order in which independent copy chains resolve — I could not prove that is unobservable, though within a chain the parents-first order is guaranteed by traverseInheritanceChain. If the port needs bit-exactness on a level with copy-colour chains, this is the one place to worry.
- PulseEffectAction+60 and +64 (fed from EffectGameObject+772 and +1484) are written by the constructor but I found no read of them in any colour path (colorForPulseEffect, processPulseActions, colorForGroupID, calculateInheritedColor, updatePulseEffects). They are probably trigger-ordering / control-ID bookkeeping. I did not determine what they do.
- PulseEffectAction+0, the bool that makes step() a no-op, is set to 0 by the constructor and I never found anything that sets it to 1. Either it is dead or it is set from a path I did not read.
- ColorAction+124 (written from updateColor's last parameter) and ColorAction+144 (read by calculateInheritedColor as the start time of the copy-HSV ramp) are never written in any function I read. +144 defaults to 0, which makes the HSV ramp use elapsed/duration, but I could not confirm that.
- The literal byte values of word_981690 (white) and algn_981693 (black) are not in this file — there is no data-section dump. I inferred them from their use as the 1011 and 1010 return values alongside activeColorForIndex's explicit (255,255,255) and (0,0,0), and from the fact that the two symbols are exactly 3 bytes apart. I am confident but it is an inference, not a read.
- EffectGameObject+894, XORed with 1 to produce colorForGroupID's isMain argument in the main-colour loop, is a GameObject flag I did not identify. In the common case it must be 0 (so main passes true), because the detail loop passes a literal 0 and the main-only/detail-only truth table only works out that way. I did not find where +894 is set.
- The exact float constant behind IDA's 0.0039216 (the /255 in transformColor) — IDA prints 5 significant figures, and 1.0f/255.0f rounds to exactly that, so it is almost certainly 1/255, but the raw bits are not in the file.
- The one-frame staleness of ColorAction+122 (calculateBaseActiveColors tests the loop flag that processInheritedColors sets later in the same frame) is visible in the code but I could not determine whether it has any observable effect, since calculateInheritedColor overwrites both colour fields for the same channels later in the same frame. It only matters for levels with copy-colour cycles.


## Camera, shake and time

All camera/state-trigger behaviour was read from D:/Proxy/games-src/geometrydash/data/ref/gd-ida-decomp.cpp (GJBaseGameLayer::updateCamera, lines 449342-450830, plus ~20 helpers). Headlines: (1) the design view is 320 GD units TALL with the width derived from the aspect ratio (569 at 16:9, not 480 — 480x320 is only the design size before the FixedHeight/FixedWidth policy is applied), so the port's "~480 units wide" assumption is wrong for widescreen; (2) camera X is not a lerp at all — it snaps exactly to playerX - viewW/2 + 75/zoom + offsetX, where the 75 is a smoothed accumulator that only moves at the player's own per-step speed, and only matters when direction reverses; (3) camera Y for cube/robot is a dead-zone follow with bounds -40/+70 around screen centre plus an exponential approach of rate dt60/10 per tick, while ship/ball/UFO/wave/swing do NOT free-follow — they lock Y to a static value derived from the entry portal's Y, unless the Camera Mode trigger's free-mode flag is set; (4) Time Warp changes the physics tick: for warp >= 1 the step stays 1/240 s and only the step count grows, but for warp < 1 the step SHRINKS to warp/240 s, so a fixed-240Hz-with-timeScale accumulator is only correct for warp >= 1; (5) camera shake has no decay, is purely visual (applied to a copy of the camera position, never fed back), and uses libc rand(), so it is not deterministic in GD itself.

### certain

- **The camera works in cocos2d "design" units where 1 design unit = 1 GD unit. AppDelegate::setupGLView passes a design size of 480x320, but CCDirector::updateScreenScale then picks ResolutionPolicy 3 (FixedHeight) when screenH/320 <= screenW/480, else 4 (FixedWidth). FixedHeight keeps height = 320 and sets width = ceilf(screenW / (screenH/320)); FixedWidth keeps width = 480 and sets height = ceilf(screenH / (screenW/480)). So for any aspect >= 1.5 the view is 320 units tall and 320*aspect wide (16:9 -> ceil(568.888) = 569 x 320); for narrower screens it is 480 wide. The port should treat 320 units of HEIGHT as the fixed quantity, not 480 of width.**

  ```
  aspect = screenW/screenH; if (screenH/320 <= screenW/480) { viewH = 320; viewW = ceil(320*aspect) } else { viewW = 480; viewH = ceil(480/aspect) }
  ```

  <sub>AppDelegate::setupGLView lines 77019 (CCSize 480,320) and 77037-77041; cocos2d::CCDirector::updateScreenScale lines 801122-801146 (policy 3 vs 4 choice); cocos2d::CCEGLViewProtocol::setDesignResolutionSize lines 853218-853229 (ceilf branches)</sub>

- **updateCamera converts the design size to world units by dividing by zoom: viewW = winSize.width / zoom, viewH = winSize.height / zoom, where zoom is the float at GJBaseGameLayer+328 (float index 82). The camera position stored at +852 (float index 213/214) is the BOTTOM-LEFT corner of the view in GD units; camera centre = camPos + view/2. The render layer is finally placed at -camPos*zoom and scaled by zoom.**

  ```
  viewW = winW/zoom; viewH = winH/zoom; layerPos = -camPos*zoom; layerScale = zoom
  ```

  <sub>GJBaseGameLayer::updateCamera lines 449578-449584 (v7 = v206/v4, v9 = v207/v4) and lines 450795-450805 (setScale(zoom), setPosition(-camPos * zoom))</sub>

- **CAMERA X RULE (classic, non-sideways gameplay): the X axis never uses a dead zone and never lerps. Its target is camX = playerX - viewW/2 + internalOffsetX + cameraOffsetX, and the per-axis smoothing divisor for X is initialised to 1.0, which the final smoothing step treats as snap (only divisors > 1.0 are interpolated). Camera X therefore follows the player exactly.**

  ```
  camX = playerX - (winW/zoom)/2 + internalOffsetX + cameraOffsetX   (no smoothing; divisor = 1.0)
  ```

  <sub>GJBaseGameLayer::updateCamera lines 449722-449726 (CCPoint(v33=1.0, 10.0) - X divisor 1.0, Y divisor 10.0), lines 450110-450140 (v164 = playerPos - halfView; v166 += internal offset; v168 += camera offset), lines 450575-450580 (if (v227 > 1.0) lerp else assign)</sub>

- **internalOffsetX is an accumulator (GJBaseGameLayer+544, float index 136) that chases a target of gameplayOffsetX * reverseSign / zoom. gameplayOffsetX defaults to the integer 75 (restoreDefaultGameplayOffsetX calls updateGameplayOffsetX(75, false)); reverseSign = -1 when PlayerObject+1970 (m_isReversed, confirmed by PlayerObject::reverseMod) is set, else +1. The division by zoom is skipped when the raw-units bool at GJBaseGameLayer+584 is set (second argument of the Gameplay Offset trigger, id 2901). The accumulator moves toward the target by exactly abs(player position delta this step) per tick, clamped so it never overshoots - so hitting a Reverse trigger slides the camera across at the player's own speed rather than snapping.**

  ```
  targetX = 75 * (reversed ? -1 : 1) / zoom;  step = abs(playerX - playerLastX);  internalOffsetX = moveTowards(internalOffsetX, targetX, step)
  ```

  <sub>GJBaseGameLayer::updateGameplayOffsetX lines 430003-430007 and restoreDefaultGameplayOffsetX lines 430024-430026 (literal 75); GJBaseGameLayer::updateCamera lines 449670-449689 (sign and /zoom), lines 450045-450110 (accumulator step using fabsf(player delta)); PlayerObject::reverseMod lines 143698-143704</sub>

- **Consequence of the X rule: the player is pinned at a fixed fraction of the screen that depends only on the aspect ratio, not on zoom. fraction = (winW/2 - 75) / winW. At 16:9 (winW = 569) that is 0.3682 (player 209.5 units from the left edge of a 569-unit-wide view); at 4:3 (winW = 480) it is 0.34375.**

  ```
  playerScreenFractionX = (winW/2 - 75) / winW
  ```

  <sub>derived from updateCamera lines 450129-450140 combined with the winW/zoom conversion at line 449580 and the literal 75 at line 430026</sub>

- **CAMERA Y RULE for cube/robot (basic mode): a dead zone around the screen centre. The player (plus cameraOffsetY) is kept inside [centreY - 40, centreY + 70]. If it falls below, camYtarget = playerY - viewH/2 + 40 + offsetY; if it rises above, camYtarget = playerY - viewH/2 - 70 + offsetY; otherwise the target is unchanged from the previous tick. When gravity is flipped (PlayerObject+1967) the two bounds are swapped, giving [centreY - 70, centreY + 40]. In platformer mode (GJBaseGameLayer+10734, confirmed by the UILayer::togglePlatformerMode call at line 106250) the pair is 27.5 / 55.0 instead of 40 / 70.**

  ```
  UP=70, DOWN=40 (upright; swapped when gravity flipped; 55/27.5 in platformer). if (playerY+offY > camY + viewH/2 + UP) target = playerY - viewH/2 - UP + offY; else if (playerY+offY < camY + viewH/2 - DOWN) target = playerY - viewH/2 + DOWN + offY; else target = camY
  ```

  <sub>GJBaseGameLayer::updateCamera lines 449691 (40.0), 449697 (70.0), 449712-449716 (27.5 / 55.0 in platformer), 449717-449721 (swap when player+1967), 450212-450296 (dead-zone test and the two corrective assignments at 450273 and 450292)</sub>

- **The Y target is smoothed with an exponential approach whose per-tick fraction is dt60/divisor, where dt60 is updateCamera's argument (0.25 at 240 Hz) and the Y divisor defaults to 10.0. A divisor <= 1.0 means snap (the interpolation branch is skipped). The divisor actually used each tick is stored back to +1020 (float index 255/256).**

  ```
  if (divisor > 1.0) { d = (dt60 > 0) ? divisor/dt60 : divisor; cam += (target - cam)/d; } else cam = target;   // dt60 = 0.25 at 240 Hz, Y divisor default 10.0
  ```

  <sub>GJBaseGameLayer::updateCamera lines 449722-449726 (CCPoint(v33,10.0) initialiser), 450574-450590 (v129 = v227/a2; v130 = v222 + (v229-v222)/v129), 450592 (store to this+1020)</sub>

- **The transition into the locked fly camera is a tween on the static camera Y with duration 0.5 s when entering ground mode for the first time, 0.3 s when the ground height changes while already in ground mode, and 0.0 s when the instant flag is passed; easing type 1, easing rate 2.0. animateOutGroundNew (leaving) tweens the ground art over 0.3 s (0.2 s in dual, literal 1050924811) with rate 1.5 and clears the static Y via resetStaticCamera(false, true).**

  ```
  enter-ground duration 0.5 s; height-change 0.3 s; easing type 1, rate 2.0
  ```

  <sub>GJBaseGameLayer::animateInDualGroundNew lines 451103-451130 (1056964608 = 0.5, 1053609165 = 0.3, 0) and line 451136 (tween args 1, 2.0); animateOutGroundNew lines 448965-448990; resetStaticCamera lines 448861-448890</sub>

- **The Camera Mode trigger (2925) turns the fly lock off and configures the free follow. Fields: obj+1556 (bool) -> GJBaseGameLayer+689 free-mode (skips the ground lock entirely); obj+1568 (bool) -> +690 (skip the floor-to-30 snap); obj+1557 (bool) gates whether the two numeric fields apply; obj+1560 (float index 390) -> follow-speed divisor clamped to [1.0, 40.0], stored at +624 (float index 156); obj+1564 (float index 391) -> padding clamped to [0.0, 1.0], stored at +620 (float index 155). resetCamera restores padding = 0.5 (0x3F000000) and divisor = 10.0 (0x41200000).**

  ```
  followDivisor = clamp(value, 1, 40) default 10; padding = clamp(value, 0, 1) default 0.5
  ```

  <sub>GJBaseGameLayer::updateCameraMode lines 451188-451232 (clamps: 1.0 floor, 1109393408 = 40.0 ceiling, [0,1] for the second); resetCamera lines 451336-451337; CameraTriggerGameObject::triggerObject line 315616 (2925 -> updateCameraMode)</sub>

- **In free-follow (non-basic mode, i.e. isInBasicMode() false) the dead zone is symmetric with half-size (winHalf - (padding*(winHalf - 2 - 30) + 30)) / zoom on each axis, and the smoothing divisor is the Camera Mode follow speed (+624). With the defaults (padding 0.5) and a 569x320 view at zoom 1 that is +/-128.475 horizontally and +/-66.0 vertically. padding = 1 collapses the dead zone to 2/zoom (tight follow); padding = 0 opens it to (winHalf-30)/zoom.**

  ```
  deadHalf(axis) = (win[axis]*0.5 - (padding*(win[axis]*0.5 - 2 - 30) + 30)) / zoom
  ```

  <sub>GJBaseGameLayer::updateCamera lines 449704-449711 (v225 = winHalf-2, v226 = winHalf - (f155*(v225-30)+30), then *1/zoom), lines 450220-450233 (the non-basic branch picking v226 and this[156])</sub>

- **When gameplay is rotated 90 degrees (player+1971) the two axes swap roles wholesale: the free-move accumulator path runs on Y using gameplayOffsetY (+588, also default 75) and the dead-zone path runs on X, and the (1.0, 10.0) divisor pair is swapped so X gets 10.0 and Y gets 1.0.**

  <sub>GJBaseGameLayer::updateCamera lines 449674-449681 (v18 branch picks this+588 and writes the Y component), lines 449727-449733 (swap of v227/v228), lines 450018-450032 (axis dispatch on v18)</sub>

- **Camera limits. Four edge slots at GJBaseGameLayer float-index 226/227/228/229 = left/right/top/bottom, each holding a target GROUP id; getCameraEdgeValue(n) resolves the group's main object and returns its x (for 1,2) or y (for 3,4). Computed limits: maxX = edge2_x - viewW (or the -99999 sentinel = unlimited when the slot is 0), maxY = edge3_y - viewH, or with no slot set maxY = (levelTopField - 150) - viewH; minX = edge1_x (or -99999 = unlimited); minY = edge4_y, or 0 when that value is <= 0. limitCamera applies max only when the max value is > 0 and applies min unconditionally, so the DEFAULT bottom limit is camY >= 0.**

  ```
  maxX = edge2x - viewW; maxY = edge3y - viewH (default (levelTop-150) - viewH); minX = edge1x; minY = max(edge4y, 0)
  ```

  <sub>GJBaseGameLayer::updateCamera lines 449586-449601 (all four limits, -99999.0 sentinel, 150.0 top margin); getCameraEdgeValue lines 429937-429985; limitCamera lines 430885-430904; applied at lines 450565-450571 and 450593</sub>

- **The default levelTop field (+11456, float index 2864) is 2790.0 (0x452E6000) unless LevelSettingsObject::shouldUseYSection() is true, in which case it is (max object Y, floored at 1200.0) + 90 + 300. So with no Y-section the default camera top limit is 2790 - 150 - viewH = 2640 - viewH.** (Corrected 2026-10-01: this read 2660.0 (0x45268000), but the literal 1160667136 is 0x452E6000 = 2790.0, and 0x45268000 would be 2664.0. The same field is the player's out-of-bounds ceiling, `MAX_GAMEPLAY_Y_DEFAULT` in `physics/constants.ts`.)

  ```
  levelTop = shouldUseYSection ? (max(1200, maxObjectY) + 390) : 2790; cameraMaxY = levelTop - 150 - viewH
  ```

  <sub>lines 430610-430652 (setter: v6 = 1200.0 floor, scan for max object Y, this[2864] = v6 + 90.0 + 300.0, else 1160667136 = 2790.0); consumed at updateCamera line 449595</sub>

- **Near a camera limit the smoothing divisor is eased toward 24.0 over the last 60 units: t = 1 - (limit - camTarget)/60 on the max side (or 1 - (camTarget - limit)/60 on the min side), newDivisor = divisor + t*(24.0 - divisor). Applied only when the corresponding edge slot is actually set (or in platformer), when the current divisor is < 24.0, and not when divisor == 1.0 with a static camera active on that axis. The result is a soft stop rather than a hard clamp.**

  ```
  t = 1 - abs(limit - camTarget)/60; divisor = divisor + t*(24.0 - divisor)
  ```

  <sub>GJBaseGameLayer::updateCamera lines 450440-450470 (max side) and lines 450515-450545 (min side)</sub>

- **Two snap-this-tick one-shot flags exist at +1368 (X) and +1369 (Y). When either is set, or when updateCamera is called with dt60 == 0, the corresponding axis divisor is forced to 1.0 (instant). checkCameraLimitAfterTeleport(player, 60.0) sets the Y flag and calls updateCamera(0.0) when the player's Y leaves the band [camY - 60, camY + winH + 60] - note it uses the raw design winSize, NOT winH/zoom. It is skipped when a static camera Y is active or when gameplay is rotated 90 degrees. The spider's call sites pass a3 = 60.0; teleportPlayer passes 180.0 when the portal's key 55 (+1652) is set and 60.0 otherwise (:462461-462464), and only for a teleport with a target. (Corrected 2026-10-01: not every call site passes 60.)**

  ```
  if (playerY > camY + winH + 60 || playerY < camY - 60) { forceInstantY = true; updateCamera(0); }
  ```

  <sub>GJBaseGameLayer::checkCameraLimitAfterTeleport lines 450837-450858; updateCamera lines 449627-449642 (v19/v20 instant flags), 450556-450568 (v214/v215 forcing divisor 1.0); call sites at lines 155229, 156550, 157030, 462489</sub>

- **While a static camera is active on an axis (index 118/119 != 0), that axis' camera target is simply staticCentre - viewHalf + cameraOffset, with divisor 1.0 (instant) - the smoothing lives in the tween of the static centre itself, not in the follow. The Y axis has an extra ground guard: if in fly-ground mode (+688) and the requested static Y (index 99) is below groundHeight*0.5/zoom + 90.0, the centre is pushed up by that deficit scaled by (1 - tween progress).**

  ```
  camTarget = staticCentre - viewHalf + cameraOffset;  Y guard minCentre = groundHeight*0.5/zoom + 90
  ```

  <sub>GJBaseGameLayer::updateCamera lines 449816-449830 (v57 = this[96]; v63 = v57 - halfView; v65 = v63 + offset) and lines 449836-449852 (the +90.0 ground guard)</sub>

- **Zoom trigger (1913) -> updateZoom(value = obj+1552, duration = obj+1264, easing = obj+1308, easeRate = obj+1312, id1 = obj+772, id2 = obj+1484). The value is clamped to [0.4, 3.0], and a value <= 0 becomes 1.0. The target is stored at float index 83 and the live zoom at index 82 is either set instantly (duration <= 0, tween 0xE stopped) or tweened over the duration. It also re-runs updateDualGround so the fly-mode ground lock re-snaps to the new zoom.**

  ```
  zoom = (v <= 0) ? 1.0 : clamp(v, 0.4, 3.0)
  ```

  <sub>GJBaseGameLayer::updateZoom lines 451250-451305 (clamps 3.0 / 0.4 / 1.0); dispatch at lines 315415-315423</sub>

- **Camera Offset trigger (1916) -> updateCameraOffsetX(value = obj+1300, duration = obj+1264, easing = obj+1308, easeRate = obj+1312, ids) and/or updateCameraOffsetY(value = obj+1304, ...), selected by obj+1324 (2 = Y only, 1 = X only, else both). The target goes to float index 86/87 and the live offset at index 84/85 is set instantly when duration <= 0 (tween 0xF/0x10 stopped) or tweened. The offset is added to the camera target on both the dead-zone and the static path, and the per-tick CHANGE in the offset is additionally added straight onto the stored camera position at the top of updateCamera, so the offset moves the camera immediately rather than being chased.**

  <sub>CameraTriggerGameObject::triggerObject lines 315661-315678; GJBaseGameLayer::updateCameraOffsetX/Y lines 449227-449290; updateCamera lines 449689-449694 (camPos += offset - prevOffset)</sub>

- **Camera Edge trigger (2062) -> updateCameraEdge(edgeSlot = obj+1644, groupID = obj+1276). It only writes the group id into slot 1/2/3/4 (= left/right/top/bottom) at float index 226/227/228/229; all the actual behaviour is the limit computation in updateCamera. A slot value of 0 or negative means no limit on that side (the bottom still defaults to 0).**

  <sub>CameraTriggerGameObject::triggerObject line 315613; GJBaseGameLayer::updateCameraEdge lines 429901-429921; consumption at updateCamera lines 449586-449601</sub>

- **Camera Guide trigger (2016) does NOTHING at runtime. CameraTriggerGameObject::triggerObject explicitly falls through for id 2016 without calling any handler (it returns the stale value 2925) and without forwarding to EffectGameObject::triggerObject. It is an editor-only visual guide.**

  <sub>CameraTriggerGameObject::triggerObject lines 315608-315618</sub>

- **Shake trigger (1520) -> shakeCamera(duration = obj+1264, strength = obj+1288, interval = obj+1292), ignored unless duration > 0 and strength > 0. shakeCamera clamps strength to a maximum of 100.0, zeroes the shake offset and the shake timer, and stores duration at +1048, strength at +1052, interval at +1056. The whole call is suppressed when the shake-disabled setting at +10977 is set (that byte is loaded from a GameManager game variable).**

  ```
  strength = min(strength, 100.0)
  ```

  <sub>trigger dispatch lines 315490-315500; GJBaseGameLayer::shakeCamera lines 430753-430775 (1120403456 = 100.0 clamp); disable byte set at line 106899</sub>

- **applyShake has NO decay: the amplitude is the full strength for the whole duration. A new random offset is generated whenever (gameTime - lastShakeTime) > interval, or whenever interval <= 0 (i.e. every tick), and is held constant between re-rolls. Normal mode picks each component uniformly in [-1, 1] (2*rand/2^31 - 1); the sign-only mode (+10976, set to 1 on player death) picks exactly +/-1. Both components are multiplied by strength. The duration counts down in real seconds once per FRAME, not per physics tick, and the active flag at +1045 is simply (remaining > 0).**

  ```
  if (now - last > interval || interval <= 0) { last = now; ox = (2*rand01 - 1)*strength; oy = (2*rand01 - 1)*strength; }  // death mode: ox,oy = +/-strength
  ```

  <sub>GJBaseGameLayer::applyShake lines 431250-431295 (rand()*4.6566e-10, the (x+x)-1.0 uniform form, offset = sign*strength); duration countdown in GJBaseGameLayer::update lines 470046-470049 (this[262] -= frameDelta; this[1045] = remaining > 0); sign-only mode set on death at line 93177</sub>

- **The shake is purely visual and never feeds back into the camera state: updateCamera copies the already-committed camera position into a local, calls applyShake on that local, and uses it only for the render transform and the background art. The stored camera position at +852 is written before the shake is added. Because it uses libc rand(), GD's own shake is not reproducible - a deterministic port can use any PRNG for it without diverging the simulation.**

  <sub>GJBaseGameLayer::updateCamera lines 450782-450790 (this+852 = v222; CCPoint v234 = this+852; applyShake(this, v234)) and lines 450795-450806 (v234 used only for setPosition and updateCameraBGArt)</sub>

- **The fixed timestep lives in GJBaseGameLayer::getModifiedDelta. Given the incoming frame delta (already multiplied by the cocos scheduler time scale - see applyTimeWarp), it computes step = (timeWarp >= 1.0) ? 0.00416666688 : timeWarp * 0.0041667, accumulates leftover, rounds to a whole number of steps, and returns steps*step, carrying the remainder at +10984. GJBaseGameLayer::update then runs that many sub-steps, each advancing the simulation by step seconds.**

  ```
  step = (timeWarp >= 1) ? 0.00416666688f : timeWarp * 0.0041667f;  acc = dt + leftover;  n = max(1, round(acc/step));  used = n*step;  leftover = acc - used
  ```

  <sub>GJBaseGameLayer::getModifiedDelta lines 430223-430246 (both literals and the leftover carry); GJBaseGameLayer::update lines 469744-469760 (v10 = a2*60; v2 = max(1, round(...)); v15 = seconds/steps; v16 = (a2*60)/steps; v18 = v15*60)</sub>

- **PlayerObject::update is called with the step expressed in 60 Hz frame units, i.e. step*60 = 0.25 at the normal 240 Hz. updateCamera receives the same quantity. So every /10, /24, /30 divisor in the camera divides that 0.25-per-tick quantity, giving a 2.5% approach per tick for the Y follow at divisor 10.**

  ```
  dt60 = step * 60 = 0.25 at 240 Hz
  ```

  <sub>GJBaseGameLayer::update lines 469757-469759 (v16 = v10/v2, v18 = v15*60.0), line 469935 (vtable+20 = PlayerObject::update called with v16), lines 469989-469990 (updateCamera(this, v18))</sub>

- **Time Warp trigger (1935) -> vtable+708 -> GJBaseGameLayer::updateTimeWarp(GameObject*, float) with the value at obj+1572, forwarding to updateTimeWarp(float). That clamps to [0.1, 2.0] and stores at +720 (float index 180). PlayLayer's override forces 1.0 when +11304 is set. When the value becomes exactly 1.0 it also calls applyTimeWarp(1.0). applyTimeWarp(v) sets the cocos CCScheduler's time scale to v, so the incoming frame delta is pre-multiplied by the warp.**

  ```
  timeWarp = clamp(value, 0.1, 2.0); schedulerTimeScale = timeWarp
  ```

  <sub>trigger dispatch lines 314896-314901; GJBaseGameLayer::updateTimeWarp(float) lines 415280-415298 (clamps 2.0 / 0.1); PlayLayer::updateTimeWarp lines 86940-86944; applyTimeWarp lines 416307-416320 (director scheduler field +52)</sub>

- **Time Warp DOES affect the physics tick, asymmetrically. For timeWarp >= 1 the step stays 1/240 s and only the number of steps per real second grows, so the simulation is bit-identical to normal speed, just replayed faster. For timeWarp < 1 the step SHRINKS to timeWarp/240 s while the step count per real second stays roughly constant, so the simulation runs at finer granularity and is NOT identical to the same level at warp 1. A port that models time warp as 'fixed 240 Hz accumulator with a timeScale on the wall clock' is therefore correct only for warp >= 1; for warp < 1 it must shrink the tick, and PlayerObject::update must receive timeWarp*0.25 instead of 0.25.**

  ```
  stepSeconds = (warp >= 1) ? 0.00416666688 : warp*0.0041667;  dt60 passed to player and camera = stepSeconds*60
  ```

  <sub>getModifiedDelta lines 430236-430243 (the >= 1.0 branch pins the step, the < 1.0 branch scales it) combined with GJBaseGameLayer::update lines 469757-469759 (per-step dt derived from the returned total)</sub>

- **All camera trigger durations are handled by GJGameState::tweenValue on the state object at GJBaseGameLayer+328, keyed by a small integer id, and updated once per physics sub-step with the step in seconds (GJGameState::updateTweenActions). Camera-relevant ids: 0xA/0xB static camera X/Y, 0xC/0xD static camera exit X/Y, 0xE zoom, 0xF/0x10 camera offset X/Y, 0x11 screen rotation, 0x12/0x13 internal cam offset X/Y, 0x14 MG offset Y, 0x15/0x16 static camera transition progress X/Y, 0x19 ground animation, 1/2 cameraMoveX/Y. Starting a tween on an id first stops any existing tween on that id, so triggers on the same channel replace rather than stack.**

  <sub>GJGameState::tweenValue lines 448905-448960 (stopTweenAction(a4) first, then insert keyed by a4); id literals at 449010 (1u), 449030 (2u), 450965/450976 (0xA/0xB), 450950 (0xC), 449290 (0xE), 449241 (0xF), 449279 (0x10), 449208 (0x11), 450884/450910 (0x12/0x13), 451504/451530 (0x15/0x16); updateTweenActions called per sub-step at line 469988</sub>

- **moveCameraToPos(p) is a direct camera move used by cutscene/end-of-level code, not by the follow: it calls cameraMoveX(p.x, 1.2, 1.8, false) and cameraMoveY(p.y, 1.2, 1.8, false), i.e. tween ids 1 and 2 on the live camera position over 1.2 s with easing rate 1.8. cameraMoveY additionally short-circuits when the requested Y equals the last requested Y and the force flag is false.**

  ```
  duration 1.2 s, easing type 1, easing rate 1.8
  ```

  <sub>GJBaseGameLayer::moveCameraToPos lines 449047-449051; cameraMoveX lines 449003-449008; cameraMoveY lines 449022-449031</sub>

- **resetCamera restores the documented defaults: camera padding 0.5, follow divisor 10.0, zoom 1.0 (via updateZoom(0.0), which maps <= 0 to 1.0), camera offsets X/Y 0, gameplay offsets X/Y 75 with the raw-units flag false, internal cam offsets 0, all four edge slots 0, screen rotation 0, both static cameras cleared, shake stopped, and the two static-smoothing factors (index 112/113) set to 1.0.**

  <sub>GJBaseGameLayer::resetCamera lines 451319-451375</sub>

### likely

- **CAMERA Y for the flying/rolling modes is NOT a free follow. updateDualGround -> animateInDualGroundNew computes a locked camera centre and installs it as a STATIC camera Y, so the Y axis takes the static-camera branch of updateCamera instead of the dead-zone branch. The locked centre is groundY = max(90.0, floor((portalY - groundH/2)/30)*30); centreY = groundY + groundH/2. The floor-to-30 snap is skipped when the Camera Mode trigger's second bool (GJBaseGameLayer+690) is set. portalY comes from getTargetFlyCameraY - the Y of the portal object that switched the mode (recorded by processCameraObject), or of the start-pos object.**

  ```
  groundY = max(90, floor((portalY - groundH/2)/30)*30); staticCentreY = groundY + groundH/2
  ```

  <sub>GJBaseGameLayer::animateInDualGroundNew lines 451080-451100 (getTargetFlyCameraY, floorf(v11/30)*30, the 90.0 floor, this[170] = v11 + groundH*0.5) and line 451136 (updateStaticCameraPos((0, this[170]), setX=0, setY=1, ...)); getTargetFlyCameraY lines 420349-420385; processCameraObject lines 420071-420100</sub>

- **Which modes lock Y is decided by getGroundHeightForMode, whose literal returns are 240.0 (mode id 16), 300.0 (ids 5, 19, 26, 41) and 270.0 (default, plus ids 23/24 resolved via the stored mode at float index 270, and id 33). updateDualGround then does: if (freeModeFlag +689) OR (groundH == 270.0 AND mode != 33 AND not dual) -> animateOutGroundNew (no lock, dead-zone follow); else -> animateInDualGroundNew (lock). So 270-height modes (cube/robot) free-follow while 240 and 300 height modes (ball, ship, UFO, wave, swing, and id 33) lock.**

  ```
  groundHeight: 240 (id 16), 300 (ids 5/19/26/41), 270 (default, ids 23/24/33)
  ```

  <sub>GJBaseGameLayer::getGroundHeightForMode lines 419619-419650 (1131413504=240.0, 1133903872=300.0, 1132920832=270.0); getGroundHeight lines 420553-420590; updateDualGround lines 451170-451182</sub>

- **PlayerObject::isInBasicMode() (which selects 40/70 vs the free dead zone) is: !isFlying() && !player[1963] && !player[1966]. Reading the standard PlayerObject mode-flag order, 1963 is m_isBall and 1966 is m_isSpider, so basic = cube and robot. player+1967 is the gravity-flipped flag, player+1970 is m_isReversed (confirmed via reverseMod) and player+1971 is gameplay-rotated-90-degrees (confirmed: PlayerObject::rotateGameplayOnly writes it).**

  ```
  basicMode = !isFlying && !isBall && !isSpider
  ```

  <sub>PlayerObject::isInBasicMode lines 145589-145599; PlayerObject::reverseMod lines 143698-143704; PlayerObject::rotateGameplayOnly lines 145549-145553; GJBaseGameLayer::updateCamera lines 449622-449626 (v203/v18/v204 loaded from player+1970/1971/1967)</sub>

- **Static Camera trigger (1914). When the trigger's exit bool (obj+1635) is clear it calls updateStaticCameraPosToGroup(groupID = obj+1280, followX = (obj+1324 != 2), followY = (obj+1324 != 1), dynamic = obj+1636, smoothing = obj+1640, duration = obj+1264, easing = obj+1308, easeRate = obj+1312, followPlayer = obj+1648, lerpAmount = obj+1652). That stores per axis: smoothing clamped to >= 1.0 at float index 112/113, the dynamic flag at 114/115, the target group id at 116/117, the follow-player flag at 128/129, the lerp amount at 130/131, and starts a 0..1 progress tween (ids 0x15/0x16) at index 108/109 over the duration. It then calls updateStaticCameraPos, which sets the static-active floats at index 118/119 to 1.0 and tweens the static centre at index 96/97 toward the requested point (tween ids 0xA/0xB). When the exit bool is set it calls exitStaticCamera instead, which clears the active floats and hands control back via a cubic-bezier blend stored at +400.**

  <sub>CameraTriggerGameObject::triggerObject lines 315619-315660 (field offsets and the two branches); updateStaticCameraPosToGroup lines 451473-451550; updateStaticCameraPos lines 450937-451075; exitStaticCamera lines 451385-451465</sub>

- **Camera Rotate trigger (2015) -> updateScreenRotation(degrees = obj+1356, relative = obj+1364, snapToClosest = obj+1337, duration = obj+1264, easing = obj+1308, easeRate = obj+1312, ids). The target angle at float index 178 becomes degrees (absolute) or degrees + current target (relative); if snapToClosest is set both the live angle (index 177) and the target are passed through convertToClosestDirection(value, 180.0). The live angle is then tweened (id 0x11) over the duration, or set instantly to the raw degrees argument when duration <= 0.** The keys behind the two switches are 70 (relative, "Add") and 394 (snapToClosest, "Snap360"): customObjectSetup :301554-301562, labelled by SetupCameraRotatePopup2::init :618062-618070. The port had them the other way round until 2026-09-30.

  <sub>CameraTriggerGameObject::triggerObject lines 315600-315612; GJBaseGameLayer::updateScreenRotation lines 449176-449210; PlayLayer override lines 89622-89650</sub>

- **Special case on a zoom in on the floor: if the player's last grounded position Y (player+2076) equals exactly 105.0, the zoom is currently increasing (previous zoom < current zoom), and the player is not flying, not upside down and gameplay is not rotated, then while the player's Y is at or below viewH - 90/zoom the camera Y target is forced to just cameraOffsetY - i.e. the view bottom is pinned to y = 0. Otherwise, whenever the zoom changed this tick the camera position is compensated so the zoom happens around the screen centre: camX += (winW/prevZoom)/2 - (winW/zoom)/2, likewise for Y.**

  ```
  camX += (winW/prevZoom - winW/zoom)*0.5;  camY += (winH/prevZoom - winH/zoom)*0.5 (skipped in the start case)
  ```

  <sub>GJBaseGameLayer::updateCamera lines 449736-449746 (the 105.0 / zoom-increasing / isFlying test and the 90.0/zoom threshold), lines 449748-449752 (the centre-preserving zoom compensation), lines 450034-450040 (v202 forcing camY = offsetY)</sub>

### Not established

- The condition that raises the camera's minimum X to 15.0 depends on LevelSettingsObject byte +340, byte +341 and GJBaseGameLayer bytes +10956/+10958 (updateCamera lines 449613-449618). I could not identify any of those four flags, so I cannot say when a left limit of x >= 15 applies. In a plain classic level the observed behaviour should be no left limit (the -99999 sentinel), but I did not prove it.
  (Since established, 2026-10-01, and the guess above was wrong.) +340 and +341 are kA23 and kA24 (objectFromDict :196187-196195). +10958 is set by setupHasCompleted :106344 (and copied from +10957 by resetLevelVariables :463044), so it is on throughout play; +10956 is set only by PlayLayer::addObject :90313-90314 when an enabled start position is picked. So unless kA24 is set, a run from the level's beginning (or any run with kA23) keeps the view's left edge at x 15 or right of it, a left Camera Edge at or under 15 included. The soft stop does not ease into it, as it reads the edge slot (v208[0], :450498-450500), except in a platformer (+10734), which eases into every limit (:450439, :450500). No official level sets kA23 or kA24, and all their start positions are disabled, so every official run has the stop: the player starts at x 0, off the left of the view, which holds still until the player is 75 behind its centre. The port follows this in render/camera.ts (LEVEL_START_LEFT).
- (Since established, 2026-10-01.) A second right-limit path exists at updateCamera lines 449604-449612: when the bool at float-index 2738 is set, maxX becomes this[2736] - viewW - cameraOffsetX, and the right-edge flag is set so the 60-unit soft stop applies. It is the level's end: PlayLayer::createObjectsFromSetupFinished :102160-102177 sets this[2736] = max(furthest object x (float 2957, kept by PlayLayer::addObject :89885-89888) + 340, getScreenRight + 300) and this[2738] = the EndPortalObject it creates there, only when the level is not a platformer. Nothing clears it, so every classic level's view slows and stops with the portal at its right edge. player+2076, read beside it at :449738, is the position at the last hitGround (:150189-150190) or propellPlayer (:147715-147716), zeroed by resetObject :153635, playerTeleported :148810 (a teleport, or rotateGameplay changing the turn, :152533) and bumpPlayer for the red pad (type 34, :157080). The port follows both in render/camera.ts.
- (Since established, 2026-09-30.) The 'dynamic' static camera: with key 212 Follow (float 114/115, the group at 116/117) the target is the group's main object read live every updateCamera; with key 453 Smooth Velocity (128/129) or Follow, updateStaticCameraPos skips the plain 0xA/0xB ease of the centre and a 0..1 progress (0x15/0x16, floats 108/109) runs instead. With Smooth Velocity the centre is cubicBezier(start, start + speed × duration / 3, lerp(target, that, key 454 modifier), target, progress), where start (94/95) is the view's centre less the offset when the trigger fired and speed (104/105) the camera's own speed then, in units a second (+368 = per-step move × 240, :450811-450813), clamped to ±10000. With Follow alone the centre moves (p − last) / (1 − last) of the way to the target each step. With Follow the axis' divisor is key 213 × progress when that is over 1. An exit (key 110) hands the view back: the jump between where the view was drawn and where it now aims is kept at +400 and tweened to 0 over the exit's move time (0xC/0xD), or along the same curve from the jump to 0 with Smooth Velocity; key 465 only forces that step to snap. A change of rotated gameplay hands the unheld axes back the same way over 1 s, easing 1, rate 2 (:449643-449661). The curve itself: lerp :430814-430830, cubicBezier :430841-430870. The port follows this in render/camera.ts.
- The GameObjectType ids in getGroundHeightForMode (5, 16, 19, 23, 24, 26, 33, 41) are reported with their literal ground heights, but I did not verify the id-to-mode mapping against the object tables; the ship/ball/wave attributions are inference from the enum ordering.
- The timer at float-index 254 (this+1016): while it is positive the Y divisor is forced to 30.0 and it counts down by dt60/60 per tick (updateCamera lines 450553-450563). It is cleared in resetCamera and when a snap flag fires. (Since found, 2026-10-01: teleportPlayer sets it to 0.5 when the teleport's byte +1652, key 55, is set, :462457-462458; the float countdown runs 121 steps at 240 Hz. Key 464 (+1685) sets both snap flags, which also clear it, and key 510 (+1686) writes the player's position into +2076. The port follows all three in render/camera.ts and Sim.teleportPlayer.)
- The argument IDA dropped from lroundf() in getModifiedDelta (line 430244) and from roundf() in update() (line 469750) is inferred to be (accumulated/step) and (delta*240) respectively from the surrounding arithmetic; it is not literally present in the decompile.
- GJGameState's easing functions (the 'easing type' int and 'easing rate' float passed to tweenValue) were not read, so I cannot give the interpolation curves for any trigger duration - only that the tween runs over the given seconds and is replaced on re-trigger.
- (Since established, 2026-09-30.) The camera rotation (float-index 177) is consumed by GJBaseGameLayer::visit :434055-434079, which turns the three game-layer wrappers (this[624..626]) about the screen centre with setRotation (clockwise-positive) and undoes it after drawing (:434160-434181); the UILayer is not under them. preUpdateVisibility :452608-452650 grows the cull rect, the ground and the background to the turned view's bounding box.
- (Since established, 2026-09-30.) convertToClosestDirection(v, 180) :428041-428058: above 180 it takes off ceil(floor(|v| / 180) / 2) whole turns, below -180 it adds them, so 350 becomes -10, 540 becomes -180 and 180 stays 180.
- applyShake calls libc rand() twice per re-roll (line 431268 onwards), so GD's own shake is not reproducible across runs. It never affects the simulation, but it means a recorded macro cannot be validated against a pixel-identical shake.

## Screen effects (the shader layer)

Added 2026-10-01, from the work that made the shader triggers reach the layers they name. Every shader trigger (2904-2924) talks to one ShaderLayer, which keeps a float per effect parameter and eases it; the setup trigger (2904) chooses which of the fifteen draw layers go through the shader, and only that band of the scene does. The port has this in `triggers/shaderState.ts` and `render/post.ts`; the shader itself is the game's, which the asset build takes out of the exe.

### certain

- **A shader trigger does not push or pop a pass: it eases values the one layer keeps. Each parameter goes to the trigger's value over the trigger's duration with its easing, or is set at once, stopping any tween on it, when the duration is 0. An effect is on while its values say so, and a trigger that "turns it off" is one that eases them back to their off values.**

  <sub>GJBaseGameLayer::triggerShaderCommand lines 422254-422603; ShaderLayer::tweenValueAuto lines 660404-660640 -> GJShaderState::tweenValue lines 660310-660345; GJValueTween::step lines 417562-417600; ShaderLayer::update lines 661546-661552</sub>

- **A key a shader trigger leaves out is 0, not a default. customObjectSetup reads each value with atof when the key is present and writes 0.0 when it is not. So an Invert Color with no key 176 (its strength, +1640) is an invert that eases itself off, which is what Dash's second one (x 1455) is for.**

  <sub>ShaderGameObject::customObjectSetup lines 308842-308852 (key 175 -> +1636, key 176 -> +1640, `else v7 = 0.0`); the strength handed to triggerInvertColor at line 422546 (float index 410 = +1640); ShaderGameObject::getSaveString writes it only when it is not 0 (line 319393)</sub>

- **The setup trigger (2904) sets the layer range before anything else: updateZLayer(key 196, key 197, key 188), then resetAllShaders when key 192 is set, and resetAllShaders ends with updateZLayer(0, 0, 0). updateZLayer raises a minimum under 1 to 1 and makes a maximum of 0 or less 15, so a missing key, and the -842150451 (0xCDCDCDCD) that most official setup triggers carry in 196 and 197, both mean the full range 1-15; a Disable All always ends at 1-15 whatever the same trigger's range says. Dash's setup at x 945 stores 8 and 8: the player's layer alone.**

  ```
  min = key196 < 1 ? 1 : key196;  max = key197 <= 0 ? 15 : key197   (196/197 atoi'd when present, else 0)
  ```

  <sub>triggerShaderCommand lines 422289-422297 (case 0xB58); ShaderLayer::updateZLayer lines 659623-659645; ShaderLayer::resetAllShaders lines 659745-659751; ShaderGameObject::customObjectSetup lines 308999-309006 (196 -> +1700, 197 -> +1704), 308929-308932 (188 -> +1695)</sub>

- **The layer numbers are 1 BG, 2 MG, 3-7 B5 to B1, 8 P, 9-12 T1 to T4, 13 G, 14 UI and 15 Max. The band is every child of the object layer whose z order lies from minZOrderForShaderZ(min) to maxZOrderForShaderZ(max); for P that is 39 to 61, the player (59) with its particles under (39) and over (61) it, or 40 to 60 when the setup's key 188 leaves the particles out. With BG in the band everything under it is in it too. The background, the middleground and the ground are tested on their own, by the layer numbers. Whatever is below the band is drawn under it as it is, and whatever is above over it.**

  ```
  minZ: BG -1600, MG -1600, B5 -1500, B4 -1200, B3 -900, B2 -600, B1 -300, P 39, T1 100, T2 400, T3 700, T4 1000, G/UI/Max 1400
  maxZ(n) = minZ(n + 1) - 1, except BG and MG -1600, P 61, Max 1400
  ```

  <sub>SetupShaderEffectPopup::zLayerToString lines 662927-662989; GJBaseGameLayer::maxZOrderForShaderZ lines 422638-422672; minZOrderForShaderZ lines 422613-422622 is a jump table the decompile does not show, and the values above are the 2.2074 exe's, read at VA 0x140223700; updateShaderLayer lines 424782-424939 (the background 424782-424792, the middleground 424793-424801, the ground 424802-424824, key 188 424843-424873, the object layer's children 424877-424939); the player at z 59, GJBaseGameLayer::createPlayer lines 417925-417928</sub>

