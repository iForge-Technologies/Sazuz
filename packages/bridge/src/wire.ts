import type { RawData } from 'ws';
import { BridgeError } from '@sazuz/core/bridge';
export function bridgeSocketText(data: RawData) {
  const size = Array.isArray(data)
    ? data.reduce((total, part) => total + part.length, 0)
    : data.byteLength;
  if (size > 16384) throw new BridgeError('BRIDGE_INVALID');
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  return new TextDecoder('utf8', { fatal: true }).decode(buffer);
}
