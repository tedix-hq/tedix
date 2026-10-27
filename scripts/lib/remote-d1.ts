/**
 * The one audited path for remote D1 access from repo scripts and tooling
 * (`bun run lint:remote-d1` blocks the raw forms elsewhere).
 *
 * Every remote statement goes through here so the actor is recorded before the
 * database is touched: who ran it, which transport carried it (Wrangler
 * `d1 execute --remote`, the pinned `cf d1 query`, or the Cloudflare REST
 * `/d1/database/<id>/query`), which database, and a SHA-256 fingerprint of the
 * SQL. The statement text itself is never logged — callers ship ciphertext and
 * provider payloads through this path.
 *
 * The trail is one JSON object per line at `.cache/remote-d1-audit.jsonl`
 * (gitignored), overridable with `TEDIX_D1_AUDIT_LOG`, plus one stderr line so
 * CI logs carry the same record. A failed audit write aborts the call rather
 * than letting an unrecorded remote write through.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const D1_AUDIT_LOG_ENV = "TEDIX_D1_AUDIT_LOG";
export const D1_AUDIT_ACTOR_ENV = "TEDIX_D1_ACTOR";
const DEFAULT_AUDIT_LOG = ".cache/remote-d1-audit.jsonl";
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const MAX_BUFFER = 30 * 1024 * 1024;

export type RemoteD1Transport =
	| "wrangler-d1-execute"
	| "cf-d1-query"
	| "rest-d1-query";

/** One row of Wrangler's/cf's `--json` D1 envelope. */
export interface RemoteD1StatementResult {
	results: Record<string, unknown>[];
	success: boolean;
	meta?: {
		changes?: number;
		duration?: number;
		rows_read?: number;
		rows_written?: number;
	};
	error?: unknown;
}

export interface RemoteD1AuditEntry {
	readonly at: string;
	readonly actor: string;
	readonly transport: string;
	readonly database: string;
	readonly caller: string;
	/** SHA-256 of the exact SQL text, when the call carries a statement. */
	readonly sqlSha256?: string;
	readonly sqlBytes?: number;
	/** Argument tail for non-statement remote calls (migrations apply, etc.). */
	readonly argv?: string;
}

/**
 * Who is running the remote write, best available identity first: the explicit
 * `TEDIX_D1_ACTOR` override, a Tedix agent session (optionally qualified with
 * its external-agent principal), a GitHub Actions actor/run, then the local
 * account. Never empty — `unknown` keeps the trail honest when nothing is set.
 */
export function resolveD1Actor(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env[D1_AUDIT_ACTOR_ENV]?.trim();
	if (explicit) return explicit;
	const session = env.TEDIX_AGENT_SESSION?.trim();
	if (session) {
		const principal = env.TEDIX_EXTERNAL_AGENT?.trim();
		return principal ? `${session}@${principal}` : session;
	}
	const github = env.GITHUB_ACTOR?.trim();
	if (github) {
		const run = env.GITHUB_RUN_ID?.trim();
		return `github:${github}${run ? `#${run}` : ""}`;
	}
	const user = env.USER?.trim() || env.LOGNAME?.trim();
	return user ?? "unknown";
}

export function d1AuditLogPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[D1_AUDIT_LOG_ENV]?.trim();
	return override ? resolve(override) : join(REPO_ROOT, DEFAULT_AUDIT_LOG);
}

function defaultCaller(): string {
	const entry = process.argv[1];
	if (!entry) return "unknown";
	const resolved = resolve(entry);
	return resolved.startsWith(REPO_ROOT)
		? resolved.slice(REPO_ROOT.length).replaceAll("\\", "/")
		: resolved;
}

/**
 * Append one audit record and echo it on stderr. Throws when the record cannot
 * be written — an unrecorded remote write is not allowed to proceed silently.
 */
export function recordRemoteD1Audit(
	entry: {
		transport: string;
		database: string;
		sql?: string;
		argv?: string;
		actor?: string;
		caller?: string;
	},
	env: NodeJS.ProcessEnv = process.env,
): RemoteD1AuditEntry {
	const record: RemoteD1AuditEntry = {
		at: new Date().toISOString(),
		actor: entry.actor?.trim() || resolveD1Actor(env),
		transport: entry.transport,
		database: entry.database,
		caller: entry.caller?.trim() || defaultCaller(),
		...(entry.sql === undefined
			? {}
			: {
					sqlSha256: createHash("sha256")
						.update(entry.sql, "utf8")
						.digest("hex"),
					sqlBytes: Buffer.byteLength(entry.sql, "utf8"),
				}),
		...(entry.argv === undefined ? {} : { argv: entry.argv }),
	};
	const path = d1AuditLogPath(env);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
	console.error(
		`[remote-d1] actor=${record.actor} transport=${record.transport} ` +
			`database=${record.database}${record.sqlSha256 ? ` sql=sha256:${record.sqlSha256}` : ""}${record.argv ? ` argv=${record.argv}` : ""}`,
	);
	return record;
}

/** True when a Wrangler argv array reaches remote D1 (`d1 ... --remote`). */
export function isRemoteD1Argv(args: readonly string[]): boolean {
	return (
		args[0] === "d1" &&
		args.some((arg) => arg === "--remote" || arg === "--remote=true")
	);
}

/**
 * Audit record for a raw Wrangler argv about to hit remote D1. `wrangler-command`
 * calls this so every remote `d1` subcommand leaves a trail without each caller
 * rebuilding it; SQL is fingerprinted, flag/file arguments are kept verbatim.
 */
export function auditRemoteD1Argv(
	args: readonly string[],
	options: { caller?: string; env?: NodeJS.ProcessEnv } = {},
): void {
	const commandIndex = args.indexOf("--command");
	// The database name is the positional right before the first `--flag`
	// (`d1 execute DB --remote`, `d1 migrations apply DB --remote`, ...).
	const firstFlag = args.findIndex((arg) => arg.startsWith("--"));
	const database =
		firstFlag > 1 ? (args[firstFlag - 1] ?? "unknown") : "unknown";
	// No --command: keep the argument tail verbatim (no SQL text to hide). With
	// --command the SQL is fingerprinted, so the argv needs no restatement.
	const argv =
		commandIndex === -1
			? args
					.slice(1)
					.filter((arg) => arg !== "--json")
					.join(" ")
			: undefined;
	recordRemoteD1Audit(
		{
			transport:
				args[1] === "execute"
					? "wrangler-d1-execute"
					: `wrangler-${args.slice(0, 3).join("-")}`,
			database,
			...(commandIndex === -1 ? {} : { sql: args[commandIndex + 1] ?? "" }),
			...(argv === undefined ? {} : { argv }),
			caller: options.caller,
		},
		options.env ?? process.env,
	);
}

function projectBin(name: "wrangler" | "cf"): string {
	const packageRoot = dirname(
		createRequire(import.meta.url).resolve(`${name}/package.json`),
	);
	return join(packageRoot, name === "wrangler" ? "bin/wrangler.js" : "bin/cf");
}

/**
 * `d1 execute --remote --json --command <sql>` argv for the project-installed
 * Wrangler (everything after the runtime + wrangler.js executable).
 */
function remoteD1ExecuteArgv(options: {
	database: string;
	sql: string;
	config?: string;
}): string[] {
	const argv = ["d1", "execute", options.database, "--remote"];
	if (options.config) argv.push("--config", options.config);
	argv.push("--json", "--command", options.sql);
	return argv;
}

/** `cf d1 query <uuid> --sql <sql>` argv for the pinned project `cf` binary. */
function cfD1QueryArgv(options: { databaseId: string }): string[] {
	return [projectBin("cf"), "d1", "query", options.databaseId, "--sql"];
}

function parseD1JsonEnvelope(
	stdout: string,
	label: string,
): RemoteD1StatementResult[] {
	const parsed = JSON.parse(stdout) as RemoteD1StatementResult[];
	if (!Array.isArray(parsed) || parsed.some((r) => r.success !== true)) {
		throw new Error(`${label} returned a failed statement`);
	}
	return parsed;
}

export interface RemoteD1ExecuteOptions {
	/** Wrangler target: the D1 binding or database name the config resolves. */
	database: string;
	sql: string;
	/** Wrangler config path; omit when `cwd` already carries wrangler.jsonc. */
	config?: string;
	cwd?: string;
	caller?: string;
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
}

export function auditedRemoteD1ExecuteArgv(
	options: RemoteD1ExecuteOptions,
): string[] {
	recordRemoteD1Audit(
		{
			transport: "wrangler-d1-execute",
			database: options.database,
			sql: options.sql,
			caller: options.caller,
		},
		options.env ?? process.env,
	);
	return remoteD1ExecuteArgv(options);
}

/** Run one remote statement through Wrangler, audited, sync. */
export function remoteD1ExecuteSync(
	options: RemoteD1ExecuteOptions,
): RemoteD1StatementResult[] {
	const result = spawnSync(
		process.execPath,
		[projectBin("wrangler"), ...auditedRemoteD1ExecuteArgv(options)],
		{
			cwd: options.cwd ?? REPO_ROOT,
			encoding: "utf8",
			env: options.env ?? process.env,
			maxBuffer: options.maxBuffer ?? MAX_BUFFER,
		},
	);
	if (result.status !== 0 || result.error) {
		throw new Error(
			`wrangler d1 execute --remote failed` +
				`${result.error ? ` (${result.error.message})` : ""}:\n${result.stderr || result.stdout}`,
		);
	}
	return parseD1JsonEnvelope(result.stdout, "wrangler d1 execute");
}

/** Run one remote statement through Wrangler, audited, async. */
export async function remoteD1Execute(
	options: RemoteD1ExecuteOptions,
): Promise<RemoteD1StatementResult[]> {
	const stdout = await collectStdout(
		[
			process.execPath,
			projectBin("wrangler"),
			...auditedRemoteD1ExecuteArgv(options),
		],
		{ cwd: options.cwd ?? REPO_ROOT, env: options.env ?? process.env },
	);
	return parseD1JsonEnvelope(stdout, "wrangler d1 execute");
}

/**
 * Run one remote statement through the pinned `cf d1 query` (Cloudflare REST
 * under the hood), audited. Takes the database UUID directly.
 */
export async function remoteD1CfQuery(options: {
	databaseId: string;
	sql: string;
	caller?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<RemoteD1StatementResult[]> {
	recordRemoteD1Audit(
		{
			transport: "cf-d1-query",
			database: options.databaseId,
			sql: options.sql,
			caller: options.caller,
		},
		options.env ?? process.env,
	);
	const stdout = await collectStdout([...cfD1QueryArgv(options), options.sql], {
		env: options.env ?? process.env,
	});
	return parseD1JsonEnvelope(stdout, "cf d1 query");
}

export interface RemoteD1RestResult {
	ok: boolean;
	status: number;
	result?: unknown;
	detail?: string;
}

/**
 * One statement through the Cloudflare REST D1 query endpoint, audited. This is
 * the bootstrap/restore/upgrade transport — the same envelope shape the
 * provisioner's API client uses.
 */
export async function remoteD1QueryRest(options: {
	accountId: string;
	databaseId: string;
	sql: string;
	apiToken: string;
	apiBaseUrl?: string;
	fetchImplementation?: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>;
	caller?: string;
	env?: NodeJS.ProcessEnv;
}): Promise<RemoteD1RestResult> {
	recordRemoteD1Audit(
		{
			transport: "rest-d1-query",
			database: options.databaseId,
			sql: options.sql,
			caller: options.caller,
		},
		options.env ?? process.env,
	);
	const fetchImpl =
		options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
	const base = options.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL;
	let response: Response;
	try {
		response = await fetchImpl(
			`${base}/accounts/${options.accountId}/d1/database/${encodeURIComponent(options.databaseId)}/query`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.apiToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ sql: options.sql }),
			},
		);
	} catch (error) {
		return {
			ok: false,
			status: 0,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
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

function collectStdout(
	argv: string[],
	options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(argv[0]!, argv.slice(1), {
			cwd: options.cwd ?? REPO_ROOT,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let stderrTail = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
		});
		child.on("error", (error) => reject(error));
		child.on("close", (code) => {
			const stdout = Buffer.concat(chunks).toString("utf8");
			if (code !== 0) {
				reject(
					new Error(
						`${argv[0]} exited ${String(code)}:\n${stderrTail || stdout.slice(-2000)}`,
					),
				);
				return;
			}
			resolvePromise(stdout);
		});
	});
}
