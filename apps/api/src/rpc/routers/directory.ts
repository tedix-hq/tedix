import { implement } from "@orpc/server";
import { directoryContract } from "@tedix/api-contract/contracts/directory";
import type { JWTPayload } from "@tedix/auth/types";
import {
	getMemberByUserId,
	getOrganizationAggregatorGateways,
	getUserOrganizationMemberships,
} from "@tedix/db/queries/organization-members";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	getOrganizationSurfaceSignals,
	type OrganizationSurfaceSignals,
} from "@tedix/db/queries/tenant-directory";
import { buildSurfaceUrl } from "@tedix/tenant-directory";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";

/**
 * Cross-surface workspace directory for the tenant-neutral launcher.
 *
 * A caller-scoped, D1-authoritative read model: it enumerates the surfaces
 * (OS, MCP, CMS) each authenticated user's organizations exposes
 * and builds their canonical URLs and browser session handoffs server-side via
 * `@tedix/tenant-directory`.
 *
 * Fail-closed by construction. `provisionComplete` gates the whole org on a
 * minted Descope tenant; an org without one is disabled and every surface
 * reports `provisioned:false`, with null canonical and handoff URLs. Each
 * surface additionally
 * requires its own live D1 signal (OS `features.os`, CMS
 * `blogConfig.enabled`, MCP unified gateway row).
 *
 * Cache posture: this endpoint reads D1 live and holds no cache of its own. The
 * downstream per-surface resolvers cache with no push-purge for their positive
 * TTLs (OS edge 300s, CMS 5min, MCP aggregate ~12min), so a
 * just-provisioned surface may report `provisioned:true` here before the
 * surface edge itself serves it. The directory must never be cached longer than
 * the smallest of those windows; today it caches nothing.
 */
const directoryOs = implement(directoryContract).$context<BaseContext>();
const authed = directoryOs.use(withAuth);

type OrgCore = {
	organizationId: string;
	slug: string;
	name: string;
	descopeTenantId: string | null;
	os: boolean;
};

type SurfaceRecord = {
	surface: "os" | "mcp" | "cms";
	provisioned: boolean;
	canonicalUrl: string | null;
	handoffUrl: string | null;
	customDomain?: string;
};

/** `tedix.dev` in production, `tedix.tech` everywhere else. */
function platformDomainFor(environment: string | undefined): string {
	return environment === "production" ? "tedix.dev" : "tedix.tech";
}

function tenantSurfaceHandoffUrl(
	surface: "os" | "cms",
	org: OrgCore,
	platformDomain: string,
): string {
	const origin = buildSurfaceUrl(surface, org.slug, { platformDomain });
	if (!origin || !org.descopeTenantId) {
		throw new Error(`${surface} handoff requires a provisioned organization`);
	}
	const handoff = new URL(
		surface === "cms"
			? "/_emdash/api/auth/session-broker/start"
			: "/auth/session-broker/start",
		origin,
	);
	handoff.searchParams.set("tenant_id", org.descopeTenantId);
	handoff.searchParams.set(
		"redirect_to",
		surface === "cms" ? "/_emdash/admin" : "/",
	);
	return handoff.toString();
}

/**
 * Normalize an org + its provision signals + its unified MCP gateway into a
 * single directory record. Every surface is gated on `provisionComplete` first,
 * then on its own live signal; a per-surface custom domain overrides the
 * platform subdomain when present.
 */
function buildWorkspaceRecord(
	org: OrgCore,
	signals: OrganizationSurfaceSignals | undefined,
	gateway: { slug: string; customMcpDomain: string | null } | undefined,
	platformDomain: string,
) {
	const provisionComplete = org.descopeTenantId != null;
	const surfaces: SurfaceRecord[] = [];

	// OS — org-level os. No custom-domain path (wildcard subdomain only).
	{
		const provisioned = provisionComplete && org.os;
		surfaces.push({
			surface: "os",
			provisioned,
			canonicalUrl: provisioned
				? buildSurfaceUrl("os", org.slug, { platformDomain })
				: null,
			handoffUrl: provisioned
				? tenantSurfaceHandoffUrl("os", org, platformDomain)
				: null,
		});
	}

	// MCP — org-wide unified gateway app; slug is the gateway's, not the org's.
	{
		const provisioned = provisionComplete && gateway != null;
		let canonicalUrl: string | null = null;
		let customDomain: string | undefined;
		if (provisioned && gateway) {
			if (gateway.customMcpDomain) {
				customDomain = gateway.customMcpDomain;
				canonicalUrl = `https://${gateway.customMcpDomain}/mcp`;
			} else {
				canonicalUrl = buildSurfaceUrl("mcp", gateway.slug, {
					platformDomain,
					path: "endpoint",
				});
			}
		}
		surfaces.push({
			surface: "mcp",
			provisioned,
			canonicalUrl,
			handoffUrl: null,
			...(customDomain ? { customDomain } : {}),
		});
	}

	// CMS — any app has blogConfig.enabled; cmsDomain overrides.
	{
		const provisioned = provisionComplete && signals?.cmsEnabled === true;
		let canonicalUrl: string | null = null;
		let customDomain: string | undefined;
		if (provisioned) {
			if (signals?.cmsDomain) {
				customDomain = signals.cmsDomain;
				canonicalUrl = `https://${signals.cmsDomain}/_emdash/admin`;
			} else {
				const origin = buildSurfaceUrl("cms", org.slug, { platformDomain });
				canonicalUrl = origin
					? new URL("/_emdash/admin", origin).toString()
					: null;
			}
		}
		surfaces.push({
			surface: "cms",
			provisioned,
			canonicalUrl,
			handoffUrl: provisioned
				? tenantSurfaceHandoffUrl("cms", org, platformDomain)
				: null,
			...(customDomain ? { customDomain } : {}),
		});
	}

	return {
		org: {
			organizationId: org.organizationId,
			slug: org.slug,
			name: org.name,
			descopeTenantId: org.descopeTenantId,
			provisionComplete,
		},
		surfaces,
	};
}

/**
 * Enumerate the caller's OWN active memberships. Scoped strictly to `user.sub`
 * — the caller supplies no organization id, so it exposes nothing beyond the
 * user's own memberships and grants no cross-org access.
 */
const listMyWorkspaces = authed.listMyWorkspaces
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires a human subject and enumerates only that subject's organization memberships.",
			},
			"apps:read",
		),
	)
	.handler(async ({ input, context }) => {
		const { db, user } = context as BaseContext & { user?: JWTPayload };
		const { limit = 50, offset = 0 } = input;
		if (!user?.sub) {
			throw createError(
				ErrorCodes.UNAUTHORIZED,
				"User authentication required",
			);
		}

		const memberships = await getUserOrganizationMemberships(db, user.sub, {
			activeOnly: true,
		});
		const organizationIds = memberships.map((m) => m.organizationId);
		const [signals, gateways] = await Promise.all([
			getOrganizationSurfaceSignals(db, organizationIds),
			getOrganizationAggregatorGateways(db, organizationIds),
		]);
		const platformDomain = platformDomainFor(context.env.ENVIRONMENT);

		const records = memberships.map((m) =>
			buildWorkspaceRecord(
				{
					organizationId: m.organizationId,
					slug: m.organizationSlug,
					name: m.organizationName,
					descopeTenantId: m.descopeTenantId,
					os: signals.get(m.organizationId)?.os === true,
				},
				signals.get(m.organizationId),
				gateways.get(m.organizationId),
				platformDomain,
			),
		);

		const data = records.slice(offset, offset + limit);
		return {
			data,
			pagination: {
				limit,
				offset,
				total: records.length,
				hasMore: offset + data.length < records.length,
			},
		};
	});

/**
 * Resolve a single workspace by UUID. Binds the caller's active membership to
 * the requested organization BEFORE returning anything; a non-member or unknown
 * org resolves to null (fail closed), so the caller-supplied id can never read
 * another tenant's directory record.
 */
const resolveWorkspace = authed.resolveWorkspace
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires a human subject and returns a record only for an organization that subject is an active member of.",
			},
			"apps:read",
		),
	)
	.handler(async ({ input, context }) => {
		const { db, user } = context as BaseContext & { user?: JWTPayload };
		if (!user?.sub) {
			throw createError(
				ErrorCodes.UNAUTHORIZED,
				"User authentication required",
			);
		}

		// Bind the caller to the requested org: only an active member resolves.
		const membership = await getMemberByUserId(
			db,
			input.organizationId,
			user.sub,
		);
		if (!membership || membership.status !== "active") return null;

		const organization = await getOrganizationById(db, input.organizationId);
		if (!organization) return null;

		const [signals, gateways] = await Promise.all([
			getOrganizationSurfaceSignals(db, [organization.id]),
			getOrganizationAggregatorGateways(db, [organization.id]),
		]);
		const platformDomain = platformDomainFor(context.env.ENVIRONMENT);

		return buildWorkspaceRecord(
			{
				organizationId: organization.id,
				slug: organization.slug,
				name: organization.name,
				descopeTenantId: organization.descopeTenantId ?? null,
				os: organization.features?.os === true,
			},
			signals.get(organization.id),
			gateways.get(organization.id),
			platformDomain,
		);
	});

export const directoryContractRouter = directoryOs.router({
	listMyWorkspaces,
	resolveWorkspace,
});
