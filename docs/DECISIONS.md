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
