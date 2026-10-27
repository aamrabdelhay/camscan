import type { NextConfig } from 'next';

/**
 * CamScan is a local-first PWA. The only server-side feature we expose is a
 * health endpoint used by the e2e suite; everything else runs in the browser.
 * No image optimisation service is needed (images are Blobs in IndexedDB).
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Large binary assets (fonts, OpenCV, tessdata) are served from /public.
  experimental: {
    largePageDataBytes: 4 * 1024 * 1024,
  },
  async headers() {
    return [
      {
        // Serve the shippable worker + wasm with the right MIME types so the
        // service worker can cache them and Tesseract can stream them.
        source: '/vendor/tesseract/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/fonts/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/tessdata/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/workers/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
    ];
  },
};

export default nextConfig;
