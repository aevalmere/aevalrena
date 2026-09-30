# Trekmore polish pass (2026-09-30)

Follow-up to the ROUGH rows in `LEDGER.md`. Local match on http://localhost:5183 at 1280x720, P1 Trekmore driven by
Playwright key events, P2 Aeval CPU frozen, game at 0.25x. Each `polish_*.png` has a BEFORE row and an AFTER row. No
moves.ts edits, no redraws, no new crops: every change is a frame pick or hold in `art/trekmore/sheetmap.json`
(repacked with `python tools/sheetcut/pack.py --char trekmore`) or a layout fix.

| Item | Screenshot | Change |
|---|---|---|
| Shield bubble | polish_shield.png | It did draw (faint P1 blue at 0.34 alpha), but it was sized for Aeval's 40 px hurtbox, so his helmet stuck out; `src/render/fighters.ts` now scales and centres the bubble on the fighter's hurtbox height (Aeval unchanged). |
| utilt | polish_utilt.png | parry_counter_1, 2, 3 then loco_idle_0, holds 6, 7, 7, 18: a side view rising overhead arc, the hit at 13 lands on the full arc (counter_3). |
| usmash | polish_usmash.png | uspec_g_0, 1, 2, 3, 7, 10, 11, 19, holds 6, 5, 4, 3, 3, 8, 10, 17: the fling passes the vertical glow (g_7) and the hit at 21 lands on the sword held straight up (g_10). usmashCharge is now g_0, g_18 (crouched gather) instead of g_1 (blade low by the feet). |
| sspecial (ground) | polish_sspecial.png | Departure uses air_stepR_1, 2, 4 instead of the side row dissolve blobs; reappear and backstrike (strike_0 to 2, hit at 19) kept; the smoky strike_3 tail cut from 21 to 5 frames and followed by the reformed stance step_side_8, 9. |
| taunt2 | polish_taunt2.png | The concept_a summon clones are dark filled shapes in the source (1 to 10 levels under the navy, not background), so no pocket threshold opens them; taunt2 now plays the detailed conA_cloneIdle_0 to 2. |
| taunt3 | polish_taunt3.png | Was cloneIdle; now emerge_2 (smoke), emerge_1 (half figure rising), then conA_idle_0, 1 standing. emerge_0 (a lone helmet mask) left out. |
| Movelist | polish_movelist_800.png, polish_movelist_1280.png | Below 62rem the table tightens padding and letter spacing and lets the name and damage columns wrap; the echo share wraps as one unit. Overflow at 800 px: 712 in 701 before, 701 in 701 after (764 px: 712 in 667, now 667). 1280 px layout unchanged. |

Gates: `npm run typecheck` exit 0, `npm run test:sim` 128/128, `npx --yes tsx src/render/rendertest.ts` 20/20, zero
console errors and zero failed requests across the browser runs.
