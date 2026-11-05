import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  freshSettings,
  namespaceSchema,
  parseSetting,
  settingsDocumentSchema,
  settingsSchemas,
} from './settings.js';
describe('settings boundaries', () => {
  it('keeps older telemetry settings off and requires an explicit safe endpoint', () => {
    const { telemetryEndpoint, telemetrySecretRef, ...older } = defaultSettings.advanced;
    expect([telemetryEndpoint, telemetrySecretRef]).toEqual([null, null]);
    expect(settingsSchemas.advanced.parse(older)).toMatchObject({
      telemetry: false,
      telemetryEndpoint: null,
      telemetrySecretRef: null,
    });
    expect(settingsSchemas.advanced.safeParse({ ...older, telemetry: true }).success).toBe(false);
    for (const telemetryEndpoint of [
      'https://user:key@collector/v1/traces',
      'https://collector/v1/traces?token=secret',
      'file:///collector',
    ]) {
      expect(
        settingsSchemas.advanced.safeParse({ ...older, telemetry: true, telemetryEndpoint })
          .success,
      ).toBe(false);
    }
    expect(
      settingsSchemas.advanced.safeParse({
        ...older,
        telemetry: true,
        telemetryEndpoint: 'http://collector:4318/v1/traces',
      }).success,
    ).toBe(true);
    expect(
      settingsSchemas.advanced.safeParse({ ...older, telemetrySecretRef: 'bearer-plaintext' })
        .success,
    ).toBe(false);
  });
  it('validates explicit model limits and defaults older settings to no overrides', () => {
    const defaults = freshSettings().models.value;
    const { modelLimits: omitted, ...older } = defaults;
    expect(omitted).toEqual([]);
    expect(settingsSchemas.models.parse(older).modelLimits).toEqual([]);
    expect(
      settingsSchemas.models.safeParse({
        ...defaults,
        modelLimits: [
          { providerId: 'local', modelId: 'model', contextWindow: 8192, maxOutput: 9000 },
        ],
      }).success,
    ).toBe(false);
  });
  it.each(namespaceSchema.options)(
    'validates the %s defaults and rejects unknown keys',
    (namespace) => {
      expect(settingsSchemas[namespace].safeParse(defaultSettings[namespace]).success).toBe(true);
      expect(
        settingsSchemas[namespace].safeParse({
          ...defaultSettings[namespace],
          password: 'plaintext-key',
        }).success,
      ).toBe(false);
    },
  );
  it('rejects credential-bearing endpoints, invalid timezones, and non-reference secrets', () => {
    for (const baseUrl of [
      'https://user:password@host/',
      'https://host/?key=secret',
      'ftp://host/',
      'https://host/#secret',
    ])
      expect(
        settingsSchemas.general.safeParse({ ...defaultSettings.general, baseUrl }).success,
      ).toBe(false);
    expect(
      settingsSchemas.general.safeParse({
        ...defaultSettings.general,
        timezone: 'Invalid/Timezone',
      }).success,
    ).toBe(false);
    expect(
      settingsSchemas.channels.safeParse({
        ...defaultSettings.channels,
        telegramSecretRef: 'plaintext-key',
      }).success,
    ).toBe(false);
  });
  it('returns detached defaults and validates nested documents', () => {
    const first = freshSettings();
    first.providers.value.items.push({
      id: 'local',
      name: 'Local',
      kind: 'ollama',
      baseUrl: 'http://localhost:11434',
      enabled: true,
      locality: 'local',
      secretRef: null,
    });
    expect(freshSettings().providers.value.items).toHaveLength(0);
    expect(
      settingsDocumentSchema.safeParse({
        ...first,
        budgets: { version: 1, value: { monthlyUsd: -1 } },
      }).success,
    ).toBe(false);
    expect(() => parseSetting('budgets', { ...defaultSettings.budgets, maxSteps: 0 })).toThrow();
  });
});
