import './validation';
import { z } from 'zod';

const errorSchema = z.object({
  error: z.object({
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
      .optional(),
    message: z.string().min(1).max(1000).optional(),
  }),
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE',
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {}),
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    if (options.signal?.aborted) throw new ApiError(0, 'ABORTED', 'The request was cancelled.');
    throw new ApiError(0, 'REQUEST_UNAVAILABLE', 'Sazuz could not be reached. Try again shortly.');
  }
  let value: unknown;
  try {
    value = response.status === 204 ? undefined : await response.json();
  } catch {
    throw new ApiError(
      response.status,
      'INVALID_RESPONSE',
      'The server returned an invalid response.',
    );
  }
  if (!response.ok) {
    const error = errorSchema.safeParse(value);
    throw new ApiError(
      response.status,
      error.success ? (error.data.error.code ?? 'REQUEST_FAILED') : 'REQUEST_FAILED',
      error.success
        ? (error.data.error.message ?? 'The request failed. Please try again.')
        : 'The request failed. Please try again.',
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      response.status,
      'INVALID_RESPONSE',
      'The server returned an invalid response.',
    );
  return parsed.data;
}
export const okSchema = z.object({ ok: z.boolean() });
export const secretListSchema = z.array(
  z.object({
    id: z.string(),
    reference: z.string(),
    name: z.string(),
    maskedValue: z.string(),
    revision: z.number(),
  }),
);
export type SecretItem = z.infer<typeof secretListSchema>[number];
