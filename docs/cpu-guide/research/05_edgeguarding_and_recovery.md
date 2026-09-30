# Edgeguarding and recovery in Smash Ultimate: techniques, frame data and decision procedures

## Conventions

- Scope: Super Smash Bros. Ultimate unless a line names another game. There is no official specification. Numbers come from SmashWiki (SSBWiki) wikitext read through the MediaWiki raw endpoint, ultimateframedata.com pages, KuroganeHammer's Smash 4 formula page, and community analysis pages. `unverified:` marks anything I could not read on a fetched page or that sources disagree on.
- "Fetched" in the Sources list means the page body was read. "Snippet" means only a search result title or excerpt was seen. Two YouTube analysis videos could not be fetched (HTTP 429 from the fetch proxy), and a YouTube transcript tool was blocked by a bot check, so no video content is used as evidence.
- `probe:` marks a measurement I ran on a local, read-only copy of the Aevalrena sim (`stepGame` driven from a scratch script, nothing in the repo changed). `Aevalrena:` marks how a finding maps onto the game. Code facts cite the repo (https://github.com/aevalmere/aevalrena) and the file.
- The repo's current stage geometry differs from the numbers in the task brief. `src/stages/hearthmoor/geometry.ts` has the main platform at x -298..298, top y = 0, blast rect x -578..598, y -394..358. `src/stages/tidegate/geometry.ts` has x -248..248 and blast y -447..305 (https://github.com/aevalmere/aevalrena). This report uses depth below the ledge top and offset beyond the corner, so it does not depend on the stage. y grows downward in the sim.
- Symbols: `a` airtime frames (cap 300), `p` percent (cap 120), `dx` px beyond the platform corner, `depth` px of the feet below the platform top, `N` the frame a fighter grabs the ledge.

## 1. Ultimate ledge mechanics

### 1.1 Grab conditions

- A fighter in the air grabs a nearby ledge automatically unless down is held on the stick. A ledge behind the fighter can be grabbed with 40% less range than one in front. Only one fighter can hold a ledge, except the two Ice Climbers of one player (https://www.ssbwiki.com/Edge).
- Every character has two ledge boxes, one in front and one behind, placed toward the head. The same boxes work during a second jump, a tether, or a plain fall. Some special moves disable one or both boxes (https://www.ssbwiki.com/Edge). Cloud's Climhazzard cannot snap to the ledge (https://www.ssbwiki.com/Cloud_(SSBU)). SSBWiki states that Ultimate toned down ledge sweetspots compared with earlier games, which makes edgeguarding easier (https://www.ssbwiki.com/Edgeguarding).
- Tumbling fighters and helpless fighters can still grab a ledge (https://www.ssbwiki.com/Tumbling, https://www.ssbwiki.com/Helpless).
- Smash 4 blocks ledge grabs for 55 frames after being hit (https://www.ssbwiki.com/Edge). The Ultimate value is not on that page. The Lucario page reports a 45-frame regrab lockout after hang time runs out and the fighter falls (https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups). `unverified:` whether Ultimate has any lockout after ordinary hitstun.
- Grabbing a ledge restores all midair jumps. Hitstun does not restore them, which is why a recoverer who already used their jumps is so vulnerable (https://www.ssbwiki.com/Double_jump). Air dodge is limited to one use until the fighter lands, is hit, or grabs a ledge (https://www.ssbwiki.com/Air_dodge).
- A fighter can grab the ledge at most six times without landing or taking hitstun. Attempts after the sixth show the particle effect and do not snap, which is close to a guaranteed self-destruct. Hitstun resets the count. Tether recoveries still grant hang intangibility on regrabs but reduce getup intangibility. Lucario's Extreme Speed ignores the cap (https://www.ssbwiki.com/Edge).
- A directional air dodge can grab a ledge after its first 24 frames. Most characters are vulnerable for only 3 frames if they grab at the earliest moment, not counting the 2-frame window (https://www.ssbwiki.com/Air_dodge). That page carries a cleanup note saying some of its per-character numbers look inaccurate.

Aevalrena: the grab test is in `tryLedgeGrab` (https://github.com/aevalmere/aevalrena, src/sim/ledge.ts). The fighter must be airborne, `vy > 0`, not in hitstun, not in ledge cooldown (12 frames after a drop or ledge jump), not in `attack`, `hitstun`, `tumble` or `footstooled`, and the ledge must be free. The `ledgeGrabBox` (Aeval: w 20, h 24, yOff -30) is tested against a region hanging off the corner: outward by the box width, from 4 px above the corner to `box.h + 20` px below it. The fighter must also face the stage, move toward it, or hold toward it. probe: from a resting start with `vy = 1`, a grab happens when the feet start within x in [corner - 2, corner + 30] and depth in [1, 72]. Facing away with no input never grabs. Facing away while holding toward the stage grabs. A rising fighter never grabs. There is no smaller rear range.

### 1.2 Hang intangibility

- SSBWiki gives one formula for Smash 4 and Ultimate: `frames = 60 * (a / 300) + (44 - p / 120 * 44)`, plus the 19-frame grab animation, minimum 23 and maximum 123 before the animation (https://www.ssbwiki.com/Edge). Low airtime and low percent gives 63 frames. High percent with high airtime gives up to 79. High percent with low airtime gives 23. Low percent with 5 seconds of airtime gives up to 123.
- KuroganeHammer's Smash 4 page writes `floor(0.2 a + 64 - 44 p / 120)` with a 24 to 124 range (https://kuroganehammer.com/Smash4/Formulas). The one-frame offset between the two is an animation counting convention. `unverified:` that Ultimate uses exactly the Smash 4 constants.
- Letting go of the ledge ends the intangibility at once in Smash 64, Smash 4 and Ultimate. A ledge option's own intangibility replaces the ledge intangibility instead of stacking with it (https://www.ssbwiki.com/Edge).
- Regrab decay in Ultimate: a regrab without landing or hitstun grants no hang intangibility. Getup option intangibility (neutral, jump, attack, roll) is multiplied by 0.8 after the first regrab, 0.5 after the second, and is gone from the third regrab, meaning the fourth grab. The multipliers reset when the fighter is grounded (https://www.ssbwiki.com/Edge). The Planking page states the same "gone after the fourth grab" result (https://www.ssbwiki.com/Planking).
- The grab animation lasts 19 frames, so no option or drop is possible before frame 20. Repeated grabs slow the animation: 1x, 1x, 0.9375x, 0.875x, 0.8125x, 0.75x for grabs 1 to 6 (https://www.ssbwiki.com/Edge). Dividing 19 by the speed (derived) gives about 20, 22, 23 and 25 frames for grabs 3 to 6.

### 1.3 Hang time

SSBWiki lists 6.5 seconds for Smash 4 and Ultimate at any percent (https://www.ssbwiki.com/Edge), which is 390 frames. The Lucario page counts 379 frames of hanging including the 19-frame grab, then a panic animation at frame 380 followed by a tumble (https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups). The two pages disagree by about ten frames. For planning, treat hang time as roughly 380 frames and irrelevant to edgeguard timing, since no realistic trap lasts that long.

Aevalrena: a hang never times out (https://github.com/aevalmere/aevalrena, docs/SPEC.md section 4.5). The hanger's limit is invulnerability, not time.

### 1.4 Ledge options

- Input priority in Ultimate is jump, then attack, then roll, then climb, then drop. Jump is any of the jump buttons, stick up-left, up or up-right, or C-stick up. Attack is any attack, special or grab button, or a smash-stick C-stick direction. Roll is shield. Climb is stick toward the stage. Drop is stick down or away, and holding down for 2 frames or more fast falls after the drop (https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups).
- Options do not change with percent in Smash 4 and Ultimate (https://www.ssbwiki.com/Edge_getup).
- Lucario, first grab: neutral getup intangible 1-33 and interruptible at frame 35 of 40. Roll intangible 1-26 of 45 frames, actionable on 46, so 19 vulnerable frames. Jump intangible 1-12, interruptible at 15 (animation 43). Second grab: 27, 21, 10. Third grab: 16, 13, 6. Dropping carries no intangibility (https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups). These match the 0.8 and 0.5 multipliers within rounding, so they generalise as ratios.
- Ledge attacks in Ultimate are intangible until the hitboxes finish, unlike earlier games (https://www.ssbwiki.com/Edge_attack). Examples, first grab: Fox intangible 1-21, hitbox 19-21, interruptible 56, animation 67. Marth 1-25, hitbox 23-25, interruptible 56. Cloud 1-22, hitbox 20-22, interruptible 56. Lucario 1-20, hitbox 18-20, interruptible 56, animation 60 (https://www.ssbwiki.com/Fox_(SSBU)/Edge_attack, https://www.ssbwiki.com/Marth_(SSBU)/Edge_attack, https://www.ssbwiki.com/Cloud_(SSBU)/Edge_attack, https://www.ssbwiki.com/Lucario_(SSBU)/Edge_attack). The hitbox is 3 frames long and leaves about 31 to 35 frames of vulnerable ending lag (derived), which is why players treat the ledge attack as a surprise option and not a safe one (https://www.ssbwiki.com/Edge_attack).
- Fastest safe option summary (derived from the numbers above): neutral getup has the longest cover and one vulnerable frame, jump has the shortest cover but is actionable at once, roll covers the first 26 frames and then leaves 19 frames of lag, attack covers through its hitbox and then lags.

Aevalrena (https://github.com/aevalmere/aevalrena, src/sim/ledge.ts, plus probe). Options work from the first hang frame, with no 19-frame lockout. Option invulnerability never shortens leftover hang invulnerability (`f.invuln` is only raised to 2 per frame inside a window), so an option chosen at hang frame `h` is covered until `max(40 - h, option window)`. With the hang invulnerability already spent, probe results per option:

| Option | Length | Invulnerable frames after input | Lands / moves | Note |
|---|---|---|---|---|
| climb (up or toward stage) | 30 | 0-28 (1 vulnerable frame, index 29) | 14 px inside | actionable at 30 |
| attack (`ledgeatk`) | 40 | 0-22 | teleports 14 px inside at frame 0 | hitbox 18-24 per SPEC, so frames 23-24 are active and vulnerable, then lag to 40 |
| roll (Dodge button) | 24 | 0-23, whole roll | appears 34 px inside on frame 24 | no vulnerable frame, actionable immediately |
| jump | 0 | 12 from leaving | 13 px inside, 15 px above the hang point | actionable on the next frame, 1 midair jump left |
| drop (down or away) | 0 | none beyond leftover hang invulnerability | falls; regrab blocked for 12 frames | regrab refreshes 40 frames on grabs 2 and 3 |

The roll is the strongest option in the sim, since the trapper gets no vulnerable frame and no lag to punish. The ledge attack is the only option whose active hitbox frames are vulnerable, which Ultimate avoids.

### 1.5 Ledge trump

- Grabbing a ledge that another fighter holds removes that fighter from the ledge gently and takes the ledge. The removed fighter cannot act for a moment. This replaced edge-hogging in Smash 4 and Ultimate (https://www.ssbwiki.com/Edge, https://www.ssbwiki.com/Edgeguarding).
- Standard execution: an onstage fighter runs off the stage and fast falls onto the ledge as soon as the recoverer grabs it, which allows a combo such as a back aerial. The trumped fighter's later regrab gives no intangibility, which a trump edgeguard can exploit (https://www.ssbwiki.com/Edgeguarding). Other entries: dash toward the edge, press down, then toward the stage; or turn around, jump off, and grab like a reverse aerial rush. The follow-up is usually a back aerial (https://supersmashbros.fandom.com/wiki/Ledge-Trumping).
- Avoidance: buffer an attack, jump or roll on the grab. A regular getup and a drop cannot be buffered, so those are easy to trump, and buffering too late still gets trumped (https://www.ssbwiki.com/Edgeguarding). A Smash 4 era thread reports that a fighter must hold the ledge at least 22 frames and that a buffered action executes on frame 23 (https://smashboards.com/threads/how-exactly-does-ledge-trumping-work.402609/). That conflicts with the 19-frame animation on SSBWiki, and the thread says the trumped lag is about 30 frames with an uncertain number. `unverified:` all ledge trump frame numbers for Ultimate.
- One 2019 guide says Ultimate weakened trump by making the launch direction depend on the trumped player's input, which reduces reliability (https://thegamehaus.com/gaming/fighting-games/super-smash-bros-ultimate-how-to-edgeguard/2019/01/08/). It is a single source, `unverified:`.
- An Ultimate era thread describes a short "trumpstun" before the trumped player can act and notes the trumper has no easy punish, with no frame number (https://smashboards.com/threads/ledge-trumps.465693/).

Aevalrena: there is no trump. `ledgeTaken` in `tryLedgeGrab` rejects any grab of an occupied ledge, so edge-hogging is the equivalent tool and works (https://github.com/aevalmere/aevalrena, src/sim/ledge.ts). probe: two fighters falling onto the same ledge, the second stays airborne. The sim keeps the hog alive for 40 frames per grab and forever afterwards, but a hog with expired invulnerability is hittable (hurtbox is the crouch box, 26 by 26 px, from 6 px above the platform top to 20 px below it, centered on the corner).

### 1.6 The 2-frame window

- After a grab there are exactly two frames before the intangibility starts. It does not exist when the recoverer grabs from beyond the ledge on the way back down, when they only jump and do not use an up special, or when they teleport from above the ledge (https://www.ssbwiki.com/Edge). Its purpose was to compensate for the removal of edge-hogging.
- Good punishers are tilts and thrown items. Any attack that reaches below the ledge works. Ike's downward Aether and the Mii Brawler's Soaring Axe Kick can meteor or trade for a KO if they land in the window (https://www.ssbwiki.com/Edge).
- The wiki sorts moves by how they meet the ledge hurtbox: "reaching" hits at ground level and catches most hanging fighters, "clipping" hits below ground level by enough to catch the whole cast (Ganondorf hangs lowest, so a move that hits him works on everyone), and "piercing" goes at least 8 units below ground level and usually hits recoverers before they grab (https://www.ssbwiki.com/Edge).
- Named examples: Wolf's down smash hits below the stage (https://www.ssbwiki.com/Down_smash). Mythra's down tilt has disjointed hitboxes that can 2-frame (https://www.ssbwiki.com/Down_tilt). Fox's down tilt hits on frame 7 and can 2-frame certain opponents, while his up tilt no longer can because its hitboxes moved higher (https://www.ssbwiki.com/Fox_(SSBU)).
- A 2014 report for the Wii U game says invulnerability starts on the second frame of the grab, which counts one vulnerable frame, against SSBWiki's two (https://eventhubs.com/news/2014/dec/31/ledge-grabbing-not-fully-invincible-super-smash-bros-wii-u-until-2nd-frame-methods-exploit-sonic). Frame counting convention (whether the grab frame is frame 0 or 1) probably explains the gap. `unverified:` which convention Ultimate data uses.

Aevalrena: the 2-frame window does not exist. `stepGame` runs `updateFighter` (which calls `tryLedgeGrab` and sets `invuln = 40`) before `resolveHits` on the same frame, so a fighter is invulnerable on its grab frame (https://github.com/aevalmere/aevalrena, src/sim/index.ts, src/sim/ledge.ts). probe: after a grab `invuln` reads 40, 39, 38 and so on, reaching 0 at 40 frames. The equivalent window is the frames before `N`. A hit that resolves on frame `N - 1` or earlier gives the victim `hitstun > 0`, which makes `tryLedgeGrab` return early. Section 6.5 turns this into a placement rule.

### 1.7 Ledge stalling in Ultimate

Melee-style ledgestalls (refreshing intangibility by dropping and regrabbing) do not work in Ultimate because of the six-grab cap, the regrab intangibility removal and the slower grab animation (https://www.ssbwiki.com/Ledgestall, https://www.ssbwiki.com/Edge). Planking is limited, and Steve's block placement is the current exception, with tournament rules such as Supernova 2025 banning a Steve-specific stall (https://www.ssbwiki.com/Planking). Ultimate does have `fast fall` from a held-down drop, and the fast-fall counter cap of seven is unreachable because of the six-grab cap (https://www.ssbwiki.com/Fast_fall).

Aevalrena differs on every point. Dropping does not clear leftover invulnerability, a regrab sets a fresh 40 frames on grabs 1 to 3 (`ledgeRegrabs <= LEDGE_MAX_REGRABS`), grabs 4 and later grant none, and there is no grab cap. probe: drop as early as possible, wait out the 12-frame cooldown, and regrab, repeatedly. Grabs land at frames 0, 13, 26, 39, 52, 65 and 78. The fighter is continuously invulnerable for 66 frames from the first grab (grab 4 arrives with 27 leftover frames, then 14, then 1) and vulnerable at frame 66. Midair jumps refill on every grab. Ledge regrab count resets only on landing, climbing or rolling onto the stage, or a KO, and not on hitstun (https://github.com/aevalmere/aevalrena, src/sim/physics.ts, src/sim/ledge.ts, src/sim/match.ts). A CPU must not assume that dropping ends invulnerability or that a hit clears the regrab counter.

## 2. Aevalrena recovery envelope (probe)

These are the numbers a CPU needs for the reachable set. Aeval's constants are gravity 0.15, max fall 3.2, fast fall 5.0, air speed 2.0, air acceleration 0.14, air friction 0.03, jump velocity 5.4, double jump velocity 5.0, `jumps: 2`, with `jumpsLeft = def.jumps - 1 = 1` after a ground jump and `jumpsLeft = 2` when landing resets it (https://github.com/aevalmere/aevalrena, src/characters/aeval/moves.ts, src/sim/actions.ts, src/sim/physics.ts). A fighter launched off the stage without jumping therefore has two midair jumps, and one who ground-jumped first has one. `unverified:` whether the owner intends that.

- Double jump: rise 80.85 px, apex 32 frames after the input, back at the launch height after 68 frames. Analytic `v^2 / (2 g)` gives 83.3, so the closed form overestimates by about 2.5 px.
- Up special (`uspecial`, 48 frames, geyser hitboxes on frames 8-20, then `airHelpless`): rise 82.3 px, apex at move frame 39. Height above the start at frames 10, 20, 30, 39 and 48 is 13, 56, 77, 82 and about 75 px. Air steering stays active, up to 2.0 px per frame. The move has `action = 'attack'` for all 48 frames, and `tryLedgeGrab` rejects that action, so an up special cannot snap to the ledge before frame 48 (probe: a grab from a start at dx 40, depth 100 happens at frame index 48). The first ledge frame is also the first `airHelpless` frame.
- Air dodge: 34 frames, invulnerable frames 2-31, ledge grab allowed at any frame while in the region and falling. A left dodge travels about 109 px sideways and falls 76 px by frame 33. A left-up dodge travels 77 px and falls 12 px. A pure up dodge nets about -20 px. A neutral dodge falls 76 px. A hit does not refund the dodge (SPEC 4.x), unlike Ultimate. probe: a left-down dodge from dx 60, depth 30 grabbed the ledge on frame index 13.
- Fall time to the lower blast line from the ledge height: about 120 frames with no fast fall (derived: 21 frames to reach 3.2 px per frame, then 3.2 px per frame over the remaining depth to 358 px on Hearthmoor).
- Deepest depth below the ledge top at which some script reaches the ledge or the stage, Hearthmoor, lower bound from a coarse grid of jump times (step 5 to 10 frames) and up special times (step 6 frames) with the stick held toward the stage (probe):

| Jumps left | dx 40 | dx 80 | dx 120 | dx 160 | dx 200 | dx 260 |
|---|---|---|---|---|---|---|
| 0 (up special only) | 110 | 140 | 140 | 90 | 30 | none |
| 1 | 130 | 190 | 220 | 230 | 220 | 150 |
| 2 | 140 | 210 | 260 | 290 | 310 | 300 |

Depth is limited by the blast line at 358 px below the ledge top. At dx 10 the depth limit falls to 70-80 px because the fighter's hurtbox (26 px wide) hits the platform side and underside while rising. Horizontal reach is not binding with a jump left, since the blast line is only 300 px past the corner on Hearthmoor. With no jump and no up special the fighter can reach only what air speed and the air dodge cover.

Aevalrena: the existing `recoverable()` in `src/ai/aevalmere.ts` uses 85 px for the up special and `doubleJumpVel^2 / (2 * gravity)` for jumps, which are within 3 px of the probes. Compute these numbers per character at load time by running the same probe, so a second character needs no code change.

## 3. Edgeguard taxonomy

### 3.1 Onstage and offstage

SSBWiki names two families. Offstage guarding means jumping or running off and attacking in midair. Onstage guarding means staying near the ledge with a down smash, down tilt, forward smash or projectile and hitting a recoverer who fails to sweetspot (https://www.ssbwiki.com/Edgeguarding). A character's edgeguard strength depends on the length and safety of its own recovery and the usefulness of its aerials (https://www.ssbwiki.com/Edgeguarding). Deterrence is a fake offstage approach that makes the recoverer dodge a nonexistent attack or miss the ledge (https://www.ssbwiki.com/Edgeguarding). One 2019 guide says an edgeguard that leaves the opponent without a jump nearly guarantees the stock except against exceptional recoveries such as Bayonetta or Pikachu, and that baiting a miss is the safe onstage alternative (https://thegamehaus.com/gaming/fighting-games/super-smash-bros-ultimate-how-to-edgeguard/2019/01/08/).

Ultimate raised the value of edgeguarding for three reasons. Sweetspots were toned down, the one-air-dodge rule makes offstage escapes weaker, and directional air dodges below stage level often guarantee a self-destruct (https://www.ssbwiki.com/Edgeguarding, https://www.ssbwiki.com/Air_dodge).

### 3.2 Offstage aerials and their timing

Offstage guarding needs a fast aerial and enough jump budget to return. SSBWiki advises not spending the second jump before the hit, since many characters cannot return without it (https://www.ssbwiki.com/Edgeguarding). Startup values from ultimateframedata.com: Fox back air hits on frame 9 (active 9-11, 13% damage) and neutral air on frame 4; Marth forward air frame 6 (active 6-8), back air 7; Cloud back air 11 (active 11-12), forward air 18; Joker back air 7 (https://ultimateframedata.com/fox, https://ultimateframedata.com/marth, https://ultimateframedata.com/cloud, https://ultimateframedata.com/joker). Air budgets differ: Fox gravity 0.230 and fall speed 2.1, Cloud gravity 0.098 and fall speed 1.68, Marth gravity 0.075 and fall speed 1.58. That ratio (about 3 to 1 in gravity) is why Cloud and Marth can stay offstage far longer than Fox (same pages).

Aevalrena: the offstage aerials are fair (frames 9-13, 10%, angle 45), bair (7-10, 11%, angle 361), dair (12-16, 12%, angle 270, landing lag 16) and nair (5-22, 7%), from SPEC section 5 (https://github.com/aevalmere/aevalrena, docs/SPEC.md). Aeval's low weight (88) and gravity 0.15 mean each offstage trip costs a jump. A brain should price an offstage aerial by our own `canGetBack` at the end of the move plus landing lag (Section 6.2).

### 3.3 Meteor smashes, spikes and semi-spikes

- Meteor cancelling exists only in Melee and Brawl. It was removed in Smash 4 and is absent in Ultimate, so every downward-launching hit in Ultimate is functionally a spike (https://www.ssbwiki.com/Spike, https://www.ssbwiki.com/Meteor_smash). The distinction between "spike" (angle outside the meteor detection window) and "meteor smash" only matters in games with cancelling.
- In Ultimate a meteor smash on a grounded fighter can no longer be teched and has 5% reduced knockback. A fighter meteor smashed with launch speed of 3 units per frame or more, at about 25 units below the camera boundary, is KO'd before the lower blast line. This makes sacrificial meteors reliable on last stocks (https://www.ssbwiki.com/Meteor_smash). Marth's down air has a meteor hit only on frame 11 of its 9-13 active window (https://ultimateframedata.com/marth).
- A semi-spike sends a fighter at a low, mostly horizontal angle so that gravity turns it into a fall. Survivors end up below and away from the ledge, the worst recovery position (https://www.ssbwiki.com/Semi-spike).
- Stage spike: hitting a fighter into the stage so it rebounds downward. Ultimate techs work with a knockback threshold: a launch speed of 6 or more at contact makes the tech impossible, and a speed of 3 or more at 25 units below the camera boundary kills before the blast line (https://www.ssbwiki.com/Stage_spike, https://www.ssbwiki.com/Tech). The tech press window is 11 frames in Ultimate, and a tech can be buffered in hitlag (https://www.ssbwiki.com/Tech).

Aevalrena: `dair` has angle 270 (a spike) and there is no meteor cancel, so its hit is a KO if the fighter cannot get back before falling out (SPEC). Sim geometry has no stage spike: `resolveSolids` zeroes the velocity component against a platform side or underside and does not rebound (https://github.com/aevalmere/aevalrena, src/sim/physics.ts). An upward launch into the underside stops the rise (`kbSpeed = 0`), so the fighter falls straight down, which acts like a gimp with no bounce. Tech is only for landing (`landTumble`).

### 3.4 Gimps

SSBWiki defines a gimp as interrupting a recovery, often with a weak or non-damaging action. Examples: interrupting a needed double jump (especially at its start), blocking haltable recoveries, non-flinching pushes, reversing the opponent's direction, hitting a recoverer out of a recovery move they cannot use twice, footstools, and weak semi-spikes or meteors that do not kill but cause the recovery to fail (https://www.ssbwiki.com/Gimp). The distinction from edgeguarding is intent: edgeguarding uses continued or powerful hits, gimping is opportunistic (https://www.ssbwiki.com/Gimp).

Aevalrena: no sim state marks the up special as used. It is blocked only by being in `airHelpless`. A hit on a helpless or mid-`uspecial` fighter replaces the action with hitstun, and afterwards the fighter is in `air` with the up special available again. A non-lethal hit on a helpless Aeval therefore refunds the recovery, and only a hit that removes enough range or depth (Section 6.1) or kills is a real gimp. Jumps are not refunded by hits, matching Ultimate.

### 3.5 Walling with disjoints and projectiles

- Disjointed swords and long-limbed attacks let a fighter cover the ledge from a safe distance. A retreating back aerial is the most common ledge trap tool, with sword users best placed because of the hitbox reach (https://rangothemercenary.medium.com/smash-ultimate-tips-ledgetrapping-51f551c949aa). Projectiles cover multiple ledge options passively while the trapper reacts to the rest (https://dignitas.gg/articles/hugs-ledgetrapping-guide-for-super-smash-bros-ultimate).
- Projectile edgeguards are safe because the user stays onstage, and gravity-affected projectiles are best (https://www.ssbwiki.com/Edgeguarding). Ultimate examples: Pikachu's Thunder Jolt blocks routes, Simon and Richter's axe passes through the stage, Sephiroth's flare works as a trap (https://www.ssbwiki.com/Edgeguarding). Cloud's Blade Beam forces low recoveries or steals jumps (https://dignitas.gg/articles/blogs/smash/14080/lord-of-sword-a-guide-to-cloud-in-super-smash-bros-ultimate).

Aevalrena: two projectiles exist. The orb has vx 3.5 to 9.5 and lifetime 48 to 34 by charge, so a tap orb covers about 168 px and a full orb about 323 px (derived from SPEC). The crescent travels about 202 px out and returns for half damage, pierces, and has clash strength 4 (https://github.com/aevalmere/aevalrena, docs/SPEC.md section 5). Both work as walls over a recovery path. Their clash strength (orb 2 to 10) decides whether they beat a recoverer's projectile.

### 3.6 Ledge trapping against going offstage

- The trapper's task is to control the stage and corner the opponent, using back aerial pressure, projectiles, and moves with lingering frames that cover several getup options at once. The standard advice is to build damage, throw the opponent back offstage, keep a perimeter around them, and mix options rather than mash (https://rangothemercenary.medium.com/smash-ultimate-tips-ledgetrapping-51f551c949aa).
- The HugS guide lists six return options (getup, roll, getup attack, ledge jump, aerial from a drop, wavelanding) and one standard answer per option: shield-grab or an aerial or up special out of shield against the plain getup, a spaced aerial out of shield or a grab against the roll, hold shield then shield-grab or up special against the getup attack, an out-of-shield aerial or up special against the ledge jump, and treat an aerial from the ledge like a getup attack. Positioning must reach both the ledge itself and the opponent's maximum roll distance (https://dignitas.gg/articles/hugs-ledgetrapping-guide-for-super-smash-bros-ultimate). SSBWiki lists shield at the ledge as a universal cover that answers four of the six options, with some needing a reaction (https://www.ssbwiki.com/Edge).
- Going offstage instead is high risk. For Cloud, one guide says the risk and reward favor staying onstage to charge Limit and ledge trap, since a full Limit lets him punish every getup option with Climhazzard out of shield (https://dignitas.gg/articles/blogs/smash/14080/lord-of-sword-a-guide-to-cloud-in-super-smash-bros-ultimate).

### 3.7 Ledge trump into back aerial, 2-framing

See sections 1.5 and 1.6. The onstage sequence is trump on the frame the recoverer grabs, then a back aerial into the trumped fighter's fall. The 2-frame is a tilt or down smash timed to the two frames before intangibility.

Aevalrena: neither exists. Their equivalents are the edge-hog (grab the ledge first, so the recoverer cannot) and the pre-grab hit of Section 6.5.

### 3.8 Footstool gimps

A footstool jump on an airborne opponent makes them tumble a set distance. It is not a meteor and cannot be cancelled early. It does no damage and can be repeated two to six times depending on fall speed. Ultimate allows a tech when a footstooled fighter lands, and a fighter must wait 16 frames after an attack before it can footstool. It cannot hit an opponent who is performing a move (https://www.ssbwiki.com/Footstool_Jump). It is used mainly to gimp when edgeguarding (https://www.ssbwiki.com/Footstool_Jump).

Aevalrena: `tryFootstool` gives the footstooler a full `jumpVel` (5.4) jump without spending a midair jump, and leaves an airborne victim in `footstooled` for 20 frames with `vy` set to 6, which is above max fall, so they drop 6 px per frame for the whole 20 frames, about 120 px, unable to act or grab the ledge (https://github.com/aevalmere/aevalrena, src/sim/footstool.ts, src/core/constants.ts). It works when the footstooler's feet are within 12 px above the victim's hurtbox top and within half the width plus 6 px horizontally. This is a very cheap gimp in the sim and a brain should consider it whenever an enemy is directly under our feet offstage.

### 3.9 Counter-edgeguard risk

- Recovery moves with high knockback punish reckless edgeguards, often by stage spike. Marth and Meta Knight are the classic cases (https://www.ssbwiki.com/Stage_spike). Fox's Fire Fox can stage spike reckless edgeguarders (https://www.ssbwiki.com/Fox_(SSBU)). Sacrificial KOs were nerfed in Smash 4 so that the initiator is KO'd first, with Ultimate keeping that rule, so a sacrifice is now a trade decided by stocks (https://www.ssbwiki.com/Sacrificial_KO). Ganondorf's recovery hitboxes can hit an incoming Wizard's Foot before it lands (https://www.ssbwiki.com/Spike).
- Two more facts help a risk model. A helpless edgeguarder cannot act, and the edgeguarder's own airtime budget shrinks with every jump (https://www.ssbwiki.com/Helpless, https://www.ssbwiki.com/Double_jump).

Aevalrena: Aeval's geyser is the main counter-edgeguard threat, since its hitboxes (8% damage, angle 88, bkb 72, kbg 86, active frames 8-20) launch upward through anyone above or beside the geyser. The edgeguarder's own `dair` has 12 startup frames and 16 landing lag, so it also leaves the user falling. Any offstage plan needs our own `canGetBack` at the end (Section 6.2) and a check that the opponent's active recovery hitbox does not overlap our path at frames 8-20 after their commit.

## 4. Recovery

### 4.1 Types and high or low routes

- Recoveries are combinations of midair jumps and recovery moves (up special, teleports, tethers, gliding, extra momentum moves). Distance splits into vertical and horizontal, and recovery moves usually help one more than the other (https://www.ssbwiki.com/Recovery, https://dignitas.gg/articles/how-to-recover-in-super-smash-bros.-ultimate-a-guide-on-recovery-for-every-character).
- Ultimate recovery gains: directional air dodges again improve every recovery and no longer cause helplessness, though they leave long ending lag, and most characters have more air speed (https://www.ssbwiki.com/Recovery). A tether that finds an open ledge connects on its own (https://www.ssbwiki.com/Tether_recovery).
- A high recovery aims above the ledge, snaps from above or lands on the stage. A low recovery aims at the ledge from below and snaps on arrival. Snapping the ledge from above resets neutral instead of fighting the opponent below (https://rangothemercenary.medium.com/smash-ultimate-tips-tricks-overcoming-disadvantage-state-83659e25cdb1). SSBWiki notes it is safer to aim a recovery to narrowly grab the ledge without peeking above it to avoid an onstage edgeguard, though overextending causes self-destructs (https://www.ssbwiki.com/Edge).

Aevalrena: every ledge grab needs `vy > 0` (falling) and a non-attacking action, so all grabs happen on the way down. A geyser from a depth of about 77 to 147 px (with roughly 80 px of inward steering) ends its 48 frames inside the grab region. A shallower start rises above the ledge and falls back into the region, which is a "high" route that spends the whole fall window (about 70 px of depth, about 22 frames at max fall) inside the trapper's reach, and the trapper stands on the stage right there.

### 4.2 Drift, timing and air dodge mixups

- Vary timing, trajectory and move order. Interrupt jumps with air dodges, alternate special moves, use stalls and B-reverses, and do not hold forward predictably. If the edgeguarder prepares to cover one side, go to the other, and if in doubt aim for the ledge snap (https://rangothemercenary.medium.com/smash-ultimate-tips-tricks-overcoming-disadvantage-state-83659e25cdb1, https://dignitas.gg/articles/how-to-recover-in-super-smash-bros.-ultimate-a-guide-on-recovery-for-every-character).
- A directional air dodge toward the ledge is a universal fallback if the fighter is close (https://dignitas.gg/articles/how-to-recover-in-super-smash-bros.-ultimate-a-guide-on-recovery-for-every-character). A fast-fall air dodge past the ledge, then a recovery upward to snap, is a documented option (https://rangothemercenary.medium.com/smash-ultimate-tips-tricks-overcoming-disadvantage-state-83659e25cdb1).
- Reverse ledge grabs: facing away from the ledge gives a smaller grab box in Ultimate (Section 1.1), so the reverse grab is used for timing (delaying the snap), not range.
- Waiting out invulnerability: after a trump-free onstage hog, the hog's invulnerability ends. In Ultimate a hanging fighter cannot be waited out because a grab trumps them, but in games with hogging the recoverer waits for the hog to expire (https://www.ssbwiki.com/Edgeguarding).

Aevalrena: with no trump, waiting out the hog matters. A recoverer with one jump left can hover about 68 frames (jump lands back at start height after 68 frames, derived from the double jump probe) and the hog's invulnerability is 40 frames from its grab. Drift steering (2.0 px per frame max) and one fast fall or air dodge give timing choices. The hogger also has no obligation to wait, and can drop, jump, roll or attack at any frame, so hovering is safe only outside every hitbox that the hogger's options can reach at the moment of expiry (Section 6.4).

### 4.3 Escaping a ledge trap

Do not input immediately on the snap. Read the opponent's spacing. Drop from below and use disjoint aerials or up specials against opponents standing too close. Drop away, jump away, and act (a Mario cape into a back aerial, Wolf's Blaster, Marth's Dancing Blade). Double snap by regrabbing after a drop, which loses intangibility but buys time, and most characters cannot hit below the ledge to punish it (https://rangothemercenary.medium.com/smash-ultimate-tips-escaping-ledgetraps-from-the-ledge-b0f84453d6d9).

### 4.4 Recovery decision theory

Recovery is a sequential game with irreversible commits: a midair jump is spent, an up special is spent for about 48 frames in the sim and usually makes the fighter helpless, and an air dodge is one per airtime. The recoverer picks a route and timing while the edgeguarder picks a cover, both under reaction limits. Nothing in the sources gives a formal model, so the following is design guidance that I derived, not a documented result.

1. Build a payoff matrix `A[route][cover]` of survival probability (or expected stocks) by playing each pair through the forward model. Routes: high early, high late, low snap, air dodge snap, drop and regrab, land-on-stage. Covers: hog, ledge trap stance, offstage aerial at several timings, projectile wall, spike attempt, do nothing.
2. If the edgeguarder cannot condition on the recoverer's route until it is visible (a jump start is visible on frame 1, an air dodge on frame 1), solve the zero-sum game for the maximin mix. For a 2 by 2 matrix `[[a, b], [c, d]]` with route 1 played with probability `p`, equalise the two columns: `p = (d - c) / (a - b - c + d)`. With survival probabilities `[[0.35, 0.90], [0.85, 0.30]]` (illustrative numbers, not measured) `p = 0.5` and the value is 0.60. For larger matrices run a fixed 200 iterations of fictitious play seeded by `state.rng`, which is deterministic across peers.
3. Reaction turns the matrix into a tree. After the edgeguarder's reaction delay `R` frames (4 for the current brain, human tiers should scale up), the recoverer's later commits can condition on what the edgeguarder did. Solve the last commit point first and back up.
4. Go high when the edgeguarder is low and committed (hogging, offstage below the ledge, or in lag), because a landing on the stage cannot be reached from there. Go low and snap when the edgeguarder is standing high or has an active hitbox over the landing spot. Use the matrix to decide when neither holds.
5. When the matrix is not solvable in time, mix by the rule "no single route is chosen more than the maximin weight" and avoid repeating the previous stock's route, since an n-gram model of your own choices is exactly what a strong opponent builds.

## 5. How top players edgeguard and recover

Documented tendencies from SSBWiki player pages and from Ultimate guides. These describe what strong players do, and I have not seen match statistics for any of them.

- Light (Fox): overwhelming speed and reaction. Many kills come from tech chases and from reacting to ledge getups, with a dash attack into back aerial kill confirm on getups that Light pioneered. He saves kill moves unstaled. He was first known for 2-framing with down smash, then moved to cornering opponents with back airs while reading or reacting to their options. He edgeguards poor or linear recoveries with neutral air or shine. On recovery he stalls with Reflector and uses Fire Fox at unusual angles to trade or dodge (https://www.ssbwiki.com/Smasher:Light_(Connecticut)). Fox's back aerial at the ledge is described as notoriously safe (https://www.ssbwiki.com/Fox_(SSBU)).
- MkLeo (Joker, Byleth): as Joker, incredible edgeguarding with Gun and a habit-reading comeback game with Arsene. As Byleth, deadly edgeguards with Sword of the Creator and knowledge of the up special that lets him take stocks at low percent. Known as "Game 4 Leo" for losing early games and then adapting (https://www.ssbwiki.com/Smasher:MkLeo).
- Sparg0 (Cloud): continuously changes which aerial he uses and when, ledge traps with back aerial to hold opponents at the ledge or offstage, and accepts calculated all-in risks such as an extended edgeguard with Limit or a suicide up special. He is also known for creative recoveries and for knowing when to take risks despite Cloud's weak recovery (https://www.ssbwiki.com/Smasher:Sparg0).
- Cloud guide (Dignitas): Cloud edgeguards mainly short, linear, weak-hitbox recoveries, with dair and fair spikes. Most of the time the guide favors staying onstage, charging Limit while shielding, and punishing every getup option with a Limit Climhazzard out of shield. Cloud's recovery uses air speed, wall jumps, directional air dodges to snap, and Cross Slash and Blade Beam as stalls (https://dignitas.gg/articles/blogs/smash/14080/lord-of-sword-a-guide-to-cloud-in-super-smash-bros-ultimate).
- Rango's articles (a coach and analyst): ledge traps are built on damage, perimeter control and retreating back airs, with mixed options. Escapes are built on patience and reading, not on immediate button input (https://rangothemercenary.medium.com/smash-ultimate-tips-ledgetrapping-51f551c949aa, https://rangothemercenary.medium.com/smash-ultimate-tips-escaping-ledgetraps-from-the-ledge-b0f84453d6d9).
- Video analyses seen only as titles in search results, content not read: "How to DOMINATE the ledge like MKLeo" (https://www.youtube.com/watch?v=n8ltbCMeotk), "The Theory Behind Ledge Trapping in Smash Ultimate" (https://www.youtube.com/watch?v=p3wxtYRGp64), and three more ledge trapping guides (https://www.youtube.com/watch?v=58TmXhbfYso, https://www.youtube.com/watch?v=NTdA4mBVBlY, https://www.youtube.com/watch?v=zAOFmyXARig).
- Izaw's "Art of Smash" Ultimate series exists (parts Beginner, Advanced, Expert, Master, Training, Godlike, plus one video per character, https://www.youtube.com/playlist?list=PL4SzCzeORbSRRI72fLpdCCDI-SZIwqFyJ). I could list its titles but not read any video, so `unverified:` nothing here is attributed to Izaw and I could not find which part covers edgeguarding.

Encoding for the CPU (design guidance derived from the tendencies above, not sourced): vary the aerial choice and its timing with an anti-repeat rule (Sparg0), react to the ledge option instead of predicting it when reaction time allows (Light), keep a habit predictor per opponent and adapt across stocks (MkLeo), accept a sacrificial trade when the stock state favors it (Sparg0), and recover with mixed timing, stalls and angle changes (Light, Sparg0).

## 6. Decision procedures

The forward model is cheap (about 1.5 microseconds per two-fighter frame), so each procedure calls `simulate(state, planA, planB, frames)` on a cloned state. All randomness comes from `state.rng`. Levels below the god tier reduce the search and add noise, and Section 6.6 lists the parameters.

### 6.1 Can the opponent get back

```
// Offline or at load, per (character, stage): envelope table, as in Section 2.
Env.maxDepth[j][u][a][dxBin]        // j = jumpsLeft, u = up special available, a = air dodge available
                                    // deepest feet depth from which SOME script reaches ledgeHang or onGround

function canGetBack(st, who):
    f = st.fighters[who]
    if f.onGround or isLedgeAction(f.action): return { ok: true, slack: INF }
    dx    = beyondCorner(f)              // 0 under the stage; use nearer corner
    depth = f.y - platformTop
    u = not (f.action == 'airHelpless' or (f.action == 'attack' and f.moveId == 'uspecial'))
    a = not f.airDodgeUsed
    margin = Env.maxDepth[f.jumpsLeft][u][a][bin(dx)] - depth     // px of spare depth
    if abs(margin) > 40: return { ok: margin > 0, slack: margin }
    // close call, or velocity matters: exact search with the forward model
    best = -INF
    for s in SCRIPTS(f):                 // about 40 to 250 scripts, see below
        for delay in 0..30 step 3:       // delay models hitstun or a late commit
            if rollout(st, who, s, delay) reaches ledgeHang/onGround before KO: best = max(best, delay)
    return { ok: best >= 0, slack: best }      // slack in frames of delay the recovery can absorb
```

- Script family: jump frame `j1` in {0, 10, ..., 50}, `j2 = j1 + {15, 30, ..., 90}`, up special frame `u` in {0, 6, ..., 120}, air dodge frame and direction, stick toward the stage each frame, optional fast fall after the apex. My coarse grid needed about 6 to 13 seconds in an unoptimised script for 21 to 24 table cells (probe), so build the table once per character and stage, not per frame. A per-frame exact check with 250 scripts and 150 frames costs about 56 ms by the 1.5 microsecond figure (derived), which is over a frame budget, so it runs only for close calls and is spread over frames.
- Gimp test: to decide whether a hit gimps, apply the hit in a clone, advance through hitstun (`floor(0.4 * kb)` frames, launch speed decaying 0.051 per frame), then call `canGetBack`. A hit is a gimp if the answer flips to `ok = false`. A hit that flips it only when the opponent's air dodge is spent is worth more, since a spent dodge cannot be refunded by hitstun in the sim.
- The existing `recoverable()` in `src/ai/aevalmere.ts` is a smooth heuristic for ranking rollout ends, and this procedure replaces its constants with measured values (https://github.com/aevalmere/aevalrena, src/ai/aevalmere.ts).
- Reference design: SmashBot's `canedgeguard` decides by who is closer to the ledge and whether the opponent is off stage, its `canrecoverhigh` steps the opponent frame by frame with gravity, terminal velocity and air speed from a character table to see whether a jump reaches stage level, and `snaptoedgeframes` estimates the frames to snap from horizontal and vertical distance with special cases for teleports (https://github.com/altf4/SmashBot, https://raw.githubusercontent.com/altf4/SmashBot/master/Tactics/edgeguard.py). It is a Melee bot and uses hand-entered up special heights per character. The table-plus-rollout method above avoids per-character constants.

### 6.2 Choosing the edgeguard action

```
PLANS = [hogWait, hogThenAct, trapStand(d, move), orbFull, crescent,
         egFair, egBair, egDair, egFairDair, egBairDair, footstoolIfUnder, retreatToStage]

function chooseEdgeguard(st, me, opp, level):
    if canGetBack(st, opp).ok == false and isKoRange(opp): // already dead: do a safe finisher only
        return safestKillPlan()
    replies = replyModels(st, opp)         // recovery scripts weighted by habit predictor + adversarial set
    for plan in PLANS:
        vals = []
        for r in replies:
            s = clone(st); simulate(s, plan, r, H)     // H = 60 to 90 frames
            oppKO   = opponent lost a stock within H
            meDead  = I lost a stock within H, or canGetBack(s, me).slack < SAFE_SLACK
            vals.push( V_STOCK * oppKO
                     - V_STOCK * riskWeight * meDead
                     + W_DMG * (dmgDealt - dmgTaken)
                     - W_CTRL * lostLedgeControl )
        score[plan] = lambda * min(vals) + (1 - lambda) * weightedMean(vals, weights(replies))
    return argmax(score)
```

- Terms: `V_STOCK` scales with the stock state. When both fighters are on the last stock a sacrificial trade is neutral (`meDead` and `oppKO` cancel), so raise it above `riskWeight`. When ahead, raise `riskWeight`. When behind, lower it. Do not treat these as tuned numbers.
- Do not go offstage when the score of an onstage plan (trap, hog, projectile) exceeds the best offstage plan by a margin. The sources support that rule for characters with weak or short recoveries (Cloud) and for any edgeguard against a recovery that has an active damaging hitbox the plan does not clear (https://dignitas.gg/articles/blogs/smash/14080/lord-of-sword-a-guide-to-cloud-in-super-smash-bros-ultimate, https://www.ssbwiki.com/Stage_spike).
- The spike plans (`egFairDair`, `egBairDair`) are worth taking outright when every reply in the set ends in a KO and we end on the stage or ledge, which is how the current brain already treats them (https://github.com/aevalmere/aevalrena, docs/CPU_AEVALMERE.md).
- Counter-edgeguard filter: from each reply script, extract the opponent's active hitboxes per frame (Aeval geyser: frames 8-20 after their commit, hitbox circles at y -44 and -76 above the feet, so up to about 76 px above their feet). Reject any plan whose hurtbox overlaps those at those frames unless the rollouts show we survive.
- Aevalrena cost model: `dair` is 36 frames with 16 landing lag, `fair` 30 with 12 landing lag, `bair` 28 with 12 (SPEC). Each offstage trip spends a jump if we need to return, so add `canGetBack(me)` at the plan's last frame, with the actual jumps left, as the risk term.

### 6.3 Ledge trap coverage

```
OPTIONS = [climb, attack, roll, jump, drop, wait]      // Aevalrena timings from Section 1.4

function vulnerableInterval(o, h):        // h = frames since their grab when they input o; absolute frames after input
    leftover = max(0, 40 - h)             // hang invulnerability still running (first three grabs)
    switch o:
      climb  -> [max(leftover, 29), 30)   // one vulnerable frame at the end, then actionable
      attack -> [max(leftover, 23), 40)   // hitbox frames 18-24, frames 23-24 active and vulnerable
      roll   -> [max(leftover, 24), 24)   // empty: no vulnerable frame; lands 34 px inside on frame 24
      jump   -> [max(leftover, 12), INF)  // airborne after 12 frames, can act at once
      drop   -> [leftover, 12) then regrab // vulnerable while leftover == 0, regrab after 12 frames
      wait   -> [leftover, INF)           // vulnerable at the ledge hurtbox once leftover == 0

function chooseTrap(st, me, opp):
    p = optionProbabilities(opp, st)      // Dirichlet-smoothed counts: (n_o + alpha * prior_o) / (N + alpha)
                                          // prior: quantal response, p(o) ~ exp(-beta * loss_o(plan)); beta by level
    for trap in TRAPS(me):                // stand distance d (shield, wait, spaced tilt), timed aerial, orb, crescent
        for o in OPTIONS:
            for h in hangTimeSamples(o):  // when they act: early, at invulnerability end, late
                s = clone(st); simulate(s, trap, optionScript(o, h), 90)
                gain[trap][o][h] = dmg + KOvalue + controlValue - ownRisk
        E[trap] = sum_o p[o] * mean_h gain[trap][o][h]
    return argmax(lambda * min_o + (1 - lambda) * E)
```

- The roll is the important coverage problem in Aevalrena. It shows no vulnerable frame, it ends at a known point (34 px inside the corner) and the roller is actionable on that frame, so the trapper's answer is a hitbox that becomes active on the landing frame at that point, or a shield that can grab the landing (HugS lists spaced aerial out of shield or a grab as the standard answer, https://dignitas.gg/articles/hugs-ledgetrapping-guide-for-super-smash-bros-ultimate).
- Waiting is not free for the hanger: after 40 frames the hurtbox (6 px above to 20 px below the platform top, 13 px either side of the corner) is exposed to any reaching or clipping move, so a poke at the ledge forces an option (SSBWiki's reaching, clipping and piercing terms, https://www.ssbwiki.com/Edge). Ledge attack and climb are hittable only in the frames listed above, so a trapper's move that is active from frame 23 to 24 after the option punishes the attack, and one active on frame 29 catches the climb.
- Reaction gating: every option is distinguishable from the first frame after the input (each has its own action id), but the input time `h` is unknown, so the trapper's reaction delay applies to the option, not to the timing. A human tier with a 12 to 20 frame reaction misses the one-frame vulnerable window of the climb entirely and can only cover options that are vulnerable for many frames (attack, wait). The god tier with a 4-frame perception delay or less can hit the climb's single frame by reading it.
- Ultimate mapping: the same structure applies with Ultimate's numbers (Lucario neutral getup 1-33 intangible then one vulnerable frame, roll 19 vulnerable frames, jump 2, https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups), a 19-frame lockout before any option (https://www.ssbwiki.com/Edge), and intangibility that shrinks by 0.8 and 0.5 on regrabs.

### 6.4 Own recovery path

```
ROUTES = [highEarly, highLate, lowSnap, airDodgeSnap, jumpThenUpB(t), upBThenJump, dropRegrab, landOnStage]
COVERS = replyModelsFor(edgeguarder)   // hog, trapStand, offstageAerial(t), orb/crescent, spikeTry, idle

function chooseRecovery(st, me, foe):
    for route in ROUTES:
        for cover in COVERS:
            s = clone(st); simulate(s, route(me), cover(foe), 150)
            A[route][cover] = survived(s, me) ? 1 - damageTaken/CAP : 0
    if foeCanReact(level):                 // reaction gate: R frames of visibility on the first commit
        return solveTree(A, reactionFrames)
    mix = solveZeroSum(A)                  // 200 iterations of fictitious play, seeded by state.rng
    return sample(mix, state.rng)
```

- Route facts for Aevalrena (probe): a geyser from depth 77 to 147 with inward steering lands its 48 frames inside the grab region, an air dodge can be fired after the jumps and snap the ledge mid-dodge with no vulnerable gap, and a drop-regrab gives up to 66 invulnerable frames.
- The air dodge is the only route that keeps invulnerability across the approach. Invulnerable frames 2-31 cover the trapper's active hitboxes on those frames, then the fighter is vulnerable for 3 frames unless a snap happens first, and the dodge is spent for the airtime. Use it when the cover set contains a hitbox active in the last frames before the region, not when the cover is a hog (a taken ledge cannot be grabbed).
- Wait out the hog: if the foe hangs with `invuln` frames left `L` and the hang has no time limit, the recoverer needs airtime `>= L + margin` without leaving the safe zone. One jump gives about 68 frames back to the start height (Section 2), so with `L <= 40` a single jump suffices when timed for the last `L` frames. A hanger whose invulnerability is spent can be hit by our recovery hitbox, since the geyser's frames 8-20 rise through the hang hurtbox, so time the geyser to end its hitbox on the frames when the hog has lost invulnerability.
- Reverse and timing mixups need no extra plans. Add an `n`-frame delay parameter to each route (`n` in {0, 6, 12, 18}) and a hold-direction parameter (toward, neutral, away for the first `k` frames).

### 6.5 The 2-frame and its Aevalrena equivalent

Ultimate (exact rule): if the recoverer grabs on frame `N` and intangibility starts on frame `N + 2`, a hit must be active on `N` or `N + 1`. A move with active frames `[a, b]` started at `t0` is active on `[t0 + a, t0 + b]`, so pick `t0` with `t0 + a <= N + 1` and `t0 + b >= N`. Long-active moves are more tolerant of error in `N` (Section 1.6).

Aevalrena (the equivalent, from the ledge code): the hit must resolve on frame `N - 1` or earlier, while the victim is airborne and hittable, and it must give hitstun. The equivalent of the 2-frame is therefore a pre-grab hit. The grab condition is: airborne, `vy > 0`, not attacking, hurtbox-side grab box overlapping the grab region (Section 1.1). Predict `N` and place the hitbox before it:

```
function predictGrabFrame(st, who, hypotheses):      // exact, using the forward model
    out = []
    for u in hypotheses:                             // holdToward, neutral, uspecialNow, airDodgeNow, jumpNow, fastFall
        s = clone(st)
        for k in 1..K:                               // K = 60
            step(s, u(who), NONE)
            if s.fighters[who].action == 'ledgeHang': out.push({ u, N: k }); break
    return out                                       // spread of N over hypotheses gives sigma_N

function placeHitbox(st, me, who, out):
    for move in myMoves:                             // a move with startup S, active [S, E], lag L
        for t0 in 0..K:
            for each hypothesis h in out:
                frames = [t0 + S .. t0 + E]
                hit_h  = exists f in frames, f <= h.N - 1, such that
                         myHitbox(move, t0, f) overlaps hurtbox(who, position at frame f under h)
            cover = weighted share of hypotheses hit
            score = cover * killOrGimpValue - (1 - cover) * (L cost + own risk)
    return argmax
```

- Because a hit on `N - 1` is the last chance, choose `t0` so that the move's active span ends at `N - 1` under the most likely hypothesis and starts no earlier than `N - 1 - sigma_N`. Moves with long active windows, orb projectiles already in flight, and the crescent's returning pass are natural for this.
- Key geometric fact: at frame `N - 1` the victim's feet are within about depth 2 to 72 below the top and within about 30 px outside the corner, so its hurtbox (40 px tall) top is between 38 px above and 32 px below the platform top. A ground-level hitbox at y around -18 (Aeval's forward tilt reaches 80 px at y -18) reaches a recoverer whose feet are shallower than about 40 px, and only a low or downward hitbox reaches deeper ones (https://github.com/aevalmere/aevalrena, docs/SPEC.md section 5).
- Defender side: the recoverer should avoid entering the grab region on the frames when a hitbox is active, and should grab on the first possible frame so that the exposed span is only the approach. A fighter that gets a `vy > 0` and a grab box overlap at the same time cannot be hit that frame, so an air dodge whose invulnerable frames end at the region entry covers the approach.
- If the owner wants Ultimate's window in the sim, the smallest change is to delay `f.invuln = LEDGE_HANG_INVULN` by two frames in `grabLedge` (while keeping the snap position), which reproduces the SSBWiki rule that grab and hit share two frames (https://www.ssbwiki.com/Edge). Without that change the brain should not plan for a post-grab window.

### 6.6 Parameters to expose per level

- `edgeguardRisk` (weight on `meDead`), `offstageWillingness` (bias toward offstage plans), `trapCoverBreadth` (how many options the trap search covers), `reactionFrames` (perception delay applied to the recovery and option reads), `mixEntropy` (temperature of the route mix), `habitDepth` (n-gram depth of the option model), `twoFrameSkill` (probability that `predictGrabFrame` is used and the standard deviation added to `N`).
- The god tier sets `reactionFrames` at the sim minimum, solves the matrices exactly, and never has `edgeguardRisk` below 1 unless the stock state says otherwise. Human tiers add execution noise to `t0` and `N` and restrict the reply set.

## Open questions

- Ultimate ledge trump timing (minimum hang before a trump works, the trumped fighter's lag, the direction rule) has no verified frame numbers in the sources I could read.
- Whether Ultimate uses the Smash 4 hang intangibility constants (both pages list one formula) and whether Ultimate has any grab lockout after ordinary hitstun.
- Per-character ledge grab box sizes for Ultimate: ultimateframedata.com shows them as images and I found no numeric source.
- Whether the sim's drop-keeps-invulnerability rule, the 66-frame stall, the missing 2-frame window, and hits not refunding air dodge are intended. Each changes CPU logic, so the owner should decide before the brain hard-codes them.
- Izaw's Art of Smash content on edgeguarding and the two named YouTube analyses could not be read.

## Sources

Fetched (page body read):
- https://www.ssbwiki.com/Edge (raw wikitext): grab conditions, intangibility formula, hang time, regrab penalties, 2-frame punish and its terminology, ledge trap examples.
- https://www.ssbwiki.com/Edgeguarding: edgeguard families, ledge trumping, Ultimate changes, notable edgeguarders.
- https://www.ssbwiki.com/Meteor_smash, https://www.ssbwiki.com/Spike, https://www.ssbwiki.com/Semi-spike, https://www.ssbwiki.com/Stage_spike, https://www.ssbwiki.com/Gimp: meteor and spike definitions, meteor cancelling history, Ultimate KO rules, gimp examples.
- https://www.ssbwiki.com/Ledgestall, https://www.ssbwiki.com/Planking, https://www.ssbwiki.com/Edgehogging, https://www.ssbwiki.com/Fast_fall: stalling and hogging history and Ultimate limits.
- https://www.ssbwiki.com/Edge_getup, https://www.ssbwiki.com/Edge_attack, https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups, https://www.ssbwiki.com/Fox_(SSBU)/Edge_attack, https://www.ssbwiki.com/Marth_(SSBU)/Edge_attack, https://www.ssbwiki.com/Cloud_(SSBU)/Edge_attack, https://www.ssbwiki.com/Lucario_(SSBU)/Edge_attack: ledge option rules and frame examples.
- https://www.ssbwiki.com/Air_dodge, https://www.ssbwiki.com/Recovery, https://www.ssbwiki.com/Double_jump, https://www.ssbwiki.com/Helpless, https://www.ssbwiki.com/Tumbling, https://www.ssbwiki.com/Tether_recovery, https://www.ssbwiki.com/Tech, https://www.ssbwiki.com/Footstool_Jump, https://www.ssbwiki.com/Sacrificial_KO: recovery resources, tech rules, footstools, sacrificial KO rules.
- https://www.ssbwiki.com/Down_smash, https://www.ssbwiki.com/Down_tilt, https://www.ssbwiki.com/Fox_(SSBU), https://www.ssbwiki.com/Cloud_(SSBU), https://www.ssbwiki.com/Joker_(SSBU): moves that 2-frame, character notes.
- https://www.ssbwiki.com/Smasher:Light_(Connecticut), https://www.ssbwiki.com/Smasher:MkLeo, https://www.ssbwiki.com/Smasher:Sparg0: documented player tendencies.
- https://ultimateframedata.com/fox, https://ultimateframedata.com/marth, https://ultimateframedata.com/cloud, https://ultimateframedata.com/joker, https://ultimateframedata.com/byleth: aerial frames and physics stats (Byleth read, not cited).
- https://kuroganehammer.com/Smash4/Formulas: Smash 4 ledge intangibility formula.
- https://github.com/altf4/SmashBot and https://raw.githubusercontent.com/altf4/SmashBot/master/Tactics/edgeguard.py: reference edgeguard and reachability logic (Melee).
- https://dignitas.gg/articles/hugs-ledgetrapping-guide-for-super-smash-bros-ultimate, https://dignitas.gg/articles/blogs/smash/14080/lord-of-sword-a-guide-to-cloud-in-super-smash-bros-ultimate, https://dignitas.gg/articles/how-to-recover-in-super-smash-bros.-ultimate-a-guide-on-recovery-for-every-character: ledge trap answers, Cloud plan, recovery principles (read through a page summarizer).
- https://rangothemercenary.medium.com/smash-ultimate-tips-ledgetrapping-51f551c949aa, https://rangothemercenary.medium.com/smash-ultimate-tips-escaping-ledgetraps-from-the-ledge-b0f84453d6d9, https://rangothemercenary.medium.com/smash-ultimate-tips-tricks-overcoming-disadvantage-state-83659e25cdb1: ledge trap, escape and recovery advice (read through a page summarizer).
- https://thegamehaus.com/gaming/fighting-games/super-smash-bros-ultimate-how-to-edgeguard/2019/01/08/: onstage and offstage guarding, Ultimate trump claim (single source).
- https://supersmashbros.fandom.com/wiki/Ledge-Trumping: trump execution (community wiki).
- https://smashboards.com/threads/how-exactly-does-ledge-trumping-work.402609/: Smash 4 era trump frame claims, unverified for Ultimate (forum).
- https://smashboards.com/threads/ledge-trumps.465693/: Ultimate era mention of trumpstun (forum).
- https://eventhubs.com/news/2014/dec/31/ledge-grabbing-not-fully-invincible-super-smash-bros-wii-u-until-2nd-frame-methods-exploit-sonic: Wii U ledge invulnerability start.
- https://github.com/aevalmere/aevalrena (local read-only copy): `src/core/constants.ts`, `src/sim/ledge.ts`, `src/sim/index.ts`, `src/sim/physics.ts`, `src/sim/actions.ts`, `src/sim/footstool.ts`, `src/sim/hits.ts`, `src/characters/aeval/moves.ts`, `src/stages/*/geometry.ts`, `src/ai/aevalmere.ts`, `docs/SPEC.md`, `docs/CPU_AEVALMERE.md`, plus my probe scripts driving `stepGame`.
- https://www.youtube.com/playlist?list=PL4SzCzeORbSRRI72fLpdCCDI-SZIwqFyJ: playlist titles for Izaw's Art of Smash Ultimate series (titles listed with a playlist tool, no video watched).

Snippet only or not readable (not used as evidence):
- https://www.youtube.com/watch?v=n8ltbCMeotk, https://www.youtube.com/watch?v=p3wxtYRGp64 (fetch returned HTTP 429), https://www.youtube.com/watch?v=58TmXhbfYso, https://www.youtube.com/watch?v=NTdA4mBVBlY, https://www.youtube.com/watch?v=zAOFmyXARig: ledge trapping video titles seen in search results.
- https://smashboards.com/threads/2-framing-basics.455295/ and https://smashboards.com/threads/edge-guarding-offstage-as-fox-what-are-some-good-and-safe-options.398901/: returned HTTP 403, titles only.
