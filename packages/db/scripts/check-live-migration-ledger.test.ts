import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkLiveMigrationLedger,
	compareMigrationLedger,
	D1_DATABASE_NAME,
	parseAppliedMigrationNames,
	readMigrationManifest,
	withD1LedgerReadRetry,
} from "./check-live-migration-ledger";
import { parseWranglerJson, runWrangler } from "./wrangler-command";

describe("live D1 migration ledger", () => {
	const expected = ["a/migration.sql", "b/migration.sql"];

	it("Wrangler resolves DB when the installation uses its own database name", () => {
		const directory = mkdtempSync(join(tmpdir(), "tedix-db-binding-"));
		const configPath = join(directory, "wrangler.jsonc");
		try {
			writeFileSync(
				configPath,
				JSON.stringify({
					name: "acme-installation",
					d1_databases: [
						{
							binding: "DB",
							database_name: "acme-own-database",
							database_id: "00000000-0000-4000-8000-000000000001",
						},
					],
				}),
			);
			const result = parseWranglerJson(
				runWrangler(
					[
						"d1",
						"execute",
						D1_DATABASE_NAME,
						"--local",
						"--config",
						configPath,
						"--persist-to",
						join(directory, "state"),
						"--command",
						"SELECT 1 AS binding_resolved",
						"--json",
					],
					{ env: { WRANGLER_SEND_METRICS: "false" } },
				),
				"local binding proof",
			);
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						success: true,
						results: [{ binding_resolved: 1 }],
					}),
				]),
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reads the installation's configured DB binding with an explicit config", () => {
		const commands: string[][] = [];
		const result = checkLiveMigrationLedger({
			allowPending: true,
			manifest: readMigrationManifest(),
			run: (args) => {
				commands.push(args);
				return JSON.stringify([{ success: true, results: [] }]);
			},
		});
		expect(result.appliedCount).toBe(0);
		expect(commands).toEqual([
			[
				"d1",
				"execute",
				"DB",
				"--remote",
				"--config",
				"wrangler.jsonc",
				"--command",
				"SELECT name FROM tedix_drizzle_migrations ORDER BY id",
				"--json",
			],
		]);
	});

	it("accepts an exact ledger and an allowed prefix", () => {
		expect(compareMigrationLedger(expected, expected, false)).toEqual({
			appliedCount: 2,
			pending: [],
		});
		expect(compareMigrationLedger(expected, [expected[0]!], true)).toEqual({
			appliedCount: 1,
			pending: [expected[1]],
		});
	});

	it("rejects unknown, reordered, and unallowed pending entries", () => {
		expect(() => compareMigrationLedger(expected, ["unknown"], true)).toThrow(
			"diverged",
		);
		expect(() => compareMigrationLedger(expected, [], false)).toThrow(
			"pending migration",
		);
	});

	it("parses Wrangler's strict D1 JSON envelope", () => {
		expect(
			parseAppliedMigrationNames([
				{ success: true, results: [{ name: expected[0] }] },
			]),
		).toEqual([expected[0]]);
		expect(() =>
			parseAppliedMigrationNames([{ success: false, results: [] }]),
		).toThrow("did not succeed");
	});

	it("retries bounded D1 CPU resets with exponential delays", () => {
		let calls = 0;
		const delays: number[] = [];
		const result = withD1LedgerReadRetry(
			() => {
				calls++;
				if (calls < 3) throw new Error("D1 reset [code: 7429]");
				return "ok";
			},
			{ wait: (delayMs) => delays.push(delayMs) },
		);

		expect(result).toBe("ok");
		expect(calls).toBe(3);
		expect(delays).toEqual([1_000, 2_000]);
	});

	it("does not retry non-transient ledger failures", () => {
		let calls = 0;
		expect(() =>
			withD1LedgerReadRetry(
				() => {
					calls++;
					throw new Error("authentication failed");
				},
				{ wait: () => undefined },
			),
		).toThrow("authentication failed");
		expect(calls).toBe(1);
	});
});
