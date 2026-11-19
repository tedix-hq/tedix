export const APP_RUNTIME_CALL_METHOD = "tedix/call";
export const APP_RUNTIME_EXPORT_METHOD = "tedix/export";
export const APP_RUNTIME_EXPORT_RESULT_METHOD = "tedix/export-result";
export const APP_RUNTIME_OUTPUTS_CHANGED_METHOD = "tedix/outputs-changed";
export const APP_RUNTIME_TRANSLATE_TEXT_METHOD = "tedix/translate-text";
export const APP_RUNTIME_TRANSLATION_METHOD = "tedix/translation";
export const APP_RUNTIME_LANGUAGE_METHOD = "tedix/language";

export interface AppRuntimeOutputRevision {
	slot: string;
	outputId: string;
	revisionId: string;
	revision: number;
}

export type AppRuntimeHostError =
	| "not_permitted"
	| "unknown_method"
	| "bad_arguments"
	| "slot_unbound"
	| "revision_conflict"
	| "too_large"
	| "host_unavailable";

export type AppRuntimeHostResult =
	| { ok: true; value: unknown }
	| { ok: false; error: AppRuntimeHostError; detail?: string };

/** A running app tells the host about a failure in its page. */
export const APP_RUNTIME_ERROR_METHOD = "tedix/error";
/** The host keeps this many of an app's most recent errors. */
export const APP_RUNTIME_MAX_ERRORS = 20;
/** One error message is cut to this many bytes of UTF-8 (2 KB). */
export const APP_RUNTIME_MAX_ERROR_BYTES = 2048;
/** One loaded app page may report this many errors; the rest are dropped. */
export const APP_RUNTIME_MAX_ERROR_REPORTS = 200;

export type AppRuntimeErrorKind = "error" | "rejection" | "console";

export interface AppRuntimeError {
	/** An uncaught error, an unhandled promise rejection or `console.error`. */
	kind: AppRuntimeErrorKind;
	message: string;
	/** The line of `client.js`, when the browser reported one. */
	line?: number;
}

/** What an app reported while running: how many, and the most recent ones. */
export interface AppRuntimeErrorLog {
	total: number;
	recent: readonly AppRuntimeError[];
}

export const EMPTY_APP_RUNTIME_ERROR_LOG: AppRuntimeErrorLog = {
	total: 0,
	recent: [],
};

function cutToBytes(text: string, bytes: number): string {
	const encoded = new TextEncoder().encode(text);
	if (encoded.length <= bytes) return text;
	// A character cut in half decodes to U+FFFD; drop it.
	return `${new TextDecoder()
		.decode(encoded.slice(0, bytes - 3))
		.replace(/�+$/, "")}…`;
}

/**
 * One error as the app's page sent it. The page is not trusted: anything
 * that is not a known kind with a text message is dropped, and the message
 * is cut to size here whatever the page did.
 */
export function readAppRuntimeError(params: unknown): AppRuntimeError | null {
	if (!params || typeof params !== "object") return null;
	const { kind, message, line } = params as Record<string, unknown>;
	if (kind !== "error" && kind !== "rejection" && kind !== "console")
		return null;
	if (typeof message !== "string") return null;
	// Control characters would let a message fake its own layout.
	const text = message
		// oxlint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.trim();
	if (!text) return null;
	return {
		kind,
		message: cutToBytes(text, APP_RUNTIME_MAX_ERROR_BYTES),
		...(typeof line === "number" &&
		Number.isInteger(line) &&
		line > 0 &&
		line < 1_000_000
			? { line }
			: {}),
	};
}

/** Adds one error, keeping the count and only the most recent ones. */
export function addAppRuntimeError(
	log: AppRuntimeErrorLog,
	error: AppRuntimeError,
): AppRuntimeErrorLog {
	return {
		total: log.total + 1,
		recent: [...log.recent, error].slice(-APP_RUNTIME_MAX_ERRORS),
	};
}
