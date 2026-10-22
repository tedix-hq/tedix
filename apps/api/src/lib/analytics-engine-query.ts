interface AEQueryResult<T = Record<string, unknown>> {
	data: T[];
	rows: number;
	rows_before_limit_at_least: number;
}

/**
 * Check if AE query env vars are configured.
 * Returns false during local dev when Worker secrets aren't available.
 */
export function hasAEConfig(env: CloudflareEnv): boolean {
	return !!(
		env.CF_ACCOUNT_ID &&
		env.CF_ANALYTICS_TOKEN &&
		env.ANALYTICS_ENGINE_DATASET
	);
}

export function hasWidgetAEConfig(env: CloudflareEnv): boolean {
	return !!(
		env.CF_ACCOUNT_ID &&
		env.CF_ANALYTICS_TOKEN &&
		env.WIDGET_ANALYTICS_DATASET
	);
}

/**
 * Execute a SQL query against Analytics Engine.
 * Returns typed rows or throws on error.
 */
export async function queryAE<T = Record<string, unknown>>(
	env: CloudflareEnv,
	sql: string,
): Promise<AEQueryResult<T>> {
	const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
			"Content-Type": "text/plain",
		},
		body: sql,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`AE SQL API error (${response.status}): ${text}`);
	}

	return response.json() as Promise<AEQueryResult<T>>;
}

export function normalizeAEDatetime(value: string | undefined): string | null {
	if (!value) return null;
	const normalized = value.includes("T")
		? value
		: `${value.replace(" ", "T")}Z`;
	const timestamp = Date.parse(normalized);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * SQL string escaping for AE queries (ClickHouse dialect).
 * Prevents injection by escaping quotes and backslashes.
 */
export function escapeSql(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Convert ISO 8601 datetime to AE-compatible format.
 * AE's toDateTime() requires 'YYYY-MM-DD HH:MM:SS' — rejects millis and 'Z'.
 */
export function toAEDatetime(iso: string): string {
	return iso
		.replace("T", " ")
		.replace(/\.\d{3}Z$/, "")
		.replace(/Z$/, "");
}
