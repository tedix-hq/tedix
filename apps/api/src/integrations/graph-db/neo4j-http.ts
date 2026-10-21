import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { GraphDbConfig } from "./types";

export interface HttpClient {
	endpoint: string;
	headers: Record<string, string>;
	database: string;
}

interface QueryApiError {
	code?: string;
	message?: string;
	gqlStatus?: string;
	statusDescription?: string;
}

function queryApiErrorMessage(value: unknown): string {
	if (!isRecord(value)) return String(value);
	const error = value as QueryApiError;
	const code =
		typeof error.code === "string"
			? error.code
			: typeof error.gqlStatus === "string"
				? error.gqlStatus
				: undefined;
	const message =
		typeof error.message === "string"
			? error.message
			: typeof error.statusDescription === "string"
				? error.statusDescription
				: undefined;
	return [code, message].filter(Boolean).join(": ") || "unknown query error";
}

/**
 * Convert Neo4j connection URI to HTTPS endpoint for Query API.
 * neo4j+s://xxx.databases.neo4j.io → https://xxx.databases.neo4j.io
 * bolt+s://xxx → https://xxx
 * https://xxx → https://xxx (passthrough)
 */
export function createHttpClient(config: GraphDbConfig): HttpClient {
	let baseUrl = config.uri;
	baseUrl = baseUrl.replace(/^neo4j\+s:\/\//, "https://");
	baseUrl = baseUrl.replace(/^neo4j\+ssc:\/\//, "https://");
	baseUrl = baseUrl.replace(/^neo4j:\/\//, "http://");
	baseUrl = baseUrl.replace(/^bolt\+s:\/\//, "https://");
	baseUrl = baseUrl.replace(/^bolt:\/\//, "http://");

	const database = config.database ?? "neo4j";
	const endpoint = `${baseUrl}/db/${database}/query/v2`;

	const credentials = btoa(`${config.user}:${config.password}`);
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Basic ${credentials}`,
	};

	return { endpoint, headers, database };
}

/**
 * Run a Cypher query via the Neo4j HTTP Query API.
 * Returns rows as Record<string, unknown>[] mapped from fields+values.
 */
export async function runQuery(
	http: HttpClient,
	cypher: string,
	params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
	// Convert undefined values to null — JSON.stringify strips undefined keys,
	// but Neo4j Query API expects all referenced $params to be present.
	const sanitizedParams: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		sanitizedParams[key] = value === undefined ? null : value;
	}

	const body = JSON.stringify({
		statement: cypher,
		parameters: sanitizedParams,
	});

	const res = await fetch(http.endpoint, {
		method: "POST",
		headers: http.headers,
		body,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`Neo4j Query API ${res.status}: ${text}`);
	}

	let json: unknown;
	try {
		json = await res.json();
	} catch {
		throw new Error("Neo4j Query API returned invalid JSON");
	}
	if (!isRecord(json)) {
		throw new Error("Neo4j Query API returned a malformed response");
	}

	// Query API v2 reports Cypher failures in a 202 response body, so inspect
	// errors before attempting to read data.
	if (Array.isArray(json.errors) && json.errors.length > 0) {
		throw new Error(
			`Neo4j Query API error: ${json.errors
				.map(queryApiErrorMessage)
				.join("; ")}`,
		);
	}

	const data = json.data;
	if (
		!isRecord(data) ||
		!Array.isArray(data.fields) ||
		!data.fields.every((field) => typeof field === "string") ||
		!Array.isArray(data.values) ||
		!data.values.every(Array.isArray)
	) {
		throw new Error("Neo4j Query API returned malformed query data");
	}
	const fields = data.fields as string[];
	const values = data.values as unknown[][];
	if (values.some((row) => row.length !== fields.length)) {
		throw new Error("Neo4j Query API returned malformed query data");
	}

	return values.map((row) => {
		const record: Record<string, unknown> = {};
		for (let i = 0; i < fields.length; i++) {
			record[fields[i]!] = row[i];
		}
		return record;
	});
}
// ============================================================================
// Parameterized HTTP transport for API callers
// ============================================================================

/**
 * Run parameterized Cypher via the HTTP Query API.
 * Used by the API router for visualization/traversal queries.
 */
export async function runCypherWithParams(
	config: GraphDbConfig,
	cypher: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
	const http = createHttpClient(config);
	return runQuery(http, cypher, params);
}

export function createQueryRunner(http: HttpClient) {
	async function run<T>(
		queryObj: { query: string; params: Record<string, unknown> },
		mapper: (records: Record<string, unknown>[]) => T,
	): Promise<T> {
		const records = await runQuery(http, queryObj.query, queryObj.params);
		return mapper(records);
	}

	return run;
}
