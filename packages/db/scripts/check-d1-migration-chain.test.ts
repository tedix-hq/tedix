import { describe, expect, it } from "vite-plus/test";
import { assertLocalMigrationInspection } from "./check-d1-migration-chain";

describe("full D1 migration-chain inspection", () => {
	const names = ["a/migration.sql", "b/migration.sql"];
	const valid = [
		{ success: true, results: names.map((name) => ({ name })) },
		{ success: true, results: [] },
	];

	it("requires the exact ledger and no FK violations", () => {
		expect(() => assertLocalMigrationInspection(valid, names)).not.toThrow();
		expect(() =>
			assertLocalMigrationInspection(
				[valid[0], { success: true, results: [{ table: "x" }] }],
				names,
			),
		).toThrow("foreign_key_check");
	});
});
