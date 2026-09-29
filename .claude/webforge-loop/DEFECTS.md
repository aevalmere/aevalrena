# Defects (refinement loop, wave 2026-09-28/29)

| ID | LOCATION | DEFECT | SEVERITY | CLASS | STATUS |
|---|---|---|---|---|---|
| R1 | src/net/client.ts, src/main.ts | Reloading the page mid-LAN-match counts as leaving; only network drops resume. Needs a resume token in sessionStorage. | MAJOR | behaviour | OPEN |
| R2 | src/main.ts, src/net/protocol.ts, src/ui/results.ts | After a disconnect timeout the results show no winner; the remaining side should win (Smash rule). | MAJOR | behaviour | OPEN |
| R3 | src/ui/context.ts | MenuState.finalSmash defaults true and teams field is stale; both are forced/ignored downstream. | MINOR | cleanup | OPEN |
| R4 | src/net/**, server/** | No independent review of the netcode yet (rollback, resume, discovery, relay). Findings become new rows. | MAJOR | review | OPEN |
| R5 | art/stages/hearthmoor | Grey diffusion patches in the far layer near the horizon at high zoom. Art pipeline; owner decision whether to repaint or mask. | MINOR | art | OPEN (owner) |
| R6 | art/stages/tidegate | Thin light band above each lowered side disc at high zoom (vacated pixels). | MINOR | art | OPEN (owner) |
| R7 | server/lobbyhost.ts:100,345 | A text frame parsing to `null` passes the try/catch, `switch (msg.t)` throws in the ws listener; no uncaughtException guard: the agent process dies with every lobby. | BLOCKER | robustness | OPEN |
| R8 | server/static.ts:24 | `decodeURIComponent` throws on a bad escape inside the http handler; `GET /%` kills the agent. | BLOCKER | robustness | OPEN |
| R9 | server/discovery.ts:68 | `ips` elements are not type-checked; a non-string element throws in the dgram listener; one crafted datagram crashes every agent on the subnet. | BLOCKER | robustness | OPEN |
| R10 | src/net/snapshot.ts:30,50; rollback.ts:445 | First `restoreInto` replaces `live.config` (not in the owned set); the AI keys "new match" on config identity: L10 re-runs warmAevalmere (400-frame hitch stalls every peer) and wipes its learned memory once per match on the host. | MAJOR | correctness | OPEN |
| R11 | server/lobbyhost.ts:332 | Relay forwards the raw packet, receivers trust the self-declared `pk.peer`; a member can inject inputs for another slot and diverge from the relay log. Relay must stamp/verify the peer. | MAJOR | trust | OPEN |
| R12 | src/net/inputlog.ts:24; server/lan.ts:68 | `put` accepts frames up to 2^22 with doubling growth and ws has no maxPayload; one packet with a huge firstFrame allocates ~136 MB. Cap frame distance from confirmed and set maxPayload. | MAJOR | robustness | OPEN |
| R13 | src/main.ts:405; net/view.ts:68; rollback.ts:343 | `drainEvents` only runs in render; the hidden-tab ticker grows pendingEvents unbounded and replays them all on return. Drop events older than N frames. | MINOR | behaviour | OPEN |
| R14 | src/net/rollback.ts:462; eliminate.ts:15 | `applyRetirements` pushes the KO event before stepGame clears events, so no peer sees the leaver's KO effect. | MINOR | behaviour | OPEN |
| R15 | src/net/protocol.ts:161; server/lobbyhost.ts:396 | stageId/charId are length-clamped but not validated against STAGE_DEFS/CHARACTER_DEFS; a stale or crafted value throws in startLanMatch for every peer. | MINOR | validation | OPEN |
| R16 | src/sim/projectiles.ts:41 | `chargedStat` derives charge from scale; an unchargeable spawn (scale 1) reads as 44% charge. Latent (no such def today). Derive from an explicit charge fraction or clamp when the move is not chargeable. | MINOR | latent | OPEN |
| R17 | server/version.ts:180; src/sim/_dbg.ts | Version hash includes every .ts under src/sim, including an untracked debug script; machines with/without it refuse to join each other. Delete _dbg.ts and hash tracked files only (or exclude `_*.ts`). | MINOR | deploy | OPEN |
| R18 | server/static.ts:27 | Root containment uses `startsWith(root)` without a separator; `/../aevalrena-lan-51800/` serves a sibling directory. | MINOR | security | OPEN |
| R19 | src/ai/profile.ts:67 | One localStorage key per typed name, no cap or eviction; quota errors swallowed silently. Cap at 16 profiles, evict oldest by saved timestamp. | MINOR | robustness | OPEN |
| R20 | src/sim/hits.ts exponentialCharge, Math.sin | `**` with fractional exponents and Math.sin are engine-dependent; a Chrome vs Firefox LAN match may desync. Document (same browser recommended) and consider table-based curves later. | MINOR | determinism | OPEN (documented) |
