# Progress

## Iteration 0 - 2026-09-28 (setup + baseline + review)
Goal: ledger, baseline every gate, review the day's diff, seed DEFECTS.md.
Pre-commit git status: 194 entries. Besides the wave (src/, docs/, balance/, index.html) the tree holds 100 pre-existing deletions (art/aeval/ref crops, art/aeval/legacy, art/aeval/preview, ART_BRIEF, FRAME_MANIFEST, art/reference/README.md, tools/legacy, tools/spritegen incl. __pycache__), untracked art/, public/ and tools/ files, and a .gitignore change. Grep over src/, tools/, index.html, package.json: no deleted path is referenced (tools/README.md only records the 2026-09-14 removal).
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 | "> tsc --noEmit" no output
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "75/75 pass"
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "PASS al. level 10 kills a level 0 fast ... 38/38 pass"
GATE: build     | CMD: npm run build     | EXIT: 0 | "dist/assets/index-CtpFQDVg.js 1,783.25 kB ... built in 240ms" (chunk-size warning only)
GATE: browser   | CMD: npm run dev; browser.mjs http://localhost:5173 --script match.mjs | EXIT: 0 | console errors/warnings (0), requests failed (0); HUD shown, tags "CPU LV 6","CPU LV 5". Screenshot: .claude/webforge-loop/evidence/iter-0.png
Results harness (dynamic import of /src/ui/index.ts, fake 2/3/4 player ResultsData, Teams): evidence/iter-0-results2.png, iter-0-results3.png, iter-0-results4.png, 0 console errors.
D1 repro (scratch src/sim/_scratch_hover.ts, deleted after): "dx 1: x 181.00 y 0.000 action air onGround false" / "dx 5: ... air false" / "dx 10: ... air false".
PLAYTEST.md automatable items: a, b, c covered by the browser gate each UI iteration; the rest need hands on keys.
Changed: ledger only. Commit 1 staged: 100 legacy deletions + tools/README.md.
Result: baseline green; 5 defects opened (2 MAJOR, 3 MINOR).
Next: D1 (sim corner hover).

## Iteration 1 - 2026-09-28
Goal: D1, corner hover in the sim.
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 | first run EXIT 1 "src/sim/selftest.ts(2337,15): error TS2740: Type 'FighterState' is missing ... SimFighter" (my new test), fixed with simFighters(state)[0], rerun EXIT 0
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "PASS bu. ... left 1: ledgeHang y 20.0 hover 0 | ... right 5: dead y 241.0 hover 0 ... 76/76 pass"
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "38/38 pass" (run after the physics change; aitest does not import selftest)
GATE: build     | CMD: npm run build     | EXIT: 0 | "dist/assets/index-CtSs7l_u.js 1,783.37 kB"
GATE: browser   | not required (sim only)
Changed: src/sim/physics.ts, src/sim/selftest.ts (new test bu), docs/DECISIONS.md
Result: D1 FIXED. First attempt (snap onto the edge) failed selftests h and ak: 74/76; replaced by slide-off. Commits: 747b9ac wave, then the D1 fix.
Next: D2 results 3/4 player overlap.

## Iteration 2 - 2026-09-28
Goal: D2, results 3/4 player overlap.
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 |
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "76/76 pass"
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "38/38 pass"
GATE: build     | CMD: npm run build     | EXIT: 0 | "dist/assets/index-6Y7mmGVD.js 1,784.10 kB"
GATE: browser   | CMD: npm run dev; browser.mjs --script match.mjs | EXIT: 0 | console errors/warnings (0), hudHidden false. Screenshot: .claude/webforge-loop/evidence/iter-2.png
Results harness overlap check (pose/quote/ring vs stats and tag line): n4 1280x720 [], n3 1280x720 [], n4/n3 1920x1080 [], n4/n3 1024x600 []; n2 still reports pose x stats (D3). Screenshots evidence/iter-2-results{2,3,4}.png and -1920x1080 / -1024x600 variants.
Changed: src/ui/results.ts
Result: D2 FIXED.
Next: D3 (2 player splash over first stat row).

## Stop - after iteration 2
Stop condition fired: (a) clean pass. Iteration 2 ran every registered gate with exit 0 (typecheck, sim 76/76, ai 38/38, build, browser), no BLOCKER or MAJOR defect is open, and every in-scope file is committed (2d3d818). Open MINOR: D3, D4, D5 (handoff in DEFECTS.md / TODO.md). Unstaged, out of scope: package.json, .gitignore, untracked art/, public/, tools/.

## Iteration 3 - 2026-09-28
Goal: D3, 2 player win pose and splash over the first stat row.
Before: harness n2 1280x720 "col0 .rs-pose x stats", "col0 .rs-splash bottom 388 > stats top 343"; n3/n4 "col0 quote x splash" (new check). evidence/iter-3-before-results{2,3,4}.png
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 | evidence/tc-3.log
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "76/76 pass"
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "38/38 pass"
GATE: build     | CMD: npm run build     | EXIT: 0 | "dist/assets/index-D6shUnuE.js 1,784.87 kB"
GATE: browser   | CMD: npm run dev; browser.mjs --script match.mjs | EXIT: 0 | console errors/warnings (0), requests failed (0), hudHidden false. evidence/iter-3.png
Results harness (results5.mjs, n x size): overlaps [] for n=2,3,4 at 1280x720, 1920x1080, 1024x600, console errors 0. evidence/iter-3-results{2,3,4}-{1280x720,1920x1080,1024x600}.png
Changed: src/ui/results.ts
Result: D3 FIXED.
Next: D5 (Aevalmere name for level 10 CPU).

## Iteration 4 - 2026-09-28
Goal: D5, level 10 CPU tag reads AEVALMERE.
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 | evidence/tc-4.log
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "76/76 pass"
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "38/38 pass"
GATE: build     | CMD: npm run build     | EXIT: 0 | "dist/assets/index-OrZkBWle.js 1,784.92 kB"
GATE: browser   | CMD: npm run dev; browser.mjs --script match10.mjs (P1 raised to CPU LV 10) | EXIT: 0 | sel "P1 · CPU LV 10 CPU AEVALMERE"; hud cards ["AEVALMERE","CPU LV 5"], ntags ["AEVALMERE","CPU LV 5"]; console errors 0. evidence/iter-4-hud-lv10.png, browser-4.log
Results harness n=4: "LOSE AEVAL · AEVALMERE", overlaps []. evidence/iter-4-results4.png
In-page eval playerTag levels 0..10: ["CPU LV 0",...,"CPU LV 9","AEVALMERE"]
Changed: src/ui/theme.ts
Result: D5 FIXED.
Next: D4 (Teams time-out selftest).

## Iteration 5 - 2026-09-28
Goal: D4, selftest for a 2v2 Teams time out with both teams in.
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 | evidence/tc-5.log
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "PASS teams: 2v2 time out ...: byTime true bothIn true | stocks: team 0 winner 0 at 60 | percent 90 v 100: team 0 winner 1 at 60 | percent 110 v 100: team 1 winner 2 at 60 | 70 v 70: team -1 winner -1 at 60" "77/77 pass"
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "38/38 pass"
GATE: build     | CMD: npm run build     | EXIT: 0 | "dist/assets/index-OrZkBWle.js 1,784.92 kB"
GATE: browser   | not required (sim test only)
Mutation: percent < bestPercent flipped to > in decideWinnerTeam -> "FAIL teams: 2v2 time out ... 76/77 pass"; reverted.
Test file diff: src/sim/selftest.ts +61 lines, 0 removed.
Changed: src/sim/selftest.ts
Result: D4 FIXED.
Next: clean-checkout buildability (track runtime assets, package.json/.gitignore).

## Iteration 6 - 2026-09-28
Goal: D6, a clean checkout builds and loads every runtime asset.
Commits: 11170ff Track runtime assets the UI references (19 files under public/fonts, public/ui, public/icons); 18d46db Drop art scripts that pointed at deleted tools (package.json, .gitignore).
Clean worktree (scratchpad/clean, HEAD 18d46db): CMD npm ci | EXIT 0 | "found 0 vulnerabilities"; CMD npm run build | EXIT 0 | "dist/assets/index-OrZkBWle.js 1,784.92 kB" (same hash as main tree, identical dist file list). vite preview + browser.mjs --script match.mjs: EXIT 0, console errors 0, requests failed 0, hudHidden false. evidence/ci-6-clean.log, build-6-clean.log, browser-6-clean.log, iter-6-clean-preview.png. Worktree removed (git worktree list: main only).
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 |
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "77/77 pass"
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "38/38 pass"
GATE: build     | CMD: npm run build     | EXIT: 0 | "dist/assets/index-OrZkBWle.js 1,784.92 kB"
GATE: browser   | CMD: browser.mjs --script match10.mjs | EXIT: 0 | console errors 0, requests failed 0, cards ["AEVALMERE","CPU LV 5"]. evidence/iter-6.png
Still untracked (owner): art/ (aeval sheets 224 files, sheetmap.json, anims.json, INTEGRATION_SPEC.md, PROMPT.md, reference, stages/tidegate 13, ui/CONTACT.png, ui/ref), tools/sheetcut, tools/spritemaker, tools/stagecut, tools/uicut (incl. __pycache__), .claude/webforge-loop/.
Changed: public/** (added), package.json, .gitignore
Result: D6 FIXED.

## Stop - after iteration 6
Stop condition fired: (a) clean pass. Iteration 6 ran every registered gate with exit 0 (typecheck, sim 77/77, ai 38/38, build, browser) plus the clean worktree build (exit 0). D1..D6 all FIXED; no open defect.

# Loop 2: refinement after the arena/balance/CPU/LAN wave (2026-09-29)

## Iteration 0 - 2026-09-29
Goal: baseline every gate on the merged tree; register defects from the worker reports.
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 | evidence/r0-typecheck.log
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "85/85 pass" evidence/r0-sim.log
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "44/44 pass (1 info)" evidence/r0-ai.log
GATE: net       | CMD: npm run test:net  | EXIT: 0 | "nettest: PASS" evidence/r0-net.log
GATE: discovery | CMD: npm run test:discovery | EXIT: 0 | "discoverytest: PASS" evidence/r0-discovery.log
GATE: lobby     | CMD: npm run test:lobby | EXIT: 0 | "lobbytest: PASS" evidence/r0-lobby.log
GATE: build     | CMD: npm run build     | EXIT: 0 | evidence/r0-build.log
Changed: nothing (ledger only)
Result: all gates green; 6 defects registered (R1-R6).
Next: iteration 1 = close R1, R2, R3 (LAN worker) and run the R4 review in parallel.

## Iteration 1 - 2026-09-29
Goal: close R1 (reload resume), R2 (leaver loses), R3 (stale menu defaults); independent review (R4).
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 | evidence/r1-typecheck.log
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "85/85 pass" evidence/r1-sim.log
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "44/44 pass (1 info)" evidence/r1-ai.log
GATE: net       | CMD: npm run test:net  | EXIT: 0 | "nettest: PASS" (11 scenarios incl. 2 leave) evidence/r1-net.log
GATE: discovery | CMD: npm run test:discovery | EXIT: 0 | evidence/r1-discovery.log
GATE: lobby     | CMD: npm run test:lobby | EXIT: 0 | "lobbytest: PASS" (13 checks) evidence/r1-lobby.log
GATE: build     | CMD: npm run build     | EXIT: 0 | evidence/r1-build.log
Test files: nettest.ts and lobbytest.ts gained scenarios, none lost lines; no .skip.
Changed: src/net/{rollback,protocol,client,inputlog,eliminate,nettest}.ts, server/{lobbyhost,lobbytest}.ts, src/main.ts, src/ui/context.ts, docs/LAN.md, docs/DECISIONS.md; src/sim/_dbg.ts deleted (stray debug script).
Browser evidence: art/ui/ref/lan3_reload_resumed.png, art/ui/ref/lan3_results_leaver.png.
Commits: 4a18663 arenas+camera, dd67809 balance/orb/rules, 1c1c63d CPU, 1ad772d LAN, 6631dc6 docs+ledger, plus tracked art.
Result: R1, R2, R3 FIXED; R4 review done, opened R7-R20.
Next: iteration 2 = R7-R15, R17, R18 (LAN worker), R16 (sim), R19 (AI), R20 documented.

## Iteration 2 - 2026-09-29
Goal: close the review findings R7-R20 (three workers on disjoint files: net/server, sim, ai).
GATE: typecheck | CMD: npm run typecheck | EXIT: 0 | evidence/r2-typecheck.log
GATE: sim       | CMD: npm run test:sim  | EXIT: 0 | "86/86 pass" evidence/r2-sim.log
GATE: ai        | CMD: npx --yes tsx src/ai/aitest.ts | EXIT: 0 | "45/45 pass (1 info)" evidence/r2-ai.log
GATE: net       | CMD: npm run test:net  | EXIT: 0 | "nettest: PASS" (13 scenarios) evidence/r2-net.log
GATE: discovery | CMD: npm run test:discovery | EXIT: 0 | (4 cases incl. hostile datagrams) evidence/r2-discovery.log
GATE: lobby     | CMD: npm run test:lobby | EXIT: 0 | "lobbytest: PASS" (18 checks) evidence/r2-lobby.log
GATE: build     | CMD: npm run build     | EXIT: 0 | evidence/r2-build.log
Test files: +400/-18 lines across nettest, lobbytest, discoverytest, selftest, aitest; the 18 removed lines are import/signature refactors (checked by diff), no assertion loosened, no .skip.
Changed: src/net/{snapshot,rollback,inputlog,client,nettest,discoverytest}.ts, src/main.ts, server/{lobbyhost,lan,static,discovery,version,lobbytest}.ts, src/sim/{projectiles,moves,hits,state,selftest}.ts, src/core/types.ts (ProjectileState.charge), src/ai/{profile,aevalmere,aitest}.ts, docs/LAN.md, docs/DECISIONS.md.
Result: R7-R20 FIXED (14). Open: R5, R6 (MINOR art, owner decision).
Stop check: (a) clean pass fired: every gate exit 0 and no open MAJOR/BLOCKER.

## Stop - after iteration 2
Stop condition (a) clean pass. Handoff: R5/R6 art rows for the owner; LAN untested across two physical machines (documented in docs/LAN.md).
