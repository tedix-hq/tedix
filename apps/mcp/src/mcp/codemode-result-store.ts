/**
 * Short-lived store for over-budget Code Mode results.
 *
 * An oversized `code` result is written once to the already-bound
 * `AGGREGATE_CACHE` R2 bucket under the producing organization and
 * executionId, and the model receives a handle envelope instead of a lossy
 * truncation. `discover.read_result` pages it back. A handle resolves only for
 * the same organization and the same principal (user, tedi or client) that
 * produced it, and only until it expires; anything else reads as missing.
 */

import { type ServerContext } from "./server-context";

export const CODEMODE_RESULT_HANDLE_TTL_MS = 30 * 60_000;
const KEY_PREFIX = "codemode-results/v1";
const HANDLE_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CodeModeResultOwner {
	organizationId: string;
	principal: string;
}

export interface CodeModeResultStore {
	put(executionId: string, serialized: string): Promise<{ expiresAt: string }>;
	/** `null` when the handle is unknown, expired, or not this owner's. */
	get(handle: string): Promise<string | null>;
}

type ResultBucket = Pick<R2Bucket, "put" | "get" | "delete">;

/** The identity a handle is bound to; `null` when the caller has none. */
export function codeModeResultOwner(
	serverCtx: Pick<ServerContext, "app" | "callerIdentity">,
): CodeModeResultOwner | null {
	const identity = serverCtx.callerIdentity;
	const organizationId = serverCtx.app?.organizationId;
	if (!identity || !organizationId) return null;
	const principal = identity.userId
		? `user:${identity.userId}`
		: identity.tediId
			? `tedi:${identity.tediId}`
			: identity.clientId
				? `client:${identity.clientId}`
				: null;
	return principal ? { organizationId, principal } : null;
}

function resultBucket(env: unknown): ResultBucket | null {
	if (typeof env !== "object" || env === null) return null;
	const bucket = (env as { AGGREGATE_CACHE?: unknown }).AGGREGATE_CACHE;
	if (
		typeof bucket !== "object" ||
		bucket === null ||
		typeof (bucket as ResultBucket).put !== "function" ||
		typeof (bucket as ResultBucket).get !== "function"
	) {
		return null;
	}
	return bucket as ResultBucket;
}

function resultKey(owner: CodeModeResultOwner, handle: string): string {
	return `${KEY_PREFIX}/${owner.organizationId}/${handle}`;
}

/** `null` when no bucket is bound or the caller has no identity to bind to. */
export function createCodeModeResultStore(
	env: unknown,
	owner: CodeModeResultOwner | null,
	options: { now?: () => number; ttlMs?: number } = {},
): CodeModeResultStore | null {
	const bucket = resultBucket(env);
	if (!bucket || !owner) return null;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? CODEMODE_RESULT_HANDLE_TTL_MS;
	return {
		async put(executionId, serialized) {
			const expiresAt = new Date(now() + ttlMs).toISOString();
			await bucket.put(resultKey(owner, executionId), serialized, {
				httpMetadata: { contentType: "application/json" },
				customMetadata: { principal: owner.principal, expiresAt },
			});
			return { expiresAt };
		},
		async get(handle) {
			if (!HANDLE_PATTERN.test(handle)) return null;
			const key = resultKey(owner, handle);
			const object = await bucket.get(key);
			if (!object) return null;
			const metadata = object.customMetadata ?? {};
			if (metadata.principal !== owner.principal) return null;
			const expiresAt = Date.parse(metadata.expiresAt ?? "");
			if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
				// Lazy cleanup: R2 has no per-object TTL here.
				await bucket.delete(key).catch(() => undefined);
				return null;
			}
			return object.text();
		},
	};
}

export function codeModeResultHandleUnavailableMessage(handle: string): string {
	return `Result handle "${handle}" is unknown, expired, or was produced for another user or organization. Handles live ${CODEMODE_RESULT_HANDLE_TTL_MS / 60_000} minutes and resolve only for the caller that produced them; re-run the program with a narrower projection.`;
}
