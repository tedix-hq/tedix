/**
 * Typed structured Worker logger.
 *
 * The load-bearing part of this module is not the logger — it is
 * `ReservedLogField` plus `ProhibitedFields`. Together they make a
 * caller-supplied field named `secret`, `token`, `prompt`, `headers`, or `body`
 * a **compile error** rather than a code-review convention.
 *
 * Adapted from Cloudflare OS logging primitives under Apache-2.0; see
 * `THIRD_PARTY_NOTICES.md`. The ambient-context variant is deliberately omitted
 * because it does not survive the runtime boundaries described in this package's README.
 */

/** A value Workers Logs / Logpush can represent as structured log data. */
export type LogValue =
	| string
	| number
	| boolean
	| Date
	| null
	| undefined
	| { [key: string]: LogValue }
	| LogValue[];

/** Console method used to emit the line. Workers Logs records it per entry. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Field names a caller may never supply.
 *
 * Two kinds of name live here and both must stay:
 *
 * - **Secret-bearing** (`body`, `header`, `headers`, `prompt`, `secret`,
 *   `token`) — the prohibition that is the point of this module. A request
 *   body, a header bag, a prompt, or a bearer token is exactly the payload
 *   that must never reach a durable log sink, and naming a field after one is
 *   the way it happens.
 * - **Emitter-owned** (`component`, `error`, `errorStack`, `event`, `message`)
 *   — reserved so a caller cannot shadow the fields the logger itself writes
 *   and silently corrupt the queryable shape. `component`, `event`, and
 *   `error` are re-opened at exactly the call sites that own them.
 */
export type ReservedLogField =
	| "body"
	| "component"
	| "error"
	| "errorStack"
	| "exception"
	| "event"
	| "header"
	| "headers"
	| "message"
	| "prompt"
	| "secret"
	| "token";

/** Caller fields with reserved names dropped and non-`LogValue` types poisoned. */
type SafeFields<ExtraFields extends object> = {
	[
		Key in keyof ExtraFields as Key extends ReservedLogField ? never : Key
	]: ExtraFields[Key] extends LogValue ? ExtraFields[Key] : never;
};

/**
 * The prohibition itself: every reserved name a caller declared is re-typed
 * `?: never`, so passing any value for it fails to typecheck. `Exceptions`
 * re-opens the names the emitter hands back to the caller at a given call site.
 */
type ProhibitedFields<
	ExtraFields extends object,
	Exceptions extends ReservedLogField = never,
> = {
	[
		Key in Extract<keyof ExtraFields, Exclude<ReservedLogField, Exceptions>>
	]?: never;
};

type AllowedFields<ExtraFields extends object> = SafeFields<ExtraFields> &
	ProhibitedFields<ExtraFields>;

/** Per-call fields. `event` is required; `error` is the one unknown-typed slot. */
type LogDetails<ExtraFields extends object> = Partial<SafeFields<ExtraFields>> &
	ProhibitedFields<ExtraFields, "event" | "error"> & {
		event: string;
		error?: unknown;
	};

/** Module-scoped defaults. `component` is the stable dot-separated identity. */
type LoggerDefaults<ExtraFields extends object> = Partial<
	SafeFields<ExtraFields>
> &
	ProhibitedFields<ExtraFields, "component"> & { component: string };

export type SerializedException = Readonly<{
	type: string;
	message?: string;
	stack?: string;
	cause?: SerializedException;
	errors?: readonly SerializedException[];
	truncated?: true;
}>;

const MAX_EXCEPTION_NODES = 8;
const MAX_EXCEPTION_DEPTH = 4;
const MAX_EXCEPTION_CHARS = 16_384;

function ownValue(value: object, key: string): unknown {
	try {
		return Object.getOwnPropertyDescriptor(value, key)?.value;
	} catch {
		return undefined;
	}
}

function readableString(value: object, key: string): string | undefined {
	try {
		const property = (value as Record<string, unknown>)[key];
		return typeof property === "string" ? property : undefined;
	} catch {
		return undefined;
	}
}

/** Only exception identity, message, stack and nested errors reach the log. */
export function serializeException(caught: unknown): SerializedException {
	const seen = new WeakSet<object>();
	const budget = { nodes: 0, chars: 0 };
	const clip = (value: string, maximum: number) => {
		const available = Math.max(0, MAX_EXCEPTION_CHARS - budget.chars);
		const retained = value.slice(0, Math.min(maximum, available));
		budget.chars += retained.length;
		return { value: retained, truncated: retained.length < value.length };
	};
	const visit = (value: unknown, depth: number): SerializedException => {
		if (
			depth >= MAX_EXCEPTION_DEPTH ||
			budget.nodes >= MAX_EXCEPTION_NODES ||
			budget.chars >= MAX_EXCEPTION_CHARS
		) {
			return { type: "TruncatedCause", truncated: true };
		}
		budget.nodes++;
		try {
			if (value === null) return { type: "NullThrown" };
			if (typeof value === "function") return { type: "FunctionThrown" };
			if (typeof value !== "object") {
				const message = clip(String(value), 1024);
				return {
					type: `${typeof value}Thrown`,
					message: message.value,
					...(message.truncated && { truncated: true }),
				};
			}
			if (seen.has(value)) return { type: "CircularCause", truncated: true };
			seen.add(value);
			const isError = value instanceof Error;
			const rawType = isError
				? readableString(value, "name")
				: ownValue(value, "name");
			const rawMessage = isError
				? readableString(value, "message")
				: ownValue(value, "message");
			const rawStack = isError
				? readableString(value, "stack")
				: ownValue(value, "stack");
			const type = clip(
				typeof rawType === "string" && rawType
					? rawType
					: isError
						? "Error"
						: "ObjectThrown",
				256,
			);
			const message =
				typeof rawMessage === "string" ? clip(rawMessage, 1024) : undefined;
			const stack =
				typeof rawStack === "string" ? clip(rawStack, 8192) : undefined;
			const causeValue = ownValue(value, "cause");
			const cause =
				causeValue === undefined ? undefined : visit(causeValue, depth + 1);
			const errorsValue = ownValue(value, "errors");
			const errors = Array.isArray(errorsValue)
				? errorsValue.slice(0, 4).map((nested) => visit(nested, depth + 1))
				: undefined;
			return {
				type: type.value || "TruncatedCause",
				...(message && { message: message.value }),
				...(stack && { stack: stack.value }),
				...(cause && { cause }),
				...(errors && { errors }),
				...((type.truncated ||
					message?.truncated ||
					stack?.truncated ||
					(Array.isArray(errorsValue) && errorsValue.length > 4)) && {
					truncated: true,
				}),
			};
		} catch {
			return { type: "UninspectableThrown", truncated: true };
		}
	};
	return visit(caught, 0);
}

function normalizeError(error: unknown): string {
	try {
		if (error instanceof Error) return String(error);
		if (typeof error === "object" && error !== null) {
			const message = ownValue(error, "message");
			if (typeof message === "string") return message;
		}
		return String(error);
	} catch {
		return "Uninspectable thrown value";
	}
}

/** A structured logger with immutable base fields and package-local fields. */
export interface Logger<ExtraFields extends object = Record<never, never>> {
	/** Returns a new logger with additional fields; this logger is unchanged. */
	with(
		fields: Readonly<Partial<AllowedFields<ExtraFields>>>,
	): Logger<ExtraFields>;
	/** Emits a noisy diagnostic event. */
	debug(message: string, details: Readonly<LogDetails<ExtraFields>>): void;
	/** Emits a notable lifecycle event. */
	info(message: string, details: Readonly<LogDetails<ExtraFields>>): void;
	/** Emits a failure the operation can continue past. */
	warn(message: string, details: Readonly<LogDetails<ExtraFields>>): void;
	/** Emits a failure that needs attention. */
	error(message: string, details: Readonly<LogDetails<ExtraFields>>): void;
}

class LoggerImpl<ExtraFields extends object> implements Logger<ExtraFields> {
	readonly #defaults: Readonly<LoggerDefaults<ExtraFields>>;

	constructor(defaults: Readonly<LoggerDefaults<ExtraFields>>) {
		this.#defaults = { ...defaults };
	}

	with(
		fields: Readonly<Partial<AllowedFields<ExtraFields>>>,
	): Logger<ExtraFields> {
		return new LoggerImpl<ExtraFields>({
			...this.#defaults,
			...fields,
		} as LoggerDefaults<ExtraFields>);
	}

	debug(message: string, details: Readonly<LogDetails<ExtraFields>>): void {
		this.#write("debug", message, details);
	}

	info(message: string, details: Readonly<LogDetails<ExtraFields>>): void {
		this.#write("info", message, details);
	}

	warn(message: string, details: Readonly<LogDetails<ExtraFields>>): void {
		this.#write("warn", message, details);
	}

	error(message: string, details: Readonly<LogDetails<ExtraFields>>): void {
		this.#write("error", message, details);
	}

	#write(
		level: LogLevel,
		message: string,
		details: Readonly<LogDetails<ExtraFields>>,
	): void {
		// Call details override logger defaults; `component` is fixed by the module.
		const { component } = this.#defaults;
		const fields: Record<string, unknown> = {
			...this.#defaults,
			...details,
			component,
		};
		if (details.error === undefined) {
			delete fields.error;
		} else {
			const error: unknown = details.error;
			fields.error = normalizeError(error);
			const exception = serializeException(error);
			fields.exception = exception;
			try {
				if (error instanceof Error && exception.stack)
					fields.errorStack = exception.stack;
			} catch {
				// A revoked or hostile Proxy must not interrupt error reporting.
			}
		}
		// ONE object argument, one call. Workers Logs promotes the object's own
		// keys to queryable fields, Logpush `workers_trace_events` carries it as
		// `logs[].message[0]`, and `logs[].level` already records the level — so
		// `level` is deliberately not a field here and not a reserved name.
		console[level]({ ...fields, message });
	}
}

/**
 * Creates a module-scoped structured logger.
 *
 * `component` is a stable dot-separated identity (`mcp.auth.cimd`), never
 * interpolated per request — it is the field every dashboard filters on.
 */
export function createLogger<ExtraFields extends object = Record<never, never>>(
	defaults: Readonly<LoggerDefaults<NoInfer<ExtraFields>>>,
): Logger<ExtraFields> {
	return new LoggerImpl<ExtraFields>(defaults);
}
