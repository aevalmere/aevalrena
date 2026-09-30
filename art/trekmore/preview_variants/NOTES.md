# Colour variants: final numbers (W1-colours, 2026-09-30)

Source: `src/render/palette.ts`. Previews: `npx --yes tsx tools/variants/preview.ts --char trekmore` and `--char aeval`.
Measured inputs: `art/trekmore/palette_measure.json`.

## Trekmore

Band 1, glow (applied first):
- hue 262..290, centre 277, feather 14; sat from 0.20 (feather 0.05); lightness from 0.30 (full at 0.35), no top.
- Provisional was hue 255..300 centre 275 feather 10, sat from 0.35, lightness from 0.35.

Band 2, cloth:
- hue 258..290, centre 273, feather 14; sat from 0.20; lightness 0.07..0.35 (feathers 0.03).
- Provisional was hue 250..300 centre 275 feather 10.

Ink: lightness below 0.07 never moves (unchanged).

Targets (glow / cloth):
- Red: glow hue 358, spread 0.3, sat x1.1, floor 0.6, lightCurve -0.25. Cloth hue 344, spread 0.3, sat x1.2, floor 0.5.
  Provisional was hue 4, spread 0.5, sat x1.05 on both.
- White: glow keeps hue, sat x0.35, lift 0.45. Cloth keeps hue, sat x0.10, lift 0.05, lightCurve 1.4.
  Provisional was sat x0.06 with lift 0.40 / 0.28.
- Gold (both bands): hue 44 clamped 40..48, sat x1.05, floor 0.6, lightCurve 0.35. Metal: highlight 0.65 toward #fff2c0 above
  lightness 0.70; shade at or below 0.24 turns to hue 28. Provisional was hue 45 clamped 42..48, sat x1.1, floor 0.7, highlight 0.6
  above 0.75, shadow hue 30 below 0.20.
- Swatches: red #e0323c changed to #c81e3a (crimson, matches the new glow). Others unchanged.

Why:
- Measured hue bands (glow 263.9..289.0, cloth 261.2..288.9) are percentile cores; with them alone the edge hues (250..262, 290..300)
  stayed violet. The cores are kept, with a wider feather so edges blend rather than seam.
- Armour highlights sit at lightness 0.35..0.55 with saturation 0.20..0.35: under neither provisional band, so they stayed violet
  specks in every variant. Glow sat floor 0.20 picks them up.
- The glow lightness start moved to 0.30 so it overlaps the cloth's top feather; before, pixels at 0.35..0.38 got under 75 percent
  weight and showed as violet seams.
- Red at hue 4 turned the cloth brown and the glow scarlet. Cloth gets its own target (hue 344, more saturation) so it reads as
  wine; glow moves to 358 and is darkened a touch so highlights do not go salmon.
- White at sat 0.06 turned the glow flat grey and the lifted cloth a flat mid grey. The glow keeps a third of its saturation
  (lavender white); the cloth uses a mid-tone curve instead of a flat lift, so darks stay dark and the plates read as silver.
- Gold with the wider glow band put low-saturation highlights at sat 0.77, which read as flat yellow. Floor 0.6, a wider polished
  highlight and a slightly higher bronze cut-off give metal.

How each variant reads:
- 0 Purple: untouched, as drawn.
- 1 Red: deep crimson glow on the slashes and bursts, dark wine armour, no pink or brown cast.
- 2 White: silver plates with dark joints and intact outline, glow a pale lavender white.
- 3 Gold: warm pale highlights, bronze shade, ochre mid tones; reads as metal, not paint.

## Aeval coat (band 2)

- hue 210..250, centre 232, feather 10; sat 0.06..0.33 (feather 0.02); lightness 0.14..0.47 (feather 0.04, zero by 0.51).
- strength 0.85 (was 0.45).
- Purple: hue 280, sat floor 0.30 (was 0.22). White: sat x0.10, lift 0.30 (was x0.12, 0.25). Pink: hue 335, lift 0.06, floor 0.30
  (was 340, 0.05, 0.22).
- Provisional band was hue 190..250, centre 220, lightness 0.14..0.45 (feather 0.03).

Why: the measured coat is hue 212..249 and saturation 0.08..0.25. Hair shares that hue and saturation, so the only separator is
lightness: hair is 0.51..0.77, so the band stops at 0.47 and reaches zero by 0.51. The coat's own highlights above 0.5 stay as drawn;
the coat's body (0.18..0.47) carries the variant. The outline #1b192b (lightness 0.133) and skin (hue about 20) are outside the band.
At strength 0.45 the coat barely moved; 0.85 makes it read at a glance.

How each variant reads:
- 0 Blue: untouched.
- 1 Purple: coat clearly violet, hair still grey.
- 2 White: coat a pale ash grey, hair unchanged.
- 3 Pink: coat a plum pink, hair unchanged.

## Rendertest expectations changed

- Trekmore red: hue near 348 within 10 (was near 4 within 12).
- Trekmore white: saturation at most half the drawn saturation (was at most 0.12), since the glow now keeps a lavender tint.
- Trekmore gold on #6a30c0: hue 40..48 and saturation at least 0.6 (was 42..48 and 0.7).
