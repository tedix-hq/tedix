import {
	createLogger,
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";

type ContentFreeException = {
	name: string;
	cause?: ContentFreeException;
	errors?: ContentFreeException[];
};

type DocsLogFields = {
	siteId: string;
	failure: ContentFreeException;
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

/** Keep exception topology while excluding messages, stacks, and thrown data. */
export function contentFreeDocsException(error: unknown): ContentFreeException {
	const redact = (exception: SerializedException): ContentFreeException => ({
		name: safeExceptionNames.has(exception.type) ? exception.type : "Error",
		...(exception.cause && { cause: redact(exception.cause) }),
		...(exception.errors && { errors: exception.errors.map(redact) }),
	});
	return redact(serializeException(error));
}

export const docsLogger = createLogger<DocsLogFields>({
	component: "docs-runtime",
});
