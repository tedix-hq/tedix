const SQLITE_TIMESTAMP_PATTERN =
	/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

const ISO_WITHOUT_ZONE_PATTERN =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * Normalize D1/SQLite timestamps to the MCP datetime shape accepted by clients.
 */
export function toMcpDateTime(
	value: string | null | undefined,
	fallback = new Date(),
): string {
	const raw = typeof value === "string" ? value.trim() : "";
	const candidate =
		raw
			.replace(SQLITE_TIMESTAMP_PATTERN, "$1T$2Z")
			.replace(ISO_WITHOUT_ZONE_PATTERN, "$1Z") || fallback.toISOString();
	const parsed = new Date(candidate);
	return Number.isNaN(parsed.getTime())
		? fallback.toISOString()
		: parsed.toISOString();
}
