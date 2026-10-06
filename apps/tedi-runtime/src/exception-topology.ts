import {
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";

export type ExceptionTopology = {
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

function projectException(exception: SerializedException): ExceptionTopology {
	return {
		type: SAFE_EXCEPTION_TYPES.has(exception.type)
			? exception.type
			: "UnknownThrown",
		...(exception.cause && { cause: projectException(exception.cause) }),
		...(exception.errors && {
			errors: exception.errors.map(projectException),
		}),
		...(exception.truncated && { truncated: true }),
	};
}

/** Preserve exception shape without retaining untrusted text. */
export function exceptionTopology(error: unknown): ExceptionTopology {
	return projectException(serializeException(error));
}
