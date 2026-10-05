import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'SyntheTick | Research built around your thesis',
  description:
    'Screen stocks, ETFs, bonds, crypto and prediction markets against your investment thesis.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // suppressHydrationWarning: the inline head script applies the saved theme
    // to <html> before hydration, so the attribute legitimately differs.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // Apply the saved theme before first paint (dark is the default).
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('sd-theme');if(t==='light')document.documentElement.dataset.theme=t}catch(e){}",
          }}
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
