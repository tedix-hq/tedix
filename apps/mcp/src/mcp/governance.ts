import { sanitizeToolName } from "@cloudflare/codemode";
import { gateDecisionMetadata } from "./gate-decision";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
	builtinToolPolicyMetadata,
	reviewedConnectedEffect,
	decideAutonomousAction,
	humanReservedActionClasses,
	isPlatformCriticalActionType,
	isSafeNotionPageUpdateCall,
	isWorkItemPurposeRepairCall,
	platformAutonomousOperation,
	type DelegationAutonomyPolicy,
} from "@tedix/api-contract/utils/approval-policy";
import { AgentLifecycleEndpointSchema } from "@tedix/api-contract/schemas/mcp-governance";
import {
	ToolActionTypeSchema,
	type ToolAnnotations,
} from "@tedix/api-contract/schemas/tools";
import {
	checkAnnotationAssertion,
	type ExpectedAnnotations,
} from "@tedix/api-contract/utils/skill-manifest";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_MODERN_PROTOCOL_VERSION,
	isModernMcpRequest,
} from "@tedix/mcp-shared/protocol";
import { clientSupportsTasks } from "@tedix/mcp-shared/tasks";
import { preDispatchUnavailableToolResult } from "@tedix/mcp-shared/tool-result";
import {
	connectedProviderId,
	resolveMcpToolNamespace,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { normalizeCallerIdentity } from "./caller-identity";
import {
	buildApprovalInputRequest,
	INPUT_REQUIRED_META_KEY,
	INPUT_RESPONSES_META_KEY,
	resolveRequestStateKey,
	signRequestState,
	verifyRequestState,
} from "./mrtr";
import { isTedixManagedMcpUrl } from "./managed-mcp-auth";
import type { AppTool, ServerContext } from "./server-context";
import {
	resolveToolRiskPolicy,
	toolRiskAuditMetadata,
} from "./tool-risk-policy";
import { emitMcpAuditEvent, type McpEvent } from "./utils/analytics";
import { isRecord } from "@tedix/api-contract/utils/is-record";

type ApprovalContext = Pick<ServerContext, "server"> &
	Partial<
		Pick<
			ServerContext,
			| "env"
			| "ctx"
			| "appId"
			| "appSlug"
			| "app"
			| "appMetadata"
			| "callerIdentity"
			| "connectionLabel"
			| "traceId"
			| "apiClient"
		>
	>;
type ApprovalTool = Pick<AppTool, "toolId" | "title"> &
	Partial<Pick<AppTool, "config" | "meta" | "actionType" | "writeCapability">>;

/** Presentation only: keep the stored schema intact for upstream argument stripping. */
export function withDestructiveApprovalSchema(
	tool: Pick<AppTool, "inputSchema">,
	annotations: ToolAnnotations | undefined,
): AppTool["inputSchema"] {
	if (annotations?.destructiveHint !== true) return tool.inputSchema;
	return {
		...tool.inputSchema,
		properties: {
			confirmDestructive: {
				type: "boolean",
				description:
					"Explicit confirmation of this action under existing user authorization. Set true only when authorized and provide a non-empty reason. Does not bypass scope or approval policy.",
			},
			reason: {
				type: "string",
				description:
					"Non-empty explanation of the authorization for this action, required when confirmDestructive is true.",
			},
			...tool.inputSchema.properties,
		},
	};
}

/**
 * Remove Tedix-only stateless approval fields before dispatching tool input.
 *
 * External and MCP-backed tools can accept these fields through the gateway's
 * lenient validation so Code Mode can authorize a destructive call, but their
 * upstream schemas do not know about Tedix governance. Preserve any field the
 * tool explicitly declares because it is then part of the tool's real input
 * contract rather than only a gateway approval envelope.
 */
export function stripDestructiveApprovalArgs(
	tool: Pick<AppTool, "inputSchema">,
	args: Record<string, unknown>,
): Record<string, unknown> {
	const properties = tool.inputSchema.properties ?? {};
	const stripConfirmation = !Object.hasOwn(properties, "confirmDestructive");
	const stripReason = !Object.hasOwn(properties, "reason");
	if (!stripConfirmation && !stripReason) return args;

	const executionArgs = { ...args };
	if (stripConfirmation) delete executionArgs.confirmDestructive;
	if (stripReason) delete executionArgs.reason;
	return executionArgs;
}

/**
 * `_meta` key carried on `tools/call` so a skill workflow runner can declare
 * the tool-annotation assertion from its CapabilityManifest. The gateway
 * fails closed with ANNOTATION_VIOLATION if the invoked tool's annotations
 * contradict the assertion.
 */
export const EXPECTED_ANNOTATIONS_META_KEY =
	"com.tedix/expectedAnnotations" as const;

function annotationViolation(toolId: string, reason: string): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `ANNOTATION_VIOLATION: ${toolId} — ${reason}`,
			},
		],
		isError: true,
	};
}

/**
 * Parse `expectedAnnotations` carried on a `tools/call` `_meta` envelope.
 * Returns null when the key is absent or malformed.
 */
export function readExpectedAnnotationsFromMeta(
	meta: Record<string, unknown> | undefined,
): ExpectedAnnotations | null {
	if (!meta) return null;
	const raw = meta[EXPECTED_ANNOTATIONS_META_KEY];
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const out: ExpectedAnnotations = {};
	if (typeof r.destructive === "boolean") out.destructive = r.destructive;
	if (typeof r.readOnly === "boolean") out.readOnly = r.readOnly;
	return out;
}

/**
 * Check the workflow-declared annotation assertion against the tool's actual
 * annotations. Returns a CallToolResult with isError=true on violation, or
 * null when the call is allowed to proceed.
 */
export function enforceExpectedAnnotations(
	agent: ApprovalContext,
	tool: ApprovalTool,
	annotations: ToolAnnotations | null | undefined,
	extra: { _meta?: Record<string, unknown> } | undefined,
): CallToolResult | null {
	const expected = readExpectedAnnotationsFromMeta(extra?._meta);
	if (!expected) return null;
	const reason = checkAnnotationAssertion(expected, annotations ?? null);
	if (!reason) return null;

	// Audit: record the fail-closed denial under the existing governance bus.
	if (agent.env && agent.ctx && agent.appId) {
		const event: McpEvent = {
			timestamp: new Date().toISOString(),
			eventType: "tool_call",
			appId: agent.appId,
			appSlug: agent.appSlug,
			organizationId: agent.app?.organizationId,
			toolName: tool.toolId,
			userId: agent.callerIdentity?.userId,
			clientId: agent.callerIdentity?.clientId,
			authType: agent.callerIdentity?.authType,
			traceId: agent.traceId,
			success: false,
			errorCode: "ANNOTATION_VIOLATION",
			metadata: {
				...gateDecisionMetadata(
					"annotation_assertion",
					"deny",
					"annotation_violation",
				),
				governance: "annotation_violation",
				reason,
				expected: JSON.stringify(expected),
				actual: JSON.stringify({
					destructiveHint: annotations?.destructiveHint ?? false,
					readOnlyHint: annotations?.readOnlyHint ?? false,
				}),
			},
		};
		emitMcpAuditEvent(agent.env, event, agent.ctx.waitUntil.bind(agent.ctx));
	}
	console.warn(`[governance] ANNOTATION_VIOLATION ${tool.toolId}: ${reason}`);
	return annotationViolation(tool.toolId, reason);
}

function approvalFailure(text: string): CallToolResult {
	return {
		content: [{ type: "text", text }],
		isError: true,
	};
}

function approvalReason(content: unknown): string | null {
	if (!content || typeof content !== "object" || Array.isArray(content)) {
		return null;
	}
	const record = content as Record<string, unknown>;
	if (isRecord(record.content)) return approvalReason(record.content);
	if (isRecord(record.approval)) return approvalReason(record.approval);
	const reason = record.reason;
	return typeof reason === "string" && reason.trim().length > 0
		? reason.trim()
		: null;
}

export function callToolResultText(result: CallToolResult): string {
	return (
		result.content.find((item) => item.type === "text")?.text ??
		"Tool call did not complete."
	);
}

type GovernanceOutcome =
	| "destructive_approved"
	| "destructive_denied"
	| "grant_approved"
	| "work_item_approved";

function emitGovernanceAuditEvent(
	agent: ApprovalContext,
	tool: ApprovalTool,
	outcome: GovernanceOutcome,
	reason: string,
	extraMetadata?: Record<string, unknown>,
	userId = agent.callerIdentity?.userId,
): void {
	// Skip audit emission when the approval context lacks the platform-level
	// fields (e.g. governance tests that stub `server` only). The audit emitter
	// also no-ops without appId/organizationId — this keeps the runtime path
	// faithful while letting unit tests focus on elicitation behaviour.
	if (!agent.env || !agent.ctx || !agent.appId) return;

	const event: McpEvent = {
		timestamp: new Date().toISOString(),
		eventType: "tool_call",
		appId: agent.appId,
		appSlug: agent.appSlug,
		organizationId: agent.app?.organizationId,
		toolName: tool.toolId,
		userId,
		clientId: agent.callerIdentity?.clientId,
		authType: agent.callerIdentity?.authType,
		traceId: agent.traceId,
		success: outcome !== "destructive_denied",
		...(outcome === "destructive_denied" && {
			errorCode: "DESTRUCTIVE_GATE_DENIED",
		}),
		metadata: {
			...gateDecisionMetadata(
				"destructive_approval",
				outcome === "destructive_denied" ? "deny" : "allow",
				outcome,
			),
			governance: outcome,
			reason,
			...toolRiskAuditMetadata({ meta: tool.meta ?? null }),
			...extraMetadata,
		},
	};
	const waitUntil = agent.ctx.waitUntil.bind(agent.ctx);
	emitMcpAuditEvent(agent.env, event, waitUntil);
}

/**
 * Declarative approval-policy override read from the tool's D1 `config` row
 * (`ToolConfig.approvalPolicy` — see `packages/api-contract/src/schemas/
 * tools.ts`). Fail-soft: any absent/malformed/unexpected value reads as `null`
 * ("never" — no grant lookup, unchanged elicitation behavior). Never throws.
 */
function isTedixOwnedChannelPublishBoundary(
	agent: ApprovalContext,
	tool: ApprovalTool,
): boolean {
	const config =
		tool.config &&
		typeof tool.config === "object" &&
		!Array.isArray(tool.config)
			? (tool.config as Record<string, unknown>)
			: {};
	const configuredLabel =
		typeof config._aggregateConnectionLabel === "string"
			? config._aggregateConnectionLabel
			: undefined;
	const connectionLabel = (configuredLabel ?? agent.connectionLabel)
		?.trim()
		.toLowerCase();
	const isCmsPublishTool =
		tool.toolId === "content_publish" ||
		tool.toolId.endsWith("__content_publish");
	const targetsTedixConnection =
		connectionLabel === "tedix" && isCmsPublishTool;
	return (
		(agent.appSlug === "tedix-unified" &&
			(tool.toolId === "cms_landing__content_publish" ||
				tool.toolId === "cms_tedix__content_publish" ||
				tool.toolId === "cms-tedix__content_publish")) ||
		((agent.appSlug === "cms-tedix-landing" || agent.appSlug === "cms-tedix") &&
			(tool.toolId === "cms__content_publish" ||
				tool.toolId === "content_publish")) ||
		targetsTedixConnection
	);
}

function readApprovalPolicy(
	agent: ApprovalContext,
	tool: ApprovalTool,
): "once" | "always" | "work_item" | null {
	// Load-bearing invariant: every addressable route to the Tedix publisher
	// must remain fail-closed even while versioned aggregate caches converge.
	if (isTedixOwnedChannelPublishBoundary(agent, tool)) {
		return "work_item";
	}
	const configured = readConfiguredApprovalPolicy(agent, tool);
	return configured === "never" ? null : configured;
}

function readConfiguredApprovalPolicy(
	agent: ApprovalContext,
	tool: ApprovalTool,
): "once" | "always" | "never" | "work_item" | null {
	const config = tool.config;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return null;
	}
	const record = config as Record<string, unknown>;
	const scoped = record.approvalPolicies;
	const scopedValue =
		scoped && typeof scoped === "object" && !Array.isArray(scoped)
			? (scoped as Record<string, unknown>)[
					`${agent.appSlug ?? ""}:${tool.toolId}`
				]
			: undefined;
	if (
		scopedValue === "once" ||
		scopedValue === "always" ||
		scopedValue === "work_item"
	) {
		return scopedValue;
	}
	if (scopedValue === "never") return "never";
	const raw = record.approvalPolicy;
	return raw === "once" ||
		raw === "always" ||
		raw === "never" ||
		raw === "work_item"
		? raw
		: null;
}

function thirdPartyTransport(tool: ApprovalTool): "external" | "mcp" | null {
	const config = tool.config;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		return null;
	}
	const record = config as Record<string, unknown>;
	if (record.transport === "external") return "external";
	if (record.transport !== "mcp") return null;

	const serverUrl = record.mcpServerUrl;
	return typeof serverUrl === "string" && isTedixManagedMcpUrl(serverUrl)
		? null
		: "mcp";
}

async function requiresExplicitThirdPartyApprovalPolicy(
	agent: ApprovalContext,
): Promise<boolean> {
	const organizationId = agent.app?.organizationId;
	const tediId = agent.callerIdentity?.tediId;
	const apiClient = agent.apiClient;
	if (!organizationId || !tediId || !apiClient) return false;

	try {
		const policy = await apiClient.mcpGovernance.resolveAgentTransportPolicy({
			organizationId,
			tediId,
		});
		return policy.requireExplicitApprovalPolicy === true;
	} catch (error) {
		// This is a staged rollout whose absent/unavailable state deliberately
		// preserves the prior behavior. The D1 tool policy remains independently
		// authoritative whenever one is configured.
		console.warn(
			`[governance] third-party transport policy lookup failed for tedi ${tediId}; preserving rollout default:`,
			error,
		);
		return false;
	}
}

/**
 * MCP-gateway grant fast path (Batch 4 — isolated from the kernel
 * write-proposal approval system). Resolves in a single round trip to
 * `apps/api` (apps/mcp has no general `@tedix/db` access) via
 * `agent.apiClient.mcpGovernance.resolveToolApprovalGrant`, which atomically
 * finds-and-(if "once")-consumes the grant server-side — so this never leaves
 * a two-step race window.
 *
 * `null` means no grant policy applies. A configured grant policy returns an
 * explicit denial on missing prerequisites, lookup failure, or non-approval;
 * the caller must not fall through to another approval path.
 */
async function tryResolveApprovalGrant(
	agent: ApprovalContext,
	tool: ApprovalTool,
): Promise<{ approved: true; grantId: string } | { approved: false } | null> {
	const grantKind = readApprovalPolicy(agent, tool);
	if (!grantKind || grantKind === "work_item") return null;

	const organizationId = agent.app?.organizationId;
	const appSlug = agent.appSlug;
	const apiClient = agent.apiClient;
	const callerIdentity = agent.callerIdentity;
	if (!organizationId || !appSlug || !apiClient || !callerIdentity) {
		return { approved: false };
	}

	const subjectId = normalizeCallerIdentity(callerIdentity).actorId;
	if (!subjectId) return { approved: false };

	try {
		const result = await apiClient.mcpGovernance.resolveToolApprovalGrant({
			organizationId,
			subjectId,
			appSlug,
			toolId: tool.toolId,
			grantKind,
		});
		if (result?.approved && result.grantId) {
			return { approved: true, grantId: result.grantId };
		}
		return { approved: false };
	} catch (error) {
		// Network/API failure cannot weaken the configured policy.
		console.warn(
			`[governance] grant lookup failed for ${tool.toolId}; denying:`,
			error,
		);
		return { approved: false };
	}
}

/**
 * An organization admin let this declared action type run without asking
 * ("comment on issues without asking"). Approves only for a caller of the
 * tool's own organization, when no "ask me" correction covers the tool or
 * type, and the API finds a current opt-in. Any failure keeps the gate.
 */
async function resolveActionTypeOptIn(
	agent: ApprovalContext,
	tool: ApprovalTool,
	actionType: string,
): Promise<boolean> {
	const organizationId = agent.app?.organizationId;
	const governance = agent.apiClient?.mcpGovernance;
	if (
		!organizationId ||
		agent.callerIdentity?.organizationId !== organizationId ||
		!governance?.resolveActionTypeOptIn
	)
		return false;
	try {
		const policy = await governance.resolveAgentTransportPolicy?.({
			organizationId,
			...(agent.callerIdentity.tediId
				? { tediId: agent.callerIdentity.tediId }
				: {}),
		});
		const askForClasses = policy?.autonomy?.askForClasses ?? [];
		if (
			askForClasses.includes("*") ||
			askForClasses.includes(`tool:${agent.appSlug ?? ""}:${tool.toolId}`) ||
			askForClasses.includes(`action_type:${actionType}`)
		)
			return false;
		const optIn = await governance.resolveActionTypeOptIn({
			organizationId,
			actionType,
		});
		if (!optIn.approved) return false;
		const reason = `Allowed without asking by the organization setting for "${actionType.replaceAll("_", " ")}"`;
		emitGovernanceAuditEvent(agent, tool, "destructive_approved", reason, {
			resolvedBy: "action_type_opt_in",
			actionType,
			grantId: optIn.grantId,
		});
		// Run history lists automatic approvals from approval rows; the row is a
		// record, not a gate, so failing to write it never blocks the call.
		await governance
			.recordPolicyToolApproval?.({
				organizationId,
				appSlug: agent.appSlug ?? "",
				toolId: tool.toolId,
				reason,
				operationId: `action_type:${actionType}`,
				...(agent.callerIdentity.userId
					? { userId: agent.callerIdentity.userId }
					: {}),
				...(agent.callerIdentity.tediId
					? { tediId: agent.callerIdentity.tediId }
					: {}),
				...(agent.callerIdentity.externalAgentPrincipalId
					? {
							externalAgentPrincipalId:
								agent.callerIdentity.externalAgentPrincipalId,
						}
					: {}),
			})
			.catch(() => {
				console.warn("[governance] policy_approval_record_failed", {
					organizationId,
					toolId: tool.toolId,
				});
			});
		return true;
	} catch {
		// Without a verified opt-in the normal gates below decide.
		return false;
	}
}

interface WorkItemAuthorizationResolution {
	approved: boolean;
	reason: string;
	workItemId: string | null;
	authorizationScopeWorkItemId: string | null;
	authorizationCommentId: string | null;
	attemptId: string | null;
	campaignKey: string | null;
	validUntil: string | null;
}

/**
 * Resolve the special fail-closed autonomous publishing lane. Unlike the
 * generic grant fast path, a denial here is terminal for an agent caller:
 * it must never fall through to Code Mode's broad agent self-confirmation.
 */
async function resolveWorkItemAuthorization(
	agent: ApprovalContext,
	tool: ApprovalTool,
	args: Record<string, unknown>,
): Promise<WorkItemAuthorizationResolution> {
	const unavailable = (reason: string): WorkItemAuthorizationResolution => ({
		approved: false,
		reason,
		workItemId: null,
		authorizationScopeWorkItemId: null,
		authorizationCommentId: null,
		attemptId: null,
		campaignKey: null,
		validUntil: null,
	});
	const organizationId = agent.app?.organizationId;
	const appSlug = agent.appSlug;
	const apiClient = agent.apiClient;
	const callerIdentity = agent.callerIdentity;
	if (!organizationId || !appSlug || !apiClient || !callerIdentity) {
		return unavailable("authorization_context_unavailable");
	}
	const subjectId = normalizeCallerIdentity(callerIdentity).actorId;
	if (!subjectId) return unavailable("authorization_subject_unavailable");

	try {
		return await apiClient.mcpGovernance.resolveWorkItemAuthorization({
			organizationId,
			subjectId,
			appSlug,
			toolId: tool.toolId,
			args,
		});
	} catch (error) {
		console.warn(
			`[governance] work-item authorization lookup failed for ${tool.toolId}:`,
			error,
		);
		return unavailable("authorization_lookup_failed");
	}
}

/**
 * Is the destructive caller an agent (including a verified coding session),
 * or a modern client that declared the tasks extension?
 *
 * Agents cannot receive a server→client `elicitation/create` over the stateless
 * transport (it drops standalone server requests), so they resolve approvals
 * via the synchronous-MRTR `input_required` round-trip. Human/bidirectional
 * hosts keep the legacy in-band `elicitInput()` prompt.
 */
function callerIsAgent(
	agent: ApprovalContext,
	extra: { _meta?: Record<string, unknown> } | undefined,
): boolean {
	const authType = agent.callerIdentity?.authType;
	if (
		authType === "tedi" ||
		authType === "service" ||
		authType === "external_agent"
	)
		return true;
	// A modern client that opted into the tasks extension is treated as an agent
	// capable of the multi-round resolution. Only a caller that declared
	// capabilities and included tasks counts here; `clientSupportsTasks` now
	// returns false for legacy/no-capabilities callers on its own (the exemption
	// was removed with the compat shims), so the explicit
	// capability guards below are belt-and-suspenders over the same check.
	const meta = extra?._meta;
	if (!meta) return false;
	const caps = (meta as Record<string, unknown>)[
		MCP_CLIENT_CAPABILITIES_META_KEY
	];
	if (typeof caps !== "object" || caps === null) return false;
	return clientSupportsTasks(meta);
}

function callerIsUserPrincipalPath(agent: ApprovalContext): boolean {
	const identity = agent.callerIdentity;
	if (!identity) return false;
	if (identity.authType === "user") return true;
	return (
		identity.authType === "oauth" &&
		!identity.tediId &&
		!identity.externalAgentPrincipalId
	);
}

/**
 * Did the caller declare `clientCapabilities.elicitation` on this request's
 * `_meta` envelope? Returns `null` when no capabilities block was declared
 * (legacy/internal caller — capability unknown), otherwise whether the
 * `elicitation` key is present.
 *
 * MRTR spec (MCP 2026-07-28, basic/patterns/mrtr): servers MUST
 * not send an `inputRequests` entry the client has not declared support for in
 * its capabilities — a caller without declared `elicitation` must never
 * receive the `elicitation/create`-typed approval inputRequest.
 */
function callerDeclaredElicitation(
	extra: { _meta?: Record<string, unknown> } | undefined,
): boolean | null {
	const caps = extra?._meta?.[MCP_CLIENT_CAPABILITIES_META_KEY];
	if (!isRecord(caps)) return null;
	return "elicitation" in caps;
}

/**
 * Is the serving connection the modern (2026-07-28) revision? On a modern
 * connection `server.elicitInput()` is illegal (server→client requests are
 * removed — SEP-2260/2322), so the destructive gate MUST request approval via
 * the 2026-native `input_required` round-trip instead. Read from the request's
 * own `_meta` envelope (the transport requires it on every modern request).
 */
function servingConnectionIsModern(
	extra: { _meta?: Record<string, unknown> } | undefined,
): boolean {
	return isModernMcpRequest(extra?._meta);
}

/** Pull the agent's echoed input responses + requestState off the retry envelope. */
function readInputResponses(
	extra: { _meta?: Record<string, unknown> } | undefined,
): { requestState?: unknown; content?: Record<string, unknown> } | null {
	const raw = extra?._meta?.[INPUT_RESPONSES_META_KEY];
	if (!isRecord(raw)) return null;
	const inputResponses = isRecord(raw.inputResponses)
		? raw.inputResponses
		: undefined;
	const canonicalContent = inputResponses
		? (inputResponses.approval ?? Object.values(inputResponses)[0])
		: undefined;
	return {
		requestState: raw.requestState,
		content: isRecord(raw.content)
			? raw.content
			: isRecord(canonicalContent)
				? canonicalContent
				: undefined,
	};
}

/**
 * Build the sync-MRTR `input_required` result for an agent caller. The marker is
 * rewritten by index.ts's resultTransform into a protocol-native
 * `resultType: "input_required"` with `inputRequests` + `requestState`.
 */
async function buildInputRequiredResult(
	agent: ApprovalContext,
	tool: ApprovalTool,
	displayName: string,
	requestBinding?: string,
): Promise<CallToolResult> {
	const organizationId = agent.app?.organizationId ?? "";
	const requestState = await signRequestState({
		toolId: tool.toolId,
		organizationId,
		subjectUserId: agent.callerIdentity?.userId,
		requestBinding,
		signingKey: resolveRequestStateKey(
			agent.env as { PLATFORM_SERVICE_TOKEN?: string } | undefined,
		),
	});
	const inputRequest = buildApprovalInputRequest(displayName);
	return {
		content: [
			{
				type: "text",
				text: `Approval required for destructive action "${tool.toolId}". Provide a reason and retry with inputResponses + requestState.`,
			},
		],
		// No operation has run. Skip the SDK's completed-output validation until
		// the wire transform turns this internal marker into input_required.
		isError: true,
		_meta: {
			[INPUT_REQUIRED_META_KEY]: {
				requestState,
				inputRequests: { approval: inputRequest },
			},
		},
	};
}

export interface DestructiveApprovalOptions {
	/** Server-projected callable, rather than an aggregate tool's wire id. */
	toolName?: string;
	/** Bind a Code Mode retry to its source and inner arguments. */
	requestBinding?: string;
	/** Retry metadata. Canonical params are adapted by the stateless transport. */
	extra?: { _meta?: Record<string, unknown> };
	/** Parsed tool arguments bound to this approval request. */
	args?: Record<string, unknown>;
	/**
	 * Allow synchronous MRTR. Code Mode enables it only before any dispatch,
	 * when replaying the program cannot repeat a previous side effect.
	 */
	allowSyncMrtr?: boolean;
	/**
	 * Legacy agent confirmation for non-critical tools only. Critical actions,
	 * destructive hints, and explicit tool approval policies remain gated.
	 */
	autoConfirmAgent?: boolean;
}

/** Park a user call in the canonical OS queue; approval permits one exact retry. */
async function ownerToolApproval(
	agent: ApprovalContext,
	tool: ApprovalTool,
	options?: DestructiveApprovalOptions,
): Promise<CallToolResult | null | undefined> {
	if (
		!callerIsUserPrincipalPath(agent) ||
		!agent.callerIdentity?.userId ||
		!agent.app?.organizationId ||
		!agent.apiClient?.mcpGovernance?.requestOwnerToolApproval
	)
		return undefined;
	try {
		const approvalRequestId =
			options?.extra?._meta?.["com.tedix/approvalRequestId"];
		const approval =
			await agent.apiClient.mcpGovernance.requestOwnerToolApproval({
				organizationId: agent.app.organizationId,
				userId: agent.callerIdentity.userId,
				appSlug: agent.appSlug ?? "",
				toolId: tool.toolId,
				target: {
					transport: tool.config?.transport ?? "rpc",
					endpoint: tool.config?.endpoint ?? null,
					mcpToolName: tool.config?.mcpToolName ?? null,
					providerId: connectedProviderId(tool),
					configHash: await sha256Hex(JSON.stringify(tool.config ?? {})),
				},
				args: JSON.parse(JSON.stringify(options?.args ?? {})),
				...(typeof approvalRequestId === "string" ? { approvalRequestId } : {}),
			});
		if (approval.approved) {
			emitGovernanceAuditEvent(
				agent,
				tool,
				"destructive_approved",
				"owner_tool_approval",
				{ approvalRequestId: approval.approvalRequestId },
			);
			return null;
		}
		return {
			...approvalFailure(
				`Human approval required. Request ${approval.approvalRequestId} (${approval.status}): ${approval.url}. Decide in Tedix OS, then retry the identical call with _meta {"com.tedix/approvalRequestId":"${approval.approvalRequestId}"}. No side effect was executed.`,
			),
			_meta: { "com.tedix/approval": approval },
		};
	} catch (error) {
		// Log the failure class and typed code only, never the message or args.
		console.warn("[governance] owner_tool_approval_unavailable", {
			errorClass:
				error instanceof Error ? error.constructor.name : typeof error,
			code:
				error && typeof error === "object" && "code" in error
					? String((error as { code: unknown }).code)
					: undefined,
			organizationId: agent.app.organizationId,
			callerOrganizationId: agent.callerIdentity.organizationId,
			appSlug: agent.appSlug,
			toolId: tool.toolId,
		});
		return approvalFailure(
			"Owner tool approval is unavailable or does not match this call. No side effect was executed.",
		);
	}
}

/**
 * Whether this call is a kernel replay of a Home approval. Once
 * {@link requireDestructiveToolApproval} returns null for such a call, its
 * receipt matched this exact tool and arguments.
 */
export function isHomeApprovalCall(
	agent: Pick<ApprovalContext, "app" | "callerIdentity">,
	options?: Pick<DestructiveApprovalOptions, "extra">,
): boolean {
	return (
		typeof options?.extra?._meta?.["com.tedix/homeApprovalRequestId"] ===
			"string" &&
		agent.callerIdentity?.kernel === true &&
		agent.callerIdentity.authType === "service" &&
		// A tenant-credential retry carries the initiating member separately, so
		// it can match the receipt without switching to their personal credential.
		Boolean(
			agent.callerIdentity.userId ?? agent.callerIdentity.approvedHomeUserId,
		) &&
		Boolean(agent.app?.organizationId)
	);
}

export async function requireDestructiveToolApproval(
	agent: ApprovalContext,
	tool: ApprovalTool,
	annotations?: ToolAnnotations | null,
	options?: DestructiveApprovalOptions,
): Promise<CallToolResult | null> {
	const homeApprovalId =
		options?.extra?._meta?.["com.tedix/homeApprovalRequestId"];
	const homeUserId =
		agent.callerIdentity?.userId ?? agent.callerIdentity?.approvedHomeUserId;
	if (
		isHomeApprovalCall(agent, options) &&
		typeof homeApprovalId === "string" &&
		homeUserId &&
		agent.app?.organizationId
	) {
		try {
			let toolName = options?.toolName ?? tool.toolId;
			const storedName =
				options?.extra?._meta?.["com.tedix/homeApprovalToolName"];
			if (storedName !== undefined) {
				const namespace = resolveMcpToolNamespace(
					tool,
					agent.appMetadata?.mcpConfig?.codeModeNamespaces as
						| Record<string, string>
						| undefined,
				);
				const method = sanitizeToolName(
					tool.toolId.includes("__")
						? tool.toolId.split("__").slice(1).join("__")
						: tool.toolId,
				);
				// A native replay may name its stored Code Mode callable, but only
				// when the current server tool projects to that exact identity.
				if (storedName !== `${namespace}.${method}`)
					return approvalFailure(
						"Home approval tool identity does not match this call.",
					);
				toolName = storedName;
			}
			const approval =
				await agent.apiClient?.mcpGovernance.resolveHomeToolApproval({
					organizationId: agent.app.organizationId,
					userId: homeUserId,
					credential: agent.callerIdentity?.userId ? "user" : "tenant",
					appSlug: agent.appSlug ?? "",
					toolName,
					args: JSON.parse(JSON.stringify(options?.args ?? {})),
					approvalRequestId: homeApprovalId,
				});
			if (approval?.approved) {
				emitGovernanceAuditEvent(
					agent,
					tool,
					"destructive_approved",
					"home_tool_approval",
					{
						approvalRequestId: homeApprovalId,
						actor: `kernel on behalf of user:${homeUserId}`,
						delegationMode: "kernel",
						subjectUserId: homeUserId,
					},
					homeUserId,
				);
				return null;
			}
		} catch {
			// Receipt lookup failures cannot fall back to another approval path.
		}
		return approvalFailure(
			"Home approval is unavailable or does not match this call. No side effect was executed.",
		);
	}
	const isOwnedChannelBoundary = isTedixOwnedChannelPublishBoundary(
		agent,
		tool,
	);
	const policy = resolveToolRiskPolicy({ meta: tool.meta ?? null });
	// Persisted operator tools can predate policy metadata. Bind this built-in
	// classification to the RPC route and verified identity, never request metadata.
	const sessionEnd =
		tool.toolId.split("__").at(-1) === "end_external_agent_session" &&
		tool.config?.transport === "rpc" &&
		tool.config.endpoint === "externalAgentIdentity/endSession";
	const ownSessionEnd =
		sessionEnd &&
		builtinToolPolicyMetadata("end_external_agent_session")?.ownSessionRisk ===
			"low" &&
		agent.callerIdentity?.authType === "external_agent" &&
		!!agent.callerIdentity.externalAgentPrincipalId &&
		!!agent.callerIdentity.externalAgentSessionId &&
		!!agent.callerIdentity.externalAgentClientRecordId &&
		!!agent.app?.organizationId &&
		agent.callerIdentity.organizationId === agent.app.organizationId &&
		options?.args?.organizationId === agent.app.organizationId &&
		options.args.principalId ===
			agent.callerIdentity.externalAgentPrincipalId &&
		options.args.sessionId === agent.callerIdentity.externalAgentSessionId;
	const boundedNotionUpdate =
		policy?.riskTier === "bounded_write" &&
		policy.argumentPolicy === "notion_page_update" &&
		tool.config?.transport === "mcp" &&
		connectedProviderId(tool) === "notion" &&
		tool.config.mcpToolName === "notion-update-page" &&
		isSafeNotionPageUpdateCall(options?.args);
	// An owner/admin purpose repair is bounded; any other update stays unclassified.
	const purposeRepairPolicy =
		policy?.argumentPolicy === "work_item_purpose_repair";
	const boundedPurposeRepair =
		purposeRepairPolicy &&
		policy.riskTier === "bounded_write" &&
		tool.config?.transport === "rpc" &&
		tool.config.endpoint === "workItems/updateSpecification" &&
		isWorkItemPurposeRepairCall(options?.args);
	const reviewedEffect =
		tool.config?.transport === "mcp"
			? reviewedConnectedEffect({
					providerId: connectedProviderId(tool),
					toolName:
						typeof tool.config.mcpToolName === "string"
							? tool.config.mcpToolName
							: undefined,
					args: options?.args,
				})
			: undefined;
	// The API checks active owner/admin membership, draft state and revision.
	const certificationStart =
		callerIsUserPrincipalPath(agent) &&
		tool.config?.transport === "rpc" &&
		tool.config.endpoint === "skills/runWorkflow" &&
		options?.args?.certification === true;
	const risk =
		reviewedEffect ??
		(certificationStart ? "bounded_write" : undefined) ??
		(ownSessionEnd
			? "bounded_write"
			: sessionEnd ||
				  (policy?.argumentPolicy === "notion_page_update" &&
						!boundedNotionUpdate)
				? "high_impact_write"
				: purposeRepairPolicy
					? boundedPurposeRepair
						? "bounded_write"
						: undefined
					: policy?.riskTier);
	if (
		boundedNotionUpdate ||
		ownSessionEnd ||
		reviewedEffect ||
		certificationStart
	)
		annotations = {
			...annotations,
			readOnlyHint: reviewedEffect === "read",
			destructiveHint: false,
		};
	const configuredApproval = readApprovalPolicy(agent, tool);
	const workflowCaller = agent.callerIdentity;
	const humanBoundary =
		annotations?.destructiveHint === true ||
		(!reviewedEffect &&
			!certificationStart &&
			humanReservedActionClasses(`${agent.appSlug ?? ""}:${tool.toolId}`)
				.length > 0) ||
		risk === "high_impact_write" ||
		risk === "external_side_effect";
	// Only a verified run and its pinned, active revision can approve a declared
	// capability. Service headers alone are correlation, not authorization.
	const manifestProtectedEffect =
		humanReservedActionClasses(
			`${tool.config?.endpoint ?? ""} ${tool.config?.mcpToolName ?? ""}`,
		).length > 0;
	// A declared action type an organization admin opted in. An undeclared,
	// destructive or platform-critical tool, an explicit tool policy and the
	// owned publish boundary never take this path; external effects such as a
	// comment on a provider's issue may, because that is what the admin chose.
	const declaredActionType = ToolActionTypeSchema.safeParse(tool.actionType);
	if (
		declaredActionType.success &&
		risk !== "read" &&
		annotations?.readOnlyHint !== true &&
		!isPlatformCriticalActionType(declaredActionType.data) &&
		!isOwnedChannelBoundary &&
		!configuredApproval &&
		!manifestProtectedEffect &&
		annotations?.destructiveHint !== true &&
		tool.writeCapability !== "destructive" &&
		risk !== "high_impact_write" &&
		humanReservedActionClasses(`${agent.appSlug ?? ""}:${tool.toolId}`)
			.length === 0 &&
		(await resolveActionTypeOptIn(agent, tool, declaredActionType.data))
	)
		return null;
	// A tenant skill reaches platform tools (os.*, tedix.*) on the public tedix
	// app, which another organization owns. The run, skill, tedi and policy
	// belong to the caller's organization, so authorize there; the API checks
	// that the run and declared namespace exist in that organization.
	const manifestOrganizationId =
		workflowCaller?.organizationId &&
		(workflowCaller.organizationId === agent.app?.organizationId ||
			agent.app?.visibility === "public")
			? workflowCaller.organizationId
			: undefined;
	if (
		!humanBoundary &&
		!manifestProtectedEffect &&
		!isOwnedChannelBoundary &&
		!configuredApproval &&
		workflowCaller?.authType === "service" &&
		!workflowCaller.kernel &&
		workflowCaller.skillRunId &&
		workflowCaller.skillId &&
		workflowCaller.tediId &&
		manifestOrganizationId &&
		workflowCaller.workflowExecutionEpoch !== undefined &&
		agent.app?.organizationId &&
		agent.apiClient?.mcpGovernance?.resolveSkillManifestAuthorization
	) {
		let stage = "transport_policy";
		try {
			const transportPolicy =
				await agent.apiClient.mcpGovernance.resolveAgentTransportPolicy?.({
					organizationId: manifestOrganizationId,
					tediId: workflowCaller.tediId,
				});
			const askForClasses = transportPolicy?.autonomy?.askForClasses;
			if (
				askForClasses?.includes("*") ||
				askForClasses?.includes(`tool:${agent.appSlug ?? ""}:${tool.toolId}`) ||
				(transportPolicy?.requireExplicitApprovalPolicy &&
					thirdPartyTransport(tool))
			)
				return approvalFailure(
					`Action "${tool.toolId}" requires approval under its configured policy. No side effect was executed.`,
				);
			stage = "manifest_authorization";
			const gatewayNamespace =
				typeof tool.config?._aggregateNamespace === "string"
					? tool.config._aggregateNamespace
					: tool.toolId.split("__").slice(0, -1).join("__") || agent.appSlug;
			const gatewayMethod = tool.toolId.split("__").at(-1)!;
			// A skill declares and calls the Code Mode name. Platform RPC tools
			// sit under their endpoint's namespace (`rationaleRecords/create` is
			// `rationale.create_rationale_records`, gateway `tedix__…`); a nested
			// wrapper mounts under its slug (`notion-tedix__notion-fetch` is
			// `notion_tedix.notion_fetch`). Either pair names this tool.
			const codeModeNamespace = resolveMcpToolNamespace(
				tool,
				agent.appMetadata?.mcpConfig?.codeModeNamespaces as
					| Record<string, string>
					| undefined,
			);
			const codeModeMethod = sanitizeToolName(
				tool.toolId.includes("__")
					? tool.toolId.split("__").slice(1).join("__")
					: tool.toolId,
			);
			const governance = agent.apiClient.mcpGovernance;
			const manifestInput = {
				organizationId: manifestOrganizationId,
				runId: workflowCaller.skillRunId,
				skillId: workflowCaller.skillId,
				tediId: workflowCaller.tediId,
				executionEpoch: workflowCaller.workflowExecutionEpoch,
			};
			const resolveManifest = (namespace: string | undefined, method: string) =>
				governance.resolveSkillManifestAuthorization!({
					...manifestInput,
					method,
					namespace,
					sourceAppSlug:
						typeof tool.config?._sourceAppSlug === "string"
							? tool.config._sourceAppSlug
							: agent.appSlug,
					targetTediId:
						typeof tool.config?._aggregateTediId === "string"
							? tool.config._aggregateTediId
							: undefined,
				});
			let resolution = await resolveManifest(gatewayNamespace, gatewayMethod);
			if (
				!resolution.approved &&
				(codeModeNamespace !== gatewayNamespace ||
					codeModeMethod !== gatewayMethod)
			)
				resolution = await resolveManifest(codeModeNamespace, codeModeMethod);
			if (resolution.approved && resolution.skillId && resolution.revision) {
				stage = "manifest_audit";
				emitGovernanceAuditEvent(
					agent,
					tool,
					"destructive_approved",
					`approved by manifest of skill ${resolution.skillId} rev ${resolution.revision}`,
					{
						resolvedBy: "skill_manifest",
						skillId: resolution.skillId,
						skillRevision: resolution.revision,
						skillRunId: workflowCaller.skillRunId,
					},
				);
				return null;
			}
			return approvalFailure(
				"Skill run identity or declared manifest capability is invalid; no side effect was executed.",
			);
		} catch (error) {
			// Upstream errors can include arguments or credentials; log correlation
			// and the failure class, never the message, cause or stack.
			console.warn("[governance] skill_manifest_authorization_unavailable", {
				stage,
				errorClass:
					error instanceof Error ? error.constructor.name : typeof error,
				organizationId: manifestOrganizationId,
				skillRunId: workflowCaller.skillRunId,
				skillId: workflowCaller.skillId,
				executionEpoch: workflowCaller.workflowExecutionEpoch,
				toolId: tool.toolId,
			});
			return approvalFailure(
				"Skill manifest authorization is unavailable; no side effect was executed.",
			);
		}
	}
	// An owner starting an active skill of this organization is the human
	// decision. The API checks membership, lifecycle and the workflow; every
	// effect inside the run keeps its own manifest and approval gates.
	if (
		!configuredApproval &&
		!isOwnedChannelBoundary &&
		!certificationStart &&
		callerIsUserPrincipalPath(agent) &&
		agent.callerIdentity?.userId &&
		!agent.callerIdentity.kernel &&
		tool.config?.transport === "rpc" &&
		tool.config.endpoint === "skills/runWorkflow" &&
		humanReservedActionClasses(`${agent.appSlug ?? ""}:${tool.toolId}`)
			.length === 0 &&
		agent.app?.organizationId &&
		agent.apiClient?.mcpGovernance?.resolveOwnerSkillStart
	) {
		const skillId =
			typeof options?.args?.skillId === "string"
				? options.args.skillId
				: undefined;
		const slug =
			typeof options?.args?.slug === "string" ? options.args.slug : undefined;
		if (skillId || slug) {
			try {
				const start =
					await agent.apiClient.mcpGovernance.resolveOwnerSkillStart({
						organizationId: agent.app.organizationId,
						userId: agent.callerIdentity.userId,
						...(skillId ? { skillId } : {}),
						...(slug ? { slug } : {}),
					});
				if (start.approved) {
					emitGovernanceAuditEvent(
						agent,
						tool,
						"destructive_approved",
						"owner_skill_start",
						{
							resolvedBy: "owner_skill_start",
							skillId: start.skillId,
							skillRevision: start.revision,
						},
					);
					return null;
				}
			} catch (error) {
				console.warn("[governance] owner_skill_start_unavailable", {
					errorClass:
						error instanceof Error ? error.constructor.name : typeof error,
					organizationId: agent.app.organizationId,
					toolId: tool.toolId,
				});
			}
		}
	}
	// Stopping one's own reply withdraws the user's request. Verify ownership
	// from the API receipt, never caller arguments or request metadata.
	if (
		!configuredApproval &&
		tool.config?.transport === "rpc" &&
		tool.config.endpoint === "kernelRuntime/cancelRun" &&
		tool.toolId.split("__").at(-1) === "cancel_home_run" &&
		callerIsUserPrincipalPath(agent) &&
		agent.callerIdentity?.userId &&
		!agent.callerIdentity.tediId &&
		!agent.callerIdentity.externalAgentPrincipalId &&
		!agent.callerIdentity.kernel &&
		!agent.callerIdentity.ownerHostSessionId &&
		agent.app?.organizationId &&
		(!options?.args?.organizationId ||
			options.args.organizationId === agent.app.organizationId) &&
		typeof options?.args?.runId === "string"
	) {
		try {
			const receipt = await agent.apiClient?.kernelRuntime.readRun({
				organizationId: agent.app.organizationId,
				runId: options.args.runId,
			});
			const saved = receipt?.run.metadata?.redriveInput;
			if (
				receipt?.run.id === options.args.runId &&
				receipt.run.organizationId === agent.app.organizationId &&
				isRecord(saved) &&
				saved.descopeUserId === agent.callerIdentity.userId
			) {
				emitGovernanceAuditEvent(
					agent,
					tool,
					"destructive_approved",
					"own_home_run",
				);
				return null;
			}
		} catch {
			// Unavailable or inaccessible ownership proof retains the approval gate.
		}
	}
	// This call IS the human's approval. The API still checks the run, tenant,
	// conversation access and owner/admin authority; asking again creates a loop.
	if (
		!humanBoundary &&
		!configuredApproval &&
		tool.config?.transport === "rpc" &&
		tool.config.endpoint === "kernelRuntime/respondApproval" &&
		tool.toolId.split("__").at(-1) === "respond_home_approval" &&
		callerIsUserPrincipalPath(agent) &&
		agent.callerIdentity?.userId &&
		!agent.callerIdentity.tediId &&
		!agent.callerIdentity.externalAgentPrincipalId &&
		!agent.callerIdentity.kernel &&
		!agent.callerIdentity.ownerHostSessionId
	)
		return null;
	// Enqueue records intent; the kernel authorizes and risk-checks execution.
	// Tasks capability alone must not turn that ingress into a destructive action.
	if (
		!humanBoundary &&
		!isOwnedChannelBoundary &&
		!configuredApproval &&
		tool.config?.transport === "rpc" &&
		tool.config.endpoint === "kernelRuntime/enqueueMessage"
	)
		return null;
	if (
		!humanBoundary &&
		!isOwnedChannelBoundary &&
		!configuredApproval &&
		(!callerIsAgent(agent, options?.extra) ||
			risk === "read" ||
			(!risk && annotations?.readOnlyHint === true))
	)
		return null;
	const lifecycleEndpoint = AgentLifecycleEndpointSchema.safeParse(
		tool.config?.endpoint,
	);
	// Check admission before org autonomy so an admitted session can keep its lease
	// and record its result even when the organization has no standing consent.
	if (
		!humanBoundary &&
		!isOwnedChannelBoundary &&
		!configuredApproval &&
		risk === "bounded_write" &&
		lifecycleEndpoint.success &&
		tool.config?.transport === "rpc" &&
		agent.callerIdentity?.authType === "external_agent" &&
		agent.callerIdentity.externalAgentPrincipalId &&
		agent.callerIdentity.externalAgentSessionId &&
		agent.app?.organizationId &&
		options?.args &&
		agent.apiClient?.mcpGovernance?.resolveAgentLifecycleAuthorization
	) {
		try {
			const resolution =
				await agent.apiClient.mcpGovernance.resolveAgentLifecycleAuthorization({
					organizationId: agent.app.organizationId,
					principalId: agent.callerIdentity.externalAgentPrincipalId,
					sessionId: agent.callerIdentity.externalAgentSessionId,
					endpoint: lifecycleEndpoint.data,
					args: options.args,
				});
			if (resolution.approved) {
				emitGovernanceAuditEvent(
					agent,
					tool,
					"destructive_approved",
					"admitted_lifecycle_write",
					{ resolvedBy: "attempt" },
				);
				return null;
			}
		} catch {
			return preDispatchUnavailableToolResult(
				"attempt_authorization_unavailable",
				"Attempt authorization is unavailable; no side effect was executed.",
				5,
			);
		}
	}
	// Platform default (organization-autonomy.v1.json): Tedix's own
	// in-organization operations (Work items, workspace and app management,
	// skill and schedule operations, run starts) need no card unless the
	// organization opted out. The tool and its API route decide, never request
	// text. Critical actions, external effects, configured approval policies,
	// manifest-protected effects and the owned publish boundary keep their gates;
	// a skill run's own calls were decided by its manifest above, and a person
	// starting a skill by the owner check above, and an agent's own Work
	// lifecycle writes by the Attempt check above.
	// Only the organization's own people and tedis inherit the default. External
	// agents, owner-host coding sessions, service and anonymous callers keep
	// their gates unless the organization grants explicit autonomy.
	const identity = agent.callerIdentity;
	const inOrganizationCaller =
		!!identity &&
		!identity.externalAgentPrincipalId &&
		!identity.ownerHostSessionId &&
		!identity.kernel &&
		((identity.authType === "tedi" && !!identity.tediId) ||
			(callerIsUserPrincipalPath(agent) && !!identity.userId));
	const platformOperation =
		inOrganizationCaller &&
		!isOwnedChannelBoundary &&
		// A person's ordinary skill start is the owner check's decision above;
		// a certification run is not (the API checks owner/admin, draft and
		// revision), so it takes the default like any other run start.
		!(
			callerIsUserPrincipalPath(agent) &&
			tool.config?.endpoint === "skills/runWorkflow" &&
			!certificationStart
		) &&
		!configuredApproval &&
		!manifestProtectedEffect &&
		tool.config?.transport === "rpc" &&
		risk !== "external_side_effect" &&
		humanReservedActionClasses(`${agent.appSlug ?? ""}:${tool.toolId}`)
			.length === 0
			? platformAutonomousOperation(
					tool.toolId,
					typeof tool.config.endpoint === "string"
						? tool.config.endpoint
						: null,
				)
			: null;
	const resolveTransportPolicy =
		agent.apiClient?.mcpGovernance?.resolveAgentTransportPolicy;
	if (
		platformOperation &&
		agent.app?.organizationId &&
		resolveTransportPolicy
	) {
		try {
			const policy = await resolveTransportPolicy({
				organizationId: agent.app.organizationId,
				...(agent.callerIdentity?.tediId
					? { tediId: agent.callerIdentity.tediId }
					: {}),
			});
			const askForClasses = policy.autonomy?.askForClasses;
			if (
				policy.platformAutonomy !== false &&
				!askForClasses?.includes("*") &&
				!askForClasses?.includes(`tool:${agent.appSlug ?? ""}:${tool.toolId}`)
			) {
				const reason = `${platformOperation.label} run without approval (platform default)`;
				emitGovernanceAuditEvent(agent, tool, "destructive_approved", reason, {
					resolvedBy: "policy",
					platformOperation: platformOperation.id,
				});
				// Activity lists automatic approvals from approval rows. The row is a
				// record, not a gate: failing to write it never blocks the call.
				await agent.apiClient?.mcpGovernance
					?.recordPolicyToolApproval?.({
						organizationId: agent.app.organizationId,
						appSlug: agent.appSlug ?? "",
						toolId: tool.toolId,
						reason,
						operationId: platformOperation.id,
						...(agent.callerIdentity?.userId
							? { userId: agent.callerIdentity.userId }
							: {}),
						...(agent.callerIdentity?.tediId
							? { tediId: agent.callerIdentity.tediId }
							: {}),
						...(agent.callerIdentity?.externalAgentPrincipalId
							? {
									externalAgentPrincipalId:
										agent.callerIdentity.externalAgentPrincipalId,
								}
							: {}),
					})
					.catch(() => {
						console.warn("[governance] policy_approval_record_failed", {
							organizationId: agent.app?.organizationId,
							toolId: tool.toolId,
						});
					});
				return null;
			}
		} catch {
			// Without the policy the normal gates below decide; nothing has run.
		}
	}
	let autonomy: DelegationAutonomyPolicy | undefined;
	if (
		callerIsAgent(agent, options?.extra) &&
		agent.apiClient?.mcpGovernance?.resolveAgentTransportPolicy &&
		agent.app?.organizationId
	) {
		try {
			const policy =
				await agent.apiClient.mcpGovernance.resolveAgentTransportPolicy({
					organizationId: agent.app.organizationId,
					...(agent.callerIdentity?.tediId
						? { tediId: agent.callerIdentity.tediId }
						: {}),
				});
			autonomy = policy.autonomy;
		} catch {
			// Typed so a client can resend the call: nothing has run yet.
			return preDispatchUnavailableToolResult(
				"autonomous_policy_unavailable",
				"Autonomous action policy is unavailable; no side effect was executed.",
				5,
			);
		}
	}
	const autonomousDecision = decideAutonomousAction({
		policy: autonomy,
		classId: `tool:${agent.appSlug ?? ""}:${tool.toolId}`,
		risk:
			ownSessionEnd || risk === "read"
				? "low"
				: risk === "bounded_write"
					? "medium"
					: risk
						? "high"
						: "unknown",
		content:
			reviewedEffect || certificationStart
				? "reviewed tool effect"
				: `${agent.appSlug ?? ""}:${tool.toolId}`,
	});
	// Org standing consent covers bounded actions; Work authorization is separate.
	if (
		autonomy &&
		autonomousDecision.autoApprove &&
		!isOwnedChannelBoundary &&
		annotations?.destructiveHint !== true &&
		configuredApproval !== "always" &&
		configuredApproval !== "once" &&
		configuredApproval !== "work_item"
	) {
		emitGovernanceAuditEvent(
			agent,
			tool,
			"destructive_approved",
			autonomousDecision.reason,
			{
				policyVersion: autonomy.version,
				resolvedBy: "policy",
				policyPack: autonomy.policyPack,
			},
		);
		return null;
	}
	if (
		!humanBoundary &&
		!isOwnedChannelBoundary &&
		!configuredApproval &&
		!autonomy &&
		!callerIsAgent(agent, options?.extra)
	)
		return null;
	// Arguments cannot certify a preview: downstream schemas may discard dryRun.

	// Grant fast path (Batch 4). Runs before confirmDestructive/MRTR/elicitInput
	// and works identically in the Code Mode inner-sandbox path (no
	// input_required emission involved — it's a single awaited network call,
	// not a client round trip). Only engages when the tool's D1 config declares
	// `approvalPolicy: "once" | "always"`; every other tool (the overwhelming
	// majority, field absent) skips this block entirely and falls through to
	// exactly today's behavior below.
	const grantApproval = await tryResolveApprovalGrant(agent, tool);
	if (grantApproval) {
		if (!grantApproval.approved) {
			const ownerApproval = await ownerToolApproval(agent, tool, options);
			if (ownerApproval !== undefined) return ownerApproval;
			emitGovernanceAuditEvent(
				agent,
				tool,
				"destructive_denied",
				"grant_not_approved",
			);
			return approvalFailure(
				`Action "${tool.toolId}" was not approved: the configured approval policy requires a current durable grant. No side effect was executed.`,
			);
		}
		emitGovernanceAuditEvent(
			agent,
			tool,
			"grant_approved",
			`durable grant ${grantApproval.grantId}`,
			{ grantId: grantApproval.grantId },
		);
		console.log(
			`[governance] ${tool.toolId} approved via durable grant ${grantApproval.grantId}`,
		);
		return null;
	}

	const approvalPolicy = readApprovalPolicy(agent, tool);
	const requiresWorkItemAuthorization =
		approvalPolicy === "work_item" &&
		(isOwnedChannelBoundary
			? !callerIsUserPrincipalPath(agent)
			: callerIsAgent(agent, options?.extra));
	if (requiresWorkItemAuthorization) {
		const resolution = await resolveWorkItemAuthorization(
			agent,
			tool,
			options?.args ?? {},
		);
		if (resolution.approved) {
			emitGovernanceAuditEvent(
				agent,
				tool,
				"work_item_approved",
				resolution.reason,
				{
					workItemId: resolution.workItemId,
					authorizationScopeWorkItemId: resolution.authorizationScopeWorkItemId,
					authorizationCommentId: resolution.authorizationCommentId,
					attemptId: resolution.attemptId,
					campaignKey: resolution.campaignKey,
					validUntil: resolution.validUntil,
				},
			);
			console.log(
				`[governance] ${tool.toolId} approved by Work Item ${resolution.workItemId}`,
			);
			return null;
		}

		emitGovernanceAuditEvent(
			agent,
			tool,
			"destructive_denied",
			`work_item_authorization:${resolution.reason}`,
			{ workItemId: resolution.workItemId },
		);
		return approvalFailure(
			`Action "${tool.toolId}" was not approved: no current server-attributed authorization receipt from an accountable principal matches the active Work Item and publish scope (${resolution.reason}). No side effect was executed.`,
		);
	}

	if (autonomy || humanBoundary || isOwnedChannelBoundary) {
		const ownerApproval = await ownerToolApproval(agent, tool, options);
		if (ownerApproval !== undefined) return ownerApproval;
	}
	if (autonomy) {
		const reason = humanBoundary
			? "critical or destructive action requires human approval"
			: autonomousDecision.reason;
		emitGovernanceAuditEvent(agent, tool, "destructive_denied", reason);
		return approvalFailure(
			`Human approval required: ${reason}. Route this action through Home's approval flow. No side effect was executed.`,
		);
	}

	// A tenant credential or remote MCP connection is authority over a third
	// party, not merely another implementation detail of a scoped Tedix tool.
	// Code Mode has no synchronous approval channel, so once the tedi policy-pack
	// rollout switch is enabled an absent D1 policy must not silently inherit the
	// broad first-party agent self-confirm below. The
	// owning app/tool row must make the posture explicit first; then the existing
	// once/always grant, work-item, explicit-confirmation, and legacy auto-confirm
	// paths retain their established semantics. Tedix-managed MCP hosts stay on
	// the first-party path because their authorization is enforced inside Tedix.
	const unconfiguredThirdPartyTransport = thirdPartyTransport(tool);
	if (
		options?.autoConfirmAgent &&
		callerIsAgent(agent, options.extra) &&
		unconfiguredThirdPartyTransport &&
		readConfiguredApprovalPolicy(agent, tool) === null &&
		(await requiresExplicitThirdPartyApprovalPolicy(agent))
	) {
		emitGovernanceAuditEvent(
			agent,
			tool,
			"destructive_denied",
			"third_party_approval_policy_required",
			{ transport: unconfiguredThirdPartyTransport },
		);
		return approvalFailure(
			`Action "${tool.toolId}" was not approved: destructive ${unconfiguredThirdPartyTransport}-transport tools require an explicit approval policy configured for the app before autonomous Code Mode can execute them. Route this write through Home's parked approval flow or configure the tool's intended approval policy. No side effect was executed.`,
		);
	}

	// Stateless command clients have no reverse request channel for legacy
	// elicitation. Let a destructive tool opt into a one-round confirmation by
	// declaring `confirmDestructive` in its own schema and sending it alongside a
	// non-empty reason. This is still explicit, auditable consent; omitted/false
	// values continue through MRTR/elicitation and fail closed when unavailable.
	if (
		options?.args?.confirmDestructive === true &&
		!configuredApproval &&
		!callerIsAgent(agent, options.extra)
	) {
		const reason = approvalReason({ reason: options.args.reason });
		if (!reason) {
			emitGovernanceAuditEvent(
				agent,
				tool,
				"destructive_denied",
				"missing_reason",
			);
			return approvalFailure(
				`Action "${tool.toolId}" was not approved because a reason is required. No side effect was executed.`,
			);
		}
		emitGovernanceAuditEvent(agent, tool, "destructive_approved", reason);
		console.log(
			`[governance] ${tool.toolId} approved via explicit stateless confirmation with reason: ${reason}`,
		);
		return null;
	}

	// Legacy confirmation cannot override a critical or destructive boundary.
	if (
		options?.autoConfirmAgent &&
		callerIsAgent(agent, options?.extra) &&
		!humanBoundary &&
		!configuredApproval &&
		risk === "bounded_write"
	) {
		const actorType = normalizeCallerIdentity(
			agent.callerIdentity ?? { authType: "tedi" },
		).actorType;
		const reason = `autonomous ${actorType} self-approval (Code Mode)`;
		emitGovernanceAuditEvent(agent, tool, "destructive_approved", reason, {
			agentAutoConfirm: true,
		});
		console.log(
			`[governance] ${tool.toolId} auto-approved for autonomous agent (${actorType})`,
		);
		return null;
	}

	const extra = options?.extra;
	const allowSyncMrtr = options?.allowSyncMrtr !== false;
	const displayName = tool.title?.trim() || tool.toolId;

	// ── Synchronous MRTR (input_required round-trip) ──
	// The 2026-native way to request mid-request approval. Fire it for an agent
	// caller (any era) or any caller on a modern serving connection — because on
	// 2026-07-28 the legacy `elicitInput()` below is illegal (server→client
	// requests are removed), so input_required is the only approval mechanism.
	// The inputRequest is `elicitation/create`-typed, so a caller that declared
	// clientCapabilities without elicitation must not receive it (MRTR spec);
	// modern callers without that capability fail closed below. Code Mode
	// permits this round-trip only before any tool has dispatched.
	if (
		allowSyncMrtr &&
		callerDeclaredElicitation(extra) !== false &&
		(callerIsAgent(agent, extra) || servingConnectionIsModern(extra))
	) {
		const responses = readInputResponses(extra);
		// First touch (no echoed state) → ask for approval via input_required.
		if (!responses) {
			return buildInputRequiredResult(
				agent,
				tool,
				displayName,
				options?.requestBinding,
			);
		}
		// Retry: the requestState MUST verify (integrity-tagged, bound to this
		// tool + org, unexpired) before the gate opens.
		const verification = await verifyRequestState({
			requestState: responses.requestState,
			toolId: tool.toolId,
			organizationId: agent.app?.organizationId ?? "",
			subjectUserId: agent.callerIdentity?.userId,
			requestBinding: options?.requestBinding,
			signingKey: resolveRequestStateKey(
				agent.env as { PLATFORM_SERVICE_TOKEN?: string } | undefined,
			),
		});
		if (!verification.ok) {
			emitGovernanceAuditEvent(
				agent,
				tool,
				"destructive_denied",
				`invalid_request_state:${verification.reason}`,
			);
			return approvalFailure(
				`Action "${tool.toolId}" was not approved: the requestState is invalid (${verification.reason}). Re-issue the call to obtain a fresh approval round. No side effect was executed.`,
			);
		}
		const reason = approvalReason(responses.content);
		if (!reason) {
			emitGovernanceAuditEvent(
				agent,
				tool,
				"destructive_denied",
				"missing_reason",
			);
			return approvalFailure(
				`Action "${tool.toolId}" was not approved because a reason is required. No side effect was executed.`,
			);
		}
		emitGovernanceAuditEvent(agent, tool, "destructive_approved", reason);
		console.log(
			`[governance] ${tool.toolId} approved via sync-MRTR with reason: ${reason}`,
		);
		return null;
	}

	if (servingConnectionIsModern(extra)) {
		return approvalFailure(
			`Action "${tool.toolId}" requires approval. Use an elicitation-capable client and a separate Code Mode call before any other tool dispatch. No side effect was executed.`,
		);
	}

	// ── Human / bidirectional host: legacy in-band elicitInput() ──
	try {
		const result = await agent.server.server.elicitInput({
			mode: "form",
			message: `You are about to execute "${displayName}". Confirm this destructive action with a reason.`,
			requestedSchema: {
				type: "object",
				properties: {
					reason: {
						type: "string",
						title: "Reason",
						description: "Why are you performing this action?",
					},
				},
				required: ["reason"],
			},
		});

		if (result.action !== "accept") {
			const actionText = result.action === "decline" ? "declined" : "cancelled";
			emitGovernanceAuditEvent(
				agent,
				tool,
				"destructive_denied",
				`user_${actionText}`,
			);
			return approvalFailure(
				`Action "${tool.toolId}" was ${actionText} by the user. No side effect was executed.`,
			);
		}

		const reason = approvalReason(result.content);
		if (!reason) {
			emitGovernanceAuditEvent(
				agent,
				tool,
				"destructive_denied",
				"missing_reason",
			);
			return approvalFailure(
				`Action "${tool.toolId}" was not approved because a reason is required. No side effect was executed.`,
			);
		}

		emitGovernanceAuditEvent(agent, tool, "destructive_approved", reason);
		console.log(`[governance] ${tool.toolId} approved with reason: ${reason}`);
		return null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Elicitation unavailable is not approval. Fail closed so destructive
		// tools never execute just because the host cannot present the prompt.
		emitGovernanceAuditEvent(
			agent,
			tool,
			"destructive_denied",
			`elicitation_unavailable: ${message}`,
		);
		console.warn(
			`[governance] ${tool.toolId} destructive approval unavailable; denied before side effect: ${message}`,
		);
		// Reaching this point on a modern connection means the sync-MRTR branch
		// was skipped — a Code Mode inner call (no round-trip channel) or a
		// caller that declared no elicitation capability. Detect the modern
		// elicitation restriction from the SDK error itself (Code Mode inner
		// calls carry no request `_meta`, so `servingConnectionIsModern` can't
		// see it) and point the caller at the explicit `confirmDestructive` arg
		// instead of leaving them at a dead end.
		// Reaching this catch means no approval channel exists at all: the
		// legacy prompt threw and sync-MRTR was skipped or unavailable. The
		// explicit `confirmDestructive` branch above is evaluated
		// unconditionally and before both, so it is a legal recovery on every
		// path that lands here — emit the recovery instruction regardless of
		// why elicitation was unavailable. Gating the hint on the cause left
		// the most common case ("client declared no elicitation capability" on
		// a connection whose `_meta` carries no modern protocol marker) at a
		// silent dead end.
		const isModernElicitRestriction =
			/Server-to-client requests are not available on protocol revision/i.test(
				message,
			);
		const cause =
			isModernElicitRestriction || servingConnectionIsModern(extra)
				? `On protocol ${MCP_MODERN_PROTOCOL_VERSION} server-to-client elicitation is removed`
				: "This client cannot present an elicitation prompt";
		const recoveryHint =
			` ${cause} — retry with confirmDestructive:true and a non-empty reason` +
			` (or call as an agent that can fulfil the input_required round-trip).`;
		return approvalFailure(
			`Action "${tool.toolId}" was not approved because destructive approval is unavailable: ${message}. No side effect was executed.${recoveryHint}`,
		);
	}
}
