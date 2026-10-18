import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { catalogsJson } from './i18n';

export const metadata: Metadata = {
  title: 'SyntheTick | Research built around your thesis',
  description:
    'Screen stocks, ETFs, bonds, crypto and prediction markets against your investment thesis.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // suppressHydrationWarning: the inline head script applies the saved theme
    // to <html> before hydration, and signal-desk.js sets lang from the saved
    // language, so the attributes legitimately differ.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // Apply the saved theme before first paint (dark is the default).
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('sd-theme');if(t==='light')document.documentElement.dataset.theme=t}catch(e){}",
          }}
        />
        {/* UI string catalogs for signal-desk.js (issue #17). A JSON data block,
            not a script: the browser never executes it, so it needs no CSP
            allowance (#45). */}
        <script
          type="application/json"
          id="sd-i18n"
          dangerouslySetInnerHTML={{ __html: catalogsJson() }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        {/* pdf.js is self-hosted and loaded on demand by signal-desk.js (security audit M4). */}
      </head>
      <body>{children}</body>
    </html>
  );
}
