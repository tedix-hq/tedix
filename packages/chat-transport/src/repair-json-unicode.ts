/** Repair JSON argument strings at dispatch without rewriting durable history. */
export function repairJsonUnicode<T>(value: T): T {
	if (typeof value === "string")
		return value.replace(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
			"\uFFFD",
		) as T;
	if (Array.isArray(value)) return value.map(repairJsonUnicode) as T;
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				repairJsonUnicode(key),
				repairJsonUnicode(entry),
			]),
		) as T;
	return value;
}
