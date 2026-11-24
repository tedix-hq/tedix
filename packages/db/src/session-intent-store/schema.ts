/**
 * The one row of a single-use browser session handoff (apps/session-broker
 * `SessionIntentOwner`). Generate migrations with
 * `bun run db:session-intent-store:generate -- --name <change>`.
 */
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const SESSION_INTENT_STATUSES = [
	"pending",
	"granted",
	"consumed",
	"failed",
] as const;

export const sessionIntent = sqliteTable(
	"session_intent",
	{
		singleton: integer("singleton").primaryKey(),
		intentJson: text("intent_json").notNull(),
		status: text("status", { enum: SESSION_INTENT_STATUSES }).notNull(),
		codeHash: text("code_hash"),
		/** Epoch seconds. */
		codeExpiresAt: integer("code_expires_at"),
		grantKind: text("grant_kind", { enum: ["session", "logout"] }),
		grantedTenantId: text("granted_tenant_id"),
		sessionJwt: text("session_jwt"),
		subject: text("subject"),
		/** Epoch seconds. */
		sessionExpiresAt: integer("session_expires_at"),
		/** Epoch milliseconds. */
		updatedAt: integer("updated_at").notNull(),
		/** Epoch milliseconds of the intent's one interactive reauthentication. */
		reauthStartedAt: integer("reauth_started_at"),
	},
	(table) => [
		check("session_intent_singleton", sql`${table.singleton} = 1`),
		check(
			"session_intent_status",
			sql`${table.status} IN ('pending', 'granted', 'consumed', 'failed')`,
		),
		check(
			"session_intent_grant_kind",
			sql`${table.grantKind} IN ('session', 'logout')`,
		),
	],
);
