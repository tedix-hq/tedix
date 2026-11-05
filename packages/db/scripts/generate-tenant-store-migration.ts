/**
 * Generate or check the TenantStore Durable Object migration chain.
 *
 * Drizzle Kit's durable-sqlite output imports each `migration.sql` from a
 * `migrations.js`, which needs a Text-module bundler rule in every Worker and
 * test pool that loads it. This script renders the same chain into
 * `src/tenant-store/migrations.ts` with the SQL inlined instead.
 *
 *   bun scripts/generate-tenant-store-migration.ts --name <change>
 *   bun scripts/generate-tenant-store-migration.ts --check
 */
import { rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DrizzleKitCommandError,
	exitForDrizzleKitError,
	requireNoChanges,
	runDrizzleKit,
} from "./drizzle-kit-command";
import {
	readTenantStoreMigrationFiles,
	renderTenantStoreMigrations,
} from "./tenant-store-migrations";

const dbRoot = fileURLToPath(new URL("../", import.meta.url));
const config = "drizzle.tenant-store.config.ts";
const migrationDir = path.join(dbRoot, "tenant-store-drizzle");
const modulePath = path.join(dbRoot, "src/tenant-store/migrations.ts");

async function generate(argv: string[]): Promise<void> {
	const check = argv.includes("--check");
	const args = argv.filter((arg) => arg !== "--check");
	const response = runDrizzleKit([
		"generate",
		"--config",
		config,
		...args,
		...(check ? ["--explain"] : []),
	]);
	if (check) {
		requireNoChanges(response, "TenantStore schema snapshot check");
		const { tenantStoreMigrations } = await import(modulePath);
		if (
			!isDeepStrictEqual(
				tenantStoreMigrations,
				readTenantStoreMigrationFiles(migrationDir),
			)
		) {
			throw new DrizzleKitCommandError(
				"src/tenant-store/migrations.ts is stale; run bun run db:tenant-store:generate",
			);
		}
		console.log(
			"TenantStore schema snapshot and migrations module are current",
		);
		return;
	}
	if (response.status === "error" || response.status === "missing_hints") {
		requireNoChanges(response, "TenantStore migration generation");
	}
	writeFileSync(modulePath, renderTenantStoreMigrations(migrationDir));
	// Drizzle Kit rewrites this on every run; the inlined module replaces it.
	rmSync(path.join(migrationDir, "migrations.js"), { force: true });
	console.log(
		response.status === "ok"
			? `Generated ${response.migration_path}; review the SQL, then run bun run format on src/tenant-store/migrations.ts`
			: "No TenantStore schema changes; migrations module refreshed",
	);
}

if (import.meta.main) {
	try {
		await generate(process.argv.slice(2));
	} catch (error) {
		exitForDrizzleKitError(error);
	}
}
