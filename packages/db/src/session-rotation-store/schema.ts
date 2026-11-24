/**
 * Refresh-token rotation state for one browser-session handle (apps/session-broker
 * `SessionRotationOwner`): a fingerprint and generation, never a credential.
 * Generate migrations with `bun run db:session-rotation-store:generate -- --name <change>`.
 */
import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const refreshRotationState = sqliteTable(
	"refresh_rotation_state",
	{
		singleton: integer("singleton").primaryKey(),
		generation: integer("generation").notNull(),
		currentFingerprint: text("current_fingerprint"),
		status: text("status", { enum: ["ready", "reauth_required"] }).notNull(),
		/** Epoch milliseconds. */
		updatedAt: integer("updated_at").notNull(),
	},
	(table) => [
		check("refresh_rotation_state_singleton", sql`${table.singleton} = 1`),
		check(
			"refresh_rotation_state_status",
			sql`${table.status} IN ('ready', 'reauth_required')`,
		),
	],
);

/** Fingerprints of refresh tokens a logout invalidated, so a replay is refused. */
export const logoutReplayFingerprints = sqliteTable(
	"logout_replay_fingerprints",
	{
		fingerprint: text("fingerprint").primaryKey(),
		/** Epoch milliseconds. */
		loggedOutAt: integer("logged_out_at").notNull(),
	},
);
