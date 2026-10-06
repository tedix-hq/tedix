import { createHash } from "node:crypto";

/**
 * Truncated SHA-256 content hash (first 16 hex chars) — the one mechanism
 * behind every persisted brain-bridge dedup/idempotency key:
 *
 * - `observationHash` / `entityHash` (bridge.ts) — DedupStore keys
 * - `actionHash` (rationale-bridge.ts) — rationale state + platform
 *   `turn-episode:` idempotency keys
 *
 * The INPUT FRAMING (prefixes, normalization) is each caller's persisted
 * contract. Changing a caller's framing — or this digest/truncation — breaks
 * continuity with already-persisted keys, so re-learns and duplicate records
 * would slip past dedup. Characterization pins live in
 * similarity-characterization.test.ts.
 *
 * Distinct on purpose from `computeProvenanceHash` in
 * `@tedix/context-core/compiler`: that one is async Web Crypto because
 * context-core stays runtime-neutral (no `node:crypto`), and its input is the
 * sorted rationale-id list. This helper is Node-only like the rest of
 * brain-bridge's synchronous hashing paths.
 */
export function sha256Hex16(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
