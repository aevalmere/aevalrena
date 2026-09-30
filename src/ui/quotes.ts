/** Win quotes per character id, shown on the results screen in the winner's column. */
export const QUOTES: Record<string, string[]> = {
  aeval: [
    'The ocean remembers what we try to forget.',
    'Every tide goes out. Mine comes back.',
    'You fought the current. The current does not notice.',
    'Still water, deep enough to drown in.',
    'The shore always gives way in the end.',
    'I only followed the pull of the moon.',
  ],
  trekmore: [
    'Everywhere I go, the shadow follows.',
    'Moonanchor holds.',
    'No face. No fear. Only wins.',
    'The Queen sleeps soundly tonight.',
    'Your shadow knew before you did.',
    'Kneel. The blade is heavier than you.',
  ],
};

const GENERIC_QUOTES: string[] = [
  'Not bad. Not enough.',
  'Get up. Try again.',
  'The stage is mine.',
];

/** A quote for `charId`, picked by `seed % length`; unknown ids fall back to a generic list. */
export function pickQuote(charId: string, seed: number): string {
  const list = QUOTES[charId] ?? GENERIC_QUOTES;
  const n = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) : 0;
  return list[n % list.length];
}
