/**
 * Drizzle Kit configuration for the session entries store: the tedi session repo's recent-turn and compaction log (packages/tedi-session).
 *
 * Local generation only: `bun run db:session-entries-store:generate -- --name <change>`.
 * The object applies the generated chain itself when it wakes, so there is no
 * remote target and no credentials here.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: ["./src/session-entries-store/schema.ts"],
	out: "./session-entries-store-drizzle",
	dialect: "sqlite",
	driver: "durable-sqlite",
	casing: "snake_case",
});
