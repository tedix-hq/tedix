/**
 * Deterministic JSON text: object keys sorted recursively, arrays kept in
 * order, scalars as `JSON.stringify` renders them. Used wherever a digest or
 * equality check must not depend on the insertion order of parsed keys.
 *
 * This is NOT `canonicalJson` (`lib/blueprint-digest.ts`): that one drops
 * `undefined` members, this one renders them as `JSON.stringify` would, so the
 * two produce different text for the same value. Digests persisted under one
 * must keep using it.
 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
		.join(",")}}`;
}
