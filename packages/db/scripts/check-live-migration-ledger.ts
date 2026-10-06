import { appendFileSync } from "node:fs";
import {
	parseMigrationIntegrityManifest,
	type MigrationIntegrityManifest,
} from "./migration-integrity";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWranglerJson, runWrangler } from "./wrangler-command";
import { isRecord } from "@tedix/api-contract/utils/is-record";

// Resolve the installation's database through its explicit Wrangler binding.
export const D1_DATABASE_NAME = "DB";
export const D1_MIGRATIONS_TABLE = "tedix_drizzle_migrations";

const DB_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const MANIFEST_PATH = path.join(DB_ROOT, "migration-integrity.json");
const D1_CPU_RESET_CODE = /(?:code:\s*7429|\[code:\s*7429\])/i;
const D1_LEDGER_READ_ATTEMPTS = 4;

function waitSynchronously(delayMs: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

export function withD1LedgerReadRetry<T>(
	operation: () => T,
	options: {
		attempts?: number;
		wait?: (delayMs: number) => void;
	} = {},
): T {
	const attempts = options.attempts ?? D1_LEDGER_READ_ATTEMPTS;
	const wait = options.wait ?? waitSynchronously;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return operation();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!D1_CPU_RESET_CODE.test(message) || attempt === attempts) {
				throw error;
			}
			const delayMs = 1_000 * 2 ** (attempt - 1);
			console.warn(
				`D1 reset migration ledger read with code 7429; retrying in ${delayMs}ms (attempt ${attempt + 1}/${attempts})`,
			);
			wait(delayMs);
		}
	}
	throw new Error("D1 migration ledger retry loop exited unexpectedly");
}

export function parseAppliedMigrationNames(payload: unknown): string[] {
	if (!Array.isArray(payload) || payload.length !== 1) {
		throw new Error(
			"D1 migration ledger query returned an unexpected envelope",
		);
	}
	const result = payload[0];
	if (
		!isRecord(result) ||
		result.success !== true ||
		!Array.isArray(result.results)
	) {
		throw new Error("D1 migration ledger query did not succeed");
	}
	return result.results.map((row, index) => {
		if (!isRecord(row) || typeof row.name !== "string") {
			throw new Error(`D1 migration ledger row ${index} has no string name`);
		}
		return row.name;
	});
}

export function compareMigrationLedger(
	expected: string[],
	applied: string[],
	allowPending: boolean,
): { appliedCount: number; pending: string[] } {
	for (const [index, name] of applied.entries()) {
		if (expected[index] !== name) {
			throw new Error(
				`Live D1 migration ledger diverged at position ${index}: expected ${expected[index] ?? "<none>"}, found ${name}`,
			);
		}
	}
	const pending = expected.slice(applied.length);
	if (!allowPending && pending.length > 0) {
		throw new Error(
			`Live D1 has ${pending.length} pending migration(s): ${pending.join(", ")}`,
		);
	}
	return { appliedCount: applied.length, pending };
}

export function readMigrationManifest(
	manifestPath = MANIFEST_PATH,
): MigrationIntegrityManifest {
	return parseMigrationIntegrityManifest(readFileSync(manifestPath, "utf8"));
}

export function checkLiveMigrationLedger(options: {
	allowPending: boolean;
	run?: typeof runWrangler;
	manifest?: MigrationIntegrityManifest;
}): { appliedCount: number; pending: string[] } {
	const manifest = options.manifest ?? readMigrationManifest();
	const command = options.run ?? runWrangler;
	const stdout = withD1LedgerReadRetry(() =>
		command([
			"d1",
			"execute",
			D1_DATABASE_NAME,
			"--remote",
			"--config",
			"wrangler.jsonc",
			"--command",
			`SELECT name FROM ${D1_MIGRATIONS_TABLE} ORDER BY id`,
			"--json",
		]),
	);
	const applied = parseAppliedMigrationNames(
		parseWranglerJson(stdout, "D1 migration ledger query"),
	);
	return compareMigrationLedger(
		manifest.migrations.map(({ name }) => name),
		applied,
		options.allowPending,
	);
}

if (import.meta.main) {
	const allowPending = process.argv.includes("--allow-pending");
	const result = checkLiveMigrationLedger({ allowPending });
	const output = process.env.GITHUB_OUTPUT;
	if (output)
		appendFileSync(output, `pending-count=${result.pending.length}\n`);
	console.log(
		`Live D1 migration ledger is ${result.pending.length === 0 ? "current" : "a valid prefix"} (${result.appliedCount} applied, ${result.pending.length} pending)`,
	);
}
