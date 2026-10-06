import {
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";

export type ExceptionTopology = Readonly<{
	type: string;
	cause?: ExceptionTopology;
	errors?: readonly ExceptionTopology[];
	truncated?: true;
}>;

const SAFE_EXCEPTION_TYPES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
	"DOMException",
	"NullThrown",
	"FunctionThrown",
	"ObjectThrown",
	"CircularCause",
	"TruncatedCause",
	"UninspectableThrown",
]);

export function exceptionTopology(error: unknown): ExceptionTopology {
	const project = (exception: SerializedException): ExceptionTopology => ({
		type: SAFE_EXCEPTION_TYPES.has(exception.type)
			? exception.type
			: "UnknownThrown",
		...(exception.cause && { cause: project(exception.cause) }),
		...(exception.errors && {
			errors: exception.errors.map(project),
		}),
		...(exception.truncated && { truncated: true }),
	});
	return project(serializeException(error));
}
