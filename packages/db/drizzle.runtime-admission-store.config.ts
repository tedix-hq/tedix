/**
 * Drizzle Kit configuration for the runtime admission store: Runtime admission state inside the tedi runtime Durable Object.
 *
 * Local generation only: `bun run db:runtime-admission-store:generate -- --name <change>`.
 * The object applies the generated chain itself when it wakes, so there is no
 * remote target and no credentials here.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: ["./src/runtime-admission-store/schema.ts"],
	out: "./runtime-admission-store-drizzle",
	dialect: "sqlite",
	driver: "durable-sqlite",
	casing: "snake_case",
});
