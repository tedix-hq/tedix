/**
 * R2 SQL (Cloudflare R2 Data Catalog / Apache Iceberg) Query Client
 *
 * Read path for tool-call PAYLOADS (input args + output bodies) that are too
 * large/contextual to live in Analytics Engine. Payloads are written by a
 * Cloudflare Pipeline into an Iceberg table managed by R2 Data Catalog and
 * queried back here via the R2 SQL HTTP API.
 *
 * AE (apps/api/src/lib/analytics-engine.ts) remains the source of truth for
 * aggregate METRICS (counts, latency, success rate). This module is the
 * complementary drill-down for the actual request/response bodies of a single
 * tool call, correlated by traceId or executionId.
 *
 * GATED: every read returns [] when R2 SQL is not configured (local dev / envs
 * without the warehouse + token), mirroring the AE `hasAEConfig` pattern so the
 * OS analytics drill-down degrades gracefully instead of throwing.
 *
 * Iceberg table schema (flat columns, written by the Pipeline):
 *   traceId, executionId, appId, appSlug, organizationId, toolName, eventType,
 *   success (int 1/0), errorCode, durationMs (int), timestamp, userId, tediId,
 *   authType, inputArgs (string), inputBytes (int), outputBody (string),
 *   outputBytes (int), truncated (int 1/0)
 *
 * @see https://developers.cloudflare.com/r2-sql/query-data/ (HTTP API + auth)
 * @see https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/
 */

/** Default Iceberg table (namespace.table) holding tool-call payloads. */
const DEFAULT_R2_SQL_TABLE = "default.mcp_tool_calls";

/**
 * Resolve the R2 SQL auth token. Prefer the dedicated CF_R2_SQL_TOKEN (scoped to
 * R2 SQL + Data Catalog + R2 storage read), fall back to the account API token.
 */
function r2SqlToken(env: CloudflareEnv): string | undefined {
	return env.CF_R2_SQL_TOKEN || env.CF_ANALYTICS_TOKEN;
}

/**
 * Check if R2 SQL query env vars are configured.
 * Returns false during local dev / envs without the warehouse + token, so the
 * payload read path degrades to [] instead of erroring.
 */
export function hasR2SqlConfig(env: CloudflareEnv): boolean {
	return !!(env.R2_SQL_WAREHOUSE && r2SqlToken(env) && env.CF_ACCOUNT_ID);
}

/**
 * Cloudflare API envelope returned by the R2 SQL HTTP endpoint. The engine
 * returns rows under `result.rows`; we also tolerate a bare `result` array or a
 * top-level `rows` array to stay resilient to envelope shape changes.
 */
interface R2SqlResponse<T = Record<string, unknown>> {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string } | string>;
	messages?: unknown[];
	result?: { rows?: T[] } | T[];
	rows?: T[];
}

/**
 * Execute a SQL query against R2 SQL (R2 Data Catalog / Iceberg).
 * Returns typed rows or throws on error (mirrors queryAE).
 *
 * Endpoint:
 *   POST https://api.sql.cloudflarestorage.com/api/v1/accounts/{accountId}/r2-sql/query/{warehouse}
 *   Authorization: Bearer <CF_R2_SQL_TOKEN | CF_ANALYTICS_TOKEN>
 *   Content-Type: application/json
 *   body: { "query": "SELECT ..." }
 */
export async function queryR2Sql<T = Record<string, unknown>>(
	env: CloudflareEnv,
	sql: string,
): Promise<T[]> {
	const token = r2SqlToken(env);
	const url = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${env.CF_ACCOUNT_ID}/r2-sql/query/${env.R2_SQL_WAREHOUSE}`;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query: sql }),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`R2 SQL API error (${response.status}): ${text}`);
	}

	const json = (await response.json()) as R2SqlResponse<T>;

	if (json.success === false) {
		const detail = (json.errors ?? [])
			.map((e) => (typeof e === "string" ? e : e?.message))
			.filter(Boolean)
			.join("; ");
		throw new Error(`R2 SQL query failed: ${detail || "unknown error"}`);
	}

	return extractRows<T>(json);
}

function extractRows<T>(json: R2SqlResponse<T>): T[] {
	if (Array.isArray(json.result)) return json.result;
	if (json.result?.rows) return json.result.rows;
	if (json.rows) return json.rows;
	return [];
}

/** Row shape returned for a single tool-call payload. */
export interface ToolCallPayloadRow {
	traceId: string;
	executionId: string;
	appId: string;
	appSlug: string;
	organizationId: string;
	toolName: string;
	eventType: string;
	success: number;
	errorCode: string;
	durationMs: number;
	timestamp: string;
	userId: string;
	tediId: string;
	authType: string;
	inputArgs: string;
	inputBytes: number;
	outputBody: string;
	outputBytes: number;
	truncated: number;
}

export interface GetToolCallPayloadsOptions {
	/** REQUIRED tenant scope — payload forensics must never cross orgs. */
	organizationId: string;
	traceId?: string;
	executionId?: string;
	toolName?: string;
	limit?: number;
}

/** Correlation ids are uuid/hex shaped — allowlist before they touch SQL. */
const SQL_ID_RE = /^[0-9a-zA-Z_-]{8,64}$/;
/** Tool names follow the verb_object MCP convention (plus provider prefixes). */
const SQL_TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Query tool-call payloads from the Iceberg table by traceId or executionId,
 * with an optional toolName filter, newest first.
 *
 * Returns [] when R2 SQL is not configured. The SELECT lists explicit columns
 * (R2 SQL supports SELECT/WHERE/ORDER BY/LIMIT; no OFFSET) and uses escapeSql to
 * defend against injection in the correlation identifiers.
 */
export async function getToolCallPayloadsFromR2(
	env: CloudflareEnv,
	options: GetToolCallPayloadsOptions,
): Promise<ToolCallPayloadRow[]> {
	if (!hasR2SqlConfig(env)) return [];

	const limit = clampLimit(options.limit ?? 20);
	const sql = buildToolCallPayloadsQuery(
		env.R2_SQL_TABLE || DEFAULT_R2_SQL_TABLE,
		options,
		limit,
	);

	const rows = await queryR2Sql<Partial<ToolCallPayloadRow>>(env, sql);
	return rows.map(normalizeRow);
}

/**
 * Build the SELECT for tool-call payloads. Exported for unit testing of the
 * WHERE/ORDER/LIMIT construction and escaping without hitting the network.
 *
 * Requires at least one correlation identifier (traceId or executionId);
 * callers (the procedure) enforce this and surface BAD_REQUEST otherwise.
 */
export function buildToolCallPayloadsQuery(
	table: string,
	options: GetToolCallPayloadsOptions,
	limit: number,
): string {
	// Tenant scoping is not optional: without it any analytics:read holder
	// could read another org's tool payloads given a circulating trace id.
	if (!SQL_ID_RE.test(options.organizationId)) {
		throw new Error("Invalid organizationId for payload query");
	}
	const wheres: string[] = [
		`organizationId = '${escapeSql(options.organizationId)}'`,
	];

	if (options.traceId) {
		if (!SQL_ID_RE.test(options.traceId)) {
			throw new Error("Invalid traceId for payload query");
		}
		wheres.push(`traceId = '${escapeSql(options.traceId)}'`);
	} else if (options.executionId) {
		if (!SQL_ID_RE.test(options.executionId)) {
			throw new Error("Invalid executionId for payload query");
		}
		wheres.push(`executionId = '${escapeSql(options.executionId)}'`);
	}

	if (options.toolName) {
		if (!SQL_TOOL_NAME_RE.test(options.toolName)) {
			throw new Error("Invalid toolName for payload query");
		}
		wheres.push(`toolName = '${escapeSql(options.toolName)}'`);
	}

	const whereClause = `WHERE ${wheres.join(" AND ")}`;

	return `SELECT
		traceId, executionId, appId, appSlug, organizationId, toolName, eventType,
		success, errorCode, durationMs, timestamp, userId, tediId, authType,
		inputArgs, inputBytes, outputBody, outputBytes, truncated
	FROM ${table}
	${whereClause}
	ORDER BY timestamp DESC
	LIMIT ${clampLimit(limit)}`;
}

// =============================================================================
// Helpers
// =============================================================================

/** Clamp the row limit to a sane bound (1..50). */
function clampLimit(limit: number): number {
	if (!Number.isFinite(limit)) return 20;
	return Math.min(50, Math.max(1, Math.floor(limit)));
}

/**
 * Coerce a partial row into the typed payload shape, defaulting missing/null
 * fields so downstream consumers and the Zod schema get stable types.
 */
function normalizeRow(row: Partial<ToolCallPayloadRow>): ToolCallPayloadRow {
	return {
		traceId: str(row.traceId),
		executionId: str(row.executionId),
		appId: str(row.appId),
		appSlug: str(row.appSlug),
		organizationId: str(row.organizationId),
		toolName: str(row.toolName),
		eventType: str(row.eventType),
		success: num(row.success),
		errorCode: str(row.errorCode),
		durationMs: num(row.durationMs),
		timestamp: str(row.timestamp),
		userId: str(row.userId),
		tediId: str(row.tediId),
		authType: str(row.authType),
		inputArgs: str(row.inputArgs),
		inputBytes: num(row.inputBytes),
		outputBody: str(row.outputBody),
		outputBytes: num(row.outputBytes),
		truncated: num(row.truncated),
	};
}

function str(value: unknown): string {
	return value == null ? "" : String(value);
}

function num(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/**
 * SQL string escaping for R2 SQL string literals: standard-SQL '' doubling
 * (DataFusion-lineage engines treat backslash as a literal character, so the
 * previous MySQL-style \' escape was wrong). Defense-in-depth behind the
 * SQL_ID_RE / SQL_TOOL_NAME_RE allowlists, which reject quotes outright.
 */
export function escapeSql(value: string): string {
	return value.replace(/'/g, "''");
}
