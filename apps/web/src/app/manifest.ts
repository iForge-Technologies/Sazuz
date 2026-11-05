import type { MetadataRoute } from 'next';
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Sazuz',
    short_name: 'Sazuz',
    description: 'Your self-hosted assistant workspace.',
    start_url: '/chat',
    scope: '/',
    display: 'standalone',
    background_color: '#f5f3ed',
    theme_color: '#183d34',
    icons: [
      { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
