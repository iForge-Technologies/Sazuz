import { createHash } from 'node:crypto';
import {
  Output,
  jsonSchema,
  stepCountIs,
  streamText,
  type AssistantContent,
  type JSONSchema7,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { SecretRedactor } from '@sazuz/vault';
import { z } from 'zod';
import {
  llmToolCallSchema,
  llmMessageSchema,
  type GenerateResult,
  type LlmMessage,
  type LlmTool,
  type LlmToolCall,
  type TokenUsage,
} from './contracts.js';
import { ModelError, safeProviderError } from './errors.js';
import { createProviderModel, type ProviderConfig, type ProviderFetch } from './providers.js';
import { estimateInputTokens, normalizeUsage } from './usage.js';

/** Stable, collision-resistant function names valid on every supported wire protocol. */
export function wireToolName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}_${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
}

function modelMessages(messages: LlmMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === 'user' && message.images?.length)
      return {
        role: 'user',
        content: [
          { type: 'text', text: message.content },
          ...message.images.map((image) => ({
            type: 'file' as const,
            data: { type: 'data' as const, data: Buffer.from(image.data, 'base64') },
            mediaType: image.mimeType,
          })),
        ],
      };
    if (message.role === 'tool')
      return {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName: wireToolName(message.name),
            output: { type: 'text', value: message.content },
          },
        ],
      };
    if (message.role !== 'assistant') return message;
    const content: AssistantContent = [];
    if (message.content) content.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? [])
      content.push({
        type: 'tool-call',
        toolCallId: call.id,
        toolName: wireToolName(call.name),
        input: call.args,
      });
    return { role: 'assistant', content: content.length > 0 ? content : message.content };
  });
}

function sdkTools(tools: LlmTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((tool) => [
      wireToolName(tool.name),
      {
        description: `${tool.name}: ${tool.description}`,
        // Tool schemas are JSON objects at this boundary. The execution registry validates
        // actual arguments with each tool's zod schema before any policy-approved action.
        inputSchema: jsonSchema<unknown>(tool.inputSchema as JSONSchema7),
      },
    ]),
  );
}

export interface ProviderAttempt {
  text: string;
  toolCalls: LlmToolCall[];
  usage: TokenUsage;
  finishReason: GenerateResult['finishReason'];
  emitted: boolean;
  error: ModelError | null;
}

interface AttemptOptions {
  provider: ProviderConfig;
  modelId: string;
  key: string | undefined;
  fetcher: ProviderFetch;
  messages: LlmMessage[];
  tools: LlmTool[];
  maxOutputTokens: number;
  requireJson: boolean;
  responseSchema: Record<string, unknown> | undefined;
  signal: AbortSignal;
  callerSignal: AbortSignal | undefined;
  redactor: SecretRedactor;
  onToken: ((text: string) => Promise<void> | void) | undefined;
}

export async function streamProviderAttempt(options: AttemptOptions): Promise<ProviderAttempt> {
  const { provider, modelId, key, fetcher, messages, tools, redactor } = options;
  const cancellation = new AbortController();
  const streamRedactor = redactor.createStream();
  const toolNames = new Map(tools.map((tool) => [wireToolName(tool.name), tool.name]));
  const streamedToolInput = new Set<string>();
  const toolCalls: LlmToolCall[] = [];
  let text = '';
  let outputBytes = 0;
  let usage: LanguageModelUsage | undefined;
  let finishReason: GenerateResult['finishReason'] = 'other';
  let completed = false;
  let emitted = false;
  let error: ModelError | null = null;
  const emit = async (delta: string) => {
    if (!delta) return;
    text += delta;
    if (options.onToken) {
      emitted = true;
      try {
        await options.onToken(delta);
      } catch {
        throw new ModelError('MODEL_STREAM_FAILED');
      }
    }
  };

  try {
    // Resolution can register a credential for the first time after admission. Scrub again
    // inside its execution scope so even that first call cannot include it in model context.
    const safeMessages = z.array(llmMessageSchema).safeParse(redactor.redact(messages));
    if (!safeMessages.success) throw new ModelError('MODEL_INVALID_INPUT');
    const response = streamText({
      model: createProviderModel(provider, modelId, key, fetcher),
      messages: modelMessages(safeMessages.data),
      allowSystemInMessages: true,
      tools: sdkTools(tools),
      maxOutputTokens: options.maxOutputTokens,
      maxRetries: 0,
      stopWhen: stepCountIs(1),
      abortSignal: AbortSignal.any([options.signal, cancellation.signal]),
      ...(options.requireJson
        ? {
            // Preserve raw JSON text for our zod boundary and one explicitly budgeted repair.
            output: {
              ...Output.text(),
              responseFormat: Promise.resolve({
                type: 'json' as const,
                ...(options.responseSchema ? { schema: options.responseSchema } : {}),
              }),
            },
          }
        : {}),
      telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      // The default SDK handler logs raw provider errors, which can contain credentials.
      onError: () => undefined,
    });

    for await (const part of response.fullStream) {
      if (part.type === 'error') {
        error ??= safeProviderError(part.error, options.callerSignal?.aborted);
        streamRedactor.discard();
        // The SDK emits final usage after a terminal provider error. Drain it so a
        // reported bill is recorded, while suppressing all later content and tools.
        continue;
      }
      if (error) {
        if (part.type === 'finish-step') usage = part.usage;
        else if (part.type === 'finish') usage = part.totalUsage;
        continue;
      }
      if (part.type === 'abort')
        throw new ModelError(
          options.callerSignal?.aborted ? 'ABORTED' : 'PROVIDER_UNAVAILABLE',
          !options.callerSignal?.aborted,
        );
      if (part.type === 'text-delta') {
        outputBytes += Buffer.byteLength(part.text, 'utf8');
        await emit(streamRedactor.push(part.text));
      } else if (part.type === 'reasoning-delta') {
        // Count reasoning tokens when usage is absent; never persist or expose private reasoning.
        outputBytes += Buffer.byteLength(part.text, 'utf8');
      } else if (part.type === 'tool-input-delta') {
        streamedToolInput.add(part.id);
        outputBytes += Buffer.byteLength(part.delta, 'utf8');
      } else if (part.type === 'tool-call') {
        if (toolCalls.length >= 128 || toolCalls.some((call) => call.id === part.toolCallId))
          throw new ModelError('MODEL_OUTPUT_INVALID');
        if (!streamedToolInput.has(part.toolCallId))
          outputBytes += Buffer.byteLength(JSON.stringify(part.input) ?? '', 'utf8');
        const call = llmToolCallSchema.safeParse({
          id: redactor.redactText(part.toolCallId),
          name: toolNames.get(part.toolName) ?? part.toolName,
          args: redactor.redact(part.input),
        });
        if (!call.success) throw new ModelError('MODEL_OUTPUT_INVALID');
        toolCalls.push(call.data);
      } else if (part.type === 'finish-step') usage = part.usage;
      else if (part.type === 'finish') {
        usage = part.totalUsage;
        completed = true;
        finishReason = ['stop', 'length', 'tool-calls', 'content-filter'].includes(
          part.finishReason,
        )
          ? (part.finishReason as GenerateResult['finishReason'])
          : 'other';
      }
      if (outputBytes > 1_000_000) throw new ModelError('MODEL_OUTPUT_INVALID');
    }
    if (error) throw error;
    if (
      !completed ||
      finishReason === 'other' ||
      (text.length === 0 && toolCalls.length === 0 && outputBytes === 0)
    )
      throw new ModelError('PROVIDER_INVALID_RESPONSE');
    await emit(streamRedactor.finish());
    if (options.requireJson && !toolCalls.length) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new ModelError('MODEL_OUTPUT_INVALID');
      }
      if (!z.json().safeParse(parsed).success) throw new ModelError('MODEL_OUTPUT_INVALID');
    }
  } catch (failure) {
    cancellation.abort();
    streamRedactor.discard();
    error = safeProviderError(failure, options.callerSignal?.aborted);
  }
  const rejected = error?.code === 'PROVIDER_AUTH' || error?.code === 'PROVIDER_RATE_LIMIT';
  return {
    text,
    toolCalls,
    usage: normalizeUsage(usage, rejected ? 0 : estimateInputTokens(messages, tools), outputBytes),
    finishReason,
    emitted,
    error,
  };
}
