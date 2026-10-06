/**
 * The per-tab browser reporter: dedupe, cap, then build.
 *
 * A frontend fault is rarely singular — one broken render loops, one failing
 * poll retries every few seconds — so an uncapped reporter turns a single
 * defect into an outbound request storm from every affected tab. Both limits
 * live here rather than at the sink, because the cheapest report is the one
 * that is never sent.
 */
import {
	MAX_STRING_CHARS,
	type OsErrorExceptionV1,
	serializeException,
} from "./serialize-exception";
import type {
	OsCaptureMechanism,
	OsClientErrorReportV1,
	OsErrorSeverity,
} from "./report";
import { normalizePageLocation } from "./report";

/** Reports accepted per rolling window, per tab. */
export const MAX_REPORTS_PER_WINDOW = 10;
/** Rolling window in milliseconds. */
export const REPORT_WINDOW_MS = 60_000;

/** Allowlisted context available at a capture site. */
export type OsReportOptions = Readonly<{
	severity?: OsErrorSeverity;
	handled?: boolean;
	captureMechanism?: OsCaptureMechanism;
}>;

export type OsErrorReporterOptions = Readonly<{
	sessionId?: string;
	transport(report: OsClientErrorReportV1): void | Promise<void>;
	now?: () => number;
	/** Reads the page URL at report time; the tab's own location by default. */
	pageHref?: () => string | undefined;
}>;

export type OsErrorReporter = Readonly<{
	reportIssue(site: string, caught: unknown, options?: OsReportOptions): void;
	reportSerialized(
		site: string,
		exception: OsErrorExceptionV1 | undefined,
		options?: OsReportOptions,
	): void;
}>;

/**
 * Returns the current page's origin and pathname, or `""` when there is
 * nothing safe to report.
 *
 * Shares `normalizePageLocation` with the ingest boundary rather than trimming
 * the URL here: both ends need the same grammar and only one of them should
 * define it. A failure resolves to `""` rather than throwing, because the
 * caller's catch would discard an entire report over one diagnostic field.
 */
function readPageLocation(pageHref: () => string | undefined): string {
	try {
		return normalizePageLocation(pageHref()) ?? "";
	} catch {
		return "";
	}
}

function defaultPageHref(): string | undefined {
	return typeof window === "undefined" ? undefined : window.location.href;
}

/** Creates a reporter owning one per-tab dedupe set and one rolling cap. */
export function createOsErrorReporter(
	options: OsErrorReporterOptions,
): OsErrorReporter {
	const now = options.now ?? Date.now;
	const pageHref = options.pageHref ?? defaultPageHref;
	const fingerprints = new Set<string>();
	let windowStart = 0;

	const reportSerialized: OsErrorReporter["reportSerialized"] = (
		site,
		exception,
		reportOptions,
	) => {
		try {
			const timestamp = now();
			if (timestamp - windowStart >= REPORT_WINDOW_MS) {
				windowStart = timestamp;
				fingerprints.clear();
			}
			if (fingerprints.size >= MAX_REPORTS_PER_WINDOW) return;
			const failureSite = site.slice(0, MAX_STRING_CHARS);
			// The route is deliberately absent from the fingerprint: the same
			// fault on two routes is one issue, and including it would let a
			// single navigation loop exhaust the per-tab cap.
			const fingerprint = `${failureSite}\n${exception?.type ?? ""}\n${firstStackFrame(exception?.stack)}`;
			if (fingerprints.has(fingerprint)) return;

			// Read only once the report is known to be sent, so a suppressed one
			// costs nothing.
			const pageLocation = readPageLocation(pageHref);
			const report: OsClientErrorReportV1 = {
				schemaVersion: 1,
				failureSite,
				severity: reportOptions?.severity ?? "error",
				handled: reportOptions?.handled ?? true,
				captureMechanism: reportOptions?.captureMechanism ?? "explicit",
				...(options.sessionId && { sessionId: options.sessionId }),
				...(pageLocation && {
					pageLocation: pageLocation.slice(0, MAX_STRING_CHARS),
				}),
				...(exception && { exception }),
				...((site.length > MAX_STRING_CHARS ||
					pageLocation.length > MAX_STRING_CHARS ||
					exception?.truncated) && { truncated: true }),
			};
			fingerprints.add(fingerprint);
			Promise.resolve(options.transport(report)).catch(() => {});
		} catch {
			// Observability must never change application behavior.
		}
	};

	return {
		reportSerialized,
		reportIssue(site, caught, reportOptions) {
			reportSerialized(site, serializeException(caught), reportOptions);
		},
	};
}

/** First recognizable stack frame, in either V8 (`at …`) or SpiderMonkey (`fn@…`) shape. */
export function firstStackFrame(stack: string | undefined): string {
	if (!stack) return "";
	return (
		stack
			.split("\n")
			.find((line) => {
				const trimmed = line.trimStart();
				return /^at(?:\s|$)/.test(trimmed) || /@.+:\d+:\d+\)?$/.test(trimmed);
			})
			?.trim() ?? ""
	);
}
