/**
 * Drizzle Kit configuration for the per-organization wallet Durable Object.
 *
 * Local generation only: `bun run db:wallet-store:generate -- --name <change>`.
 * The wallet applies the generated chain itself when it wakes, so there is no
 * remote target and no credentials here.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: ["./src/wallet-store/schema.ts"],
	out: "./wallet-store-drizzle",
	dialect: "sqlite",
	driver: "durable-sqlite",
	casing: "snake_case",
});
