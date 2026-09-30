/**
 * Short game codes for the in-browser LAN mode (docs/LAN.md section 11). Shared by the
 * rendezvous handler (server/rendezvous/handler.ts) and the page, so both agree on what a code is.
 *
 * Four characters from 31 letters and digits that cannot be mixed up when read aloud or off a
 * screen: no 0 or O, no 1, I or L.
 */

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
/** Guest ids: longer, since nobody types them. */
export const GUEST_ID_LENGTH = 8;

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const GUEST_RE = new RegExp(`^[${CODE_ALPHABET}]{${GUEST_ID_LENGTH}}$`);

export function isRoomCode(s: string): boolean {
  return CODE_RE.test(s);
}

export function isGuestId(s: string): boolean {
  return GUEST_RE.test(s);
}

/** A random string over the alphabet. `random` returns [0, 1). */
export function randomCode(length: number, random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return out;
}

/** What a player typed, as a code: upper case, with anything outside the alphabet dropped. */
export function normalizeCode(text: string): string {
  let out = '';
  for (const ch of text.toUpperCase()) if (CODE_ALPHABET.includes(ch)) out += ch;
  return out;
}
