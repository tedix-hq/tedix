import {
	createLogger,
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";

/** Diagnostic fields only. Caller input, credentials, and process output stay out. */
type TediLogFields = {
	tediId: string;
	leaseId: string;
	observation: string;
	outcome: "invalid" | "unavailable";
};

export function createTediLogger(component: string) {
	return createLogger<TediLogFields>({ component });
}

type ContentFreeException = {
	name: string;
	message: string;
	cause?: ContentFreeException;
	errors?: ContentFreeException[];
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
	"stringThrown",
	"numberThrown",
	"booleanThrown",
	"bigintThrown",
	"symbolThrown",
	"undefinedThrown",
]);

/** Preserve bounded exception topology without message, stack, or thrown data. */
export function contentFreeTediException(error: unknown): ContentFreeException {
	const redact = (exception: SerializedException): ContentFreeException => ({
		name: SAFE_EXCEPTION_TYPES.has(exception.type) ? exception.type : "Error",
		message: "Content omitted",
		...(exception.cause && { cause: redact(exception.cause) }),
		...(exception.errors && { errors: exception.errors.map(redact) }),
	});
	return redact(serializeException(error));
}
