import type { ChatEvent } from '@sazuz/core/work';

const statusLabels: Record<string, string> = {
  queued: 'Your request is queued.',
  running: 'Sazuz is working…',
  completed: 'Response complete.',
  waiting_approval: 'An action is waiting for your approval.',
  paused: 'The mission is paused.',
  cancelled: 'The mission was cancelled.',
  failed: 'The mission could not finish. Check its timeline for details.',
  budget_exceeded: 'The mission stopped at its budget limit.',
  stream_interrupted:
    'Live updates ended. Your saved mission can continue. Check its status before sending again.',
};
const observationEnds = new Set([
  'completed',
  'waiting_approval',
  'budget_exceeded',
  'paused',
  'cancelled',
  'failed',
  'stream_interrupted',
]);

/** The SSE boundary validates events. Only the server's canonical mission suffix becomes a link. */
export function presentChatStatus(
  event: Pick<Extract<ChatEvent, { type: 'run.status' }>, 'status' | 'message'>,
) {
  const message = event.message?.trim() ?? '';
  const mission = /(?:^|\s)View mission: (\/missions\/mis_[0-9A-HJKMNP-TV-Z]{26})$/.exec(message);
  return {
    text:
      (mission ? message.slice(0, mission.index).trim() : message) ||
      statusLabels[event.status] ||
      'Mission status updated. Check Missions for details.',
    missionPath: mission?.[1] ?? null,
    observationEnded: observationEnds.has(event.status),
  };
}
