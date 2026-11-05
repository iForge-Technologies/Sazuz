'use client';
import './validation';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';
import { api, ApiError } from './api';

const sessionSchema = z.object({ user: z.object({ id: z.string() }) }).nullable();

export function useWorkspaceSession() {
  const query = useQuery({
    queryKey: ['workspace-session'],
    queryFn: ({ signal }) => api('auth/get-session', sessionSchema, undefined, 'GET', { signal }),
    staleTime: 30_000,
    retry: false,
  });
  useEffect(() => {
    if (query.data === null || (query.error instanceof ApiError && query.error.status === 401))
      window.location.assign('/login');
  }, [query.data, query.error]);
  return { ready: !!query.data, error: query.error, loading: query.isPending };
}

export function useWorkspaceResource<T>(
  path: string,
  schema: z.ZodType<T>,
  enabled: boolean,
  live = true,
) {
  return useQuery({
    queryKey: ['workspace', path],
    queryFn: ({ signal }) => api(path, schema, undefined, 'GET', { signal }),
    enabled,
    retry: false,
    refetchInterval: live ? 2000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function workspaceError(
  error: unknown,
  fallback = 'The request could not finish. Try again.',
): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session has expired. Sign in again to continue.';
    if (error.status === 409)
      return 'This item changed while you were reviewing it. Refresh and review the latest version.';
    if (error.status === 410) return 'This request has expired. Refresh to see its current status.';
    return error.message;
  }
  return fallback;
}
