/**
 * Projection override tables for the Tedix admin app's oRPC → MCP tool
 * surface: stable tool ids, declared operator kinds, widget overlays, and the
 * endpoint allowlists the projection consults. Pure data — no D1 access —
 * consumed by `tool-schema-projection.ts` and merged into a sync's options by
 * `tool-schema-sync.ts`.
 */
import type { ToolSchemaSyncInput } from "@tedix/api-contract/contracts/tool-schema-sync";
import {
	WORKFLOW_DEFINITIONS_WIDGET,
	WORKFLOW_HEALTH_WIDGET,
} from "@tedix/api-contract/contracts/workflows";

export const OPEN_WORLD_ENDPOINTS = new Set([
	"seo/researchKeywords",
	"seo/getSerpResults",
	"seo/getDomainOverview",
	"seo/getBacklinksOverview",
]);

export const EXTERNAL_AGENT_MCP_ENDPOINTS = new Set([
	"externalAgentIdentity/createPrincipal",
	"externalAgentIdentity/renamePrincipal",
	"externalAgentIdentity/openOwnerHostSession",
	"externalAgentIdentity/recordKnowledgeCheckpoint",
	"externalAgentIdentity/recordKnowledgeDisposition",
	"externalAgentIdentity/endSession",
	"externalAgentIdentity/retireAbandonedSession",
	"externalAgentIdentity/revokeMcpCredential",
	"externalAgentIdentity/listStaleKnowledgeSessions",
]);

export const EXTERNAL_AGENT_TOOL_ID_OVERRIDES: Record<string, string> = {
	"externalAgentIdentity/createPrincipal": "create_external_agent_principal",
	"externalAgentIdentity/renamePrincipal": "rename_external_agent_principal",
	"externalAgentIdentity/openOwnerHostSession":
		"start_external_agent_session_for_host",
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
	"externalAgentIdentity/renamePrincipal": "write",
	"externalAgentIdentity/openOwnerHostSession": "write",
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
	"personalResourceDelegations/create": "create_personal_resource_delegation",
	"personalResourceDelegations/list": "list_personal_resource_delegations",
	"personalResourceDelegations/revoke": "revoke_personal_resource_delegation",
	"calendarCoordinator/supportedAccounts": "list_calendar_accounts",
	"calendarCoordinator/listCalendars": "list_account_calendars",
	"calendarCoordinator/list": "list_calendar_coordinators",
	"calendarCoordinator/configure": "configure_calendar_coordinator",
	"calendarCoordinator/activate": "activate_calendar_coordinator",
	"calendarCoordinator/deactivate": "deactivate_calendar_coordinator",
	"calendarCoordinator/preview": "preview_calendar_reconciliation",
	"calendarCoordinator/apply": "apply_calendar_reconciliation",
	"calendarCoordinator/previewCompensation": "preview_calendar_compensation",
	"calendarCoordinator/compensate": "compensate_calendar_reconciliation",
	"calendarCoordinator/recover": "recover_calendar_reconciliation",
	"calendarCoordinator/reconcileSubscription":
		"reconcile_calendar_subscription",
	"calendarCoordinator/status": "get_calendar_coordinator_status",
	"osGadgetState/get": "get_os_gadget_state",
	"osGadgetState/list": "list_os_gadget_state",
	"osGadgetState/put": "put_os_gadget_state",
	"osGadgetState/delete": "delete_os_gadget_state",
	"providerEvents/register": "register_provider_event_subscription",
	"providerEvents/list": "list_provider_event_subscriptions",
	"providerEvents/get": "get_provider_event_subscription",
	"providerEvents/disable": "disable_provider_event_subscription",
	"providerEvents/reconcile": "reconcile_provider_event_subscription",

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
	"osWorkspaces/workspaces/restore": "restore_os_workspace",
	"osWorkspaces/workspaces/delete": "delete_os_workspace",
	"osWorkspaces/resources/list": "list_os_workspace_resources",
	"osWorkspaces/resources/requestFileUpload":
		"request_os_workspace_file_upload",
	"osWorkspaces/resources/confirmFileUpload":
		"confirm_os_workspace_file_upload",
	"osWorkspaces/resources/getFile": "get_os_workspace_file",
	"osWorkspaces/resources/create": "create_os_workspace_resource",
	"osWorkspaces/resources/get": "get_os_workspace_resource",
	"osWorkspaces/resources/readPdf": "read_os_workspace_pdf",
	"osWorkspaces/resources/rename": "rename_os_workspace_resource",
	"osWorkspaces/resources/remove": "remove_os_workspace_resource",
	"osWorkspaces/schedules/list": "list_os_workspace_schedules",
	"osWorkspaces/schedules/link": "link_os_workspace_skill",
	"osWorkspaces/schedules/unlink": "unlink_os_workspace_skill",
	"osWorkspaces/schedules/linkFactorySkills":
		"link_os_workspace_factory_skills",
	"osWorkspaces/gadgets/list": "list_os_gadgets",
	"osWorkspaces/gadgets/workApps": "list_work_apps",
	"osWorkspaces/gadgets/installWorkDefaults": "install_work_defaults",
	"osWorkspaces/gadgets/create": "create_os_gadget",
	"osWorkspaces/gadgets/get": "get_os_gadget",
	"osWorkspaces/gadgets/revise": "revise_os_gadget",
	"osWorkspaces/gadgets/archive": "archive_os_gadget",
	"osWorkspaces/gadgets/rename": "rename_os_gadget",
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
	"osWorkspaces/blueprints/apply": "apply_os_blueprint",
	"osWorkspaces/blueprints/previewApply": "preview_os_blueprint_apply",
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
	"osWorkspaces/outputs/history": "get_os_output_history",
	"osWorkspaces/outputs/rename": "rename_os_output",
	"osWorkspaces/outputs/move": "move_os_output",
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
	"personalResourceDelegations/create": "destructive",
	"personalResourceDelegations/list": "read",
	"personalResourceDelegations/revoke": "destructive",
	"calendarCoordinator/supportedAccounts": "read",
	"calendarCoordinator/listCalendars": "read",
	"calendarCoordinator/list": "read",
	"calendarCoordinator/configure": "write",
	"calendarCoordinator/activate": "destructive",
	"calendarCoordinator/deactivate": "destructive",
	"calendarCoordinator/preview": "write",
	"calendarCoordinator/apply": "destructive",
	"calendarCoordinator/previewCompensation": "write",
	"calendarCoordinator/compensate": "destructive",
	"calendarCoordinator/recover": "write",
	"calendarCoordinator/reconcileSubscription": "destructive",
	"calendarCoordinator/status": "read",
	"osGadgetState/get": "read",
	"osGadgetState/list": "read",
	"osGadgetState/put": "write",
	"osGadgetState/delete": "destructive",
	"providerEvents/register": "destructive",
	"providerEvents/list": "read",
	"providerEvents/get": "read",
	"providerEvents/disable": "destructive",
	"providerEvents/reconcile": "destructive",

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
	"osWorkspaces/workspaces/restore": "write",
	"osWorkspaces/workspaces/delete": "destructive",
	"osWorkspaces/resources/requestFileUpload": "write",
	"osWorkspaces/resources/confirmFileUpload": "write",
	"osWorkspaces/resources/getFile": "read",
	"osWorkspaces/resources/readPdf": "read",
	"osWorkspaces/gadgets/list": "read",
	"osWorkspaces/gadgets/workApps": "read",
	"osWorkspaces/gadgets/installWorkDefaults": "write",
	"osWorkspaces/gadgets/create": "write",
	"osWorkspaces/gadgets/get": "read",
	"osWorkspaces/gadgets/revise": "write",
	"osWorkspaces/gadgets/archive": "write",
	"osWorkspaces/gadgets/rename": "write",
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
	"osWorkspaces/blueprints/apply": "write",
	"osWorkspaces/blueprints/previewApply": "read",
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
	"osWorkspaces/outputs/history": "read",
	"osWorkspaces/outputs/rename": "write",
	"osWorkspaces/outputs/move": "write",
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
	"skills/pauseSchedule": "pause_skill_schedule",
	"skills/resumeSchedule": "resume_skill_schedule",
	"skills/restartWorkflow": "restart_skill_workflow",
	"skills/approveWorkflow": "approve_skill_workflow",
	"skills/rejectWorkflow": "reject_skill_workflow",
	"skills/getRunArtifact": "get_skill_run_artifact",
	"skills/listRunArtifacts": "list_skill_run_artifacts",
	"skills/revokeSkillRun": "revoke_skill_run",
	"skills/moveToTedi": "move_skill_to_tedi",
};

export const SKILL_WORKFLOW_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"skills/getWorkspaceDraftGrant": "read",
	"skills/getWorkspaceDraftProposal": "read",
	"skills/listWorkspaceDraftProposals": "read",
	"skills/proposeWorkspaceRevision": "write",
	"skills/setWorkspaceDraftGrant": "destructive",
	"skills/withdrawWorkspaceDraftProposal": "write",
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
	"skills/activateWorkflowImprovement": "write",
	"skills/inspectWorkflowRun": "read",
	"skills/listWorkflowSteps": "read",
	"skills/listWorkflowToolCalls": "read",
	"skills/listWorkflowRevisions": "read",
	"skills/getWorkflowRevision": "read",
	"skills/compareWorkflowRevisions": "read",
	"skills/getWorkflowReliability": "read",
	"skills/pauseWorkflow": "write",
	// Defaults to a dry run; a real move is reversed by moving the skill back.
	"skills/moveToTedi": "write",
	"skills/resumeWorkflow": "write",
	// Only capabilities.schedule.enabled changes; resume undoes pause.
	"skills/pauseSchedule": "write",
	"skills/resumeSchedule": "write",
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

/**
 * Memory reads served over POST whose names carry no read verb. Inferred as
 * writes, they emitted unverified action receipts that replaced a tedi's
 * answer with "I could not verify every action" (CFO memory check, 23 Oct).
 */
export const MEMORY_GRAPH_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"memoryGraph/assemble": "read",
	"memoryGraph/browse": "read",
	"memoryGraph/expertise": "read",
	"memoryGraph/stats": "read",
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
	"memoryGraph/browse": "browse_memories",
	"decisionGraph/getContext": "get_decision_context",
	"decisionGraph/backfillPreview": "preview_decision_graph_backfill",
	"decisionGraph/recordAgentDecision": "record_agent_decision",
	"decisionGraph/recordAgentDecisionOutcome": "record_agent_decision_outcome",
	"decisionGraph/listAgentDecisions": "list_agent_decisions",
	"memoryGraph/listObservations": "list_memory_observations",
	"memoryGraph/consolidateObservations": "consolidate_memory_observations",
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
	"memoryGraph/listObservations": "read",
	"memoryGraph/browse": "read",
	"decisionGraph/getContext": "read",
	"decisionGraph/backfillPreview": "read",
	"decisionGraph/recordAgentDecision": "write",
	"decisionGraph/recordAgentDecisionOutcome": "write",
	"decisionGraph/listAgentDecisions": "read",
	"memoryGraph/consolidateObservations": "write",
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
	"attention/listDeckCards": "list_deck_cards",
	"attention/showDeck": "show_deck",
	"attention/showFeed": "show_feed",
	"attention/rankDeckCards": "rank_deck_cards",
	"attention/getDeckCard": "get_deck_card",
	"attention/decideDeckCard": "decide_deck_card",
	"attention/curationInbox": "list_deck_curation_inbox",
	"attention/curateDeckCard": "curate_deck_card",
	"attention/retireDeckCard": "retire_deck_card",
	"attention/mergeDeckCards": "merge_deck_cards",
	"attention/getDeckPipelineStatus": "get_deck_pipeline_status",
	"attention/markDeckCardNotUseful": "mark_deck_card_not_useful",
	"attention/removeDeckRule": "remove_deck_rule",
	"attention/rankCurationInbox": "rank_deck_curation_inbox",
	"attention/listFeedForYou": "list_feed_for_you",
	"repositoryObserver/configure": "configure_repository_observer",
	"repositoryObserver/observe": "observe_repository_event",
	"repositoryObserver/report": "report_repository_observation",
	"repositoryObserver/repair": "dispatch_repository_repair",
	"repositoryObserver/pending": "list_repository_observations",
	"support/file": "file_support_request",
	"support/status": "get_support_status",
	"support/mine": "list_my_support_tickets",
	"support/configure": "configure_support_factory",
	"support/queue": "list_support_tickets",
	"support/get": "get_support_ticket",
	"support/draft": "draft_support_answer",
	"support/publish": "publish_support_answer",
	"support/escalate": "escalate_support_ticket",
	"support/review": "record_support_review",
	"projects/create": "create_project",
	"projects/get": "get_project",
	"projects/update": "update_project",
	"projects/archive": "archive_project",
	"projects/getRollup": "get_project_rollup",
	"projects/getContinuity": "get_project_continuity",
	"projects/getPortfolio": "get_project_portfolio",
	"projects/getTodayTotals": "get_today_project_totals",
	"projects/getFactoryScoreboard": "get_factory_scoreboard",
	"projects/createFactory": "create_factory",
	"projects/pauseFactory": "pause_factory",
	"projects/resumeFactory": "resume_factory",
	"projects/archiveFactory": "archive_factory",
	"projects/inspectFactoryHealth": "inspect_factory_health",
	"projects/createMilestone": "create_project_milestone",
	"projects/listMilestones": "list_project_milestones",
	"projects/updateMilestone": "update_project_milestone",
	"projects/attachMilestoneWorkItem": "attach_project_milestone_work_item",
	"projects/addMilestoneDependency": "add_project_milestone_dependency",
	"projects/recordHealthJudgment": "record_project_health_judgment",
	"projects/listHealthJudgments": "list_project_health_judgments",
	"workItems/listCliProjection": "list_work_item_cli_rows",
	"workItems/getCheckpointProjection": "get_work_item_checkpoint",
	"workItems/listAttemptCliProjection": "list_work_attempt_cli_rows",
	"workItems/listEvidenceCliProjection": "list_work_evidence_cli_rows",
	"workItems/listEventCliProjection": "list_work_event_cli_rows",
	"workInteractions/listCliInboxProjection": "list_work_interaction_cli_rows",
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
	"workInteractions/refreshDecisionSources": "refresh_decision_sources",
	"workInteractions/regenerateCard": "regenerate_decision_card",
	"workInteractions/cardHistory": "get_card_revision_history",
	"workInteractions/listCardVersions": "list_card_versions",
	"workInteractions/requestCardChanges": "request_card_changes",
	"workInteractions/reviseCard": "revise_decision_card",
	"workInteractions/outbound/submit": "submit_outbound_draft",
	"workInteractions/outbound/review": "review_outbound_draft",
	"workInteractions/outbound/requestReview": "request_outbound_review",
	"workInteractions/outbound/get": "get_outbound_draft",
	"workInteractions/outbound/list": "list_outbound_drafts",
	"workInteractions/outbound/policy": "get_outbound_review_policy",
	"workInteractions/outbound/configure": "configure_outbound_review",
	"workInteractions/respond": "respond_work_interaction",
	"workInteractions/review": "review_work_interaction",
	"workInteractions/cancel": "cancel_work_interaction",
	"workInteractions/get": "get_work_interaction",
	"workInteractions/listInbox": "list_work_interactions",
	"workInteractions/listOutbox": "list_work_interaction_outbox",
	"workInteractions/listAudit": "list_work_interaction_audit",
	"workInteractions/listUndelivered":
		"list_undelivered_work_interaction_responses",
	"workInteractions/ackDelivery": "ack_work_interaction_delivery",
	"workInteractions/recordDraftDelivery": "record_reply_draft_delivery",
	"workFleet/getControlTower": "get_work_fleet_control_tower",
	"workAgentSessions/report": "report_work_agent_session_status",
	"workAgentSessions/list": "list_work_agent_sessions",
	"workAgentSessions/attention": "read_work_attention",
	"workAgentSessions/getAttentionLayout": "get_attention_layout",
	"workAgentSessions/updateAttentionLayout": "update_attention_layout",
	"workAgentSessions/visitAttention": "record_attention_visit",
	"workAgentSessions/contributors": "list_work_project_contributors",
	"workAgentSessions/recordEvents": "record_agent_session_events",
	"workAgentSessions/listActivity": "list_agent_session_activity",
	"workAgentSessions/listRequests": "list_agent_session_requests",
	"workAgentSessions/updateRequest": "update_agent_session_request",
	"workAgentSessions/fileRequest": "file_agent_session_request",
	"workAgentSessions/classifyRequests": "classify_agent_session_requests",
	"workScheduler/listReady": "list_ready_work",
	"workScheduler/planClusters": "plan_work_execution_clusters",
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
	"attention/listDeckCards": "read",
	"attention/showDeck": "read",
	"attention/showFeed": "read",
	"attention/rankDeckCards": "write",
	"attention/getDeckCard": "read",
	"attention/decideDeckCard": "write",
	"attention/curationInbox": "read",
	"attention/curateDeckCard": "write",
	"attention/retireDeckCard": "write",
	"attention/mergeDeckCards": "write",
	"attention/getDeckPipelineStatus": "read",
	"attention/markDeckCardNotUseful": "write",
	"attention/removeDeckRule": "write",
	"attention/rankCurationInbox": "write",
	"attention/listFeedForYou": "read",
	"repositoryObserver/configure": "write",
	"repositoryObserver/observe": "write",
	"repositoryObserver/report": "write",
	"repositoryObserver/repair": "write",
	"repositoryObserver/pending": "read",
	"projects/create": "write",
	"projects/update": "write",
	"projects/archive": "destructive",
	"projects/list": "read",
	"projects/get": "read",
	"projects/getRollup": "read",
	"projects/getPortfolio": "read",
	"projects/getTodayTotals": "read",
	"projects/getFactoryScoreboard": "read",
	"projects/createFactory": "write",
	"projects/pauseFactory": "write",
	"projects/resumeFactory": "write",
	"projects/archiveFactory": "write",
	"projects/inspectFactoryHealth": "read",
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
	"workInteractions/refreshDecisionSources": "write",
	"workInteractions/regenerateCard": "write",
	"workInteractions/requestCardChanges": "write",
	"workInteractions/listCardVersions": "read",
	"workInteractions/rememberCardStyle": "write",
	"workInteractions/reviewCardStyleRule": "write",
	"workInteractions/reviseCard": "write",
	"workInteractions/outbound/submit": "write",
	"workInteractions/outbound/review": "write",
	"workInteractions/outbound/requestReview": "write",
	"workInteractions/outbound/get": "read",
	"workInteractions/outbound/list": "read",
	"workInteractions/outbound/policy": "read",
	"workInteractions/outbound/configure": "write",
	"workInteractions/respond": "write",
	"workInteractions/review": "write",
	"workInteractions/cancel": "destructive",
	"workInteractions/get": "read",
	"workInteractions/listInbox": "read",
	"workInteractions/listOutbox": "read",
	"workInteractions/listAudit": "read",
	"workInteractions/listUndelivered": "read",
	"workInteractions/ackDelivery": "write",
	"workInteractions/recordDraftDelivery": "write",
	"workFleet/getControlTower": "read",
	"workAgentSessions/report": "write",
	"workAgentSessions/list": "read",
	"workAgentSessions/attention": "read",
	"workAgentSessions/getAttentionLayout": "read",
	"workAgentSessions/updateAttentionLayout": "write",
	"workAgentSessions/visitAttention": "write",
	"workAgentSessions/contributors": "read",
	"workAgentSessions/recordEvents": "write",
	"workAgentSessions/listRequests": "read",
	"workAgentSessions/updateRequest": "write",
	"workScheduler/listReady": "read",
	"workScheduler/planClusters": "read",
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
	"workItems/cancel": "write",
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
 * reads, so they project as `read`; reply-draft request/propose append state
 * (a queued drafting turn, an immutable draft) and project as `write`.
 */
export const AGENT_TURN_TRIAGE_TOOL_ID_OVERRIDES: Record<string, string> = {
	"learningFeedback/model": "get_decision_learning",
	"learningFeedback/cardContext": "record_card_context",
	"learningFeedback/cardContextPrompt": "record_card_context_view",
	"learningFeedback/configure": "configure_decision_learning",
	"learningFeedback/correct": "correct_decision_learning",
	"agentTurnTriage/triage": "triage_agent_turn",
	"agentTurnTriage/labelReply": "label_agent_reply",
	"agentTurnTriage/getPolicy": "get_agent_turn_triage_policy",
	"agentTurnTriage/updatePolicy": "update_agent_turn_triage_policy",
	"agentTurnTriage/requestReplyDraft": "request_agent_reply_draft",
	"agentTurnTriage/proposeReplyDraft": "propose_agent_reply_draft",
	"agentTurnTriage/retriageQuestions": "retriage_agent_turn_questions",
	"agentTurnTriage/getReplyDraftAcceptance": "get_agent_reply_draft_acceptance",
	"agentTurnTriage/getReplyDraftLeaderboard":
		"get_agent_reply_draft_leaderboard",
	"agentTurnTriage/getCaptureHealth": "get_decision_capture_health",
	"agentTurnTriage/getSessionLessons": "get_agent_session_lessons",
	"agentTurnTriage/recordSessionFeedback": "record_session_feedback",
	"agentTurnTriage/listLessons": "list_agent_session_lessons",
	"agentTurnTriage/updateLessonTriggers": "update_lesson_triggers",
	"agentTurnTriage/backfillLessonTriggers": "backfill_lesson_triggers",
	"agentTurnTriage/recordLessonIncident": "record_lesson_incident",
	"agentTurnTriage/getLessonEffectiveness": "get_lesson_effectiveness",
	"agentTurnTriage/mineSessionLessons": "mine_agent_session_lessons",
	"agentTurnTriage/importSessionDecisions": "import_agent_session_decisions",
};

export const AGENT_TURN_TRIAGE_KIND_OVERRIDES: Record<
	string,
	"read" | "write" | "destructive"
> = {
	"learningFeedback/model": "read",
	"learningFeedback/cardContext": "write",
	"learningFeedback/cardContextPrompt": "write",
	"learningFeedback/configure": "write",
	"learningFeedback/correct": "write",
	"agentTurnTriage/triage": "read",
	"agentTurnTriage/labelReply": "read",
	"agentTurnTriage/getPolicy": "read",
	"agentTurnTriage/updatePolicy": "write",
	"agentTurnTriage/requestReplyDraft": "write",
	"agentTurnTriage/proposeReplyDraft": "write",
	"agentTurnTriage/retriageQuestions": "write",
	"agentTurnTriage/getReplyDraftAcceptance": "read",
	"agentTurnTriage/getReplyDraftLeaderboard": "read",
	"agentTurnTriage/getCaptureHealth": "read",
	"agentTurnTriage/getSessionLessons": "read",
	"agentTurnTriage/listLessons": "read",
	"agentTurnTriage/updateLessonTriggers": "write",
	"agentTurnTriage/backfillLessonTriggers": "write",
	"agentTurnTriage/recordLessonIncident": "write",
	"agentTurnTriage/getLessonEffectiveness": "read",
	"agentTurnTriage/mineSessionLessons": "write",
	"agentTurnTriage/importSessionDecisions": "write",
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
export const ORG_INJECT_ROUTERS = new Set<string>(["members"]);
