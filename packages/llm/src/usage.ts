import type { LanguageModelUsage } from 'ai';
import { type LlmMessage, type LlmTool, type ModelPrice, type TokenUsage } from './contracts.js';

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** A deliberately conservative byte bound for admission, including message/tool framing. */
export function inputTokenBound(messages: LlmMessage[], tools: LlmTool[]): number {
  return (
    32 +
    utf8Bytes(JSON.stringify(messages)) +
    utf8Bytes(JSON.stringify(tools)) +
    messages.length * 16
  );
}

export function estimateInputTokens(messages: LlmMessage[], tools: LlmTool[]): number {
  return Math.ceil(inputTokenBound(messages, tools) / 3);
}

export function normalizeUsage(
  usage: LanguageModelUsage | undefined,
  estimatedInput: number,
  output: string | number,
): TokenUsage {
  const valid = (value: number | undefined): value is number =>
    value !== undefined && Number.isSafeInteger(value) && value >= 0;
  const inputTokens = valid(usage?.inputTokens) ? usage.inputTokens : estimatedInput;
  const outputBytes = typeof output === 'number' ? output : utf8Bytes(output);
  const outputTokens = valid(usage?.outputTokens) ? usage.outputTokens : Math.ceil(outputBytes / 3);
  const cached = usage?.inputTokenDetails.cacheReadTokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: valid(cached) ? Math.min(inputTokens, cached) : 0,
    source: valid(usage?.inputTokens) && valid(usage?.outputTokens) ? 'provider' : 'estimated',
  };
}

export function calculateCost(price: ModelPrice, usage: TokenUsage): number {
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  return (
    ((usage.inputTokens - cached) * price.inputPerMTok +
      cached * (price.cachedInputPerMTok ?? price.inputPerMTok) +
      usage.outputTokens * price.outputPerMTok) /
    1_000_000
  );
}

export function maximumCost(price: ModelPrice, inputBound: number, outputTokens: number): number {
  return (
    (inputBound * Math.max(price.inputPerMTok, price.cachedInputPerMTok ?? 0) +
      outputTokens * price.outputPerMTok) /
    1_000_000
  );
}
