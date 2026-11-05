import { z } from 'zod';
import { checkpointSchema, type RunCheckpoint } from '@sazuz/runtime/contracts';
import { generateResultSchema, generationUsageRecordSchema } from '@sazuz/llm/contracts';
import { evalDecisionSchema, evalDispatchSchema, evalFlagSchema } from '@sazuz/core/evals';

const result = z.strictObject({
  output: z.json(),
  untrusted: z.boolean(),
  privateOnly: z.boolean().default(false),
});
export const evalJournalSchema = z.strictObject({
  models: z
    .array(
      z.strictObject({
        key: z.string(),
        kind: z.enum(['agent', 'judge']),
        status: z.enum(['intent', 'done', 'uncertain', 'failed']),
        response: generateResultSchema.nullable(),
      }),
    )
    .max(40),
  tools: z
    .array(
      z.strictObject({
        key: z.string(),
        status: z.enum(['intent', 'done']),
        result: result.nullable(),
      }),
    )
    .max(128),
  charges: z
    .array(generationUsageRecordSchema.extend({ id: z.string(), kind: z.enum(['agent', 'judge']) }))
    .max(80),
  decisions: z.array(evalDecisionSchema).max(128),
  dispatches: z.array(evalDispatchSchema).max(128),
  flags: z.array(evalFlagSchema),
  unauthorizedEffects: z.number().int().nonnegative(),
  liveDispatches: z.number().int().nonnegative(),
});
export type EvalJournal = z.infer<typeof evalJournalSchema>;
export const evalRecordSchema = z.strictObject({
  checkpoint: checkpointSchema,
  journal: evalJournalSchema,
});
export type EvalRecord = z.infer<typeof evalRecordSchema>;
export const newJournal = (): EvalJournal => ({
  models: [],
  tools: [],
  charges: [],
  decisions: [],
  dispatches: [],
  flags: [],
  unauthorizedEffects: 0,
  liveDispatches: 0,
});
export interface EvalPersistence {
  load(this: void): Promise<EvalRecord | null>;
  save(checkpoint: RunCheckpoint, journal: EvalJournal): Promise<void>;
}
export function memoryPersistence(initial: EvalRecord | null = null): EvalPersistence {
  let value = initial ? evalRecordSchema.parse(structuredClone(initial)) : null;
  return {
    load: () => Promise.resolve(value ? structuredClone(value) : null),
    save: (checkpoint, journal) => {
      value = evalRecordSchema.parse(structuredClone({ checkpoint, journal }));
      return Promise.resolve();
    },
  };
}
