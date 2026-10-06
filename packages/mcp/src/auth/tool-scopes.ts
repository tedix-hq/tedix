import {
	DOMAINLESS_WORKSTATION_TOOL_NAMES,
	isAdminAccessLevelOverrideTool,
	toolToAccessLevel,
	toolToCapabilityScope,
} from "@tedix/api-contract/schemas/mcp-capability-scopes";
import { REVIEWED_RPC_ENDPOINT_SCOPES } from "./reviewed-rpc-endpoint-scopes";
import { hasScope, toolToScope } from "./scopes";
import type {
	ToolAnnotations,
	ToolWriteCapability,
} from "@tedix/api-contract/schemas/tools";

const CAPABILITY_FAMILY_SCOPE_RE =
	/^mcp:(tedis|apps|memory|skills|content|catalog|observe|messaging|settings|work)$/;

const RESOURCE_BOUND_DURABLE_CODE_TOOLS: Record<
	string,
	{ endpoint: string; scope: string }
> = {
	recover_tedi_code_execution: {
		endpoint: "tedis/recoverTediCodeExecution",
		scope: "mcp:tedis.admin",
	},
	run_tedi_durable_code: {
		endpoint: "tedis/runTediDurableCode",
		scope: "mcp:tedis.write",
	},
	list_tedi_code_executions: {
		endpoint: "tedis/listTediCodeExecutions",
		scope: "mcp:tedis.read",
	},
	get_tedi_code_execution: {
		endpoint: "tedis/getTediCodeExecution",
		scope: "mcp:tedis.read",
	},
	approve_tedi_code_execution: {
		endpoint: "tedis/approveTediCodeExecution",
		scope: "mcp:tedis.admin",
	},
	reject_tedi_code_execution: {
		endpoint: "tedis/rejectTediCodeExecution",
		scope: "mcp:tedis.admin",
	},
	rollback_tedi_code_execution: {
		endpoint: "tedis/rollbackTediCodeExecution",
		scope: "mcp:tedis.admin",
	},
};

// The Code Mode namespace for every mcp* router is `mcp`, so a namespace
// fallback would grant one domain's authority to unrelated credentials,
// payments, governance, or network-security procedures. These exact oRPC
// endpoints are the retained tenant/operator tools; internal credential and
// service-only procedures are excluded from the admin MCP projection instead.
const RPC_ENDPOINT_CAPABILITY_SCOPES: Record<string, string> = {
	// Reviewed platform-only endpoints (service-binding-only, platform guards,
	// credential minting) tighten every namespace. Their tenant-tier siblings
	// apply only as the last fallback in resolveNamespaceFallbackScope.
	...Object.fromEntries(
		Object.entries(REVIEWED_RPC_ENDPOINT_SCOPES).filter(
			([, scope]) => scope === "platform:admin",
		),
	),
	// Organization aliases hide the ordinary `apps` namespace. Retain the
	// tenant Apps read boundary for this exact RPC without granting an alias
	// authority over unknown tools or unrelated provider inventories.
	"apps/list": "mcp:apps.read",
	// Connect uses an organization aggregate alias instead of the underlying
	// `kernel` or `os` namespace. Preserve the API's capability at these exact
	// endpoints; an arbitrary aggregate name must never borrow a family grant.
	"kernelRuntime/enqueueMessage": "mcp:tedis.write",
	"kernelRuntime/readRun": "mcp:tedis.read",
	"kernelRuntime/readRunEvents": "mcp:tedis.read",
	"kernelRuntime/readMessages": "mcp:tedis.read",
	"kernelRuntime/readToolResult": "mcp:tedis.read",
	"kernelRuntime/listConversations": "mcp:tedis.read",
	"kernelRuntime/readRunTrace": "mcp:tedis.read",
	"kernelRuntime/readChildRunEvidence": "mcp:tedis.read",
	"kernelRuntime/readChildRunTree": "mcp:tedis.read",
	"harness/listKernelTraceBundles": "mcp:tedis.read",
	// Exact share review RPCs retain their API permission boundary under tenant aliases.
	"osShares/reviews/create": "mcp:apps.write",
	"osShares/reviews/get": "mcp:apps.read",
	"osShares/reviews/listFeedback": "mcp:apps.write",
	"osShares/reviews/saveFeedback": "mcp:apps.write",

	"osWorkspaces/workspaces/list": "mcp:apps.read",
	"osWorkspaces/workspaces/get": "mcp:apps.read",
	"osWorkspaces/outputs/list": "mcp:apps.read",
	"osWorkspaces/outputs/get": "mcp:apps.read",
	"osWorkspaces/outputs/create": "mcp:apps.write",
	"osWorkspaces/outputs/revise": "mcp:apps.write",
	"osWorkspaces/outputs/patchDocument": "mcp:apps.write",
	"osWorkspaces/outputs/setSheetRange": "mcp:apps.write",
	"osWorkspaces/outputs/patchSlides": "mcp:apps.write",
	// Interaction RPCs retain the API's messaging authority through organization
	// aliases. Their Work-prefixed names do not change the owning capability.
	"workInteractions/create": "mcp:messaging.write",
	"workInteractions/respond": "mcp:messaging.write",
	"workInteractions/delegate": "mcp:messaging.write",
	"workInteractions/cancel": "mcp:messaging.write",
	"workInteractions/get": "mcp:messaging.read",
	"workInteractions/listInbox": "mcp:messaging.read",
	"workInteractions/listOutbox": "mcp:messaging.read",
	"workInteractions/listAudit": "mcp:messaging.read",
	// Agent-turn triage keeps the API's messaging authority through aliases.
	"agentTurnTriage/triage": "mcp:messaging.read",
	"agentTurnTriage/labelReply": "mcp:messaging.read",
	"agentTurnTriage/getPolicy": "mcp:messaging.read",
	"agentTurnTriage/updatePolicy": "mcp:messaging.write",
	// The local agent session board is the caller's own Work status. Keep the
	// Work authority when an organization alias hides the `work` namespace.
	"workAgentSessions/report": "mcp:work.write",
	"workAgentSessions/list": "mcp:work.read",
	"mcpHealth/run": "mcp:observe.write",
	"mcpEval/run": "platform:admin",
	// Recovery for a wedged or quarantined Agent-runtime tedi. The API also
	// requires platform authority; the exact endpoint keeps aliases from
	// borrowing any broader tedi grant.
	"tedis/rebind": "platform:admin",
	// Read-only cutover inventory; temporary, removed with the cutover tooling.
	"tedis/inspectRuntimeCutover": "platform:admin",
	// Contract projection can change the fleet tool catalog, including internal
	// procedures. Keep its operator route platform-only through org aliases.
	"toolSchemaSync/preview": "platform:admin",
	"toolSchemaSync/check": "platform:admin",
	"toolSchemaSync/run": "platform:admin",
	// The API's billing guards cannot substitute for the MCP edge gate when
	// invoked through its service binding. Mutating account/policy authority
	// therefore remains platform-only until a dedicated payment grant exists.
	"mcpPayments/disablePolicy": "platform:admin",
	"mcpPayments/getEffectivePolicy": "mcp:settings.read",
	"mcpPayments/getReceipt": "mcp:settings.read",
	"mcpPayments/listAccounts": "mcp:settings.read",
	"mcpPayments/listPolicies": "mcp:settings.read",
	"mcpPayments/listReservations": "mcp:settings.read",
	"mcpPayments/registerAccount": "platform:admin",
	"mcpPayments/spendSummary": "mcp:settings.read",
	"mcpServer/adoptResource": "platform:admin",
	"mcpServer/getStatus": "mcp:apps.read",
	"mcpServer/register": "mcp:apps.write",
	"mcpNetworkSecurity/getConfig": "mcp:settings.read",
	"mcpNetworkSecurity/configure": "mcp:settings.admin",
	"mcpNetworkSecurity/reconcile": "mcp:settings.write",
	"mcpNetworkSecurity/applyPortalOnlyPolicy": "mcp:settings.admin",
};

// These handlers require the exact gateway-verified organization, principal,
// session, and client. Closing one's own session is Work lifecycle authority;
// destructive metadata still describes credential teardown, not org governance.
const EXTERNAL_AGENT_SELF_LIFECYCLE_RPC_TOOLS: Record<string, string> = {
	"externalAgentIdentity/endSession": "end_external_agent_session",
	"externalAgentIdentity/recordKnowledgeCheckpoint":
		"record_external_agent_knowledge_checkpoint",
	"externalAgentIdentity/recordKnowledgeDisposition":
		"record_external_agent_knowledge_disposition",
};

// The live Home adapter presents these exact aliases on its messaging surface.
// Keep that existing grant while raw kernel RPC tools retain tedis authority.
const HOME_RPC_ALIASES: Record<string, string> = {
	"kernelRuntime/enqueueMessage": "ask",
	"kernelRuntime/readRun": "read_home_run",
	"kernelRuntime/readRunEvents": "read_home_run_events",
	"kernelRuntime/readMessages": "read_home_messages",
	"kernelRuntime/listConversations": "list_conversations",
	"kernelRuntime/readRunTrace": "read_home_trace",
	"kernelRuntime/readChildRunEvidence": "read_child_run_evidence",
	"kernelRuntime/readChildRunTree": "read_child_run_tree",
};

function resolveCapabilityFamilyScope(
	scope: string,
	tool: Pick<ToolAuthShape, "annotations" | "toolId" | "writeCapability">,
): string {
	const declaredDestructive =
		tool.writeCapability === "destructive" ||
		tool.annotations?.destructiveHint === true;
	const declaredWrite =
		tool.writeCapability === "write" ||
		tool.annotations?.readOnlyHint === false;
	const accessLevel = toolToAccessLevel(tool.toolId, {
		...tool.annotations,
		destructiveHint: declaredDestructive,
	});
	const minimumTier =
		(declaredWrite || declaredDestructive) && accessLevel === "read"
			? "write"
			: accessLevel;
	if (!CAPABILITY_FAMILY_SCOPE_RE.test(scope)) {
		if (!declaredWrite && !declaredDestructive) return scope;
		const tieredScope = /^(.*)\.(read|write|admin)$/.exec(scope);
		const family = tieredScope?.[1];
		if (!family || !CAPABILITY_FAMILY_SCOPE_RE.test(family)) {
			return scope;
		}
		const tier = tieredScope[2];
		if (minimumTier === "admin" && tier !== "admin") {
			return `${family}.admin`;
		}
		if (minimumTier === "write" && tier === "read") {
			return `${family}.write`;
		}
		return scope;
	}
	return `${scope}.${minimumTier}`;
}

const NAMESPACE_SCOPE_FALLBACKS: Record<string, string> = {
	app: "mcp:apps",
	app_config: "mcp:apps",
	apps: "mcp:apps",
	assignment: "mcp:apps",
	assignments: "mcp:apps",
	adapter: "mcp:apps",
	adapters: "mcp:apps",
	cron: "mcp:apps",
	domain: "mcp:apps",
	domains: "mcp:apps",
	tool: "mcp:apps",
	tools: "mcp:apps",
	// Tenant app/product surfaces. Their API handlers use apps read/write (or a
	// narrower content/skills capability) and retain tenant ownership checks.
	aeo: "mcp:apps",
	directory: "mcp:apps",
	feature: "mcp:apps",
	generated: "mcp:apps",
	items: "mcp:apps",
	listings: "mcp:apps",
	model: "mcp:apps",
	plugins: "mcp:apps",
	seo: "mcp:apps",
	snapshots: "mcp:apps",
	widget: "mcp:apps",
	// The Tedix OS domain (workspaces/gadgets/outputs/blueprints/shares/
	// approval rules) is tenant product surface: every handler is org-fenced
	// two-plane (Descope settings:manage + apps:* machine scopes), so the true
	// capability is mcp:apps — the admin catch-all would demand PLATFORM-wide
	// admin for strictly own-org actions and broke bearer callers the moment
	// the aggregate cache rebuilt with real scope metadata.
	os: "mcp:apps",
	// Runtime entitlement is a read-only view of the caller org's own plan.
	runtime: "mcp:observe",
	// Descope AIH management mutates the platform identity control plane. It is
	// intentionally outside every tenant capability family and requires explicit
	// platform authority rather than being left as an unclassified tool.
	descope: "platform:admin",

	brain: "mcp:memory",
	cognitive: "mcp:memory",
	growth: "mcp:memory",
	knowledge: "mcp:memory",
	mission: "mcp:memory",
	projects: "mcp:memory",
	memory: "mcp:memory",
	objective: "mcp:memory",
	objectives: "mcp:memory",
	rationale: "mcp:memory",
	muscle: "mcp:skills",
	skill: "mcp:skills",
	skills: "mcp:skills",

	blog: "mcp:content",
	browser: "mcp:content",
	cms: "mcp:content",
	content: "mcp:content",
	docs: "mcp:content",
	ingest: "mcp:content",
	sync: "mcp:content",

	catalog: "mcp:catalog",
	marketplace: "mcp:catalog",
	submission: "mcp:catalog",
	submissions: "mcp:catalog",

	analytics: "mcp:observe",
	audit: "mcp:observe",
	gateway: "mcp:observe",
	observe: "mcp:observe",
	observability: "mcp:observe",
	storage: "mcp:observe",
	telemetry: "mcp:observe",
	workflow: "mcp:observe",
	workflows: "mcp:observe",
	external: "mcp:observe",
	// Runtime quality/learning reads are tedi-governed operational surfaces.
	flywheel: "mcp:tedis",
	harness: "mcp:tedis",
	kernel: "mcp:tedis",
	learning: "mcp:tedis",
	work: "mcp:work",
	work_item: "mcp:work",
	work_items: "mcp:work",

	approval: "mcp:messaging",
	approvals: "mcp:messaging",
	home: "mcp:messaging",
	message: "mcp:messaging",
	messaging: "mcp:messaging",
	notify: "mcp:messaging",

	tedi: "mcp:tedis",
	tedis: "mcp:tedis",

	// Own-org governance surface (members, connections, org settings). Code Mode
	// derives the namespace from the endpoint router root (`members/list` →
	// `members`, `connections/list` → `connections`, `orgUsage/*` → `org`), so a
	// governance READ that names no exact rule (`list_members`, `list_connections`,
	// `get_org_usage`) otherwise reaches the unclassified-tool error in
	// `toolToCapabilityScope` — demanding PLATFORM-wide admin for a strictly
	// own-org action. Map these to `mcp:settings` (org self-governance), which the
	// `org_admin` operator profile grants and `standard` tedis do not. Destructive
	// members/connections tools (`remove_*`, `delete_*`, `disconnect_*`) trip the
	// name/`destructiveHint` fallback FIRST, so this only loosens the safe reads
	// and non-destructive writes; the individually destructive member ops keep
	// their explicit `TENANT_OPERATOR` overrides above. The mixed
	// `organizations`/`tenantMembership` routers are deliberately NOT mapped here:
	// they carry platform-admin cross-org procedures (syncFromDescope,
	// cancel/delete org) that must stay `platform:admin`.
	member: "mcp:settings",
	members: "mcp:settings",
	connection: "mcp:settings",
	connections: "mcp:settings",
	org: "mcp:settings",
	setting: "mcp:settings",
	settings: "mcp:settings",
	organization: "mcp:settings",
	secrets: "mcp:settings",
	user: "mcp:settings",
	team: "mcp:settings",
	teams: "mcp:settings",

	// Mixed fleet, cross-organization, billing, and security-sensitive routers
	// contain procedures whose API guard is platform-only. A broad tenant
	// fallback would over-grant their siblings, so keep the whole unresolved
	// namespace on explicit platform authority until each procedure is split.
	billing: "platform:admin",
	control: "platform:admin",
	earned: "platform:admin",
	graph: "platform:admin",
	images: "platform:admin",
	organizations: "platform:admin",
	templates: "platform:admin",
	tenant: "platform:admin",
	waitlist: "platform:admin",

	// Video jobs run governed skill workflows guarded by the API's
	// mcp:skills plane.
	video: "mcp:skills",
};

const DANGEROUS_TOOL_NAME_RE =
	/(^|[_.:/-])(clear|delete|destroy|disable|drop|purge|remove|reset|revoke|rotate|truncate|wipe)([_.:/-]|$)/i;

// Narrow tenant-operator exceptions to the name-based dangerous-tool fallback.
// The API procedure remains the authorization boundary: rotateAccessKey requires
// tedis:update + apps:write and verifies that the caller owns the target tedi.
// This override only lets tenant admins discover/call that guarded procedure
// with their normal mcp:tedis grant instead of requiring platform-wide admin.
const TENANT_OPERATOR_TOOL_SCOPE_OVERRIDES: Record<string, string> = {
	// The overview only reads the authenticated organization's billing state.
	// Its API guard enforces billing:read on both user and machine principals.
	get_billing_overview: "mcp:settings",
	// Provider sponsorship is own-org billing configuration. The API handlers
	// require billing RBAC, scope the installation lookup to the caller's provider
	// organization, and never accept a customer organization id. Keep these two
	// procedures off the mixed billing namespace's platform-admin fallback.
	list_provider_capacity_sponsorships: "mcp:settings",
	set_provider_capacity_sponsorship: "mcp:settings",
	// Resource and budget configuration retain owner/admin API checks and
	// destructive annotations, but only govern the caller's organization.
	put_work_resource_pool: "mcp:settings",
	put_work_budget_envelope: "mcp:settings",
	// Name-only knowledge classification retains observe authority. The exact
	// self-lifecycle RPC bindings above use Work write; stale-session inventory
	// remains an observability read.
	record_external_agent_knowledge_checkpoint: "mcp:observe",
	record_external_agent_knowledge_disposition: "mcp:observe",
	list_stale_external_agent_knowledge_sessions: "mcp:observe",
	// Administrative retirement/revocation remain org governance. The end-session
	// name alone is also admin-tier; only its canonical RPC binding above proves
	// the self-service handler. Names and arbitrary namespaces cannot borrow it.
	end_external_agent_session: "mcp:settings",
	retire_abandoned_external_agent_session: "mcp:settings",
	revoke_external_agent_mcp_credential: "mcp:settings",
	rotate_access_key: "mcp:tedis",
	// The aggregate tedi `cron` bridge carries destructiveHint because remove/run
	// need governance, but it only manages the caller's own tedi scheduler. Keep
	// its scope aligned with the cron/apps capability taxonomy instead of letting
	// the annotation escalate every action (including list) to platform admin.
	cron: "mcp:apps",
	// Own-org app lifecycle. These are the tenant OPERATOR's governance surface:
	// install/remove the org's own MCP apps, provision/configure/delete apps in
	// the org's own gateway. Without an override they hit the unclassified-tool error
	// in `toolToCapabilityScope` (they match no prefix rule) — or, for `delete_app`,
	// the destructive-name fallback below — which demands PLATFORM-WIDE admin for a
	// strictly own-org action. Map them to `mcp:settings` (org self-governance),
	// which the `org_admin` profile grants and `standard` does not, so only a
	// tenant's designated operator gets them, never every task tedi. The API
	// procedure is still the real boundary: each handler confines the write to the
	// caller's own org (cross-org needs `isPlatformPrincipal`, which `org_admin`
	// lacks). This override, checked BEFORE the dangerous-name and admin fallbacks,
	// is the one place that reliably covers destructive names like `delete_app`.
	install_tenant_mcp_app: "mcp:settings",
	install_tenant_mcp_apps: "mcp:settings",
	uninstall_tenant_mcp_app: "mcp:settings",
	create_tenant_openapi_mcp_app: "mcp:settings",
	provision_app: "mcp:settings",
	create_app: "mcp:settings",
	update_app: "mcp:settings",
	delete_app: "mcp:settings",
	reconcile_app: "mcp:settings",
	// Own-org member governance. Same rationale as the app tools: managing your
	// own org's team is a tenant OPERATOR action, not platform admin. The API
	// handlers enforce own-org (requireOrganizationAccess) and cap authority
	// (an org_admin caller cannot outrank itself, cannot remove the last owner).
	// remove_member/update_member_role trip the destructive-name fallback, so they
	// need the override (checked first) to reach mcp:settings.
	invite_member: "mcp:settings",
	remove_member: "mcp:settings",
	update_member_role: "mcp:settings",
};

// Self-service skill-workflow lifecycle. These are how a tedi RUNS and manages
// its OWN org's skill workflows — `run_skill_workflow` is the one a tedi cron
// fires to execute a skill. Their real capability is `mcp:skills` (which every
// tedi profile grants, and `EXACT_TOOL_RULES` already maps them to), NOT
// platform admin — but each carries `destructiveHint: true`, so without this
// override the `isDangerousTool(tool) → ADMIN_SCOPE` fallback below demands
// `platform:admin` for what is a routine own-skill operation. A tedi is correctly not
// a platform admin, so its own weekly/scheduled skill-run crons were failing
// (e.g. weekly-winners + judge-calibration crons). Mirrors TENANT_OPERATOR
// above: gate the destructive action at its true (org-scoped) capability,
// never platform-wide admin. destructiveHint is
// preserved for the confirm/approval UX — this only changes the required SCOPE.
// The run handler remains the real boundary: a skill run is confined to the
// caller's own org's skills. Do NOT list `promote_skill`/`quarantine_skill_*`
// here — those ARE intended to be admin-tier (see ACCESS_LEVEL_OVERRIDES).
const SKILL_SELF_SERVICE_TOOL_SCOPE_OVERRIDES: Record<string, string> = {
	run_skill_workflow: "mcp:skills",
	cancel_skill_workflow: "mcp:skills",
	restart_skill_workflow: "mcp:skills",
	list_skill_workflow_retry_candidates: "mcp:skills",
	resume_skill_workflow: "mcp:skills",
	pause_skill_workflow: "mcp:skills",
	send_skill_workflow_event: "mcp:skills",
	approve_skill_workflow: "mcp:skills",
	reject_skill_workflow: "mcp:skills",
};

const TEDI_MESSAGING_TOOL_PREFIXES = [
	"message_",
	"messages_",
	"conversation_",
	"conversations_",
] as const;
const TEDI_MESSAGING_TOOL_NAMES = new Set(["synthesize_spoken_reply"]);

// Work Items are the collaboration surface between a role tedi and its parent
// Home run. Aggregate tedi tools use a role namespace (for example `cmo`) that
// intentionally has no broad fallback, so map these exact operations to the
// existing org messaging capability. The destructive bulk cancel remains
// admin-tier because `isDangerousTool()` is checked before this override.
const TEDI_WORK_ITEM_TOOL_NAME_RE = /(^|_)work_items?(_|$)/;

// The regex above recognises names containing `work_item`, but canonical
// attempt/evidence/event verbs deliberately name their own resource. Keep those
// exact operations on the same collaboration capability instead of letting
// them fall through to the unclassified-tool error that tenant clients cannot
// obtain (e.g. `tedix__list_inbox` demanding `platform:admin` while
// `tedix__list_work_items` succeeded for the same caller).
//
// These are listed by exact name rather than widening the regex: the board verbs
// have no shared token, and a looser pattern would sweep in unrelated tools.
const TEDI_WORK_BOARD_TOOL_NAMES = new Set([
	"complete_work_item",
	"heartbeat_work_attempt",
	"list_work_attempts",
	"list_work_events",
	"list_work_evidence",
	"run_work_graph_steward",
	"settle_work_attempt",
	"start_work_attempt",
	"submit_work_evidence",
]);

// Board observability reads, kept on the analytics capability rather than the
// collaboration one, following the `list_workflow_*` precedent above.
const TEDI_WORK_BOARD_OBSERVE_TOOL_NAMES = new Set([
	"get_work_graph_health",
	"get_org_graph_health",
	"list_activity",
]);

export type ToolAuthShape = {
	annotations?: ToolAnnotations | null;
	config?: Record<string, unknown> | null;
	/**
	 * The DECLARED capability. Read alongside `annotations`, never instead of
	 * it, because the row shape this exists for carries a declaration and NO
	 * annotations at all — that is the whole point of declared capability for
	 * upstream servers that send none.
	 */
	writeCapability?: ToolWriteCapability | null;
	authRequired?: boolean;
	toolId: string;
	toolTypeId?: string | null;
	visibility?: string | null;
};

export type ToolNamespaceShape = Pick<ToolAuthShape, "config" | "toolId"> & {
	toolTypeId?: string | null;
};

function extractCamelCaseRoot(prefix: string): string {
	const match = prefix.match(/^[a-z]+/);
	return match ? match[0] : prefix.toLowerCase();
}

/**
 * Resolve the Code Mode/native authorization namespace from persisted tool
 * metadata. This is shared by discovery, dispatch, scope preview, and Descope
 * manifests so an RPC endpoint such as `appTools/list` never falls back to the
 * tool verb (`list`) on one surface while Code Mode classifies it as
 * `app_config` on another.
 */
export function resolveMcpToolNamespace(
	tool: ToolNamespaceShape,
	namespaceOverrides?: Record<string, string>,
): string {
	const config = tool.config;
	const aggregateNamespace =
		typeof config?._aggregateNamespace === "string"
			? config._aggregateNamespace
			: undefined;
	if (aggregateNamespace) {
		const sanitized = aggregateNamespace.replace(/[^a-zA-Z0-9_]/g, "_");
		return namespaceOverrides?.[sanitized] ?? sanitized;
	}

	const endpoint =
		typeof config?.endpoint === "string" ? config.endpoint : undefined;
	const endpointPrefix = endpoint?.split("/")[0];
	if (endpointPrefix) {
		const root = extractCamelCaseRoot(endpointPrefix);
		return (
			namespaceOverrides?.[endpointPrefix] ?? namespaceOverrides?.[root] ?? root
		);
	}

	const toolIdPrefix = tool.toolId.includes("__")
		? tool.toolId.split("__")[0]
		: undefined;
	if (toolIdPrefix) {
		const sanitized = toolIdPrefix.replace(/[^a-zA-Z0-9_]/g, "_");
		return namespaceOverrides?.[toolIdPrefix] ?? sanitized;
	}

	if (tool.toolTypeId && tool.toolTypeId !== "rpc") return tool.toolTypeId;
	return "tools";
}

function connectedProviderId(tool: ToolAuthShape): string | null {
	const config = tool.config;
	if (!config || typeof config !== "object") return null;
	const auth = config.auth;
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
	const authConfig = auth as Record<string, unknown>;
	if (authConfig.type !== "connection") return null;
	const connectionId =
		typeof authConfig.connectionId === "string"
			? authConfig.connectionId.trim()
			: "";
	if (!connectionId) return null;

	const stampedProvider = config._aggregateConnectionProviderId;
	if (
		stampedProvider !== undefined &&
		(typeof stampedProvider !== "string" ||
			stampedProvider.trim() !== connectionId)
	) {
		return null;
	}
	return connectionId;
}

function isConnectedTool(tool: ToolAuthShape): boolean {
	return connectedProviderId(tool) !== null;
}

function isSafeNotionPageUpdateCall(args: unknown): boolean {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	const call = args as Record<string, unknown>;
	if (typeof call.page_id !== "string" || !call.page_id.trim()) return false;
	if (call.allow_async !== undefined && typeof call.allow_async !== "boolean")
		return false;
	if (
		call.confirmDestructive !== undefined &&
		typeof call.confirmDestructive !== "boolean"
	)
		return false;
	if (call.reason !== undefined && typeof call.reason !== "string")
		return false;

	let allowed: ReadonlySet<string>;
	switch (call.command) {
		case "update_properties":
			if (
				!call.properties ||
				typeof call.properties !== "object" ||
				Array.isArray(call.properties)
			)
				return false;
			allowed = new Set(["properties"]);
			break;
		case "insert_content":
			if (typeof call.content !== "string") return false;
			if (call.position !== undefined) {
				if (
					!call.position ||
					typeof call.position !== "object" ||
					Array.isArray(call.position)
				)
					return false;
				const position = call.position as Record<string, unknown>;
				if (
					(position.type !== "start" && position.type !== "end") ||
					Object.keys(position).some((key) => key !== "type")
				)
					return false;
			}
			allowed = new Set(["content", "position"]);
			break;
		case "update_content":
			if (
				!Array.isArray(call.content_updates) ||
				call.content_updates.length === 0 ||
				call.content_updates.some((update) => {
					if (!update || typeof update !== "object" || Array.isArray(update))
						return true;
					const entry = update as Record<string, unknown>;
					return (
						typeof entry.old_str !== "string" ||
						!entry.old_str ||
						typeof entry.new_str !== "string" ||
						(entry.replace_all_matches !== undefined &&
							typeof entry.replace_all_matches !== "boolean") ||
						Object.keys(entry).some(
							(key) =>
								key !== "old_str" &&
								key !== "new_str" &&
								key !== "replace_all_matches",
						)
					);
				}) ||
				(call.allow_deleting_content !== undefined &&
					call.allow_deleting_content !== false)
			)
				return false;
			allowed = new Set(["content_updates", "allow_deleting_content"]);
			break;
		default:
			return false;
	}
	const common = new Set([
		"page_id",
		"command",
		"allow_async",
		"confirmDestructive",
		"reason",
	]);
	return Object.keys(call).every((key) => common.has(key) || allowed.has(key));
}

function sanitizeToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function isDangerousTool(
	tool: Pick<ToolAuthShape, "annotations" | "toolId" | "writeCapability">,
) {
	// A declared-destructive tool with no upstream annotations reached here as
	// "not dangerous" and fell through to the NAME regex — the same camelCase
	// blind spot the declared column exists to close. The scope tier a tool
	// requires must follow its declaration, not its spelling.
	if (tool.writeCapability === "destructive") return true;
	if (tool.annotations?.destructiveHint === true) return true;
	return DANGEROUS_TOOL_NAME_RE.test(tool.toolId);
}

function normalizeNamespaceForScope(namespace: string): string {
	return namespace.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
}

function hasNamespaceFallbackScope(namespace: string): boolean {
	return (
		NAMESPACE_SCOPE_FALLBACKS[normalizeNamespaceForScope(namespace)] != null
	);
}

function resolveKnownToolCapabilityScope(toolName: string): string | null {
	try {
		return toolToCapabilityScope(toolName);
	} catch {
		return null;
	}
}

function resolveNamespaceFallbackScope(
	tool: ToolAuthShape,
	namespace: string,
	mcpConfig?: Record<string, unknown>,
): string {
	const rpcEndpoint =
		tool.toolTypeId === "rpc" && typeof tool.config?.endpoint === "string"
			? tool.config.endpoint
			: null;
	if (
		rpcEndpoint &&
		EXTERNAL_AGENT_SELF_LIFECYCLE_RPC_TOOLS[rpcEndpoint] ===
			rawToolName(tool.toolId)
	) {
		return "mcp:work.write";
	}
	let endpointScope = rpcEndpoint
		? RPC_ENDPOINT_CAPABILITY_SCOPES[rpcEndpoint]
		: null;
	if (
		rpcEndpoint &&
		namespace === "home" &&
		HOME_RPC_ALIASES[rpcEndpoint] === rawToolName(tool.toolId)
	) {
		endpointScope =
			rpcEndpoint === "kernelRuntime/enqueueMessage"
				? "mcp:messaging.write"
				: "mcp:messaging.read";
	}
	if (endpointScope) {
		// Exact RPC policy is a floor even when a name override classifies a
		// revision as an ordinary write. Explicit destructive metadata wins.
		if (
			(tool.writeCapability === "destructive" ||
				tool.annotations?.destructiveHint === true) &&
			/^mcp:.*\.(read|write)$/.test(endpointScope)
		) {
			return endpointScope.replace(/\.(read|write)$/, ".admin");
		}
		return resolveCapabilityFamilyScope(endpointScope, tool);
	}

	const rawName = rawToolName(tool.toolId);
	const tenantOperatorScope = TENANT_OPERATOR_TOOL_SCOPE_OVERRIDES[rawName];
	if (tenantOperatorScope) {
		return resolveCapabilityFamilyScope(tenantOperatorScope, tool);
	}
	const skillSelfServiceScope =
		SKILL_SELF_SERVICE_TOOL_SCOPE_OVERRIDES[rawName];
	if (skillSelfServiceScope) {
		return resolveCapabilityFamilyScope(skillSelfServiceScope, tool);
	}
	if (
		TEDI_WORK_ITEM_TOOL_NAME_RE.test(rawName) ||
		TEDI_WORK_BOARD_TOOL_NAMES.has(rawName) ||
		TEDI_WORK_BOARD_OBSERVE_TOOL_NAMES.has(rawName)
	) {
		return resolveCapabilityFamilyScope("mcp:work", tool);
	}
	if (isAdminAccessLevelOverrideTool(rawName)) {
		return resolveCapabilityFamilyScope(toolToCapabilityScope(rawName), tool);
	}
	// A domain-less workstation name proves nothing once it carries an aggregate
	// prefix: `read` means "this tedi's workstation" only on the tedi's own
	// server, where the id is unprefixed. Consulting the exact-name rule for
	// `<ns>__read` let ANY unmapped namespace borrow `mcp:tedis` — the whole
	// bare set did, while `<ns>__frobnicate` correctly failed closed. Prefixed,
	// these fall through to the namespace below, which throws when it is
	// unknown. Names that carry their own domain (`messages_read`,
	// `work_item_get`) are unaffected, which keeps the tedi-slug namespaces
	// (`ceo__messages_read`, `cto__work_item_get`) resolving as they always have.
	const prefixedDomainlessWorkstationTool =
		tool.toolId.includes("__") &&
		DOMAINLESS_WORKSTATION_TOOL_NAMES.has(rawName);
	const configuredAggregateTediNamespace = Array.isArray(
		mcpConfig?.aggregateTedis,
	)
		? mcpConfig.aggregateTedis.some((entry) => {
				if (!entry || typeof entry !== "object" || Array.isArray(entry))
					return false;
				const configured = (entry as Record<string, unknown>).namespace;
				return (
					typeof configured === "string" &&
					normalizeNamespaceForScope(configured) ===
						normalizeNamespaceForScope(namespace)
				);
			})
		: false;
	if (prefixedDomainlessWorkstationTool && configuredAggregateTediNamespace) {
		return resolveCapabilityFamilyScope("mcp:tedis", tool);
	}
	const knownToolScope = prefixedDomainlessWorkstationTool
		? null
		: resolveKnownToolCapabilityScope(rawName);
	if (knownToolScope) {
		return resolveCapabilityFamilyScope(knownToolScope, tool);
	}

	const normalizedNamespace = normalizeNamespaceForScope(namespace);
	const namespaceScope = NAMESPACE_SCOPE_FALLBACKS[normalizedNamespace];
	if (namespaceScope) return resolveCapabilityFamilyScope(namespaceScope, tool);

	if (TEDI_MESSAGING_TOOL_NAMES.has(rawName)) {
		return resolveCapabilityFamilyScope("mcp:messaging", tool);
	}
	if (
		TEDI_MESSAGING_TOOL_PREFIXES.some((prefix) => rawName.startsWith(prefix))
	) {
		return resolveCapabilityFamilyScope("mcp:messaging", tool);
	}
	if (TEDI_WORK_ITEM_TOOL_NAME_RE.test(rawName)) {
		return resolveCapabilityFamilyScope("mcp:work", tool);
	}
	if (TEDI_WORK_BOARD_TOOL_NAMES.has(rawName)) {
		return resolveCapabilityFamilyScope("mcp:work", tool);
	}
	if (TEDI_WORK_BOARD_OBSERVE_TOOL_NAMES.has(rawName)) {
		return resolveCapabilityFamilyScope("mcp:work", tool);
	}

	if (prefixedDomainlessWorkstationTool) {
		// Same refusal the exact-name table gives an unknown tool, reported
		// against the id the caller actually sent so the failure names the
		// namespace that could not be mapped.
		throw new Error(`Missing MCP capability mapping for tool: ${tool.toolId}`);
	}
	// A reviewed endpoint resolves only where nothing above did, so it never
	// changes a namespace that already maps (e.g. Home's messaging aliases).
	const reviewedScope = rpcEndpoint
		? REVIEWED_RPC_ENDPOINT_SCOPES[rpcEndpoint]
		: undefined;
	if (reviewedScope) return resolveCapabilityFamilyScope(reviewedScope, tool);
	return resolveCapabilityFamilyScope(toolToCapabilityScope(rawName), tool);
}

function rawToolName(toolId: string): string {
	return toolId.includes("__")
		? toolId.split("__").slice(1).join("__")
		: toolId;
}

export function inferToolNamespace(toolId: string): string {
	if (toolId.includes("__")) return toolId.split("__")[0] ?? toolId;
	const root = toolId.split("_")[0];
	return root || toolId;
}

export function resolveMcpToolRequiredScopes(
	tool: ToolAuthShape,
	namespace: string,
	mcpConfig: Record<string, unknown> | undefined,
	options: {
		fallbackOnAuthenticatedAuthMode?: boolean;
		toolCall?: { arguments: unknown };
	} = {},
): string[] {
	const durableCodeBinding =
		RESOURCE_BOUND_DURABLE_CODE_TOOLS[rawToolName(tool.toolId)];
	const durableCodeEndpoint = Object.values(
		RESOURCE_BOUND_DURABLE_CODE_TOOLS,
	).some((binding) => binding.endpoint === tool.config?.endpoint);
	if (durableCodeBinding || durableCodeEndpoint) {
		if (
			!durableCodeBinding ||
			tool.toolTypeId !== "rpc" ||
			durableCodeBinding.endpoint !== tool.config?.endpoint
		) {
			throw new Error(
				`Missing MCP capability mapping for tool: ${tool.toolId} (invalid durable worker RPC binding)`,
			);
		}
		// Resource-bound operations retain their exact tier before configuration
		// overrides or aggregate aliases can downgrade operator administration.
		return [durableCodeBinding.scope];
	}
	const authorizationInventoryName =
		rawToolName(tool.toolId) === "list_mcp_authorizations";
	const authorizationInventoryEndpoint =
		tool.config?.endpoint === "organizations/listMcpAuthorizations";
	// This human-owned inventory is exposed only through its canonical RPC pair.
	// Validate before configured scopes or connection metadata can bypass it.
	if (
		(authorizationInventoryName || authorizationInventoryEndpoint) &&
		(!authorizationInventoryName ||
			!authorizationInventoryEndpoint ||
			tool.toolTypeId !== "rpc")
	) {
		throw new Error(
			`Missing MCP capability mapping for tool: ${tool.toolId} (invalid authorization inventory RPC binding)`,
		);
	}

	if (isConnectedTool(tool)) {
		// Notion exposes several commands through one destructive-annotated tool.
		// Discovery shows its least-privileged executable path; each call is
		// classified again from the exact arguments before any upstream dispatch.
		if (
			connectedProviderId(tool) === "notion" &&
			sanitizeToolName(rawToolName(tool.toolId)) === "notion_update_page"
		) {
			return !options.toolCall ||
				isSafeNotionPageUpdateCall(options.toolCall.arguments)
				? ["connections.execute"]
				: ["connections.execute", "connections.admin"];
		}
		if (isDangerousTool(tool))
			return ["connections.execute", "connections.admin"];
		// Upstream hints and the column derived from them cannot independently
		// establish read authority. This server-owned declaration is recorded on
		// the exact configured tool after review, never copied from upstream meta.
		const reviewedRead =
			tool.config?.connectionReadOnly === true &&
			tool.writeCapability === "read" &&
			tool.annotations?.readOnlyHint !== false;
		return reviewedRead ? ["connections.read"] : ["connections.execute"];
	}

	if (mcpConfig?.enforcePolicies === true) {
		return [toolToScope(tool.toolId)];
	}

	const toolScopes = mcpConfig?.toolScopes as
		| Record<string, string[]>
		| undefined;
	const rawName = rawToolName(tool.toolId);
	const safeName = sanitizeToolName(rawName);
	for (const key of [tool.toolId, rawName, safeName, namespace, "*"]) {
		if (!toolScopes || !Object.hasOwn(toolScopes, key)) continue;
		const configuredScopes = toolScopes[key] ?? [];
		if (
			configuredScopes.length > 0 ||
			(tool.authRequired !== true &&
				tool.visibility !== "private" &&
				!isDangerousTool(tool))
		) {
			return [
				...new Set(
					configuredScopes.map((scope) =>
						resolveCapabilityFamilyScope(scope, tool),
					),
				),
			];
		}
	}

	const authMode =
		(mcpConfig?.authMode as string | undefined) ?? "authenticated";
	const shouldFallback =
		!!toolScopes ||
		(options.fallbackOnAuthenticatedAuthMode === true &&
			(authMode === "authenticated" ||
				authMode === "hybrid" ||
				authMode === "proxy-target")) ||
		tool.authRequired === true ||
		tool.visibility === "private" ||
		isDangerousTool(tool) ||
		!hasNamespaceFallbackScope(namespace);

	if (!shouldFallback) return [];
	return [resolveNamespaceFallbackScope(tool, namespace, mcpConfig)];
}

export function isMcpToolVisibleToCaller(
	tool: ToolAuthShape,
	namespace: string,
	mcpConfig: Record<string, unknown> | undefined,
	caller: { authType?: string | null; scopes?: string[] },
	options: { fallbackOnAuthenticatedAuthMode?: boolean } = {},
): boolean {
	let requiredScopes: string[];
	try {
		requiredScopes = resolveMcpToolRequiredScopes(
			tool,
			namespace,
			mcpConfig,
			options,
		);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("Missing MCP capability mapping for tool:")
		) {
			return false;
		}
		throw error;
	}
	if (requiredScopes.length === 0) return true;

	if (caller.authType === "service") return true;
	if (!caller.authType) return false;

	const scopes = caller.scopes ?? [];
	return requiredScopes.every((requiredScope) =>
		hasScope(scopes, requiredScope),
	);
}
