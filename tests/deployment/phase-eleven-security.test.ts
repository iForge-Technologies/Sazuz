import { describe, expect, it, vi } from 'vitest';
import { readRequestBody } from '../../apps/web/src/lib/request-body.js';

function request(stream: ReadableStream<Uint8Array>, headers?: HeadersInit, signal?: AbortSignal) {
  return new Request('http://localhost/api/voice/transcribe', {
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers,
    signal,
  } as RequestInit & { duplex: 'half' });
}
describe('Phase 11 bounded web request ingress', () => {
  it('counts bytes across chunks and decodes a split UTF-8 character correctly', async () => {
    const bytes = new TextEncoder().encode('a€z');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });
    expect(await readRequestBody(request(stream), 5)).toBe('a€z');
  });
  it('stops a dishonest length header at the byte limit and cancels the unread body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
      },
      cancel,
    });
    await expect(
      readRequestBody(request(stream, { 'content-length': '1' }), 5),
    ).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE', status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('refuses an oversized declared body before pulling data', async () => {
    const pull = vi.fn(),
      cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    await expect(
      readRequestBody(request(stream, { 'content-length': '100' }), 10),
    ).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([[0xff], [0xe2, 0x82]])('refuses malformed or truncated UTF-8 (%j)', async (...bytes) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
    await expect(readRequestBody(request(stream), 10)).rejects.toMatchObject({
      code: 'REQUEST_INVALID',
      status: 400,
    });
  });
  it('bounds a stalled body and cancels it after the deadline', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(readRequestBody(request(stream), 10, 20)).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      status: 408,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('honors client cancellation while a read is pending', async () => {
    const control = new AbortController(),
      cancel = vi.fn();
    const pending = readRequestBody(
      request(new ReadableStream<Uint8Array>({ cancel }), undefined, control.signal),
      10,
    );
    control.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
