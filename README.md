# GG DOGGIE 🥹


# Geometry Dash — ground-up web port

A browser port of Geometry Dash 2.2, written from scratch in TypeScript and
WebGL2. anyone can host their own copy.

The game's art, sound and levels are in `prebuilt/assets/`, already built from
Geometry Dash 2.2's own files, so hosting it needs nothing but this repository.

## Host it yourself

You need Node 20 or newer.

```
git clone https://github.com/martijas/proton-gd-port.git
cd proton-gd-port
npm ci
npm run build      # the page, its scripts and a copy of prebuilt/assets, into dist/
npm start          # serves it on http://localhost:8080 (PORT to change)
```

To build somewhere other than `dist/`, set `GD_OUT` in the environment or in a
`.env` file in the project folder.

### Remaking the assets

Only needed when Geometry Dash itself updates. Point `GD_RESOURCES` at the
install's `Resources` folder (with `GeometryDash.exe` beside it), run
`npm run assets`, and commit what changed in `prebuilt/assets/`.

```
GD_RESOURCES=C:/Program Files (x86)/Steam/steamapps/common/Geometry Dash/Resources
```

`npm start` is a small server with no dependencies. It serves the built folder
and the `/api/robtop-server/*` tunnel the game uses for online levels. You can
also put the built folder on any static host. In that case, point the host
config at a tunnel somewhere else, or online levels won't load.

### Host config

`host-config.json` is copied next to the page when you build. Edit either the
copy in the project folder before building, or the one in the built folder at
any time; the game reads it when it starts.

```json
{
  "server": { "mode": "autodetect", "hostApi": "" },
  "hostedBy": ""
}
```

- `server.mode` decides how the game reaches RobTop's level servers:
  - `"autodetect"`: through `/api/robtop-server/*` on whatever site the game
    is loaded from. `npm start` and Proton Catalog both answer it.
  - `"hostApi"`: through the tunnel at `server.hostApi`, a full URL such as
    `https://example.com/api/robtop-server`. The game posts to
    `<hostApi>/<endpoint>.php` and fetches songs from `<hostApi>/audio?url=…`.
    `npm start` allows other sites to use its tunnel this way.
  - `"direct"`: straight to `https://www.boomlings.com/database`. Browsers
    normally block this, because RobTop's servers don't allow requests from
    other sites. Only use it where that isn't enforced, such as a desktop
    wrapper.
- `hostedBy` is shown as "Hosted by …" under the home screen's play button.
  Leave it empty to show nothing.

Players can see both settings under Settings > Server, but can't change them.

## Commands

```
npm run dev       dev server on :5199 (/api is passed to GD_DEV_API, default http://localhost:3000)
npm run build     writes index.html, the debug pages, js/ and a copy of prebuilt/assets into GD_OUT
npm run assets    rebuilds prebuilt/assets/ from the install in GD_RESOURCES
npm start         serves GD_OUT with the level-server tunnel
npm test          decoder, physics, object table, triggers and asset checks
npm run bot       the autoplayer (see test/macros/README.md)
npm run triggers  how much of the trigger set is handled, weighted by use
```

The tests read the built assets and the official levels from `prebuilt/assets/`.

`index.html` is the game. `debug.html?level=<id>` plays a level with the
physics readout; add `&audio=1` for sound, `&macro=1` to replay the saved
autoplayer run, `&macro=best` for the furthest failed attempt.
`macroverify.html` plays every saved run back to back — Stereo Madness to
Dash, then The Challenge — moving on by itself when each one ends, so a run
that does something it should not can be watched rather than inferred;
`?level=<id>` starts it part-way down the list. Both pages have a speed
slider, from a quarter speed to sixteen times. `ui.html` shows one of every
interface part with a live hit-test readout, and `textures.html` shows what
the asset build produced.

`npm run assets -- --help` lists the build flags. The two worth knowing:
`--dry-run` prints the plan without writing, and `--verify` re-reads what is
already built and re-runs every check.

## Layout

```
src/level      level string decoder
src/physics    the 240 Hz simulation and the object table
src/assets     what the browser loads: atlases, objects, icons, levels, manifest
src/render     the WebGL2 renderer: draw list, batch order, colours, camera, screen effects
src/triggers   level logic: what fires, what moves, what colour it turns
src/ui         the interface: design box, bitmap text, widgets, screen stack
src/audio      the Web Audio graph, the music and the sound the levels ask for
src/save       progress and settings, kept in the store the catalog persists
src/game       the one object that owns all of the above
src/debug      the three debug pages (level playback, asset viewer, interface)
tools          asset pipeline and the table generators
test           node tests plus the autoplayer
data           generated tables and build reports (not shipped)
```

## Conventions

- Distances are GD units. One block is 30. Object space has y up; texture space
  has y down.
- Art is 4 pixels per unit at uhd, 2 at hd, 1 at sd. Every file that describes
  pixels carries the `pxPerUnit` it was measured at, because the trails and ship
  fire only exist at sd.
- A rotated atlas frame is stored turned 90° clockwise: its region covers `h`
  across and `w` down from `(x, y)`.
- Numbers that define behaviour live in named constants with a comment naming
  their source: `[gdp]` the 2.2 decompile, `[osgp]` the open-source annotations,
  `[boom]` measurements, `[meas]` measured here, `[guess]` a reasoned choice with
  nothing behind it yet.
- `[gdp]` tags in the trigger code point at `data/ref/trigger-semantics.md`,
  which carries 154 rules read out of the 2.206 decompile with the line number
  each one came from.

## Triggers

`npm run triggers` prints what the 10,426 trigger placements in the 27 official
levels get from this port, weighted by how often each id is actually used rather
than by id, because that is what decides whether a level looks right.

Every id in the game has an entry in `src/triggers/registry.ts` with one of four
statuses, and anything that is not `done` says why in a sentence. A trigger that
does nothing is meant to be a counted gap, never a surprise — the same rule the
asset build follows for dropped glow frames.

## State

Goals 1 (physics), 2 (assets) and 4 (triggers) are done. Goal 3 (the renderer)
draws the level, its colours, its moving parts, the player, the particles, the
frame animations, the skeletal beasts, the text objects, the ground line, the
middleground, the player's trail, the gradient layers and the screen effects.
What it still owes — most of the distortion effects, two of the gradient's
four blends, the circle waves and the middleground's true height — is under
"Known wrong" below.

Goal 5 is done. **The game is playable from its own page**: the entry page
boots into a loading screen, a main menu, level select, the level with its
HUD, a pause menu, an end screen, settings, the icon kit, the stats and the
achievements — all drawn in WebGL from the game's own art and fonts, in one
extra draw call. Progress, the chosen icons and colours, and the jump count are
kept across reloads. Practice mode has checkpoints.

Goal 6 is under way. Its plan splits the rest into four stages — the accuracy
pass and the trigger closure, then the editor, then online levels, then the
parts of the game behind the creator tiles. The accuracy pass is done for the
physics and has been through the screen effects, the camera, how each object
is set up to draw, the batches a layer draws in, how much additive art adds,
and what an object's opacity does to its particles; the trigger closure's
remaining gaps are counted by `npm run triggers`.

### Landed so far in goal 6

- **The flying corridor hangs from the right object.** This was the headline
  entry under "Known wrong" for the whole of goal 5: the band followed the
  player, so crossing a portal high inside its own box lifted the floor and
  the ceiling by a block and the section played differently depending on the
  approach. The game hangs it from an object, and while a dual is running that
  object is *the dual portal* — kept for the whole section, outranking any mode
  portal crossed inside it. That last part is what had never been spotted, and
  it is why anchoring to the portal had been tried and abandoned: Hexagon
  Force's two stacked ship portals sit inside a dual that began 64 units
  higher, so the band there is 240–540 and not the 180–480 the portals
  themselves give, and the level's blocks run up to 533. Under the old rule the
  autoplayer needed 266 s for that level; it now finishes in 68.
  Two things this port already had right and its own comment doubted: the
  30-unit snap is in the binary, and the clamp at the ground is the game's
  clamp shifted by 90, which is a multiple of 30 and so commutes with the snap.
  Entering a dual also gives *every* mode a band, the cube's and the robot's
  included, which is the game's rule and was not here before.
  `test/portals.test.ts` lost both of its `todo`s and gained the Hexagon Force
  case.
- **The level has a ceiling.** There was none, so a player whose gravity
  flipped in a mode without a corridor rose for ever and still counted x
  progress to the end. The autoplayer found that route in eight levels and
  "finished" them from thousands of units up — Dash from y 14,000. The game
  kills the player above a maximum height: a flat one for most levels, and
  for a platformer or a level carrying `kA37` its own highest object plus a
  margin. That split is exactly right for the official set — Dash and the four
  tower floors are the only levels that ask for the taller one, and the only
  ones whose art reaches above the flat line. Travelling left off the start
  with reversed gameplay is lethal too, and was missing for the same reason.
- **A pad is weaker for a mini player.** By the same four fifths a mini jump
  is, and it was missing, so a mini cube left every pad a quarter too fast and
  sailed over whatever it was meant to land on. The missing ceiling had been
  hiding it: Clutterfunk and Electroman Adventures both overshot an orb here
  and escaped into the sky instead of dying. Both now finish honestly.
- **Gameplay rotation.** Dash's Rotate Gameplay triggers turn the player a
  quarter: it travels along y and falls along x, which is how its spider walks
  down a wall. The player's own physics does not change at all — only the step
  it takes each tick is written onto the other pair of axes — and collision
  runs in the player's own frame against the level mirrored across y = x, so
  every existing resolver works unchanged. The ground and the corridor stay in
  world coordinates, as the game's own collision pass never reads the flag.
  The spider's jump searches along x when turned, 3,000 units either way.
  Walked in noclip from the top of Dash's first shaft, the spider presses
  against the right wall and walks down it to the floor, which is the section
  as it plays in the game. The autoplayer got from 13 % to 30.5 %, but not
  down that wall: Dash's spider portal is in free mode, so there is no corridor
  above it and a jump with nothing overhead lands 3,000 units up — the game's
  own rule, which the search found and took. (The view did not turn with the
  player until the camera triggers landed, and the triggers inside a turned
  section fired along x until trigger channels did; both are below.)
- **The player no longer vanishes.** It used to disappear a few seconds into
  any level and come back a while later, at random. The main menu stays on the
  stack under a level and went on running there, and each time its cube ran
  off the edge it came back with a random icon and bound that icon's page into
  the two units the player is drawn from. The level only rebound on a change
  of mode, so it never noticed, and the player drew nothing until another
  random cube happened to share its page — in one measured run, 1,602 of 1,649
  frames. Three changes, any one of which would have stopped it: a screen
  covered by an opaque one no longer updates, since it is not drawn either;
  the level checks every frame that the players' pages are the ones bound,
  so nothing can take them for longer than a frame; and the menu checks its
  own page the same way, because quitting a level uncovers it without
  entering it again. Two smaller faults in the same code went with it. A
  level now loads the icon of every mode it uses before its first attempt, so
  the player no longer blinks out on a first portal while that image
  downloads. And in a dual, player 2's pages are bound as well as player 1's —
  up to the two units there are, so a dual whose players need three pages
  between them — a ship's rider and a ball, say — still loses player 2's.
- **Player 2 wears the colours the other way round.** In a dual the second
  player has the same icons with its two colours swapped — its first colour is
  the player's second and its second the first — and here it was drawn
  identical to player 1. The game builds player 2 from the same two colour
  lookups in the opposite order. Its wave band and Ghost Trail are its own,
  in its own colour 1.
- **The autoplayer no longer climbs for free.** Height cost it nothing — every
  node advances in x at the same rate — and empty air meets no hazard, so the
  search filled its beam with nodes over the level instead of in it. It now
  pays for floating well above the level, and clearance stops paying once it
  is safe. The macros README records which levels this re-solved and which it
  did not.
- **The physics is the game's wherever it had been this port's guess.** An
  audit of open-source GD code, with every claim re-read in the 2.206
  decompile, found seventeen places the port played differently, and all
  seventeen are fixed; `data/ref/gd-discrepancies.md` lists them with the
  lines each comes from. The ones a player feels first: an orb is taken by the
  press, before that tick's move, and a flying mode never takes one by flying
  into it; the ship, UFO, wave and swing answer a press on its own tick
  instead of the next; a level made before 2.2's gravity fix — every classic
  official level but Dash — keeps the old upside-down falling test, and with
  it a few ticks of coyote time off a ledge; a dual's two players flip gravity
  together; and the player's position is a 32-bit float, as the game keeps
  it, so a run drifts the way the game's does. Behind those: the spider's box
  is 27, a mini player's inner box stays 9, mini flying modes get the game's
  orb and pad strengths, running off a slope launches the way the game does,
  the collision pass runs in the game's order, rotated objects meet the
  player's rotated box, the spins and ball rolls turn at the game's rates, a
  pad fires once per player, the jump latch waits for a soft landing, player
  2 spawns a tick later, a cube or robot that meets a band edge head first
  dies, and letting go ends a dash before the move. Every macro was solved
  again on the result.
- **Three more, found by that re-solve.** A spawned trigger without
  multi-trigger never fired: the once-only check ran twice, and the second saw
  the first's mark. That kept Geometrical Dominator's door shut at 85 % and
  The Tower's Ferris wheels still. A flipped player on a ceiling slope let go
  of it the tick after meeting it and started the ride over, so it left the
  far end too slowly — which is why Blast Processing's ball could never reach
  its blue orb. And a linked teleport sets the player at its partner's height,
  not at the player's own height plus the offset; the old rule dropped
  Deadlocked's player under the floor at 45 %.
- **The End trigger, trigger channels and the teleports' options.** 3600 is a
  trigger, not an end block: passed, touched or spawned, it ends the level
  where the game does, once, so the tower floors can be finished. Pass-by
  triggers queue per gameplay channel, each sorted along the way its Rotate
  Gameplay turn sends the player, and only the live channel fires — by y while
  the player is turned — so Dash's turns undo where they should; in a
  platformer the queue runs on the music clock. The teleport portals' box sits
  12 units along their own x, which is what had Deadlocked's ship land on
  spikes at 58.5 %, and every teleport honours keep-x/y, gravity and the push
  along its exit. A platformer's checkpoint objects now bring a normal run back
  too, after a death or from the pause menu's restart, and its pause menu has
  the game's second button to start over. The details are in
  `data/ref/boomlings-notes.md`, open items 1-3.
- **Start positions and the level's start keys.** An enabled start position
  starts the run in its own mode, speed, size, gravity and direction, after the
  level has been run up to it the game's way — a sixtieth of a second at a
  time along the level's clock of speed portals, turns and teleports — so its
  moves, spawns and colours stand where they would. Such a run counts as an
  attempt and nothing more. No official level has an enabled one. The header's
  spawn group, turned start and compatibility switches are read as well; the
  one the official levels meet is static rotation, so Dash's swaying pillars and
  The Tower's wheels keep their blocks level, as in the game, though the art
  still turns with them. Triggers at the very start fire before the first
  step, and the level decoder is cocos2d's, taking an uncompressed level as it
  comes. `data/ref/boomlings-notes.md` #32 and #36-#38 have the details.
- **The 1.x colours, warped art and the Custom Particles' own options.** Blast
  Processing and Theory of Everything 2 colour their decoration by the old key
  19, which is read now, and anything on the player's colours or the light
  background adds its light, as in the game: about 16,000 objects across
  levels 1-22 draw brighter on dark backgrounds. The level's copies of the
  player's colours are strengthened the game's way (the icon keeps the colours
  as chosen), and colour triggers can ask for them. The old headers' ground
  line adds too, a colour trigger that names no channel recolours channel 1,
  and 900 is the second ground. Keys 131 and 132 warp art, so The Secret
  Hollow's upside-down spikes point down. The Custom Particles fade in and out,
  slow down, face their motion, restart on their own or wait for an Animate
  trigger, and take their object's colours; the 111 one-frame bursts that drew
  nothing now show. `data/ref/boomlings-notes.md` #23-#30 have the details.
- **The trigger runtime reads what the game reads.** Force blocks and circles
  push the player, as Dash's ball and swing find on its way. A player caught
  between a floor and a ceiling in one step dies where the level asks for it
  (`kA31`, and every platformer). Item Compare and Item Edit read
  the right keys and the attempt number and level time, so the floors' end
  results are earned instead of always full; collectibles count and switch
  their groups; a Count waits for its number instead of looking once; a Pickup
  multiplies, divides or sets; groups are sorted by x before a spawn; Follow
  copies whatever moved the object it follows, so The Tower's cars ride their
  wheels; and the Event trigger hears the buttons and pickups.
  `data/ref/boomlings-notes.md` #1-#8 and #33-#35 have the details.
- **Progression and sound, the game's way.** A normal clear earns the normal
  achievement and a practice clear the practice one, where they had been
  swapped; secret coins are saved; jumps are counted as the game counts them;
  and the achievement table is read in every shape the binary writes it.
  Practice plays Stay Inside Me, a finish lets the song play on, the tower
  floors and The Challenge have their own songs and stars, and the Song, SFX
  and Edit triggers use all their settings. #9-#22 have the details.
- **The final check.** Every entry in `data/ref/boomlings-notes.md` is fixed or
  says what remains, and the re-solve that followed turned up one more: a
  trigger orb (1594) fired and did nothing to its group, which kept The
  Sewers' route shut at the top of its pad shaft. It switches the group on or
  off, or spawns it, now; the toggle block (3643) is the same thing, 30 units
  square and hidden, and works too.
- **The screen effects reach the layers they name.** The setup trigger (2904)
  picks a range of the fifteen draw layers, and only that band of the scene
  goes through the effect; what lies below and above it is drawn as it is, so
  Dash's invert at its first spider portal turns the player and nothing else.
  The band runs through the game's own shader, which the asset build takes out
  of the exe, so the effects apply in its order with its arithmetic. Every
  value eases to its target over the trigger's own duration and easing, and a
  key the level leaves out is zero, so the triggers that switch an effect off
  now do, and Disable All puts the range back as well. The player sits among
  the level's layers — the front decoration and the ground cover it — its
  landing puff and exhaust go over it, Custom Particles draw in their own
  layer, and the Screen effects switch in settings works. The distortions
  (shock waves, glitch, the blurs, bulge, pinch, pixelate, split screen) are
  timed and turn the band on but are not drawn yet.
- **The camera is the game's, and the corridor stands on the screen.** Zoom
  (1913), Static Camera (1914), Offset (1916), Camera Rotate (2015) and Camera
  Edge (2062) ease as the game's do, and the follow between them is
  `updateCamera` tick for tick: the 75-unit lead over the zoom, the axes
  swapped in rotated gameplay, the floor at y 0 and the level's top, the left
  stop at x 15, the slow stop at the level's end, the edges' soft stop, the
  static camera's smoothing, follow and hand-back, and the teleports' camera
  keys. Camera Rotate turns the view, so Dash's first spider section tilts a
  few degrees either way, as it does in the game. The background and the
  middleground move by the camera's own step, and the MG trigger (2999) eases
  the middleground up. The flying corridor is the game's too, and this part is
  physics: its two ground layers stand on the screen and slide in from its
  edges, so the band the player is held in is the corridor's height over the
  zoom, about the camera while a Static Camera trigger holds it. Dash's first
  spider runs in 16.5–313.5 under its 0.909 zoom, not 0–270. Because the band
  now depends on the camera, the camera triggers run in the headless sim as
  well. The flat level top a classic level dies above is the game's 2,790,
  not 2,688 (`updateMaxGameplayY`). Every saved macro still finishes,
  checkpoint for checkpoint; Dash's best attempt does not (under "Macros").
- **Each object draws the way the game sets it up.** `GameObject::customSetup`
  and its neighbours were traced for every id
  (`tools/ref-trace-ida-customsetup.py`, into
  `data/ref/customSetup_render_flags_2206.json`), and the draw list reads what
  they set. An object hidden in play — key 135, or one of the editor-only
  blocks — draws nothing, which is what Dash's outlined grey blocks and big
  grey spikes were. Invisible blocks fade by their distance from the middle of
  the screen and show once the player dies; the orbs', saws' and blades' glows
  take the background, and the pads' and orbs' glows keep the colour they were
  given; keys 64 and 67 keep an object out of the fade and the enter effect;
  each object takes its enter effect from its own channel (key 343) as it
  starts to come in; turning objects turn at their own speed, with a random
  sign; a group's pulse comes before the object's own hue shift; and the 183
  objects that draw their frame through a copy draw it once. Frame animations
  come from the game's own table (`GameManager::setupGameAnimations`, now
  `src/assets/gameAnimations.ts`), at the speed the object's keys give and
  held for an Animate trigger where they ask. Every portal gets its back half,
  under the player, and a linked teleport its exit; the particle systems the
  game hangs on objects — the portals' swirls, the orbs' rings, the pads'
  bumps, the speed portals' streaks, the fireballs' trails, the collectibles'
  sparkle — are emitted (`tools/ref-trace-ida-particles.py`); the beasts'
  detail limbs take the detail colour; and the pixel art's edge strips draw
  over the tiles they edge.
- **The Gradient trigger is drawn.** Each layer (key 209) takes its sides
  from the main objects of keys 203-206, or its corners with key 207, and the
  view's edges for any it leaves out; its colour runs along the trigger's own
  turn from key 21's channel to key 22's, normal or additive, over everything
  else in its key-202 draw layer, and keys 208 and 508 take layers away.
  `render/gradients.ts` draws it as strips fine enough not to band.
- **A layer draws in the game's batches, not by z order alone.**
  `GJBaseGameLayer::setupLayers` gives each of the nine z layers a batch per
  sheet and per blend mode, a glow batch and a particle container, at fixed z
  values, and key 25 orders a sprite only among the sprites of its own batch.
  `render/batchNodes.ts` is the transcription — the node z values,
  `getParentMode`'s id table and `parentForZLayer`'s routing, each checked
  against the 2.2074 exe — and the draw list sorts by it. So a GJ_GameSheet
  sprite draws over pixel art in the same layer whatever their z orders, which
  is Dash's fireball over its skull at 4 %; every glow sits under the rest of
  its layer; a blending main half over a colour half that does not goes up a
  layer; a colour trigger that turns a channel's blending on moves its objects
  to the additive batch as it happens, from slots baked at load rather than by
  sorting again; and the levels made before 2.0's layers (1-20 and The
  Challenge) draw their text and fire in B1, as the game does for them.
  Particle systems draw among the batches: a Custom Particles object's in its
  layer's container at its z order, an object's own at the z its type gives
  it, which is over all of B1 and under all of T1. The order changed in every
  level from Time Machine on, mostly glows dropping under their layer; levels
  1-7 draw as before.
- **Particles follow their object's opacity.** An object's own system stops
  emitting once the object is shown at 50 of 255 or less — faded at the
  screen's edge, by its enter effect, or by its colour's or its groups'
  opacity — and starts again above that; the particles already out finish as
  they are (`GameObject::updateParticleOpacity`). So Dash's first spider
  portal, which an Alpha trigger fades out, stops sparkling. A Custom
  Particles object is never stopped by its opacity: it dims every particle it
  has out instead, and with key 146 it is the alpha new ones start at.
- **Additive art adds as much as the game's does.** The game's additive
  batches blend with SRC_ALPHA / ONE, on premultiplied art whose colour cocos
  has already multiplied by the sprite's opacity, so the art's alpha and the
  opacity each count twice; here they counted once. A soft or part-faded
  blending sprite now adds a good deal less, and Dash's rotating rays round
  its first cube portal, which had drawn far too bright, match the game. Particles add the way `updateQuadWithParticle` hands them over, which
  the blend the system was made with decides. The same work found every
  channel opacity under 1 applied twice — 0.5 drew at 0.25 — and an object now
  wears it once, rounded to the byte the game keeps, as its particle system
  does. The background and ground always cover, as in the game; the floor
  line and the middleground add only while their channels blend.
- **Black art stays black, and only it.** The game makes some objects' own
  sprite black as it builds them and keeps it out of every recolouring after
  (+541): the pits, the old fake spikes, the sawblades, the black outlines
  and fills, 80 kinds in all. Their main colour — 1004, or key 21's — still
  decides how opaque they are, whether they add, and the colour of their glow
  and of what hangs on them; here all of that came from 1010, which no level
  sets. The object table had also let the fan table's black flag override
  the game's own table, blacking out objects that are only black by default
  (the beasts, the sludge and the fake spikes 1889-1892, whose main colour
  starts at 1010 and which key 21 recolours) and some that are not black at
  all (the slope outline 309, the cogwheels 675-677, the block edge 1363);
  it takes the game's word now. The pulsing balls (50-54, 60, 148, 149, 405)
  lost a sprite the game never makes: the fan table hung the rod's ball, or
  the ball's own frame, behind each one, drawn in white.
- **The streak and the wave's band blend as the game's do.** Every level
  starts with the streak additive, and only the Options trigger's key 159
  makes it normal; here it was normal from the start. The streak adds or
  covers as a CCMotionStreak does, its art's alpha counting twice, and the
  wave's band adds its flat colour with the game's white core over it, a
  third as wide. Interface art fades once: its tint was dimmed by its opacity
  and then again by the shader, so a fade went dark before it went clear. An
  additive interface sprite adds as the game's ground line does.
- **Pausing freezes the level.** The colours, pulses, screen effects, shake
  and particles kept running under the pause menu, in the game and in both
  debug pages. The game stops the whole level layer when it pauses
  (`PlayLayer::pauseGame`), and the port does too now, settings opened from
  the pause menu included; the end screen still lets the level run on, as the
  game's does. Two paused frames taken seconds apart are identical, so a
  paused debug run is a fair screenshot.
- **The Ghost Trail and the wave's band are the game's.** The Enable and
  Disable Ghost Trail triggers (32, 33) drew a streak here. The game draws
  copies of the icon instead, one every 0.05 s, each fading from 200 to
  nothing over 0.4 s as it shrinks to 0.6 of its size, added in the player's
  strengthened colour 1, or laid over in black when colour 1 is black
  (`GhostTrailEffect`). Twelve official levels use them, Dash among them. The
  wave's band had been a ribbon 0.45 s long; it now keeps a point only where
  the wave turns and lasts until it is off the left of the screen, built
  corner for corner as `HardStreak::updateStroke` builds it, so a bend closes
  on its outside. It is 6 units times the player's size times the music
  pulse, so a mini wave's is 0.6 as wide, and it fades over 0.2 s when the
  wave stops or dies. A black colour 1 gives a solid black band with no core,
  as the game's does, until an Options trigger turns the streak blend off and
  on again. Player 2 has a band of its own.

### Landed so far in goal 5

- **The player starts on the ground.** `PLAYER_START_Y` was the game's own 105,
  which is measured from a ground plane at 90; this port's floor is 0, so the
  cube fell 90 units — 60 ticks and 79 units of level — at the start of every
  classic level. It is now 15 and rests from tick 0.
- **Portal transitions carry the right velocity and angle.** The `× 0.5` is not
  a portal rule: `flipGravity` owns one, and the four *flying* mode toggles
  (ship, UFO, wave, swing) own another each, on both edges of the toggle. So
  wave → ship is `× 0.25` and leaves at 0°, where this port used to keep the
  wave's speed and its 45°. `test/portals.test.ts` pins the whole table against
  the decompile rather than against what the code happens to do.
- **Audio ships.** 34 tracks, 291 effects and 9 songs, 143 MiB total with
  107 MiB of headroom before the catalog warns. `src/audio/` plays a level's
  track at its own offset and its audio triggers with their own keys: numbered
  music channels, songs prepared and played later, Edit Song and Edit SFX,
  SFX groups, the minimum interval and unique sounds, proximity volume, and
  key 405's pitch shift (worked out when the level loads). A checkpoint puts
  each song back where it would be on the music clock and the sounds that were
  playing back where they were; a start position plays what its warm-up left
  running. The time warp changes the game's clock, never the music. Practice
  plays Stay Inside Me and none of the level's own audio, and a finish lets the
  song play on.
- **`strings.json`** — the loading tips, song titles and credits, and every
  official level's song, difficulty and star count, read out of the decompile by
  the new `strings` build step. Goal 2 specified this and never built it.
- **The Challenge and the Tower floors** have `LevelTools::getLevel` branches
  of their own, opened with the level's name rather than a song title. The
  Challenge plays track 26 (DJRubRub.mp3) and awards 3 stars; the floors play
  music-library songs by id — IDA prints those as strings, so the four ids come
  from the exe — and award 25 stars between them.
- **Fonts narrowed to what the levels ask for.** Measured: 23 levels use bigFont
  and the four Tower floors use gjFont19. `--fonts=all` still exists for custom
  levels; it is 20 MiB of art the official set never reads.
- **The interface.** `src/ui/` is a screen stack over the same `SpriteBatch` the
  level uses, sharing the 480x320 design box with the camera so the two can
  never disagree about where the edge of the screen is. Text is laid out from
  the game's own `.fnt` data, window frames are nine-sliced, and the loose
  interface PNGs are packed onto one page so the whole menu costs one texture
  unit. Everything that can be decided without a browser — wrapping, kerning,
  hit-testing, the nine-slice tiling — is unit-tested.
- **The menus are the game's menus.** Every screen is laid out from the
  game's own code rather than from a sketch of it: the main menu from
  `MenuLayer::init` (the logo 50 under the top, the three buttons 10 above the
  centre and 110 apart, the round row 45 off the bottom, the social icons 22
  in from the left, the sky cycling the game's eight colours over a ground
  that scrolls at the cube's own speed with a cube running on it), the level
  select from `LevelSelectLayer` and `LevelPage` (one page per level swiped
  or paged through, the 340 by 95 panel 60 above the centre, the bars 30 and
  80 below, the sky the game's colour for that page), the icon kit from
  `GJGarageLayer::init` (the icon standing on its line 50 above the centre,
  the tab row, twelve by three in the grid, the paint pot swapping the grid
  for the colours), the creator page from `CreatorLayer::init` (fifteen tiles
  90 apart, the two the game greys out greyed here), the pause menu, the end
  screen with the game's own table of phrases, and the death screen. In the
  level: the faint pause button 15 in from the corner; the bar 8 under the
  top with its fill 2 in and 4 up, and the percentage 110 right of the centre
  beside it or centred without it — both off on a fresh save, as in the game,
  and neither ever in a platformer; and this visit's attempt count standing
  in the level itself 85 above the camera's centre (50 right of it after the
  first attempt), scrolling away with the blocks. Buttons swell by the
  game's 1.26 while held. Three faces are on screen at once and there are two
  font units, so chatFont's glyph page is packed onto the interface page and
  read from there; the logo is cut out of the launch sheet the same way
  rather than shipping the sheet. Two things the game's own layout does not
  settle are measured off screenshots and tagged so: the kit's grid and tab
  spacing, and the practice buttons' place. Not here: the shop, the shards,
  the name field, the vaults and everything behind the creator tiles, each of
  which says so in a line when tapped.
- **The robot's held jump stays with the jump it belongs to.** Holding the
  button after a mid-air orb used to cancel the robot's gravity for another
  quarter of a second, so a yellow orb threw it 6.9 blocks up instead of 1.9 and
  a red one 11 instead of 3.8. The hold is the property of a jump *off the
  ground*: letting go ends it, a pad ends it, entering robot mode starts it
  spent, and only the next ground jump hands it back. An orb does none of those,
  which is why holding through one buys no height. The robot's own jump is
  untouched — a tap is still a hop and a full hold still clears 3.4 blocks.
  Nothing outside robot mode reads either flag, so no other mode moved.
- **One texture unit is scratch, and everything else stays off it.** Menu text
  used to come out as black boxes, or as a background image's pixels shaped like
  letters, and only sometimes. `uploadTexture` binds in order to upload, and a
  bind lands on whichever unit happens to be *active* — so every upload took
  over whatever the last caller had left active and emptied it on the way out.
  The interface, which left a font unit active and cached its bindings across
  frames, never repaired them. Now every upload goes through unit 15, which is
  declared scratch and shared with the post-processing pass; the interface binds
  its page and both font pages at the top of every frame and keeps no cache;
  font pages get a fixed unit each at load rather than taking turns; and
  `bindSheets` stops before the icon pages instead of walking the whole budget.
- **The enter effects are the game's.** They were being played against a
  guessed 140-unit band with a guessed 60-unit slide and no fade on the scale
  effects. `PlayLayer::applyEnterEffect` settles all of it: a 70-unit band
  inside the screen edge, measured by distance rather than time; a 100-unit
  slide; big-to-small from 1.75; a fade on every effect but "none", measured
  from the object's position less half its width beyond one block (+704,
  which is its centre up to a block wide); the same effect played back to
  front on the way off the left; and — the part that changes every classic
  level — a default of *fade and nothing else* when no trigger is in force,
  which is why blocks fade in at the right edge of Stereo Madness in the game
  and used to pop in here. `render/enterEffects.ts` carries the id table and
  the arithmetic.
- **The icon kit.** Every icon of every kind in a grid, the game's own 107
  colours in two rows, the glow switch, and the choice drawn large the way the
  level draws it — off the same two texture units the level binds the player's
  pages to. That sharing was meant to stop a menu leaving the level drawing off
  the wrong page, and on its own it did the opposite; see "The player no
  longer vanishes" under goal 6. The level takes the choice and the colours
  from the save on every attempt.
- **What is unlocked.** The free set from the binary (cubes 1–4, the first of
  everything else, four colours) and the 276 achievement rewards read out of
  `getAchievementRewardDict`, with thresholds from `checkAchievement` in every
  shape it writes them (hex cases, whole reports, shared tails) and the
  per-level ids from `reportPercentageForLevel` and `checkCoinAchievement`.
  What this port can count — stars, secret coins, demons, jumps as the game
  counts them (ground jumps and orbs), attempts, each level's best in either
  mode (`levelNNb` is the normal clear, `levelNNa` the practice one), its
  coins, and a normal-mode crash at 95–99 % — decides those; the rest are
  shown as earned in a part of the game that is not here, rather than as
  locked behind a number or given away. Secret coins are saved by their own
  number from a completion outside practice. The achievements' own titles are
  in neither reading of the binary, so they are described by what they are.
- **Practice checkpoints.** The game's own two buttons (and its Z and X), a
  checkpoint laid down by itself after two seconds on the ground — that
  interval is this port's, the game queues one from its checkpoint object —
  and death in practice comes back to the last one with the simulation, the
  camera and the ribbon rewound together, off the same snapshot the autoplayer
  uses, while the practice track plays on.
- **An additive sprite in a menu adds again.** The interface batch wrote zero
  alpha for one, meaning to zero the output alpha; the shader multiplies the
  colour by that alpha first, so the sprite was drawn and invisible. The
  alpha stays and the additive flag does the zeroing, which is what the menu's
  ground line needed.
- **Lists are clipped.** A list's rows go out under a scissor in a draw call
  of their own, so a row half off the end of its window stops at the window
  instead of drawing over what is under it.
- **Saved progress.** One key in the store the catalog persists per account, so
  a plain write is the save. Every field is merged against the defaults on load,
  so a truncated or mistyped save loses one field rather than everything, and
  the host's reset button is answered properly.

### The renderer's long tail

Six things the level had data for and no reader. All of them were already being
built and shipped; none of them needed a new texture unit, which is the
constraint that shapes the rest of this section.

- **Frame animations.** 26 object ids animate, 2,068 placements in the official
  levels. The table says an object animates and names the frames but not which
  of its sprites plays them, and the answer differs by object — so `anim.ts`
  works it out from the names, in three cases, each checked against the built
  atlas. The third is an inference and is written up where it lives.
- **Skeletal beasts.** The six `ent` ids, 1,006 placements — Fingerdash alone
  places 588. They are limbs moved by a per-frame transform, like the robot and
  the spider, except their textures are ordinary atlas frames. A limb is one
  sprite whose transform and frame both come from the animation, which is the
  same mechanism a frame animation uses, so both go through one path: every
  frame is baked at load and playing one is a ten-float copy.
- **Text objects.** 140 placements. The string is url-safe base64 in property
  31; layout is the interface's, not a second copy of it, and the face is the
  interface's upload on the interface's unit — the level and the menus want the
  same face, and a second copy would cost a unit.
- **A random frame on spawn.** `rnd` had zero consumers and 3,845 placements —
  every decorative spike in the game. It picks by position in the level string
  rather than by a die, so a level looks the same on every attempt and a saved
  macro's screenshots still mean something.
- **The ground line.** The bright line along the top of the ground, and its
  mirror under a flying corridor's ceiling. `kA17` picks it, the game clamps
  that into 1..3 before using it — so every level has one, including the twenty
  that leave the key at zero — and it follows colour channel 1002, which
  nothing was reading.
- **The middleground**, which did need a unit and got one without taking any:
  its two images take turns on the scratch unit, one pass each. Only Dash asks
  for one (`kA25`).
- **What the player leaves behind.** A cube has no ribbon — what follows it is
  `dragEffect`, thirty small additive squares off its feet, with `landEffect`
  when it touches down, `shipDragEffect` for the ship's exhaust and
  `dashEffect` for a dash. All four are cocos plists out of the install that
  the asset build has been shipping all along with nothing reading them; they
  are written in the plist's field names rather than the level string's, so
  they are converted to the one definition the emitter runs. The settings
  screen's Particles switch turns them off, which it previously did nothing
  with. The ribbon in `trail.ts` is the game's CCMotionStreak, kept for when
  the port lays it as `activateStreak` does; the wave's band and the Ghost
  Trail are other things (`hardStreak.ts`, `ghostTrail.ts`).

Found while doing it: the per-frame gather emitted a sprite twice when it was
wide enough to sit in two of the visible columns — invisible on an opaque
sprite, brighter than it should be on a translucent one; and an emitter that
was switched off left its live particles hanging in the air instead of letting
them finish, because stepping it with no time on the clock stops them ageing
as well as stopping the emitting.

### Known wrong, and why it is not fixed yet

**Most of the distortion effects are not drawn.** Shock Wave (2905), Shock
Line (2907), Glitch (2909), Chromatic Glitch (2911), Radial Blur (2914) and
Bulge (2916) — 25 placements across Dash and the tower floors — and the four
the official levels never place are timed, eased and layered as the game's,
and turn their band on, but the shader runs with the distortion at its off
value. Lens Circle (2913) is drawn, though its centre does not turn with the
view. `npm run triggers` counts all eleven as partial.

**Two of the gradient's blends are not drawn.** Blends 2 and 3 (key 174)
multiply by and invert what is under the layer, which needs a blend state the
sprite batch does not have, so such a layer draws nothing. A layer on a
screen-space draw layer (BG, MG, G, UI, Max) also turns with the view, where
the game's stays upright.

**Frame animations the table does not cover.** The per-id frame choices of
1697-1699 and the extra drops of 1855 and 1858 play the plain cycle, the
special animations of 1839-1842, 2892 and 2893 hold their resting frame, and
an Animate trigger cannot yet switch a beast to a named clip. The platformer
camera's own dead zone is not built either (Camera Mode, 2925).

**Dash's ship tunnel at x 17745-18975.** The best run on the old band entered
ship mode through a teleport onto the portal at (15765, 555), took the 390-690
band from it, and died on the tunnel's floor pressed against that band's
ceiling. The
tunnel opens from about 416-614 at one end to 718-894 at the other, which no
fixed band holds. Of the two leads, the band's source under a Static Camera is
now the game's (above); the other, the two Area Move triggers on the tunnel's
walls, turned out not to touch anything the player can reach: they centre on
player 1 with a 90-unit dead zone. Dash is solved now (see "Macros"), and
the area triggers are built (`src/triggers/area.ts`): Area Move, Rotate and
Scale run every step with the game's falloff, easing and variance, Edit Area
tweens them and Area Stop ends them. Fade and Tint are not built yet.

**Dash at 4 %: what the side-by-side still shows.** With the batches, the
particles' opacity, the additive blend and the pause fixed, the frame matches
the screenshot of the real game but for these:

- The middleground stands about 60 units too high. Its base height
  (`MIDDLEGROUND_BASE_Y` in `render/scenery.ts`) is a guess: the game takes
  it from a table (`GJMGLayer::defaultYOffsetForBG2`, IDA:382677-382686)
  whose values are in the exe, not the decompile. The rest of the placement
  is the game's (`updateCameraBGArt`), and every level with a middleground has
  the same error.
- There are no circle waves. `CCCircleWave`, the thin ring that grows and
  fades — the spider's dash makes three, and the orbs, pads, portals and
  pickups about forty more — is not built.
- The spider portal's last particles linger. Once the Alpha trigger stops its
  system, the sixteen or so already out live out their lives here, where the
  real screenshot shows none half a second later. The port does what
  `updateParticleOpacity` says — stop, and leave the rest — so the cause is
  elsewhere. Leads: `GJBaseGameLayer::updateParticles` (IDA:456986ff), which
  pools systems; `GameObject::setVisible` (IDA:164660-164700), which hides a
  system's node outright; and whether a particle's life here means what
  cocos's `timeToLive` does. The port also stops the system about 0.1 s
  sooner than a straight fade through 50 would.
- The rest is the run rather than the port: a smoke puff (2042) rolls a random
  speed, so a different frame of it covers the fireball; the rock pile's
  pulse comes from a touch trigger the screenshot's run never set off; and the
  icon and its colours are the port's defaults.

**Batches and particles: what is left.** Inside one batch, sprites with the
same z order go in the level string's order; the game's is the order they
last joined the batch, as they came on screen. An object's own system is
reset the moment its object leaves the screen, where the game lets the
particles out finish; keys 507 and 116 (no particles, no effects) are not read
for those systems; and while a shader layer's range is 2-7 the game adds them
to its other object layer (`claimParticle`, IDA:431679-431681), which is not
done here. A B1 gradient with z order 1 or more sits over the player's own
particles in the game and under them here. The streak, the CCMotionStreak
ribbon, never comes on here; the game's comes on for pads, orbs, dashes, the
ship, the UFO, the swing and the wave, under its band, and goes off on
landing (the callers of `PlayerObject::activateStreak` and
`deactivateStreak`). The wave's band pulses with the music in the game
(`PlayerObject::update`, IDA:161151-161153); the port has no metering and
holds it at the resting value, 1.24 times its width. The band's last
segment, which the game draws as a general four-cornered polygon, is drawn
as the nearest parallelogram, a sliver different under the player. A Ghost
Trail turned on before a dual starts gives player 2 none in the game
(`PlayLayer::toggleGhostEffect`, IDA:92269-92276) and one here. The rods (15-17)
draw their ball from the fan table's child, where the game makes it an object
of its own (37) in `PlayLayer::addObject` (IDA:90320-90345).

**What the boomlings notes leave open.** A moving solid collides as a static
block where it now stands, so a squeeze under one is approximate: the game's
moving-object branch of the collision is one long function that waits for a
port of the whole. The Touch trigger (1595), Advanced Follow (3016), the area
triggers (3006-3015) and the physics half of the time warp are not built,
which is why Dash's 0.2 warp at x 4535 plays at full speed; `npm run triggers`
counts these. The Event trigger hears the buttons and pickups but not the
landings, orbs and pads the tower floors also listen for. Ice and the slope
and boost slides still use a measured ramp. `data/ref/boomlings-notes.md`
lists the rest under its status.

### Macros

18 of the 19 saved macros survived goal 5's physics changes — 13 broke and 12
were re-solved. Clubstep's was retired: see `test/macros/README.md` for why, and
for the check that shows its 40.1 % wall is the autoplayer's ranking rather than
the new physics.

The corridor change in goal 6 broke three of the 18 — Theory of Everything,
Hexagon Force and Blast Processing, which is to say the three whose bands moved.
All three were re-solved. Blast Processing needed a wider beam than the usual
`--W=1024`, the same ranking limit the ball sections always hit; its band never
changed, and the geometry either side of the spike it kept dying on confirms
the 0–240 it has.

Then the ceiling went in, and eight macros turned out to have finished their
levels by flying over them. Six re-solved honestly — xStep, Clutterfunk,
Theory of Everything, Electroman Adventures, Theory of Everything 2 and The
Challenge. Fingerdash reached 57.7 % before its time ran out and was retired
with its best attempt kept; Dash never had an honest one.

The accuracy pass broke every macro, as expected, and all of them were solved
again from nothing. 21 of the 27 official levels now have one that finishes —
Stereo Madness to Geometrical Dominator, Fingerdash and The Challenge — and
all but two came from the solver's default search. Blast Processing needed
`--D=2`, the only setting that kept enough wave nodes alive past its late
portals, and its run stays a wave around the UFO, ship and ball section
rather than going through it. Fingerdash needed longer than the default 90
seconds and nothing else. Clubstep is solved for the first time: its only
earlier run was older inputs re-stamped, because the solver had never got
past 40 %.

Six had no macro then. Geometrical Dominator died on the spawn bug fixed after
the re-solve; solved again, it finishes for the first time (`--W=512`, 21
minutes). Goal 6's trigger, audio and save fixes came next. On 2026-09-29
twenty macros still finished and were re-stamped; Fingerdash's had gone stale
and was solved again in about 450 s; and Deadlocked, with its teleport portals'
box fixed, finishes for the first time (19 minutes, no dead end). 22 of the 27
official levels now have a macro that finishes, and every one replays on
`npm test`.

Five do not. Dash reached 75.4 %: the autoplayer's clearance score looks ahead
in x even while gameplay is turned, so it threw away the only nodes walking up
a wall, until a longer danger lookahead (`--N=101`) let a walker that survives
it outrank them. That run died in the ship tunnel under "Known wrong". It was
solved against the old corridor band, and once the band moved onto the screen
it replayed only to 4.5 %: its spider walked a pit floor at x 1080 that the
new band lifts into the pit's hidden spike. Dash has since been solved again
on the new band. The saved best attempt gets past the pit — it is what the
debug page's `&macro=best` now plays to the 4 % screenshot's moment by itself
— and reaches 67.7 %, where it dies on block #10655 (16305, 675) in the
rotated climb, short of the tunnel. The tower floors fail on the autoplayer's
platformer guide, which aims at the End trigger rather than the spawn that
fires it and counts one-way blocks and switched doors as walls. The Tower and
The Secret Hollow finish from a point on their routes, and The Sewers' way on
needed the trigger orb fixed in the final check, so none of the four is
known to be stopped by the port. `test/macros/README.md` has each level.

Checked before goal 5 started, so it did not start by discovering them:

- every saved macro replays to 100% **in the browser**, not just headless
- the production build runs from a plain static server, so the asset paths that
  ship are the ones that were tested
- `npm run assets -- --verify` is clean
- frames interpolate between simulation ticks, so the view does not judder on a
  display whose refresh rate is not a multiple of 240

`npm run assets` needs `canvas` (a dev dependency) for the icon pages; without
it every other category still builds and the icon step reports itself as
skipped.
