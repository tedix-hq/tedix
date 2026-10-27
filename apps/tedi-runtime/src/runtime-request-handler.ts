import { exceptionTopology } from "@tedix/worker-kit/exception-topology";
import { memoryDiagnostics } from "./runtime-diagnostics";
import { RuntimeRunSteeringInputSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import type { PolicyCronReconcileReceipt } from "./runtime-cron";
import { type ProxyToolOutput, resolveProvider } from "@cloudflare/codemode";
import { stateTools } from "./workspace-state/workers";
import { ExecutionSurfaceSchema } from "@tedix/api-contract/schemas/execution-evidence";
import type { DelegationAuthorityEnvelope } from "@tedix/api-contract/schemas/kernel-runtime";
import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import { type CompiledDirective } from "@tedix/context-core/compiler";
import { type BrainAuditInput } from "@tedix/db/queries/memory-audit";
import {
	type CallerTrustTier,
	stripMemberOnlyInjectFields,
} from "@tedix/mcp-shared/auth/caller-trust";
import {
	boundCodeModeLogs,
	shapeBoundedCodeModeResult,
} from "@tedix/tedi-codemode-core/bounded-result";
import { runStatelessCodeMode } from "@tedix/tedi-codemode-core/run-stateless-code";
import type { CodeModeExecutionContext } from "@tedix/tedi-codemode-core/types";
import {
	DEFAULT_SESSION_KEY,
	type TediSessionModelIdentity,
} from "@tedix/tedi-session/session-harness";
import {
	type CompactionResult,
	deriveIdempotencyKey,
	TediSessionRepo,
} from "@tedix/tedi-session/session-repo";
import { type AudioAttachment, type TurnImagePart } from "@tedix/voice/stt";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { type ToolSet } from "ai";
import * as z from "zod";
import { type NativeAcpTurnInput } from "./acp-channel";
import {
	type AdaptiveLearningMode,
	adaptiveLearningModeForTurn,
} from "./adaptive-learning";
import {
	isAdminAuthorized,
	parseDequeueBody,
	type QueueRow,
	summarizeQueue,
} from "./admin-agent-diag";
import { handleAgentMemoryProjectionInspect } from "./agent-memory-projection";
import {
	agentMemoryProfileName,
	handleAgentMemoryProfileDelete,
} from "./agent-memory-tools";
import { TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION } from "./artifacts-contract";
import type { ArtifactsPushReceipt } from "./artifacts-git";
import type { DoSqlRunner } from "./brain-bridge-do";
import { type BrainDigest, serializeBrainDigest } from "./brain/brain-digest";
import type { HttpPlatformClient } from "./brain/platform-client";
import { sanitizeChatAttachments } from "./chat-attachments";
import {
	type InternalChatStreamPayload,
	internalChatStreamTrust,
	isEmbeddedSessionKey,
} from "./chat-stream-input";
import {
	isPageToolCallId,
	normalizePageToolDescriptors,
	normalizePageToolResult,
} from "@tedix/chat-transport/page-tools";
import type { PageToolBroker } from "@tedix/chat-transport/page-tool-broker";
import type { ChatTurnParams } from "./chat-turn-input";
import { CmSessionGate } from "./cm-execution-gate";
import { CmExecutionStore, hashCode } from "./cm-execution-store";
import {
	type ComputerCodeBinding,
	ComputerCodeRouting,
} from "./computer-codemode-routing";
import {
	ComputerEnvironmentController,
	computerRepositoryReader,
	computerScratchState,
} from "./computer-environment";
import { computerMcpContext } from "./computer-mcp-context";
import {
	type ComputerWorkspaceScope,
	OPERATOR_COMPUTER_SCOPE,
	ScopedComputerWorkspace,
} from "./computer-workspace-scope";
import { ConversationFacet } from "./conversation-facet";
import { type AdminScheduleSnapshot, scheduleToAdminSchedule } from "./cron";
import {
	isAdmissionBudgetExhausted,
	isBackgroundBudgetHardExhausted,
	nextUtcDayStartMs,
} from "./cron-budget-control";
import { DoCrystallizationStateStore } from "./crystallization-store-do";
import { type FacetWorkflowTurnInput } from "./delegated-work-lease";
import {
	type DelegationAuthorityMode,
	parseDelegationAuthorityEnvelope,
	parseDelegationAuthorityMode,
} from "./delegation-authority";
import type { AgentTediDO } from "./do";
import type { ActiveTurnBinding, State } from "./runtime-state";
import {
	createDurableCodeRecovery,
	scopeDurableCodeAction,
	type RecoverableCodemodeRuntimeHandle,
} from "./durable-codemode-recovery";
import {
	chatTurnErrorResponse,
	isDuplicateWorkflowInstanceError,
	recordQueuedChatTurn,
	settledChatTurnReceipt,
} from "./durable-messages-send";
import {
	handleEmbeddedTranscriptRequest,
	handleEmbeddedWarmRequest,
} from "./embedded-internal-routes";
import { embeddedTurnQuotaFromPayload } from "./embedded-turn-quota";
import { DoInferenceBudgetStore } from "./inference-budget-store-do";
import { trustedInstructionOriginForInject } from "./inference-guardrails";
import { buildRunId, buildWorkflowInstanceId } from "./ledger-mirror";
import { recordDirectMcpAuditEvent } from "./mcp-audit";
import { callerTrustTierForRequest } from "./mcp-caller-trust";
import type { AgentMcpRuntime } from "./mcp-client-runtime";
import type { CronToolInput } from "./mcp-mount";
import { buildDirectTediTaskHandlers } from "./mcp-task-handlers";
import { turnModelForInject } from "./model-policy";
import { OBJECT_STORE_PREFIX } from "./object-store-tools";
import { parseOperatorConsent } from "./operator-consent";
import { PiTelegram } from "./pi-parent-services";
import { inspectExistingPiFacet } from "./pi-recovery-diagnostic";
import { RuntimeConfigCache } from "./runtime-config-cache";
import { RuntimeEventOutbox } from "./runtime-event-outbox";
import { repositoryModeForMetadata } from "./runtime-tool-guidance";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import { capabilityPlanForMetadata } from "./delegation-capabilities";
import { delegationBudgetForMetadata } from "./delegation-budget";
import { terminateWorkflow } from "./workflow-cancellation";
import { WorkflowImageCleanup } from "./workflow-image-cleanup";
import { type WorkflowImageRef } from "./workflow-image-handoff";
import { type WorkflowDispatchContext } from "./workflow-start-watchdog";
import { utcDateSlug } from "./workspace";
import { type WorkstationTurnContext } from "./workstation-turn-context";

export interface RuntimeRequestHost {
	pageToolBroker: PageToolBroker;
	hintsFromHeaders: (headers: Headers) => {
		slug?: string;
		tediId?: string;
		orgId?: string;
		authSubject?: string;
	};
	ensureIdentity: (hints?: {
		slug?: string;
		tediId?: string;
		orgId?: string;
		authSubject?: string;
	}) => Promise<void>;
	state: State;
	subAgent: AgentTediDO["subAgent"];
	nativeTelegram: () => Promise<PiTelegram | null>;
	env: Cloudflare.Env;
	browserTakeoverStatus: (
		approvalRequestId: string,
		limit: number,
	) => Promise<unknown>;
	browserLoginSession: (action: "status" | "end") => Promise<unknown>;
	runtimeConfigCache: RuntimeConfigCache;
	setState: (state: State) => void;
	cronReconcileDone: boolean;
	reconcilePolicyPackCrons: (options?: {
		forceUpdate?: boolean;
	}) => Promise<PolicyCronReconcileReceipt>;
	resumeChatStream: (request: Request, url: URL) => Response;
	streamChatTurn: (
		input: NativeAcpTurnInput,
		serviceOperationId?: string,
	) => Promise<Response>;
	getMcpRuntime: (skipInitialSync?: boolean) => Promise<AgentMcpRuntime | null>;
	imageCleanupJournal: () => WorkflowImageCleanup;
	isWorkflowRunCanceled: (runId: string) => Promise<boolean>;
	sessionRepo: TediSessionRepo;
	getPlatformClient: () => Promise<HttpPlatformClient | null>;
	acceptRuntimeTurn: (
		runId: string,
		sessionKey: string,
		input: unknown,
		reuseAccepted?: boolean,
	) => Promise<void>;
	assertChatTurnActive: (runId: string | null | undefined) => Promise<void>;
	resolveAttachmentTurn: (
		userText: string,
		attachments: AudioAttachment[] | undefined,
	) => Promise<{ content: string; images: TurnImagePart[] }>;
	prepareWorkflowImages: (
		runId: string,
		workflowInstanceId: string,
		images: TurnImagePart[],
		sessionKey: string,
	) => Promise<WorkflowImageRef[]>;
	recordWorkflowDispatch: (
		workflowInstanceId: string,
		ctx: {
			runId: string;
			traceId?: string;
			sessionKey: string;
			userText: string;
			userTs: number;
			workItemId?: string;
			cron?: WorkflowDispatchContext["cron"];
		},
	) => Promise<boolean>;
	clearWorkflowDispatch: (
		workflowInstanceId: string,
		imageCleanup?: "terminal" | "cancelled",
	) => Promise<void>;
	dispatchAdmittedChatWorkflow: (
		binding: "CHAT_TURN_WORKFLOW",
		params: ChatTurnParams & Pick<FacetWorkflowTurnInput, "operatorConsent">,
		options: { id: string; agentBinding: "TEDI_AGENT" },
	) => Promise<void>;
	name: string;
	reconcileChatWorkflowTerminal: (input: {
		workflowInstanceId: string;
		attempt: number;
		renewal?: boolean;
	}) => Promise<boolean>;
	runDurableChatTurn: (input: {
		noFunds?: boolean;
		sessionKey: string;
		text: string;
		traceId?: string;
		clientRequestId: string;
		attachments?: AudioAttachment[];
		learningMode?: AdaptiveLearningMode;
		callerTrust?: CallerTrustTier;
	}) => Promise<{
		ok: true;
		run_id: string;
		session_key: string;
		assistant: { role: "assistant"; content: string; ts: number } | null;
		pending?: true;
		model_identity?: TediSessionModelIdentity;
	}>;
	getTools: (
		scope?: ComputerWorkspaceScope | null,
		binding?: ActiveTurnBinding | null,
	) => ToolSet;
	recordWorkflowCancellation: (runId: string) => Promise<void>;
	activeTurnAborts: Map<string, AbortController>;
	cascadeCancelFanout: (
		rootRunId: string,
		opts?: { maxDepth?: number; maxTerminations?: number },
	) => Promise<{ terminated: string[] }>;
	ctx: DurableObjectState<{}>;
	dispatchIndependentWorkItem: (item: {
		clientRequestId: string;
		userText: string;
		parentRunId: string;
		parentConversationId: string;
		independent?: boolean;
		objective?: string;
	}) => Promise<{
		dispatched: boolean;
		childRunId?: string;
		sessionKey?: string;
	}>;
	liveWorkItemSlots: Map<string, string>;
	repoCommitDrainTool: (input: {
		approvalRequestId?: string;
		executionLedgerId?: string;
	}) => Promise<unknown>;
	getSqlRunner: () => DoSqlRunner;
	meshInject: (input: {
		target: string;
		sessionKey: string;
		text: string;
		clientRequestId: string;
	}) => Promise<
		| { ok: true; target: string; session_key: string; assistant: unknown }
		| { ok: false; error: string; status: number }
	>;
	landVoiceRecap: (input: {
		sessionKey: string;
		recap: string;
		clientRequestId: string;
	}) => Promise<{ ok: true; session_key: string; run_id: string }>;
	readMessagesForSession: (
		sessionKey: string,
		limit?: number,
	) => Promise<{
		session_key: string;
		messages: {
			role: "system" | "user" | "assistant" | "tool" | "runtime";
			content: string;
			text: string;
			ts: number;
			timestamp: number;
		}[];
	}>;
	computerWorkspace: (scope: ComputerWorkspaceScope) => ScopedComputerWorkspace;
	runDurableCode: (
		input: { code: string },
		scope: ComputerWorkspaceScope,
		binding: ActiveTurnBinding | null,
	) => Promise<ProxyToolOutput>;
	searchDurableCode: (
		query: string,
		scope: ComputerWorkspaceScope,
	) => Promise<unknown>;
	describeDurableCode: (
		target: string,
		scope: ComputerWorkspaceScope,
	) => Promise<unknown>;
	getDurableCodeExecution: (
		executionId: string,
		expectedScope?: ComputerWorkspaceScope,
	) => Promise<unknown>;
	listDurableCodeExecutions: (
		limit: number,
		scope: ComputerWorkspaceScope,
	) => Promise<unknown[]>;
	approveDurableCodeExecution: (
		executionId: string,
	) => Promise<ProxyToolOutput>;
	rejectDurableCodeExecution: (
		executionId: string,
		seq: number,
	) => Promise<{ ok: boolean; execution_id: string; seq: number }>;
	rollbackDurableCodeExecution: (
		executionId: string,
	) => Promise<{ ok: true; execution_id: string }>;
	computerCodeRouting: ComputerCodeRouting;
	getDurableCodemodeRuntime: (
		scope: ComputerCodeBinding,
	) => Promise<RecoverableCodemodeRuntimeHandle>;
	brainAuditTool: (input: BrainAuditInput) => Promise<unknown>;
	readConversationForSession: (sessionKey: string) => Promise<{
		session_key: string;
		title: string;
		messageCount: number;
		messages: {
			role: "system" | "user" | "assistant" | "tool" | "runtime";
			content: string;
			text: string;
			ts: number;
			timestamp: number;
		}[];
	}>;
	readConversationSummaryForSession: (sessionKey: string) => Promise<{
		session_key: string;
		title: string;
		messageCount: number;
		updatedAt: number | null;
	}>;
	cronTool: (
		input: CronToolInput,
		boundSessionKey?: string,
	) => Promise<unknown>;
	repoCommitProposeTool: (
		input: {
			branch: string;
			message: string;
			paths: string[];
			deletePaths?: string[];
			baseRef?: string;
			openPr?: boolean;
			prBase?: string;
		},
		computer: {
			turnContext: WorkstationTurnContext | null;
			workspace: Pick<ScopedComputerWorkspace["workspace"], "readFile">;
		},
	) => Promise<unknown>;
	computerEnvironment: (
		scope: ComputerWorkspaceScope,
		turnContext: WorkstationTurnContext | null,
	) => ComputerEnvironmentController;
	repoCommitStatusTool: (input: {
		approvalRequestId?: string;
		executionLedgerId?: string;
	}) => Promise<unknown>;
	listArtifactFilesTool: (input: {
		prefix?: string;
		limit?: number;
	}) => Promise<unknown>;
	readArtifactFileTool: (input: {
		path?: string;
		maxChars?: number;
	}) => Promise<unknown>;
	writeArtifactFileTool: (
		input: { path?: string; content?: string; message?: string },
		runId: string | null | undefined,
	) => Promise<unknown>;
	workstationAiTool: (
		scope: ComputerWorkspaceScope,
		turnContext: WorkstationTurnContext | null,
	) => ToolSet;
	drainPendingCodemodeExecutions: () => Promise<void>;
	proposeCodemodeExecuteApproval: (input: {
		approvalRequestId: string;
		executionId: string;
		sessionKey: string;
		codeHash: string;
		conversationId: string;
		executionMode?: "session_replay" | "durable_call";
		homeRunId?: string;
		childRunId?: string;
		pendingSeq?: number;
		connector?: string;
		method?: string;
		repairAttempt?: number;
	}) => Promise<string | null>;
	onDailyLogFlush: (
		admittedRunId?: string,
	) => Promise<ArtifactsPushReceipt | null>;
	dynamicAgents: AgentTediDO["dynamicAgents"];
	ensureBrainDigestLoaded: () => Promise<void>;
	brainDigest: BrainDigest | null;
	ensureDirectivesLoaded: () => Promise<void>;
	compiledDirectives: CompiledDirective[];
	getInferenceBudgetStore: () => DoInferenceBudgetStore;
	inferenceBudgetLimits: () => {
		dailyMessageLimit: number;
		dailyTokenLimit: number;
		operatorMessageReserve: number;
		operatorTokenReserve: number;
		governedLearningMessageReserve: number;
		governedLearningTokenReserve: number;
	};
	prepareCompaction: (
		sessionKey: string,
		opts?: { keepRecentTokens?: number },
	) => Promise<string>;
	runCompaction: (
		sessionKey: string,
		opts?: { keepRecentTokens?: number },
		acceptedOperationId?: string,
	) => Promise<CompactionResult | null>;
	agentMemoryProfile: () => Promise<AgentMemoryProfile | null>;
	listSchedules: AgentTediDO["listSchedules"];
	eventOutbox: RuntimeEventOutbox;
	getCrystallizationStore: () => DoCrystallizationStateStore;
	activeTurnBinding: ActiveTurnBinding | null;
	directivesLoaded: boolean;
	r2SqlEnv: () => {
		accountId: string;
		table: string;
		token: string | undefined;
		warehouse: string | undefined;
	};
	cancelSchedule: AgentTediDO["cancelSchedule"];
	dequeueAllByCallback: AgentTediDO["dequeueAllByCallback"];
	dequeueAll: AgentTediDO["dequeueAll"];
	TELEGRAM_WEBHOOK_PATH: "/webhooks/telegram";
	unknownRecord: (value: unknown) => Record<string, unknown> | null;
	identityValue: (value: string | null | undefined) => string | undefined;
}

/**
 * Whether a request path names a tedi DO `/__internal/*` route under any
 * spelling. The DO matches those routes by exact pathname, so the caller
 * check decodes percent-escapes, resolves dot segments and collapses repeated
 * slashes before deciding: a caller must not reach a privileged handler
 * through a spelling the exact match would miss on a later rewrite.
 */
export function targetsInternalRoute(url: URL): boolean {
	let pathname = url.pathname;
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// Undecodable escapes stay literal; they are compared as written.
	}
	// Resolve `.`/`..` segments the decode may have revealed.
	pathname = new URL(pathname.replace(/\/{2,}/g, "/"), "https://internal")
		.pathname;
	return /^\/__internal(?:\/|$)/i.test(pathname.replace(/\/{2,}/g, "/"));
}

export async function handleRuntimeRequest(
	host: RuntimeRequestHost,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	// `/__internal/*` is this DO's privileged control surface. The Worker edge
	// refuses an untrusted caller before the DO wakes, but the DO's `fetch` is
	// reachable by anything holding the `TEDI_AGENT` binding and by any later
	// edge rewrite, so the DO checks the hop itself: only a trusted caller
	// stamps the service-binding marker (the edge after its own check, the
	// mesh and voice DO-to-DO calls), and the edge drops it from every
	// untrusted inbound request. Refused before any handler reads identity.
	if (targetsInternalRoute(url) && !isServiceBinding(request.headers)) {
		return Response.json(
			{ error: "Forbidden", message: "Internal route" },
			{ status: 403 },
		);
	}
	const hints = host.hintsFromHeaders(request.headers);
	if (
		url.pathname === "/get-messages" ||
		url.pathname.endsWith("/get-messages")
	) {
		if (request.method !== "GET")
			return new Response("Method Not Allowed", { status: 405 });
		await host.ensureIdentity(hints);
		// The Worker edge authenticates this same Agents route before forwarding.
		if (
			!request.headers.get("X-Tedi-Auth-Subject") ||
			request.headers.get("X-Tedi-Auth-TediId") !== host.state.tediId
		)
			return new Response("Forbidden", { status: 403 });
		const sessionKey =
			url.searchParams.get("sessionKey") ??
			url.searchParams.get("conversationId") ??
			DEFAULT_SESSION_KEY;
		const facet = await host.subAgent(
			ConversationFacet,
			sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_"),
		);
		return Response.json(await facet.historyMessages());
	}
	if (url.pathname === host.TELEGRAM_WEBHOOK_PATH) {
		if (request.method !== "POST")
			return new Response("Method Not Allowed", { status: 405 });
		await host.ensureIdentity(hints);
		const telegram = await host.nativeTelegram();
		return telegram
			? telegram.handleRequest(request)
			: new Response("Not Found", { status: 404 });
	}
	const adminAuthorized = () =>
		isAdminAuthorized({
			request,
			masterKey: (host.env as { SECRETS_MASTER_KEY?: string })
				.SECRETS_MASTER_KEY,
		});
	if (url.pathname === "/__internal/browser/takeover-status") {
		if (request.method !== "POST")
			return new Response("Method Not Allowed", { status: 405 });
		if (!(await adminAuthorized()))
			return new Response("Forbidden", { status: 403 });
		const input = z
			.object({ approvalRequestId: z.uuid() })
			.parse(await request.json());
		return Response.json(
			await host.browserTakeoverStatus(
				input.approvalRequestId,
				host.state.budgets?.browserBudgetDaily ?? 50,
			),
		);
	}
	if (url.pathname === "/__internal/browser/login-session") {
		if (request.method !== "POST")
			return new Response("Method Not Allowed", { status: 405 });
		if (!(await adminAuthorized()))
			return new Response("Forbidden", { status: 403 });
		const input = z
			.object({ action: z.enum(["status", "end"]) })
			.parse(await request.json());
		return Response.json(await host.browserLoginSession(input.action));
	}
	if (url.pathname === "/__internal/config/refresh") {
		if (request.method !== "POST")
			return new Response("Method Not Allowed", { status: 405 });
		host.runtimeConfigCache.invalidate();
		host.setState({ ...host.state, governanceLoadedAt: 0 });
		return Response.json({ ok: true });
	}
	if (url.pathname === "/__internal/cron/sync") {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		// `ensureIdentity()` normally launches a fire-and-forget reconcile on a
		// fresh DO instance. Suppress that implicit pass here so it cannot race
		// the awaited operator pass against the same schedule ids.
		const reconcileWasDone = host.cronReconcileDone;
		host.cronReconcileDone = true;
		try {
			await host.ensureIdentity(hints);
		} catch (error) {
			host.cronReconcileDone = reconcileWasDone;
			throw error;
		}
		const cronBootstrap = await host.reconcilePolicyPackCrons({
			forceUpdate: url.searchParams.get("forceUpdate") === "true",
		});
		if (!cronBootstrap.ok) host.cronReconcileDone = false;
		return Response.json({ success: cronBootstrap.ok, cronBootstrap });
	}
	if (url.pathname === "/__internal/chat/stream") {
		// GET = resume: a reconnecting EventSource re-attaches to an in-flight
		// run via `Last-Event-ID` (no message body). POST = the initiating turn.
		if (request.method === "GET") {
			await host.ensureIdentity(hints);
			return host.resumeChatStream(request, url);
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		await host.ensureIdentity(hints);
		let payload: InternalChatStreamPayload;
		try {
			payload = (await request.json()) as typeof payload;
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		// Stable runId source: the caller (Tedix OS) MUST supply a client-generated
		// id. No wall-clock fallback — a missing id is a contract error, not a
		// reason to fabricate a runId that breaks redelivery dedup.
		const clientRequestId = (payload.client_request_id ?? "").trim();
		if (!clientRequestId) {
			return Response.json(
				{ ok: false, error: "client_request_id is required" },
				{ status: 400 },
			);
		}
		const sessionKey = payload.session_key || DEFAULT_SESSION_KEY;
		return host.streamChatTurn({
			sessionKey,
			text: payload.text ?? "",
			clientRequestId,
			...internalChatStreamTrust(payload, sessionKey),
			attachments: sanitizeChatAttachments(payload.attachments),
			learningMode: payload.learning_mode,
			contextPolicy: payload.context_policy,
			toolArgumentConstraints: payload.tool_argument_constraints,
			toolNamespacePrefix: payload.tool_namespace_prefix,
			toolAllowedCallables: payload.tool_allowed_callables,
			embeddedSessionToken: payload.embedded_session_token,
			embeddedQuota: embeddedTurnQuotaFromPayload(payload.embedded_quota),
			// Only a widget turn on an embedded session may carry page tools.
			...(isEmbeddedSessionKey(sessionKey)
				? { pageTools: normalizePageToolDescriptors(payload.page_tools) }
				: {}),
			// `/__internal/*` is reachable only from this Worker's own edge, which
			// resolves a model choice against the tedi's model-catalog roster
			// before dispatching. Re-deriving that verdict here would need a
			// second API read per turn and could only disagree with the gate that
			// already ran, so this accepts the ref the edge settled on. The
			// narrow shape check stays: a ref is the only thing this may be.
			modelRefOverride:
				typeof payload.model_ref === "string" &&
				/^[a-z0-9-]+\/[\w./@-]{1,120}$/i.test(payload.model_ref)
					? payload.model_ref
					: undefined,
			reasoningEffortOverride:
				payload.reasoning_effort === "none" ||
				payload.reasoning_effort === "low" ||
				payload.reasoning_effort === "medium" ||
				payload.reasoning_effort === "high"
					? payload.reasoning_effort
					: undefined,
		});
	}
	if (url.pathname === "/__internal/page-tool/result") {
		// The browser's result for one page tool call. The edge derived the run
		// id from the posting session's own authority, so this can only settle
		// a call that conversation's turn requested.
		if (request.method !== "POST")
			return new Response("Method Not Allowed", { status: 405 });
		let body: { run_id?: unknown; call_id?: unknown; result?: unknown };
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json({ accepted: false }, { status: 400 });
		}
		if (typeof body.run_id !== "string" || !isPageToolCallId(body.call_id))
			return Response.json({ accepted: false }, { status: 400 });
		const accepted = host.pageToolBroker.resolve(
			body.run_id,
			body.call_id,
			normalizePageToolResult(body.result),
		);
		return Response.json({ accepted }, { status: accepted ? 200 : 404 });
	}
	if (url.pathname === "/__internal/chat/warm") {
		// Warm the tool schemas while the panel opens — see the module.
		return handleEmbeddedWarmRequest(request, {
			getMcpRuntime: () => host.getMcpRuntime(),
			tediRef: host.state.slug || host.state.tediId,
			defaultSessionKey: DEFAULT_SESSION_KEY,
		});
	}
	if (url.pathname === "/__internal/steer-run") {
		if (request.method !== "POST")
			return new Response("Method Not Allowed", { status: 405 });
		const parsed = RuntimeRunSteeringInputSchema.safeParse(
			await request.json().catch(() => null),
		);
		if (!parsed.success)
			return Response.json(
				{ error: "Invalid steering request" },
				{ status: 400 },
			);
		await host.ensureIdentity(hints);
		const input = parsed.data;
		const facet = await host.subAgent(
			ConversationFacet,
			input.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_"),
		);
		try {
			return Response.json({ messages: await facet.controlRunSteering(input) });
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : String(error) },
				{ status: 409 },
			);
		}
	}
	if (url.pathname === "/__internal/inject") {
		// Server-side message inject for isolate tedis — the runtime-kind-aware
		// equivalent of the container's `/api/admin/notify`. Drives ONE turn
		// through the SAME `TediSessionHarness` + ledger path the mesh/Tedix OS paths
		// use through ChatTurnWorkflow — so an operator/system
		// send produces the same per-session context + durable event chain.
		// Admission waits until the durable workflow and canonical task are
		// pollable, then acknowledges with the stable run id. A settled
		// redelivery returns the existing assistant receipt.
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		await host.ensureIdentity(hints);
		let payload: {
			session_key?: string;
			text?: string;
			message?: string;
			client_request_id?: string;
			trace_id?: string;
			message_id?: string;
			idempotency_key?: string;
			attachments?: AudioAttachment[];
			learning_mode?: AdaptiveLearningMode;
			metadata?: Record<string, unknown>;
			/**
			 * Async-supervised inject (kernel delegation). When true the DO
			 * accepts the message, dispatches ChatTurnWorkflow, and returns
			 * `202 { accepted, run_id }`
			 * immediately — the turn is NOT bound to this HTTP request, so a cold
			 * DO's first turn (MCP bind + guidance load + LLM call) is not capped
			 * by the caller's inject timeout. The full ledger chain lands under the
			 * deterministic run id when the scheduled turn runs, and Home reconciles
			 * via terminal events. Absent/false ⇒ the synchronous path below
			 * (operator/mesh inject that needs the reply inline) is UNCHANGED.
			 */
			async?: boolean;
		};
		try {
			payload = (await request.json()) as typeof payload;
		} catch {
			return Response.json(
				{ ok: false, success: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const callerTrust = callerTrustTierForRequest(request.headers);
		const noFunds = request.headers.get("X-Tedix-No-Funds") === "true";
		// Defense in depth: the gateway already strips these for non-members.
		payload = stripMemberOnlyInjectFields(payload, callerTrust);
		const text = (payload.text ?? payload.message ?? "").trim();
		if (!text) {
			return Response.json(
				{ ok: false, success: false, error: "text is required" },
				{ status: 400 },
			);
		}
		// Stable runId source: prefer the inbound message id / idempotency key
		// the caller carries; otherwise require an explicit client_request_id.
		// No Date.now() fallback — a redelivered inject with the same id must
		// dedup to the same runId.
		const clientRequestId = (
			payload.client_request_id ??
			payload.message_id ??
			payload.idempotency_key ??
			""
		).trim();
		const traceId =
			(payload.trace_id ?? request.headers.get("X-Trace-Id") ?? "").trim() ||
			undefined;
		if (!clientRequestId) {
			return Response.json(
				{
					ok: false,
					success: false,
					error:
						"client_request_id (or message_id / idempotency_key) is required",
				},
				{ status: 400 },
			);
		}
		// Async-supervised inject (kernel delegation): accept immediately and
		// dispatch to ChatTurnWorkflow (durable, eviction-surviving). Each
		// step.do() is a checkpoint — the root cause of the runtime_dropped bug
		// where DO alarm contexts die before any in-DO code executes.
		//
		// ATTACHMENT-BEARING turns (audio / image): resolveAttachmentTurn() runs
		// HERE in the inject handler (before the 202 response) to produce a text
		// transcript. STT latency (~1-3s) delays the 202 slightly — acceptable
		// for async-supervised inject which is already non-instant. The resolved
		// transcript is passed as userText into the same workflow path as text
		// turns, making attachment turns durable and cancelable.
		//
		// Resolved image payloads stay in private R2. Only compact references
		// cross Workflow and Pi persistence; the provider bridge materializes them
		// for inference without writing the bytes into durable session rows.
		if (payload.async === true) {
			const sessionKey = payload.session_key || DEFAULT_SESSION_KEY;
			const runId = buildRunId(host.state.tediId, clientRequestId, "mcp");
			return host.imageCleanupJournal().withRun(runId, async () => {
				try {
					if (await host.isWorkflowRunCanceled(runId)) {
						return Response.json(
							{
								success: true,
								accepted: false,
								canceled: true,
								run_id: runId,
								session_key: sessionKey,
							},
							{ status: 202 },
						);
					}
					// Redelivery fast-path, mirroring runDurableChatTurn: the same
					// client_request_id ⇒ the same `${runId}:2`-keyed committed row. A
					// settled turn must return in-band ("a settled turn keeps its
					// in-band shape untouched" — the mcp-bridge task contract);
					// re-dispatching instead throws instance.already_exists below and
					// turned an idempotent retry into a 500 the caller read as an
					// empty reply.
					const assistantKey = deriveIdempotencyKey(runId, "assistant");
					const settledTurn = host.sessionRepo.findTurnByIdempotencyKey(
						sessionKey,
						assistantKey,
					);
					if (settledTurn) {
						return Response.json({
							success: true,
							...(await settledChatTurnReceipt(await host.getPlatformClient(), {
								runId,
								sessionKey,
								assistant: settledTurn,
							})),
						});
					}
					const attachments =
						sanitizeChatAttachments(payload.attachments) ?? [];
					const metadata = host.unknownRecord(payload.metadata);
					let authorityMode: DelegationAuthorityMode;
					let authorityEnvelope: DelegationAuthorityEnvelope | null;
					let capabilityPlan: ReturnType<typeof capabilityPlanForMetadata>;
					try {
						authorityMode = parseDelegationAuthorityMode(
							metadata?.delegationAuthorityMode,
						);
						authorityEnvelope = parseDelegationAuthorityEnvelope(
							metadata?.delegationAuthority,
						);
						capabilityPlan = capabilityPlanForMetadata(metadata);
					} catch (error) {
						return Response.json(
							{
								ok: false,
								success: false,
								error:
									error instanceof Error
										? error.message
										: "invalid delegation authority",
							},
							{ status: 400 },
						);
					}
					if (authorityMode === "enforce" && !authorityEnvelope) {
						return Response.json(
							{
								ok: false,
								success: false,
								error:
									"earned delegation enforcement requires an authority envelope",
							},
							{ status: 403 },
						);
					}
					const workItemId =
						typeof metadata?.workItemId === "string" &&
						metadata.workItemId.trim().length > 0
							? metadata.workItemId.trim()
							: undefined;
					const homeRunId =
						typeof metadata?.homeRunId === "string" &&
						metadata.homeRunId.trim().length > 0
							? metadata.homeRunId.trim()
							: undefined;
					const parsedExecutionSurface = ExecutionSurfaceSchema.safeParse(
						metadata?.executionSurface,
					);
					const executionSurface = parsedExecutionSurface.success
						? parsedExecutionSurface.data
						: undefined;
					const repositoryMode = repositoryModeForMetadata(metadata);
					const kernelDelegationSource =
						typeof metadata?.source === "string" &&
						[
							"kernelRuntime.autoDispatch",
							"kernelRuntime.delegate",
							"kernelRuntime.respondApproval",
							"kernelRuntime.retryDelegation",
						].includes(metadata.source);
					if (kernelDelegationSource && !executionSurface) {
						return Response.json(
							{
								ok: false,
								success: false,
								error: "kernel delegation requires a valid executionSurface",
							},
							{ status: 400 },
						);
					}
					const trustedInstructionOrigin =
						trustedInstructionOriginForInject(metadata);
					const turnModel = turnModelForInject(metadata);
					// Operator-consent attestation: read from request
					// HEADERS only — the edge strips/stamps them, so payload metadata (a
					// tenant-reachable surface) can never author consent.
					const operatorConsent = parseOperatorConsent(request.headers);

					await host.acceptRuntimeTurn(runId, sessionKey, {
						kind: "inject",
						payload,
						operatorConsent,
					});
					await host.assertChatTurnActive(runId);
					// Resolve attachments (STT transcription + context notes) before
					// dispatching to the workflow. For text-only turns this is a no-op
					// pass-through. For voice/attachment turns this produces the
					// transcript that becomes userText.
					let userText = text;
					let turnImages: TurnImagePart[] = [];
					if (attachments.length > 0) {
						let resolved: { content: string; images: TurnImagePart[] };
						try {
							resolved = await host.resolveAttachmentTurn(text, attachments);
						} catch (e) {
							const error =
								e instanceof Error ? e.message : "attachment resolution failed";
							console.warn(
								"[isolate.do] async-inject attachment resolution failed",
								{ exception: exceptionTopology(error) },
							);
							return Response.json(
								{ ok: false, success: false, error },
								{ status: 500 },
							);
						}
						if (!resolved.content.trim()) {
							return Response.json(
								{ ok: false, success: false, error: "text is required" },
								{ status: 400 },
							);
						}
						userText = resolved.content;
						turnImages = resolved.images;
					}

					if (
						homeRunId &&
						workItemId &&
						Array.isArray(metadata?.originalTargetWorkItems)
					) {
						userText += `\n\nOriginal target Work context (reference data; distinct from the generated dispatch Work and its lifecycle):\n${wrapUntrustedInput(JSON.stringify(metadata.originalTargetWorkItems), "original_work_context")}`;
					}
					// Single durable path for all turns (text and attachment).
					const { tediId, slug } = host.state;
					// Cloudflare Workflow instance ids reject colons (and other
					// punctuation) — kernel client_request_ids are colon-delimited, so a
					// raw id throws `instance.invalid_id`. Derive a deterministic, valid
					// id (same input → same id keeps redelivery idempotent).
					const workflowInstanceId = buildWorkflowInstanceId(clientRequestId);
					const imageRefs = await host.prepareWorkflowImages(
						runId,
						workflowInstanceId,
						turnImages,
						sessionKey,
					);
					const conversationId = buildTediConversationId({
						tediRef: slug || tediId,
						sessionKey,
					});
					const injectUserTs = Date.now();
					const delegationBudget = homeRunId
						? delegationBudgetForMetadata(metadata, injectUserTs)
						: undefined;
					const learningMode =
						payload.learning_mode ?? adaptiveLearningModeForTurn({ userText });
					const recorded = await host.recordWorkflowDispatch(
						workflowInstanceId,
						{
							runId,
							traceId,
							workItemId,
							sessionKey,
							userText,
							userTs: injectUserTs,
						},
					);
					if (!recorded)
						throw new Error(
							`Cannot dispatch tedi run ${runId}: durable context unavailable`,
						);
					// The cancel request and this inject can interleave at any awaited
					// operation above. Re-check immediately before creating the native
					// Workflow instance; a recorded cancel owns admission.
					if (await host.isWorkflowRunCanceled(runId)) {
						await host.clearWorkflowDispatch(workflowInstanceId, "cancelled");
						return Response.json(
							{
								success: true,
								accepted: false,
								canceled: true,
								run_id: runId,
								session_key: sessionKey,
							},
							{ status: 202 },
						);
					}
					await host
						.imageCleanupJournal()
						.beforeDispatch(runId, workflowInstanceId);
					try {
						await host.dispatchAdmittedChatWorkflow(
							"CHAT_TURN_WORKFLOW",
							{
								agentName: host.name,
								sessionKey,
								userText,
								...(imageRefs?.length ? { imageRefs } : {}),
								userTs: injectUserTs,
								conversationId,
								runId,
								traceId,
								clientRequestId,
								learningMode: noFunds ? "disabled" : learningMode,
								workItemId,
								homeRunId,
								personalRequest: metadata?.personalRequest === true,
								executionSurface,
								repositoryMode,
								delegationBudget,
								authorityMode,
								capabilityPlan,
								...(authorityEnvelope ? { authorityEnvelope } : {}),
								...(operatorConsent ? { operatorConsent } : {}),
								trustedInstructionOrigin,
								callerTrust,
								noFunds,
								...(turnModel ? { turnModel } : {}),
							},
							// Agent binding can't be auto-detected from the class name in
							// this dispatch context (runWorkflow throws "Could not detect
							// Agent binding name" otherwise), so pass it explicitly — the DO
							// binding is TEDI_AGENT → AgentTediDO; the workflow calls back
							// into the DO hooks through it.
							{ id: workflowInstanceId, agentBinding: "TEDI_AGENT" },
						);
					} catch (e) {
						if (isDuplicateWorkflowInstanceError(e)) {
							// Reconcile native terminal state before reusing a dispatch context
							// that completion may have cleared during this redelivery.
							await host.reconcileChatWorkflowTerminal({
								workflowInstanceId,
								attempt: 0,
							});
							const committedTurn = host.sessionRepo.findTurnByIdempotencyKey(
								sessionKey,
								assistantKey,
							);
							if (committedTurn) {
								return Response.json({
									success: true,
									...(await settledChatTurnReceipt(
										await host.getPlatformClient(),
										{ runId, sessionKey, assistant: committedTurn },
									)),
								});
							}
							await recordQueuedChatTurn(await host.getPlatformClient(), {
								tediId,
								runId,
								conversationId,
								userTs: injectUserTs,
								sessionKey,
								traceId,
							});
							return Response.json(
								{
									success: true,
									accepted: true,
									run_id: runId,
									session_key: sessionKey,
								},
								{ status: 202 },
							);
						}
						const error =
							e instanceof Error ? e.message : "workflow dispatch failed";
						console.warn("[isolate.do] async-inject workflow dispatch failed", {
							exception: exceptionTopology(error),
						});
						throw e;
					}

					await recordQueuedChatTurn(await host.getPlatformClient(), {
						tediId,
						runId,
						conversationId,
						userTs: injectUserTs,
						sessionKey,
						traceId,
					});

					return Response.json(
						{
							success: true,
							accepted: true,
							run_id: runId,
							session_key: sessionKey,
						},
						{ status: 202 },
					);
				} catch (error) {
					return chatTurnErrorResponse(error, {
						runId,
						sessionKey,
						clientRequestId,
					});
				}
			});
		}
		try {
			const turnInput = {
				sessionKey: payload.session_key || DEFAULT_SESSION_KEY,
				text,
				clientRequestId,
				traceId,
				attachments: sanitizeChatAttachments(payload.attachments),
				learningMode: payload.learning_mode,
				callerTrust,
				noFunds,
			};
			const result = await host.runDurableChatTurn(turnInput);
			return Response.json({ success: true, ...result });
		} catch (err) {
			// Non-2xx on a caught runtime error so callers (provisioning /
			// operator tooling) can distinguish a failed turn from a successful
			// one — a 200 with {ok:false} reads as success to most HTTP clients.
			return Response.json(
				{
					ok: false,
					success: false,
					error: err instanceof Error ? err.message : String(err),
				},
				{ status: 500 },
			);
		}
	}
	if (url.pathname === "/__internal/review-capabilities") {
		if (request.method !== "GET")
			return new Response("Method Not Allowed", { status: 405 });
		await host.ensureIdentity(hints);
		return Response.json({
			ok: true,
			nativeTools: Object.keys(host.getTools(OPERATOR_COMPUTER_SCOPE)),
		});
	}
	if (url.pathname === "/__internal/cancel") {
		// Cancel a delegated CHAT_TURN_WORKFLOW instance by its clientRequestId.
		// The kernel cascade derives the workflow ID exactly like async inject. A terminal run is a
		// no-op success. Returns { success, workflowInstanceId }.
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		let cancelPayload: { client_request_id?: string; run_id?: string };
		try {
			cancelPayload = (await request.json()) as {
				client_request_id?: string;
				run_id?: string;
			};
		} catch {
			return Response.json(
				{ ok: false, success: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const cancelClientRequestId = (
			cancelPayload.client_request_id ?? ""
		).trim();
		if (!cancelClientRequestId) {
			return Response.json(
				{
					ok: false,
					success: false,
					error: "client_request_id is required",
				},
				{ status: 400 },
			);
		}
		// Derive the workflowInstanceId using the SAME logic as dispatch
		// (do.ts async-inject branch, line ~9007).
		const cancelWorkflowInstanceId = buildWorkflowInstanceId(
			cancelClientRequestId,
		);
		// #6 cancel-depth: trip the per-run abort (frees in-flight tools — #4)
		// and cascade the cancel to the fan-out subtree. The cancelled run's
		// runId keys both the abort map and the `${parentRunId}:fanout:` slot
		// ids; the caller may send it explicitly (full-depth cascade) or we
		// fall back to the mcp-surface derivation (additive: an un-updated
		// kernel caller degrades to today's one-hop terminate). All best-effort
		// — never throws into the cancel response.
		const cancelRunId =
			(cancelPayload.run_id ?? "").trim() ||
			buildRunId(host.state.tediId, cancelClientRequestId, "mcp");
		try {
			await host.recordWorkflowCancellation(cancelRunId);
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			console.warn("[isolate.do] /__internal/cancel tombstone persist failed", {
				exception: exceptionTopology(error),
			});
			return Response.json(
				{
					ok: false,
					success: false,
					workflowInstanceId: cancelWorkflowInstanceId,
					error: `cancel intent could not be persisted: ${error}`,
				},
				{ status: 500 },
			);
		}
		host.activeTurnAborts
			.get(cancelRunId)
			?.abort(new DOMException("run cancelled", "AbortError"));
		host.pageToolBroker.cancelRun(cancelRunId);
		let cascadeTerminated: string[] = [];
		try {
			cascadeTerminated = (await host.cascadeCancelFanout(cancelRunId))
				.terminated;
		} catch (e) {
			console.warn("[isolate.do] /__internal/cancel cascade failed", {
				exception: exceptionTopology(e),
			});
		}
		try {
			const result = await terminateWorkflow(
				host.env.CHAT_TURN_WORKFLOW,
				cancelWorkflowInstanceId,
			);
			// A long workflow sleep may outlive the terminal watchdog. Do not
			// depend on a later SDK callback to cancel this run's native jobs.
			const canceledContext =
				await host.ctx.storage.get<WorkflowDispatchContext>(
					`wfctx:${cancelWorkflowInstanceId}`,
				);
			if (canceledContext?.runId === cancelRunId)
				await host.clearWorkflowDispatch(cancelWorkflowInstanceId, "cancelled");
			return Response.json({
				...result,
				ok: true,
				success: true,
				workflowInstanceId: cancelWorkflowInstanceId,
				cascadeTerminated,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				"[isolate.do] /__internal/cancel workflow terminate failed:",
				msg,
			);
			return Response.json(
				{
					ok: false,
					success: false,
					workflowInstanceId: cancelWorkflowInstanceId,
					error: msg,
					cascadeTerminated,
				},
				{ status: 500 },
			);
		}
	}
	// ---- Fan-out slots read endpoint -----------------------------------------
	// GET /__internal/fanout-slots?parent_run_id=<id>&limit=<n>
	// Returns live fanoutslot records for a given parentRunId. Only slots still
	// alive in DO storage (queued/running children) are returned; terminal
	// children have had their slots cleared by clearFanoutSlot. Auth: service
	// binding OR X-Tedix-Admin-Token === SECRETS_MASTER_KEY. Flag-gated.
	if (url.pathname === "/__internal/fanout-slots") {
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (!(await adminAuthorized())) {
			return new Response(JSON.stringify({ ok: false, error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}
		const parentRunId = url.searchParams.get("parent_run_id") ?? "";
		const limitParam = Number(url.searchParams.get("limit") ?? "20");
		const limit = Math.min(Number.isFinite(limitParam) ? limitParam : 20, 50);
		try {
			const stored = await host.ctx.storage.list<Record<string, unknown>>({
				prefix: "fanoutslot:",
				limit: 100,
			});
			const slots: Array<{
				id: string;
				childRunId: string;
				ownerTediId: string;
				ownerSlug: string | null;
				ownerLabel: string;
				objective: string;
				status: string;
				dispatchedAt: string | null;
			}> = [];
			for (const [_key, record] of stored) {
				if (typeof record !== "object" || record === null) continue;
				// Slot id is `${parentRunId}:fanout:${childRunId}` — filter by prefix.
				if (parentRunId) {
					const slotId = typeof record.id === "string" ? record.id : "";
					if (!slotId.startsWith(`${parentRunId}:fanout:`)) continue;
				}
				if (slots.length >= limit) break;
				slots.push({
					id: String(record.id ?? ""),
					childRunId: String(record.childRunId ?? ""),
					ownerTediId: String(record.ownerTediId ?? ""),
					ownerSlug:
						typeof record.ownerSlug === "string" ? record.ownerSlug : null,
					ownerLabel: String(record.ownerLabel ?? ""),
					objective: String(record.objective ?? ""),
					status: String(record.status ?? "queued"),
					dispatchedAt:
						typeof record.dispatchedAt === "string"
							? record.dispatchedAt
							: null,
				});
			}
			return Response.json({ ok: true, slots });
		} catch (e) {
			console.warn("[isolate.fanout-slots] storage list failed", {
				exception: exceptionTopology(e),
			});
			return Response.json({ ok: true, slots: [], error: "storage_error" });
		}
	}
	// ---- Work-item fan-out batch endpoint ------------------------------------
	// Accepts N INDEPENDENT items and fans each out as its own CHAT_TURN_WORKFLOW
	// instance (Phase 1). Auth: X-Tedix-Admin-Token === SECRETS_MASTER_KEY OR service
	// binding — same trust model as /__internal/cm-session/* and /__admin/restart.
	// Live-prove trigger: POST /__internal/fanout-batch with:
	//   { "parent_run_id": "<runId>", "items": [
	//       { "client_request_id": "item-1", "text": "task one", "independent": true },
	//       { "client_request_id": "item-2", "text": "task two", "independent": true }
	//   ]}
	// Confirm: `cf workflows instances list CHAT_TURN_WORKFLOW` shows 2 distinct
	// concurrent instance ids; `cf workflows instances get <id>` for each.
	if (url.pathname === "/__internal/fanout-batch") {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		let batchPayload: {
			parent_run_id?: string;
			items?: Array<{
				client_request_id?: string;
				text?: string;
				independent?: boolean;
				objective?: string;
			}>;
		};
		try {
			batchPayload = (await request.json()) as typeof batchPayload;
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		await host.ensureIdentity(hints);
		const parentRunId = (batchPayload.parent_run_id ?? "").trim();
		const parentConversationId = buildTediConversationId({
			tediRef:
				host.state.slug || host.identityValue(host.state.tediId) || "unknown",
			sessionKey: DEFAULT_SESSION_KEY,
		});
		const items = batchPayload.items ?? [];
		if (!Array.isArray(items) || items.length === 0) {
			return Response.json(
				{ ok: false, error: "items array is required and must be non-empty" },
				{ status: 400 },
			);
		}
		const results: Array<{
			client_request_id: string;
			dispatched: boolean;
			childRunId?: string;
			sessionKey?: string;
			fallback?: boolean;
		}> = [];
		for (const item of items) {
			const clientRequestId = (item.client_request_id ?? "").trim();
			const userText = (item.text ?? "").trim();
			if (!clientRequestId || !userText) {
				results.push({
					client_request_id: clientRequestId || "(missing)",
					dispatched: false,
					fallback: true,
				});
				continue;
			}
			const fanoutResult = await host.dispatchIndependentWorkItem({
				clientRequestId,
				userText,
				parentRunId: parentRunId || `fanout-parent:${clientRequestId}`,
				parentConversationId,
				// Default to independent unless the caller explicitly says otherwise.
				independent: item.independent !== false,
				objective: item.objective,
			});
			results.push({
				client_request_id: clientRequestId,
				dispatched: fanoutResult.dispatched,
				childRunId: fanoutResult.childRunId,
				sessionKey: fanoutResult.sessionKey,
				fallback: !fanoutResult.dispatched,
			});
		}
		return Response.json({
			ok: true,
			fanout_enabled: true,
			results,
			live_slots: host.liveWorkItemSlots.size,
		});
	}
	// ---- Code Mode session authorization endpoints ---------------------------
	// Operator/kernel pre-authorizes a coding session (sessionKey) for `execute`.
	// Gate: X-Tedix-Admin-Token === SECRETS_MASTER_KEY OR service binding.
	// Mirrors the /__admin/restart trust model.
	if (
		url.pathname === "/__internal/cm-session/authorize" ||
		url.pathname === "/__internal/cm-session/revoke"
	) {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		let body: { sessionKey?: string; authorized_by?: string };
		try {
			body = (await request.json()) as {
				sessionKey?: string;
				authorized_by?: string;
			};
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const sessionKey = (body.sessionKey ?? "").trim();
		if (!sessionKey) {
			return Response.json(
				{ ok: false, error: "sessionKey is required" },
				{ status: 400 },
			);
		}
		const gate = new CmSessionGate(host.ctx.storage);
		const isRevoke = url.pathname === "/__internal/cm-session/revoke";
		if (isRevoke) {
			await gate.revokeSession(sessionKey);
			console.log(
				JSON.stringify({
					_cm: "session_revoked",
					sessionKey,
				}),
			);
			return Response.json({ ok: true, action: "revoked", sessionKey });
		}
		const authorizedBy = (body.authorized_by ?? "operator").trim();
		await gate.authorizeSession(sessionKey, authorizedBy);
		console.log(
			JSON.stringify({
				_cm: "session_authorized",
				sessionKey,
				authorizedBy,
			}),
		);
		return Response.json({
			ok: true,
			action: "authorized",
			sessionKey,
			authorizedBy,
		});
	}
	// ---- repo_commit approval drain endpoint ---------------------------------
	// Approval rows live in D1, but repo_commit changesets live in this tedi
	// DO's local ledger. The API approval resolver calls this route after the
	// pending->resolved latch so the DO can commit/abandon exactly once.
	if (url.pathname === "/__internal/repo-commit/drain") {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		let body: {
			approvalRequestId?: unknown;
			executionLedgerId?: unknown;
		};
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const approvalRequestId =
			typeof body.approvalRequestId === "string" &&
			body.approvalRequestId.trim().length > 0
				? body.approvalRequestId.trim()
				: undefined;
		const executionLedgerId =
			typeof body.executionLedgerId === "string" &&
			body.executionLedgerId.trim().length > 0
				? body.executionLedgerId.trim()
				: undefined;
		if (!approvalRequestId && !executionLedgerId) {
			return Response.json(
				{
					ok: false,
					error: "approvalRequestId or executionLedgerId is required",
				},
				{ status: 400 },
			);
		}
		await host.ensureIdentity(hints);
		const result = await host.repoCommitDrainTool({
			...(approvalRequestId ? { approvalRequestId } : {}),
			...(executionLedgerId ? { executionLedgerId } : {}),
		});
		return Response.json(result);
	}
	// ---- Code Mode execution replay authorization ----------------------------
	// Authorize one exact-code replay for a parked execution. The parked code
	// remains in this DO and is never run server-side from this route.
	if (url.pathname === "/__internal/cm-executions/resume") {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		let body: { execution_id?: string };
		try {
			body = (await request.json()) as { execution_id?: string };
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const executionId = (body.execution_id ?? "").trim();
		if (!executionId) {
			return Response.json(
				{ ok: false, error: "execution_id is required" },
				{ status: 400 },
			);
		}
		const execStore = new CmExecutionStore(host.getSqlRunner());
		const row = execStore.get(executionId);
		if (!row) {
			return Response.json(
				{
					ok: false,
					error: "execution_not_found",
					execution_id: executionId,
				},
				{ status: 404 },
			);
		}
		if (row.status !== "parked") {
			return Response.json({
				ok: false,
				error: "execution_not_parked",
				execution_id: executionId,
				status: row.status,
			});
		}
		// Operator force-resume: authorize one replay of the parked row's exact
		// code hash (mirrors the approval-drain's approved path). The parked code
		// is never re-run server-side.
		const sessionGate = new CmSessionGate(host.ctx.storage);
		await sessionGate.authorizeReplay({
			sessionKey: row.session_id,
			codeHash: row.code_hash,
			sourceExecutionId: row.id,
			authorizedBy: "operator",
		});
		execStore.markReplayAuthorized(executionId, "operator");
		return Response.json({
			ok: true,
			execution_id: executionId,
			session_id: row.session_id,
			code_hash: row.code_hash,
			status: "replay_authorized",
			message:
				"Exact execute replay authorized. Re-issue the same `execute` code in this session and it will run inline once.",
		});
	}
	if (url.pathname === "/__internal/mesh/inject") {
		// Cross-tedi mesh inject — THIS tedi delivers a message to a PEER tedi
		// in the same org and returns the peer's reply. Service-binding-only
		// (same trust gate as `/__internal/voice/consult`); the caller identity
		// is hydrated from the stamped `X-Tedi-*` headers, and the peer is
		// resolved + addressed DO→DO inside `meshInject`. The peer runs the
		// message through its OWN canonical loop, so it lands a first-class turn
		// (session + ledger + brain) on the receiving side.
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (!isServiceBinding(request.headers)) {
			return Response.json(
				{ ok: false, success: false, error: "Internal route" },
				{ status: 403 },
			);
		}
		await host.ensureIdentity(hints);
		let payload: {
			target?: string;
			target_slug?: string;
			session_key?: string;
			text?: string;
			message?: string;
			client_request_id?: string;
		};
		try {
			payload = (await request.json()) as typeof payload;
		} catch {
			return Response.json(
				{ ok: false, success: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const target = (payload.target ?? payload.target_slug ?? "").trim();
		if (!target) {
			return Response.json(
				{ ok: false, success: false, error: "target is required" },
				{ status: 400 },
			);
		}
		const text = (payload.text ?? payload.message ?? "").trim();
		if (!text) {
			return Response.json(
				{ ok: false, success: false, error: "text is required" },
				{ status: 400 },
			);
		}
		const clientRequestId = (payload.client_request_id ?? "").trim();
		if (!clientRequestId) {
			return Response.json(
				{
					ok: false,
					success: false,
					error: "client_request_id is required",
				},
				{ status: 400 },
			);
		}
		const result = await host.meshInject({
			target,
			sessionKey: payload.session_key || DEFAULT_SESSION_KEY,
			text,
			clientRequestId,
		});
		if (!result.ok) {
			const { status, ...rest } = result;
			return Response.json({ success: false, ...rest }, { status });
		}
		return Response.json({ success: true, ...result });
	}
	if (url.pathname === "/__internal/voice/consult") {
		// LIVE VOICE CALL consult — the sibling `VoiceCallDO`
		// (`withVoice(Agent)`, holds NO canonical state) calls this for every
		// voice turn AND for the end-of-call recap. The VoiceCallDO does NOT
		// answer locally; it CONSULTS the canonical tedi loop here so ledger,
		// brain, session, and MCP-tool semantics all apply for free — keyed on
		// the SAME conversationId the chat path uses.
		//
		//   mode "turn"  → runs `streamChatTurn` (the SAME path Tedix OS chat uses) and
		//                  returns the assistant text for streaming TTS.
		//   mode "recap" → lands a compact recap session turn via
		//                  `landVoiceRecap` (no LLM call). Mirrors the runtime's
		//                  recap-to-session.
		//
		// Service-binding-only: the VoiceCallDO reaches this through the
		// TEDI_AGENT namespace binding (X-Service-Binding: true).
		// Mirrors the `/hooks/*` internal trust gate; the edge (`index.ts`)
		// never exposes a public `/__internal/*` route.
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		if (!isServiceBinding(request.headers)) {
			return Response.json(
				{ ok: false, error: "Internal route" },
				{ status: 403 },
			);
		}
		await host.ensureIdentity(hints);
		let payload: {
			mode?: "turn" | "recap";
			session_key?: string;
			text?: string;
			recap?: string;
			client_request_id?: string;
		};
		try {
			payload = (await request.json()) as typeof payload;
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const sessionKey = payload.session_key || DEFAULT_SESSION_KEY;
		const clientRequestId = (payload.client_request_id ?? "").trim();
		if (!clientRequestId) {
			return Response.json(
				{ ok: false, error: "client_request_id is required" },
				{ status: 400 },
			);
		}
		const mode = payload.mode ?? "turn";
		try {
			if (mode === "recap") {
				const recap = (payload.recap ?? payload.text ?? "").trim();
				if (!recap) {
					return Response.json(
						{ ok: false, error: "recap is required" },
						{ status: 400 },
					);
				}
				const result = await host.landVoiceRecap({
					sessionKey,
					recap,
					clientRequestId,
				});
				return Response.json(result);
			}
			const text = (payload.text ?? "").trim();
			if (!text) {
				return Response.json(
					{ ok: false, error: "text is required" },
					{ status: 400 },
				);
			}
			// STREAM the voice turn (SDK best practice): reuse the SAME
			// `streamChatTurn` SSE path the Tedix OS composer uses — same
			// conversationId / session harness / ledger / brain / MCP tools —
			// tagged `voice`. The sibling VoiceCallDO reads this SSE and yields
			// deltas from `onTurn`, so `withVoice` sentence-chunks and synthesizes
			// TTS concurrently instead of waiting for the whole turn. Returns
			// `data: {kind:"delta"|"done"|"error"}` frames.
			return await host.streamChatTurn({
				sessionKey,
				text,
				clientRequestId,
				origin: "voice",
			});
		} catch (err) {
			return Response.json(
				{
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				},
				{ status: 500 },
			);
		}
	}
	if (url.pathname === "/__internal/messages/read") {
		return handleEmbeddedTranscriptRequest(request, {
			ensureIdentity: () => host.ensureIdentity(hints),
			readMessagesForSession: (sessionKey, limit) =>
				host.readMessagesForSession(sessionKey, limit),
			defaultSessionKey: DEFAULT_SESSION_KEY,
		});
	}
	// /__internal/inbound-email removed (P9.2) — inbound email now flows via
	// the Agents SDK `routeAgentEmail()` primitive in email-ingress.ts, which
	// invokes `Agent.onEmail()` directly through the DO namespace binding.
	if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
		await host.ensureIdentity(hints);
		const mcpComputer = await computerMcpContext(
			request,
			OPERATOR_COMPUTER_SCOPE,
		);
		const mcpWorkspace = host.computerWorkspace(mcpComputer.scope).workspace;
		const canManageDurableCode =
			request.headers.get("X-Tedix-Can-Manage-Durable-Code") === "true";
		const { handleMcp } = await import("./mcp-mount");
		return handleMcp(
			request,
			host.state.slug || host.name || "tedi",
			{
				recordMcpAuditEvent: (event) =>
					recordDirectMcpAuditEvent(
						host.env.API_SERVICE,
						host.state.orgId,
						host.state.tediId,
						event,
					),
				taskHandlers: buildDirectTediTaskHandlers({
					getPlatform: () => host.getPlatformClient(),
				}),
				runDurableCode: (input) =>
					host.runDurableCode(input, mcpComputer.scope, null),
				searchDurableCode: ({ query }) =>
					host.searchDurableCode(query, mcpComputer.scope),
				describeDurableCode: ({ target }) =>
					host.describeDurableCode(target, mcpComputer.scope),
				getCodeExecution: ({ execution_id }) =>
					host.getDurableCodeExecution(execution_id),
				listCodeExecutions: async ({ limit }) => ({
					executions: await host.listDurableCodeExecutions(
						limit ?? 20,
						mcpComputer.scope,
					),
				}),
				...(canManageDurableCode
					? {
							approveCodeExecution: scopeDurableCodeAction({
								resolve: (id) => host.computerCodeRouting.resolve(id),
								scope: mcpComputer.scope,
								action: ({ execution_id }) =>
									host.approveDurableCodeExecution(execution_id),
							}),
							rejectCodeExecution: scopeDurableCodeAction({
								resolve: (id) => host.computerCodeRouting.resolve(id),
								scope: mcpComputer.scope,
								action: ({
									execution_id,
									seq,
								}: {
									execution_id: string;
									seq: number;
								}) => host.rejectDurableCodeExecution(execution_id, seq),
							}),
							rollbackCodeExecution: scopeDurableCodeAction({
								resolve: (id) => host.computerCodeRouting.resolve(id),
								scope: mcpComputer.scope,
								action: ({ execution_id }) =>
									host.rollbackDurableCodeExecution(execution_id),
							}),
						}
					: {}),
				...(request.headers.get("X-Tedix-Auth-Can-Recover-Durable-Code") ===
				"true"
					? {
							recoverCodeExecution: createDurableCodeRecovery({
								resolve: (id) => host.computerCodeRouting.resolve(id),
								runtime: (scope) => host.getDurableCodemodeRuntime(scope),
								scope: mcpComputer.scope,
							}),
						}
					: {}),

				brainAudit: async (input) => host.brainAuditTool(input),
				conversationGet: async ({ session_key }) => {
					return host.readConversationForSession(session_key);
				},
				conversationsList: async ({ limit }) => {
					const max = Math.max(1, Math.min(limit ?? 50, 200));
					const sessionKeys = [
						...new Set([
							DEFAULT_SESSION_KEY,
							...host.sessionRepo
								.listTurns()
								.map((turn) => turn.sessionKey || DEFAULT_SESSION_KEY),
						]),
					];
					const conversations = (
						await Promise.all(
							sessionKeys.map((sessionKey) =>
								host.readConversationSummaryForSession(sessionKey),
							),
						)
					)
						.filter((conversation) => conversation.messageCount > 0)
						.sort(
							(left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
						);
					return {
						conversations: conversations.slice(0, max),
					};
				},
				messagesRead: async ({ session_key, limit }) =>
					host.readMessagesForSession(session_key, limit),
				messagesSend: async ({
					session_key,
					text,
					trace_id,
					client_request_id,
					attachments,
				}) => {
					const turnInput = {
						sessionKey: session_key,
						text,
						traceId: trace_id,
						clientRequestId: client_request_id,
						attachments: sanitizeChatAttachments(attachments),
						callerTrust: callerTrustTierForRequest(request.headers),
						noFunds: request.headers.get("X-Tedix-No-Funds") === "true",
					};
					return host.runDurableChatTurn(turnInput);
				},
				readResource: async ({ server, uri }) => {
					const mcpRuntime = await host.getMcpRuntime();
					if (!mcpRuntime) throw new Error("MCP runtime unavailable");
					return mcpRuntime.readResource(server, uri);
				},
				readDirectory: async ({ server, uri, cursor }) => {
					const mcpRuntime = await host.getMcpRuntime();
					if (!mcpRuntime) throw new Error("MCP runtime unavailable");
					return mcpRuntime.readDirectory(server, uri, cursor);
				},
				sendTediMessage: async ({
					target,
					text,
					session_key,
					client_request_id,
				}) => {
					const result = await host.meshInject({
						target,
						sessionKey: session_key || DEFAULT_SESSION_KEY,
						text,
						clientRequestId: client_request_id,
					});
					if (!result.ok) throw new Error(result.error);
					return result;
				},
				cron: async (input) => host.cronTool(input),
				repoCommit: async (input) =>
					host.repoCommitProposeTool(input, {
						turnContext: mcpComputer.turnContext,
						workspace: {
							readFile: computerRepositoryReader(
								mcpWorkspace,
								host.computerEnvironment(
									mcpComputer.scope,
									mcpComputer.turnContext,
								),
							),
						},
					}),
				repoCommitStatus: async (input) => host.repoCommitStatusTool(input),
				repoCommitDrain: async (input) => host.repoCommitDrainTool(input),
				listArtifactFiles: async (input) => host.listArtifactFilesTool(input),
				readArtifactFile: async (input) => host.readArtifactFileTool(input),
				writeArtifactFile: async (input) =>
					host.writeArtifactFileTool(input, mcpComputer.turnContext?.runId),
				computerTools: host.workstationAiTool(
					mcpComputer.scope,
					mcpComputer.turnContext,
				),
			},
			{
				LOADER: host.env.LOADER,
				codeModeExtras: async (outerServer, runtime) => {
					// Scratch state refuses access while a Linux computer is selected.
					runtime.addProvider(
						resolveProvider(
							stateTools(
								computerScratchState(
									mcpWorkspace,
									host.computerEnvironment(
										mcpComputer.scope,
										mcpComputer.turnContext,
									),
								),
							),
						),
					);

					// One-shot network-isolated execution retains the CmSessionGate:
					// session authorization or an exact-code, one-use approval grant.
					outerServer.registerTool(
						"execute",
						{
							description: [
								"Run model-supplied JavaScript in a network-isolated JavaScript sandbox (Cloudflare WorkerLoader).",
								"The sandbox has full access to `state.*` (readFile, writeFile, glob, diff, replaceInFiles, applyEdits, JSON helpers) backed by this tedi's durable DO-SQLite workspace — reads/writes are live, not a copy.",
								"No outbound fetch or network is available in the sandbox; use open_computer and exec for shell, process, or repo work. state.* is available only before opening Linux; use the selected file tools or durable Code Mode after opening it.",
								"Returns `{ executionId, result, logs? }` on success, `{ executionId, error }` on failure, or `{ requires_approval, execution_id, risk_tier, session_id }` when parked (session not pre-authorized).",
								"Runs when either the coding session is explicitly pre-authorized via POST /__internal/cm-session/authorize or a prior parked approval created a one-shot exact-code replay grant.",
							].join("\n"),
							inputSchema: z.object({
								code: z
									.string()
									.describe(
										"JavaScript async arrow function to execute, e.g. `async () => { const txt = await state.readFile({ path: '/notes.md' }); return txt; }`",
									),
							}),
						},
						async ({ code }) => {
							const newExecutionId = crypto.randomUUID();
							const sessionKey = mcpComputer.scope.key;
							const codeHash = await hashCode(code);

							const execStore = new CmExecutionStore(host.getSqlRunner());
							const sessionGate = new CmSessionGate(host.ctx.storage);

							// Self-heal the direct (/mcp callTool) path: drain here so a
							// prior parked execution whose approval card is now approved
							// authorizes THIS session in-context, letting the re-issued
							// call run inline without needing a separate chat turn.
							await host.drainPendingCodemodeExecutions().catch(() => {});

							const replayGrant = await sessionGate.consumeReplayGrant(
								sessionKey,
								codeHash,
							);
							const sessionAuthorized =
								replayGrant === null
									? await sessionGate.isSessionAuthorized(sessionKey)
									: false;
							const authorized = sessionAuthorized || replayGrant !== null;
							const executionId =
								replayGrant?.sourceExecutionId ?? newExecutionId;

							if (!authorized) {
								execStore.park({
									id: newExecutionId,
									sessionId: sessionKey,
									codeHash,
								});
								// Bridge to the kernel approval ledger: create a HIGH-risk
								// card the operator can approve from Tedix OS. On
								// approval the next-turn drain authorizes the session.
								const approvalRequestId =
									await host.proposeCodemodeExecuteApproval({
										approvalRequestId: crypto.randomUUID(),
										executionId: newExecutionId,
										sessionKey,
										codeHash,
										conversationId: buildTediConversationId({
											tediRef: host.state.slug || host.state.tediId || "tedi",
											sessionKey,
										}),
									});
								if (approvalRequestId) {
									execStore.updateApprovalId(newExecutionId, approvalRequestId);
								}
								console.log(
									JSON.stringify({
										_cm: "execute_parked",
										executionId: newExecutionId,
										sessionKey,
										risk_tier: "HIGH",
										approvalRequestId,
									}),
								);
								return {
									content: [
										{
											type: "text" as const,
											text: JSON.stringify({
												requires_approval: true,
												execution_id: newExecutionId,
												approval_request_id: approvalRequestId,
												risk_tier: "HIGH",
												session_id: sessionKey,
												message:
													"This coding session is not authorized for `execute`. A HIGH-risk approval request was created for the operator. Once approved, re-issue the same `execute` code in this session and it will run once.",
											}),
										},
									],
									structuredContent: {
										requires_approval: true,
										execution_id: newExecutionId,
										approval_request_id: approvalRequestId,
										risk_tier: "HIGH" as const,
										session_id: sessionKey,
									},
								};
							}

							// Explicit session pre-authorization gets a new ledger row.
							// Exact replay resolves the original parked row instead.
							if (!replayGrant) {
								execStore.markAuthorizedPre({
									id: executionId,
									sessionId: sessionKey,
									codeHash,
									resolvedBy: "policy",
								});
							}

							const context: CodeModeExecutionContext = {
								executionId,
								kind: "code",
							};
							console.log(
								JSON.stringify({
									_cm: "execute_start",
									executionId,
									tediId: host.state.tediId || host.state.slug,
									sessionKey,
									codeLength: code.length,
									...(replayGrant
										? { replayedExecutionId: replayGrant.sourceExecutionId }
										: {}),
								}),
							);
							try {
								const result = await runStatelessCodeMode({
									code,
									executor: runtime.executor,
									providers: runtime.createProviders(context),
								});
								console.log(
									JSON.stringify({
										_cm: "execute_end",
										executionId,
										success: !result.error,
										error: result.error?.slice(0, 200),
									}),
								);
								if (result.error) {
									execStore.resolve({
										id: executionId,
										status: "error",
										resolvedBy: replayGrant ? "operator" : "policy",
										error: result.error,
									});
									return {
										content: [
											{
												type: "text" as const,
												text: `Execution error: ${result.error}`,
											},
										],
										isError: true,
										structuredContent: {
											executionId,
											error: result.error,
										},
									};
								}
								execStore.resolve({
									id: executionId,
									status: "authorized_ran",
									resolvedBy: replayGrant ? "operator" : "policy",
									result: result.result ?? null,
								});
								const output: Record<string, unknown> = {
									executionId,
									result: shapeBoundedCodeModeResult(result.result ?? null),
								};
								if (replayGrant) {
									output.replayedApprovedExecution = true;
								}
								if (result.logs?.length)
									output.logs = boundCodeModeLogs(result.logs);
								return {
									content: [
										{
											type: "text" as const,
											text: JSON.stringify(output, null, 2),
										},
									],
									structuredContent: output,
								};
							} catch (err) {
								const message =
									err instanceof Error ? err.message : String(err);
								console.log(
									JSON.stringify({
										_cm: "execute_end",
										executionId,
										success: false,
										error: message.slice(0, 200),
									}),
								);
								execStore.resolve({
									id: executionId,
									status: "error",
									resolvedBy: replayGrant ? "operator" : "policy",
									error: message,
								});
								return {
									content: [
										{
											type: "text" as const,
											text: `Execution error: ${message}`,
										},
									],
									isError: true,
									structuredContent: {
										executionId,
										error: message,
									},
								};
							}
						},
					);
				},
				codeModeExtraInstructions: [
					"Computer files and exec share the selected environment. Call open_computer for Linux and use read_execution for long commands. The one-shot state.* provider is scratch-only and refuses access while Linux is selected; durable Code Mode uses the selected filesystem and preserves it for execution recovery.",
				],
			},
		);
	}
	if (url.pathname === "/debug/daily-log") {
		// Header-guarded ops probe: read a daily-log file straight from
		// the per-tedi CF Artifacts repo. Not on a public route — only
		// reachable via the parent Worker which already gates auth.
		if (request.headers.get("X-Tedix-Debug") !== "1") {
			return new Response("forbidden", { status: 403 });
		}
		await host.ensureIdentity(hints);
		const { tediId, slug } = host.state;
		if (!tediId) return new Response("no tediId", { status: 412 });
		const artifacts = host.env.ARTIFACTS;
		if (!artifacts)
			return new Response("no ARTIFACTS binding", { status: 412 });
		const date = url.searchParams.get("date") ?? utcDateSlug(Date.now());
		const { readFileFromExistingRepo } = await import("./artifacts-git");
		const path = `workspace/daily/${date}.md`;
		const content = await readFileFromExistingRepo(
			artifacts,
			host.env.CF_ACCOUNT_ID,
			"tedix-prod",
			tediId,
			path,
		);
		if (content == null)
			return Response.json(
				{ ok: false, path, error: "not_found" },
				{ status: 404 },
			);
		return Response.json({ ok: true, tediId, slug, path, content });
	}
	if (url.pathname === "/debug/flush-daily-log") {
		if (request.headers.get("X-Tedix-Debug") !== "1") {
			return new Response("forbidden", { status: 403 });
		}
		await host.ensureIdentity(hints);
		await host.onDailyLogFlush();
		return Response.json({
			ok: true,
			pending: (host.state.pendingDailyEntries ?? []).length,
		});
	}
	// Read only an already registered Pi facet; no create/submit/resume path.
	if (url.pathname === "/__admin/pi-recovery") {
		if (request.method !== "GET")
			return new Response("Method Not Allowed", { status: 405 });
		if (!(await adminAuthorized()))
			return new Response("Forbidden", { status: 403 });
		try {
			return Response.json(
				await inspectExistingPiFacet({
					sessionKey: url.searchParams.get("sessionKey") ?? "",
					operationId: url.searchParams.get("operationId") ?? undefined,
					has: (name) => host.dynamicAgents.has(ConversationFacet, name),
					get: (name) => host.dynamicAgents.get(ConversationFacet, name),
				}),
			);
		} catch {
			console.error("[tedi.pi.recovery] Diagnostic read unavailable");
			return Response.json(
				{ ok: false, error: "pi_recovery_unavailable" },
				{ status: 503 },
			);
		}
	}

	// ----- Admin: force a DO restart (reload newly-deployed bundle code) -----
	// A warm DO singleton keeps running the code it was instantiated with;
	// the 5-min cron keeps it warm so it never idle-evicts to pick up a new
	// deploy. `ctx.abort()` forcibly resets the DO so the NEXT request
	// re-instantiates it from the current (newly-deployed) bundle. Same gate
	// as the workflow-control admin routes (token OR service binding).
	if (url.pathname === "/__admin/restart") {
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		// Abort AFTER this response flushes (microtask) so the caller gets a
		// clean 200; the reset then drops the in-memory instance and the next
		// turn re-instantiates from the deployed bundle.
		queueMicrotask(() => {
			try {
				(host.ctx as DurableObjectState).abort("admin restart");
			} catch {
				/* abort may throw as it tears down; that's expected */
			}
		});
		return Response.json({
			ok: true,
			restarted: true,
			slug: host.state.slug,
		});
	}
	// ----- Admin: brain-digest inspector -----
	// GET /__admin/brain-digest — returns the exact string serializeBrainDigest
	// produces (what the system prompt sees) plus metadata for quality inspection.
	// Admin token (X-Tedix-Admin-Token === SECRETS_MASTER_KEY)
	// OR service-binding trust.
	if (url.pathname === "/__admin/brain-digest") {
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		await host.ensureBrainDigestLoaded();
		const digest = host.brainDigest;
		return Response.json({
			ok: true,
			slug: host.state.slug,
			digestPresent: digest != null,
			serialized: digest != null ? serializeBrainDigest(digest) : null,
			factCount: digest != null ? digest.factCount : null,
			domains: digest != null ? digest.domains : null,
		});
	}
	// GET /__admin/directives — the FULL compiled directive bodies (text,
	// strength, evidence counts, provenance hashes). Same admin gate.
	// Added per benchmark-review feedback: prior runs
	// archived only directiveCount, so directive-BODY claims rested on offline
	// corpus re-derivation instead of a committed artifact.
	if (url.pathname === "/__admin/directives") {
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		await host.ensureDirectivesLoaded();
		return Response.json({
			ok: true,
			slug: host.state.slug,
			directiveCount: host.compiledDirectives.length,
			directives: host.compiledDirectives.map((d) => ({
				strength: d.strength,
				directive: d.directive,
				category: d.category,
				evidenceCount: d.evidenceCount,
				successRate: d.successRate,
				provenanceHash: d.provenanceHash,
				compiledAt: d.compiledAt,
				lastMatchedAt: d.lastMatchedAt,
			})),
		});
	}
	// ----- Admin: resolve a delegated durable Code Mode approval -----
	if (url.pathname === "/__admin/durable-code/resolve") {
		if (!(await adminAuthorized())) {
			return Response.json(
				{ error: "Forbidden", message: "Admin endpoint" },
				{ status: 403 },
			);
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		await host.ensureIdentity(hints);
		let body: {
			decision?: "approve" | "reject";
			executionId?: string;
			seq?: number;
		};
		try {
			body = (await request.json()) as typeof body;
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const executionId = body.executionId?.trim();
		if (!executionId || !body.decision) {
			return Response.json(
				{ ok: false, error: "executionId and decision are required" },
				{ status: 400 },
			);
		}
		if (body.decision === "reject") {
			if (!Number.isInteger(body.seq) || (body.seq ?? -1) < 0) {
				return Response.json(
					{ ok: false, error: "seq is required for rejection" },
					{ status: 400 },
				);
			}
			const result = await host.rejectDurableCodeExecution(
				executionId,
				body.seq!,
			);
			return Response.json({ ok: result.ok, result });
		}

		const result = await host.approveDurableCodeExecution(executionId);
		if (result.status !== "error") return Response.json({ ok: true, result });
		const current = await host.getDurableCodeExecution(executionId);
		const currentStatus =
			current && typeof current === "object" && "status" in current
				? (current as { status?: unknown }).status
				: null;
		const alreadyResolved =
			currentStatus === "completed" ||
			currentStatus === "rejected" ||
			currentStatus === "rolled_back";
		return Response.json({
			ok: alreadyResolved,
			alreadyResolved,
			result: alreadyResolved ? current : result,
		});
	}

	// ----- Admin: workflow control (P11.3) -----
	// `/__admin/workflow-list` and `/__admin/workflow-restart` are gated by
	// a shared-secret `X-Tedix-Admin-Token` matching `env.SECRETS_MASTER_KEY`
	// OR a trusted service binding (`isServiceBinding`). The shared-secret path lets a
	// local operator shell (not a service binding) authenticate without a
	// binding hop.
	if (
		url.pathname === "/__admin/workflow-list" ||
		url.pathname === "/__admin/workflow-restart"
	) {
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		await host.ensureIdentity(hints);

		if (url.pathname === "/__admin/workflow-list") {
			const limit = Math.min(
				Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
				100,
			);
			try {
				const page = (
					host as unknown as {
						getWorkflows: (criteria: { limit?: number; status?: string }) => {
							workflows: Array<Record<string, unknown>>;
						};
					}
				).getWorkflows({ limit });
				return Response.json({ ok: true, workflows: page.workflows });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return Response.json({ ok: false, error: msg }, { status: 500 });
			}
		}

		// POST /__admin/workflow-restart  { workflowId, resetTracking? }
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		let body: { workflowId?: string; resetTracking?: boolean };
		try {
			body = (await request.json()) as {
				workflowId?: string;
				resetTracking?: boolean;
			};
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const workflowId = body.workflowId?.trim();
		if (!workflowId) {
			return Response.json(
				{ ok: false, error: "workflowId required" },
				{ status: 400 },
			);
		}
		try {
			await (
				host as unknown as {
					restartWorkflow: (
						id: string,
						opts?: { resetTracking?: boolean },
					) => Promise<void>;
				}
			).restartWorkflow(workflowId, {
				resetTracking: body.resetTracking ?? false,
			});
			return Response.json({ ok: true, workflowId });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return Response.json(
				{ ok: false, workflowId, error: msg },
				{ status: 500 },
			);
		}
	}

	// ----- Admin: background inference budget status (read-only) -----
	// `/__admin/budget-status` (GET) reports whether THIS tedi's background
	// inference lane is hard-exhausted for the current UTC accounting day. The
	// platform skill-scheduler (`apps/api` dispatchDueSkillSchedules) reads it
	// before dispatching a scheduled cognitive skill so it can suppress fires
	// that would only be rejected at provider admission — closing the wasteful
	// scheduler-retry loop that lived OUTSIDE the DO `onCronFire` budget gate
	// (the cognitive crons dispatch as platform skill-schedules, not DO alarms).
	// PURE READ: unlike `cronBudgetSuppression()` it never writes the suppression
	// marker, so a probe cannot mutate scheduling state. Shares the EXACT
	// operator-only `/__admin/*` guard (service-binding trust shape OR master
	// key) every sibling route uses; the edge forwards `/__admin/*` unchanged.
	if (url.pathname === "/__admin/budget-status") {
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		if (request.method !== "GET") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		await host.ensureIdentity(hints);
		const requestedClass =
			url.searchParams.get("admissionClass") === "governed_learning"
				? "governed_learning"
				: "background";
		const usage = host
			.getInferenceBudgetStore()
			.status(host.inferenceBudgetLimits(), new Date(), requestedClass);
		return Response.json({
			ok: true,
			tediId: host.state.tediId ?? null,
			slug: host.state.slug || host.name || null,
			day: usage.day,
			admissionClass: requestedClass,
			exhausted: isAdmissionBudgetExhausted(usage),
			backgroundExhausted: isBackgroundBudgetHardExhausted(usage),
			resetAtMs: nextUtcDayStartMs(Date.now()),
			resetAt: new Date(nextUtcDayStartMs(Date.now())).toISOString(),
			reason: isAdmissionBudgetExhausted(usage)
				? `${requestedClass} inference budget exhausted for ${usage.day}`
				: null,
			usage: {
				usedTokens: usage.usedTokens,
				usedMessages: usage.usedMessages,
				backgroundTokenLimit: usage.backgroundTokenLimit,
				backgroundMessageLimit: usage.backgroundMessageLimit,
				governedLearningTokenLimit: usage.governedLearningTokenLimit,
				governedLearningMessageLimit: usage.governedLearningMessageLimit,
				admissionTokenLimit: usage.admissionTokenLimit,
				admissionMessageLimit: usage.admissionMessageLimit,
				remainingTokens: usage.remainingTokens,
				remainingMessages: usage.remainingMessages,
			},
		});
	}

	// ----- Admin: FORCE compaction (proof hook) -----
	// `/__admin/force-compact` (POST) forces a compaction pass on a session
	// REGARDLESS of the keep-recent-token budget, so the observability proof
	// does not require a 20k-token conversation to cross the default threshold.
	// It runs `compactSession` with `keepRecentTokens: 0` (always cuts) through
	// the SAME `runCompaction` seam the queue uses — so the canonical
	// `context.compacted` ledger event is emitted identically. Shares the EXACT
	// operator-only guard (`X-Tedix-Admin-Token` == `SECRETS_MASTER_KEY` OR the
	// service-binding trust shape) used by every other `/__admin/*` route, so it
	// is NOT publicly reachable. The edge (`index.ts`) forwards all `/__admin/*`
	// through unchanged; the gate lives here so the secret never crosses the
	// Worker bundle boundary.
	if (url.pathname === "/__admin/force-compact") {
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		await host.ensureIdentity(hints);

		let rawBody: unknown = {};
		try {
			const text = await request.text();
			rawBody = text.trim().length > 0 ? JSON.parse(text) : {};
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const body = (rawBody ?? {}) as {
			sessionKey?: unknown;
			keepRecentTokens?: unknown;
		};
		const sessionKey =
			typeof body.sessionKey === "string" && body.sessionKey.trim().length > 0
				? body.sessionKey
				: DEFAULT_SESSION_KEY;
		// Default 0 ⇒ always cut (force). An operator may pass a real budget to
		// test the threshold path instead.
		const keepRecentTokens =
			typeof body.keepRecentTokens === "number" &&
			Number.isFinite(body.keepRecentTokens) &&
			body.keepRecentTokens >= 0
				? body.keepRecentTokens
				: 0;

		let result: CompactionResult | null = null;
		let compactError: string | undefined;
		try {
			const operationId = await host.prepareCompaction(sessionKey, {
				keepRecentTokens,
			});
			result = await host.runCompaction(sessionKey, undefined, operationId);
		} catch (err) {
			compactError = err instanceof Error ? err.message : String(err);
		}
		return Response.json({
			ok: compactError === undefined,
			slug: host.state.slug || host.name || null,
			tediId: host.state.tediId ?? null,
			conversationId: buildTediConversationId({
				tediRef: host.state.slug || host.state.tediId,
				sessionKey,
			}),
			sessionKey,
			keepRecentTokens,
			compacted: result?.compacted ?? false,
			...(result?.compacted
				? {
						summaryChars: result.summaryChars,
						tokensBefore: result.tokensBefore,
						firstKeptEntryId: result.firstKeptEntryId,
						markerTs: result.markerTs,
					}
				: {}),
			...(compactError ? { error: compactError } : {}),
		});
	}
	if (
		url.pathname === "/__admin/agent-diag" ||
		url.pathname === "/__admin/schedules" ||
		url.pathname === "/__admin/dequeue" ||
		url.pathname === "/__admin/agent-memory/inspect" ||
		url.pathname === "/__admin/agent-memory/delete-profile"
	) {
		if (!(await adminAuthorized())) {
			return new Response(
				JSON.stringify({ error: "Forbidden", message: "Admin endpoint" }),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			);
		}
		await host.ensureIdentity(hints);
		if (url.pathname === "/__admin/agent-memory/inspect") {
			return handleAgentMemoryProjectionInspect(request, () =>
				host.agentMemoryProfile(),
			);
		}
		if (url.pathname === "/__admin/agent-memory/delete-profile") {
			return handleAgentMemoryProfileDelete(
				request,
				host.env.AGENT_MEMORY,
				host.state.orgId!,
				host.state.tediId!,
			);
		}
		// GET /__admin/schedules — read-only list of EVERY Agents-SDK scheduler
		// row on this DO (`cf_agents_schedules`): operator/tedi cron jobs
		// (`onCronFire`) plus framework maintenance schedules, each with its
		// payload message and next fire time. Consumed by the org-scoped
		// `tedis.listSchedules` read in apps/api (dashboard Schedule tab).
		if (url.pathname === "/__admin/schedules") {
			if (request.method !== "GET") {
				return new Response("Method Not Allowed", { status: 405 });
			}
			let schedules: AdminScheduleSnapshot[] = [];
			let scheduleError: string | undefined;
			try {
				schedules = (await host.listSchedules()).map(scheduleToAdminSchedule);
			} catch (err) {
				scheduleError = err instanceof Error ? err.message : String(err);
			}
			return Response.json({
				ok: true,
				tediId: host.state.tediId ?? null,
				slug: host.state.slug || host.name || null,
				schedules,
				...(scheduleError ? { error: scheduleError } : {}),
			});
		}

		// GET /__admin/agent-diag — read-only snapshot.
		if (url.pathname === "/__admin/agent-diag") {
			const runIds = url.searchParams.getAll("runId");
			if (runIds.length > 0) {
				if (request.method !== "GET")
					return new Response("Method Not Allowed", { status: 405 });
				// Exact-run diagnostic only. Do not offer a broad outbox inventory or
				// return payloads, event IDs, or delivery errors containing secrets.
				if (
					runIds.length !== 1 ||
					!runIds[0] ||
					runIds[0].length > 512 ||
					runIds[0] !== runIds[0].trim()
				)
					return Response.json({ error: "Invalid runId" }, { status: 400 });
				try {
					return Response.json({
						ok: true,
						outbox: await host.eventOutbox.inspectRun(runIds[0]),
					});
				} catch {
					return Response.json(
						{ error: "Outbox diagnostic unavailable" },
						{ status: 503 },
					);
				}
			}
			// Queue depth + recent queued callback names, read straight from the
			// SDK-owned Lifecycle job queue (no public count API exists). Since
			// agents 0.24.0 a queue item is a `cf_agents_jobs` row owned by the
			// "queue" capability, whose `fn` is the callback name.
			let queue: ReturnType<typeof summarizeQueue> = {
				depth: 0,
				recent: [],
			};
			let queueError: string | undefined;
			try {
				const rows = host.getSqlRunner().sql`
						SELECT id, fn AS callback, created_at
						FROM cf_agents_jobs WHERE capability = 'queue'
					` as unknown as QueueRow[];
				queue = summarizeQueue(rows);
			} catch (err) {
				queueError = err instanceof Error ? err.message : String(err);
			}

			// Scheduled tasks use the asynchronous public SDK API, which also
			// supports routed facets. Report read errors in the diagnostic response.
			let schedules: Array<{ id: string; callback: string; type: string }> = [];
			let scheduleError: string | undefined;
			try {
				const list = await host.listSchedules();
				schedules = list.map((s) => ({
					id: s.id,
					callback: s.callback,
					type: s.type,
				}));
			} catch (err) {
				scheduleError = err instanceof Error ? err.message : String(err);
			}

			// Crystallization buffer row count — reuse the store (its reader
			// ensures the table exists, so this is safe on a fresh DO).
			let crystallizationBufferRows = 0;
			let crystallizationError: string | undefined;
			try {
				crystallizationBufferRows = host
					.getCrystallizationStore()
					.loadBufferedObservations().length;
			} catch (err) {
				crystallizationError = err instanceof Error ? err.message : String(err);
			}

			// T1.4: surface the CURRENT active run's attempt marker (if any) so a
			// liveness reader (getTediRuntimeStatus → livenessVerdict) can tell a
			// healthy long synthesis from a frozen DO. agent-diag has no runId
			// param, so we expose the marker for `this.activeTurnBinding?.runId`.
			let attempt: unknown = null;
			const activeRunId = host.activeTurnBinding?.runId ?? null;
			if (activeRunId) {
				attempt =
					(await host.ctx.storage
						.get(`run:attempt:${activeRunId}`)
						.catch(() => null)) ?? null;
			}

			await host.ensureDirectivesLoaded();
			const memory = await memoryDiagnostics(host);
			return Response.json({
				ok: true,
				memory,
				slug: host.state.slug || host.name || null,
				tediId: host.state.tediId ?? null,
				attempt,
				queue: {
					depth: queue.depth,
					recent: queue.recent,
					...(queueError ? { error: queueError } : {}),
				},
				schedules: {
					count: schedules.length,
					items: schedules,
					...(scheduleError ? { error: scheduleError } : {}),
				},
				state: {
					recentTurns: host.sessionRepo.listTurns().length,
					crystallizationBufferRows,
					...(crystallizationError ? { crystallizationError } : {}),
					compiledDirectives: host.compiledDirectives.length,
					pendingDailyEntries: memory.pendingDailyEntries,
					directivesLoaded: host.directivesLoaded,
					identityLoaded: host.state.identityLoaded,
				},
				artifacts: host.state.identityDiagnostics ?? null,
				primitives: {
					computerWorkspace: {
						configured: true,
						backend: "do-sqlite",
						bash: true,
						nativeGit: true,
						r2IdentityMount: Boolean(host.env.TEDI_STORAGE),
					},
					artifactsRepo: {
						configured: Boolean(host.env.ARTIFACTS && host.env.CF_ACCOUNT_ID),
						namespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
						repoName: host.state.tediId ?? null,
					},
					objectStore: {
						configured: Boolean(host.env.TEDI_STORAGE),
						prefix: host.state.tediId
							? `${host.state.tediId}/${OBJECT_STORE_PREFIX}`
							: null,
					},
					agentMemory: {
						configured: true,
						profile:
							host.state.orgId && host.state.tediId
								? agentMemoryProfileName(host.state.orgId, host.state.tediId)
								: null,
					},
					r2Sql: {
						configured: Boolean(
							host.r2SqlEnv().accountId &&
							host.r2SqlEnv().warehouse &&
							host.r2SqlEnv().token,
						),
						warehouse: host.r2SqlEnv().warehouse ?? null,
						table: host.r2SqlEnv().table,
					},
				},
			});
		}

		// POST /__admin/dequeue — drain the (poison) reflection queue.
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		let rawBody: unknown = {};
		try {
			const text = await request.text();
			rawBody = text.trim().length > 0 ? JSON.parse(text) : {};
		} catch {
			return Response.json(
				{ ok: false, error: "invalid_json" },
				{ status: 400 },
			);
		}
		const parsed = parseDequeueBody(rawBody);
		if (!parsed.ok) {
			return Response.json({ ok: false, error: parsed.error }, { status: 400 });
		}
		const { callback, cancelSchedules } = parsed.value;

		// agents >= 0.24.0 moved queue items into the Lifecycle job queue and
		// dropped `cf_agents_queues`; a queue item is a `cf_agents_jobs` row
		// owned by the "queue" capability.
		const queueDepth = (): number => {
			try {
				const rows = host.getSqlRunner().sql`
						SELECT id FROM cf_agents_jobs WHERE capability = 'queue'
					` as unknown as Array<{ id: string }>;
				return rows.length;
			} catch {
				return -1;
			}
		};
		const before = queueDepth();

		// Optionally cancel all current schedules first (so a poison job's
		// re-scheduler can't immediately re-enqueue it).
		const canceledScheduleIds: string[] = [];
		let scheduleCancelError: string | undefined;
		if (cancelSchedules) {
			try {
				const list = await host.listSchedules();
				for (const s of list) {
					try {
						const ok = await host.cancelSchedule(s.id);
						if (ok) canceledScheduleIds.push(s.id);
					} catch {
						/* fail-soft per schedule */
					}
				}
			} catch (err) {
				scheduleCancelError = err instanceof Error ? err.message : String(err);
			}
		}

		// Drain the queue. Since agents 0.24.0 `dequeueAll()` /
		// `dequeueAllByCallback()` are asynchronous and return how many items
		// they removed from the Lifecycle job queue.
		let dequeueError: string | undefined;
		let dequeued: number | undefined;
		try {
			dequeued = callback
				? await host.dequeueAllByCallback(callback)
				: await host.dequeueAll();
		} catch (err) {
			dequeueError = err instanceof Error ? err.message : String(err);
		}

		const after = queueDepth();
		return Response.json({
			ok: dequeueError === undefined,
			mode: callback ? "by-callback" : "all",
			...(callback ? { callback } : {}),
			clearedQueueDepthBefore: before,
			queueDepthAfter: after,
			...(dequeued === undefined ? {} : { dequeued }),
			canceledScheduleIds,
			...(scheduleCancelError ? { scheduleCancelError } : {}),
			...(dequeueError ? { error: dequeueError } : {}),
		});
	}

	if (url.pathname === "/health") {
		return Response.json({
			status: "ok",
			service: "tedi-runtime-do",
			slug: host.state.slug || host.name || null,
			recentTurnCount: host.sessionRepo.listTurns().length,
		});
	}
	return new Response("Not Found", { status: 404 });
}
