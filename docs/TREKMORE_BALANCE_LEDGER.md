# Trekmore balance ledger

One entry per balance loop. Aeval's numbers are frozen in these loops (plan section F, Wave 4). Each loop records every number
changed with its value before and after, why, and the calibrate tables after the change. Loops 1 and later are CPU match loops
(`tk.vsAeval.7`, plan F); loop 0 is calibrate only.

## Loop 0 (calibrate)

Date 2026-09-30. Method: `npm run calibrate -- --char trekmore --victim aeval` and the reverse (Tidegate, centre stage, fresh
victim holding nothing, crits off). Aeval's KO percents are the yardstick (Aeval on Aeval: fsmash 121 / full 79, usmash 134 / 90,
dsmash 134 / 92, fair 135, bair 124, uair 220; see `docs/TUNING.md`). Damage per hit is unchanged everywhere (1.4x to 1.6x Aeval);
every change is knockback growth, base knockback, launch angle, echo timing or the counter cap. No startup, active window, endlag
or landing lag changed.

Targets from the loop card, against Aeval from centre, uncharged (full charge in brackets): fsmash 95 (62), usmash 105 (70), dsmash
110 (75), fair 120, bair 105, uair 130, dair spike as is, nair no kill below 200, counter at min damage 130 and at max damage 60, tilts
130 to 170, sspecial backstrike 110, nspecial sword full charge 120.

### Changes

| Move | Field | Before | After | KO before | KO after | Why |
|---|---|---|---|---|---|---|
| fsmash | kbg | 30 | 35 | 118 (72) | 96 (56) | Uncharged target 95. See note 1 on the charged number. |
| usmash | kbg (all circles) | 76 | 63 | 83 (48) | 107 (65) | Killed 20 percent early. |
| dsmash | kbg arc, front eruption, back eruption | 68, 70, 64 | 37, 38, 35 | 47 (22) | 110 (69) | The earliest killer in his kit; one factor (0.54x) on all three so the arc and eruption keep their ratio. |
| fair | kbg (both circles) | 62 | 42 | 71 | 119 | Killed earlier than any Aeval smash. |
| bair | kbg (both circles) | 64 | 53 | 81 behind (151 harness) | 104 behind (188 harness) | See note 2 on the placement. |
| uair | bkb, kbg (all circles) | 30, 82 | 20, 95 | 141 | 128 | Echo fix (below), then kbg to the 130 target. |
| uair | echo delayFrames | 10 | 5 | | | Echo fix. |
| dtilt | angle, bkb, kbg | 75, 36, 90 | 10, 20, 100 | 161 | 162 | Echo fix (below); kbg keeps the KO in the tilt band. |
| dtilt | echo delayFrames, offsetX | 8, -6 | 4, 20 | | | Echo fix. |
| ftilt | kbg | 58 | 48 | 110 | 139 | Under the 130 to 170 tilt band. |
| utilt | kbg | 92 | 98 | 177 | 165 | Just over the tilt band. |
| sspecial | kbg | 60 | 48 | 81 | 108 | Backstrike target 110. |
| nspecial | shadowSword charged kbg | 62 | 43 | 173 (73) | 173 (119) | Full charge target 120; the tap is unchanged. |
| dspecial | counter maxDamage | 30 | 20 | 46 (0) | 130 (57) | At the 30 cap the counter killed a fresh Aeval at 0 percent. See note 3. |
| dspecial | counter hitboxes bkb, kbg | 60, 70 | 20, 61 | | | The floor (10, a countered jab) now kills at 130 and the cap at 57. |

Left alone: jab (none), dashatk 174, nair 275 (no kill below 200), dair (spike; none from centre, as before), uspecial (none),
ledgeatk 166, getupatk 162, throws, attributes, crit.

Notes:

1. fsmash charged. With 22 damage the full-charge hit (x1.4 damage) always kills about 40 percent under the uncharged hit, whatever the
   bkb and kbg: both percents solve the same knockback threshold, and only the damage term differs. The search over kbg (bkb 26)
   gave 30: 118 / 72, 35: 96 / 56, 36: 93 / 53, 40: 80 / 44. The uncharged target was kept, so full charge is 56, not 62. Aeval's own
   fsmash has the same 42-point gap (121 / 79). Meeting both would need less damage, which this loop does not touch. The same holds for
   usmash (107 / 65) and dsmash (110 / 69), a little under their charged targets of 70 and 75.
2. bair placement. The harness always faces the attacker right and places the victim in front or overhead, so it measures bair from
   an overhead circle (gap 0, lift 44), not the thrust. A separate probe (Trekmore 30 px up facing left, a grounded Aeval 40 px behind
   him) measures the real use: 81 before, 104 after. The harness row moved from 151 to 188 with the same change.
3. Counter scale. Scale stays 1.3, floor 10, cap 20. A countered Aeval jab (3 x 1.3 = 3.9) repays the floor and kills at 130; a
   countered Aeval ftilt (8 x 1.3 = 10.4) repays 10.4 (selftest tkd7); a countered uncharged Aeval fsmash (15 x 1.3 = 19.5) kills at 59
   (probe with min and max set to 10.4 and 19.5: 125 and 59); anything over 15.4 raw hits the cap and kills at 57.
4. Echo re-launch. An echo that lands on a victim already in flight replaces the launch with its own (half damage, same bkb and kbg), so
   an echo that lands too early can save the victim: uair with echo delay 4 read KO 171 (bkb 20, kbg 95) against 128 at delay 5.
   Delay 5 is the shortest that keeps the echo from lengthening the kill. Worth knowing for loop 1 when the echo is a lever.
5. `src/sim/selftest.ts` tkd7 computes its expected repay as `Math.min(30, ...)`. The ftilt it counters repays 10.4, so the new cap
   does not change the result and the test passes untouched. The literal 30 is stale but not broken, so it was left as is.

### Echo probes

dtilt: Trekmore on the ground at x -20 facing right, a standing Aeval at every spacing from 16 to 64 px (centre to centre) in 4 px
steps, `startMove` dtilt, count the owner hit and the echo hit (the hit event's `echo` flag). uair: Trekmore airborne 30 px up with
vy 0 or -3 (a jump), Aeval airborne and still at dx -16 to 16 (8 px steps) and 40 to 80 px above him (10 px steps), `startMove` uair.
The pattern is the one W1-char used for the jab echo (selftest tkd4). Counts are echo hits over owner hits.

| Probe | 0 percent | 30 | 60 | 90 |
|---|---|---|---|---|
| dtilt before | 0 / 11 | 0 / 11 | 0 / 11 | 0 / 11 |
| dtilt after | 11 / 11 | 10 / 11 | 7 / 11 | 5 / 11 |
| uair before | 25 / 41 | 0 / 41 | 0 / 41 | 0 / 41 |
| uair after | 36 / 41 | 27 / 41 | 7 / 41 | 0 / 41 |
| jab after (unchanged, reference) | 11 / 12 | 9 / 12 | 10 / 12 | 9 / 12 |

dtilt: the plan's 75 degree launch at bkb 36 put 82 kb on a fresh Aeval (tumble) and carried her about 40 px away before the echo's
frame. Lowering bkb alone (15 to 25) still lifted her out of the low sweep; at 30 to 50 degrees she flew clear sideways. At 10
degrees, under 80 kb, the sim slides a grounded victim along the floor (`GROUNDED_ANGLE` 15), and the echo, 4 frames behind and 20 px
ahead of where he started, reaches her. At higher percents the kb passes 80 and she launches low and flat; the echo still catches the
nearer spacings.

uair: the echo latches where he started the move and replayed 10 frames late, by which time a victim above 0 percent had risen out of
it. bkb 20 lowers the early launch and delay 5 brings the echo in before she clears it.

### Calibrate after loop 0

Trekmore on Aeval (`npm run calibrate -- --char trekmore --victim aeval`):

```
move        gap  lift    ko %  full ko %  kb at 100
---------------------------------------------------
jab          40     0    none          -       52.8
ftilt        40     0     139          -       86.7
utilt         0     0     165          -      156.4
dtilt        40     0     162          -      127.3
dashatk      40     0     174          -      119.6
fsmash       40     0      96         56      108.6
usmash        0     0     107         65      167.2
dsmash       40     0     110         69      101.7
nair         26     0     275          -       92.1
fair         40     0     119          -       96.9
bair          0    44     188          -       80.5
uair         40     0     128          -      148.0
dair         26     0    none          -      175.3
nspecial     40     0     173        119       79.3
sspecial     40     0     108          -      109.2
uspecial      0    44    none          -       76.9
dspecial     40     0     130         57       90.9
ledgeatk     40     0     166          -       77.8
getupatk     40     0     162          -       79.8
```

Aeval on Trekmore (`npm run calibrate -- --char aeval --victim trekmore`), unchanged by this loop (Aeval is frozen and Trekmore's
weight and hurtbox did not change):

```
move        gap  lift    ko %  full ko %  kb at 100
---------------------------------------------------
jab          40     0    none          -       40.9
ftilt        40     0     234          -       64.9
utilt        26     0     229          -      111.0
dtilt        26     0     254          -      104.8
dashatk      40     0     228          -       81.0
fsmash       40     0     145         97       87.2
usmash       26     0     160        109      133.3
dsmash       40     0     164        114       84.7
nair         26     0    none          -       65.0
fair         40     0     161          -       81.9
bair          0     0     148          -       92.0
uair         26     0     259          -       97.1
dair         26     0    none          -      161.7
nspecial     40     0    none        133       31.9
sspecial     40     0     262          -       63.2
uspecial     26     0     154          -      149.4
dspecial     40     0     230          -      137.2
ledgeatk     40     0     254          -       62.3
getupatk     40     0     252          -       63.9
```

Trekmore on Trekmore (`npm run calibrate -- --char trekmore`), for reference:

```
move        gap  lift    ko %  full ko %  kb at 100
---------------------------------------------------
jab          40     0    none          -       50.6
ftilt        40     0     167          -       80.8
utilt        26     0     142          -      145.9
dtilt        40     0     197          -      117.9
dashatk      40     0     121          -      112.0
fsmash       40     0     118         72      100.6
usmash       26     0     129         81      154.2
dsmash       40     0     134         87       94.9
nair         40     0    none          -       85.7
fair         40     0     143          -       90.0
bair          0     0     106          -      114.1
uair         40     0     209          -      136.4
dair         26     0    none          -      162.6
nspecial     40     0     207        145       75.2
sspecial     40     0     131          -      102.9
uspecial      0    44    none          -       75.7
dspecial     40     0     156         71       84.7
ledgeatk     40     0     198          -       72.9
getupatk     40     0     194          -       74.9
```

Trekmore on Aeval before this loop (W1-char's numbers, for comparison):

```
move        gap  lift    ko %  full ko %  kb at 100
---------------------------------------------------
jab          40     0    none          -       52.8
ftilt        40     0     110          -      100.2
utilt         0     0     177          -      149.2
dtilt        40     0     161          -      132.6
dashatk      40     0     174          -      119.6
fsmash       40     0     118         72       96.8
usmash        0     0      83         48      195.1
dsmash       40     0      47         22      161.7
nair         26     0     275          -       92.1
fair         40     0      71          -      131.6
bair          0    44     151          -       91.8
uair         40     0     141          -      140.5
dair         26     0    none          -      175.3
nspecial     40     0     173         73       79.3
sspecial     40     0      81          -      126.5
uspecial      0    44    none          -       76.9
dspecial     40     0      46          0      141.4
ledgeatk     40     0     166          -       77.8
getupatk     40     0     162          -       79.8
```

### Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run test:sim` | exit 0, 128 of 128 pass |
| `npm run test:net` | exit 0, nettest PASS |
| `npm run calibrate` (Aeval on Aeval) | identical to the `docs/TUNING.md` table, every row |

### Next (loop 1)

Run `tk.vsAeval.7` at 100 paired matches as plan F Wave 4 describes. Levers if Trekmore wins too much: fsmash kbg (the largest single
kill), the counter cap, and the dtilt echo delay (4 is generous). If he loses too much: fair kbg back toward 45, bair toward 56.

## Loops 1 to 4 (CPU matches)

Date 2026-09-30. Driver: `npx --yes tsx src/ai/eval/diag/trekbalance.ts` (new file, parallel over 11 child processes,
deterministic). Trekmore (player a) against Aeval (player b) at the same UI level on the new engine, 3 stocks, frame cap 16200,
paired seeds with side swap (seed tag `UIn|UIn|trekbal|s3`), stages alternating per seed pair (Tidegate, Hearthmoor). UI 7 over
100 matches (50 seeds, both sides), UI 5 over 60, UI 10 over 40; a timeout counts half. Columns: KO % is the victim's percent on
the frame before each KO (T on A: Trekmore's KOs on Aeval); damage per opening is all damage one side dealt over its openings
(an opening is a hit or grab on a victim who was not in hitstun, tumble or grabbed the frame before); SDs are self-destructs as
the sim credits them (no hit within the KO credit window), and a Trekmore SD is blamed on the sword recall or on dair when either
started within 180 frames before it. KO share by move is the source of Trekmore's last hit on Aeval before a credited KO, echo and
sword hits folded into their move. "State when Aeval opened him" is Trekmore's action on the frame before each Aeval opening
(attacks split by the move's first and last active frame). A rerun of the same numbers reproduces every count exactly (the final
run below equals the loop 3 run).

Trekmore's dair has no dive (plan D.4), so a dair self-destruct can only come from drifting off with it; there were none at UI 7
in any loop, and at most one at UI 5.

Startup frames were not a lever: every first active frame is pinned to a drawn slash frame (selftest tkd1, `TK_HIT_FRAMES`, and
the sheetmap holds sum to totalFrames), so a startup or totalFrames change would put the sim and the art out of step.

### Loop 1

Measured on the loop 0 numbers:


| UI | n | W-L-T | score | Wilson 95% | KO % T on A | KO % A on T | dmg/opening T | dmg/opening A | openings T/A | T SDs (dair/recall/other) | A SDs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 7 | 100 | 53-47-0 | 53/100 (53%) | 0.433 to 0.625 | 154 | 174 | 15.3 | 10.6 | 2837/4241 | 2 (0/2/0) | 2 |
| 5 | 60 | 46-14-0 | 46/60 (77%) | 0.646 to 0.856 | 153 | 180 | 14.3 | 9.2 | 1882/2757 | 4 (0/0/4) | 2 |
| 10 | 40 | 6-34-0 | 6/40 (15%) | 0.071 to 0.291 | 153 | 185 | 16.0 | 14.1 | 755/1561 | 0 (0/0/0) | 1 |

UI 7: Trekmore KOs by move: uair 49 (20%), usmash 45 (19%), utilt 29 (12%), sspecial 22 (9%), fsmash 19 (8%), bair 15 (6%), dashatk 14 (6%), dtilt 12 (5%), uspecial 11 (5%), dspecial 9 (4%)
UI 7: Trekmore move usage: nspecial 1683 (19%), sspecial 1409 (16%), dashatk 747 (8%), dair 717 (8%), nair 664 (7%), fsmash 627 (7%), usmash 524 (6%), uair 513 (6%), fair 375 (4%), dspecial 292 (3%), grab 232 (3%), uspecial 220 (2%)
UI 7: Trekmore SD causes: recall 2 (100%)

UI 5: Trekmore KOs by move: uair 36 (22%), usmash 29 (18%), utilt 24 (15%), fsmash 20 (12%), dtilt 10 (6%), sspecial 9 (6%), bthrow 8 (5%), dashatk 5 (3%), dspecial 5 (3%), dair 4 (2%)
UI 5: Trekmore move usage: nspecial 870 (15%), sspecial 764 (13%), fsmash 654 (11%), ftilt 426 (7%), nair 410 (7%), uair 354 (6%), dashatk 331 (6%), usmash 320 (5%), dair 261 (4%), fair 259 (4%), dsmash 216 (4%), dtilt 203 (3%)
UI 5: Trekmore SD causes: other:uspecial 4 (100%)

UI 10: Trekmore KOs by move: uair 13 (23%), usmash 13 (23%), dspecial 6 (11%), sspecial 6 (11%), utilt 6 (11%), fsmash 4 (7%), bair 3 (5%), dashatk 2 (4%), dtilt 2 (4%), nair 1 (2%)
UI 10: Trekmore move usage: nspecial 578 (20%), sspecial 494 (17%), dair 353 (12%), nair 247 (9%), uair 198 (7%), dspecial 150 (5%), fair 146 (5%), dashatk 141 (5%), usmash 130 (5%), fsmash 119 (4%), bair 73 (3%), uspecial 71 (2%)
UI 10: Trekmore SD causes: none

UI 10 only, rerun with the opening-state line added (identical match counts):

UI 10: Trekmore state when Aeval opened him: land 164 (11%), nspecial-startup 131 (8%), dair-startup 120 (8%), air(air) 110 (7%), sspecial-startup 108 (7%), uair-startup 80 (5%), usmash-startup 64 (4%), techRoll 60 (4%), sspecial-endlag 59 (4%), dair-active 47 (3%), fsmash-startup 47 (3%), nair-startup 46 (3%), fair-startup 41 (3%), dspecial-active 39 (2%)

Reading. UI 7 already sits in the band (53, Wilson 0.433 to 0.625) and no move passes 40 percent of his KOs (uair 20). UI 5 (77)
and UI 10 (15) are both outside 35 to 65, in opposite directions: he beats the weaker Aeval and loses to the god. Damage per
opening favours him at every level (14 to 16 against 9 to 14) and he dies later (174 to 185 against 153); the god gap is
openings, 1561 to 755, twice his, and the god Aeval converts them better (14.1 per opening against 10.6 at UI 7). At UI 10 Aeval
opens him most in landing lag (11 percent), nspecial startup, dair startup (the god throws dair on 12 percent of his moves) and
shadow step startup. Hypothesis: shaving the commitments the god punishes (landing, step startup) lifts UI 10 more than UI 5,
and a small cut on his top KO move keeps UI 7 flat.

| Move | Field | Before | After | Metric that motivated it |
|---|---|---|---|---|
| dair | landingLag | 24 | 18 | landing is the top UI 10 opening state (11 percent); dair is 12 percent of the god's starts |
| sspecial | shadowStep.invuln start | 6 | 3 | sspecial startup is 7 percent of UI 10 openings |
| uair | kbg (all three circles) | 95 | 90 | uair is his top KO move at every level (20 to 23 percent); KO 128 to 137 |

Gates: cache regenerated (`--check` fresh), test:sim 128 of 128.

### Loop 2


| UI | n | W-L-T | score | Wilson 95% | KO % T on A | KO % A on T | dmg/opening T | dmg/opening A | openings T/A | T SDs (dair/recall/other) | A SDs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 7 | 100 | 55-45-0 | 55/100 (55%) | 0.452 to 0.644 | 159 | 178 | 15.2 | 10.6 | 2929/4366 | 2 (0/2/0) | 4 |
| 5 | 60 | 47-13-0 | 47/60 (78%) | 0.664 to 0.869 | 153 | 177 | 14.2 | 9.1 | 1882/2567 | 8 (0/0/8) | 1 |
| 10 | 40 | 7-33-0 | 7/40 (18%) | 0.087 to 0.320 | 163 | 185 | 15.7 | 14.0 | 825/1550 | 1 (0/0/1) | 0 |

UI 7: Trekmore KOs by move: usmash 51 (21%), uair 47 (20%), utilt 24 (10%), dspecial 18 (8%), fsmash 18 (8%), uspecial 14 (6%), bair 12 (5%), dtilt 12 (5%), sspecial 11 (5%), dashatk 10 (4%)
UI 7: Trekmore move usage: nspecial 1742 (19%), sspecial 1522 (16%), dashatk 729 (8%), dair 721 (8%), nair 711 (8%), fsmash 651 (7%), usmash 536 (6%), uair 455 (5%), fair 391 (4%), dspecial 329 (4%), grab 239 (3%), uspecial 230 (2%)
UI 7: Trekmore SD causes: recall 2 (100%)
UI 7: Trekmore state when Aeval opened him: air(air) 463 (11%), land 401 (9%), nspecial-startup 326 (7%), fsmash-startup 296 (7%), dair-startup 216 (5%), usmash-startup 206 (5%), idle 168 (4%), sspecial-startup 158 (4%), dashatk-startup 154 (4%), dash 109 (2%), sspecial-endlag 108 (2%), grab 98 (2%), roll 90 (2%), uair-startup 77 (2%)

UI 5: Trekmore KOs by move: uair 29 (18%), usmash 29 (18%), utilt 28 (18%), dtilt 15 (9%), dashatk 11 (7%), sspecial 11 (7%), bthrow 9 (6%), fsmash 8 (5%), dspecial 6 (4%), uspecial 4 (3%)
UI 5: Trekmore move usage: nspecial 899 (15%), sspecial 803 (13%), fsmash 716 (12%), ftilt 433 (7%), nair 404 (7%), dashatk 353 (6%), usmash 323 (5%), uair 316 (5%), fair 277 (5%), dair 255 (4%), jab 217 (4%), utilt 216 (4%)
UI 5: Trekmore SD causes: other:uspecial 4 (50%), other:fsmash 3 (38%), other:uair 1 (13%)
UI 5: Trekmore state when Aeval opened him: air(air) 260 (10%), land 231 (9%), fsmash-startup 227 (9%), nspecial-startup 202 (8%), idle 163 (6%), ftilt-startup 135 (5%), dash 101 (4%), dashatk-startup 73 (3%), sspecial-startup 73 (3%), grab 65 (3%), fsmash-endlag 61 (2%), dtilt-startup 60 (2%), turn 55 (2%), roll 47 (2%)

UI 10: Trekmore KOs by move: uair 14 (22%), usmash 9 (14%), sspecial 8 (13%), utilt 6 (10%), dspecial 5 (8%), fair 5 (8%), bair 4 (6%), fsmash 4 (6%), bthrow 2 (3%), dair 2 (3%)
UI 10: Trekmore move usage: nspecial 592 (20%), sspecial 539 (18%), dair 341 (12%), nair 252 (9%), uair 178 (6%), fair 164 (6%), dashatk 150 (5%), fsmash 149 (5%), usmash 137 (5%), dspecial 126 (4%), uspecial 73 (2%), bair 69 (2%)
UI 10: Trekmore SD causes: other:uspecial 1 (100%)
UI 10: Trekmore state when Aeval opened him: dair-startup 146 (9%), land 139 (9%), nspecial-startup 127 (8%), air(air) 121 (8%), sspecial-startup 88 (6%), usmash-startup 68 (4%), fsmash-startup 67 (4%), uair-startup 67 (4%), techRoll 64 (4%), sspecial-endlag 61 (4%), dspecial-active 46 (3%), roll 40 (3%), fair-startup 34 (2%), dair-active 31 (2%)

Reading. UI 7 55, UI 5 78, UI 10 18 (one more win in 40). Every move stayed under 40 percent. The changes moved all three levels
by one or two matches, inside the noise of 40 and 60 matches. At UI 5 he leans on fsmash (11 percent of his starts; 5 at UI 10)
and fsmash startup is where the UI 5 Aeval opens him most, so a landed read pays well there; at UI 10 dair startup and landing are
still the top openings.

| Move | Field | Before | After | Metric that motivated it |
|---|---|---|---|---|
| fsmash | damage (all circles) | 22 | 19 | fsmash is 11 percent of his UI 5 starts against 5 at UI 10; less paid per read at the low level |
| fsmash | kbg (all circles) | 35 | 40 | keeps the KO in place after the damage cut: 96 to 98 uncharged, 56 to 59 charged (calibrate; damage 19 with kbg 38 read 105) |
| dair | landingLag | 18 | 14 | landing and dair startup still the top UI 10 openings |

Gates: cache regenerated (`--check` fresh), test:sim 128 of 128.

### Loop 3


| UI | n | W-L-T | score | Wilson 95% | KO % T on A | KO % A on T | dmg/opening T | dmg/opening A | openings T/A | T SDs (dair/recall/other) | A SDs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 7 | 100 | 54-46-0 | 54/100 (54%) | 0.443 to 0.634 | 160 | 183 | 15.0 | 10.3 | 3021/4580 | 1 (0/1/0) | 6 |
| 5 | 60 | 46-14-0 | 46/60 (77%) | 0.646 to 0.856 | 157 | 184 | 14.3 | 9.0 | 1917/2748 | 5 (0/0/5) | 2 |
| 10 | 40 | 4-36-0 | 4/40 (10%) | 0.040 to 0.231 | 153 | 179 | 15.5 | 13.9 | 763/1545 | 0 (0/0/0) | 1 |

UI 7: Trekmore KOs by move: uair 47 (20%), usmash 34 (14%), utilt 22 (9%), sspecial 19 (8%), dspecial 17 (7%), fsmash 17 (7%), dashatk 16 (7%), bthrow 14 (6%), uspecial 13 (5%), dtilt 12 (5%)
UI 7: Trekmore move usage: nspecial 1777 (19%), sspecial 1597 (17%), dashatk 791 (8%), dair 732 (8%), nair 717 (7%), fsmash 629 (7%), usmash 561 (6%), uair 451 (5%), fair 406 (4%), dspecial 357 (4%), grab 274 (3%), uspecial 250 (3%)
UI 7: Trekmore SD causes: recall 1 (100%)
UI 7: Trekmore state when Aeval opened him: air(air) 458 (10%), land 458 (10%), nspecial-startup 323 (7%), fsmash-startup 298 (7%), usmash-startup 246 (5%), dair-startup 203 (4%), sspecial-startup 184 (4%), idle 164 (4%), dashatk-startup 145 (3%), uair-startup 108 (2%), sspecial-endlag 105 (2%), roll 102 (2%), grab 95 (2%), dash 93 (2%)

UI 5: Trekmore KOs by move: uair 37 (23%), usmash 34 (21%), utilt 23 (14%), bthrow 11 (7%), dtilt 10 (6%), fsmash 10 (6%), sspecial 7 (4%), dspecial 6 (4%), dashatk 5 (3%), dair 3 (2%)
UI 5: Trekmore move usage: nspecial 897 (15%), sspecial 786 (13%), fsmash 659 (11%), ftilt 450 (7%), nair 414 (7%), dashatk 352 (6%), uair 326 (5%), usmash 326 (5%), dair 287 (5%), fair 276 (4%), jab 228 (4%), dtilt 213 (3%)
UI 5: Trekmore SD causes: other:uspecial 3 (60%), other:fsmash 2 (40%)
UI 5: Trekmore state when Aeval opened him: air(air) 307 (11%), land 254 (9%), fsmash-startup 222 (8%), nspecial-startup 218 (8%), idle 176 (6%), ftilt-startup 142 (5%), dash 101 (4%), dashatk-startup 88 (3%), sspecial-startup 76 (3%), walk 73 (3%), grab 65 (2%), fsmash-endlag 62 (2%), dtilt-startup 60 (2%), roll 55 (2%)

UI 10: Trekmore KOs by move: usmash 10 (19%), uair 8 (15%), bair 6 (11%), sspecial 5 (9%), dair 4 (8%), dspecial 4 (8%), utilt 3 (6%), dashatk 2 (4%), dtilt 2 (4%), fair 2 (4%)
UI 10: Trekmore move usage: nspecial 583 (21%), sspecial 527 (19%), dair 345 (12%), nair 231 (8%), uair 177 (6%), fair 158 (6%), fsmash 136 (5%), dashatk 135 (5%), dspecial 117 (4%), usmash 112 (4%), bair 75 (3%), uspecial 69 (2%)
UI 10: Trekmore SD causes: none
UI 10: Trekmore state when Aeval opened him: land 148 (10%), dair-startup 146 (9%), nspecial-startup 115 (7%), sspecial-startup 107 (7%), air(air) 101 (7%), uair-startup 70 (5%), sspecial-endlag 66 (4%), fsmash-startup 65 (4%), usmash-startup 57 (4%), techRoll 50 (3%), roll 39 (3%), dspecial-active 38 (2%), fair-startup 38 (2%), fsmash-endlag 36 (2%)

Reading. UI 7 54, UI 5 77, UI 10 10 (four wins in 40, down from seven; the Wilson intervals of loops 1 to 3 at UI 10 all overlap).
Two loops aimed at what the god punishes did not move UI 10 beyond noise and did not bring UI 5 down. Last try, on the survival
side: the god Aeval deals 13.9 per opening, so weight should pay most against her, and fair and bair landing lag are the other
aerial landings.

| Move | Field | Before | After | Metric that motivated it |
|---|---|---|---|---|
| attributes | weight | 110 | 114 | UI 10 Aeval damage per opening 13.9 against 10.3 at UI 7 |
| fair | landingLag | 16 | 13 | landing still 7 to 10 percent of openings at every level |
| bair | landingLag | 15 | 12 | same |

Gates: selftest tkd1 pins `def.weight === 110`; updated to 114 for this loop and restored in loop 4. Cache regenerated, test:sim
128 of 128.

### Loop 4

Measured on the loop 3 numbers:


| UI | n | W-L-T | score | Wilson 95% | KO % T on A | KO % A on T | dmg/opening T | dmg/opening A | openings T/A | T SDs (dair/recall/other) | A SDs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 7 | 100 | 62-38-0 | 62/100 (62%) | 0.522 to 0.709 | 155 | 178 | 15.1 | 10.1 | 2971/4428 | 3 (0/1/2) | 8 |
| 5 | 60 | 51-9-0 | 51/60 (85%) | 0.739 to 0.919 | 154 | 192 | 14.0 | 9.1 | 1966/2637 | 5 (1/0/4) | 3 |
| 10 | 40 | 3-37-0 | 3/40 (8%) | 0.026 to 0.199 | 165 | 187 | 15.5 | 13.7 | 827/1622 | 0 (0/0/0) | 0 |

UI 7: Trekmore KOs by move: usmash 54 (22%), uair 38 (15%), dtilt 19 (8%), utilt 19 (8%), bthrow 18 (7%), fsmash 16 (7%), sspecial 16 (7%), uspecial 16 (7%), dspecial 12 (5%), bair 9 (4%)
UI 7: Trekmore move usage: nspecial 1798 (19%), sspecial 1556 (16%), nair 748 (8%), dair 744 (8%), dashatk 741 (8%), fsmash 641 (7%), usmash 577 (6%), uair 487 (5%), fair 385 (4%), dspecial 343 (4%), grab 272 (3%), uspecial 233 (2%)
UI 7: Trekmore SD causes: other:uspecial 2 (67%), recall 1 (33%)
UI 7: Trekmore state when Aeval opened him: air(air) 460 (10%), land 413 (9%), nspecial-startup 324 (7%), fsmash-startup 292 (7%), dair-startup 221 (5%), usmash-startup 216 (5%), sspecial-startup 178 (4%), dashatk-startup 150 (3%), idle 120 (3%), uair-startup 113 (3%), roll 108 (2%), sspecial-endlag 108 (2%), grab 98 (2%), dash 96 (2%)

UI 5: Trekmore KOs by move: uair 36 (22%), utilt 35 (21%), usmash 22 (13%), sspecial 14 (8%), fsmash 12 (7%), bthrow 11 (7%), dtilt 11 (7%), dashatk 9 (5%), dspecial 8 (5%), fair 2 (1%)
UI 5: Trekmore move usage: nspecial 872 (14%), sspecial 772 (13%), fsmash 654 (11%), nair 428 (7%), ftilt 421 (7%), dashatk 350 (6%), usmash 319 (5%), uair 317 (5%), fair 267 (4%), dair 249 (4%), dtilt 222 (4%), dsmash 211 (3%)
UI 5: Trekmore SD causes: other:uspecial 4 (80%), dair 1 (20%)
UI 5: Trekmore state when Aeval opened him: air(air) 275 (10%), fsmash-startup 225 (9%), nspecial-startup 221 (8%), land 189 (7%), idle 182 (7%), dash 123 (5%), ftilt-startup 122 (5%), dashatk-startup 77 (3%), sspecial-startup 75 (3%), grab 66 (3%), walk 61 (2%), dtilt-startup 57 (2%), jumpsquat 55 (2%), fsmash-endlag 52 (2%)

UI 10: Trekmore KOs by move: dspecial 8 (15%), sspecial 7 (13%), uair 7 (13%), usmash 6 (11%), dtilt 5 (9%), fsmash 5 (9%), bair 4 (7%), uspecial 4 (7%), dair 2 (4%), dashatk 2 (4%)
UI 10: Trekmore move usage: nspecial 590 (20%), sspecial 555 (18%), dair 363 (12%), nair 259 (9%), fair 183 (6%), fsmash 166 (6%), uair 150 (5%), dashatk 139 (5%), dspecial 129 (4%), usmash 115 (4%), bair 98 (3%), uspecial 85 (3%)
UI 10: Trekmore SD causes: none
UI 10: Trekmore state when Aeval opened him: dair-startup 153 (9%), nspecial-startup 134 (8%), land 130 (8%), air(air) 99 (6%), sspecial-startup 98 (6%), fsmash-startup 84 (5%), sspecial-endlag 75 (5%), uair-startup 63 (4%), usmash-startup 49 (3%), fair-startup 48 (3%), roll 48 (3%), techRoll 47 (3%), nair-startup 39 (2%), dashatk-startup 38 (2%)

Reading. The buff went where it was not wanted: UI 7 62 (Wilson 0.522 to 0.709, out of band), UI 5 85, UI 10 8. Weight and landing
lag help him against every Aeval, the weaker ones more. This is the clearest evidence of the four loops that the UI 5 to UI 10
spread (about 70 points) is not in his numbers: every change moved the three levels together or within noise, while the band
asks for a spread under 30. All three loop 3 changes were reverted.

| Move | Field | Before | After | Metric that motivated it |
|---|---|---|---|---|
| attributes | weight | 114 | 110 | UI 7 62 percent, above the 55 ceiling |
| fair | landingLag | 13 | 16 | same |
| bair | landingLag | 12 | 15 | same |

Final measurement on the kept numbers (loop 2's; it reproduces the loop 3 run count for count):


| UI | n | W-L-T | score | Wilson 95% | KO % T on A | KO % A on T | dmg/opening T | dmg/opening A | openings T/A | T SDs (dair/recall/other) | A SDs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 7 | 100 | 54-46-0 | 54/100 (54%) | 0.443 to 0.634 | 160 | 183 | 15.0 | 10.3 | 3021/4580 | 1 (0/1/0) | 6 |
| 5 | 60 | 46-14-0 | 46/60 (77%) | 0.646 to 0.856 | 157 | 184 | 14.3 | 9.0 | 1917/2748 | 5 (0/0/5) | 2 |
| 10 | 40 | 4-36-0 | 4/40 (10%) | 0.040 to 0.231 | 153 | 179 | 15.5 | 13.9 | 763/1545 | 0 (0/0/0) | 1 |

UI 7: Trekmore KOs by move: uair 47 (20%), usmash 34 (14%), utilt 22 (9%), sspecial 19 (8%), dspecial 17 (7%), fsmash 17 (7%), dashatk 16 (7%), bthrow 14 (6%), uspecial 13 (5%), dtilt 12 (5%)
UI 7: Trekmore move usage: nspecial 1777 (19%), sspecial 1597 (17%), dashatk 791 (8%), dair 732 (8%), nair 717 (7%), fsmash 629 (7%), usmash 561 (6%), uair 451 (5%), fair 406 (4%), dspecial 357 (4%), grab 274 (3%), uspecial 250 (3%)
UI 7: Trekmore SD causes: recall 1 (100%)
UI 7: Trekmore state when Aeval opened him: air(air) 458 (10%), land 458 (10%), nspecial-startup 323 (7%), fsmash-startup 298 (7%), usmash-startup 246 (5%), dair-startup 203 (4%), sspecial-startup 184 (4%), idle 164 (4%), dashatk-startup 145 (3%), uair-startup 108 (2%), sspecial-endlag 105 (2%), roll 102 (2%), grab 95 (2%), dash 93 (2%)

UI 5: Trekmore KOs by move: uair 37 (23%), usmash 34 (21%), utilt 23 (14%), bthrow 11 (7%), dtilt 10 (6%), fsmash 10 (6%), sspecial 7 (4%), dspecial 6 (4%), dashatk 5 (3%), dair 3 (2%)
UI 5: Trekmore move usage: nspecial 897 (15%), sspecial 786 (13%), fsmash 659 (11%), ftilt 450 (7%), nair 414 (7%), dashatk 352 (6%), uair 326 (5%), usmash 326 (5%), dair 287 (5%), fair 276 (4%), jab 228 (4%), dtilt 213 (3%)
UI 5: Trekmore SD causes: other:uspecial 3 (60%), other:fsmash 2 (40%)
UI 5: Trekmore state when Aeval opened him: air(air) 307 (11%), land 254 (9%), fsmash-startup 222 (8%), nspecial-startup 218 (8%), idle 176 (6%), ftilt-startup 142 (5%), dash 101 (4%), dashatk-startup 88 (3%), sspecial-startup 76 (3%), walk 73 (3%), grab 65 (2%), fsmash-endlag 62 (2%), dtilt-startup 60 (2%), roll 55 (2%)

UI 10: Trekmore KOs by move: usmash 10 (19%), uair 8 (15%), bair 6 (11%), sspecial 5 (9%), dair 4 (8%), dspecial 4 (8%), utilt 3 (6%), dashatk 2 (4%), dtilt 2 (4%), fair 2 (4%)
UI 10: Trekmore move usage: nspecial 583 (21%), sspecial 527 (19%), dair 345 (12%), nair 231 (8%), uair 177 (6%), fair 158 (6%), fsmash 136 (5%), dashatk 135 (5%), dspecial 117 (4%), usmash 112 (4%), bair 75 (3%), uspecial 69 (2%)
UI 10: Trekmore SD causes: none
UI 10: Trekmore state when Aeval opened him: land 148 (10%), dair-startup 146 (9%), nspecial-startup 115 (7%), sspecial-startup 107 (7%), air(air) 101 (7%), uair-startup 70 (5%), sspecial-endlag 66 (4%), fsmash-startup 65 (4%), usmash-startup 57 (4%), techRoll 50 (3%), roll 39 (3%), dspecial-active 38 (2%), fair-startup 38 (2%), fsmash-endlag 36 (2%)

Net change over loops 1 to 4 against loop 0: dair landingLag 24 to 14, sspecial shadowStep invuln [6, 16] to [3, 16], uair kbg 95
to 90, fsmash damage 22 to 19 and kbg 35 to 40. UI 7 53 to 54, UI 5 77 to 77, UI 10 15 to 10 (noise at n 40), top KO share 20 to
20 percent, Trekmore SDs at UI 7 2 to 1.

### Stop

After loop 4 (the loop cap). Met: UI 7 54 of 100 (Wilson 0.443 to 0.634, inside 45 to 55), top KO share 20 percent (uair; under
40 at every level). Not met: UI 5 46 of 60 (77 percent) and UI 10 4 of 40 (10 percent), both outside 35 to 65.

The gap and the next change. The spread between levels comes from the two brains, not from Trekmore's numbers: the god Aeval finds
twice his openings and the weaker Aevals feed his heavy hits, and no number tried moved one end without the other. The next change
is in the CPU, not in `moves.ts`: the Trekmore plan pack (`src/ai/characters/trekmore.ts`) at UI 10 spends 20 percent of its
starts on nspecial and 12 on dair, and those startups plus landing are where the god opens him; fewer sword casts in neutral and
fewer dairs above a grounded Aeval is the lever. If a number must move next, the one to try is nspecial's tap cast (the sword
leaves on 14), which needs the art retimed (the nspecial holds [5, 5, 4, 4, 12] put the release pose on 14).

### Calibrate after loop 4

Trekmore on Aeval (`npm run calibrate -- --char trekmore --victim aeval`); fsmash and uair changed, every other row is as after
loop 0:

```
move        gap  lift    ko %  full ko %  kb at 100
---------------------------------------------------
jab          40     0    none          -       52.8
ftilt        40     0     139          -       86.7
utilt         0     0     165          -      156.4
dtilt        40     0     162          -      127.3
dashatk      40     0     174          -      119.6
fsmash       40     0      98         59      107.6
usmash        0     0     107         65      167.2
dsmash       40     0     110         69      101.7
nair         26     0     275          -       92.1
fair         40     0     119          -       96.9
bair          0    44     188          -       80.5
uair         40     0     137          -      141.3
dair         26     0    none          -      175.3
nspecial     40     0     173        119       79.3
sspecial     40     0     108          -      109.2
uspecial      0    44    none          -       76.9
dspecial     40     0     130         57       90.9
ledgeatk     40     0     166          -       77.8
getupatk     40     0     162          -       79.8
```

Aeval on Trekmore (`npm run calibrate -- --char aeval --victim trekmore`) is unchanged (weight and hurtbox as in loop 0); the loop
0 table above still holds, checked row by row.

### Gates after loop 4

| Gate | Result |
|---|---|
| `npx --yes tsx src/ai/eval/main.ts --tier fast --only trek.mirror,trek.vs.aeval.l7,trek.ko.share` | exit 0; trek.mirror PASS (1 of 1 identical reruns); trek.vs.aeval.l7 INFO 2-2 of 4 at 2 stocks; trek.ko.share INFO top share 0.33 of 3 KOs |
| `npm run typecheck` | exit 0 |
| `npm run test:sim` | exit 0, 128 of 128 pass |
| `npm run test:net` | exit 0, nettest PASS |
| `npx --yes tsx src/ai/charprofile/cache.ts --check` | exit 0, trekmore hearthmoor and tidegate fresh |
