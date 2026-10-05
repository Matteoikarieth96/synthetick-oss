/**
 * Clipping for user-facing text (QA P2-16). A bare `slice(0, n)` cut vendor
 * descriptions and model prose mid-word on the cards and in the API payload
 * ("specifically tho", "income maxi"). Pure: no env, no network.
 */

/** At most `max` chars, cut at a word boundary with an ellipsis when anything
 * was dropped. A single word longer than the window is cut hard (still with
 * the ellipsis) rather than returning nothing. */
export function clipText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const room = Math.max(1, max - 1); // one char for the ellipsis
  const head = t.slice(0, room);
  const space = head.lastIndexOf(' ');
  const cut = space >= room / 2 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:(\-–—]+$/, '')}…`;
}

/** Length of the description prefix stored as a candidate's blurb (SQL
 * `left(description, 300)` in match_candidates, and the same slice in code). */
export const BLURB_CHARS = 300;

/** A blurb at the full prefix length was cut by the query, almost always
 * mid-word: re-clip it at a word boundary for display. Shorter blurbs are
 * whole descriptions and pass through. */
export function clipBlurb(blurb: string): string {
  return blurb.length >= BLURB_CHARS ? clipText(blurb, BLURB_CHARS - 1) : blurb.trim();
}
