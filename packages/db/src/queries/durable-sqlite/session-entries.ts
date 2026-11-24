/**
 * Reads and writes of the tedi session repo's `session_entries` log
 * (`session-entries-store/schema.ts`). Synchronous. Reads return the
 * snake_case row shape the repo's projections consume. The compacted-history
 * projection is not here: it needs `AS MATERIALIZED`, which Drizzle cannot
 * build, so packages/tedi-session runs it as one statement.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import type { SessionEntriesDb } from "../../session-entries-store/store";
import { sessionEntries } from "../../session-entries-store/schema";

/** A message row as the recent window reads it. */
export interface SessionEntryMessageRow {
	session_key: string;
	role: string;
	content: string;
	ts: number;
	model_provider: string | null;
	model_id: string | null;
}

/** Every column of an entry. */
export interface SessionEntryFullRow extends SessionEntryMessageRow {
	id: string;
	parent_id: string | null;
	type: string;
	first_kept_entry_id: string | null;
	tokens_before: number | null;
}

const messageColumns = {
	session_key: sessionEntries.sessionKey,
	role: sessionEntries.role,
	content: sessionEntries.content,
	ts: sessionEntries.ts,
	model_provider: sessionEntries.modelProvider,
	model_id: sessionEntries.modelId,
};

/** The newest `limit` message rows across every session, ts-descending. */
export function listRecentSessionMessages(
	db: SessionEntriesDb,
	limit: number,
): SessionEntryMessageRow[] {
	return db
		.select(messageColumns)
		.from(sessionEntries)
		.where(eq(sessionEntries.type, "message"))
		.orderBy(desc(sessionEntries.ts))
		.limit(limit)
		.all();
}

/** Whether any session has a compaction marker. */
export function hasSessionCompaction(db: SessionEntriesDb): boolean {
	return (
		db
			.select({ id: sessionEntries.id })
			.from(sessionEntries)
			.where(eq(sessionEntries.type, "compaction"))
			.limit(1)
			.get() !== undefined
	);
}

/** One session's entries, ts-ascending. */
export function listSessionEntries(
	db: SessionEntriesDb,
	sessionKey: string,
): SessionEntryFullRow[] {
	return db
		.select({
			id: sessionEntries.id,
			session_key: sessionEntries.sessionKey,
			parent_id: sessionEntries.parentId,
			type: sessionEntries.type,
			role: sessionEntries.role,
			content: sessionEntries.content,
			ts: sessionEntries.ts,
			first_kept_entry_id: sessionEntries.firstKeptEntryId,
			tokens_before: sessionEntries.tokensBefore,
			model_provider: sessionEntries.modelProvider,
			model_id: sessionEntries.modelId,
		})
		.from(sessionEntries)
		.where(eq(sessionEntries.sessionKey, sessionKey))
		.orderBy(asc(sessionEntries.ts))
		.all();
}

/**
 * Append an entry unless its id or its (session, idempotency key) already
 * exists; true when a row was inserted.
 */
export function appendSessionEntry(
	db: SessionEntriesDb,
	entry: typeof sessionEntries.$inferInsert,
): boolean {
	return (
		db
			.insert(sessionEntries)
			.values(entry)
			.onConflictDoNothing()
			.returning({ id: sessionEntries.id })
			.all().length > 0
	);
}

/** The message appended under this key in this session, if it landed. */
export function findSessionMessageByIdempotencyKey(
	db: SessionEntriesDb,
	p: { sessionKey: string; idempotencyKey: string },
): SessionEntryMessageRow | undefined {
	return db
		.select(messageColumns)
		.from(sessionEntries)
		.where(
			and(
				eq(sessionEntries.sessionKey, p.sessionKey),
				eq(sessionEntries.idempotencyKey, p.idempotencyKey),
			),
		)
		.limit(1)
		.get();
}
