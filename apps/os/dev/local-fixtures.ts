import type {
	CatalogAppDetail,
	ListCatalogAppsInput,
} from "@tedix/api-contract/schemas/catalog";
import type { ConnectionInventoryInput } from "@tedix/api-contract/schemas/connections";
/**
 * Zero-account local API lane: deterministic fixtures + per-procedure handlers
 * for every oRPC procedure the Tedix OS SPA calls.
 *
 * `handleLocalRpc` is pure with respect to its module (no Vite/node imports)
 * so it is unit-testable; write-shaped procedures mutate an in-memory store
 * that `resetLocalFixtures()` restores. The wire envelope mirrors the oRPC v2
 * RPC serializer the SPA client uses: success bodies are `{"json": <output>}`,
 * error bodies are `{"json": {defined, inferable, code, message, data?}}` on a
 * >=400 status, and input envelopes may carry a `meta` array whose
 * `"undefined"` entries must be re-applied (the client serializes explicit
 * `undefined` property values as `null` + meta marker).
 */

import type {
	HomeConversation,
	HomeMessage,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { TediMessageAttachment } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { Organization } from "@tedix/api-contract/schemas/organization";
import type { OsUserPreferences } from "@tedix/api-contract/schemas/user-settings";
import type { OsBlueprintWithVisibility as OsBlueprint } from "@tedix/api-contract/contracts/os-workspaces";
import type {
	OsBlueprintPreflight,
	OsBlueprintExport,
	OsBlueprintRevision,
	OsCollaborationProposal,
	OsGadget,
	OsGadgetExecution,
	OsGadgetRevision,
	OsOutput,
	OsOutputContent,
	OsOutputLibraryItem,
	OsOutputRevision,
	OsWorkspace,
	OsWorkspacePreference,
	OsWorkspaceResource,
} from "@tedix/api-contract/schemas/os-workspaces";

// ---------------------------------------------------------------------------
// Deterministic identity + time
// ---------------------------------------------------------------------------

/** Fixed, valid v4-shaped UUIDs: block selects the entity family. */
const fid = (block: string, n: number): string =>
	`${block.padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const ORG_ID = fid("0a", 1);

const TEDI_NOVA = fid("10", 1);
const TEDI_MILES = fid("10", 2);
const TEDI_JUNO = fid("10", 3);

const SKILL_REVENUE = fid("20", 1);
const SKILL_TRIAGE = fid("20", 2);
const SKILL_CHURN = fid("20", 3);
const SKILL_BRIEF = fid("20", 4);

const RUN_REVENUE_OK = fid("21", 1);
const RUN_CHURN_FAILED = fid("21", 2);
const RUN_REVENUE_LIVE = fid("21", 3);

const WORKSPACE_REVENUE = fid("30", 1);
const WORKSPACE_SUPPORT = fid("30", 2);
const WORKSPACE_RESOURCE_REPO = fid("30", 3);
const GADGET_DASHBOARD = fid("31", 1);
const GADGET_TRIAGE = fid("31", 2);
const GADGET_REV_DASHBOARD = fid("32", 1);
const GADGET_REV_TRIAGE = fid("32", 2);
const EXEC_DASHBOARD_DONE = fid("33", 1);
const EXEC_DASHBOARD_LIVE = fid("33", 2);

const OUTPUT_DOCUMENT = fid("40", 1);
const OUTPUT_SHEET = fid("40", 2);
const OUTPUT_DECK = fid("40", 3);
const COLLAB_PROPOSAL_OPEN = fid("42", 1);
const COLLAB_PROPOSAL_ACCEPTED = fid("42", 2);

const BLUEPRINT_PUBLISHED = fid("50", 1);
const BLUEPRINT_DRAFT = fid("50", 2);

const CONVERSATION_HOME = fid("60", 1);
const HOME_RUN_DONE = fid("62", 1);

const APP_STOREFRONT = fid("80", 1);
const APP_SUPPORT = fid("80", 2);
const APP_FINANCE = fid("80", 3);

const T0 = "2026-08-10T09:00:00.000Z";
const T1 = "2026-08-10T13:00:00.000Z";
const T2 = "2026-08-11T06:00:00.000Z";
const T3 = "2026-08-11T13:05:00.000Z";
const T4 = "2026-08-12T08:30:00.000Z";
const T5 = "2026-08-12T08:31:00.000Z";

export const LOCAL_WIDGET_APP_SLUG = "tedix-local";
export const LOCAL_WIDGET_RESOURCE_URI =
	"ui://widgets/mcp-app/tedix-local/r/revenue-dashboard.html";

const now = (): string => new Date().toISOString();

let seq = 0;
const nextId = (): string => fid("9e", ++seq);

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

type RpcErrorCode = "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT";

const RPC_ERROR_STATUS: Record<RpcErrorCode, number> = {
	BAD_REQUEST: 400,
	NOT_FOUND: 404,
	CONFLICT: 409,
};

class RpcError extends Error {
	constructor(
		readonly code: RpcErrorCode,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
	}
}

const revisionConflict = (
	expectedRevision: number,
	currentRevision: number | null,
): RpcError =>
	new RpcError("CONFLICT", "Revision conflict", {
		expectedRevision,
		currentRevision,
	});

// ---------------------------------------------------------------------------
// Stateful store (writes mutate; resetLocalFixtures() reseeds)
// ---------------------------------------------------------------------------

type ApprovalRow = {
	id: string;
	tediId: string;
	orgId: string;
	actionType: string;
	description: string;
	payload: Record<string, unknown>;
	status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
	createdAt: string;
	expiresAt: string;
	resolvedAt: string | null;
	resolvedBy: string | null;
	resolution: string | null;
	workflowId: string | null;
	review: {
		intent: "tool_write";
		state: "requires_decision" | "resolved";
		decisionMode: "approve_or_reject";
		outcome: "approved" | "rejected" | null;
		safetyDefault: "deny_on_timeout";
		summary: string;
		operatorQuestion: string;
		timeout: {
			expired: boolean;
			terminalStatus: null;
			defaultDecision: null;
			reason: string;
		};
		evidenceRefs: { kind: "approval_request" | "tedi"; id: string }[];
		interaction: null;
	};
};

type SkillRunRow = {
	id: string;
	skillId: string;
	skillSlug: string;
	tediId: string;
	status: "queued" | "running" | "paused" | "completed" | "failed" | "canceled";
	executionEpoch: number;
	startedAt: string | null;
	completedAt: string | null;
	error: string | null;
	createdBy: string | null;
};

type LocalState = {
	/** The one local organization; profile writes mutate it in place. */
	organization: Organization;
	workspaces: OsWorkspace[];
	workspacePreferences: OsWorkspacePreference[];
	workspaceResources: OsWorkspaceResource[];
	gadgets: OsGadget[];
	gadgetRevisions: OsGadgetRevision[];
	executions: OsGadgetExecution[];
	outputs: OsOutput[];
	outputRevisions: OsOutputRevision[];
	collaborationProposals: OsCollaborationProposal[];
	blueprints: OsBlueprint[];
	blueprintRevisions: OsBlueprintRevision[];
	conversations: (HomeConversation & { hidden?: boolean })[];
	messages: HomeMessage[];
	homeRuns: HomeRun[];
	approvals: ApprovalRow[];
	skillRuns: SkillRunRow[];
	/** null until the operator saves; mirrors "no `user_configs` row". */
	userPreferences: {
		value: OsUserPreferences;
		revision: number;
		updatedAt: string;
	} | null;
};

/**
 * Mirrors `DEFAULT_OS_USER_PREFERENCES` in
 * `@tedix/api-contract/schemas/user-settings`. Written out rather than
 * imported because vite.config.ts loads this module under raw Node, where the
 * package's TypeScript entry points cannot be evaluated — only `import type`
 * survives. The fixture test still parses the result through the REAL contract
 * output schema, so any SHAPE drift fails there.
 */
const DEFAULT_LOCAL_PREFERENCES: OsUserPreferences = {
	theme: "system",
	density: "comfortable",
	locale: null,
	timezone: null,
	accessibility: { motion: "system", contrast: "system" },
	notifications: { approvals: true, runFailures: true, budgetAlerts: true },
	conversationModelRef: null,
};

const workspaceRow = (
	id: string,
	name: string,
	description: string,
): OsWorkspace => ({
	id,
	organizationId: ORG_ID,
	name,
	description,
	status: "active",
	sourceBlueprintId: null,
	sourceBlueprintRevisionId: null,
	sourceBlueprintRevisionNumber: null,
	instantiationPreflight: null,
	rollbackReference: null,
	blueprintDecision: null,
	createdByKind: "user",
	createdById: "dev-operator",
	createdAt: T0,
	updatedAt: T0,
});

const documentContent: OsOutputContent = {
	kind: "document",
	blocks: [
		{ type: "heading", level: 1, text: "Q3 Revenue Narrative" },
		{
			type: "paragraph",
			text: "Revenue held at 412,000 MXN for week 32, up 6% week over week. Subscription renewals carried the growth while walk-in volume stayed flat.",
		},
		{
			type: "list",
			ordered: false,
			items: [
				"Renewals: 212 active, 9 recovered from dunning",
				"Wholesale: 3 new cafés onboarded",
				"Churn watch: 4 accounts flagged, 2 saved",
			],
		},
		{
			type: "quote",
			text: "Hold the wholesale discount at 12% until the churn cohort stabilizes.",
		},
	],
};

const sheetContent: OsOutputContent = {
	kind: "sheet",
	columns: ["Week", "Revenue (MXN)", "Orders", "Notes"],
	rows: [
		["W29", 371500, 502, "Baseline"],
		["W30", 384200, 517, "Promo weekend"],
		["W31", 388900, 509, null],
		["W32", 412000, 541, "Wholesale onboarding"],
	],
};

const deckContent: OsOutputContent = {
	kind: "presentation",
	slides: [
		{
			title: "Solstice Coffee — August Update",
			bullets: ["Revenue +6% WoW", "3 new wholesale cafés", "Churn saves: 2/4"],
			notes: "Open with the wholesale story; it explains the whole delta.",
		},
		{
			title: "Digital worker operations",
			bullets: [
				"Nova: ops coordination, 6 decisions/day",
				"Miles: revenue reporting on a weekly workflow",
				"Juno: support triage across 2 inboxes",
			],
		},
		{
			title: "Next 30 days",
			bullets: [
				"Automate dunning recovery",
				"Ship churn-watch to daily cadence",
			],
		},
	],
};

const seedState = (): LocalState => ({
	organization: {
		id: ORG_ID,
		// Literals, not ORG_MEMBERSHIP: seedState() runs at module evaluation,
		// before that const initializes (it would be a TDZ ReferenceError).
		name: "Solstice Coffee Co.",
		slug: "solstice",
		type: "organization",
		// null keeps the Descope-backed sections (identity widgets, SSO embed)
		// honestly unavailable in the zero-account lane.
		descopeTenantId: null,
		logoUrl: null,
		description: "Local fixture organization for the zero-account lane.",
		appsCount: 3,
		features: {
			maxApps: 10,
			maxTeamMembers: 10,
			customDomain: false,
			sso: false,
			apiAccess: true,
			prioritySupport: false,
			advancedAnalytics: false,
			whiteLabel: false,
			os: true,
		},
		metadata: {
			website: "https://solstice.example",
			contactEmail: "hello@solstice.example",
		},
		createdAt: T0,
		updatedAt: T5,
	},
	workspaces: [
		workspaceRow(
			WORKSPACE_REVENUE,
			"Revenue Ops",
			"Weekly revenue reporting surfaces and gadgets",
		),
		workspaceRow(
			WORKSPACE_SUPPORT,
			"Support Desk",
			"Ticket triage and support follow-ups",
		),
	],
	workspacePreferences: [
		{
			workspaceId: WORKSPACE_REVENUE,
			favorite: true,
			lastOpenedAt: T5,
			updatedAt: T5,
		},
		{
			workspaceId: WORKSPACE_SUPPORT,
			favorite: false,
			lastOpenedAt: T4,
			updatedAt: T4,
		},
	],
	workspaceResources: [
		{
			id: WORKSPACE_RESOURCE_REPO,
			personalOwnerUserId: null,
			connectionInstanceId: null,
			providerAccess: null,
			organizationId: ORG_ID,
			workspaceId: WORKSPACE_REVENUE,
			slot: null,
			providerId: "github",
			connectionScope: "tenant",
			requiredScopes: ["repo:read"],
			resourceType: "repository",
			providerResourceId: "tedix-hq/tedix",
			name: "Tedix repository",
			metadata: {},
			status: "active",
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T4,
			updatedAt: T4,
			removedAt: null,
		},
	],
	gadgets: [
		{
			id: GADGET_DASHBOARD,
			organizationId: ORG_ID,
			workspaceId: WORKSPACE_REVENUE,
			name: "Revenue Dashboard",
			description: "Renders the weekly revenue summary sheet",
			status: "active",
			currentRevisionId: GADGET_REV_DASHBOARD,
			sourceBlueprintRevisionId: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T0,
			updatedAt: T1,
		},
		{
			id: GADGET_TRIAGE,
			organizationId: ORG_ID,
			workspaceId: WORKSPACE_SUPPORT,
			name: "Ticket Triage Board",
			description: "Groups open tickets by SLA risk",
			status: "active",
			currentRevisionId: GADGET_REV_TRIAGE,
			sourceBlueprintRevisionId: null,
			createdByKind: "tedi",
			createdById: TEDI_JUNO,
			createdAt: T0,
			updatedAt: T0,
		},
	],
	gadgetRevisions: [
		{
			id: GADGET_REV_DASHBOARD,
			organizationId: ORG_ID,
			gadgetId: GADGET_DASHBOARD,
			revision: 1,
			manifest: {
				capabilities: ["outputs.read", "sheets.write"],
				entry: LOCAL_WIDGET_RESOURCE_URI,
				notes: "Reads the weekly revenue sheet output and renders trend tiles.",
			},
			sourceArtifactRef: "r2://gadget-builds/revenue-dashboard/v1.tar",
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T1,
		},
		{
			id: GADGET_REV_TRIAGE,
			organizationId: ORG_ID,
			gadgetId: GADGET_TRIAGE,
			revision: 1,
			manifest: {
				capabilities: ["tickets.read"],
				entry: "gadgets/ticket-triage/index.html",
			},
			sourceArtifactRef: null,
			createdByKind: "tedi",
			createdById: TEDI_JUNO,
			createdAt: T0,
		},
	],
	executions: [
		{
			id: EXEC_DASHBOARD_DONE,
			organizationId: ORG_ID,
			workspaceId: WORKSPACE_REVENUE,
			gadgetId: GADGET_DASHBOARD,
			revisionId: GADGET_REV_DASHBOARD,
			revision: 1,
			lineage: {
				runId: null,
				workflowInstanceId: null,
				executionEpoch: 0,
				tediId: null,
				workItemId: null,
				traceBundleId: null,
				billingReservationId: null,
				approvalRequestId: null,
				runtimeEnvironment: null,
				agentSessionId: null,
			},
			status: "completed",
			grantedCapabilities: ["outputs.read"],
			policyDecision: { allowed: true, reasons: [] },
			input: { range: "last_7_days" },
			output: { rowsRendered: 42 },
			error: null,
			costs: { cpuMs: 1240 },
			evidenceRefs: ["r2://gadget-runs/dashboard/render.log"],
			createdByKind: "tedi",
			createdById: TEDI_MILES,
			createdAt: T2,
			completedAt: T3,
		},
		{
			id: EXEC_DASHBOARD_LIVE,
			organizationId: ORG_ID,
			workspaceId: WORKSPACE_REVENUE,
			gadgetId: GADGET_DASHBOARD,
			revisionId: GADGET_REV_DASHBOARD,
			revision: 1,
			lineage: {
				runId: null,
				workflowInstanceId: null,
				executionEpoch: 0,
				tediId: null,
				workItemId: null,
				traceBundleId: null,
				billingReservationId: null,
				approvalRequestId: null,
				runtimeEnvironment: null,
				agentSessionId: null,
			},
			status: "running",
			grantedCapabilities: ["outputs.read", "sheets.write"],
			policyDecision: { allowed: true, reasons: [] },
			input: { range: "today" },
			output: null,
			error: null,
			costs: null,
			evidenceRefs: null,
			createdByKind: "tedi",
			createdById: TEDI_MILES,
			createdAt: T4,
			completedAt: null,
		},
	],
	outputs: [
		{
			id: OUTPUT_DOCUMENT,
			organizationId: ORG_ID,
			workspaceId: WORKSPACE_REVENUE,
			kind: "document",
			title: "Q3 Revenue Narrative",
			status: "active",
			currentRevisionId: fid("41", 1),
			createdByKind: "tedi",
			createdById: TEDI_MILES,
			createdAt: T1,
			updatedAt: T1,
		},
		{
			id: OUTPUT_SHEET,
			organizationId: ORG_ID,
			workspaceId: WORKSPACE_REVENUE,
			kind: "sheet",
			title: "Weekly Revenue Summary",
			status: "active",
			currentRevisionId: fid("41", 2),
			createdByKind: "tedi",
			createdById: TEDI_MILES,
			createdAt: T1,
			updatedAt: T2,
		},
		{
			id: OUTPUT_DECK,
			organizationId: ORG_ID,
			workspaceId: null,
			kind: "presentation",
			title: "Investor Update Deck",
			status: "active",
			currentRevisionId: fid("41", 3),
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T2,
			updatedAt: T2,
		},
	],
	outputRevisions: [
		{
			id: fid("41", 1),
			organizationId: ORG_ID,
			outputId: OUTPUT_DOCUMENT,
			revision: 1,
			content: documentContent,
			note: "Initial narrative from the weekly workflow",
			producedBy: null,
			accessEnvelope: null,
			createdByKind: "tedi",
			createdById: TEDI_MILES,
			createdAt: T1,
		},
		{
			id: fid("41", 2),
			organizationId: ORG_ID,
			outputId: OUTPUT_SHEET,
			revision: 1,
			content: sheetContent,
			note: null,
			producedBy: null,
			accessEnvelope: null,
			createdByKind: "tedi",
			createdById: TEDI_MILES,
			createdAt: T1,
		},
		{
			id: fid("41", 3),
			organizationId: ORG_ID,
			outputId: OUTPUT_DECK,
			revision: 1,
			content: deckContent,
			note: "Draft for the August investor sync",
			producedBy: null,
			accessEnvelope: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T2,
		},
	],
	collaborationProposals: [
		{
			id: COLLAB_PROPOSAL_OPEN,
			organizationId: ORG_ID,
			workspaceId: WORKSPACE_REVENUE,
			documentType: "output",
			documentId: OUTPUT_DOCUMENT,
			baseRevisionId: fid("41", 1),
			baseRevision: 1,
			status: "open",
			sourceKind: "agent_session",
			sourceId: "local-agent-session",
			content: {
				kind: "document",
				blocks: [
					{ type: "heading", level: 1, text: "Agent revenue proposal" },
					{ type: "paragraph", text: "Review this preview before merge." },
				],
			},
			sequence: 1,
			createdByKind: "external_agent",
			createdById: "local-agent",
			createdAt: T2,
			updatedAt: T3,
			decisionRationale: null,
			decisionEvidenceRefs: [],
			decidedByKind: null,
			decidedById: null,
			decidedAt: null,
			mergeRationale: null,
			mergeEvidenceRefs: [],
			mergedByKind: null,
			mergedById: null,
			mergedAt: null,
			resultRevisionId: null,
			resultRevision: null,
		},
		{
			id: COLLAB_PROPOSAL_ACCEPTED,
			organizationId: ORG_ID,
			workspaceId: WORKSPACE_REVENUE,
			documentType: "output",
			documentId: OUTPUT_DOCUMENT,
			baseRevisionId: fid("41", 1),
			baseRevision: 1,
			status: "accepted",
			sourceKind: "run",
			sourceId: "local-run",
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "Accepted local preview" }],
			},
			sequence: 0,
			createdByKind: "tedi",
			createdById: TEDI_MILES,
			createdAt: T1,
			updatedAt: T2,
			decisionRationale: "Ready for the final merge decision",
			decisionEvidenceRefs: ["local://canvas/review"],
			decidedByKind: "user",
			decidedById: "dev-operator",
			decidedAt: T2,
			mergeRationale: null,
			mergeEvidenceRefs: [],
			mergedByKind: null,
			mergedById: null,
			mergedAt: null,
			resultRevisionId: null,
			resultRevision: null,
		},
	],
	blueprints: [
		{
			id: BLUEPRINT_PUBLISHED,
			organizationId: ORG_ID,
			name: "Revenue Ops Starter",
			description: "Workspace template for weekly revenue reporting",
			status: "published",
			visibility: "catalog",
			currentRevisionId: fid("51", 1),
			lineage: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T0,
			updatedAt: T1,
		},
		{
			id: BLUEPRINT_DRAFT,
			organizationId: ORG_ID,
			name: "Support Desk Draft",
			description: "Draft template for the support triage workspace",
			status: "draft",
			visibility: "org",
			currentRevisionId: fid("51", 2),
			lineage: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T2,
			updatedAt: T2,
		},
	],
	blueprintRevisions: [
		{
			id: fid("51", 1),
			organizationId: ORG_ID,
			blueprintId: BLUEPRINT_PUBLISHED,
			revision: 1,
			definition: {
				gadgets: [
					{
						name: "Revenue Dashboard",
						manifest: {
							capabilities: ["outputs.read", "sheets.write"],
							entry: "gadgets/revenue-dashboard/index.html",
						},
					},
				],
				requirements: {
					version: 1,
					skills: [
						{
							role: "skill",
							skillId: fid("52", 1),
							slug: "weekly-revenue-report",
							revision: 3,
							workflowSha256: null,
						},
					],
					connections: [
						{ providerId: "gmail", tokenScope: "tenant", scopes: [] },
					],
					policies: [
						{ scope: "organization", slug: "revenue-ops", version: 2 },
					],
					runtime: {
						modelRef: null,
						minTier: "balanced",
						requiresReasoning: false,
					},
					layout: {
						columns: 12,
						placements: [
							{
								gadget: "Revenue Dashboard",
								column: 1,
								row: 1,
								width: 6,
								height: 2,
							},
						],
					},
					outputs: [
						{
							gadget: "Revenue Dashboard",
							kind: "sheet",
							title: "Weekly Revenue",
						},
					],
				},
			},
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T0,
			publishedAt: T1,
		},
		{
			id: fid("51", 2),
			organizationId: ORG_ID,
			blueprintId: BLUEPRINT_DRAFT,
			revision: 1,
			definition: {
				gadgets: [
					{
						name: "Ticket Triage Board",
						manifest: {
							capabilities: ["tickets.read"],
							entry: "gadgets/ticket-triage/index.html",
						},
					},
				],
				requirements: null,
			},
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: T2,
			publishedAt: null,
		},
	],
	conversations: [
		{
			id: CONVERSATION_HOME,
			organizationId: ORG_ID,
			title: "Monday revenue check-in",
			status: "active",
			channel: "os",
			lastMessageAt: T5,
			messageCount: 4,
			createdAt: T0,
			updatedAt: T5,
			pinnedAt: null,
			origin: "human",
		},
	],
	messages: [
		{
			id: fid("61", 1),
			organizationId: ORG_ID,
			conversationId: CONVERSATION_HOME,
			role: "user",
			status: "completed",
			content: "Morning — where does revenue stand after last week?",
			createdAt: T0,
		},
		{
			id: fid("61", 2),
			organizationId: ORG_ID,
			conversationId: CONVERSATION_HOME,
			role: "assistant",
			status: "completed",
			content:
				"Week 32 closed at 412,000 MXN, up 6% week over week. Miles published the Weekly Revenue Summary sheet and the Q3 narrative document in Revenue Ops.",
			createdAt: T1,
		},
		{
			id: fid("61", 3),
			organizationId: ORG_ID,
			conversationId: CONVERSATION_HOME,
			runId: HOME_RUN_DONE,
			role: "user",
			status: "completed",
			content: "Great — flag anything unusual in the churn cohort.",
			createdAt: T4,
		},
		{
			id: fid("61", 4),
			organizationId: ORG_ID,
			conversationId: CONVERSATION_HOME,
			runId: HOME_RUN_DONE,
			role: "assistant",
			status: "completed",
			content:
				"Two of the four flagged accounts renewed after the win-back email; the churn-watch workflow failed on its last run and is queued for retry, so today's cohort view may lag by a day.",
			createdAt: T5,
		},
	],
	homeRuns: [
		{
			id: HOME_RUN_DONE,
			organizationId: ORG_ID,
			conversationId: CONVERSATION_HOME,
			status: "completed",
			inputMessageId: fid("61", 3),
			outputMessageId: fid("61", 4),
			delegatedTediId: null,
			childRunId: null,
			startedAt: T4,
			completedAt: T5,
			createdAt: T4,
			updatedAt: T5,
			usage: {
				pricing: null,

				inputTokens: 1840,
				outputTokens: 412,
				reasoningTokens: 64,
				totalTokens: 2252,
				costUsd: 0.0179,
			},
		},
	],
	approvals: [
		{
			id: fid("71", 1),
			tediId: TEDI_MILES,
			orgId: ORG_ID,
			actionType: "tool_write",
			description: "Send the weekly revenue digest email to the owners list",
			payload: { tool: "gmail_send", recipients: 2 },
			status: "pending",
			createdAt: T4,
			// Future-relative on purpose: a fixed past expiry would render every
			// pending approval as expired the day after this file was written.
			expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
			resolvedAt: null,
			resolvedBy: null,
			resolution: null,
			workflowId: null,
			review: {
				intent: "tool_write",
				state: "requires_decision",
				decisionMode: "approve_or_reject",
				outcome: null,
				safetyDefault: "deny_on_timeout",
				summary: "Miles wants to send the weekly digest to 2 recipients.",
				operatorQuestion: "Send the weekly revenue digest email?",
				timeout: {
					expired: false,
					terminalStatus: null,
					defaultDecision: null,
					reason: "Denies automatically at expiry.",
				},
				evidenceRefs: [
					{ kind: "approval_request", id: fid("71", 1) },
					{ kind: "tedi", id: TEDI_MILES },
				],
				interaction: null,
			},
		},
		{
			id: fid("71", 2),
			tediId: TEDI_JUNO,
			orgId: ORG_ID,
			actionType: "tool_write",
			description: "Issue a 150 MXN goodwill credit on ticket #4821",
			payload: { tool: "billing_credit", amountMxn: 150 },
			status: "pending",
			createdAt: T5,
			expiresAt: new Date(Date.now() + 40 * 3_600_000).toISOString(),
			resolvedAt: null,
			resolvedBy: null,
			resolution: null,
			workflowId: null,
			review: {
				intent: "tool_write",
				state: "requires_decision",
				decisionMode: "approve_or_reject",
				outcome: null,
				safetyDefault: "deny_on_timeout",
				summary: "Juno proposes a goodwill credit for a delayed order.",
				operatorQuestion: "Approve the 150 MXN goodwill credit?",
				timeout: {
					expired: false,
					terminalStatus: null,
					defaultDecision: null,
					reason: "Denies automatically at expiry.",
				},
				evidenceRefs: [{ kind: "approval_request", id: fid("71", 2) }],
				interaction: null,
			},
		},
	],
	skillRuns: [
		{
			id: RUN_REVENUE_OK,
			skillId: SKILL_REVENUE,
			skillSlug: "weekly-revenue-report",
			tediId: TEDI_MILES,
			status: "completed",
			executionEpoch: 0,
			startedAt: T1,
			completedAt: T2,
			error: null,
			createdBy: "schedule",
		},
		{
			id: RUN_CHURN_FAILED,
			skillId: SKILL_CHURN,
			skillSlug: "churn-watch",
			tediId: TEDI_MILES,
			status: "failed",
			executionEpoch: 0,
			startedAt: T2,
			completedAt: T3,
			error: "MCP call crm.list_accounts timed out after 15s",
			createdBy: "schedule",
		},
		{
			id: RUN_REVENUE_LIVE,
			skillId: SKILL_REVENUE,
			skillSlug: "weekly-revenue-report",
			tediId: TEDI_MILES,
			status: "running",
			executionEpoch: 0,
			startedAt: T4,
			completedAt: null,
			error: null,
			createdBy: "dev-operator",
		},
	],
	userPreferences: null,
});

let state = seedState();

export function resetLocalFixtures(): void {
	state = seedState();
	seq = 0;
}

// ---------------------------------------------------------------------------
// Read-only fixtures
// ---------------------------------------------------------------------------

const tediRow = (
	id: string,
	name: string,
	slug: string,
	displayName: string,
	personality: string,
) => ({
	id,
	organizationId: ORG_ID,
	ownerUserId: "dev-operator",
	scope: "organization" as const,
	name,
	slug,
	displayName,
	descopeUserId: null,
	descopeMcpResourceId: null,
	externalRef: null,
	tags: ["local-fixture"],
	personality,
	avatar: null,
	timezone: "America/Mexico_City",
	language: "en",
	installedSkills: null,
	installedPlugins: null,
	status: "active" as const,
	billingState: "active" as const,
	workerName: null,
	r2BucketName: null,
	runtimeState: "active" as const,
	lastActivityAt: T5,
	runtimeStatus: "running" as const,
	runtimeKind: "agent" as const,
	isolateAgentId: null,
	lastSeenAt: T5,
	lastSyncAt: T4,
	createdAt: T0,
	updatedAt: T5,
});

const TEDIS = [
	tediRow(TEDI_NOVA, "nova", "nova", "Nova", "Calm ops coordinator"),
	tediRow(
		TEDI_MILES,
		"miles",
		"miles",
		"Miles",
		"Numbers-first revenue analyst",
	),
	tediRow(TEDI_JUNO, "juno", "juno", "Juno", "Warm support concierge"),
];

/**
 * One entrustable activity + the applied grant over it. Modeled with a real
 * grant (not an empty array) because the OS authority surface's whole job is
 * showing what a tedi may ACTUALLY do — a lane that only ever renders the
 * empty state never exercises the scope, expiry, or review evidence.
 */
const entrustableActivity = (tediId: string) => ({
	id: fid("74", 1),
	organizationId: ORG_ID,
	key: "publish_revenue_summary",
	version: 2,
	supersedesId: null,
	roleTemplateId: null,
	name: "Publish the weekly revenue summary",
	description:
		"Reconcile orders against the ledger and publish the weekly summary.",
	status: "active" as const,
	taskFamily: "reporting",
	riskLevel: "medium" as const,
	maximumLevel: "execute_reviewed" as const,
	actionPatterns: ["reports.publish", "orders.read"],
	toolIds: ["list_orders", "publish_report"],
	rubric: { criteria: ["ledger reconciled", "owner-readable summary"] },
	rubricHash: `rubric-${tediId.slice(0, 8)}`,
	evidencePolicy: {
		minimumVerifiedObservations: 3,
		minimumDistinctVerifierPrincipals: 2,
		maximumFailureRate: 0.2,
		maximumPolicyViolationSeverity: 0,
		maximumEvidenceAgeDays: 90,
		requireNonTrivialWork: true,
		minimumReliabilityLowerBound: 0.5,
		minimumMeanComplexity: 0.25,
		minimumTaskFamilies: 1,
		minimumCalibrationScore: 0.7,
		minimumEscalationQuality: 0.7,
		requireLearningTransfer: false,
	},
	evidencePolicyHash: `evidence-${tediId.slice(0, 8)}`,
	createdAt: T0,
	updatedAt: T4,
});

const roleAssignment = (tediId: string) => ({
	id: fid("75", 1),
	organizationId: ORG_ID,
	tediId,
	roleTemplateId: null,
	roleKey: "revenue_analyst",
	roleName: "Revenue analyst",
	status: "active" as const,
	// Non-shadow stages require an applied decision and an evidence hash
	// (TediRoleAssignmentSchema.superRefine) — omitting either fails the parse.
	careerStage: "operator" as const,
	assignedAt: T0,
	stageChangedAt: T2,
	endedAt: null,
	revision: 2,
	lastDecisionId: fid("76", 1),
	evidenceSnapshotHash: `evidence-snapshot-${tediId.slice(0, 8)}`,
	metadata: null,
	createdAt: T0,
	updatedAt: T2,
});

const delegationProfile = (tediId: string) => ({
	tediId,
	activeRole: roleAssignment(tediId),
	roleHistory: [roleAssignment(tediId)],
	validatedExperience: {
		formulaVersion: "validated-experience-v1" as const,
		descriptiveOnly: true as const,
		authorityEffect: "none" as const,
		provisional: true as const,
		limitations: ["Descriptive career progress only — never task authority"],
		points: 700,
		maxPoints: 3000 as const,
		validatedUnits: 7,
		uncappedUnits: 8.5,
		creditedOpportunities: 21,
		negativeOpportunities: 1,
		maximumPolicyViolationSeverity: 0,
		standing: "clear" as const,
		observationsEvaluated: 40,
		truncated: false,
		saturated: false,
		lastValidatedAt: T4,
		taskFamilies: [
			{
				taskFamily: "reporting",
				points: 300,
				maxPoints: 500 as const,
				validatedUnits: 3,
				uncappedUnits: 3.5,
				creditedOpportunities: 9,
				saturated: false,
			},
		],
	},
	delegationYield: {
		metric: "verified_value_per_owner_review_hour" as const,
		authorityEffect: "none" as const,
		measurementStatus: "partial" as const,
		provisional: true as const,
		coverage: "observed_issued_work_items_only" as const,
		observedOpportunities: 12,
		issuedOpportunities: 15,
		reviewedOpportunities: 10,
		valueCertifiedOpportunities: 6,
		ownerReviewMinutes: 120,
		valueByCurrency: [
			{
				currency: "MXN",
				verifiedValueMinorUnits: 2_500_000,
				ownerReviewMinutes: 120,
				valuePerOwnerReviewHourMinorUnits: 1_250_000,
			},
		],
		costByCurrency: [{ currency: "USD", costMinorUnits: 4200 }],
		truncated: false,
		limitations: ["Coverage limited to observed issued Work Items"],
	},
	entrustments: [
		{
			id: fid("77", 1),
			organizationId: ORG_ID,
			tediId,
			roleAssignmentId: fid("75", 1),
			activityId: fid("74", 1),
			level: "execute_reviewed" as const,
			status: "active" as const,
			scope: {
				actions: ["reports.publish", "orders.read"],
				toolIds: ["list_orders", "publish_report"],
				environments: ["production"],
				// budgetPolicyId must be present exactly when spendPermission is
				// policy_bound (EntrustmentScopeSchema.superRefine).
				spendPermission: "none" as const,
				budgetPolicyId: null,
				constraints: { maxRowsPerRead: 500 },
			},
			revision: 3,
			lastCertifiedAt: T4,
			expiresAt: null,
			nextReviewAt: "2026-09-12T08:30:00.000Z",
			restrictedAt: null,
			reason: null,
			lastDecisionId: fid("76", 1),
			activityVersion: 2,
			rubricHash: `rubric-${tediId.slice(0, 8)}`,
			evidencePolicyHash: `evidence-${tediId.slice(0, 8)}`,
			evidenceSnapshotHash: `evidence-snapshot-${tediId.slice(0, 8)}`,
			grantedByType: "user" as const,
			grantedById: "owner@tedix.dev",
			createdAt: T2,
			updatedAt: T4,
			effectiveStatus: "active" as const,
			activity: entrustableActivity(tediId),
		},
	],
});

const operationsSummary = (
	tediId: string,
	taskTitle: string,
	rationaleAction: string,
) => ({
	tediId,
	delegationProfile: delegationProfile(tediId),
	pulse: {
		lastRationale: {
			id: fid("72", 1),
			action: rationaleAction,
			category: "optimization",
			confidence: 0.82,
			outcomeStatus: "success",
			createdAt: T4,
		},
		lastFactLearned: {
			id: fid("73", 1),
			summary: "Wholesale renewals convert 2x better with a Monday follow-up",
			factType: "observation",
			confidence: 0.77,
			source: "run://" + RUN_REVENUE_OK,
			createdAt: T2,
		},
		lastToolCall: { toolName: "list_orders", success: true, createdAt: T5 },
		decisionsLast24h: 6,
		factsLearnedLast24h: 3,
	},
	activeTasks: [
		{
			id: nextIdStable(tediId, 1),
			title: taskTitle,
			status: "in_progress",
			blocker: null,
		},
	],
	objectives: [
		{ id: nextIdStable(tediId, 2), status: "active", gateConfig: null },
	],
	growthMetrics: {
		facts: 128,
		avgConfidence: 0.82,
		skills: 14,
		avgRevision: 2.1,
		muscles: 5,
		avgUsage: 11.4,
		domains: 6,
		autonomyRate: 0.64,
		expertiseLevels: { reporting: "operator", support: "apprentice" },
	},
	crons: [
		{
			name: "brain-reflection",
			mechanism: "scheduled_skill_workflow" as const,
			lastRunId: RUN_REVENUE_OK,
			lastExecutedAt: T2,
			lastSuccess: true,
			executionsLast24h: 1,
			expectedIntervalHours: 24,
			overdue: false,
			state: "healthy" as const,
			budgetBlockedAt: null,
			budgetBlockedReason: null,
			budgetResetAt: null,
			budgetBlockActive: false,
			budgetAdmissionClass: null,
		},
	],
	recentRationales: [
		{
			id: fid("72", 2),
			action: rationaleAction,
			category: "optimization",
			outcomeStatus: "success",
			createdAt: T4,
		},
	],
	muscleCount: 5,
	completedObjectives: 2,
	approvalFatigueSignal: null,
});

/** Stable pseudo-ids for nested summary rows (no state, still deterministic). */
function nextIdStable(tediId: string, n: number): string {
	return `${tediId.slice(0, 8)}-task-${n}`;
}

const skillEntry = (
	id: string,
	tediId: string | null,
	title: string,
	slug: string,
	summary: string,
	lifecycleState: "draft" | "active" | "proven" | "crystallized",
	successCount: number,
	failureCount: number,
) => ({
	id,
	organizationId: ORG_ID,
	tediId,
	proposedByTediId: tediId,
	domainId: null,
	title,
	slug,
	description: summary,
	content: `# ${title}\n\n${summary}\n\n## Steps\n1. Gather inputs\n2. Execute\n3. Record evidence`,
	files: null,
	inputSchema: null,
	successCount,
	failureCount,
	lastUsedAt: T4,
	avgDurationMs: 42_000,
	revision: 3,
	revisionReasoning: null,
	supersedesId: null,
	sourceSkillId: null,
	sourceRevision: null,
	visibility: "org" as const,
	agentSkillsFormat: null,
	r2Path: null,
	appId: null,
	toolIds: null,
	summary,
	tags: ["revenue"],
	audience: null,
	preconditions: null,
	lifecycleState,
	reviewFlaggedAt: null,
	reviewFlagReason: null,
	paceLayer:
		lifecycleState === "draft"
			? ("innovation" as const)
			: ("differentiation" as const),
	createdAt: T0,
	updatedAt: T4,
});

const SKILLS = [
	skillEntry(
		SKILL_REVENUE,
		TEDI_MILES,
		"Weekly revenue report",
		"weekly-revenue-report",
		"Assemble the weekly revenue summary sheet and narrative from order data.",
		"proven",
		18,
		1,
	),
	skillEntry(
		SKILL_TRIAGE,
		TEDI_JUNO,
		"Inbox triage",
		"inbox-triage",
		"Classify inbound support email by SLA risk and draft first responses.",
		"active",
		44,
		3,
	),
	skillEntry(
		SKILL_CHURN,
		TEDI_MILES,
		"Churn watch",
		"churn-watch",
		"Scan renewal cohorts daily and flag accounts likely to lapse.",
		"draft",
		2,
		2,
	),
	skillEntry(
		SKILL_BRIEF,
		TEDI_NOVA,
		"Meeting brief",
		"meeting-brief",
		"Prepare a one-page brief before each owner sync.",
		"active",
		9,
		0,
	),
];

const skillRunSummary = (run: SkillRunRow) => ({
	id: run.id,
	organizationId: ORG_ID,
	skillId: run.skillId,
	tediId: run.tediId,
	workflowInstanceId: `wf-${run.id.slice(0, 8)}`,
	runtimeEnvironment: "development" as const,
	lastReconciledAt: T5,
	executionEpoch: run.executionEpoch,
	restartRequestedAt: null,
	workflowRetiredAt: null,
	status: run.status,
	skillSlug: run.skillSlug,
	skillRevision: 3,
	startedAt: run.startedAt,
	completedAt: run.completedAt,
	pausedAt: null,
	createdBy: run.createdBy,
	hasResult: run.status === "completed",
	hasError: run.error !== null,
	outcome: run.status === "completed" ? ("delivered" as const) : null,
	workItemId: null,
});

const runtimeProvenanceNulls = {
	workerVersionId: null,
	workerVersionTag: null,
	workerVersionTimestamp: null,
	executionCompatibilityHash: null,
	dispatchShimVersion: null,
	compatibilityDate: null,
	dynamicWorkflowsVersion: null,
	loaderConfigHash: null,
	tenantCpuMs: null,
	tenantSubRequests: null,
};

const workflowDefinitionOperatorSurface = {
	namespace: "skills" as const,
	runTool: "run_skill_workflow",
	statusTool: "run_workflow_status",
	historyTool: "run_workflow_history",
	revisionsTool: "list_workflow_revisions",
	mutationMode: "governed_skill_revision" as const,
	mutationTool: "improve_skills",
};

const WORKFLOW_DEFINITIONS = [
	{
		kind: "static_platform" as const,
		id: "platform:memory_reflection",
		title: "Memory reflection",
		description: "Nightly brain reflection over the day's runtime evidence",
		engine: "cloudflare_workflows" as const,
		binding: "MEMORY_REFLECTION_WORKFLOW",
		entrypoint: "MemoryReflectionWorkflow",
		triggers: ["cron:0 7 * * *"],
		operatorSurface: {
			namespace: "workflows" as const,
			runTool: null,
			statusTool: "get_workflow_status",
			historyTool: "list_workflow_runs",
			revisionsTool: null,
			mutationMode: "deploy_main" as const,
			mutationTool: null,
		},
		scope: "platform" as const,
		ownerKind: "platform" as const,
		sourceKind: "deployed_entrypoint" as const,
		workflowType: "memory_reflection" as const,
		lifecycleState: "active" as const,
	},
	{
		kind: "dynamic_skill" as const,
		id: `skill:${SKILL_REVENUE}`,
		title: "Weekly revenue report",
		description: "Assembles the weekly revenue sheet and narrative",
		engine: "cloudflare_workflows" as const,
		binding: "SKILL_WORKFLOW",
		entrypoint: "SkillWorkflow",
		triggers: ["cron:0 13 * * 1"],
		operatorSurface: workflowDefinitionOperatorSurface,
		scope: "organization" as const,
		ownerKind: "tenant" as const,
		sourceKind: "revisioned_skill_source" as const,
		skillId: SKILL_REVENUE,
		skillSlug: "weekly-revenue-report",
		skillRevision: 3,
		tediId: TEDI_MILES,
		lifecycleState: "proven" as const,
		updatedAt: T4,
	},
	{
		kind: "dynamic_skill" as const,
		id: `skill:${SKILL_CHURN}`,
		title: "Churn watch",
		description: "Daily churn-cohort scan with account flags",
		engine: "cloudflare_workflows" as const,
		binding: "SKILL_WORKFLOW",
		entrypoint: "SkillWorkflow",
		triggers: ["cron:0 6 * * *"],
		operatorSurface: workflowDefinitionOperatorSurface,
		scope: "organization" as const,
		ownerKind: "tenant" as const,
		sourceKind: "revisioned_skill_source" as const,
		skillId: SKILL_CHURN,
		skillSlug: "churn-watch",
		skillRevision: 3,
		tediId: TEDI_MILES,
		lifecycleState: "draft" as const,
		updatedAt: T3,
	},
];

const WORKFLOW_HEALTH = [
	{
		definitionId: "platform:memory_reflection",
		title: "Memory reflection",
		kind: "static_platform" as const,
		lifecycleState: "active",
		currentRevision: null,
		healthStatus: "healthy" as const,
		driftStatus: "not_applicable" as const,
		executionSurface: {
			kind: "platform_workflow_binding" as const,
			binding: "MEMORY_REFLECTION_WORKFLOW",
			available: true,
			checkedAt: T5,
		},
		latestRun: {
			id: fid("22", 1),
			status: "completed" as const,
			startedAt: T2,
			completedAt: T2,
			observedRevision: null,
			lastReconciledAt: T5,
			source: "workflow_run_ledger" as const,
		},
		notes: [],
	},
	{
		// Literal, not the contract helper: this module is loaded by vite.config.ts
		// under raw Node, where package subpaths do not resolve. local-fixtures.test.ts
		// asserts these equal dynamicSkillDefinitionId(...) so they cannot drift.
		definitionId: `dynamic-skill:${SKILL_REVENUE}`,
		title: "Weekly revenue report",
		kind: "dynamic_skill" as const,
		lifecycleState: "proven",
		currentRevision: 3,
		healthStatus: "active" as const,
		driftStatus: "in_sync" as const,
		executionSurface: {
			kind: "skill_runtime_service" as const,
			binding: "SKILL_WORKFLOW",
			available: true,
			checkedAt: T5,
		},
		latestRun: {
			id: RUN_REVENUE_LIVE,
			status: "running" as const,
			startedAt: T4,
			completedAt: null,
			observedRevision: 3,
			lastReconciledAt: T5,
			source: "skill_runs_snapshot" as const,
		},
		notes: [],
	},
	{
		definitionId: `dynamic-skill:${SKILL_CHURN}`,
		title: "Churn watch",
		kind: "dynamic_skill" as const,
		lifecycleState: "draft",
		currentRevision: 3,
		healthStatus: "attention" as const,
		driftStatus: "in_sync" as const,
		executionSurface: {
			kind: "skill_runtime_service" as const,
			binding: "SKILL_WORKFLOW",
			available: true,
			checkedAt: T5,
		},
		latestRun: {
			id: RUN_CHURN_FAILED,
			status: "failed" as const,
			startedAt: T2,
			completedAt: T3,
			observedRevision: 3,
			lastReconciledAt: T5,
			source: "skill_runs_snapshot" as const,
		},
		notes: ["Last run failed: crm.list_accounts timed out"],
	},
];

const SCHEDULES = [
	{
		id: fid("23", 1),
		organizationId: ORG_ID,
		skillId: SKILL_REVENUE,
		tediId: TEDI_MILES,
		cron: "0 13 * * 1",
		params: { period: "last_7_days" },
		enabled: true,
		nextFireAt: "2026-08-17T13:00:00.000Z",
		lastFireAt: T1,
		lastRunId: RUN_REVENUE_OK,
		lastError: null,
		lastBudgetBlockedAt: null,
		lastBudgetBlockedReason: null,
		lastBudgetResetAt: null,
		lastBudgetAdmissionClass: null,
		createdAt: T0,
		updatedAt: T4,
	},
	{
		id: fid("23", 2),
		organizationId: ORG_ID,
		skillId: SKILL_CHURN,
		tediId: TEDI_MILES,
		cron: "0 6 * * *",
		params: {},
		enabled: true,
		nextFireAt: "2026-08-13T06:00:00.000Z",
		lastFireAt: T2,
		lastRunId: RUN_CHURN_FAILED,
		lastError: "MCP call crm.list_accounts timed out after 15s",
		lastBudgetBlockedAt: null,
		lastBudgetBlockedReason: null,
		lastBudgetResetAt: null,
		lastBudgetAdmissionClass: null,
		createdAt: T0,
		updatedAt: T3,
	},
	// Budget governance suppressing a cadence: the schedule is enabled and
	// healthy, but admission denied the fire. This is a governed pause with its
	// own reset evidence, never a run failure.
	{
		id: fid("23", 3),
		organizationId: ORG_ID,
		skillId: SKILL_BRIEF,
		tediId: TEDI_NOVA,
		cron: "*/30 * * * *",
		params: {},
		enabled: true,
		nextFireAt: "2026-08-13T09:00:00.000Z",
		lastFireAt: T4,
		lastRunId: null,
		lastError: null,
		lastBudgetBlockedAt: T5,
		lastBudgetBlockedReason:
			"Daily background inference budget exhausted for this workspace",
		lastBudgetResetAt: "2099-01-01T00:00:00.000Z",
		lastBudgetAdmissionClass: "background" as const,
		createdAt: T0,
		updatedAt: T5,
	},
];

const rationaleRecord = (
	n: number,
	tediId: string,
	action: string,
	rationale: string,
	category: string,
	outcomeStatus: "pending" | "success" | "failure" | "partial" | "unverified",
	runId: string | null,
	createdAt: string,
) => ({
	id: fid("72", n),
	tediId,
	orgId: ORG_ID,
	action,
	rationale,
	category,
	confidence: 0.5 + (n % 5) * 0.1,
	evidence: { source: "local-fixture" },
	outcome:
		outcomeStatus === "pending"
			? null
			: outcomeStatus === "failure"
				? "Did not complete as planned"
				: "Completed as planned",
	outcomeStatus,
	approvalRequestId: null,
	objectiveId: null,
	runId,
	workItemId: null,
	toolCallRefs: null,
	proofRef:
		outcomeStatus === "success"
			? { kind: "run" as const, ref: runId ?? RUN_REVENUE_OK }
			: null,
	createdAt,
	completedAt: outcomeStatus === "pending" ? null : createdAt,
	blameChain: null,
});

const RATIONALES = [
	rationaleRecord(
		1,
		TEDI_MILES,
		"Publish week-32 revenue summary",
		"Weekly cadence hit; order data reconciled against the ledger before publishing.",
		"content",
		"success",
		RUN_REVENUE_OK,
		T2,
	),
	rationaleRecord(
		2,
		TEDI_MILES,
		"Retry churn scan with a smaller account page",
		"CRM listing timed out at 500 accounts; halving the page should fit the tool budget.",
		"recovery",
		"pending",
		RUN_CHURN_FAILED,
		T3,
	),
	rationaleRecord(
		3,
		TEDI_JUNO,
		"Escalate ticket #4821 to a goodwill credit",
		"Second delay on the same order; policy allows credits under 200 MXN with approval.",
		"custom",
		"pending",
		null,
		T4,
	),
	rationaleRecord(
		4,
		TEDI_NOVA,
		"Move owner sync brief to Monday 08:00",
		"Owner reads briefs before the revenue check-in; earlier delivery doubles read rate.",
		"optimization",
		"success",
		HOME_RUN_DONE,
		T4,
	),
	rationaleRecord(
		5,
		TEDI_MILES,
		"Skip wholesale discount adjustment",
		"Churn cohort still unstable; changing pricing now would confound the win-back test.",
		"config_change",
		"unverified",
		null,
		T4,
	),
	rationaleRecord(
		6,
		TEDI_JUNO,
		"Auto-close stale duplicate tickets",
		"Duplicate detector confidence exceeded 0.9 on 6 threads.",
		"health_check",
		"failure",
		null,
		T5,
	),
];

const knowledgeEntry = (
	n: number,
	title: string,
	content: string,
	entryType: "insight" | "pattern" | "anti_pattern" | "convention" | "decision",
	tediId: string | null,
) => ({
	id: fid("73", n),
	organizationId: ORG_ID,
	tediId,
	domainId: null,
	title,
	content,
	entryType,
	sourceFactIds: null,
	sourceCount: 3 + n,
	confidence: 0.7 + (n % 3) * 0.08,
	revision: 1,
	revisionReasoning: null,
	supersedesId: null,
	visibility: "org" as const,
	tags: ["local-fixture"],
	lastValidatedAt: T4,
	createdAt: T0,
	updatedAt: T4,
});

const KNOWLEDGE = [
	knowledgeEntry(
		1,
		"Monday follow-ups double wholesale renewals",
		"Wholesale accounts contacted on Monday renew at 2x the baseline rate across 8 observed cycles.",
		"insight",
		TEDI_MILES,
	),
	knowledgeEntry(
		2,
		"Answer refunds before shipping questions",
		"Refund threads escalate within 4 hours when unanswered; shipping questions tolerate a day.",
		"pattern",
		TEDI_JUNO,
	),
	knowledgeEntry(
		3,
		"Never adjust pricing during an active cohort test",
		"Price changes mid-test confounded two prior churn experiments.",
		"anti_pattern",
		TEDI_MILES,
	),
	knowledgeEntry(
		4,
		"Owner briefs are one page, metrics first",
		"Briefs longer than one page go unread; lead with the three headline metrics.",
		"convention",
		TEDI_NOVA,
	),
	knowledgeEntry(
		5,
		"Hold wholesale discount at 12%",
		"Decided 2026-08-11: keep the wholesale discount until the churn cohort stabilizes.",
		"decision",
		null,
	),
];

/**
 * Tool telemetry source rows. `cognitiveRuntime.listEvents` filters by ONE
 * kind, so the OS issues a completed read and a failed read and merges them;
 * a fixture that ignored `kind` would make that union meaningless and hide a
 * real filter bug.
 */
const toolEvent = (
	n: number,
	tediId: string,
	kind: "tool.completed" | "tool.failed",
	name: string,
	latencyMs: number,
	createdAt: string,
	error: string | null,
) => ({
	id: fid("78", n),
	tediId,
	kind,
	conversationId: CONVERSATION_HOME,
	runId: RUN_REVENUE_OK,
	toolCallId: `call-${n}`,
	sequence: n,
	payload: {
		name,
		latencyMs,
		...(error === null ? {} : { error }),
	},
	createdAt,
});

const TOOL_EVENTS = [
	toolEvent(1, TEDI_MILES, "tool.completed", "list_orders", 840, T2, null),
	toolEvent(2, TEDI_MILES, "tool.completed", "list_orders", 1240, T3, null),
	toolEvent(3, TEDI_MILES, "tool.completed", "publish_report", 2100, T4, null),
	toolEvent(
		4,
		TEDI_MILES,
		"tool.failed",
		"list_accounts",
		15_020,
		T3,
		"Upstream CRM timed out after 15s",
	),
	toolEvent(5, TEDI_NOVA, "tool.completed", "get_owner_brief", 410, T4, null),
	toolEvent(6, TEDI_NOVA, "tool.completed", "list_work_items", 620, T5, null),
	toolEvent(
		7,
		TEDI_JUNO,
		"tool.failed",
		"send_credit",
		980,
		T5,
		"Approval required before issuing a goodwill credit",
	),
	toolEvent(8, TEDI_JUNO, "tool.completed", "list_tickets", 730, T5, null),
];

/** Per-domain expertise, keyed by tedi. Unnamed domains are modeled too. */
const expertiseEntry = (
	n: number,
	tediId: string,
	domainName: string | null,
	factCount: number,
	avgConfidence: number,
	competenceScore: number,
	expertiseLevel: "novice" | "familiar" | "proficient" | "expert",
) => ({
	id: fid("79", n),
	tediId,
	domainId: fid("7a", n),
	domainName,
	factCount,
	avgConfidence,
	competenceScore,
	expertiseLevel,
	lastActivityAt: T4,
	createdAt: T0,
	updatedAt: T4,
});

const EXPERTISE = [
	expertiseEntry(1, TEDI_MILES, "revenue-reporting", 84, 0.86, 0.79, "expert"),
	expertiseEntry(2, TEDI_MILES, "churn-analysis", 41, 0.71, 0.58, "proficient"),
	expertiseEntry(3, TEDI_MILES, null, 6, 0.52, 0.24, "novice"),
	expertiseEntry(4, TEDI_NOVA, "owner-briefing", 62, 0.83, 0.72, "proficient"),
	expertiseEntry(5, TEDI_JUNO, "support-triage", 55, 0.78, 0.66, "proficient"),
];

const growthSnapshot = (tediId: string) => ({
	id: fid("7b", 1),
	tediId,
	orgId: ORG_ID,
	snapshotDate: "2026-08-10",
	metrics: {
		facts: 128,
		avgConfidence: 0.82,
		skills: 14,
		avgRevision: 2.1,
		muscles: 5,
		avgUsage: 11.4,
		// Deliberately one MORE than the live expertise read returns for Miles,
		// so the snapshot-drift caption is exercised rather than dead code.
		domains: 4,
		autonomyRate: 0.64,
		expertiseLevels: { "revenue-reporting": "expert" },
	},
	createdAt: T0,
});

/**
 * Knowledge-map projection. `meta` rides along with the nodes, so the caveat
 * the OS renders describes the exact snapshot drawn rather than a second,
 * later health read.
 */
const KNOWLEDGE_GRAPH = {
	nodes: [
		{
			id: fid("7a", 1),
			label: "revenue-reporting",
			type: "domain" as const,
			properties: { factCount: 84 },
		},
		{
			id: fid("7a", 2),
			label: "churn-analysis",
			type: "domain" as const,
			properties: { factCount: 41 },
		},
		{
			id: fid("7c", 1),
			label: "Monday follow-ups double wholesale renewals",
			type: "knowledge_entry" as const,
			properties: { confidence: 0.86 },
		},
		{
			id: fid("7c", 2),
			label: "Weekly revenue summary",
			type: "skill" as const,
			properties: { revision: 3 },
		},
		{
			id: fid("7d", 1),
			label: "Wholesale renewals convert 2x on Monday",
			type: "fact" as const,
			properties: { confidence: 0.77 },
		},
		{
			id: fid("7d", 2),
			label: "CRM listing times out past 500 accounts",
			type: "fact" as const,
			properties: { confidence: 0.91 },
		},
		{
			id: fid("7d", 3),
			label: "Churn cohort is unstable this week",
			type: "fact" as const,
			properties: { confidence: 0.64 },
		},
		{
			id: fid("7e", 1),
			label: "Publish week-32 revenue summary",
			type: "decision" as const,
			properties: { outcomeStatus: "success" },
		},
	],
	edges: [
		{
			source: fid("7a", 1),
			target: fid("7d", 1),
			type: "HAS_FACT",
			properties: {},
		},
		{
			source: fid("7a", 2),
			target: fid("7d", 3),
			type: "HAS_FACT",
			properties: {},
		},
		{
			source: fid("7a", 2),
			target: fid("7d", 2),
			type: "HAS_FACT",
			properties: {},
		},
		{
			source: fid("7c", 1),
			target: fid("7d", 1),
			type: "DERIVED_FROM",
			properties: {},
		},
		{
			source: fid("7c", 2),
			target: fid("7a", 1),
			type: "OPERATES_ON",
			properties: {},
		},
		{
			source: fid("7e", 1),
			target: fid("7d", 1),
			type: "GROUNDED_IN",
			properties: {},
		},
		// An edge whose target is outside the returned node set: the OS must
		// report it as unresolved rather than draw a box with no meaning.
		{
			source: fid("7e", 1),
			target: fid("7d", 9),
			type: "GROUNDED_IN",
			properties: {},
		},
	],
	meta: {
		graphConfigured: true,
		graphHealthy: true,
		projectionState: "ready" as const,
		projectionReady: true,
		projectionReason: null,
		persistedWatermark: 1840,
		gdsWatermark: 1840,
		degraded: false,
		source: "neo4j" as const,
	},
};

const MEMORY_HEALTH = {
	totalFacts: 412,
	activeFacts: 371,
	archivedFacts: 41,
	totalGaps: 9,
	totalOpinions: 23,
	totalEdges: 640,
	totalDomains: 6,
	avgConfidence: 0.81,
	orphanRatio: 0.06,
	staleFacts: 14,
	contradictions: 2,
	curiosityQueue: { queued: 4, exploring: 1, completedTotal: 37 },
};

const auditEvent = (
	n: number,
	actorId: string,
	actorType:
		| "user"
		| "service"
		| "tedi"
		| "m2m"
		| "api_key"
		| "anonymous"
		| "external_agent"
		| "kernel",
	action: string,
	resourceType: string,
	resourceId: string | null,
	timestamp: string,
) => ({
	id: fid("74", n),
	organizationId: ORG_ID,
	actorId,
	actorType,
	action,
	resourceType,
	resourceId,
	metadata: null,
	ipAddress: null,
	userAgent: null,
	timestamp,
});

const AUDIT_EVENTS = [
	auditEvent(
		1,
		"dev-operator",
		"user",
		"workspace.created",
		"workspace",
		WORKSPACE_REVENUE,
		T0,
	),
	auditEvent(
		2,
		TEDI_MILES,
		"tedi",
		"output.created",
		"output",
		OUTPUT_SHEET,
		T1,
	),
	auditEvent(
		3,
		TEDI_MILES,
		"tedi",
		"output.revised",
		"output",
		OUTPUT_DOCUMENT,
		T1,
	),
	auditEvent(
		4,
		"dev-operator",
		"user",
		"blueprint.published",
		"blueprint",
		BLUEPRINT_PUBLISHED,
		T1,
	),
	auditEvent(
		5,
		TEDI_MILES,
		"tedi",
		"skill_run.completed",
		"skill_run",
		RUN_REVENUE_OK,
		T2,
	),
	auditEvent(
		6,
		TEDI_MILES,
		"tedi",
		"skill_run.failed",
		"skill_run",
		RUN_CHURN_FAILED,
		T3,
	),
	auditEvent(
		7,
		"kernel",
		"kernel",
		"tool.called",
		"tool_call",
		"list_orders",
		T4,
	),
	auditEvent(
		8,
		TEDI_JUNO,
		"tedi",
		"approval.requested",
		"approval",
		fid("71", 2),
		T5,
	),
	auditEvent(
		9,
		"dev-operator",
		"user",
		"conversation.created",
		"conversation",
		CONVERSATION_HOME,
		T0,
	),
	auditEvent(
		10,
		"ci-deployer",
		"service",
		"app.updated",
		"app",
		APP_STOREFRONT,
		T2,
	),
	auditEvent(
		11,
		TEDI_NOVA,
		"tedi",
		"work_item.completed",
		"work_item",
		fid("70", 4),
		T4,
	),
	auditEvent(
		12,
		"dev-operator",
		"api_key",
		"connection.connected",
		"connection",
		"gmail",
		T4,
	),
];

const workItem = (
	n: number,
	title: string,
	status:
		| "candidate"
		| "accepted"
		| "todo"
		| "claimed"
		| "in_progress"
		| "in_review"
		| "blocked"
		| "done"
		| "cancelled"
		| "stale",
	assigneeTediId: string | null,
	priority: "critical" | "high" | "medium" | "low",
	createdAt: string,
	projectKey = "OPS",
) => ({
	id: fid("70", n),
	orgId: ORG_ID,
	title,
	description: null,
	disposition:
		status === "done"
			? ("completed" as const)
			: status === "cancelled"
				? ("cancelled" as const)
				: ["candidate", "todo"].includes(status)
					? ("proposed" as const)
					: ("accepted" as const),
	workKind:
		title.toLowerCase().includes("query") ||
		title.toLowerCase().includes("wire") ||
		title.toLowerCase().includes("widget")
			? ("coding" as const)
			: title.toLowerCase().includes("policy")
				? ("legal" as const)
				: ("communication" as const),
	riskLevel:
		priority === "critical"
			? ("critical" as const)
			: priority === "high"
				? ("high" as const)
				: ("medium" as const),
	acceptanceContract: ["candidate", "todo"].includes(status)
		? null
		: {
				version: 1 as const,
				doneLooksLike: "The named outcome is delivered",
			},
	requiredCapabilities: [],
	requiredAuthorities: [],
	resourceScopes: [],
	budgetLimitMicros: null,
	priority,
	accountableOwnerType: assigneeTediId ? ("tedi" as const) : null,
	accountableOwnerId: assigneeTediId,
	stewardType: assigneeTediId ? ("tedi" as const) : null,
	stewardId: assigneeTediId,
	reviewerType: "user" as const,
	reviewerId: "local-owner",
	reviewerLeaseExpiresAt: null,
	objectiveId: null,
	workClass: "objective" as const,
	purposeExceptionExpiresAt: null,
	projectId: projectKey === "GROWTH" ? fid("76", 2) : fid("76", 1),
	parentWorkItemId: null,
	sourceSessionKey: null,
	sourceIntentId: null,
	dueDate: null,
	deadline: null,
	startAt: null,
	durationDays: null,
	provenance: null,
	metadata: null,
	admissionSpecRevision: `local-fixture-revision-${n}`,
	createdAt,
	updatedAt: createdAt,
	acceptedAt: ["candidate", "todo"].includes(status) ? null : createdAt,
	completedAt: status === "done" ? T4 : null,
	cancelledAt: status === "cancelled" ? T4 : null,
	version: 1,
});

const WORK_ITEMS = [
	workItem(
		1,
		"Rebuild the churn cohort query with paging",
		"in_progress",
		TEDI_MILES,
		"high",
		T3,
	),
	workItem(
		2,
		"Draft goodwill-credit policy for delayed orders",
		"blocked",
		TEDI_JUNO,
		"medium",
		T4,
	),
	workItem(
		3,
		"Wire the investor deck into the owner sync brief",
		"todo",
		TEDI_NOVA,
		"low",
		T4,
		"GROWTH",
	),
	workItem(
		4,
		"Publish week-32 revenue summary",
		"done",
		TEDI_MILES,
		"medium",
		T1,
	),
	workItem(
		5,
		"Review the dunning-recovery email copy",
		"in_review",
		TEDI_JUNO,
		"medium",
		T5,
		"GROWTH",
	),
	workItem(
		6,
		"Backfill wholesale order attribution",
		"todo",
		TEDI_MILES,
		"critical",
		T2,
	),
	workItem(7, "Ship the churn dashboard widget", "todo", TEDI_NOVA, "high", T3),
	// Deliberate near-duplicate of item 5 — the coherence report's evidence.
	workItem(
		8,
		"Review the dunning recovery email copy",
		"todo",
		TEDI_JUNO,
		"low",
		T5,
		"GROWTH",
	),
];

const workItemId = (n: number) => fid("70", n);

// ---------------------------------------------------------------------------
// Work graph: projects, dependency edges, and the derived diagnostic reads.
// The reports are DERIVED from WORK_ITEMS/WORK_ITEM_RELATIONS rather than
// hand-frozen, so editing an item cannot leave the diagnostics describing a
// board that no longer exists.
// ---------------------------------------------------------------------------

const project = (
	n: number,
	key: string,
	name: string,
	status: "active" | "paused" | "archived" | "done",
	archivedAt: string | null = null,
) => ({
	id: fid("76", n),
	orgId: ORG_ID,
	key,
	name,
	description: null,
	status,
	leadTediId: null,
	ownerUserId: null,
	objectiveId: null,
	targetDate: null,
	metadata: null,
	createdAt: T0,
	updatedAt: T4,
	archivedAt,
});

const PROJECTS = [
	project(1, "OPS", "Platform operations", "active"),
	project(2, "GROWTH", "Growth experiments", "active"),
	project(3, "LEGACY", "Wind-down", "archived", T1),
];

const relation = (
	n: number,
	from: number,
	to: number,
	relationType: "blocks" | "duplicates" | "references",
) => ({
	id: fid("77", n),
	fromWorkItemId: workItemId(from),
	toWorkItemId: workItemId(to),
	relationType,
	createdAt: T2,
});

const WORK_ITEM_RELATIONS = [
	relation(1, 6, 1, "blocks"),
	relation(2, 1, 7, "blocks"),
	relation(3, 6, 2, "blocks"),
	relation(4, 5, 3, "references"),
];

const TERMINAL_DISPOSITIONS = new Set(["completed", "cancelled"]);

/** Ordering edges in dependency direction (blocker → dependent). */
const ORDERING_EDGES = WORK_ITEM_RELATIONS.flatMap((row) => {
	if (row.relationType === "blocks") {
		return [{ blocker: row.fromWorkItemId, dependent: row.toWorkItemId }];
	}
	return [];
});

const workItemsInScope = (projectId?: string) =>
	WORK_ITEMS.filter(
		(row) => projectId === undefined || row.projectId === projectId,
	);

const orgGraphHealthFor = (projectId: string | undefined, limit: number) => {
	const scoped = workItemsInScope(projectId);
	const ids = new Set(scoped.map((row) => row.id));
	const edges = ORDERING_EDGES.filter(
		(edge) => ids.has(edge.blocker) && ids.has(edge.dependent),
	);
	const downstream = new Map<string, string[]>();
	const hasIncoming = new Set(edges.map((edge) => edge.dependent));
	for (const edge of edges) {
		downstream.set(edge.blocker, [
			...(downstream.get(edge.blocker) ?? []),
			edge.dependent,
		]);
	}
	const reach = (id: string): number => {
		const seen = new Set<string>();
		const queue = [...(downstream.get(id) ?? [])];
		while (queue.length > 0) {
			const next = queue.shift();
			if (next === undefined || seen.has(next)) continue;
			seen.add(next);
			queue.push(...(downstream.get(next) ?? []));
		}
		return seen.size;
	};
	const nonTerminal = scoped.filter(
		(row) => !TERMINAL_DISPOSITIONS.has(row.disposition),
	);
	const rootBlockers = nonTerminal
		.filter(
			(row) =>
				!hasIncoming.has(row.id) && (downstream.get(row.id) ?? []).length > 0,
		)
		.map((row) => ({
			id: row.id,
			title: row.title,
			disposition: row.disposition,
			ownerTediId: row.accountableOwnerId,
			downstreamBlockedCount: reach(row.id),
		}))
		.sort((a, b) => b.downstreamBlockedCount - a.downstreamBlockedCount)
		.slice(0, limit);
	const blockerTedis = [
		...new Map(
			rootBlockers
				.filter((row) => row.ownerTediId !== null)
				.map((row) => [
					row.ownerTediId as string,
					{
						tediId: row.ownerTediId as string,
						rootBlockerCount: 1,
						downstreamImpact: row.downstreamBlockedCount,
					},
				]),
		).values(),
	];
	const statusBlocked = nonTerminal
		.filter((row) => row.disposition === "accepted")
		.map((row) => ({
			id: row.id,
			title: row.title,
			priority: row.priority,
			ownerTediId: row.accountableOwnerId,
			ageHours: 31,
		}));
	return {
		orgId: ORG_ID,
		generatedAt: T5,
		limit,
		rootBlockers,
		blockerTedis,
		capabilityStall: [],
		capabilityLinksAvailable: false,
		statusBlocked,
		counts: {
			totalNonTerminal: nonTerminal.length,
			blockedCount: new Set(edges.map((edge) => edge.dependent)).size,
			statusBlockedCount: statusBlocked.length,
			rootBlockerCount: rootBlockers.length,
			scannedCount: edges.length,
			truncated: false,
		},
		notes: ["Capability links are not populated in the local lane."],
	};
};

/**
 * Coherence report. Org-wide by design: the canonical read scopes by canonical
 * projectId only, and these fixture items carry a project_key with a null
 * project_id — exactly the production shape the OS caption warns about.
 */
const WORK_GRAPH_HEALTH = {
	orgId: ORG_ID,
	projectId: null,
	generatedAt: T5,
	idleThresholdDays: 14,
	dupThreshold: 0.85,
	scannedCount: WORK_ITEMS.length,
	duplicates: [
		{
			canonicalWorkItemId: workItemId(5),
			duplicateWorkItemIds: [workItemId(8)],
			workItemIds: [workItemId(5), workItemId(8)],
			normalizedTitle: "review the dunning recovery email copy",
			method: "jaccard" as const,
			suggestedAction: "link_duplicates" as const,
		},
	],
	idleAccepted: [
		{
			workItemId: workItemId(3),
			title: "Wire the investor deck into the owner sync brief",
			disposition: "accepted" as const,
			readiness: "ready" as const,
			lastActivityAt: T1,
			idleDays: 21,
			suggestedAction: "review_idle" as const,
		},
	],
	naming: [],
	expiredAttempts: [
		{
			workItemId: workItemId(7),
			attemptId: fid("79", 1),
			executorType: "tedi" as const,
			executorId: TEDI_NOVA,
			executorSessionId: null,
			expiresAt: T3,
			suggestedAction: "flag" as const,
		},
	],
	counts: {
		duplicateClusters: 1,
		duplicateItems: 2,
		idleAccepted: 1,
		naming: 0,
		expiredAttempts: 1,
	},
	truncated: {
		scan: false,
		idleAccepted: false,
		expiredAttempts: false,
	},
};

/**
 * Owner brief. The charter is human-owned; the drift block is the
 * deterministic verdict measured against it.
 */
const OWNER_BRIEF = {
	generatedAt: T5,
	purposeCharter: {
		id: fid("78", 1),
		orgId: ORG_ID,
		version: 3,
		status: "active" as const,
		purpose:
			"Give this organization digital workers it truly owns: durable, governed operators that execute, learn from outcomes, and stay steerable without constant supervision.",
		principles: [
			"Evidence over assertion — every decision cites what it was based on.",
			"Reversible first: prefer the change that can be undone cheaply.",
		],
		strategicTheses: [
			"Owned memory compounds; rented context does not.",
			"Governance is a product surface, not a compliance afterthought.",
		],
		nonGoals: [
			"No unsupervised spend outside an approved budget.",
			"No customer data leaves the tenant boundary.",
		],
		evidenceRefs: [],
		reviewCadenceDays: 30,
		revisionReason: "Sharpened the red lines after the Q3 budget review",
		createdByUserId: null,
		createdAt: T1,
		activatedAt: T1,
		supersededAt: null,
	},
	needsJudgment: [
		{
			id: workItemId(2),
			title: "Draft goodwill-credit policy for delayed orders",
			kind: "decision" as const,
			reason: "Blocked on an owner policy call: credit ceiling per order.",
			priority: "medium" as const,
			objectiveId: null,
			projectId: fid("76", 1),
			updatedAt: T4,
			blocking: true,
		},
	],
	exceptions: [
		{
			id: workItemId(6),
			title: "Backfill wholesale order attribution",
			kind: "exception" as const,
			reason: "Critical work with no linked objective for 6 days.",
			priority: "critical" as const,
			objectiveId: null,
			projectId: fid("76", 1),
			updatedAt: T2,
			blocking: false,
		},
	],
	outcomes: [
		{
			id: workItemId(4),
			title: "Publish week-32 revenue summary",
			kind: "outcome" as const,
			reason: "Completed against the revenue-visibility objective.",
			priority: "medium" as const,
			objectiveId: null,
			projectId: fid("76", 1),
			updatedAt: T4,
			blocking: false,
		},
	],
	drift: {
		severity: "watch" as const,
		activeObjectiveCount: 4,
		unlinkedObjectiveCount: 1,
		openWorkCount: 7,
		unlinkedOpenWorkCount: 2,
		activeOperationalExceptionCount: 1,
		expiredOperationalExceptionCount: 0,
		legacyUnclassifiedOpenWorkCount: 0,
		charterReviewOverdue: false,
		summary:
			"Two open work items carry no objective, and one active objective sits outside the charter.",
	},
};

const appListItem = (
	id: string,
	name: string,
	slug: string,
	description: string,
) => ({
	id,
	name,
	slug,
	domain: `${slug}.solstice.example`,
	description,
	logoUrl: null,
	visibility: "private" as const,
	discoveryStatus: "scraped" as const,
	customMcpDomain: null,
	appStoreStatus: null,
	createdAt: T0,
	updatedAt: T4,
});

const APPS = [
	appListItem(
		APP_STOREFRONT,
		"Storefront",
		"storefront",
		"Orders, subscriptions, and wholesale accounts",
	),
	appListItem(
		APP_SUPPORT,
		"Support Inbox",
		"support-inbox",
		"Ticket queue with SLA tracking",
	),
	appListItem(
		APP_FINANCE,
		"Finance Ledger",
		"finance-ledger",
		"Invoices, credits, and payout history",
	),
];

const appTool = (
	appId: string,
	n: number,
	toolId: string,
	title: string,
	description: string,
) => ({
	id: `${appId.slice(0, 8)}-tool-${n}`,
	toolId,
	toolTypeId: "mcp",
	title,
	description,
	inputSchema: { type: "object" as const, properties: {} },
	outputSchema: null,
	adapterScope: null,
	resultStrategy: null,
	outputTemplate: null,
	widgetKey: null,
	widgetRoute: null,
	widgetAccessible: null,
	authRequired: false,
	visibility: "public",
	icons: null,
	executionTaskSupport: null,
	annotations: null,
	meta: null,
	invocationStatus: null,
	fileParams: null,
	widgetDescription: null,
	widgetPrefersBorder: null,
	widgetDomain: null,
	config: null,
	schemaDialect: null,
	schemaSource: null,
	schemaSourceRef: null,
	schemaSourceHash: null,
	schemaSyncedAt: null,
	sortOrder: n,
	enabled: true,
	createdAt: T0,
	updatedAt: T4,
});

const APP_TOOLS: Record<string, ReturnType<typeof appTool>[]> = {
	[APP_STOREFRONT]: [
		appTool(
			APP_STOREFRONT,
			1,
			"list_orders",
			"List orders",
			"List recent orders with totals",
		),
		appTool(
			APP_STOREFRONT,
			2,
			"get_order",
			"Get order",
			"Fetch one order with line items",
		),
		appTool(
			APP_STOREFRONT,
			3,
			"list_subscriptions",
			"List subscriptions",
			"Active and lapsed subscriptions",
		),
	],
	[APP_SUPPORT]: [
		appTool(
			APP_SUPPORT,
			1,
			"list_tickets",
			"List tickets",
			"Open tickets ordered by SLA risk",
		),
		appTool(
			APP_SUPPORT,
			2,
			"reply_ticket",
			"Reply to ticket",
			"Send a reply on a ticket thread",
		),
	],
	[APP_FINANCE]: [
		appTool(
			APP_FINANCE,
			1,
			"list_invoices",
			"List invoices",
			"Invoices with payment status",
		),
		appTool(
			APP_FINANCE,
			2,
			"create_credit",
			"Create credit",
			"Issue a goodwill credit",
		),
	],
};

const fullApp = (item: (typeof APPS)[number]) => ({
	id: item.id,
	organizationId: ORG_ID,
	name: item.name,
	slug: item.slug,
	description: item.description,
	primaryDomain: item.domain,
	logoUrl: null,
	visibility: item.visibility,
	discoveryStatus: item.discoveryStatus,
	customMcpDomain: null,
	openaiChallengeToken: null,
	openaiAppId: null,
	appStoreStatus: null,
	activeConfigVersionId: null,
	latestConfigVersion: 1,
	metadata: null,
	extractedAt: null,
	aiSearchSyncedAt: null,
	createdAt: item.createdAt,
	updatedAt: item.updatedAt,
});

const ELIGIBILITY = [
	{
		appId: APP_STOREFRONT,
		appName: "Storefront",
		result: {
			eligible: true,
			degraded: false,
			missing: [],
			availableTools: ["list_orders", "get_order", "list_subscriptions"],
			unavailableTools: [],
		},
		badge: "ready" as const,
	},
	{
		appId: APP_SUPPORT,
		appName: "Support Inbox",
		result: {
			eligible: false,
			degraded: true,
			missing: [
				{
					type: "connector" as const,
					key: "gmail",
					detail: "Support inbox needs the Gmail connection re-authorized",
					resolution: {
						action: "connect" as const,
						label: "Reconnect Gmail",
						href: "/connections",
					},
				},
			],
			availableTools: ["list_tickets"],
			unavailableTools: [
				{
					name: "reply_ticket",
					reason: "Gmail connection expired",
					missing: [{ type: "connector" as const, key: "gmail" }],
				},
			],
		},
		badge: "setup_needed" as const,
	},
	{
		appId: APP_FINANCE,
		appName: "Finance Ledger",
		result: {
			eligible: true,
			degraded: false,
			missing: [],
			availableTools: ["list_invoices", "create_credit"],
			unavailableTools: [],
		},
		badge: "ready" as const,
	},
];

const CONNECTION_PROVIDERS = [
	{
		appId: "gmail",
		name: "Gmail",
		description: "Google Workspace mail",
		enabled: true,
		availableScopes: ["gmail.readonly", "gmail.send"],
		logoUrl: null,
		connectionType: "oauth" as const,
		registrationMode: "pre_registered" as const,
		tokenScope: "tenant" as const,
		supportedScopes: ["tenant" as const, "user" as const],
		recommendedScope: "tenant" as const,
		credentialProfile: null,
		referencedByOrg: true,
	},
	{
		appId: "notion",
		name: "Notion",
		description: "Workspace pages and databases",
		enabled: true,
		availableScopes: ["read_content", "update_content"],
		logoUrl: null,
		connectionType: "api_key" as const,
		registrationMode: null,
		tokenScope: "user" as const,
		supportedScopes: ["user" as const],
		recommendedScope: "user" as const,
		credentialProfile: null,
		referencedByOrg: false,
	},
];

const CONNECTIONS = [
	{
		appId: "gmail",
		providerName: "Gmail",
		status: "expired" as const,
		connectedAt: 1_754_000_000,
		tokenExpiresAt: 1_754_900_000,
		scopes: ["gmail.readonly", "gmail.send"],
		tokenScope: "tenant" as const,
		connectedByUserId: "dev-operator",
		connectedByEmail: "owner@solstice.example",
	},
	{
		appId: "notion",
		providerName: "Notion",
		status: "connected" as const,
		connectedAt: 1_754_500_000,
		tokenExpiresAt: null,
		scopes: ["read_content", "update_content"],
		tokenScope: "user" as const,
		connectedByUserId: "dev-operator",
		connectedByEmail: "owner@solstice.example",
	},
];

const ORG_MEMBERSHIP = {
	member: {
		id: fid("90", 1),
		organizationId: ORG_ID,
		descopeUserId: "dev-operator",
		email: "owner@solstice.example",
		name: "Local Operator",
		avatarUrl: null,
		role: "owner" as const,
		customPermissions: null,
		status: "active" as const,
		invitedAt: null,
		invitedBy: null,
		inviteAcceptedAt: null,
		lastActiveAt: T5,
		createdAt: T0,
		updatedAt: T5,
	},
	organizationId: ORG_ID,
	organizationName: "Solstice Coffee Co.",
	organizationSlug: "solstice",
	organizationLogoUrl: null,
	organizationType: "organization" as const,
	descopeTenantId: null,
	appsCount: 3,
	tediCount: 3,
	mcpGatewaySlug: "solstice",
	mcpGatewayUrl: "https://solstice.mcp.tedix.dev/mcp",
};

/** Org API keys for /admin/api-keys; raw keys never exist in a list read. */
const apiKeyRow = (
	n: number,
	name: string,
	overrides: Partial<{
		status: "active" | "revoked" | "expired";
		environment: "test" | "live";
		scopes: string[];
		lastUsedAt: string | null;
		revokedAt: string | null;
	}> = {},
) => ({
	id: fid("96", n),
	organizationId: ORG_ID,
	name,
	description: null,
	keyPreview: `sk_test_...${(1000 + n).toString(16)}`,
	scopes: overrides.scopes ?? ["apps:read", "analytics:read"],
	descopeClientId: null,
	environment: overrides.environment ?? ("test" as const),
	lastUsedAt: overrides.lastUsedAt ?? null,
	requestsThisMonth: 0,
	totalRequests: 0,
	ipAllowlist: null,
	expiresAt: null,
	status: overrides.status ?? ("active" as const),
	rotatedAt: null,
	rotationScheduleDays: null,
	previousKeyExpiresAt: null,
	revokedAt: overrides.revokedAt ?? null,
	revokedBy: null,
	revokeReason: null,
	metadata: null,
	createdBy: "dev-operator",
	createdAt: T0,
	updatedAt: T1,
});

const API_KEYS = [
	apiKeyRow(1, "CI/CD Pipeline", { environment: "live", lastUsedAt: T4 }),
	apiKeyRow(2, "Analytics export"),
	apiKeyRow(3, "Legacy importer", { status: "revoked", revokedAt: T2 }),
];

// --- MCP payment ledger fixtures (/admin/payments) ---

const MCP_PAYMENT_RECEIPT = fid("76", 1);

const mcpPaymentEvent = (
	n: number,
	overrides: {
		requirementId: string;
		eventType: "payment_required" | "payment_settled" | "payment_rejected";
		status: "required" | "settled" | "rejected";
		amount: string;
		settled: boolean;
		createdAt: string;
		budgetDecision?: Record<string, string | boolean>;
	},
) => ({
	id: n === 1 ? MCP_PAYMENT_RECEIPT : fid("76", n),
	requirementId: overrides.requirementId,
	eventType: overrides.eventType,
	status: overrides.status,
	protocol: "x402",
	mode: "mock",
	network: "base-sepolia",
	asset: "usdc",
	currency: "USDC",
	amount: overrides.amount,
	recipient: "0x1111111111111111111111111111111111111111",
	resource: null,
	appId: null,
	appSlug: "storefront",
	organizationId: ORG_ID,
	toolRowId: null,
	toolId: "generate_market_report",
	tediId: TEDI_MILES,
	userId: null,
	clientId: null,
	authType: "tedi",
	traceId: null,
	toolArgsHash: null,
	settled: overrides.settled,
	requirements: null,
	paymentProof: null,
	paymentResponse: overrides.settled ? { settlementId: "mock-1" } : null,
	budgetPolicy: overrides.budgetDecision ? { scope: "org" } : null,
	budgetDecision: overrides.budgetDecision ?? null,
	decisionRationale: null,
	auditEventId: null,
	rationaleRecordId: null,
	createdAt: overrides.createdAt,
});

const MCP_PAYMENT_EVENTS = [
	mcpPaymentEvent(1, {
		requirementId: "req-local-1",
		eventType: "payment_settled",
		status: "settled",
		amount: "0.25",
		settled: true,
		createdAt: T3,
		budgetDecision: {
			allowed: true,
			projected: "0.25",
			maxAmount: "5",
			currency: "USDC",
			scope: "org",
			mode: "enforce",
		},
	}),
	mcpPaymentEvent(2, {
		requirementId: "req-local-2",
		eventType: "payment_required",
		status: "required",
		amount: "0.25",
		settled: false,
		createdAt: T4,
	}),
];

const MCP_PAYMENT_POLICIES = [
	{
		id: fid("77", 1),
		organizationId: ORG_ID,
		tediId: null,
		appSlug: null,
		toolId: null,
		currency: "USDC",
		network: "base-sepolia",
		enabled: true,
		maxAmount: "5",
		maxTransactionAmount: null,
		allowedRecipients: null,
		allowedTools: null,
		windowSeconds: 86_400,
		mode: "enforce" as const,
		createdBy: null,
		updatedBy: null,
		createdAt: T1,
		updatedAt: T1,
	},
];

const callCostRow = (
	n: number,
	tediId: string,
	runId: string | null,
	model: string,
	costUsd: number,
	snapshotAt: string,
	// Literal, not the contract enum: this module is loaded by vite.config.ts
	// under raw Node, where package subpaths do not resolve. The ingestion job
	// writes exactly these three values (`tedi_call_costs.data_quality`).
	dataQuality: "ok" | "quarantined_no_pricing" | "quarantined_failed" = "ok",
) => ({
	providerCostEvidence: null,
	sourceRetired: false,
	costBasis:
		dataQuality === "quarantined_no_pricing"
			? ("unknown" as const)
			: ("legacy_estimate" as const),
	rateVersionId: null,
	costReason: null,
	executionId: null,
	rawReportedCostUsd: null,
	id: fid("75", n),
	tediId,
	snapshotAt,
	model,
	provider: "anthropic",
	providerResource: null,
	deployment: null,
	runId,
	workItemId: null,
	sessionKeyHash: null,
	sessionType: "tedi" as const,
	source: "ai-gateway",
	inputTokens: 12_400,
	outputTokens: 1_900,
	cacheReadTokens: 8_000,
	cacheWriteTokens: 0,
	totalTokens: 22_300,
	estimatedCostUsd: dataQuality === "quarantined_no_pricing" ? null : costUsd,
	dataQuality,
	sessionCount: 1,
	createdAt: snapshotAt,
});

const CALL_COSTS = [
	callCostRow(1, TEDI_MILES, RUN_REVENUE_OK, "claude-sonnet-4-5", 0.084, T2),
	callCostRow(2, TEDI_MILES, RUN_CHURN_FAILED, "claude-sonnet-4-5", 0.031, T3),
	callCostRow(3, TEDI_MILES, RUN_REVENUE_LIVE, "claude-sonnet-4-5", 0.012, T4),
	callCostRow(4, TEDI_JUNO, null, "claude-haiku-4-5", 0.006, T4),
	callCostRow(5, TEDI_NOVA, null, "claude-sonnet-4-5", 0.02, T4),
	// A quarantined row so the dev lane exercises the state a spend total must
	// never absorb: zero stored cost with real tokens, held out by ingestion.
	callCostRow(
		6,
		TEDI_NOVA,
		null,
		"claude-sonnet-4-5",
		0,
		T4,
		"quarantined_no_pricing",
	),
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Pagination = { limit?: number; offset?: number };

const paginate = <T>(rows: T[], input?: Pagination) => {
	const limit = input?.limit ?? 50;
	const offset = input?.offset ?? 0;
	return {
		data: rows.slice(offset, offset + limit),
		pagination: {
			limit,
			offset,
			total: rows.length,
			hasMore: offset + limit < rows.length,
		},
	};
};

const findWorkspace = (workspaceId: string): OsWorkspace => {
	const workspace = state.workspaces.find((row) => row.id === workspaceId);
	if (!workspace) throw new RpcError("NOT_FOUND", "Workspace not found");
	return workspace;
};

const findGadget = (workspaceId: string, gadgetId: string): OsGadget => {
	const gadget = state.gadgets.find(
		(row) => row.id === gadgetId && row.workspaceId === workspaceId,
	);
	if (!gadget) throw new RpcError("NOT_FOUND", "Gadget not found");
	return gadget;
};

const findOutput = (outputId: string): OsOutput => {
	const output = state.outputs.find((row) => row.id === outputId);
	if (!output) throw new RpcError("NOT_FOUND", "Output not found");
	return output;
};

const findCollaborationProposal = (
	proposalId: string,
): OsCollaborationProposal => {
	const proposal = state.collaborationProposals.find(
		(row) => row.id === proposalId,
	);
	if (!proposal) throw new RpcError("NOT_FOUND", "Proposal not found");
	return proposal;
};

const findBlueprint = (blueprintId: string): OsBlueprint => {
	const blueprint = state.blueprints.find((row) => row.id === blueprintId);
	if (!blueprint) throw new RpcError("NOT_FOUND", "Blueprint not found");
	return blueprint;
};

const latestRevision = <T extends { revision: number }>(rows: T[]): T | null =>
	rows.reduce<T | null>(
		(latest, row) =>
			latest === null || row.revision > latest.revision ? row : latest,
		null,
	);

const compactOutputPreviewText = (value: string): string =>
	value.replace(/\s+/g, " ").trim().slice(0, 240);

const localOutputLibraryItem = (
	output: OsOutput,
	revision: OsOutputRevision,
): OsOutputLibraryItem => {
	const content = revision.content;
	const preview: OsOutputLibraryItem["preview"] =
		content.kind === "document"
			? {
					kind: "document",
					lines: content.blocks
						.flatMap((block) =>
							block.type === "list" ? block.items : [block.text],
						)
						.map(compactOutputPreviewText)
						.filter(Boolean)
						.slice(0, 6),
					blockCount: content.blocks.length,
				}
			: content.kind === "sheet"
				? {
						kind: "sheet",
						columns: content.columns
							.slice(0, 6)
							.map((value) => value.slice(0, 80)),
						rows: content.rows
							.slice(0, 5)
							.map((row) =>
								row
									.slice(0, 6)
									.map((cell) =>
										typeof cell === "string"
											? compactOutputPreviewText(cell)
											: cell,
									),
							),
						rowCount: content.rows.length,
						columnCount: content.columns.length,
						sheetCount: content.workbook?.sheets.length ?? 1,
					}
				: content.kind === "video"
					? {
							kind: "video",
							mimeType: content.mimeType,
							...(content.caption
								? { caption: compactOutputPreviewText(content.caption) }
								: {}),
						}
					: {
							kind: "presentation",
							title: compactOutputPreviewText(content.slides[0]?.title ?? ""),
							bullets: (content.slides[0]?.bullets ?? [])
								.slice(0, 4)
								.map(compactOutputPreviewText),
							slideCount: content.slides.length,
						};
	const workspace = output.workspaceId
		? state.workspaces.find((row) => row.id === output.workspaceId)
		: null;
	return {
		output,
		workspace: workspace
			? { id: workspace.id, name: workspace.name, status: workspace.status }
			: null,
		currentRevision: {
			id: revision.id,
			revision: revision.revision,
			createdAt: revision.createdAt,
		},
		scope:
			output.createdByKind === "user" && output.createdById === "dev-operator"
				? "mine"
				: "organization",
		preview,
	};
};

const findSkillRun = (runId: string): SkillRunRow => {
	const run = state.skillRuns.find((row) => row.id === runId);
	if (!run) throw new RpcError("NOT_FOUND", "Skill run not found");
	return run;
};

const findConversation = (
	conversationId: string,
): HomeConversation & { hidden?: boolean } => {
	const conversation = state.conversations.find(
		(row) => row.id === conversationId,
	);
	if (!conversation) throw new RpcError("NOT_FOUND", "Conversation not found");
	return conversation;
};

const findHomeRun = (runId: string): HomeRun => {
	const run = state.homeRuns.find((row) => row.id === runId);
	if (!run) throw new RpcError("NOT_FOUND", "Run not found");
	return run;
};

const CANNED_REPLY =
	"Noted — I logged that in the Home journal. Everything on this surface is running against local fixture data, so nothing left your machine.";

// Synthetic catalog entries for local discovery and install-review validation.
const LOCAL_CATALOG = (
	[
		[
			"local-documents",
			"Documents",
			"Search documents and prepare a sourced team briefing.",
		],
		[
			"local-projects",
			"Projects",
			"Review project tasks and prepare a weekly progress report.",
		],
	] as const
).map(
	([slug, name, description]) =>
		({
			modelDescription: null,
			baseUrl: null,
			mcpEndpointNormalized: null,
			toolSource: null,
			distributionChannel: null,
			developerType: null,
			status: null,
			website: null,
			privacyPolicy: null,
			termsOfService: null,
			logoUrl: null,
			logoUrlDark: null,
			screenshots: null,
			keywordsForDiscovery: null,
			keywordsForTriggering: null,
			hasInteractive: null,
			hasFileSearch: null,
			hasDeepResearch: null,
			hasSync: null,
			authTypes: null,
			mcpServerName: null,
			mcpServerVersion: null,
			mcpToolCount: null,
			mcpResourceCount: null,
			mcpPromptCount: null,
			mcpLastScannedAt: null,
			mcpInstructions: null,
			healthLastCheckedAt: null,
			healthConnectTimeMs: null,
			healthUptimePercent: null,
			healthErrorMessage: null,
			screenshotUrl: null,
			enrichedDescription: null,
			seoDescription: null,
			socialLinks: null,
			examplePrompts: null,
			categories: null,
			enrichedAt: null,
			lastSyncedAt: null,
			createdAt: null,
			updatedAt: null,
			sourceCreatedAt: null,
			id: slug,
			slug,
			name,
			description,
			connectorType: "MCP",
			category: "PRODUCTIVITY",
			developer: "Local fixture",
			healthStatus: "unknown",
			hasWrites: false,
			discoverability: { score: 0, label: "Low", criteria: [], tips: [] },
			quality: {
				score: 0,
				label: "Thin",
				status: "needs_review",
				logoStatus: "missing",
				sourceConfidence: "low",
				freshnessStatus: "unknown",
				signals: [],
			},
			installability: {
				installable: true,
				state: "installable",
				reason: "Synthetic local app for UI validation",
			},
			tools: [],
			resources: [],
			resourceTemplates: [],
			prompts: [],
			storeListings: [],
		}) satisfies CatalogAppDetail,
);

// --- Local agent session board (/work/agents) ---

type LocalAgentSessionState =
	| "needs_you"
	| "error"
	| "done"
	| "working"
	| "idle"
	| "ended";

/** One session per board state, aged relative to the request so times read live. */
const LOCAL_AGENT_SESSIONS: readonly {
	n: number;
	harness: "claude-code" | "codex";
	label: string;
	state: Exclude<LocalAgentSessionState, "idle">;
	effectiveState: LocalAgentSessionState;
	summary: string;
	minutesAgo: number;
}[] = [
	{
		n: 1,
		harness: "claude-code",
		label: "tedix · agent-status",
		state: "needs_you",
		effectiveState: "needs_you",
		summary:
			"Waiting for approval to run the D1 migration against the local database before continuing with the board.",
		minutesAgo: 3,
	},
	{
		n: 2,
		harness: "codex",
		label: "acme-books · invoices",
		state: "needs_you",
		effectiveState: "needs_you",
		summary: "Asked which tax regime applies to the imported supplier.",
		minutesAgo: 12,
	},
	{
		n: 3,
		harness: "claude-code",
		label: "tedix · runtime-retry",
		state: "error",
		effectiveState: "error",
		summary: "Type-check failed in apps/tedi-runtime after the retry refactor.",
		minutesAgo: 7,
	},
	{
		n: 4,
		harness: "codex",
		label: "landing · hero-copy",
		state: "done",
		effectiveState: "done",
		summary: "Rewrote the hero copy and pushed to main.",
		minutesAgo: 18,
	},
	{
		n: 5,
		harness: "claude-code",
		label: "tedix · mcp-scopes",
		state: "working",
		effectiveState: "working",
		summary: "Running the MCP conformance suite.",
		minutesAgo: 1,
	},
	{
		n: 6,
		harness: "codex",
		label: "tedix · docs-public",
		state: "working",
		effectiveState: "working",
		summary: "Updating release-status for the new board.",
		minutesAgo: 4,
	},
	{
		n: 7,
		harness: "claude-code",
		label: "cms · theme-parity",
		state: "done",
		effectiveState: "idle",
		summary: "Finished the theme token audit.",
		minutesAgo: 190,
	},
	{
		n: 8,
		harness: "codex",
		label: "tedix · old-spike",
		state: "ended",
		effectiveState: "ended",
		summary: "Session closed.",
		minutesAgo: 600,
	},
];

function localAgentSessions(includeEnded: boolean | undefined) {
	const at = (minutesAgo: number) =>
		new Date(Date.now() - minutesAgo * 60_000).toISOString();
	const sessions = LOCAL_AGENT_SESSIONS.filter(
		(row) => includeEnded || row.effectiveState !== "ended",
	).map((row) => ({
		id: fid("a6", row.n),
		harness: row.harness,
		sessionKey: `local-session-${row.n}`,
		label: row.label,
		state: row.state,
		effectiveState: row.effectiveState,
		summary: row.summary,
		stateSince: at(row.minutesAgo),
		lastEventAt: at(row.minutesAgo),
	}));
	const counts: Record<LocalAgentSessionState, number> = {
		needs_you: 0,
		error: 0,
		done: 0,
		working: 0,
		idle: 0,
		ended: 0,
	};
	for (const row of sessions) counts[row.effectiveState] += 1;
	return { sessions, counts };
}

// --- Office (/work/office): knocks, auto-sent replies and the notebook ---

/** Agent turns that knocked today, aged relative to the request. */
const LOCAL_KNOCKS: readonly {
	n: number;
	subject: string;
	host: "claude-code" | "codex";
	repository: string;
	urgency: "now" | "later";
	state: "open" | "resolved";
	minutesAgo: number;
	draft: "auto" | "review" | null;
	drafter: string;
}[] = [
	{
		n: 1,
		subject: "Tests pass. Push the retry fix to main?",
		host: "claude-code",
		repository: "acme/books",
		urgency: "later",
		state: "open",
		minutesAgo: 2,
		draft: "auto",
		drafter: TEDI_NOVA,
	},
	{
		n: 2,
		subject: "The production database migration drops a column. Run it now?",
		host: "codex",
		repository: "acme/books",
		urgency: "now",
		state: "open",
		minutesAgo: 9,
		draft: null,
		drafter: TEDI_NOVA,
	},
	{
		n: 3,
		subject: "Hero copy rewritten in plain English. Ship it?",
		host: "claude-code",
		repository: "acme/landing",
		urgency: "later",
		state: "open",
		minutesAgo: 21,
		draft: "auto",
		drafter: TEDI_MILES,
	},
	{
		n: 4,
		subject: "Which pricing tier should the new plan default to?",
		host: "codex",
		repository: "acme/landing",
		urgency: "later",
		state: "open",
		minutesAgo: 47,
		draft: "review",
		drafter: TEDI_MILES,
	},
	{
		n: 5,
		subject: "Done with the invoice export. Anything else?",
		host: "claude-code",
		repository: "acme/books",
		urgency: "later",
		state: "resolved",
		minutesAgo: 95,
		draft: null,
		drafter: TEDI_NOVA,
	},
];

function localKnockRequest(knock: (typeof LOCAL_KNOCKS)[number]) {
	const at = new Date(Date.now() - knock.minutesAgo * 60_000).toISOString();
	return {
		id: fid("a7", knock.n),
		orgId: ORG_ID,
		workItemId: null,
		caseId: null,
		projectId: null,
		kind: "question" as const,
		subject: knock.subject,
		prompt: knock.subject,
		requestedFromType: "user" as const,
		requestedFromId: "dev-operator",
		creatorType: "user" as const,
		creatorId: "dev-operator",
		creatorSessionId: null,
		state: knock.state,
		requestedAt: at,
		dueAt: null,
		expiresAt: null,
		resolvedAt: knock.state === "resolved" ? at : null,
		version: 1,
		metadata: {
			schema: "tedix.decision-capture.v1",
			host: knock.host,
			sessionId: fid("a8", knock.n),
			repository: knock.repository,
			triage: { urgency: knock.urgency },
		},
	};
}

function localKnockRow(knock: (typeof LOCAL_KNOCKS)[number]) {
	return {
		request: localKnockRequest(knock),
		effectiveState: knock.state,
		canRespond: knock.state === "open",
		canCancel: false,
		workItem: null,
		responseCount: knock.state === "resolved" ? 1 : 0,
	};
}

function localKnockDetail(requestId: string) {
	const knock = LOCAL_KNOCKS.find((row) => fid("a7", row.n) === requestId);
	if (!knock) throw new RpcError("NOT_FOUND", "Interaction not found");
	const row = localKnockRow(knock);
	return {
		request: row.request,
		effectiveState: row.effectiveState,
		canRespond: row.canRespond,
		canCancel: false,
		latestDraft: knock.draft
			? {
					id: fid("a9", knock.n),
					body: "Yes, go ahead.",
					rationale: "Reversible and matches how you answered last time.",
					drafterId: knock.drafter,
					drafterName: null,
					createdAt: row.request.requestedAt,
					turnType: "ship",
					delivery: knock.draft,
				}
			: null,
		responses: { data: [], nextCursor: null, hasMore: false },
	};
}

const LOCAL_LESSONS = [
	{
		n: 1,
		text: "Answer in plain English and keep it short; no IDs in the reply.",
		addedMinutesAgo: 30,
		replies: 1,
	},
	{
		n: 2,
		text: "Commit and push to main once checks pass; never open a pull request.",
		addedMinutesAgo: 60 * 26,
		replies: 4,
	},
	{
		n: 3,
		text: "Prefer the simple version first; ask before adding a feature flag.",
		addedMinutesAgo: 60 * 24 * 5,
		replies: 0,
	},
] as const;

// ---------------------------------------------------------------------------
// Per-procedure handlers
// ---------------------------------------------------------------------------

const handlers: Record<string, (input: never) => unknown> = {
	"workAgentSessions/list": (input: { includeEnded?: boolean } | undefined) =>
		localAgentSessions(input?.includeEnded),
	"workInteractions/listInbox": (
		input: { states?: string[]; urgency?: string } | undefined,
	) => ({
		data: LOCAL_KNOCKS.filter(
			(knock) =>
				(!input?.states || input.states.includes(knock.state)) &&
				(!input?.urgency || input.urgency === knock.urgency),
		).map(localKnockRow),
		nextCursor: null,
		hasMore: false,
		observedAt: new Date().toISOString(),
	}),
	"workInteractions/get": (input: { requestId: string }) =>
		localKnockDetail(input.requestId),
	"agentTurnTriage/getReplyDraftAcceptance": () => ({
		byTurnType: [
			{
				turnType: "ship",
				drafts: 3,
				decided: 1,
				accepted: 0,
				edited: 1,
				replaced: 0,
				rate: 0,
				eligible: false,
				autoSent: 2,
				autoFollowedUp: 1,
				overridden: 0,
				overrideRate: 0,
			},
		],
		policy: { minDrafts: 50, minRate: 0.9 },
	}),
	"agentTurnTriage/getReplyDraftLeaderboard": () => {
		const score = (
			answered: number,
			autoSent: number,
			stood: number,
			corrected: number,
			avgReplySeconds: number | null,
		) => ({ answered, autoSent, stood, corrected, avgReplySeconds });
		return {
			tedis: [
				{
					tediId: TEDI_NOVA,
					name: "Nova",
					avatar: null,
					week: score(14, 9, 11, 2, 38),
					today: score(3, 2, 3, 0, 31),
					level: {
						stage: "apprentice" as const,
						nextStage: "operator" as const,
						stood: 12,
						corrected: 1,
						target: 25,
						minStandingRate: 0.9,
						streakDays: 4,
					},
				},
				{
					tediId: TEDI_MILES,
					name: "Miles",
					avatar: null,
					week: score(6, 2, 4, 1, 52),
					today: score(1, 0, 0, 1, 64),
					level: null,
				},
			],
		};
	},
	"agentTurnTriage/listLessons": () => ({
		lessons: LOCAL_LESSONS.map((lesson) => {
			const added = new Date(
				Date.now() - lesson.addedMinutesAgo * 60_000,
			).toISOString();
			return {
				id: fid("b1", lesson.n),
				text: lesson.text,
				addedAt: added,
				learnedFrom: lesson.replies
					? { replies: lesson.replies, lastReplyAt: added, fromCaller: true }
					: null,
			};
		}),
	}),
	"catalog/list": (input: ListCatalogAppsInput) => {
		const rows = LOCAL_CATALOG.filter(
			(app) =>
				(!input.search ||
					`${app.name} ${app.description}`
						.toLowerCase()
						.includes(input.search.toLowerCase())) &&
				(!input.category || app.category === input.category) &&
				(!input.connectorType || app.connectorType === input.connectorType) &&
				(!input.healthStatus || app.healthStatus === input.healthStatus),
		);
		const offset = input.offset ?? 0;
		const limit = input.limit ?? 30;
		return {
			apps: rows.slice(offset, offset + limit).map((app) => ({
				...app,
				source: "manual",
				sourceAppId: null,
				regions: null,
				version: null,
			})),
			total: rows.length,
			pagination: { offset, limit, hasMore: offset + limit < rows.length },
		};
	},
	"catalog/getCategories": () => [
		{
			name: "PRODUCTIVITY",
			label: "Productivity",
			count: LOCAL_CATALOG.length,
		},
	],
	"catalog/getBySlug": (input: { slug: string }) =>
		LOCAL_CATALOG.find((app) => app.slug === input.slug) ?? null,

	// --- team ---
	"members/listMembers": (input: Pagination | undefined) =>
		paginate([ORG_MEMBERSHIP.member], input),
	"tedis/list": (input: Pagination | undefined) => paginate(TEDIS, input),
	"tedis/listOperationsSummaries": () => ({
		data: [
			operationsSummary(
				TEDI_NOVA,
				"Prepare Monday owner brief",
				"Move owner sync brief to Monday 08:00",
			),
			operationsSummary(
				TEDI_MILES,
				"Rebuild churn cohort query",
				"Publish week-32 revenue summary",
			),
			operationsSummary(
				TEDI_JUNO,
				"Clear SLA-risk ticket queue",
				"Escalate ticket #4821 to a goodwill credit",
			),
		],
	}),
	"tediUsage/getCallCosts": (input: {
		tediId: string;
		period?: "24h" | "7d" | "30d";
	}) => {
		const rows = CALL_COSTS.filter((row) => row.tediId === input.tediId);
		const priced = rows.filter(
			(row) => row.dataQuality === "ok" && row.estimatedCostUsd !== null,
		);
		const knownSubtotalUsd = priced.reduce(
			(sum, row) => sum + row.estimatedCostUsd!,
			0,
		);
		const unpriced = rows.length - priced.length;
		return {
			tediId: input.tediId,
			period: input.period ?? "7d",
			costs: rows,
			summary: [
				{
					knownSubtotalUsd,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: priced.length,
					unpricedRowCount: unpriced,
					unpricedTokens: unpriced * 22300,
					costCompleteness:
						priced.length === 0
							? ("unknown" as const)
							: unpriced > 0
								? ("partial" as const)
								: ("complete" as const),
					model: "claude-sonnet-4-5",
					provider: "anthropic",
					providerResource: null,
					deployment: null,
					totalInputTokens: rows.length * 12_400,
					totalOutputTokens: rows.length * 1_900,
					totalCacheReadTokens: rows.length * 8_000,
					totalCacheWriteTokens: 0,
					totalTokens: rows.length * 22_300,
					totalCostUsd: unpriced > 0 ? null : knownSubtotalUsd,
					snapshotCount: rows.length,
				},
			],
			sourceSummary: [
				{
					knownSubtotalUsd,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: priced.length,
					unpricedRowCount: unpriced,
					unpricedTokens: unpriced * 22300,
					costCompleteness:
						priced.length === 0
							? ("unknown" as const)
							: unpriced > 0
								? ("partial" as const)
								: ("complete" as const),
					source: "ai-gateway",
					sessionType: "tedi",
					totalInputTokens: rows.length * 12_400,
					totalOutputTokens: rows.length * 1_900,
					totalCacheReadTokens: rows.length * 8_000,
					totalCacheWriteTokens: 0,
					totalTokens: rows.length * 22_300,
					totalCostUsd: unpriced > 0 ? null : knownSubtotalUsd,
					rowCount: rows.length,
				},
			],
		};
	},

	// --- skills + workflows ---
	"skills/listByOrg": () => ({ entries: SKILLS, total: SKILLS.length }),
	"skills/listWorkflowSchedules": () => ({
		schedules: SCHEDULES,
		total: SCHEDULES.length,
		offset: 0,
		limit: 100,
		nextOffset: null,
	}),
	"skills/runWorkflowHistory": (
		input: { status?: SkillRunRow["status"]; limit?: number } | undefined,
	) => {
		const rows = state.skillRuns.filter(
			(run) => input?.status === undefined || run.status === input.status,
		);
		return { runs: rows.map(skillRunSummary) };
	},
	"skills/listWorkflowRetryCandidates": () => ({
		candidates: state.skillRuns
			.filter((run) => run.status === "failed")
			.map((run) => ({
				runId: run.id,
				tediId: run.tediId,
				skillId: run.skillId,
				skillSlug: run.skillSlug,
				status: "failed" as const,
				executionEpoch: run.executionEpoch,
				restartId: `restart-${run.id.slice(0, 8)}-epoch-${run.executionEpoch}`,
				failedAt: run.completedAt,
				error: run.error,
			})),
	}),
	"skills/inspectWorkflowRun": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		return {
			run: {
				id: run.id,
				organizationId: ORG_ID,
				skillId: run.skillId,
				tediId: run.tediId,
				workflowInstanceId: `wf-${run.id.slice(0, 8)}`,
				runtimeEnvironment: "development" as const,
				lastReconciledAt: T5,
				executionEpoch: run.executionEpoch,
				restartRequestedAt: null,
				workflowRetiredAt: null,
				status: run.status,
				params: { period: "last_7_days" },
				result: run.status === "completed" ? { published: true } : null,
				error: run.error,
				capabilityManifest: null,
				startedAt: run.startedAt,
				completedAt: run.completedAt,
				pausedAt: null,
				createdBy: run.createdBy,
				workItemId: null,
				costSummary: null,
				engine: null,
			},
			revision: {
				runId: run.id,
				skillId: run.skillId,
				tediId: run.tediId,
				skillSlug: run.skillSlug,
				revision: 3,
				status: run.status,
				observedAt: run.startedAt,
				observedRunCount: 4,
				firstObservedAt: T0,
				lastObservedAt: run.startedAt,
				completedCount: 3,
				failedCount: run.status === "failed" ? 1 : 0,
				canceledCount: 0,
				workflowSourceSha256: null,
				skillDocSha256: null,
				runtimeVariants: [],
				runtimeDriftObserved: false,
				runtimeDriftBlocked: false,
				...runtimeProvenanceNulls,
			},
			workflowSource: null,
			skillDoc: null,
			artifacts: [
				{
					path: "reports/revenue-week-32.md",
					mimeType: "text/markdown",
					sizeBytes: 4821,
					outcome: "success" as const,
					attempt: 1,
					storage: "r2" as const,
					createdAt: run.startedAt,
					sha256: null,
				},
			],
			steps: [
				{
					path: "steps/fetch-orders/attempt-1.json",
					name: "fetch-orders",
					count: 1,
					executionEpoch: run.executionEpoch,
					stepId: null,
					kind: "attempt" as const,
					attempt: 1,
					ordinal: 1,
					outcome: "success" as const,
					status: "succeeded" as const,
					durationMs: 1840,
					retryable: null,
					sensitiveOutput: null,
					outputArtifactPath: null,
					error: null,
					provenance: "step_artifact" as const,
					legacy: false,
					mimeType: "application/json",
					sizeBytes: 512,
					createdAt: run.startedAt,
					data: null,
				},
				{
					path: "calls/storefront/list_orders/1.json",
					name: "fetch-orders",
					count: 1,
					executionEpoch: run.executionEpoch,
					stepId: null,
					kind: "tool_call" as const,
					attempt: 1,
					ordinal: 2,
					outcome:
						run.status === "failed"
							? ("failure" as const)
							: ("success" as const),
					status:
						run.status === "failed"
							? ("failed" as const)
							: ("succeeded" as const),
					durationMs: 940,
					retryable: null,
					sensitiveOutput: null,
					outputArtifactPath: null,
					error: run.error,
					provenance: "step_artifact" as const,
					legacy: false,
					mimeType: "application/json",
					sizeBytes: 2048,
					createdAt: run.startedAt,
					data: null,
					phase: "execute",
					namespace: "storefront",
					method: "list_orders",
					callId: `call-${run.id.slice(0, 8)}`,
					idempotencyKey: `idem-${run.id.slice(0, 8)}-1`,
					idempotencyRequested: true,
					providerConfirmation: "storefront-ack-8812",
				},
				// waitForEvent evidence: one gate this run already answered, plus a
				// live gate while the run is still in flight so the governed
				// approve/reject controls render in the zero-account lane.
				{
					path: "events/publish-approval/1.json",
					name: "publish-approval",
					count: 1,
					executionEpoch: run.executionEpoch,
					stepId: null,
					kind: "wait_for_event" as const,
					attempt: 1,
					ordinal: 3,
					outcome: "success" as const,
					status: "resolved" as const,
					durationMs: 412_000,
					retryable: null,
					sensitiveOutput: null,
					outputArtifactPath: null,
					error: null,
					provenance: "step_artifact" as const,
					legacy: false,
					mimeType: "application/json",
					sizeBytes: 256,
					createdAt: run.startedAt,
					data: {
						eventType: "approval",
						approvalId: `apr-${run.id.slice(0, 8)}-1`,
						payload: { decision: "approved", by: "dev-operator" },
					},
				},
				...(run.status === "running"
					? [
							{
								path: "events/spend-approval/1.json",
								name: "spend-approval",
								count: 1,
								executionEpoch: run.executionEpoch,
								stepId: null,
								kind: "wait_for_event" as const,
								attempt: 1,
								ordinal: 4,
								outcome: "pending" as const,
								status: "waiting" as const,
								durationMs: 96_000,
								retryable: null,
								sensitiveOutput: null,
								outputArtifactPath: null,
								error: null,
								provenance: "step_artifact" as const,
								legacy: false,
								mimeType: "application/json",
								sizeBytes: 192,
								createdAt: run.startedAt,
								data: {
									eventType: "approval",
									approvalId: `apr-${run.id.slice(0, 8)}-2`,
								},
							},
						]
					: []),
			],
			toolCalls: [
				{
					path: "calls/storefront/list_orders/1.json",
					name: "fetch-orders",
					count: 1,
					executionEpoch: run.executionEpoch,
					stepId: null,
					kind: "tool_call" as const,
					attempt: 1,
					ordinal: 2,
					outcome:
						run.status === "failed"
							? ("failure" as const)
							: ("success" as const),
					status:
						run.status === "failed"
							? ("failed" as const)
							: ("succeeded" as const),
					durationMs: 940,
					retryable: null,
					sensitiveOutput: null,
					outputArtifactPath: null,
					error: run.error,
					provenance: "step_artifact" as const,
					legacy: false,
					mimeType: "application/json",
					sizeBytes: 2048,
					createdAt: run.startedAt,
					data: null,
					phase: "execute",
					namespace: "storefront",
					method: "list_orders",
					callId: `call-${run.id.slice(0, 8)}`,
					idempotencyKey: `idem-${run.id.slice(0, 8)}-1`,
					idempotencyRequested: true,
					providerConfirmation: "storefront-ack-8812",
				},
			],
			warnings: [],
		};
	},
	"skills/listRunArtifacts": (input: { runId: string }) => {
		findSkillRun(input.runId);
		return {
			artifacts: [
				{
					path: "reports/revenue-week-32.md",
					mimeType: "text/markdown",
					sizeBytes: 4821,
					outcome: "success" as const,
					attempt: 1,
					storage: "r2" as const,
					createdAt: T2,
					sha256: null,
				},
				{
					path: "steps/fetch-orders/attempt-1.json",
					mimeType: "application/json",
					sizeBytes: 512,
					outcome: "success" as const,
					attempt: 1,
					storage: "inline" as const,
					createdAt: T2,
					sha256: null,
				},
			],
			truncated: false,
			nextOffset: null,
		};
	},
	"skills/restartWorkflow": (input: { runId: string; restartId: string }) => {
		const run = findSkillRun(input.runId);
		run.status = "queued";
		run.executionEpoch += 1;
		run.error = null;
		run.completedAt = null;
		return {
			runId: run.id,
			status: run.status,
			executionEpoch: run.executionEpoch,
			restartId: input.restartId,
		};
	},
	"skills/runWorkflowCancel": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		run.status = "canceled";
		run.completedAt = now();
		return { runId: run.id, status: run.status };
	},
	"skills/approveWorkflow": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		run.status = "running";
		return { runId: run.id, status: run.status };
	},
	"skills/rejectWorkflow": (input: { runId: string }) => {
		const run = findSkillRun(input.runId);
		run.status = "canceled";
		run.completedAt = now();
		return { runId: run.id, status: run.status };
	},
	// The admission gate the budget-pause surface reads: an active entitlement
	// with a daily token/spend policy, which is exactly what makes a background
	// schedule's fire get denied without any run ever failing.
	"runtimeEntitlements/get": () => ({
		entitlement: {
			planKey: "growth",
			planName: "Growth",
			status: "active" as const,
			periodStart: "2026-08-01T00:00:00.000Z",
			periodEnd: "2026-09-01T00:00:00.000Z",
			active: true,
			settlementMode: "managed" as const,
			source: "managed-plan" as const,
			version: 4,
		},
		modelPolicy: {
			allowedModelTiers: ["economy" as const, "balanced" as const],
			dailyTokenLimit: 5_000_000,
			dailySpendLimitMicros: 25_000_000,
		},
	}),
	/**
	 * Compute posture. Deliberately NOT a clean, fully-labeled reading: the dev
	 * lane exercises the honest states, so this window carries a quarantined
	 * bucket and an unknown-basis bucket beside the estimate, reports credential
	 * health as `unattested` (nothing stores a passing probe) and provider health
	 * as `unknown`, and reports D1 as the sole admission authority. Every literal below is
	 * written out rather than imported because vite.config.ts loads this module
	 * under raw Node, where package subpaths do not resolve.
	 */
	"osCompute/posture": (input: { window?: "24h" | "7d" | "30d" }) => {
		const window = input.window ?? "7d";
		const days = window === "24h" ? 1 : window === "7d" ? 7 : 30;
		const to = new Date();
		const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
		return {
			window,
			from: from.toISOString(),
			to: to.toISOString(),
			freshness: {
				state: "ingestion_pending" as const,
				lastRowAt: T4,
				staleMinutes: 42,
				rowsLast24h: 4,
				rowsLast30d: 6,
				detail:
					"The cost ledger ingests every 15 minutes; work newer than the last tick is not counted yet.",
			},
			spend: {
				knownSubtotalUsd: 0.153,
				pricedRowCount: 4,
				unpricedRowCount: 2,
				unpricedTokens: 44600,
				costCompleteness: "partial" as const,
				quarantinedKnownSubtotalUsd: 0,
				rowCount: 6,
				totalTokens: 111_500,
				costUsd: null,
				quarantinedCostUsd: null,
				quarantinedTokens: 22_300,
				quarantinedRowCount: 1,
				provenanceFloor: "unknown" as const,
			},
			provenance: [
				{
					provenance: "pricing_table_estimate" as const,
					rowCount: 4,
					totalTokens: 89_200,
					costUsd: 0.153,
					knownSubtotalUsd: 0.153,
				},
				{
					provenance: "unknown" as const,
					rowCount: 1,
					totalTokens: 22_300,
					costUsd: null,
					knownSubtotalUsd: 0,
				},
				{
					provenance: "quarantined" as const,
					rowCount: 1,
					totalTokens: 22_300,
					costUsd: null,
					knownSubtotalUsd: 0,
				},
			],
			budget: {
				configured: true,
				includedTokens: 20_000_000,
				usedTokens: 4_120_000,
				reservedTokens: 60_000,
				remainingIncludedTokens: 15_820_000,
				unlimitedTokenUsage: false,
				allowOverage: false,
				entitlementActive: true,
				detail:
					"Copied from the canonical billing balance snapshot the admission path reads; remaining already nets out live reservations.",
			},
			routing: {
				modelRef: "azure-openai/gpt-5.6-luna",
				selectedBy: "org_default" as const,
				detail:
					"No tedi is named, so the chat slot resolves to the deployment default deployment.",
				allowedCount: 6,
				deniedCount: 2,
				wiredProviders: ["azure-openai", "workers-ai"],
				observedProviders: ["anthropic"],
				fallbackDetail:
					"Calls in this window were served by anthropic while the model catalog selects azure-openai/gpt-5.6-luna. Runtime fallback is not recorded durably — the only breaker is an in-memory, per-isolate circuit in the Agent runtime — so the reason and the time of the switch are unknown.",
			},
			credentialHealth: {
				scope: "platform_ai_gateway" as const,
				status: "unattested" as const,
				observedAt: T4,
				detail:
					"No open credential-drift condition and no fresh ingestion to evidence the credentials. Nothing stores a passing probe, so credential health is unattested here — not healthy.",
			},
			providerHealth: {
				status: "unknown" as const,
				detail:
					"No durable provider-health signal exists. The only breaker is an in-memory, per-isolate circuit inside the Agent runtime, unreadable from the control plane — so provider health is unknown here, not healthy.",
			},
			admissionPolicy: {
				state: "d1_authoritative" as const,
				desiredDailyTokenLimit: 5_000_000,
				desiredDailySpendLimitMicros: 25_000_000,
				detail:
					"D1 is the sole inference-admission authority. Daily token and spend limits are checked atomically with reservations; AI Gateway only records provider usage and cost.",
			},
			attribution: {
				unattributedCostUsd: 0.006,
				unattributedTokens: 22_300,
				unattributedRowCount: 1,
				unattributedQuarantinedRowCount: 0,
				orphanedRowsVisible: false as const,
				detail:
					"Unattributed rows that still carry this organization. Rows with no organization at all are invisible to every org-scoped read, so this is a floor on unattributed spend, never a total.",
			},
		};
	},
	"workflows/listDefinitions": () => ({
		definitions: WORKFLOW_DEFINITIONS,
		counts: { staticPlatform: 1, dynamicSkill: 2, total: 3 },
		offset: 0,
		limit: 50,
		truncated: false,
		nextOffset: null,
	}),
	"workflows/listDefinitionHealth": () => ({
		health: WORKFLOW_HEALTH,
		definitionCounts: { staticPlatform: 1, dynamicSkill: 2, total: 3 },
		pageCounts: {
			healthy: 1,
			active: 1,
			attention: 1,
			unknown: 0,
			degraded: 0,
			dormant: 0,
		},
		evaluatedAt: T5,
		offset: 0,
		limit: 50,
		truncated: false,
		nextOffset: null,
	}),

	// --- brain ---
	"memoryGraph/health": () => MEMORY_HEALTH,
	"rationaleRecords/list": (
		input:
			| {
					tediId?: string;
					outcomeStatus?: string;
					limit?: number;
					offset?: number;
			  }
			| undefined,
	) =>
		paginate(
			RATIONALES.filter(
				(row) =>
					(input?.tediId === undefined || row.tediId === input.tediId) &&
					(input?.outcomeStatus === undefined ||
						row.outcomeStatus === input.outcomeStatus),
			),
			input,
		),
	"knowledge/list": () => ({ entries: KNOWLEDGE }),
	"memoryGraph/expertise": (input: { tediId?: string } | undefined) => ({
		expertise: EXPERTISE.filter(
			(row) => input?.tediId === undefined || row.tediId === input.tediId,
		),
	}),
	"memoryGraph/graph/visualization": () => KNOWLEDGE_GRAPH,

	// --- tedi detail: telemetry, authority, growth ---
	"cognitiveRuntime/listEvents": (input: {
		tediId: string;
		kind?: string;
		limit?: number;
	}) => {
		const rows = TOOL_EVENTS.filter(
			(row) =>
				row.tediId === input.tediId &&
				(input.kind === undefined || row.kind === input.kind),
		).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const limit = input.limit ?? 100;
		return { events: rows.slice(0, limit), nextBefore: null };
	},
	"earnedDelegation/getProfile": (input: { tediId: string }) =>
		delegationProfile(input.tediId),
	"growthSnapshots/latest": (input: { tediId: string }) =>
		growthSnapshot(input.tediId),

	// --- audit ---
	"audit/search": (
		input:
			| { resourceType?: string; limit?: number; offset?: number }
			| undefined,
	) =>
		paginate(
			AUDIT_EVENTS.filter(
				(row) =>
					input?.resourceType === undefined ||
					row.resourceType === input.resourceType,
			),
			input,
		),

	// --- activity ---
	"workItems/list": (
		input:
			| {
					disposition?: string;
					workKind?: string;
					projectId?: string;
					limit?: number;
					offset?: number;
			  }
			| undefined,
	) =>
		paginate(
			WORK_ITEMS.filter(
				(row) =>
					(input?.disposition === undefined ||
						row.disposition === input.disposition) &&
					(input?.workKind === undefined || row.workKind === input.workKind) &&
					(input?.projectId === undefined || row.projectId === input.projectId),
			),
			input,
		),
	"projects/list": (input: Pagination | undefined) => paginate(PROJECTS, input),

	// --- work graph diagnostics ---
	"workItems/listRelations": (
		input: { projectId?: string; limit?: number } | undefined,
	) => {
		const ids = new Set(
			workItemsInScope(input?.projectId).map((row) => row.id),
		);
		const relations = WORK_ITEM_RELATIONS.filter(
			(row) =>
				input?.projectId === undefined ||
				(ids.has(row.fromWorkItemId) && ids.has(row.toWorkItemId)),
		);
		const limit = input?.limit ?? 500;
		return {
			relations: relations.slice(0, limit),
			truncated: relations.length > limit,
		};
	},
	"workItems/getOrgGraphHealth": (
		input: { projectId?: string; limit?: number } | undefined,
	) => orgGraphHealthFor(input?.projectId, input?.limit ?? 20),
	"workItems/getWorkGraphHealth": () => WORK_GRAPH_HEALTH,

	// --- purpose ---
	"organizationPurpose/getOwnerBrief": () => OWNER_BRIEF,
	"tediApprovals/list": (
		input:
			| { status?: ApprovalRow["status"]; limit?: number; offset?: number }
			| undefined,
	) =>
		paginate(
			state.approvals.filter(
				(row) => input?.status === undefined || row.status === input.status,
			),
			input,
		),
	"tediApprovals/resolve": (input: {
		id: string;
		status: "approved" | "rejected";
		resolution?: string;
	}) => {
		const approval = state.approvals.find((row) => row.id === input.id);
		if (!approval)
			throw new RpcError("NOT_FOUND", "Approval request not found");
		if (approval.status !== "pending") {
			throw new RpcError("CONFLICT", "Approval request already resolved");
		}
		approval.status = input.status;
		approval.resolvedAt = now();
		approval.resolvedBy = "dev-operator";
		approval.resolution = input.resolution ?? null;
		approval.review = {
			...approval.review,
			state: "resolved",
			outcome: input.status,
		};
		return approval;
	},

	// --- launcher / apps ---
	// --- per-user OS settings ---
	// Unset reads report the platform defaults at revision 0 so the surface can
	// tell "never saved" from "saved with default values"; the write is a real
	// compare-and-swap, so a stale revision 409s here exactly as it does in D1.
	"userSettings/getPreferences": () =>
		state.userPreferences
			? {
					preferences: state.userPreferences.value,
					source: "stored" as const,
					revision: state.userPreferences.revision,
					updatedAt: state.userPreferences.updatedAt,
				}
			: {
					preferences: DEFAULT_LOCAL_PREFERENCES,
					source: "default" as const,
					revision: 0,
					updatedAt: null,
				},
	"userSettings/updatePreferences": (input: {
		preferences: OsUserPreferences;
		expectedRevision: number;
	}) => {
		const current = state.userPreferences?.revision ?? 0;
		if (input.expectedRevision !== current) {
			throw new RpcError(
				"CONFLICT",
				"Preference revision compare-and-swap lost against a concurrent write",
				{
					expectedRevision: input.expectedRevision,
					currentRevision: state.userPreferences?.revision ?? null,
				},
			);
		}
		state.userPreferences = {
			value: input.preferences,
			revision: current + 1,
			updatedAt: now(),
		};
		return {
			preferences: state.userPreferences.value,
			source: "stored" as const,
			revision: state.userPreferences.revision,
			updatedAt: state.userPreferences.updatedAt,
		};
	},
	"userSettings/getContext": () => ({
		organization: {
			id: ORG_ID,
			name: ORG_MEMBERSHIP.organizationName,
			slug: ORG_MEMBERSHIP.organizationSlug,
			type: ORG_MEMBERSHIP.organizationType,
			descopeTenantId: state.organization.descopeTenantId,
			logoUrl: ORG_MEMBERSHIP.organizationLogoUrl,
			appearance: state.organization.metadata?.osTheme ?? null,
		},
		authority: {
			authType: "user" as const,
			role: ORG_MEMBERSHIP.member.role,
			// The owner grant from ROLE_PERMISSION_GRANTS, so the local lane shows
			// the same authority the real projection computes for an owner.
			permissions: [
				"apps:read",
				"tedis:read",
				"team:read",
				"analytics:read",
				"apps:create",
				"apps:update",
				"apps:delete",
				"tedis:create",
				"tedis:update",
				"tedis:delete",
				"secrets:manage",
				"integrations:manage",
				"api_keys:manage",
				"team:manage",
				"billing:read",
				"settings:manage",
				"os:read",
				"os:author",
				"os:run",
				"os:publish",
				"os:approve",
				"os:admin",
				"billing:manage",
			] as const,
			machineScopes: [],
			crossTenantOverrideActive: false,
		},
		purpose: {
			access: "granted" as const,
			charter: {
				id: fid("95", 1),
				version: 3,
				status: "active" as const,
				activatedAt: T1,
				reviewCadenceDays: 30,
				reviewDueAt: new Date(Date.parse(T1) + 30 * 86_400_000).toISOString(),
			},
		},
	}),
	"userSettings/getBrowserMcpAuthorization": () => ({
		policyVersion: 1 as const,
		scopes: [
			"mcp:tedis.read",
			"mcp:tedis.write",
			"mcp:apps.read",
			"mcp:apps.write",
			"mcp:memory.read",
			"mcp:memory.write",
			"mcp:memory.admin",
			"mcp:skills.read",
			"mcp:skills.write",
			"mcp:content.read",
			"mcp:content.write",
			"mcp:catalog.read",
			"mcp:catalog.write",
			"mcp:observe.read",
			"mcp:messaging.read",
			"mcp:messaging.write",
			"mcp:settings.read",
			"mcp:settings.write",
			"mcp:settings.admin",
			"mcp:work.read",
			"mcp:work.write",
			"mcp:work.admin",
		],
	}),
	"organizations/listAllMine": () => paginate([ORG_MEMBERSHIP]),
	"organizations/get": (input: { organizationId: string }) => {
		if (input.organizationId !== ORG_ID)
			throw new RpcError("NOT_FOUND", "Organization not found");
		return state.organization;
	},
	"organizations/getFeatures": (input: { organizationId: string }) => {
		if (input.organizationId !== ORG_ID)
			throw new RpcError("NOT_FOUND", "Organization not found");
		return state.organization.features ?? {};
	},
	"organizations/update": (input: {
		organizationId: string;
		name?: string;
		slug?: string;
		logoUrl?: string | null;
		description?: string | null;
		metadata?: Organization["metadata"];
	}) => {
		if (input.organizationId !== ORG_ID)
			throw new RpcError("NOT_FOUND", "Organization not found");
		state.organization = {
			...state.organization,
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.slug !== undefined ? { slug: input.slug } : {}),
			...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
			...(input.description !== undefined
				? { description: input.description }
				: {}),
			...(input.metadata !== undefined
				? {
						metadata: {
							...state.organization.metadata,
							...input.metadata,
						},
					}
				: {}),
			updatedAt: now(),
		};
		return state.organization;
	},
	"billing/listPlans": () => ({
		stripeEnvironment: "test" as const,
		plans: [
			{
				planKey: "growth" as const,
				version: 1,
				name: "Growth",
				currency: "usd",
				monthlyPriceMicros: 99_000_000,
				annualPriceMicros: 950_000_000,
				includedMonthlyTokens: 5_000_000,
				overageUnitTokens: 100_000,
				overageUnitPriceMicros: 500_000,
				maxTedis: 1,
				maxCronJobsPerTedi: 5,
				maxIterationsPerTask: 50,
			},
			{
				planKey: "business" as const,
				version: 1,
				name: "Business",
				currency: "usd",
				monthlyPriceMicros: 249_000_000,
				annualPriceMicros: 2_390_000_000,
				includedMonthlyTokens: 20_000_000,
				overageUnitTokens: 100_000,
				overageUnitPriceMicros: 400_000,
				maxTedis: 3,
				maxCronJobsPerTedi: 10,
				maxIterationsPerTask: 100,
			},
			{
				planKey: "enterprise" as const,
				version: 1,
				name: "Enterprise",
				currency: "usd",
				monthlyPriceMicros: 999_000_000,
				annualPriceMicros: 9_590_000_000,
				includedMonthlyTokens: -1,
				overageUnitTokens: 100_000,
				overageUnitPriceMicros: 0,
				maxTedis: -1,
				maxCronJobsPerTedi: -1,
				maxIterationsPerTask: -1,
			},
		],
	}),
	"billing/getOverview": () => ({
		stripeEnvironment: "test" as const,
		workstationCostCoverage: {
			periodStart: T1,
			periodEnd: new Date(Date.parse(T1) + 30 * 86_400_000).toISOString(),
			observedAt: T1,
			unit: "compute_seconds",
			basis: "recorded_lease_end_wall_clock",
			status: "partial",
			knownAttributedCostMicros: 2000000,
			total: { rowCount: 3, leaseSeconds: 300 },
			reconciled: { rowCount: 1, leaseSeconds: 100 },
			pending: { rowCount: 1, leaseSeconds: 100 },
			unproven: { rowCount: 1, leaseSeconds: 100 },
		} as const,
		snapshot: {
			status: "active" as const,
			billingMode: "trial" as const,
			planKey: "growth" as const,
			planVersion: 1,
			periodStart: T1,
			periodEnd: new Date(Date.parse(T1) + 30 * 86_400_000).toISOString(),
			includedTokens: 5_000_000,
			usedTokens: 1_260_000,
			reservedTokens: 40_000,
			remainingIncludedTokens: 3_700_000,
			creditBalanceMicros: 25_000_000,
			reservedChargeMicros: 0,
			availableCreditMicros: 25_000_000,
			customerChargeMicros: 0,
			hardSpendLimitMicros: null,
			allowOverage: false,
			stripeCustomerId: null,
		},
		plan: {
			name: "Growth",
			currency: "usd",
			monthlyPriceMicros: 99_000_000,
			annualPriceMicros: 950_000_000,
			includedMonthlyCreditMicros: 0,
			overageUnitTokens: 100_000,
			overageUnitPriceMicros: 500_000,
			maxTedis: 1,
			maxCronJobsPerTedi: 5,
			maxIterationsPerTask: 50,
			defaultDailyTokenLimit: 500_000,
			defaultDailyMessageLimit: 500,
		},
		period: {
			usedInputTokens: 940_000,
			usedOutputTokens: 320_000,
			meteredOverageTokens: 0,
			providerCostMicros: 3_400_000,
			customerChargeMicros: 0,
			creditAppliedMicros: 0,
		},
		inferenceCapacity: {
			available: true,
			monthlyMetered: false,
			blockingReason: null,
			unblockAction: "none",
			budgetDay: new Date().toISOString().slice(0, 10),
			baseDailyTokenLimit: 10_000_000,
			baseDailySpendLimitMicros: 80_000_000,
			allocatedTokens: 2_000_000,
			allocatedSpendCapacityMicros: 10_000_000,
			// A provider fixture: part of the allocation is capacity sponsored to
			// embedded customers, so the local surface renders that line too.
			sponsoredTokens: -500_000,
			sponsoredSpendCapacityMicros: -2_500_000,
			usedTokens: 4_200_000,
			usedSpendMicros: 31_000_000,
			remainingTokens: 7_800_000,
			remainingSpendMicros: 59_000_000,
			expiresAt: new Date(
				Date.UTC(
					new Date().getUTCFullYear(),
					new Date().getUTCMonth(),
					new Date().getUTCDate() + 1,
				),
			).toISOString(),
			allocations: [],
			tediOverflow: [],
			packs: [
				{
					packKey: "daily-boost",
					name: "Daily boost",
					tokens: 2_000_000,
					spendCapacityMicros: 10_000_000,
					priceMicros: 12_000_000,
					currency: "usd",
				},
			],
		},
		serviceCredits: { seo: null },
	}),
	"orgUsage/getOrgUsage": (input: {
		organizationId: string;
		period?: "24h" | "7d" | "30d";
		window?: { from: string; to: string };
	}) => {
		if (input.organizationId !== ORG_ID)
			throw new RpcError("NOT_FOUND", "Organization not found");
		return {
			organization: {
				id: ORG_ID,
				name: state.organization.name,
				tier: "growth" as const,
				status: "active" as const,
			},
			period: input.period ?? ("30d" as const),
			window: input.window ?? {
				from: "2026-07-22T00:00:00.000Z",
				to: "2026-08-21T00:00:00.000Z",
			},
			totals: {
				totalTokens: 1_260_000,
				inputTokens: 940_000,
				outputTokens: 320_000,
				cacheReadTokens: 210_000,
				cacheWriteTokens: 45_000,
				estimatedCostUsd: 3.4,
				knownSubtotalUsd: 3.4,
				reviewedEstimateRowCount: 0,
				reviewedEstimateTokens: 0,
				reviewedEstimateMicros: 0,
				sourceRetiredRowCount: 0,
				pricedRowCount: 1,
				unpricedRowCount: 0,
				unpricedTokens: 0,
				costCompleteness: "complete" as const,
				activeTedis: 2,
			},
			planLimits: {
				maxTokensPerMonth: 5_000_000,
				currentMonthTokens: 1_260_000,
				usagePct: 0.252,
				maxTedis: 1,
				currentTedis: 2,
			},
			daily: [
				{
					date: "2026-08-11",
					totalTokens: 82_000,
					estimatedCostUsd: 0.19,
					knownSubtotalUsd: 0.19,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 61_000,
					outputTokens: 21_000,
				},
				{
					date: "2026-08-12",
					totalTokens: 96_000,
					estimatedCostUsd: 0.24,
					knownSubtotalUsd: 0.24,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 73_000,
					outputTokens: 23_000,
				},
				{
					date: "2026-08-13",
					totalTokens: 104_000,
					estimatedCostUsd: 0.27,
					knownSubtotalUsd: 0.27,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 77_000,
					outputTokens: 27_000,
				},
				{
					date: "2026-08-14",
					totalTokens: 91_000,
					estimatedCostUsd: 0.22,
					knownSubtotalUsd: 0.22,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 68_000,
					outputTokens: 23_000,
				},
				{
					date: "2026-08-15",
					totalTokens: 126_000,
					estimatedCostUsd: 0.31,
					knownSubtotalUsd: 0.31,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 93_000,
					outputTokens: 33_000,
				},
				{
					date: "2026-08-16",
					totalTokens: 113_000,
					estimatedCostUsd: 0.28,
					knownSubtotalUsd: 0.28,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 84_000,
					outputTokens: 29_000,
				},
				{
					date: "2026-08-17",
					totalTokens: 148_000,
					estimatedCostUsd: 0.38,
					knownSubtotalUsd: 0.38,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 111_000,
					outputTokens: 37_000,
				},
				{
					date: "2026-08-18",
					totalTokens: 132_000,
					estimatedCostUsd: 0.34,
					knownSubtotalUsd: 0.34,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 98_000,
					outputTokens: 34_000,
				},
				{
					date: "2026-08-19",
					totalTokens: 164_000,
					estimatedCostUsd: 0.51,
					knownSubtotalUsd: 0.51,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 121_000,
					outputTokens: 43_000,
				},
				{
					date: "2026-08-20",
					totalTokens: 204_000,
					estimatedCostUsd: 0.66,
					knownSubtotalUsd: 0.66,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 154_000,
					outputTokens: 50_000,
				},
			],
			tediBreakdown: [
				{
					tediId: TEDI_MILES,
					tediName: "Miles",
					tediSlug: "miles",
					totalTokens: 824_000,
					estimatedCostUsd: 2.37,
					knownSubtotalUsd: 2.37,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					cacheHitRate: 0.28,
				},
				{
					tediId: TEDI_JUNO,
					tediName: "Juno",
					tediSlug: "juno",
					totalTokens: 436_000,
					estimatedCostUsd: 1.03,
					knownSubtotalUsd: 1.03,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					cacheHitRate: 0.19,
				},
			],
			modelBreakdown: [],
			sourceBreakdown: [],
		};
	},
	// --- MCP payment ledger (read-only) ---
	"mcpPayments/listEvents": (
		input:
			| {
					status?: "required" | "settled" | "rejected";
					appSlug?: string;
					toolId?: string;
					tediId?: string;
					limit?: number;
			  }
			| undefined,
	) => ({
		events: MCP_PAYMENT_EVENTS.filter(
			(event) =>
				(input?.status === undefined || event.status === input.status) &&
				(input?.appSlug === undefined || event.appSlug === input.appSlug) &&
				(input?.toolId === undefined || event.toolId === input.toolId) &&
				(input?.tediId === undefined || event.tediId === input.tediId),
		).slice(0, input?.limit ?? 100),
	}),
	"mcpPayments/getReceipt": (input: { id: string }) => {
		const receipt = MCP_PAYMENT_EVENTS.find(
			(event) => event.id === input.id && event.settled,
		);
		if (!receipt) throw new RpcError("NOT_FOUND", "Receipt not found");
		return {
			receipt,
			events: MCP_PAYMENT_EVENTS.filter(
				(event) => event.requirementId === receipt.requirementId,
			),
		};
	},
	"mcpPayments/spendSummary": (
		input:
			| {
					lastHours?: number;
					appSlug?: string;
					toolId?: string;
					tediId?: string;
			  }
			| undefined,
	) => {
		const settled = MCP_PAYMENT_EVENTS.filter(
			(event) =>
				event.settled &&
				(input?.appSlug === undefined || event.appSlug === input.appSlug) &&
				(input?.toolId === undefined || event.toolId === input.toolId) &&
				(input?.tediId === undefined || event.tediId === input.tediId),
		);
		const lastHours = input?.lastHours ?? 24;
		return {
			lastHours,
			since: new Date(Date.now() - lastHours * 3_600_000).toISOString(),
			summary: settled.map((event) => ({
				appSlug: event.appSlug,
				toolId: event.toolId,
				currency: event.currency,
				asset: event.asset,
				network: event.network,
				settledCount: 1,
				totalAmount: Number(event.amount),
				firstSettledAt: event.createdAt,
				lastSettledAt: event.createdAt,
			})),
			totals: settled.length
				? [
						{
							currency: settled[0]!.currency,
							asset: settled[0]!.asset,
							network: settled[0]!.network,
							settledCount: settled.length,
							totalAmount: settled.reduce(
								(sum, event) => sum + Number(event.amount),
								0,
							),
						},
					]
				: [],
		};
	},
	"mcpPayments/listPolicies": (
		input:
			| { appSlug?: string; toolId?: string; tediId?: string; limit?: number }
			| undefined,
	) => ({
		policies: MCP_PAYMENT_POLICIES.filter(
			(policy) =>
				(input?.appSlug === undefined || policy.appSlug === input.appSlug) &&
				(input?.toolId === undefined || policy.toolId === input.toolId) &&
				(input?.tediId === undefined || policy.tediId === input.tediId),
		).slice(0, input?.limit ?? 100),
	}),
	"organizations/listApiKeys": (
		input: Pagination & { organizationId: string },
	) => paginate(API_KEYS, input),
	// One key overdue for rotation so the admin banner has something to say.
	"organizations/getExpiringKeys": () => ({
		data: [{ ...API_KEYS[0]!, warningType: "rotation_overdue" as const }],
	}),
	"connections/getConnectionsOverview": (
		raw: Partial<ConnectionInventoryInput> | undefined,
	) => {
		const input = {
			scope: "organization",
			q: "",
			status: "all",
			limit: 50,
			offset: 0,
			...raw,
		};
		const scope = input.scope === "personal" ? "user" : "tenant";
		const rows = CONNECTIONS.filter((c) => c.tokenScope === scope)
			.map((connection) => ({
				provider: CONNECTION_PROVIDERS.find(
					(p) => p.appId === connection.appId,
				)!,
				scope,
				accountState: connection.status === "expired" ? "expired" : "present",
				accountLabel: scope === "user" ? connection.connectedByEmail : null,
				connection,
				references:
					connection.appId === "gmail"
						? [{ appId: APP_STOREFRONT, appSlug: "storefront", source: "app" }]
						: [],
				referencesComplete: true,
				access: "not_evaluated",
				health: "not_checked",
			}))
			.filter(
				(row) =>
					(!input.providerId || row.provider.appId === input.providerId) &&
					row.provider.name.toLowerCase().includes(input.q.toLowerCase()) &&
					(input.status === "all" ||
						(input.status === "attention" && row.accountState !== "present") ||
						(input.status === "in_use" && row.references.length > 0) ||
						(input.status === "unused" && row.references.length === 0)),
			);
		return {
			organizationId: ORG_ID,
			scope: input.scope,
			observedAt: "2026-08-28T00:00:00Z",
			rows: rows.slice(input.offset, input.offset + input.limit),
			total: rows.length,
			hasMore: input.offset + input.limit < rows.length,
			verificationComplete: true,
			referencesComplete: true,
			issues: [],
		};
	},
	"connections/getUserConnections": () => ({ data: CONNECTIONS }),
	// Provider catalog behind /admin/connections. Mirrors the two seeded
	// connections so the local page shows both an OAuth and an API-key row.
	"connections/listProviders": () => ({ data: CONNECTION_PROVIDERS }),
	"apps/list": (input: Pagination | undefined) => paginate(APPS, input),
	"apps/getByIdWithTools": (input: { appId: string }) => {
		const item = APPS.find((row) => row.id === input.appId);
		if (!item) throw new RpcError("NOT_FOUND", "App not found");
		return {
			app: fullApp(item),
			tools: APP_TOOLS[item.id] ?? [],
			catalogMcp: null,
		};
	},
	"appGating/installedEligibility": () => ELIGIBILITY,

	// --- Tedix OS workspaces ---
	"osWorkspaces/workspaces/list": (
		input: { status?: OsWorkspace["status"]; limit?: number } | undefined,
	) => ({
		items: state.workspaces.filter(
			(row) => input?.status === undefined || row.status === input.status,
		),
		truncated: false,
	}),
	"osWorkspaces/workspaces/create": (input: {
		name: string;
		description?: string;
	}) => {
		const workspace: OsWorkspace = {
			id: nextId(),
			organizationId: ORG_ID,
			name: input.name,
			description: input.description ?? null,
			status: "active",
			sourceBlueprintId: null,
			sourceBlueprintRevisionId: null,
			sourceBlueprintRevisionNumber: null,
			instantiationPreflight: null,
			rollbackReference: null,
			blueprintDecision: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
			updatedAt: now(),
		};
		state.workspaces.push(workspace);
		return { workspace };
	},
	"osWorkspaces/workspaces/get": (input: { workspaceId: string }) => ({
		workspace: findWorkspace(input.workspaceId),
	}),
	"osWorkspaces/workspaces/update": (input: {
		workspaceId: string;
		name?: string;
		description?: string | null;
	}) => {
		const workspace = findWorkspace(input.workspaceId);
		if (input.name !== undefined) workspace.name = input.name;
		if (input.description !== undefined) {
			workspace.description = input.description;
		}
		workspace.updatedAt = now();
		return { workspace };
	},
	"osWorkspaces/workspaces/archive": (input: { workspaceId: string }) => {
		const workspace = findWorkspace(input.workspaceId);
		workspace.status = "archived";
		workspace.updatedAt = now();
		return { workspace };
	},
	"osWorkspaces/workspaces/restore": (input: { workspaceId: string }) => {
		const workspace = findWorkspace(input.workspaceId);
		workspace.status = "active";
		workspace.updatedAt = now();
		return { workspace };
	},
	"osWorkspaces/workspacePreferences/list": () => ({
		items: [...state.workspacePreferences],
	}),
	"osWorkspaces/workspacePreferences/setFavorite": (input: {
		workspaceId: string;
		favorite: boolean;
	}) => {
		findWorkspace(input.workspaceId);
		const current = state.workspacePreferences.find(
			(row) => row.workspaceId === input.workspaceId,
		);
		const preference: OsWorkspacePreference = {
			workspaceId: input.workspaceId,
			favorite: input.favorite,
			lastOpenedAt: current?.lastOpenedAt ?? null,
			updatedAt: now(),
		};
		if (current) Object.assign(current, preference);
		else state.workspacePreferences.push(preference);
		return { preference };
	},
	"osWorkspaces/workspacePreferences/touch": (input: {
		workspaceId: string;
	}) => {
		findWorkspace(input.workspaceId);
		const current = state.workspacePreferences.find(
			(row) => row.workspaceId === input.workspaceId,
		);
		const timestamp = now();
		const preference: OsWorkspacePreference = {
			workspaceId: input.workspaceId,
			favorite: current?.favorite ?? false,
			lastOpenedAt: timestamp,
			updatedAt: timestamp,
		};
		if (current) Object.assign(current, preference);
		else state.workspacePreferences.push(preference);
		return { preference };
	},
	"osWorkspaces/resources/list": (input: {
		workspaceId: string;
		status?: OsWorkspaceResource["status"];
		limit?: number;
	}) => ({
		items: state.workspaceResources.filter(
			(resource) =>
				resource.workspaceId === input.workspaceId &&
				(input.status === undefined || resource.status === input.status),
		),
		truncated: false,
	}),
	"osWorkspaces/resources/create": (input: {
		workspaceId: string;
		selection: Omit<
			OsWorkspaceResource,
			| "id"
			| "organizationId"
			| "workspaceId"
			| "slot"
			| "status"
			| "createdByKind"
			| "createdById"
			| "createdAt"
			| "updatedAt"
			| "removedAt"
		>;
	}) => {
		findWorkspace(input.workspaceId);
		const timestamp = now();
		const resource: OsWorkspaceResource = {
			...input.selection,
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			slot: null,
			status: "active",
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: timestamp,
			updatedAt: timestamp,
			removedAt: null,
		};
		state.workspaceResources.push(resource);
		return { resource };
	},
	"osWorkspaces/resources/get": (input: {
		workspaceId: string;
		resourceId: string;
	}) => {
		const resource = state.workspaceResources.find(
			(row) =>
				row.workspaceId === input.workspaceId && row.id === input.resourceId,
		);
		if (!resource)
			throw new RpcError("NOT_FOUND", "Workspace resource not found");
		return { resource };
	},
	"osWorkspaces/resources/rename": (input: {
		workspaceId: string;
		resourceId: string;
		name: string;
		expectedUpdatedAt: string;
	}) => {
		const resource = state.workspaceResources.find(
			(row) =>
				row.workspaceId === input.workspaceId && row.id === input.resourceId,
		);
		if (!resource)
			throw new RpcError("NOT_FOUND", "Workspace resource not found");
		if (resource.updatedAt !== input.expectedUpdatedAt) {
			throw new RpcError("CONFLICT", "Workspace resource changed concurrently");
		}
		resource.name = input.name;
		resource.updatedAt = now();
		return { resource };
	},
	"osWorkspaces/resources/remove": (input: {
		workspaceId: string;
		resourceId: string;
		expectedUpdatedAt: string;
	}) => {
		const resource = state.workspaceResources.find(
			(row) =>
				row.workspaceId === input.workspaceId && row.id === input.resourceId,
		);
		if (!resource)
			throw new RpcError("NOT_FOUND", "Workspace resource not found");
		if (resource.updatedAt !== input.expectedUpdatedAt) {
			throw new RpcError("CONFLICT", "Workspace resource changed concurrently");
		}
		resource.status = "removed";
		resource.removedAt = now();
		resource.updatedAt = resource.removedAt;
		return { resource };
	},
	"osWorkspaces/gadgets/list": (input: {
		workspaceId: string;
		status?: OsGadget["status"];
	}) => ({
		items: state.gadgets.filter(
			(row) =>
				row.workspaceId === input.workspaceId &&
				(input.status === undefined || row.status === input.status),
		),
		truncated: false,
	}),
	"osWorkspaces/gadgets/create": (input: {
		workspaceId: string;
		name: string;
		description?: string;
	}) => {
		findWorkspace(input.workspaceId);
		const gadget: OsGadget = {
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			name: input.name,
			description: input.description ?? null,
			status: "active",
			currentRevisionId: null,
			sourceBlueprintRevisionId: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
			updatedAt: now(),
		};
		state.gadgets.push(gadget);
		return { gadget };
	},
	"osWorkspaces/gadgets/get": (input: {
		workspaceId: string;
		gadgetId: string;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const currentRevision = latestRevision(
			state.gadgetRevisions.filter((row) => row.gadgetId === gadget.id),
		);
		return { gadget, currentRevision };
	},
	"osWorkspaces/gadgets/revise": (input: {
		workspaceId: string;
		gadgetId: string;
		manifest: OsGadgetRevision["manifest"];
		sourceArtifactRef?: string;
		expectedRevision?: number;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const current = latestRevision(
			state.gadgetRevisions.filter((row) => row.gadgetId === gadget.id),
		);
		const currentNumber = current?.revision ?? 0;
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== currentNumber
		) {
			throw revisionConflict(input.expectedRevision, current?.revision ?? null);
		}
		const revision: OsGadgetRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			gadgetId: gadget.id,
			revision: currentNumber + 1,
			manifest: {
				capabilities: input.manifest.capabilities ?? [],
				entry: input.manifest.entry,
				...(input.manifest.skillSlug !== undefined
					? { skillSlug: input.manifest.skillSlug }
					: {}),
				...(input.manifest.notes !== undefined
					? { notes: input.manifest.notes }
					: {}),
			},
			sourceArtifactRef: input.sourceArtifactRef ?? null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
		};
		state.gadgetRevisions.push(revision);
		gadget.currentRevisionId = revision.id;
		gadget.updatedAt = revision.createdAt;
		return { gadget, revision };
	},
	"osWorkspaces/gadgets/archive": (input: {
		workspaceId: string;
		gadgetId: string;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		gadget.status = "archived";
		gadget.updatedAt = now();
		return { gadget };
	},
	"osWorkspaces/gadgets/run": (input: {
		workspaceId: string;
		gadgetId: string;
		input?: OsGadgetExecution["input"];
		capabilities?: string[];
		tediId: string;
		approvalMode?: "policy" | "required";
		workItemId?: string;
		idempotencyKey?: string;
	}) => {
		const gadget = findGadget(input.workspaceId, input.gadgetId);
		const revision = latestRevision(
			state.gadgetRevisions.filter((row) => row.gadgetId === gadget.id),
		);
		const requested =
			input.capabilities ?? revision?.manifest.capabilities ?? [];
		const undeclared = requested.filter(
			(capability) => !revision?.manifest.capabilities.includes(capability),
		);
		const reasons = [
			...(gadget.status === "archived" ? ["gadget is archived"] : []),
			...(!revision ? ["gadget has no revision to run"] : []),
			...undeclared.map(
				(capability) => `capability is not declared: ${capability}`,
			),
		];
		const admitted = reasons.length === 0;
		const createdAt = now();
		const governed = admitted;
		const execution: OsGadgetExecution = {
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			gadgetId: gadget.id,
			revisionId: revision?.id ?? null,
			revision: revision?.revision ?? null,
			status: !admitted ? "denied" : governed ? "completed" : "running",
			grantedCapabilities: admitted ? requested : [],
			policyDecision: { allowed: admitted, reasons },
			input: input.input ?? null,
			output: governed
				? {
						ok: true,
						gadgetId: gadget.id,
						revision: revision?.revision ?? null,
					}
				: null,
			error: null,
			costs: governed ? { cpuMs: 32, inferenceMicros: 0 } : null,
			evidenceRefs: governed ? [`local://gadget-runs/${gadget.id}`] : null,
			lineage: {
				runId: governed ? nextId() : null,
				workflowInstanceId: governed ? nextId() : null,
				executionEpoch: 0,
				tediId: input.tediId,
				workItemId: input.workItemId ?? null,
				traceBundleId: governed ? `local-trace:${gadget.id}` : null,
				billingReservationId: governed ? nextId() : null,
				approvalRequestId: null,
				runtimeEnvironment: governed ? "development" : null,
				agentSessionId: null,
			},
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			completedAt: governed ? createdAt : null,
		};
		state.executions.unshift(execution);
		return { execution };
	},
	"osWorkspaces/executions/list": (input: {
		workspaceId: string;
		gadgetId: string;
		status?: OsGadgetExecution["status"];
	}) => ({
		items: state.executions.filter(
			(row) =>
				row.gadgetId === input.gadgetId &&
				row.workspaceId === input.workspaceId &&
				(input.status === undefined || row.status === input.status),
		),
		truncated: false,
	}),
	"osWorkspaces/outputs/list": (
		input:
			| {
					workspaceId?: string;
					kind?: OsOutput["kind"];
					status?: OsOutput["status"];
			  }
			| undefined,
	) => ({
		items: state.outputs.filter(
			(row) =>
				(input?.workspaceId === undefined ||
					row.workspaceId === input.workspaceId) &&
				(input?.kind === undefined || row.kind === input.kind) &&
				(input?.status === undefined || row.status === input.status),
		),
		truncated: false,
	}),
	"osWorkspaces/outputs/library": (
		input:
			| {
					kind?: OsOutput["kind"];
					status?: OsOutput["status"];
					limit?: number;
			  }
			| undefined,
	) => {
		const limit = input?.limit ?? 50;
		const rows = state.outputs
			.filter(
				(output) =>
					(input?.kind === undefined || output.kind === input.kind) &&
					(input?.status === undefined || output.status === input.status),
			)
			.map((output) => {
				const revision = latestRevision(
					state.outputRevisions.filter((row) => row.outputId === output.id),
				);
				if (!revision)
					throw new RpcError("NOT_FOUND", "Output revision not found");
				return localOutputLibraryItem(output, revision);
			});
		return { items: rows.slice(0, limit), truncated: rows.length > limit };
	},
	"osWorkspaces/outputs/create": (input: {
		kind: OsOutput["kind"];
		title: string;
		workspaceId?: string;
		content: OsOutputContent;
		note?: string;
	}) => {
		if (input.content.kind !== input.kind) {
			throw new RpcError(
				"BAD_REQUEST",
				"Content kind must match the output kind",
			);
		}
		const createdAt = now();
		const revision: OsOutputRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			outputId: nextId(),
			revision: 1,
			content: input.content,
			note: input.note ?? null,
			producedBy: null,
			accessEnvelope: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
		};
		const output: OsOutput = {
			id: revision.outputId,
			organizationId: ORG_ID,
			workspaceId: input.workspaceId ?? null,
			kind: input.kind,
			title: input.title,
			status: "active",
			currentRevisionId: revision.id,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			updatedAt: createdAt,
		};
		state.outputs.push(output);
		state.outputRevisions.push(revision);
		return { output, revision };
	},
	"osWorkspaces/outputs/get": (input: { outputId: string }) => {
		const output = findOutput(input.outputId);
		const currentRevision = latestRevision(
			state.outputRevisions.filter((row) => row.outputId === output.id),
		);
		if (!currentRevision)
			throw new RpcError("NOT_FOUND", "Output revision not found");
		return { output, currentRevision, authoringHomeRun: null };
	},
	"osWorkspaces/outputs/rename": (input: {
		outputId: string;
		title: string;
	}) => {
		const output = findOutput(input.outputId);
		output.title = input.title;
		output.updatedAt = now();
		return { output };
	},
	"osWorkspaces/outputs/revise": (input: {
		outputId: string;
		content: OsOutputContent;
		note?: string;
		expectedRevision?: number;
	}) => {
		const output = findOutput(input.outputId);
		if (input.content.kind !== output.kind) {
			throw new RpcError(
				"BAD_REQUEST",
				"Content kind must match the output kind",
			);
		}
		const current = latestRevision(
			state.outputRevisions.filter((row) => row.outputId === output.id),
		);
		const currentNumber = current?.revision ?? 0;
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== currentNumber
		) {
			throw revisionConflict(input.expectedRevision, current?.revision ?? null);
		}
		const revision: OsOutputRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			outputId: output.id,
			revision: currentNumber + 1,
			content: input.content,
			note: input.note ?? null,
			producedBy: null,
			accessEnvelope: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
		};
		state.outputRevisions.push(revision);
		output.currentRevisionId = revision.id;
		output.updatedAt = revision.createdAt;
		return { output, revision };
	},
	"osWorkspaces/outputs/export": (input: {
		outputId: string;
		format: "pdf" | "png";
	}) => {
		const output = findOutput(input.outputId);
		const current = latestRevision(
			state.outputRevisions.filter((row) => row.outputId === output.id),
		);
		return {
			key: `exports/${output.id}/rev-${current?.revision ?? 1}.${input.format}`,
			format: input.format,
			revision: current?.revision ?? 1,
			sizeBytes: 128_000,
			url: `https://local.invalid/exports/${output.id}.${input.format}`,
		};
	},
	"osWorkspaces/outputs/archive": (input: { outputId: string }) => {
		const output = findOutput(input.outputId);
		output.status = "archived";
		output.updatedAt = now();
		return { output };
	},
	"osWorkspaces/collaboration/list": (input: {
		workspaceId: string;
		documentType?: OsCollaborationProposal["documentType"];
		documentId?: string;
		statuses?: OsCollaborationProposal["status"][];
		limit?: number;
	}) => {
		const items = state.collaborationProposals
			.filter(
				(row) =>
					row.workspaceId === input.workspaceId &&
					(input.documentType === undefined ||
						row.documentType === input.documentType) &&
					(input.documentId === undefined ||
						row.documentId === input.documentId) &&
					(input.statuses === undefined || input.statuses.includes(row.status)),
			)
			.slice(0, input.limit ?? 50);
		return { items, truncated: false };
	},
	"osWorkspaces/collaboration/get": (input: { proposalId: string }) => ({
		proposal: findCollaborationProposal(input.proposalId),
	}),
	"osWorkspaces/collaboration/create": (input: {
		workspaceId: string;
		documentType: OsCollaborationProposal["documentType"];
		documentId: string;
		sourceKind: OsCollaborationProposal["sourceKind"];
		sourceId: string;
		content: OsCollaborationProposal["content"];
	}) => {
		findWorkspace(input.workspaceId);
		const currentRevision =
			input.documentType === "gadget"
				? latestRevision(
						state.gadgetRevisions.filter(
							(row) =>
								row.gadgetId ===
								findGadget(input.workspaceId, input.documentId).id,
						),
					)
				: latestRevision(
						state.outputRevisions.filter(
							(row) => row.outputId === findOutput(input.documentId).id,
						),
					);
		if (!currentRevision) {
			throw new RpcError("CONFLICT", "Document has no immutable base revision");
		}
		const createdAt = now();
		const proposal: OsCollaborationProposal = {
			id: nextId(),
			organizationId: ORG_ID,
			workspaceId: input.workspaceId,
			documentType: input.documentType,
			documentId: input.documentId,
			baseRevisionId: currentRevision.id,
			baseRevision: currentRevision.revision,
			status: "open",
			sourceKind: input.sourceKind,
			sourceId: input.sourceId,
			content: input.content,
			sequence: 0,
			createdByKind: "external_agent",
			createdById: "local-agent",
			createdAt,
			updatedAt: createdAt,
			decisionRationale: null,
			decisionEvidenceRefs: [],
			decidedByKind: null,
			decidedById: null,
			decidedAt: null,
			mergeRationale: null,
			mergeEvidenceRefs: [],
			mergedByKind: null,
			mergedById: null,
			mergedAt: null,
			resultRevisionId: null,
			resultRevision: null,
		};
		state.collaborationProposals.push(proposal);
		return { proposal };
	},
	"osWorkspaces/collaboration/updatePreview": (input: {
		proposalId: string;
		expectedSequence: number;
		content: OsCollaborationProposal["content"];
	}) => {
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			proposal.status !== "open" ||
			proposal.sequence !== input.expectedSequence
		) {
			throw new RpcError("CONFLICT", "Proposal preview changed");
		}
		proposal.content = input.content;
		proposal.sequence += 1;
		proposal.updatedAt = now();
		return { proposal };
	},
	"osWorkspaces/collaboration/accept": (input: {
		proposalId: string;
		expectedSequence: number;
		rationale: string;
		evidenceRefs?: string[];
	}) => {
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			proposal.status !== "open" ||
			proposal.sequence !== input.expectedSequence
		) {
			throw new RpcError("CONFLICT", "Proposal preview changed");
		}
		proposal.status = "accepted";
		proposal.decisionRationale = input.rationale;
		proposal.decisionEvidenceRefs = input.evidenceRefs ?? [];
		proposal.decidedByKind = "user";
		proposal.decidedById = "dev-operator";
		proposal.decidedAt = now();
		proposal.updatedAt = proposal.decidedAt;
		return { proposal };
	},
	"osWorkspaces/collaboration/reject": (input: {
		proposalId: string;
		expectedSequence: number;
		rationale: string;
		evidenceRefs?: string[];
	}) => {
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			(proposal.status !== "open" && proposal.status !== "accepted") ||
			proposal.sequence !== input.expectedSequence
		) {
			throw new RpcError("CONFLICT", "Proposal preview changed");
		}
		proposal.status = "rejected";
		proposal.decisionRationale = input.rationale;
		proposal.decisionEvidenceRefs = input.evidenceRefs ?? [];
		proposal.decidedByKind = "user";
		proposal.decidedById = "dev-operator";
		proposal.decidedAt = now();
		proposal.updatedAt = proposal.decidedAt;
		return { proposal };
	},
	"osWorkspaces/collaboration/merge": (input: {
		proposalId: string;
		expectedSequence: number;
		rationale: string;
		evidenceRefs?: string[];
	}) => {
		const proposal = findCollaborationProposal(input.proposalId);
		if (
			proposal.status !== "accepted" ||
			proposal.sequence !== input.expectedSequence
		) {
			throw new RpcError("CONFLICT", "Proposal is not accepted");
		}
		const createdAt = now();
		const revisionId = nextId();
		const revisionNumber = proposal.baseRevision + 1;
		const revision =
			proposal.documentType === "gadget"
				? (() => {
						const gadget = findGadget(
							proposal.workspaceId,
							proposal.documentId,
						);
						if (gadget.currentRevisionId !== proposal.baseRevisionId) {
							throw revisionConflict(proposal.baseRevision, revisionNumber);
						}
						const next: OsGadgetRevision = {
							id: revisionId,
							organizationId: ORG_ID,
							gadgetId: gadget.id,
							revision: revisionNumber,
							manifest: proposal.content as OsGadgetRevision["manifest"],
							sourceArtifactRef: null,
							createdByKind: "user",
							createdById: "dev-operator",
							createdAt,
						};
						state.gadgetRevisions.push(next);
						gadget.currentRevisionId = revisionId;
						gadget.updatedAt = createdAt;
						return next;
					})()
				: (() => {
						const output = findOutput(proposal.documentId);
						if (output.currentRevisionId !== proposal.baseRevisionId) {
							throw revisionConflict(proposal.baseRevision, revisionNumber);
						}
						const next: OsOutputRevision = {
							id: revisionId,
							organizationId: ORG_ID,
							outputId: output.id,
							revision: revisionNumber,
							content: proposal.content as OsOutputContent,
							note: input.rationale,
							producedBy: null,
							accessEnvelope: null,
							createdByKind: "user",
							createdById: "dev-operator",
							createdAt,
						};
						state.outputRevisions.push(next);
						output.currentRevisionId = revisionId;
						output.updatedAt = createdAt;
						return next;
					})();
		proposal.status = "merged";
		proposal.mergeRationale = input.rationale;
		proposal.mergeEvidenceRefs = input.evidenceRefs ?? [];
		proposal.mergedByKind = "user";
		proposal.mergedById = "dev-operator";
		proposal.mergedAt = createdAt;
		proposal.resultRevisionId = revisionId;
		proposal.resultRevision = revisionNumber;
		proposal.updatedAt = createdAt;
		return { proposal, revision };
	},
	"osWorkspaces/blueprints/list": (
		input: { status?: OsBlueprint["status"] } | undefined,
	) => ({
		items: state.blueprints.filter(
			(row) => input?.status === undefined || row.status === input.status,
		),
		truncated: false,
	}),
	"osWorkspaces/blueprints/gallery": (input: { limit: number }) => ({
		items: state.blueprints
			.filter(
				(row) => row.status === "published" && row.visibility === "catalog",
			)
			.slice(0, input.limit)
			.map((blueprint) => {
				const revision = latestRevision(
					state.blueprintRevisions.filter(
						(row) => row.blueprintId === blueprint.id,
					),
				);
				return {
					id: blueprint.id,
					name: blueprint.name,
					description: blueprint.description,
					gadgetCount: revision?.definition.gadgets.length ?? 0,
					organizationName: "Tedix local",
					publishedAt: revision?.publishedAt ?? null,
				};
			}),
	}),
	"osWorkspaces/blueprints/create": (input: {
		name: string;
		description?: string;
	}) => {
		const blueprint: OsBlueprint = {
			id: nextId(),
			organizationId: ORG_ID,
			name: input.name,
			description: input.description ?? null,
			status: "draft",
			visibility: "org",
			currentRevisionId: null,
			lineage: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
			updatedAt: now(),
		};
		state.blueprints.push(blueprint);
		return { blueprint };
	},
	"osWorkspaces/blueprints/get": (input: { blueprintId: string }) => {
		const blueprint = findBlueprint(input.blueprintId);
		const currentRevision = latestRevision(
			state.blueprintRevisions.filter(
				(row) => row.blueprintId === blueprint.id,
			),
		);
		return { blueprint, currentRevision };
	},
	"osWorkspaces/blueprints/revise": (input: {
		blueprintId: string;
		definition: OsBlueprintRevision["definition"];
		expectedRevision?: number;
	}) => {
		const blueprint = findBlueprint(input.blueprintId);
		const current = latestRevision(
			state.blueprintRevisions.filter(
				(row) => row.blueprintId === blueprint.id,
			),
		);
		const currentNumber = current?.revision ?? 0;
		if (
			input.expectedRevision !== undefined &&
			input.expectedRevision !== currentNumber
		) {
			throw revisionConflict(input.expectedRevision, current?.revision ?? null);
		}
		const revision: OsBlueprintRevision = {
			id: nextId(),
			organizationId: ORG_ID,
			blueprintId: blueprint.id,
			revision: currentNumber + 1,
			definition: {
				gadgets: input.definition.gadgets ?? [],
				requirements: input.definition.requirements ?? null,
			},
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt: now(),
			publishedAt: null,
		};
		state.blueprintRevisions.push(revision);
		blueprint.currentRevisionId = revision.id;
		blueprint.updatedAt = revision.createdAt;
		return { blueprint, revision };
	},
	"osWorkspaces/blueprints/publish": (input: { blueprintId: string }) => {
		const blueprint = findBlueprint(input.blueprintId);
		const revision = latestRevision(
			state.blueprintRevisions.filter(
				(row) => row.blueprintId === blueprint.id,
			),
		);
		if (!revision) {
			throw new RpcError("BAD_REQUEST", "Blueprint has no revision to publish");
		}
		blueprint.status = "published";
		blueprint.updatedAt = now();
		revision.publishedAt = blueprint.updatedAt;
		return { blueprint, revision };
	},
	"osWorkspaces/blueprints/setVisibility": (input: {
		blueprintId: string;
		visibility: OsBlueprint["visibility"];
	}) => {
		const blueprint = findBlueprint(input.blueprintId);
		if (blueprint.status !== "published") {
			throw new RpcError(
				"BAD_REQUEST",
				"Only a published blueprint can change catalog visibility",
			);
		}
		blueprint.visibility = input.visibility;
		blueprint.updatedAt = now();
		return { blueprint };
	},
	"osWorkspaces/blueprints/export": (input: {
		blueprintId: string;
		revisionId?: string;
	}) => {
		const blueprint = findBlueprint(input.blueprintId);
		const revision = input.revisionId
			? state.blueprintRevisions.find(
					(row) =>
						row.id === input.revisionId && row.blueprintId === blueprint.id,
				)
			: latestRevision(
					state.blueprintRevisions.filter(
						(row) => row.blueprintId === blueprint.id,
					),
				);
		if (!revision) {
			throw new RpcError("BAD_REQUEST", "Blueprint has no revision to export");
		}
		const portableExport: OsBlueprintExport = {
			envelopeVersion: 1,
			exportedAt: now(),
			exportedByKind: "user",
			source: {
				organizationId: ORG_ID,
				organizationName: "Tedix local",
				blueprintId: blueprint.id,
				blueprintName: blueprint.name,
				revisionId: revision.id,
				revision: revision.revision,
				definitionSha256: "a".repeat(64),
				forkedAt: now(),
				via: "export",
				attested: true,
			},
			blueprint: {
				name: blueprint.name,
				description: blueprint.description,
				status: blueprint.status,
			},
			revision: {
				revision: revision.revision,
				createdAt: revision.createdAt,
				publishedAt: revision.publishedAt,
				createdByKind: revision.createdByKind,
			},
			definition: revision.definition,
			lineage: blueprint.lineage,
		};
		return { export: portableExport };
	},
	"osWorkspaces/blueprints/import": (input: {
		export: OsBlueprintExport;
		name?: string;
	}) => {
		const name = input.name ?? input.export.blueprint.name;
		if (state.blueprints.some((row) => row.name === name)) {
			throw new RpcError(
				"CONFLICT",
				"A blueprint with this name already exists in the organization",
			);
		}
		const createdAt = now();
		const blueprintId = nextId();
		const revisionId = nextId();
		const inherited = (input.export.lineage?.chain ?? []).map((entry) => ({
			...entry,
			attested: false,
		}));
		const chain = [
			{ ...input.export.source, attested: false as const },
			...inherited,
		];
		const blueprint: OsBlueprint = {
			id: blueprintId,
			organizationId: ORG_ID,
			name,
			description: input.export.blueprint.description,
			status: "draft",
			visibility: "org",
			currentRevisionId: revisionId,
			lineage: {
				version: 1,
				chain: chain.slice(0, 20),
				truncated:
					chain.length > 20 || (input.export.lineage?.truncated ?? false),
			},
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			updatedAt: createdAt,
		};
		const revision: OsBlueprintRevision = {
			id: revisionId,
			organizationId: ORG_ID,
			blueprintId,
			revision: 1,
			definition: input.export.definition,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			publishedAt: null,
		};
		state.blueprints.push(blueprint);
		state.blueprintRevisions.push(revision);
		return { blueprint, revision };
	},
	"osWorkspaces/blueprints/instantiate": (input: {
		blueprintId: string;
		workspaceName: string;
		description?: string;
		resourceBindings?: Array<{
			slot: string;
			selection: Omit<
				OsWorkspaceResource,
				| "id"
				| "organizationId"
				| "workspaceId"
				| "slot"
				| "status"
				| "createdByKind"
				| "createdById"
				| "createdAt"
				| "updatedAt"
				| "removedAt"
			>;
		}>;
	}) => {
		const blueprint = findBlueprint(input.blueprintId);
		if (blueprint.status !== "published") {
			throw new RpcError(
				"BAD_REQUEST",
				"Only a published blueprint instantiates",
			);
		}
		const revision = latestRevision(
			state.blueprintRevisions.filter(
				(row) => row.blueprintId === blueprint.id,
			),
		);
		if (!revision) {
			throw new RpcError("BAD_REQUEST", "Published blueprint has no revision");
		}
		if (state.workspaces.some((row) => row.name === input.workspaceName)) {
			throw new RpcError("CONFLICT", "Workspace name already taken");
		}
		const createdAt = now();
		// The local surface resolves no tenant state, so it reports exactly what
		// the real preflight reports when nothing was resolved: `not_configured`
		// with an empty decision trail. It never fabricates satisfied pins.
		const preflight: OsBlueprintPreflight = {
			blueprintId: blueprint.id,
			revisionId: revision.id,
			revision: revision.revision,
			status: "not_configured",
			instantiateAllowed: true,
			targetTediId: null,
			requirements: null,
			decisions: [],
			blockingReasons: [],
			configurationReasons: [],
			consentReasons: [],
			resolvedAt: createdAt,
		};
		const workspace: OsWorkspace = {
			id: nextId(),
			organizationId: ORG_ID,
			name: input.workspaceName,
			description: input.description ?? blueprint.description,
			status: "active",
			sourceBlueprintId: blueprint.id,
			sourceBlueprintRevisionId: revision.id,
			sourceBlueprintRevisionNumber: revision.revision,
			instantiationPreflight: preflight,
			rollbackReference: null,
			blueprintDecision: null,
			createdByKind: "user",
			createdById: "dev-operator",
			createdAt,
			updatedAt: createdAt,
		};
		state.workspaces.push(workspace);
		const resources = (input.resourceBindings ?? []).map((binding) => {
			const resource: OsWorkspaceResource = {
				...binding.selection,
				id: nextId(),
				organizationId: ORG_ID,
				workspaceId: workspace.id,
				slot: binding.slot,
				status: "active",
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
				updatedAt: createdAt,
				removedAt: null,
			};
			state.workspaceResources.push(resource);
			return resource;
		});
		const gadgets = revision.definition.gadgets.map((declared) => {
			const gadget: OsGadget = {
				id: nextId(),
				organizationId: ORG_ID,
				workspaceId: workspace.id,
				name: declared.name,
				description: null,
				status: "active",
				currentRevisionId: null,
				sourceBlueprintRevisionId: revision.id,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
				updatedAt: createdAt,
			};
			const gadgetRevision: OsGadgetRevision = {
				id: nextId(),
				organizationId: ORG_ID,
				gadgetId: gadget.id,
				revision: 1,
				manifest: declared.manifest,
				sourceArtifactRef: null,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt,
			};
			gadget.currentRevisionId = gadgetRevision.id;
			state.gadgets.push(gadget);
			state.gadgetRevisions.push(gadgetRevision);
			return { gadget, revision: gadgetRevision };
		});
		return { workspace, blueprint, revision, preflight, resources, gadgets };
	},
	"osWorkspaces/blueprints/instantiateFromGallery": (input: {
		blueprintId: string;
		workspaceName: string;
		tediId?: string;
	}) => {
		const source = findBlueprint(input.blueprintId);
		if (source.status !== "published" || source.visibility !== "catalog") {
			throw new RpcError("NOT_FOUND", "OS blueprint not found");
		}
		const sourceRevision = latestRevision(
			state.blueprintRevisions.filter((row) => row.blueprintId === source.id),
		);
		if (!sourceRevision) {
			throw new RpcError("NOT_FOUND", "OS blueprint not found");
		}
		const createdAt = now();
		const blueprintId = nextId();
		const revisionId = nextId();
		const blueprint: OsBlueprint = {
			...source,
			id: blueprintId,
			name: `${source.name} copy`,
			description:
				`${source.description ?? ""}\n\nImported from the blueprint gallery: "${source.name}" by Tedix local.`.trim(),
			visibility: "org",
			currentRevisionId: revisionId,
			createdAt,
			updatedAt: createdAt,
		};
		const revision: OsBlueprintRevision = {
			...sourceRevision,
			id: revisionId,
			blueprintId,
			revision: 1,
			createdAt,
		};
		state.blueprints.push(blueprint);
		state.blueprintRevisions.push(revision);
		return handlers["osWorkspaces/blueprints/instantiate"]!({
			blueprintId,
			workspaceName: input.workspaceName,
		} as never);
	},

	// --- Home / kernel runtime ---
	"kernelRuntime/listConversations": () => ({
		conversations: state.conversations
			.filter((row) => row.hidden !== true)
			.map(({ hidden: _hidden, ...conversation }) => conversation),
		nextCursor: null,
	}),
	"kernelRuntime/renameConversation": (input: {
		conversationId: string;
		title: string;
	}) => {
		const conversation = findConversation(input.conversationId);
		conversation.title = input.title;
		conversation.updatedAt = now();
		const { hidden: _hidden, ...row } = conversation;
		return { conversation: row };
	},
	"kernelRuntime/pinConversation": (input: {
		conversationId: string;
		pinned: boolean;
	}) => {
		const conversation = findConversation(input.conversationId);
		conversation.pinnedAt = input.pinned ? now() : null;
		conversation.updatedAt = now();
		const { hidden: _hidden, ...row } = conversation;
		return { conversation: row };
	},
	"kernelRuntime/deleteConversation": (input: { conversationId: string }) => {
		const conversation = findConversation(input.conversationId);
		conversation.hidden = true;
		return {
			ok: true,
			conversationId: conversation.id,
			deletedAt: now(),
			hardDeleted: true,
			canceledRunCount: 0,
		};
	},
	"kernelRuntime/readMessages": (input: { conversationId: string }) => ({
		messages: state.messages.filter(
			(row) => row.conversationId === input.conversationId,
		),
		nextCursor: null,
	}),
	"kernelRuntime/readRunSet": (input: { conversationId: string }) => {
		const runs = state.homeRuns.filter(
			(row) => row.conversationId === input.conversationId,
		);
		return {
			runSet: {
				organizationId: ORG_ID,
				conversationId: input.conversationId,
				activeRunIds: runs
					.filter((row) => row.status === "queued" || row.status === "running")
					.map((row) => row.id),
				runs,
				approvalMirrors: {},
				updatedAt: now(),
			},
		};
	},
	"kernelRuntime/readRunEvents": (input: { runId: string }) => {
		const run = state.homeRuns.find((row) => row.id === input.runId);
		const outputMessage = run
			? state.messages.find((row) => row.id === run.outputMessageId)
			: undefined;
		const events =
			run && outputMessage
				? [
						{
							id: `${run.id}:0`,
							kind: "run.started",
							conversationId: run.conversationId,
							runId: run.id,
							sequence: 0,
							createdAt: run.createdAt,
						},
						{
							id: `${run.id}:1`,
							kind: "message.completed",
							conversationId: run.conversationId,
							runId: run.id,
							messageId: outputMessage.id,
							sequence: 1,
							payload: { content: outputMessage.content },
							createdAt: outputMessage.createdAt,
						},
					]
				: [];
		return {
			events,
			stream: {
				streamId: `stream-${input.runId}`,
				offset: 0,
				nextOffset: events.length,
				closed: true,
				terminalEventId:
					events.length > 0 ? events[events.length - 1]?.id : null,
				submissionId: null,
			},
		};
	},
	"kernelRuntime/respondApproval": (input: { runId: string }) => ({
		run: findHomeRun(input.runId),
		assignments: [],
	}),
	"kernelRuntime/cancelRun": (input: { runId: string }) => {
		const run = findHomeRun(input.runId);
		run.status = "canceled";
		run.completedAt = now();
		run.updatedAt = run.completedAt;
		return { run };
	},
	"kernelRuntime/retryRun": (input: { runId: string }) => {
		const failed = findHomeRun(input.runId);
		const retried: HomeRun = {
			...failed,
			id: nextId(),
			status: "queued",
			startedAt: null,
			completedAt: null,
			createdAt: now(),
			updatedAt: now(),
		};
		state.homeRuns.push(retried);
		return { run: retried, newRunId: retried.id };
	},
	// Fixture-only upload acknowledgement; production validation/storage lives in API.
	"kernelRuntime/uploadAttachment": (input: TediMessageAttachment) => ({
		...input,
		content: `tedix-attachment:${nextId().replaceAll("-", "").repeat(2)}`,
	}),
	"kernelRuntime/enqueueMessage": (input: {
		conversationId?: string;
		content: string;
		idempotencyKey?: string;
		attachments?: HomeMessage["attachments"];
	}) => {
		const timestamp = now();
		let conversation = input.conversationId
			? findConversation(input.conversationId)
			: undefined;
		if (!conversation) {
			conversation = {
				id: nextId(),
				organizationId: ORG_ID,
				title: input.content.slice(0, 60) || "New conversation",
				status: "active",
				channel: "os",
				lastMessageAt: timestamp,
				messageCount: 0,
				createdAt: timestamp,
				updatedAt: timestamp,
				pinnedAt: null,
				origin: "human",
			};
			state.conversations.push(conversation);
		}
		const run: HomeRun = {
			id: nextId(),
			organizationId: ORG_ID,
			conversationId: conversation.id,
			status: "completed",
			startedAt: timestamp,
			completedAt: timestamp,
			createdAt: timestamp,
			updatedAt: timestamp,
			usage: {
				pricing: null,

				inputTokens: 620,
				outputTokens: 96,
				reasoningTokens: 24,
				totalTokens: 716,
				costUsd: 0.0052,
			},
		};
		const userMessage: HomeMessage = {
			id: nextId(),
			organizationId: ORG_ID,
			conversationId: conversation.id,
			runId: run.id,
			role: "user",
			status: "completed",
			content: input.content,
			attachments: input.attachments,
			createdAt: timestamp,
		};
		const assistantMessage: HomeMessage = {
			id: nextId(),
			organizationId: ORG_ID,
			conversationId: conversation.id,
			runId: run.id,
			role: "assistant",
			status: "completed",
			content: CANNED_REPLY,
			createdAt: timestamp,
		};
		run.inputMessageId = userMessage.id;
		run.outputMessageId = assistantMessage.id;
		state.messages.push(userMessage, assistantMessage);
		state.homeRuns.push(run);
		conversation.lastMessageAt = timestamp;
		conversation.updatedAt = timestamp;
		conversation.messageCount = (conversation.messageCount ?? 0) + 2;
		return {
			idempotencyKey: input.idempotencyKey ?? `local-${run.id}`,
			conversationId: conversation.id,
			status: "queued" as const,
			run,
			assistantMessage,
		};
	},
};

export const LOCAL_RPC_PROCEDURES: readonly string[] = Object.keys(handlers);

/** Fixture ids the unit tests (and curl probes) address directly. */
export const LOCAL_FIXTURE_IDS = {
	orgId: ORG_ID,
	tediMiles: TEDI_MILES,
	tediNova: TEDI_NOVA,
	workspaceRevenue: WORKSPACE_REVENUE,
	workspaceSupport: WORKSPACE_SUPPORT,
	gadgetDashboard: GADGET_DASHBOARD,
	outputDocument: OUTPUT_DOCUMENT,
	outputSheet: OUTPUT_SHEET,
	outputDeck: OUTPUT_DECK,
	collaborationProposalOpen: COLLAB_PROPOSAL_OPEN,
	collaborationProposalAccepted: COLLAB_PROPOSAL_ACCEPTED,
	blueprintPublished: BLUEPRINT_PUBLISHED,
	blueprintDraft: BLUEPRINT_DRAFT,
	conversationHome: CONVERSATION_HOME,
	homeRunDone: HOME_RUN_DONE,
	skillRunCompleted: RUN_REVENUE_OK,
	skillRevenue: SKILL_REVENUE,
	skillChurn: SKILL_CHURN,
	skillRunFailed: RUN_CHURN_FAILED,
	appStorefront: APP_STOREFRONT,
	approvalPending: fid("71", 1),
	/** The one settled MCP payment event, addressable as a receipt. */
	paymentReceipt: MCP_PAYMENT_RECEIPT,
	documentContent,
	sheetContent,
	deckContent,
} as const;

// ---------------------------------------------------------------------------
// Wire envelope
// ---------------------------------------------------------------------------

type RpcMetaEntry = [string, ...(string | number)[]];

/**
 * Re-apply the client serializer's meta markers to the raw json payload. Only
 * the built-in types our SPA can emit matter here; `"undefined"` is the
 * load-bearing one (optional fields sent as explicit `undefined` arrive as
 * `null` + marker and must not fail `.optional()` input schemas).
 */
function decodeRpcInput(body: unknown): unknown {
	if (body === undefined || body === null) return undefined;
	const envelope = body as { json?: unknown; meta?: RpcMetaEntry[] };
	const ref: { data: unknown } = { data: envelope.json };
	for (const entry of envelope.meta ?? []) {
		const type = entry[0];
		let parent: unknown = ref;
		let key: string | number = "data";
		for (let index = 1; index < entry.length; index++) {
			parent = (parent as Record<string | number, unknown>)[key];
			const segment = entry[index];
			if (
				segment === undefined ||
				parent === null ||
				typeof parent !== "object"
			) {
				parent = undefined;
				break;
			}
			key = segment;
		}
		if (parent === undefined || parent === null || typeof parent !== "object")
			continue;
		const holder = parent as Record<string | number, unknown>;
		if (type === "undefined") holder[key] = undefined;
		else if (type === "date") holder[key] = new Date(String(holder[key]));
		else if (type === "bigint") holder[key] = BigInt(String(holder[key]));
	}
	return ref.data;
}

const errorEnvelope = (error: RpcError): { status: number; body: unknown } => ({
	status: RPC_ERROR_STATUS[error.code],
	body: {
		json: {
			defined: true,
			inferable: true,
			code: error.code,
			message: error.message,
			...(error.data !== undefined ? { data: error.data } : {}),
		},
	},
});

/**
 * Route one oRPC request. `path` is the request path (query string tolerated),
 * `body` the parsed JSON envelope (`{"json": ..., "meta": [...]}`) or
 * undefined for body-less calls. Returns null for paths this lane does not
 * handle so the middleware can 404 loudly instead of hanging.
 */
export function handleLocalRpc(
	path: string,
	method: string,
	body: unknown,
): { status: number; body: unknown } | null {
	const cleanPath = path.split("?")[0] ?? path;
	const match = cleanPath.match(/^\/api\/rpc\/(.+)$/);
	if (!match?.[1]) return null;
	const key = match[1].split("/").map(decodeURIComponent).join("/");
	const handler = handlers[key];
	if (!handler) return null;
	if (method !== "POST" && method !== "GET") {
		return errorEnvelope(
			new RpcError("BAD_REQUEST", `Unsupported method ${method}`),
		);
	}
	const input = decodeRpcInput(body);
	try {
		return {
			status: 200,
			body: { json: (handler as (value: unknown) => unknown)(input) },
		};
	} catch (error) {
		if (error instanceof RpcError) return errorEnvelope(error);
		throw error;
	}
}
