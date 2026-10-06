/**
 * Single source for the camelCase router → oRPC contract map used by the
 * schema-drift tooling (sync-tool-schemas, ToolSchemaSyncWorkflow).
 *
 * Endpoint shape: `<router>[/<sub-router>...]/<proc>`. Path is walked
 * segment-by-segment, so nested routers like `memoryGraph.gaps.detect` are
 * resolved correctly from `memoryGraph/gaps/detect`.
 */

import { getOpenAPIMeta } from "@orpc/openapi";
import { adapterBindingsContract } from "../contracts/adapter-bindings";
import { aeoContract } from "../contracts/aeo";
import { agentTurnTriageContract } from "../contracts/agent-turn-triage";
import { analyticsContract } from "../contracts/analytics";
import { appAdaptersContract } from "../contracts/app-adapters";
import { appGatingContract } from "../contracts/app-gating";
import { appToolsContract } from "../contracts/app-tools";
import { appsContract } from "../contracts/apps";
import { sitesContract } from "../contracts/sites";
import { auditContract } from "../contracts/audit";
import { billingContract } from "../contracts/billing";
import { browserContract } from "../contracts/browser";
import { capabilitiesContract } from "../contracts/capabilities";
import { catalogContract } from "../contracts/catalog";
import {
	knowledgeContract,
	muscleContract,
	skillsContract,
} from "../contracts/cognitive";
import { cognitiveRuntimeContract } from "../contracts/cognitive-runtime";
import { connectionsContract } from "../contracts/connections";
import { contentContract } from "../contracts/content";
import { controlPlaneContract } from "../contracts/control-plane";
import { descopeAihContract } from "../contracts/descope-aih";
import { directoryContract } from "../contracts/directory";
import { docsContract } from "../contracts/docs";
import { earnedDelegationContract } from "../contracts/earned-delegation";
import { externalAgentIdentityContract } from "../contracts/external-agent-identity";
import { flywheelHealthContract } from "../contracts/flywheel-health";
import { generatedWidgetArtifactsContract } from "../contracts/generated-widget-artifacts";
import { governanceContract } from "../contracts/governance";
import { graphRetrievalBenchmarksContract } from "../contracts/graph-retrieval-benchmarks";
import { growthSnapshotsContract } from "../contracts/growth-snapshots";
import { harnessContract } from "../contracts/harness";
import { imagesContract } from "../contracts/images";
import { itemsContract } from "../contracts/items";
import { jobsContract } from "../contracts/jobs";
import { kernelRuntimeContract } from "../contracts/kernel-runtime";
import { learningFeedbackContract } from "../contracts/learning-feedback";
import { listingsContract } from "../contracts/listings";
import { mcpCredentialsContract } from "../contracts/mcp-credentials";
import { mcpEvalContract } from "../contracts/mcp-eval";
import { mcpGovernanceContract } from "../contracts/mcp-governance";
import { mcpHealthContract } from "../contracts/mcp-health";
import { mcpNetworkSecurityContract } from "../contracts/mcp-network-security";
import { mcpPaymentsContract } from "../contracts/mcp-payments";
import { mcpServerContract } from "../contracts/mcp-server";
import { membersContract } from "../contracts/members";
import { memoryEntitiesContract } from "../contracts/memory-entities";
import { memoryGraphContract } from "../contracts/memory-graph";
import { orgUsageContract } from "../contracts/org-usage";
import { organizationPurposeContract } from "../contracts/organization-purpose";
import { organizationsContract } from "../contracts/organizations";
import { osTenantContract } from "../contracts/os-tenant";
import { osApprovalRulesContract } from "../contracts/os-approval-rules";
import { osComputeContract } from "../contracts/os-compute";
import { osSharesContract } from "../contracts/os-shares";
import { osWorkspacesContract } from "../contracts/os-workspaces";
import { modelCatalogContract } from "../contracts/model-catalog";
import { pluginsContract } from "../contracts/plugins";
import { projectsContract } from "../contracts/projects";
import { rationaleRecordsContract } from "../contracts/rationale-records";
import { roleTemplatesContract } from "../contracts/role-templates";
import { runtimeEntitlementsContract } from "../contracts/runtime-entitlements";
import {
	appSecretsContract,
	organizationSecretsContract,
} from "../contracts/secrets";
import { seoContract } from "../contracts/seo";
import { tediAppAssignmentsContract } from "../contracts/tedi-app-assignments";
import { tediApprovalsContract } from "../contracts/tedi-approvals";
import { tediEmailContract } from "../contracts/tedi-email";
import { tediObjectivesContract } from "../contracts/tedi-objectives";
import { tediSecretsContract } from "../contracts/tedi-secrets";
import { tediUsageContract } from "../contracts/tedi-usage";
import { tedisContract } from "../contracts/tedis";
import { templatesContract } from "../contracts/templates";
import { tenantCatalogContract } from "../contracts/tenant-catalog";
import { tenantMembershipContract } from "../contracts/tenant-membership";
import { tenantBehavioralEvalsContract } from "../contracts/tenant-behavioral-evals";
import { toolSchemaSyncContract } from "../contracts/tool-schema-sync";
import { userSettingsContract } from "../contracts/user-settings";
import { userProfileContract } from "../contracts/user-profile";
import { voiceContract } from "../contracts/voice";
import { waitlistContract } from "../contracts/waitlist";
import { widgetTestContract } from "../contracts/widget-test";
import { widgetTestRunsContract } from "../contracts/widget-test-runs";
import { workItemsContract } from "../contracts/work-items";
import { workApprovalsContract } from "../contracts/work-approvals";
import { workAgentSessionsContract } from "../contracts/work-agent-sessions";
import { workInteractionsContract } from "../contracts/work-interactions";
import { workFleetContract } from "../contracts/work-fleet";
import { workSchedulerContract } from "../contracts/work-scheduler";
import { workflowsContract } from "../contracts/workflows";
import {
	procedureInputSchema,
	procedureOutputSchema,
} from "./procedure-schemas";
import { isRecord } from "./is-record";

/**
 * Top-level oRPC routers, keyed by the camelCase name used in
 * `app_tools.config.endpoint` (`<router>/<...>/<proc>`).
 */
export const ROUTERS: Record<string, unknown> = {
	tenantBehavioralEvals: tenantBehavioralEvalsContract,
	adapterBindings: adapterBindingsContract,
	analytics: analyticsContract,
	appAdapters: appAdaptersContract,
	appGating: appGatingContract,
	appSecrets: appSecretsContract,
	appTools: appToolsContract,
	apps: appsContract,
	sites: sitesContract,
	audit: auditContract,
	billing: billingContract,
	browser: browserContract,
	capabilities: capabilitiesContract,
	catalog: catalogContract,
	tenantCatalog: tenantCatalogContract,
	connections: connectionsContract,
	content: contentContract,
	controlPlane: controlPlaneContract,
	cognitiveRuntime: cognitiveRuntimeContract,
	descopeAih: descopeAihContract,
	directory: directoryContract,
	docs: docsContract,
	flywheelHealth: flywheelHealthContract,
	generatedWidgetArtifacts: generatedWidgetArtifactsContract,
	graphRetrievalBenchmarks: graphRetrievalBenchmarksContract,
	governance: governanceContract,
	growthSnapshots: growthSnapshotsContract,
	harness: harnessContract,
	kernelRuntime: kernelRuntimeContract,
	learningFeedback: learningFeedbackContract,
	images: imagesContract,
	items: itemsContract,
	jobs: jobsContract,
	knowledge: knowledgeContract,
	listings: listingsContract,
	mcpCredentials: mcpCredentialsContract,
	mcpEval: mcpEvalContract,
	mcpGovernance: mcpGovernanceContract,
	mcpNetworkSecurity: mcpNetworkSecurityContract,
	mcpHealth: mcpHealthContract,
	mcpPayments: mcpPaymentsContract,
	mcpServer: mcpServerContract,
	members: membersContract,
	memoryGraph: memoryGraphContract,
	memoryEntities: memoryEntitiesContract,
	muscle: muscleContract,
	orgUsage: orgUsageContract,
	organizations: organizationsContract,
	osTenant: osTenantContract,
	osApprovalRules: osApprovalRulesContract,
	osCompute: osComputeContract,
	osShares: osSharesContract,
	osWorkspaces: osWorkspacesContract,
	modelCatalog: modelCatalogContract,
	organizationPurpose: organizationPurposeContract,
	plugins: pluginsContract,
	projects: projectsContract,
	rationaleRecords: rationaleRecordsContract,
	roleTemplates: roleTemplatesContract,
	runtimeEntitlements: runtimeEntitlementsContract,
	earnedDelegation: earnedDelegationContract,
	externalAgentIdentity: externalAgentIdentityContract,
	secrets: organizationSecretsContract,
	seo: seoContract,
	aeo: aeoContract,
	agentTurnTriage: agentTurnTriageContract,
	skills: skillsContract,
	tediAppAssignments: tediAppAssignmentsContract,
	tediApprovals: tediApprovalsContract,
	tediEmail: tediEmailContract,
	tediObjectives: tediObjectivesContract,
	tediSecrets: tediSecretsContract,
	tediUsage: tediUsageContract,
	tedis: tedisContract,
	templates: templatesContract,
	tenantMembership: tenantMembershipContract,
	toolSchemaSync: toolSchemaSyncContract,
	userSettings: userSettingsContract,
	userProfile: userProfileContract,
	waitlist: waitlistContract,
	voice: voiceContract,
	widgetTest: widgetTestContract,
	widgetTestRuns: widgetTestRunsContract,
	workItems: workItemsContract,
	workApprovals: workApprovalsContract,
	workAgentSessions: workAgentSessionsContract,
	workInteractions: workInteractionsContract,
	workFleet: workFleetContract,
	workScheduler: workSchedulerContract,
	workflows: workflowsContract,
};

/**
 * Why two return shapes: callers that want the raw zod input (e.g. drift
 * regen) need the schema; callers that want to surface "router/proc" for
 * logging want the parsed identity.
 */
export interface ResolvedContractEndpoint {
	/** Top-level router name (first segment). */
	router: string;
	/** Full nested path joined with "/" (e.g. `gaps/detect`). */
	procPath: string;
	/** Final segment — the procedure name. */
	proc: string;
	/** oRPC route metadata, when declared on the procedure. */
	route:
		| {
				method?: string;
				path?: string;
				operationId?: string;
				summary?: string;
				description?: string;
				tags?: string[];
				deprecated?: boolean;
		  }
		| undefined;
	/** The procedure's single input schema, resolved via `procedureInputSchema`. */
	inputSchema: unknown;
	/** The procedure's single output schema, if declared. */
	outputSchema: unknown | undefined;
}

/**
 * Walk a nested oRPC router by `endpoint` path. Returns null when:
 *   - endpoint has no `/`
 *   - first segment is not in {@link ROUTERS}
 *   - any intermediate segment is missing
 *   - leaf is not an oRPC procedure (no `~orpc` property at all)
 *
 * A procedure with no `.input()` is still resolved (inputSchema=undefined).
 * Per MCP 2025-11-25 spec § Tool, a tool with no parameters is valid — it
 * just expresses an empty object schema on the wire. Drift checkers and
 * regenerators should treat undefined inputSchema as the "no params" form,
 * not as a missing contract.
 *
 * Crucially, this walks segment-by-segment instead of splitting only once,
 * so `memoryGraph/optimize/scan` resolves to `memoryGraphContract.optimize.scan`.
 */
/**
 * The procedure's OpenAPI metadata with its router prefix already joined into
 * `path`.
 *
 * oRPC v1 handed back a single merged `route.path`. v2 propagates the router
 * prefix onto each leaf but keeps it in a separate `prefix` field, so reading
 * `path` alone silently drops it — `/flywheel/orphan-run-health` came back as
 * `/orphan-run-health`. Consumers here (the MCP tool projection, drift checks,
 * `sync-tool-schemas`) treat `route.path` as the full REST path, so the join
 * happens once, here.
 *
 * Collection procedures use `path: ""`, so joining a prefix preserves the
 * canonical unslashed collection path.
 */
function resolveEffectiveRoute(
	node: unknown,
): ResolvedContractEndpoint["route"] {
	const meta = getOpenAPIMeta(
		node as unknown as Parameters<typeof getOpenAPIMeta>[0],
	) as (ResolvedContractEndpoint["route"] & { prefix?: string }) | undefined;
	if (!meta) return undefined;
	const { prefix, path, ...rest } = meta;
	if (!prefix) return { ...rest, path } as ResolvedContractEndpoint["route"];
	const joined = path === undefined ? prefix : `${prefix}${path}`;
	return { ...rest, path: joined } as ResolvedContractEndpoint["route"];
}

export function resolveContractEndpoint(
	endpoint: string,
): ResolvedContractEndpoint | null {
	const segments = endpoint.split("/").filter(Boolean);
	if (segments.length < 2) return null;
	const router = segments[0];
	const rest = segments.slice(1);
	if (!router || rest.length === 0) return null;
	const root = ROUTERS[router];
	if (!root) return null;

	let node: unknown = root;
	for (const seg of rest) {
		if (!node || typeof node !== "object") return null;
		node = (node as Record<string, unknown>)[seg];
		if (node === undefined) return null;
	}
	// oRPC v2 removed `route` from the procedure definition — HTTP metadata moved
	// behind OpenAPI meta plugins — and turned the schemas into arrays. Presence
	// of `~orpc` is still what marks a procedure, but every field now comes from a
	// supported accessor rather than the private definition.
	if (!isRecord(node) || !("~orpc" in node)) return null;

	const proc = rest[rest.length - 1];
	if (!proc) return null;

	return {
		router,
		procPath: rest.join("/"),
		proc,
		route: resolveEffectiveRoute(node),
		inputSchema: procedureInputSchema(node),
		outputSchema: procedureOutputSchema(node),
	};
}

export interface ContractEndpointListOptions {
	/** Restrict discovery to a single top-level router. */
	router?: string;
	/** Restrict discovery to explicit `<router>/<proc>` endpoint paths. */
	endpoints?: string[];
	/** Include procedures tagged `internal`. Defaults to false. */
	includeInternal?: boolean;
}

function endpointIsInternal(endpoint: ResolvedContractEndpoint): boolean {
	return endpoint.route?.tags?.includes("internal") === true;
}

function walkContractRouter(
	router: string,
	node: unknown,
	path: string[],
	out: ResolvedContractEndpoint[],
): void {
	if (!isRecord(node)) return;

	if (isRecord(node["~orpc"])) {
		const endpoint = resolveContractEndpoint([router, ...path].join("/"));
		if (endpoint) out.push(endpoint);
		return;
	}

	for (const [key, child] of Object.entries(node)) {
		if (key === "~orpc") continue;
		walkContractRouter(router, child, [...path, key], out);
	}
}

/**
 * Flatten the oRPC contract registry into concrete endpoint paths that can be
 * projected into MCP app_tools rows. This is the create/delete counterpart to
 * {@link resolveContractEndpoint}, which only resolves already-known paths.
 */
export function listContractEndpoints(
	options: ContractEndpointListOptions = {},
): ResolvedContractEndpoint[] {
	const includeInternal = options.includeInternal === true;

	if (options.endpoints) {
		return options.endpoints
			.map((endpoint) => endpoint.trim())
			.filter(Boolean)
			.flatMap((endpoint) => {
				const resolved = resolveContractEndpoint(endpoint);
				return resolved ? [resolved] : [];
			})
			.filter((endpoint) => {
				if (options.router && endpoint.router !== options.router) return false;
				if (!includeInternal && endpointIsInternal(endpoint)) return false;
				return true;
			})
			.sort((left, right) =>
				`${left.router}/${left.procPath}`.localeCompare(
					`${right.router}/${right.procPath}`,
				),
			);
	}

	const endpoints: ResolvedContractEndpoint[] = [];
	for (const [router, contract] of Object.entries(ROUTERS)) {
		if (options.router && router !== options.router) continue;
		walkContractRouter(router, contract, [], endpoints);
	}

	return endpoints
		.filter((endpoint) => {
			if (!includeInternal && endpointIsInternal(endpoint)) return false;
			return true;
		})
		.sort((left, right) =>
			`${left.router}/${left.procPath}`.localeCompare(
				`${right.router}/${right.procPath}`,
			),
		);
}
