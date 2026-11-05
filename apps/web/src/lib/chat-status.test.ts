import { describe, expect, it } from 'vitest';
import { presentChatStatus } from './chat-status';

const missionPath = `/missions/mis_${'0'.repeat(25)}1`;

describe('durable chat status', () => {
  it('shows the server explanation and a canonical mission link when approval pauses observation', () => {
    expect(
      presentChatStatus({
        status: 'waiting_approval',
        message: `Review the proposed action. View mission: ${missionPath}`,
      }),
    ).toEqual({
      text: 'Review the proposed action.',
      missionPath,
      observationEnded: true,
    });
  });

  it('ends cancelled observation without interpreting it as a stream failure', () => {
    expect(presentChatStatus({ status: 'cancelled' })).toMatchObject({
      text: 'The mission was cancelled.',
      observationEnded: true,
    });
  });

  it('distinguishes an interrupted observation from a failed mission', () => {
    const status = presentChatStatus({ status: 'stream_interrupted' });
    expect(status.observationEnded).toBe(true);
    expect(status.text).toContain('saved mission can continue');
    expect(status.text).not.toContain('failed');
    expect(presentChatStatus({ status: 'running' }).observationEnded).toBe(false);
  });

  it.each([
    `https://example.test${missionPath}`,
    `//example.test${missionPath}`,
    `${missionPath}?redirect=https://example.test`,
    `${missionPath}/../settings`,
    '/missions/mis_invalid',
  ])('never turns an arbitrary destination into a mission link: %s', (destination) => {
    expect(
      presentChatStatus({ status: 'paused', message: `View mission: ${destination}` }).missionPath,
    ).toBeNull();
  });
});
