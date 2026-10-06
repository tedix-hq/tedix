/**
 * oRPC Router Index
 * Combined router export - NOT a barrel file
 *
 * All routers use contract-first design (no legacy endpoints).
 *
 * Every router here is authenticated. There is no public/unauthenticated
 * router group: a `publicRouters` split existed but was an empty object
 * spread into `apiRouter`, so it has been removed along with its unused
 * `ProtectedRouters`/`PublicRouters` type exports.
 *
 * Authentication Strategy:
 * Most routers apply `withAuth` at the contract implementer level (via
 * `.use(withAuth)` on the implementer), so individual procedures inherit
 * user/apikey auth.
 *
 * Mixed Auth Patterns:
 * Some routers build on the bare implementer to allow mixed auth strategies
 * and apply auth per procedure instead:
 * - organizations: user auth for most procedures, service auth for syncFromDescope
 * - analytics: user auth for getMetrics, service auth for tracking endpoints
 *
 * Procedure-level logging is NOT applied here — `logProcedureCall` is
 * registered once as a handler client interceptor in `../../worker-app.ts`
 * and covers every procedure in this tree.
 */

import { Lazy } from "@orpc/server";

/**
 * Defer a namespace's implementation — and, transitively, its contract and Zod
 * schemas — until a request actually routes into it.
 *
 * WHY. Every namespace below used to be a static import, so building this object
 * evaluated all 75 router modules, every contract in `@tedix/api-contract` and
 * every Zod schema they construct. src/index.ts keeps that off *script startup*
 * (the 1s limit, error 10021) by loading ./worker-app dynamically, but that only
 * moved the bill: it is now paid by the first request into every isolate, and
 * under load concurrent requests land on fresh isolates and each pays it again.
 * Most of that evaluation cost is `packages/api-contract` schemas plus
 * contracts, and in an isolate it runs to seconds of CPU.
 *
 * A request touches exactly one namespace. oRPC's matcher indexes a `Lazy`
 * child as a pending path prefix and only unlazies the branch a request routes
 * into (`RPCMatcher.resolvePendingLazyRouters` → `unlazy`), so the other 74
 * namespaces never evaluate. `OpenAPIGenerator.generate` walks with
 * `walkProcedureContractsAsync`, which unlazies everything — /openapi.json and
 * /v1/* still see the complete tree, unchanged.
 *
 * WHY `new Lazy` AND NOT `implement(contract).lazy()`. The implementer needs
 * its contract eagerly, and the contract is what imports the schemas — so that
 * form would defer the 3.5ms of router wiring and keep the 168ms. It is also
 * the identical runtime value: for a contract-first router with no extra
 * middleware, `SharedRouterImplementer.lazy` returns exactly
 * `new Lazy({ loader, meta: {} })`. `Builder.lazy` (`os.lazy`) is NOT
 * equivalent — it re-wraps the loaded tree through `augmentRouter`, which
 * rebuilds every Procedure and drops the hidden router contract, changing
 * contract-first resolution.
 *
 * THE CAST IS DELIBERATE. `ApiRouter` is this file's public contract (typed
 * clients, `src/index.ts`'s `export type`), and it must not become a tree of
 * `Lazy<T>`. The loader's inferred type is the real router type, so the
 * declared shape stays byte-identical to the eager version; only the runtime
 * value is deferred. Consequence: `apiRouter` is for oRPC handlers/generators
 * ONLY. Do not read a procedure off it directly (`apiRouter.billing.getPlan`) —
 * it is a `Lazy` at runtime and the property is `undefined`. Import the router
 * module directly instead, as `createRouterClient` call sites already do.
 *
 * Guarded by lazy-namespace-isolation.test.ts.
 */
const lazyRouter = <T>(load: () => Promise<T>): T =>
	new Lazy({
		meta: {},
		loader: async () => ({ default: await load() }),
	}) as unknown as T;

// =============================================================================
// ROUTER TREE
// =============================================================================

export const apiRouter = {
	billing: lazyRouter(() =>
		import("./billing").then((m) => m.billingContractRouter),
	),
	runtimeEntitlements: lazyRouter(() =>
		import("./runtime-entitlements").then(
			(m) => m.runtimeEntitlementsContractRouter,
		),
	),
	organizations: lazyRouter(() =>
		import("./organizations").then((m) => m.organizationsContractRouter),
	),
	directory: lazyRouter(() =>
		import("./directory").then((m) => m.directoryContractRouter),
	),
	organizationPurpose: lazyRouter(() =>
		import("./organization-purpose").then(
			(m) => m.organizationPurposeContractRouter,
		),
	),
	secrets: lazyRouter(() =>
		import("./organization-secrets").then(
			(m) => m.organizationSecretsContractRouter,
		),
	),
	appSecrets: lazyRouter(() =>
		import("./app-secrets").then((m) => m.appSecretsContractRouter),
	),
	adapterBindings: lazyRouter(() =>
		import("./adapter-bindings").then((m) => m.adapterBindingsContractRouter),
	),
	members: lazyRouter(() =>
		import("./members").then((m) => m.membersContractRouter),
	),
	apps: lazyRouter(() => import("./apps").then((m) => m.appsContractRouter)),
	sites: lazyRouter(() => import("./sites").then((m) => m.sitesContractRouter)),
	appAdapters: lazyRouter(() =>
		import("./app-adapters").then((m) => m.appAdaptersContractRouter),
	),
	appTools: lazyRouter(() =>
		import("./app-tools").then((m) => m.appToolsContractRouter),
	),
	browser: lazyRouter(() =>
		import("./browser").then((m) => m.browserContractRouter),
	),
	content: lazyRouter(() =>
		import("./content").then((m) => m.contentContractRouter),
	),
	memoryGraph: lazyRouter(() =>
		import("./memory-graph").then((m) => m.memoryGraphContractRouter),
	),
	memoryEntities: lazyRouter(() =>
		import("./memory-entities").then((m) => m.memoryEntitiesContractRouter),
	),
	graphRetrievalBenchmarks: lazyRouter(() =>
		import("./graph-retrieval-benchmarks").then(
			(m) => m.graphRetrievalBenchmarksContractRouter,
		),
	),
	items: lazyRouter(() => import("./items").then((m) => m.itemsContractRouter)),

	templates: lazyRouter(() =>
		import("./templates").then((m) => m.templatesContractRouter),
	),
	workflows: lazyRouter(() =>
		import("./workflows").then((m) => m.workflowsContractRouter),
	),

	analytics: lazyRouter(() =>
		import("./analytics").then((m) => m.analyticsContractRouter),
	),
	tedis: lazyRouter(() => import("./tedis").then((m) => m.tedisContractRouter)),
	tediAppAssignments: lazyRouter(() =>
		import("./tedi-app-assignments").then(
			(m) => m.tediAppAssignmentsContractRouter,
		),
	),
	tediSecrets: lazyRouter(() =>
		import("./tedi-secrets").then((m) => m.tediSecretsContractRouter),
	),
	orgUsage: lazyRouter(() =>
		import("./org-usage").then((m) => m.orgUsageContractRouter),
	),
	tediUsage: lazyRouter(() =>
		import("./tedi-usage").then((m) => m.tediUsageContractRouter),
	),
	tediApprovals: lazyRouter(() =>
		import("./tedi-approvals").then((m) => m.tediApprovalsContractRouter),
	),
	rationaleRecords: lazyRouter(() =>
		import("./rationale-records").then((m) => m.rationaleRecordsContractRouter),
	),
	workItems: lazyRouter(() =>
		import("./work-items").then((m) => m.workItemsContractRouter),
	),
	workApprovals: lazyRouter(() =>
		import("./work-approvals").then((m) => m.workApprovalsContractRouter),
	),
	workAgentSessions: lazyRouter(() =>
		import("./work-agent-sessions").then(
			(m) => m.workAgentSessionsContractRouter,
		),
	),
	workInteractions: lazyRouter(() =>
		import("./work-interactions").then((m) => m.workInteractionsContractRouter),
	),
	workFleet: lazyRouter(() =>
		import("./work-fleet").then((m) => m.workFleetContractRouter),
	),
	workScheduler: lazyRouter(() =>
		import("./work-scheduler").then((m) => m.workSchedulerContractRouter),
	),
	projects: lazyRouter(() =>
		import("./projects").then((m) => m.projectsContractRouter),
	),
	roleTemplates: lazyRouter(() =>
		import("./role-templates").then((m) => m.roleTemplatesContractRouter),
	),
	earnedDelegation: lazyRouter(() =>
		import("./earned-delegation").then((m) => m.earnedDelegationContractRouter),
	),
	externalAgentIdentity: lazyRouter(() =>
		import("./external-agent-identity").then(
			(m) => m.externalAgentIdentityContractRouter,
		),
	),
	appGating: lazyRouter(() =>
		import("./app-gating").then((m) => m.appGatingContractRouter),
	),
	plugins: lazyRouter(() =>
		import("./plugins").then((m) => m.pluginsContractRouter),
	),
	mcpHealth: lazyRouter(() =>
		import("./mcp-health").then((m) => m.mcpHealthContractRouter),
	),
	mcpEval: lazyRouter(() =>
		import("./mcp-eval").then((m) => m.mcpEvalContractRouter),
	),
	mcpGovernance: lazyRouter(() =>
		import("./mcp-governance").then((m) => m.mcpGovernanceContractRouter),
	),
	mcpNetworkSecurity: lazyRouter(() =>
		import("./mcp-network-security").then(
			(m) => m.mcpNetworkSecurityContractRouter,
		),
	),
	mcpPayments: lazyRouter(() =>
		import("./mcp-payments").then((m) => m.mcpPaymentsContractRouter),
	),
	catalog: lazyRouter(() =>
		import("./catalog").then((m) => m.catalogContractRouter),
	),
	tenantCatalog: lazyRouter(() =>
		import("./tenant-catalog").then((m) => m.tenantCatalogContractRouter),
	),
	mcpCredentials: lazyRouter(() =>
		import("./mcp-credentials").then((m) => m.mcpCredentialsContractRouter),
	),
	mcpServer: lazyRouter(() =>
		import("./mcp-server").then((m) => m.mcpServerContractRouter),
	),
	descopeAih: lazyRouter(() =>
		import("./descope-aih").then((m) => m.descopeAihContractRouter),
	),
	connections: lazyRouter(() =>
		import("./connections").then((m) => m.connectionsContractRouter),
	),
	docs: lazyRouter(() => import("./docs").then((m) => m.docsContractRouter)),
	osApprovalRules: lazyRouter(() =>
		import("./os-approval-rules").then((m) => m.osApprovalRulesContractRouter),
	),
	osShares: lazyRouter(() =>
		import("./os-shares").then((m) => m.osSharesContractRouter),
	),
	osWorkspaces: lazyRouter(() =>
		import("./os-workspaces").then((m) => m.osWorkspacesContractRouter),
	),
	modelCatalog: lazyRouter(() =>
		import("./model-catalog").then((m) => m.modelCatalogContractRouter),
	),
	osCompute: lazyRouter(() =>
		import("./os-compute").then((m) => m.osComputeContractRouter),
	),
	// Internal edge-resolution surface for tedix-os; deliberately absent
	// from contracts/api.ts and the contract-routers ROUTERS map so it is
	// neither a typed client surface nor a projectable MCP tool.
	osTenant: lazyRouter(() =>
		import("./os-tenant").then((m) => m.osTenantContractRouter),
	),
	seo: lazyRouter(() => import("./seo").then((m) => m.seoContractRouter)),
	aeo: lazyRouter(() => import("./aeo").then((m) => m.aeoContractRouter)),
	agentTurnTriage: lazyRouter(() =>
		import("./agent-turn-triage").then((m) => m.agentTurnTriageContractRouter),
	),
	audit: lazyRouter(() => import("./audit").then((m) => m.auditContractRouter)),
	knowledge: lazyRouter(() =>
		import("./cognitive").then((m) => m.knowledgeContractRouter),
	),
	skills: lazyRouter(() =>
		import("./cognitive").then((m) => m.skillsContractRouter),
	),
	muscle: lazyRouter(() =>
		import("./cognitive").then((m) => m.muscleContractRouter),
	),
	cognitiveRuntime: lazyRouter(() =>
		import("./cognitive-runtime").then((m) => m.cognitiveRuntimeContractRouter),
	),
	harness: lazyRouter(() =>
		import("./harness").then((m) => m.harnessContractRouter),
	),
	tediEmail: lazyRouter(() =>
		import("./tedi-email").then((m) => m.tediEmailContractRouter),
	),
	voice: lazyRouter(() => import("./voice").then((m) => m.voiceContractRouter)),

	widgetTest: lazyRouter(() =>
		import("./widget-test").then((m) => m.widgetTestContractRouter),
	),
	widgetTestRuns: lazyRouter(() =>
		import("./widget-test-runs").then((m) => m.widgetTestRunsContractRouter),
	),
	generatedWidgetArtifacts: lazyRouter(() =>
		import("./generated-widget-artifacts").then(
			(m) => m.generatedWidgetArtifactsContractRouter,
		),
	),
	tediObjectives: lazyRouter(() =>
		import("./tedi-objectives").then((m) => m.tediObjectivesContractRouter),
	),
	capabilities: lazyRouter(() =>
		import("./capabilities").then((m) => m.capabilitiesContractRouter),
	),
	governance: lazyRouter(() =>
		import("./governance").then((m) => m.governanceContractRouter),
	),
	jobs: lazyRouter(() => import("./jobs").then((m) => m.jobsContractRouter)),
	flywheelHealth: lazyRouter(() =>
		import("./flywheel-health").then((m) => m.flywheelHealthContractRouter),
	),
	growthSnapshots: lazyRouter(() =>
		import("./growth-snapshots").then((m) => m.growthSnapshotsContractRouter),
	),
	kernelRuntime: lazyRouter(() =>
		import("./kernel-runtime").then((m) => m.kernelRuntimeContractRouter),
	),
	learningFeedback: lazyRouter(() =>
		import("./learning-feedback").then((m) => m.learningFeedbackContractRouter),
	),
	controlPlane: lazyRouter(() =>
		import("./control-plane").then((m) => m.controlPlaneContractRouter),
	),
	images: lazyRouter(() =>
		import("./images").then((m) => m.imagesContractRouter),
	),
	tenantMembership: lazyRouter(() =>
		import("./tenant-membership").then((m) => m.tenantMembershipContractRouter),
	),
	tenantBehavioralEvals: lazyRouter(() =>
		import("./tenant-behavioral-evals").then(
			(m) => m.tenantBehavioralEvalsContractRouter,
		),
	),
	toolSchemaSync: lazyRouter(() =>
		import("./tool-schema-sync").then((m) => m.toolSchemaSyncContractRouter),
	),
	userSettings: lazyRouter(() =>
		import("./user-settings").then((m) => m.userSettingsContractRouter),
	),
	userProfile: lazyRouter(() =>
		import("./user-profile").then((m) => m.userProfileContractRouter),
	),
	waitlist: lazyRouter(() =>
		import("./waitlist").then((m) => m.waitlistContractRouter),
	),

	listings: lazyRouter(() =>
		import("./listings").then((m) => m.listingsContractRouter),
	),
};

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type ApiRouter = typeof apiRouter;
