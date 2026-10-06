/**
 * The OS Worker's client-error sink.
 *
 * The endpoint answers browser ingress, so it is bounded on every axis a
 * caller controls: method, content type, declared and actual body size, shape,
 * and — because logging is the only thing it does — the rate at which it is
 * willing to log. Nothing here is authorization: the router holds none, and a
 * report grants nothing.
 *
 * The sink is a structured `console.error`, which is exactly what Workers
 * observability ingests. That keeps the whole feature dependency-free and
 * queryable with the recipes already used for the rest of this Worker.
 */
import {
	normalizeOsClientErrorReport,
	type OsClientErrorReportV1,
} from "./report";
import { clipped, MAX_STRING_CHARS } from "./serialize-exception";

/**
 * Largest accepted request body. A full report is one bounded stack
 * (`MAX_STACK_CHARS`, 16 KiB) plus small scalars; 32 KiB leaves headroom for
 * JSON escaping without letting the endpoint accept an arbitrary upload.
 */
export const MAX_CLIENT_ERROR_BODY_BYTES = 32 * 1024;

/** Reports logged per isolate per window before the sink starts shedding. */
export const MAX_LOGGED_REPORTS_PER_WINDOW = 60;
/** Log-shedding window in milliseconds. */
export const LOG_WINDOW_MS = 10_000;

/** Log line prefix; stable so an observability query can select on it. */
export const CLIENT_ERROR_LOG_EVENT = "os.client-error";

/** Worker-derived context. Every field here is stamped by the origin, not claimed. */
export type OsClientErrorContext = Readonly<{
	/** Host role: a tenant slug, or "launcher" for os.tedix.dev. */
	tenant: string;
	/** Deploy provenance, so a report can be pinned to the code that produced it. */
	deployedSha: string;
	/**
	 * Diagnostic subject from the host-only product session cookie, decoded
	 * WITHOUT verification. It is a triage label and nothing may read it to
	 * make a decision — an unverified claim is still worth having in a log.
	 */
	reportedUserId?: string;
}>;

export type OsClientErrorEventV1 = Readonly<{
	event: typeof CLIENT_ERROR_LOG_EVENT;
	receivedAt: string;
	tenant: string;
	deployedSha: string;
	reportedUserId?: string;
	report: OsClientErrorReportV1;
}>;

export type OsClientErrorIngest = Readonly<{
	handle(request: Request, context: OsClientErrorContext): Promise<Response>;
}>;

function refuse(status: number, reason: string): Response {
	return new Response(`${reason}\n`, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

/**
 * Creates one ingest handler owning its own log-shed window.
 *
 * The window is per isolate rather than global on purpose: it is a spend
 * guard, not a correctness mechanism, and an isolate-local counter needs no
 * coordination, no storage, and no binding.
 */
export function createOsClientErrorIngest(
	options: {
		now?: () => number;
		sink?: (event: OsClientErrorEventV1) => void;
	} = {},
): OsClientErrorIngest {
	const now = options.now ?? Date.now;
	const sink =
		options.sink ??
		((event: OsClientErrorEventV1) => {
			console.error(CLIENT_ERROR_LOG_EVENT, event);
		});
	let windowStart = 0;
	let loggedInWindow = 0;

	return {
		async handle(request, context) {
			if (request.method !== "POST") {
				return refuse(405, "Client error reports are posted.");
			}
			if (
				!(request.headers.get("Content-Type") ?? "").includes(
					"application/json",
				)
			) {
				return refuse(415, "Client error reports are JSON.");
			}
			// Reject on the declared length first so an oversized body is refused
			// before it is buffered at all.
			const declared = Number(request.headers.get("Content-Length"));
			if (Number.isFinite(declared) && declared > MAX_CLIENT_ERROR_BODY_BYTES) {
				return refuse(413, "Client error report is too large.");
			}
			let raw: string;
			try {
				raw = await request.text();
			} catch {
				return refuse(400, "Malformed client error report.");
			}
			// A chunked body carries no Content-Length, so the real size is only
			// knowable here. UTF-16 code units over-count nothing that matters:
			// the check is a ceiling, and a byte is never more than a code unit.
			if (raw.length > MAX_CLIENT_ERROR_BODY_BYTES) {
				return refuse(413, "Client error report is too large.");
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return refuse(400, "Malformed client error report.");
			}
			const report = normalizeOsClientErrorReport(parsed);
			if (!report) return refuse(400, "Unsupported client error report.");

			const timestamp = now();
			if (timestamp - windowStart >= LOG_WINDOW_MS) {
				windowStart = timestamp;
				loggedInWindow = 0;
			}
			// Accepted-and-shed, never refused: a client told its report was
			// rejected would retry, which is the opposite of shedding.
			if (loggedInWindow < MAX_LOGGED_REPORTS_PER_WINDOW) {
				loggedInWindow += 1;
				sink({
					event: CLIENT_ERROR_LOG_EVENT,
					receivedAt: new Date(timestamp).toISOString(),
					tenant: clipped(context.tenant, MAX_STRING_CHARS).value,
					deployedSha: clipped(context.deployedSha, MAX_STRING_CHARS).value,
					...(context.reportedUserId && {
						reportedUserId: clipped(context.reportedUserId, MAX_STRING_CHARS)
							.value,
					}),
					report,
				});
			}
			return new Response(null, { status: 204 });
		},
	};
}
