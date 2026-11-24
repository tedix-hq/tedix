/**
 * Generate or check the Durable Object store migration chains (TenantStore, wallet).
 *
 * Drizzle Kit's durable-sqlite output imports each `migration.sql` from a
 * `migrations.js`, which needs a Text-module bundler rule in every Worker and
 * test pool that loads it. This script renders the same chain into
 * each store's `migrations.ts` with the SQL inlined instead.
 *
 *   bun scripts/generate-tenant-store-migration.ts [--store wallet-store] --name <change>
 *   bun scripts/generate-tenant-store-migration.ts --check   (every store)
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

/** Durable Object stores whose schema chain this script generates and checks. */
const STORES = {
	"tenant-store": {
		config: "drizzle.tenant-store.config.ts",
		folder: "tenant-store-drizzle",
		module: "src/tenant-store/migrations.ts",
		exportName: "tenantStoreMigrations",
		label: "TenantStore",
	},
	"wallet-store": {
		config: "drizzle.wallet-store.config.ts",
		folder: "wallet-store-drizzle",
		module: "src/wallet-store/migrations.ts",
		exportName: "walletStoreMigrations",
		label: "wallet store",
	},
	"session-intent-store": {
		config: "drizzle.session-intent-store.config.ts",
		folder: "session-intent-store-drizzle",
		module: "src/session-intent-store/migrations.ts",
		exportName: "sessionIntentStoreMigrations",
		label: "session intent store",
	},
	"session-rotation-store": {
		config: "drizzle.session-rotation-store.config.ts",
		folder: "session-rotation-store-drizzle",
		module: "src/session-rotation-store/migrations.ts",
		exportName: "sessionRotationStoreMigrations",
		label: "session rotation store",
	},
	"poppy-store": {
		config: "drizzle.poppy-store.config.ts",
		folder: "poppy-store-drizzle",
		module: "src/poppy-store/migrations.ts",
		exportName: "poppyStoreMigrations",
		label: "Poppy store",
	},
	"runtime-admission-store": {
		config: "drizzle.runtime-admission-store.config.ts",
		folder: "runtime-admission-store-drizzle",
		module: "src/runtime-admission-store/migrations.ts",
		exportName: "runtimeAdmissionStoreMigrations",
		label: "runtime admission store",
	},
	"session-entries-store": {
		config: "drizzle.session-entries-store.config.ts",
		folder: "session-entries-store-drizzle",
		module: "src/session-entries-store/migrations.ts",
		exportName: "sessionEntriesStoreMigrations",
		label: "session entries store",
	},
} as const;
type StoreName = keyof typeof STORES;

async function generateStore(name: StoreName, args: string[], check: boolean) {
	const store = STORES[name];
	const migrationDir = path.join(dbRoot, store.folder);
	const modulePath = path.join(dbRoot, store.module);
	const response = runDrizzleKit([
		"generate",
		"--config",
		store.config,
		...args,
		...(check ? ["--explain"] : []),
	]);
	if (check) {
		requireNoChanges(response, `${store.label} schema snapshot check`);
		const generated = (await import(modulePath))[store.exportName];
		if (
			!isDeepStrictEqual(generated, readTenantStoreMigrationFiles(migrationDir))
		) {
			throw new DrizzleKitCommandError(
				`${store.module} is stale; run bun run db:${name}:generate`,
			);
		}
		console.log(
			`${store.label} schema snapshot and migrations module are current`,
		);
		return;
	}
	if (response.status === "error" || response.status === "missing_hints") {
		requireNoChanges(response, `${store.label} migration generation`);
	}
	writeFileSync(modulePath, renderTenantStoreMigrations(migrationDir, store));
	// Drizzle Kit rewrites this on every run; the inlined module replaces it.
	rmSync(path.join(migrationDir, "migrations.js"), { force: true });
	console.log(
		response.status === "ok"
			? `Generated ${response.migration_path}; review the SQL, then run bun run format on ${store.module}`
			: `No ${store.label} schema changes; migrations module refreshed`,
	);
}

async function generate(argv: string[]): Promise<void> {
	const check = argv.includes("--check");
	const storeAt = argv.indexOf("--store");
	const named = storeAt >= 0 ? argv[storeAt + 1] : undefined;
	if (named !== undefined && !(named in STORES))
		throw new DrizzleKitCommandError(
			`--store must be one of: ${Object.keys(STORES).join(", ")}`,
		);
	const args = argv.filter(
		(arg, i) => arg !== "--check" && i !== storeAt && i !== storeAt + 1,
	);
	// --check covers every store; generation targets one (TenantStore by default).
	const stores = check
		? (Object.keys(STORES) as StoreName[])
		: [(named ?? "tenant-store") as StoreName];
	for (const name of stores) await generateStore(name, args, check);
}

if (import.meta.main) {
	try {
		await generate(process.argv.slice(2));
	} catch (error) {
		exitForDrizzleKitError(error);
	}
}
