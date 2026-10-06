import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	compareMigrationLedger,
	D1_MIGRATIONS_TABLE,
	readMigrationManifest,
} from "./check-live-migration-ledger";
import { parseWranglerJson, runWrangler } from "./wrangler-command";
import { isRecord } from "@tedix/api-contract/utils/is-record";

function successfulResults(
	payload: unknown[],
	index: number,
	context: string,
): unknown[] {
	const result = payload[index];
	if (
		!isRecord(result) ||
		result.success !== true ||
		!Array.isArray(result.results)
	) {
		throw new Error(`${context} did not succeed`);
	}
	return result.results;
}

export function assertLocalMigrationInspection(
	payload: unknown,
	expectedNames: string[],
): void {
	if (!Array.isArray(payload) || payload.length !== 2) {
		throw new Error(
			"Local D1 migration inspection returned an unexpected envelope",
		);
	}
	const names = successfulResults(
		payload,
		0,
		"Local migration ledger query",
	).map((row, index) => {
		if (!isRecord(row) || typeof row.name !== "string") {
			throw new Error(`Local migration ledger row ${index} is invalid`);
		}
		return row.name;
	});
	compareMigrationLedger(expectedNames, names, false);

	const foreignKeys = successfulResults(payload, 1, "PRAGMA foreign_key_check");
	if (foreignKeys.length > 0) {
		throw new Error(
			`PRAGMA foreign_key_check found ${foreignKeys.length} violation(s)`,
		);
	}
}

/**
 * Addressed by binding, not database name: the chain runs against a throwaway
 * local store, and a public installation renames the database.
 */
const D1_BINDING = "DB";

export function checkD1MigrationChain(): void {
	const manifest = readMigrationManifest();
	const expectedNames = manifest.migrations.map(({ name }) => name);
	const persistencePath = mkdtempSync(path.join(tmpdir(), "tedix-d1-chain-"));
	try {
		runWrangler(
			[
				"d1",
				"migrations",
				"apply",
				D1_BINDING,
				"--local",
				"--persist-to",
				persistencePath,
				"--config",
				"wrangler.jsonc",
			],
			{ env: { CI: "1" } },
		);
		const inspection = runWrangler([
			"d1",
			"execute",
			D1_BINDING,
			"--local",
			"--persist-to",
			persistencePath,
			"--config",
			"wrangler.jsonc",
			"--command",
			`SELECT name FROM ${D1_MIGRATIONS_TABLE} ORDER BY id; PRAGMA foreign_key_check;`,
			"--json",
		]);
		assertLocalMigrationInspection(
			parseWranglerJson(inspection, "Local D1 migration inspection"),
			expectedNames,
		);
		console.log(
			`Full D1 migration chain passed (${expectedNames.length} applied; foreign keys valid)`,
		);
	} finally {
		rmSync(persistencePath, { recursive: true, force: true });
	}
}

if (import.meta.main) checkD1MigrationChain();
