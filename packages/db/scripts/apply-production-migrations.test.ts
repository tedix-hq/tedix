import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyProductionMigrations,
	assertD1ExecutionSucceeded,
	parseTimeTravelBookmark,
} from "./apply-production-migrations";
import { readMigrationManifest } from "./check-live-migration-ledger";

describe("production D1 migration orchestration", () => {
	it("uses the configured binding for recovery, apply, optimize and ledger checks", () => {
		const directory = mkdtempSync(join(tmpdir(), "tedix-migration-summary-"));
		const summaryPath = join(directory, "summary.md");
		const previousSummary = process.env.GITHUB_STEP_SUMMARY;
		process.env.GITHUB_STEP_SUMMARY = summaryPath;
		const names = readMigrationManifest().migrations.map(({ name }) => name);
		const commands: string[][] = [];
		let ledgerReads = 0;
		try {
			applyProductionMigrations({
				run: (args) => {
					commands.push(args);
					if (
						args.includes(
							"SELECT name FROM tedix_drizzle_migrations ORDER BY id",
						)
					) {
						const applied = ledgerReads++ === 0 ? names.slice(0, -1) : names;
						return JSON.stringify([
							{ success: true, results: applied.map((name) => ({ name })) },
						]);
					}
					if (args[1] === "time-travel")
						return JSON.stringify({ bookmark: "bookmark-1" });
					if (args.includes("PRAGMA optimize"))
						return JSON.stringify([{ success: true, results: [] }]);
					return "";
				},
			});
			expect(commands.map((args) => args.slice(0, 3))).toEqual([
				["d1", "execute", "DB"],
				["d1", "time-travel", "info"],
				["d1", "migrations", "apply"],
				["d1", "execute", "DB"],
				["d1", "execute", "DB"],
			]);
			expect(commands[1]?.[3]).toBe("DB");
			expect(commands[2]?.[3]).toBe("DB");
			for (const args of commands) {
				expect(args[args.indexOf("--config") + 1]).toBe("wrangler.jsonc");
			}
			expect(readFileSync(summaryPath, "utf8")).toContain(
				"wrangler d1 time-travel restore DB --config wrangler.jsonc --bookmark bookmark-1",
			);
		} finally {
			if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
			else process.env.GITHUB_STEP_SUMMARY = previousSummary;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("requires a Time Travel bookmark", () => {
		expect(parseTimeTravelBookmark({ bookmark: "bookmark-1" })).toBe(
			"bookmark-1",
		);
		expect(() => parseTimeTravelBookmark({})).toThrow("missing a bookmark");
	});

	it("requires successful D1 execution envelopes", () => {
		expect(() =>
			assertD1ExecutionSucceeded([{ success: true, results: [] }], "optimize"),
		).not.toThrow();
		expect(() =>
			assertD1ExecutionSucceeded([{ success: false }], "optimize"),
		).toThrow("did not return a successful");
	});
});
