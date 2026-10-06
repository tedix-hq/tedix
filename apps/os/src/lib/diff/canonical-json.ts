/**
 * Canonical text for a JSON payload, used as the two sides of a proposal diff.
 *
 * Object keys are sorted. An agent that rebuilds a document object emits its
 * keys in whatever order it produced them, and a reviewer must not be shown a
 * key reordering as a change — a diff that reports noise is a diff nobody
 * reads. Arrays keep their order, which IS semantic.
 */
export function canonicalJsonText(value: unknown): string {
	// `undefined` is not JSON; render it as the absent document rather than the
	// literal string "undefined".
	return JSON.stringify(sortKeys(value), null, 2) ?? "";
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value === null || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(source).sort())
		sorted[key] = sortKeys(source[key]);
	return sorted;
}
