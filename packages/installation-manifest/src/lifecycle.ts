import { executeD1Statements } from "./provision";

/**
 * Backup, restore, and upgrade lifecycle operations for a provisioned
 * installation. These are the engine halves of the
 * manifest's `lifecycle` promises: D1 export via the polling REST API, SQL
 * restore through the same caller-supplied-statement path the bootstrap uses,
 * a verification diff over restored tables, an R2 object backup roundtrip,
 * and an upgrade leg that applies migration statements to a restored
 * database. Network access is injectable so tests never leave process.
 */

export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

interface LifecycleClientOptions {
	accountId: string;
	apiToken: string;
	apiBaseUrl?: string;
	fetchImplementation?: typeof fetch;
}

function resolveFetch(options: LifecycleClientOptions): typeof fetch {
	return options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
}

function apiUrl(options: LifecycleClientOptions, path: string): string {
	const base = options.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
	return `${base}/accounts/${options.accountId}${path}`;
}

async function apiJson(
	options: LifecycleClientOptions,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
): Promise<{
	ok: boolean;
	status: number;
	result?: unknown;
	detail?: string;
}> {
	const response = await resolveFetch(options)(apiUrl(options, path), {
		method,
		headers: {
			Authorization: `Bearer ${options.apiToken}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	let envelope:
		| {
				success?: boolean;
				result?: unknown;
				errors?: Array<{ code?: number; message?: string }>;
		  }
		| undefined;
	try {
		envelope = (await response.json()) as typeof envelope;
	} catch {
		envelope = undefined;
	}
	const firstError = envelope?.errors?.[0];
	return {
		ok: response.ok && envelope?.success !== false,
		status: response.status,
		result: envelope?.result,
		detail: firstError
			? `${firstError.code ?? "unknown"}: ${firstError.message ?? ""}`
			: undefined,
	};
}

// =============================================================================
// D1 export (polling protocol)
// =============================================================================

export interface D1ExportResult {
	sql: string;
	filename: string | null;
	bookmark: string | null;
	polls: number;
}

/**
 * Export a D1 database to its SQL dump via the polling protocol: POST the
 * export request, re-POST with the returned bookmark until the run reports
 * complete, then download the signed dump URL.
 */
export async function exportD1Database(
	options: LifecycleClientOptions & {
		databaseId: string;
		maxPolls?: number;
		sleep?: (ms: number) => Promise<void>;
		pollIntervalMs?: number;
	},
): Promise<D1ExportResult> {
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const maxPolls = options.maxPolls ?? 30;
	const interval = options.pollIntervalMs ?? 2000;
	let bookmark: string | null = null;
	for (let poll = 1; poll <= maxPolls; poll++) {
		const body: Record<string, unknown> = { output_format: "polling" };
		if (bookmark) body.current_bookmark = bookmark;
		const response = await apiJson(
			options,
			"POST",
			`/d1/database/${encodeURIComponent(options.databaseId)}/export`,
			body,
		);
		if (!response.ok) {
			throw new Error(
				`d1 export failed: ${response.detail ?? response.status}`,
			);
		}
		const result = response.result as {
			status?: string;
			at_bookmark?: string;
			result?: { filename?: string; signed_url?: string };
			signed_url?: string;
			filename?: string;
		};
		bookmark = result.at_bookmark ?? bookmark;
		const signedUrl = result.result?.signed_url ?? result.signed_url;
		if (result.status === "complete" && signedUrl) {
			const download = await resolveFetch(options)(signedUrl);
			if (!download.ok) {
				throw new Error(`d1 export download failed: ${download.status}`);
			}
			return {
				sql: await download.text(),
				filename: result.result?.filename ?? result.filename ?? null,
				bookmark,
				polls: poll,
			};
		}
		if (result.status === "error") {
			throw new Error("d1 export reported error status");
		}
		await sleep(interval);
	}
	throw new Error(`d1 export did not complete within ${maxPolls} polls`);
}

// =============================================================================
// SQL statement splitting (restore input)
// =============================================================================

/**
 * Split a D1 SQL dump into executable statements: semicolons terminate
 * statements only outside single-quoted strings (D1 dumps escape quotes by
 * doubling them, which this handles as two consecutive quote toggles).
 * Comments and blank lines between statements are dropped.
 */
export function splitSqlStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = "";
	let inString = false;
	for (const char of sql) {
		if (char === "'") inString = !inString;
		if (char === ";" && !inString) {
			const trimmed = current.trim();
			if (trimmed && !isSqlNoise(trimmed)) statements.push(trimmed);
			current = "";
			continue;
		}
		current += char;
	}
	const tail = current.trim();
	if (tail && !isSqlNoise(tail)) statements.push(tail);
	return statements;
}

function isSqlNoise(statement: string): boolean {
	const lines = statement
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("--"));
	if (lines.length === 0) return true;
	const joined = lines.join(" ").toUpperCase();
	return (
		joined === "BEGIN TRANSACTION" || joined === "COMMIT" || joined === "END"
	);
}

// =============================================================================
// Restore + verification
// =============================================================================

/** Restore a SQL dump into a target database, statement by statement. */
export async function restoreD1Database(
	options: LifecycleClientOptions & { targetDatabaseId: string; sql: string },
): Promise<{ ok: boolean; executed: number; detail?: string }> {
	const statements = splitSqlStatements(options.sql);
	return executeD1Statements({
		accountId: options.accountId,
		databaseId: options.targetDatabaseId,
		statements,
		apiToken: options.apiToken,
		apiBaseUrl: options.apiBaseUrl,
		fetchImplementation: options.fetchImplementation,
	});
}

export interface TableVerification {
	table: string;
	sourceRows: number | null;
	targetRows: number | null;
	match: boolean;
}

async function queryScalar(
	options: LifecycleClientOptions,
	databaseId: string,
	sql: string,
): Promise<unknown[]> {
	const response = await apiJson(
		options,
		"POST",
		`/d1/database/${encodeURIComponent(databaseId)}/query`,
		{ sql },
	);
	if (!response.ok) {
		throw new Error(`d1 query failed: ${response.detail ?? response.status}`);
	}
	const result = response.result as Array<{
		results?: Array<Record<string, unknown>>;
	}>;
	return (result?.[0]?.results ?? []).map((row) => Object.values(row)[0]);
}

/**
 * Compare per-table row counts between a source and its restore. Tables are
 * enumerated from the SOURCE schema, so a missing table in the target shows
 * up as a null count and a mismatch instead of silently narrowing the check.
 */
export async function verifyD1Restore(
	options: LifecycleClientOptions & {
		sourceDatabaseId: string;
		targetDatabaseId: string;
	},
): Promise<{ ok: boolean; tables: TableVerification[] }> {
	const tableNames = (await queryScalar(
		options,
		options.sourceDatabaseId,
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
	)) as string[];
	const tables: TableVerification[] = [];
	for (const table of tableNames) {
		const safe = String(table).replace(/"/g, '""');
		const count = async (databaseId: string): Promise<number | null> => {
			try {
				const values = await queryScalar(
					options,
					databaseId,
					`SELECT count(*) FROM "${safe}"`,
				);
				return Number(values[0] ?? 0);
			} catch {
				return null;
			}
		};
		const sourceRows = await count(options.sourceDatabaseId);
		const targetRows = await count(options.targetDatabaseId);
		tables.push({
			table: String(table),
			sourceRows,
			targetRows,
			match: sourceRows !== null && sourceRows === targetRows,
		});
	}
	return { ok: tables.length > 0 && tables.every((t) => t.match), tables };
}

// =============================================================================
// R2 object backup roundtrip
// =============================================================================

/**
 * Prove the R2 backup path with a write→copy→read roundtrip through the REST
 * object endpoints: write a payload, copy it under a backup prefix, read the
 * backup back, and compare bytes.
 */
export async function r2BackupRoundtrip(
	options: LifecycleClientOptions & {
		bucketName: string;
		key: string;
		payload: string;
		backupPrefix?: string;
	},
): Promise<{ ok: boolean; backupKey: string; detail?: string }> {
	const prefix = options.backupPrefix ?? "backups/";
	const backupKey = `${prefix}${options.key}`;
	const doFetch = resolveFetch(options);
	const objectUrl = (key: string): string =>
		apiUrl(
			options,
			`/r2/buckets/${encodeURIComponent(options.bucketName)}/objects/${encodeURIComponent(key)}`,
		);
	const put = async (key: string, body: string): Promise<Response> =>
		doFetch(objectUrl(key), {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${options.apiToken}`,
				"content-type": "application/octet-stream",
			},
			body,
		});
	const wrote = await put(options.key, options.payload);
	if (!wrote.ok) {
		return { ok: false, backupKey, detail: `write failed: ${wrote.status}` };
	}
	const read = await doFetch(objectUrl(options.key), {
		headers: { Authorization: `Bearer ${options.apiToken}` },
	});
	if (!read.ok) {
		return { ok: false, backupKey, detail: `read failed: ${read.status}` };
	}
	const original = await read.text();
	const copied = await put(backupKey, original);
	if (!copied.ok) {
		return { ok: false, backupKey, detail: `copy failed: ${copied.status}` };
	}
	const readBack = await doFetch(objectUrl(backupKey), {
		headers: { Authorization: `Bearer ${options.apiToken}` },
	});
	if (!readBack.ok) {
		return {
			ok: false,
			backupKey,
			detail: `backup read failed: ${readBack.status}`,
		};
	}
	const roundtripped = await readBack.text();
	return {
		ok: roundtripped === options.payload,
		backupKey,
		detail: roundtripped === options.payload ? undefined : "payload mismatch",
	};
}

// =============================================================================
// Upgrade leg
// =============================================================================

/**
 * Apply upgrade (migration) statements to a database and verify an expected
 * schema condition afterwards — the recovery→upgrade path: a restored
 * database must accept the next migration, not just serve reads.
 */
export async function applyD1Upgrade(
	options: LifecycleClientOptions & {
		databaseId: string;
		statements: string[];
		verifySql: string;
		expectValue: unknown;
	},
): Promise<{ ok: boolean; executed: number; observed: unknown }> {
	const applied = await executeD1Statements({
		accountId: options.accountId,
		databaseId: options.databaseId,
		statements: options.statements,
		apiToken: options.apiToken,
		apiBaseUrl: options.apiBaseUrl,
		fetchImplementation: options.fetchImplementation,
	});
	if (!applied.ok) {
		return { ok: false, executed: applied.executed, observed: null };
	}
	const values = await queryScalar(
		options,
		options.databaseId,
		options.verifySql,
	);
	const observed = values[0];
	return {
		ok: observed === options.expectValue,
		executed: applied.executed,
		observed,
	};
}
