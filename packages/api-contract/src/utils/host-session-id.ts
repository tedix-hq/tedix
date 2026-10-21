/**
 * Native host identifiers are opaque. Devin uses word pairs and OpenCode
 * `ses_` + 12 hex + 14 base62 characters rather than UUIDs.
 */
export function isHostSessionId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 128 &&
		value === value.trim() &&
		/^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[a-z]+-[a-z]+|ses_[0-9a-f]{12}[0-9a-z]{14})$/i.test(
			value,
		)
	);
}
