/** Adobe Helvetica AFM advance widths (per 1000 em) for ASCII 32..126. */
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space .. /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, // 0-9
  278, 278, 584, 584, 584, 556, 1015, // : ; < = > ? @
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, // A-Z
  278, 278, 278, 469, 556, 333, // [ \ ] ^ _ `
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, // a-z
  334, 260, 334, 584, // { | } ~
];

/** Average width for characters outside ASCII (Latin-1 accents, punctuation). */
const FALLBACK_WIDTH = 556;

export function charWidth(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return WIDTHS[code - 32];
  return FALLBACK_WIDTH;
}

/** Estimated rendered width in points of `text` in Helvetica at `fontSize`. */
export function estimateTextWidth(text: string, fontSize: number): number {
  let total = 0;
  for (const ch of text) total += charWidth(ch);
  return (total / 1000) * fontSize;
}
