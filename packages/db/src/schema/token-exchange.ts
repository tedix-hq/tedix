/**
 * Internal RFC 8693 token exchange lineage (pilot).
 *
 * One row per exchanged token the API broker issues: who the originating
 * subject is, the actor chain from the current actor back to the first, the
 * one internal audience and the narrowed scopes. A verifier accepts a token
 * only while its row exists unrevoked, so revoking a row (and every row that
 * descends from it) ends the token before it expires.
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tokenExchangeGrants = sqliteTable(
	"token_exchange_grants",
	{
		jti: text("jti").primaryKey(),
		/** The subject token's jti when it was itself exchanged. */
		parentJti: text("parent_jti"),
		organizationId: text("organization_id").notNull(),
		subject: text("subject").notNull(),
		/** Current actor first, e.g. ["service:mcp", "tedi:<id>"]. */
		actorChain: text("actor_chain", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		audience: text("audience").notNull(),
		/** The one API procedure the token may call, e.g. `tedis/get`. */
		endpoint: text("endpoint").notNull(),
		scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
		issuedAt: integer("issued_at").notNull(),
		expiresAt: integer("expires_at").notNull(),
		/** Set by the one verification that consumes the token. */
		usedAt: text("used_at"),
		revokedAt: text("revoked_at"),
		revokedBy: text("revoked_by"),
	},
	(table) => [
		index("token_exchange_grants_org_issued_idx").on(
			table.organizationId,
			table.issuedAt,
		),
		index("token_exchange_grants_parent_idx").on(table.parentJti),
	],
);

export type TokenExchangeGrantRow = typeof tokenExchangeGrants.$inferSelect;
export type NewTokenExchangeGrantRow = typeof tokenExchangeGrants.$inferInsert;
