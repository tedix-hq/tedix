import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const gitCommitAliases = sqliteTable("git_commit_aliases", {
	oldSha: text("old_sha").primaryKey(),
	newSha: text("new_sha").notNull().unique(),
	repository: text("repository").notNull(),
	createdAt: text("created_at")
		.notNull()
		.default(sql`(CURRENT_TIMESTAMP)`),
});
