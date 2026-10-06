/**
 * Source Graph Schema — external sources attached to work.
 *
 * Answers "what external material does this engagement touch": the Notion pages,
 * Gmail threads, and Drive files a project or work item is actually built from.
 *
 * This is deliberately NOT `work_item_projections`. That table is a 1:1
 * task mirror (UNIQUE(work_item_id, provider)) with sync-cursor machinery for
 * keeping one item aligned with one external task. Source attachment is
 * many-per-owner and needs no cursor — conflating them is what forced the
 * unique index to fight the use case.
 *
 * Federation over ingestion still holds: this table stores *identity* (uri,
 * external id, content hash), never source CONTENT. Content is read live at
 * query time. The hash exists only so a reconciliation sweep can tell "changed"
 * from "unchanged" from "gone" without copying anything.
 *
 * Deletion is a tombstone, not a DELETE — a source that disappears upstream is
 * evidence, and hard-deleting it would erase the record that we ever worked
 * from it. This matches the memory-entity contract, where mentions are
 * immutable and corrections create new rows.
 *
 * D1 is canonical. Fresh CREATE TABLE, so real FKs are safe here.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { projects } from "./projects";

/**
 * Provider is open text, not an enum: the source graph must accept a connector
 * the platform has never heard of without a migration. Convention is the app
 * slug (`notion`, `gmail`, `google_drive`, `slack`).
 */

export const WORK_ITEM_SOURCE_KIND_VALUES = [
	"document",
	"thread",
	"message",
	"file",
	"record",
	"page",
	"other",
] as const;
export type WorkItemSourceKind = (typeof WORK_ITEM_SOURCE_KIND_VALUES)[number];

export const WORK_ITEM_SOURCE_STATE_VALUES = [
	/** Seen at the last sweep, hash unchanged. */
	"current",
	/** Seen at the last sweep, content hash moved since it was attached. */
	"changed",
	/** Not returned by the last sweep — upstream deleted, moved, or revoked access. */
	"missing",
	/** Confirmed gone and retained as evidence. Excluded from live reads. */
	"tombstoned",
] as const;
export type WorkItemSourceState =
	(typeof WORK_ITEM_SOURCE_STATE_VALUES)[number];

export const workItemSources = sqliteTable(
	"work_item_sources",
	{
		id: text("id").primaryKey(),

		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		/**
		 * A source attaches to a project, a work item, or both. Project-level is
		 * the common case for an engagement ("the proposal deck"); item-level
		 * is for a source that motivated one specific piece of work. At least one
		 * must be set — enforced in the query layer, the same way `work_items`
		 * validates its polymorphic parent.
		 */
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		/**
		 * Deliberately TEXT with NO FK, matching `work_items.parentWorkItemId`: a
		 * self-referencing FK onto the pre-existing `work_items` table would force
		 * a destructive table recreate, which can wipe data. Existence + org are validated in the query layer.
		 */
		workItemId: text("work_item_id"),

		/** App slug of the connector that owns this source (`notion`, `gmail`, ...). */
		provider: text("provider").notNull(),
		/** Provider-native id — a Notion page id, a Gmail thread id. */
		externalId: text("external_id").notNull(),
		kind: text("kind", { enum: WORK_ITEM_SOURCE_KIND_VALUES })
			.notNull()
			.default("other"),

		externalUrl: text("external_url"),
		/** Human label for reads that must not re-fetch the provider to render. */
		title: text("title"),

		/**
		 * Hash over the source's content as of `lastCheckedAt`. Hash, not
		 * timestamp: third-party `last_modified` is unreliable and, critically,
		 * cannot detect a delete. Null means never hashed (attached by reference).
		 */
		contentHash: text("content_hash"),

		state: text("state", { enum: WORK_ITEM_SOURCE_STATE_VALUES })
			.notNull()
			.default("current"),

		/** When a sweep last confirmed this source still exists upstream. */
		lastCheckedAt: text("last_checked_at"),
		/** When the content hash last changed. Drives "what moved since I looked". */
		lastChangedAt: text("last_changed_at"),
		/** When it was first observed missing — the tombstone grace clock. */
		missingSinceAt: text("missing_since_at"),
		tombstonedAt: text("tombstoned_at"),

		/** Who attached it: a tedi slug, an external agent, or `system`. */
		attributedTo: text("attributed_to"),

		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),

		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
	},
	(table) => [
		/**
		 * One row per (owner, provider, external id). The owner is part of the key
		 * so the SAME Notion page can legitimately attach to a project and to a
		 * specific work item without colliding — that is a real relationship, not a
		 * duplicate. SQLite treats NULLs as distinct in a unique index, which would
		 * let duplicates through on the unset side, so the null cases are covered
		 * explicitly rather than left to default behaviour.
		 *
		 * These four partial indexes are the nullability partition of the single
		 * `coalesce(project_id, '') / coalesce(work_item_id, '')` index they
		 * replace, and enforce exactly the same rule: coalescing to a sentinel and
		 * branching on IS NULL describe the same four owner shapes.
		 *
		 * They are split because `drizzle-kit` 1.0.0-rc.4 cannot INTROSPECT an
		 * index built on expressions — its puller aborts with "unexpected unique
		 * index ... with expression value", which takes down the live-drift check
		 * for EVERY table, not just this one, and `--output json` reports that as
		 * an empty response with no error text. A partial index over plain columns
		 * is the shape the rest of this schema already uses (14 of them) and that
		 * drizzle-kit reads back correctly.
		 */
		uniqueIndex("uniq_work_item_source_owner_external_both")
			.on(
				table.orgId,
				table.provider,
				table.externalId,
				table.projectId,
				table.workItemId,
			)
			.where(
				sql`${table.projectId} IS NOT NULL AND ${table.workItemId} IS NOT NULL`,
			),
		uniqueIndex("uniq_work_item_source_owner_external_project")
			.on(table.orgId, table.provider, table.externalId, table.projectId)
			.where(
				sql`${table.projectId} IS NOT NULL AND ${table.workItemId} IS NULL`,
			),
		uniqueIndex("uniq_work_item_source_owner_external_work_item")
			.on(table.orgId, table.provider, table.externalId, table.workItemId)
			.where(
				sql`${table.projectId} IS NULL AND ${table.workItemId} IS NOT NULL`,
			),
		/**
		 * Both unset is rejected by `AttachWorkItemSourceInputSchema.refine()` at
		 * the API boundary, but the table is the authority: without this index a
		 * direct writer could insert unlimited ownerless duplicates.
		 */
		uniqueIndex("uniq_work_item_source_owner_external_orphan")
			.on(table.orgId, table.provider, table.externalId)
			.where(sql`${table.projectId} IS NULL AND ${table.workItemId} IS NULL`),
		index("idx_work_item_source_project").on(
			table.orgId,
			table.projectId,
			table.state,
		),
		index("idx_work_item_source_work_item").on(table.orgId, table.workItemId),
		/** The reconciliation sweep's scan: oldest-checked first, per provider. */
		index("idx_work_item_source_sweep").on(
			table.orgId,
			table.provider,
			table.lastCheckedAt,
		),
	],
);

export type WorkItemSource = typeof workItemSources.$inferSelect;
export type NewWorkItemSource = typeof workItemSources.$inferInsert;
