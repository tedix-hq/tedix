/**
 * What a tedi keeps for itself between conversations.
 *
 * One row is one version of one document. A tedi has one `core` document
 * (a few named sections, small enough to sit in its prompt on every trusted
 * turn) and any number of named `note` documents it opens when it needs them.
 * A change never updates a row: it adds the next version with who or what
 * made it, so a person can read the history and bring an earlier version back.
 */

import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const TEDI_MEMORY_DOCUMENT_KINDS = ["core", "note"] as const;
export type TediMemoryDocumentKind =
	(typeof TEDI_MEMORY_DOCUMENT_KINDS)[number];

/** `reflection` is the tedi itself, in the turn that follows finished work. */
export const TEDI_MEMORY_AUTHOR_TYPES = ["tedi", "reflection", "user"] as const;
export type TediMemoryAuthorType = (typeof TEDI_MEMORY_AUTHOR_TYPES)[number];

export const tediMemoryDocuments = sqliteTable(
	"tedi_memory_documents",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: TEDI_MEMORY_DOCUMENT_KINDS }).notNull(),
		/** `core` for the core document, otherwise the note's name. */
		name: text("name").notNull(),
		version: integer("version").notNull(),
		/** Core document only: section key to text. */
		sections: text("sections", { mode: "json" }).$type<
			Record<string, string>
		>(),
		/** Note only: the one line shown in the prompt. */
		description: text("description"),
		/** Note only: the note's text. */
		content: text("content"),
		/** A note that was removed keeps its history; this version marks the removal. */
		removed: integer("removed", { mode: "boolean" }).notNull().default(false),
		charCount: integer("char_count").notNull(),
		authorType: text("author_type", {
			enum: TEDI_MEMORY_AUTHOR_TYPES,
		}).notNull(),
		authorId: text("author_id").notNull(),
		/** What changed, in a few words written by the server. */
		changeSummary: text("change_summary").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uq_tedi_memory_documents_version").on(
			table.organizationId,
			table.tediId,
			table.kind,
			table.name,
			table.version,
		),
		index("idx_tedi_memory_documents_tedi").on(table.tediId),
	],
);

export type TediMemoryDocumentRow = typeof tediMemoryDocuments.$inferSelect;
export type NewTediMemoryDocumentRow = typeof tediMemoryDocuments.$inferInsert;
