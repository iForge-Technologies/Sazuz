export type TriggerErrorCode =
  | 'INVALID_TRIGGER'
  | 'INVALID_SCHEDULE'
  | 'INVALID_SCHEDULE_RESULT'
  | 'SCHEDULE_MODEL_FAILED'
  | 'INVALID_WEBHOOK'
  | 'WEBHOOK_TOO_LARGE'
  | 'WEBHOOK_EXPIRED'
  | 'WEBHOOK_REPLAYED'
  | 'WEBHOOK_SECRET_UNAVAILABLE'
  | 'WEBHOOK_RECEIPT_FAILED'
  | 'INVALID_FEED'
  | 'FEED_TOO_LARGE'
  | 'FEED_FETCH_FAILED'
  | 'INVALID_POLL_RESULT'
  | 'POLL_FAILED'
  | 'POLL_ABORTED'
  | 'INVALID_NOTIFICATION';

const messages: Record<TriggerErrorCode, string> = {
  INVALID_TRIGGER: 'The trigger configuration is invalid.',
  INVALID_SCHEDULE: 'The schedule or timezone is invalid or has no future occurrence.',
  INVALID_SCHEDULE_RESULT: 'The schedule model returned an invalid structured schedule.',
  SCHEDULE_MODEL_FAILED: 'The schedule model could not interpret the requested schedule.',
  INVALID_WEBHOOK: 'The webhook signature or authentication headers are invalid.',
  WEBHOOK_TOO_LARGE: 'The webhook body exceeds the size limit.',
  WEBHOOK_EXPIRED: 'The webhook timestamp is outside the allowed window.',
  WEBHOOK_REPLAYED: 'This webhook delivery has already been accepted.',
  WEBHOOK_SECRET_UNAVAILABLE: 'The webhook verification credential is unavailable.',
  WEBHOOK_RECEIPT_FAILED: 'The webhook receipt could not be recorded.',
  INVALID_FEED: 'The feed is not a supported bounded RSS or Atom document.',
  FEED_TOO_LARGE: 'The feed exceeds the size or item limit.',
  FEED_FETCH_FAILED: 'The feed could not be fetched safely.',
  INVALID_POLL_RESULT: 'The connector returned an invalid polling result.',
  POLL_FAILED: 'The polling source could not be read.',
  POLL_ABORTED: 'Polling was cancelled or timed out.',
  INVALID_NOTIFICATION: 'The notification or routing settings are invalid.',
};

/** Deliberately excludes source text, bodies, credentials and transport causes. */
export class TriggerError extends Error {
  constructor(public readonly code: TriggerErrorCode) {
    super(messages[code]);
    this.name = 'TriggerError';
  }
}
