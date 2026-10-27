#!/usr/bin/env bun
/**
 * Drain a `SECRETS_MASTER_KEY` rotation window.
 *
 * `splitMasterKeys` (packages/db/src/utils/secrets-encryption.ts) lets the
 * secret hold a comma-separated list: index 0 encrypts, every entry decrypts.
 * This script finds rows still encrypted under an older entry, re-encrypts
 * them under index 0 and writes them back, so the older entries can be dropped.
 *
 *   SECRETS_MASTER_KEY='<new>,<old>' bun scripts/secrets/rotate-master-key.ts \
 *     --remote [--apply] [--database DB] [--config apps/api/wrangler.jsonc] [--limit N]
 *
 * The key comes from the environment only, so it never lands in shell history.
 * Remote rows are read and written through the project-installed `cf d1 query`.
 * Local stores still use Wrangler until cf supports local D1 queries. The default
 * is a dry run that classifies every row and prints counts, never plaintext,
 * key material or ciphertext. Row ids are printed only for unreadable rows.
 *
 * Writes are optimistic (`WHERE id = ? AND encrypted_value = ?`): a row that
 * changed between read and write is skipped, not clobbered, and never uses a
 * transaction. The `key_version` column is a value revision counter, not a
 * key id, so it is left alone.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import {
	decryptAppSecret,
	decryptCatalogAppSecret,
	decryptSecret,
	decryptTediSecret,
	encryptAppSecret,
	encryptCatalogAppSecret,
	encryptSecret,
	encryptTediSecret,
	splitMasterKeys,
} from "../../packages/db/src/utils/secrets-encryption";
import { remoteD1CfQuery } from "../lib/remote-d1.ts";

// ---------------------------------------------------------------------------
// Table inventory: every column holding a master-key-encrypted value, with the
// derive function (HKDF info label) and the salt column each one uses.
// ---------------------------------------------------------------------------

type Codec = {
	readonly decrypt: (
		key: string,
		salt: string,
		value: string,
	) => Promise<string>;
	readonly encrypt: (
		key: string,
		salt: string,
		plaintext: string,
	) => Promise<string>;
};

export type EncryptedTable = {
	readonly table: string;
	readonly saltColumn: string;
	readonly valueColumn: string;
	readonly codec: Codec;
};

export const ENCRYPTED_TABLES: readonly EncryptedTable[] = [
	{
		table: "organization_secrets",
		saltColumn: "organization_id",
		valueColumn: "encrypted_value",
		codec: { decrypt: decryptSecret, encrypt: encryptSecret },
	},
	{
		table: "app_secrets",
		saltColumn: "app_id",
		valueColumn: "encrypted_value",
		codec: { decrypt: decryptAppSecret, encrypt: encryptAppSecret },
	},
	{
		table: "tedi_secrets",
		saltColumn: "tedi_id",
		valueColumn: "encrypted_value",
		codec: { decrypt: decryptTediSecret, encrypt: encryptTediSecret },
	},
	{
		table: "app_catalog",
		saltColumn: "id",
		valueColumn: "scan_auth_headers",
		codec: {
			decrypt: decryptCatalogAppSecret,
			encrypt: encryptCatalogAppSecret,
		},
	},
];

// ---------------------------------------------------------------------------
// SQL (the only place statements are built)
// ---------------------------------------------------------------------------

/** Keyset page size. Each row is a small base64 string; 200 keeps JSON small. */
export const PAGE_SIZE = 200;
/**
 * UPDATE statements per D1 query. Each UPDATE carries three
 * literal values; 30 keeps a batch under D1's 100-bound-parameter ceiling even
 * if these statements were ever rewritten to use placeholders.
 */
export const UPDATE_BATCH_SIZE = 30;

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export function selectPageSql(
	spec: EncryptedTable,
	afterId: string | null,
	limit: number,
): string {
	const where = [`${spec.valueColumn} IS NOT NULL`];
	if (afterId !== null) where.push(`id > ${sqlString(afterId)}`);
	return (
		`SELECT id, ${spec.saltColumn} AS salt, ${spec.valueColumn} AS value ` +
		`FROM ${spec.table} WHERE ${where.join(" AND ")} ORDER BY id LIMIT ${String(limit)}`
	);
}

export function updateRowSql(
	spec: EncryptedTable,
	row: { id: string; previous: string; next: string },
): string {
	return (
		`UPDATE ${spec.table} SET ${spec.valueColumn} = ${sqlString(row.next)} ` +
		`WHERE id = ${sqlString(row.id)} AND ${spec.valueColumn} = ${sqlString(row.previous)}`
	);
}

// ---------------------------------------------------------------------------
// Runner: one function that executes SQL and returns one result per statement.
// Tests back it with an in-memory table.
// ---------------------------------------------------------------------------

export type D1StatementResult = {
	readonly results: readonly Record<string, unknown>[];
	readonly meta?: { readonly changes?: number };
};

export type D1Runner = (sql: string) => Promise<D1StatementResult[]>;

export type EncryptedRow = {
	readonly id: string;
	readonly salt: string;
	readonly value: string;
};

export async function* readRows(
	run: D1Runner,
	spec: EncryptedTable,
	limit: number | null,
): AsyncGenerator<EncryptedRow> {
	let afterId: string | null = null;
	let seen = 0;
	while (limit === null || seen < limit) {
		const pageLimit =
			limit === null ? PAGE_SIZE : Math.min(PAGE_SIZE, limit - seen);
		const [page] = await run(selectPageSql(spec, afterId, pageLimit));
		const rows = page?.results ?? [];
		for (const raw of rows) {
			const id = raw["id"];
			const salt = raw["salt"];
			const value = raw["value"];
			if (
				typeof id !== "string" ||
				typeof salt !== "string" ||
				typeof value !== "string"
			) {
				throw new Error(`${spec.table}: unexpected row shape from D1`);
			}
			yield { id, salt, value };
			afterId = id;
			seen += 1;
		}
		if (rows.length < pageLimit) return;
	}
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type Classified =
	| { readonly kind: "current"; readonly row: EncryptedRow }
	| {
			readonly kind: "stale";
			readonly row: EncryptedRow;
			readonly keyIndex: number;
			readonly plaintext: string;
	  }
	| { readonly kind: "unreadable"; readonly row: EncryptedRow };

/** Try each key in order; the first that authenticates names the row's key. */
export async function classifyRow(
	keys: readonly string[],
	codec: Codec,
	row: EncryptedRow,
): Promise<Classified> {
	for (const [keyIndex, key] of keys.entries()) {
		let plaintext: string;
		try {
			plaintext = await codec.decrypt(key, row.salt, row.value);
		} catch {
			continue;
		}
		return keyIndex === 0
			? { kind: "current", row }
			: { kind: "stale", row, keyIndex, plaintext };
	}
	return { kind: "unreadable", row };
}

export type TableReport = {
	readonly table: string;
	total: number;
	current: number;
	/** Rows readable only with an older key, by key index. */
	readonly staleByKey: Record<number, number>;
	readonly unreadableIds: string[];
	/** Apply only. */
	rewritten: number;
	skipped: number;
};

export type RotateOptions = {
	readonly keys: readonly string[];
	readonly apply: boolean;
	readonly limit: number | null;
	readonly tables?: readonly EncryptedTable[];
};

export async function rotateTable(
	run: D1Runner,
	spec: EncryptedTable,
	options: RotateOptions,
): Promise<TableReport> {
	const report: TableReport = {
		table: spec.table,
		total: 0,
		current: 0,
		staleByKey: {},
		unreadableIds: [],
		rewritten: 0,
		skipped: 0,
	};
	const primary = options.keys[0];
	if (primary === undefined) throw new Error("No master key configured");

	let pending: { id: string; previous: string; next: string }[] = [];
	const flush = async () => {
		if (pending.length === 0) return;
		const batch = pending;
		pending = [];
		const results = await run(
			batch.map((row) => updateRowSql(spec, row)).join(";\n"),
		);
		if (results.length !== batch.length) {
			throw new Error(
				`${spec.table}: expected ${String(batch.length)} statement results, got ${String(results.length)}`,
			);
		}
		for (const result of results) {
			if (result.meta?.changes === 1) report.rewritten += 1;
			else report.skipped += 1;
		}
	};

	for await (const row of readRows(run, spec, options.limit)) {
		report.total += 1;
		const classified = await classifyRow(options.keys, spec.codec, row);
		if (classified.kind === "current") {
			report.current += 1;
			continue;
		}
		if (classified.kind === "unreadable") {
			report.unreadableIds.push(row.id);
			continue;
		}
		report.staleByKey[classified.keyIndex] =
			(report.staleByKey[classified.keyIndex] ?? 0) + 1;
		if (!options.apply) continue;
		pending.push({
			id: row.id,
			previous: row.value,
			next: await spec.codec.encrypt(primary, row.salt, classified.plaintext),
		});
		if (pending.length >= UPDATE_BATCH_SIZE) await flush();
	}
	await flush();
	return report;
}

export async function rotateAll(
	run: D1Runner,
	options: RotateOptions,
): Promise<TableReport[]> {
	const reports: TableReport[] = [];
	for (const spec of options.tables ?? ENCRYPTED_TABLES) {
		reports.push(await rotateTable(run, spec, options));
	}
	return reports;
}

export function renderReport(
	reports: readonly TableReport[],
	apply: boolean,
): string {
	const lines: string[] = [];
	for (const r of reports) {
		const stale = Object.entries(r.staleByKey)
			.map(([index, count]) => `key[${index}]=${String(count)}`)
			.join(", ");
		lines.push(
			`${r.table}: total=${String(r.total)} current=${String(r.current)} stale=${String(Object.values(r.staleByKey).reduce((a, b) => a + b, 0))}${stale ? ` (${stale})` : ""} unreadable=${String(r.unreadableIds.length)}`,
		);
		if (apply) {
			lines.push(
				`  rewritten=${String(r.rewritten)} skipped(concurrent change)=${String(r.skipped)}`,
			);
		}
		for (const id of r.unreadableIds) lines.push(`  unreadable id: ${id}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export type CliArgs = {
	readonly apply: boolean;
	readonly limit: number | null;
	readonly database: string | null;
	readonly config: string;
	readonly target: "--remote" | "--local";
};

export function parseCli(argv: readonly string[]): CliArgs {
	let apply = false;
	let limit: number | null = null;
	let database: string | null = null;
	let config = resolve(import.meta.dir, "../../apps/api/wrangler.jsonc");
	let target: "--remote" | "--local" | null = null;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]!;
		const next = () => {
			const value = argv[i + 1];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			i += 1;
			return value;
		};
		if (arg === "--apply") apply = true;
		else if (arg === "--remote" || arg === "--local") {
			if (target !== null && target !== arg)
				throw new Error("Pass only one of --remote or --local");
			target = arg;
		} else if (arg === "--limit") {
			const value = next();
			limit = Number(value);
			if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit <= 0)
				throw new Error("--limit must be a positive safe integer");
		} else if (arg === "--database") database = next();
		else if (arg === "--config") config = resolve(next());
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (target === null) throw new Error("Pass --remote or --local");
	return { apply, limit, database, config, target };
}

/** The first D1 binding name in a wrangler.jsonc (top-level, not env-scoped). */
export function defaultDatabaseFromConfig(configPath: string): string {
	const parsed = parseJsonc(readFileSync(configPath, "utf8")) as {
		d1_databases?: { binding?: string }[];
	};
	const binding = parsed.d1_databases?.[0]?.binding;
	if (!binding) throw new Error(`${configPath} declares no d1_databases`);
	return binding;
}

export function remoteDatabaseId(configPath: string, database: string): string {
	const uuid =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	let id = database;
	if (!uuid.test(database)) {
		const parsed = parseJsonc(readFileSync(configPath, "utf8")) as {
			d1_databases?: {
				binding?: string;
				database_name?: string;
				database_id?: string;
			}[];
		};
		const matches = parsed.d1_databases?.filter(
			(entry) => entry.binding === database || entry.database_name === database,
		);
		if (matches?.length !== 1) {
			throw new Error(
				`${configPath} must declare exactly one D1 target for ${database}`,
			);
		}
		id = matches[0]?.database_id ?? "";
	}
	if (!uuid.test(id) || id === "00000000-0000-0000-0000-000000000000") {
		throw new Error("Remote rotation requires a configured D1 database UUID");
	}
	return id;
}

export function localRotationCommand(
	args: CliArgs,
	database: string,
): string[] {
	return [
		resolve(import.meta.dir, "../../node_modules/.bin/wrangler"),
		"d1",
		"execute",
		database,
		"--local",
		"--config",
		args.config,
		"--json",
		"--command",
	];
}

function d1Runner(args: CliArgs, database: string): D1Runner {
	if (args.target === "--remote") {
		const databaseId = remoteDatabaseId(args.config, database);
		return (sql) =>
			remoteD1CfQuery({
				databaseId,
				sql,
				caller: "scripts/secrets/rotate-master-key.ts",
			});
	}
	const command = localRotationCommand(args, database);
	const label = "wrangler d1 execute";
	return async (sql) => {
		const proc = Bun.spawn([...command, sql], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		if ((await proc.exited) !== 0) {
			throw new Error(`${label} failed:\n${stderr}`);
		}
		const parsed = JSON.parse(stdout) as (D1StatementResult & {
			success?: boolean;
		})[];
		if (!Array.isArray(parsed) || parsed.some((r) => r.success !== true)) {
			throw new Error(`${label} returned a failed statement`);
		}
		return parsed;
	};
}

async function main(): Promise<void> {
	const args = parseCli(process.argv.slice(2));
	const masterKey = process.env["SECRETS_MASTER_KEY"];
	if (!masterKey) throw new Error("SECRETS_MASTER_KEY is not set");
	const keys = splitMasterKeys(masterKey);
	const database = args.database ?? defaultDatabaseFromConfig(args.config);
	console.log(
		`${args.apply ? "APPLY" : "DRY RUN"}: ${String(keys.length)} key(s), database ${database} (${args.target.slice(2)})`,
	);
	if (keys.length === 1 && args.apply) {
		console.log("Only one key configured; nothing can be stale.");
	}
	const reports = await rotateAll(d1Runner(args, database), {
		keys,
		apply: args.apply,
		limit: args.limit,
	});
	console.log(renderReport(reports, args.apply));
	const unreadable = reports.reduce((n, r) => n + r.unreadableIds.length, 0);
	if (unreadable > 0) process.exitCode = 2;
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
