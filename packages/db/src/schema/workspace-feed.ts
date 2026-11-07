/**
 * Workspace change feed: core projections of what happens inside a workspace
 * object.
 *
 * A workspace object owns its outputs, runs, artifacts, memory and chat. After
 * each write it appends one `WorkspaceChangeEvent` to its own ledger and sends
 * it through the automation-events queue. The consumer applies every event
 * exactly once, in per-workspace sequence order, into the tables below. Org
 * level readers (recent activity, output library and search, Work linkage,
 * the Home conversation list) read these rows and never list a workspace
 * object; a detail view may still fetch one object directly.
 *
 * Every column is portable: ISO-8601 text timestamps, integer sequences and
 * JSON text, so the same Drizzle queries run on D1 today and on the EU
 * Postgres core later (epic 00290527). Nothing here uses SQLite-only SQL.
 */

import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/** What kind of record a workspace write touched. */
export const WORKSPACE_CHANGE_KINDS = [
	"output",
	"run",
	"artifact",
	"memory",
	"chat",
] as const;
export type WorkspaceChangeKind = (typeof WORKSPACE_CHANGE_KINDS)[number];

/** Who performed the write, as the workspace object recorded it. */
export const WORKSPACE_CHANGE_ACTOR_KINDS = [
	"user",
	"tedi",
	"external_agent",
	"service",
] as const;
export type WorkspaceChangeActorKind =
	(typeof WORKSPACE_CHANGE_ACTOR_KINDS)[number];

/**
 * Core-side copy of a workspace's change ledger. Today the core API is the
 * writer for outputs, so it appends here and allocates `seq`; once the
 * workspace object owns the write path its own SQLite ledger (see
 * `@tedix/workspace-feed/ledger`) plays this role and this table only serves
 * replay of history written before the cut-over.
 */
export const workspaceFeedLedger = sqliteTable(
	"workspace_feed_ledger",
	{
		/** Deterministic `${workspaceId}:${seq}`. */
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		/** Contiguous per-workspace sequence, starting at 1. */
		seq: integer("seq").notNull(),
		kind: text("kind", { enum: WORKSPACE_CHANGE_KINDS }).notNull(),
		entityId: text("entity_id").notNull(),
		revision: integer("revision").notNull(),
		actorKind: text("actor_kind", {
			enum: WORKSPACE_CHANGE_ACTOR_KINDS,
		}).notNull(),
		actorId: text("actor_id").notNull(),
		/** The workspace-side record (revision row, run event, memory fact) this event describes. */
		changeRecordId: text("change_record_id").notNull(),
		/** JSON `WorkspaceChangeSummary`; what the projections need beyond ids. */
		summary: text("summary").notNull().default("{}"),
		/** Writer wall clock, ISO-8601. */
		at: text("at").notNull(),
	},
	(table) => [
		uniqueIndex("workspace_feed_ledger_workspace_seq_unique").on(
			table.workspaceId,
			table.seq,
		),
		index("workspace_feed_ledger_org_idx").on(table.organizationId),
	],
);

/**
 * The consumer's position per workspace. An event whose `seq` is at or below
 * `last_seq` was already applied and is acknowledged without effect; one that
 * skips ahead waits for redelivery so projections never see a gap.
 */
export const workspaceFeedCursors = sqliteTable(
	"workspace_feed_cursors",
	{
		workspaceId: text("workspace_id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		lastSeq: integer("last_seq").notNull(),
		/** Consumer wall clock of the last applied event, ISO-8601. */
		appliedAt: text("applied_at").notNull(),
		/** `at` of the last applied event; `applied_at - last_event_at` is the feed lag. */
		lastEventAt: text("last_event_at").notNull(),
	},
	(table) => [index("workspace_feed_cursors_org_idx").on(table.organizationId)],
);

/** Recent activity: one row per applied event, newest first per organization. */
export const workspaceActivity = sqliteTable(
	"workspace_activity",
	{
		/** Deterministic `${workspaceId}:${seq}`. */
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		seq: integer("seq").notNull(),
		kind: text("kind", { enum: WORKSPACE_CHANGE_KINDS }).notNull(),
		entityId: text("entity_id").notNull(),
		revision: integer("revision").notNull(),
		actorKind: text("actor_kind", {
			enum: WORKSPACE_CHANGE_ACTOR_KINDS,
		}).notNull(),
		actorId: text("actor_id").notNull(),
		changeRecordId: text("change_record_id").notNull(),
		/** Human title of the touched record when the event carried one. */
		title: text("title"),
		/** One-line description of the change when the event carried one. */
		summary: text("summary"),
		/** Writer wall clock, ISO-8601. */
		occurredAt: text("occurred_at").notNull(),
		/** Consumer wall clock, ISO-8601. */
		appliedAt: text("applied_at").notNull(),
	},
	(table) => [
		index("workspace_activity_org_occurred_idx").on(
			table.organizationId,
			table.occurredAt,
			table.seq,
		),
		index("workspace_activity_workspace_seq_idx").on(
			table.workspaceId,
			table.seq,
		),
		index("workspace_activity_entity_idx").on(table.entityId, table.revision),
	],
);

/**
 * Search index: one row per output revision. The current revision carries
 * `is_current = 1`; the output library and search read only those rows. The
 * output-level columns are repeated on every revision row so the library can
 * render a card from this table alone.
 */
export const workspaceOutputIndex = sqliteTable(
	"workspace_output_index",
	{
		/** Deterministic `${outputId}:${revision}`. */
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		outputId: text("output_id").notNull(),
		revision: integer("revision").notNull(),
		/** The revision row id in the workspace object (the event's `changeRecordId`). */
		revisionId: text("revision_id").notNull(),
		isCurrent: integer("is_current").notNull().default(0),
		outputKind: text("output_kind", {
			enum: ["document", "sheet", "presentation", "video"],
		}).notNull(),
		title: text("title").notNull(),
		status: text("status", { enum: ["active", "archived"] }).notNull(),
		/** Lower-cased searchable excerpt of the body; the title is searched separately. */
		searchText: text("search_text").notNull().default(""),
		note: text("note"),
		outputCreatedByKind: text("output_created_by_kind", {
			enum: WORKSPACE_CHANGE_ACTOR_KINDS,
		}).notNull(),
		outputCreatedById: text("output_created_by_id").notNull(),
		outputCreatedAt: text("output_created_at").notNull(),
		revisionCreatedByKind: text("revision_created_by_kind", {
			enum: WORKSPACE_CHANGE_ACTOR_KINDS,
		}).notNull(),
		revisionCreatedById: text("revision_created_by_id").notNull(),
		revisionCreatedAt: text("revision_created_at").notNull(),
		skillRunId: text("skill_run_id"),
		skillId: text("skill_id"),
		/** JSON OsDerivedAccessEnvelope inherited from the producing run; null when unverifiable. */
		accessEnvelope: text("access_envelope"),
		contentSha256: text("content_sha256"),
		contentBytes: integer("content_bytes"),
		bodyR2Key: text("body_r2_key"),
		/** Writer wall clock of the event that wrote this row, ISO-8601. */
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		uniqueIndex("workspace_output_index_output_revision_unique").on(
			table.outputId,
			table.revision,
		),
		index("workspace_output_index_org_current_idx").on(
			table.organizationId,
			table.isCurrent,
			table.updatedAt,
		),
		index("workspace_output_index_workspace_idx").on(
			table.workspaceId,
			table.outputId,
		),
	],
);

/** Which Work Items an output is linked to, as the workspace object reports it. */
export const workspaceWorkLinks = sqliteTable(
	"workspace_work_links",
	{
		/** Deterministic `${outputId}:${workItemId}`. */
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		outputId: text("output_id").notNull(),
		workItemId: text("work_item_id").notNull(),
		/** Output revision that last confirmed the link. */
		revision: integer("revision").notNull(),
		linkedAt: text("linked_at").notNull(),
		/** Set when a later revision no longer lists the Work Item. */
		unlinkedAt: text("unlinked_at"),
	},
	(table) => [
		index("workspace_work_links_work_item_idx").on(
			table.organizationId,
			table.workItemId,
		),
		index("workspace_work_links_output_idx").on(table.outputId),
	],
);

export type WorkspaceFeedLedgerRow = typeof workspaceFeedLedger.$inferSelect;
export type NewWorkspaceFeedLedgerRow = typeof workspaceFeedLedger.$inferInsert;
export type WorkspaceFeedCursorRow = typeof workspaceFeedCursors.$inferSelect;
export type WorkspaceActivityRow = typeof workspaceActivity.$inferSelect;
export type NewWorkspaceActivityRow = typeof workspaceActivity.$inferInsert;
export type WorkspaceOutputIndexRow = typeof workspaceOutputIndex.$inferSelect;
export type NewWorkspaceOutputIndexRow =
	typeof workspaceOutputIndex.$inferInsert;
export type WorkspaceWorkLinkRow = typeof workspaceWorkLinks.$inferSelect;
