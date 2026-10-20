const RPC_ERROR_LOG_SUMMARY_MAX_CHARS = 300;
const RPC_ERROR_LOG_MAX_DEPTH = 3;
const RPC_ERROR_LOG_MAX_ARRAY_ITEMS = 5;
const RPC_ERROR_LOG_MAX_OBJECT_KEYS = 12;
const REDACTED_LOG_VALUE = "<redacted>";

export function isPlainRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveLogKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
	return (
		normalized === "authorization" ||
		normalized === "cookie" ||
		normalized === "setcookie" ||
		normalized === "apikey" ||
		normalized === "secret" ||
		normalized === "password" ||
		normalized === "passwd" ||
		normalized === "pwd" ||
		normalized === "token" ||
		normalized === "credential" ||
		normalized === "credentials" ||
		normalized === "privatekey" ||
		normalized === "sessionid" ||
		normalized.endsWith("token") ||
		normalized.endsWith("secret") ||
		normalized.endsWith("password") ||
		normalized.endsWith("apikey") ||
		normalized.endsWith("credential")
	);
}

export function scrubSensitiveLogText(value: string): string {
	return value
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
		.replace(
			/\b(api[-_]?key|secret|password|passwd|pwd|access[-_]?token|refresh[-_]?token|client[-_]?secret)(["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
			`$1$2${REDACTED_LOG_VALUE}`,
		)
		.replace(
			/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
			"<redacted.jwt>",
		);
}

function truncateLogText(
	value: string,
	maxLength = RPC_ERROR_LOG_SUMMARY_MAX_CHARS,
): { value: string; truncated: boolean } {
	if (value.length <= maxLength) return { value, truncated: false };
	return {
		value: `${value.slice(0, Math.max(0, maxLength - 3))}...`,
		truncated: true,
	};
}

export function redactLogValue(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return scrubSensitiveLogText(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) {
		if (depth >= RPC_ERROR_LOG_MAX_DEPTH) {
			return `[array:${value.length}]`;
		}
		const items = value
			.slice(0, RPC_ERROR_LOG_MAX_ARRAY_ITEMS)
			.map((item) => redactLogValue(item, depth + 1));
		if (value.length > RPC_ERROR_LOG_MAX_ARRAY_ITEMS) {
			items.push(
				`... ${value.length - RPC_ERROR_LOG_MAX_ARRAY_ITEMS} more item(s)`,
			);
		}
		return items;
	}
	if (typeof value !== "object") return String(value);

	const record = value as Record<string, unknown>;
	const entries = Object.entries(record);
	if (depth >= RPC_ERROR_LOG_MAX_DEPTH) {
		return `[object:${entries.length} key(s)]`;
	}

	const redacted: Record<string, unknown> = {};
	for (const [key, entryValue] of entries.slice(
		0,
		RPC_ERROR_LOG_MAX_OBJECT_KEYS,
	)) {
		redacted[key] = isSensitiveLogKey(key)
			? REDACTED_LOG_VALUE
			: redactLogValue(entryValue, depth + 1);
	}
	if (entries.length > RPC_ERROR_LOG_MAX_OBJECT_KEYS) {
		redacted._truncatedKeys = entries.length - RPC_ERROR_LOG_MAX_OBJECT_KEYS;
	}
	return redacted;
}

export function summarizeRpcErrorResponse(data: unknown): {
	type: string;
	summary: string;
	truncated: boolean;
} {
	const type = Array.isArray(data)
		? "array"
		: data === null
			? "null"
			: typeof data;
	try {
		const redacted = redactLogValue(data);
		const serialized =
			typeof redacted === "string" ? redacted : JSON.stringify(redacted);
		const summary = truncateLogText(serialized ?? "");
		return { type, summary: summary.value, truncated: summary.truncated };
	} catch {
		return {
			type,
			summary: "[unserializable error response]",
			truncated: false,
		};
	}
}
