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
  appearance: none;
  -webkit-appearance: none;
  background: #232538;
  border: 2px solid #6e7a94;
  border-radius: 0;
  padding: 0.15rem 0.9rem;
  cursor: pointer;
  box-shadow: 3px 3px 0 rgba(14, 15, 23, 0.8);
}

.aev-card-mode:hover {
  background: #2c2f46;
  border-color: #9aa5b8;
}

.aev-card-mode:active {
  box-shadow: none;
  transform: translate(3px, 3px);
}

.aev-card-selected .aev-card-mode {
  border-color: #7fb2ff;
}

.aev-card-dim .aev-card-mode {
  color: #6e7a94;
  border-color: #3a4a6b;
  box-shadow: none;
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

/* ---- Character grid + drag markers ---- */

.aev-char-grid {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.75rem;
  width: 100%;
}

.aev-char-tile {
  width: 8rem;
  min-height: 8rem;
  flex: 0 0 auto;
  border: 3px solid #6e7a94;
  background: rgba(58, 74, 107, 0.18);
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
}

.aev-char-tile:hover {
  border-color: #7fb2ff;
}

.aev-char-tile.aev-char-tile-hover {
  border-color: #f0ead6;
  background: rgba(127, 178, 255, 0.18);
}

.aev-char-art {
  width: 100%;
  height: 4.6rem;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.aev-char-img {
  max-width: 100%;
  max-height: 100%;
  image-rendering: pixelated;
  -ms-interpolation-mode: nearest-neighbor;
}

.aev-char-placeholder {
  width: 4rem;
  height: 4rem;
  border: 3px solid #3a4a6b;
  color: #9aa5b8;
  font-size: 1.1rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.aev-char-name {
  font-size: 0.75rem;
  color: #7fb2ff;
  text-align: center;
}

.aev-tile-markers {
  margin-top: auto;
  min-height: 1.35rem;
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
}

.aev-marker-home {
  min-height: 1.35rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.aev-marker {
  width: 1.7rem;
  height: 1.2rem;
  border-radius: 0;
  color: #14151f;
  font-size: 0.65rem;
  line-height: 1.2rem;
  text-align: center;
  cursor: grab;
  box-shadow: 2px 2px 0 rgba(14, 15, 23, 0.8);
  touch-action: none;
}

.aev-marker.aev-marker-dragging {
  opacity: 0.35;
  cursor: grabbing;
}

.aev-marker-ghost {
  position: fixed;
  pointer-events: none;
  z-index: 50;
  opacity: 0.9;
}

.aev-card-dim {
  opacity: 0.55;
}

/* ---- CPU difficulty slider ---- */

.aev-cpu-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
}

.aev-cpu-label {
  font-size: 0.65rem;
  color: #9aa5b8;
}

.aev-cpu-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 0.75rem;
  background: transparent;
  cursor: pointer;
}

.aev-cpu-slider:focus-visible {
  outline: 2px solid #7fb2ff;
  outline-offset: 2px;
}

.aev-cpu-slider::-webkit-slider-runnable-track {
  height: 0.5rem;
  background: #3a4a6b;
  border: 0;
  border-radius: 0;
}

.aev-cpu-slider::-moz-range-track {
  height: 0.5rem;
  background: #3a4a6b;
  border: 0;
  border-radius: 0;
}

.aev-cpu-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 0.7rem;
  height: 1rem;
  margin-top: -0.25rem;
  background: #7fb2ff;
  border: 0;
  border-radius: 0;
}

.aev-cpu-slider::-moz-range-thumb {
  width: 0.7rem;
  height: 1rem;
  background: #7fb2ff;
  border: 0;
  border-radius: 0;
}
`;
