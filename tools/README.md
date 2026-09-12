# Art tooling

Python, not TypeScript, and deliberately outside the build. Neither script is
imported by the game; both exist so the pixel art can be regenerated and
inspected rather than hand-edited blind. Requires Pillow (`pip install pillow`).

## `gen_fx.py`

Generates `src/characters/aeval/art/fx.ts` — the 24 water effect frames.

The frames in that `.ts` are generated output, not hand-typed. The geometry that
matters lives in named constants near the top of each section:

| constant | controls |
|---|---|
| `WHIRL_BANDS`, `WHIRL_THROAT` | the whirlpool funnel: three nested elliptical bands, each with a gap at a different angle, draining to a throat low and right of centre |
| `GEYSER_SPIKES` | the geyser's seven overlapping water spikes |
| `SPLASH_SPIKES` | the ground splash prongs |
| `ORB0`, `HITSPARK`, `DUST` | hand-placed literals, not generated |

Sizes are fixed by `FX_SIZES` in `src/characters/aeval/art/validate.ts` and must
not drift — run `npm run validate:art` after regenerating.

Design note worth keeping: the whirlpool reads as a funnel because it is nested
elliptical *bands* with offset gaps, not a spiral. An earlier version drew
genuine spiral arms through two-plus revolutions and read as a spiral galaxy; no
amount of thickening fixed it, because that was a silhouette problem rather than
a colour-value one.

## `preview_sheet.py`

Renders any `PixelSheet` module to a PNG so a change can be looked at instead of
guessed at.

```
python tools/preview_sheet.py <file.ts> <EXPORT_NAME> <out.png> [frame ...]
```

With no frame list it renders every frame, 8 per row, labelled. Transparent
pixels show as dark slate, characters missing from the palette render as
magenta, and a ground line is drawn on the last row so foot placement can be
checked. It prints `PROBLEM` lines for frames that are not 40x32 — expected and
ignorable for FX frames, which have their own sizes, real for body frames.

Check small-size readability too: a sprite that cannot be identified at 1x has
failed, regardless of how it looks zoomed in.
