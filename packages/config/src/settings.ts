import { z } from 'zod';
import { policyRuleSchema } from '@sazuz/policy';
import { connectorProviderSchema, connectorResourceFields } from '@sazuz/core/connectors';

export const secretRefSchema = z.string().regex(/^secret:\/\/sec_[0-9A-HJKMNP-TV-Z]{26}$/);
const label = z.string().trim().min(1).max(120);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const zone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
const endpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  });
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const secret = secretRefSchema.nullable();

export const providerSchema = z.strictObject({
  id,
  name: label,
  kind: z.enum(['anthropic', 'openai', 'google', 'openai-compatible', 'ollama', 'other']),
  baseUrl: endpoint,
  secretRef: secret,
  locality: z.enum(['cloud', 'local']),
  enabled: z.boolean(),
});
const role = z.strictObject({ providerId: id, modelId: z.string().trim().min(1).max(200) });
export const teamSchema = z.strictObject({
  template: z.enum([
    'personal-ops',
    'developer',
    'freelancer',
    'researcher',
    'job-seeker',
    'custom',
  ]),
  agents: z
    .array(
      z.enum([
        'cos',
        'researcher',
        'operator',
        'coder',
        'comms',
        'scheduler',
        'analyst',
        'writer',
        'monitor',
        'auditor',
      ]),
    )
    .min(1)
    .max(10)
    .refine((items) => new Set(items).size === items.length),
});

export const settingsSchemas = {
  general: z.strictObject({
    instanceName: label,
    baseUrl: endpoint,
    timezone: zone,
    language: z.enum(['en']),
    theme: z.enum(['system', 'light', 'dark']),
  }),
  profile: z.strictObject({
    displayName: z.string().trim().max(120),
    workingStart: clock,
    workingEnd: clock,
    quietStart: clock,
    quietEnd: clock,
    digestTimes: z.array(clock).max(6),
    tone: z.enum(['concise', 'friendly', 'formal']),
    noiseBudget: z.number().int().min(0).max(100),
    priorityModel: z.boolean().default(true),
    vipSenders: z.array(z.email().max(320)).max(100).default([]),
    priorityRules: z
      .array(
        z.strictObject({
          projectId: z
            .string()
            .regex(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/)
            .nullable(),
          source: z.string().regex(/^[a-z]+:[A-Za-z0-9_-]{1,128}$/),
          bias: z.number().int().min(-40).max(40),
        }),
      )
      .max(200)
      .default([]),
  }),
  providers: z.strictObject({
    items: z
      .array(providerSchema)
      .max(25)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  }),
  models: z.strictObject({
    preset: z.enum(['quality', 'balanced', 'budget', 'private']),
    roles: z.strictObject({
      planner: role.nullable(),
      executor: role.nullable(),
      fast: role.nullable(),
      vision: role.nullable(),
      embedding: role.nullable(),
    }),
    fallbackOrder: z.array(id).max(25),
    providerRateLimits: z
      .array(
        z.strictObject({
          providerId: id,
          requestsPerMinute: z.number().int().min(1).max(100000),
          burst: z.number().int().min(1).max(1000),
        }),
      )
      .max(25)
      .refine((items) => new Set(items.map((item) => item.providerId)).size === items.length)
      .default([]),
    modelLimits: z
      .array(
        z
          .strictObject({
            providerId: id,
            modelId: z.string().min(1).max(200),
            contextWindow: z.number().int().min(256).max(10_000_000),
            maxOutput: z.number().int().min(1).max(1_000_000),
          })
          .refine((value) => value.maxOutput <= value.contextWindow),
      )
      .max(5000)
      .default([]),
    priceOverrides: z
      .array(
        z.strictObject({
          providerId: id,
          modelId: z.string().min(1).max(200),
          price: z.strictObject({
            inputPerMTok: z.number().finite().min(0).max(1_000_000),
            outputPerMTok: z.number().finite().min(0).max(1_000_000),
            cachedInputPerMTok: z.number().finite().min(0).max(1_000_000).optional(),
          }),
        }),
      )
      .max(5000)
      .default([]),
  }),
  budgets: z.strictObject({
    monthlyUsd: z.number().min(0).max(1_000_000),
    dailyUsd: z.number().min(0).max(100_000),
    perRunUsd: z.number().min(0).max(10_000),
    maxSteps: z.number().int().min(1).max(1000),
    maxConcurrentRuns: z.number().int().min(1).max(16).default(4),
    maxWallTimeSeconds: z.number().int().min(10).max(86_400),
    alertPercentages: z.array(z.number().int().min(1).max(100)).min(1).max(5),
    onCap: z.enum(['pause', 'downgrade', 'ask']),
  }),
  security: z.strictObject({
    preset: z.enum(['cautious', 'balanced', 'autonomous']),
    sessionTimeoutMinutes: z.number().int().min(5).max(10_080),
    requireTwoFactor: z.boolean(),
    egressDefault: z.literal('deny'),
    agentDomains: z
      .array(
        z.strictObject({
          agentId: z.enum(['cos', 'researcher', 'comms', 'coder', 'operator', 'analyst']),
          domains: z
            .array(
              z
                .string()
                .max(253)
                .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
            )
            .max(32),
        }),
      )
      .max(6)
      .refine((items) => new Set(items.map((item) => item.agentId)).size === items.length)
      .default([]),
    rules: z.array(policyRuleSchema).max(1000).default([]),
  }),
  connectors: z.strictObject({
    accounts: z
      .array(
        z.strictObject({
          id,
          name: label,
          kind: z.enum(['email', 'calendar', 'github', 'chat', 'productivity']),
          secretRef: secret,
          scopes: z.array(z.string().trim().min(1).max(120)).max(30),
          mode: z.enum(['read', 'read-write']),
          provider: connectorProviderSchema.nullable().default(null),
          options: z
            .strictObject({
              ...connectorResourceFields,
              email: z.email().max(254).optional(),
              imapHost: z
                .string()
                .trim()
                .min(1)
                .max(253)
                .regex(/^[a-zA-Z0-9.-]+$/)
                .optional(),
              imapPort: z.number().int().min(1).max(65535).optional(),
              imapSecure: z.boolean().optional(),
              smtpHost: z
                .string()
                .trim()
                .min(1)
                .max(253)
                .regex(/^[a-zA-Z0-9.-]+$/)
                .optional(),
              smtpPort: z.number().int().min(1).max(65535).optional(),
              smtpSecure: z.boolean().optional(),
              sentMailbox: z
                .string()
                .min(1)
                .max(200)
                .regex(/^[^\r\n\0]+$/)
                .optional(),
              calendarId: z.string().min(1).max(254).optional(),
              repo: z
                .string()
                .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
                .max(200)
                .optional(),
              oauthClientId: z.string().min(1).max(300).optional(),
              oauthClientSecretRef: secretRefSchema.optional(),
              oauthRedirectUri: endpoint.optional(),
            })
            .default({}),
        }),
      )
      .max(30),
  }),
  channels: z.strictObject({
    webPush: z.boolean(),
    telegramSecretRef: secret,
    discordSecretRef: secret,
    emailAddress: z.email().max(254).nullable(),
    urgent: z.enum(['web', 'telegram', 'discord', 'email']),
    digest: z.enum(['web', 'telegram', 'discord', 'email']),
  }),
  speech: z.strictObject({
    enabled: z.boolean(),
    maxRequestUsd: z.number().min(0).max(5),
    transcription: role.extend({ pricePerMinuteUsd: z.number().min(0).max(100) }).nullable(),
    synthesis: role
      .extend({
        voice: z.string().trim().min(1).max(100),
        pricePerMillionCharactersUsd: z.number().min(0).max(10000),
      })
      .nullable(),
  }),
  memory: z.strictObject({
    autoAccept: z.boolean(),
    retentionDays: z.number().int().min(1).max(3650),
    embeddingModel: z.string().min(1).max(200).nullable(),
  }),
  sandbox: z.strictObject({
    cpu: z.number().min(0.25).max(16),
    memoryMb: z.number().int().min(128).max(32_768),
    timeoutSeconds: z.number().int().min(10).max(3600),
    network: z.literal('none'),
    runtime: z.enum(['runc', 'runsc']).default('runc'),
    pids: z.number().int().min(16).max(256).default(64),
  }),
  browser: z.strictObject({
    poolSize: z.number().int().min(1).max(10),
    screencastQuality: z.number().int().min(10).max(100),
    sessionMinutes: z.number().int().min(1).max(60).default(30),
  }),
  backups: z.strictObject({
    enabled: z.boolean(),
    prune: z.boolean().default(false),
    schedule: z
      .string()
      .regex(/^[\d*/,-]+(?: [\d*/,-]+){4}$/)
      .max(100),
    retentionDays: z.number().int().min(1).max(3650),
    target: z.literal('local'),
  }),
  advanced: z
    .strictObject({
      logLevel: z.enum(['debug', 'info', 'warn', 'error']),
      telemetry: z.boolean(),
      telemetryEndpoint: endpoint.nullable().default(null),
      telemetrySecretRef: secret.default(null),
      experimental: z.boolean(),
      team: teamSchema,
    })
    .refine((value) => !value.telemetry || value.telemetryEndpoint !== null, {
      message: 'Configure an OTLP/HTTP traces endpoint before enabling export.',
      path: ['telemetryEndpoint'],
    }),
} as const;

export const namespaceSchema = z.enum([
  'general',
  'profile',
  'providers',
  'models',
  'budgets',
  'security',
  'connectors',
  'channels',
  'speech',
  'memory',
  'sandbox',
  'browser',
  'backups',
  'advanced',
]);
export type SettingsNamespace = z.infer<typeof namespaceSchema>;
export type SettingsValues = { [K in SettingsNamespace]: z.infer<(typeof settingsSchemas)[K]> };
export type SettingsDocument = {
  [K in SettingsNamespace]: { version: number; value: SettingsValues[K] };
};

export const defaultSettings: SettingsValues = {
  general: {
    instanceName: 'Sazuz',
    baseUrl: 'http://localhost:7777',
    timezone: 'UTC',
    language: 'en',
    theme: 'system',
  },
  profile: {
    displayName: '',
    workingStart: '09:00',
    workingEnd: '17:00',
    quietStart: '22:00',
    quietEnd: '08:00',
    digestTimes: ['09:00', '18:00'],
    tone: 'concise',
    noiseBudget: 5,
    priorityModel: true,
    vipSenders: [],
    priorityRules: [],
  },
  providers: { items: [] },
  models: {
    preset: 'balanced',
    roles: { planner: null, executor: null, fast: null, vision: null, embedding: null },
    fallbackOrder: [],
    providerRateLimits: [],
    priceOverrides: [],
    modelLimits: [],
  },
  budgets: {
    monthlyUsd: 25,
    dailyUsd: 5,
    perRunUsd: 0.5,
    maxSteps: 40,
    maxConcurrentRuns: 4,
    maxWallTimeSeconds: 1800,
    alertPercentages: [50, 80, 100],
    onCap: 'pause',
  },
  security: {
    preset: 'balanced',
    sessionTimeoutMinutes: 1440,
    requireTwoFactor: false,
    egressDefault: 'deny',
    agentDomains: [],
    rules: [],
  },
  connectors: { accounts: [] },
  channels: {
    webPush: false,
    telegramSecretRef: null,
    discordSecretRef: null,
    emailAddress: null,
    urgent: 'web',
    digest: 'web',
  },
  speech: { enabled: false, maxRequestUsd: 0.05, transcription: null, synthesis: null },
  memory: { autoAccept: false, retentionDays: 365, embeddingModel: null },
  sandbox: {
    cpu: 1,
    memoryMb: 512,
    timeoutSeconds: 120,
    network: 'none',
    runtime: 'runc',
    pids: 64,
  },
  browser: { poolSize: 1, screencastQuality: 60, sessionMinutes: 30 },
  backups: {
    enabled: false,
    prune: false,
    schedule: '0 3 * * *',
    retentionDays: 14,
    target: 'local',
  },
  advanced: {
    logLevel: 'info',
    telemetry: false,
    telemetryEndpoint: null,
    telemetrySecretRef: null,
    experimental: false,
    team: {
      template: 'personal-ops',
      agents: ['cos', 'researcher', 'comms', 'scheduler', 'auditor'],
    },
  },
};

export function parseSetting<N extends SettingsNamespace>(
  namespace: N,
  value: unknown,
): SettingsValues[N] {
  // Each schema is indexed by its corresponding namespace; this assertion preserves that mapping.
  return settingsSchemas[namespace].parse(value) as SettingsValues[N];
}

export const settingsEntrySchema = z.strictObject({
  version: z.number().int().nonnegative(),
  value: z.unknown(),
});
export const settingsDocumentSchema = z
  .record(namespaceSchema, settingsEntrySchema)
  .superRefine((document, context) => {
    for (const namespace of namespaceSchema.options) {
      if (!settingsSchemas[namespace].safeParse(document[namespace].value).success)
        context.addIssue({
          code: 'custom',
          message: 'Invalid settings document.',
          path: [namespace],
        });
    }
  })
  .transform((document) => document as SettingsDocument);

export function freshSettings(): SettingsDocument {
  return settingsDocumentSchema.parse(
    Object.fromEntries(
      namespaceSchema.options.map((namespace) => [
        namespace,
        { version: 0, value: structuredClone(defaultSettings[namespace]) },
      ]),
    ),
  );
}
