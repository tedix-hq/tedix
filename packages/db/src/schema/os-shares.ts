import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/**
 * Tedix OS governed share links. The 256-bit token is shown exactly
 * once at creation; only its
 * sha-256 hex hash persists here, so a leaked database row cannot be replayed
 * as a link. `resource_type`/`resource_id` are deliberately generic (plain
 * text, no FK — redemption re-resolves the resource org-scoped through the
 * query layer). Revision pins are likewise immutable identifiers without FKs
 * so share audit evidence survives resource cleanup.
 */

const createdByKinds = ["user", "tedi", "external_agent", "service"] as const;

export const osShareLinks = sqliteTable(
	"os_share_links",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		resourceType: text("resource_type", {
			enum: ["output", "gadget", "workspace"],
		}).notNull(),
		resourceId: text("resource_id").notNull(),
		/**
		 * Permanent id in the share URL (`/s/<public_id>`), stored in clear: it
		 * names the link, it is not the secret. 22 random base62 characters;
		 * links from before this column were backfilled with 22 hex characters.
		 * Nullable only because SQLite cannot add a NOT NULL column to a
		 * populated table; every row has one after the backfill migration.
		 */
		publicId: text("public_id"),
		/** sha-256 hex of the link's plaintext secret; the plaintext is never stored. */
		tokenHash: text("token_hash").notNull(),
		/** Who may open the link; `invited` consults `os_share_link_invitees`. */
		access: text("access", {
			enum: ["anyone_with_link", "organization", "invited"],
		})
			.notNull()
			.default("anyone_with_link"),
		role: text("role", { enum: ["viewer", "use", "build"] })
			.notNull()
			.default("viewer"),
		/** Living links resolve current truth; pinned links resolve this immutable revision. */
		revisionMode: text("revision_mode", { enum: ["living", "pinned"] })
			.notNull()
			.default("living"),
		pinnedRevisionId: text("pinned_revision_id"),
		/** JSON safe snapshot used only by pinned workspace links. */
		pinnedSnapshot: text("pinned_snapshot"),
		note: text("note"),
		/** Monotonic policy ceiling: once set, it can stay or tighten, never clear/widen. */
		policyMaxRole: text("policy_max_role", {
			enum: ["viewer", "use", "build"],
		}),
		policyReason: text("policy_reason"),
		policyRestrictedAt: text("policy_restricted_at"),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		/** Optional ISO-8601 expiry; null links never expire. */
		expiresAt: text("expires_at"),
		/** Set when the link was revoked; a revoked link never redeems again. */
		revokedAt: text("revoked_at"),
		/**
		 * Set while the link is turned off: it stops redeeming like a revoked
		 * link, but clearing it revives the same address — no new public id.
		 */
		disabledAt: text("disabled_at"),
	},
	(table) => [
		index("os_share_links_org_resource_idx").on(
			table.organizationId,
			table.resourceId,
		),
		uniqueIndex("os_share_links_token_hash_unique").on(table.tokenHash),
		uniqueIndex("os_share_links_public_id_unique").on(table.publicId),
	],
);

/**
 * Who an `invited` link admits. A row names a person by lowercased email and,
 * once known, by Tedix user id; either identity on a signed-in session
 * matches. The link's role applies to every invitee. Rows go with their link.
 */
export const osShareLinkInvitees = sqliteTable(
	"os_share_link_invitees",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		shareLinkId: text("share_link_id")
			.notNull()
			.references(() => osShareLinks.id, { onDelete: "cascade" }),
		email: text("email"),
		userId: text("user_id"),
		name: text("name"),
		addedByKind: text("added_by_kind", { enum: createdByKinds }).notNull(),
		addedById: text("added_by_id").notNull(),
		addedAt: text("added_at")
			.notNull()
			.default(sql`(datetime('now'))`),
	},
	(table) => [
		uniqueIndex("os_share_link_invitees_link_email_unique").on(
			table.shareLinkId,
			table.email,
		),
		index("os_share_link_invitees_link_user_idx").on(
			table.shareLinkId,
			table.userId,
		),
	],
);

/**
 * Ephemeral redemption sessions. Both the link secret and the session secret
 * are hash-only at rest. Revocation stamps every live session in the same D1
 * batch as the link, so a viewer's next read is denied even if it already
 * removed the link secret from its address bar.
 */
export const osShareSessions = sqliteTable(
	"os_share_sessions",
	{
		id: text("id").primaryKey(),
		shareLinkId: text("share_link_id")
			.notNull()
			.references(() => osShareLinks.id, { onDelete: "cascade" }),
		sessionTokenHash: text("session_token_hash").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		lastSeenAt: text("last_seen_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		expiresAt: text("expires_at").notNull(),
		revokedAt: text("revoked_at"),
	},
	(table) => [
		index("os_share_sessions_link_idx").on(table.shareLinkId),
		uniqueIndex("os_share_sessions_token_hash_unique").on(
			table.sessionTokenHash,
		),
	],
);

export type OsShareLinkRow = typeof osShareLinks.$inferSelect;
export type NewOsShareLinkRow = typeof osShareLinks.$inferInsert;
export type OsShareSessionRow = typeof osShareSessions.$inferSelect;
export type NewOsShareSessionRow = typeof osShareSessions.$inferInsert;
export type OsShareLinkInviteeRow = typeof osShareLinkInvitees.$inferSelect;
export type NewOsShareLinkInviteeRow = typeof osShareLinkInvitees.$inferInsert;

/**
 * Immutable owner-reviewed projection; source provenance is retained independently.
 * A link may carry several dated rounds; recipients see the newest one.
 */
export const osReviewBatches = sqliteTable(
	"os_review_batches",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		shareLinkId: text("share_link_id")
			.notNull()
			.references(() => osShareLinks.id, { onDelete: "cascade" }),
		sourceOutputId: text("source_output_id").notNull(),
		sourceRevisionId: text("source_revision_id").notNull(),
		title: text("title").notNull(),
		cards: text("cards").notNull(),
		accessEnvelope: text("access_envelope").notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		index("os_review_batches_share_created_idx").on(t.shareLinkId, t.createdAt),
		index("os_review_batches_org_idx").on(t.organizationId),
	],
);
/** Each recipient owns their feedback; concurrency is independent from research revisions. */
export const osReviewFeedback = sqliteTable(
	"os_review_feedback",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		batchId: text("batch_id")
			.notNull()
			.references(() => osReviewBatches.id, { onDelete: "cascade" }),
		cardId: text("card_id").notNull(),
		reviewerId: text("reviewer_id").notNull(),
		revision: integer("revision").notNull(),
		decision: text("decision", {
			enum: ["needs_checking", "edit", "skip", "ready"],
		}).notNull(),
		editedReply: text("edited_reply").notNull(),
		reason: text("reason").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		uniqueIndex("os_review_feedback_recipient_unique").on(
			t.batchId,
			t.cardId,
			t.reviewerId,
		),
	],
);
export type OsReviewBatchRow = typeof osReviewBatches.$inferSelect;
export type OsReviewFeedbackRow = typeof osReviewFeedback.$inferSelect;
