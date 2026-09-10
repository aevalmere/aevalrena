/**
 * Pixel-art menu styling. Injected once into a <style> element by createUi.
 * Palette per docs/SPEC.md section 6. No border-radius, no gradients, no
 * blurred box-shadow (offset shadows with 0 blur are used for depth).
 */
export const STYLE_CSS = `
.aev-ui-root {
  position: absolute;
  inset: 0;
  font-family: "Courier New", Consolas, monospace;
  color: #c9d1e0;
  letter-spacing: 1px;
  user-select: none;
  -webkit-user-select: none;
}

/* Class rules below set display, which would beat the user-agent [hidden] rule. */
.aev-ui-root [hidden] {
  display: none !important;
}

.aev-ui-root * {
  box-sizing: border-box;
  font-family: inherit;
  letter-spacing: inherit;
}

.aev-screen {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2%;
}

.aev-panel {
  background: rgba(26, 27, 38, 0.95);
  border: 3px solid #6e7a94;
  border-radius: 0;
  box-shadow: 6px 6px 0 rgba(14, 15, 23, 0.8);
  padding: 1.5rem 2rem;
  max-width: 94%;
  max-height: 92%;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.aev-panel-narrow {
  width: min(90%, 24rem);
}

.aev-panel-wide {
  width: min(96%, 56rem);
}

.aev-heading {
  font-size: clamp(1.1rem, 3vw, 1.6rem);
  color: #c9d1e0;
  text-align: center;
  margin: 0;
}

.aev-subtext {
  font-size: 0.8rem;
  color: #9aa5b8;
  text-align: center;
  margin: 0;
}

/* ---- Title screen ---- */

.aev-title-wrap {
  text-align: center;
}

.aev-title-logo {
  font-size: clamp(2rem, 8vw, 5rem);
  color: #7fb2ff;
  letter-spacing: 6px;
  margin: 0 0 1rem 0;
}

.aev-title-blink {
  font-size: clamp(0.9rem, 2.5vw, 1.3rem);
  color: #c9d1e0;
  animation: aev-blink-step 1.1s steps(1) infinite;
}

@keyframes aev-blink-step {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}

.aev-version {
  position: absolute;
  right: 1%;
  bottom: 1%;
  font-size: 0.7rem;
  color: #3a4a6b;
}

/* ---- Lists / menu items ---- */

.aev-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  width: 100%;
}

.aev-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.6rem 0.9rem;
  border: 3px solid #6e7a94;
  background: transparent;
  color: #c9d1e0;
  font-size: 1rem;
  cursor: pointer;
  text-align: left;
}

.aev-item:hover:not(.aev-item-disabled) {
  border-color: #7fb2ff;
  color: #7fb2ff;
}

.aev-item.aev-item-selected:not(.aev-item-disabled) {
  border-color: #7fb2ff;
  color: #7fb2ff;
  background: rgba(127, 178, 255, 0.1);
}

.aev-item:focus-visible {
  outline: 2px solid #7fb2ff;
  outline-offset: 2px;
}

.aev-item-disabled {
  color: #3a4a6b;
  border-color: #3a4a6b;
  cursor: default;
}

.aev-item-suffix {
  font-size: 0.75rem;
  color: #3a4a6b;
}

/* ---- Buttons ---- */

.aev-btn {
  font-family: inherit;
  letter-spacing: inherit;
  border: 3px solid #6e7a94;
  border-radius: 0;
  background: transparent;
  color: #c9d1e0;
  padding: 0.5rem 1rem;
  font-size: 0.9rem;
  cursor: pointer;
}

.aev-btn:hover:not(:disabled) {
  border-color: #7fb2ff;
  color: #7fb2ff;
}

.aev-btn:focus-visible {
  outline: 2px solid #7fb2ff;
  outline-offset: 2px;
}

.aev-btn:disabled {
  color: #3a4a6b;
  border-color: #3a4a6b;
  cursor: default;
}

.aev-btn-selected {
  border-color: #7fb2ff;
  color: #7fb2ff;
  background: rgba(127, 178, 255, 0.1);
}

.aev-btn-accent {
  border-color: #7fb2ff;
  color: #7fb2ff;
}

.aev-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.aev-row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

/* ---- Stepper (stocks) ---- */

.aev-stepper {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.aev-stepper-value {
  min-width: 1.5rem;
  text-align: center;
  color: #7fb2ff;
  font-size: 1.1rem;
}

.aev-stepper-btn {
  border: 3px solid #6e7a94;
  background: transparent;
  color: #c9d1e0;
  width: 1.8rem;
  height: 1.8rem;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
}

.aev-stepper-btn:hover:not(:disabled) {
  border-color: #7fb2ff;
  color: #7fb2ff;
}

.aev-stepper-btn:disabled {
  color: #3a4a6b;
  border-color: #3a4a6b;
  cursor: default;
}

/* ---- Character select cards ---- */

.aev-cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.75rem;
  width: 100%;
}

.aev-card {
  border: 3px solid #6e7a94;
  padding: 0.6rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
  min-height: 8rem;
  text-align: center;
}

.aev-card:hover {
  border-color: #7fb2ff;
}

.aev-card.aev-card-selected {
  border-color: #7fb2ff;
  background: rgba(127, 178, 255, 0.08);
}

.aev-card:focus-visible {
  outline: 2px solid #7fb2ff;
  outline-offset: 2px;
}

.aev-card-slot {
  font-size: 0.75rem;
  color: #9aa5b8;
}

.aev-card-mode {
  font-size: 1rem;
  color: #c9d1e0;
}

.aev-card-char {
  font-size: 0.85rem;
  color: #7fb2ff;
}

.aev-card-hint {
  font-size: 0.65rem;
  color: #3a4a6b;
}

.aev-card-keys {
  font-size: 0.65rem;
  color: #9aa5b8;
}

.aev-stage-line {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  font-size: 0.9rem;
}

/* ---- Controls table ---- */

.aev-tabs {
  display: flex;
  gap: 0.4rem;
}

.aev-tab {
  border: 3px solid #6e7a94;
  background: transparent;
  color: #c9d1e0;
  padding: 0.35rem 0.8rem;
  cursor: pointer;
  font-size: 0.85rem;
}

.aev-tab:hover {
  border-color: #7fb2ff;
}

.aev-tab.aev-tab-active {
  border-color: #7fb2ff;
  color: #7fb2ff;
  background: rgba(127, 178, 255, 0.1);
}

.aev-tab:focus-visible {
  outline: 2px solid #7fb2ff;
  outline-offset: 2px;
}

.aev-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.aev-table th, .aev-table td {
  border: 1px solid #3a4a6b;
  padding: 0.4rem 0.6rem;
  text-align: left;
}

.aev-table th {
  color: #9aa5b8;
  font-weight: normal;
}

.aev-table tr.aev-row-selected td {
  background: rgba(127, 178, 255, 0.08);
}

.aev-key-cell {
  cursor: pointer;
  color: #7fb2ff;
}

.aev-key-cell:hover {
  color: #b8e3ff;
}

.aev-key-cell.aev-key-listening {
  color: #f0ead6;
}

.aev-key-cell.conflict {
  color: #ff7f7f;
}

.aev-toggle-cell {
  cursor: pointer;
}
`;
