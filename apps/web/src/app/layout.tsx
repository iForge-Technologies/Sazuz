import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Providers } from '../components/providers';
import { PwaRegistration } from '../components/pwa-registration';
import './globals.css';
import './workspace.css';
import './workspace-surfaces.css';
import './settings-surfaces.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sazuz',
  description: 'Your self-hosted assistant workspace.',
  appleWebApp: { capable: true, title: 'Sazuz', statusBarStyle: 'default' },
  icons: { apple: '/pwa-192.png' },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PwaRegistration />
        <Providers>{children}</Providers>
        <noscript>
          <p className="no-script">
            Live health checks need JavaScript.{' '}
            <a href="/api/health">View the current health response.</a>
          </p>
        </noscript>
      </body>
    </html>
  );
}
