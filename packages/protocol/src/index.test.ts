import { describe, expect, it } from 'vitest';
import { HelloSchema, PROTOCOL_VERSION } from './index.js';

describe('protocol hello', () => {
  it('round-trips a valid hello envelope', () => {
    const hello = {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'renderer', version: '0.1.0' },
      capabilities: { streaming: true },
    };
    expect(HelloSchema.parse(hello)).toEqual(hello);
  });

  it('rejects a wrong protocol version', () => {
    expect(() =>
      HelloSchema.parse({
        type: 'hello',
        protocolVersion: 2,
        clientInfo: { name: 'renderer', version: '0.1.0' },
        capabilities: {},
      }),
    ).toThrow();
  });
});
