/**
 * Cap-class banding (spec §4.1 step 4). Input MUST be USD (§4.1c).
 *   mega  > $200B
 *   large $10B – $200B
 *   mid   $2B – $10B
 *   small $300M – $2B
 *   micro < $300M
 */
export type CapClass = 'mega' | 'large' | 'mid' | 'small' | 'micro';

const B = 1_000_000_000;
const M = 1_000_000;

export function capClass(marketCapUsd: number | null | undefined): CapClass | null {
  if (marketCapUsd == null || !Number.isFinite(marketCapUsd) || marketCapUsd <= 0) {
    return null;
  }
  if (marketCapUsd > 200 * B) return 'mega';
  if (marketCapUsd >= 10 * B) return 'large';
  if (marketCapUsd >= 2 * B) return 'mid';
  if (marketCapUsd >= 300 * M) return 'small';
  return 'micro';
}
