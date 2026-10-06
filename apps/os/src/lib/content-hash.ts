/**
 * Revision integrity hashing for workshop content bodies.
 *
 * The hash is a client-side integrity/dedupe aid, not an authority: the OS
 * shows it beside a revision and skips a save whose canonical body equals the
 * one already persisted. Canonicalization sorts object keys recursively so
 * semantically-equal bodies hash identically regardless of construction order.
 */

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value as JsonValue));
}

function sortValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const sorted: { [key: string]: JsonValue } = {};
		for (const key of Object.keys(value).sort()) {
			const entry = value[key];
			// JSON.stringify drops undefined properties; mirror that here so the
			// canonical form matches what a round-trip through JSON would produce.
			if (entry !== undefined) sorted[key] = sortValue(entry);
		}
		return sorted;
	}
	return value;
}

export async function contentHash(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalJson(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Short display form for integrity chips. */
export function shortHash(hash: string): string {
	return hash.slice(0, 12);
}
