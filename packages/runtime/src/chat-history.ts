import { llmMessageSchema, type LlmMessage, type LlmToolCall } from '@sazuz/llm/contracts';
import { z } from 'zod';
import { RunError } from './contracts.js';

const persistedChatSchema = z.array(llmMessageSchema).max(500);
// Leave room for the system prompt and subsequent model/tool messages in a 1,000-message checkpoint.
const historyMessageLimit = 750;
const missingResultObservation = JSON.stringify({
  status: 'unknown',
  code: 'MISSING_CHAT_TOOL_RESULT',
  message:
    'No result for this tool call is available in the saved chat history. Whether it executed or produced side effects is unknown. Inspect the original mission before repeating any consequential action.',
});

/**
 * Reconstruct complete assistant/tool groups from at most 500 persisted messages.
 * Existing observations retain their order and content. Missing observations describe
 * uncertainty; they never authorize or execute a retry. Unmatched tools, including a
 * leading group clipped by the history query, are omitted. Keep the newest complete
 * groups within 750 messages, without separating an assistant from its observations.
 */
export function normalizeChatHistory(messages: readonly LlmMessage[]): LlmMessage[] {
  const parsed = persistedChatSchema.safeParse(messages);
  if (!parsed.success) throw new RunError('RUN_INVALID');

  const groups: LlmMessage[][] = [];
  const pending = new Map<string, LlmToolCall>();
  let current: LlmMessage[] = [];
  let retainedCount = 0;

  const finishGroup = () => {
    if (!current.length) return;
    for (const call of pending.values())
      current.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: missingResultObservation,
      });
    groups.push(current);
    retainedCount += current.length;
    while (retainedCount > historyMessageLimit) retainedCount -= groups.shift()!.length;
    current = [];
    pending.clear();
  };

  for (const message of parsed.data) {
    if (message.role === 'tool') {
      const call = pending.get(message.toolCallId);
      if (call?.name === message.name) {
        current.push(message);
        pending.delete(message.toolCallId);
      }
      continue;
    }
    finishGroup();
    current.push(message);
    if (message.role === 'assistant')
      for (const call of message.toolCalls ?? []) {
        // One ID cannot identify two different calls in the same assistant turn.
        if (pending.has(call.id)) throw new RunError('RUN_INVALID');
        pending.set(call.id, call);
      }
  }
  finishGroup();
  return groups.flat();
}
