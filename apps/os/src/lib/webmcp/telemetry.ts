import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * The WebMCP client-telemetry contract and its trust-boundary normalizer.
 *
 * Native WebMCP tools execute entirely in the browser, so their invocation
 * telemetry (tool name, scope key, outcome class, duration — NEVER arguments,
 * results, or user content) has to be shipped to the Worker to become
 * queryable. The producer (`telemetry-client.ts`) and the consumer
 * (`telemetry-ingest.ts`) share this module deliberately, exactly like the
 * client-error report contract: the ingest endpoint carries no credential a
 * browser could not also present, so any client can claim any shape, and
 * nothing downstream may trust a field it did not rebuild here.
 */

/**
 * Same-origin ingest path. Deliberately outside `/api/` — that prefix is the
 * authenticated proxy into `apps/api`, and this endpoint is answered by the OS
 * Worker itself.
 */
export const WEBMCP_TELEMETRY_PATH = "/webmcp/telemetry";

/** Log line prefix; stable so an observability query can select on it. */
export const WEBMCP_CLIENT_LOG_EVENT = "webmcp.client";

/** Events buffered client-side before an immediate flush; also the ingest cap. */
export const MAX_TELEMETRY_BATCH_EVENTS = 20;

/**
 * Largest accepted request body. A full batch is 20 events of four bounded
 * scalars each (~10 KiB worst case at the string caps); 16 KiB leaves headroom
 * for JSON framing without accepting an arbitrary upload.
 */
export const MAX_TELEMETRY_BODY_BYTES = 16 * 1024;

/** Client flush cadence: at most one beacon per interval per tab. */
export const TELEMETRY_FLUSH_INTERVAL_MS = 15_000;

/** Tool and scope names are caller-controlled strings; bound them. */
export const MAX_TELEMETRY_NAME_CHARS = 128;

/** Durations above this are clock nonsense, not slow tools. */
const MAX_TELEMETRY_DURATION_MS = 600_000;

export type WebMcpTelemetryOutcome = "ok" | "error" | "context_unavailable";

/**
 * One bounded invocation record. No other field survives normalization.
 *
 * `invocationId` is the per-invocation correlation UUID the webmcp-core
 * registry mints (`WebMcpInvocationEvent.invocationId`); it is what joins a
 * telemetry event to the os-audit rows and Analytics Engine datapoints the
 * same invocation produced. OPTIONAL by design: schemaVersion stays 1 because
 * an already-deployed client legitimately omits the field and a new optional
 * field breaks no v1 consumer — a version bump would refuse those clients'
 * batches for no gain. A malformed value is dropped (the event survives
 * without it), never stored.
 */
export type WebMcpTelemetryEventV1 = Readonly<{
	tool: string;
	scope: string;
	outcome: WebMcpTelemetryOutcome;
	durationMs: number;
	invocationId?: string;
}>;

export type WebMcpTelemetryBatchV1 = Readonly<{
	schemaVersion: 1;
	events: readonly WebMcpTelemetryEventV1[];
}>;

const outcomes: ReadonlySet<WebMcpTelemetryOutcome> =
	new Set<WebMcpTelemetryOutcome>(["ok", "error", "context_unavailable"]);

function ownValue(object: Record<string, unknown>, key: string): unknown {
	return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function boundedName(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0
		? value.slice(0, MAX_TELEMETRY_NAME_CHARS)
		: undefined;
}

/** Exact UUID shape or nothing: the id is caller-claimed and only correlates. */
const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizedInvocationId(value: unknown): string | undefined {
	return typeof value === "string" && UUID_PATTERN.test(value)
		? value.toLowerCase()
		: undefined;
}

/** Rebuilds one event from untrusted input, or drops it. */
function normalizeEvent(value: unknown): WebMcpTelemetryEventV1 | undefined {
	if (!isRecord(value)) return undefined;
	const tool = boundedName(ownValue(value, "tool"));
	const scope = boundedName(ownValue(value, "scope"));
	const outcome = ownValue(value, "outcome");
	const durationMs = ownValue(value, "durationMs");
	if (!tool || !scope) return undefined;
	if (typeof outcome !== "string" || !outcomes.has(outcome as never)) {
		return undefined;
	}
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
		return undefined;
	}
	const invocationId = normalizedInvocationId(ownValue(value, "invocationId"));
	return {
		tool,
		scope,
		outcome: outcome as WebMcpTelemetryOutcome,
		durationMs: Math.min(
			Math.max(0, Math.round(durationMs)),
			MAX_TELEMETRY_DURATION_MS,
		),
		...(invocationId !== undefined && { invocationId }),
	};
}

/**
 * Normalizes an untrusted batch into fresh, bounded, allowlisted events.
 * Returns `null` when the envelope itself is not a v1 batch (wrong version,
 * events not an array, or more events than a conforming client can send);
 * a malformed individual event is dropped without losing its siblings.
 */
export function normalizeWebMcpTelemetryBatch(
	input: unknown,
): WebMcpTelemetryEventV1[] | null {
	try {
		if (!isRecord(input) || ownValue(input, "schemaVersion") !== 1) return null;
		const events = ownValue(input, "events");
		if (!Array.isArray(events) || events.length > MAX_TELEMETRY_BATCH_EVENTS) {
			return null;
		}
		const normalized: WebMcpTelemetryEventV1[] = [];
		for (const event of events) {
			const rebuilt = normalizeEvent(event);
			if (rebuilt) normalized.push(rebuilt);
		}
		return normalized;
	} catch {
		return null;
	}
}
