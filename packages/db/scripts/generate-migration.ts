import {
	DrizzleKitCommandError,
	exitForDrizzleKitError,
	requireNoChanges,
	runDrizzleKit,
	type DrizzleKitResponse,
} from "./drizzle-kit-command";
import { syncMigrationIntegrity } from "./migration-integrity";

export function finishMigrationGeneration(
	response: DrizzleKitResponse,
	mode: "check" | "generate",
	sync: typeof syncMigrationIntegrity = syncMigrationIntegrity,
): string[] {
	if (mode === "check") {
		requireNoChanges(response, "Drizzle schema snapshot check");
		return sync("check").migrations.map(({ name }) => name);
	}

	if (response.status === "missing_hints") {
		throw new DrizzleKitCommandError(
			`Migration generation needs hints:\n${JSON.stringify(response.unresolved, null, 2)}`,
			2,
		);
	}
	if (response.status === "error") {
		throw new DrizzleKitCommandError(
			`Migration generation failed (${response.error.code}):\n${JSON.stringify(response.error, null, 2)}`,
		);
	}
	if (response.status === "ok" && !response.migration_path) {
		throw new DrizzleKitCommandError(
			"Migration generation returned ok without a migration_path",
		);
	}

	return sync("draft").migrations.map(({ name }) => name);
}

export function generateMigration(argv: string[]): void {
	const check = argv.includes("--check");
	const drizzleArgs = argv.filter((arg) => arg !== "--check");
	if (
		drizzleArgs.some((arg) => arg === "--explain" || arg.startsWith("--output"))
	) {
		throw new DrizzleKitCommandError(
			"Use --check for dry runs; output mode is fixed to machine-readable JSON",
		);
	}

	// Validate recorded history before Drizzle can create any draft files.
	if (!check) syncMigrationIntegrity("draft");
	const response = runDrizzleKit([
		"generate",
		...drizzleArgs,
		...(check ? ["--explain"] : []),
	]);
	const files = finishMigrationGeneration(
		response,
		check ? "check" : "generate",
	);

	if (check) {
		console.log(
			`Drizzle schema snapshot is current; migration integrity matches (${files.length} migration(s))`,
		);
	} else if (response.status === "no_changes") {
		console.log(
			`No Drizzle schema changes; recorded history verified (${files.length} migration(s)). Pending drafts remain unrecorded; review them before bun scripts/migration-integrity.ts --write`,
		);
	} else {
		console.log(
			`Generated unrecorded draft ${response.migration_path}; review SQL and snapshot, then run bun scripts/migration-integrity.ts --write`,
		);
	}
}

if (import.meta.main) {
	try {
		generateMigration(process.argv.slice(2));
	} catch (error) {
		exitForDrizzleKitError(error);
	}
}
