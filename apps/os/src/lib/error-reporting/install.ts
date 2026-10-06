/**
 * The Tedix OS tab's single error reporter and its global capture sites.
 *
 * Before this module existed, apps/os had no frontend error reporting at all:
 * `os-route-boundaries.tsx` called `console.error` and every client-side
 * regression was discovered only when a person reproduced it. The reports now
 * land in the OS Worker's structured logs, which is what Workers observability
 * already consumes — no vendor SDK and no new dependency.
 */
import {
	createOsErrorReporter,
	type OsErrorReporter,
	type OsReportOptions,
} from "./browser-reporter";
import { OS_CLIENT_ERROR_PATH, type OsClientErrorReportV1 } from "./report";
import { MAX_STRING_CHARS } from "./serialize-exception";

const SESSION_ID_KEY = "tedix-os.client-error.session.v1";

function createSessionId(): string {
	try {
		const uuid = globalThis.crypto?.randomUUID?.();
		if (uuid) return uuid;
	} catch {
		// Diagnostic correlation only, so a non-cryptographic fallback is fine.
	}
	return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function resolveSessionId(): string {
	try {
		const existing = window.sessionStorage.getItem(SESSION_ID_KEY);
		if (existing && existing.length <= MAX_STRING_CHARS) return existing;
		const created = createSessionId();
		window.sessionStorage.setItem(SESSION_ID_KEY, created);
		return created;
	} catch {
		return createSessionId();
	}
}

/**
 * Posts one report same-origin.
 *
 * `keepalive` keeps a report captured during unload in flight, which is
 * exactly when a fatal render failure tends to be captured. `credentials:
 * "same-origin"` sends the host-only broker cookie so the Worker can stamp the
 * signed-in subject itself — the browser never claims an identity, so nothing
 * spoofable rides in the body.
 */
function postReport(report: OsClientErrorReportV1): Promise<void> {
	return fetch(OS_CLIENT_ERROR_PATH, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(report),
		credentials: "same-origin",
		keepalive: true,
	}).then(() => undefined);
}

let reporter: OsErrorReporter | null = null;

/** Reports an unexpected OS failure without affecting the user-facing operation. */
export function reportOsIssue(
	site: string,
	caught: unknown,
	options?: OsReportOptions,
): void {
	reporter?.reportIssue(site, caught, options);
}

/**
 * Installs the global capture sites. Called once from the app entry, before
 * the router mounts, so a failure during first render is still reported.
 *
 * Returns a teardown so a test can install against its own window without
 * leaking listeners; the app entry ignores it.
 */
export function installOsErrorReporting(
	target: Window = window,
	transport: (
		report: OsClientErrorReportV1,
	) => void | Promise<void> = postReport,
): () => void {
	reporter = createOsErrorReporter({
		sessionId: resolveSessionId(),
		transport,
		pageHref: () => target.location.href,
	});

	const onError = (event: ErrorEvent) => {
		// A resource load failure fires `error` with no `error` property and
		// nothing to serialize; only real exceptions are reportable.
		if (event.error == null) return;
		reporter?.reportIssue("browser.window-error", event.error, {
			handled: false,
			captureMechanism: "window.error",
		});
	};
	const onRejection = (event: PromiseRejectionEvent) => {
		reporter?.reportIssue("browser.unhandled-rejection", event.reason, {
			handled: false,
			captureMechanism: "unhandledrejection",
		});
	};

	target.addEventListener("error", onError as EventListener);
	target.addEventListener("unhandledrejection", onRejection as EventListener);
	return () => {
		target.removeEventListener("error", onError as EventListener);
		target.removeEventListener(
			"unhandledrejection",
			onRejection as EventListener,
		);
		reporter = null;
	};
}
