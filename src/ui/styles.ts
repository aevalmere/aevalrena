/**
 * Root and screen container rules. Injected once by createUi after THEME_CSS.
 * Screen-specific rules live in each screen module's exported CSS string.
 */
export const STYLE_CSS = `
.aev-ui-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: var(--ink);
  font-family: var(--font-ui);
  color: var(--text);
  user-select: none;
  -webkit-user-select: none;
}

/* Class rules set display, which would beat the user-agent [hidden] rule. */
.aev-ui-root [hidden] {
  display: none !important;
}

.aev-ui-root *, .aev-ui-root *::before, .aev-ui-root *::after {
  box-sizing: border-box;
}

/* Pause sits over the frozen match, so the root is see-through there. */
.aev-ui-root:has(> .aev-screen-pause), .aev-ui-root:has(> .aev-screen-movelist-over) {
  background: color-mix(in srgb, var(--ink) 55%, transparent);
}

.aev-screen {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  padding: 3vh 3vw;
}

.aev-screen-title,
.aev-screen-select,
.aev-screen-controls,
.aev-screen-results,
.aev-screen-movelist {
  align-items: center;
  justify-content: center;
}

/* Mode select and pause: panel anchored left of centre, vertically centred. */
.aev-screen-mode,
.aev-screen-pause {
  align-items: flex-start;
  justify-content: center;
  padding-left: 8vw;
}
`;
