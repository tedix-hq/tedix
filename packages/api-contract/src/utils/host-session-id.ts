/** Native host identifiers are opaque; Devin uses word pairs rather than UUIDs. */
export function isHostSessionId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 128 &&
		value === value.trim() &&
		/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[a-z]+-[a-z]+)$/i.test(
			value,
		)
	);
}
