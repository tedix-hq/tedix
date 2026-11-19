import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A primary-read fence for cached authorization, advanced by database triggers. */
export const authContextCacheState = sqliteTable("auth_context_cache_state", {
	id: integer("id").primaryKey(),
	version: text("version").notNull(),
});
