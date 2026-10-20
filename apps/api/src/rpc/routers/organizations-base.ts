/** Shared oRPC implementers and cross-cutting helpers for the organizations router modules. */
import { getDescopeManagement } from "../../lib/descope-management";
import { implement } from "@orpc/server";
import { organizationsContract } from "@tedix/api-contract/contracts/organizations";
import type { OrganizationPermission } from "@tedix/api-contract/schemas/user-settings";
import { isTenantGrantablePermission } from "@tedix/auth/rbac";
import { type BaseContext, createError, ErrorCodes, withAuth } from "../orpc";

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
export const organizationsOs = implement(
	organizationsContract,
).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all organization endpoints require authentication
 */
export const authedOrganizationsOs = organizationsOs.use(withAuth);

export function mcpDomainForEnvironment(
	environment: string | undefined,
): string {
	return environment === "production" ? "mcp.tedix.dev" : "mcp.tedix.tech";
}

export function gatewayUrl(
	gateway: { slug: string; customMcpDomain: string | null },
	environment: string | undefined,
	mcpOrigin?: string,
): string {
	if (!gateway.customMcpDomain && environment !== "production" && mcpOrigin) {
		try {
			const local = new URL(mcpOrigin);
			if (
				local.protocol === "http:" &&
				(local.hostname === "localhost" || local.hostname === "127.0.0.1")
			) {
				return `http://${gateway.slug}.localhost${local.port ? `:${local.port}` : ""}/mcp`;
			}
		} catch {
			// An invalid optional origin cannot replace the normal Cloud endpoint.
		}
	}
	const host =
		gateway.customMcpDomain ??
		`${gateway.slug}.${mcpDomainForEnvironment(environment)}`;
	return `https://${host}/mcp`;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Cross-check D1 org memberships against the user's LIVE Descope tenant
 * grants — a defense against drift between D1 (Tedix's local membership
 * cache) and Descope (identity source of truth). Tedix JWTs only carry the
 * current tenant's claims, so this can no longer be answered from the token;
 * it queries the Descope Management API directly instead, which is also
 * strictly more correct than the old JWT-snapshot check (immune to the
 * "switched to org A, still see org B" stale-token class of bug).
 */
export async function filterMembershipsByLiveDescopeTenants<
	T extends {
		organizationType: "personal" | "organization";
		descopeTenantId: string | null;
	},
>(memberships: T[], descopeUserId: string, env: CloudflareEnv): Promise<T[]> {
	const personalTenantId = `personal_${descopeUserId}`;
	const mgmt = getDescopeManagement(env);
	let liveTenantIds: Set<string> | null = null;
	if (mgmt) {
		try {
			const resp = await mgmt.management.user.loadByUserId(descopeUserId);
			liveTenantIds = new Set(
				(resp.data?.userTenants ?? []).map((t) => t.tenantId),
			);
		} catch (error) {
			console.warn(
				"[organizations.listMine] Failed to load live Descope tenants — trusting D1 membership instead:",
				error,
			);
		}
	}

	// No management key configured, or the live check errored: trust D1 alone
	// rather than hiding every non-personal org on a transient failure.
	if (!liveTenantIds) return memberships;

	return memberships.filter((membership) => {
		const tenantId = membership.descopeTenantId;
		if (!tenantId) return false;
		if (tenantId === personalTenantId) return true;
		if (membership.organizationType === "personal") return false;
		return liveTenantIds.has(tenantId);
	});
}

/**
 * Map DB organization to contract shape.
 * Contract uses `descopeTenantId` directly.
 */
export function mapOrgToContract(
	org: Record<string, unknown> & {
		id: string;
		name: string;
		slug: string;
		type?: string | null;
		descopeTenantId?: string | null;
		logoUrl?: string | null;
		description?: string | null;
		appsCount?: number | null;
		features?: unknown;
		metadata?: unknown;
		createdAt: string | null;
		updatedAt: string | null;
	},
) {
	return {
		id: org.id,
		name: org.name,
		slug: org.slug,
		type: (org.type ?? "organization") as "personal" | "organization",
		descopeTenantId: org.descopeTenantId ?? null,
		logoUrl: org.logoUrl ?? null,
		description: org.description ?? null,
		appsCount: org.appsCount ?? null,
		features: (org.features ?? null) as Record<string, unknown> | null,
		metadata: (org.metadata ?? null) as Record<string, unknown> | null,
		createdAt: org.createdAt,
		updatedAt: org.updatedAt,
	};
}

export function requireOrganizationAccess(
	context: BaseContext,
	organizationId: string,
): void {
	const contextOrgId = context.organizationId;
	if (!contextOrgId || contextOrgId !== organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Organization access denied for this resource",
		);
	}
}

export function requireAdminOrOwner(context: BaseContext): void {
	const role = context.userRole;
	if (!role || !["admin", "owner"].includes(role)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only admins and owners can perform this action",
		);
	}
}
/**
 * Overrides as the guards see them.
 *
 * `userHoldsPermission` filters this column to `TENANT_GRANTABLE_PERMISSIONS`
 * before honoring it, so every surface that REPORTS it must apply the same
 * filter — otherwise the product would show authority the API ignores, which is
 * the defect this whole model unification removes.
 */
export function filterGrantableOverrides(
	value: unknown,
): OrganizationPermission[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter(
		(entry): entry is OrganizationPermission =>
			typeof entry === "string" && isTenantGrantablePermission(entry),
	);
}
