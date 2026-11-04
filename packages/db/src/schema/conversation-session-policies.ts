import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

export const CONVERSATION_SESSION_POLICY_EFFECT_VALUES = ["allow"] as const;

/**
 * Operator decisions that hold for the rest of one Home conversation: the
 * durable store behind the chat card's "Always allow this session".
 *
 * `scopeKey` names exactly what was allowed (today `delegate:<tediId>`). The
 * kernel reads the rows for a conversation on every turn and treats a matching
 * row as the operator's standing approval of that hand-off. A row never
 * weakens a deny, a human-reserved action, a capability gap or a speaker
 * without approval authority; it only clears the soft holds the operator
 * would otherwise be asked about again.
 */
export const kernelConversationSessionPolicies = sqliteTable(
	"kernel_conversation_session_policies",
	{
		/** Deterministic `${organizationId}:${conversationId}:${scopeKey}`. */
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").notNull(),
		scopeKey: text("scope_key").notNull(),
		effect: text("effect", {
			enum: CONVERSATION_SESSION_POLICY_EFFECT_VALUES,
		}).notNull(),
		grantedByType: text("granted_by_type", {
			enum: ["user", "external_agent", "api_key", "service"],
		}).notNull(),
		grantedById: text("granted_by_id").notNull(),
		/** Why the operator granted it, as the card showed it. */
		reason: text("reason"),
		createdAt: text("created_at").notNull(),
		/** Optional ISO instant after which the row no longer applies. */
		expiresAt: text("expires_at"),
	},
	(table) => [
		uniqueIndex("uniq_kernel_conversation_session_policy_scope").on(
			table.organizationId,
			table.conversationId,
			table.scopeKey,
		),
		index("idx_kernel_conversation_session_policy_conversation").on(
			table.organizationId,
			table.conversationId,
			table.createdAt,
		),
	],
);

export type KernelConversationSessionPolicyRow =
	typeof kernelConversationSessionPolicies.$inferSelect;
export type NewKernelConversationSessionPolicyRow =
	typeof kernelConversationSessionPolicies.$inferInsert;
