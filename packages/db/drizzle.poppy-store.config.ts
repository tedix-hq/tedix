/**
 * Drizzle Kit configuration for the Poppy store: Poppy conversations protocol state inside the tedi runtime Durable Object.
 *
 * Local generation only: `bun run db:poppy-store:generate -- --name <change>`.
 * The object applies the generated chain itself when it wakes, so there is no
 * remote target and no credentials here.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: ["./src/poppy-store/schema.ts"],
	out: "./poppy-store-drizzle",
	dialect: "sqlite",
	driver: "durable-sqlite",
	casing: "snake_case",
});
