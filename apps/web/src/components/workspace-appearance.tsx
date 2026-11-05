'use client';

import '../lib/validation';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { settingsSchemas } from '@sazuz/config/settings';
import { api } from '../lib/api';

const sessionSchema = z.object({ user: z.object({ id: z.string() }) }).nullable();
const appearanceSchema = z.object({ general: z.object({ value: settingsSchemas.general }) });

/** Appearance remains a versioned Settings value. Public pages use the system preference. */
export function WorkspaceAppearance() {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ['workspace-session'],
    queryFn: ({ signal }) => api('auth/get-session', sessionSchema, undefined, 'GET', { signal }),
    staleTime: 30_000,
    retry: false,
  });
  const settings = useQuery({
    queryKey: ['workspace-appearance'],
    queryFn: ({ signal }) => api('settings', appearanceSchema, undefined, 'GET', { signal }),
    enabled: !!session.data,
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  useEffect(() => {
    // A failed read keeps the last verified appearance. No setting is written by a fallback.
    const theme = settings.data?.general.value.theme;
    if (!session.data) delete document.documentElement.dataset.theme;
    else if (theme) document.documentElement.dataset.theme = theme;
  }, [settings.data, session.data]);
  useEffect(() => {
    function apply(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const parsed = settingsSchemas.general.shape.theme.safeParse(event.detail);
      if (!parsed.success) return;
      document.documentElement.dataset.theme = parsed.data;
      void client.invalidateQueries({ queryKey: ['workspace-appearance'] });
    }
    window.addEventListener('sazuz:appearance', apply);
    return () => window.removeEventListener('sazuz:appearance', apply);
  }, [client]);
  return null;
}
