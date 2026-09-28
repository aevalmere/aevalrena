# Aeval reference (empty, waiting for the new sheet)

Drop the new character sheet here as `art/aeval/reference/aevalmere.png`.
Keep that exact filename: PROMPT.md, SPEC.md and DECISIONS.md all point at it.

The previous sheet, its crops and the Pixler idle candidates are archived
outside the repo at `../aevalrena-archive/art-aeval-2026-09-15/`.

## Lead intake checklist (run after the sheet lands, before any worker starts)

1. Read the sheet. Cut upscaled crops into `crops/` (portrait, turnaround,
   idle, walk, run, jump, fall, land, effects, expressions, or whatever the new
   sheet actually has). List the crop names in PROMPT.md section 2.
2. Pick the palette from the sheet: fill PROMPT.md section 5 (keys, ramps,
   usage table). Ink `#0e0c16` and the water ramp `Q A a q z` are fixed.
3. Write PROMPT.md section 6: silhouette sentences, the idle0 pixel plan
   (rows, columns, ramp keys per body part), expression rules.
4. Write the Step A4 idle-loop shift commands from the section 6 coordinates.
5. Write the Pixler generate prompt in section 3 from the new sheet.
6. Rewrite every Step B description (batches B1..B7) and re-check Step C
   effect sizes against the new anatomy. anims.json does not change.
7. Update docs/SPEC.md line "Palette base (from the reference art)" and the
   character line under Characters if the design changed.
8. Delete every `TO BE WRITTEN` and `REFERENCE-BOUND` marker and the NOT READY
   box at the top of PROMPT.md. `grep -c "TO BE WRITTEN" art/aeval/PROMPT.md`
   must print 0.
9. Dispatch the art worker with PROMPT.md. One gate: idle. Then the full set
   (66 body animations, 13 effects) without stopping.
