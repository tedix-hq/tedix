/**
 * Drizzle Kit Configuration
 * For schema management with Cloudflare D1
 *
 * RECOMMENDED WORKFLOW:
 * 1. Edit schema files in src/schema/
 * 2. Run `bun run db:migrate:generate -- --name <change>`
 * 3. Review the unrecorded SQL/snapshot, then `bun scripts/migration-integrity.ts --write`
 * 4. Run `bun run db:migrate:check` before `bun run db:migrate`
 * 5. Run `bun run db:studio` to inspect database visually
 *
 * REQUIRED ENV VARS (read from the shell environment; see README.md):
 * - CLOUDFLARE_ACCOUNT_ID (legacy CF_ACCOUNT_ID is also accepted)
 * - CLOUDFLARE_D1_DATABASE_ID (the `d1_databases[0].database_id` in this
 *   package's wrangler.jsonc; required by `db:studio` and `drizzle-kit push`)
 * - CLOUDFLARE_D1_API_TOKEN
 */

import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// Load plain local env files; live commands read the rest from the shell.
config({ quiet: true });

export default defineConfig({
	// Keep startup-heavy graph governance schemas directly addressable instead
	// of re-exporting them through the hot runtime barrel. Drizzle still owns the
	// complete canonical schema through this explicit source list.
	schema: [
		"./src/schema/index.ts",
		"./src/schema/graph-retrieval-benchmarks.ts",
		"./src/schema/memory-entities.ts",
	],
	out: "./drizzle",
	dialect: "sqlite",
	driver: "d1-http",
	casing: "snake_case",
	// Wrangler owns the native migration ledger; it is not product schema.
	tablesFilter: ["*", "!tedix_drizzle_migrations"],
	dbCredentials: {
		// No real identifier is spelled here. Migration generation and
		// `db:schema:check` are local-only and never contact D1, so they run on
		// these inert placeholders; every command that does reach the live
		// database (`db:migrate`, `db:drift:check`, `db:studio`) reads the real
		// account, database, and token from the shell environment.
		accountId:
			process.env.CLOUDFLARE_ACCOUNT_ID ??
			process.env.CF_ACCOUNT_ID ??
			"generation-only",
		databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID ?? "generation-only",
		token: process.env.CLOUDFLARE_D1_API_TOKEN ?? "generation-only",
	},
});
