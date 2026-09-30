# Aevalrena UI style contract (v2, 2026-09-28)

Owner-supplied references: `art/ui/ref/hud.png` (in-match player card) and
`art/ui/ref/screens.png` (pause menu, WIN card, LOSE card). Every screen, the HUD and the
results screen follow this look. This file is the frozen contract between the UI workers.
Nothing here is optional; a worker that needs something outside it asks the lead.

## 1. Look

- Ground: near-black navy `#070a16`. Panels: `#0b1020` at 92% over a backdrop image.
- Lines are thin (`--line` = 1.5px), not chunky. No 3 px pixel borders anywhere.
- Frames are chamfered: the top-left and bottom-right corners are cut at 45 degrees
  (`--chamfer` = 14px). Build with two nested `clip-path: polygon(...)` boxes: an outer box
  filled with the accent color and an inner box filled with the panel color inset by
  `--line`. Helper class `.ui-frame` (in theme.ts) does this; every panel and card uses it.
- Ornaments: a four-point spark (the `✦` glyph) before headers, a small diamond `◆` on
  separator lines (`.ui-rule`: a 1px line, a diamond in the middle, arrow tips at both ends,
  like the line under WIN). Text has a soft glow: `text-shadow: 0 0 8px <accent at 55%>`.
- Player color drives everything on a per-player element: the CSS variable `--accent` is set
  inline on the element (`style="--accent:#7fb2ff"`), and every color in that subtree derives
  from it via `color-mix(in srgb, var(--accent) N%, ...)`. Default `--accent` (no player) is
  ice blue `#8fd3ff`.
- Backdrops: a dim character image behind the panel, right-aligned, fading to transparent on
  its left edge (mask-image linear gradient), opacity 0.55, tinted to the accent with
  `filter: hue-rotate(var(--hue-shift)) saturate(0.9)`. `--hue-shift` is set inline next to
  `--accent` by `accentVars(slot)` in theme.ts (hue of the player color minus 215, the hue of
  the reference blue).
- Motion: menu cursor slides 120ms ease-out; highlight bar fades 120ms; petals drift with a
  slow CSS keyframe (translate + rotate, 9 to 14s, 3 to 6 petals per screen, no filters
  animating). WIN/LOSE headings scale from 1.15 to 1 over 260ms on show. Percent pop in the
  HUD: scale 1.35 to 1 over 160ms on change. `prefers-reduced-motion` turns every animation off.

## 2. Type

Bundled fonts under `public/fonts/` (self-hosted woff2, loaded with `@font-face` in
`src/ui/theme.ts` CSS; never a CDN link at runtime). Fallback stacks in case a file is missing:

| Role | Family | Fallback | Use |
|---|---|---|---|
| `--font-display` | Cormorant Garamond 500/600 | Georgia, "Times New Roman", serif | percent numerals, WIN / LOSE, character names, title logo, quotes (italic) |
| `--font-ui` | Space Mono 400/700 | Consolas, "Courier New", monospace | every menu label, header, tag, button, table cell, hints |

Menu text is UPPERCASE with `letter-spacing: 0.18em`. Headers (`✦ PAUSE MENU` style): 0.95rem,
letter-spacing 0.22em, accent color. Items 1.05rem, `#c9d4ea`, selected item accent color.
Tags (P1, CPU LV 5, stage name) 0.7rem letter-spacing 0.3em, accent at 80%.

## 3. Assets (worker A produces, everyone else consumes)

All under `public/ui/`. Masks are white RGBA where alpha is the shape (luma of the crop),
so CSS paints them with `background: var(--accent); mask-image: url(...)` and canvas is never
involved. Backdrops are full color RGBA with faded edges.

| File | Cut from | Size (px, approx) | Kind |
|---|---|---|---|
| `ring-hud.png` | hud.png, the swirl of water around the portrait | 210 x 230 | mask, the character region knocked out |
| `ring-win.png` | screens.png WIN card, the circle ring with the spark at the top | 130 x 120 | mask, centre knocked out |
| `splash.png` | screens.png WIN card, the ripple pool and spray at the character's feet | 360 x 60 | mask, feet region knocked out |
| `cursor.png` | screens.png pause menu, the diamond-arrow selector left of RESUME | 36 x 22 | mask |
| `petal-1.png` .. `petal-4.png` | four different petals/leaves from the WIN and LOSE cards | 16 to 30 px | masks |
| `backdrop-face.png` | screens.png pause menu, the face on the right of the panel | 280 x 190 | color RGBA, left edge faded |
| `backdrop-lose.png` | screens.png LOSE card, the slumped figure and petals | 220 x 130 | color RGBA, edges faded |
| `backdrop-stage.png` | hud.png, the dark stage on the right behind the percent | 200 x 120 | color RGBA, edges faded |
| `aeval-win.png` | `art/aeval/sheets/crops/extra_taunt_0.png` copied as is | 43 x 50 | color RGBA, pixel art |

`tools/uicut/cut.py` (Python 3 + Pillow) produces all of them from `art/ui/ref/*.png` with
the crop boxes in the script, so a re-cut is one command: `python tools/uicut/cut.py`.

## 4. Screens

Shared: `src/ui/theme.ts` exports `THEME_CSS` (fonts, variables, `.ui-frame`, `.ui-rule`,
`.ui-spark`, `.ui-cursor`, `.ui-item`, `.ui-bar`, `.ui-petals`, `.ui-backdrop`, buttons,
tables, sliders), `PLAYER_ACCENTS` (the four player colors from `src/render/colors.ts`),
`accentVars(slot: number | null): string` (inline style text `--accent:...;--hue-shift:...deg`),
`hueShift(hex)`, `uiAsset(name)` (path under `import.meta.env.BASE_URL + 'ui/'`), and
`playerTag(players, slot)` -> `'P1'` or `'CPU LV 5'`. `styles.ts` keeps only screen-specific
CSS and is rewritten, not appended to.

1. **Title**: logo `AEVALRENA` in display serif, 500, letter-spacing 0.35em, ice blue with glow,
   a `.ui-rule` under it, `PRESS ANY KEY` mono blinking (steps, 1.1s). `backdrop-stage.png`
   faint at the bottom right, `splash.png` mask faint under the logo, 5 drifting petals.
   Version bottom right in tag style.
2. **Mode select**: left-anchored chamfered panel (like the pause reference), header
   `✦ MODE SELECT`, rows LOCAL / LAN (tag SOON, dimmed) / ONLINE (tag SOON, dimmed) /
   CONTROLS, then a thin rule, then rule rows STOCKS `‹ 3 ›`, FINAL SMASH `‹ ON ›`,
   LV 0 CPU `‹ WANDERS ›`. The selected row gets the cursor mask at its left and the highlight
   bar (`linear-gradient(90deg, accent 30%, transparent)`, chamfered left tip) behind it.
   `backdrop-face.png` on the panel's right. Esc back to title.
3. **Character select**: header `✦ CHARACTER SELECT`. Left: character grid of chamfered tiles
   (icon, name in display serif). Right or below: four player cards, each a `.ui-frame` with
   that slot's `--accent`, laid out like the HUD card: portrait in `ring-hud.png`, character
   name (serif), tag line (`P1 · HUMAN`, `P2 · CPU LV 5`, `OFF`), the CPU level slider styled
   thin with an accent thumb, the human's Attack/Jump keys in tag style. Off cards are 40%
   opacity with a grey accent. Markers are small chamfered tags in the accent color, still
   draggable onto tiles (keep all of the existing drag, click, keyboard and pad behaviour).
   Stage row `STAGE ‹ TIDEGATE ›` and a START button (accent frame) at the bottom.
4. **Controls**: same rows and behaviour as today. Panel is wide; the P1..P4 tabs are chamfered
   tags in each player's color and the active tab sets the panel's `--accent`, so the whole
   screen recolors per player. Section rows in accent letter-spaced caps; note rows dim.
   Selected cell: accent outline. Listening cell: white text on accent at 25%.
5. **Pause**: match the reference: panel anchored left-center, header `✦ PAUSE MENU`, rows
   RESUME / MOVE LIST / CONTROLS / QUIT with cursor and highlight bar, `backdrop-face.png`
   on the right. Esc resumes. The HUD stays visible under it (the HUD host is outside `#ui`).
6. **Move list** (new screen id `movelist`): header `✦ MOVE LIST`, a tag row with the
   character name, a chamfered table: MOVE | INPUT | DAMAGE for the 17 attack moves plus the
   grab/throws in the owner's order (`docs/SPEC.md` section 5 names). INPUT is the Smash
   recipe (`ATTACK`, `SIDE + ATTACK`, `FLICK UP + ATTACK`, `AIR DOWN + ATTACK`, `SPECIAL`, ...),
   plus the P1 shortcut chord when one is bound. DAMAGE comes from the move's first hitbox.
   Esc or BACK returns to `state.movelistReturnTo` (pause or mode).
7. **Results** (split screen): the screen is split into N equal full-height columns, one per
   player in slot order (N = 2..4), each column a `.ui-frame` with that player's `--accent`.
   Winner column: `WIN` (display serif, 4rem, accent, glow), `.ui-rule`, character name and
   tag under it; the character's win pose (`CHARACTER_LIST[i].winPose`, pixelated, 3x)
   centred in `ring-win.png` over `splash.png`, 5 petals drifting; a quote in italic serif to
   the side (`QUOTES[charId]`, a small list in `src/ui/quotes.ts`, picked by `seed % length`).
   Loser columns: `LOSE` in the accent desaturated to 60%, an `OPPONENT` style line with
   `P2 · CPU LV 5`, `backdrop-lose.png` hue-shifted to the accent, 3 petals, 70% brightness.
   Every column ends with a stats block in mono: `PLACE 1ST`, `STOCKS 2`, `DAMAGE 84.3%`.
   Place = rank by stocks desc then percent asc. A draw shows `DRAW` in every column with no
   ring. Bottom bar over the columns: REMATCH and CHARACTER SELECT buttons with the cursor;
   Enter/Space activates, Left/Right moves.
   `CHARACTER_LIST` entries gain `winPose?: string` (`'ui/aeval-win.png'`).
   `ResultsData` gains `players[].cpu: boolean`, `players[].cpuLevel: number` and `seed: number`
   so the screen can build tags and pick a quote.
   Stats block (2026-09-28): rows PLACE, STOCKS, KOs, FALLS, SDs, DAMAGE GIVEN, DAMAGE TAKEN,
   PEAK DAMAGE, MAX COMBO, MOST USED MOVE, GRABS, THROWS, SHIELD BREAKS, LEDGE GRABS, TECHS,
   DODGES, FINAL SMASHES (used / hit), PROJECTILES (hit / fired), AIR TIME, TIME IN LEAD, FIRST KO,
   DISTANCE RUN, from `ResultsData.players[].stats` and `matchFrames`. Labels mono 0.66rem
   letter-spacing 0.18em in the accent at 45% over grey (KOs and SDs keep their lowercase s);
   values accent-tinted with glow, right aligned, ellipsis. Two column-major stat columns with 2
   players, one with 3 or 4. The block is at most 46% of the column tall and scrolls
   (`overflow-y: auto`, thin accent scrollbar). Missing values read NONE, never a dash.

## 5. HUD (in match, DOM, not canvas)

`src/render/hud.ts` is replaced by a DOM HUD in `src/ui/hud.ts`: `createHud(host, deps)`
returning `{ start(state), update(state), stop() }`. The host is `#hud`, a sibling of `#ui`
inside `#app`, positioned over the canvas: `main.ts` reads the canvas fit
(`fitCanvas` result) on resize and sets the host's left/top/width/height to the canvas CSS
box, so the HUD scales with the game view (font sizes in `cqw` units; the host is a
`container-type: size` element). The renderer no longer draws a HUD (`drawHud` call and hud
state removed from `src/render/index.ts`; `src/render/hud.ts` deleted).

Card layout per player (sizes as shipped 2026-09-28): bottom row, centred, gap 1.5cqw, bottom
inset 1cqw, card 27cqw x 15cqw (23cqw with 4 players via `.hud-row-4`). No visible frame; only a
soft dark radial backing behind the text column. Left: the ring mask (`ring-hud.png`) painted in
the accent at 13cqw, with the character bust (`icons/<char>-bust.png`, pixelated, 9cqw tall,
hair breaking above the ring; falls back to `icons/<char>.png`). Right: the percent in display
serif 600 with lining numerals, integer 6.5cqw, `.d%` 3.2cqw, baseline aligned, colored by
`percentColor`, a fading accent rule under it; the character name (serif 1.9cqw, .25em
spacing); the tag (`P1` or `CPU LV 5`, mono 1.2cqw, accent); stocks as the head icon
(`icons/<char>-stock.png`) at 2cqw each, lost stocks dim greyscale ghosts; the Final Smash meter
(rule on only) as a 0.5cqw accent bar that pulses white when full. KO'd card: 35% opacity and
greyscale. Percent changes trigger the pop. Percent shows one decimal (floor to 0.1).
Bust and stock icons come from `tools/uicut/portrait.py` (native pixel crops of idle frame 0).

Only changed values touch the DOM: keep last percent, stocks, meter per slot and compare.
`update(state)` is called once per render frame by `main.ts`.

## 6. Rules for every worker

- Keyboard and pad navigation must keep working on every screen (padnav dispatches arrow
  keys, Enter and Escape). Mouse still works.
- No new dependencies. `npm run typecheck` and `npm run build` must pass.
- No em dashes in UI copy. All menu copy uppercase via CSS, not in source strings.
- Do not touch `src/sim`, `src/characters/aeval/art`, or any file another worker owns.

## 7. Name tags and team swatch (2026-09-28)

**Name tag** (`src/ui/hud.ts`, `.hud-ntag`): one per fighter inside `#hud .hud-ntags` (an
`inset: 0` layer, `pointer-events: none`). A label over a chevron, no box: Space Mono 700,
`max(18px, 1.78cqw)`, uppercase, letter-spacing 0.3em, color the accent mixed 12% toward white,
text-shadow a stronger accent glow (80%, `max(8px, 0.75cqw)`) plus a thin black edge, behind it a radial ink haze (`::before`,
55% ink fading out). The chevron is a `max(14px, 1.4cqw)` by `max(8px, 0.85cqw)` V (drop-shadow glow on the box, accent 85%, `max(4px, 0.4cqw)`) cut with
`clip-path` in the accent. Text is `playerTag()`: the typed name for a human, `CPU LV n` for a
CPU. Placed by transform every render frame at the fighter's feet minus 44 world px, eased
(30 ms time constant), clamped 6px inside the canvas box and above the card row (16.5cqw from
the bottom). 40% opacity (140ms fade) in hitstun, tumble or KO'd; hidden when out of stocks.
Sprites never get a coloured outline; the tag is how fighters are told apart.

**Team swatch** (`src/ui/select.ts`, `.sel-swatch`): a 30 x 20 `.ui-frame` with `--chamfer: 6px`,
inner fill a 135deg gradient from the accent to the accent at 45% over the panel; hover and focus
add an accent drop-shadow glow. It sits left of the name field in the `.sel-id-row` under the
card header. Click or T cycles the slot's team colour through `PLAYER_ACCENTS`
(blue, red, yellow, green); the chosen colour is the slot's `--accent` everywhere
(`playerAccentVars(players, slot)` in theme.ts). **Name field** (`.sel-name`, humans only):
Space Mono 700 0.78rem caps, letter-spacing 0.18em, no box, a 1px accent underline at 40% that
goes full accent with glow while editing.

**Outfit colour** (`src/ui/select.ts`, `.sel-variants`, 2026-09-29): under the card header of
each active slot, four 13 px circles filled with `VARIANT_SWATCHES` (blue, purple, white, pink
from `src/render/palette.ts`; the only colours outside the accent tokens), the current one ringed
in the panel colour and then the accent. A colour another slot already uses on the same character
is dimmed and cannot be picked. `[` / `]`, pad L1 / R1 or a click cycles it; the portrait bust
redraws in the chosen colour. The LAN lobby card shows the same swatch as a chip.
