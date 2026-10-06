/**
 * Organizations Schema
 * Canonical tenant entities with external identity-provider mappings.
 *
 * Organizations are the top-level billing/team entity that own multiple AI apps (brands).
 * Descope-specific columns support the certified adapter; principal mappings
 * own the provider-neutral authentication join.
 */

import { sql } from "drizzle-orm";
import type { McpNetworkControlConfig } from "@tedix/api-contract/schemas/mcp-network-security";
import type { OrganizationOsTheme } from "@tedix/api-contract/schemas/os-theme";
import type { OrganizationMetadata as OrganizationContractMetadata } from "@tedix/api-contract/schemas/organization";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ============================================================================
// Organizations Table
// ============================================================================

export const organizations = sqliteTable(
	"organizations",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),

		// Organization type: "personal" for auto-created user workspaces, "organization" for team orgs
		type: text("type").notNull().default("organization"), // "personal" | "organization"

		// Certified Descope adapter subject. Canonical auth uses
		// principal_identities(provider, issuer, subject).
		descopeTenantId: text("descope_tenant_id").unique(),

		// Branding
		logoUrl: text("logo_url"),
		description: text("description"),

		// Usage tracking
		appsCount: integer("apps_count").default(0),

		// Feature flags (JSON)
		// Controls what features are available for this organization
		features: text("features", { mode: "json" }).$type<OrganizationFeatures>(),

		// General metadata (JSON)
		metadata: text("metadata", { mode: "json" }).$type<OrganizationMetadata>(),

		// Timestamps
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("organizations_slug_unique").on(table.slug),
		uniqueIndex("organizations_descope_tenant_id_unique")
			.on(table.descopeTenantId)
			.where(sql`${table.descopeTenantId} IS NOT NULL`),
		index("idx_org_slug").on(table.slug),
		index("idx_org_descope").on(table.descopeTenantId),
		index("organizations_type_idx").on(table.type),
	],
);

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Organization feature flags
 * Controls what features are available based on subscription tier
 */
export interface OrganizationFeatures {
	/** Maximum number of AI apps this org can create */
	maxApps?: number;
	/** Maximum CMS sites (-1 = unlimited); paused sites still occupy a slot. */
	maxCmsSites?: number;
	/** Maximum team members */
	maxTeamMembers?: number;
	/** Custom domain support for MCP endpoints */
	customDomain?: boolean;
	/** SSO/SAML support via Descope */
	sso?: boolean;
	/** API access for programmatic management */
	apiAccess?: boolean;
	/** Priority support channel */
	prioritySupport?: boolean;
	/** Advanced analytics */
	advancedAnalytics?: boolean;
	/** White-label (remove Tedix branding) */
	whiteLabel?: boolean;
	/** Maximum tokens per month (-1 = unlimited) */
	maxTokensPerMonth?: number;
	/** Maximum tedis (-1 = unlimited) */
	maxTedis?: number;
	/** Tedix OS provisioned: `{slug}.os.tedix.dev` resolves to the OS shell */
	os?: boolean;
}

/**
 * Organization metadata
 * Additional organization information
 */
export interface OrganizationMetadata {
	providerCustomerKey?: string;
	providerOnboarding?: OrganizationContractMetadata["providerOnboarding"];
	tediWidget?: OrganizationContractMetadata["tediWidget"];
	/** Published, validated Tedix OS semantic appearance inputs. */
	osTheme?: OrganizationOsTheme | null;
	/** Optional Cloudflare One network overlay; never a Tedix authorization source. */
	mcpNetworkControl?: McpNetworkControlConfig;
	/** Organization-wide browser boundary; per-tedi policy may narrow it further. */
	browserEgress?: {
		allowedHostnames?: string[];
		deniedHostnames?: string[];
	};
	/** Industry vertical (for analytics/recommendations) */
	industryVertical?: string;
	/** Primary country */
	country?: string;
	/** Timezone for reports */
	timezone?: string;
	/** Company website */
	website?: string;
	/** Primary contact email */
	contactEmail?: string;
	/** How they found Tedix */
	referralSource?: string;
	/** Notes from onboarding */
	onboardingNotes?: string;
}

// ============================================================================
// Inferred Types
// ============================================================================

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

// ============================================================================
// Enum Types
// ============================================================================

export type OrganizationType = "personal" | "organization";
export const ORGANIZATION_TYPE_VALUES = ["personal", "organization"] as const;

export type OrganizationFeaturePlanKey =
	| "starter"
	| "growth"
	| "business"
	| "enterprise";
// ============================================================================
// Default Organization Features by Billing Plan
// ============================================================================

/**
 * Default organization feature limits by canonical billing plan.
 */
export const DEFAULT_ORGANIZATION_FEATURES_BY_PLAN: Record<
	OrganizationFeaturePlanKey,
	OrganizationFeatures
> = {
	starter: {
		maxApps: 1,
		maxCmsSites: 1,
		maxTeamMembers: 2,
		customDomain: false,
		sso: false,
		apiAccess: false,
		prioritySupport: false,
		advancedAnalytics: false,
		whiteLabel: false,
		maxTokensPerMonth: 100_000,
		maxTedis: 1,
	},
	growth: {
		maxApps: 5,
		maxCmsSites: 5,
		maxTeamMembers: 5,
		customDomain: false,
		sso: false,
		apiAccess: true,
		prioritySupport: false,
		advancedAnalytics: true,
		whiteLabel: false,
		maxTokensPerMonth: 500_000,
		maxTedis: 1,
	},
	business: {
		maxApps: 15,
		maxCmsSites: 15,
		maxTeamMembers: 15,
		customDomain: true,
		sso: false,
		apiAccess: true,
		prioritySupport: false,
		advancedAnalytics: true,
		whiteLabel: false,
		maxTokensPerMonth: 2_000_000,
		maxTedis: 3,
	},
	enterprise: {
		maxApps: -1, // unlimited
		maxCmsSites: -1, // unlimited
		maxTeamMembers: -1, // unlimited
		customDomain: true,
		sso: true,
		apiAccess: true,
		prioritySupport: true,
		advancedAnalytics: true,
		whiteLabel: true,
		maxTokensPerMonth: -1, // unlimited
		maxTedis: -1, // unlimited
	},
};
