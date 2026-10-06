import { DOCS_TOOL_SCOPES } from "../contracts/docs-tool-scopes";

/**
 * MCP Capability Scope Mapping
 *
 * Maps tool name prefixes to granular domain.read/write/admin capability
 * scopes used for Descope policy configuration.
 * Capability scopes are coarser-grained than per-tool `mcp:<tool.name>`
 * scopes — they group related tools so a single Descope policy can grant
 * access to a whole category.
 *
 * The `generateToolScopes()` helper drafts a D1-ready `toolScopes` mapping
 * (`mcpConfig.toolScopes`) from tool NAMES alone. It is an authoring aid for a
 * first draft, never a description of what an app enforces: the edge resolves
 * scopes with `resolveMcpToolRequiredScopes` (packages/mcp), where the name
 * mapping below is the LAST fallback, after per-app `toolScopes`,
 * `enforcePolicies` mode, dangerous-tool promotion, and namespace fallbacks.
 * Report enforcement with the resolver; use these helpers only to draft.
 *
 * =============================================================================
 * ACTIVATION CHECKLIST
 * =============================================================================
 *
 * The scope enforcement pipeline is code-complete. To activate for an app:
 *
 * Step 1 — See what the app enforces today
 *   Call POST /rpc/mcp-server/{appId}/mcp-server/preview-tool-scopes for the
 *   target app.
 *   It reports the scopes the edge resolves for `tools/list` and `tools/call`,
 *   so tools grouped under `(none)` are the candidates to close. Verify before
 *   acting on an app that has never had a `toolScopes` key: Code Mode's inner
 *   gate resolves with `fallbackOnAuthenticatedAuthMode: true` and can enforce a
 *   namespace fallback the preview shows as `(none)`.
 *
 * Step 2 — Create Descope policies in the Descope Console
 *   a) Platform Admin policy  → grant platform:admin on a separate operator client
 *   b) Org Member policy      → prefer read-only granular scopes such as
 *                               mcp:apps.read, mcp:catalog.read,
 *                               mcp:observe.read
 *   c) Org Admin policy       → grant write/admin scopes for the org-owned
 *                               capabilities the admin should operate
 *   d) Tedi Agent policy      → grant worker scopes based on its D1 capability
 *                               profile; never grant platform authority by default
 *   Add `connections.execute` only to callers that invoke a connected provider.
 *   Credential retrieval stays internal. Descope manages identity scopes separately; do not
 *   add `profile` or `email` to every capability policy by rote.
 *
 *   IMPORTANT — gate condition: use `user.tenantIds CONTAINS "<tenantId>"`,
 *   NOT `user.roles CONTAINS "<role>"`. The inbound-app consent flow does
 *   not establish a tenant context, so `user.roles` is empty (`{}`) and any
 *   roles-only policy will silently deny with "CreateConsentPoliciesDenied".
 *   See docs/platform/auth.md "AIH Consent Flow Gotchas" for the full story.
 *
 *   Also: Tedix CLI binds the tenant before authorization, so the Resource's
 *   User Consent Flow must be `inbound-apps-user-consent`. The separate Client
 *   Registration Flow assesses DCR and CIMD clients and must not be confused
 *   with the User Consent Flow. Current AIH policies are Console-managed.
 *
 * Step 3 — Populate toolScopes in D1
 *   Use the preview endpoint output and write the chosen mapping to D1:
 *   { "toolScopes": { "<toolName>": ["mcp:<capability>"], ... } }
 *   Use `toolScopes` for broad compatibility, or `granularToolScopes` once
 *   the matching Descope scopes and policies have been registered.
 *
 * Step 4 — Enable enforcement
 *   Set in apps.metadata.mcpConfig:
 *   { "enforcePolicies": false, "authMode": "authenticated", "toolScopes": {...} }
 *   Note: keep enforcePolicies false to use capability scopes (D1 toolScopes path),
 *   not the per-tool mcp:<tool.name> policy path. Set authMode: "authenticated"
 *   so unauthenticated requests are blocked at the edge before tool dispatch.
 *
 * Step 5 — Test with a non-admin user
 *   Obtain a resource-bound token. Attempt to call a tool in each capability
 *   group. Verify the edge returns 403 for missing-scope calls and 200 for
 *   permitted ones. Check WWW-Authenticate headers carry the right scope names.
 *
 * =============================================================================
 */

// =============================================================================
// CAPABILITY SCOPE DESCRIPTIONS
// =============================================================================

/**
 * Broad capability scopes and their human-readable descriptions.
 * These are registered in Descope and assigned to Descope policies.
 */
export const MCP_CAPABILITY_SCOPES = {
	"mcp:tedis": "Manage your digital workers",
	"mcp:apps": "Manage MCP apps",
	"mcp:memory": "Access tedi memory & knowledge",
	"mcp:skills": "Manage org skills and executable skill workflows",
	"mcp:content": "Manage content & blog",
	"mcp:catalog": "Browse & publish to marketplace",
	"mcp:observe": "View logs, audit & analytics",
	"mcp:messaging": "Send messages to tedis",
	"mcp:settings": "Manage your org settings, members & connections",
	"mcp:work": "Operate governed Work Items and evidence",
} as const;

export type McpCapabilityScopeName = keyof typeof MCP_CAPABILITY_SCOPES;

export const MCP_GRANULAR_CAPABILITY_SCOPES = {
	"mcp:tedis.read": "View digital workers",
	"mcp:tedis.write": "Operate digital workers",
	"mcp:tedis.admin": "Administer digital workers",
	"mcp:apps.read": "View MCP apps and tool configuration",
	"mcp:apps.write": "Create and update MCP apps and tools",
	"mcp:apps.admin": "Delete apps, rotate credentials, and change app security",
	"mcp:memory.read": "Read tedi memory and rationale",
	"mcp:memory.write": "Write tedi memory and rationale",
	"mcp:memory.admin": "Delete or reconfigure memory and rationale",
	"mcp:skills.read": "Read org skills and skill workflow runs",
	"mcp:skills.write": "Create, update, validate, and run org skills",
	"mcp:skills.admin": "Delete, repair, promote, or reconfigure org skills",
	"mcp:content.read": "Read content and CMS data",
	"mcp:content.write": "Create and update content and CMS data",
	"mcp:content.admin": "Delete content or change content security",
	"mcp:catalog.read": "Browse catalog and marketplace data",
	"mcp:catalog.write": "Publish or update catalog and marketplace data",
	"mcp:catalog.admin": "Delete or administer catalog and marketplace data",
	"mcp:observe.read": "View logs, audit, analytics, and health",
	"mcp:observe.write": "Run diagnostics and health checks",
	"mcp:observe.admin": "Delete telemetry or change observability settings",
	"mcp:messaging.read": "Read messages and approvals",
	"mcp:messaging.write": "Send messages and create approvals",
	"mcp:messaging.admin": "Administer messaging and approval state",
	"mcp:settings.read": "View org settings, members, and connections",
	"mcp:settings.write":
		"Update org settings, invite members, manage connections",
	"mcp:settings.admin":
		"Remove members, delete connections, change org security",
	"mcp:work.read": "Read Work Items, attempts, evidence, and factory state",
	"mcp:work.write": "Create and execute Work Items and submit evidence",
	"mcp:work.admin": "Accept, cancel, review, and complete Work Items",
} as const;

export type McpGranularCapabilityScopeName =
	keyof typeof MCP_GRANULAR_CAPABILITY_SCOPES;

// =============================================================================
// PREFIX-TO-CAPABILITY MAPPING
// =============================================================================

/**
 * Ordered prefix rules — first match wins.
 * The order matters: more specific prefixes should appear before catch-alls.
 */
const DOCS_SCOPES_BY_TOOL = new Map(Object.entries(DOCS_TOOL_SCOPES));

const EXACT_TOOL_RULES: Record<string, McpCapabilityScopeName> = {
	// The canonical approval inbox uses a plural name outside WORK_TOOL_RE.
	list_work_approvals: "mcp:work",
	// The local agent session board names its own resource, outside WORK_TOOL_RE.
	report_work_agent_session_status: "mcp:work",
	list_work_agent_sessions: "mcp:work",
	// Verb-first catalog operator tools miss the `catalog_` prefix rule. The API
	// keeps requireCatalogOperatorAccess on every catalog mutation; this gate
	// only names the capability family so the tools stop failing closed.
	list_catalog_apps: "mcp:catalog",
	get_catalog_app: "mcp:catalog",
	get_catalog_categories: "mcp:catalog",
	get_catalog_stats: "mcp:catalog",
	get_catalog_health_summary: "mcp:catalog",
	get_catalog_sync_logs: "mcp:catalog",
	get_recent_catalog_changes: "mcp:catalog",
	check_catalog_integrity: "mcp:catalog",
	trigger_catalog_sync: "mcp:catalog",
	trigger_catalog_scan: "mcp:catalog",
	trigger_catalog_enrich: "mcp:catalog",
	run_catalog_test: "mcp:catalog",
	create_catalog_app: "mcp:catalog",
	update_catalog_app: "mcp:catalog",
	update_catalog_store_listing: "mcp:catalog",
	delete_catalog_app: "mcp:catalog",
	// Installing creates an org app; the API authorizes it as an Apps create.
	install_catalog_app: "mcp:apps",
	merge_catalog_apps: "mcp:catalog",
	create_base_app_from_catalog: "mcp:catalog",
	// Verb-first skills-router tools miss the `skill_`/`skills_` prefix rules.
	// The API's skills guards stay authoritative after this capability gate.
	get_skills: "mcp:skills",
	improve_skills: "mcp:skills",
	move_skills: "mcp:skills",
	promote_skills: "mcp:skills",
	repair_skills: "mcp:skills",
	usage_skills: "mcp:skills",
	propose_workshop: "mcp:skills",
	inspect_workshop: "mcp:skills",
	revise_workshop: "mcp:skills",
	reject_workshop: "mcp:skills",
	apply_workshop: "mcp:skills",
	quarantine_workshop: "mcp:skills",
	run_tedi_turn: "mcp:messaging",
	// Agent-turn urgency triage reads and configures operator messaging.
	triage_agent_turn: "mcp:messaging",
	label_agent_reply: "mcp:messaging",
	get_agent_turn_triage_policy: "mcp:messaging",
	update_agent_turn_triage_policy: "mcp:messaging",
	// A budget rejection may ask a human to change policy; the request itself
	// never authorizes spend. The separate budget-policy mutation stays admin.
	request_budget_override: "mcp:messaging",
	list_mcp_payments_events: "mcp:observe",
	set_budget_policy: "mcp:settings",
	// First-party tedi mailbox send is exposed through the aggregate tedi
	// namespace. Keep this exact so an unrelated provider's email_* tool does
	// not inherit the tedi messaging capability by name alone.
	email_send: "mcp:messaging",
	list_sites: "mcp:content",
	create_cms_site: "mcp:content",
	begin_cms_domain: "mcp:content",
	get_cms_domain: "mcp:content",
	verify_cms_domain: "mcp:content",
	remove_cms_domain: "mcp:content",
	get_site_recovery_manifest: "mcp:content",
	start_cms_recovery_capture: "mcp:content",
	get_cms_recovery_capture: "mcp:content",
	purge_cms_recovery_capture: "mcp:content",
	start_cms_site_restore: "mcp:content",
	get_cms_site_restore: "mcp:content",
	set_site_lifecycle: "mcp:content",
	get_site_reconciliation: "mcp:content",
	run_site_reconciliation: "mcp:content",
	get_site_deprovision_plan: "mcp:content",
	get_site_deprovision_status: "mcp:content",
	deprovision_site: "mcp:content",
	repair_cms_media: "mcp:content",
	provision_theme_artifact_repo: "mcp:content",
	read_theme_artifact_file: "mcp:content",
	checkout_theme_artifact_source: "mcp:content",
	commit_theme_artifact_files: "mcp:content",
	theme_artifact_commit_status: "mcp:content",
	theme_artifact_seed_status: "mcp:content",
	theme_artifact_seed_cancel: "mcp:content",
	// A tedi's durable workspace and repository projection are part of operating
	// that digital worker. These direct MCP tools do not share the `tedi_`
	// prefix, so the aggregate Code Mode gate otherwise fails closed before the
	// credential-bound tedi runtime can enforce its narrower per-tool scopes.
	repo_load: "mcp:tedis",
	clone_repo: "mcp:tedis",
	run_git: "mcp:tedis",
	repo_commit: "mcp:tedis",
	repo_commit_drain: "mcp:tedis",
	repo_commit_status: "mcp:tedis",
	artifact_list_files: "mcp:tedis",
	artifact_read_file: "mcp:tedis",
	artifact_write_file: "mcp:tedis",
	open_computer: "mcp:tedis",
	close_computer: "mcp:tedis",
	read_execution: "mcp:tedis",
	cancel_execution: "mcp:tedis",
	exec: "mcp:tedis",
	read: "mcp:tedis",
	write: "mcp:tedis",
	edit: "mcp:tedis",
	delete: "mcp:tedis",
	ls: "mcp:tedis",
	find: "mcp:tedis",
	grep: "mcp:tedis",
	// Structured repo-wide search (replaces grep/rg/find through exec). Every
	// workstation name listed in DOMAINLESS_WORKSTATION_TOOL_NAMES needs a rule
	// here, or resolving it throws "Missing MCP capability mapping".
	code_search: "mcp:tedis",

	get_tedi: "mcp:tedis",

	// This body-neutral aggregate tedi status tool has no tedi_ prefix. Keep it
	// explicit so Code Mode discovery cannot fail closed before the tedi can
	// inspect its own execution readiness.
	get_tedi_runtime_status: "mcp:tedis",
	// Tenant Work configuration is not platform administration. API role and
	// organization checks remain authoritative after the MCP scope gate.
	put_work_resource_pool: "mcp:settings",
	list_work_resource_pools: "mcp:settings",
	put_work_budget_envelope: "mcp:settings",
	list_work_budget_envelopes: "mcp:settings",
	get_work_admission_specification: "mcp:work",
	replace_work_admission_specification: "mcp:work",
	// Tenant self-service connection management — org-scoped credential/provider
	// operations a human tenant admin should run without platform-wide authority.
	// These operations require the corresponding exact tenant-settings tier.
	// Platform authority does not substitute for tenant capability.
	create_mcp_connection_provider: "mcp:settings",
	create_connection_provider: "mcp:settings",
	initiate_connection: "mcp:settings",
	store_connection_api_key: "mcp:settings",
	install_tenant_mcp_app: "mcp:apps",
	install_tenant_mcp_apps: "mcp:apps",
	create_tenant_open_api_mcp_app: "mcp:apps",
	preview_tool_scopes: "mcp:apps",
	// Connection inventory is an apps:read API view of the caller's organization
	// or personal accounts. It never executes providers or returns credentials.
	get_connections_overview: "mcp:apps",
	list_mcp_authorizations: "mcp:apps",
	// The CLI resolves a saved workspace by listing only organizations the
	// authenticated principal belongs to. This is tenant account discovery,
	// not platform inventory, and must remain available to a scoped external
	// agent while it establishes its own gateway-bound session.
	list_all_mine: "mcp:settings",
	// Tenant owners bootstrap a least-privilege coding-harness identity by
	// issuing an org API key and binding it to an external-agent principal. Keep
	// the complete API-key lifecycle in the tenant-settings family: inventory and
	// expiry health are reads, while create/rotate/revoke/delete are security
	// administration. The API still enforces organization ownership and role
	// checks after this MCP capability gate.
	list_api_keys: "mcp:settings",
	get_expiring_keys: "mcp:settings",
	create_api_key: "mcp:settings",
	rotate_api_key: "mcp:settings",
	revoke_api_key: "mcp:settings",
	delete_api_key: "mcp:settings",
	// External-agent principal creation is governed Work administration rather
	// than platform scope.
	create_external_agent_principal: "mcp:work",
	// Removing an org-scoped tedi-to-app grant is ordinary worker capability
	// management. The API revalidates ownership of both records before revoking
	// FGA/AIH state; this generated procedure name does not begin with `tedi_`,
	// so it needs an exact family classification.
	delete_tedi_app_assignments: "mcp:tedis",
	move_prompts: "mcp:content",
	get_workflow_status: "mcp:observe",
	list_workflow_definitions: "mcp:observe",
	list_workflow_definition_health: "mcp:observe",
	list_workflow_runs: "mcp:observe",
	// Read-only operational view over the docs-curation sweep ledger, schedule,
	// and execution receipts. The D1-synced tool is intentionally verb-first and
	// therefore needs an explicit observability classification.
	get_curation_console: "mcp:observe",
	// AI-answer citation analytics (PromptWatch). A read-only marketing/AEO
	// visibility signal a CMO-class tedi must reach on its own. It is a proxied
	// connection tool with no D1 mcpConfig, so without an exact rule it falls to
	// the unclassified-tool failure — which no tedi holds — and silently locks the
	// worker out of its own analytics. mcp:observe (the analytics family, granted
	// to every tedi profile) is the correct floor; the API/connection remains
	// read-only, so there is no write exposure.
	get_grouped_citations: "mcp:observe",
	// Prompt taxonomy maintenance is a content operation. PromptWatch exposes
	// update_prompt through its official REST API (type + intent only), while
	// Peec uses the same verb for topic/tag assignment. Neither operation is
	// platform administration, so provider-backed imports must not fall through
	// to the platform:admin default before an aggregate namespace override is applied.
	update_prompt: "mcp:content",
	// Governance one-pager (flywheel P5 #3) — an audit/analytics-family READ
	// (same scope family as audit_search): the decision-rights matrix is
	// static code facts, and the live state aggregates rows already readable
	// under mcp:memory/mcp:skills/mcp:messaging. platform:admin would defeat the
	// operator-legibility purpose by hiding governance from the governed.
	get_governance_overview: "mcp:observe",
	// Business capability map — org knowledge structure (flywheel P5 #2),
	// same scope family as objective_* / memory_* institutional-memory tools.
	create_capability: "mcp:memory",
	update_capability: "mcp:memory",
	archive_capability: "mcp:memory",
	list_capabilities: "mcp:memory",
	get_capability_tree: "mcp:memory",
	get_capability_coverage: "mcp:memory",
	list_unmapped_capability_entities: "mcp:memory",
	link_capability: "mcp:memory",
	unlink_capability: "mcp:memory",
	// Work hierarchy v1 (project → epic → story container + rollup). Org work
	// structure, same institutional-memory family as the capability map and
	// objective_* tools — all eight map to mcp:memory (the granular access level
	// is then derived per-verb by toolToAccessLevel).
	create_project: "mcp:memory",
	update_project: "mcp:memory",
	archive_project: "mcp:memory",
	list_projects: "mcp:memory",
	get_project: "mcp:memory",
	get_project_rollup: "mcp:memory",
	get_work_item_tree: "mcp:memory",
	get_work_item_rollup: "mcp:memory",
	// Work-graph steward (dup/stale/naming/orphan verifier + gated repair) —
	// same org-structure institutional-memory family; the read reports and the
	// run mutates, both under mcp:memory (per-verb access derived downstream).
	get_work_graph_health: "mcp:memory",
	run_work_graph_steward: "mcp:memory",
	// Org graph health (blocked-work dependency analysis — the org "digital
	// twin", Stage 1) — read-only multi-hop planner over the same org work/
	// capability structure, so it sits in the same institutional-memory family.
	get_org_graph_health: "mcp:memory",
	// Knowledge-market telemetry (flywheel P5 #6) — org institutional-memory
	// diagnostics, same scope family as the capability map and memory_* tools.
	get_knowledge_market_report: "mcp:memory",
	// Role templates (reusable role primitive) — create/list are template CRUD
	// and apply provisions persona/objectives/tags/profile onto a tedi, so all
	// three sit in the tedi-worker-management family (mcp:tedis), matching how
	// the tedi_* update tools are scoped. Per-verb access is derived downstream
	// (list=read, create=write, apply=write via ACCESS_LEVEL_OVERRIDES).
	create_role_template: "mcp:tedis",
	list_role_templates: "mcp:tedis",
	apply_role_template: "mcp:tedis",
	apply_skill_proposal: "mcp:skills",
	approve_skill_workflow: "mcp:skills",
	audit_low_quality_skills: "mcp:skills",
	audit_skill_tool_coverage: "mcp:skills",
	cancel_skill_workflow: "mcp:skills",
	compare_skill_workflow_revisions: "mcp:skills",
	delete_skills: "mcp:skills",
	find_skills: "mcp:skills",
	get_skill: "mcp:skills",
	get_skill_run_artifact: "mcp:skills",
	get_skill_workflow_reliability: "mcp:skills",
	list_skill_workflow_schedules: "mcp:skills",
	propose_skill_workflow_improvement: "mcp:skills",
	inspect_skill_workflow_improvement: "mcp:skills",
	activate_skill_workflow_improvement: "mcp:skills",
	get_skill_workflow_revision: "mcp:skills",
	get_skill_workflow_status: "mcp:skills",
	get_skill_portfolio_balance: "mcp:skills",
	get_skills_for_mcp: "mcp:skills",
	inspect_skill_proposal: "mcp:skills",
	inspect_skill_workflow_run: "mcp:skills",
	list_promotion_candidates: "mcp:skills",
	list_skill_run_artifacts: "mcp:skills",
	list_skill_workflow_history: "mcp:skills",
	list_skill_workflow_retry_candidates: "mcp:skills",
	list_skill_workflow_revisions: "mcp:skills",
	list_skill_workflow_steps: "mcp:skills",
	list_skill_workflow_tool_calls: "mcp:skills",
	list_skills: "mcp:skills",
	list_skills_by_app: "mcp:skills",
	list_skills_by_org: "mcp:skills",
	mine_skill_candidates: "mcp:skills",
	list_muscle_memories: "mcp:skills",
	register_muscle_memory: "mcp:skills",
	crystallize_muscle_memory: "mcp:skills",
	track_muscle_usage: "mcp:skills",
	preview_skill: "mcp:skills",
	preview_skills: "mcp:skills",
	promote_skill: "mcp:skills",
	propose_skill: "mcp:skills",
	pause_skill_workflow: "mcp:skills",
	quarantine_skill_proposal: "mcp:skills",
	read_skill: "mcp:skills",
	record_skill: "mcp:skills",
	record_skills: "mcp:skills",
	reject_skill_proposal: "mcp:skills",
	reject_skill_workflow: "mcp:skills",
	repair_skill: "mcp:skills",
	revoke_skill_run: "mcp:skills",
	revise_skill_proposal: "mcp:skills",
	restart_skill_workflow: "mcp:skills",
	resume_skill_workflow: "mcp:skills",
	run_skill_workflow: "mcp:skills",
	send_skill_workflow_event: "mcp:skills",
	track_skill_usage: "mcp:skills",
	validate_skill: "mcp:skills",
	validate_skills: "mcp:skills",
};

/**
 * Workstation tool names that carry NO domain of their own.
 *
 * The tedi runtime registers these on its own MCP server unprefixed
 * (`apps/tedi-runtime/src/mcp-mount.ts`), where "read" unambiguously means
 * "read a file on this tedi's workstation" and {@link EXACT_TOOL_RULES} maps it
 * to `mcp:tedis`. Reached through an aggregate prefix the name proves nothing:
 * `third_party__read` is not this tedi's workstation. Scope resolution must
 * therefore consult these names only for an UNPREFIXED tool id and otherwise
 * fall through to the namespace, which fails closed when the namespace is
 * unknown.
 *
 * Distinctive workstation names (`open_computer`, `read_execution`,
 * `repo_commit`, `artifact_read_file`) are deliberately absent: they cannot
 * collide with another surface's tool, so they stay resolvable either way.
 */
export const DOMAINLESS_WORKSTATION_TOOL_NAMES: ReadonlySet<string> = new Set([
	"exec",
	"read",
	"write",
	"edit",
	"delete",
	"ls",
	"find",
	"grep",
	"code_search",
]);

/**
 * Aggregate-qualified exceptions checked before the namespace is stripped.
 *
 * `update_project` already names Tedix work-hierarchy maintenance and must stay
 * under mcp:memory. The private PromptWatch compatibility tools have different
 * business semantics, so only their fully qualified aggregate names are
 * content.
 */
const EXACT_AGGREGATE_TOOL_RULES: Record<string, McpCapabilityScopeName> = {
	promptwatch_project_tedix__move_prompts: "mcp:content",
	promptwatch_project_tedix__update_project: "mcp:content",
};

const PREFIX_RULES: Array<{ prefix: string; scope: McpCapabilityScopeName }> = [
	// Tedi worker management
	{ prefix: "tedi_", scope: "mcp:tedis" },
	{ prefix: "config_tedi_", scope: "mcp:tedis" },
	{ prefix: "device_", scope: "mcp:tedis" },
	{ prefix: "secret_", scope: "mcp:tedis" },
	// App / tool management
	{ prefix: "app_", scope: "mcp:apps" },
	{ prefix: "tool_", scope: "mcp:apps" },
	{ prefix: "adapter_", scope: "mcp:apps" },
	{ prefix: "domain_", scope: "mcp:apps" },
	{ prefix: "cron_", scope: "mcp:apps" },
	{ prefix: "assignment_", scope: "mcp:apps" },
	// Memory / knowledge
	{ prefix: "memory_", scope: "mcp:memory" },
	{ prefix: "objective_", scope: "mcp:memory" },
	{ prefix: "rationale_", scope: "mcp:memory" },
	{ prefix: "brain_", scope: "mcp:memory" },
	// Skills / procedural memory
	{ prefix: "skill_", scope: "mcp:skills" },
	{ prefix: "skills_", scope: "mcp:skills" },
	{ prefix: "muscle_memory_", scope: "mcp:skills" },
	// Content / blog
	{ prefix: "content_", scope: "mcp:content" },
	{ prefix: "blog_", scope: "mcp:content" },
	{ prefix: "ingest_", scope: "mcp:content" },
	{ prefix: "sync_", scope: "mcp:content" },
	// Catalog / marketplace
	{ prefix: "catalog_", scope: "mcp:catalog" },
	{ prefix: "marketplace_", scope: "mcp:catalog" },
	{ prefix: "submission_", scope: "mcp:catalog" },
	// Observability
	{ prefix: "gateway_", scope: "mcp:observe" },
	{ prefix: "audit_", scope: "mcp:observe" },
	{ prefix: "telemetry_", scope: "mcp:observe" },
	{ prefix: "storage_", scope: "mcp:observe" },
	{ prefix: "mcp_server_", scope: "mcp:observe" },
	// Messaging
	{ prefix: "message_", scope: "mcp:messaging" },
	{ prefix: "messages_", scope: "mcp:messaging" },
	{ prefix: "conversation_", scope: "mcp:messaging" },
	{ prefix: "conversations_", scope: "mcp:messaging" },
	{ prefix: "notify_", scope: "mcp:messaging" },
	{ prefix: "approval_", scope: "mcp:messaging" },
];

const WORK_TOOL_RE =
	/(?:^|_)(?:work_item|work_attempt|work_evidence|work_approval|work_resource|work_budget)(?:_|$)/;

const DANGEROUS_TOOL_NAME_RE =
	/(^|[_.:/-])(clear|delete|destroy|disable|drop|purge|remove|reset|revoke|rotate|truncate|wipe)([_.:/-]|$)/i;

const WRITE_TOOL_NAME_RE =
	/(^|[_.:/-])(add|approve|assign|complete|configure|connect|create|generate|grant|import|ingest|install|invite|message|patch|provision|publish|refresh|repair|restart|schedule|send|set|store|sync|test|trigger|update|upsert|wake|write)([_.:/-]|$)/i;

const READ_TOOL_NAME_RE =
	/(^|[_.:/-])(analyze|ask|check|fetch|find|get|health|inspect|list|load|preview|query|read|resolve|search|status|stats|summary|validate)([_.:/-]|$)/i;

const ACCESS_LEVEL_OVERRIDES: Record<string, ToolAccessLevel> = {
	request_budget_override: "write",
	set_budget_policy: "admin",
	// "triage"/"label" match neither verb regex; both are stateless model
	// reads that store nothing, so they sit at messaging.read.
	triage_agent_turn: "read",
	label_agent_reply: "read",
	// Emdash marks editorial writes destructive to request action confirmation.
	// That hint does not make drafting or publishing content administration;
	// publication still passes the owned-channel authorization gate.
	content_create: "write",
	content_update: "write",
	content_publish: "write",
	// Repairing tenant media provisions provider infrastructure. Keep it above
	// ordinary editorial writes even though the operation is idempotent.
	repair_cms_media: "admin",
	start_cms_recovery_capture: "admin",
	purge_cms_recovery_capture: "admin",
	start_cms_site_restore: "admin",
	create_cms_site: "admin",
	begin_cms_domain: "admin",
	verify_cms_domain: "admin",
	remove_cms_domain: "admin",
	// Workspace revisions are ordinary author writes. Keep this exact: unknown
	// `revise_*` tools must still fail closed at the admin tier.
	revise_os_output: "write",
	revise_os_gadget: "write",
	revise_os_blueprint: "write",
	// Requesting admission does not grant it; the designated approver decides.
	propose_work_approval: "write",
	// `status` would otherwise classify this upsert as a read.
	report_work_agent_session_status: "write",
	get_work_admission_specification: "read",
	replace_work_admission_specification: "admin",
	run_tedi_turn: "write",
	put_work_resource_pool: "admin",
	put_work_budget_envelope: "admin",
	list_work_resource_pools: "read",
	list_work_budget_envelopes: "read",
	accept_work_item: "admin",
	cancel_work_item: "admin",
	complete_work_item: "write",
	heartbeat_work_attempt: "write",
	record_external_agent_knowledge_checkpoint: "write",
	record_external_agent_knowledge_disposition: "write",
	retry_delegation: "write",
	synthesize_spoken_reply: "write",
	work_item_comment: "write",
	work_item_heartbeat: "write",
	open_computer: "write",
	close_computer: "write",
	read_execution: "read",
	cancel_execution: "write",
	exec: "write",
	read: "read",
	write: "write",
	edit: "write",
	delete: "write",
	ls: "read",
	find: "read",
	grep: "read",

	run_work_graph_steward: "write",
	settle_work_attempt: "write",
	start_work_attempt: "write",
	submit_work_evidence: "write",
	// Canonical Work Item board ids as synced by tool-schema-sync
	// (WORK_HIERARCHY_TOOL_ID_OVERRIDES: `*_work_item_*`). The tedi-gateway
	// twins above (`*_work_*`) were classified when the ids were renamed
	// (83b43544a), but the renamed canonical ids were not — so verbs whose
	// leading word matches neither the write nor the read regex (start,
	// heartbeat, settle, submit, review) fell to the admin tier, and
	// `tedix__review_work_item_evidence` demanded `mcp:messaging.admin` —
	// a scope only a platform-admin OAuth grant carries. The board contract
	// (WORK_HIERARCHY_KIND_OVERRIDES) declares all five as `write`; the API
	// procedure remains the real authorization boundary (independent-reviewer
	// enforcement for reviewEvidence lives there, not in the scope tier).
	start_work_item_attempt: "write",
	heartbeat_work_item_attempt: "write",
	settle_work_item_attempt: "write",
	submit_work_item_evidence: "write",
	review_work_item_evidence: "write",
	// "link"/"unlink" match neither the write nor read verb regexes and would
	// fall through to admin; they are ordinary org-scoped mapping writes.
	link_capability: "write",
	unlink_capability: "write",
	// "apply" matches neither the write nor read verb regexes; provisioning a
	// role onto a tedi is a mutating write (destructive-hint trips the approval
	// gate for interactive callers, but the access LEVEL is write, not admin).
	apply_role_template: "write",
	delete_tedi_app_assignments: "write",
	list_all_mine: "read",
	create_api_key: "admin",
	create_external_agent_principal: "admin",
	apply_skill_proposal: "write",
	// Plural skills-router twins keep their singular counterparts' tiers.
	improve_skills: "write",
	move_skills: "write",
	usage_skills: "read",
	propose_workshop: "write",
	revise_workshop: "write",
	reject_workshop: "write",
	apply_workshop: "write",
	quarantine_workshop: "admin",
	merge_catalog_apps: "admin",
	mine_skill_candidates: "write",
	activate_skill_workflow_improvement: "write",
	approve_skill_workflow: "write",
	cancel_skill_workflow: "write",
	pause_skill_workflow: "write",
	promote_skill: "admin",
	propose_skill: "write",
	propose_skill_workflow_improvement: "write",
	quarantine_skill_proposal: "admin",
	reject_skill_proposal: "write",
	reject_skill_workflow: "write",
	repair_skill: "write",
	revoke_skill_run: "admin",
	revise_skill_proposal: "write",
	restart_skill_workflow: "write",
	resume_skill_workflow: "write",
	run_skill_workflow: "write",
	send_skill_workflow_event: "write",
	register_muscle_memory: "write",
	crystallize_muscle_memory: "write",
	track_muscle_usage: "write",
};

const EXACT_AGGREGATE_ACCESS_LEVEL_OVERRIDES: Record<string, ToolAccessLevel> =
	{
		// Moving PromptWatch prompt records between compatible monitors preserves
		// their identities and history. Keep the private migration primitive at
		// content.write; the generic unknown-verb fallback deliberately stays admin.
		promptwatch_project_tedix__move_prompts: "write",
	};

export type ToolAccessLevel = "read" | "write" | "admin";

export interface ToolScopeHints {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

function stripAggregatePrefix(toolName: string): string {
	return toolName.includes("__")
		? toolName.split("__").slice(1).join("__")
		: toolName;
}

/**
 * Map a single tool name to its capability scope.
 *
 * Performs prefix matching using the ordered rule table. Unknown tools throw
 * until explicitly categorised; callers must fail closed without collapsing a
 * configuration error into a usable authority grant.
 *
 * @example
 * toolToCapabilityScope("tedi_list")          // "mcp:tedis"
 * toolToCapabilityScope("app_create")         // "mcp:apps"
 * toolToCapabilityScope("memory_store_fact")  // "mcp:memory"
 * toolToCapabilityScope("unknown_tool_xyz")   // throws
 */
export function toolToCapabilityScope(
	toolName: string,
): McpCapabilityScopeName {
	const aggregateExactScope = EXACT_AGGREGATE_TOOL_RULES[toolName];
	if (aggregateExactScope) return aggregateExactScope;
	const normalizedToolName = stripAggregatePrefix(toolName);
	if (DOCS_SCOPES_BY_TOOL.has(normalizedToolName)) return "mcp:content";
	const exactScope = EXACT_TOOL_RULES[normalizedToolName];
	if (exactScope) return exactScope;
	if (WORK_TOOL_RE.test(normalizedToolName)) return "mcp:work";

	for (const rule of PREFIX_RULES) {
		if (normalizedToolName.startsWith(rule.prefix)) {
			return rule.scope;
		}
	}
	throw new Error(`Missing MCP capability mapping for tool: ${toolName}`);
}

export function toolToAccessLevel(
	toolName: string,
	hints?: ToolScopeHints | null,
): ToolAccessLevel {
	const aggregateExactOverride =
		EXACT_AGGREGATE_ACCESS_LEVEL_OVERRIDES[toolName];
	if (aggregateExactOverride) return aggregateExactOverride;
	const normalizedToolName = stripAggregatePrefix(toolName);
	const accessLevelOverride = ACCESS_LEVEL_OVERRIDES[normalizedToolName];
	if (accessLevelOverride) return accessLevelOverride;
	if (hints?.destructiveHint === true) return "admin";
	const docsScope = DOCS_SCOPES_BY_TOOL.get(normalizedToolName);
	if (docsScope) {
		if (docsScope === "mcp:content.admin") return "admin";
		return docsScope === "mcp:content.write" ? "write" : "read";
	}
	if (DANGEROUS_TOOL_NAME_RE.test(normalizedToolName)) return "admin";
	if (hints?.readOnlyHint === true) return "read";
	if (hints?.readOnlyHint === false) return "write";
	if (WRITE_TOOL_NAME_RE.test(normalizedToolName)) return "write";
	if (READ_TOOL_NAME_RE.test(normalizedToolName)) return "read";
	return "admin";
}

/**
 * True when a tool is EXPLICITLY marked admin-tier in `ACCESS_LEVEL_OVERRIDES`
 * (`promote_skill`, `quarantine_skill_proposal`, `revoke_skill_run`) — the
 * deliberate governance operations, NOT the heuristic "unknown verb → admin"
 * fallback that `toolToAccessLevel` also returns "admin" for.
 *
 * The MCP edge uses this to lift these tools above their broad capability scope
 * in the coarse (`enforcePolicies: false`) path. There a per-tool
 * `<namespace>.admin` scope cannot gate anything: `hasScope` treats the broad
 * parent scope (e.g. `mcp:skills`, which every tedi profile holds) as
 * satisfying its `.admin` child, so an admin-marked tool that resolves to its
 * broad capability is reachable by every worker. Callers pair this with a scope
 * only admin/operator profiles hold (`mcp:settings`) to realise the intended
 * admin tier.
 */
export function isAdminAccessLevelOverrideTool(toolName: string): boolean {
	const normalizedToolName = stripAggregatePrefix(toolName);
	return ACCESS_LEVEL_OVERRIDES[normalizedToolName] === "admin";
}

export function toolToGranularCapabilityScope(
	toolName: string,
	hints?: ToolScopeHints | null,
): McpGranularCapabilityScopeName {
	const broadScope = toolToCapabilityScope(toolName);
	const accessLevel = toolToAccessLevel(toolName, hints);
	return `${broadScope}.${accessLevel}` as McpGranularCapabilityScopeName;
}

/**
 * Generate the D1-ready `toolScopes` mapping for a list of tool names.
 *
 * Returns `Record<toolName, [capabilityScope]>` — the format expected by
 * `apps.metadata.mcpConfig.toolScopes`. Each tool maps to a single-element
 * array so the edge layer's `extractRequiredScopes()` can do an O(1) lookup.
 *
 * @example
 * generateToolScopes(["tedi_list", "app_create", "unknown_xyz"])
 * // {
 * //   "tedi_list":    ["mcp:tedis"],
 * //   "app_create":   ["mcp:apps"],
 * //   "unknown_xyz":  ["platform:admin"],
 * // }
 */
export function generateToolScopes(
	toolNames: string[],
): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const name of toolNames) {
		result[name] = [toolToCapabilityScope(name)];
	}
	return result;
}

export function generateGranularToolScopes(
	tools: Array<{ toolId: string; annotations?: ToolScopeHints | null }>,
): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const tool of tools) {
		result[tool.toolId] = [
			toolToGranularCapabilityScope(tool.toolId, tool.annotations),
		];
	}
	return result;
}

/**
 * Group tool names by their assigned capability scope.
 *
 * Useful for reviewing the mapping before writing it to D1 — the preview
 * endpoint returns this grouped view so operators can verify categorisation.
 *
 * @example
 * groupToolsByCapabilityScope(["tedi_list", "app_create"])
 * // {
 * //   "mcp:tedis": ["tedi_list"],
 * //   "mcp:apps":  ["app_create"],
 * // }
 */
export function groupToolsByCapabilityScope(
	toolNames: string[],
): Partial<Record<McpCapabilityScopeName, string[]>> {
	const groups: Partial<Record<McpCapabilityScopeName, string[]>> = {};
	for (const name of toolNames) {
		const scope = toolToCapabilityScope(name);
		if (!groups[scope]) {
			groups[scope] = [];
		}
		groups[scope].push(name);
	}
	return groups;
}

export function groupToolsByGranularCapabilityScope(
	tools: Array<{ toolId: string; annotations?: ToolScopeHints | null }>,
): Partial<Record<McpGranularCapabilityScopeName, string[]>> {
	const groups: Partial<Record<McpGranularCapabilityScopeName, string[]>> = {};
	for (const tool of tools) {
		const scope = toolToGranularCapabilityScope(tool.toolId, tool.annotations);
		if (!groups[scope]) {
			groups[scope] = [];
		}
		groups[scope].push(tool.toolId);
	}
	return groups;
}
