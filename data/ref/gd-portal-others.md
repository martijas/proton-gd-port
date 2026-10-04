# the non-mode portals, read out of the 2.206 decompile

Everything below comes from `gd-ida-decomp.cpp` (IDA pseudo-C of GD 2.206, ARM32). Every
line range was re-read before being cited. Offsets are proved from an independent site
before any meaning is attached to them.

## what this answers, in one page

**The `× 0.5` is not a ship-portal rule and not a gravity-portal rule — it is a
`PlayerObject::flipGravity` rule.** The body is in the decompile and it is unambiguous:
when the gravity flag actually changes, and the "suppress" flag `+1601` is clear, the y
velocity is multiplied by `0.5`. It runs in *both* directions (into flipped gravity and
back out of it), and it runs for *every* caller — the two gravity portals, the toggle
portal 2926, the blue orb/pad, the green orb, the spider orb, the ball click, the swing
click, the teleport portal's own gravity setting, and the dash-gravity orb. The port's
`GRAVITY_PORTAL_VELOCITY_FACTOR = 0.5` has the right number for the wrong reason: it is
modelled as a portal constant, and it is missing everywhere else a flip happens. The
port's separate `BALL_FLIP_EXTRA_FACTOR = 0.5` is the same rule counted twice — the real
ball click is `setYVelocity(jump)` → `flipGravity` (halves) → `× 0.6`, which is where
boomlings' measured `0.3 × yStart` comes from.

**Nothing else in the non-mode portals touches the y velocity at all.** Size portals,
speed portals, mirror portals and teleport portals leave `m_yVelocity` exactly as it was.
The dual portals are the one exception, and only because entering dual *constructs* player
2: `spawnFromPlayer` copies player 1 wholesale, flips its gravity and negates its y
velocity; leaving dual copies player 2's y velocity verbatim onto player 1 if player 2 is
the one that hit the exit portal.

**There is no y-position snap to the portal's own y for any portal except the teleport
portal.** What every portal does with its own position is store it on the player at
`+2032`, for the circle-wave/lightning effects, and `flipGravity` copies that to `+2076`,
which is a *camera* input. The player's own position is never written by a gravity, size,
mirror or dual portal. The teleport portal is the exception and it writes the position
outright: for the classic linked pair (id 747) the new position is `(player.x,
partnerY)`; for everything else it is the target object's own position.

**Activation is one-shot per attempt per player by default**, not per overlap: the object
is skipped on entry to the collision loop if `hasBeenActivatedByPlayer(player)` is already
true, and `canBeActivatedByPlayer` is what sets that flag. A portal can carry the
multi-activate checkbox (`canAllowMultiActivate` allows it on every portal id), but it is
off unless the level string says otherwise, and with it off the per-player activated flag
is the only thing that decides.

## certain

**`+1936` is the y velocity, proved from three independent sites: the getter returns it,
the setter writes it, and `addToYVelocity` reads-modifies-writes it.**

```c
getYVelocity(this)      -> *((_QWORD *)this + 242)      // 242*8 = 1936
setYVelocity(this,v,r)  -> *(double *)(this + 1936) = v // after a round-to-milli fixup
addToYVelocity(this,d,r)-> setYVelocity(this, d + *(double*)(this+1936), r)
```
<sub>PlayerObject::setYVelocity / getYVelocity / addToYVelocity, gd-ida-decomp.cpp:141992-142046</sub>

**`setYVelocity` is not a plain store: a non-integral value is snapped to three decimal
places before it is written.** `v5 = (double)(int)a2; if (a2 != v5) v3 = v5 + round(...)/1000.0;`
The port stores the raw double; this quantisation is real and applies to every velocity
the game sets through this path.
<sub>PlayerObject::setYVelocity, gd-ida-decomp.cpp:141992-142008</sub>

**`+1967` is the gravity-flipped flag: `flipMod` returns `-1` when it is set and `+1`
otherwise.**
<sub>PlayerObject::flipMod, gd-ida-decomp.cpp:143484-143490</sub>

**`PlayerObject::flipGravity(newFlag, suppressCircle)` does nothing at all unless the flag
actually changes, and then it halves the y velocity — unconditionally except for the
`+1601` suppress flag.**

```c
if (this[1967] == a2) return;              // the flag must actually change
placeStreakPoint(); this[1967] = a2;
*(_QWORD*)(this+1632) = *(_QWORD*)(this+2144);   // remember the time of this flip
*(_QWORD*)(this+1872) = 0; *(_QWORD*)(this+1864) = 0;  // drop pending floor/ceiling contacts
*(_BYTE*)(this+2073) = 0;
if (this[1953] || this[1952]) this[1404] ^= 1;   // only while on a slope
resetCollisionLog(1);
if (!this[1601]) {
    *(double*)(this+1936) = *(double*)(this+1936) * 0.5;   // <-- the rule
    if (!a3) spawnPortalCircle(...);                       // a3 only gates the visual
}
updatePlayerScale(); updatePlayerArt();
CCPoint::operator=(this+2076, this+2032);        // camera: remember the portal position
this[1969] = 0;
if (this[1963]) { stopRotation(1,6); runBallRotation2(); }   // ball art only
else if (this[1972]) updateSwingFire();                      // swing art only
```
<sub>PlayerObject::flipGravity, gd-ida-decomp.cpp:151121-151207</sub>

**The second argument of `flipGravity` (`a3`) suppresses only the portal circle — it has
no effect on the velocity.** The halving sits inside `if (!this[1601])`, above the
`if (!a3)` that guards `spawnPortalCircle`.
<sub>PlayerObject::flipGravity, gd-ida-decomp.cpp:151156-151177</sub>

**`+1601` means "we are copying/restoring state, not playing", so in real gameplay the
halving always applies.** It is set to 1 only for the duration of `copyAttributes`, of the
reset path, and of the checkpoint-load path, and cleared again at the end of each.
<sub>PlayerObject::copyAttributes 153307/153329; reset 153567/153671; checkpoint load 161637/161744, gd-ida-decomp.cpp</sub>

**The same code runs leaving flipped gravity as entering it — there is no "on entry only"
branch.** Callers pass the new flag: the yellow portal passes `1`, the blue portal passes
`0`, the green toggle portal and every orb pass `player[1967] ^ 1`.
<sub>GJBaseGameLayer::collisionCheckObjects cases 3 / 4 / 0x2A, gd-ida-decomp.cpp:463492-463542, 463830-463857</sub>

**`flipGravity` does not move the player and does not rotate it.** The only position write
is `+2076 = +2032` (a camera field, below), and the only rotation calls are the ball's
`stopRotation`/`runBallRotation2` and the swing's `updateSwingFire`, both art.
<sub>PlayerObject::flipGravity, gd-ida-decomp.cpp:151194-151205</sub>

**`+2076` is a camera field, not a position.** The camera reads
`player1->+2076` and compares its y to `105.0` (the default start y) to decide whether a
portal has moved the camera anchor yet.
<sub>PlayLayer camera, gd-ida-decomp.cpp:449738-449744</sub>

**`flipGravity` timestamps the flip at `+1632`, and that is what the post-flip grace
windows read.** `isSafeFlip(t)` is `lastFlipTime != 0 && now - lastFlipTime < t`; callers
pass `0.1` (the inner-hitbox/head snap) and `isSafeSpiderFlip` passes `0.04`.
<sub>PlayerObject::isSafeFlip, gd-ida-decomp.cpp:147844-147850; callers 152374, 152398, 157647, 464736</sub>

**The two doubles `flipGravity` zeroes are the pending floor and ceiling contact heights.**
`updateCollideBottom` writes `+1872`, `updateCollideTop` writes `+1864`, each keeping the
extreme value for the current gravity direction.
<sub>PlayerObject::updateCollideBottom / updateCollideTop, gd-ida-decomp.cpp:142770-142845</sub>

**The ball click is the independent confirmation that the halving is real: jump velocity,
then flip (× 0.5), then × 0.6 — a net 0.3 × yStart.**

```c
setYVelocity(yStart * flipMod * v20, 2);
...
if (this[1963]) {                                   // ball
    flipGravity(this[1967] ^ 1, 1);                 // halves
    *((double *)this + 242) *= 0.600000024;         // 0.6f
}
```
<sub>PlayerObject::updateJump, gd-ida-decomp.cpp:155814, 155855-155862</sub>

**The swing click flips and then *overwrites* the velocity, so the halving is invisible
there: `yVel = (velocity captured before the flip) * 0.8`.** The port's
`SWING_CLICK_FACTOR = 0.8` with no extra 0.5 is correct.
<sub>PlayerObject::updateJump, gd-ida-decomp.cpp:155607-155617</sub>

**Gravity portal ids map to object types 3 / 4 / 42, and the dispatch is a plain switch on
the object type.** id 11 "Yellow Gravity Portal" → type 3 → `flipGravity(player, 1)`;
id 10 "Blue Gravity Portal" → type 4 → `flipGravity(player, 0)`; id 2926 "Green Gravity
Portal" → type 42 → `flipGravity(player, player[1967] ^ 1)`.
<sub>gd_2206_customSetup_objectTypes.csv ids 10/11/2926; GJBaseGameLayer::collisionCheckObjects, gd-ida-decomp.cpp:463490-463542, 463830-463857</sub>

**A gravity portal stores its own position on the player and records itself as the last
portal, and that is the whole of its interaction with the player's position.**

```c
CCPoint::operator=(player + 2032, portal->getPosition());
*(_DWORD *)(player + 2116) = portal;
GJBaseGameLayer::flipGravity(layer, player, <0|1|toggle>, portal[900] ? 1 : portal[1106]);
```
<sub>GJBaseGameLayer::collisionCheckObjects case 3, gd-ida-decomp.cpp:463492-463520</sub>

**In dual, `GJBaseGameLayer::flipGravity` mirrors the flip onto the other player — it flips
the *other* player to the opposite value — but only when the two players are in the same
mode.** The mode bytes compared are 1961/1962/1963/1965/1966/1972 (ship/bird/ball/robot/
spider/swing).
<sub>GJBaseGameLayer::flipGravity, gd-ida-decomp.cpp:420149-420182</sub>

**Size portals are types 17 (id 99, back to normal) and 18 (id 101, mini), and they call
`togglePlayerScale` and nothing else.** Same shape as the gravity portals: store `+2032`,
store `+2116`, `togglePlayerScale(player, 0|1, portal[900])`, shine, `activatedByPlayer`.
<sub>GJBaseGameLayer::collisionCheckObjects cases 0x11 / 0x12, gd-ida-decomp.cpp:463629-463660</sub>

**`togglePlayerScale` early-returns when the player is already at the requested size, sets
the scale field `+2016` to `0.6` or `1.0`, and changes nothing else about the physics
state — no velocity, no position.** What follows the scale write is art: particle
`loadScaledDefaults`, streak stroke, a `CCScaleTo` of 0.5 s wrapped in `CCEaseElasticOut`
(`0x3F000000` = `0.5f`), a lightning flash at `+2032`, the portal circle, the scale
circle, and `updateRobotAnimationSpeed`.
<sub>PlayerObject::togglePlayerScale, gd-ida-decomp.cpp:150364-150506</sub>

**`+2016` is the size the physics reads, proved from `updateJump`: `scale == 1.0` picks the
`0.8` mini jump factor, and the flying branch divides the `8.0 / -6.4` caps by `0.85` when
`scale != 1.0`.**
<sub>PlayerObject::updateJump, gd-ida-decomp.cpp:155476-155487</sub>

**Going mini does not move the player, so a mini player's feet end up 6 units above the
floor and it falls.** The floor the collision pass snaps to is
`v12 = height*0.5 + 90.0 - (1 - scale)*height*0.5`: full size `15 + 90 - 0 = 105`,
mini `15 + 90 - 6 = 99`, and `99` is exactly `90 + 9` (mini half-height).
<sub>GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464678-464690</sub>

**Speed portals never touch the y velocity, and they are not even in the portal switch:
they are object type 20 ("Modifier") and go through the trigger path.**
<sub>gd_2206_customSetup_objectTypes.csv ids 200-203/1334; collisionCheckObjects case 0x14, gd-ida-decomp.cpp:463671-463674</sub>

**The speed values are 0.7 / 0.9 / 1.1 / 1.3 / 1.6 for ids 200 / 201 / 202 / 203 / 1334,
decoded from the raw floats in `EffectGameObject::triggerObject`.**
`1060320051 = 0x3F333333 = 0.7`, `1063675494 = 0x3F666666 = 0.9`,
`1066192077 = 0x3F8CCCCD = 1.1`, `1067869798 = 0x3FA66666 = 1.3`,
`1070386381 = 0x3FCCCCCD = 1.6`.
<sub>EffectGameObject::triggerObject, gd-ida-decomp.cpp:315457-315482</sub>

**The speed change is queued, not immediate: the trigger stores the value on the layer and
a later pass pushes it to both players.** `updateTimeMod(layer, v, 0, silent)` writes
`layer+984`/`layer+988`; the pass that runs with `a3 = 1` clears them and calls
`PlayerObject::updateTimeMod` for player 1 and, in dual, player 2.
<sub>GJBaseGameLayer::updateTimeMod, gd-ida-decomp.cpp:421462-421485; the applying call, gd-ida-decomp.cpp:469848</sub>

**`PlayerObject::updateTimeMod` writes the time mod and the three per-speed physics
constants and nothing else — the y velocity is not read or written.**

```c
*(float*)(this+2020) = a2;                      // m_timeMod
*((_QWORD*)this + 196) = <yStart>;              // +1568
*((_QWORD*)this + 197) = <gravity>;             // +1576
*((_QWORD*)this + 195) = <speedMultiplier>;     // +1560
updateRobotAnimationSpeed(); if (ball) runRotateAction(0,9); updateStreakSettings(...)
```
<sub>PlayerObject::updateTimeMod, gd-ida-decomp.cpp:150522-150575</sub>

**The 0.7 and 0.9 rows of the port's `SPEED_PARAMS` are exactly right, decoded from the
raw doubles.** `0x40253D74D594F26B = 10.620032` (yStart 0.7), `0x3FEE161C36976BC2 =
0.940199` (gravity 0.7), `0x4017EB85A4F00EF1 = 5.980002` (multiplier 0.7),
`0x40265C2D20000000 = 11.180032`, `0x3FEEA99100000000 = 0.958199`,
`0x4017147B60000000 = 5.770002` (0.9).
<sub>PlayerObject::updateTimeMod, gd-ida-decomp.cpp:150531-150563</sub>

**Mirror portals are types 14 (id 45, into mirror) and 15 (id 46, out of mirror) and they
call `GJBaseGameLayer::toggleFlipped`, which touches the *layer*, never the player.**
Guarded by `layer[860] == a2 → return`; it tweens `layer+864` between `~0` (`0x3727C5AC`
= `1e-5`) and `~1` (`0x3F7FFF58` = `0.99999`) over 0.4 s with easing type 7, and calls
`levelWillFlip` on each player (which only fades the streak).
<sub>GJBaseGameLayer::toggleFlipped, gd-ida-decomp.cpp:449092-449158; PlayerObject::levelWillFlip, gd-ida-decomp.cpp:147801-147807</sub>

**Mirror portals are also blocked while the level is already flipping in that direction,
and they mark the object activated for *both* players** (`vtable+736` =
`triggerActivated`, which sets 1256 and 1257) rather than for the touching player only.
<sub>GJBaseGameLayer::collisionCheckObjects cases 0xE / 0xF, gd-ida-decomp.cpp:463585-463620; EnhancedGameObject::triggerActivated, gd-ida-decomp.cpp:164128-164134</sub>

**Dual portals are types 23 (id 286, on) and 24 (id 287, off); `toggleDualMode` is guarded
by the flag actually changing.**
<sub>GJBaseGameLayer::collisionCheckObjects cases 0x17 / 0x18, gd-ida-decomp.cpp:463691-463729; GJBaseGameLayer::toggleDualMode, gd-ida-decomp.cpp:462616-462712</sub>

**Entering dual builds player 2 from player 1 with mirrored gravity and a negated y
velocity.**

```c
spawnPlayer2() -> spawnFromPlayer(player2, player1, layer[1512] ^ 1)
spawnFromPlayer(this, src, mirror):
    copyAttributes(this, src);                       // position, gravity, mode, size, speed, yVel
    if (mirror) { flipGravity(this, src[1967] ^ 1, 1); yVel = -src.yVel; }
    else        { flipGravity(this, src[1967],     1); yVel =  src.yVel; }
    setYVelocity(this, yVel, 49);                    // overwrites whatever the flip did
    this[1969] = 0; this[2044] = 0;
```
<sub>GJBaseGameLayer::spawnPlayer2, gd-ida-decomp.cpp:420882-420898; PlayerObject::spawnFromPlayer, gd-ida-decomp.cpp:153347-153375</sub>

**`copyAttributes` copies the position, gravity, every mode flag, the time mod, the size
and the y velocity — with `+1601` held at 1 throughout, so none of the toggles it calls
apply their own velocity rules.**
<sub>PlayerObject::copyAttributes, gd-ida-decomp.cpp:153298-153330</sub>

**Leaving dual copies player 2 onto player 1 when player 2 is the one that hit the exit
portal, y velocity included and unmodified.** `if (a4->id == player2->id)
copyAttributes(player1, player2)`, then `removePlayer2`.
<sub>GJBaseGameLayer::toggleDualMode, gd-ida-decomp.cpp:462664-462690</sub>

**Teleport portals are object type 28 — id 747 (the classic linked pair's entrance) and
id 2902 (unlinked blue). The orange exit, id 2064, is object type 7 "Decoration", and
type 7 is the first thing `collisionCheckObjects` skips, so the exit is never itself
activated.**
<sub>gd_2206_customSetup_objectTypes.csv ids 747/2064/2902; collisionCheckObjects, gd-ida-decomp.cpp:463392</sub>

**`teleportPlayer` writes the player's position and never its velocity.**

```c
if (portal[+1640]) portal[+1648] = linked.y - portal.y;   // the pair's y difference
target = getPortalTarget(portal);
if (target) {
    player[+2032] = portal.getPosition(); player[+2116] = portal;
    p = getPortalTargetPos(layer, portal, target, player);
    if (portal[1676]) p -= (portal.slot672() - player.getPosition());  // keep relative offset
    if (portal[1677]) p.x = player.x;
    if (portal[1678]) p.y = player.y;
    player->setPosition(p);
}
switch (portal[+1680]) {           // the portal's own gravity setting
    case 1: flipGravity(player, 0, 1); break;
    case 2: flipGravity(player, 1, 1); break;
    case 3: flipGravity(player, player[1967] ^ 1, 1); break;
}
```
<sub>GJBaseGameLayer::teleportPlayer, gd-ida-decomp.cpp:462312-462375</sub>

**That gravity setting is a normal flip, so it *does* halve the y velocity** — `+1601` is
clear in gameplay and the third argument only suppresses the circle.
<sub>GJBaseGameLayer::teleportPlayer, gd-ida-decomp.cpp:462351-462375; PlayerObject::flipGravity, gd-ida-decomp.cpp:151156-151158</sub>

**The destination is `(player.x, partner.y)` for the classic linked portal and the
target's own position for everything else.**

```c
getPortalTargetPos(layer, portal, target, player):
    if (!target || portal->id == 747)
        return CCPoint(player.getPosition().x, portal.slot672().y + portal[+1648]);
    else
        return target.slot672();
```
Since `portal[+1648]` was set to `partner.y - portal.y`, the 747 branch is
`portalY + (partnerY - portalY)` = the partner's y, with the player's x untouched. This is
the only y snap in the whole portal set.
<sub>GJBaseGameLayer::getPortalTargetPos, gd-ida-decomp.cpp:419416-419438; the offset write, gd-ida-decomp.cpp:462316-462324</sub>

**The 3027 teleport orb is object type 46; it goes through the ring path and ends in the
same `teleportPlayer`, and it too leaves the velocity alone.** `ringJump` case 46:
`teleportPlayer(layer, orb, player); player[1910] = 0;`.
<sub>gd_2206_customSetup_objectTypes.csv id 3027; PlayerObject::ringJump, gd-ida-decomp.cpp:160068-160077</sub>

**Its "target group" is resolved by `getPortalTarget`: the direct link if there is one,
otherwise a *random* member of the target group.** With more than one member it draws from
the game's own LCG (`qword_A9C810 * k + 2531011 >> 16`, masked to 15 bits, divided by
32767) and indexes `count * r`.
<sub>GJBaseGameLayer::getPortalTarget, gd-ida-decomp.cpp:422931-422960</sub>

**After a teleport (and after the teleport orb) the collision loop re-reads the player's
rect before continuing with the remaining objects.**
<sub>GJBaseGameLayer::collisionCheckObjects, LABEL_124 at gd-ida-decomp.cpp:463754-463761</sub>

**`teleportPlayer` also resets the camera anchor: `playerTeleported` clears `+2044` and
sets `+2076` back to the sentinel point.**
<sub>PlayerObject::playerTeleported, gd-ida-decomp.cpp:148807-148812; called from gd-ida-decomp.cpp:462466</sub>

**The shared path is `GJBaseGameLayer::collisionCheckObjects`, and the gate order is
fixed.**

```c
for each candidate object:
    if (objectType == 7 || obj[550] || obj[826]) skip;      // decoration / disabled
    if (objectType is 0, 21) -> solid list;  if (2, 47) -> hazard list;  if (39) skip;
    if (obj->hasBeenActivatedByPlayer(player)) skip;         // vtable+764
    rect overlap (or playerCircleCollision when obj[756] > 0)
    if (obj[636]) OBB2D::overlaps1Way both ways
    if (canTouchObject(layer, obj))                          // camera-group filter
        switch (objectType) { ... }
```
<sub>GJBaseGameLayer::collisionCheckObjects, gd-ida-decomp.cpp:463309-463490</sub>

**`canBeActivatedByPlayer` is the one-shot gate, and it records the touch on both paths.**

```c
canBeActivatedByPlayer(player, obj):
    if (obj->canMultiActivate(player[2336]) && playerWasTouchingObject(player, obj)) {
        playerTouchedObject(player, obj); return 0;          // already overlapping: blocked
    }
    playerTouchedObject(player, obj);
    return !obj->hasBeenActivatedByPlayer(player);
```
<sub>GJBaseGameLayer::canBeActivatedByPlayer, gd-ida-decomp.cpp:456752-456766</sub>

**`playerWasTouchingObject` is a set membership test on `(objectID, playerID)`, and
`playerTouchedObject` inserts that pair stamped with the current frame.** No erase site for
that map appears anywhere in this dump — only the insert, the lookup and a `clear` on level
reset — so within what is readable here "was touching" means "has touched at any point this
attempt".
<sub>GJBaseGameLayer::playerWasTouchingObject, gd-ida-decomp.cpp:440602-440612; playerTouchedObject, gd-ida-decomp.cpp:456726-456736; the clear, gd-ida-decomp.cpp:462990</sub>

**`player[+2336]` is the platformer flag, proved by its only setter.**
`PlayerObject::togglePlatformerMode(bool a2) { this[2336] = a2; }`, and the layer copies
its own platformer byte into both players.
<sub>PlayerObject::togglePlatformerMode, gd-ida-decomp.cpp:141624-141628; PlayLayer setup, gd-ida-decomp.cpp:106212-106213</sub>

**`canMultiActivate` is `isPlatformer ? !obj[1253] : obj[1254]`, so in a classic level a
portal with the checkbox off can never take the multi-activate branch — the activation
flag alone decides, and it is per-player (1256 for player id 1, 1257 otherwise).**
<sub>EnhancedGameObject::canMultiActivate, gd-ida-decomp.cpp:164106-164112; activatedByPlayer, gd-ida-decomp.cpp:165225-165241; hasBeenActivatedByPlayer, gd-ida-decomp.cpp:165257-165270</sub>

**`canAllowMultiActivate` — which ids may carry the checkbox at all — covers every portal,
so "one-shot" is a default, not a guarantee.** The accepted ids are 10-13, 35, 36, 45-47,
67, 84, 99, 101, 111, 140, 141, 286, 287, 660, 745, 747, 1022, 1330-1333, 1594, 1704,
1751, 1933, 2902, 2926, 3004, 3005, 3027 and 3643 — i.e. the gravity, cube, ship, mirror,
size, UFO, dual, wave, teleport and toggle portals along with the orbs and pads.
<sub>EnhancedGameObject::canAllowMultiActivate, gd-ida-decomp.cpp:163950-164019</sub>

**Gravity, size, ship/ball/robot/spider/wave/swing, and teleport portals mark themselves
activated for the touching player only (`vtable+760` = `activatedByPlayer`); mirror and
dual portals mark both players (`vtable+736` = `triggerActivated`).**
<sub>GJBaseGameLayer::collisionCheckObjects, gd-ida-decomp.cpp:463515, 463597, 463615, 463705</sub>

**`processCameraObject` stores the portal's position on the player and makes it the
camera's reference object; it does not move the player.**

```c
if (obj) { CCPoint::operator=(player+2032, obj->getPosition()); player[+2116] = obj; }
if (layer[870] && layer[+848]) obj = layer[+848];   // dual: prefer the dual portal
else if (!obj) return;
layer[+844] = obj;
```
<sub>GJBaseGameLayer::processCameraObject, gd-ida-decomp.cpp:420071-420101</sub>

**`playerWillSwitchMode` records the portal, updates the camera mode, re-animates the dual
ground and fires the event; its only physics effect is a dual-mode gravity flip.** In dual,
if the *other* player is already in the mode this portal switches to, this player's gravity
is set to the opposite of the other player's.
<sub>GJBaseGameLayer::playerWillSwitchMode, gd-ida-decomp.cpp:462507-462599</sub>

**The floor/ceiling corridor is only applied when the camera is not free and the player is
flying, a ball, a spider, or in dual — a solo cube or robot has no ceiling.**

```c
if (layer[689])                       v13 = 0;              // free camera: no corridor
else if (isFlying() || ball || spider) v13 = 1;
else                                   v13 = layer[870];    // dual: yes, even as a cube
```
<sub>GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464691-464703</sub>

**The corridor limits themselves are dynamic — `getMaxPortalY`/`getMinPortalY`, derived
from the ground and ceiling nodes divided by the camera zoom, with the minimum floored at
90.0 — while the fixed heights live in `getGroundHeightForMode`: `0x43700000 = 240.0` for
the ball (16), `0x43960000 = 300.0` for ship (5), UFO (19), wave (26) and swing (41), and
`0x43870000 = 270.0` for everything else including the spider (33) and dual.**
<sub>GJBaseGameLayer::getGroundHeightForMode, gd-ida-decomp.cpp:419619-419650; getMinPortalY/getMaxPortalY, gd-ida-decomp.cpp:420443-420512; the clamp, gd-ida-decomp.cpp:464763-464790</sub>

**In dual the ball's 240 is raised to 270, and the corridor takes the larger of this
player's and the other player's mode height.**
<sub>GJBaseGameLayer::getGroundHeight, gd-ida-decomp.cpp:420553-420591</sub>

**The floor sits at y = 90 in the game's own coordinates: the y a full-size player is
snapped to is `vehicleHeight*0.5 + 90.0`, i.e. 105, which is also the value the camera
treats as "the default start y".**
<sub>GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464678-464690; camera, gd-ida-decomp.cpp:449739</sub>

**`+2160` is a per-mode corridor height distinct from the sprite size: the spider sets it
to `0x41D80000 = 27.0` (content size also 27) and the wave sets it to `0x41A00000 = 20.0`
while its content size is `0x41200000 = 10.0`.**
<sub>PlayerObject::toggleSpiderMode, gd-ida-decomp.cpp:152721-152723; PlayerObject::toggleDartMode, gd-ida-decomp.cpp:153041-153043</sub>

### verdicts on the port's constants

**`GRAVITY_PORTAL_VELOCITY_FACTOR = 0.5` — right number, wrong home.** It belongs in
`flipGravity`, applied whenever the gravity flag changes and the player is not being
copied/restored, in both directions, for every caller. The comment claiming the body is
not decompiled is stale: it is at gd-ida-decomp.cpp:151121-151207.
<sub>PlayerObject::flipGravity, gd-ida-decomp.cpp:151156-151158</sub>

**`BALL_FLIP_EXTRA_FACTOR = 0.5` is the same rule double-counted and should disappear once
`flipGravity` halves.** Order matters: flip first, then `× 0.6`.
<sub>PlayerObject::updateJump, gd-ida-decomp.cpp:155855-155862</sub>

**`MINI_SCALE = 0.6` is right, and so are `MINI_JUMP_FACTOR = 0.8` and
`MINI_FLY_DIVISOR = 0.85`.**
<sub>PlayerObject::togglePlayerScale, gd-ida-decomp.cpp:150398; PlayerObject::updateJump, gd-ida-decomp.cpp:155476-155487</sub>

**`POST_FLIP_SNAP_GRACE = 0.1` and `SPIDER_FLIP_GRACE = 0.04` are right.**
<sub>PlayerObject::isSafeFlip, gd-ida-decomp.cpp:147844-147850; callers 152374 and 152398</sub>

**`SPEED_PARAMS` rows 0 and 1 match the binary exactly.**
<sub>PlayerObject::updateTimeMod, gd-ida-decomp.cpp:150531-150563</sub>

**`TELEPORT_DEFAULT_OFFSET = 90` has no counterpart in the binary.** There is no default
offset: with a linked partner the offset is `partner.y - portal.y`, recomputed on every
teleport; with no link the target's own position is used whole.
<sub>GJBaseGameLayer::teleportPlayer, gd-ida-decomp.cpp:462316-462324; getPortalTargetPos, gd-ida-decomp.cpp:419427-419436</sub>

**`FLY_CORRIDOR_HEIGHT = 300`, `BALL_CORRIDOR_HEIGHT = 240`, `SPIDER_CORRIDOR_HEIGHT = 270`
agree with the binary's mode table; `OPEN_CEILING` for cube and robot is right solo and
wrong in dual, where the corridor applies to every mode at height 270.**
<sub>GJBaseGameLayer::getGroundHeightForMode, gd-ida-decomp.cpp:419619-419650; GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464691-464703</sub>

## likely

**`FLOOR_Y = 0` disagrees with the binary's 90, and the port has no compensating shift, so
its ground is 90 units below the real one.** The binary snaps a resting full-size player to
`90 + halfHeight = 105`, and `PLAYER_START_Y = 105` in the port is that same number — but
measured from a floor at 0 it is 90 units of free fall that the real game does not have.
No `- 90` appears anywhere in the port's level loading or `sim.ts` reset. I have not
audited the whole loader, so this is "likely", not "certain".
<sub>GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464678-464690</sub>

**`portal[+900]` is the "silent / no visual effects" flag.** Every portal passes it as the
suppress argument to the toggle it calls, and `if (!portal[900])` guards the lightning
flash and the circle waves. Its own setter was not located.
<sub>GJBaseGameLayer::collisionCheckObjects, gd-ida-decomp.cpp:463505-463508, 463629-463644</sub>

**`layer` vtable slot 716, called by the gravity portals and the gravity pad with the new
gravity flag, is the ground-flip animation.** It is only ever called with the target
gravity value and only when `!portal[900]`, which fits an art hook, but the slot is not
resolved to a name here.
<sub>GJBaseGameLayer::collisionCheckObjects, gd-ida-decomp.cpp:463496-463498, 463832-463836; gravBumpPlayer, gd-ida-decomp.cpp:463245</sub>

**`obj[+1253]`/`obj[+1254]` are the level-string multi-activate flags (keys 444 and 99).**
They are parsed straight out of the object's key dictionary next to the other setup
flags; the mapping to editor checkbox names is inferred, not proved.
<sub>EnhancedGameObject setup, gd-ida-decomp.cpp:181778-181786</sub>

**`player[+1404]`, which `flipGravity` XORs when the player is on a slope
(`+1952`/`+1953`), is a slope-direction bit read by `isBoostValid`.** Its exact semantics
were not pinned down.
<sub>PlayerObject::flipGravity, gd-ida-decomp.cpp:151153-151154; PlayerObject::isBoostValid, gd-ida-decomp.cpp:142563-142581</sub>

## Not established

- **Vtable slot 672** (`CCPoint`-returning, used for the teleport source and destination
  anchors) and **slot 900** (`CCPoint`-out, used for the pair's y difference and by
  `getTargetFlyCameraY`) are not resolved to names. Both return a point associated with the
  object; whether either is the object's plain position or a portal-specific anchor is not
  shown by any site read here.
  <sub>GJBaseGameLayer::getPortalTargetPos, gd-ida-decomp.cpp:419430-419435; teleportPlayer, gd-ida-decomp.cpp:462320-462322</sub>
- **The player argument of `getPortalTargetPos` is an IDA-dropped stack argument.** The
  mangled name `...EP20TeleportPortalObjectP10GameObjectP12PlayerObject` gives three
  parameters, and with the sret pointer in r0 the register assignment forces
  `a2 = this(layer)`, `a3 = portal`, `a4 = target`, `a5 = player`; the caller at 462336
  passes only four of the five. The x used in the 747 branch is therefore the player's x by
  argument order, not by direct evidence in the body.
  <sub>GJBaseGameLayer::getPortalTargetPos, gd-ida-decomp.cpp:419416-419438</sub>
- **The 1.1 / 1.3 / 1.6 speed constant blocks are `loc_339208`-style unresolved symbols in
  this dump**, so only 0.7 and 0.9 could be decoded. 1.3 and 1.6 demonstrably share one
  block (`loc_339220`/`loc_339228`/`locret_339230`), which matches the port's identical
  rows 3 and 4.
  <sub>PlayerObject::updateTimeMod, gd-ida-decomp.cpp:150545-150563</sub>
- **`player[+1632]`'s companion `+2144` is a time accumulator** (it is stamped into
  `+2296` on a state change and read by `isSafeFlip` as "now"), but the unit — seconds of
  gameplay versus ticks — is not shown by any site read here.
  <sub>PlayerObject::isSafeFlip, gd-ida-decomp.cpp:147844-147850</sub>
- **`player[+2073]` and `player[+1969]`, both cleared by `flipGravity`, have no proved
  meaning.**
  <sub>PlayerObject::flipGravity, gd-ida-decomp.cpp:151152, 151195</sub>
- **Whether the wave and swing portals are disabled or merely silent in platformer levels.**
  Cases 0x1A and 0x29 read `layer[+10734]` (the platformer flag) into `v48`, `break` out of
  the case when it is set — yet `v48` is also the `a4` passed to `switchToFlyMode` on the
  path that is not taken. The decompiled control flow is self-contradictory here and was not
  resolved.
  <sub>GJBaseGameLayer::collisionCheckObjects, gd-ida-decomp.cpp:463733-463742, 463815-463829</sub>
- **The default value of `player[+2160]` (the corridor height used for the floor snap) for
  cube/robot.** Only the spider (27) and wave (20) writes were found; the arithmetic at
  464678-464690 requires 30 for a cube to rest at 105, but no write of 30 was located.
  <sub>GJBaseGameLayer::checkCollisions, gd-ida-decomp.cpp:464678-464690</sub>
