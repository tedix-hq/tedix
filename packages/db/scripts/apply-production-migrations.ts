import { appendFileSync } from "node:fs";
import {
	checkLiveMigrationLedger,
	D1_DATABASE_NAME,
} from "./check-live-migration-ledger";
import { parseWranglerJson, runWrangler } from "./wrangler-command";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export function parseTimeTravelBookmark(payload: unknown): string {
	if (
		!isRecord(payload) ||
		typeof payload.bookmark !== "string" ||
		!payload.bookmark
	) {
		throw new Error("D1 Time Travel response is missing a bookmark");
	}
	return payload.bookmark;
}

export function assertD1ExecutionSucceeded(
	payload: unknown,
	context: string,
): void {
	if (
		!Array.isArray(payload) ||
		payload.length === 0 ||
		payload.some((result) => !isRecord(result) || result.success !== true)
	) {
		throw new Error(`${context} did not return a successful D1 result`);
	}
}

function appendMigrationSummary(lines: string[]): void {
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary) appendFileSync(summary, `${lines.join("\n")}\n`);
}

export function applyProductionMigrations(
	options: { run?: typeof runWrangler } = {},
): void {
	const run = options.run ?? runWrangler;
	const before = checkLiveMigrationLedger({
		allowPending: true,
		run,
	});
	if (before.pending.length === 0) {
		appendMigrationSummary([
			"### D1 migrations",
			"",
			"No pending migrations; production ledger was already current.",
		]);
		console.log("Production D1 migration ledger is already current");
		return;
	}

	const bookmark = parseTimeTravelBookmark(
		parseWranglerJson(
			run([
				"d1",
				"time-travel",
				"info",
				D1_DATABASE_NAME,
				"--config",
				"wrangler.jsonc",
				"--json",
			]),
			"D1 Time Travel info",
		),
	);
	appendMigrationSummary([
		"### D1 migration recovery point",
		"",
		`- Pending migrations: ${before.pending.length}`,
		`- Pre-migration Time Travel bookmark: \`${bookmark}\``,
		`- Restore command (cwd packages/db): \`wrangler d1 time-travel restore ${D1_DATABASE_NAME} --config wrangler.jsonc --bookmark ${bookmark}\``,
	]);
	console.log(
		`Captured pre-migration Time Travel bookmark ${bookmark} for ${before.pending.length} migration(s)`,
	);

	const applyOutput = run(
		[
			"d1",
			"migrations",
			"apply",
			D1_DATABASE_NAME,
			"--remote",
			"--config",
			"wrangler.jsonc",
		],
		{ env: { CI: "1" } },
	);
	if (applyOutput) console.log(applyOutput);

	const optimize = parseWranglerJson(
		run([
			"d1",
			"execute",
			D1_DATABASE_NAME,
			"--remote",
			"--config",
			"wrangler.jsonc",
			"--command",
			"PRAGMA optimize",
			"--json",
		]),
		"D1 PRAGMA optimize",
	);
	assertD1ExecutionSucceeded(optimize, "D1 PRAGMA optimize");
	const after = checkLiveMigrationLedger({
		allowPending: false,
		run,
	});
	appendMigrationSummary([
		"",
		`Applied ${before.pending.length} migration(s), ran \`PRAGMA optimize\`, and verified ${after.appliedCount} immutable ledger entries.`,
	]);
	console.log(
		`Production D1 migration complete (${after.appliedCount} applied); PRAGMA optimize succeeded`,
	);
}

if (import.meta.main) applyProductionMigrations();
