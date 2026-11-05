'use client';
import { useEffect } from 'react';
export function PwaRegistration() {
  useEffect(() => {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      void navigator.serviceWorker
        .register('/service-worker.global.js', { scope: '/', updateViaCache: 'none' })
        .catch(() => {
          console.warn('Sazuz offline support could not be registered.');
        });
    }
  }, []);
  return null;
}
