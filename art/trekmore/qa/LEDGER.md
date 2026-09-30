# Trekmore QA ledger (W2)

2026-09-30. Dev server on http://localhost:5183 (vite --port 5183 --strictPort). Local match,
P1 Trekmore (human, driven by trusted Playwright key events matching `src/input/defaults.ts`),
P2 Aeval (CPU, level 1 for the main sweep, level 7-8 for hit-reaction/counter/crit/fuzz phases),
both stages (Tidegate, Hearthmoor). Game time slowed to 0.25x (sometimes 0.5x) via the F4 tuner
panel so screenshots land on the intended frame; frame numbers below are sim frames from
`docs/TREKMORE_PLAN.md` section D / `art/trekmore/sheetmap.json` holds, not wall-clock.

**Console errors across the whole session: zero.** Failed requests: zero. Includes ~953 + ~951
random inputs (two 90s fuzz runs, see bottom) and a KO/respawn cycle.

No BROKEN animations found, so no sheetmap.json or code edits were made this pass. Gates:
`npm run typecheck` exit 0; `npm run test:sim` 128/128 pass (both run after the QA pass with no
diff, to confirm the baseline W2 inherited is clean).

## Legend

OK = reads correctly, hitbox lines up with the drawn swing where checked. ROUGH = readable but
has a concrete cosmetic issue (noted). BROKEN = wrong/missing/floating/flipped frames or a
hitbox not on the swing (none found). INCONCLUSIVE = the mechanic could not be confirmed
visually in this harness (noted why); not evidence of a defect.

## Ground normals

| Anim | Verdict | Screenshot | Note |
|---|---|---|---|
| jab | OK | jab.png | Clean forward slash, magenta trail, hit landed at the expected ~frame 7-9. |
| ftilt | OK | ftilt.png | Big readable crescent; P2 damage jumped from 0 to 15.6% at exactly this frame (hit lines up with the drawn swing). |
| utilt | ROUGH | utilt.png | At the frame13 hit window the pose reads close to idle, not a clear crescent; this is the front three-quarter source (`uspec_g_*`) plan risk G.1 (mixed camera angles) rather than a timing bug -- hitbox landed on the intended frame in `test:sim` (tkd1/tkd2), the *drawing* is just hard to read. |
| dtilt | OK | dtilt.png | Clear low magenta sweep near the ground. |
| dashatk | OK | dashatk.png | Lunging thrust with a trailing spark; reads well. |

## Smashes

| Anim | Verdict | Screenshot | Note |
|---|---|---|---|
| fsmash (tap) | OK | fsmash.png | Big crescent + white flash; P2 damage jumped by exactly 22% (D.3's uncharged value) at this frame. |
| fsmash (charged) | OK | fsmash_charged.png | Visibly larger arc than the tap version (full-charge chord held 60f then released); redone once after the first take whiffed because the CPU had 4 real seconds to reposition while charging (test-harness artifact, not a game issue -- see Process notes). |
| usmash (tap) | ROUGH | usmash.png | Pose reads as a generic forward-diagonal slash, not an obvious vertical sword column. Front-view source risk (G.1) again. |
| usmash (charged) | ROUGH | usmash_charged.png | Shows a clean vertical blade silhouette, but pointing down near his feet rather than up as a "column" -- bigger and more distinct than the tap version, still a camera-angle read issue, not a broken frame. |
| dsmash (tap/arc) | OK | dsmash.png | Compact low crouch with a magenta glow at the arc hit (frame 17). The move's second "eruption" hit (frame 24) was not separately screenshotted; flagged for the balance worker below. |
| dsmash (charged) | OK | dsmash_charged.png | Clearly bigger arc than the tap version; first take actually caught the *respawn drop* (Trekmore had been KO'd mid-charge by the CPU) and was redone with the CPU frozen for a clean capture. |

## Aerials

| Anim | Verdict | Screenshot | Note |
|---|---|---|---|
| nair | OK | nair.png | Clean purple ring, reads as the "ring spin" the plan describes. |
| fair | ROUGH | fair.png | Blade trail is small/faint at the hit frame compared to the other aerials; still recognisable as an attack pose. |
| bair | OK | bair.png | Readable trailing slash behind him (source faces left, no mirror flag per sheetmap -- confirmed the body actually turns). |
| uair | OK | uair.png | Big, clean overhead crescent. |
| dair | OK | dair.png | Clear downward stab shape near his feet. |

## Specials

| Anim | Verdict | Screenshot | Note |
|---|---|---|---|
| nspecial (tap) | ROUGH | nspecial.png | The thrown sword reads as a small pink smear at 55px; hard to read as a distinct projectile in a still frame (it's more legible in motion). |
| nspecial (full charge) | OK | nspecial_charge.png | Clearly larger, more solid blade shape than the tap version. |
| nspecial recall | OK | nspecial_recall.png | Excellent capture: the stationary sword (left) and Trekmore's dark violet-glow silhouette reappearing at it (right) are both clearly visible -- the "teleport reappear" key frame the brief asked for. |
| crescent-lock rule (2nd nspecial while the sword is out teleports, not a 2nd throw) | OK | nspecial_recall.png | Confirmed behaviourally: second Special press while the tap sword was still alive triggered the recall teleport, not a second throw (also pinned by `test:sim` tk12/tkd5). |
| sspecial (ground) | ROUGH | sspecial.png | Reads as a large dark smear/blob more than a crescent. This matches the cut notes' documented shadow-smoke aesthetic (dissolve cells "come out as solid dark smoke blobs, which is how they read at 55px"), so it looks intentional rather than a cutter defect, but it is the blobbiest of the shadow-themed moves and worth a second look from W0-art/W1-colours. Backstrike hit landed (P2 damage +25%ish observed cumulative). |
| sspecial (air) | OK | sspecial_air.png | Reads more like a defined crescent+smear than the ground version; hit confirmed (P2 +13% at this frame, matches D.5 backstrike 13 damage). |
| uspecial (rise) | ROUGH | uspecial_rise.png | Subtle small pink trail around him mid-rise; not very dramatic, easy to miss against the sky backdrop. |
| uspecial (swing) | OK | uspecial_swing.png | Dramatic, clean crescent silhouetted against the moon -- the best single "big swing" frame captured this pass. |
| dspecial (whiff / parry stance) | OK | dspecial_whiff.png | Clear guard/parry stance, reads correctly inside the counter window. |
| dspecial vs an incoming attack (counter) | INCONCLUSIVE | counter_try_15.png, counter_try_18.png | Ran ~24 repeated dspecial attempts against a level 8 CPU over ~16s; P2 (attacker) ended the session having taken chip damage consistent with at least one counter repay, but the counter flash / 4-frame screen dim (C.3) is too short-lived (4 frames) to reliably land in a periodic screenshot poll in this harness. Not confirmed broken -- recommend a debug hook (e.g. a SimEvent counter listener exposed to `window`) if the lead wants a certain capture. |

## Grab kit

| Anim | Verdict | Screenshot | Note |
|---|---|---|---|
| grab | OK | grab.png | Clean shadow-hand reach pose. Standing/dash grab reach is short (D.6: x20 r11 / x28 r12), so whiffed repeatedly from mid-stage distance in testing until Trekmore closed to near-adjacent range -- not a bug, just a short-range grab by design. |
| pummel | OK | pummel.png | Same held pose, damage ticking (+2.2%, matches D.6). |
| fthrow | OK | fthrow.png | Big white impact flash + magenta swirl, damage +13.2% (~matches D.6's 11-14 range with echo/variance). |
| bthrow | OK | bthrow.png | Same impact language as fthrow, facing flipped correctly, +12.5% damage (matches D.6's 12.5). |
| uthrow | OK | uthrow.png | Aeval held up above his shoulder before launch; first capture attempt was timed a few frames too late and caught her already off-screen after launch (redone earlier in the throw window). |
| dthrow | OK | dthrow.png | Both fighters low and close together, clear "combo starter" read. |

## Taunts, shield, dodges

| Anim | Verdict | Screenshot | Note |
|---|---|---|---|
| taunt | OK | taunt.png | Plain, appropriately restrained standing pose. |
| taunt2 (clone summon) | ROUGH | taunt2.png | Renders as a solid flat magenta/purple silhouette rather than a detailed figure. Matches the cut notes' documented limitation for `concept_a` summon cells ("hollow outlines; pockets of 60px or more keyed inside them"), so this looks like an accepted tradeoff, not a new cutter bug -- flagging so W0-art/the lead can decide if it needs a pixler pass. |
| taunt3 | OK | taunt3.png | Readable standing pose with a hood/shoulder detail. |
| shield | ROUGH | shield.png | No shield bubble overlay visible in the captured frame, and the underlying pose (`parry_parry_0`) reads more like a lunging stance than a static guard. Worth the render team double-checking the bubble draws for Trekmore the same way it does for Aeval. |
| spotDodge | ROUGH | spotDodge.png | Dissolve reads as a flat dark blob (same intentional shadow-smoke language as taunt2/roll/airDodge per the cut notes); readable as "he's dissolving" but not very detailed. |
| roll | OK | roll.png | Teleport-silhouette reads reasonably well as a mobility dodge. |
| airDodge | OK | airDodge.png | Same teleport-silhouette language as roll, consistent. |

## Ledge

| Anim | Verdict | Screenshot | Note |
|---|---|---|---|
| ledgeHang | ROUGH | ledgeHang.png | Correctly triggered (auto-caught while falling with no away-input, per SPEC 4.5), but the capture landed at a wide camera distance that makes him very small/dark against the platform edge -- inconclusive on fine detail, not a confirmed defect. |
| ledgeClimb | ROUGH | ledgeClimb.png | Same small/dark-at-distance caveat as ledgeHang. |
| ledgeatk | OK | ledgeatk.png | Clear purple crescent slash off the ledge, easily the most legible of the three ledge captures. |

## Hit reactions, tumble, tech, downed, KO

| Anim | Verdict | Screenshot | Note |
|---|---|---|---|
| hitLight (hitstun) | OK | hitLight_live.png | Readable pink hit-flash reaction pose. |
| tumble | OK | tumble_live.png | Readable mid-air tumbling silhouette with hit sparkle fx. |
| tech | ROUGH | tech_live.png | Correctly entered on a well-timed Shield press before landing; capture is small/distant (wide camera between two far-apart fighters), pose itself looks like a normal recovery stance. |
| downed | ROUGH | downed_live.png | Reads as upright/kneeling with a raised arm rather than "lying down". This matches the already-documented A.5 pixler gate failure (`downed` generation failed on hue and ink-outline checks, "the fallback kneel uspec_g_18/19 ships") -- a known, already-decided limitation, not a new defect. |
| getUp | NOT CAPTURED | -- | The poll loop caught downed -> getupatk (attack pressed) every time it triggered; a plain (non-attack) getUp was not independently captured before the match ended in a KO. Low risk (same `uspec_g_19`/`loco_idle_0` frames as the getupatk tail), flagged as a gap rather than judged. |
| getupatk | OK | getupatk.png | Sword swing near his feet, reads correctly for a getup attack. |
| KO / dead | OK | ko_live.png | Pink burst fx as he's launched off-stage, reads clearly as a KO given the distance. |

## Echo, crit, colours, screens

| Check | Verdict | Screenshot | Note |
|---|---|---|---|
| echo shadow (dashatk) | OK | echo_dashatk_check.png | A clearly separate, darker secondary silhouette is visible behind/left of the owner mid-swing -- the shadow echo is working and reads as intended. |
| echo shadow (ftilt) | INCONCLUSIVE | echo_check.png | No clearly distinguishable second silhouette against the busy stage background at this frame; may simply be harder to see on this particular background/pose than on dashatk's open-ground shot. Not a confirmed miss -- `test:sim` (tk1, tkd4) already proves the echo hits land on schedule. |
| crit rate | INCONCLUSIVE | -- | Spammed jab (~8 landed hits total across a sampling run) against a stationary CPU and tracked HUD percent deltas; deltas were muddied by the echo's own delayed hit landing in the same sampling window, so no delta cleanly isolated a 1.3x crit multiple. Did not visually confirm the bigger flash/shake in this pass. `test:sim` tk4/tk5 already statistically confirm the crit rate (0.131 of 2000 at chance 0.12, exactly 1.3x damage) and echo crit rate (0.0665 of 4000, half chance) in the sim, so the mechanic itself is verified; this row is about the screenshot/visual side only. |
| counter flash + screen dim | INCONCLUSIVE | see dspecial row above | Not caught on screenshot; see the dspecial vs incoming attack row. |
| colour: red | OK | variant_red.png | Reads clearly as red/crimson armour. |
| colour: white | OK | variant_white.png | Reads as a pale silver knight with dark joints, matches the plan's intent. |
| colour: gold | OK | variant_gold.png | Reads as polished gold/bronze metal, highlights and shading both visible. |
| HUD | OK | hud.png | Bust, percent, stocks all correct for both fighters. |
| Movelist | OK | movelist.png | "TREKMORE P1 CRIT 12%" header correct; echo damage annotations ("+2.3%" etc.), chord input labels (G+J, G+W, G+S) and "Shadow repeats it." notes all present and correct. Minor: the damage/input columns run off the right edge of the panel at this test window's width -- likely just the harness's small viewport, worth a glance at a normal window size. |
| Results screen | OK | results_screen.png | Split win/lose panels, stats (stocks, KOs, falls, SDs, damage given/taken, peak damage, max combo, most-used move, grabs/throws/shield breaks/ledge grabs) all populated and readable. |
| Hearthmoor stage | OK | hearthmoor_boot.png | Renders correctly with Trekmore, no clipping, no console errors. |

## Fuzz (90s each, zero console errors on both)

- Trekmore (human, random inputs) vs Aeval (CPU level 7), Tidegate: ~953 random key actions over 90s, 0 console errors, 0 failed requests.
- Aeval (human, random inputs) vs Trekmore (CPU level 7), Tidegate: ~951 random key actions over 90s, 0 console errors, 0 failed requests.

## Process notes (for whoever re-runs this)

- Standing/dash grab reach is short; approaching a stationary CPU needs roughly 80-100 sim
  frames of continuous dash/run before a grab connects at Tidegate's default spawn spacing.
  Blind fixed-distance dashes are unreliable (they either fall short or overshoot past the
  target, since fighters do not body-block each other); a checkpoint loop that tries a grab
  every ~40 frames while holding the direction is far more reliable.
- The F4 tuner's live readout (`f.action`/percent/hitstun`) only updates while the panel is
  visible; closing it freezes the last text. For point-in-time reads, open/read/close in one
  shot; for anything that needs to react to a state change in near-real-time (hit reactions,
  crit sampling, the counter hunt), leave the panel open for that whole phase and read the DOM
  text directly (it costs the right 300px of the screenshot, worth it for the reliability).
- "Freeze CPU" (also in the F4 panel) gives the CPU `ZERO_INPUT` every frame without pausing
  the sim; it is the safe way to hold a charge (fsmash/usmash/dsmash/nspecial) for multiple
  real seconds without the CPU landing free hits or KOing Trekmore mid-charge.
