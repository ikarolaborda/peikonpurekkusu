import { unframe } from './wire';

function frame(envelope: object): Buffer {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeInt32BE(7, 1);
  return Buffer.concat([header, json]);
}

describe('wire.unframe', () => {
  it('parses a framed envelope', () => {
    const env = unframe(
      frame({ event_id: 'e1', event_type: 'payments.payment.captured.v1', payload: { user_id: 'u1' } }),
    );
    expect(env.event_id).toBe('e1');
    expect(env.payload.user_id).toBe('u1');
  });

  it('rejects raw JSON (no magic byte)', () => {
    expect(() => unframe(Buffer.from('{"event_id":"x"}', 'utf8'))).toThrow();
  });

  it('rejects an envelope missing required fields', () => {
    expect(() => unframe(frame({ payload: {} }))).toThrow();
  });
});
