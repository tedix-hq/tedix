/**
 * The OS Worker's WebMCP client-telemetry sink.
 *
 * Mirrors the client-error ingest discipline exactly: the endpoint answers
 * browser ingress, so it is bounded on every axis a caller controls — method,
 * content type, declared and actual body size, shape, and, because logging is
 * the only thing it does, the rate at which it is willing to log. Nothing here
 * is authorization: the handler holds none, and a telemetry event grants
 * nothing.
 *
 * The sink is one structured `console.log` line per accepted batch, which is
 * exactly what Workers observability ingests (`invocation_logs`, head
 * sampling 1). It used to also write one Analytics Engine datapoint per event
 * through a `WEBMCP_ANALYTICS` binding; nothing in the repo ever queried
 * `tedix_webmcp_analytics_production`, so the write-only dataset was deleted
 * and the log line is the whole lane. The per-isolate rate shed governs it.
 */
import {
	MAX_TELEMETRY_BODY_BYTES,
	normalizeWebMcpTelemetryBatch,
	WEBMCP_CLIENT_LOG_EVENT,
	type WebMcpTelemetryEventV1,
} from "./telemetry";

/** Batches logged per isolate per window before the sink starts shedding. */
export const MAX_LOGGED_TELEMETRY_BATCHES_PER_WINDOW = 30;
/** Log-shedding window in milliseconds. */
export const TELEMETRY_LOG_WINDOW_MS = 10_000;

/** Names stamped by the Worker are bounded like everything else in the line. */
const MAX_CONTEXT_CHARS = 256;

/** Worker-derived context. Every field here is stamped by the origin, not claimed. */
export type WebMcpTelemetryContext = Readonly<{
	/** Host role: a tenant slug, or "launcher" for os.tedix.dev. */
	tenant: string;
	/** Deploy provenance, so a slow tool can be pinned to the code that shipped it. */
	deployedSha: string;
}>;

export type WebMcpTelemetryLogEventV1 = Readonly<{
	event: typeof WEBMCP_CLIENT_LOG_EVENT;
	receivedAt: string;
	tenant: string;
	deployedSha: string;
	events: readonly WebMcpTelemetryEventV1[];
}>;

export type WebMcpTelemetryIngest = Readonly<{
	handle(request: Request, context: WebMcpTelemetryContext): Promise<Response>;
}>;

function refuse(status: number, reason: string): Response {
	return new Response(`${reason}\n`, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

/**
 * Creates one ingest handler owning its own log-shed window. Per isolate
 * rather than global on purpose: it is a spend guard, not a correctness
 * mechanism, and an isolate-local counter needs no coordination, no storage,
 * and no binding.
 */
export function createWebMcpTelemetryIngest(
	options: {
		now?: () => number;
		sink?: (event: WebMcpTelemetryLogEventV1) => void;
	} = {},
): WebMcpTelemetryIngest {
	const now = options.now ?? Date.now;
	const sink =
		options.sink ??
		((event: WebMcpTelemetryLogEventV1) => {
			console.log(WEBMCP_CLIENT_LOG_EVENT, event);
		});
	let windowStart = 0;
	let loggedInWindow = 0;

	return {
		async handle(request, context) {
			if (request.method !== "POST") {
				return refuse(405, "WebMCP telemetry is posted.");
			}
			if (
				!(request.headers.get("Content-Type") ?? "").includes(
					"application/json",
				)
			) {
				return refuse(415, "WebMCP telemetry is JSON.");
			}
			// Reject on the declared length first so an oversized body is refused
			// before it is buffered at all.
			const declared = Number(request.headers.get("Content-Length"));
			if (Number.isFinite(declared) && declared > MAX_TELEMETRY_BODY_BYTES) {
				return refuse(413, "WebMCP telemetry batch is too large.");
			}
			let raw: string;
			try {
				raw = await request.text();
			} catch {
				return refuse(400, "Malformed WebMCP telemetry batch.");
			}
			// A chunked body carries no Content-Length; UTF-16 code units
			// over-count nothing that matters — the check is a ceiling.
			if (raw.length > MAX_TELEMETRY_BODY_BYTES) {
				return refuse(413, "WebMCP telemetry batch is too large.");
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return refuse(400, "Malformed WebMCP telemetry batch.");
			}
			const events = normalizeWebMcpTelemetryBatch(parsed);
			if (!events) return refuse(400, "Unsupported WebMCP telemetry batch.");

			const timestamp = now();
			if (timestamp - windowStart >= TELEMETRY_LOG_WINDOW_MS) {
				windowStart = timestamp;
				loggedInWindow = 0;
			}
			// Accepted-and-shed, never refused: a client told its batch was
			// rejected would retry, which is the opposite of shedding. An empty
			// normalized batch is accepted without spending a log line.
			if (
				events.length > 0 &&
				loggedInWindow < MAX_LOGGED_TELEMETRY_BATCHES_PER_WINDOW
			) {
				loggedInWindow += 1;
				sink({
					event: WEBMCP_CLIENT_LOG_EVENT,
					receivedAt: new Date(timestamp).toISOString(),
					tenant: context.tenant.slice(0, MAX_CONTEXT_CHARS),
					deployedSha: context.deployedSha.slice(0, MAX_CONTEXT_CHARS),
					events,
				});
			}
			return new Response(null, { status: 204 });
		},
	};
}
