/**
 * Shared basics for the local fixture lane: deterministic ids and times, the
 * RPC error type, and the row shapes the in-memory store keeps.
 */

import type { OsApprovalRule } from "@tedix/api-contract/contracts/os-approval-rules";
import {
	blocksFromRichText,
	normalizeDocumentContent,
} from "@tedix/api-contract/utils/os-document";
import type {
	HomeConversation,
	HomeMessage,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { AppRuntimeFiles } from "@tedix/api-contract/schemas/os-app-runtime";
import type { Organization } from "@tedix/api-contract/schemas/organization";
import type { OsUserPreferences } from "@tedix/api-contract/schemas/user-settings";
import type { OsBlueprintWithVisibility as OsBlueprint } from "@tedix/api-contract/contracts/os-workspaces";
import type {
	OsBlueprintRevision,
	OsCollaborationProposal,
	OsGadget,
	OsGadgetExecution,
	OsGadgetRevision,
	OsOutput,
	OsOutputContent,
	OsOutputRevision,
	OsWorkspace,
	OsWorkspacePreference,
	OsWorkspaceProject,
	OsWorkspaceResource,
} from "@tedix/api-contract/schemas/os-workspaces";

/** Mirrors `APP_RUNTIME_ENTRY` in `@tedix/api-contract/schemas/os-app-runtime` (type-only imports here). */
export const APP_RUNTIME_ENTRY = "tedix:runtime/v1";

export function emptyUnreadState(workspaceId: string) {
	return {
		workspaceId,
		chat: 0,
		files: 0,
		total: 0,
		fileIds: [],
		conversations: [],
	};
}

// ---------------------------------------------------------------------------
// Deterministic identity + time
// ---------------------------------------------------------------------------

/** Fixed, valid v4-shaped UUIDs: block selects the entity family. */
export const fid = (block: string, n: number): string =>
	`${block.padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export const ORG_ID = fid("0a", 1);

export const TEDI_NOVA = fid("10", 1);
export const TEDI_MILES = fid("10", 2);
export const TEDI_JUNO = fid("10", 3);

export const SKILL_REVENUE = fid("20", 1);
export const SKILL_TRIAGE = fid("20", 2);
export const SKILL_CHURN = fid("20", 3);
export const SKILL_BRIEF = fid("20", 4);

export const RUN_REVENUE_OK = fid("21", 1);
export const RUN_CHURN_FAILED = fid("21", 2);
export const RUN_REVENUE_LIVE = fid("21", 3);

export const WORKSPACE_REVENUE = fid("30", 1);
export const WORKSPACE_SUPPORT = fid("30", 2);
export const WORKSPACE_RESOURCE_REPO = fid("30", 3);
export const GADGET_DASHBOARD = fid("31", 1);
export const GADGET_TRIAGE = fid("31", 2);
export const GADGET_REV_DASHBOARD = fid("32", 1);
export const GADGET_REV_TRIAGE = fid("32", 2);
export const GADGET_CARD_REVIEW = fid("31", 3);
export const GADGET_REV_CARD_REVIEW = fid("32", 3);
export const GADGET_SYSTEM_MAP = fid("31", 4);
export const GADGET_REV_SYSTEM_MAP = fid("32", 4);
export const OUTPUT_CARDS = fid("40", 4);
export const OUTPUT_RULES = fid("40", 5);
export const EXEC_DASHBOARD_DONE = fid("33", 1);
export const EXEC_DASHBOARD_LIVE = fid("33", 2);

export const OUTPUT_DOCUMENT = fid("40", 1);
export const OUTPUT_SHEET = fid("40", 2);
export const OUTPUT_DECK = fid("40", 3);
export const COLLAB_PROPOSAL_OPEN = fid("42", 1);
export const COLLAB_PROPOSAL_ACCEPTED = fid("42", 2);

export const BLUEPRINT_PUBLISHED = fid("50", 1);
export const BLUEPRINT_DRAFT = fid("50", 2);
/** Support Desk (Finance ops in the demo) was made from version 1; version 2 is newer. */
export const BLUEPRINT_SUPPORT = fid("50", 3);

export const CONVERSATION_HOME = fid("60", 1);
export const HOME_RUN_DONE = fid("62", 1);
/**
 * Home → Miles delegations for the Response details panel. Kernel ids are not
 * always UUIDs; these mirror the live `<slug>-home-<uuid>` and
 * `<uuid>:mcp:<slug>` shapes. Open with
 * `/chat?conversation=<CONVERSATION_DELEGATION>&details=<run>&branch=<child>`.
 */
export const CONVERSATION_DELEGATION = fid("60", 9);
export const HOME_RUN_DELEGATING = `revenue-check-home-${fid("62", 2)}`;
export const CHILD_RUN_DELEGATING = `${fid("63", 2)}:mcp:${HOME_RUN_DELEGATING}`;
export const HOME_RUN_DELEGATED = `revenue-check-home-${fid("62", 3)}`;
export const CHILD_RUN_DELEGATED = `${fid("63", 3)}:mcp:${HOME_RUN_DELEGATED}`;
export const DELEGATION_WORK_ITEM = fid("64", 1);

export const APP_STOREFRONT = fid("80", 1);
export const APP_SUPPORT = fid("80", 2);
export const APP_FINANCE = fid("80", 3);
export const APP_GATEWAY = fid("80", 4);

export const T0 = "2026-08-10T09:00:00.000Z";
export const T1 = "2026-08-10T13:00:00.000Z";
export const T2 = "2026-08-11T06:00:00.000Z";
export const T3 = "2026-08-11T13:05:00.000Z";
export const T4 = "2026-08-12T08:30:00.000Z";
export const T5 = "2026-08-12T08:31:00.000Z";

export const LOCAL_WIDGET_APP_SLUG = "tedix-local";
export const LOCAL_WIDGET_RESOURCE_URI =
	"ui://widgets/mcp-app/tedix-local/r/revenue-dashboard.html";

export const now = (): string => new Date().toISOString();

export let seq = 0;

export function setSeq(value: typeof seq): void {
	seq = value;
}

export const nextId = (): string => fid("9e", ++seq);

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

type RpcErrorCode = "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";

export const RPC_ERROR_STATUS: Record<RpcErrorCode, number> = {
	BAD_REQUEST: 400,
	FORBIDDEN: 403,
	NOT_FOUND: 404,
	CONFLICT: 409,
};

export class RpcError extends Error {
	constructor(
		readonly code: RpcErrorCode,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
	}
}

/** How the plain block copy of a document follows its rich body here. */
export const LOCAL_OUTPUT_PROJECTIONS = { documentBlocks: blocksFromRichText };

/** Stored content as the editors hold it; see the API's `editableStoredContent`. */
export const editableLocalContent = (
	content: OsOutputContent,
): OsOutputContent =>
	content.kind === "document" && !content.file && content.blocks.length
		? normalizeDocumentContent(content)
		: content;

export const revisionConflict = (
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

export type ApprovalRow = {
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

export type SkillRunRow = {
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

export type LocalState = {
	/** The one local organization; profile writes mutate it in place. */
	organization: Organization;
	workspaces: OsWorkspace[];
	workspacePreferences: OsWorkspacePreference[];
	workspaceResources: OsWorkspaceResource[];
	workspaceProjects: OsWorkspaceProject[];
	gadgets: OsGadget[];
	gadgetRevisions: OsGadgetRevision[];
	/** Runtime app files by revision id (`os_gadget_code`). */
	gadgetCode: Record<string, AppRuntimeFiles>;
	executions: OsGadgetExecution[];
	outputs: OsOutput[];
	outputRevisions: OsOutputRevision[];
	collaborationProposals: OsCollaborationProposal[];
	blueprints: OsBlueprint[];
	blueprintRevisions: OsBlueprintRevision[];
	/** Gallery blueprints a platform admin added to the Featured set. */
	featuredBlueprintIds: string[];
	/** Saved auto-approval rules: one that is off, so it can be turned on or deleted. */
	approvalRules: OsApprovalRule[];
	conversations: (HomeConversation & { hidden?: boolean })[];
	messages: HomeMessage[];
	homeRuns: HomeRun[];
	approvals: ApprovalRow[];
	skillRuns: SkillRunRow[];
	pushMutedProjectIds: string[];
	pushMutedWorkspaceIds: string[];
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
export const DEFAULT_LOCAL_PREFERENCES: OsUserPreferences = {
	theme: "system",
	density: "comfortable",
	locale: null,
	timezone: null,
	accessibility: { motion: "system", contrast: "system" },
	notifications: { approvals: true, runFailures: true, budgetAlerts: true },
	conversationModelRef: null,
};

export const workspaceRow = (
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
	visibility: "org",
	ownerUserId: null,
});

export const workspaceProjectLink = (
	n: number,
	workspaceId: string,
	projectId: string,
): OsWorkspaceProject => ({
	id: fid("43", n),
	organizationId: ORG_ID,
	workspaceId,
	projectId,
	status: "active",
	createdByKind: "user",
	createdById: "dev-operator",
	createdAt: T2,
	updatedAt: T2,
	removedAt: null,
});
