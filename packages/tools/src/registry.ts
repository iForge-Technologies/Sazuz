import { normalizeEffect, type ToolEffect, type ToolScope } from '@sazuz/policy';
import { secretRedactor } from '@sazuz/vault';
import { z } from 'zod';
import { checkAbort, ToolError } from './errors.js';
import type { SafeNetworkDependencies } from './network.js';
import type { SearchProvider } from './search.js';

export interface ToolContext {
  modelFree?: boolean;
  memoryScopes?: readonly ('global' | 'project' | 'agent')[];
  workspaceDir: string;
  projectId: string;
  runId: string;
  agentId: string;
  idempotencyKey: string;
  claimKey?: string;
  signal: AbortSignal;
  now?: () => Date;
  network?: SafeNetworkDependencies;
  search?: SearchProvider;
  secret?: <T>(reference: string, consume: (secret: string) => Promise<T>) => Promise<T>;
  redact?: (value: unknown) => unknown;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: ToolEffect;
  effectKnown: boolean;
  scope: ToolScope;
  connector?: string;
  moneyMovement?: boolean;
}

export interface ToolExecution {
  output: unknown;
  untrusted: boolean;
  privateOnly?: boolean;
  pause?: string | undefined;
}

export type Verification<Result> =
  { status: 'done'; result: Result } | { status: 'not_done' } | { status: 'unknown' };
export type ToolVerification = Verification<ToolExecution>;

export interface RegisteredTool extends ToolDescriptor {
  parseArgs(value: unknown): unknown;
  execute(context: ToolContext, value: unknown): Promise<ToolExecution>;
  verify(context: ToolContext, value: unknown): Promise<ToolVerification>;
}

interface ToolDefinition<Input extends z.ZodType, Output extends z.ZodType> {
  name: string;
  description: string;
  input: Input;
  output: Output;
  effect?: string;
  scope?: ToolScope;
  connector?: string;
  moneyMovement?: boolean;
  untrusted?: boolean;
  privateOnly?: (output: z.output<Output>) => boolean;
  pause?: (output: z.output<Output>) => string | undefined;
  run: (context: ToolContext, args: z.output<Input>) => Promise<z.input<Output>>;
  verify?: (context: ToolContext, args: z.output<Input>) => Promise<Verification<z.input<Output>>>;
}

const descriptorSchema = z.strictObject({
  name: z
    .string()
    .max(128)
    .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/),
  description: z.string().trim().min(1).max(2000),
  scope: z.enum(['internal', 'external']),
  connector: z.string().min(1).max(128).optional(),
  moneyMovement: z.boolean().optional(),
});

function scrub(value: unknown, context?: ToolContext): unknown {
  const output = secretRedactor.redact(value);
  return context?.redact === undefined ? output : secretRedactor.redact(context.redact(output));
}

function containsSecret(value: unknown, context?: ToolContext): boolean {
  try {
    return JSON.stringify(value) !== JSON.stringify(scrub(value, context));
  } catch {
    return true;
  }
}

export function defineTool<Input extends z.ZodType, Output extends z.ZodType>(
  definition: ToolDefinition<Input, Output>,
): RegisteredTool {
  const metadata = descriptorSchema.safeParse({
    name: definition.name,
    description: definition.description,
    scope: definition.scope ?? 'external',
    ...(definition.connector === undefined ? {} : { connector: definition.connector }),
    ...(definition.moneyMovement === undefined ? {} : { moneyMovement: definition.moneyMovement }),
  });
  if (!metadata.success || containsSecret(metadata.data)) throw new ToolError('INVALID_TOOL');
  const normalized = normalizeEffect(definition.effect);
  let inputSchema: Record<string, unknown>;
  try {
    inputSchema = z.toJSONSchema(definition.input, { io: 'input' });
  } catch {
    throw new ToolError('INVALID_TOOL');
  }
  const parseArgs = (value: unknown): z.output<Input> => {
    const parsed = definition.input.safeParse(value);
    if (!parsed.success) throw new ToolError('INVALID_TOOL_ARGS');
    if (containsSecret(parsed.data)) throw new ToolError('SECRET_INPUT');
    return parsed.data;
  };
  const result = (value: unknown, context: ToolContext): ToolExecution => {
    const parsed = definition.output.safeParse(value);
    if (!parsed.success) throw new ToolError('INVALID_TOOL_RESULT');
    const pause = definition.pause?.(parsed.data);
    return {
      output: scrub(parsed.data, context),
      untrusted: definition.untrusted ?? metadata.data.scope === 'external',
      ...(definition.privateOnly ? { privateOnly: definition.privateOnly(parsed.data) } : {}),
      ...(pause ? { pause: z.string().min(1).max(500).parse(scrub(pause, context)) } : {}),
    };
  };
  return Object.freeze({
    name: metadata.data.name,
    description: metadata.data.description,
    scope: metadata.data.scope,
    ...(metadata.data.connector === undefined ? {} : { connector: metadata.data.connector }),
    ...(metadata.data.moneyMovement === undefined
      ? {}
      : { moneyMovement: metadata.data.moneyMovement }),
    inputSchema,
    effect: normalized.effect,
    effectKnown: normalized.known,
    parseArgs,
    async execute(context: ToolContext, value: unknown): Promise<ToolExecution> {
      const args = parseArgs(value);
      if (containsSecret(args, context)) throw new ToolError('SECRET_INPUT');
      checkAbort(context.signal);
      try {
        return result(await definition.run(context, args), context);
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if (context.signal.aborted) throw new ToolError('TOOL_ABORTED');
        throw new ToolError('TOOL_FAILED');
      }
    },
    async verify(context: ToolContext, value: unknown): Promise<ToolVerification> {
      const args = parseArgs(value);
      if (containsSecret(args, context)) throw new ToolError('SECRET_INPUT');
      checkAbort(context.signal);
      if (definition.verify === undefined) return { status: 'unknown' };
      try {
        const verification = await definition.verify(context, args);
        if (verification.status === 'done')
          return { status: 'done', result: result(verification.result, context) };
        if (verification.status === 'not_done' || verification.status === 'unknown')
          return verification;
        throw new ToolError('INVALID_TOOL_RESULT');
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if (context.signal.aborted) throw new ToolError('TOOL_ABORTED');
        throw new ToolError('TOOL_FAILED');
      }
    },
  });
}

export class ToolRegistry {
  #tools = new Map<string, RegisteredTool>();

  constructor(tools: readonly RegisteredTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: RegisteredTool): this {
    if (this.#tools.has(tool.name)) throw new ToolError('INVALID_TOOL');
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): RegisteredTool {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw new ToolError('TOOL_NOT_FOUND');
    return tool;
  }

  list(): ToolDescriptor[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema),
      effect: tool.effect,
      effectKnown: tool.effectKnown,
      scope: tool.scope,
      ...(tool.connector === undefined ? {} : { connector: tool.connector }),
      ...(tool.moneyMovement === undefined ? {} : { moneyMovement: tool.moneyMovement }),
    }));
  }

  parseArgs(name: string, args: unknown): unknown {
    return this.get(name).parseArgs(args);
  }

  execute(name: string, context: ToolContext, args: unknown): Promise<ToolExecution> {
    return this.get(name).execute(context, args);
  }

  verify(name: string, context: ToolContext, args: unknown): Promise<ToolVerification> {
    return this.get(name).verify(context, args);
  }
}

/** Escaping prevents external text from closing its trust boundary in model context. */
export function renderToolOutput(result: ToolExecution): string {
  const text = JSON.stringify(secretRedactor.redact(result.output));
  return result.untrusted
    ? `<untrusted>\n${text.replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\n</untrusted>`
    : text;
}
