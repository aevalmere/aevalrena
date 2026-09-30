import { VARIANT_COUNT, remapPixels } from './palette';

/**
 * Character icons and busts (public/icons) in a colour variant, for the DOM screens: the
 * image is decoded once, run through the same remap the sprite bake uses, and served as an
 * object URL. Results are cached per (character, variant, url), so a card that redraws does not
 * redo it. `charId` picks the character's palette bands (default Aeval).
 */

const cache = new Map<string, Promise<string>>();

function recolor(url: string, variant: number, charId: string): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = (): void => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx === null) {
          resolve(url);
          return;
        }
        ctx.drawImage(image, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        remapPixels(data.data, variant, charId);
        ctx.putImageData(data, 0, 0);
        canvas.toBlob((blob) => resolve(blob === null ? url : URL.createObjectURL(blob)));
      } catch {
        // A tainted or undecodable image: show it in the base colour.
        resolve(url);
      }
    };
    image.onerror = (): void => resolve(url);
    image.src = url;
  });
}

/** `url` recoloured for `variant`; variant 0 (or out of range) resolves to `url` itself. */
export function variantImageUrl(url: string, variant: number, charId = 'aeval'): Promise<string> {
  if (variant <= 0 || variant >= VARIANT_COUNT) return Promise.resolve(url);
  const key = charId + '|' + variant + '|' + url;
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = recolor(url, variant, charId);
    cache.set(key, hit);
  }
  return hit;
}

/**
 * Point `img` at `url` in `variant`. A later call on the same element wins, so a quick run of
 * swatch changes never lands on a stale colour.
 */
export function setVariantSrc(img: HTMLImageElement, url: string, variant: number, charId = 'aeval'): void {
  const key = charId + '|' + variant + '|' + url;
  img.dataset.variantSrc = key;
  if (variant <= 0 || variant >= VARIANT_COUNT) {
    img.src = url;
    return;
  }
  void variantImageUrl(url, variant, charId).then((src) => {
    if (img.dataset.variantSrc === key) img.src = src;
  });
}
