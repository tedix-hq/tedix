/**
 * Drizzle Kit configuration for the session rotation store: refresh-token rotation for one browser session (apps/session-broker SessionRotationOwner).
 *
 * Local generation only: `bun run db:session-rotation-store:generate -- --name <change>`.
 * The object applies the generated chain itself when it wakes, so there is no
 * remote target and no credentials here.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: ["./src/session-rotation-store/schema.ts"],
	out: "./session-rotation-store-drizzle",
	dialect: "sqlite",
	driver: "durable-sqlite",
	casing: "snake_case",
});
