import {
	exitForDrizzleKitError,
	requireOk,
	runDrizzleKit,
	type DrizzleKitResponse,
} from "./drizzle-kit-command";

export function assertMigrationHistoryConsistent(
	response: DrizzleKitResponse,
): void {
	requireOk(response, "Drizzle migration history check");
}

export function checkMigrationHistory(): void {
	const response = runDrizzleKit(["check"]);
	assertMigrationHistoryConsistent(response);
	console.log("Drizzle migration history is consistent");
}

if (import.meta.main) {
	try {
		checkMigrationHistory();
	} catch (error) {
		exitForDrizzleKitError(error);
	}
}
