/**
 * Organization Schemas for oRPC Contracts
 * Zod schemas for Organization and Member entity validation
 */

import * as z from "zod";
import { JevSettingsSchema } from "./jev";
import {
	EmbeddedTediSelectionPolicySchema,
	EmbeddedTurnQuotaPolicySchema,
} from "./embedded-widget-access";
import { ProviderCapacityPolicySchema } from "./billing";
import { OrganizationOsThemeSchema } from "./os-theme";
import { JsonValueSchema } from "./common";
import { OrganizationPermissionSchema } from "./user-settings";
import { PortableWebMcpProfileSchema } from "./portable-webmcp";

// =============================================================================
// ENUMS
// =============================================================================

/**
 * Organization type
 * Must match packages/db/src/schema/organizations.ts
 */
export const OrganizationTypeSchema = z.enum(["personal", "organization"]);
export type OrganizationType = z.infer<typeof OrganizationTypeSchema>;

/**
 * Member role
 */
export const MemberRoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

/**
 * Member status
 */
export const MemberStatusSchema = z.enum(["active", "invited", "deactivated"]);
export type MemberStatus = z.infer<typeof MemberStatusSchema>;

/**
 * API key environment
 * Must match packages/db/src/schema/api-keys.ts
 */
export const ApiKeyEnvironmentSchema = z.enum(["test", "live"]);
export type ApiKeyEnvironment = z.infer<typeof ApiKeyEnvironmentSchema>;

/**
 * API key status
 */
export const ApiKeyStatusSchema = z.enum(["active", "revoked", "expired"]);
export type ApiKeyStatus = z.infer<typeof ApiKeyStatusSchema>;

/**
 * API key scopes
 */
export const ApiKeyScopeSchema = z.enum([
	"apps:read",
	"apps:write",
	"apps:delete",
	"tools:read",
	"tools:write",
	"analytics:read",
	"adapters:read",
	"adapters:write",
	"billing:read",
	"team:read",
	"team:write",
	"tedis:read",
	"tedis:write",
	"embedded:session",
	"earned-delegation:govern",
	"work:read",
	"work:write",
	"work:accept",
	"work:cancel",
	"work:review",
	"work:complete",
	"os:fleet-run",
	"platform:admin",
	"*",
]);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

/**
 * Scopes only a platform principal may put on a key.
 *
 * `*` satisfies wildcard-aware machine-scope guards; `platform:admin` grants
 * explicit cross-org platform authority without implying other machine scopes.
 * Neither may be delegated by a tenant principal. `os:fleet-run` drives a
 * fleet deployment runner and is provisioned, never self-served.
 *
 * This is the single list the server guard enforces AND the list the OS admin UI
 * subtracts to build its scope picker, so the UI cannot offer a scope the API
 * will reject. That divergence is exactly what broke tenant key creation: the
 * create dialog hardcoded `["*"]`, which the guard refuses for every
 * non-platform caller, so an ordinary admin could not mint a key at all.
 */
export const PLATFORM_ONLY_API_KEY_SCOPES = [
	"*",
	"platform:admin",
	"os:fleet-run",
] as const satisfies readonly ApiKeyScope[];

export type PlatformOnlyApiKeyScope =
	(typeof PLATFORM_ONLY_API_KEY_SCOPES)[number];

/** Scopes a tenant owner or admin may delegate to a key they create. */
export const TENANT_DELEGABLE_API_KEY_SCOPES = ApiKeyScopeSchema.options.filter(
	(scope): scope is Exclude<ApiKeyScope, PlatformOnlyApiKeyScope> =>
		!(PLATFORM_ONLY_API_KEY_SCOPES as readonly string[]).includes(scope),
);

export type TenantDelegableApiKeyScope =
	(typeof TENANT_DELEGABLE_API_KEY_SCOPES)[number];

/** Coarse grouping used to section a rendered scope picker. */
export const API_KEY_SCOPE_GROUPS = [
	"apps",
	"tedis",
	"organization",
	"automation",
] as const;
export type ApiKeyScopeGroup = (typeof API_KEY_SCOPE_GROUPS)[number];

export interface ApiKeyScopeMetadata {
	label: string;
	description: string;
	group: ApiKeyScopeGroup;
	/** True when the scope permits writes, so a picker can warn on it. */
	write: boolean;
}

export const API_KEY_SCOPE_METADATA: Record<ApiKeyScope, ApiKeyScopeMetadata> =
	{
		"apps:read": {
			label: "Read apps",
			description: "Read apps and their configuration.",
			group: "apps",
			write: false,
		},
		"apps:write": {
			label: "Write apps",
			description: "Create and update apps.",
			group: "apps",
			write: true,
		},
		"apps:delete": {
			label: "Delete apps",
			description: "Permanently delete apps.",
			group: "apps",
			write: true,
		},
		"tools:read": {
			label: "Read tools",
			description: "Read the tools an app exposes.",
			group: "apps",
			write: false,
		},
		"tools:write": {
			label: "Write tools",
			description: "Create and update app tools.",
			group: "apps",
			write: true,
		},
		"adapters:read": {
			label: "Read adapters",
			description: "Read adapter bindings and integration configuration.",
			group: "apps",
			write: false,
		},
		"adapters:write": {
			label: "Write adapters",
			description: "Configure adapters and integrations.",
			group: "apps",
			write: true,
		},
		"analytics:read": {
			label: "Read analytics",
			description: "Read organization activity, runs, and usage.",
			group: "organization",
			write: false,
		},
		"billing:read": {
			label: "Read billing",
			description: "Read subscription, usage, and invoices.",
			group: "organization",
			write: false,
		},
		"team:read": {
			label: "Read team",
			description: "Read organization members and their roles.",
			group: "organization",
			write: false,
		},
		"team:write": {
			label: "Write team",
			description: "Invite, remove, and change the role of a member.",
			group: "organization",
			write: true,
		},
		"tedis:read": {
			label: "Read tedis",
			description: "Read digital workers and their activity.",
			group: "tedis",
			write: false,
		},
		"tedis:write": {
			label: "Write tedis",
			description: "Create and update digital workers.",
			group: "tedis",
			write: true,
		},
		"embedded:session": {
			label: "Issue embedded Tedi sessions",
			description:
				"Exchange a provider installation for a short-lived, origin-bound customer Tedi session.",
			group: "tedis",
			write: true,
		},
		"earned-delegation:govern": {
			label: "Govern earned delegation",
			description: "Review and rule on earned-delegation evidence.",
			group: "automation",
			write: true,
		},
		"work:accept": {
			label: "Accept Work Items",
			description:
				"Fix a Work Item's acceptance contract, making it executable. Granted deliberately: it lets a non-human principal make its own work executable.",
			group: "automation",
			write: true,
		},
		"work:read": {
			label: "Read Work Items",
			description: "Read Work Items, attempts, evidence, and factory state.",
			group: "automation",
			write: false,
		},
		"work:write": {
			label: "Execute Work Items",
			description:
				"Create, start, heartbeat, settle, and submit evidence for Work Items.",
			group: "automation",
			write: true,
		},
		"work:cancel": {
			label: "Cancel Work Items",
			description: "Cancel obsolete Work Items within the organization.",
			group: "automation",
			write: true,
		},
		"work:review": {
			label: "Review Work evidence",
			description: "Accept or reject independently assigned Work evidence.",
			group: "automation",
			write: true,
		},
		"work:complete": {
			label: "Complete Work Items",
			description:
				"Complete Work Items whose acceptance contract is satisfied.",
			group: "automation",
			write: true,
		},
		"os:fleet-run": {
			label: "Run the OS fleet deployer",
			description:
				"Drive and settle a Tedix OS deployment. Provisioned by Tedix, never self-served.",
			group: "automation",
			write: true,
		},
		"platform:admin": {
			label: "Administer the platform",
			description: "Operate Tedix itself across every tenant.",
			group: "automation",
			write: true,
		},
		"*": {
			label: "Full access",
			description: "Every scope, including future ones. Platform use only.",
			group: "automation",
			write: true,
		},
	};

// =============================================================================
// NESTED SCHEMAS
// =============================================================================

/**
 * SSO Setup Suite (S4) configuration — mirrors @descope/node-sdk
 * `SSOSetupSuiteSettings` (added in 2.5.0).
 *
 * Fields control which pieces of the self-service S4 portal are exposed
 * to the customer's IT admin when they configure their IdP.
 */
export const SsoSetupDisabledFeaturesSchema = z.object({
	saml: z.boolean().optional(),
	oidc: z.boolean().optional(),
	scim: z.boolean().optional(),
	ssoDomains: z.boolean().optional(),
	groupMapping: z.boolean().optional(),
});
export type SsoSetupDisabledFeatures = z.infer<
	typeof SsoSetupDisabledFeaturesSchema
>;

export const SsoSetupSuiteSettingsSchema = z.object({
	enabled: z.boolean().optional(),
	styleId: z.string().optional(),
	disabledFeatures: SsoSetupDisabledFeaturesSchema.optional(),
});
export type SsoSetupSuiteSettings = z.infer<typeof SsoSetupSuiteSettingsSchema>;

/**
 * SSO status surfaced to the OS admin UI. `enabled` reflects whether S4 is
 * turned on for the tenant; `authType` is the connection type the
 * customer has actually wired up via the S4 portal (or null if no IdP yet).
 */
export const SsoStatusSchema = z.object({
	enabled: z.boolean(),
	authType: z.enum(["none", "saml", "oidc"]).nullable(),
	disabledFeatures: SsoSetupDisabledFeaturesSchema.nullable(),
	styleId: z.string().nullable(),
});
export type SsoStatus = z.infer<typeof SsoStatusSchema>;

/**
 * Organization features schema
 */
export const OrganizationFeaturesSchema = z.object({
	maxApps: z.number().optional(),
	maxCmsSites: z.number().int().min(-1).optional(),
	maxTeamMembers: z.number().optional(),
	customDomain: z.boolean().optional(),
	sso: z.boolean().optional(),
	apiAccess: z.boolean().optional(),
	prioritySupport: z.boolean().optional(),
	advancedAnalytics: z.boolean().optional(),
	whiteLabel: z.boolean().optional(),
	os: z
		.boolean()
		.optional()
		.describe(
			"Whether the organization is provisioned on its canonical {slug}.os.tedix.dev origin.",
		),
});
export type OrganizationFeatures = z.infer<typeof OrganizationFeaturesSchema>;

/**
 * Organization metadata schema
 */
export const ProviderOnboardingSchema = z.object({
	enabled: z.boolean(),
	providerAppId: z.uuid(),
	providerApiKeyId: z.uuid(),
	allowedOrigin: z
		.url()
		.refine((value) => URL.canParse(value) && new URL(value).origin === value, {
			message: "Use an origin without a path",
		}),
	hostTenantArgument: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
	hostTenantNamespace: z.string().regex(/^[a-z][a-z0-9_]{1,127}$/),
	ownerUserId: z.string().min(1),
	ownerEmail: z.email(),
	billingPlanKey: z.enum(["growth", "business", "enterprise"]),
	sponsoredCapacity: ProviderCapacityPolicySchema,
	language: z
		.string()
		.min(2)
		.max(10)
		.optional()
		.describe("Omit to use the standard worker language."),
	timezone: z
		.string()
		.max(100)
		.optional()
		.describe("Omit to use the standard worker timezone."),
	personality: z
		.string()
		.max(10000)
		.optional()
		.describe("Omit to use the standard worker instructions."),
});

export const OrganizationMetadataSchema = z.object({
	githubWorkstationCredentials: z
		.object({
			enabled: z.boolean(),
			disabledInstallationIds: z
				.array(z.number().int().positive().safe())
				.max(100)
				.default([]),
			disabledRepositoryIds: z
				.array(z.number().int().positive().safe())
				.max(500)
				.default([]),
		})
		.optional()
		.describe(
			"Operator-owned org, installation and repository kill controls for workstation GitHub App authority.",
		),
	jev: JevSettingsSchema.optional().describe(
		"Bounded Jev ranking defaults enabled; explicit tenant and purpose denials remain authoritative.",
	),
	providerOnboarding: ProviderOnboardingSchema.optional().describe(
		"Platform-owned defaults authorizing provider customer activation.",
	),
	providerCustomerKey: z
		.string()
		.regex(/^[a-f0-9]{32}$/)
		.optional()
		.describe("Platform-owned automatic customer provisioning identity."),
	cancelledAt: z
		.string()
		.optional()
		.describe("Absent until phase-one organization cancellation is recorded."),
	cancelReason: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Optional operator rationale; null records an explicit cancellation without a supplied reason.",
		),
	retiredAt: z
		.string()
		.optional()
		.describe(
			"Absent for live organizations; set when external access is retired without deleting customer memory.",
		),
	retiredSlug: z
		.string()
		.optional()
		.describe(
			"Canonical tenant slug preserved when retirement renames the live row.",
		),
	memoryRetained: z
		.boolean()
		.optional()
		.describe(
			"Retirement receipt confirming the organization and tedi memory rows were retained.",
		),
	industryVertical: z.string().optional(),
	country: z.string().optional(),
	timezone: z.string().optional(),
	website: z.string().optional(),
	contactEmail: z.email().optional(),
	referralSource: z.string().optional(),
	onboardingNotes: z.string().optional(),
	osTheme: OrganizationOsThemeSchema.nullable()
		.optional()
		.describe(
			"Absent for organizations that never configured OS appearance; null explicitly resets the published profile to the Tedix default",
		),
	tediWidget: z
		.object({
			tediSelection: EmbeddedTediSelectionPolicySchema.optional().describe(
				"Absent until an administrator configures OS quick chat workers; no name-based routing fallback is applied.",
			),
			defaultModelRef: z
				.string()
				.min(1)
				.max(200)
				.optional()
				.describe(
					"Canonical `provider/model-id` the OS quick chat routes at when the user picks nothing. Absent means inherit the tedi's own resolved chat model. Advisory: the session mint drops a ref the model catalog denies for that tedi, so this can never widen what a session may spend.",
				),
			version: z.literal(1),
			turnQuota: EmbeddedTurnQuotaPolicySchema.optional().describe(
				"Per-visitor and per-origin embedded turn ceilings per hour. Absent fields use the runtime platform defaults.",
			),
			analyticsEnabled: z
				.boolean()
				.optional()
				.describe(
					"Explicit provider consent to send content-free widget lifecycle and reliability events; absence is disabled.",
				),
			locale: z
				.string()
				.regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
				.optional()
				.describe(
					"Optional for configurations published before locale support; absence resolves to the neutral English provider default.",
				),
			title: z.string().trim().min(1).max(80),
			subtitle: z.string().trim().min(1).max(160),
			product: z.string().trim().min(1).max(100),
			assistantLogoUrl: z
				.url()
				.optional()
				.describe("Optional assistant logo override."),
			assistantLogoUrlDark: z
				.url()
				.optional()
				.describe("Optional dark-theme assistant logo override."),
			launcherIconUrl: z
				.url()
				.optional()
				.describe("Optional launcher icon override."),
			launcherIconUrlDark: z
				.url()
				.optional()
				.describe("Optional dark-theme launcher icon override."),
			accentColor: z
				.string()
				.regex(/^#[0-9a-fA-F]{6}$/)
				.optional()
				.describe(
					"Optional light-theme accent; absence uses the provider default.",
				),
			accentColorDark: z
				.string()
				.regex(/^#[0-9a-fA-F]{6}$/)
				.optional()
				.describe("Optional dark-theme accent; absence uses the light accent."),
			themeMode: z
				.enum(["host", "system", "light", "dark"])
				.optional()
				.describe(
					"Optional theme authority; absence preserves the host-driven default.",
				),
			launcherPosition: z
				.enum(["bottom-left", "bottom-right"])
				.optional()
				.describe(
					"Optional launcher edge; absence preserves bottom-right placement.",
				),
			horizontalOffset: z
				.number()
				.int()
				.min(8)
				.max(120)
				.optional()
				.describe("Optional horizontal launcher offset in pixels."),
			bottomOffset: z
				.number()
				.int()
				.min(8)
				.max(120)
				.optional()
				.describe("Optional bottom launcher offset in pixels."),
			zIndex: z
				.number()
				.int()
				.min(1)
				.max(2147483647)
				.optional()
				.describe("Optional widget stacking order."),
			launcherMode: z
				.enum(["default", "hidden", "host"])
				.optional()
				.describe(
					"Optional launcher ownership mode; host delegates opening to the embedding page.",
				),
			startMode: z
				.enum(["home", "conversation"])
				.optional()
				.describe(
					"Optional initial surface; conversation bypasses the widget home.",
				),
			homeModules: z
				.array(z.enum(["welcome", "attention", "recent"]))
				.max(3)
				.optional()
				.describe(
					"Optional ordered widget-home modules; absence preserves the standard home.",
				),
			translations: z
				.record(
					z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
					z
						.object({
							title: z
								.string()
								.trim()
								.min(1)
								.max(80)
								.optional()
								.describe("Optional localized assistant title."),
							subtitle: z
								.string()
								.trim()
								.min(1)
								.max(160)
								.optional()
								.describe("Optional localized assistant subtitle."),
							welcomeHeading: z
								.string()
								.trim()
								.min(1)
								.max(160)
								.optional()
								.describe("Optional localized home heading."),
							welcomeBody: z
								.string()
								.trim()
								.min(1)
								.max(320)
								.optional()
								.describe("Optional localized home description."),
							conversationStarters: z
								.array(z.string().trim().min(1).max(240))
								.max(6)
								.optional()
								.describe("Optional localized conversation starters."),
						})
						.catchall(
							z
								.string()
								.trim()
								.min(1)
								.max(400)
								.describe(
									"Optional override for one widget copy key in this locale.",
								),
						),
				)
				.optional()
				.describe(
					"Optional locale-keyed copy overrides with exact-then-base fallback.",
				),
			conversationStarters: z.array(z.string().trim().min(1).max(240)).max(6),
			webMcpProfile: PortableWebMcpProfileSchema.optional().describe(
				"Organization-managed portable route tools projected by signed embedded widget sessions; execution authority remains host- or installation-bound.",
			),
		})
		.optional()
		.describe(
			"Versioned white-label Tedi widget experience for this provider organization; absent derives neutral defaults from the organization identity.",
		),
});
export type OrganizationMetadata = z.infer<typeof OrganizationMetadataSchema>;

// =============================================================================
// ORGANIZATION ENTITY SCHEMAS
// =============================================================================

/**
 * Full Organization schema (response)
 */
export const OrganizationSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	slug: z.string(),
	type: OrganizationTypeSchema.default("organization"),
	descopeTenantId: z.string().nullable(),
	logoUrl: z.string().nullable(),
	description: z.string().nullable(),
	appsCount: z.number().nullable(),
	features: OrganizationFeaturesSchema.nullable(),
	metadata: OrganizationMetadataSchema.nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

/**
 * Organization list item schema (simplified for list views)
 */
export const OrganizationListItemSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	slug: z.string(),
	type: OrganizationTypeSchema.default("organization"),
	logoUrl: z.string().nullable(),
	appsCount: z.number().nullable(),
	createdAt: z.string().nullable(),
});
export type OrganizationListItem = z.infer<typeof OrganizationListItemSchema>;

// =============================================================================
// MEMBER ENTITY SCHEMAS
// =============================================================================

/**
 * Full Member schema (response)
 */
export const MemberSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	descopeUserId: z.string(),
	email: z.email(),
	name: z.string().nullable(),
	avatarUrl: z.string().nullable(),
	role: MemberRoleSchema,
	/**
	 * Additive permission grants layered on top of the role. Always the
	 * canonical vocabulary — never a separate capability model — and bounded to
	 * what the `owner` role itself holds, so an override can never carry
	 * `platform:admin`.
	 */
	customPermissions: z
		.array(OrganizationPermissionSchema)
		.nullable()
		.describe(
			"Additive permission grants layered on the member's role. Null when the member has no overrides, which is the common case and is stored as SQL NULL rather than an empty array so the column stays cheap for the overwhelming majority of rows. Always reported filtered to what a tenant admin may grant, matching what the API guards honor.",
		),
	status: MemberStatusSchema.nullable(),
	invitedAt: z.string().nullable(),
	invitedBy: z.string().nullable(),
	inviteAcceptedAt: z.string().nullable(),
	lastActiveAt: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type Member = z.infer<typeof MemberSchema>;

// =============================================================================
// API KEY SCHEMAS
// =============================================================================

/**
 * API Key schema (response - never includes full key)
 */
export const ApiKeySchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	name: z.string(),
	description: z.string().nullable(),
	keyPreview: z.string(),
	scopes: z.array(ApiKeyScopeSchema).nullable(),
	descopeClientId: z.string().nullable(),
	environment: ApiKeyEnvironmentSchema.nullable(),
	lastUsedAt: z.string().nullable(),
	requestsThisMonth: z.number().nullable(),
	totalRequests: z.number().nullable(),
	ipAllowlist: z.array(z.string()).nullable(),
	expiresAt: z.string().nullable(),
	status: ApiKeyStatusSchema.nullable(),
	rotatedAt: z.string().nullable(),
	rotationScheduleDays: z.number().nullable(),
	previousKeyExpiresAt: z.string().nullable(),
	revokedAt: z.string().nullable(),
	revokedBy: z.string().nullable(),
	revokeReason: z.string().nullable(),
	metadata: z.record(z.string(), JsonValueSchema).nullable(),
	createdBy: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

// =============================================================================
// INPUT SCHEMAS
// =============================================================================

/**
 * Create organization input schema
 */
export const CreateOrganizationInputSchema = z.object({
	name: z.string().min(1, "Name is required").max(100),
	slug: z.string().min(1).max(100).optional(),
	logoUrl: z.url().optional(),
	description: z.string().max(500).optional(),
	metadata: OrganizationMetadataSchema.optional(),
	/**
	 * Owner email — required for non-User-JWT auth (API key, service binding,
	 * tedi, skill workflow). Ignored when caller is a User JWT (uses user.email).
	 *
	 * Platform-admin authority is required to create an org under a different
	 * user — see `isPlatformPrincipal()`.
	 */
	ownerEmail: z
		.email()
		.optional()
		.describe(
			"Descope email of the human who will own the new org. REQUIRED (together with ownerUserId) for every non-user caller — API key, tedi, or skill workflow. Ignored for a signed-in user, who becomes the owner automatically. A tedi cannot own an org: it must name a human here.",
		),
	/** Owner Descope userId — paired with ownerEmail for non-User-JWT auth. */
	ownerUserId: z
		.string()
		.optional()
		.describe(
			"Descope userId of the owner (e.g. 'U39z...'), paired with ownerEmail. REQUIRED alongside ownerEmail for non-user callers; omitting it fails with 'Platform-admin org creation requires ownerEmail + ownerUserId'. Resolve it from the owner's email first if you only have the address.",
		),
});
export type CreateOrganizationInput = z.infer<
	typeof CreateOrganizationInputSchema
>;

/**
 * Update organization input schema
 */
export const UpdateOrganizationInputSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	slug: z.string().min(1).max(100).optional(),
	logoUrl: z.url().nullable().optional(),
	description: z.string().max(500).nullable().optional(),
	metadata: OrganizationMetadataSchema.optional(),
});
export type UpdateOrganizationInput = z.infer<
	typeof UpdateOrganizationInputSchema
>;

/**
 * Invite member input schema
 */
export const InviteMemberInputSchema = z.object({
	email: z.email("Valid email is required"),
	role: MemberRoleSchema.optional().default("member"),
});
export type InviteMemberInput = z.infer<typeof InviteMemberInputSchema>;

/**
 * Update member role input schema
 */
export const UpdateMemberRoleInputSchema = z.object({
	role: MemberRoleSchema,
});
export type UpdateMemberRoleInput = z.infer<typeof UpdateMemberRoleInputSchema>;

/**
 * Create API key input schema
 */
export const CreateApiKeyInputSchema = z
	.object({
		name: z.string().min(1).max(100),
		description: z.string().max(500).optional(),
		scopes: z.array(ApiKeyScopeSchema).optional(),
		environment: ApiKeyEnvironmentSchema.optional(),
		ipAllowlist: z.array(z.string()).optional(),
		expiresAt: z.iso.datetime().optional(),
		rotationScheduleDays: z.number().positive().optional(),
	})
	.strict();
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInputSchema>;
