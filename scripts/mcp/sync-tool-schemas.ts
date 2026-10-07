#!/usr/bin/env bun

import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
	accessSync,
	constants,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

/**
 * Drift gate: D1 `app_tools` schemas vs oRPC contract zod schemas.
 *
 * Source of truth: `packages/api-contract/src/contracts/`.
 * Target: every `app_tools` row on the tedix admin app with `transport='rpc'`.
 *
 * Input schemas are MCP JSON Schema root objects because tool calls pass named
 * argument objects. Output schemas match the shared SDK adapter: object results
 * stay direct; non-object results use its `{ data: value }` envelope.
 *
 * Modes:
 *   --apply            Repair D1 schemas directly through Wrangler D1, deleting
 *                      stale contract-backed RPC rows and updating drifted
 *                      input/output schema columns.
 *   --check            CI gate. Fails on any drift. Existing drift is not
 *                      tolerated; run ToolSchemaSyncWorkflow with
 *                      pruneStale=true for rows whose source contract was
 *                      intentionally removed.
 *   --dry-run          default — print diffs, never fail.
 *   --only=<id>[,...]  restrict to specific tool_ids (debugging).
 *
 * `--check` and `--dry-run` are read-only. Normal operator writes go through the
 * ToolSchemaSyncWorkflow exposed by Tedix admin MCP (`tool.run_tool_schema_sync`).
 * The deploy workflow runs that sync before this check and uses `--apply` as
 * the synchronous CI repair path because Cloudflare Workflow execution is
 * asynchronous.
 */

import {
	listContractEndpoints,
	resolveContractEndpoint,
} from "@tedix/api-contract/utils/contract-routers";
import {
	zodToStructuredOutputJsonSchema,
	zodToToolInputJsonSchema,
} from "@tedix/api-contract/utils/tool-json-schema";

const TEDIX_ADMIN_APP_SLUG = "tedix";
const TEDIX_APP_ID_SQL = `(SELECT id FROM apps WHERE slug = '${TEDIX_ADMIN_APP_SLUG}')`;
// The binding name resolves to whichever database apps/api/wrangler.jsonc binds.
const D1_DB = "DB";

const IGNORE_DRIFT: Record<string, string> = {};

export const REQUIRED_PROJECTION_ENDPOINTS = [
	"workflows/listDefinitions",
	"skills/listPromotionCandidates",
	"skills/listWorkflowSchedules",
	"skills/proposeWorkflowImprovement",
	"skills/inspectWorkflowImprovement",
	"skills/activateWorkflowImprovement",
	"flywheelHealth/learningCurves",
	"flywheelHealth/getOrphanRunHealth",
	"memoryGraph/graph/path",
	"memoryGraph/graph/similar",
	"memoryGraph/graph/communities",
	"memoryGraph/graph/influence",
	"memoryGraph/graph/health",
	"memoryGraph/graph/sync",
	"memoryGraph/graph/maintenance",
	"memoryGraph/graph/maintenanceTaskStatus",
	"memoryGraph/graph/maintenanceTaskCancel",
	"memoryEntities/createEntity",
	"memoryEntities/recordMention",
	"memoryEntities/listCandidates",
	"memoryEntities/proposeResolution",
	"memoryEntities/proposeResolutionRollback",
	"memoryEntities/reviewResolution",
	"memoryEntities/getMentionResolution",
	"graphRetrievalBenchmarks/createSuite",
	"graphRetrievalBenchmarks/addCase",
	"graphRetrievalBenchmarks/lockSuite",
	"graphRetrievalBenchmarks/getSuite",
	"graphRetrievalBenchmarks/startPair",
	"graphRetrievalBenchmarks/recordObservation",
	"graphRetrievalBenchmarks/completeRun",
	"graphRetrievalBenchmarks/executePair",
	"graphRetrievalBenchmarks/evaluatePair",
	"graphRetrievalBenchmarks/getRun",
	"graphRetrievalBenchmarks/getGate",
] as const;

export const READER_RAW_BYTE_LIMIT = 8_388_608;
export const READER_DEADLINE_MS = 30_000;
/** Per-stream tail kept for refusal diagnostics; bounded and redacted before printing. */
export const READER_DIAGNOSTIC_TAIL_CHARS = 2_000;

/**
 * A refusal carries a fixed stage message plus an optional cause (exit status,
 * redacted child output tail) so a failed deploy step says what went wrong.
 * The message stays fixed; only `main` prints the cause, after redaction.
 */
export class ReaderRefusal extends Error {
	constructor(
		stage: string,
		readonly detail?: string,
	) {
		super(`Schema reader refused: ${stage}.`);
		this.name = "ReaderRefusal";
	}
}

const ANSI_ESCAPE = new RegExp(
	`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
	"g",
);
const SECRET_ENV_NAME =
	/TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|API_KEY|PRIVATE_KEY|_KEY$/i;
/** Strip control characters, mask secret-named env values and bearer tokens, keep the tail. */
export function redactDiagnostic(
	text: string,
	env: Readonly<Record<string, string | undefined>> = {},
	limit = READER_DIAGNOSTIC_TAIL_CHARS,
): string {
	let out = text;
	const secrets = Object.entries(env)
		.filter(
			(entry): entry is [string, string] =>
				SECRET_ENV_NAME.test(entry[0]) &&
				typeof entry[1] === "string" &&
				entry[1].length >= 8,
		)
		.sort((a, b) => b[1].length - a[1].length);
	for (const [name, value] of secrets)
		out = out.split(value).join(`[redacted ${name}]`);
	out = Array.from(
		out
			.replace(ANSI_ESCAPE, "")
			.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"),
		// Drop control characters (and CR) except newline and tab.
		(char) => {
			const code = char.charCodeAt(0);
			return (code < 32 && code !== 9 && code !== 10) || code === 127
				? ""
				: char;
		},
	)
		.join("")
		.trim();
	return out.length > limit ? `…${out.slice(out.length - limit)}` : out;
}

export interface ReaderChild {
	readonly pid?: number;
	readonly stdout: Readable;
	readonly stderr: Readable;
	on(event: "error", listener: (error: Error) => void): unknown;
	on(
		event: "close",
		listener: (code: number | null, signal: string | null) => void,
	): unknown;
}
export interface ReaderTools {
	readonly node: string;
	readonly wrangler: string;
	readonly config: string;
}
/** Primitive collaborators only; production never selects them from arguments/config. */
export interface ReaderIo {
	readonly platform: string;
	now(): number;
	setTimer(callback: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	resolveTools(): ReaderTools | Promise<ReaderTools>;
	spawn(argv: readonly string[]): ReaderChild;
	killGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
	log(line: string): void;
	error(line: string): void;
	/** Environment whose secret-named values are masked from printed causes. */
	readonly env?: Readonly<Record<string, string | undefined>>;
}
export interface ReaderScope {
	readonly signal: AbortSignal | undefined;
	readonly rawBytes: number;
	check(): void;
	remaining(): number;
	charge(bytes: number): void;
	fail(stage: string, detail?: string): Error;
}

/** One original monotonic deadline and shared budget, private from its callers. */
export function createReaderScope(
	io: ReaderIo,
	signal?: AbortSignal,
): ReaderScope {
	const now = io.now.bind(io);
	const start = now();
	const deadline = start + READER_DEADLINE_MS;
	let last = start;
	let bytes = 0;
	let terminal: Error | undefined;
	const fail = (stage: string, detail?: string) => {
		terminal ??= new ReaderRefusal(stage, detail);
		return terminal;
	};
	const check = () => {
		if (terminal) throw terminal;
		const current = now();
		if (
			!Number.isFinite(start) ||
			!Number.isFinite(current) ||
			current < last ||
			current >= deadline
		)
			throw fail(
				"deadline",
				`${READER_DEADLINE_MS} ms reader deadline reached after ${Math.round(current - start)} ms`,
			);
		last = current;
		if (signal?.aborted) throw fail("aborted");
	};
	return Object.freeze({
		signal,
		get rawBytes() {
			return bytes;
		},
		check,
		remaining() {
			check();
			return deadline - now();
		},
		charge(size: number) {
			check();
			if (
				!Number.isSafeInteger(size) ||
				size < 0 ||
				!Number.isSafeInteger(bytes + size) ||
				bytes + size > READER_RAW_BYTE_LIMIT
			)
				throw fail("raw byte budget");
			bytes += size;
		},
		fail,
	});
}

interface ToolFiles {
	realpath(path: string): string;
	isFile(path: string): boolean;
	read(path: string): string;
	findNode(): string | null;
}
/** Check only the installed owning package; no package runner/download fallback. */
export function resolveInstalledReaderTools(
	root: string,
	files: ToolFiles,
): ReaderTools {
	let step = "realpath node_modules/wrangler";
	try {
		const packageRoot = files.realpath(join(root, "node_modules/wrangler"));
		step = "wrangler package.json name/bin";
		const pkg = JSON.parse(files.read(join(packageRoot, "package.json"))) as {
			name?: string;
			bin?: { wrangler?: string };
		};
		if (pkg.name !== "wrangler" || pkg.bin?.wrangler !== "./bin/wrangler.js")
			throw new Error();
		const expected = join(packageRoot, "bin/wrangler.js");
		step = "node_modules/.bin/wrangler resolves to the package entry";
		const wrangler = files.realpath(join(root, "node_modules/.bin/wrangler"));
		if (wrangler !== expected || !files.isFile(wrangler)) throw new Error();
		step = "executable node on PATH";
		const candidate = files.findNode();
		if (!candidate) throw new Error();
		const node = files.realpath(candidate);
		if (!files.isFile(node)) throw new Error();
		return Object.freeze({
			node,
			wrangler,
			config: join(root, "apps/api/wrangler.jsonc"),
		});
	} catch (failure) {
		const code = (failure as NodeJS.ErrnoException)?.code;
		throw new ReaderRefusal(
			"installed tools",
			`failed check: ${step}${typeof code === "string" ? ` (${code})` : ""}`,
		);
	}
}

function productionIo(): ReaderIo {
	return {
		platform: process.platform,
		now: () => performance.now(),
		setTimer: (callback, ms) => setTimeout(callback, ms),
		clearTimer: (handle) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
		resolveTools: () =>
			resolveInstalledReaderTools(
				fileURLToPath(new URL("../../", import.meta.url)),
				{
					realpath: realpathSync,
					isFile: (path) => statSync(path).isFile(),
					read: (path) => readFileSync(path, "utf8"),
					findNode: () => {
						for (const directory of (process.env.PATH ?? "").split(":")) {
							if (!directory) continue;
							const candidate = resolve(directory, "node");
							try {
								accessSync(candidate, constants.X_OK);
								if (statSync(candidate).isFile()) return candidate;
							} catch {
								/* Try the next existing executable only. */
							}
						}
						return null;
					},
				},
			),
		spawn: (argv) =>
			spawn(argv[0]!, argv.slice(1), {
				detached: true,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		killGroup: (pid, signal) => {
			process.kill(-pid, signal);
		},
		log: (line) => console.log(line),
		error: (line) => console.error(line),
		env: process.env,
	};
}

/** Executable basename plus subcommand words; never SQL or other argument values. */
function commandLabel(argv: readonly string[]): string {
	const executable = (path: string) => path.split("/").pop() ?? path;
	return [
		...argv.slice(0, 2).map(executable),
		...argv.slice(2, 4).filter((arg) => /^[a-z][a-z0-9-]*$/i.test(arg)),
	].join(" ");
}

/** A failure's errno code or name/message only, for a later redacted cause line. */
function errorCause(failure: unknown): string {
	if (!(failure instanceof Error)) return "non-Error failure";
	const code = (failure as NodeJS.ErrnoException).code;
	return `${typeof code === "string" ? `${code}: ` : ""}${failure.name}: ${failure.message}`;
}

/** Streams drain concurrently; success needs both EOFs and the owned close status. */
function collectCommand(
	argv: readonly string[],
	scope: ReaderScope,
	io: ReaderIo,
): Promise<string> {
	scope.check();
	if (io.platform === "win32") throw scope.fail("unsupported process groups");
	const command = Object.freeze([...argv]);
	const spawnChild = io.spawn.bind(io);
	const killGroup = io.killGroup.bind(io);
	const setTimer = io.setTimer.bind(io);
	const clearTimer = io.clearTimer.bind(io);
	return new Promise((resolveResult, reject) => {
		let child: ReaderChild;
		try {
			child = spawnChild(command);
		} catch (failure) {
			reject(scope.fail("spawn", errorCause(failure)));
			return;
		}
		const pid = child.pid;
		let terminal = false;
		let timer: unknown;
		let stdoutEnd = false;
		let stderrEnd = false;
		const chunks: string[] = [];
		// Bounded rolling tail of stderr, only ever printed (redacted) on refusal.
		let stderrTail = "";
		const keepTail = (text: string) => {
			stderrTail = (stderrTail + text).slice(-READER_DIAGNOSTIC_TAIL_CHARS);
		};
		const exitDetail = (code: number | null, signal: string | null) => {
			const stdoutTail = chunks.join("").slice(-READER_DIAGNOSTIC_TAIL_CHARS);
			return [
				`\`${commandLabel(command)}\` exited with code ${code ?? "none"}, signal ${signal ?? "none"}` +
					(stdoutEnd && stderrEnd
						? ""
						: `; streams ended: stdout=${stdoutEnd} stderr=${stderrEnd}`),
				stderrTail.trim() ? `stderr tail:\n${stderrTail}` : "stderr: (empty)",
				stdoutTail.trim() ? `stdout tail:\n${stdoutTail}` : "stdout: (empty)",
			].join("\n");
		};
		const outDecoder = new TextDecoder("utf-8", { fatal: true });
		const errDecoder = new TextDecoder("utf-8", { fatal: true });
		const cleanup = () => {
			clearTimer(timer);
			scope.signal?.removeEventListener("abort", onAbort);
		};
		const refuse = (stage: string, detail?: string) => {
			if (terminal) return;
			terminal = true;
			let error = scope.fail(stage, detail);
			cleanup();
			chunks.length = 0;
			child.stdout.destroy();
			child.stderr.destroy();
			if (Number.isSafeInteger(pid) && pid! > 0 && pid !== process.pid) {
				let confirmed = true;
				for (const signal of ["SIGTERM", "SIGKILL"] as const) {
					try {
						killGroup(pid!, signal);
					} catch (failure) {
						// ESRCH means the owned group is already absent.
						if ((failure as NodeJS.ErrnoException)?.code !== "ESRCH")
							confirmed = false;
					}
				}
				if (!confirmed)
					error = new ReaderRefusal(
						"cancellation unconfirmed",
						(error as ReaderRefusal).detail,
					);
			}
			reject(error);
		};
		const onAbort = () => refuse("aborted");
		const read = (chunk: unknown, decoder: TextDecoder, keep: boolean) => {
			if (terminal) return;
			try {
				if (!(chunk instanceof Uint8Array)) throw scope.fail("stream chunk");
				scope.charge(chunk.byteLength);
				const decoded = decoder.decode(chunk, { stream: true });
				if (keep) chunks.push(decoded);
				else keepTail(decoded);
			} catch {
				refuse("stream or byte budget");
			}
		};
		child.stdout.on("data", (chunk: unknown) => read(chunk, outDecoder, true));
		child.stderr.on("data", (chunk: unknown) => read(chunk, errDecoder, false));
		child.stdout.on("error", (failure) =>
			refuse("stdout", errorCause(failure)),
		);
		child.stderr.on("error", (failure) =>
			refuse("stderr", errorCause(failure)),
		);
		child.on("error", (failure) =>
			refuse("spawn", `\`${commandLabel(command)}\`: ${errorCause(failure)}`),
		);
		child.stdout.on("end", () => {
			if (terminal) return;
			try {
				scope.check();
				chunks.push(outDecoder.decode());
				stdoutEnd = true;
			} catch {
				refuse("stdout UTF8 or deadline");
			}
		});
		child.stderr.on("end", () => {
			if (terminal) return;
			try {
				scope.check();
				keepTail(errDecoder.decode());
				stderrEnd = true;
			} catch {
				refuse("stderr UTF8 or deadline");
			}
		});
		child.on("close", (code, signal) => {
			if (terminal) return;
			try {
				scope.check();
				if (code !== 0 || signal !== null || !stdoutEnd || !stderrEnd) {
					refuse(
						"child status or incomplete streams",
						exitDetail(code, signal),
					);
					return;
				}
				const output = chunks.join("");
				chunks.length = 0;
				scope.check();
				terminal = true;
				cleanup();
				resolveResult(output);
			} catch {
				refuse("deadline");
			}
		});
		if (!Number.isSafeInteger(pid) || pid! <= 0 || pid === process.pid) {
			refuse("missing owned PID");
			return;
		}
		try {
			scope.check();
			scope.signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimer(() => refuse("deadline"), scope.remaining());
		} catch {
			refuse("deadline or aborted");
		}
	});
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
interface D1Report {
	results: unknown[];
}
export async function executeD1(
	sql: string,
	scope: ReaderScope,
	io: ReaderIo,
	tools: ReaderTools,
): Promise<D1Report> {
	scope.check();
	const output = await collectCommand(
		[
			tools.node,
			tools.wrangler,
			"d1",
			"execute",
			D1_DB,
			"--remote",
			"--config",
			tools.config,
			"--json",
			"--command",
			sql,
		],
		scope,
		io,
	);
	scope.check();
	try {
		const parsed: unknown = JSON.parse(output);
		scope.check();
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 1 ||
			!record(parsed[0]) ||
			parsed[0].success !== true ||
			!Array.isArray(parsed[0].results) ||
			(Object.hasOwn(parsed[0], "error") && parsed[0].error !== null) ||
			(Object.hasOwn(parsed[0], "errors") &&
				(!Array.isArray(parsed[0].errors) || parsed[0].errors.length !== 0))
		)
			throw scope.fail("D1 result envelope");
		return { results: parsed[0].results };
	} catch {
		throw scope.fail("D1 JSON or envelope");
	}
}

interface D1ToolState {
	id: string;
	toolId: string;
	toolTypeId: string | null;
	schemaDialect: string | null;
	inputSchema: unknown;
	outputSchema: unknown;
	endpoint: string | null;
}
export const TOOL_SCHEMA_SELECT = `SELECT id, tool_id, tool_type_id, schema_dialect, json(input_schema) AS input_schema, json(output_schema) AS output_schema, json_extract(config, '$.endpoint') AS endpoint FROM app_tools WHERE app_id = ${TEDIX_APP_ID_SQL} AND json_extract(config, '$.transport') = 'rpc'`;
async function fetchD1Rows(
	scope: ReaderScope,
	io: ReaderIo,
	tools: ReaderTools,
): Promise<D1ToolState[]> {
	const parsed = await executeD1(TOOL_SCHEMA_SELECT, scope, io, tools);
	scope.check();
	return parsed.results.map((row) => {
		scope.check();
		if (
			!record(row) ||
			typeof row.id !== "string" ||
			typeof row.tool_id !== "string" ||
			![
				"tool_type_id",
				"schema_dialect",
				"input_schema",
				"output_schema",
				"endpoint",
			].every(
				(key) =>
					Object.hasOwn(row, key) &&
					(row[key] === null || typeof row[key] === "string"),
			)
		)
			throw scope.fail("SELECT row aliases");
		try {
			const value = {
				id: row.id,
				toolId: row.tool_id,
				toolTypeId: row.tool_type_id as string | null,
				schemaDialect: row.schema_dialect as string | null,
				inputSchema:
					row.input_schema === null
						? null
						: JSON.parse(row.input_schema as string),
				outputSchema:
					row.output_schema === null
						? null
						: JSON.parse(row.output_schema as string),
				endpoint: row.endpoint as string | null,
			};
			scope.check();
			return value;
		} catch {
			throw scope.fail("nested schema JSON");
		}
	});
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
		.join(",")}}`;
}

function diff(
	toolId: string,
	column: "inputSchema" | "outputSchema",
	expected: unknown,
	actual: unknown,
): string {
	return [
		`--- D1 ${column} (${toolId}) ----------------------------------------`,
		JSON.stringify(actual, null, 2),
		`+++ contract ${column} (${toolId}) ----------------------------------`,
		JSON.stringify(expected, null, 2),
	].join("\n");
}

function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function sqlJson(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	return sqlString(JSON.stringify(value));
}

async function deleteStaleRow(
	row: D1ToolState,
	execute: (sql: string) => Promise<D1Report>,
): Promise<void> {
	await execute(
		`DELETE FROM app_tools WHERE id = ${sqlString(row.id)} AND app_id = ${TEDIX_APP_ID_SQL}`,
	);
}

async function updateSchemaRow(
	row: D1ToolState,
	patch: {
		inputSchema?: unknown;
		outputSchema?: unknown;
		toolTypeId?: "rpc";
		schemaDialect?: "json-schema-2020-12";
	},
	execute: (sql: string) => Promise<D1Report>,
): Promise<void> {
	const assignments: string[] = [];
	if (patch.inputSchema !== undefined) {
		assignments.push(`input_schema = ${sqlJson(patch.inputSchema)}`);
	}
	if (patch.outputSchema !== undefined) {
		assignments.push(`output_schema = ${sqlJson(patch.outputSchema)}`);
	}
	if (patch.toolTypeId) {
		assignments.push(`tool_type_id = ${sqlString(patch.toolTypeId)}`);
	}
	if (patch.schemaDialect) {
		assignments.push(`schema_dialect = ${sqlString(patch.schemaDialect)}`);
	}
	assignments.push(`schema_source = 'orpc'`);
	if (row.endpoint) {
		assignments.push(`schema_source_ref = ${sqlString(row.endpoint)}`);
	}
	const now = new Date().toISOString();
	assignments.push(`schema_synced_at = ${sqlString(now)}`);
	assignments.push(`updated_at = ${sqlString(now)}`);

	await execute(
		`UPDATE app_tools SET ${assignments.join(", ")} WHERE id = ${sqlString(row.id)} AND app_id = ${TEDIX_APP_ID_SQL}`,
	);
}

export async function main(
	args: readonly string[] = process.argv.slice(2),
	primitiveIo: ReaderIo = productionIo(),
	signal?: AbortSignal,
): Promise<number> {
	// Capture collaborators/arguments before any await; neither is a mutable grant.
	const io: ReaderIo = Object.freeze(
		Object.fromEntries(
			Object.entries(primitiveIo).map(([key, value]) => [
				key,
				typeof value === "function" ? value.bind(primitiveIo) : value,
			]),
		) as unknown as ReaderIo,
	);
	const scope = createReaderScope(io, signal);
	const argv = [...args];
	const log = (line: string) => {
		scope.check();
		io.log(line);
	};
	const mode: "apply" | "check" | "dry-run" = argv.includes("--apply")
		? "apply"
		: argv.includes("--check")
			? "check"
			: "dry-run";
	const onlyArg = argv.find((arg) => arg.startsWith("--only="));
	const onlyFilter = onlyArg
		? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean))
		: null;
	try {
		scope.check();
		if (io.platform === "win32") throw scope.fail("unsupported process groups");
		const tools = Object.freeze({ ...(await io.resolveTools()) });
		scope.check();
		const version = await collectCommand([tools.node, "--version"], scope, io);
		scope.check();
		if (
			!/^v\d+\.\d+\.\d+\s*$/.test(version) ||
			Number(version.slice(1).split(".")[0]) < 22
		)
			throw scope.fail(
				"Node minimum 22",
				`${tools.node} reported ${JSON.stringify(version.trim().slice(0, 40))}`,
			);
		const execute = (sql: string) => executeD1(sql, scope, io, tools);
		scope.check();
		log(
			`# Sync tool schemas — mode: ${mode}${onlyFilter ? ` (filter: ${[...onlyFilter].join(",")})` : ""}\n`,
		);
		const rows = await fetchD1Rows(scope, io, tools);
		scope.check();
		const filtered = onlyFilter
			? rows.filter((row) => onlyFilter.has(row.toolId))
			: rows;

		const buckets = {
			inSync: [] as string[],
			missingSchema: [] as string[],
			realMismatch: [] as string[],
			converterUnsupported: [] as string[],
			noContract: [] as string[],
			missingProjection: [] as string[],
			typeDrift: [] as string[],
			ignored: [] as string[],
			applied: [] as string[],
		};

		if (!onlyFilter) {
			const rowEndpoints = new Set(
				rows
					.map((row) => row.endpoint)
					.filter((endpoint): endpoint is string => !!endpoint),
			);
			const contractEndpoints = new Set(
				listContractEndpoints({ includeInternal: true }).map(
					(endpoint) => `${endpoint.router}/${endpoint.procPath}`,
				),
			);
			for (const endpoint of REQUIRED_PROJECTION_ENDPOINTS) {
				scope.check();
				if (!contractEndpoints.has(endpoint)) {
					buckets.noContract.push(
						`required projection endpoint "${endpoint}" is not in the contract router`,
					);
				} else if (!rowEndpoints.has(endpoint)) {
					buckets.missingProjection.push(
						`required projection endpoint "${endpoint}" has no tedix admin app_tools row`,
					);
				}
			}
		}

		filtered.sort((a, b) => a.toolId.localeCompare(b.toolId));

		for (const row of filtered) {
			scope.check();
			if (!row.endpoint) {
				buckets.noContract.push(`${row.toolId}: config.endpoint is missing`);
				if (mode === "apply") {
					await deleteStaleRow(row, execute);
					scope.check();
					buckets.applied.push(
						`${row.toolId}: deleted missing-endpoint rpc row`,
					);
				}
				continue;
			}
			const lookup = resolveContractEndpoint(row.endpoint);
			if (!lookup) {
				buckets.noContract.push(
					`${row.toolId}: no contract proc at "${row.endpoint}"`,
				);
				if (mode === "apply") {
					await deleteStaleRow(row, execute);
					scope.check();
					buckets.applied.push(`${row.toolId}: deleted stale rpc row`);
				}
				continue;
			}
			const patch: Parameters<typeof updateSchemaRow>[1] = {};
			if (row.toolTypeId !== "rpc") {
				buckets.typeDrift.push(
					`${row.toolId}: tool_type_id=${row.toolTypeId ?? "NULL"} (expected rpc)`,
				);
				patch.toolTypeId = "rpc";
			}
			if (row.schemaDialect !== "json-schema-2020-12") {
				buckets.typeDrift.push(
					`${row.toolId}: schema_dialect=${row.schemaDialect ?? "NULL"} (expected json-schema-2020-12)`,
				);
				patch.schemaDialect = "json-schema-2020-12";
			}
			if (IGNORE_DRIFT[row.toolId]) {
				buckets.ignored.push(
					`${row.toolId}: ignored — ${IGNORE_DRIFT[row.toolId]}`,
				);
				continue;
			}

			let expectedInput: unknown;
			let expectedOutput: unknown;
			try {
				expectedInput = zodToToolInputJsonSchema(lookup.inputSchema);
				expectedOutput = zodToStructuredOutputJsonSchema(lookup.outputSchema);
			} catch {
				buckets.converterUnsupported.push(
					`${row.toolId}: schema conversion unsupported at "${row.endpoint}"`,
				);
				continue;
			}

			let toolInSync = true;
			if (row.inputSchema === null) {
				buckets.missingSchema.push(`${row.toolId}: inputSchema`);
				patch.inputSchema = expectedInput;
				toolInSync = false;
			} else if (
				stableStringify(expectedInput) !== stableStringify(row.inputSchema)
			) {
				log(diff(row.toolId, "inputSchema", expectedInput, row.inputSchema));
				log("");
				buckets.realMismatch.push(`${row.toolId}: inputSchema`);
				patch.inputSchema = expectedInput;
				toolInSync = false;
			}

			if (expectedOutput !== null) {
				if (row.outputSchema === null) {
					buckets.missingSchema.push(`${row.toolId}: outputSchema`);
					patch.outputSchema = expectedOutput;
					toolInSync = false;
				} else if (
					stableStringify(expectedOutput) !== stableStringify(row.outputSchema)
				) {
					log(
						diff(row.toolId, "outputSchema", expectedOutput, row.outputSchema),
					);
					log("");
					buckets.realMismatch.push(`${row.toolId}: outputSchema`);
					patch.outputSchema = expectedOutput;
					toolInSync = false;
				}
			}

			if (mode === "apply" && Object.keys(patch).length > 0) {
				await updateSchemaRow(row, patch, execute);
				scope.check();
				buckets.applied.push(
					`${row.toolId}: updated ${Object.keys(patch).join(", ")}`,
				);
			}

			if (toolInSync) buckets.inSync.push(row.toolId);
		}

		scope.check();
		const printBucket = (label: string, items: string[]) => {
			if (!items.length) return;
			log(`\n# ${label} (${items.length})`);
			for (const item of items) {
				scope.check();
				log(`  ${item}`);
			}
		};

		printBucket("missingSchema", buckets.missingSchema);
		printBucket("realMismatch", buckets.realMismatch);
		printBucket("converterUnsupported", buckets.converterUnsupported);
		printBucket("noContract", buckets.noContract);
		printBucket("missingProjection", buckets.missingProjection);
		printBucket("typeDrift", buckets.typeDrift);
		printBucket("ignored", buckets.ignored);
		printBucket("applied", buckets.applied);

		log(
			`\nSummary: ${buckets.inSync.length} in sync | ${buckets.missingSchema.length} missingSchema | ${buckets.realMismatch.length} realMismatch | ${buckets.converterUnsupported.length} converterUnsupported | ${buckets.noContract.length} noContract | ${buckets.missingProjection.length} missingProjection | ${buckets.typeDrift.length} typeDrift | ${buckets.ignored.length} ignored — over ${filtered.length} rpc-transport tools on tedix admin app`,
		);

		if (mode === "apply") {
			const unrepairable =
				buckets.converterUnsupported.length + buckets.missingProjection.length;
			if (unrepairable > 0) {
				io.error(
					`\nApply finished with ${unrepairable} unrepairable schema issue(s).`,
				);
				return 1;
			}
			log("\nApply complete. Rerun --check to verify D1 state.");
			scope.check();
			return 0;
		}

		if (mode !== "check") {
			scope.check();
			return 0;
		}

		const failing =
			buckets.missingSchema.length +
			buckets.realMismatch.length +
			buckets.converterUnsupported.length +
			buckets.noContract.length +
			buckets.missingProjection.length +
			buckets.typeDrift.length;
		if (failing > 0) {
			io.error(
				`\nDrift detected. Fix through the ToolSchemaSyncWorkflow exposed by Tedix admin MCP (tool.run_tool_schema_sync). For intentionally removed oRPC endpoints, run schema sync with pruneStale=true.`,
			);
			return 1;
		}

		scope.check();
		log("\nCheck passed: no tool schema drift.");

		scope.check();
		return 0;
	} catch (error) {
		// The first line is always a fixed stage; unexpected errors map to "execution".
		const fixed =
			error instanceof Error &&
			/^Schema reader refused: [A-Za-z0-9 -]+\.$/.test(error.message);
		io.error(fixed ? error.message : "Schema reader refused: execution.");
		// The cause (exit status, child output tail, unexpected error) is printed
		// redacted and bounded so a failed deploy step is diagnosable.
		const detail =
			error instanceof ReaderRefusal ? error.detail : errorCause(error);
		// Each child stream tail is already bounded; this caps the whole cause.
		if (detail)
			io.error(
				`Cause: ${redactDiagnostic(detail, io.env, 3 * READER_DIAGNOSTIC_TAIL_CHARS + 1_000)}`,
			);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await main();
