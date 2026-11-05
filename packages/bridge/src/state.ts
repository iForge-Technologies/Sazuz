import { randomBytes } from 'node:crypto';
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { BridgeError, bridgeEndpointSchema } from '@sazuz/core/bridge';
import { workId } from '@sazuz/core/work';
import { CompanionVault, companionMetadataSchema, secretRedactor } from '@sazuz/vault';
import {
  preparePrivateSecretDirectory,
  readPrivateFiles,
  claimPrivateFile,
} from '@sazuz/config/private-files';
import { digest, localConfigSchema, localPin, prepareLocalConfiguration } from './local-config.js';

export const pairingSchema = z.strictObject({
  endpoint: bridgeEndpointSchema,
  deviceId: workId,
  projectId: workId,
  token: z
    .string()
    .min(32)
    .max(4096)
    .refine((value) => !/\s/.test(value)),
});
export class BridgeState {
  private constructor(
    readonly directory: string,
    private readonly vault: CompanionVault,
  ) {}
  static async create(
    directory: string,
    passphrase: string,
    pairing: unknown,
    configuration: unknown,
  ) {
    const value = pairingSchema.parse(pairing);
    await preparePrivateSecretDirectory(directory);
    const root = await realpath(directory);
    const previous = await readPrivateFiles(root, [
      { name: 'vault.json', maxBytes: 8192, optional: true },
    ]);
    if (previous.size) throw new BridgeError('BRIDGE_CONFLICT');
    await claimPrivateFile(root, 'machine.key', randomBytes(32));
    const machine = (await readPrivateFiles(root, [{ name: 'machine.key', maxBytes: 32 }])).get(
      'machine.key',
    )!;
    let vault: CompanionVault;
    try {
      secretRedactor.register(machine.toString('base64url'));
      secretRedactor.register(machine.toString('hex'));
      vault = await CompanionVault.initialize(passphrase, machine);
    } finally {
      machine.fill(0);
    }
    const state = new BridgeState(root, vault);
    if (
      !(await claimPrivateFile(root, 'vault.json', Buffer.from(JSON.stringify(vault.metadata))))
    ) {
      vault.close();
      throw new BridgeError('BRIDGE_CONFLICT');
    }
    try {
      secretRedactor.register(value.token);
      await state.write('pairing.vault', value);
      await state.configure(configuration);
      return state;
    } catch (error) {
      state.close();
      throw error;
    }
  }
  static async open(directory: string) {
    const root = await realpath(directory);
    const files = await readPrivateFiles(root, [
      { name: 'machine.key', maxBytes: 32 },
      { name: 'vault.json', maxBytes: 8192 },
    ]);
    const machine = files.get('machine.key')!;
    try {
      secretRedactor.register(machine.toString('base64url'));
      secretRedactor.register(machine.toString('hex'));
      const metadata = companionMetadataSchema.parse(
        JSON.parse(files.get('vault.json')!.toString('utf8')) as unknown,
      );
      const state = new BridgeState(root, await CompanionVault.unlock(metadata, machine));
      await state.withPairing((pairing) => {
        secretRedactor.register(pairing.token);
        return Promise.resolve();
      });
      return state;
    } finally {
      machine.fill(0);
    }
  }
  async read<T>(name: string, schema: z.ZodType<T>): Promise<T | null> {
    if ((await realpath(this.directory)) !== this.directory) throw new BridgeError('BRIDGE_DENIED');
    const files = await readPrivateFiles(this.directory, [
      { name, maxBytes: 65536, optional: true },
    ]);
    const file = files.get(name);
    if (!file) return null;
    try {
      return await this.vault.consume(
        name,
        JSON.parse(file.toString('utf8')) as unknown,
        schema,
        (value) => Promise.resolve(value),
      );
    } finally {
      file.fill(0);
    }
  }
  async write(name: string, value: unknown): Promise<boolean> {
    const encoded = Buffer.from(JSON.stringify(this.vault.encrypt(name, value)));
    try {
      return await claimPrivateFile(this.directory, name, encoded);
    } finally {
      encoded.fill(0);
    }
  }
  async withPairing<T>(consume: (value: z.infer<typeof pairingSchema>) => Promise<T>) {
    const pairing = await this.read('pairing.vault', pairingSchema);
    if (!pairing) throw new BridgeError('BRIDGE_INVALID');
    return consume(pairing);
  }
  private async configurations() {
    const names = (await readdir(join(this.directory, 'secrets')))
      .filter((name) => /^config-[0-9]{6}\.vault$/.test(name))
      .sort();
    if (names.length > 1000) throw new BridgeError('BRIDGE_INVALID');
    return names;
  }
  async configuration() {
    const names = await this.configurations(),
      name = names.at(-1);
    const config = name ? await this.read(name, localConfigSchema) : null;
    if (!config) throw new BridgeError('BRIDGE_INVALID');
    return config;
  }
  async configure(input: unknown) {
    const config = await prepareLocalConfiguration(input, this.directory),
      names = await this.configurations();
    const next = Number(names.at(-1)?.slice(7, 13) ?? '0') + 1;
    if (!(await this.write(`config-${String(next).padStart(6, '0')}.vault`, config)))
      throw new BridgeError('BRIDGE_CONFLICT');
    return localPin(config);
  }
  receiptName(key: string, kind: 'start' | 'done') {
    return `${kind}-${digest(key).slice(0, 48)}.vault`;
  }
  close() {
    this.vault.close();
  }
}
