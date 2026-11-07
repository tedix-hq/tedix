/** Stable JSON serialization with sorted object keys, so equal values hash equal. */
export function stableStringify(value: unknown): string {
	const ancestors: Array<{ original: object; serialized: object }> = [];
	return JSON.stringify(value, function (_key, inner: unknown) {
		while (ancestors.length && ancestors.at(-1)?.serialized !== this) {
			ancestors.pop();
		}
		if (inner && typeof inner === "object") {
			if (ancestors.some(({ original }) => original === inner)) {
				throw new TypeError("Cannot serialize cyclic governance arguments");
			}
			// Sorted copies hide the original cycle from JSON.stringify's own check.
			const serialized = Array.isArray(inner)
				? inner
				: Object.fromEntries(
						Object.keys(inner)
							.sort()
							.map((key) => [key, (inner as Record<string, unknown>)[key]]),
					);
			ancestors.push({ original: inner, serialized });
			return serialized;
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

/** Preserve JSON hashes, with a tagged structural fallback for non-JSON arguments. */
export async function hashArguments(value: unknown): Promise<string> {
	try {
		return await hashValue(value);
	} catch {
		const seen = new Map<object, number>();
		function encode(inner: unknown): unknown {
			if (inner === null) return ["null"];
			if (typeof inner !== "object") return [typeof inner, String(inner)];
			const ref = seen.get(inner);
			if (ref !== undefined) return ["ref", ref];
			seen.set(inner, seen.size);
			return [
				Array.isArray(inner) ? "array" : "object",
				Object.keys(inner)
					.sort()
					.map((key) => [key, encode((inner as Record<string, unknown>)[key])]),
			];
		}
		return hashValue(["governance-arguments-v1", encode(value)]);
	}
}
