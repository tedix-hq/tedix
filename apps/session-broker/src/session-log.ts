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

/** Preserve bounded cause structure without JWTs, provider messages or stacks. */
export function sessionExceptionTopology(error: unknown): ExceptionTopology {
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
