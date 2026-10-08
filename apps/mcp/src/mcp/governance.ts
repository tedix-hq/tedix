import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ToolAnnotations } from "@tedix/api-contract/schemas/tools";
import {
	checkAnnotationAssertion,
	type ExpectedAnnotations,
} from "@tedix/api-contract/utils/skill-manifest";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_META_KEY,
} from "@tedix/mcp-shared/protocol";
import { clientSupportsTasks } from "@tedix/mcp-shared/tasks";
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
import { toolRiskAuditMetadata } from "./tool-risk-policy";
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
			| "callerIdentity"
			| "connectionLabel"
			| "traceId"
			| "apiClient"
		>
	>;
type ApprovalTool = Pick<AppTool, "toolId" | "title"> &
	Partial<Pick<AppTool, "config" | "meta">>;

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
 * contradict the assertion. See Sam Morrow Part 3 in `docs/engineering/cognition/skills.md`
 * "External Design Lessons".
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
		userId: agent.callerIdentity?.userId,
		clientId: agent.callerIdentity?.clientId,
		authType: agent.callerIdentity?.authType,
		traceId: agent.traceId,
		success: outcome !== "destructive_denied",
		...(outcome === "destructive_denied" && {
			errorCode: "DESTRUCTIVE_GATE_DENIED",
		}),
		metadata: {
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
 * FAIL-CLOSED at every branch: any missing prerequisite (no approvalPolicy
 * override, no org/appSlug/apiClient/callerIdentity, no resolvable subject
 * id) or any error/non-approval from the resolve call returns `null` — the
 * caller then falls through to exactly today's elicitation behavior. Nothing
 * here can turn into auto-approval on failure.
 */
async function tryResolveApprovalGrant(
	agent: ApprovalContext,
	tool: ApprovalTool,
): Promise<{ grantId: string } | null> {
	const grantKind = readApprovalPolicy(agent, tool);
	if (!grantKind || grantKind === "work_item") return null;

	const organizationId = agent.app?.organizationId;
	const appSlug = agent.appSlug;
	const apiClient = agent.apiClient;
	const callerIdentity = agent.callerIdentity;
	if (!organizationId || !appSlug || !apiClient || !callerIdentity) {
		return null;
	}

	const subjectId = normalizeCallerIdentity(callerIdentity).actorId;
	if (!subjectId) return null;

	try {
		const result = await apiClient.mcpGovernance.resolveToolApprovalGrant({
			organizationId,
			subjectId,
			appSlug,
			toolId: tool.toolId,
			grantKind,
		});
		if (result?.approved && result.grantId) {
			return { grantId: result.grantId };
		}
		return null;
	} catch (error) {
		// Network/API failure is not approval. Fail closed to elicitation.
		console.warn(
			`[governance] grant lookup failed for ${tool.toolId}; falling through to elicitation:`,
			error,
		);
		return null;
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
 * Is the destructive caller an AGENT (kernel / another tedi or a modern client
 * that declared the tasks extension) rather than a human/bidirectional host?
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
	if (authType === "tedi" || authType === "service") return true;
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
	return (
		extra?._meta?.[MCP_PROTOCOL_VERSION_META_KEY] ===
		MCP_MODERN_PROTOCOL_VERSION
	);
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
): Promise<CallToolResult> {
	const organizationId = agent.app?.organizationId ?? "";
	const requestState = await signRequestState({
		toolId: tool.toolId,
		organizationId,
		subjectUserId: agent.callerIdentity?.userId,
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
		_meta: {
			[INPUT_REQUIRED_META_KEY]: {
				requestState,
				inputRequests: { approval: inputRequest },
			},
		},
	};
}

export interface DestructiveApprovalOptions {
	/** Retry metadata. Canonical params are adapted by the stateless transport. */
	extra?: { _meta?: Record<string, unknown> };
	/** Parsed tool arguments; explicit dryRun=true previews are non-mutating. */
	args?: Record<string, unknown>;
	/**
	 * Allow the synchronous-MRTR (`input_required`) path for agent callers.
	 * Defaults to true. Code Mode inner sandbox calls pass `false`: the sandbox
	 * cannot perform the retry round-trip, so they keep the legacy
	 * proceed-under-auth behavior instead of halting on an unreachable prompt.
	 */
	allowSyncMrtr?: boolean;
	/**
	 * Auto-confirm a destructive action for an AGENT (tedi) caller with a
	 * reasoned, audited justification, instead of failing closed on the
	 * unreachable elicitation prompt. Passed by the Code Mode inner-tool path,
	 * where a tedi runs its own scope-permitted tools with no protocol channel
	 * to answer an `input_required` round-trip (see `allowSyncMrtr`). This is the
	 * autonomous-workflow posture: a tedi self-approves destructive tools it
	 * already has SCOPE for. It is not a scope grant and does not touch the
	 * crown-jewel gates — capability-tier mutations (apps/api's
	 * `agentUnreachableCapabilityFieldsTouched` allowlist) and cross-tedi/cross-org
	 * access (the runtime self-binding guard) stay blocked at a separate layer
	 * regardless. Only fires when the caller is actually an agent
	 * (`callerIsAgent`) — a human operator via Code Mode still confirms explicitly
	 * (or is denied), never auto-approved.
	 */
	autoConfirmAgent?: boolean;
}

export async function requireDestructiveToolApproval(
	agent: ApprovalContext,
	tool: ApprovalTool,
	annotations?: ToolAnnotations | null,
	options?: DestructiveApprovalOptions,
): Promise<CallToolResult | null> {
	const isOwnedChannelBoundary = isTedixOwnedChannelPublishBoundary(
		agent,
		tool,
	);
	if (annotations?.destructiveHint !== true && !isOwnedChannelBoundary)
		return null;
	// `content_publish` has no preview contract. Unknown arguments can be
	// stripped downstream, so a caller-supplied dryRun=true must never bypass
	// the exact owned-channel gate while the real publish still executes.
	if (options?.args?.dryRun === true && !isOwnedChannelBoundary) return null;

	// Grant fast path (Batch 4). Runs before confirmDestructive/MRTR/elicitInput
	// and works identically in the Code Mode inner-sandbox path (no
	// input_required emission involved — it's a single awaited network call,
	// not a client round trip). Only engages when the tool's D1 config declares
	// `approvalPolicy: "once" | "always"`; every other tool (the overwhelming
	// majority, field absent) skips this block entirely and falls through to
	// exactly today's behavior below.
	const grantApproval = await tryResolveApprovalGrant(agent, tool);
	if (grantApproval) {
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
	if (options?.args?.confirmDestructive === true) {
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

	// Autonomous agent self-approval (Code Mode inner path). A tedi runs all its
	// tools through Code Mode, whose sandbox cannot answer an elicitation
	// round-trip (allowSyncMrtr is false there), so without this a tedi could not
	// execute any destructive tool it has scope for — breaking autonomous
	// workflows. Auto-approve for a genuine AGENT caller with an audited reason;
	// a human operator (not callerIsAgent) still falls through to the explicit
	// confirmation / elicitation paths below and is never auto-approved. See the
	// autoConfirmAgent doc on DestructiveApprovalOptions for the security envelope
	// (scope-permitted only; crown-jewel gates unaffected).
	if (options?.autoConfirmAgent && callerIsAgent(agent, options?.extra)) {
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
	// such callers fall through to the legacy path, which fails closed when the
	// host cannot present the prompt. Code Mode inner calls set allowSyncMrtr
	// false (the sandbox has no outer channel to round-trip) and rely on the
	// tedi auto-confirm above or an explicit `confirmDestructive` arg.
	if (
		allowSyncMrtr &&
		callerDeclaredElicitation(extra) !== false &&
		(callerIsAgent(agent, extra) || servingConnectionIsModern(extra))
	) {
		const responses = readInputResponses(extra);
		// First touch (no echoed state) → ask for approval via input_required.
		if (!responses) {
			return buildInputRequiredResult(agent, tool, displayName);
		}
		// Retry: the requestState MUST verify (integrity-tagged, bound to this
		// tool + org, unexpired) before the gate opens.
		const verification = await verifyRequestState({
			requestState: responses.requestState,
			toolId: tool.toolId,
			organizationId: agent.app?.organizationId ?? "",
			subjectUserId: agent.callerIdentity?.userId,
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
