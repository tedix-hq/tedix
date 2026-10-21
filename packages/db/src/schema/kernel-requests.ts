import type { KernelRequestSnapshot } from "@tedix/api-contract/schemas/kernel-request";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/** Links existing private requests or Home runs to their coordinator; never a Work authority. */
export const kernelRequests = sqliteTable(
	"kernel_requests",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		ownerUserId: text("owner_user_id").notNull(),
		sourceKind: text("source_kind", {
			enum: ["home", "agent_session_request", "work_attempt"],
		}).notNull(),
		sourceId: text("source_id").notNull(),
		conversationId: text("conversation_id"),
		version: integer("version").notNull().default(1),
		snapshot: text("snapshot", { mode: "json" })
			.$type<KernelRequestSnapshot>()
			.notNull(),
		nextOwner: text("next_owner").notNull(),
		nextAction: text("next_action").notNull(),
		nextDueAt: text("next_due_at"),
		lastEventId: text("last_event_id").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		uniqueIndex("kernel_requests_source_unique").on(
			t.organizationId,
			t.ownerUserId,
			t.sourceKind,
			t.sourceId,
		),
		index("kernel_requests_due_idx").on(t.organizationId, t.nextDueAt),
		index("kernel_requests_updated_idx").on(t.organizationId, t.updatedAt),
	],
);

/** Atomic transition history, private to the same tenant and source owner. */
export const kernelRequestEvents = sqliteTable(
	"kernel_request_events",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		ownerUserId: text("owner_user_id").notNull(),
		requestId: text("request_id")
			.notNull()
			.references(() => kernelRequests.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		snapshot: text("snapshot", { mode: "json" })
			.$type<KernelRequestSnapshot>()
			.notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		uniqueIndex("kernel_request_events_version_unique").on(
			t.requestId,
			t.version,
		),
	],
);

export type KernelRequestRow = typeof kernelRequests.$inferSelect;
