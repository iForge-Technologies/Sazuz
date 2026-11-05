import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { z } from 'zod';
import type {
  passkeyAuthenticateOptionsSchema,
  passkeyRegisterOptionsSchema,
} from '@sazuz/core/audit';

// Minimal, genuine ES256 WebAuthn authenticator fixture. It never mocks signature verification.
function length(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const result = Buffer.alloc(3);
  result[0] = (major << 5) | 25;
  result.writeUInt16BE(value, 1);
  return result;
}
function cbor(value: string | number | Buffer | Map<string | number, unknown>): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.concat([length(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([length(3, bytes.length), bytes]);
  }
  if (typeof value === 'number') return length(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  return Buffer.concat([
    length(5, value.size),
    ...[...value].flatMap(([key, item]) => {
      if (!(
        typeof item === 'string' ||
        typeof item === 'number' ||
        Buffer.isBuffer(item) ||
        item instanceof Map
      ))
        throw new Error('Invalid fixture CBOR.');
      return [cbor(key), cbor(item as string | number | Buffer | Map<string | number, unknown>)];
    }),
  ]);
}
export function authenticatorFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credential = randomBytes(32);
  let userHandle = '';
  let counter = 0;
  function data(rpId: string, flags: number) {
    const number = Buffer.alloc(4);
    number.writeUInt32BE(counter);
    return Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([flags]),
      number,
    ]);
  }
  function client(challenge: string, type: string, origin: string) {
    return Buffer.from(JSON.stringify({ challenge, type, origin, crossOrigin: false }));
  }
  return {
    register(
      options: z.infer<typeof passkeyRegisterOptionsSchema>,
      verified = true,
      origin = 'http://localhost:7777',
    ) {
      userHandle = options.user.id;
      const cose = cbor(
        new Map<number, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, 'base64url')],
          [-3, Buffer.from(jwk.y!, 'base64url')],
        ]),
      );
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credential.length);
      const authData = Buffer.concat([
        data(options.rp.id, verified ? 0x45 : 0x41),
        Buffer.alloc(16),
        idLength,
        credential,
        cose,
      ]);
      const attestation = cbor(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      );
      return {
        name: 'Fixture security key',
        response: {
          id: credential.toString('base64url'),
          rawId: credential.toString('base64url'),
          type: 'public-key' as const,
          clientExtensionResults: {},
          response: {
            clientDataJSON: client(options.challenge, 'webauthn.create', origin).toString(
              'base64url',
            ),
            attestationObject: attestation.toString('base64url'),
            transports: ['internal' as const],
          },
        },
      };
    },
    authenticate(
      options: z.infer<typeof passkeyAuthenticateOptionsSchema>,
      verified = true,
      origin = 'http://localhost:7777',
    ) {
      counter++;
      const authData = data(options.rpId, verified ? 0x05 : 0x01);
      const json = client(options.challenge, 'webauthn.get', origin);
      const signature = sign(
        'sha256',
        Buffer.concat([authData, createHash('sha256').update(json).digest()]),
        privateKey,
      );
      return {
        response: {
          id: credential.toString('base64url'),
          rawId: credential.toString('base64url'),
          type: 'public-key' as const,
          clientExtensionResults: {},
          response: {
            clientDataJSON: json.toString('base64url'),
            authenticatorData: authData.toString('base64url'),
            signature: signature.toString('base64url'),
            userHandle,
          },
        },
      };
    },
  };
}
