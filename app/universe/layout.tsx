import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Robinhood Chain RWA Universe | SyntheTick',
  description:
    'Every tokenized stock and ETF on Robinhood Chain with live venue quotes, Uniswap prices, onchain token data and SyntheTick fundamentals.',
};

export default function UniverseLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
