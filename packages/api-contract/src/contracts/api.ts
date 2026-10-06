import "@orpc/openapi/extensions/route";
/**
 * Combined API Contract for oRPC
 * Exports the unified API contract with versioning and all routes
 *
 * Import specific contracts from their dedicated files:
 * - appsContract from "@tedix/api-contract/contracts/apps"
 * - organizationsContract from "@tedix/api-contract/contracts/organizations"
 * - etc.
 */

import { oc } from "@orpc/contract";
import { adapterBindingsContract } from "./adapter-bindings";
import { aeoContract } from "./aeo";
import { analyticsContract } from "./analytics";
import { appAdaptersContract } from "./app-adapters";
import { appGatingContract } from "./app-gating";
import { appToolsContract } from "./app-tools";
import { appsContract } from "./apps";
import { auditContract } from "./audit";
import { billingContract } from "./billing";
import { browserContract } from "./browser";
import { capabilitiesContract } from "./capabilities";
import { catalogContract } from "./catalog";

import { knowledgeContract, muscleContract, skillsContract } from "./cognitive";
import { cognitiveRuntimeContract } from "./cognitive-runtime";
import { connectionsContract } from "./connections";
import { contentContract } from "./content";
import { controlPlaneContract } from "./control-plane";
import { descopeAihContract } from "./descope-aih";
import { directoryContract } from "./directory";
import { docsContract } from "./docs";
import { osComputeContract } from "./os-compute";
import { osTenantContract } from "./os-tenant";
import { osApprovalRulesContract } from "./os-approval-rules";
import { osSharesContract } from "./os-shares";
import { osWorkspacesContract } from "./os-workspaces";
import { modelCatalogContract } from "./model-catalog";
import { earnedDelegationContract } from "./earned-delegation";
import { externalAgentIdentityContract } from "./external-agent-identity";
import { flywheelHealthContract } from "./flywheel-health";
import { generatedWidgetArtifactsContract } from "./generated-widget-artifacts";
import { governanceContract } from "./governance";
import { graphRetrievalBenchmarksContract } from "./graph-retrieval-benchmarks";
import { growthSnapshotsContract } from "./growth-snapshots";
import { harnessContract } from "./harness";
import { imagesContract } from "./images";
import { itemsContract } from "./items";
import { jobsContract } from "./jobs";
import { kernelRuntimeContract } from "./kernel-runtime";
import { learningFeedbackContract } from "./learning-feedback";
import { listingsContract } from "./listings";
import { mcpCredentialsContract } from "./mcp-credentials";
import { mcpEvalContract } from "./mcp-eval";
import { mcpGovernanceContract } from "./mcp-governance";
import { mcpHealthContract } from "./mcp-health";
import { mcpNetworkSecurityContract } from "./mcp-network-security";
import { mcpPaymentsContract } from "./mcp-payments";
import { mcpServerContract } from "./mcp-server";
import { membersContract } from "./members";
import { memoryEntitiesContract } from "./memory-entities";
import { memoryGraphContract } from "./memory-graph";
import { orgUsageContract } from "./org-usage";
import { organizationPurposeContract } from "./organization-purpose";
import { organizationsContract } from "./organizations";
import { pluginsContract } from "./plugins";
import { projectsContract } from "./projects";
import { rationaleRecordsContract } from "./rationale-records";
import { roleTemplatesContract } from "./role-templates";
import { runtimeEntitlementsContract } from "./runtime-entitlements";
import { appSecretsContract, organizationSecretsContract } from "./secrets";
import { seoContract } from "./seo";
import { sitesContract } from "./sites";
import { tediAppAssignmentsContract } from "./tedi-app-assignments";
import { tediApprovalsContract } from "./tedi-approvals";
import { tediEmailContract } from "./tedi-email";
import { tediObjectivesContract } from "./tedi-objectives";
import { tediSecretsContract } from "./tedi-secrets";
import { tediUsageContract } from "./tedi-usage";
import { tedisContract } from "./tedis";
import { templatesContract } from "./templates";
import { tenantCatalogContract } from "./tenant-catalog";
import { tenantMembershipContract } from "./tenant-membership";
import { tenantBehavioralEvalsContract } from "./tenant-behavioral-evals";
import { toolSchemaSyncContract } from "./tool-schema-sync";
import { userSettingsContract } from "./user-settings";
import { userProfileContract } from "./user-profile";
import { voiceContract } from "./voice";
import { waitlistContract } from "./waitlist";
import { widgetTestContract } from "./widget-test";
import { widgetTestRunsContract } from "./widget-test-runs";
import { workItemsContract } from "./work-items";
import { workApprovalsContract } from "./work-approvals";
import { workAgentSessionsContract } from "./work-agent-sessions";
import { workInteractionsContract } from "./work-interactions";
import { workFleetContract } from "./work-fleet";
import { workSchedulerContract } from "./work-scheduler";
import { workflowsContract } from "./workflows";

/**
 * Complete API contract tree with OpenAPI v1 route metadata
 *
 * The prefix applies when a procedure is admitted to the external REST
 * handler/spec. RPCLink uses `/rpc/{router}/{procedure}` and can reach the
 * complete tree. `apps/api/src/rpc/openapi-filter.ts` owns the narrower,
 * operation-opt-in REST boundary.
 *
 * Examples of admitted REST routes include:
 * - /v1/apps/...
 * - /v1/apps/{appId}/tools/... (app tools CRUD)
 * - /v1/apps/{appId}/adapters/... (app adapters CRUD)
 * - /v1/organizations/...
 * - /v1/organizations/{organizationId}/members/...
 * - /v1/catalog/...
 * - /v1/tedis/...
 * - /v1/tedi-app-assignments/...
 * - /v1/templates/...
 *
 * A contract route is metadata, not publication. Backend-only domains are
 * excluded by default, and `internal` remains an additional deny tag.
 */
export const apiContract = oc.route({ prefix: "/v1" }).router({
	// Billing (Stripe checkout, portal, status)
	billing: billingContract,
	runtimeEntitlements: runtimeEntitlementsContract,

	// Organization management (multi-tenant billing entities)
	organizations: organizationsContract,
	organizationPurpose: organizationPurposeContract,

	// Organization secrets (encrypted customer API keys - org-wide)
	secrets: organizationSecretsContract,

	// App secrets (encrypted API keys - per-app)
	appSecrets: appSecretsContract,

	// Adapter secret bindings (explicit adapter-to-secret mapping)
	adapterBindings: adapterBindingsContract,

	// Organization member management
	members: membersContract,

	// App management (multi-tenant apps)
	apps: appsContract,
	sites: sitesContract,

	// App tools management (CRUD for app_tools)
	appTools: appToolsContract,

	// App adapters management (CRUD for app_adapters)
	appAdapters: appAdaptersContract,

	// Product/listing search
	listings: listingsContract,

	// Content library (search, ingestion, source management)
	content: contentContract,

	// Stateless Browser Run render/extract tools
	browser: browserContract,

	// Memory graph (knowledge graph API)
	memoryGraph: memoryGraphContract,
	memoryEntities: memoryEntitiesContract,
	graphRetrievalBenchmarks: graphRetrievalBenchmarksContract,
	learningFeedback: learningFeedbackContract,

	// Items (extracted items from apps)
	items: itemsContract,

	// Templates
	templates: templatesContract,

	// Workflows
	workflows: workflowsContract,

	// Tool schema sync (contract/OpenAPI/MCP projection management)
	toolSchemaSync: toolSchemaSyncContract,

	// Per-user OS settings + read-only operational context projection
	userSettings: userSettingsContract,
	userProfile: userProfileContract,

	// Analytics (usage tracking and billing metrics)
	analytics: analyticsContract,

	// Catalog (public, clean API)
	catalog: catalogContract,
	tenantCatalog: tenantCatalogContract,

	// App gating (eligibility checking for apps and tools)
	appGating: appGatingContract,

	// Plugin system (marketplace, installation, events)
	plugins: pluginsContract,

	// MCP payments (read-only x402 requirement/settlement ledger)
	mcpPayments: mcpPaymentsContract,

	// Tedi management
	tedis: tedisContract,

	// Tedi app assignments (tedi-to-app linkage)
	tediAppAssignments: tediAppAssignmentsContract,

	// Tedi secrets (per-tedi encrypted API keys, bot tokens)
	tediSecrets: tediSecretsContract,

	// Org-level usage aggregation (billing alignment)
	orgUsage: orgUsageContract,

	// Tedi token usage (observability + efficiency analysis)
	tediUsage: tediUsageContract,

	// Runtime-neutral voice utilities (Tedix OS spoken replies, Home, tedis)
	voice: voiceContract,

	// Harness self-improvement evals (versions, subjects, trace bundles)
	harness: harnessContract,

	// Tenant membership administration (Descope-owned tenant/user linkage)
	tenantMembership: tenantMembershipContract,
	tenantBehavioralEvals: tenantBehavioralEvalsContract,

	// Waitlist administration (Descope-owned)
	waitlist: waitlistContract,

	// Tedi state management (runtime state tiers + idle detection)

	// MCP telemetry (from tedi container MCP plugins — internal only)

	// MCP credentials (resolves auth headers for tedi → MCP connections — internal only)
	mcpCredentials: mcpCredentialsContract,

	// MCP Server (Descope Agentic Identity Hub registration and scope sync)
	mcpServer: mcpServerContract,

	// Descope AIH management (MCP Server + Client CRUD — internal only)
	descopeAih: descopeAihContract,

	// OAuth connections (Descope Outbound Apps / Token Vault)
	connections: connectionsContract,

	// Cross-surface workspace directory for the tenant-neutral launcher
	directory: directoryContract,

	// Git-backed, tenant-scoped documentation control and review
	docs: docsContract,

	// Tedix OS workspace domain (workspaces, gadgets, blueprints)
	osWorkspaces: osWorkspacesContract,

	// Tedix OS: share links, approval rules, and runtime entitlement
	osShares: osSharesContract,
	osApprovalRules: osApprovalRulesContract,
	// Tedix OS: compute-and-models posture (provenance-labeled spend visibility;
	// invoices and destructive reconciliation stay in the administrative billing plane)
	osCompute: osComputeContract,
	// Model catalog: one contract-backed, filter-explained model list for OS,
	// CLI (via the projected MCP tool), and MCP.
	modelCatalog: modelCatalogContract,
	// Tedix OS: internal edge tenant resolution (service-binding only, never a tool)
	osTenant: osTenantContract,

	// SEO / Google Search Console management for app domains
	seo: seoContract,

	// AEO (Answer Engine Optimization) live citation-rate measurement
	aeo: aeoContract,

	// Audit trail (org-scoped event history)
	audit: auditContract,

	// Cognitive stack — top-level namespaces (renamed from `cognitive.*`).
	knowledge: knowledgeContract,
	skills: skillsContract,
	muscle: muscleContract,
	cognitiveRuntime: cognitiveRuntimeContract,
	kernelRuntime: kernelRuntimeContract,

	// Tedi approval queue (human-in-the-loop governance)
	tediApprovals: tediApprovalsContract,

	// Tedi rationale records (decision journal for Tedix OS Activity)
	rationaleRecords: rationaleRecordsContract,

	// Provider-neutral issue/work coordination
	workItems: workItemsContract,
	workApprovals: workApprovalsContract,
	workAgentSessions: workAgentSessionsContract,
	workInteractions: workInteractionsContract,
	workFleet: workFleetContract,
	workScheduler: workSchedulerContract,

	// Tedix-owned channels and cross-installation outcome authority

	// Work hierarchy v1: project → epic → story container + rollup
	projects: projectsContract,

	// Reusable role primitive: persona + objectives + tags + profile as a unit
	roleTemplates: roleTemplatesContract,

	// Evidence-gated career progression and task-scoped authority
	earnedDelegation: earnedDelegationContract,

	// Stable external-agent principals and immutable execution sessions
	externalAgentIdentity: externalAgentIdentityContract,

	// Tedi email (inbound email routing — internal only, service binding)
	tediEmail: tediEmailContract,

	// Widget E2E testing (real MCP call + Puppeteer screenshot — internal only)
	widgetTest: widgetTestContract,

	// Tedi objectives and tasks (mission directives + execution log)
	tediObjectives: tediObjectivesContract,

	// Business capability map (value-stream capabilities + entity links)
	capabilities: capabilitiesContract,

	// Governance overview (Weill & Ross decision-rights one-pager — read-only)
	governance: governanceContract,

	// Background job tracking (blog generation, discovery, etc.)
	jobs: jobsContract,

	// Flywheel health (pulse, fact lifecycle, cron status — dashboard)
	flywheelHealth: flywheelHealthContract,

	// Tedi growth snapshots (weekly cognitive metric snapshots for Growth Timeline)
	growthSnapshots: growthSnapshotsContract,

	// Control plane (runtime profiles, policy packs, workspace template sets)
	controlPlane: controlPlaneContract,

	// Image uploads (org logos, app logos, tedi avatars)
	images: imagesContract,

	// Durable FFmpeg video composition backed by Cloudflare Containers + R2

	// MCP health checks (deterministic protocol-level verification)
	mcpHealth: mcpHealthContract,
	mcpNetworkSecurity: mcpNetworkSecurityContract,

	// MCP eval (async LLM-powered tool routing evaluation)
	mcpEval: mcpEvalContract,

	// MCP tool-approval grant resolution (internal, service-binding only —
	// isolated grant layer for the destructive-tool approval gate)
	mcpGovernance: mcpGovernanceContract,

	// Widget test runs (persisted E2E test results — internal only)
	widgetTestRuns: widgetTestRunsContract,

	// Generated widget artifacts (GenUI drafts, Browser QA, publish progress)
	generatedWidgetArtifacts: generatedWidgetArtifactsContract,

	// Tedi runtime metrics from Analytics Engine
});

export type ApiContract = typeof apiContract;
