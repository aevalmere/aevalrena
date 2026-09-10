# Decisions log

One line per decision. Newest at the bottom. Workers append here when the spec left a choice open.

- 2026-09-09 lead: stack is Vite + TypeScript + Canvas 2D, no framework, no WebGL. Reason: performance on integrated GPUs and a tiny bundle.
- 2026-09-09 lead: sim is a pure fixed-step function over InputFrame[] so rollback netcode can be added without a rewrite.
- 2026-09-09 lead: pixel art is authored as character-grid strings in code and baked to canvases at load. Reason: agents can author and diff it, no binary assets.
- 2026-09-09 lead: the first character is named Aeval (the reference sheet says ???). Name pending owner approval.
- 2026-09-09 lead: grabs, throws, teching and DI are deferred to after the MVP feedback pass.
- 2026-09-09 lead: keyboard smash attacks use a direction-tap window (5 frames) instead of a modifier key.
- 2026-09-09 integration: holding a direction walks; a second tap of the same direction inside 14 frames dashes. Reason: every keyboard press is a "tap", so the old rule dashed on any hold and made ftilt and fsmash unreachable.
- 2026-09-09 integration: a direction flick inside the smash window beats the dash-attack rule, so fsmash is reachable out of a dash the way it is in Smash.
- 2026-09-09 integration: main drains one input sample when a match starts and when the pause menu closes, which clears the keyboard latch so the menu key press is not replayed as a jump or an instant re-pause.
- 2026-09-09 integration: the KeyboardSource attaches once for the whole app with a reference count; sessions add a second reference. Reason: the controls screen needs listenForNextKey before the first match.
- 2026-09-09 integration: a CPU-only match takes its pause key from a window listener, since no slot can produce Btn.Start and the match would otherwise be unquittable.
- 2026-09-09 integration: main drops the finished match when the results screen navigates away on its own, polled from the render callback because UiCallbacks has no screen-change hook.
- 2026-09-09 integration: the CPU holds toward its target when it is facing the wrong way at close range, and keeps recovering when no opponent is alive. Reason: it used to swing at empty air forever, or drift off stage while the other fighter was respawning.
- 2026-09-09 owner: character name Aeval approved. Double-tap dash stays. Defaults of 3 stocks and no timer stay. First deploy target is GitHub Pages.
- 2026-09-09 owner: priority order is feel tuning and fixing known issues before any new feature (grabs, netcode, gamepad wait).
- 2026-09-09 lead: feel constants move from fixed exports to a mutable TUNING object so a debug panel (F4) can change them live; saved values apply at boot from localStorage. Character physics are tuned by mutating the character def in place.
- 2026-09-09 tuning: the calibration harness probes three victim placements and a raised one, because the upward normals and the whirlpool are centered on the attacker and cannot reach a victim standing 40 px away; the table prints the gap and lift each move used.
- 2026-09-09 tuning: knockout percents were reached by scaling each move's bkb and kbg together, which keeps the low-percent feel in proportion to the growth, instead of moving only kbg.
- 2026-09-09 tuning: the whirlpool pull hits drop from 15/40 to 6/10 knockback so the victim stays inside the vortex at high percent and the launching fifth hit still connects; without it dspecial could not kill above about 200 percent.
- 2026-09-09 tuning: damageMul is applied inside applyHit, so it scales percent, shield damage and hitlag together rather than only the number on the hitbox.
- 2026-09-09 tuning: the tuner panel is appended to document.body, not the UI root, because the UI root is hidden while a match runs.
