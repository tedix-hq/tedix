import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { cmsSites } from "./cms-sites";
import { organizations } from "./organizations";

/** Primary routing is canonical in cms_sites; only an active www companion may redirect. */
export const cmsDomainClaims = sqliteTable(
	"cms_domain_claims",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		siteId: text("site_id")
			.notNull()
			.references(() => cmsSites.id, { onDelete: "cascade" }),
		hostname: text("hostname").notNull(),
		kind: text("kind", { enum: ["primary", "www_alias"] })
			.notNull()
			.default("primary"),
		verificationToken: text("verification_token").notNull(),
		providerHostnameId: text("provider_hostname_id"),
		status: text("status", {
			enum: [
				"pending",
				"provisioning",
				"active",
				"removing",
				"removing_provisioning",
				"removing_legacy",
			],
		})
			.notNull()
			.default("pending"),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("cms_domain_claims_hostname_unique").on(table.hostname),
		uniqueIndex("cms_domain_claims_provider_unique").on(
			table.providerHostnameId,
		),
		uniqueIndex("cms_domain_claims_site_pending_unique")
			.on(table.siteId)
			.where(sql`status = 'pending'`),
		index("cms_domain_claims_site_idx").on(table.organizationId, table.siteId),
	],
);

export type CmsDomainClaimRow = typeof cmsDomainClaims.$inferSelect;
export type NewCmsDomainClaimRow = typeof cmsDomainClaims.$inferInsert;
