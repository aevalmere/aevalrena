# Advantage state, defense and combo algorithms for the Aevalrena CPU

Verification status. Read as wikitext or page text: SSBWiki Combo, Tech-chasing, Edge, Air dodge, Grab, Lucario edge getups, Directional influence; ultimateframedata.com Mario; slippi-js combo code. Read through a page summarizer only: SSBWiki Hitstun, Tech, Shield. "Secondhand" marks values taken from sibling reports 01 and 07 in /home/claude/research, whose cited pages I did not open. The Izaw Metafy ledge-trap lesson is video only, so nothing here is attributed to Izaw. Aevalrena numbers come from the local repo, and the worked example (3.7) was run on a scratch copy of the real sim, repo untouched.

## 1. Advantage state

### 1.1 Hitstun and the true combo budget

- Ultimate hitstun is floor(0.4 x kb) - 1 for every hit; Smash 4 added a frame for tumble and electric hits. Balloon knockback shortens effective hitstun at high kb: kb 90 gives 33 frames (Smash 4: 36), kb 145 gives 41 (Smash 4: 58). Set-knockback hits skip it, and flinching hits last at least 4 frames (https://www.ssbwiki.com/Hitstun).
- Aevalrena: hitstun = floor(0.4 kb), no minus 1, no balloon effect, no cancelling. At kb 145 that is 58 frames, the Smash 4 value, not Ultimate's 41. Combos run longer than Ultimate lore at high knockback, so take percent windows from the forward model, not from Ultimate guides.
- True combo budget, counted in frames after hitlag ends (one hit freezes both fighters for the same hitlag, so it cancels):

```
T  = floor(0.4 * kb)                    # victim hitstun
E  = iasa - hitFrame                    # attacker frames until actionable after the hit
J  = 4 if follow-up is an aerial after a jump, else 0   # jumpsquat 3 + 1 (measured, 3.7)
S  = frame index of the follow-up's first active hitbox
Tr = travel frames to legal spacing (dash, walk, air drift), 0 if in range
budget = T - (E + J + S + Tr) + 1       # victim hitstun frames left when the hitbox lands
true combo <=> budget >= 1 (add margin m per level for execution error)
```

  The +1 is calibrated on the sim. The hitbox must also overlap the hurtbox on that frame; it fails when the attacker rises past a low victim (3.7).
- Air dodge is the only escape once hitstun ends, and Aevalrena's dodge is invulnerable from its frame 2 (`AIR_DODGE`), so a hit in the first 1 to 2 frames after hitstun still lands against an instant reaction. unverified: read from code, not run.

### 1.2 What counts as a combo

- SSBWiki: a true combo keeps the opponent in hitstun and is impossible to escape if performed correctly, though some need a read of DI; the in-game combo counter allows one non-hitstun frame (https://www.ssbwiki.com/Combo).
- Slippi statistic (Melee states): a combo starts when the opponent is damaged, grabbed or command-grabbed. A reset counter is 0 on frames where the opponent is damaged, grabbed, command-grabbed, teching, down or dying, and increments otherwise; the combo ends when it exceeds 45 (`COMBO_STRING_RESET_FRAMES`) or on a stock loss (https://raw.githubusercontent.com/OGoodness/slippi-js/master/src/stats/combos.ts, https://raw.githubusercontent.com/OGoodness/slippi-js/master/src/stats/common.ts, a fork because project-slippi paths returned 404). So 45 counts consecutive frames outside stun, tech and knockdown, not "actionable" frames, and it is a statistic, not a guarantee.
- Aevalrena: plan with budget >= 1. Use the Slippi rule only for a future combo counter or replay stats.

### 1.3 Juggling and landing traps

- Ultimate allows one air dodge per airtime (reset by landing, a hit or a ledge grab). Neutral dodges average 49-50 frames (Smash 4: 32-33) with landing lag 10 (Smash 4: 21). Directional dodges slingshot backward first, last over a second, and land with 11-19 frames of lag. A fully stale dodge gains intangibility 3 frames later. SSBWiki says this makes juggling and edgeguarding more common (https://www.ssbwiki.com/Air_dodge).
- Mario: neutral dodge 52 frames, intangible 3-29, landing lag 10; directional 71-116 frames, intangible 3-21 (https://ultimateframedata.com/mario). The neutral exit window (intangibility over, not yet actionable) is 23 frames.
- Rules: (1) read the victim's dodge-spent flag and time the hitbox for the exit window, not the approach; (2) predict landing frame and spot by ballistic rollout and hold a hitbox active there plus the victim's landing lag; (3) cover directional dodges with wide or lingering hitboxes because they move the victim.
- Aevalrena: air dodge is 34 frames, intangible 2-31, so the exit window is 2 frames (32-33); one dodge per airborne period; no known landing lag. A cloned state times that window exactly.

### 1.4 Tech chasing

- Ultimate tech window is 11 frames (Smash 4: 8), lockout 40, buffering in hitlag allowed, grounded meteors cannot be teched, footstools can, and very high knockback near a surface removes the tech (https://www.ssbwiki.com/Tech, summarizer). The Lucario page says 12 (secondhand, https://www.ssbwiki.com/Lucario_(SSBU)/Techs).
- SSBWiki: tech chasing is weaker in Smash 4 and Ultimate because tech rolls are shorter and post-grab immunity (60 to 70 frames; the Tech-chasing page says 70 for both games, the Grab page says 60 in Ultimate) blocks chain grabs. Slow strong moves work when the roll is predicted or the victim is against an edge or wall; platforms help reaction because rolls are limited by platform length (https://www.ssbwiki.com/Tech-chasing, https://www.ssbwiki.com/Grab).
- Reactability, forum-level and secondhand: about 15 frames of human reaction, last frame to cover a missed tech with a jab 17, grab deadline against tech in place 18, tech rolls 19-21 (https://SMASHBoards.com/threads/tech-chasing-like-a-man-complete-breakdown.382475/, via report 07).
- One move for several options: a move covers option o when its active window overlaps o's vulnerable window and its hitbox contains o's position then. Prefer long, multi-hit or wide hitboxes and score a coverage matrix (3.6) rather than reasoning per move.
- Aevalrena: press window 20, lockout 40 (`TECH`); frames counted from the option's first frame, off-by-one unverified. Tech in place: 26 frames, intangible to 20, vulnerable 21-25. Tech roll: 40 frames, intangible to 20, vulnerable 21-39, moves 40 px. A missed tech goes to `downed` (no intangibility in the code), up to 120 frames: getup 30 frames intangible to 22 (vulnerable 23-29), getup roll 35 frames intangible to 25 (vulnerable 26-34, 40 px), getup attack 34 frames, intangible 0-13, hitboxes 14-20 on both sides. The CPU sees the option and roll direction at frame 0; the only hidden information is which option and, when lying down, when.

### 1.5 Ledge trapping

- The six options to cover: regular getup, getup attack, ledge roll, ledge jump, drop plus ledge attack, and staying. Shielding at the ledge covers four, two of which must be reacted to (the page lists getup, getup attack, roll and jump without saying which two); on a hit into the shield, grab and send the victim back offstage. Mario's up smash covers jump, getup attack and roll (https://www.ssbwiki.com/Edge).
- Ledge intangibility on grab (Ultimate): 60 x (airtime/300) + 44 - 44 x (percent/120) frames, airtime capped at 300, percent at 120, minimum 23, maximum 123, plus a 19-frame grab animation; hang time 6.5 s. Regrabs: 6 grabs before landing, getup intangibility x0.8 after the first regrab, x0.5 after the second, none after that, and the grab animation slows from x0.9375 (third grab) to x0.75 (sixth) (https://www.ssbwiki.com/Edge).
- Getup timings, Lucario, first grab: neutral getup intangible 1-33 then one vulnerable frame, actionable at 35 of 40; ledge jump intangible 1-12; ledge roll intangible 1-26 of 45; regrabs cut these (getup 27 then 16, jump 10 then 6, roll 21 then 13) (https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups).
- The 2-frame: a grabbing recoverer has 2 vulnerable frames before intangibility starts, so moves that reach, clip or pierce the ledge punish it; it does not apply to a grab on the way down past the ledge or to a teleport from above (https://www.ssbwiki.com/Edge).
- Ledge trump: grabbing an occupied ledge removes the holder, which ended edge-hogging in Smash 4 and Ultimate (https://www.ssbwiki.com/Edge). I did not fetch trump frame values or the buffer rule (report 01 says buffering attack, jump or roll on the grab frame avoids it; unverified).
- Aevalrena: no trump, since `tryLedgeGrab` skips a taken ledge, so hogging works. Hang invulnerability is 40 frames for the first 3 grabs, a hang never times out, a drop sets a 12-frame regrab cooldown. Options from `src/sim/ledge.ts`: climb 30 frames, intangible under 28, arrives 14 px inside; roll 24 frames, intangible to 22, about 1 vulnerable frame, lands 34 px inside; jump intangible 12 frames; ledge attack 40 frames, intangible 0-21, hitbox 18-24, exposed on 22-39. The trapper cannot time on the grab. It reacts to the option's first frame and punishes the arrival spot, or holds a lingering hitbox over the union of arrival spots. Ledge attack is the easiest to punish, roll the hardest.

### 1.6 Kill confirms

- Definition: a weaker, faster, safer move links into a strong finisher over a percent range; Fox neutral air into up smash is the SSBWiki example (https://www.ssbwiki.com/Combo).
- Finding one, for starter s and finisher f on weight w:
  1. p_true from the budget: T_s(p) from kb_s(p + d_s), lowest percent with budget >= 1 (3.7 shows the hit-frame dependence).
  2. p_koF: percent where the finisher's kb reaches kbKO, the knockback that reaches the blast rect (rollout). The formula is linear in p: X = (k/r - bkb) x 100/kbg - 18, p_after = X / ((0.1 + d/20) x 200/(w+100) x 1.4), percent before the hit = p_after - d; r = 1 in Aevalrena.
  3. Confirm window = [max(p_true, p_koF - d_s), p_upper], where p_upper is where the starter sends the victim beyond finisher reach or kills on its own.
  4. Confirm means choosing the finisher after the starter lands, from the real state. Ultimate players do this because DI changes the state; Aevalrena has no DI, so the state is known before the hit.

## 2. Disadvantage and defense

### 2.1 DI, LSI, SDI, ASDI limits

- Ultimate reuses the Smash 4 system. Trajectory DI is capped at 0.17 rad, about 9.74 degrees. The page's general description gives about 18 degrees for the older games and says Smash 4 made DI half as effective (https://www.ssbwiki.com/Directional_influence, wikitext). So 18 is the pre-Smash 4 value; I found no fetched source giving 18 for Ultimate.
- The deviation is largest for stick directions perpendicular to the launch angle and scales with tilt; parallel input does nothing. The stick is read on the last frame of hitlag, has no effect on non-tumbling knockback, and a grounded victim cannot DI knockback that keeps it grounded (same page). Calculator form, secondhand: angle' = angle +/- 0.17 x |X Vy - Y Vx| / |V| (https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js).
- LSI multiplies launch speed by up to x1.095 (stick up) or x0.92 (down), off for launch angles 65-115 and 245-295, checked against the DI-adjusted angle (same page).
- SDI: 2 units per input, 4-frame gap between inputs, x1.15 per five consecutive hits; ASDI only on electric, paralyze, crumple, autoshift and zero-hitlag projectile hits (secondhand: https://www.ssbwiki.com/Smash_directional_influence, https://www.ssbwiki.com/Automatic_smash_directional_influence).
- Aevalrena: none of this exists, so victim movement in hitstun is a pure function of the hit and combo tables are exact. If DI is added, model three victim replies (none, best survival, best escape) and score by the worst.

### 2.2 Teching, air dodge, shield

- Tech (1.4): press inside the window when no lockout is active; roll away from the attacker's fastest reach, in place if the attacker is far.
- Air dodge, Ultimate (https://www.ssbwiki.com/Air_dodge, https://ultimateframedata.com/mario): neutral keeps momentum, landing lag 10; directional slingshots, intangible 3-21 (Mario), can grab a ledge after its first 24 frames, landing lag 11-19; staling shortens intangibility and distance but not lag.
- Shield, Ultimate (summarizer, https://www.ssbwiki.com/Shield): HP 50 (42.02 with the 1.19 multiplier), decay 0.15 per frame held, regen 0.08, startup 1 frame, release lag 11, size (HP/50) x 0.85 + 0.15, HP 37.5 after a break, break stun shorter at higher percent, pushback (shieldstun + 1) x 0.09 x shield factor capped at 1.3. Shieldstun = damage x 0.8 x mult + 2 frames; report 01 adds multipliers 0.725 for grounded smashes and 0.33 for aerials and a cap of 60 (secondhand, https://www.ssbwiki.com/Shieldstun).
- Parry: release shield within the first 5 frames of the 11-frame drop, after at least 3 frames up: no shield damage, no drop lag, pushback x0.15 (https://www.ssbwiki.com/Shield; https://www.ssbwiki.com/Perfect_shield via report 01).
- On-shield advantage, calculator form, secondhand: hitFrame - (FAF - 1) + shieldstun + shieldHitlag - attackerHitlag.
- Aevalrena: shield HP 60, decay 0.12 (500 frames from full), regen 0.07, stun floor(0.6d) + 2, break stun 180 fixed, no parry, no known drop lag. Aeval utilt (d 7) gives 6 frames of shieldstun against 14 frames of attacker endlag (iasa 20, hit frame 6), so the defender has about 8 free frames, enough for a grab (active 7-8). Confirm in the forward model.

### 2.3 Out-of-shield options

- Ultimate, Mario (https://ultimateframedata.com/mario): up special 3 frames, neutral air 6 (jumpsquat 3 + 3), up air 7, shield grab 10 after shieldstun (4 extra frames of shield), shield drop 11 for everyone, jumpsquat 3 for everyone but Kazuya, up smash direct (9). Forms: OoS aerial = 3 + startup; up special or up smash = startup; grab = startup + 4 after stun.
- Aevalrena: jump, grab, up smash, up special, roll, spot dodge. Rank by frames to first active hitbox: up special (read the move data), grab 7, jump plus aerial 4 + startup (measured in 3.7), up smash 12. Choose the fastest whose reach covers the attacker and whose start is at most the on-shield advantage.

### 2.4 Rolls, spot dodge, staling

- Mario (https://ultimateframedata.com/mario): spot dodge 25 frames (20 if cancelled into a ground attack), intangible 3-17; forward roll 29, intangible 4-15; back roll 34, intangible 5-16.
- Staling, secondhand (https://www.ssbwiki.com/Roll, https://www.ssbwiki.com/Spot_dodge): duration x (1 + P), P + 0.06 per spot dodge or forward roll (cap 0.3), + 0.10 per back roll (cap 0.5); fully stale dodges start intangibility 3 frames later (rolls 4).
- Aevalrena: spot dodge 22 frames, intangible 3-17; roll 24 frames, intangible 3-16 (`ROLL.distance` is 80 in code, 60 in the brief); air dodge 34 frames; no staling, so cap dodge repetition in the level tables.

### 2.5 Grab mash-out

- Ultimate hold = floor(90 + 1.7 x victim percent) frames, minus 8 per stick input and about 14.4 per button input, minimum 19; yellow flash at 180 frames left; 60 frames of grab immunity after release (https://www.ssbwiki.com/Grab).
- Aevalrena: hold = round(60 + 0.5 x percent), minus 4 per mash press per frame (`mashFrames`, `src/sim/grab.ts`): 60 frames at 0%, 110 at 100%, against Ultimate's 90 and 260. Budget pummels from that.

### 2.6 Defensive decision rules

Grabs beat shields and attacks beat grabs (https://www.ssbwiki.com/Grab). Evaluate each frame, with perception delay d:

1. Frames-to-hit < d: cannot react, choose by prediction (shield for blockable strings, spot dodge for expected grabs).
2. Shield when the hit is blockable, shield HP after the hit stays above a floor (suggest 25% of max), and on-shield advantage is at least the fastest OoS startup.
3. Spot dodge or roll against a predicted grab or long string; spot dodge only if the grab's first active frame is at or before the intangibility end (Aevalrena 17), after which the dodger recovers 5 frames later (22 - 17).
4. Challenge when attackerEndlag - myStartup - travel >= 1 and the move is safe; this is the counter archetype's core.
5. Jump when pressure is grounded, no anti-air reaches the landing spot, and a dodge is unspent for the exit.
6. Air dodge when the hit arrives at least 2 frames out (Aevalrena) and the attacker cannot reach the exit window (1.3).

## 3. Algorithms for a forward-model CPU without DI

### 3.1 Exact true-combo test

Closed form filters; the cloned sim decides. Sim formulas (`src/sim/hits.ts`, `physics.ts`): kb = ((((p/10) + (p x d/20)) x (200/(w+100)) x 1.4) + 18) x (kbg/100) + bkb with p the percent after damage; hitstun floor(0.4 kb); hitlag min(20, floor(d/2) + 4); launch speed kb x 0.06 px per frame, decaying 0.051 per frame along the launch vector while a separate fall term grows 0.15 per frame to max fall; position integrates after the decay.

```
trueCombo(starter, follow, victim, margin):
  s = clone(state); apply starter hit -> kb, T = floor(0.4*kb), hitFrame f
  E = starter.iasa - f
  for variant in (full hop, short hop, dash k):
    for early in 0..5, off in 1..16:            # buffer and attack-press offsets
      c = clone(s); run with victim input = none; note first follow-up hit
      if hit and victimHitstunBeforeHit >= 1 + margin: return (true, variant, early, off)
  return false
```

A 60-frame rollout costs about 90 microseconds at 1.5 microseconds per step, so 115 candidates cost about 10 ms (my arithmetic on the brief's figure).

### 3.2 Percent-bracketed combo table by BFS

- Key: (starter, victim percent bracket of 5, hit-frame class early/mid/late, dx bucket 10 px, dy bucket, victim grounded or airborne). Value: best sequences with damage, kill flag, end position, end advantage.
- Expand each node with the follow-up set (moves, dash, short hop, full hop) and input timings, rollout each, keep a child if budget >= 1 + level margin and it is not dominated (same key, lower damage and lower end advantage). Depth at most 4, total frames at most 240, stop at a KO, keep the best 6 per level.
- Cost: 30 brackets x 12 starters x 10 follow-ups x 3 variants = 10,800 rollouts x 60 frames x 1.5 microseconds, about 1 second (my arithmetic). Build at load or lazily per bracket; level tables set maximum depth and margin.

### 3.3 Per-hit replanning

The table is a prior. After each hit, during hitlag, re-read the victim, re-run 3.1 for the top entries plus the ordinary 115-plan search, and commit inputs early enough for the 6-frame buffer (`TUNING.input.buffer`).

### 3.4 Kill routing and ledge-carry scoring

- Roll each candidate final hit out to `stage.blast`, read from the stage (report 01 found the code's blast rects differ from the brief's numbers). Kill if the fighter crosses the rect inside hitstun; otherwise project free flight and test recovery reach (double jump, up special, air speed).
- `score = wD x damage + wK x P(KO) + wO x offstage + wL x ledgeCarry - wR x risk`. offstage is 1 when the victim ends outside the platform x range or below it and the CPU's follow-up still reaches. ledgeCarry = clamp((|x_end| - stageHalfWidth)/100, 0, 1), plus a bonus when the victim ends at a ledge where the CPU's known trap (1.5) covers most options. Prefer routes ending offstage or past the blast rect; break ties toward the nearer blast line.

### 3.5 Landing prediction for juggles

```
predictLanding(victim):
  for pol in {none, driftToStage, fastFall, doubleJumpAt(t), airDodgeAt(t)}:
      c = clone; run until onGround; record (x, t, landingLag)
  return set weighted by the habit predictor (uniform if none; exact for the god tier)
```

Pick the attack maximizing lambda x worst + (1 - lambda) x mean hit probability over the set.

### 3.6 Tech chase as a reaction problem

Let d be perception delay in frames (level 10 uses 4; human tiers roughly 12-18 per report 07). The option and roll direction are visible at frame 0 of the tech. A reply m started when the CPU sees the option hits if [d + Tr + S, d + Tr + S + A - 1] overlaps the vulnerable window V_o and the hitbox contains o's position.

```
chase(victim at landing L, d):
  R = {o : exists m with hit(m, o, d)}          # options coverable by reaction
  if R == all options: wait; at L + d play best m for the observed o     # god case
  else: pick pre-commit c (start L - k) maximizing sum_o P(o) * payoff[c][o] from cloned rollouts
```

With Aevalrena values (1.4), tech in place is vulnerable 21-25, so a reply needs 21 - d <= S + Tr <= 25 - d: 6-10 frames at d 15, 3-7 at d 18, so a pre-commit or a fast short-range move. The tech roll window 21-39 is wide enough to react to. At d 4 every option is coverable by reaction. A lower tier runs the same code with its own d.

### 3.7 Worked example: Aeval utilt into uair

Utilt: damage 7, bkb 37, kbg 90, angle 90, iasa 20, hitbox frames 6-11. Uair: startup 8, jumpsquat 3, landing lag 11. Victim weight 88, percent read as the value before the hit (p = percent + 7). Hitlag on both fighters is min(20, floor(7/2) + 4) = 7. The launch is straight up, so there is no horizontal travel.

| victim % | p | kb | hitstun T | launch speed (px/frame) | tumble | height at T |
|---|---|---|---|---|---|---|
| 0 | 7 | 57.42 | 22 | 3.445 | no | 25.0 px (apex 27.8 at frame 17) |
| 30 | 37 | 75.52 | 30 | 4.531 | no (kb 80 needs 37.5% before the hit) | 48.8 px (apex 49.3 at frame 26) |
| 60 | 67 | 93.61 | 37 | 5.617 | yes | 86.1 px, still rising |

Trajectory: vy_n = -(kb x 0.06 - 0.051 n) + min(3.2, 0.15 n), height = -sum vy. It matched the real sim to about 0.1 px at frames 10 and T (23.4 px at frame 10 for 0%, 45.1 for 60%).

Follow-up timing on the real sim with frame-perfect inputs (jump buffered to the iasa frame, aerial pressed 4 frames after the jump): the uair first connects E + 12 frames after hitlag ends, E = 20 - utilt hit frame, so 26 frames after a frame-6 hit and 21 after a frame-11 hit. X is victim hitstun left when the uair lands, X = T - (E + 12) + 1; true needs X >= 1.

| victim % | utilt hits on frame 6 | frame 10 | frame 11 | uair result |
|---|---|---|---|---|
| 0 (T 22) | X = 0, not true | X = 1 | X = 2 | full hop misses (attacker feet 46 px up, hitbox starts 32 px above them, victim top 66 px); short hop connects |
| 10 (T 25) | X = 0 | X = 4 | X = 5 | short hop only |
| 30 (T 30) | X = 5 | X = 9 | X = 10 | true, full or short hop |
| 60 (T 37) | X = 12 | X = 16 | X = 17 | true, victim 77 px up at the hit |

A frame-6 utilt turns the combo true at T >= 26, kb >= 65, about 12.6% before the hit; below that it needs a late-frame utilt and a short hop. Reading 0/30/60 as p after damage gives kb 53.2, 71.3 and 89.4 and T 21, 28 and 35. The uair still connected at 120% in the same scan. Runs used a horizontal offset of 0; the uair column spans about x -10 to 17 px in the attacker's facing (my reading of the hitbox data) and the 26 px hurtbox must overlap it, so spacing matters and was not swept.

## Open questions

- The +1 in J is measured for one input path (buffered jump, then attack). Other paths, such as air drift into an aerial, may cost more; re-measure per character with a script like the one used here.
- Ledge trump frame values, the trump buffer rule and Ultimate ledge attack frames were not fetched.
- The 0.17 rad DI cap rests on SSBWiki and the community calculator, both reconstructions, not a game-side source.
- Human tech-chase reactability rests on forum posts, a limit report 07 shares.

## Sources

Fetched (page text or raw wikitext read by me):
- https://www.ssbwiki.com/Hitstun : Ultimate hitstun formula, balloon knockback examples, cancel thresholds (summarizer).
- https://www.ssbwiki.com/Tech : tech window 11, lockout 40, surfaces (summarizer).
- https://www.ssbwiki.com/Shield : HP, decay, regen, drop lag, shieldstun form, pushback, parry window (summarizer).
- https://www.ssbwiki.com/Directional_influence : DI 0.17 rad, LSI, read timing (summarizer and raw wikitext).
- https://www.ssbwiki.com/Combo : combo definitions, true combo, kill confirm (raw wikitext).
- https://www.ssbwiki.com/Tech-chasing : tech chase mechanics and Ultimate limits (raw wikitext).
- https://www.ssbwiki.com/Edge : ledge options, intangibility formula, regrab penalties, ledgetrapping, 2-frame, trump (raw wikitext).
- https://www.ssbwiki.com/Air_dodge : Ultimate air dodge rules, landing lag, staling (raw wikitext).
- https://www.ssbwiki.com/Grab : hold-time formula, mash values, grab immunity, priority (raw wikitext).
- https://www.ssbwiki.com/Lucario_(SSBU)/Edge_getups : ledge getup intangibility by grab count (raw wikitext).
- https://ultimateframedata.com/mario : dodge, roll, air dodge, OoS frames (HTML text; getup and ledge tables are images).
- https://raw.githubusercontent.com/OGoodness/slippi-js/master/src/stats/combos.ts : Slippi combo logic (fork).
- https://raw.githubusercontent.com/OGoodness/slippi-js/master/src/stats/common.ts : 45-frame constant and state predicates (fork).
- https://metafy.gg/guides/view/mastering-smash-ultimate-how-to-ledge-trap-cWOGTnRQyA5 : Izaw ledge trap lesson; video only, no usable text.
- https://github.com/aevalmere/aevalrena : local copy read for constants.ts, sim/{hits,physics,ledge,tech,grab,actions,index}.ts, characters/aeval/moves.ts, characters/common/grabkit.ts; a scratch copy of the sim was run for 3.7.

Snippet only (title in a search result, page not opened):
- https://metafy.gg/@izaw/guides : Izaw's guide list.
- https://www.eventhubs.com/news/2019/mar/19/tech-chase-trapping-super-smash-bros-ultimate-creates-true-5050-mix-ups-after-knock-downs : tech chase trapping article title.

Secondhand (not opened; values from sibling reports 01 and 07):
- https://www.ssbwiki.com/Shieldstun, https://www.ssbwiki.com/Perfect_shield, https://www.ssbwiki.com/Smash_directional_influence, https://www.ssbwiki.com/Automatic_smash_directional_influence, https://www.ssbwiki.com/Roll, https://www.ssbwiki.com/Spot_dodge, https://www.ssbwiki.com/Lucario_(SSBU)/Techs, https://raw.githubusercontent.com/rubendal/SSBU-Calculator/master/js/formulas.js : formulas and timings in 1.4 and 2.1 to 2.4.
- https://SMASHBoards.com/threads/tech-chasing-like-a-man-complete-breakdown.382475/ : forum tech-chase deadlines, via report 07.
