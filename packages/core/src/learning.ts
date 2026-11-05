import { z } from 'zod';
import { workId } from './work';
import { browserSessionId, browserSiteSchema, browserUrlSchema } from './browser';
import { skillNameSchema, skillVersionSchema } from './skills';

export const parameterNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/)
  .refine((name) => !['constructor', 'prototype', '__proto__'].includes(name));
import { elementFingerprintSchema } from './learned-target';
export {
  learnedLocatorSchema,
  elementFingerprintSchema,
  type LearnedLocator,
  type ElementFingerprint,
} from './learned-target';
export const recordingEventSchema = z
  .strictObject({
    id: z.string().regex(/^e[1-9][0-9]{0,3}$/),
    kind: z.enum(['navigate', 'click', 'fill', 'select']),
    target: elementFingerprintSchema.nullable(),
    url: browserUrlSchema.nullable(),
    replay: z.boolean(),
  })
  .superRefine((event, context) => {
    if (
      event.kind === 'navigate'
        ? !event.url || event.target !== null
        : !event.target || event.url !== null
    )
      context.addIssue({
        code: 'custom',
        message: 'An event must have its matching target or navigation.',
      });
    if (event.url && (new URL(event.url).search || new URL(event.url).hash))
      context.addIssue({
        code: 'custom',
        message: 'Recording URLs cannot contain queries or fragments.',
      });
  });
export type RecordingEvent = z.infer<typeof recordingEventSchema>;
export const recordingEventsSchema = z
  .array(recordingEventSchema)
  .max(100)
  .refine(
    (events) =>
      JSON.stringify(events).length <= 80000 &&
      new Set(events.map((event) => event.id)).size === events.length,
  );
export const recordingSchema = z.strictObject({
  id: workId,
  sessionId: browserSessionId,
  projectId: workId,
  name: z.string().min(1).max(80),
  site: browserSiteSchema,
  status: z.enum(['recording', 'stopped', 'interrupted']),
  version: z.number().int().positive(),
  privateOnly: z.boolean(),
  events: recordingEventsSchema,
  omitted: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type Recording = z.infer<typeof recordingSchema>;
export const recordingControlSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('start'),
    requestId: z.uuid(),
    name: z.string().trim().min(1).max(80),
    version: z.number().int().positive(),
    privateOnly: z.boolean().default(true),
  }),
  z.strictObject({
    action: z.literal('stop'),
    recordingId: workId,
    version: z.number().int().positive(),
  }),
]);
export const learnedActionSchema = z
  .strictObject({
    kind: z.literal('action'),
    id: z.string().regex(/^s[1-9][0-9]{0,3}$/),
    operation: z.enum(['navigate', 'click', 'fill', 'select']),
    intent: z.string().trim().min(1).max(500),
    target: elementFingerprintSchema.nullable(),
    url: browserUrlSchema.nullable(),
    parameter: parameterNameSchema.nullable(),
  })
  .superRefine((step, context) => {
    if (
      step.operation === 'navigate'
        ? !step.url || step.target !== null
        : !step.target || step.url !== null
    )
      context.addIssue({
        code: 'custom',
        message: 'An action needs its matching target or navigation.',
      });
    if (['fill', 'select'].includes(step.operation) !== (step.parameter !== null))
      context.addIssue({
        code: 'custom',
        message: 'Only fill/select actions require a parameter.',
      });
    if (step.url && (new URL(step.url).search || new URL(step.url).hash))
      context.addIssue({
        code: 'custom',
        message: 'Use a credential-free navigation without a query or fragment.',
      });
  });
export type LearnedAction = z.infer<typeof learnedActionSchema>;
export const learnedLoopSchema = z.strictObject({
  kind: z.literal('loop'),
  id: z.string().regex(/^loop[1-9][0-9]{0,2}$/),
  parameter: parameterNameSchema,
  maxItems: z.number().int().min(1).max(20),
  steps: z.array(learnedActionSchema).min(1).max(12),
});
export const learnedProgramSchema = z
  .strictObject({
    version: z.literal(1),
    site: browserSiteSchema,
    steps: z
      .array(z.discriminatedUnion('kind', [learnedActionSchema, learnedLoopSchema]))
      .min(1)
      .max(50),
  })
  .superRefine((program, context) => {
    const ids: string[] = [];
    const names = new Map<string, string>();
    let expanded = 0;
    for (const node of program.steps) {
      ids.push(node.id);
      const actions = node.kind === 'loop' ? node.steps : [node];
      expanded += actions.length * (node.kind === 'loop' ? node.maxItems : 1);
      if (node.kind === 'loop') {
        if (names.has(node.parameter))
          context.addIssue({ code: 'custom', message: 'List parameter names must be unique.' });
        names.set(node.parameter, 'list');
        ids.push(...node.steps.map((step) => step.id));
      }
      for (const step of actions) {
        if (step.url && new URL(step.url).origin !== program.site)
          context.addIssue({
            code: 'custom',
            message: 'Every navigation must stay on the reviewed site.',
          });
        if (node.kind === 'action' && step.parameter) {
          if (names.get(step.parameter) === 'list')
            context.addIssue({
              code: 'custom',
              message: 'A parameter cannot be both text and a list.',
            });
          names.set(step.parameter, 'text');
        }
      }
    }
    if (
      new Set(ids).size !== ids.length ||
      expanded > 200 ||
      JSON.stringify(program).length > 80000
    )
      context.addIssue({
        code: 'custom',
        message: 'Keep unique step IDs and at most 200 expanded actions.',
      });
  });
export type LearnedProgram = z.infer<typeof learnedProgramSchema>;
export const loopCandidateSchema = z.strictObject({
  start: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  repeats: z.number().int().min(2),
});
export const learningInputSchema = z.strictObject({
  requestId: z.uuid(),
  name: skillNameSchema,
  parameters: z.record(z.string().regex(/^e[1-9][0-9]{0,3}$/), parameterNameSchema).default({}),
  loops: z
    .array(loopCandidateSchema.extend({ parameter: parameterNameSchema }))
    .max(5)
    .default([]),
});
export const learningLabelsSchema = z.strictObject({
  description: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .regex(/^[^\r\n]+$/),
  intents: z
    .array(
      z.strictObject({
        id: z.string().regex(/^s[1-9][0-9]{0,3}$/),
        text: z.string().trim().min(1).max(500),
      }),
    )
    .min(1)
    .max(50),
});
export const learnedDraftSchema = z.strictObject({
  id: workId,
  recordingId: workId,
  projectId: workId,
  requestId: z.uuid(),
  status: z.enum(['generating', 'ready', 'failed', 'saved']),
  name: skillNameSchema,
  description: z.string().max(240).nullable(),
  program: learnedProgramSchema.nullable(),
  markdown: z.string().max(24000).nullable(),
  script: z.string().max(100000).nullable(),
  privateOnly: z.boolean(),
  costUsd: z.number().nonnegative(),
  errorCode: z.string().nullable(),
  skillId: workId.nullable(),
  revision: z.number().int().positive().nullable(),
});
export type LearnedDraft = z.infer<typeof learnedDraftSchema>;
export const learnedVersionSchema = z.strictObject({
  skill: skillVersionSchema,
  projectId: workId,
  recordingId: workId.nullable(),
  program: learnedProgramSchema,
  programHash: z.string().regex(/^[a-f0-9]{64}$/),
  script: z.string().max(100000),
});
export type LearnedVersion = z.infer<typeof learnedVersionSchema>;
export const learnedSaveSchema = z.strictObject({
  draftId: workId,
  skillId: workId.optional(),
  expectedRevision: z.number().int().nonnegative(),
  description: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .regex(/^[^\r\n]+$/),
  program: learnedProgramSchema,
  enabled: z.boolean().default(true),
});
const learningErrors = {
  LEARNING_INVALID: 'Check the recording, parameters and reviewed steps.',
  LEARNING_NOT_FOUND: 'This recording, learned skill or revision is unavailable.',
  LEARNING_CONFLICT: 'This item changed or the request was already used. Reload before continuing.',
  LEARNING_LIMIT: 'Learning is paused or exceeds the configured size, time or spending limits.',
  LEARNING_FAILED:
    'Learning could not finish. Review the model, vault and receipt before starting a new request.',
  LEARNING_INTERRUPTED: 'This attempt was interrupted and will not repeat automatically.',
  LEARNING_DENIED: 'This action requires a current owned recording, profile or reviewed skill.',
} as const;
export class LearningError extends Error {
  constructor(readonly code: keyof typeof learningErrors) {
    super(learningErrors[code]);
    this.name = 'LearningError';
  }
}
