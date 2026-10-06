/**
 * Metadata-only production logging helpers.
 *
 * Provider and validation errors can retain request bodies, prompts, tokens,
 * SQL parameters, or response payloads. Never pass those objects directly to
 * console methods. These helpers retain correlation value without retaining
 * the underlying text.
 */

import {
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";

type ExceptionTopology = {
	type: string;
	cause?: ExceptionTopology;
	errors?: ExceptionTopology[];
	truncated?: true;
};

const SAFE_EXCEPTION_TYPES = new Set([
	"Error",
	"AggregateError",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"DOMException",
	"NullThrown",
	"FunctionThrown",
	"ObjectThrown",
	"CircularCause",
	"TruncatedCause",
	"UninspectableThrown",
]);

/** Bounded cause structure for logs that must exclude all thrown text. */
export function safeExceptionTopology(error: unknown): ExceptionTopology {
	const project = (exception: SerializedException): ExceptionTopology => ({
		type: SAFE_EXCEPTION_TYPES.has(exception.type)
			? exception.type
			: "UnknownThrown",
		...(exception.cause && { cause: project(exception.cause) }),
		...(exception.errors && { errors: exception.errors.map(project) }),
		...(exception.truncated && { truncated: true }),
	});
	return project(serializeException(error));
}

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export async function safeTextMetadata(value: string) {
	const encoded = new TextEncoder().encode(value);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));

	return {
		chars: value.length,
		bytes: encoded.byteLength,
		sha256: [...digest.subarray(0, 8)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join(""),
	};
}

function safeIdentifier(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_IDENTIFIER.test(value)
		? value
		: undefined;
}

/**
 * Fixed infrastructure-failure phrases. Only a phrase from this list is ever
 * logged, so classification cannot leak dynamic content (SQL, params,
 * payloads). Grown as new failure classes appear; production 5xx metadata is
 * otherwise fully hashed and undiagnosable (e.g. a DrizzleQueryError whose D1
 * cause is invisible).
 */
const INFRA_ERROR_PHRASES = [
	"D1_ERROR",
	"D1_EXEC_ERROR",
	"D1_TYPE_ERROR",
	"D1_COLUMN_NOTFOUND",
	"Network connection lost",
	"storage caused object to be reset",
	"reset because its code was updated",
	"exceeded timeout",
	"timed out",
	"Too many API requests",
	"overloaded",
	"SQLITE_BUSY",
	"SQLITE_CONSTRAINT",
	"SQLITE_FULL",
	"internal error",
	"server error",
	"database is locked",
	"no such table",
	"no such column",
	"constraint failed",
	"malformed JSON",
	"too many SQL variables",
	"CHECK constraint failed",
	"FOREIGN KEY constraint failed",
	"UNIQUE constraint failed",
	"NOT NULL constraint failed",
] as const;

function safeErrorClass(message: unknown): string[] | undefined {
	if (typeof message !== "string") return undefined;
	const haystack = message.toLowerCase();
	const matched = INFRA_ERROR_PHRASES.filter((phrase) =>
		haystack.includes(phrase.toLowerCase()),
	);
	return matched.length > 0 ? matched : undefined;
}

// D1/Drizzle can wrap the transport failure more than once. Keep diagnostics
// bounded and allowlisted at every level; never emit SQL or bound parameters.
function safeCauseChain(
	error: Error,
): Array<Record<string, unknown>> | undefined {
	const chain: Array<Record<string, unknown>> = [];
	const seen = new Set<Error>([error]);
	let cause: unknown = error.cause;
	while (cause instanceof Error && !seen.has(cause) && chain.length < 4) {
		seen.add(cause);
		const numericCode = /\[code:\s*(\d{1,8})\]/i.exec(cause.message)?.[1];
		chain.push({
			name: safeIdentifier(cause.name) ?? "Error",
			messageClass: safeErrorClass(cause.message),
			numericCode,
			valueRedacted: true,
		});
		cause = cause.cause;
	}
	return chain.length ? chain : undefined;
}

/** Fixed failure categories only; no thrown text, query hashes, or dynamic identifiers. */
export function safeErrorClassification(error: unknown) {
	if (!(error instanceof Error)) return {};
	return {
		messageClass: safeErrorClass(error.message),
		causeChain: safeCauseChain(error)?.map(({ messageClass, numericCode }) => ({
			messageClass,
			numericCode,
		})),
	};
}

export async function safeErrorMetadata(
	error: unknown,
): Promise<Record<string, unknown>> {
	if (!(error instanceof Error)) {
		return {
			kind: typeof error,
			thrownValueRedacted: true,
		};
	}

	const detailed = error as Error & {
		cause?: unknown;
		code?: unknown;
		data?: unknown;
	};
	const cause = detailed.cause;
	const source = [detailed.data, cause].find(
		(value) => value && typeof value === "object" && "issues" in value,
	) as { issues?: unknown } | undefined;
	const fieldPaths = Array.isArray(source?.issues)
		? source.issues.slice(0, 20).flatMap((issue) => {
				const path = (issue as { path?: unknown })?.path;
				if (!Array.isArray(path)) return [];
				return [
					path
						.map((part) =>
							typeof part === "number" ? "[]" : (safeIdentifier(part) ?? "*"),
						)
						.join(".")
						.replace(".[]", "[]"),
				];
			})
		: [];

	return {
		name: safeIdentifier(error.name) ?? "Error",
		causeChain: safeCauseChain(error),
		code: safeIdentifier(detailed.code),
		message: await safeTextMetadata(error.message),
		messageClass: safeErrorClass(error.message),
		fieldPaths: fieldPaths.length > 0 ? fieldPaths : undefined,
		cause:
			cause instanceof Error
				? {
						name: safeIdentifier(cause.name) ?? "Error",
						code: safeIdentifier((cause as { code?: unknown }).code),
						messageClass: safeErrorClass(cause.message),
						valueRedacted: true,
					}
				: cause === undefined
					? undefined
					: { kind: typeof cause, valueRedacted: true },
	};
}
