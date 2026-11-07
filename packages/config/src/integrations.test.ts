import { describe, expect, it } from 'vitest';
import { freshSettings, settingsDocumentSchema } from './settings.js';
import { channelConnectionSchema, mcpConnectionSchema } from './integrations.js';
describe('integration configuration compatibility', () => {
  it('supplies new fields when loading an existing installation document', () => {
    const old = JSON.parse(JSON.stringify(freshSettings())) as {
      channels: { value: Record<string, unknown> };
      advanced: { value: Record<string, unknown> };
    };
    delete old.channels.value.connections;
    delete old.advanced.value.mcp;
    const parsed = settingsDocumentSchema.parse(old);
    expect(parsed.channels.value.connections).toEqual([]);
    expect(parsed.advanced.value.mcp).toEqual([]);
  });
  it('accepts vault handles and rejects inline credentials and credential-bearing URLs', () => {
    const input = { id: 'server', name: 'Server', url: 'https://example.com/mcp' };
    expect(mcpConnectionSchema.safeParse(input).success).toBe(true);
    for (const url of [
      'http://example.com/mcp',
      'https://user:pass@example.com/mcp',
      'https://example.com/mcp?token=secret',
    ])
      expect(mcpConnectionSchema.safeParse({ ...input, url }).success).toBe(false);
    expect(mcpConnectionSchema.safeParse({ ...input, secretRef: 'plaintext-token' }).success).toBe(
      false,
    );
    expect(
      channelConnectionSchema.safeParse({
        id: 'channel',
        name: 'Channel',
        kind: 'whatsapp-qr',
        projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }).success,
    ).toBe(true);
  });
});
