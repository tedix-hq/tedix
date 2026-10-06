import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { orgCapabilities } from "./capabilities";
import { organizations } from "./organizations";

/**
 * Context-only capability names attached to a Home or signed embedded
 * conversation. Embedded rows use the opaque server-derived session key from
 * the signed browser capability; callers never supply that key directly.
 *
 * These rows never grant execution authority. MCP scopes, FGA, capability
 * links, and tool policy are still re-evaluated at execution time.
 */
export const kernelConversationCapabilities = sqliteTable(
	"kernel_conversation_capabilities",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").notNull(),
		capabilityId: text("capability_id")
			.notNull()
			.references(() => orgCapabilities.id, { onDelete: "cascade" }),
		replayName: text("replay_name").notNull(),
		attachedByType: text("attached_by_type", {
			enum: [
				"user",
				"tedi",
				"service",
				"external_agent",
				"api_key",
				"m2m",
				"anonymous",
				"kernel",
			],
		}).notNull(),
		attachedById: text("attached_by_id").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("uniq_kernel_conversation_capability_name").on(
			table.organizationId,
			table.conversationId,
			table.replayName,
		),
		uniqueIndex("uniq_kernel_conversation_capability_target").on(
			table.organizationId,
			table.conversationId,
			table.capabilityId,
		),
		index("idx_kernel_conversation_capability_conversation").on(
			table.organizationId,
			table.conversationId,
			table.createdAt,
		),
	],
);

export type KernelConversationCapability =
	typeof kernelConversationCapabilities.$inferSelect;
export type NewKernelConversationCapability =
	typeof kernelConversationCapabilities.$inferInsert;
