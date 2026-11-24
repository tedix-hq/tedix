/**
 * Drizzle Kit configuration for the session intent store: Single-use browser session handoff (apps/session-broker SessionIntentOwner).
 *
 * Local generation only: `bun run db:session-intent-store:generate -- --name <change>`.
 * The object applies the generated chain itself when it wakes, so there is no
 * remote target and no credentials here.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: ["./src/session-intent-store/schema.ts"],
	out: "./session-intent-store-drizzle",
	dialect: "sqlite",
	driver: "durable-sqlite",
	casing: "snake_case",
});
