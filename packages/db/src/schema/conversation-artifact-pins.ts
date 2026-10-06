import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tediArtifacts } from "./cognitive-runtime";
import { organizations } from "./organizations";

/**
 * Immutable artifact revision descriptors attached to one conversation.
 *
 * A pin snapshots a platform-published artifact's content digest and URI. The
 * source artifact remains mutable; consumers must compare it with this frozen
 * descriptor before using it. Pins are context references only and carry no
 * tool, MCP, policy, or FGA authority.
 */
export const kernelConversationArtifactPins = sqliteTable(
	"kernel_conversation_artifact_pins",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id").notNull(),
		artifactId: text("artifact_id")
			.notNull()
			.references(() => tediArtifacts.id, { onDelete: "cascade" }),
		replayName: text("replay_name").notNull(),
		revisionDigest: text("revision_digest").notNull(),
		artifactUri: text("artifact_uri").notNull(),
		artifactName: text("artifact_name").notNull(),
		artifactKind: text("artifact_kind").notNull(),
		mimeType: text("mime_type"),
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
		uniqueIndex("uniq_kernel_conversation_artifact_pin_name").on(
			table.organizationId,
			table.conversationId,
			table.replayName,
		),
		uniqueIndex("uniq_kernel_conversation_artifact_pin_revision").on(
			table.organizationId,
			table.conversationId,
			table.artifactId,
			table.revisionDigest,
		),
		index("idx_kernel_conversation_artifact_pin_conversation").on(
			table.organizationId,
			table.conversationId,
			table.createdAt,
		),
	],
);

export type KernelConversationArtifactPin =
	typeof kernelConversationArtifactPins.$inferSelect;
export type NewKernelConversationArtifactPin =
	typeof kernelConversationArtifactPins.$inferInsert;
