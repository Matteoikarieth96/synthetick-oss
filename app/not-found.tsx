import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Page not found | SyntheTick',
  robots: { index: false },
};

/**
 * Branded 404 for every unknown page (replaces Next.js' stock black screen).
 * Server component, no client script: it works the same signed in or out, in
 * the light and dark themes (the root layout applies the saved theme).
 */
export default function NotFound() {
  return (
    <main className="nf-wrap">
      <div className="nf-card">
        <a className="nf-brand" href="/">
          SyntheTick<span className="dot">.</span>
        </a>
        <p className="nf-code">Error 404</p>
        <h1>This page could not be found</h1>
        <p>The link may be old or mistyped. You can head back to the app or explore the Robinhood Chain universe.</p>
        <div className="nf-actions">
          <a className="nf-btn" href="/">
            Back to SyntheTick
          </a>
          <a className="nf-btn ghost" href="/universe">
            Open the universe
          </a>
        </div>
      </div>
    </main>
  );
}
