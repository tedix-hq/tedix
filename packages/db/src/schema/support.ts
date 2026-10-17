import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
	SupportConfiguration,
	SupportReport,
} from "@tedix/api-contract/schemas/support";
import type { z } from "zod";
import type {
	SupportAnswerSchema,
	SupportPublicUpdateSchema,
	SupportStatusSchema,
} from "@tedix/api-contract/schemas/support";

/** Installation-owned bridge configuration; no tenant credentials or provider data. */
export const supportConfiguration = sqliteTable("support_configuration", {
	id: text("id").primaryKey(),
	configuration: text("configuration", { mode: "json" })
		.$type<SupportConfiguration>()
		.notNull(),
	updatedAt: text("updated_at").notNull(),
});
/** Work remains canonical; these rows hold the consented bridge and public projection. */
export const supportTickets = sqliteTable(
	"support_tickets",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").notNull(),
		platformOrgId: text("platform_org_id").notNull(),
		reporterKey: text("reporter_key").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		workItemId: text("work_item_id").notNull(),
		mirrorWorkItemId: text("mirror_work_item_id").notNull(),
		projectId: text("project_id").notNull(),
		report: text("report", { mode: "json" }).$type<SupportReport>().notNull(),
		consentReference: text("consent_reference").notNull(),
		payloadDigest: text("payload_digest").notNull(),
		status: text("status")
			.$type<z.infer<typeof SupportStatusSchema>>()
			.notNull()
			.default("received"),
		mirrorDelivery: text("mirror_delivery", { enum: ["pending", "delivered"] })
			.notNull()
			.default("pending"),
		version: integer("version").notNull().default(1),
		draft: text("draft", { mode: "json" }).$type<z.infer<
			typeof SupportAnswerSchema
		> | null>(),
		publicUpdates: text("public_updates", { mode: "json" })
			.$type<z.infer<typeof SupportPublicUpdateSchema>[]>()
			.notNull()
			.default([]),
		reporterVerification: text("reporter_verification", {
			enum: ["unconfirmed", "unblocked", "still-blocked"],
		})
			.notNull()
			.default("unconfirmed"),
		updateKeys: text("update_keys", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		nextUpdateDue: text("next_update_due").notNull(),
		escalationWorkItemId: text("escalation_work_item_id"),
		interactionId: text("interaction_id"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		uniqueIndex("support_tickets_org_key").on(t.orgId, t.idempotencyKey),
		index("support_tickets_org_reporter").on(t.orgId, t.reporterKey),
		index("support_tickets_platform_due").on(t.platformOrgId, t.nextUpdateDue),
	],
);
export type SupportTicketRow = typeof supportTickets.$inferSelect;
