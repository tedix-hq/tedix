/**
 * The per-tab WebMCP telemetry batcher and its one-time observer install.
 *
 * The webmcp-core registry exposes an optional invocation observer; this
 * module is the OS host's implementation. Events buffer per tab and ship as a
 * BOUNDED beacon: a flush happens when the buffer reaches the batch cap, at
 * most once per interval otherwise, and on pagehide so a closing tab does not
 * lose its tail. Telemetry is observability, never behavior: every path here
 * is wrapped so a failure can only lose an event, not affect a tool.
 */
import {
	setWebMcpInvocationObserver,
	type WebMcpInvocationEvent,
} from "@tedix/webmcp-core/registry";
import {
	MAX_TELEMETRY_BATCH_EVENTS,
	TELEMETRY_FLUSH_INTERVAL_MS,
	WEBMCP_TELEMETRY_PATH,
	type WebMcpTelemetryBatchV1,
	type WebMcpTelemetryEventV1,
} from "./telemetry";

export type WebMcpTelemetryTransport = (body: string) => void;

export type WebMcpTelemetryBatcher = Readonly<{
	record(event: WebMcpInvocationEvent): void;
	flush(): void;
}>;

/**
 * Ships one serialized batch same-origin. `sendBeacon` survives pagehide and
 * is the preferred lane; the `keepalive` fetch is the fallback where the
 * beacon API is missing or refuses the payload. Fire-and-forget on purpose:
 * a lost batch is cheaper than a retry loop.
 */
function defaultTransport(body: string): void {
	try {
		const sent = navigator.sendBeacon?.(
			WEBMCP_TELEMETRY_PATH,
			new Blob([body], { type: "application/json" }),
		);
		if (sent) return;
	} catch {
		// Fall through to fetch.
	}
	try {
		void fetch(WEBMCP_TELEMETRY_PATH, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			credentials: "same-origin",
			keepalive: true,
		}).catch(() => {});
	} catch {
		// Observability must never change application behavior.
	}
}

/** Creates one batcher owning its buffer and lazily armed flush timer. */
export function createWebMcpTelemetryBatcher(
	transport: WebMcpTelemetryTransport = defaultTransport,
): WebMcpTelemetryBatcher {
	let buffer: WebMcpTelemetryEventV1[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;

	const flush = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (buffer.length === 0) return;
		const batch: WebMcpTelemetryBatchV1 = {
			schemaVersion: 1,
			events: buffer,
		};
		buffer = [];
		try {
			transport(JSON.stringify(batch));
		} catch {
			// A lost batch is acceptable; a thrown one is not.
		}
	};

	return {
		flush,
		record(event) {
			buffer.push({
				tool: event.tool,
				scope: event.scope,
				outcome: event.outcome,
				durationMs: event.durationMs,
				invocationId: event.invocationId,
			});
			if (buffer.length >= MAX_TELEMETRY_BATCH_EVENTS) {
				flush();
				return;
			}
			// Lazy timer: an idle tab with no invocations runs nothing.
			timer ??= setTimeout(flush, TELEMETRY_FLUSH_INTERVAL_MS);
		},
	};
}

let teardown: (() => void) | null = null;

/**
 * Installs the invocation observer once per tab. Module-singleton like the
 * error reporter: the document has one agent surface and needs one batcher.
 * Inert outside a browser, so node-environment suites importing host
 * components stay clean.
 */
export function installWebMcpTelemetry(
	transport: WebMcpTelemetryTransport = defaultTransport,
): void {
	if (teardown || typeof window === "undefined") return;
	const batcher = createWebMcpTelemetryBatcher(transport);
	setWebMcpInvocationObserver((event) => batcher.record(event));
	const onPagehide = (): void => batcher.flush();
	window.addEventListener("pagehide", onPagehide);
	teardown = () => {
		window.removeEventListener("pagehide", onPagehide);
		setWebMcpInvocationObserver(null);
		teardown = null;
	};
}

/** Uninstalls the singleton so a test can install against its own transport. */
/** @internal */
export function resetWebMcpTelemetryForTests(): void {
	teardown?.();
}
