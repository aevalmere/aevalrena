# Wave 2026-09-28c: arenas, camera, balance, orb art, rules, god CPU

Lead-owned spec. Workers read this, own only the files listed for them, and return the JSON
report at the end of their section. Nothing here changes existing move numbers other than the ones
listed (owner rule: adding entries is fine, renumbering is not).

Gates every worker runs before reporting (exit codes are the truth, paste the tail of the output):

```
npm run typecheck
npm run test:sim
npx --yes tsx src/ai/aitest.ts      # only workers who touch src/sim or src/ai
npm run build
```

Source paintings supplied by the owner today (copy, never modify the originals):

| Purpose | Source file |
|---|---|
| Tidegate repaint (night, moon, floating castle, two side discs) | `C:\Users\light_095j4re\Downloads\ChatGPT Image Sep 28, 2026, 11_31_35 PM.png` (1672x941) |
| Second arena (day, village, well, two grassy side platforms) | `C:\Users\light_095j4re\Downloads\ChatGPT Image Sep 28, 2026, 11_43_08 PM.png` (1672x941) |
| Neutral special projectile sheet (charge, travel, expanded, explosion, close-ups) | `C:\Users\light_095j4re\Downloads\ChatGPT Image Sep 28, 2026, 11_36_20 PM.png` (1672x940 RGBA, black bg) |

## Frozen contracts (all workers)

1. **World scale.** 640x360 base view (`VIEW_W`/`VIEW_H`), Aeval stands 48 px tall, main platform
   walk line is y = 0 and x = 0 is its centre. Unchanged.
2. **Camera zoom range.** `TUNING.camera.zoomMin` becomes **0.6** and `zoomMax` stays 1.8. At zoomMin
   the view is 1067x600 world px. Every stage's `cameraBounds` must be at least that big, and each
   painting must cover its stage's `cameraBounds` completely (edge clamping is a last resort, not
   the plan).
3. **Stage sizing rule (both arenas).** Scale each painting so its full width is **1080 world px**
   (painting is 1672 wide, so scale = 1080/1672 = 0.6459). Its height is then 608 px. Place it so the
   main platform walk line measured on the painting sits at world y = 0 and the platform's horizontal
   centre at x = 0. `cameraBounds` = the painting's world rect. `blast` = cameraBounds grown by 48 px
   on the left, right and top and by 96 px at the bottom. Report the resulting numbers.
4. **Layer order and parallax** (back to front): `sky` 0.15, `far` 0.35, `mid` 0.6, `stage` 1.0.
   Same `TidegateLayerData`-style contract for every stage (rename the type to `StageLayerData` in
   a shared file `src/stages/layers.ts` if you touch it; keep the field names).
5. **Projectile art names** (fx sheet, `src/characters/aeval/art/atlas.fx.ts`, generated):
   `orbCharge0..7`, `orb0..11` (normal travel), `orbBig0..11` (expanded travel), `burst0..10`
   (explosion). `crescent0..2`, `geyser*`, `whirl*`, `hitspark*`, `ko*`, `splash*`, `arrow0` keep
   their names. Anim entries in `anims.ts` fx section: `orbCharge`, `orb`, `orbBig`, `burst`.
6. **Renderer sprite rule for charged shots.** `drawProjectiles` draws anim `<sprite>Big` when the
   projectile's `scale >= 1.2` and that anim exists, else `<sprite>`. No new field on
   `ProjectileDef` for this.
7. **Charged projectile sim contract** (owned by the balance worker, consumed by nobody else this
   wave):
   - `ProjectileDef.charged?: { vx?: number; lifetime?: number; damage?: number; bkb?: number; kbg?: number; r?: number }`
     = the values at full charge. Every field lerps from the base value to the charged value on
     the existing exponential charge curve `t` (`exponentialCharge(t, 0, 1)` style, so the last
     quarter of the charge matters most). Omitted fields keep the base value at every charge.
   - `MoveDef.chargeCastFrames?: number` = extra frames added to **both** the projectile
     `spawnFrame` and the move `totalFrames` at full charge, scaled linearly by charge fraction.
   - `power`/`scale` from `projectileChargePower/Scale` stay as the damage and hit-circle
     multipliers on top; a burst spawned by `killProjectile` inherits the parent's `power` and
     `scale`.
8. **Final Smash is disabled this wave.** `config.finalSmash` is always false at match start; the
   Mode screen shows the row as "Final Smash: Disabled" and it cannot be toggled; Move List shows
   the Final Smash row as "Unavailable". No sim code is deleted.
9. **Teams are automatic.** The Teams rule is on if and only if two or more active slots share a
   team colour at match start. The Mode screen row becomes read-only text "Teams: Same colour =
   team". `MatchConfig.teams` keeps its meaning.
10. **CPU stays king.** After every other change lands, level 10 (Aevalmere) must still win 10/10
    against level 9 with 0 stocks lost on both arenas.

## Worker A: arenas and camera

Owns: `tools/stagecut/**`, `art/stages/**`, `src/stages/**`, `src/render/camera.ts`,
`TUNING.camera` in `src/core/constants.ts`, `docs/TUNING.md` camera section, `docs/DECISIONS.md`
(append only).

1. Copy the Tidegate repaint to `art/stages/tidegate/source.png` (keep the old one as
   `source_old.png`) and the village painting to `art/stages/hearthmoor/source.png`. Stage id
   `hearthmoor`, display name "Hearthmoor" (owner may rename).
2. Generalise `tools/stagecut/cut_tidegate.py` into `tools/stagecut/cut_stage.py <stageId>` that
   reads `art/stages/<id>/source.png` + `masks.json` and writes `art/stages/<id>/layers/*.png`,
   `src/stages/<id>/layers.ts`, `src/stages/<id>/geometry.ts`. Same algorithm (polygon masks,
   diffusion fill, shared palette). Keep `cut_tidegate.py` as a one-line shim or delete it.
3. Author `masks.json` for both paintings by looking at them (Read the PNG). Layers:
   - Tidegate night: sky = sky, moon, clouds; far = floating castle with beam, distant towers;
     mid = the two side floating islands with waterfalls and the ruined arches on the main island's
     back edge; stage = the main disc island plus the two side platform discs.
   - Hearthmoor: sky = sky, clouds, mountains, castle; far = village, windmill, lake, distant
     islands; mid = trees at the left and right edges, the fence, near clouds; stage = the main
     grassy island (with the well, cart, hay, banner post on it) plus the two grassy side platforms.
   Collision, measured on the painting: main platform walk line (the top of the grass / the middle
   depth line of the disc top), two side platforms (pass-through). Ledges on the main platform
   only. Use contract item 3 for scale and placement; record the numbers in `data.ts` comments.
4. Register both stages in `src/stages/registry.ts` (`STAGE_LIST` order: Tidegate, Hearthmoor).
   The select screen already cycles `deps.stages`.
5. Camera (`src/render/camera.ts`): `zoomMin` 0.6. Fix framing so a fighter at the top of the blast
   zone stays in view with the whole stage: the fit must consider the full fighter extent plus
   margin, and `clampToBounds` must not fight the fit (if the fitted view is larger than the bounds
   in one axis, centre that axis). Add `VIEW_H`-relative head room so a fighter launched up is never
   cut off before the blast line.
6. Verify in the browser with the `game-development` or `browser-automation` skill: screenshots of
   both arenas at match start, and with one fighter thrown to the top of the stage (use the F4 tuner
   or a scripted match). Save to `art/stages/<id>/ingame_*.png`.

Return JSON: `{ "stages": [{ "id", "cameraBounds", "blast", "platforms" }], "zoomMin", "filesChanged": [], "gates": { "typecheck": exit, "sim": exit, "build": exit }, "screenshots": [], "openQuestions": [] }`

## Worker B: move balance and charged orb sim

Owns: `src/characters/aeval/moves.ts`, `src/core/types.ts` (only the two additions in contract 7),
`src/sim/moves.ts`, `src/sim/projectiles.ts`, `src/sim/hits.ts`, `src/sim/selftest.ts`,
`src/sim/calibrate.ts`, `balance/aeval.balance.json`, `docs/SPEC.md` section 5 numbers.

1. **Side hits accurate to the art.** Measure the water reach of the crops the anims use (manifest at
   `art/aeval/sheets/crops/manifest.json`; crops in the same folder; anchor `ax, ay` is the feet
   point, sprite faces right). Python + Pillow: foreground bbox of the crop minus the body column
   (the body is roughly the 26 px hurtbox around ax). Reach = rightmost foreground x minus ax.
   Lead's rough numbers from the manifest widths: ftilt `ground_spikeMed_2` reaches ~80 px,
   dashatk/fsmash `ground_sweepF_2/3` reach ~95 px.
   - `ftilt`: hitboxes become a chain of circles (same group 1, ids 1..n) covering x from 12 to the
     measured tip at y -18, r 10. Startup 8 -> 10, active through 14, totalFrames 26 -> 30, iasa 26.
     Damage 8 stays; the outermost circle may carry +1 damage.
   - `dashatk`: chain from x 14 to the measured tip at y -16, r 11. Start 6 -> 8, end 16 -> 18,
     totalFrames 32 -> 36.
   - `fsmash`: chain from x 16 to the measured tip at y -18, r 13. Start 16 -> 18, end 21 -> 23,
     totalFrames 44 -> 48. Damage 15 stays.
   Aeval is mid range: these ranges are the point, the extra frames are the price.
2. **Neutral special (orb) rework**, contract 7. Base (tap) values: `spawnFrame` 11, move
   `totalFrames` 40, `vx` 3.5, `lifetime` 48, `damage` 4, `bkb` 14, `kbg` 30, `r` 8.
   `charged`: `vx` 9.5, `lifetime` 34 (about 320 px of travel: a bullet), `damage` 11, `bkb` 34,
   `kbg` 66, `r` 12. `chargeCastFrames` 16 (full charge fires on frame 27 of a 56-frame move).
   Keep `PROJECTILE_POWER_MIN`/`SCALE` curves; `orbBurst` inherits the orb's power and scale. Remove
   the old comment maths; write the new ones.
3. **Side special (crescent).** `vx` 4.25 -> 3.2. Out-and-back distance 4/3 of before: old out 152 px
   / total 348 px. New: `returnFrame` 57, `lifetime` 146. `bkb` 27 -> 24, `kbg` 48 -> 44.
4. Update selftests that pin the old numbers (`e`, `i`, `k`, `o`, `p`, `v` and any that assert orb
   range or crescent timing) and add: ftilt/dashatk/fsmash connect at the measured tip and whiff
   10 px past it; full-charge orb spawns later, flies faster and further than a tap; crescent
   turnaround frame and death distance. `npm run calibrate` output pasted in the report.
5. Do not touch `src/ai/**`. If aitest fails only because of new numbers, report which tests; the CPU
   worker fixes them next wave.

Return JSON: `{ "reach": { "ftilt", "dashatk", "fsmash" }, "moveChanges": [...], "calibrate": "<table>", "selftests": "n/n", "aitest": "n/n or list of failures", "filesChanged": [], "gates": {...}, "openQuestions": [] }`

## Worker C: orb art and renderer

Owns: `tools/sheetcut/cut_orb.py` (new), `art/aeval/sheets/orb.png` (copy of the source),
`art/aeval/sheets/CUT_SPEC.md` (append an orb section), `art/aeval/sheets/crops/fx_orb*.png`,
`fx_burst*.png`, `crops/manifest.json` fx entries, `art/aeval/sheetmap.json` **fx section only**,
`tools/sheetcut/pack.py` (only if the fx path needs it), generated `src/characters/aeval/art/atlas.fx.ts`
and `anims.ts`, `src/render/fx.ts`, `src/render/visuals.ts`.

1. Cut the orb sheet (contract 5). Rows, top to bottom, each frame numbered under it: CHARGE/FORM
   8 frames, TRAVEL (NORMAL) 12, TRAVEL (EXPANDED) 12, EXPLOSION 11; the bottom band is close-ups
   (ignore for crops). Key the black background (luma threshold plus alpha), strip caption text and
   numbers, split each row into frames by connected components in x order, tight bbox, centre
   anchor. Scale: the normal travel frame's core is **16 px** wide in game (r 8 hit circle);
   expanded frames scale so their core is about **28 px** (the sim scales the sprite by `scale` up
   to 1.5 on top, so do not pre-scale to the full 40). Explosion frames scale to about **40 px** at
   their widest. Sprites are cropped exactly, never redrawn (owner rule).
2. Regenerate the fx atlas with `pack.py`. Anims: `orbCharge` 8 frames loop, `orb` 12 loop at 18 fps,
   `orbBig` 12 loop at 24 fps, `burst` 11 no loop at 30 fps (lifetime 10 frames in the sim; make
   the anim fit by holds so it plays once).
3. Renderer: contract 6 (`orbBig` when `scale >= 1.2`). While Aeval charges nspecial, replace
   `drawChargeRing` with the `orbCharge` anim at the hand (frame index by charge fraction, so a
   fuller charge shows a later, bigger frame); keep the ring for any other charging move. Trail:
   when `scale >= 1.2` draw the previous frame position once at 50% alpha (cheap motion trail, no
   allocation).
4. Verify in the browser with a scripted match: screenshot a tap orb, a full-charge orb in flight,
   and an explosion. Save to `art/aeval/sheets/orb_ingame_*.png`.

Return JSON: `{ "crops": { "orbCharge": n, "orb": n, "orbBig": n, "burst": n }, "sizes": {...}, "filesChanged": [], "gates": {...}, "screenshots": [], "openQuestions": [] }`

## Worker D: rules UI (Final Smash off, Teams automatic)

Owns: `src/ui/mode.ts`, `src/ui/select.ts`, `src/ui/movelist.ts`, `src/main.ts` (only the
`startMatch` config lines), `src/ui/hud.ts` (only if the meter needs hiding), `docs/SPEC.md` rules
section, `docs/DECISIONS.md` (append only).

1. Contract 8: Final Smash disabled. Mode row read-only "Disabled"; `ctx.state.finalSmash` forced
   false on screen entry and at `startMatch`; `main.ts` passes `finalSmash: false` whatever was
   saved; Move List row shows "Unavailable" and no input hint. The controls binding row may stay.
2. Contract 9: Teams automatic. In `select.ts` `startMatch`, compute `teams` = any two active slots
   share `teamOf(slot)`. Remove `state.teams` from the select flow. Mode row becomes read-only
   "Same colour = team". Update the hint line on select ("T: team colour. Same colour = one team").
3. Selftest is not yours; add a small unit check in `src/ui` only if one exists. Verify in the
   browser: Mode screen rows, a 2v2 with matching colours starts with no friendly fire (screenshot
   of the HUD showing team-coloured cards), Move List row.

Return JSON: `{ "filesChanged": [], "gates": {...}, "screenshots": [], "openQuestions": [] }`

## Worker E (wave 2, after A to D land): Aevalmere god CPU

Owns: `src/ai/**`, `docs/CPU_AEVALMERE.md`. Runs after the balance and stage work is merged. Spec
in the dispatch prompt; summary: re-tune to the new move data on both arenas, opponent modelling
that learns the human's tendencies within and across matches, kill-confirm and spike routing,
loss-avoidance objective, and gates: 10/10 vs level 9 with 0 stocks lost on both arenas, 0 SDs,
budget under 1.5 ms per call.

## Worker E spec: Aevalmere god CPU (wave 2)

Owns `src/ai/**` and `docs/CPU_AEVALMERE.md`. Nothing else. Requires waves A to D merged and
`npm run typecheck` green.

Goal, in the owner's words: an untouchable level 10 that "learns everything about the player and
plays to avoid losing at all costs", takes kills through combos and spikes rather than fishing,
and adapts to any playstyle rather than being tuned to one. Keep the existing architecture
(bounded rollout search, reply models, combo table, habit tables, no-whiff vetoes) and extend it.

### E1. Re-tune to the new data
- Combo table (`buildComboTable`) rebuilt from the new ftilt / dashatk / fsmash chains, the
  charged orb (`ProjectileDef.charged`, `MoveDef.chargeCastFrames`: model tap and full charge as
  two starters) and the slower, longer crescent.
- Stage awareness: every use of stage geometry (`stageInfo`, `cSi`, blast reads, ledge x, platform
  heights, `GroundInfo` in index.ts) must come from the live `StageDef`, never from Tidegate
  constants. Both `tidegate` and `hearthmoor` must pass the gates.
- Camera-independent: the brain reads the sim only.

### E2. Opponent model that learns the player (within a match and across matches)
Research basis to cite in the doc: opponent modelling in FightingICE winners (rollouts against a
learned reply policy beat fixed policies), Tekken/SF "ghost" style action-sequence models,
n-gram / variable-order Markov predictors for fighting-game inputs, and the SmashBot punish gate.
Implement:
- **Situation-conditioned n-gram predictor.** Context key = (opponent situation bucket: neutral
  ground / neutral air / in shield / launched / ledge / downed / offstage, distance bucket 4-way,
  our state bucket: free / busy / shielding, opponent last action). Value = counts of the
  opponent's next action class (attack by move id, shield, roll to/away, spot dodge, jump, grab,
  drift in/out, nothing) with exponential recency (decay 0.97 per observation) and Laplace
  smoothing. Order-2 (previous action pair) backed off to order-1 backed off to the existing
  habit tables.
- **Reply models weighted by the predictor.** The reply set for each rollout is built from the
  predictor's top-k next actions (k up to 5) with their probabilities, so the "worst case" and
  the weighted mean use what this player actually does. Keep a floor weight for the fixed models
  so a never-seen option still gets checked.
- **Per-player persistent profile.** Serialise the predictor (fixed-size Float32Array counts and
  the habit tables) to `localStorage` under `aevalrena.aevalmere.profile.v1.<playerName>` at match
  end and on every KO (keyed by the human's typed name from `config.players[i].name`, falling back
  to `slot<n>`); load at match start and blend it in as a prior (weight equal to about 60 real
  observations). In node (tests) use an injectable in-memory store. Never store anything else.
- **Exploit detection.** Track the opponent's repetition (already `mem.repetition`) and their
  reactions to our approaches (e.g. shield on dash-in, roll on shield pressure, jump on projectile)
  as separate conditional tables; when one response exceeds 55% probability, add the direct
  counter as a candidate with a bonus (grab vs shield, wait-and-punish vs roll, uair/usmash vs
  jump, dash-attack the landing vs air dodge).

### E3. Kill routing: combos and spikes, not fishing
- Extend the combo table's chain search to score chains that end past the blast rect, and add
  **dair spike routing**: when the victim is offstage below ledge height or can be carried there,
  evaluate fair/bair -> dair, and ledge-drop dair, against the recovery reply models; take the
  spike when the rollout shows a KO in every reply and our own recovery back is guaranteed
  (rollout must end with us on stage or on the ledge with a jump left).
- Edgeguard ladder: ledge trump / ledge hog is not in the sim; use crescent (now longer) as an
  offstage coverage tool and the orb charge as a ledge-timing tool, all through rollouts.
- Kill-confirm table: at each victim percent bracket precompute which starters (grab -> throw,
  dtilt, utilt, nair) lead to a guaranteed KO chain on each stage, and raise their priority when
  the victim is in the bracket.

### E4. Loss avoidance objective
- Objective = expected score with a **CVaR-style tail penalty**: the worst 25% of reply outcomes
  weighted 2x when we are ahead in stocks, 1x when even, 0.5x when behind; a stock lost in any
  reply that the predictor rates above 5% is a hard veto for that candidate if any candidate
  without such a loss exists.
- Recovery: always choose the recovery policy whose rollout keeps the largest margin to every
  blast line, and never air dodge into the ledge when a jump remains; never SD.
- Stock-up management: when ahead by a stock and the timer is off, stay in the maximin regime
  (lambda 0.7) and keep the combo game; never taunt or wait passively (the kill-speed test
  stays).
- Never take an option the rollouts mark as a whiff or as shield-punishable, as before.

### E5. Human-looking but never worse
Keep the 4-frame reaction floor and the ~2% safe alternates, but the alternate must never be one
that a reply above 5% punishes.

### E6. Gates (all in `src/ai/aitest.ts`, deterministic seeds, both stages)
- L10 vs L9: 10/10 wins, 0 stocks lost, 0 SDs, on `tidegate` and `hearthmoor`.
- L10 vs scripted archetypes (add them to the harness as fixed policies): rushdown masher,
  shield-grab turtle, projectile camper, roll-spammer, ledge-camper, jump-happy: 0 stocks lost
  over 3 seeds each; the predictor's top guess accuracy against each reaches >= 60% within 30 s.
- Profile persistence: a second match against the same archetype with the loaded profile reaches
  first KO faster than the first match (median over 5 seeds).
- Kill speed vs standing dummy: median first KO under 12 s, and at least 40% of KOs come from a
  chain of 2+ hits or a spike.
- Budget: mean `cpuInput` under 0.3 ms, p99 under 4 ms, first call under 40 ms after warm-up.
- Determinism: same seed, identical final state (with the store empty and with a fixed profile).
- Existing tests a..ak keep passing.
Update `docs/CPU_AEVALMERE.md` sections 1 to 4 with the new sources, mechanisms and measurements.

Return JSON: `{ "results": { "l10_vs_l9": {...}, "archetypes": {...}, "profile": {...}, "killSpeed": {...}, "budget": {...} }, "aitest": "n/n", "filesChanged": [], "gates": {...}, "openQuestions": [] }`

## Worker F spec: experimental LAN (parallel track)

Owner's words (2026-09-29): "develop experimental LAN that can be ported onto the new stuff after
updates easily. deep research best way to do this. on each person's computer, still max 4, LAN
lobbies: create lobbies, lobby settings. each person should be P1 on their own screen. it should
feel instantaneous, no lag or issues."

Owns: `src/net/**` (new), `src/input/session.ts` (extend, keep `createLocalSessionImpl` intact),
`src/ui/lan.ts` (new screen), the `LAN` row in `src/ui/mode.ts` (enable it and route to the
screen; nothing else in that file), `src/main.ts` (only: a `startLanMatch` path next to
`startMatch` and the screen registration), `server/**` (new: the LAN host process),
`package.json` scripts and devDependencies (`ws` only, plus `tsx` if needed), `docs/LAN.md` (new),
`docs/DECISIONS.md` (append). Never edit `src/sim/**`, `src/ai/**`, `src/render/**`, `src/stages/**`,
`src/characters/**`. If a sim hook is missing, write down the exact function you need in the report
and stub around it.

### Design constraints (frozen)
1. **Deterministic lockstep with rollback.** The sim is deterministic (`stepGame(state, inputs)`,
   `cloneGameState`, seeded RNG, every selftest replays byte-identically). Use GGPO-style rollback:
   each peer runs the sim locally, predicts remote inputs (repeat last input), and on receiving the
   real input for a past frame restores the saved state for that frame and re-simulates forward.
   Input delay 1 frame on LAN, configurable 0-4 in lobby settings. Keep a ring of 32 saved states
   (cloneGameState into pooled copies; `stepGame` costs ~1.5 µs so re-simulating 8 frames is
   nothing).
2. **Transport.** WebSocket relay through a host process (`server/lan.ts`, Node + `ws`), one
   process per lobby host, started with `npm run lan` and printing the LAN URL. Every client
   (including the host's own browser) connects to it. Per-frame packets are tiny binary frames
   (frame number, slot, held/pressed/released/direct as ints) and carry the last 4 frames of the
   sender's inputs for loss tolerance. Lobby traffic is JSON. A WebRTC DataChannel path is out of
   scope this wave, but the transport is behind an interface (`NetTransport`) so it can be added.
3. **Lobby.** Create lobby (name, stocks, stage, input delay, CPU fill on/off), join by typing the
   host's LAN address or picking from a list the host broadcasts via UDP discovery if that is cheap
   in Node (otherwise skip discovery, say so). Up to 4 players; the host's slot assignment is
   authoritative; ready-up; host starts. Reuse the existing character/name/team-colour data from
   the select screen by sharing the same `MatchConfig` shape.
4. **Everyone is P1 on their own screen.** The sim slot order is the lobby's; the *view* remaps:
   the local player's card is drawn first and coloured as P1, their name tag says "P1 (you)", and
   local keyboard/pad bindings for player 1 drive the local slot. Do this in the session adapter
   and the HUD's slot order input, without changing sim slot numbering (results, teams and stats
   must still be correct). If the HUD needs a "display order" hook, add the smallest one and name
   it in the report.
5. **Feel.** Target: under 1 frame of added input latency on a LAN, no visible hitches on rollback
   (resim runs inside the same tick), desync detection via a per-frame state hash every 60 frames
   (any mismatch shows a "desync" banner and logs the frame); a simulated-latency toggle in the
   lobby (0/30/60/100 ms, via the server) for testing rollback visually.
6. **Portability.** All netcode reads the sim only through `stepGame`, `cloneGameState`,
   `createGameState`, and `MatchConfig`; no move data, no AI. State the porting checklist in
   `docs/LAN.md`.
7. **Research first, cite.** Read and cite in `docs/LAN.md`: GGPO / rollback netcode (Tony
   Cannon's GDC talk and the GGPO README), Infil's "Netcode explained", Slippi's Melee rollback
   notes, the Rivals/Skullgirls rollback writeups, and browser transport comparisons (WebSocket vs
   WebRTC DataChannel latency on LAN). Use WebSearch/WebFetch.

### Gates
- `npm run typecheck`, `npm run build`, `npm run test:sim` unaffected.
- A node harness `src/net/nettest.ts` (`npx --yes tsx src/net/nettest.ts`): two in-process peers
  over a fake transport with 0, 2 and 6 frames of one-way delay and 5% loss play a scripted 1800
  frame match; final state hashes match on every peer; max rollback depth reported; no frame
  hashes differ.
- Browser: two tabs on the same machine joined to one lobby via `npm run lan`, match runs, both
  HUDs show the local player as P1; screenshots into `art/ui/ref/lan_*.png`.
