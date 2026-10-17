import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/** Only digests of browser credentials are stored. Login records are single-use. */
export const oidcSessions = sqliteTable(
	"oidc_sessions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: ["login", "session"] }).notNull(),
		configDigest: text("config_digest").notNull(),
		verifier: text("verifier"),
		nonce: text("nonce"),
		subject: text("subject"),
		scopes: text("scopes", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		expiresAt: integer("expires_at").notNull(),
	},
	(t) => [index("idx_oidc_sessions_expiry").on(t.expiresAt)],
);
