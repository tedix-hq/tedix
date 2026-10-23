import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Cross-host release mutexes for production releases. A row is held until the release
 * process removes its exact owner token. There is deliberately no lease expiry:
 * an old Wrangler upload must never regain authority after a timed takeover.
 * A GitHub holder can be replaced after its exact numeric job has completed.
 * Other abandoned rows require an operator to confirm uploads have stopped.
 */
export const releaseLocks = sqliteTable("release_locks", {
	surface: text("surface").primaryKey(),
	ownerToken: text("owner_token").notNull(),
	targetSha: text("target_sha").notNull(),
	startedAt: integer("started_at").notNull(),
	githubRunId: text("github_run_id"),
	githubJobId: text("github_job_id"),
});
