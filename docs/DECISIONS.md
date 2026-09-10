# Decisions log

One line per decision. Newest at the bottom. Workers append here when the spec left a choice open.

- 2026-09-09 lead: stack is Vite + TypeScript + Canvas 2D, no framework, no WebGL. Reason: performance on integrated GPUs and a tiny bundle.
- 2026-09-09 lead: sim is a pure fixed-step function over InputFrame[] so rollback netcode can be added without a rewrite.
- 2026-09-09 lead: pixel art is authored as character-grid strings in code and baked to canvases at load. Reason: agents can author and diff it, no binary assets.
- 2026-09-09 lead: the first character is named Aeval (the reference sheet says ???). Name pending owner approval.
- 2026-09-09 lead: grabs, throws, teching and DI are deferred to after the MVP feedback pass.
- 2026-09-09 lead: keyboard smash attacks use a direction-tap window (5 frames) instead of a modifier key.
