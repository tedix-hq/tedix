import { TEDI_DURABLE_CODE_TRANSPORT_TIMEOUT_MS } from "@tedix/api-contract/schemas/tedi-durable-code";
import type {
	ToolSchemaSyncInput,
	ToolSchemaSyncResult,
} from "@tedix/api-contract/contracts/tool-schema-sync";
import {
	WORKFLOW_DEFINITIONS_WIDGET,
	WORKFLOW_HEALTH_WIDGET,
} from "@tedix/api-contract/contracts/workflows";
import {
	deriveToolWriteCapability,
	withDerivedToolOperationalRiskPolicy,
	operatorKindToAnnotations,
} from "@tedix/api-contract/schemas/tools";
import {
	listContractEndpoints,
	type ResolvedContractEndpoint,
	resolveContractEndpoint,
} from "@tedix/api-contract/utils/contract-routers";
import {
	zodToStructuredOutputJsonSchema,
	zodToToolInputJsonSchema,
} from "@tedix/api-contract/utils/tool-json-schema";
import type { DbClient } from "@tedix/db/client";
import { getAppBySlug } from "@tedix/db/queries/apps";
import {
	deleteTool,
	listToolIdsForSchemaSync,
	listToolsForSchemaSync,
	listToolsForSchemaSyncScoped,
	updateToolSchemaProjection,
	upsertTool,
} from "@tedix/db/queries/tools";
import type { AppTool } from "@tedix/db/schema";
import { toJsonRecord } from "@tedix/db/utils/json";
import { publishMcpListChangedEvents } from "../lib/mcp-subscriptions";

export const TEDIX_ADMIN_APP_SLUG = "tedix";

/**
 * The admin app is a D1 row addressed by slug; its id differs per database,
 * so callers resolve it once per operation instead of baking one in.
 */
export async function resolveTedixAdminAppId(db: DbClient): Promise<string> {
	const app = await getAppBySlug(db, TEDIX_ADMIN_APP_SLUG);
	if (!app) {
		throw new Error(
			`Tedix admin app "${TEDIX_ADMIN_APP_SLUG}" is not provisioned`,
		);
	}
	return app.id;
}

const OPEN_WORLD_ENDPOINTS = new Set([
	"seo/researchKeywords",
	"seo/getSerpResults",
	"seo/getDomainOverview",
	"seo/getBacklinksOverview",
]);

const EXTERNAL_AGENT_MCP_ENDPOINTS = new Set([
	"externalAgentIdentity/createPrincipal",
	"externalAgentIdentity/recordKnowledgeCheckpoint",
	"externalAgentIdentity/recordKnowledgeDisposition",
	"externalAgentIdentity/endSession",
	"externalAgentIdentity/retireAbandonedSession",
	"externalAgentIdentity/revokeMcpCredential",
	"externalAgentIdentity/listStaleKnowledgeSessions",
]);

export const EXTERNAL_AGENT_TOOL_ID_OVERRIDES: Record<string, string> = {
	"externalAgentIdentity/createPrincipal": "create_external_agent_principal",
	"externalAgentIdentity/recordKnowledgeCheckpoint":
		"record_external_agent_knowledge_checkpoint",
	"externalAgentIdentity/recordKnowledgeDisposition":
		"record_external_agent_knowledge_disposition",
	"externalAgentIdentity/endSession": "end_external_agent_session",
	"externalAgentIdentity/retireAbandonedSession":
		"retire_abandoned_external_agent_session",
	"externalAgentIdentity/revokeMcpCredential":
		"revoke_external_agent_mcp_credential",
	"externalAgentIdentity/listStaleKnowledgeSessions":
		"list_stale_external_agent_knowledge_sessions",
};

export const EXTERNAL_AGENT_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"externalAgentIdentity/createPrincipal": "write",
	"externalAgentIdentity/recordKnowledgeCheckpoint": "write",
	"externalAgentIdentity/recordKnowledgeDisposition": "write",
	"externalAgentIdentity/endSession": "destructive",
	"externalAgentIdentity/retireAbandonedSession": "destructive",
	"externalAgentIdentity/revokeMcpCredential": "destructive",
	"externalAgentIdentity/listStaleKnowledgeSessions": "read",
};

/**
 * Preserve the established public spelling for the tenant OpenAPI importer.
 * The generic camel-case projection would otherwise emit `open_api`, which
 * diverges from the platform operator definition and its capability policy.
 */
export const CATALOG_TOOL_ID_OVERRIDES: Record<string, string> = {
	"catalog/createTenantOpenApiMcpApp": "create_tenant_openapi_mcp_app",
};

export const SITE_TOOL_ID_OVERRIDES: Record<string, string> = {
	"docs/listSites": "list_docs_sites",
	"sites/list": "list_sites",
	"sites/getRecoveryManifest": "get_site_recovery_manifest",
	"sites/setLifecycle": "set_site_lifecycle",
	"sites/getReconciliation": "get_site_reconciliation",
	"sites/runReconciliation": "run_site_reconciliation",
	"sites/getDeprovisionPlan": "get_site_deprovision_plan",
	"sites/getDeprovisionStatus": "get_site_deprovision_status",
	"sites/deprovision": "deprovision_site",
};

export const SITE_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"sites/list": "read",
	"sites/getRecoveryManifest": "read",
	"sites/startCmsRecoveryCapture": "write",
	"sites/getCmsRecoveryCapture": "read",
	"sites/purgeCmsRecoveryCapture": "destructive",
	"sites/startCmsSiteRestore": "destructive",
	"sites/getCmsSiteRestore": "read",
	"sites/setLifecycle": "write",
	"sites/getReconciliation": "read",
	"sites/runReconciliation": "write",
	"sites/getDeprovisionPlan": "read",
	"sites/getDeprovisionStatus": "read",
	"sites/deprovision": "destructive",
};

/**
 * Stable verb-first names for the Tedix OS workspace domain
 * (osWorkspaces — D1-canonical). The OS surface owns the `os` namespace
 * outright.
 */
export const OS_TOOL_ID_OVERRIDES: Record<string, string> = {
	"osShares/shares/create": "create_os_share_link",
	"osShares/shares/list": "list_os_share_links",
	"osShares/shares/previewRevoke": "preview_os_share_revocation",
	"osShares/shares/revoke": "revoke_os_share_link",
	"osShares/shares/restrict": "restrict_os_share_link",
	"osShares/shares/delete": "delete_os_share_link",
	"osApprovalRules/create": "create_os_approval_rule",
	"osApprovalRules/list": "list_os_approval_rules",
	"osApprovalRules/setEnabled": "set_os_approval_rule_enabled",
	"osApprovalRules/apply": "apply_os_approval_rules",
	"osApprovalRules/delete": "delete_os_approval_rule",
	"osWorkspaces/blueprints/setVisibility": "set_os_blueprint_visibility",
	"osWorkspaces/blueprints/gallery": "list_os_blueprint_gallery",
	"osWorkspaces/blueprints/instantiateFromGallery":
		"instantiate_os_gallery_blueprint",
	"runtimeEntitlements/get": "get_runtime_entitlement",
	// The one contract-backed model catalog. `list_models` (not
	// `list_model_catalogs`, which the bare-verb rule would emit against the
	// router name) — verb-first, and the noun callers actually ask for.
	"modelCatalog/list": "list_models",
	"osWorkspaces/workspaces/list": "list_os_workspaces",
	"osWorkspaces/workspaces/create": "create_os_workspace",
	"osWorkspaces/workspaces/get": "get_os_workspace",
	"osWorkspaces/workspaces/update": "update_os_workspace",
	"osWorkspaces/workspaces/archive": "archive_os_workspace",
	"osWorkspaces/workspaces/delete": "delete_os_workspace",
	"osWorkspaces/resources/list": "list_os_workspace_resources",
	"osWorkspaces/resources/create": "create_os_workspace_resource",
	"osWorkspaces/resources/get": "get_os_workspace_resource",
	"osWorkspaces/resources/readPdf": "read_os_workspace_pdf",
	"osWorkspaces/resources/rename": "rename_os_workspace_resource",
	"osWorkspaces/resources/remove": "remove_os_workspace_resource",
	"osWorkspaces/gadgets/list": "list_os_gadgets",
	"osWorkspaces/gadgets/create": "create_os_gadget",
	"osWorkspaces/gadgets/get": "get_os_gadget",
	"osWorkspaces/gadgets/revise": "revise_os_gadget",
	"osWorkspaces/gadgets/archive": "archive_os_gadget",
	"osWorkspaces/gadgets/run": "run_os_gadget",
	"osWorkspaces/gadgets/delete": "delete_os_gadget",
	"osWorkspaces/executions/list": "list_os_gadget_executions",
	"osWorkspaces/executions/get": "get_os_gadget_execution",
	"osWorkspaces/collaboration/list": "list_os_collaboration_proposals",
	"osWorkspaces/collaboration/get": "get_os_collaboration_proposal",
	"osWorkspaces/collaboration/create": "create_os_collaboration_proposal",
	"osWorkspaces/collaboration/updatePreview":
		"update_os_collaboration_proposal_preview",
	"osWorkspaces/collaboration/accept": "accept_os_collaboration_proposal",
	"osWorkspaces/collaboration/reject": "reject_os_collaboration_proposal",
	"osWorkspaces/collaboration/merge": "merge_os_collaboration_proposal",
	"osWorkspaces/blueprints/list": "list_os_blueprints",
	"osWorkspaces/blueprints/create": "create_os_blueprint",
	"osWorkspaces/blueprints/get": "get_os_blueprint",
	"osWorkspaces/blueprints/revise": "revise_os_blueprint",
	"osWorkspaces/blueprints/publish": "publish_os_blueprint",
	"osWorkspaces/blueprints/preflight": "preflight_os_blueprint",
	"osWorkspaces/blueprints/instantiate": "instantiate_os_blueprint",
	"osWorkspaces/blueprints/export": "export_os_blueprint",
	"osWorkspaces/blueprints/import": "import_os_blueprint",
	"osWorkspaces/blueprints/archive": "archive_os_blueprint",
	"osWorkspaces/blueprints/delete": "delete_os_blueprint",
	"osWorkspaces/workspaces/previewBlueprintUpgrade":
		"preview_os_blueprint_upgrade",
	"osWorkspaces/workspaces/decideBlueprintUpgrade":
		"decide_os_blueprint_upgrade",
	"osWorkspaces/outputs/list": "list_os_outputs",
	"osWorkspaces/outputs/library": "list_os_output_library",
	"osWorkspaces/outputs/create": "create_os_output",
	"osWorkspaces/outputs/get": "get_os_output",
	"osWorkspaces/outputs/rename": "rename_os_output",
	"osWorkspaces/outputs/revise": "revise_os_output",
	"osWorkspaces/outputs/patchDocument": "patch_os_document",
	"osWorkspaces/outputs/patchSlides": "patch_os_slides",
	"osWorkspaces/outputs/setSheetRange": "set_os_sheet_range",
	"osWorkspaces/outputs/export": "export_os_output",
	"osWorkspaces/outputs/archive": "archive_os_output",
	"osWorkspaces/outputs/delete": "delete_os_output",
};

export const OS_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"osShares/shares/create": "write",
	"osShares/shares/list": "read",
	"osShares/shares/previewRevoke": "read",
	"osShares/shares/revoke": "write",
	"osShares/shares/restrict": "write",
	"osShares/shares/delete": "destructive",
	"osApprovalRules/create": "write",
	"osApprovalRules/list": "read",
	"osApprovalRules/setEnabled": "write",
	"osApprovalRules/apply": "write",
	"osApprovalRules/delete": "destructive",
	"osWorkspaces/blueprints/setVisibility": "write",
	"osWorkspaces/blueprints/gallery": "read",
	"osWorkspaces/blueprints/instantiateFromGallery": "write",
	"runtimeEntitlements/get": "read",
	"modelCatalog/list": "read",
	"osWorkspaces/workspaces/list": "read",
	"osWorkspaces/workspaces/create": "write",
	"osWorkspaces/workspaces/get": "read",
	"osWorkspaces/workspaces/update": "write",
	"osWorkspaces/workspaces/archive": "write",
	"osWorkspaces/workspaces/delete": "destructive",
	"osWorkspaces/resources/readPdf": "read",
	"osWorkspaces/gadgets/list": "read",
	"osWorkspaces/gadgets/create": "write",
	"osWorkspaces/gadgets/get": "read",
	"osWorkspaces/gadgets/revise": "write",
	"osWorkspaces/gadgets/archive": "write",
	// A Gadget run dispatches a governed skill that may exercise granted tools.
	// The MCP annotation must communicate that effect even though admission can
	// still return a denied receipt without executing.
	"osWorkspaces/gadgets/run": "destructive",
	"osWorkspaces/gadgets/delete": "destructive",
	"osWorkspaces/executions/list": "read",
	"osWorkspaces/executions/get": "read",
	"osWorkspaces/collaboration/list": "read",
	"osWorkspaces/collaboration/get": "read",
	"osWorkspaces/collaboration/create": "write",
	"osWorkspaces/collaboration/updatePreview": "write",
	"osWorkspaces/collaboration/accept": "write",
	"osWorkspaces/collaboration/reject": "write",
	"osWorkspaces/collaboration/merge": "write",
	"osWorkspaces/blueprints/list": "read",
	"osWorkspaces/blueprints/create": "write",
	"osWorkspaces/blueprints/get": "read",
	"osWorkspaces/blueprints/revise": "write",
	"osWorkspaces/blueprints/publish": "write",
	// Read-only dependency resolution: it never mints authority or provisions.
	"osWorkspaces/blueprints/preflight": "read",
	"osWorkspaces/blueprints/instantiate": "write",
	// export is a pure projection of a blueprint the caller can already read:
	// no write, no budget, no durable artifact — unlike `outputs/export`, which
	// spends Browser Rendering and persists to R2.
	"osWorkspaces/blueprints/export": "read",
	"osWorkspaces/blueprints/import": "write",
	"osWorkspaces/blueprints/archive": "write",
	"osWorkspaces/blueprints/delete": "destructive",
	"osWorkspaces/workspaces/previewBlueprintUpgrade": "read",
	// Both branches write: an apply re-pins and reconciles gadgets, and staying
	// pinned records the review. Nothing is destroyed — gadget and blueprint
	// revisions are append-only and dropped gadgets are archived.
	"osWorkspaces/workspaces/decideBlueprintUpgrade": "write",
	"osWorkspaces/outputs/list": "read",
	"osWorkspaces/outputs/library": "read",
	"osWorkspaces/outputs/create": "write",
	"osWorkspaces/outputs/get": "read",
	"osWorkspaces/outputs/rename": "write",
	"osWorkspaces/outputs/revise": "write",
	"osWorkspaces/outputs/patchDocument": "write",
	"osWorkspaces/outputs/patchSlides": "write",
	"osWorkspaces/outputs/setSheetRange": "write",
	// export never mutates the output, but it is effectful, not `read`: it
	// spends Browser Rendering budget and persists a durable R2 artifact —
	// same posture as the sibling receipt-writing `gadgets/run`.
	"osWorkspaces/outputs/export": "write",
	"osWorkspaces/outputs/archive": "write",
	"osWorkspaces/outputs/delete": "destructive",
};

/**
 * Stable public names and annotation intent for the skill-workflow operator
 * surface. These defaults keep an unscoped Tedix-admin projection from
 * regressing read tools to write annotations or inventing a second naming
 * scheme. Explicit caller overrides still win.
 */
export const SKILL_WORKFLOW_TOOL_ID_OVERRIDES: Record<string, string> = {
	"skills/runWorkflow": "run_skill_workflow",
	"skills/runWorkflowStatus": "get_skill_workflow_status",
	"skills/runWorkflowCancel": "cancel_skill_workflow",
	"skills/runWorkflowSendEvent": "send_skill_workflow_event",
	"skills/runWorkflowHistory": "list_skill_workflow_history",
	"skills/listWorkflowRetryCandidates": "list_skill_workflow_retry_candidates",
	"skills/inspectWorkflowRun": "inspect_skill_workflow_run",
	"skills/listWorkflowSteps": "list_skill_workflow_steps",
	"skills/listWorkflowToolCalls": "list_skill_workflow_tool_calls",
	"skills/listWorkflowRevisions": "list_skill_workflow_revisions",
	"skills/getWorkflowRevision": "get_skill_workflow_revision",
	"skills/compareWorkflowRevisions": "compare_skill_workflow_revisions",
	"skills/getWorkflowReliability": "get_skill_workflow_reliability",
	"skills/listWorkflowSchedules": "list_skill_workflow_schedules",
	"skills/mineCandidates": "mine_skill_candidates",
	"skills/portfolioBalance": "get_skill_portfolio_balance",
	"skills/proposeWorkflowImprovement": "propose_skill_workflow_improvement",
	"skills/inspectWorkflowImprovement": "inspect_skill_workflow_improvement",
	"skills/activateWorkflowImprovement": "activate_skill_workflow_improvement",
	"skills/pauseWorkflow": "pause_skill_workflow",
	"skills/resumeWorkflow": "resume_skill_workflow",
	"skills/restartWorkflow": "restart_skill_workflow",
	"skills/approveWorkflow": "approve_skill_workflow",
	"skills/rejectWorkflow": "reject_skill_workflow",
	"skills/getRunArtifact": "get_skill_run_artifact",
	"skills/listRunArtifacts": "list_skill_run_artifacts",
	"skills/revokeSkillRun": "revoke_skill_run",
};

export const SKILL_WORKFLOW_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"skills/runWorkflow": "destructive",
	"skills/runWorkflowStatus": "read",
	"skills/runWorkflowCancel": "destructive",
	"skills/runWorkflowSendEvent": "destructive",
	"skills/runWorkflowHistory": "read",
	"skills/listWorkflowRetryCandidates": "read",
	"skills/listWorkflowSchedules": "read",
	"skills/mineCandidates": "write",
	"skills/portfolioBalance": "read",
	"skills/proposeWorkflowImprovement": "write",
	"skills/inspectWorkflowImprovement": "read",
	"skills/activateWorkflowImprovement": "destructive",
	"skills/inspectWorkflowRun": "read",
	"skills/listWorkflowSteps": "read",
	"skills/listWorkflowToolCalls": "read",
	"skills/listWorkflowRevisions": "read",
	"skills/getWorkflowRevision": "read",
	"skills/compareWorkflowRevisions": "read",
	"skills/getWorkflowReliability": "read",
	"skills/pauseWorkflow": "write",
	"skills/resumeWorkflow": "write",
	"skills/restartWorkflow": "destructive",
	"skills/approveWorkflow": "destructive",
	"skills/rejectWorkflow": "destructive",
	"skills/getRunArtifact": "read",
	"skills/listRunArtifacts": "read",
	"skills/revokeSkillRun": "destructive",
};

/** Stable lifecycle surface for tedi procedural memory. */
export const MUSCLE_MEMORY_TOOL_ID_OVERRIDES: Record<string, string> = {
	"muscle/list": "list_muscle_memories",
	"muscle/register": "register_muscle_memory",
	"muscle/crystallize": "crystallize_muscle_memory",
	"muscle/usage": "track_muscle_usage",
};

export const MUSCLE_MEMORY_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"muscle/list": "read",
	"muscle/register": "write",
	"muscle/crystallize": "write",
	"muscle/usage": "write",
};

/** Stable cross-platform workflow catalog surface. */
export const WORKFLOW_CATALOG_TOOL_ID_OVERRIDES: Record<string, string> = {
	"workflows/listDefinitions": "list_workflow_definitions",
	"workflows/listDefinitionHealth": "list_workflow_definition_health",
};

export const WORKFLOW_CATALOG_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"workflows/listDefinitions": "read",
	"workflows/listDefinitionHealth": "read",
};

export const WORKFLOW_CATALOG_WIDGET_OVERRIDES: NonNullable<
	ToolSchemaSyncInput["widgetOverrides"]
> = {
	"workflows/listDefinitions": WORKFLOW_DEFINITIONS_WIDGET,
	"workflows/listDefinitionHealth": WORKFLOW_HEALTH_WIDGET,
};

/**
 * Stable verb-first tool ids for the business-capability-map surface
 * (capabilities router — flywheel P5 #2). Without overrides the generator
 * would pluralize bare verbs against the router name (`create_capabilities`)
 * and leave noun-first residue (`tree_capabilities`). `capabilities/list`
 * needs no entry: the generator's bare-verb rule already emits
 * `list_capabilities` (asserted in tool-schema-sync.test.ts).
 */
export const CAPABILITY_TOOL_ID_OVERRIDES: Record<string, string> = {
	"capabilities/create": "create_capability",
	"capabilities/update": "update_capability",
	"capabilities/archive": "archive_capability",
	"capabilities/tree": "get_capability_tree",
	"capabilities/coverage": "get_capability_coverage",
	"capabilities/unmapped": "list_unmapped_capability_entities",
	"capabilities/link": "link_capability",
	"capabilities/unlink": "unlink_capability",
};

export const CAPABILITY_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"capabilities/create": "write",
	"capabilities/update": "write",
	"capabilities/archive": "destructive",
	"capabilities/list": "read",
	"capabilities/tree": "read",
	"capabilities/coverage": "read",
	"capabilities/unmapped": "read",
	"capabilities/link": "write",
	"capabilities/unlink": "write",
};

/**
 * Stable verb-first tool id for the governance one-pager (governance router —
 * flywheel P5 #3). The generator would otherwise project the noun-first
 * `overview_governance`.
 */
export const GOVERNANCE_TOOL_ID_OVERRIDES: Record<string, string> = {
	"governance/overview": "get_governance_overview",
};

export const GOVERNANCE_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"governance/overview": "read",
};

export const SEO_RESEARCH_TOOL_ID_OVERRIDES: Record<string, string> = {
	"seo/researchKeywords": "research_keywords",
	"seo/getSerpResults": "get_serp_results",
	"seo/getDomainOverview": "get_domain_overview",
	"seo/getBacklinksOverview": "get_backlinks_overview",
};

export const SEO_RESEARCH_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"seo/researchKeywords": "read",
	"seo/getSerpResults": "read",
	"seo/getDomainOverview": "read",
	"seo/getBacklinksOverview": "read",
};

/**
 * Governed entity resolution and graph-retrieval graduation are separate
 * contract routers but one cognition operator surface. Pin explicit verb-first
 * ids and annotations so Code Mode never derives noun-first or ambiguous
 * names from camelCase procedures.
 */
export const GRAPH_GOVERNANCE_TOOL_ID_OVERRIDES: Record<string, string> = {
	"memoryGraph/graph/maintenanceTaskStatus": "get_graph_gds_refresh_task",
	"memoryGraph/graph/maintenanceTaskCancel": "cancel_graph_gds_refresh_task",
	"memoryEntities/createEntity": "create_memory_entity",
	"memoryEntities/recordMention": "record_entity_mention",
	"memoryEntities/listCandidates": "list_entity_candidates",
	"memoryEntities/proposeResolution": "propose_entity_resolution",
	"memoryEntities/proposeResolutionRollback":
		"propose_entity_resolution_rollback",
	"memoryEntities/reviewResolution": "review_entity_resolution",
	"memoryEntities/getMentionResolution": "get_entity_resolution",
	"graphRetrievalBenchmarks/createSuite":
		"create_graph_retrieval_benchmark_suite",
	"graphRetrievalBenchmarks/addCase": "add_graph_retrieval_benchmark_case",
	"graphRetrievalBenchmarks/lockSuite": "lock_graph_retrieval_benchmark_suite",
	"graphRetrievalBenchmarks/getSuite": "get_graph_retrieval_benchmark_suite",
	"graphRetrievalBenchmarks/startPair": "start_graph_retrieval_benchmark_pair",
	"graphRetrievalBenchmarks/recordObservation":
		"record_graph_retrieval_benchmark_observation",
	"graphRetrievalBenchmarks/completeRun":
		"complete_graph_retrieval_benchmark_run",
	"graphRetrievalBenchmarks/executePair":
		"execute_graph_retrieval_benchmark_pair",
	"graphRetrievalBenchmarks/evaluatePair":
		"evaluate_graph_retrieval_benchmark_pair",
	"graphRetrievalBenchmarks/getRun": "get_graph_retrieval_benchmark_run",
	"graphRetrievalBenchmarks/getGate": "get_graph_retrieval_graduation_gate",
};

export const GRAPH_GOVERNANCE_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"memoryGraph/graph/visualization": "read",
	"memoryGraph/graph/similar": "read",
	"memoryGraph/graph/path": "read",
	"memoryGraph/graph/communities": "read",
	"memoryGraph/graph/influence": "read",
	"memoryGraph/graph/traverse": "read",
	"memoryGraph/graph/edges": "read",
	"memoryGraph/graph/causalChain": "read",
	"memoryGraph/graph/similarDecisions": "read",
	"memoryGraph/graph/health": "read",
	"memoryGraph/graph/sync": "destructive",
	"memoryGraph/graph/maintenance": "destructive",
	"memoryGraph/graph/maintenanceTaskStatus": "read",
	"memoryGraph/graph/maintenanceTaskCancel": "destructive",
	"memoryEntities/createEntity": "write",
	"memoryEntities/recordMention": "write",
	"memoryEntities/listCandidates": "read",
	"memoryEntities/proposeResolution": "write",
	"memoryEntities/proposeResolutionRollback": "write",
	"memoryEntities/reviewResolution": "destructive",
	"memoryEntities/getMentionResolution": "read",
	"graphRetrievalBenchmarks/createSuite": "write",
	"graphRetrievalBenchmarks/addCase": "write",
	"graphRetrievalBenchmarks/lockSuite": "destructive",
	"graphRetrievalBenchmarks/getSuite": "read",
	"graphRetrievalBenchmarks/startPair": "write",
	"graphRetrievalBenchmarks/recordObservation": "write",
	"graphRetrievalBenchmarks/completeRun": "write",
	"graphRetrievalBenchmarks/executePair": "write",
	"graphRetrievalBenchmarks/evaluatePair": "destructive",
	"graphRetrievalBenchmarks/getRun": "read",
	"graphRetrievalBenchmarks/getGate": "read",
};

/**
 * Stable verb-first tool ids for project and Work Item operator surfaces.
 * Without overrides the generator would pluralize bare verbs against the
 * router (`create_projects`, `get_projects`) and leave `get_rollup`
 * router-less. `projects/list` needs no entry: the bare-verb rule already emits
 * `list_projects`. Work Item reads are pinned so their durable object is
 * explicit in discovery and authorization scope routing.
 */
export const WORK_HIERARCHY_TOOL_ID_OVERRIDES: Record<string, string> = {
	"projects/create": "create_project",
	"projects/get": "get_project",
	"projects/update": "update_project",
	"projects/archive": "archive_project",
	"projects/getRollup": "get_project_rollup",
	"projects/createMilestone": "create_project_milestone",
	"projects/listMilestones": "list_project_milestones",
	"projects/updateMilestone": "update_project_milestone",
	"projects/attachMilestoneWorkItem": "attach_project_milestone_work_item",
	"projects/addMilestoneDependency": "add_project_milestone_dependency",
	"projects/recordHealthJudgment": "record_project_health_judgment",
	"projects/listHealthJudgments": "list_project_health_judgments",
	"workItems/createCase": "create_work_case",
	"workItems/listCases": "list_work_cases",
	"workItems/getCase": "get_work_case",
	"workItems/updateCase": "update_work_case",
	"workItems/attachCaseWorkItem": "attach_work_case_item",
	"workItems/addCaseDependency": "add_work_case_dependency",
	"workItems/replaceAdmissionSpecification":
		"replace_work_admission_specification",
	"workItems/getAdmissionSpecification": "get_work_admission_specification",
	"workItems/putResourcePool": "put_work_resource_pool",
	"workItems/listResourcePools": "list_work_resource_pools",
	"workItems/putBudgetEnvelope": "put_work_budget_envelope",
	"workItems/listBudgetEnvelopes": "list_work_budget_envelopes",
	"workApprovals/propose": "propose_work_approval",
	"workApprovals/decide": "decide_work_approval",
	"workApprovals/listInbox": "list_work_approvals",
	"workApprovals/listAudit": "list_work_approval_audit",
	"workInteractions/create": "create_work_interaction",
	"workInteractions/respond": "respond_work_interaction",
	"workInteractions/cancel": "cancel_work_interaction",
	"workInteractions/get": "get_work_interaction",
	"workInteractions/listInbox": "list_work_interactions",
	"workInteractions/listOutbox": "list_work_interaction_outbox",
	"workInteractions/listAudit": "list_work_interaction_audit",
	"workFleet/getControlTower": "get_work_fleet_control_tower",
	"workAgentSessions/report": "report_work_agent_session_status",
	"workAgentSessions/list": "list_work_agent_sessions",
	"workScheduler/listReady": "list_ready_work",
	"workScheduler/planClusters": "plan_work_execution_clusters",
	"workItems/getWorkItemTree": "get_work_item_tree",
	"workItems/getWorkItemRollup": "get_work_item_rollup",
	"workItems/updateSpecification": "update_work_item_specification",
	"workItems/accept": "accept_work_item",
	"workItems/authorizeOwnedChannel": "authorize_owned_channel",
	"workItems/revokeOwnedChannel": "revoke_owned_channel",
	"workItems/getReadiness": "get_work_item_readiness",
	"workItems/startAttempt": "start_work_item_attempt",
	"workItems/heartbeatAttempt": "heartbeat_work_item_attempt",
	"workItems/settleAttempt": "settle_work_item_attempt",
	"workItems/listAttempts": "list_work_item_attempts",
	"workItems/submitEvidence": "submit_work_item_evidence",
	"workItems/listEvidence": "list_work_item_evidence",
	"workItems/listEvents": "list_work_item_events",
	"workItems/complete": "complete_work_item",
	"workItems/cancel": "cancel_work_item",
	// Work-graph steward (dup/stale/naming/orphan verifier + gated repair).
	"workItems/getWorkGraphHealth": "get_work_graph_health",
	"workItems/runWorkGraphSteward": "run_work_graph_steward",
	// Org graph health (blocked-work dependency analysis — org "digital twin").
	"workItems/getOrgGraphHealth": "get_org_graph_health",
};

export const WORK_HIERARCHY_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"projects/create": "write",
	"projects/update": "write",
	"projects/archive": "destructive",
	"projects/list": "read",
	"projects/get": "read",
	"projects/getRollup": "read",
	"projects/createMilestone": "write",
	"projects/listMilestones": "read",
	"projects/updateMilestone": "write",
	"projects/attachMilestoneWorkItem": "write",
	"projects/addMilestoneDependency": "write",
	"projects/recordHealthJudgment": "write",
	"projects/listHealthJudgments": "read",
	"workItems/createCase": "write",
	"workItems/listCases": "read",
	"workItems/getCase": "read",
	"workItems/updateCase": "write",
	"workItems/attachCaseWorkItem": "write",
	"workItems/addCaseDependency": "write",
	"workItems/replaceAdmissionSpecification": "write",
	"workItems/getAdmissionSpecification": "read",
	"workItems/putResourcePool": "write",
	"workItems/listResourcePools": "read",
	"workItems/putBudgetEnvelope": "write",
	"workItems/listBudgetEnvelopes": "read",
	"workApprovals/propose": "write",
	"workApprovals/decide": "write",
	"workApprovals/listInbox": "read",
	"workApprovals/listAudit": "read",
	"workInteractions/create": "write",
	"workInteractions/respond": "write",
	"workInteractions/cancel": "destructive",
	"workInteractions/get": "read",
	"workInteractions/listInbox": "read",
	"workInteractions/listOutbox": "read",
	"workInteractions/listAudit": "read",
	"workFleet/getControlTower": "read",
	"workAgentSessions/report": "write",
	"workAgentSessions/list": "read",
	"workScheduler/listReady": "read",
	"workScheduler/planClusters": "read",
	"workItems/getWorkItemTree": "read",
	"workItems/getWorkItemRollup": "read",
	"workItems/updateSpecification": "write",
	"workItems/accept": "write",
	"workItems/getReadiness": "read",
	"workItems/startAttempt": "write",
	"workItems/heartbeatAttempt": "write",
	"workItems/settleAttempt": "write",
	"workItems/listAttempts": "read",
	"workItems/submitEvidence": "write",
	"workItems/listEvidence": "read",
	"workItems/listEvents": "read",
	"workItems/complete": "write",
	"workItems/cancel": "destructive",
	// Steward: the health report is a read; running the steward can transition
	// items to stale + write links/flags org-wide, so it is `destructive`
	// (mirroring run_skill_workflow) to trip the destructive-tool approval gate
	// for interactive MCP callers. The daily cron calls the DB fn directly.
	"workItems/getWorkGraphHealth": "read",
	"workItems/runWorkGraphSteward": "destructive",
	// Org graph health: a read-only recursive-CTE dependency report.
	"workItems/getOrgGraphHealth": "read",
	// Public-channel authority changes are owner/admin decisions and must trip
	// explicit destructive confirmation when invoked through MCP.
	"workItems/authorizeOwnedChannel": "destructive",
	"workItems/revokeOwnedChannel": "destructive",
};

/**
 * Agent-turn urgency triage. The router key is camelCase (`agentTurnTriage`),
 * so the bare-verb generator would emit `triage_agentTurnTriage`; these pin the
 * verb-first snake_case ids. Triage and reply labelling are stateless model
 * reads, so they project as `read`.
 */
export const AGENT_TURN_TRIAGE_TOOL_ID_OVERRIDES: Record<string, string> = {
	"agentTurnTriage/triage": "triage_agent_turn",
	"agentTurnTriage/labelReply": "label_agent_reply",
	"agentTurnTriage/getPolicy": "get_agent_turn_triage_policy",
	"agentTurnTriage/updatePolicy": "update_agent_turn_triage_policy",
};

export const AGENT_TURN_TRIAGE_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"agentTurnTriage/triage": "read",
	"agentTurnTriage/labelReply": "read",
	"agentTurnTriage/getPolicy": "read",
	"agentTurnTriage/updatePolicy": "write",
};

/**
 * Stable verb-first tool ids for the role-template surface (reusable role
 * primitive). The router key is camelCase (`roleTemplates`), so the bare-verb
 * generator would emit `create_roleTemplates` — these overrides pin the
 * snake_case names the MCP naming policy requires.
 */
export const ROLE_TEMPLATE_TOOL_ID_OVERRIDES: Record<string, string> = {
	"roleTemplates/create": "create_role_template",
	"roleTemplates/list": "list_role_templates",
	"roleTemplates/apply": "apply_role_template",
};

export const ROLE_TEMPLATE_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"roleTemplates/create": "write",
	"roleTemplates/list": "read",
	// apply overwrites a tedi's persona + capability profile and seeds
	// objectives — a significant provisioning mutation, so `destructive` trips
	// the destructive-tool approval gate for interactive MCP callers (the
	// capability access level stays `write` via ACCESS_LEVEL_OVERRIDES).
	"roleTemplates/apply": "destructive",
};

/** Stable public MCP names for human-owned purpose and owner attention. */
export const ORGANIZATION_PURPOSE_TOOL_ID_OVERRIDES: Record<string, string> = {
	"organizationPurpose/getActive": "get_active_purpose_charter",
	"organizationPurpose/listRevisions": "list_purpose_charter_revisions",
	"organizationPurpose/createRevision": "create_purpose_charter_revision",
	"organizationPurpose/getOwnerBrief": "get_owner_brief",
};

export const ORGANIZATION_PURPOSE_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"organizationPurpose/getActive": "read",
	"organizationPurpose/listRevisions": "read",
	"organizationPurpose/createRevision": "write",
	"organizationPurpose/getOwnerBrief": "read",
};

/** Stable operator names for the task-scoped Earned Delegation evidence plane. */
export const EARNED_DELEGATION_TOOL_ID_OVERRIDES: Record<string, string> = {
	"earnedDelegation/getProfile": "get_earned_delegation_profile",
	"earnedDelegation/createActivity": "create_entrustable_activity",
	"earnedDelegation/recordObservation": "record_competency_observation",
	"earnedDelegation/attestObservation": "attest_competency_observation",
	"earnedDelegation/certifyObservation": "certify_competency_observation",
	"earnedDelegation/proposeDecision": "propose_entrustment_decision",
	"earnedDelegation/decideDecision": "decide_entrustment_decision",
};

export const EARNED_DELEGATION_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"earnedDelegation/getProfile": "read",
	"earnedDelegation/createActivity": "destructive",
	"earnedDelegation/recordObservation": "write",
	"earnedDelegation/attestObservation": "write",
	"earnedDelegation/certifyObservation": "write",
	"earnedDelegation/proposeDecision": "write",
	"earnedDelegation/decideDecision": "destructive",
};

/**
 * Routers whose org-sub-collection procedures are unambiguously scoped to the
 * CALLER's own org (and backstopped by requireOrganizationAccess), so a
 * forwarded MCP user's org may be auto-injected into their `organizationId`
 * input. An explicit allowlist — NOT a path heuristic — because
 * `/{organizationId}/members` and `/{organizationId}/cancel` are structurally
 * identical but semantically opposite: the latter is a platform-admin CROSS-org action that skips requireOrganizationAccess
 * and must keep its explicit target org. Only add a router here after confirming
 * every org-path procedure in it targets the caller's own org.
 */
const ORG_INJECT_ROUTERS = new Set<string>(["members"]);

type SchemaColumn = "inputSchema" | "outputSchema";
type SyncColumn =
	| SchemaColumn
	| "title"
	| "description"
	| "config"
	| "annotations"
	| "meta"
	| "authRequired"
	| "visibility"
	| "schemaSource"
	| "widget";

type JsonObject = Record<string, unknown>;
type WidgetOverride = NonNullable<
	ToolSchemaSyncInput["widgetOverrides"]
>[string];

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as JsonObject;
	return `{${Object.keys(obj)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
		.join(",")}}`;
}

function jsonEqual(left: unknown, right: unknown): boolean {
	return stableStringify(left ?? null) === stableStringify(right ?? null);
}

async function sha256(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(stableStringify(value));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function asRpcEndpoint(tool: AppTool): string | null {
	const config = tool.config as Record<string, unknown> | null;
	if (config?.transport !== "rpc") return null;
	return typeof config.endpoint === "string" ? config.endpoint : null;
}

function hasObjectProperty(schema: unknown, property: string): boolean {
	if (!schema || typeof schema !== "object") return false;
	const properties = (schema as JsonObject).properties;
	return (
		!!properties &&
		typeof properties === "object" &&
		!Array.isArray(properties) &&
		Object.hasOwn(properties, property)
	);
}

function snakeCase(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

function titleFromToolId(toolId: string): string {
	return toolId
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/**
 * Prepositions that signal the procedure name carries a qualifier rather than a
 * concrete object (e.g. `list_by_app`, `get_for_mcp`). When proc is verb +
 * preposition phrase, the router becomes the object slotted after the verb:
 * `list_by_app` (skills) → `list_skills_by_app`.
 */
const PROC_PREPOSITIONS = new Set([
	"by",
	"for",
	"to",
	"from",
	"with",
	"of",
	"in",
	"as",
]);

/**
 * Decorate a proc with the router as its object, inserting it after the verb:
 * `{verb}_{router}_{rest}` (rest may be empty → `{verb}_{router}`). Used both
 * for the preposition case and for deterministic collision disambiguation.
 */
function decorateWithRouter(proc: string, router: string): string {
	const words = proc.split("_").filter(Boolean);
	const [verb, ...rest] = words;
	if (!verb) return router;
	return [verb, router, ...rest].filter(Boolean).join("_");
}

/**
 * Verb-first MCP tool id from an oRPC endpoint, following the
 * "MCP Tool Naming Convention" in CLAUDE.md (`verb_object` /
 * `verb_object_qualifier`). Router-name suffixes are NOT appended — the router
 * is the Code Mode namespace, so `skills.list_by_app_skills` becomes
 * `skills.list_skills_by_app`.
 */
function generatedToolIdForEndpoint(
	endpoint: ResolvedContractEndpoint,
): string {
	if (endpoint.route?.operationId) return snakeCase(endpoint.route.operationId);

	const proc = snakeCase(endpoint.procPath.replace(/\//g, "_"));
	const router = snakeCase(endpoint.router);
	if (!proc) return router;

	// Proc already contains the router token sequence anywhere (e.g. proc
	// `search_memory_graph` for router `memory_graph`, or proc ending in
	// `_skills` for router `skills`) → leave it untouched.
	const procWords = proc.split("_").filter(Boolean);
	const routerWords = router.split("_").filter(Boolean);
	if (containsTokenSequence(procWords, routerWords)) return proc;

	const [verb, ...rest] = procWords;
	if (!verb) return router;

	// Bare verb (`get`, `list`, `search`, `create`) → `{verb}_{router}`.
	if (rest.length === 0) return `${verb}_${router}`;

	// Preposition phrase (`list_by_app`) → insert router after the verb.
	if (PROC_PREPOSITIONS.has(rest[0]!)) return decorateWithRouter(proc, router);

	// Proc already names a real object (`rotate_access_key`, `run_workflow`)
	// → return it without router decoration.
	return proc;
}

/** True when `needle` appears as a contiguous subsequence of `haystack`. */
function containsTokenSequence(haystack: string[], needle: string[]): boolean {
	if (needle.length === 0) return false;
	for (let i = 0; i + needle.length <= haystack.length; i++) {
		let match = true;
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}
	return false;
}

/**
 * Generate tool ids for a set of endpoints with deterministic collision
 * resolution: when two endpoints would produce the same tool id, ALL colliding
 * entries are disambiguated by slotting the router after the verb
 * (`{verb}_{router}_{rest}`). Per-endpoint overrides win and are never
 * collision-adjusted.
 */
function generateToolIdMap(
	endpoints: ResolvedContractEndpoint[],
	overrides?: Record<string, string>,
): Map<string, string> {
	const byEndpoint = new Map<string, string>();
	const counts = new Map<string, ResolvedContractEndpoint[]>();

	for (const endpoint of endpoints) {
		const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
		const override = overrides?.[endpointPath];
		const generated = override ?? generatedToolIdForEndpoint(endpoint);
		byEndpoint.set(endpointPath, generated);
		if (override) continue;
		const bucket = counts.get(generated) ?? [];
		bucket.push(endpoint);
		counts.set(generated, bucket);
	}

	for (const [toolId, colliding] of counts) {
		if (colliding.length < 2) continue;
		console.warn(
			`[tool-schema-sync] tool id collision on "${toolId}" across ${colliding
				.map((endpoint) => `${endpoint.router}/${endpoint.procPath}`)
				.join(", ")} — disambiguating with router prefix.`,
		);
		for (const endpoint of colliding) {
			const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
			const proc = snakeCase(endpoint.procPath.replace(/\//g, "_"));
			const router = snakeCase(endpoint.router);
			byEndpoint.set(endpointPath, decorateWithRouter(proc, router));
		}
	}

	// Write-time config lint: any tool id still claimed by 2+ endpoints after
	// overrides + router disambiguation violates the (app_id, tool_id) unique
	// index — and worse, `upsertTool` matches by (appId, toolId), so the second
	// projection would silently clobber the first row instead of failing.
	// Reject the whole sync before any write, naming the colliders. Overrides
	// are never collision-adjusted, so this fires for override↔override and
	// override↔generated collisions plus unresolvable generated residue.
	const endpointsByFinalToolId = new Map<string, string[]>();
	for (const [endpointPath, toolId] of byEndpoint) {
		const bucket = endpointsByFinalToolId.get(toolId) ?? [];
		bucket.push(endpointPath);
		endpointsByFinalToolId.set(toolId, bucket);
	}
	const residualCollisions = [...endpointsByFinalToolId].filter(
		([, endpointPaths]) => endpointPaths.length > 1,
	);
	if (residualCollisions.length > 0) {
		throw new Error(
			`TOOL_ID_COLLISION: ${residualCollisions
				.map(
					([toolId, endpointPaths]) =>
						`"${toolId}" is claimed by ${endpointPaths.join(", ")}`,
				)
				.join(
					"; ",
				)}. Each endpoint in one app must map to a unique tool_id (idx_app_tool_unique) — set distinct toolIdOverrides for the colliding endpoints.`,
		);
	}

	return byEndpoint;
}

function descriptionForEndpoint(endpoint: ResolvedContractEndpoint): string {
	return (
		endpoint.route?.description ??
		endpoint.route?.summary ??
		`Tedix oRPC endpoint ${endpoint.router}/${endpoint.procPath}`
	);
}

function annotationsForEndpoint(
	endpoint: ResolvedContractEndpoint,
	kind?: "read" | "write" | "destructive",
): NonNullable<AppTool["annotations"]> {
	const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
	if (kind) {
		// Single source of truth — see operatorKindToAnnotations in
		// packages/api-contract/src/schemas/tools.ts. Same mapping is used by
		// the retired one-off operator-annotation backfill.
		return {
			...operatorKindToAnnotations(kind),
			openWorldHint: OPEN_WORLD_ENDPOINTS.has(endpointPath),
		};
	}

	const method = endpoint.route?.method?.toUpperCase();
	const proc = snakeCase(endpoint.proc);
	const readOnly =
		method === "GET" ||
		/^(get|list|search|query|check|preview|validate|audit|inspect|estimate|read)_?/.test(
			`${proc}_`,
		);
	const destructive =
		method === "DELETE" ||
		/^(delete|remove|destroy|reset|purge)_?/.test(`${proc}_`);

	return {
		readOnlyHint: readOnly,
		destructiveHint: destructive,
		idempotentHint: readOnly || method === "PUT" || method === "DELETE",
		openWorldHint: OPEN_WORLD_ENDPOINTS.has(endpointPath),
	};
}

function mergeGeneratedMeta(
	existing: AppTool | undefined,
	endpoint: string,
): Record<string, unknown> {
	return {
		...(existing?.meta as Record<string, unknown> | null),
		"com.tedix/schemaSource": "orpc",
		"com.tedix/orpcEndpoint": endpoint,
	};
}

function mergeGeneratedConfig(
	existing: AppTool | undefined,
	endpoint: ResolvedContractEndpoint,
	inputSchema: AppTool["inputSchema"],
	widgetOverride?: WidgetOverride,
): Record<string, unknown> {
	const existingConfig = (existing?.config as JsonObject | null) ?? {};
	const nextConfig: JsonObject = {
		transport: "rpc",
		endpoint: `${endpoint.router}/${endpoint.procPath}`,
		responsePath: "json",
		...(endpoint.route?.method
			? { method: endpoint.route.method.toUpperCase() }
			: {}),
	};

	if (
		endpoint.router === "tedis" &&
		[
			"runTediDurableCode",
			"approveTediCodeExecution",
			"rollbackTediCodeExecution",
		].includes(endpoint.procPath)
	) {
		const existingTimeout = existingConfig.timeout;
		nextConfig.timeout =
			typeof existingTimeout === "number" && Number.isFinite(existingTimeout)
				? Math.max(TEDI_DURABLE_CODE_TRANSPORT_TIMEOUT_MS, existingTimeout)
				: TEDI_DURABLE_CODE_TRANSPORT_TIMEOUT_MS;
	}

	if (hasObjectProperty(inputSchema, "tediId")) {
		nextConfig.allowExplicitTediId = true;
	}
	if (hasObjectProperty(inputSchema, "appId")) {
		nextConfig.allowExplicitAppId = true;
	}
	// Inject the caller's org for caller-org-scoped sub-collection routes — gated
	// on the ORG_INJECT_ROUTERS allowlist (NOT a path heuristic) so platform-admin
	// cross-org procs like organizations.cancel are never auto-rescoped.
	// The path check still excludes non-org routes in an allowlisted router.
	if (
		ORG_INJECT_ROUTERS.has(endpoint.router) &&
		endpoint.route?.path?.includes("{organizationId}/")
	) {
		nextConfig.injectOrganizationId = true;
	}

	// Keep hand-authored widget projections attached to the tool row.
	for (const key of ["layoutId", "layoutSpec", "responseMap", "staticOutput"]) {
		if (existingConfig[key] !== undefined)
			nextConfig[key] = existingConfig[key];
	}

	if (widgetOverride) {
		nextConfig.layoutId = widgetOverride.layoutId;
		nextConfig.layoutSpec = widgetOverride.layoutSpec;
	}

	return nextConfig;
}

async function buildProjectedTool(
	appId: string,
	endpoint: ResolvedContractEndpoint,
	existing?: AppTool,
	options: {
		toolIdOverrides?: Record<string, string>;
		kindOverrides?: Record<string, "read" | "write" | "destructive">;
		widgetOverrides?: ToolSchemaSyncInput["widgetOverrides"];
		/**
		 * Pre-resolved tool id for this endpoint (collision-adjusted by the
		 * caller). Falls back to override → generated when omitted.
		 */
		resolvedToolId?: string;
		/**
		 * Aggressive mode: replace the existing row's tool_id with the
		 * generated/override name instead of preserving it. Renames in place by
		 * row id (upsertTool updates by id first).
		 */
		regenerateToolIds?: boolean;
	} = {},
): Promise<{
	tool: Omit<
		AppTool,
		"id" | "createdAt" | "updatedAt" | "schemaSourceHash" | "schemaSyncedAt"
	> & {
		id?: string;
		schemaSourceHash: string;
		schemaSyncedAt: string;
	};
	endpointPath: string;
}> {
	const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
	const widgetOverride = options.widgetOverrides?.[endpointPath];
	const inputSchema = zodToToolInputJsonSchema(
		endpoint.inputSchema,
	) as AppTool["inputSchema"];
	const outputSchema = endpoint.outputSchema
		? (zodToStructuredOutputJsonSchema(
				endpoint.outputSchema,
			) as AppTool["outputSchema"])
		: null;
	const generatedToolId =
		options.resolvedToolId ??
		options.toolIdOverrides?.[endpointPath] ??
		generatedToolIdForEndpoint(endpoint);
	// Aggressive mode flips precedence: the generated/override name wins so
	// existing rows are renamed in place. Otherwise the existing name is sticky.
	const toolId = options.regenerateToolIds
		? generatedToolId
		: (existing?.toolId ?? generatedToolId);
	const config = mergeGeneratedConfig(
		existing,
		endpoint,
		inputSchema,
		widgetOverride,
	);
	const annotations = annotationsForEndpoint(
		endpoint,
		options.kindOverrides?.[endpointPath],
	);
	const writeCapability = deriveToolWriteCapability(annotations);
	const meta = withDerivedToolOperationalRiskPolicy({
		meta: toJsonRecord(mergeGeneratedMeta(existing, endpointPath)),
		config: toJsonRecord(config),
		writeCapability,
	});
	const widgetRoute = widgetOverride ? `/r/${widgetOverride.layoutId}` : null;
	const widgetKey = widgetOverride ? "render" : (existing?.widgetKey ?? null);
	const schemaSourceHash = await sha256({
		endpoint: endpointPath,
		toolId,
		title: titleFromToolId(toolId),
		description: descriptionForEndpoint(endpoint),
		inputSchema,
		outputSchema,
		config,
		annotations,
		meta,
		authRequired: true,
		visibility: "private",
		widgetKey,
		widgetRoute: widgetRoute ?? existing?.widgetRoute ?? null,
		widgetDescription:
			widgetOverride?.description ?? existing?.widgetDescription ?? null,
	});

	return {
		endpointPath,
		tool: {
			id: existing?.id,
			appId,
			toolId,
			title: titleFromToolId(toolId),
			description: descriptionForEndpoint(endpoint),
			toolTypeId: "rpc",
			inputSchema,
			outputSchema,
			config: toJsonRecord(config),
			icons: existing?.icons ?? null,
			executionTaskSupport: existing?.executionTaskSupport ?? null,
			annotations,
			// First-party oRPC rows are classified at generation time, so the
			// declarative column is populated from the SAME annotations that get
			// persisted — never from the tool name. `kindOverrides` is the
			// genuinely declarative input; the method/prefix branch of
			// annotationsForEndpoint is its fallback, and either way the answer is
			// recorded once here instead of being re-inferred at every gate.
			writeCapability,
			meta: meta == null ? null : toJsonRecord(meta),
			invocationStatus: existing?.invocationStatus ?? null,
			fileParams: existing?.fileParams ?? null,
			adapterScope: existing?.adapterScope ?? "primary",
			resultStrategy: existing?.resultStrategy ?? "merge",
			outputTemplate: existing?.outputTemplate ?? null,
			widgetKey,
			widgetRoute: widgetRoute ?? existing?.widgetRoute ?? null,
			widgetAccessible: widgetOverride
				? true
				: (existing?.widgetAccessible ?? true),
			visibility: "private",
			authRequired: true,
			widgetDescription:
				widgetOverride?.description ?? existing?.widgetDescription ?? null,
			widgetPrefersBorder: widgetOverride
				? null
				: (existing?.widgetPrefersBorder ?? true),
			widgetDomain: existing?.widgetDomain ?? null,
			schemaDialect: "json-schema-2020-12",
			schemaSource: "orpc",
			schemaSourceRef: endpointPath,
			schemaSourceHash,
			schemaSyncedAt: new Date().toISOString(),
			sortOrder: existing?.sortOrder ?? 0,
			enabled: existing?.enabled ?? true,
		},
	};
}

function changedProjectionColumns(
	existing: AppTool,
	projected: Awaited<ReturnType<typeof buildProjectedTool>>["tool"],
): SyncColumn[] {
	const changed: SyncColumn[] = [];
	if (existing.title !== projected.title) changed.push("title");
	if ((existing.description ?? null) !== (projected.description ?? null)) {
		changed.push("description");
	}
	if (!jsonEqual(existing.inputSchema, projected.inputSchema)) {
		changed.push("inputSchema");
	}
	if (!jsonEqual(existing.outputSchema, projected.outputSchema)) {
		changed.push("outputSchema");
	}
	if (!jsonEqual(existing.config, projected.config)) changed.push("config");
	if (!jsonEqual(existing.annotations, projected.annotations)) {
		changed.push("annotations");
	}
	if (!jsonEqual(existing.meta, projected.meta)) changed.push("meta");
	if ((existing.authRequired ?? false) !== projected.authRequired) {
		changed.push("authRequired");
	}
	if ((existing.visibility ?? "public") !== projected.visibility) {
		changed.push("visibility");
	}
	if (
		existing.schemaDialect !== projected.schemaDialect ||
		existing.schemaSource !== projected.schemaSource ||
		existing.schemaSourceRef !== projected.schemaSourceRef ||
		existing.schemaSourceHash !== projected.schemaSourceHash
	) {
		changed.push("schemaSource");
	}
	if (
		(existing.widgetKey ?? null) !== (projected.widgetKey ?? null) ||
		(existing.widgetRoute ?? null) !== (projected.widgetRoute ?? null) ||
		(existing.widgetDescription ?? null) !==
			(projected.widgetDescription ?? null) ||
		(existing.widgetAccessible ?? true) !==
			(projected.widgetAccessible ?? true) ||
		(existing.widgetPrefersBorder ?? true) !==
			(projected.widgetPrefersBorder ?? true)
	) {
		changed.push("widget");
	}
	return changed;
}

function targetColumns(target: ToolSchemaSyncInput["target"]): SchemaColumn[] {
	switch (target ?? "both") {
		case "input":
			return ["inputSchema"];
		case "output":
			return ["outputSchema"];
		case "both":
			return ["inputSchema", "outputSchema"];
	}
}

/**
 * Routers that must never materialize as MCP tools. `osTenant` is the
 * service-binding-only edge-resolution surface for `tedix-os`, while
 * `tenantBehavioralEvals` is an API-only authoring and execution surface.
 * `mcpCredentials` returns bearer credentials only to the authenticated tedi;
 * `mcpGovernance` is service-binding-only. These routes remain registered in
 * ROUTERS for contract/router parity without becoming MCP tools.
 */
const UNPROJECTABLE_ROUTERS = new Set([
	"osTenant",
	"tenantBehavioralEvals",
	"mcpCredentials",
	"mcpGovernance",
]);
const UNPROJECTABLE_ENDPOINTS = new Set([
	"cognitiveRuntime/createRedactedArtifactRevision",
	"cognitiveRuntime/getArtifactReleaseReview",
	"cognitiveRuntime/approveArtifactRelease",
	"cognitiveRuntime/revokeArtifactRelease",
]);

function isProjectableRouter(router: string): boolean {
	return !UNPROJECTABLE_ROUTERS.has(router);
}

function endpointPathOf(endpoint: ResolvedContractEndpoint): string {
	return `${endpoint.router}/${endpoint.procPath}`;
}

/**
 * Codepoint ordering, deliberately not `localeCompare`. Batch boundaries are
 * derived from this order, so it has to produce the same slices on every
 * runtime and every ICU data set — a locale-sensitive comparator would let two
 * invocations disagree about which endpoints belong to batch N.
 */
function compareEndpointPath(
	left: ResolvedContractEndpoint,
	right: ResolvedContractEndpoint,
): number {
	const a = endpointPathOf(left);
	const b = endpointPathOf(right);
	return a < b ? -1 : a > b ? 1 : 0;
}

function projectionCandidates(
	options: ToolSchemaSyncInput,
): ResolvedContractEndpoint[] {
	if (options.router || options.endpoints?.length) {
		const candidates = listContractEndpoints({
			router: options.router,
			endpoints: options.endpoints,
			includeInternal: options.includeInternal !== false,
		});
		if (candidates.length === 0) {
			throw new Error(
				`Explicit tool projection resolved no contract endpoints${
					options.router ? ` for router "${options.router}"` : ""
				}`,
			);
		}
		return candidates.filter(
			(endpoint) =>
				isProjectableRouter(endpoint.router) &&
				!UNPROJECTABLE_ENDPOINTS.has(endpointPathOf(endpoint)) &&
				(endpoint.router !== "externalAgentIdentity" ||
					EXTERNAL_AGENT_MCP_ENDPOINTS.has(
						`${endpoint.router}/${endpoint.procPath}`,
					)),
		);
	}

	// Tedix admin projection is default-include: every oRPC procedure is MCP
	// eligible unless a caller explicitly scopes the projection.
	return listContractEndpoints({
		includeInternal: options.includeInternal !== false,
	}).filter(
		(endpoint) =>
			isProjectableRouter(endpoint.router) &&
			!UNPROJECTABLE_ENDPOINTS.has(endpointPathOf(endpoint)) &&
			(endpoint.router !== "externalAgentIdentity" ||
				EXTERNAL_AGENT_MCP_ENDPOINTS.has(
					`${endpoint.router}/${endpoint.procPath}`,
				)),
	);
}

async function runToolProjectionSync(
	db: DbClient,
	rows: AppTool[],
	endpoints: ResolvedContractEndpoint[],
	resolvedToolIds: Map<string, string>,
	options: ToolSchemaSyncInput & {
		appId: string;
		mode: "projection";
		source: "rpc";
		target: "input" | "output" | "both";
		apply: boolean;
		regenerateToolIds?: boolean;
	},
): Promise<ToolSchemaSyncResult> {
	const existingByEndpoint = new Map<string, AppTool>();
	const existingByToolId = new Map<string, AppTool>();
	for (const row of rows) {
		existingByToolId.set(row.toolId, row);
		const endpoint = asRpcEndpoint(row);
		if (endpoint) existingByEndpoint.set(endpoint, row);
	}

	const onlyToolIds = options.toolIds ? new Set(options.toolIds) : null;
	const items: ToolSchemaSyncResult["items"] = [];
	let planned = 0;
	let created = 0;
	let updated = 0;
	// Projection mode NEVER deletes, and must never learn to. This run may be a
	// single batch of a batched sync, so "rows in the DB that this run did not
	// visit" is not a stale set — it is every other batch's work. A full-set
	// diff here would delete the entire tool surface except the current batch.
	// `tool-schema-sync-batching.test.ts` fails if this becomes a mutable
	// counter that a set-difference can drive.
	const deleted = 0;
	let inSync = 0;
	let skipped = 0;
	let failed = 0;

	for (const endpoint of endpoints) {
		const endpointPath = `${endpoint.router}/${endpoint.procPath}`;
		const resolvedToolId =
			resolvedToolIds.get(endpointPath) ?? generatedToolIdForEndpoint(endpoint);
		const existing =
			existingByEndpoint.get(endpointPath) ??
			existingByToolId.get(resolvedToolId);

		let projected: Awaited<ReturnType<typeof buildProjectedTool>>;
		try {
			projected = await buildProjectedTool(options.appId, endpoint, existing, {
				toolIdOverrides: options.toolIdOverrides,
				kindOverrides: options.kindOverrides,
				widgetOverrides: options.widgetOverrides,
				resolvedToolId,
				regenerateToolIds: options.regenerateToolIds,
			});
		} catch (error) {
			skipped++;
			items.push({
				toolUuid: existing?.id ?? null,
				toolId: existing?.toolId ?? resolvedToolId,
				endpoint: endpointPath,
				status: "converterUnsupported",
				changed: [],
				message: (error as Error).message,
			});
			continue;
		}

		if (onlyToolIds && !onlyToolIds.has(projected.tool.toolId)) continue;

		const changed = existing
			? changedProjectionColumns(existing, projected.tool)
			: ([
					"title",
					"description",
					"inputSchema",
					"outputSchema",
					"config",
					"annotations",
					"meta",
					"authRequired",
					"visibility",
					"schemaSource",
				] satisfies SyncColumn[]);

		if (existing && changed.length === 0) {
			inSync++;
			items.push({
				toolUuid: existing.id,
				toolId: existing.toolId,
				endpoint: endpointPath,
				status: "inSync",
				changed: [],
			});
			continue;
		}

		planned++;
		if (options.limit !== undefined && planned > options.limit) {
			planned--;
			skipped++;
			items.push({
				toolUuid: existing?.id ?? null,
				toolId: projected.tool.toolId,
				endpoint: endpointPath,
				status: "skipped",
				changed,
				message: "Limit reached",
			});
			continue;
		}

		if (!options.apply) {
			items.push({
				toolUuid: existing?.id ?? null,
				toolId: projected.tool.toolId,
				endpoint: endpointPath,
				status: existing ? "wouldUpdate" : "wouldCreate",
				changed,
			});
			continue;
		}

		try {
			const saved = await upsertTool(db, projected.tool);
			if (existing) updated++;
			else created++;
			items.push({
				toolUuid: saved.id,
				toolId: saved.toolId,
				endpoint: endpointPath,
				status: existing ? "updated" : "created",
				changed,
			});
		} catch (error) {
			failed++;
			items.push({
				toolUuid: existing?.id ?? null,
				toolId: projected.tool.toolId,
				endpoint: endpointPath,
				status: "failed",
				changed,
				message: (error as Error).message,
			});
		}
	}

	return {
		appId: options.appId,
		mode: options.mode,
		source: options.source,
		target: options.target,
		apply: options.apply,
		total: endpoints.length,
		planned,
		created,
		updated,
		deleted,
		inSync,
		skipped,
		failed,
		items,
	};
}

/**
 * After an applied (non-dry-run) sync that changed rows, nudge live MCP
 * subscribers on the synced app: tool rows changed, so tools/list and the
 * derived ui:// widget resource list are stale. No-op without an env (test
 * and CLI callers) — publishMcpListChangedEvents itself no-ops when the
 * MCP_SERVICE binding is absent.
 *
 * A batched sync therefore calls `runToolSchemaSync` WITHOUT an env per batch
 * and invokes this once, after every batch succeeded, so subscribers are never
 * told to re-read a half-projected tool surface.
 */
export async function publishToolSchemaSyncEvents(
	env: CloudflareEnv | undefined,
	result: ToolSchemaSyncResult,
): Promise<void> {
	if (!env || !result.apply) return;
	if (result.created + result.updated + result.deleted === 0) return;
	await publishMcpListChangedEvents(env, { appId: result.appId }, [
		"notifications/tools/list_changed",
		"notifications/resources/list_changed",
	]);
}

/**
 * Merge the Tedix admin app's built-in projection overrides into the caller's
 * options. Extracted so the batch planner resolves tool ids from exactly the
 * same override set a batch run will use — a planner that missed an override
 * would hand batches a different id map than the one the collision guard
 * validated.
 */
export function resolveEffectiveToolSchemaSyncOptions(
	options: ToolSchemaSyncInput,
	appId: string,
	adminAppId: string | undefined,
): ToolSchemaSyncInput {
	return appId === adminAppId
		? {
				...options,
				toolIdOverrides: {
					...CATALOG_TOOL_ID_OVERRIDES,
					...SITE_TOOL_ID_OVERRIDES,
					...SKILL_WORKFLOW_TOOL_ID_OVERRIDES,
					...MUSCLE_MEMORY_TOOL_ID_OVERRIDES,
					...WORKFLOW_CATALOG_TOOL_ID_OVERRIDES,
					...CAPABILITY_TOOL_ID_OVERRIDES,
					...GOVERNANCE_TOOL_ID_OVERRIDES,
					...SEO_RESEARCH_TOOL_ID_OVERRIDES,
					...GRAPH_GOVERNANCE_TOOL_ID_OVERRIDES,
					...WORK_HIERARCHY_TOOL_ID_OVERRIDES,
					...ROLE_TEMPLATE_TOOL_ID_OVERRIDES,
					...AGENT_TURN_TRIAGE_TOOL_ID_OVERRIDES,
					...ORGANIZATION_PURPOSE_TOOL_ID_OVERRIDES,
					...EARNED_DELEGATION_TOOL_ID_OVERRIDES,
					...EXTERNAL_AGENT_TOOL_ID_OVERRIDES,
					...OS_TOOL_ID_OVERRIDES,
					...options.toolIdOverrides,
				},
				kindOverrides: {
					...SITE_KIND_OVERRIDES,
					...SKILL_WORKFLOW_KIND_OVERRIDES,
					...MUSCLE_MEMORY_KIND_OVERRIDES,
					...WORKFLOW_CATALOG_KIND_OVERRIDES,
					...CAPABILITY_KIND_OVERRIDES,
					...GOVERNANCE_KIND_OVERRIDES,
					...SEO_RESEARCH_KIND_OVERRIDES,
					...GRAPH_GOVERNANCE_KIND_OVERRIDES,
					...WORK_HIERARCHY_KIND_OVERRIDES,
					...ROLE_TEMPLATE_KIND_OVERRIDES,
					...AGENT_TURN_TRIAGE_KIND_OVERRIDES,
					...ORGANIZATION_PURPOSE_KIND_OVERRIDES,
					...EARNED_DELEGATION_KIND_OVERRIDES,
					...EXTERNAL_AGENT_KIND_OVERRIDES,
					...OS_KIND_OVERRIDES,
					...options.kindOverrides,
				},
				widgetOverrides: {
					...WORKFLOW_CATALOG_WIDGET_OVERRIDES,
					...options.widgetOverrides,
				},
			}
		: options;
}

export interface ToolSchemaSyncProjectionPlan {
	appId: string;
	/** Endpoint paths in deterministic codepoint order. Frozen batch input. */
	endpoints: string[];
	/** endpointPath -> tool id, collision-resolved across the WHOLE plan. */
	toolIds: Record<string, string>;
}

/**
 * Enumerate the projection work list without generating a single JSON Schema.
 *
 * Walking the contract registry costs ~2 ms and allocates nothing beyond the
 * already-resident zod graph; the memory that exhausted the unscoped Worker run
 * is spent inside `buildProjectedTool` (`z.toJSONSchema` + re-validation +
 * `stableStringify` + `sha256` per endpoint). Planning is therefore cheap enough
 * to run whole, which is what makes deterministic batching possible.
 *
 * The tool id map MUST be resolved here, over the complete candidate set, and
 * sliced per batch. `generateToolIdMap` disambiguates colliding ids across the
 * set it is given, and `upsertTool` matches on `(app_id, tool_id)` — so a map
 * recomputed per batch would emit the same bare id for two endpoints in
 * different batches and let the later batch silently clobber the earlier
 * batch's row, with the residual-collision guard seeing only one member and
 * staying quiet.
 */
export function planToolSchemaSyncProjection(
	options: ToolSchemaSyncInput,
	adminAppId: string,
): ToolSchemaSyncProjectionPlan {
	const appId = options.appId ?? adminAppId;
	const effective = resolveEffectiveToolSchemaSyncOptions(
		options,
		appId,
		adminAppId,
	);
	const candidates = projectionCandidates(effective).sort(compareEndpointPath);
	const resolved = generateToolIdMap(candidates, effective.toolIdOverrides);
	const toolIds: Record<string, string> = {};
	const endpoints: string[] = [];
	for (const candidate of candidates) {
		const path = endpointPathOf(candidate);
		endpoints.push(path);
		const resolvedToolId = resolved.get(path);
		if (resolvedToolId) toolIds[path] = resolvedToolId;
	}
	return { appId, endpoints, toolIds };
}

export interface ToolSchemaSyncRowPlan {
	appId: string;
	/** Stored tool ids in deterministic order. Frozen batch input. */
	toolIds: string[];
}

/**
 * Schema-mode work list: the app's stored tool ids, ordered by the same stable
 * key the sync reads rows with. Reads one column per row so planning never
 * materializes the ~3 MB of schema/config JSON that the batches page in.
 */
export async function planToolSchemaSyncRows(
	db: DbClient,
	options: ToolSchemaSyncInput,
): Promise<ToolSchemaSyncRowPlan> {
	const appId = options.appId ?? (await resolveTedixAdminAppId(db));
	const stored = await listToolIdsForSchemaSync(db, appId);
	const requested = options.toolIds ? new Set(options.toolIds) : null;
	const toolIds = (
		requested ? stored.filter((toolId) => requested.has(toolId)) : stored
	).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	return { appId, toolIds };
}

export async function runToolSchemaSync(
	db: DbClient,
	options: ToolSchemaSyncInput,
	env?: CloudflareEnv,
): Promise<ToolSchemaSyncResult> {
	const appId = options.appId ?? (await resolveTedixAdminAppId(db));
	// A tenant projection names its own app and must not require the platform
	// admin app: a fresh local database has none, and first-run onboarding
	// projects workspace tools into the new tenant gateway.
	const adminAppId = options.appId
		? (await getAppBySlug(db, TEDIX_ADMIN_APP_SLUG))?.id
		: appId;
	const effectiveOptions = resolveEffectiveToolSchemaSyncOptions(
		options,
		appId,
		adminAppId,
	);
	const mode = options.mode ?? "schema";
	const source = options.source ?? "rpc";
	const target = options.target ?? "both";
	const apply = options.apply ?? false;
	const pruneStale = options.pruneStale ?? true;
	const columns = targetColumns(target);
	const onlyToolIds = options.toolIds ? new Set(options.toolIds) : null;

	if (source !== "rpc") {
		throw new Error(`Unsupported tool schema source: ${source}`);
	}

	if (mode === "projection") {
		// Resolve the work list and the tool id map BEFORE touching D1 so the
		// row read can be scoped to exactly the rows this run can match.
		const endpoints = projectionCandidates(effectiveOptions);
		const resolvedToolIds = generateToolIdMap(
			endpoints,
			effectiveOptions.toolIdOverrides,
		);
		// An explicitly scoped run (one batch of a batched sync) reads only the
		// rows it can possibly match. `runToolProjectionSync` looks an existing
		// row up by exactly two keys — the endpoint path and the resolved tool id
		// — so scoping the read to those two key sets returns the same rows the
		// unscoped read would have matched. Anything wider is memory the batch
		// does not need: the Tedix admin app carries ~3 MB of schema/config JSON.
		const projectionRows = options.endpoints?.length
			? await listToolsForSchemaSyncScoped(db, appId, {
					endpoints: endpoints.map(endpointPathOf),
					toolIds: [...resolvedToolIds.values(), ...(options.toolIds ?? [])],
				})
			: await listToolsForSchemaSync(db, appId);
		const projectionResult = await runToolProjectionSync(
			db,
			projectionRows,
			endpoints,
			resolvedToolIds,
			{
				...effectiveOptions,
				appId,
				source,
				target,
				apply,
				mode,
			},
		);
		await publishToolSchemaSyncEvents(env, projectionResult);
		return projectionResult;
	}

	// Schema mode batches over stored tool ids, so the same scoping rule applies:
	// only the batch's rows are read, and every row outside the batch is
	// untouched — including by `pruneStale`, which can only delete a row it read.
	const rows = options.toolIds?.length
		? await listToolsForSchemaSyncScoped(db, appId, {
				toolIds: options.toolIds,
			})
		: await listToolsForSchemaSync(db, appId);

	const rpcTools = rows.filter((tool) => {
		if (onlyToolIds && !onlyToolIds.has(tool.toolId)) return false;
		const endpoint = asRpcEndpoint(tool);
		if (!endpoint) return false;
		if (!options.router) return true;
		return resolveContractEndpoint(endpoint)?.router === options.router;
	});

	const items: ToolSchemaSyncResult["items"] = [];
	let planned = 0;
	const created = 0;
	let updated = 0;
	let deleted = 0;
	let inSync = 0;
	let skipped = 0;
	let failed = 0;

	for (const tool of rpcTools) {
		const endpoint = asRpcEndpoint(tool);
		if (!endpoint) continue;

		const lookup = resolveContractEndpoint(endpoint);
		if (!lookup) {
			if (!pruneStale) {
				skipped++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "noContract",
					changed: [],
					message: "No matching oRPC contract endpoint",
				});
				continue;
			}

			planned++;
			if (options.limit !== undefined && planned > options.limit) {
				planned--;
				skipped++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "skipped",
					changed: [],
					message: "Limit reached",
				});
				continue;
			}

			if (!apply) {
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "wouldDelete",
					changed: [],
					message: "No matching oRPC contract endpoint",
				});
				continue;
			}

			try {
				await deleteTool(db, tool.id);
				deleted++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "deleted",
					changed: [],
					message: "No matching oRPC contract endpoint",
				});
			} catch (error) {
				failed++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "failed",
					changed: [],
					message: (error as Error).message,
				});
			}
			continue;
		}
		const patch: Partial<Pick<AppTool, "inputSchema" | "outputSchema">> = {};
		let nextInputSchema: AppTool["inputSchema"] | null = null;
		const changed: SyncColumn[] = [];

		for (const column of columns) {
			const zodSchema =
				column === "inputSchema" ? lookup.inputSchema : lookup.outputSchema;
			if (column === "outputSchema" && !zodSchema) continue;

			let nextSchema: AppTool["inputSchema"] | AppTool["outputSchema"];
			try {
				nextSchema =
					column === "inputSchema"
						? zodToToolInputJsonSchema(zodSchema)
						: zodToStructuredOutputJsonSchema(zodSchema);
			} catch (error) {
				skipped++;
				items.push({
					toolUuid: tool.id,
					toolId: tool.toolId,
					endpoint,
					status: "converterUnsupported",
					changed: [],
					message: `${column}: ${(error as Error).message}`,
				});
				continue;
			}
			if (!nextSchema) continue;
			if (column === "inputSchema") {
				nextInputSchema = nextSchema as AppTool["inputSchema"];
			}

			const currentSchema = tool[column];
			if (stableStringify(currentSchema) !== stableStringify(nextSchema)) {
				if (column === "inputSchema") {
					patch.inputSchema = nextSchema as AppTool["inputSchema"];
				} else {
					patch.outputSchema = nextSchema as AppTool["outputSchema"];
				}
				changed.push(column);
			}
		}

		const currentConfig = (tool.config ?? {}) as JsonObject;
		const nextConfig = { ...currentConfig };
		const effectiveInputSchema = nextInputSchema ?? tool.inputSchema;
		if (
			hasObjectProperty(effectiveInputSchema, "tediId") &&
			nextConfig.allowExplicitTediId !== true
		) {
			nextConfig.allowExplicitTediId = true;
		}
		if (
			hasObjectProperty(effectiveInputSchema, "appId") &&
			nextConfig.allowExplicitAppId !== true
		) {
			nextConfig.allowExplicitAppId = true;
		}
		// Inject the caller's org for caller-org-scoped sub-collection routes (e.g.
		// `members` → `/{organizationId}/members`) so forwarded MCP users don't
		// pass/spoof their own org UUID. Gated on an explicit router allowlist
		// (NOT a path heuristic) so platform-admin cross-org procs like
		// organizations.cancel (also `/{organizationId}/...`) is never
		// auto-rescoped. The path check still excludes non-org routes in an
		// allowlisted router (e.g. members.acceptInvitation).
		if (
			ORG_INJECT_ROUTERS.has(lookup.router) &&
			lookup.route?.path?.includes("{organizationId}/") &&
			nextConfig.injectOrganizationId !== true
		) {
			nextConfig.injectOrganizationId = true;
		}
		if (stableStringify(currentConfig) !== stableStringify(nextConfig)) {
			changed.push("config");
		}

		if (changed.length === 0) {
			inSync++;
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "inSync",
				changed: [],
			});
			continue;
		}

		planned++;
		if (options.limit !== undefined && planned > options.limit) {
			planned--;
			skipped++;
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "skipped",
				changed,
				message: "Limit reached",
			});
			continue;
		}

		if (!apply) {
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "wouldUpdate",
				changed,
			});
			continue;
		}

		try {
			const now = new Date().toISOString();
			const schemaSourceHash = await sha256({
				endpoint,
				inputSchema: patch.inputSchema ?? tool.inputSchema,
				outputSchema: patch.outputSchema ?? tool.outputSchema,
				config: changed.includes("config") ? nextConfig : currentConfig,
			});
			await updateToolSchemaProjection(db, {
				toolId: tool.id,
				patch: { ...patch, schemaSourceRef: endpoint },
				config: changed.includes("config")
					? toJsonRecord(nextConfig)
					: undefined,
				schemaSourceHash,
				now,
			});

			updated++;
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "updated",
				changed,
			});
		} catch (error) {
			failed++;
			items.push({
				toolUuid: tool.id,
				toolId: tool.toolId,
				endpoint,
				status: "failed",
				changed,
				message: (error as Error).message,
			});
		}
	}

	const result: ToolSchemaSyncResult = {
		appId,
		mode,
		source,
		target,
		apply,
		total: rpcTools.length,
		planned,
		created,
		updated,
		deleted,
		inSync,
		skipped,
		failed,
		items,
	};
	await publishToolSchemaSyncEvents(env, result);
	return result;
}
