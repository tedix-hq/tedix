/** Stable JSON serialization with sorted object keys, so equal values hash equal. */
export function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) => {
		if (inner && typeof inner === "object" && !Array.isArray(inner)) {
			const sorted: Record<string, unknown> = {};
			for (const key of Object.keys(inner as Record<string, unknown>).sort()) {
				sorted[key] = (inner as Record<string, unknown>)[key];
			}
			return sorted;
		}
		return inner;
	});
}

/** SHA-256 hex of the stable serialization. Uses Web Crypto, which every target runtime has. */
export async function hashValue(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(stableStringify(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}
