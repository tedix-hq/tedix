import { getOpenAPIMeta } from "@orpc/openapi";

/**
 * Canonical external REST inventory used by tests and review tooling.
 *
 * Runtime publication is marked directly on each procedure with the `REST`
 * metadata tag. Keeping this human-readable inventory outside the Worker
 * import graph avoids paying for a second copy of every method and path in
 * production while the spec test still proves exact equality.
 */
export const PUBLIC_REST_OPERATION_LIST = [
	/** Stable customer account checkout, portal, plan, status, and overview resources. */
	"POST /billing/checkout",
	"POST /billing/inference-capacity/checkout",
	"GET /billing/inference-capacity/sponsorships",
	"PUT /billing/inference-capacity/sponsorships/{installationId}",
	"POST /billing/portal",
	"GET /billing/plans",
	"GET /billing/overview",
	/** First-class customer tenant lifecycle and membership resources. */
	"GET /organizations/cli-workspace/{slug}",
	"GET /organizations/mine",
	"GET /organizations/mine/all",
	"GET /organizations/{organizationId}",
	"PATCH /organizations/{organizationId}",
	"DELETE /organizations/{organizationId}",
	"GET /organizations/slug/{slug}",
	"GET /organizations/slug-check/{slug}",
	"POST /organizations",
	"POST /organizations/{organizationId}/cancel",
	"GET /organizations/{organizationId}/features",
	"GET /organizations/{organizationId}/can-create-app",
	"GET /organizations/{organizationId}/members",
	"GET /organizations/{organizationId}/members/{memberId}",
	"DELETE /organizations/{organizationId}/members/{memberId}",
	"POST /organizations/{organizationId}/members/invite",
	"PATCH /organizations/{organizationId}/members/{memberId}/role",
	"PUT /organizations/{organizationId}/members/{memberId}/permissions",
	"POST /organizations/invitations/{memberId}/accept",
	/** Stable developer configuration model: app records plus adapters and tools. */
	"GET /apps",
	"POST /apps",
	"GET /apps/{appId}",
	"PATCH /apps/{appId}",
	"DELETE /apps/{appId}",
	"GET /apps/slug/{slug}",
	"GET /apps/slug-check/{slug}",
	"GET /apps/{appId}/adapters",
	"POST /apps/{appId}/adapters",
	"GET /apps/{appId}/adapters/{adapterId}",
	"PATCH /apps/{appId}/adapters/{adapterId}",
	"DELETE /apps/{appId}/adapters/{adapterId}",
	"POST /apps/{appId}/adapters/preflight",
	"GET /apps/{appId}/tools",
	"POST /apps/{appId}/tools",
	"GET /apps/{appId}/tools/{toolId}",
	"PATCH /apps/{appId}/tools/{toolId}",
	"DELETE /apps/{appId}/tools/{toolId}",
	"PUT /apps/{appId}/tools/order",
	"POST /apps/{appId}/tools/preflight",
	/** Supported external catalog discovery and tenant installation workflow. */
	"GET /catalog/apps",
	"GET /catalog/apps/{slug}",
	"GET /catalog/categories",
	"GET /catalog/stats",
	"GET /catalog/health-summary",
	"POST /catalog/apps/{catalogAppId}/install",
	"POST /catalog/install-tenant-mcp-app",
	"POST /catalog/install-tenant-mcp-apps",
	"POST /catalog/uninstall-tenant-mcp-app",
	"POST /catalog/tenant-openapi-mcp-app",
	/** Stable tedi identity, status, and assignment resources; runtime internals excluded. */
	"GET /tedis",
	"POST /tedis",
	"GET /tedis/{tediId}",
	"PATCH /tedis/{tediId}",
	"DELETE /tedis/{tediId}",
	"GET /tedis/{tediId}/status",
	"GET /tedi-app-assignments/by-app/{appId}",
	"GET /tedi-app-assignments/by-tedi/{tediId}",
	"POST /tedi-app-assignments",
	"PATCH /tedi-app-assignments/{assignmentId}",
	"DELETE /tedi-app-assignments/{assignmentId}",
	/** Global template browse/apply for controlled organizations; registry writes excluded. */
	"GET /templates",
	"GET /templates/{templateId}",
	"POST /templates/apply",
	/** Scoped operator cost, usage, and audit reads without runtime payload internals. */
	"GET /organizations/{organizationId}/usage",
	"GET /organizations/{organizationId}/cost-drilldown",
	"GET /organizations/{organizationId}/billing-ledger",
	"GET /tedis/{tediId}/usage",
	"GET /tedis/{tediId}/call-costs",
	"GET /audit",
	"GET /audit/resource/{resourceType}/{resourceId}",
] as const;

export const PUBLIC_REST_OPERATIONS = new Set<string>(
	PUBLIC_REST_OPERATION_LIST,
);

export function getPublicOperationKey(
	contract: Parameters<typeof getOpenAPIMeta>[0],
): string | null {
	const meta = getOpenAPIMeta(contract);
	if (!meta?.method || meta.path === undefined) return null;
	const path = `${meta.prefix ?? ""}${meta.path}`.replace(/\/{2,}/g, "/");
	return `${meta.method.toUpperCase()} ${path.startsWith("/") ? path : `/${path}`}`;
}
