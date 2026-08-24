import { z } from "zod";

/**
 * Minimal structural validation for a JSON-RPC 2.0 response envelope.
 *
 * Deliberately permissive on `jsonrpc` (kept as `z.unknown()` here
 * rather than `z.literal("2.0")`) and on `id` (typed per the JSON-RPC
 * spec's `string | number | null`) — the *business-logic* checks that
 * `jsonrpc` is exactly `"2.0"` and that `id` matches the outgoing
 * request's own id live in `client.ts`'s `callRpc`, not here, so that a
 * version mismatch and an id mismatch can each produce their own
 * specific, diagnosable `RobinhoodRpcMalformedResponseError` reason
 * rather than one generic schema-validation failure.
 *
 * What this schema *does* enforce: the response is a JSON object (not
 * an array, string, or bare primitive), and if it carries an `error` it
 * is shaped like a JSON-RPC error object (`{code, message, data?}`).
 * Whether `result` XOR `error` is actually present — as opposed to both
 * or neither — is also `callRpc`'s job, since that's a cross-field
 * invariant `zod` would express more awkwardly than a plain runtime
 * check.
 */
const jsonRpcErrorObjectSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

export const jsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.unknown(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: jsonRpcErrorObjectSchema.optional(),
});

export type JsonRpcEnvelope = z.infer<typeof jsonRpcEnvelopeSchema>;
export type JsonRpcErrorObject = z.infer<typeof jsonRpcErrorObjectSchema>;
