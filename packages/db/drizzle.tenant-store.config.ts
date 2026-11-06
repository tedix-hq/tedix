/**
 * Drizzle Kit configuration for the per-workspace TenantStore Durable Object.
 *
 * Local generation only: `bun run db:tenant-store:generate -- --name <change>`.
 * The object applies the generated chain itself when it wakes, so there is no
 * remote target and no credentials here.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: [
		"./src/tenant-store/schema.ts",
		"./src/tenant-store/memory-schema/*.ts",
	],
	out: "./tenant-store-drizzle",
	dialect: "sqlite",
	driver: "durable-sqlite",
	casing: "snake_case",
});
