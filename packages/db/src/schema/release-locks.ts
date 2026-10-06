import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Cross-host release mutexes for production releases. A row is held until the release
 * process removes its exact owner token. There is deliberately no lease expiry:
 * an old Wrangler upload must never regain authority after a timed takeover.
 * Recovery from an abandoned row requires an operator to establish that the
 * original process and any upload it started have stopped.
 */
export const releaseLocks = sqliteTable("release_locks", {
	surface: text("surface").primaryKey(),
	ownerToken: text("owner_token").notNull(),
	targetSha: text("target_sha").notNull(),
	startedAt: integer("started_at").notNull(),
});
