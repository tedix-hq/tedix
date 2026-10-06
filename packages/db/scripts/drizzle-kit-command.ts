import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export type DrizzleKitResponse =
	| {
			status: "ok";
			dialect: string;
			migration_path?: string;
			statements?: unknown[];
			hints?: unknown[];
	  }
	| { status: "no_changes"; dialect: string }
	| { status: "missing_hints"; unresolved: unknown[] }
	| { status: "error"; error: { code: string; [key: string]: unknown } };

export class DrizzleKitCommandError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "DrizzleKitCommandError";
		this.exitCode = exitCode;
	}
}

const DB_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

export function parseDrizzleKitResponse(stdout: string): DrizzleKitResponse {
	const payload = stdout.trim();
	if (!payload) {
		throw new DrizzleKitCommandError(
			"Drizzle Kit returned an empty machine-readable response",
		);
	}

	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch (error) {
		throw new DrizzleKitCommandError(
			`Drizzle Kit returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!isRecord(value) || typeof value.status !== "string") {
		throw new DrizzleKitCommandError(
			"Drizzle Kit response is missing a status discriminator",
		);
	}

	switch (value.status) {
		case "ok":
			if (typeof value.dialect !== "string") {
				throw new DrizzleKitCommandError(
					"Drizzle Kit ok response is missing dialect",
				);
			}
			if (
				value.migration_path !== undefined &&
				typeof value.migration_path !== "string"
			) {
				throw new DrizzleKitCommandError(
					"Drizzle Kit migration_path must be a string",
				);
			}
			if (value.statements !== undefined && !Array.isArray(value.statements)) {
				throw new DrizzleKitCommandError(
					"Drizzle Kit statements must be an array",
				);
			}
			if (value.hints !== undefined && !Array.isArray(value.hints)) {
				throw new DrizzleKitCommandError("Drizzle Kit hints must be an array");
			}
			return value as DrizzleKitResponse;
		case "no_changes":
			if (typeof value.dialect !== "string") {
				throw new DrizzleKitCommandError(
					"Drizzle Kit no_changes response is missing dialect",
				);
			}
			return value as DrizzleKitResponse;
		case "missing_hints":
			if (!Array.isArray(value.unresolved)) {
				throw new DrizzleKitCommandError(
					"Drizzle Kit missing_hints response is missing unresolved decisions",
					2,
				);
			}
			return value as DrizzleKitResponse;
		case "error":
			if (!isRecord(value.error) || typeof value.error.code !== "string") {
				throw new DrizzleKitCommandError(
					"Drizzle Kit error response is missing an error code",
				);
			}
			return value as DrizzleKitResponse;
		default:
			throw new DrizzleKitCommandError(
				`Drizzle Kit returned unknown status ${JSON.stringify(value.status)}`,
			);
	}
}

export function expectedExitCode(response: DrizzleKitResponse): number {
	switch (response.status) {
		case "ok":
		case "no_changes":
			return 0;
		case "error":
			return 1;
		case "missing_hints":
			return 2;
	}
}

export function assertMatchingExitCode(
	response: DrizzleKitResponse,
	actual: number | null,
): void {
	const expected = expectedExitCode(response);
	if (actual !== expected) {
		throw new DrizzleKitCommandError(
			`Drizzle Kit status ${response.status} requires exit ${expected}, received ${String(actual)}`,
		);
	}
}

/**
 * Diagnostic rerun without `--output json`, used only after a silent-empty
 * JSON-mode failure. Returns the bounded tail of whatever the human mode
 * printed (there, drift statements and real errors DO surface), or null when
 * even the rerun says nothing. Never throws — this path exists purely to make
 * the original failure explainable.
 */
function runDrizzleKitHumanFallback(args: string[]): string | null {
	try {
		const rerun = spawnSync(
			process.execPath,
			["run", "--silent", "drizzle-kit", "--", ...args],
			{
				cwd: DB_ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const combined = `${rerun.stdout ?? ""}\n${rerun.stderr ?? ""}`
			.replace(/\[[0-9;]*[A-Za-z]/g, "")
			.trim();
		if (!combined) return null;
		const lines = combined.split("\n").filter((line) => line.trim());
		return lines.slice(-25).join("\n");
	} catch {
		return null;
	}
}

export function runDrizzleKit(args: string[]): DrizzleKitResponse {
	const result = spawnSync(
		process.execPath,
		["run", "--silent", "drizzle-kit", "--", ...args, "--output", "json"],
		{
			cwd: DB_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	if (result.error) {
		throw new DrizzleKitCommandError(
			`Unable to run the project-installed Drizzle Kit: ${result.error.message}`,
		);
	}

	let response: DrizzleKitResponse;
	try {
		response = parseDrizzleKitResponse(result.stdout ?? "");
	} catch (error) {
		const stderr = result.stderr?.trim();
		if (stderr && error instanceof Error) {
			throw new DrizzleKitCommandError(`${error.message}\n${stderr}`);
		}
		// Drizzle Kit RC can exit non-zero under `--output json` with nothing on
		// either stream (for example, a schema table with no applied migration).
		// Rerun without --output json and surface the human-readable tail so the
		// error names the cause.
		if (
			!(result.stdout ?? "").trim() &&
			!stderr &&
			typeof result.status === "number" &&
			result.status !== 0
		) {
			const humanTail = runDrizzleKitHumanFallback(args);
			if (humanTail) {
				throw new DrizzleKitCommandError(
					`Drizzle Kit --output json exited ${result.status} with no output. Human-mode rerun says:\n${humanTail}`,
					result.status,
				);
			}
		}
		throw error;
	}

	assertMatchingExitCode(response, result.status);

	return response;
}

/**
 * Render one planned statement for an operator reading a drift failure.
 *
 * Drizzle Kit emits statements as strings in some shapes and as objects
 * (`{sql, ...}`, or a structured kind with no sql at all) in others. `String()`
 * on the object shapes yields `[object Object]`, which turns the one line that
 * says WHAT drifted into noise — the exact opposite of what a drift report is
 * for. Prefer the `sql` field, fall back to the whole object as JSON so a
 * structured statement still names itself.
 */
function renderDriftStatement(statement: unknown): string {
	if (typeof statement === "string") return statement;
	if (isRecord(statement) && typeof statement.sql === "string") {
		return statement.sql;
	}
	try {
		return JSON.stringify(statement);
	} catch {
		return String(statement);
	}
}

export function requireNoChanges(
	response: DrizzleKitResponse,
	context: string,
): void {
	switch (response.status) {
		case "no_changes":
			return;
		case "ok": {
			const statements = response.statements ?? [];
			const details =
				statements.length > 0
					? `\n${statements.map(renderDriftStatement).join("\n")}`
					: "";
			throw new DrizzleKitCommandError(
				`${context} detected ${statements.length} pending SQL statement(s).${details}`,
			);
		}
		case "missing_hints":
			throw new DrizzleKitCommandError(
				`${context} needs migration hints:\n${JSON.stringify(response.unresolved, null, 2)}`,
				2,
			);
		case "error":
			throw new DrizzleKitCommandError(
				`${context} failed (${response.error.code}):\n${JSON.stringify(response.error, null, 2)}`,
			);
	}
}

export function requireOk(response: DrizzleKitResponse, context: string): void {
	switch (response.status) {
		case "ok":
			return;
		case "no_changes":
			throw new DrizzleKitCommandError(
				`${context} returned no_changes instead of the required ok status`,
			);
		case "missing_hints":
			throw new DrizzleKitCommandError(
				`${context} needs migration hints:\n${JSON.stringify(response.unresolved, null, 2)}`,
				2,
			);
		case "error":
			throw new DrizzleKitCommandError(
				`${context} failed (${response.error.code}):\n${JSON.stringify(response.error, null, 2)}`,
			);
	}
}

export function exitForDrizzleKitError(error: unknown): never {
	const commandError =
		error instanceof DrizzleKitCommandError
			? error
			: new DrizzleKitCommandError(
					error instanceof Error ? error.message : String(error),
				);
	console.error(commandError.message);
	process.exit(commandError.exitCode);
}
