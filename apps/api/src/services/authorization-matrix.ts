import { listContractEndpoints } from "@tedix/api-contract/utils/contract-routers";
import { resolveMcpToolRequiredScopes } from "@tedix/mcp-shared/auth/tool-scopes";
import { planToolSchemaSyncProjection } from "./tool-schema-sync";

export type ObjectAuthorizationReview = {
	endpoint: string;
	authority:
		| "descope_fga"
		| "downstream_per_user"
		| "tenant_object"
		| "platform"
		| "public";
	objectCheck: string;
	negativeTest: string;
};

// Exact endpoints only: a sibling's test never certifies a whole router or scope.
export const OBJECT_AUTHORIZATION_REVIEWS: ObjectAuthorizationReview[] = [
	{
		endpoint: "tediAppAssignments/listFgaRelationsByApp",
		authority: "tenant_object",
		objectCheck:
			"apps/api/src/rpc/routers/tedi-app-assignments.ts: listFgaRelationsByApp checks app.organizationId before querying Descope",
		negativeTest:
			"apps/api/src/rpc/routers/tedi-app-assignments.fga-relations.test.ts: refuses an app outside the caller's organization before querying Descope",
	},
	{
		endpoint: "tediAppAssignments/listFgaRelationsByTedi",
		authority: "tenant_object",
		objectCheck:
			"apps/api/src/rpc/routers/tedi-app-assignments.ts: listFgaRelationsByTedi checks tedi.organizationId and withholds foreign app identifiers",
		negativeTest:
			"apps/api/src/rpc/routers/tedi-app-assignments.fga-relations.test.ts: refuses a tedi outside the caller's organization before querying Descope",
	},
];

export function buildAuthorizationMatrix(
	reviews: ObjectAuthorizationReview[] = OBJECT_AUTHORIZATION_REVIEWS,
) {
	const endpoints = listContractEndpoints({ includeInternal: true });
	const paths = new Set(endpoints.map((e) => `${e.router}/${e.procPath}`));
	const byEndpoint = new Map<string, ObjectAuthorizationReview>();
	for (const review of reviews) {
		if (!paths.has(review.endpoint))
			throw new Error(`Unknown reviewed endpoint: ${review.endpoint}`);
		if (byEndpoint.has(review.endpoint))
			throw new Error(`Duplicate review: ${review.endpoint}`);
		if (!review.objectCheck.trim() || !review.negativeTest.trim()) {
			throw new Error(
				`Incomplete object authorization review: ${review.endpoint}`,
			);
		}
		byEndpoint.set(review.endpoint, review);
	}
	const projection = planToolSchemaSyncProjection(
		{},
		"00000000-0000-4000-8000-000000000001",
	);
	const projected = new Set(projection.endpoints);
	const rows = endpoints.map((e) => {
		const endpoint = `${e.router}/${e.procPath}`;
		const toolId = projected.has(endpoint)
			? (projection.toolIds[endpoint] ?? null)
			: null;
		let scopes: string[] | null = null;
		let scopeError: string | null = null;
		if (toolId) {
			try {
				scopes = resolveMcpToolRequiredScopes(
					{
						toolId: `acme_unified__${toolId}`,
						toolTypeId: "rpc",
						authRequired: true,
						config: { endpoint },
					},
					"acme_unified",
					{ enforcePolicies: false, authMode: "authenticated" },
					{ fallbackOnAuthenticatedAuthMode: true },
				);
			} catch (error) {
				scopeError = error instanceof Error ? error.message : String(error);
			}
		}
		return {
			endpoint,
			domain: e.router,
			internal: e.route?.tags?.includes("internal") === true,
			rest: e.route?.tags?.includes("REST") === true,
			mcp: { toolId, scopes, scopeError },
			objectAuthorization: byEndpoint.get(endpoint) ?? null,
		};
	});
	return {
		resourceModel:
			"AIH Resource identifies the MCP server audience; concrete object IDs remain downstream authorization inputs.",
		ingress: {
			audience:
				"apps/mcp/src/auth-helpers.ts: resource audience and attested AIH M2M client validation",
			scopes:
				"apps/mcp/src/mcp-access.ts and apps/mcp/src/mcp/tool-registration-policy.ts",
			api: "apps/api/src/rpc/orpc.ts: human RBAC and machine scopes; object ownership is a separate handler/query check",
		},
		limitations: [
			"Source inventory, not a live tenant configuration or deployment attestation.",
			"Review references identify tests to run; they do not attest a test execution.",
			"Dynamic app_tools rows, non-RPC transports, code-built tools and Worker HTTP routes require separate runtime inventories.",
			"API scopes may differ from MCP scopes; MCP scope projection does not certify API authorization.",
		],
		rows,
		unreviewedEndpoints: rows
			.filter((r) => !r.objectAuthorization)
			.map((r) => r.endpoint),
		unmappedMcpEndpoints: rows
			.filter((r) => r.mcp.toolId && !r.mcp.scopes)
			.map((r) => r.endpoint),
	};
}
