import {
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";

type DocsFailureEvent =
	| "docs.search_index_queue_failed"
	| "docs.build_failed"
	| "docs.build_container_failed";

type ContentFreeException = {
	name: string;
	cause?: ContentFreeException;
	errors?: ContentFreeException[];
};

const safeExceptionNames = new Set([
	"Error",
	"AggregateError",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"DOMException",
	"NullThrown",
	"ObjectThrown",
	"CircularCause",
	"TruncatedCause",
	"UninspectableThrown",
	"stringThrown",
	"numberThrown",
	"booleanThrown",
	"undefinedThrown",
]);

function contentFreeException(error: unknown): ContentFreeException {
	const redact = (exception: SerializedException): ContentFreeException => ({
		name: safeExceptionNames.has(exception.type) ? exception.type : "Error",
		...(exception.cause && { cause: redact(exception.cause) }),
		...(exception.errors && { errors: exception.errors.map(redact) }),
	});
	return redact(serializeException(error));
}

/** Preserve bounded cause topology without logging tenant or source content. */
export function logDocsFailure(event: DocsFailureEvent, error: unknown): void {
	console.error({
		component: "docs",
		event,
		exception: contentFreeException(error),
	});
}
