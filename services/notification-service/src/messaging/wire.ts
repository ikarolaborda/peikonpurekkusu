export interface DecodedEnvelope {
  event_id: string;
  event_type: string;
  correlation_id: string;
  payload: Record<string, unknown>;
}

/**
 * Parse the Confluent wire format (magic 0x00 + big-endian int32 schema id +
 * JSON envelope). Rejects raw JSON — framed and unframed messages are never
 * mixed on a topic.
 */
export function unframe(value: Buffer): DecodedEnvelope {
  if (value.length < 6 || value[0] !== 0) {
    throw new Error('not a confluent-framed message');
  }
  const env = JSON.parse(value.subarray(5).toString('utf8')) as Partial<DecodedEnvelope>;
  if (!env.event_id || !env.event_type) {
    throw new Error('envelope missing event_id/event_type');
  }
  return {
    event_id: env.event_id,
    event_type: env.event_type,
    correlation_id: env.correlation_id ?? env.event_id,
    payload: (env.payload as Record<string, unknown>) ?? {},
  };
}
