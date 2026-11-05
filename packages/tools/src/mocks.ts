import { z } from 'zod';
import { secretRedactor } from '@sazuz/vault';
import { ToolRegistry, type ToolExecution } from './registry.js';
import { checkAbort, ToolError } from './errors.js';

export const mockFixtureSchema = z.strictObject({
  name: z.string().min(1).max(128),
  args: z.json(),
  output: z.json(),
  privateOnly: z.boolean().default(false),
});
export const mockFixturesSchema = z
  .array(mockFixtureSchema)
  .max(200)
  .refine(
    (value) => JSON.stringify(value).length <= 1_000_000,
    'Recorded fixtures exceed the replay limit.',
  );
export type MockFixture = z.infer<typeof mockFixtureSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** No original executor, verifier, credential callback or network client is invoked. */
export function createMockTools(registry: ToolRegistry, input: unknown): ToolRegistry {
  const fixtures = mockFixturesSchema.parse(secretRedactor.redact(input));
  return new ToolRegistry(
    registry.list().map((descriptor) => {
      const original = registry.get(descriptor.name);
      const simulate = (value: unknown): ToolExecution => {
        const args = original.parseArgs(value);
        if (canonical(args) !== canonical(secretRedactor.redact(args)))
          throw new ToolError('SECRET_INPUT');
        const fixture = fixtures.find(
          (item) => item.name === descriptor.name && canonical(item.args) === canonical(args),
        );
        return {
          untrusted: true,
          privateOnly: fixture?.privateOnly ?? false,
          output: {
            simulation: true,
            tool: descriptor.name,
            effect: descriptor.effect,
            matchedFixture: !!fixture,
            ...(fixture
              ? { recorded: fixture.output }
              : {
                  notice: 'No matching recorded fixture. No live action or read was performed.',
                }),
          },
        };
      };
      return {
        ...original,
        execute(context, args) {
          return Promise.resolve().then(() => {
            checkAbort(context.signal);
            return simulate(args);
          });
        },
        verify(context, args) {
          return Promise.resolve().then(() => {
            checkAbort(context.signal);
            return { status: 'done' as const, result: simulate(args) };
          });
        },
      };
    }),
  );
}
