/**
 * Organization Purpose Charters
 *
 * Human-owned, versioned direction for an autonomous organization. Objectives
 * point at the charter revision they interpret; work remains in work_items.
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

export const PURPOSE_CHARTER_STATUS_VALUES = ["active", "superseded"] as const;
export type PurposeCharterStatus =
	(typeof PURPOSE_CHARTER_STATUS_VALUES)[number];

export const organizationPurposeCharters = sqliteTable(
	"organization_purpose_charters",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		status: text("status", { enum: PURPOSE_CHARTER_STATUS_VALUES })
			.notNull()
			.default("active"),
		/** Why the organization exists, who benefits, and what change it seeks. */
		purpose: text("purpose").notNull(),
		/** Human taste and trade-off rules used when more than one path is valid. */
		principles: text("principles", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		/** Current beliefs about how the organization will create distinctive value. */
		strategicTheses: text("strategic_theses", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		/** Explicitly excluded outcomes or behaviors. */
		nonGoals: text("non_goals", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		/** Evidence or artifact references that justify this revision. */
		evidenceRefs: text("evidence_refs", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		reviewCadenceDays: integer("review_cadence_days").notNull().default(30),
		revisionReason: text("revision_reason").notNull(),
		createdByUserId: text("created_by_user_id"),
		createdAt: text("created_at").notNull(),
		activatedAt: text("activated_at").notNull(),
		supersededAt: text("superseded_at"),
	},
	(table) => [
		uniqueIndex("uniq_org_purpose_version").on(table.orgId, table.version),
		uniqueIndex("uniq_org_purpose_active")
			.on(table.orgId)
			.where(sql`${table.status} = 'active'`),
		index("idx_org_purpose_history").on(table.orgId, table.createdAt),
	],
);

export type OrganizationPurposeCharter =
	typeof organizationPurposeCharters.$inferSelect;
export type NewOrganizationPurposeCharter =
	typeof organizationPurposeCharters.$inferInsert;
