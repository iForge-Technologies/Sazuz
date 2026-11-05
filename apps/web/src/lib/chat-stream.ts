import './validation';
import { chatEventSchema, chatInput, workId, type ChatEvent } from '@sazuz/core/work';
import type { z } from 'zod';

const maximumFrameBytes = 4 * 1024 * 1024;

export class ChatStreamError extends Error {
  constructor(
    message = 'Live updates ended. A saved mission can continue. Refresh the conversation or check Missions before sending again.',
  ) {
    super(message);
    this.name = 'ChatStreamError';
  }
}

function dispatchFrame(frame: string, onEvent: (event: ChatEvent) => void): void {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new ChatStreamError('The server sent an invalid chat event. Refresh the conversation.');
  }
  const event = chatEventSchema.safeParse(payload);
  if (!event.success)
    throw new ChatStreamError('The server sent an invalid chat event. Refresh the conversation.');
  onEvent(event.data);
}

/** SSE frames can span arbitrary network and UTF-8 boundaries. Never render an unverified frame. */
export async function readChatStream(
  response: Response,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  if (!response.ok) {
    if (response.status === 401)
      throw new ChatStreamError('Your session has expired. Sign in again to continue.');
    if (response.status === 409)
      throw new ChatStreamError(
        'This conversation already has a running request. Refresh its status.',
      );
    throw new ChatStreamError(
      'Chat could not start. Check your models, vault and budget, then try again.',
    );
  }
  if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body)
    throw new ChatStreamError(
      'The server returned an invalid chat response. Refresh the conversation.',
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let finished = false;
  let failure: ChatStreamError | null = null;
  try {
    while (!finished) {
      const chunk = await reader.read();
      finished = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !finished });
      let separator = /\r?\n\r?\n/.exec(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        if (frame.length > maximumFrameBytes) throw new ChatStreamError();
        dispatchFrame(frame, onEvent);
        buffer = buffer.slice(separator.index + separator[0].length);
        separator = /\r?\n\r?\n/.exec(buffer);
      }
      if (buffer.length > maximumFrameBytes) throw new ChatStreamError();
    }
    if (buffer.trim() !== '') throw new ChatStreamError();
  } catch (cause) {
    failure = cause instanceof ChatStreamError ? cause : new ChatStreamError();
  } finally {
    try {
      if (!finished) await reader.cancel();
    } catch {
      failure ??= new ChatStreamError();
    } finally {
      reader.releaseLock();
    }
  }
  if (failure) throw failure;
}

export async function sendChat(
  threadId: string,
  input: z.infer<typeof chatInput>,
  onEvent: (event: ChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const request = chatInput.parse(input);
  const response = await fetch(`/api/threads/${workId.parse(threadId)}/chat`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal,
  });
  await readChatStream(response, onEvent);
}
