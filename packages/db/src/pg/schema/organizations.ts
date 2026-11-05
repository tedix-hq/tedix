/**
 * Organizations Schema
 * Canonical tenant entities with external identity-provider mappings.
 *
 * Organizations are the top-level billing/team entity that own multiple AI apps (brands).
 * Descope-specific columns support the certified adapter; principal mappings
 * own the provider-neutral authentication join.
 */

import type {
	ConnectionAllowedResources,
	ConnectionConsumerGrants,
} from "@tedix/api-contract/schemas/connections";
import type { OrganizationPermission } from "@tedix/api-contract/schemas/user-settings";
import { sql } from "drizzle-orm";
import type { DecisionLearningConfig } from "@tedix/api-contract/schemas/decision-learning";
import type { OutboundPolicy } from "@tedix/api-contract/schemas/outbound";
import type { McpNetworkControlConfig } from "@tedix/api-contract/schemas/mcp-network-security";
import type { OrganizationOsTheme } from "@tedix/api-contract/schemas/os-theme";
import type { OrganizationMetadata as OrganizationContractMetadata } from "@tedix/api-contract/schemas/organization";
import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";

// ============================================================================
// Organizations Table
// ============================================================================

export const organizations = pgTable(
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
		features: jsonb("features").$type<OrganizationFeatures>(),

		// General metadata (JSON)
		metadata: jsonb("metadata").$type<OrganizationMetadata>(),

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

export const organizationMembers = pgTable(
	"organization_members",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id"),
		descopeUserId: text("descope_user_id").notNull(),
		email: text("email").notNull(),
		name: text("name"),
		avatarUrl: text("avatar_url"),
		kind: text("kind").notNull().default("human"),
		representedUserId: text("represented_user_id"),
		role: text("role").notNull().default("member"),
		customPermissions:
			jsonb("custom_permissions").$type<OrganizationPermission[]>(),
		status: text("status").default("active"),
		invitedAt: text("invited_at"),
		inviteAcceptedAt: text("invite_accepted_at"),
		invitedBy: text("invited_by"),
		lastActiveAt: text("last_active_at"),
		createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP::text`),
	},
	(table) => [
		uniqueIndex("uniq_org_member").on(
			table.organizationId,
			table.descopeUserId,
		),
		uniqueIndex("uniq_org_member_user")
			.on(table.organizationId, table.userId)
			.where(sql`${table.userId} IS NOT NULL`),
		index("idx_org_members_org").on(table.organizationId),
		index("idx_org_members_canonical_user").on(table.userId),
		index("idx_org_members_user").on(table.descopeUserId),
		index("idx_org_members_email").on(table.email),
		index("idx_org_members_status").on(table.status),
		index("idx_org_members_role").on(table.role),
	],
);

export type PgOrganization = typeof organizations.$inferSelect;
export type NewPgOrganization = typeof organizations.$inferInsert;
export type PgOrganizationMember = typeof organizationMembers.$inferSelect;
export type NewPgOrganizationMember = typeof organizationMembers.$inferInsert;

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
	agentRequestApprovals?: OrganizationContractMetadata["agentRequestApprovals"];
	sessionProjectBindings?: OrganizationContractMetadata["sessionProjectBindings"];
	modelFallback?: OrganizationContractMetadata["modelFallback"];
	workStewardship?: OrganizationContractMetadata["workStewardship"];
	decisionLearning?: DecisionLearningConfig;
	connectionConsumerGrants?: Record<string, ConnectionConsumerGrants>;
	connectionResourceLimits?: Record<string, ConnectionAllowedResources | null>;
	portfolioBuckets?: OrganizationContractMetadata["portfolioBuckets"];
	identityProvider?: import("@tedix/api-contract/schemas/oidc-identity").OidcIdentityConfig;
	providerCustomerKey?: string;
	providerOnboarding?: OrganizationContractMetadata["providerOnboarding"];
	tediWidget?: OrganizationContractMetadata["tediWidget"];
	/** Published, validated Tedix OS semantic appearance inputs. */
	osTheme?: OrganizationOsTheme | null;
	outboundReview?: OutboundPolicy;
	/** Dispatcher stall alarm: quiet minutes before it fires (default 45); enabled false turns it off. */
	dispatcherHealth?: { staleAfterMinutes?: number; enabled?: boolean };
	/** Optional Cloudflare One network overlay; never a Tedix authorization source. */
	mcpNetworkControl?: McpNetworkControlConfig;
	/** Gateway web search for tedis; absent means off. */
	webSearch?: OrganizationContractMetadata["webSearch"];
	/** Org admin overrides of "check each person's access" per organization account. */
	connectionAccessChecks?: OrganizationContractMetadata["connectionAccessChecks"];
	/** Inbound human OAuth client admission; absent admits every verified client. */
	mcpInboundClientPolicy?: OrganizationContractMetadata["mcpInboundClientPolicy"];
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
