import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Development only: the hosts whose pages may load Next's dev resources
  // (/_next/*, the HMR websocket, /__nextjs_* endpoints) cross-origin. Loopback
  // names only, so a DNS-rebinding page cannot drive the dev server (security
  // audit L1; server/server.ts also refuses non-loopback Host/Origin in dev).
  allowedDevOrigins: ['localhost', '127.0.0.1', '[::1]'],
  // The app renders no next/image; with this flag /_next/image is not served,
  // which removes the image-optimizer attack surface (security audit H1).
  images: { unoptimized: true },
  // Overridable so a second dev server can run against the same checkout
  // (Next's dev lock lives inside distDir).
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
