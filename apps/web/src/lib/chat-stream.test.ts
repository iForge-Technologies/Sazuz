import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '@sazuz/core/work';
import { readChatStream } from './chat-stream';

function response(text: string, size = 1): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += size)
          controller.enqueue(bytes.slice(offset, offset + size));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}

describe('chat event stream boundary', () => {
  it('preserves UTF-8 text and tool order across one-byte chunks, CRLF and keepalives', async () => {
    const events: ChatEvent[] = [];
    await readChatStream(
      response(
        ': heartbeat\r\n\r\n' +
          'data: {"type":"text.delta","text":"A € / 🌍"}\r\n\r\n' +
          'data: {"type":"tool.call","id":"call-1","name":"time.now",\n' +
          'data: "args":{}}\n\n' +
          'data: {"type":"run.status","status":"completed"}\n\n',
      ),
      (event) => events.push(event),
    );
    expect(events).toEqual([
      { type: 'text.delta', text: 'A € / 🌍' },
      { type: 'tool.call', id: 'call-1', name: 'time.now', args: {} },
      { type: 'run.status', status: 'completed' },
    ]);
  });

  it.each([
    'data: {secret-canary}\n\n',
    'data: {"type":"text.delta","text":{"secret":"canary"}}\n\n',
    'data: {"type":"text.delta","text":"incomplete"}',
  ])('rejects malformed or truncated events without exposing their content', async (frame) => {
    const received: ChatEvent[] = [];
    await expect(readChatStream(response(frame), (event) => received.push(event))).rejects.toThrow(
      /Refresh the conversation/,
    );
    expect(received).toEqual([]);
  });

  it('rejects a JSON error page without rendering its body', async () => {
    await expect(
      readChatStream(new Response('{"secret":"canary"}'), () => undefined),
    ).rejects.toThrow('invalid chat response');
  });

  it('reports expired authentication and conflicts with safe actionable errors', async () => {
    await expect(
      readChatStream(new Response('private error', { status: 401 }), () => undefined),
    ).rejects.toThrow('Sign in again');
    await expect(
      readChatStream(new Response('private error', { status: 409 }), () => undefined),
    ).rejects.toThrow('already has a running request');
  });
});
