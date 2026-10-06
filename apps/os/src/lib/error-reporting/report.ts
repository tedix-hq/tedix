/**
 * The client-error report contract and its trust-boundary normalizer.
 *
 * The producer (`browser-reporter.ts`) and the consumer (`ingest.ts`) share
 * this module deliberately: the ingest endpoint carries no credential a
 * browser could not also present, so any client can claim any shape. Nothing
 * downstream may trust a field it did not rebuild here.
 */
import {
	clipped,
	MAX_MESSAGE_CHARS,
	MAX_STACK_CHARS,
	MAX_STRING_CHARS,
	type OsErrorExceptionV1,
	serializeException,
} from "./serialize-exception";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * Same-origin ingest path. Deliberately outside `/api/` — that prefix is the
 * authenticated proxy into `apps/api`, and this endpoint is answered by the OS
 * Worker itself.
 */
export const OS_CLIENT_ERROR_PATH = "/client-errors";

/** How a browser failure was captured; keeps the source distinguishable in logs. */
export type OsCaptureMechanism =
	| "window.error"
	| "unhandledrejection"
	| "react"
	| "explicit";

export type OsErrorSeverity = "warning" | "error" | "fatal";

/**
 * An untrusted, bounded browser failure report. No field in this report
 * conveys authority: the Worker re-derives every decision it makes.
 */
export type OsClientErrorReportV1 = Readonly<{
	schemaVersion: 1;
	failureSite: string;
	severity: OsErrorSeverity;
	handled: boolean;
	captureMechanism: OsCaptureMechanism;
	/** Per-tab diagnostic correlation id; not a session credential. */
	sessionId?: string;
	/**
	 * Origin and pathname of the page where the failure was captured.
	 *
	 * Rebuilt by `normalizePageLocation`, so credentials, query and fragment
	 * are all excluded and URL-borne secrets never leave the tab — notably a
	 * share link's `#share=` fragment, which is a bearer capability.
	 */
	pageLocation?: string;
	exception?: OsErrorExceptionV1;
	truncated?: true;
}>;

const severities: ReadonlySet<OsErrorSeverity> = new Set<OsErrorSeverity>([
	"warning",
	"error",
	"fatal",
]);
const mechanisms: ReadonlySet<OsCaptureMechanism> = new Set<OsCaptureMechanism>(
	["window.error", "unhandledrejection", "react", "explicit"],
);

function ownValue(object: Record<string, unknown>, key: string): unknown {
	return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function allowlistedString<T extends string>(
	value: unknown,
	allowed: ReadonlySet<T>,
): T | undefined {
	return typeof value === "string" && allowed.has(value as T)
		? (value as T)
		: undefined;
}

/**
 * Reduces a URL to its origin and pathname, or `undefined` when it is not an
 * ordinary page URL.
 *
 * Rebuilt from the parsed URL rather than trimmed as text, because an `href`
 * retains any `user:password@` credentials, which a textual strip of the query
 * and fragment would carry through to the sink. In Tedix the fragment is worse
 * than noise: a share link's `#share=` is a live bearer capability, so
 * pathname-vs-href is the difference between logging a workspace id and
 * logging an access grant.
 *
 * Only `http(s)` survives, which is what makes the concatenation safe: every
 * other scheme either has an opaque origin that serializes to a meaningless
 * `"null"` prefix, or keeps its content in the path, as `data:` does.
 */
export function normalizePageLocation(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	return `${url.origin}${url.pathname}`;
}

function boundedString(
	value: unknown,
	maximum: number,
	mark: () => void,
): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const result = clipped(value, maximum);
	if (result.truncated) mark();
	return result.value;
}

function boundedContent(
	value: unknown,
	maximum: number,
	mark: () => void,
): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = clipped(value, maximum);
	if (result.truncated) mark();
	return result.value;
}

/**
 * Bounds a captured page location, reduced to origin and pathname.
 *
 * Normalized BEFORE bounding so a long query string cannot consume the budget
 * for the part we keep, and so a policy strip is never reported as a
 * truncation.
 */
function boundedPageLocation(
	value: unknown,
	mark: () => void,
): string | undefined {
	return boundedString(normalizePageLocation(value), MAX_STRING_CHARS, mark);
}

function normalizeException(
	value: unknown,
	mark: () => void,
): OsErrorExceptionV1 | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		const exception = serializeException(value);
		if (exception.truncated) mark();
		return exception;
	}

	let truncated = ownValue(value, "truncated") === true;
	const markException = () => {
		truncated = true;
	};
	const type =
		boundedString(ownValue(value, "type"), MAX_STRING_CHARS, markException) ??
		"Error";
	const message = boundedContent(
		ownValue(value, "message"),
		MAX_MESSAGE_CHARS,
		markException,
	);
	const stack = boundedContent(
		ownValue(value, "stack"),
		MAX_STACK_CHARS,
		markException,
	);
	if (truncated) mark();
	return {
		type,
		...(message !== undefined && { message }),
		...(stack !== undefined && { stack }),
		...(truncated && { truncated: true }),
	};
}

/**
 * Normalizes an untrusted client report into a fresh, bounded, allowlisted
 * object. Returns `null` for anything that is not a v1 report.
 */
export function normalizeOsClientErrorReport(
	input: unknown,
): OsClientErrorReportV1 | null {
	try {
		if (!isRecord(input) || ownValue(input, "schemaVersion") !== 1) return null;
		let truncated = ownValue(input, "truncated") === true;
		const mark = () => {
			truncated = true;
		};
		const handledValue = ownValue(input, "handled");
		const exception = normalizeException(ownValue(input, "exception"), mark);
		const sessionId = boundedString(
			ownValue(input, "sessionId"),
			MAX_STRING_CHARS,
			mark,
		);
		const pageLocation = boundedPageLocation(
			ownValue(input, "pageLocation"),
			mark,
		);
		return {
			schemaVersion: 1,
			failureSite:
				boundedString(ownValue(input, "failureSite"), MAX_STRING_CHARS, mark) ??
				"browser.unknown",
			severity:
				allowlistedString(ownValue(input, "severity"), severities) ?? "error",
			handled: typeof handledValue === "boolean" ? handledValue : true,
			captureMechanism:
				allowlistedString(ownValue(input, "captureMechanism"), mechanisms) ??
				"explicit",
			...(sessionId && { sessionId }),
			...(pageLocation && { pageLocation }),
			...(exception && { exception }),
			...(truncated && { truncated: true }),
		};
	} catch {
		return null;
	}
}
