import "@orpc/openapi/extensions/route";
/**
 * Organizations Contract for oRPC
 * Type-safe API contract for Organization endpoints
 */

import { oc } from "@orpc/contract";
import { SURFACE_SLUG_PATTERN } from "@tedix/tenant-directory";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	ListMcpAuthorizationsInputSchema,
	ListMcpAuthorizationsResultSchema,
	DisableMcpAuthorizationInputSchema,
	HumanMcpConsentRevisionSchema,
	RevokeHumanMcpConsentInputSchema,
	StageHumanMcpConsentInputSchema,
	VerifyHumanMcpGrantInputSchema,
	VerifyHumanMcpGrantResultSchema,
} from "../schemas/mcp-grant";
export type {
	StageHumanMcpConsentInput,
	VerifyHumanMcpGrantInput,
} from "../schemas/mcp-grant";
import {
	createPaginatedResponseSchema,
	PaginationSchema,
	SlugParamSchema,
	SuccessResponseSchema,
} from "../schemas/common";
import {
	ApiKeyEnvironmentSchema,
	ApiKeySchema,
	ApiKeyStatusSchema,
	CreateApiKeyInputSchema,
	CreateOrganizationInputSchema,
	MemberRoleSchema,
	MemberSchema,
	OrganizationFeaturesSchema,
	OrganizationListItemSchema,
	OrganizationSchema,
	OrganizationTypeSchema,
	SsoSetupSuiteSettingsSchema,
	SsoStatusSchema,
	UpdateOrganizationInputSchema,
} from "../schemas/organization";

/**
 * Organizations contract defining all organization-related endpoints
 */
export const organizationsContract = oc
	.route({ tags: ["organizations"], prefix: "/organizations" })
	.errors(baseErrors)
	.router({
		listMcpAuthorizations: oc
			.route({ summary: "List your Tedix Connect authorizations" })
			.input(ListMcpAuthorizationsInputSchema)
			.output(ListMcpAuthorizationsResultSchema),
		disableMcpAuthorization: oc
			.route({
				summary: "Disable your human MCP access for one resource and client",
			})
			.input(DisableMcpAuthorizationInputSchema)
			.output(HumanMcpConsentRevisionSchema),
		stageMultiOrgMcpConsent: oc
			.route({
				summary: "Stage a human MCP consent selection",
				description:
					"Authenticated browser decision; verifies the OAuth client and selected organizations, then stores an expiring candidate without replacing current access.",
			})
			.input(StageHumanMcpConsentInputSchema)
			.output(HumanMcpConsentRevisionSchema),
		revokeMultiOrgMcpConsent: oc
			.route({ summary: "Revoke a human MCP consent selection" })
			.input(RevokeHumanMcpConsentInputSchema)
			.output(HumanMcpConsentRevisionSchema),
		/** Internal, service-bound recheck before every human MCP call. */
		verifyMultiOrgMcpGrant: oc
			.route({
				summary: "Verify a current human MCP OAuth grant",
				description:
					"Check live Descope consent, signed selection and membership; atomically activate a matching pending candidate only after verification. Internal service binding only.",
			})
			.input(VerifyHumanMcpGrantInputSchema)
			.output(VerifyHumanMcpGrantResultSchema),

		/**
		 * Resolve the public MCP gateway used by first-run CLI login.
		 * GET /organizations/cli-workspace/{slug}
		 *
		 * This intentionally returns no organization id, Descope tenant id, member
		 * data, or credentials. The gateway hostname is already a public OAuth/MCP
		 * resource; this endpoint only maps the human-facing organization slug to it.
		 */
		resolveCliWorkspace: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/cli-workspace/{slug}",
				summary: "Resolve an organization CLI workspace",
				description:
					"Resolve an organization slug to its public unified MCP gateway for first-run CLI OAuth login.",
			})
			.input(SlugParamSchema)
			.output(
				z.object({
					slug: z.string(),
					name: z.string(),
					gatewayUrl: z.url(),
				}),
			),

		// =========================================================================
		// ORGANIZATION CRUD
		// =========================================================================

		/**
		 * List all organizations for the current user
		 * GET /organizations/mine
		 */
		listMine: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/mine",
				summary: "List my organizations",
				description: "List all organizations the current user is a member of",
			})
			.input(
				PaginationSchema.extend({
					activeOnly: z.boolean().optional().default(true),
				}),
			)
			.output(
				createPaginatedResponseSchema(
					z.object({
						member: MemberSchema,
						organizationId: z.string(),
						organizationName: z.string(),
						organizationSlug: z.string(),
						organizationLogoUrl: z.string().nullable(),
						organizationType: OrganizationTypeSchema,
						descopeTenantId: z.string().nullable(),
						appsCount: z.number().nullable(),
						tediCount: z.number(),
					}),
				),
			),

		/**
		 * List ALL organizations the user is a D1 member of, with each org's
		 * resolved unified MCP gateway URL.
		 * GET /organizations/mine/all
		 *
		 * Unlike listMine (scoped to the JWT's current `tenants` claim), this uses
		 * D1 membership as the authority, so a tenant-scoped token (e.g. a
		 * per-gateway CLI login) can still enumerate every org the user belongs to.
		 * Read-only enumeration of the caller's OWN memberships.
		 */
		listAllMine: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/mine/all",
				summary: "List all my organizations (D1 membership authority)",
				description:
					"List every organization the current user is a member of in D1, regardless of the token's tenant claim, with each org's resolved unified MCP gateway URL.",
			})
			.input(
				PaginationSchema.extend({
					activeOnly: z.boolean().optional().default(true),
				}),
			)
			.output(
				createPaginatedResponseSchema(
					z.object({
						member: MemberSchema,
						organizationId: z.string(),
						organizationName: z.string(),
						organizationSlug: z.string(),
						organizationLogoUrl: z.string().nullable(),
						organizationType: OrganizationTypeSchema,
						descopeTenantId: z.string().nullable(),
						appsCount: z.number().nullable(),
						tediCount: z.number(),
						mcpGatewaySlug: z.string().nullable(),
						mcpGatewayUrl: z.string().nullable(),
					}),
				),
			),

		/**
		 * List the caller's active, provisioned OS organizations.
		 * RPC-only launcher projection: unlike listAllMine it excludes organizations
		 * without features.os and returns no gateway or operational metadata.
		 */
		listOsMine: oc
			.route({
				summary: "List my provisioned Tedix OS organizations",
				description:
					"List active D1 memberships whose organizations explicitly enable the Tedix OS, for the tenant-neutral os.tedix.dev launcher.",
			})
			.input(PaginationSchema)
			.output(
				createPaginatedResponseSchema(
					z.object({
						organizationId: z.string(),
						organizationName: z.string(),
						organizationSlug: z.string(),
						organizationLogoUrl: z
							.string()
							.nullable()
							.describe(
								"Optional organization branding; null when no launcher logo has been configured.",
							),
					}),
				),
			),

		/**
		 * Get my organization (creates if missing)
		 * GET /organizations/my
		 *
		 * User-authenticated endpoint that ensures the user has an organization.
		 * If the organization doesn't exist, it creates one based on JWT claims.
		 * Used by authenticated launcher bootstrap for org sync.
		 */
		getMyOrganization: oc
			.route({
				method: "GET",
				path: "/my",
				tags: ["internal"],
				summary: "Get my organization",
				description:
					"Internal bootstrap RPC. Get the current user's organization from JWT context and create organization/member state when missing.",
			})
			.input(z.object({}))
			.output(
				z.object({
					organization: OrganizationSchema,
					member: MemberSchema,
					created: z.object({
						organization: z.boolean(),
						member: z.boolean(),
					}),
				}),
			),

		/**
		 * Complete the signed-in owner's first-run Tedix OS setup.
		 *
		 * This is deliberately separate from the ordinary organization settings
		 * mutation: the apex launcher has account-level identity but no selected
		 * tenant yet. The handler proves active D1 ownership directly, then makes
		 * the existing organization launchable by enabling features.os.
		 */
		completeOsOnboarding: oc
			.route({
				method: "POST",
				path: "/os-onboarding",
				tags: ["internal"],
				summary: "Complete Tedix OS onboarding",
				description:
					"Name the signed-in owner's organization, choose its canonical OS hostname, and explicitly enable Tedix OS. The operation is idempotent and never selects a tenant for the launcher.",
			})
			.input(
				z.object({
					organizationId: z
						.uuid()
						.describe(
							"Existing organization bootstrapped for the signed-in user.",
						),
					name: z
						.string()
						.trim()
						.min(1)
						.max(100)
						.describe("Human-readable organization name."),
					slug: z
						.string()
						.trim()
						.min(1)
						.max(63)
						.regex(SURFACE_SLUG_PATTERN)
						.describe(
							"Canonical hostname label for https://{slug}.os.tedix.dev.",
						),
				}),
			)
			.output(OrganizationSchema),

		/**
		 * List organizations with pagination
		 * GET /organizations
		 */
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				tags: ["internal"],
				summary: "List all organizations (platform admin)",
				description:
					"Internal platform-admin inventory across every organization.",
			})
			.input(PaginationSchema)
			.output(createPaginatedResponseSchema(OrganizationListItemSchema)),

		/**
		 * Get organization by ID
		 * GET /organizations/{organizationId}
		 */
		get: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{organizationId}",
				summary: "Get organization by ID",
				description: "Get detailed information about a specific organization",
			})
			.input(z.object({ organizationId: z.uuid() }))
			.output(OrganizationSchema),

		/**
		 * Get organization by slug
		 * GET /organizations/slug/{slug}
		 */
		getBySlug: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/slug/{slug}",
				summary: "Get organization by slug",
				description: "Get organization information by its unique slug",
			})
			.input(SlugParamSchema)
			.output(OrganizationSchema),

		/**
		 * Check if slug is available
		 * GET /organizations/slug-check/{slug}
		 */
		isSlugAvailable: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/slug-check/{slug}",
				summary: "Check slug availability",
				description: "Check if an organization slug is available for use",
			})
			.input(SlugParamSchema)
			.output(z.object({ available: z.boolean() })),

		/**
		 * Create a new organization
		 * POST /organizations
		 */
		create: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "" as `/${string}`,
				summary: "Create organization",
				description:
					"Create a new organization with a canonical starter billing account.",
				successStatus: 201,
			})
			.input(CreateOrganizationInputSchema)
			.output(OrganizationSchema),

		/**
		 * Update an organization
		 * PATCH /organizations/{organizationId}
		 */
		update: oc
			.route({
				tags: ["REST"],
				method: "PATCH",
				path: "/{organizationId}",
				summary: "Update organization",
				description: "Update an existing organization",
			})
			.input(
				z
					.object({ organizationId: z.uuid() })
					.extend(UpdateOrganizationInputSchema.shape),
			)
			.output(OrganizationSchema),

		/**
		 * Cancel an organization (phase 1 of two-phase offboarding).
		 * POST /organizations/{organizationId}/cancel
		 *
		 * Stamps `metadata.cancelledAt`.
		 * Auth still works for the org (read-only operations remain available),
		 * but the org is now eligible for hard-delete after the grace period.
		 */
		cancel: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/{organizationId}/cancel",
				summary: "Cancel organization (phase 1 of offboarding)",
				description:
					"Mark org cancelled — eligible for hard-delete after the grace period (default 14 days). Reversible until delete fires.",
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					reason: z.string().max(500).optional(),
				}),
			)
			.output(OrganizationSchema),

		/**
		 * Delete an organization (phase 2 of two-phase offboarding).
		 * DELETE /organizations/{organizationId}
		 *
		 * Retires the D1 organization and its tedis while removing external access.
		 * Customer-owned memory remains recoverable. Requires
		 * either `force: true` (platform-admin escape hatch) OR the org to be
		 * marked cancelled in metadata for at least the grace period.
		 */
		delete: oc
			.route({
				tags: ["REST"],
				method: "DELETE",
				path: "/{organizationId}",
				summary: "Retire organization",
				description:
					"Retire an organization and its tedis without destroying customer-owned memory. External access is removed. Requires org cancelled >= grace period; force=true is restricted to platform-admin principals.",
				successStatus: 200,
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					force: z.boolean().optional().default(false),
				}),
			)
			.output(SuccessResponseSchema),

		// =========================================================================
		// DESCOPE SYNC (Internal)
		// =========================================================================

		/**
		 * Sync organization and member from Descope
		 * POST /organizations/sync-from-descope
		 *
		 * Internal endpoint used during auth callback to ensure
		 * organization and member records exist in D1 after Descope login
		 */
		syncFromDescope: oc
			.route({
				method: "POST",
				path: "/sync-from-descope",
				summary: "Sync from Descope",
				description:
					"Sync organization and member from Descope IDs (internal auth flow)",
				tags: ["internal"],
			})
			.input(
				z.object({
					descopeTenantId: z.string(),
					descopeUserId: z.string(),
					email: z.email(),
					name: z.string().optional(),
					role: MemberRoleSchema.optional().default("member"),
				}),
			)
			.output(
				z.object({
					organization: OrganizationSchema,
					member: MemberSchema,
				}),
			),

		// =========================================================================
		// FEATURES
		// =========================================================================

		/**
		 * Get organization features
		 * GET /organizations/{organizationId}/features
		 */
		getFeatures: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{organizationId}/features",
				summary: "Get organization features",
				description:
					"Get the effective features for an organization (including tier defaults)",
			})
			.input(z.object({ organizationId: z.uuid() }))
			.output(OrganizationFeaturesSchema),

		/** Repair a stale custom-domain feature snapshot for an eligible plan. */
		repairCmsDomainEntitlement: oc
			.route({
				summary: "Repair CMS custom-domain entitlement",
				description:
					"Platform-only repair when an organization's active billing plan includes custom domains but its stored feature snapshot disables them.",
			})
			.input(z.object({ organizationId: z.uuid() }))
			.output(
				z.object({
					organizationId: z.uuid(),
					planKey: z.enum(["business", "enterprise"]),
					customDomain: z.literal(true),
					repaired: z.boolean(),
				}),
			),

		/**
		 * Check if organization can create a new app
		 * GET /organizations/{organizationId}/can-create-app
		 */
		canCreateApp: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{organizationId}/can-create-app",
				summary: "Check app creation eligibility",
				description:
					"Check if the organization can create a new app based on limits",
			})
			.input(z.object({ organizationId: z.uuid() }))
			.output(
				z.object({ allowed: z.boolean(), reason: z.string().optional() }),
			),

		// =========================================================================
		// API KEYS
		// =========================================================================

		/**
		 * List API keys for an organization
		 * GET /organizations/{organizationId}/api-keys
		 */
		listApiKeys: oc
			.route({
				method: "GET",
				path: "/{organizationId}/api-keys",
				summary: "List API keys",
				description: "List all API keys for an organization",
			})
			.input(
				z.object({ organizationId: z.uuid() }).extend({
					...PaginationSchema.shape,
					status: ApiKeyStatusSchema.optional(),
					environment: ApiKeyEnvironmentSchema.optional(),
				}),
			)
			.output(createPaginatedResponseSchema(ApiKeySchema)),

		/**
		 * Create a new API key
		 * POST /organizations/{organizationId}/api-keys
		 */
		createApiKey: oc
			.route({
				method: "POST",
				path: "/{organizationId}/api-keys",
				summary: "Create API key",
				description:
					"Create a new API key (returns raw key ONCE - must be saved by user)",
				successStatus: 201,
			})
			.input(CreateApiKeyInputSchema.extend({ organizationId: z.uuid() }))
			.output(
				z.object({
					rawKey: z.string(),
					apiKey: ApiKeySchema,
				}),
			),

		/**
		 * Revoke an API key
		 * POST /organizations/{organizationId}/api-keys/{keyId}/revoke
		 */
		revokeApiKey: oc
			.route({
				method: "POST",
				path: "/{organizationId}/api-keys/{keyId}/revoke",
				summary: "Revoke API key",
				description: "Revoke an API key (soft delete with audit trail)",
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					keyId: z.uuid(),
					reason: z.string().max(500).optional(),
				}),
			)
			.output(ApiKeySchema),

		/**
		 * Delete an API key (hard delete)
		 * DELETE /organizations/{organizationId}/api-keys/{keyId}
		 */
		deleteApiKey: oc
			.route({
				method: "DELETE",
				path: "/{organizationId}/api-keys/{keyId}",
				summary: "Delete API key",
				description:
					"Permanently delete an API key (requires owner role, use revoke instead)",
				successStatus: 200,
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					keyId: z.uuid(),
				}),
			)
			.output(SuccessResponseSchema),

		/**
		 * Rotate an API key
		 * POST /organizations/{organizationId}/api-keys/{keyId}/rotate
		 *
		 * Generates a new key, preserves the old key for a 24-hour grace period.
		 * Returns the new raw key (show once).
		 */
		rotateApiKey: oc
			.route({
				method: "POST",
				path: "/{organizationId}/api-keys/{keyId}/rotate",
				summary: "Rotate API key",
				description:
					"Generate a new API key. The old key remains valid for 24 hours during the grace period.",
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					keyId: z.uuid(),
				}),
			)
			.output(
				z.object({
					rawKey: z.string(),
					apiKey: ApiKeySchema,
				}),
			),

		// =========================================================================
		// SSO (DESCOPE S4)
		// =========================================================================

		/**
		 * Get SSO status for an organization
		 * GET /organizations/{organizationId}/sso
		 *
		 * Reads the org's Descope tenant settings and surfaces whether S4 is
		 * enabled, what auth type the customer has wired up, and which S4
		 * features are disabled.
		 */
		getSsoStatus: oc
			.route({
				method: "GET",
				path: "/{organizationId}/sso",
				summary: "Get SSO status",
				description:
					"Read SSO Setup Suite (S4) state and connection type for an organization's Descope tenant",
			})
			.input(z.object({ organizationId: z.uuid() }))
			.output(SsoStatusSchema),

		/**
		 * Configure SSO Setup Suite (S4) for an organization
		 * PATCH /organizations/{organizationId}/sso
		 *
		 * Enables/disables S4 self-service portal access on the customer's
		 * Descope tenant and optionally sets which features are exposed
		 * (saml/oidc/scim/ssoDomains/groupMapping).
		 */
		configureSso: oc
			.route({
				method: "PATCH",
				path: "/{organizationId}/sso",
				summary: "Configure SSO",
				description:
					"Enable/disable SSO Setup Suite (S4) and adjust disabled features for an organization",
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					settings: SsoSetupSuiteSettingsSchema,
				}),
			)
			.output(SsoStatusSchema),

		/**
		 * Generate a self-service S4 setup link
		 * POST /organizations/{organizationId}/sso/setup-link
		 *
		 * Returns a one-time link the customer's IT admin uses to configure
		 * their IdP (SAML/OIDC) via Descope's hosted S4 portal. The link
		 * is scoped to the org's Descope tenant and expires after
		 * `expireDuration` seconds (default 1h).
		 */
		generateSsoSetupLink: oc
			.route({
				method: "POST",
				path: "/{organizationId}/sso/setup-link",
				summary: "Generate SSO setup link",
				description:
					"Issue a self-service S4 portal URL for the customer's IT admin to configure SAML/OIDC",
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					expireDuration: z.number().positive().optional().default(3600),
					email: z.string().email().optional(),
				}),
			)
			.output(z.object({ url: z.string().url() })),

		/**
		 * Get API keys approaching expiry or overdue for rotation
		 * GET /organizations/{organizationId}/api-keys/expiring
		 */
		getExpiringKeys: oc
			.route({
				method: "GET",
				path: "/{organizationId}/api-keys/expiring",
				summary: "Get expiring API keys",
				description:
					"List API keys approaching expiry (within N days) or overdue for rotation",
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					withinDays: z.number().positive().optional().default(7),
				}),
			)
			.output(
				z.object({
					data: z.array(
						ApiKeySchema.extend({
							warningType: z.enum(["expiring", "rotation_overdue"]),
						}),
					),
				}),
			),
	});

export type OrganizationsContract = typeof organizationsContract;
