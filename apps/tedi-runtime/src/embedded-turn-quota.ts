/**
 * Per-visitor and per-origin turn quota for embedded (widget) sessions.
 *
 * A host backend can mint any number of embedded sessions, so the per-session
 * limiter in `@tedix/chat-transport` and the tedi's daily inference budget
 * together still let one visitor or one origin drain a tedi. This counter
 * lives in the tedi's own Durable Object storage, so the count is durable per
 * tedi and shared by every session the host opens.
 *
 * Fixed hourly buckets (`floor(now / 1h)`): one key per scope per hour, no
 * weighting of the previous bucket. Simpler to reason about and to test than
 * a weighted sliding window, and a burst at a bucket edge can at most double
 * the hourly ceiling, which is acceptable for a budget guard.
 *
 * Limits ride in the signed session claims (resolved from D1 config when the
 * API mints the session); a token without them gets the platform defaults.
 */
import {
	type EmbeddedTurnQuota,
	isEmbeddedSessionKey,
	type StreamChatTurnInput,
} from "./chat-stream-input";

/** Platform defaults, applied when the signed session carries no ceiling. */
export const EMBEDDED_TURN_QUOTA_DEFAULTS = {
	visitorTurnsPerHour: 60,
	originTurnsPerHour: 600,
} as const;

export const EMBEDDED_TURN_QUOTA_BUCKET_MS = 3_600_000;
const STORAGE_PREFIX = "embedded-quota:";
const MAX_SCOPE_KEY_LENGTH = 200;

/** What the runtime edge forwards for an embedded turn, snake_case on the wire. */
export interface InternalEmbeddedQuotaPayload {
	origin?: string;
	visitor_key?: string;
	visitor_turns_per_hour?: number;
	origin_turns_per_hour?: number;
}

export type EmbeddedTurnQuotaVerdict =
	| { ok: true }
	| {
			ok: false;
			kind: "visitor" | "origin";
			count: number;
			limit: number;
			retryAfterSeconds: number;
	  };

/** The KV subset of `DurableObjectStorage` the counter touches. */
export interface EmbeddedQuotaStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

function readLimit(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function readScopeKey(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0
		? value.slice(0, MAX_SCOPE_KEY_LENGTH)
		: undefined;
}

/** Shape-check the edge's payload; `/__internal/*` is reachable only from this Worker's own edge. */
export function embeddedTurnQuotaFromPayload(
	payload: InternalEmbeddedQuotaPayload | undefined,
): EmbeddedTurnQuota | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	return {
		origin: readScopeKey(payload.origin),
		visitorKey: readScopeKey(payload.visitor_key),
		visitorTurnsPerHour: readLimit(payload.visitor_turns_per_hour),
		originTurnsPerHour: readLimit(payload.origin_turns_per_hour),
	};
}

export interface EmbeddedTurnQuotaScope {
	origin?: string;
	visitorKey: string;
	visitorTurnsPerHour: number;
	originTurnsPerHour: number;
}

/**
 * Which counters a turn consumes. Non-embedded turns have no scope. An
 * embedded turn that reaches the DO without the edge's quota payload still
 * counts per visitor by its session key, so the guard is never skipped by a
 * caller that forgets the field; only the origin counter needs the edge.
 */
export function embeddedTurnQuotaScope(
	input: Pick<StreamChatTurnInput, "sessionKey" | "embeddedQuota">,
): EmbeddedTurnQuotaScope | null {
	if (!isEmbeddedSessionKey(input.sessionKey)) return null;
	const quota = input.embeddedQuota;
	return {
		origin: quota?.origin,
		visitorKey: quota?.visitorKey ?? input.sessionKey,
		visitorTurnsPerHour:
			quota?.visitorTurnsPerHour ??
			EMBEDDED_TURN_QUOTA_DEFAULTS.visitorTurnsPerHour,
		originTurnsPerHour:
			quota?.originTurnsPerHour ??
			EMBEDDED_TURN_QUOTA_DEFAULTS.originTurnsPerHour,
	};
}

export function embeddedQuotaBucket(now: number): number {
	return Math.floor(now / EMBEDDED_TURN_QUOTA_BUCKET_MS);
}

function bucketKey(kind: "visitor" | "origin", scope: string, bucket: number) {
	return `${STORAGE_PREFIX}${kind}:${scope}:${bucket}`;
}

function bucketOf(key: string): number {
	return Number(key.slice(key.lastIndexOf(":") + 1));
}

/**
 * Count one turn against both scopes, or refuse without counting. Buckets
 * older than the previous one are deleted the first time a scope opens a new
 * bucket, so storage never grows past two hours per active scope.
 */
export async function admitEmbeddedTurn(
	storage: EmbeddedQuotaStorage,
	scope: EmbeddedTurnQuotaScope,
	now = Date.now(),
): Promise<EmbeddedTurnQuotaVerdict> {
	const bucket = embeddedQuotaBucket(now);
	const retryAfterSeconds = Math.max(
		1,
		Math.ceil(((bucket + 1) * EMBEDDED_TURN_QUOTA_BUCKET_MS - now) / 1000),
	);
	const counters: Array<{
		kind: "visitor" | "origin";
		key: string;
		count: number;
		limit: number;
	}> = [
		{
			kind: "visitor",
			key: bucketKey("visitor", scope.visitorKey, bucket),
			count: 0,
			limit: scope.visitorTurnsPerHour,
		},
		...(scope.origin
			? [
					{
						kind: "origin" as const,
						key: bucketKey("origin", scope.origin, bucket),
						count: 0,
						limit: scope.originTurnsPerHour,
					},
				]
			: []),
	];
	let opensBucket = false;
	for (const counter of counters) {
		const stored = await storage.get<number>(counter.key);
		if (stored === undefined) opensBucket = true;
		counter.count = typeof stored === "number" ? stored : 0;
	}
	for (const counter of counters) {
		if (counter.count >= counter.limit)
			return {
				ok: false,
				kind: counter.kind,
				count: counter.count,
				limit: counter.limit,
				retryAfterSeconds,
			};
	}
	for (const counter of counters)
		await storage.put(counter.key, counter.count + 1);
	if (opensBucket) {
		const stale = await storage.list<number>({ prefix: STORAGE_PREFIX });
		for (const key of stale.keys())
			if (bucketOf(key) < bucket - 1) await storage.delete(key);
	}
	return { ok: true };
}

/**
 * The refusal the widget already understands: `inference_capacity_exhausted`
 * in the error message maps to its capacity copy (`chat-errors.ts`), and the
 * retry-after rides both as a frame field and a header.
 */
export function embeddedQuotaRefusalResponse(
	verdict: Exclude<EmbeddedTurnQuotaVerdict, { ok: true }>,
): Response {
	const message =
		`inference_capacity_exhausted: embedded ${verdict.kind} turn quota reached ` +
		`(${verdict.count}/${verdict.limit} per hour); retry in ${verdict.retryAfterSeconds}s`;
	return new Response(
		`data: ${JSON.stringify({
			kind: "error",
			message,
			retryAfterSeconds: verdict.retryAfterSeconds,
		})}\n\n`,
		{
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				"X-Accel-Buffering": "no",
				"Retry-After": String(verdict.retryAfterSeconds),
			},
		},
	);
}

/**
 * The one call `streamChatTurn` makes: null admits the turn, a Response is
 * the refusal to return before any model or admission work starts.
 */
export async function refuseOverEmbeddedTurnQuota(
	storage: EmbeddedQuotaStorage,
	input: Pick<StreamChatTurnInput, "sessionKey" | "embeddedQuota">,
	tediId: string | undefined,
): Promise<Response | null> {
	const scope = embeddedTurnQuotaScope(input);
	if (!scope) return null;
	const verdict = await admitEmbeddedTurn(storage, scope);
	if (verdict.ok) return null;
	console.error(
		JSON.stringify({
			_tr: "embedded_quota",
			tediId: tediId ?? null,
			origin: scope.origin ?? null,
			kind: verdict.kind,
			count: verdict.count,
			limit: verdict.limit,
		}),
	);
	return embeddedQuotaRefusalResponse(verdict);
}
