import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
  transpilePackages: ['@sazuz/core', '@sazuz/ui', '@sazuz/config', '@sazuz/llm', '@sazuz/policy'],
  poweredByHeader: false,
  rewrites() {
    return [
      { source: '/live/browser/:id', destination: 'http://127.0.0.1:17779/live/browser/:id' },
      { source: '/bridge', destination: 'http://127.0.0.1:17779/bridge' },
    ];
  },
  logging: { incomingRequests: { ignore: [/^\/oauth\/google\/callback(?:\?|$)/] } },
  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
        ],
      },
      {
        source: '/service-worker.global.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
          {
            key: 'Content-Security-Policy',
            value: "default-src 'none'; script-src 'self'; connect-src 'self'",
          },
        ],
      },
      {
        source: '/offline.html',
        headers: [
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          },
        ],
      },
      {
        source: '/api/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
        ],
      },
    ]);
  },
};

export default nextConfig;
