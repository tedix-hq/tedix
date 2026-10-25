import { operatorRecordTools } from "./operator-record-tools";
import { hasOperatorRecordPlan } from "@tedix/api-contract/schemas/operator-records";
import { requireUnrestrictedModelEgress } from "./unrouted-model-egress";
import { type ExecutionSurface } from "@tedix/api-contract/schemas/execution-evidence";
import { configuredRuntimeTools } from "./configured-tool-surface";
import type { DelegationAuthorityEnvelope } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	buildDanglingTurnAnalyticsDataPoint,
	buildFacetTurnAnalyticsDataPoint,
	type FacetTurnAnalyticsDataPointEvent,
	hashAnalyticsLabel,
} from "@tedix/api-contract/schemas/mcp-analytics";
import {
	buildTediConversationId,
	isBlindVerificationSession,
	isWorkflowSynthesisSession,
} from "@tedix/api-contract/utils/runtime-identity";
import { type CallerTrustTier } from "@tedix/mcp-shared/auth/caller-trust";
import {
	selectSessionContext,
	type TediSessionModelIdentity,
} from "@tedix/tedi-session/session-harness";
import { deriveIdempotencyKey } from "@tedix/tedi-session/session-repo";
import {
	type AudioAttachment,
	resolveVoiceMessageContent,
	type TurnImagePart,
	type VoiceSttEnv,
} from "@tedix/voice/stt";
import type { SessionMessage } from "agents/sessions";
import { type ToolSet } from "ai";
import {
	type AdaptiveLearningMode,
	adaptiveLearningModeForTurn,
} from "./adaptive-learning";
import { tedixMcpAITools } from "./ai-sdk-adapter";
import type { RecentTurn } from "./bridge-turn-input";
import { isVisionCapableChatDeployment } from "./chat-attachments";
import type { ChatTurnParams } from "./chat-turn-input";
import {
	AcquisitionDeadline,
	computerAcquisitionKey,
	originalAcquisitionAuthority,
	reconcileComputerAcquisition,
} from "./computer-acquisition";
import {
	computerEffectKey,
	reconcileComputerEffect,
} from "./computer-environment";
import {
	canWaitWithoutAssistant,
	type ComputerContinuationReadDeps,
	ComputerWorkflowContinuation,
	type ComputerWorkflowSegmentResult,
	hasPendingComputerExecutions,
	observeComputerWorkflowProgress,
} from "./computer-workflow-continuation";
import { computerWorkspaceScope } from "./computer-workspace-scope";
import {
	ConversationFacet,
	type FacetBudgetStopReason,
} from "./conversation-facet";
import { cronFacetToolSurface } from "./cron-tool-surface";
import {
	cronTurnMaxSteps,
	facetToolResultIndicatesFailure,
	facetTurnFailureReason,
} from "./cron-turn-outcome";
import {
	type FacetWorkflowTurnInput,
	type FacetWorkflowTurnResult,
	observeDelegatedWorkLeaseWorkflow,
	renewDelegatedWorkLease,
	scheduleDelegatedWorkLeaseRenewal,
	validateDelegatedWorkLeaseWorkflow,
	withDelegatedWorkLease,
} from "./delegated-work-lease";
import {
	computerToolsForDelegatedTurn,
	delegatedTurnAuthority,
	type DelegationAuthorityMode,
	evaluateDelegatedFacetTool,
	restrictDelegatedToolSet,
	supervisedDelegationToolSet,
} from "./delegation-authority";
import { emitDelegationAuthorityRuntimeEvent } from "./delegation-authority-telemetry";
import { capabilityToolSet } from "./delegation-capabilities";
import {
	preflightDelegationTools,
	assertNativeResearchCheckout,
} from "./delegation-preflight";
import { runWithDelegationDeadline } from "./delegation-budget";
import type { DelegationCapabilityPlan } from "@tedix/api-contract/schemas/kernel-runtime";
import type { AgentTediDO } from "./do";
import type { ActiveTurnBinding } from "./runtime-state";
import { type DurableCodePause } from "./durable-codemode-lifecycle";
import {
	findDanglingUserTurnAgeMs,
	isDuplicateWorkflowInstanceError,
	recordQueuedChatTurn,
	settledChatTurnReceipt,
} from "./durable-messages-send";
import { supportsReasoningNone } from "./facet-generation-settings";
import {
	type FacetHistoryInput,
	hydrateFacetHistory,
} from "./facet-history-context";
import {
	type FacetStreamFrame,
	parseFacetStreamFrames,
} from "./facet-stream-frames";
import { describeFacetTools } from "./facet-tool-descriptors";
import {
	awaitRebuiltFacetRegistry,
	FACET_REGISTRY_REBUILD_WAIT_MS,
} from "./facet-registry-rebuild";
import {
	facetTurnBudgetClass,
	inferenceBudgetAdmissionClass,
	inferenceSource,
} from "./inference-guardrails";
import { JudgeSessionFacet } from "./judge-session-facet";
import {
	buildRunId,
	buildWorkflowInstanceId,
	parseRunSurface,
} from "./ledger-mirror";
import { mcpTurnSurfaceTrust } from "./mcp-caller-trust";
import { generationForSurface, type ModelPolicySurface } from "./model-policy";
import { NO_FUNDS_TURN_MESSAGE, noFundsTurnTools } from "./no-funds-turn";
import { digestObserverToolResult } from "./observer-execution-evidence";
import {
	type OperatorConsentAttestation,
	renderOperatorConsentBlock,
} from "./operator-consent";
import { cacheOrderedSystemPrompt } from "./prompt-cache";
import {
	logTediFacetBudgetStop,
	logTediRuntimeFailure,
	runtimeFailureType,
} from "./runtime-failure-log";
import { markFacetToolDispatch } from "./runtime-latency-markers";
import {
	type RepositoryMode,
	PERSONAL_REQUEST_READ_GUIDANCE,
	selectRepositoryToolSurface,
	settledDelegatedReply,
	workspaceToolGuidance,
} from "./runtime-tool-guidance";
import { facetToolCallOutcomes, type FacetTurnUsage } from "./step-telemetry";
import { SynthesisSessionFacet } from "./synthesis-session-facet";
import {
	selectTrustedTurnTools,
	type SurfaceTrust,
	trustedTurnMemoryEffects,
	untrustedTurnSystemAddendum,
	untrustedTurnToolAllowlist,
} from "./turn-trust";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import { createWebSearchAiTools } from "./web-search-tool";
import { withTimeout } from "./with-timeout";
import { createWorkApprovalAiTools as workAiTools } from "./work-approval-tools";
import { delegatedWorkTools } from "./delegated-work-tools";
import {
	RuntimeAdmissionDO,
	readStoredRuntimeAdmission,
} from "./runtime-admission-do";
import {
	type WorkflowImageRef,
	workflowImageUri,
} from "./workflow-image-handoff";
import { captureWorkstationTurnContext } from "./workstation-turn-context";
/**
 * Char cap for hydrating a pre-cutover judge conversation's parent-side
 * history into the facet's first turn. Judge
 * conversations are usually fresh; this only bounds the rare legacy carryover.
 */
const JUDGE_FACET_HYDRATION_CHAR_CAP = 4_000;

export function identityValue(
	value: string | null | undefined,
): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Cold-start guard: bound a TRUE hang in the initial MCP sync in
 * {@link AgentTediDO.getMcpRuntime}. `ensureSynced()`'s own legs are already
 * bounded — the credential fetches by `AbortSignal` (mcp-client-runtime.ts), the
 * Descope exchange by the sibling guard in platform-client-factory.ts, and each
 * per-server connect by the core's 25s `DEFAULT_CONNECT_TIMEOUT_MS`. This outer
 * timeout only catches a leg none of those cover (e.g. a wedged `loadTediSecrets`
 * storage read), converting the hang into the SAME fail-soft path as a thrown
 * sync error: cache the runtime un-synced so the turn proceeds (tool access
 * re-syncs) instead of wedging. It MUST sit ABOVE the 25s per-server connect
 * ceiling so a slow-but-healthy cold connect is not prematurely stranded
 * tool-less, and below the 60s `prepare-context` catch-all so this gentler
 * fail-soft fires first.
 */
export const COLD_MCP_SYNC_TIMEOUT_MS = 250;

/**
 * Per-turn provider-call discipline for interactive/delegated turns.
 * Cron turns learn their four-call budget from the
 * cron message body; operator/delegated turns previously learned about the
 * effective provider-round budget only by exhausting it (`budgetStopCondition`
 * appends the "[Turn stopped early: ...]" notice after the fact). Teaching the
 * bounded budget + batching up front is what made cron cycles viable; this
 * applies the same move to every other turn path. Appended per-turn beside
 * WORKSPACE_TOOLS_NOTE so warm DOs pick it up without an
 * AGENT_PROMPT_VERSION recompose.
 */
export const CODE_MODE_BATCHING_NOTE =
	"Provider-call budget: the active runtime and plan policy set the permitted provider rounds for each turn, and the runtime reserves the final permitted round for a tool-free answer. Treat the budget as finite. Each Code Mode execution costs ONE round no matter how many tool calls it composes inside. Batch aggressively: put any needed discovery, all dependent namespace.tool(args) calls, filtering, and readbacks into ONE async Code Mode program instead of one program per tool call. Reuse schemas already present in this conversation instead of rediscovering them. Return only the IDs, concise facts, completionEvidence, and readback needed for your answer; do not return full discovery catalogs or raw bulk payloads.";

/**
 * Char cap for hydrating a pre-cutover MCP/mesh conversation's parent-side
 * history into its ConversationFacet's first turn.
 * Wider than the judge cap: mesh conversations legitimately carry context.
 */
const CONVERSATION_FACET_HYDRATION_CHAR_CAP = 12_000;

export function unknownRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Effective ceiling for a wake turn: the smaller of the governed ceiling and
 * {@link WAKE_TURN_MAX_STEPS}, so a policy that already stamps something
 * tighter is never RAISED (same contract as {@link cronTurnMaxSteps}). An
 * ungoverned (`null`) ceiling still gets the wake cap: the single durable
 * Workflow step must stay inside Cloudflare's 10-minute wall clock.
 */
function wakeTurnMaxSteps(policyMaxSteps: number | null): number {
	return Math.min(policyMaxSteps ?? WAKE_TURN_MAX_STEPS, WAKE_TURN_MAX_STEPS);
}

/**
 * Step ceiling for an assignment-wake turn — the durable turn a tedi runs when
 * the board hands it an assigned Work Item.
 *
 * A wake arrives with `trustedInstructionOrigin: "cron"` purely to select the
 * background budget lane, which used to also buy it the maintenance cycle's
 * 4-round cap ({@link CRON_TURN_MAX_STEPS}). Four rounds minus the reserved
 * tool-free final round leaves three for claim + read + edit + validate +
 * settle, so settlement was structurally the first thing sacrificed. This
 * ceiling is deliberately between the two: enough rounds to do a unit of work
 * and still call `work_item_release`, while keeping the single durable
 * Workflow step well inside Cloudflare's 10-minute wall clock (the failure
 * that motivated the cron cap in the first place).
 */
const WAKE_TURN_MAX_STEPS = 12;

/**
 * Minimal event frame helper. Used only
 * by the `ChatTurnWorkflow` callback path (`runFacetWorkflowTurn`,
 * `commitAssistantTurn`,
 * `onWorkflowError`) which still broadcasts streaming deltas + errors to any
 * connected WS clients. Native ACP turns emit the Agents UI stream separately.
 */
export function workflowEvent(
	name: string,
	payload: unknown,
	seq?: number,
): { type: "event"; event: string; payload: unknown; seq?: number } {
	const frame: {
		type: "event";
		event: string;
		payload: unknown;
		seq?: number;
	} = { type: "event", event: name, payload };
	if (seq !== undefined) frame.seq = seq;
	return frame;
}
export interface RuntimeFacetTurnsHost {
	env: AgentTediDO["env"];
	state: AgentTediDO["state"];
	acceptRuntimeTurn: AgentTediDO["acceptRuntimeTurn"];
	subAgent: AgentTediDO["subAgent"];
	admitInferenceTurn: AgentTediDO["admitInferenceTurn"];
	tediAigMetadata: AgentTediDO["tediAigMetadata"];
	sessionHarness: AgentTediDO["sessionHarness"];
	emitFacetTurnDatapoint: AgentTediDO["emitFacetTurnDatapoint"];
	modelOverrideForTurn: AgentTediDO["modelOverrideForTurn"];
	settleCumulativeInferenceTokens: AgentTediDO["settleCumulativeInferenceTokens"];
	assertChatTurnActive: AgentTediDO["assertChatTurnActive"];
	facetDispatchJournal: AgentTediDO["facetDispatchJournal"];
	ctx: AgentTediDO["ctx"];
	getPlatformClient: AgentTediDO["getPlatformClient"];
	readWorkstationJobTool: AgentTediDO["readWorkstationJobTool"];
	bufferFacetToolCall: AgentTediDO["bufferFacetToolCall"];
	activeFacetTurnTools: AgentTediDO["activeFacetTurnTools"];
	activeFacetTurnAuthorities: AgentTediDO["activeFacetTurnAuthorities"];
	eventOutbox: AgentTediDO["eventOutbox"];
	activeFacetTurnConversations: AgentTediDO["activeFacetTurnConversations"];
	nativeToolLedger: AgentTediDO["nativeToolLedger"];
	completeFacetToolCall: AgentTediDO["completeFacetToolCall"];
	cronAiTool: AgentTediDO["cronAiTool"];
	publishRuntimeObservation: AgentTediDO["publishRuntimeObservation"];
	computerWorkspace: AgentTediDO["computerWorkspace"];
	getMcpRuntime: AgentTediDO["getMcpRuntime"];
	workspaceAiTools: AgentTediDO["workspaceAiTools"];
	browserAiTools: AgentTediDO["browserAiTools"];
	skillReadTool: AgentTediDO["skillReadTool"];
	durableCodemodeAiTools: AgentTediDO["durableCodemodeAiTools"];
	workstationAiTool: AgentTediDO["workstationAiTool"];
	objectStoreAiTools: AgentTediDO["objectStoreAiTools"];
	r2SqlAiTool: AgentTediDO["r2SqlAiTool"];
	cognitiveAddenda: AgentTediDO["cognitiveAddenda"];
	modelOverrideForSurface: AgentTediDO["modelOverrideForSurface"];
	observerDeploymentForTurn: AgentTediDO["observerDeploymentForTurn"];
	runtimeConfigCache: AgentTediDO["runtimeConfigCache"];
	hydrateFirstFacetTurnText: AgentTediDO["hydrateFirstFacetTurnText"];
	actionReceiptJournal: AgentTediDO["actionReceiptJournal"];
	prepareNativeConversationImages: AgentTediDO["prepareNativeConversationImages"];
	sessionRepo: AgentTediDO["sessionRepo"];
	ensureIdentity: AgentTediDO["ensureIdentity"];
	logDanglingTurnIfAny: AgentTediDO["logDanglingTurnIfAny"];
	imageCleanupJournal: AgentTediDO["imageCleanupJournal"];
	isWorkflowRunCanceled: AgentTediDO["isWorkflowRunCanceled"];
	resolveAttachmentTurn: AgentTediDO["resolveAttachmentTurn"];
	prepareWorkflowImages: AgentTediDO["prepareWorkflowImages"];
	recordWorkflowDispatch: AgentTediDO["recordWorkflowDispatch"];
	clearWorkflowDispatch: AgentTediDO["clearWorkflowDispatch"];
	dispatchAdmittedChatWorkflow: AgentTediDO["dispatchAdmittedChatWorkflow"];
	name: AgentTediDO["name"];
	reconcileChatWorkflowTerminal: AgentTediDO["reconcileChatWorkflowTerminal"];
	dispatchTurnMemoryEffects: AgentTediDO["dispatchTurnMemoryEffects"];
	queue: AgentTediDO["queue"];
	enqueueCompaction: AgentTediDO["enqueueCompaction"];
	facetWorkflowTurns: AgentTediDO["facetWorkflowTurns"];
	facetTurnAdmission: AgentTediDO["facetTurnAdmission"];
	keepAliveWhile: AgentTediDO["keepAliveWhile"];
	armDelegatedWorkLeaseRenewal: AgentTediDO["armDelegatedWorkLeaseRenewal"];
	facetComputerReadDeps: AgentTediDO["facetComputerReadDeps"];
	commitFacetWorkflowSegment: AgentTediDO["commitFacetWorkflowSegment"];
	runFacetWorkflowTurnImpl: AgentTediDO["runFacetWorkflowTurnImpl"];
	scheduleEvery: AgentTediDO["scheduleEvery"];
	recordWorkflowCancellation: AgentTediDO["recordWorkflowCancellation"];
	cancelSchedule: AgentTediDO["cancelSchedule"];
	computerEnvironment: AgentTediDO["computerEnvironment"];
	stepEventSequence: AgentTediDO["stepEventSequence"];
	commitAssistantTurn: AgentTediDO["commitAssistantTurn"];
	ensureModelPolicy: AgentTediDO["ensureModelPolicy"];
	runJudgeFacetTurn: AgentTediDO["runJudgeFacetTurn"];
	runSynthesisFacetTurn: AgentTediDO["runSynthesisFacetTurn"];
	prepareMcpFacetTurn: AgentTediDO["prepareMcpFacetTurn"];
	activeTurnBinding: AgentTediDO["activeTurnBinding"];
	runConversationFacetTurn: AgentTediDO["runConversationFacetTurn"];
	effectiveStepCeiling: AgentTediDO["effectiveStepCeiling"];
	mcpRuntime: AgentTediDO["mcpRuntime"];
	clearActiveTurn: AgentTediDO["clearActiveTurn"];
	runHadFacetToolError: AgentTediDO["runHadFacetToolError"];
	peekPendingToolSteps: AgentTediDO["peekPendingToolSteps"];
	commitAssistantTurnImpl: AgentTediDO["commitAssistantTurnImpl"];
	broadcast: AgentTediDO["broadcast"];
	toolCallRefsForRun: AgentTediDO["toolCallRefsForRun"];
	toolExecutionEvidenceForRun: AgentTediDO["toolExecutionEvidenceForRun"];
	onLedgerMirror: AgentTediDO["onLedgerMirror"];
	runtimeAdmission: AgentTediDO["runtimeAdmission"];
	/** Tests shorten the wait for a rebuilt registry; production uses the default. */
	facetRegistryRebuildWaitMs?: number;
}

export const runtimeFacetTurns = {
	/**
	 * ASYNC VOICE NOTES + attachment surfacing for isolate bodies.
	 *
	 * The runtime has no separate media-understanding path, so an audio
	 * attachment from Tedix OS (or MCP / email) would never be transcribed. This is
	 * the BODY-side attachment entry point shared by the isolate chat paths
	 * (`streamChatTurn`, `runDurableChatTurn`). It transcribes the FIRST audio
	 * attachment via the shared `@tedix/voice/stt` helper (Azure `gpt-transcribe`
	 * preferred, Workers AI whisper fallback) and templates the transcript into
	 * the turn text using the `{{Transcript}}` convention. STT routes
	 * through authenticated BYOK on the configured gateway.
	 *
	 * Non-audio attachments resolve as model-facing content AND/OR a note:
	 *   - When the pinned chat deployment is vision-capable, `image/*` files are
	 *     FAIL-SOFT resolved into model image content parts (capped per-image
	 *     size + total count; oversized / non-image / over-count / unsupported
	 *     mime fall back to the note). The returned `images` are EMPTY whenever
	 *     the model is not vision-capable, so a text-only or audio turn is
	 *     byte-for-byte unaffected.
	 *   - Everything not sent as an image part is surfaced via a compact context
	 *     note listing the file(s) so the operator and model know they arrived —
	 *     we never silently drop an attachment.
	 *
	 * Fail-soft: a transcription error runs the turn with a clear
	 * `[audio transcription failed: …]` note instead of dropping the message.
	 */
	async resolveAttachmentTurn(
		this: RuntimeFacetTurnsHost,
		userText: string,
		attachments: AudioAttachment[] | undefined,
	): Promise<{ content: string; images: TurnImagePart[] }> {
		if (attachments?.some((a) => a.type === "audio"))
			await requireUnrestrictedModelEgress(
				this.env,
				this.state.orgId!,
				"Speech transcription",
			);
		const resolveImages = isVisionCapableChatDeployment(
			this.env.AZURE_CHAT_DEPLOYMENT,
		);
		const resolved = await resolveVoiceMessageContent({
			env: this.env as unknown as VoiceSttEnv,
			content: userText,
			attachments,
			logContext: "isolate.do",
			includeNonAudioAttachmentNote: true,
			resolveImages,
			gatewayMetadata: {
				orgId: this.state.orgId,
				tediId: this.state.tediId,
				source: "voice-stt",
				usage: JSON.stringify({ k: "voice_stt", u: "units", q: 1 }),
			},
		});
		return { content: resolved.content, images: resolved.images };
	},
	/**
	 * Facet-per-conversation judge turn: run a blind
	 * verification (`evidence:judge:*`) turn on its OWN Pi facet instead of
	 * the parent's multi-session loop. One facet per judge conversation (name =
	 * sanitized session key), spawned lazily and reused across turns — the
	 * facet's isolated, initially-empty SQLite makes blindness STRUCTURAL
	 * (nothing to bleed) where the parent path relied on vigilance gates.
	 *
	 * The parent keeps everything canonical: the session-harness user/assistant
	 * appends, run events, and the deterministic runId contract all happen in
	 * durable chat settlement — this helper only produces the assistant
	 * text. Persona + per-role model are stamped per turn (`configure`), so
	 * model-policy changes apply to the very next verdict.
	 *
	 * Pre-cutover continuity: a judge conversation whose earlier turns ran on
	 * the parent path has history only in the parent harness; on the facet's
	 * FIRST turn that history is hydrated in as an explicit context block.
	 * Fail-soft: hydration errors degrade to an empty history (judge sessions
	 * are usually fresh), and any facet error surfaces as a normal turn error
	 * through the shared post-turn ledger path — never a dropped turn.
	 */
	/**
	 * Queryable facet-turn observability: the co-located console
	 * lines are the human trail but Workers Logs samples them away under load,
	 * so latency/error graduation decisions
	 * read from Analytics Engine instead. Fail-soft: an AE write must never
	 * throw into a turn.
	 */
	emitFacetTurnDatapoint(
		this: RuntimeFacetTurnsHost,
		event: FacetTurnAnalyticsDataPointEvent,
	): void {
		try {
			this.env.RUNTIME_ANALYTICS?.writeDataPoint(
				buildFacetTurnAnalyticsDataPoint({
					tediId: this.state.tediId ?? "",
					...event,
				}),
			);
		} catch {
			/* AE write is best-effort */
		}
	},
	async runJudgeFacetTurn(
		this: RuntimeFacetTurnsHost,
		input: {
			runId: string;
			sessionKey: string;
			guardedUserText: string;
			userTs: number;
		},
	): Promise<{
		assistantText: string;
		turnError: string | null;
		modelIdentity?: TediSessionModelIdentity;
	}> {
		const runId = input.runId;
		await this.acceptRuntimeTurn(runId, input.sessionKey, input, true);
		const facetName = input.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
		const t0 = Date.now();
		let firstFacetTurn = false;
		try {
			const facet = await this.subAgent(JudgeSessionFacet, facetName);
			const source = inferenceSource(input.sessionKey, "judge");
			this.admitInferenceTurn(runId, [
				this.state.systemPrompt,
				input.guardedUserText,
			]);
			const { priorTurnCount } = await facet.configureJudgeTurn({
				runId,
				sessionKey: input.sessionKey,
				aigMetadata: this.tediAigMetadata(source, {
					runId,
					sessionKey: input.sessionKey,
				}),
				system: this.state.systemPrompt,
			});
			firstFacetTurn = priorTurnCount === 0;
			let text = input.guardedUserText;
			if (priorTurnCount === 0) {
				try {
					const prior = await this.sessionHarness.buildContext(
						input.sessionKey,
						{ excludeUserTs: input.userTs, requireContent: true },
					);
					if (prior.length > 0) {
						const rendered = prior
							.map((message) =>
								typeof message.content === "string"
									? `${message.role}: ${message.content}`
									: "",
							)
							.filter(Boolean)
							.join("\n")
							.slice(-JUDGE_FACET_HYDRATION_CHAR_CAP);
						text = `Prior turns in this verification conversation (context only):\n${rendered}\n\n---\n\n${text}`;
					}
				} catch {
					// Fail-soft: hydration is best-effort; judges are usually fresh.
				}
			}
			const result = await facet.runJudgeTurn({ text });
			console.log("[judge-facet] turn complete", {
				facetName,
				modelIdentity: result.modelIdentity,
				requestId: result.requestId,
				sessionKey: input.sessionKey,
				totalMs: Date.now() - t0,
				turnCount: result.turnCount,
				turnMs: result.turnMs,
			});
			this.emitFacetTurnDatapoint({
				surface: "judge",
				outcome: "complete",
				facetNameHash: hashAnalyticsLabel(facetName),
				turnMs: result.turnMs,
				totalMs: Date.now() - t0,
				firstFacetTurn,
				turnCount: result.turnCount,
			});
			return {
				assistantText: result.assistantText,
				turnError: null,
				modelIdentity: result.modelIdentity,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logTediRuntimeFailure("tedi.facet.judge_turn_failed", error, "error");
			this.emitFacetTurnDatapoint({
				surface: "judge",
				outcome: "error",
				errorClass: runtimeFailureType(error),
				facetNameHash: hashAnalyticsLabel(facetName),
				totalMs: Date.now() - t0,
				firstFacetTurn,
			});
			return { assistantText: "", turnError: message };
		}
	},
	async runSynthesisFacetTurn(
		this: RuntimeFacetTurnsHost,
		input: {
			sessionKey: string;
			guardedUserText: string;
			runId: string;
		},
	): Promise<{
		assistantText: string;
		turnError: string | null;
		usage?: FacetTurnUsage;
		modelIdentity?: TediSessionModelIdentity;
	}> {
		await this.acceptRuntimeTurn(input.runId, input.sessionKey, input, true);
		// One facet per run keeps synthesis self-contained even if a producer
		// accidentally reuses its session key. No harness-history hydration occurs.
		const facetName = `synth_${hashAnalyticsLabel(
			`${input.sessionKey}:${input.runId}`,
		)}`;
		const system =
			`${this.state.systemPrompt}\n\n` +
			"Tool-free workflow synthesis: use only the supplied message. " +
			"Do not request tools, memory, or missing context. Return the requested " +
			"bounded synthesis directly.";
		const t0 = Date.now();
		try {
			const facet = await this.subAgent(SynthesisSessionFacet, facetName);
			const source = inferenceSource(input.sessionKey, "mcp");
			this.admitInferenceTurn(input.runId, [system, input.guardedUserText]);
			await facet.configureSynthesisTurn({
				runId: input.runId,
				sessionKey: input.sessionKey,
				aigMetadata: this.tediAigMetadata(source, {
					runId: input.runId,
					sessionKey: input.sessionKey,
				}),
				modelRef: this.modelOverrideForSurface("synthesis")?.modelRef ?? null,
				system,
			});
			const result = await facet.runSynthesisTurn({
				text: input.guardedUserText,
			});
			this.settleCumulativeInferenceTokens(
				input.runId,
				result.usage?.totalTokens,
			);
			console.log("[synthesis-facet] turn complete", {
				facetName,
				modelIdentity: result.modelIdentity,
				requestId: result.requestId,
				sessionKey: input.sessionKey,
				totalMs: Date.now() - t0,
				turnCount: result.turnCount,
				turnMs: result.turnMs,
			});
			this.emitFacetTurnDatapoint({
				surface: "mcp",
				outcome: "complete",
				facetNameHash: hashAnalyticsLabel(facetName),
				turnMs: result.turnMs,
				totalMs: Date.now() - t0,
				firstFacetTurn: result.turnCount === 1,
				turnCount: result.turnCount,
			});
			return {
				assistantText: result.assistantText,
				turnError: null,
				...(result.usage ? { usage: result.usage } : {}),
				modelIdentity: result.modelIdentity,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logTediRuntimeFailure("tedi.facet.synthesis_turn_failed", error, "error");
			this.emitFacetTurnDatapoint({
				surface: "mcp",
				outcome: "error",
				errorClass: runtimeFailureType(error),
				facetNameHash: hashAnalyticsLabel(facetName),
				totalMs: Date.now() - t0,
				firstFacetTurn: true,
			});
			return { assistantText: "", turnError: message };
		}
	},
	async enrollFacetDispatchRun(
		this: RuntimeFacetTurnsHost,
		runId: string,
	): Promise<void> {
		await this.assertChatTurnActive(runId);
		await this.facetDispatchJournal.enroll(runId);
	},
	async reconcileFacetToolEffect(
		this: RuntimeFacetTurnsHost,
		runId: string,
		toolCallId: string,
	) {
		await this.assertChatTurnActive(runId);
		const acquisition = await new AcquisitionDeadline(20_000).run(
			reconcileComputerAcquisition(
				this.ctx.storage,
				runId,
				`${runId}:${toolCallId}`,
				async (receipt) => {
					if (receipt.work && receipt.work.tediId !== this.state.tediId)
						throw new Error("Computer acquisition executor changed");
					await this.assertChatTurnActive(runId);
					await originalAcquisitionAuthority(
						this.ctx.storage,
						() => this.getPlatformClient(),
						{
							runId,
							workItemId: receipt.work?.workItemId,
							attemptId: receipt.work?.attemptId,
							tediId: this.state.tediId ?? undefined,
						},
					);
				},
			),
		);
		if (acquisition) return acquisition;
		const execution = await reconcileComputerEffect(
			this.ctx.storage,
			`${runId}:${toolCallId}`,
			(environment, jobId) =>
				this.readWorkstationJobTool({ ...environment, jobId }, null),
		);
		const rejected = await this.facetDispatchJournal.rejected(
			runId,
			toolCallId,
			async () =>
				(await this.ctx.storage.get(
					computerEffectKey(`${runId}:${toolCallId}`),
				)) !== undefined ||
				(await this.ctx.storage.get(
					computerAcquisitionKey(`${runId}:${toolCallId}`),
				)) !== undefined,
		);
		return (
			execution ??
			(await this.facetDispatchJournal.returned(runId, toolCallId)) ??
			rejected
		);
	},
	/** Rebuild closures after a parent reset from the immutable admitted dispatch.
	 * Never re-enroll a call or clear its durable dispatch receipt. */
	async restoreFacetTurnTools(
		this: RuntimeFacetTurnsHost,
		runId: string,
	): Promise<void> {
		if (this.activeFacetTurnTools.has(runId)) return;
		await this.facetWorkflowTurns.run(`restore-tools:${runId}`, async () => {
			if (this.activeFacetTurnTools.has(runId)) return;
			await this.assertChatTurnActive(runId);
			const dispatch = await this.ctx.storage.get<{ params: ChatTurnParams }>(
				`runtime-admission-workflow:${runId}`,
			);
			const params = dispatch?.params;
			if (!params || params.runId !== runId) return;
			await this.ensureIdentity();
			if (!this.state.tediId || !this.state.orgId)
				throw new Error("Runtime admission requires stored tenant identity");
			if (!readStoredRuntimeAdmission(this.ctx.storage, this.ctx.id.toString()))
				throw new Error(
					"Tool registry restoration requires existing runtime admission",
				);
			const admission = new RuntimeAdmissionDO(this.ctx.storage, {
				objectId: this.ctx.id.toString(),
				tediId: this.state.tediId,
				orgId: this.state.orgId,
			});
			const accepted = await admission.assertAcceptedTurn({
				runId,
				sessionKey: params.sessionKey,
				principalId: this.state.tediId,
			});
			const originalParams = JSON.stringify(params);
			await withDelegatedWorkLease(
				params,
				{
					storage: this.ctx.storage,
					getClient: () => this.getPlatformClient(),
					tediId: this.state.tediId,
					isSettled: () => false,
					assertActive: () => this.assertChatTurnActive(runId),
					arm: () => this.armDelegatedWorkLeaseRenewal(runId),
					requireActiveAttempt: true,
					keepRenewal: () => true,
				},
				async () => {
					const setup = await this.prepareMcpFacetTurn({
						...params,
						userMessage: params.userText,
						trust: mcpTurnSurfaceTrust(params),
						toolsOnly: true,
					});
					await this.assertChatTurnActive(runId);
					const current = this.ctx.storage.kv.get<{ params: ChatTurnParams }>(
						`runtime-admission-workflow:${runId}`,
					);
					if (
						JSON.stringify(current?.params) !== originalParams ||
						accepted.owner.tediId !== this.state.tediId ||
						accepted.owner.orgId !== this.state.orgId
					)
						throw new Error(
							"Original tool registry dispatch changed during restoration",
						);
					admission.assertAcceptedTurnSync({ runId, expected: accepted });
					this.activeFacetTurnTools.set(
						runId,
						configuredRuntimeTools(
							setup.tools,
							this.state.toolPolicy?.runtimeTools,
						),
					);
					this.activeFacetTurnConversations.set(runId, params.conversationId);
					const authority = delegatedTurnAuthority({
						delegated: Boolean(params.workItemId && params.homeRunId),
						envelope: params.authorityEnvelope,
						mode: params.authorityMode,
					});
					if (authority) this.activeFacetTurnAuthorities.set(runId, authority);
				},
			);
		});
	},
	/** Facet tool proxy: authorize, dispatch, and record one live tool call. */
	async executeFacetTool(
		this: RuntimeFacetTurnsHost,
		input: {
			runId: string;
			toolCallId: string;
			tool: string;
			args: unknown;
			deadlineAt?: number;
		},
	): Promise<unknown> {
		await this.assertChatTurnActive(input.runId);
		// CALLEE-side duration only — the facet emits `facet_tool_wait` for the same
		// (runId, toolCallId). Wait minus callee is the resolve/RPC/queue cost of
		// the hop, which an end-to-end span alone could not separate from the tool.
		const enteredAt = Date.now();
		let authorityMs = 0;
		let executeMs = 0;
		// Retain failed and evicted calls for post-turn rationale.
		const stepNumber = this.bufferFacetToolCall(input.runId, input.tool);
		await runtimeFacetTurns.restoreFacetTurnTools.call(this, input.runId);
		const tools = await awaitRebuiltFacetRegistry(
			() => this.activeFacetTurnTools.get(input.runId),
			{
				waitMs:
					this.facetRegistryRebuildWaitMs ?? FACET_REGISTRY_REBUILD_WAIT_MS,
				deadlineAt: input.deadlineAt,
			},
		);
		const definition = tools?.[input.tool];
		let result: unknown;
		let finishReason = "facet-tool-proxy";
		const authorityContext = this.activeFacetTurnAuthorities.get(input.runId);
		const authorityVerdict = authorityContext
			? evaluateDelegatedFacetTool({
					envelope: authorityContext.envelope,
					mode: authorityContext.mode,
					tool: input.tool,
					args: input.args,
				})
			: null;
		if (authorityContext && authorityVerdict && this.state.tediId) {
			const authorityAt = Date.now();
			await emitDelegationAuthorityRuntimeEvent({
				// Observational: the verdict above already enforced. Publishing it
				// through the outbox keeps a ~1s ledger RPC off every delegated tool
				// call; `onLedgerMirror` drains the run before it settles.
				getRecorder: async () =>
					(await this.getPlatformClient())
						? {
								recordRuntimeEvent: async (event) => {
									await this.eventOutbox.publish(event);
								},
							}
						: null,
				tediId: this.state.tediId,
				runId: input.runId,
				stepNumber,
				tool: input.tool,
				mode: authorityContext.mode,
				envelope: authorityContext.envelope,
				verdict: authorityVerdict,
			});
			authorityMs = Date.now() - authorityAt;
		}
		const claimed = await this.facetDispatchJournal.claim(
			input,
			Boolean(definition?.execute) &&
				(!authorityVerdict || authorityVerdict.allowed),
		);
		if (authorityVerdict && !authorityVerdict.allowed) {
			finishReason = "facet-tool-authority-denied";
			result = {
				error: authorityVerdict.reason,
				code: "delegation_authority_denied",
			};
		} else if (!claimed || !definition?.execute) {
			finishReason = "facet-tool-unavailable";
			result = {
				code: "facet_tool_unavailable",
				error: `Tool "${input.tool}" is not available on this turn (no live registry for run ${input.runId}).`,
			};
		} else {
			const executedAt = Date.now();
			try {
				// Ledger bracket for native tools (MCP tools ledger themselves in
				// core `executeTool`); the conversation id was pinned when this
				// run's registry was installed, so a concurrent facet cannot
				// misattribute the row.
				const conversationId = this.activeFacetTurnConversations.get(
					input.runId,
				);
				const ledgerContext =
					this.state.tediId && conversationId
						? { tediId: this.state.tediId, runId: input.runId, conversationId }
						: null;
				result = await this.nativeToolLedger.observe(
					ledgerContext,
					{
						name: input.tool,
						callId: input.toolCallId,
						args: input.args,
					},
					async () => {
						await this.assertChatTurnActive(input.runId);
						return runWithDelegationDeadline(
							input.deadlineAt,
							async (abortSignal) =>
								await definition.execute!(input.args as never, {
									abortSignal,
									context: undefined,
									messages: [],
									toolCallId: `${input.runId}:${input.toolCallId}`,
								}),
						);
					},
				);
				executeMs = Date.now() - executedAt;
				// Fail-soft MCP/Code Mode errors still count as failed tool execution.
				if (facetToolResultIndicatesFailure(result)) {
					finishReason = "facet-tool-error";
				}
			} catch (error) {
				executeMs = Date.now() - executedAt;
				finishReason = "facet-tool-error";
				const message = error instanceof Error ? error.message : String(error);
				logTediRuntimeFailure("tedi.facet.proxied_tool_failed", error, "error");
				result = { error: `Tool "${input.tool}" failed: ${message}` };
			}
			// Persist only a terminal marker, not the tool result. If this write
			// fails, the dispatch remains fenced across a reset.
			await this.facetDispatchJournal.markReturned(input, finishReason);
		}
		const resultDigest = await digestObserverToolResult(result);
		await this.completeFacetToolCall({
			finishReason,
			runId: input.runId,
			stepNumber,
			toolName: input.tool,
			...(resultDigest ? { resultDigest } : {}),
		});
		markFacetToolDispatch({
			tediId: identityValue(this.state.tediId) ?? null,
			runId: input.runId,
			toolCallId: input.toolCallId,
			tool: input.tool,
			calleeMs: Date.now() - enteredAt,
			authorityMs,
			executeMs,
			finishReason,
		});
		return result;
	},
	/**
	 * Facet-per-conversation MCP/mesh turn: run a
	 * `run_tedi_turn`/mesh turn on its OWN Pi facet instead of the parent's
	 * bespoke multi-session model loop. One facet per conversation (name =
	 * sanitized session key) — per-facet session tree/queue gives structural
	 * session isolation and concurrent admission; the parent keeps the
	 * canonical harness appends, run events, and the deterministic runId dedup
	 * contract, and serves the turn's real tools through the per-runId proxy
	 * registry. Pre-cutover history hydrates fail-soft (capped) into the
	 * facet's first turn. Any facet error surfaces as a normal turn error —
	 * never a dropped turn.
	 */
	/**
	 * Shared MCP-surface facet-turn setup — tools, system prompt, and turn
	 * binding — used by the durable `runFacetWorkflowTurn` path, so the two surfaces can
	 * never diverge on tool surface or cognition injection again (the
	 * divergence class the adoption review kept finding). Threads `workItemId`
	 * for Home-delegated turns, mirroring the retired `prepareChatContext`.
	 *
	 * Workspace tools spread first so an MCP tool that ever collides on a
	 * generic name (`read`, `list`, ...) wins. Cognitive addenda (matched
	 * compiled directives + brain digest + skill guidance) are injected exactly
	 * as on `beforeTurn`/the other facet paths, session-key-gated.
	 */
	async prepareMcpFacetTurn(
		this: RuntimeFacetTurnsHost,
		input: {
			noFunds?: boolean;
			sessionKey: string;
			userMessage: string;
			conversationId: string;
			runId: string;
			traceId?: string;
			workItemId?: string;
			homeRunId?: string;
			personalRequest?: boolean;
			executionSurface?: ExecutionSurface;
			repositoryMode?: RepositoryMode;
			authorityEnvelope?: DelegationAuthorityEnvelope;
			capabilityPlan?: DelegationCapabilityPlan;
			authorityMode?: DelegationAuthorityMode;
			operatorConsent?: OperatorConsentAttestation;
			/** Omitted ⇒ trusted; `untrusted` keeps the MCP read-only allowlist. */
			trust?: SurfaceTrust;
			/** Restore closures without invoking cognitive retrieval or inference. */
			toolsOnly?: boolean;
		},
	): Promise<{
		tools: ToolSet;
		system: string;
		turnBinding: ActiveTurnBinding | null;
	}> {
		// Work attribution belongs to dispatch, independently of gateway availability.
		const computerTurnContext = captureWorkstationTurnContext(input);
		if (Boolean(input.workItemId) !== Boolean(input.homeRunId)) {
			throw new Error("Incomplete Home-supervised MCP authority context");
		}
		const supervised = Boolean(input.workItemId && input.homeRunId);
		if (
			supervised &&
			input.executionSurface === "native" &&
			input.capabilityPlan?.requiredCapabilities.includes("repository.read")
		) {
			assertNativeResearchCheckout(
				input.capabilityPlan,
				await this.computerEnvironment(
					computerWorkspaceScope(input),
					computerTurnContext,
				).selected(),
			);
		}
		const cronTool = this.cronAiTool(input.sessionKey);
		// Connections carry the calling run's personal-read lookup and trace.
		// Isolate them per turn so a scheduled or concurrent turn cannot borrow
		// another request's binding or its supervised credentials.
		const { AgentMcpRuntime } = await import("./mcp-client-runtime");
		const isolatedRequest = supervised || input.personalRequest === true;
		const mcpRuntime =
			isolatedRequest && this.state.tediId
				? new AgentMcpRuntime(
						this.env,
						this.state.tediId,
						this.state.orgId,
						(event) => this.publishRuntimeObservation(event),
						(conversationId) =>
							this.computerWorkspace({
								kind: "conversation",
								key: conversationId,
							}).workspace,
						supervised
							? {
									runId: input.runId,
									homeRunId: input.homeRunId!,
									workItemId: input.workItemId!,
								}
							: undefined,
					)
				: await this.getMcpRuntime();
		if (isolatedRequest && mcpRuntime) {
			try {
				await withTimeout(
					mcpRuntime.ensureSynced(),
					COLD_MCP_SYNC_TIMEOUT_MS,
					"supervised MCP sync",
				);
			} catch (error) {
				console.warn(
					"[isolate-mcp] supervised MCP sync unavailable; no parent credential fallback:",
					error,
				);
			}
		}
		const requiredSchemas =
			supervised && input.capabilityPlan
				? await preflightDelegationTools(input.capabilityPlan, async (code) => {
						if (!mcpRuntime)
							throw new Error(
								"Delegation preflight failed: child MCP credential unavailable",
							);
						return mcpRuntime.executeTool(
							"tedix_mcp_code",
							{ code },
							{
								resultAudience: "machine",
							},
						);
					})
				: [];
		const platform = await this.getPlatformClient();
		let turnBinding: ActiveTurnBinding | null = null;
		if (mcpRuntime && platform) {
			mcpRuntime.bindTurn({
				platform,
				conversationId: input.conversationId,
				runId: input.runId,
				traceId: input.traceId ?? input.runId,
				workItemId: input.workItemId,
			});
			turnBinding = {
				platform,
				conversationId: input.conversationId,
				runId: input.runId,
				// The conversation a detached command's completion wake lands back
				// in; a delegated-run computer scope is keyed by Work Item, so the
				// session key exists nowhere else at tool-call time.
				sessionKey: input.sessionKey,
				traceId: input.traceId ?? input.runId,
				...(input.workItemId ? { workItemId: input.workItemId } : {}),
				...(input.homeRunId ? { homeRunId: input.homeRunId } : {}),
			};
			platform.setEpisodeTrace(input.traceId ?? input.runId);
		}
		const computerScope = computerWorkspaceScope(input);
		const unrestrictedTools: ToolSet = {
			// Computer owns the durable filesystem and no-network isolate shell;
			// native Git and checkpoints share that same workspace substrate.
			...this.workspaceAiTools(computerScope, computerTurnContext),
			...(mcpRuntime ? tedixMcpAITools(mcpRuntime, turnBinding) : {}),
			...workAiTools(() => this.getPlatformClient()),
			...(supervised &&
			this.state.tediId &&
			this.state.orgId &&
			hasOperatorRecordPlan(input.capabilityPlan)
				? operatorRecordTools({
						env: this.env,
						tediId: this.state.tediId,
						organizationId: this.state.orgId,
						runId: input.runId,
						homeRunId: input.homeRunId!,
						workItemId: input.workItemId!,
						executeMcp: async (name, args) => {
							if (!mcpRuntime)
								throw new Error(
									"No connected calendar or mail reader is available for this delegation",
								);
							return mcpRuntime.executeTool(name, args, {
								binding: turnBinding,
							});
						},
					})
				: {}),
			...(supervised &&
			input.homeRunId &&
			input.workItemId &&
			input.capabilityPlan?.allowedToolIds.includes("close_completed_work_item")
				? delegatedWorkTools({
						getPlatform: () => this.getPlatformClient(),
						homeRunId: input.homeRunId,
						runId: input.runId,
						linkedWorkItemId: input.workItemId,
					})
				: {}),
			...this.browserAiTools(computerScope, turnBinding),
			...this.skillReadTool(turnBinding),
			...this.durableCodemodeAiTools(computerScope, turnBinding),
			...cronTool,
			...computerToolsForDelegatedTurn(
				this.workstationAiTool(computerScope, computerTurnContext),
				input.executionSurface,
			),
			...this.objectStoreAiTools(),
			...this.r2SqlAiTool(),
			...createWebSearchAiTools({
				ai: this.env.AI,
				organizationWebSearch: this.state.organizationWebSearch,
				toolPolicy: this.state.toolPolicy,
				runId: input.runId,
				getPlatform: () => this.getPlatformClient(),
			}),
		};
		const supervisedTools = supervisedDelegationToolSet(
			selectRepositoryToolSurface(unrestrictedTools, input.repositoryMode),
			supervised,
			input.authorityMode === "enforce" || Boolean(input.capabilityPlan),
			hasOperatorRecordPlan(input.capabilityPlan),
		);
		const capabilityTools = capabilityToolSet({
			tools: input.capabilityPlan
				? {
						...supervisedTools,
						tedix_mcp_search_tools: unrestrictedTools.tedix_mcp_search_tools!,
					}
				: supervisedTools,
			plan: input.capabilityPlan,
			onEvaluation: async (evaluation) => {
				await this.eventOutbox.publish({
					id: `${input.runId}:capability:${evaluation.toolCallId}`,
					tediId: this.state.tediId!,
					kind: "delegation.authority.evaluated",
					runId: input.runId,
					conversationId: input.conversationId,
					sequence: 0,
					payload: {
						source: "delegation-capabilities",
						mode: "enforce",
						enforced: true,
						...evaluation,
						capabilityPlan: input.capabilityPlan,
						workItemId: input.workItemId,
						homeRunId: input.homeRunId,
					},
					runtime: { backend: "cloudflare-agents" },
					createdAt: new Date().toISOString(),
				});
			},
		});
		const trust = input.trust ?? "trusted";
		const tools = selectTrustedTurnTools({
			trust,
			allowlist: untrustedTurnToolAllowlist("mcp"),
			full: restrictDelegatedToolSet(
				capabilityTools,
				input.authorityEnvelope,
				input.authorityMode,
			),
		});
		if (input.toolsOnly)
			return {
				tools: noFundsTurnTools(tools, input.noFunds),
				system: "",
				turnBinding,
			};
		const addenda = await this.cognitiveAddenda(
			input.sessionKey,
			input.userMessage,
			turnBinding,
		);
		const toolsNote =
			workspaceToolGuidance({
				supervised,
				repositoryMode: input.repositoryMode,
			}) +
			(input.capabilityPlan
				? ` This delegation is restricted to ${input.capabilityPlan.allowedToolIds.join(", ")}. Use tedix_mcp_call_tool with the exact schemas supplied below; arbitrary Code Mode is unavailable. If retrieval fails, report the capability gap rather than inventing a result.\n${wrapUntrustedInput(requiredSchemas.join("\n"), "delegated_tool_schemas")}`
				: "");
		// Per-turn addenda (memory recall, matched directives, retrieved skills)
		// follow the turn-invariant runtime contract so the provider prefix cache
		// can reuse everything before them.
		let system = cacheOrderedSystemPrompt(
			[
				this.state.systemPrompt,
				mcpRuntime?.getSystemInstructions({ includeGuidance: !supervised }) ??
					"",
				toolsNote,
				isolatedRequest ? PERSONAL_REQUEST_READ_GUIDANCE : "",
				CODE_MODE_BATCHING_NOTE,
				trust === "untrusted" ? untrustedTurnSystemAddendum("mcp") : "",
			],
			[addenda],
		);
		// Runtime-authored consent block: appended to the
		// SYSTEM prompt, never the user message, so the one trustworthy consent
		// representation lives on the side of the turn tenant text cannot reach.
		// The log pairs with the gateway's "operator-consent attached" line so
		// attach→render is auditable end to end.
		if (input.operatorConsent) {
			system = `${system}\n\n${renderOperatorConsentBlock(input.operatorConsent)}`;
			console.log(
				`[isolate.do] operator-consent rendered: run=${input.operatorConsent.runId} createdBy=${input.operatorConsent.createdBy} turnRun=${input.runId}`,
			);
		}
		return {
			tools: noFundsTurnTools(tools, input.noFunds),
			system: input.noFunds ? `${system}\n\n${NO_FUNDS_TURN_MESSAGE}` : system,
			turnBinding,
		};
	},
	async runConversationFacetTurn(
		this: RuntimeFacetTurnsHost,
		input: {
			sessionKey: string;
			guardedUserText: string;
			userTs: number;
			system: string;
			runId: string;
			maxSteps: number | null;
			tools: ToolSet;
			authorityEnvelope?: DelegationAuthorityEnvelope;
			authorityMode?: DelegationAuthorityMode;
			delegated?: boolean;
			delegationBudget?: ChatTurnParams["delegationBudget"];
			/** Vision-capable image attachments resolved by the parent (FAIL-SOFT
			 * empty on non-vision deployments) — carried through the facet boundary
			 * as UIMessage file parts. */
			images?: TurnImagePart[];
			/** Durable workflow images remain private references through Pi state. */
			imageRefs?: WorkflowImageRef[];
			/** Which migrated surface is running this turn (AE observability). */
			surface: "mcp" | "email";
			/** Server-derived trigger class for AI Gateway cost attribution. */
			source?: string;
			/** Concrete Work Item behind this turn (kernel delegation / work-order
			 * dispatch). Threaded into `cf-aig-metadata` attribution so gateway cost
			 * rows carry a purpose-linked id instead of the `system:mcp` fallback,
			 * so run purpose stays recoverable. */
			workItemId?: string;
			/** Budget lane. Authenticated cron turns are background; user/Home work is operator. */
			admissionClass?: "background" | "governed_learning" | "operator";
			/**
			 * Cron turns rebuild continuity from canonical Tedix state and must not
			 * replay the prior fire's derived Pi transcript.
			 */
			freshHistory?: boolean;
			durableSubmissionId?: string;
			/**
			 * Which model-policy surface pays for this turn. Derived from the existing
			 * trusted-scheduler signal (`trustedInstructionOrigin === "cron"`), NOT from
			 * anything a tenant can set. Omitted → `"chat"` (interactive), which
			 * resolves exactly as before the per-surface refs existed.
			 */
			modelSurface?: Exclude<ModelPolicySurface, "synthesis">;
			/** Replaces the surface's model and generation for this turn only. */
			turnModel?: ChatTurnParams["turnModel"];
		},
	): Promise<{
		assistantText: string;
		turnError: string | null;
		modelIdentity?: TediSessionModelIdentity;
		/** Aggregate model-reported token usage for the turn (facet-owned loop),
		 * absent when no step reported it (null-absent). */
		usage?: FacetTurnUsage;
		/** Present when the facet's mid-turn budget gate stopped the loop early. */
		stopReason?: FacetBudgetStopReason;
	}> {
		await this.acceptRuntimeTurn(
			input.runId,
			input.sessionKey,
			{
				...input,
				tools: describeFacetTools(
					configuredRuntimeTools(
						input.tools,
						this.state.toolPolicy?.runtimeTools,
					),
				),
			},
			true,
		);
		this.activeFacetTurnTools.set(
			input.runId,
			configuredRuntimeTools(input.tools, this.state.toolPolicy?.runtimeTools),
		);
		this.activeFacetTurnConversations.set(
			input.runId,
			buildTediConversationId({
				tediRef: this.state.slug || this.state.tediId,
				sessionKey: input.sessionKey,
			}),
		);
		// Per-tool authority exists only for a delegation carrying an earned
		// grant; an envelope-less delegation runs on the supervised ceiling alone.
		const turnAuthority = delegatedTurnAuthority({
			delegated: input.delegated,
			envelope: input.authorityEnvelope,
			mode: input.authorityMode,
		});
		if (turnAuthority) {
			this.activeFacetTurnAuthorities.set(input.runId, turnAuthority);
		}
		const facetName = input.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
		const t0 = Date.now();
		let firstFacetTurn = false;
		try {
			const facet = await this.subAgent(ConversationFacet, facetName);
			const toolDescriptors = describeFacetTools(
				configuredRuntimeTools(
					input.tools,
					this.state.toolPolicy?.runtimeTools,
				),
			);
			const source =
				input.source ?? inferenceSource(input.sessionKey, input.surface);
			this.admitInferenceTurn(
				input.runId,
				[input.system, input.guardedUserText, toolDescriptors],
				input.admissionClass,
			);
			const modelSurface = input.modelSurface ?? "chat";
			const modelOverride = input.turnModel
				? { modelRef: input.turnModel.modelRef }
				: this.modelOverrideForSurface(modelSurface);
			// Adaptive routing is authority, not a property a model ref grants itself.
			// Ordinary chat, agent, and background turns use the platform default;
			// Model routing does not replace deterministic authority or Work admission.
			const adaptiveRouting = {
				surface: modelSurface,
				authority: input.authorityEnvelope ? "authority-sensitive" : "ordinary",
				reproducibility: "adaptive",
				sovereignty: "unconstrained",
			} as const;
			const turnConfiguration = {
				delegationBudget: input.delegationBudget,
				observerModelRef:
					this.modelOverrideForSurface("observer")?.modelRef ?? null,
				observerDeployment: this.modelOverrideForSurface(
					"observer",
				)?.modelRef.startsWith("azure-openai/")
					? this.observerDeploymentForTurn()
					: null,
				generation: input.turnModel
					? (input.turnModel.generation ?? {})
					: generationForSurface(
							this.runtimeConfigCache.modelPolicy,
							modelSurface,
						),
				adaptiveRouting,
				aigMetadata: this.tediAigMetadata(source, {
					runId: input.runId,
					sessionKey: input.sessionKey,
					...(input.workItemId ? { workItemId: input.workItemId } : {}),
				}),
				maxSteps: input.maxSteps,
				// Per-SURFACE model selection: a scheduled turn can run on
				// `cronModelRef` while the same tedi keeps `chatModelRef` for
				// interactive work. No cron ref set → identical to before.
				modelRef: modelOverride?.modelRef ?? null,
				runId: input.runId,
				sessionKey: input.sessionKey,
				system: input.system,
				stableSystemPrefix: input.system.startsWith(this.state.systemPrompt)
					? this.state.systemPrompt
					: null,
				promptCacheSurface: input.surface,
				toolDescriptors,
			};
			const turnCountHint = await facet.completedTurnCount();
			const firstTurnText = input.freshHistory
				? input.guardedUserText
				: await this.hydrateFirstFacetTurnText({
						runId: input.runId,
						priorTurnCount: turnCountHint,
						sessionKey: input.sessionKey,
						text: input.guardedUserText,
						userTs: input.userTs,
					});
			const { priorTurnCount, result } =
				await facet.runConfiguredConversationTurn({
					configuration: turnConfiguration,
					text: input.guardedUserText,
					firstTurnText,
					freshHistory: input.freshHistory,
					durableSubmissionId: input.durableSubmissionId,
					...(input.images?.length ? { images: input.images } : {}),
					...(input.imageRefs?.length ? { imageRefs: input.imageRefs } : {}),
				});
			firstFacetTurn = priorTurnCount === 0;
			this.settleCumulativeInferenceTokens(
				input.runId,
				result.usage?.totalTokens,
			);
			if (result.stopReason) {
				logTediFacetBudgetStop("conversation", result.stopReason);
			}
			console.log("[conversation-facet] turn complete", {
				facetName,
				requestId: result.requestId,
				sessionKey: input.sessionKey,
				totalMs: Date.now() - t0,
				turnCount: result.turnCount,
				turnMs: result.turnMs,
			});
			this.emitFacetTurnDatapoint({
				surface: input.surface,
				outcome: "complete",
				facetNameHash: hashAnalyticsLabel(facetName),
				turnMs: result.turnMs,
				totalMs: Date.now() - t0,
				firstFacetTurn,
				turnCount: result.turnCount,
			});
			return {
				assistantText: await this.actionReceiptJournal.finish(
					input.runId,
					input.delegated
						? settledDelegatedReply(result.assistantText)
						: result.assistantText,
				),
				turnError: null,
				modelIdentity: result.modelIdentity,
				...(result.usage ? { usage: result.usage } : {}),
				...(result.stopReason ? { stopReason: result.stopReason } : {}),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logTediRuntimeFailure(
				"tedi.facet.conversation_turn_failed",
				error,
				"error",
			);
			this.emitFacetTurnDatapoint({
				surface: input.surface,
				outcome: "error",
				errorClass: runtimeFailureType(error),
				facetNameHash: hashAnalyticsLabel(facetName),
				totalMs: Date.now() - t0,
				firstFacetTurn,
			});
			return { assistantText: "", turnError: message };
		} finally {
			this.activeFacetTurnTools.delete(input.runId);
			this.activeFacetTurnConversations.delete(input.runId);
			this.activeFacetTurnAuthorities.delete(input.runId);
		}
	},
	/**
	 * Pre-cutover continuity: on a conversation's FIRST facet turn, prepend a
	 * capped render of its harness history so the facet doesn't start blind.
	 * Fail-soft — the facet's own history is canonical thereafter. Shared by
	 * the MCP/mesh turn and the Tedix OS SSE turn.
	 */
	async hydrateFirstFacetTurnText(
		this: RuntimeFacetTurnsHost,
		input: FacetHistoryInput,
	): Promise<string> {
		return hydrateFacetHistory(
			input,
			() =>
				this.sessionHarness.buildContext(input.sessionKey, {
					excludeUserTs: input.userTs,
					requireContent: true,
				}),
			CONVERSATION_FACET_HYDRATION_CHAR_CAP,
		);
	},
	/**
	 * Facet-per-conversation Tedix OS SSE turn: run a
	 * `streamChatTurn` text turn on the conversation's OWN Pi facet and
	 * pump its NDJSON frame stream live — `onDelta` fires per text-delta
	 * chunk (true token streaming; the legacy tool loop only ever emitted one
	 * terminal delta when tools were in play). The parent keeps the identical
	 * settlement contract as the legacy path: harness appends, run events,
	 * memory effects, ledger mirror, and the `{tediId}:chat:{clientRequestId}`
	 * runId dedup are all performed by the caller AFTER this resolves, in the
	 * same order as before. Fail-soft: any facet/pump failure returns a
	 * `turnError` — a normal turn error frame for the Tedix OS, never a dropped
	 * turn or hung stream.
	 */
	async streamConversationFacetTurn(
		this: RuntimeFacetTurnsHost,
		input: {
			durableSubmissionId?: string;
			messengerMetadata?: Record<string, unknown>;
			originalUiMessage?: SessionMessage;
			regenerationOf?: string;
			sessionKey: string;
			userText: string;
			userTs: number;
			system: string;
			runId: string;
			maxSteps: number | null;
			tools: ToolSet;
			onDelta: (text: string) => void;
			/** Raw AI SDK chunk sink — the full frame taxonomy (tool/data/metadata)
			 * the Tedix OS replays through `processChunk`. Optional: text-only callers
			 * (voice) pass just `onDelta`. */
			onChunk?: (body: string) => void;
			/** Vision-capable image attachments resolved by the parent (FAIL-SOFT
			 * empty on non-vision deployments) — carried through the facet boundary
			 * as UIMessage file parts. */
			images?: TurnImagePart[];
			/** Server-derived trigger class for AI Gateway cost attribution. */
			source?: string;
			modelRefOverride?: string;
			maxOutputTokensOverride?: number;
			/** Explicit per-turn thinking effort, already checked at the edge against
			 * the chosen model's declared reasoning capability. */
			reasoningEffortOverride?: "none" | "low" | "medium" | "high";
		},
	): Promise<{
		assistantText: string;
		turnError: string | null;
		/** Aggregate model-reported token usage for the turn (from the done frame),
		 * absent when no step reported it (null-absent). */
		usage?: FacetTurnUsage;
		/** Present when the facet's mid-turn budget gate stopped the loop early. */
		stopReason?: FacetBudgetStopReason;
	}> {
		await this.acceptRuntimeTurn(
			input.runId,
			input.sessionKey,
			{
				...input,
				tools: describeFacetTools(
					configuredRuntimeTools(
						input.tools,
						this.state.toolPolicy?.runtimeTools,
					),
				),
			},
			true,
		);
		this.activeFacetTurnTools.set(
			input.runId,
			configuredRuntimeTools(input.tools, this.state.toolPolicy?.runtimeTools),
		);
		this.activeFacetTurnConversations.set(
			input.runId,
			buildTediConversationId({
				tediRef: this.state.slug || this.state.tediId,
				sessionKey: input.sessionKey,
			}),
		);
		const facetName = input.sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
		const t0 = Date.now();
		let firstFacetTurn = false;
		try {
			const facet = await this.subAgent(ConversationFacet, facetName);
			const toolDescriptors = describeFacetTools(
				configuredRuntimeTools(
					input.tools,
					this.state.toolPolicy?.runtimeTools,
				),
			);
			const source =
				input.source ?? inferenceSource(input.sessionKey, "operator");
			this.admitInferenceTurn(input.runId, [
				input.system,
				input.userText,
				toolDescriptors,
			]);
			const imageRefs = input.images?.length
				? await this.prepareNativeConversationImages({
						runId: input.runId,
						operationId: input.durableSubmissionId ?? input.runId,
						sessionKey: input.sessionKey,
						images: input.images,
					})
				: [];
			let imageIndex = 0;
			const originalUiMessage = input.originalUiMessage
				? {
						...input.originalUiMessage,
						parts: input.originalUiMessage.parts.map((part) => {
							if (
								part.type !== "file" ||
								typeof part.mediaType !== "string" ||
								!part.mediaType.startsWith("image/")
							)
								return part;
							const ref = imageRefs[imageIndex++];
							if (!ref)
								throw new Error(
									"Authored UI image has no immutable native image reference",
								);
							return { ...part, url: workflowImageUri(ref) };
						}),
					}
				: undefined;
			const turnConfiguration = {
				turnMetadata: input.messengerMetadata ?? null,
				observerModelRef:
					this.modelOverrideForSurface("observer")?.modelRef ?? null,
				observerDeployment: this.modelOverrideForSurface(
					"observer",
				)?.modelRef.startsWith("azure-openai/")
					? this.observerDeploymentForTurn()
					: null,
				adaptiveRouting: null,
				generation: generationForSurface(
					this.runtimeConfigCache.modelPolicy,
					"chat",
				),
				aigMetadata: this.tediAigMetadata(source, {
					runId: input.runId,
					sessionKey: input.sessionKey,
				}),
				maxSteps: input.maxSteps,
				maxOutputTokens: input.maxOutputTokensOverride,
				// An explicit user choice wins. Otherwise a surface that caps output
				// is declaring a short utility turn; use "none" only when supported.
				// With neither override, the profile/model default stands.
				reasoning:
					input.reasoningEffortOverride ??
					(input.maxOutputTokensOverride &&
					supportsReasoningNone(
						input.modelRefOverride ??
							this.modelOverrideForTurn()?.modelRef ??
							`azure-openai/${this.env.AZURE_CHAT_DEPLOYMENT}`,
					)
						? "none"
						: null),
				modelRef:
					input.modelRefOverride ??
					this.modelOverrideForTurn()?.modelRef ??
					null,
				runId: input.runId,
				sessionKey: input.sessionKey,
				system: input.system,
				toolDescriptors,
			};
			const turnCountHint = await facet.completedTurnCount();
			firstFacetTurn = turnCountHint === 0;
			const text = await this.hydrateFirstFacetTurnText({
				runId: input.runId,
				priorTurnCount: turnCountHint,
				sessionKey: input.sessionKey,
				text: input.userText,
				userTs: input.userTs,
			});
			const stream = await facet.streamConfiguredConversationTurn({
				configuration: turnConfiguration,
				durableSubmissionId: input.durableSubmissionId ?? input.runId,
				originalUiMessage,
				regenerationOf: input.regenerationOf,
				text: input.userText,
				firstTurnText: text,
				...(imageRefs.length ? { imageRefs } : {}),
			});
			const reader = stream.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let done: Extract<FacetStreamFrame, { kind: "done" }> | null = null;
			let turnError: string | null = null;
			const consume = (frames: FacetStreamFrame[]) => {
				for (const frame of frames) {
					if (frame.kind === "delta") {
						input.onDelta(frame.text);
					} else if (frame.kind === "chunk") {
						input.onChunk?.(frame.body);
					} else if (frame.kind === "done") {
						done = frame;
					} else if (frame.kind === "error") {
						turnError = frame.message;
					}
				}
			};
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				const parsed = parseFacetStreamFrames(buffer);
				buffer = parsed.rest;
				consume(parsed.frames);
			}
			buffer += decoder.decode();
			consume(parseFacetStreamFrames(`${buffer}\n`).frames);
			if (turnError) {
				this.emitFacetTurnDatapoint({
					surface: "sse",
					outcome: "error",
					errorClass: "FacetStreamErrorFrame",
					facetNameHash: hashAnalyticsLabel(facetName),
					totalMs: Date.now() - t0,
					firstFacetTurn,
				});
				return { assistantText: "", turnError };
			}
			if (!done) {
				// Stream closed without a terminal frame (parent/facet eviction
				// mid-turn) — surface as a turn error; the Tedix OS retries under the
				// same clientRequestId⇒runId dedup contract.
				this.emitFacetTurnDatapoint({
					surface: "sse",
					outcome: "error",
					errorClass: "FacetStreamNoTerminalFrame",
					facetNameHash: hashAnalyticsLabel(facetName),
					totalMs: Date.now() - t0,
					firstFacetTurn,
				});
				return {
					assistantText: "",
					turnError: "facet stream ended without a terminal frame",
				};
			}
			const settled: Extract<FacetStreamFrame, { kind: "done" }> = done;
			firstFacetTurn = settled.turnCount === 1;
			this.settleCumulativeInferenceTokens(
				input.runId,
				settled.usage?.totalTokens,
			);
			if (settled.stopReason) {
				logTediFacetBudgetStop("sse", settled.stopReason);
			}
			console.log("[conversation-facet] sse turn complete", {
				facetName,
				requestId: settled.requestId,
				sessionKey: input.sessionKey,
				totalMs: Date.now() - t0,
				turnCount: settled.turnCount,
				turnMs: settled.turnMs,
			});
			this.emitFacetTurnDatapoint({
				surface: "sse",
				outcome: "complete",
				facetNameHash: hashAnalyticsLabel(facetName),
				turnMs: settled.turnMs,
				totalMs: Date.now() - t0,
				firstFacetTurn,
				turnCount: settled.turnCount,
			});
			return {
				assistantText: await this.actionReceiptJournal.finish(
					input.runId,
					settled.text,
				),
				turnError: null,
				...(settled.usage ? { usage: settled.usage } : {}),
				...(settled.stopReason ? { stopReason: settled.stopReason } : {}),
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logTediRuntimeFailure("tedi.facet.sse_turn_failed", error, "error");
			this.emitFacetTurnDatapoint({
				surface: "sse",
				outcome: "error",
				errorClass: runtimeFailureType(error),
				facetNameHash: hashAnalyticsLabel(facetName),
				totalMs: Date.now() - t0,
				firstFacetTurn,
			});
			return { assistantText: "", turnError: message };
		} finally {
			this.activeFacetTurnTools.delete(input.runId);
			this.activeFacetTurnConversations.delete(input.runId);
		}
	},
	/**
	 * Dangling-turn telemetry: before this turn appends its user message, check
	 * whether the in-memory recent-window cache has an old trailing user row.
	 * This is a diagnostic correlation, not canonical evidence that a D1 run
	 * lacks a terminal. Log-only, fail-soft, and never a settlement/watchdog gate.
	 */
	logDanglingTurnIfAny(
		this: RuntimeFacetTurnsHost,
		sessionKey: string,
		surface: string,
	): void {
		try {
			const turns = selectSessionContext(
				this.sessionRepo.listTurns(),
				sessionKey,
			);
			const ageMs = findDanglingUserTurnAgeMs(turns, Date.now());
			if (ageMs != null) {
				console.warn("[dangling-turn] prior cache ends with old user row", {
					ageMs: Math.round(ageMs),
					sessionKey,
					surface,
				});
				try {
					this.env.RUNTIME_ANALYTICS?.writeDataPoint(
						buildDanglingTurnAnalyticsDataPoint({
							surface,
							tediId: this.state.tediId ?? "",
							sessionKeyHash: hashAnalyticsLabel(sessionKey),
							ageMs: Math.round(ageMs),
						}),
					);
				} catch {
					/* AE write is best-effort */
				}
			}
		} catch {
			// Telemetry only — never let detection interfere with the turn.
		}
	},
	/** Dispatch durable chat and acknowledge after its canonical task is pollable. */
	async runDurableChatTurn(
		this: RuntimeFacetTurnsHost,
		input: {
			noFunds?: boolean;
			sessionKey: string;
			text: string;
			traceId?: string;
			clientRequestId: string;
			attachments?: AudioAttachment[];
			/** Explicit caller override (sync-inject threads the payload's
			 * learning_mode); absent ⇒ derived from the resolved user text. */
			learningMode?: AdaptiveLearningMode;
			callerTrust?: CallerTrustTier;
		},
	): Promise<{
		ok: true;
		run_id: string;
		session_key: string;
		assistant: { role: "assistant"; content: string; ts: number } | null;
		pending?: true;
		model_identity?: TediSessionModelIdentity;
	}> {
		await this.ensureIdentity();
		const { tediId, slug } = this.state;
		const sessionKey = input.sessionKey;
		this.logDanglingTurnIfAny(sessionKey, "runDurableChatTurn");
		const runId = buildRunId(tediId, input.clientRequestId, "mcp");
		return this.imageCleanupJournal().withRun(runId, async () => {
			if (await this.isWorkflowRunCanceled(runId))
				throw new Error(`Tedi run ${runId} cancelled`);
			const assistantKey = deriveIdempotencyKey(runId, "assistant");

			// Redelivery fast-path: THIS turn already settled (same client_request_id
			// ⇒ same `{runId}:2` keyed row) — return it without re-dispatching.
			const settled = this.sessionRepo.findTurnByIdempotencyKey(
				sessionKey,
				assistantKey,
			);
			if (settled) {
				return await settledChatTurnReceipt(await this.getPlatformClient(), {
					runId,
					sessionKey,
					assistant: settled,
				});
			}

			await this.acceptRuntimeTurn(runId, sessionKey, input);
			await this.assertChatTurnActive(runId);
			const resolved = await this.resolveAttachmentTurn(
				input.text.trim(),
				input.attachments,
			);
			const userText = resolved.content.trim();
			if (!userText) throw new Error("text is required");
			const workflowInstanceId = buildWorkflowInstanceId(input.clientRequestId);
			const imageRefs = await this.prepareWorkflowImages(
				runId,
				workflowInstanceId,
				resolved.images,
				sessionKey,
			);
			const conversationId = buildTediConversationId({
				tediRef: slug || tediId,
				sessionKey,
			});
			const originalDispatch = await this.ctx.storage.get<{
				params: ChatTurnParams;
			}>(`runtime-admission-workflow:${runId}`);
			if (
				originalDispatch !== undefined &&
				(!Number.isSafeInteger(originalDispatch?.params?.userTs) ||
					originalDispatch.params.userTs < 0)
			)
				throw new Error("Original admitted workflow timestamp unavailable");
			// Redelivery retains the timestamp in the original immutable dispatch.
			// The dispatch guard still compares every parameter before returning.
			const userTs = originalDispatch?.params.userTs ?? Date.now();
			const learningMode =
				input.learningMode ?? adaptiveLearningModeForTurn({ userText });
			const recorded = await this.recordWorkflowDispatch(workflowInstanceId, {
				runId,
				traceId: input.traceId,
				sessionKey,
				userText,
				userTs,
			});
			if (!recorded)
				throw new Error(
					`Cannot dispatch tedi run ${runId}: durable context unavailable`,
				);
			if (await this.isWorkflowRunCanceled(runId)) {
				await this.clearWorkflowDispatch(workflowInstanceId, "cancelled");
				throw new Error(`Tedi run ${runId} cancelled`);
			}
			await this.imageCleanupJournal().beforeDispatch(
				runId,
				workflowInstanceId,
			);
			try {
				await this.dispatchAdmittedChatWorkflow(
					"CHAT_TURN_WORKFLOW",
					{
						agentName: this.name,
						sessionKey,
						userText,
						...(imageRefs?.length ? { imageRefs } : {}),
						userTs,
						conversationId,
						runId,
						traceId: input.traceId,
						clientRequestId: input.clientRequestId,
						learningMode: input.noFunds ? "disabled" : learningMode,
						callerTrust: input.callerTrust,
						noFunds: input.noFunds,
					},
					// Same explicit binding as the async-inject dispatch: the binding
					// can't be auto-detected from the class name in this context.
					{ id: workflowInstanceId, agentBinding: "TEDI_AGENT" },
				);
			} catch (e) {
				if (!isDuplicateWorkflowInstanceError(e)) {
					// An ambiguous dispatch must never start a second inline execution.
					throw new Error(
						`Tedi run ${runId} dispatch outcome is unknown. Read its status or retry with the same client_request_id.`,
						{ cause: e },
					);
				}
				await this.reconcileChatWorkflowTerminal({
					workflowInstanceId,
					attempt: 0,
				});
			}
			await recordQueuedChatTurn(await this.getPlatformClient(), {
				tediId,
				runId,
				conversationId,
				userTs,
				sessionKey,
				traceId: input.traceId,
			});

			return {
				ok: true as const,
				run_id: runId,
				session_key: sessionKey,
				assistant: null,
				pending: true as const,
			};
		});
	},
	/**
	 * Land a COMPACT recap of a finished live voice call into the canonical
	 * session — the durable record of the call. Mirrors the runtime's
	 * recap-to-session: the call's lasting memory is a single
	 * ledger-mirrored session turn, NOT the voice package's ephemeral
	 * `cf_voice_messages` SQLite table (which lives in the SIBLING `VoiceCallDO`
	 * and holds zero canonical state).
	 *
	 * Unlike a chat turn this does NOT call the model — the recap text is
	 * pre-formatted by the sibling DO ({@link buildVoiceCallRecap}). It is landed
	 * as a user-marker / assistant-recap pair through the SAME
	 * `TediSessionHarness` + `onBridgeTurn` + `onLedgerMirror` fan-out the chat /
	 * MCP turns use, surface-tagged `voice`, so the recap appears in the ledger,
	 * brain bridge, and daily log identically and the NEXT turn sees it as
	 * context. `clientRequestId` makes the runId stable so a redelivered recap
	 * (retry / reconnect) dedups to the same run.
	 */
	async landVoiceRecap(
		this: RuntimeFacetTurnsHost,
		input: {
			sessionKey: string;
			recap: string;
			clientRequestId: string;
		},
	): Promise<{ ok: true; session_key: string; run_id: string }> {
		const recap = input.recap.trim();
		if (!recap) throw new Error("recap is required");
		await this.ensureIdentity();
		const { tediId } = this.state;
		const runId = buildRunId(tediId, input.clientRequestId, "voice");
		await this.acceptRuntimeTurn(runId, input.sessionKey, {
			kind: "voice_recap",
			input,
		});

		const userTurn: RecentTurn = {
			role: "user",
			content: "(live voice call ended)",
			sessionKey: input.sessionKey,
			ts: Date.now(),
		};
		const assistantTurn: RecentTurn = {
			role: "assistant",
			content: recap,
			sessionKey: input.sessionKey,
			ts: Date.now() + 1,
		};

		// Durable, deduped append through the body-neutral harness — same path the
		// chat/MCP turns use, keyed on `{runId}:user` / `{runId}:assistant`.
		await this.sessionHarness.appendTurn(
			input.sessionKey,
			userTurn,
			deriveIdempotencyKey(runId, "user"),
		);
		await this.sessionHarness.appendTurn(
			input.sessionKey,
			assistantTurn,
			deriveIdempotencyKey(runId, "assistant"),
		);

		// Same post-turn fan-out, surface-tagged `voice`. Brain bridge + ledger
		// mirror + daily log + compaction all run off the canonical queue, so the
		// recap is durable proof and feeds memory without an LLM round-trip.
		await this.dispatchTurnMemoryEffects({
			user: userTurn,
			assistant: assistantTurn,
			runId,
			origin: "voice",
			sessionKey: input.sessionKey,
		});
		void this.queue(
			"onLedgerMirror",
			{
				sessionKey: input.sessionKey,
				user: userTurn,
				assistant: assistantTurn,
				runId,
				origin: "voice" as const,
			},
			{ retry: { maxAttempts: 5 } },
		).catch((e) => {
			logTediRuntimeFailure("tedi.runtime.voice_ledger_mirror_queue_failed", e);
		});
		await this.enqueueCompaction(input.sessionKey);

		return { ok: true, session_key: input.sessionKey, run_id: runId };
	},
	/**
	 * The durable turn — the ChatTurnWorkflow's single
	 * execution step for MCP, inject, and delegated work (per-conversation
	 * Pi facet, parent-owned tools via the
	 * per-runId proxy registry, AE `facet_turn` metrics with surface "mcp") and
	 * settles through `commitAssistantTurn` (keyed assistant append, AWAITED
	 * ledger mirror — the kernel-visible run lifecycle delegated turns depend
	 * on — memory effects, final `assistant.done` broadcast).
	 *
	 * Idempotency contract (the workflow step re-drives this on eviction /
	 * deploy collision):
	 *   1. Settled fast-path: the `{runId}:2` assistant row returns immediately
	 *      (redelivery / resume after settlement) — no double turn.
	 *   2. The `{runId}:0` user append is INSERT-OR-IGNORE keyed.
	 *   3. Overlapping retries wait for this run, then re-read its durable result.
	 *      After an isolate reset, recovery still uses the same durable keys.
	 *
	 * A turn error THROWS: the
	 * durable re-drive IS the retry mechanism, and terminal exhaustion seals
	 * the run `failed` via `onWorkflowError` → `mirrorWorkflowFailure`.
	 *
	 * Untrusted-input rule: plain MCP `run_tedi_turn` turns are wrapped.
	 * Home-supervised delegated turns (`workItemId` /
	 * `homeRunId` present) and authenticated instructions loaded from a persisted
	 * cron schedule carry their work order verbatim. The cron provenance is set
	 * only by `onCronFire`, never from an inbound message.
	 */
	async runFacetWorkflowTurn(
		this: RuntimeFacetTurnsHost,
		input: FacetWorkflowTurnInput,
	): Promise<FacetWorkflowTurnResult> {
		return this.facetWorkflowTurns.run(input.runId, () =>
			this.keepAliveWhile(async () => {
				await this.ensureIdentity();
				const readSettled = () =>
					this.sessionRepo.findTurnByIdempotencyKey(
						input.sessionKey,
						deriveIdempotencyKey(input.runId, "assistant"),
					);
				const settled = readSettled();
				if (settled) {
					return {
						text: settled.content,
						stopReason: "settled",
						toolCalls: [],
						...(settled.modelIdentity
							? { modelIdentity: settled.modelIdentity }
							: {}),
					};
				}
				const dispatched = await this.ctx.storage.get<{
					params: ChatTurnParams;
				}>(`runtime-admission-workflow:${input.runId}`);
				if (dispatched) {
					const { computerContinuation: _continuation, ...originalInput } =
						input;
					if (
						JSON.stringify(originalInput) !== JSON.stringify(dispatched.params)
					)
						throw new Error(
							"Native workflow input changed from admitted dispatch",
						);
					await this.assertChatTurnActive(input.runId);
				} else {
					await this.acceptRuntimeTurn(input.runId, input.sessionKey, {
						...input,
						computerContinuation: undefined,
					});
				}
				const computer =
					input.workItemId && input.homeRunId
						? new ComputerWorkflowContinuation(this.ctx.storage)
						: null;
				return withDelegatedWorkLease<FacetWorkflowTurnResult>(
					input,
					{
						storage: this.ctx.storage,
						getClient: () => this.getPlatformClient(),
						tediId: this.state.tediId,
						isSettled: () => Boolean(readSettled()),
						assertActive: () => this.assertChatTurnActive(input.runId),
						arm: () => this.armDelegatedWorkLeaseRenewal(input.runId),
						requireActiveAttempt:
							(input.computerContinuation ?? 0) > 0 ||
							Boolean(computer && (await computer.hasExecutions(input))),
						keepRenewal: (result) =>
							hasPendingComputerExecutions(result) ||
							(result as FacetWorkflowTurnResult).stopReason ===
								"turn_deferred",
					},
					() =>
						this.facetTurnAdmission.run(input.runId, async () => {
							const prepared = await computer?.prepare(
								input,
								this.facetComputerReadDeps(input),
							);
							if (prepared?.cached)
								return this.commitFacetWorkflowSegment(input, prepared.cached);
							return this.runFacetWorkflowTurnImpl(
								input,
								prepared?.completionText,
							);
						}),
				);
			}),
		);
	},
	/**
	 * Arm the durable renewal of this run's Work Attempt.
	 *
	 * The ordinary schedule this DO already uses for Workflow terminality and
	 * detached commands, for the same reason: a timer in the isolate dies with
	 * the isolate, and a delegated turn that goes quiet across an eviction used
	 * to lose its Work authority permanently.
	 */
	async armDelegatedWorkLeaseRenewal(
		this: RuntimeFacetTurnsHost,
		runId: string,
	): Promise<void> {
		await scheduleDelegatedWorkLeaseRenewal(
			runId,
			this.scheduleEvery.bind(this),
		);
	},
	/** The SDK recurs after callback completion; stop the interval when no lease is owed. */
	async onDelegatedWorkLeaseRenewal(
		this: RuntimeFacetTurnsHost,
		input: { runId: string },
		schedule?: { id: string },
	): Promise<void> {
		const retained = await renewDelegatedWorkLease(input.runId, {
			storage: this.ctx.storage,
			getClient: () => this.getPlatformClient(),
			isSettled: (record) =>
				Boolean(
					this.sessionRepo.findTurnByIdempotencyKey(
						record.sessionKey,
						deriveIdempotencyKey(record.runId, "assistant"),
					),
				),
			validateWorkflow: (record) =>
				validateDelegatedWorkLeaseWorkflow(record, {
					storage: this.ctx.storage,
				}),
			observeWorkflow: (record) =>
				observeDelegatedWorkLeaseWorkflow(record, {
					storage: this.ctx.storage,
					reconcile: (workflowInstanceId) =>
						this.reconcileChatWorkflowTerminal({
							workflowInstanceId,
							attempt: 0,
							renewal: true,
						}),
				}),
			assertActive: (runId) => this.assertChatTurnActive(runId),
			cancel: (runId) => this.recordWorkflowCancellation(runId),
			rearm: () => this.armDelegatedWorkLeaseRenewal(input.runId),
		});
		if (!retained && schedule) await this.cancelSchedule(schedule.id);
	},
	facetComputerReadDeps(
		this: RuntimeFacetTurnsHost,
		input: FacetWorkflowTurnInput,
	): ComputerContinuationReadDeps {
		const scope = computerWorkspaceScope(input);
		return {
			selected: async () => ({
				environment: await this.computerEnvironment(scope, input).selected(),
				ownerRunId: await this.ctx.storage.get<string>(
					`computer-environment:${this.computerWorkspace(scope).id}:owner`,
				),
			}),
			read: async (record) =>
				unknownRecord(
					await this.readWorkstationJobTool(
						{ ...record.environment, jobId: record.executionId },
						input,
					),
				) ?? {},
		};
	},
	/** Workflow polling is observation under the original, still-live Attempt. */
	async readFacetComputerExecutions(
		this: RuntimeFacetTurnsHost,
		input: FacetWorkflowTurnInput & { executionIds: string[] },
	): Promise<{ ready: boolean; retryAfterSeconds: number }> {
		return this.keepAliveWhile(async () => {
			await this.ensureIdentity();
			if (!input.workItemId || !input.homeRunId)
				throw new Error(
					"computer_continuation_failed: missing delegated identity",
				);
			return observeComputerWorkflowProgress(input, {
				tediId: this.state.tediId,
				sequence: () => this.stepEventSequence.next(),
				publish: (event) => this.eventOutbox.publish(event),
				read: (observationStarted) =>
					withDelegatedWorkLease(
						input,
						{
							storage: this.ctx.storage,
							getClient: () => this.getPlatformClient(),
							tediId: this.state.tediId,
							isSettled: () => false,
							assertActive: () => this.assertChatTurnActive(input.runId),
							arm: () => this.armDelegatedWorkLeaseRenewal(input.runId),
							requireActiveAttempt: true,
							keepRenewal: () => true,
						},
						() =>
							new ComputerWorkflowContinuation(this.ctx.storage).read(input, {
								...this.facetComputerReadDeps(input),
								observationStarted,
							}),
					),
			});
		});
	},
	/** Only a final segment gets the canonical assistant row and terminal ledger. */
	async commitFacetWorkflowSegment(
		this: RuntimeFacetTurnsHost,
		input: FacetWorkflowTurnInput & { dailyLog?: boolean },
		result: ComputerWorkflowSegmentResult,
	): Promise<FacetWorkflowTurnResult> {
		const commit = async (segment: ComputerWorkflowSegmentResult) => {
			await this.commitAssistantTurn({
				...input,
				assistantText: segment.text,
				stopReason: segment.stopReason,
				toolCalls: segment.toolCalls,
				suppressMemoryEffects: segment.suppressMemoryEffects,
				facetUsage: segment.facetUsage,
				...(segment.modelIdentity && !segment.suppressMemoryEffects
					? { modelIdentity: segment.modelIdentity }
					: {}),
			});
		};
		const segment =
			input.workItemId && input.homeRunId
				? await new ComputerWorkflowContinuation(this.ctx.storage).settle(
						input,
						result,
						commit,
					)
				: (await commit(result), result);
		return {
			text: segment.text,
			stopReason: segment.stopReason,
			toolCalls: segment.toolCalls,
			...(segment.pendingComputerExecutions
				? { pendingComputerExecutions: segment.pendingComputerExecutions }
				: {}),
		};
	},
	async runFacetWorkflowTurnImpl(
		this: RuntimeFacetTurnsHost,
		input: FacetWorkflowTurnInput,
		completionText?: string,
	): Promise<FacetWorkflowTurnResult> {
		await this.ensureIdentity();
		if (!isBlindVerificationSession(input.sessionKey)) {
			await this.ensureModelPolicy();
		}

		this.logDanglingTurnIfAny(input.sessionKey, "facetWorkflowTurn");

		// (2) Idempotent user append keyed `{runId}:0` (INSERT-OR-IGNORE).
		await this.sessionHarness.appendTurn(
			input.sessionKey,
			{
				role: "user",
				content: input.userText,
				sessionKey: input.sessionKey,
				ts: input.userTs,
			},
			deriveIdempotencyKey(input.runId, "user"),
		);

		// Blind evidence turns must stay on the dedicated, tool-free judge facet
		// even when `run_tedi_turn` is wrapped in ChatTurnWorkflow. The durable
		// cutover previously fell through to prepareMcpFacetTurn + ConversationFacet,
		// silently exposing the general tool surface and bypassing the pinned judge
		// model. Settle through the shared commit path so model identity survives
		// workflow completion, eviction, and idempotent redelivery.
		if (isBlindVerificationSession(input.sessionKey)) {
			const judge = await this.runJudgeFacetTurn({
				runId: input.runId,
				sessionKey: input.sessionKey,
				guardedUserText: wrapUntrustedInput(input.userText, "mcp"),
				userTs: input.userTs,
			});
			if (judge.turnError) throw new Error(judge.turnError);
			const assistantText = judge.assistantText.trim();
			if (!assistantText) throw new Error("empty_assistant_message");
			if (!judge.modelIdentity) {
				throw new Error("judge turn completed without model identity");
			}
			await this.commitAssistantTurn({
				sessionKey: input.sessionKey,
				runId: input.runId,
				traceId: input.traceId,
				conversationId: input.conversationId,
				userTs: input.userTs,
				userText: input.userText,
				assistantText,
				stopReason: "stop",
				toolCalls: [],
				clientRequestId: input.clientRequestId,
				learningMode: input.learningMode,
				modelIdentity: judge.modelIdentity,
			});
			return {
				text: assistantText,
				stopReason: "stop",
				toolCalls: [],
				modelIdentity: judge.modelIdentity,
			};
		}

		if (isWorkflowSynthesisSession(input.sessionKey)) {
			const synthesis = await this.runSynthesisFacetTurn({
				sessionKey: input.sessionKey,
				guardedUserText: wrapUntrustedInput(input.userText, "mcp"),
				runId: input.runId,
			});
			if (synthesis.turnError) throw new Error(synthesis.turnError);
			const assistantText = synthesis.assistantText.trim();
			if (!assistantText) throw new Error("empty_assistant_message");
			await this.commitAssistantTurn({
				sessionKey: input.sessionKey,
				runId: input.runId,
				traceId: input.traceId,
				conversationId: input.conversationId,
				userTs: input.userTs,
				userText: input.userText,
				assistantText,
				stopReason: "stop",
				toolCalls: [],
				clientRequestId: input.clientRequestId,
				learningMode: input.learningMode,
				...(synthesis.usage ? { facetUsage: synthesis.usage } : {}),
				modelIdentity: synthesis.modelIdentity,
			});
			return {
				text: assistantText,
				stopReason: "stop",
				toolCalls: [],
				modelIdentity: synthesis.modelIdentity,
			};
		}

		const modelUserText = completionText
			? `${input.userText}\n\n${completionText}`
			: input.userText;
		const trust = mcpTurnSurfaceTrust(input);
		const setup = await this.prepareMcpFacetTurn({
			noFunds: input.noFunds,
			sessionKey: input.sessionKey,
			userMessage: modelUserText,
			trust,
			conversationId: input.conversationId,
			runId: input.runId,
			traceId: input.traceId,
			workItemId: input.workItemId,
			homeRunId: input.homeRunId,
			personalRequest: input.personalRequest,
			executionSurface: input.executionSurface,
			repositoryMode: input.repositoryMode,
			authorityEnvelope: input.authorityEnvelope,
			capabilityPlan: input.capabilityPlan,
			authorityMode: input.authorityMode,
			operatorConsent: input.operatorConsent,
		});
		const isCronTurn = input.trustedInstructionOrigin === "cron";
		const budgetClass = facetTurnBudgetClass(input);
		const isWakeTurn = budgetClass === "wake";
		const isMaintenanceCycle = budgetClass === "maintenance_cycle";
		const isComputerExecutionWake =
			input.trustedInstructionOrigin === "computer_execution";
		const isTrustedInstruction =
			!isComputerExecutionWake &&
			(Boolean(input.workItemId || input.homeRunId) ||
				input.trustedInstructionOrigin === "cron");
		// The runtime authored the completion notification, not the command output
		// embedded in it. Fence the entire wake so stdout/stderr cannot impersonate
		// an operator instruction while its execution metadata remains available.
		const guardedUserText = isTrustedInstruction
			? modelUserText
			: wrapUntrustedInput(
					modelUserText,
					isComputerExecutionWake ? "computer_execution" : "mcp",
				);

		if (setup.turnBinding) this.activeTurnBinding = setup.turnBinding;
		let facetTurn: {
			assistantText: string;
			turnError: string | null;
			modelIdentity?: TediSessionModelIdentity;
			usage?: FacetTurnUsage;
			stopReason?: FacetBudgetStopReason;
		};
		try {
			facetTurn = await this.runConversationFacetTurn({
				admissionClass: inferenceBudgetAdmissionClass(input),
				freshHistory: isCronTurn,
				durableSubmissionId: `${input.runId}:segment:${input.computerContinuation ?? 0}`,
				guardedUserText,
				...(input.imageRefs?.length ? { imageRefs: input.imageRefs } : {}),
				...(input.workItemId ? { workItemId: input.workItemId } : {}),
				// (c) TIMEOUT: a cron cognitive cycle runs as ONE durable Workflow step
				// bounded by Cloudflare's 10-minute wall clock. The interactive step
				// ceiling (40) let the heavy consolidation / grounding-review Code Mode
				// loop iterate long enough to blow it (`Execution timed out after
				// 600000ms` → lastSuccess:false). Cron turns run under a tighter round
				// cap so no single durable step exceeds the limit; the cron deliverable
				// is bounded tool work + ledger stamps, not exhaustive iteration.
				maxSteps: isMaintenanceCycle
					? cronTurnMaxSteps(this.effectiveStepCeiling())
					: isWakeTurn
						? wakeTurnMaxSteps(this.effectiveStepCeiling())
						: this.effectiveStepCeiling(),
				// The cheap cron model belongs to the MAINTENANCE cycle only. A wake
				// turn is real Work Item execution (repo, workspace, browser) on the
				// background lane — cheapening it re-creates the zero-evidence wakes
				// the wake/maintenance split exists to prevent.
				modelSurface: isMaintenanceCycle ? "cron" : "chat",
				...(input.turnModel && !isMaintenanceCycle
					? { turnModel: input.turnModel }
					: {}),
				runId: input.runId,
				sessionKey: input.sessionKey,
				surface: "mcp",
				system: setup.system,
				tools: isMaintenanceCycle
					? cronFacetToolSurface(setup.tools)
					: setup.tools,
				authorityEnvelope: input.authorityEnvelope,
				authorityMode: input.authorityMode,
				delegated: Boolean(input.workItemId && input.homeRunId),
				delegationBudget: input.delegationBudget,
				userTs: input.userTs,
			});
		} finally {
			try {
				this.mcpRuntime?.clearTurn();
			} catch {
				/* defensive */
			}
			if (this.activeTurnBinding === setup.turnBinding) {
				this.clearActiveTurn();
			}
		}

		const assistantText = facetTurn.assistantText.trim();
		// Maintenance delivers tool effects, so missing prose alone is success.
		// Fail-soft tool errors never reach turnError; inspect the durable tool
		// buffer to keep failed maintenance from sealing success. Work Item
		// reviews retain their independent verdict instead of replaying rejected
		// evidence as failed maintenance. Work wakes and user turns still require
		// prose, and genuine stream failures retain bounded recovery.
		const pendingComputer = Boolean(
			input.workItemId &&
			input.homeRunId &&
			(await new ComputerWorkflowContinuation(this.ctx.storage).hasExecutions(
				input,
			)),
		);
		const failureReason = facetTurnFailureReason({
			turnError: facetTurn.turnError,
			assistantText:
				assistantText ||
				(canWaitWithoutAssistant({
					failureReason: "empty_assistant_message",
					turnError: facetTurn.turnError,
					pendingComputer,
				})
					? "Waiting for the existing native command."
					: ""),
			isCronTurn: isMaintenanceCycle,
			workItemId: input.workItemId,
			hadToolError: isMaintenanceCycle
				? this.runHadFacetToolError(input.runId)
				: false,
		});
		if (failureReason) {
			// Workflow classifies deterministic failures before retrying transients.
			if (input.workItemId && input.homeRunId)
				await new ComputerWorkflowContinuation(this.ctx.storage).recordFailure(
					input,
					failureReason,
				);
			throw new Error(failureReason);
		}
		// A cron turn with no prose commits a synthetic terminal note purely so
		// the named execution seals SUCCESS (ledger mirror + run lifecycle). That
		// placeholder is NOT genuine assistant cognition, so its commit must
		// suppress the memory/brain/daily-log/learning fan-out — otherwise
		// the identical string accumulates in the very stores these crons curate.
		const isSyntheticTerminalNote = !assistantText;
		const committedAssistantText =
			assistantText ||
			(pendingComputer
				? "Waiting for the existing native command."
				: "Cron maintenance cycle completed (tool work only, no assistant reply).");

		// A budget-gated turn settles NORMALLY (partial output + notice text)
		// under a distinct stopReason — a durable record that the loop was cut
		// by the mid-turn budget gate, not a model stop. Deliberately NOT a
		// throw: re-driving an over-budget turn would burn admission on every
		// Workflow retry while the budget stays exhausted.
		const settledStopReason = facetTurn.stopReason ?? "stop";
		const toolCalls = facetToolCallOutcomes(
			this.peekPendingToolSteps(input.runId),
		);

		return this.commitFacetWorkflowSegment(
			{ ...input, ...trustedTurnMemoryEffects(trust) },
			{
				text: committedAssistantText,
				stopReason: settledStopReason,
				toolCalls,
				suppressMemoryEffects: isSyntheticTerminalNote,
				...(input.workItemId &&
				input.homeRunId &&
				!isSyntheticTerminalNote &&
				facetTurn.modelIdentity
					? { modelIdentity: facetTurn.modelIdentity }
					: {}),
				...(facetTurn.usage ? { facetUsage: facetTurn.usage } : {}),
			},
		);
	},
	/**
	 * Persist the assistant turn produced by the workflow + schedule all
	 * post-turn bridges (ledger mirror, brain/rationale, daily-log buffer)
	 * and broadcast the final `assistant.done` event.
	 *
	 * Idempotent — guarded by `runId`. If `commitAssistantTurn` runs twice
	 * (workflow resume after a partial failure between this checkpoint and
	 * the final `return`), the second call sees the assistant turn already
	 * in `recentTurns` and skips the side effects.
	 */
	async commitAssistantTurn(
		this: RuntimeFacetTurnsHost,
		input: {
			sessionKey: string;
			runId: string;
			traceId?: string;
			conversationId: string;
			userTs: number;
			userText: string;
			assistantText: string;
			stopReason: string;
			toolCalls: Array<{ name: string; ok: boolean }>;
			durableCodePause?: DurableCodePause;
			clientRequestId?: string;
			learningMode?: AdaptiveLearningMode;
			/** Home Work Item served by this delegated turn, when present. */
			workItemId?: string;
			/**
			 * Skip the cognitive-store fan-out (brain bridge, daily narrative
			 * log, learning-conversion signal) for this commit. Set ONLY when
			 * `assistantText` is a synthetic terminal placeholder — a no-prose cron
			 * turn whose deliverable is its Code Mode tool work, not the boilerplate
			 * note. The ledger mirror (kernel-visible run lifecycle / cron success
			 * seal) and session append still run; only the memory/brain/daily-log
			 * curation surfaces — the exact stores these cognitive crons exist to
			 * tend — are spared the identical placeholder string on every fire.
			 */
			suppressMemoryEffects?: boolean;
			/** False keeps an unverified turn out of the daily log. */
			dailyLog?: boolean;
			/** Facet-reported turn token usage (null-absent), forwarded to the ledger
			 * mirror so a durable facet turn's `run.completed.tokensUsed` is not dark. */
			facetUsage?: FacetTurnUsage;
			/** Actual verifier provider/model; persisted on blind judge assistant rows. */
			modelIdentity?: TediSessionModelIdentity;
		},
	): Promise<void> {
		// keepAlive across the post-turn bridge fetches (ledger mirror + brain /
		// rationale HTTP + Workers AI observer) this step makes inside the DO, so a
		// cold DO is not idle-evicted mid-fetch (the runtime_dropped cause).
		return this.keepAliveWhile(() => this.commitAssistantTurnImpl(input));
	},
	async commitAssistantTurnImpl(
		this: RuntimeFacetTurnsHost,
		input: {
			sessionKey: string;
			runId: string;
			traceId?: string;
			conversationId: string;
			userTs: number;
			userText: string;
			assistantText: string;
			stopReason: string;
			toolCalls: Array<{ name: string; ok: boolean }>;
			durableCodePause?: DurableCodePause;
			clientRequestId?: string;
			learningMode?: AdaptiveLearningMode;
			workItemId?: string;
			suppressMemoryEffects?: boolean;
			dailyLog?: boolean;
			facetUsage?: FacetTurnUsage;
			modelIdentity?: TediSessionModelIdentity;
		},
	): Promise<void> {
		await this.ensureIdentity();
		// Final durable cancel fence. Native Workflow termination is best-effort
		// with respect to an already-running DO RPC; if the facet returns after the
		// operator canceled, the tombstone must win before any assistant row,
		// `assistant.done`, or `run.completed` ledger event is materialized.
		if (await this.isWorkflowRunCanceled(input.runId)) {
			console.info(
				`[isolate.workflow] suppressed assistant settlement for canceled run ${input.runId}`,
			);
			return;
		}
		const assistantTurn: RecentTurn = {
			role: "assistant",
			content: input.assistantText,
			sessionKey: input.sessionKey,
			ts: Date.now(),
			...(input.modelIdentity ? { modelIdentity: input.modelIdentity } : {}),
		};
		const userTurn: RecentTurn = {
			role: "user",
			content: input.userText,
			sessionKey: input.sessionKey,
			ts: input.userTs,
		};
		// Stage 3: keyed idempotent commit. The assistant turn is keyed on the
		// deterministic `{runId}:2` (the workflow's stable per-turn runId), so a
		// workflow resume between this checkpoint and the final `return` re-runs as
		// a NO-OP. The returned boolean IS the dedup signal — replaces the old
		// SCAN-based `alreadyCommitted` `.some(listTurns())` check. `false` ⇒
		// already committed ⇒ skip the once-per-turn daily-log enqueue below. The
		// ledger/brain fan-out is NOT gated (its own `{runId}:{seq}` event-id /
		// content-hash dedup makes a re-queue harmless), matching prior behavior.
		const inserted = await this.sessionHarness.appendTurn(
			input.sessionKey,
			assistantTurn,
			deriveIdempotencyKey(input.runId, "assistant"),
		);

		// Broadcast the final frame to all connected WS clients.
		try {
			this.broadcast(
				JSON.stringify(
					workflowEvent(
						"assistant.done",
						{
							stream: "assistant",
							data: {
								text: input.assistantText,
								stopReason: input.stopReason,
							},
							runId: input.runId,
						},
						0,
					),
				),
			);
		} catch {
			/* no connections — fine */
		}

		// Clear MCP runtime per-turn binding.
		try {
			this.mcpRuntime?.clearTurn();
		} catch {
			/* defensive */
		}

		// Surface tag: the runId already encodes its body-neutral surface
		// (`chat` | `mcp`, or a legacy `isolate` tag on pre-rename chains). Read it
		// back VERBATIM via parseRunSurface so the mirror reconstructs the exact
		// runId — `{runId}:{seq}` event-id dedup stays stable across the rename.
		// Computed before the bridge queue too, so the bridge's trace-bundle
		// emission builds the SAME runId the mirror does.
		const origin = parseRunSurface(input.runId);
		// WS1: capture the run's tool-call refs BEFORE the ledger mirror — the
		// trace-bundle writer inside it consumes the per-run step buffer
		// (`takePendingToolSteps`), so reading after would always be empty.
		const toolCallRefs = this.toolCallRefsForRun(input.runId);
		const executionEvidence = this.toolExecutionEvidenceForRun(input.runId);
		// Post-turn bridges. commitAssistantTurn runs as a ChatTurnWorkflow RPC
		// callback, where Agent.queue()'s fire-and-forget flush does NOT drain
		// before the callback returns — so queued ledger/bridge work was stranded
		// and the kernel never saw a delegated turn's events (run.started/completed),
		// orphan-failing the parent even though the workflow turn succeeded. Call the
		// handlers DIRECTLY (awaited) so they run synchronously within the commit.
		// Ledger mirror first — it carries the kernel-visible run lifecycle.

		// A synthetic no-prose cron commit carries no genuine assistant
		// cognition — the Code Mode tool work already wrote its own memory/skill
		// effects during the facet turn. Fanning the identical placeholder note
		// into the brain bridge, daily narrative log, and learning-conversion
		// signal on every fire would seed those curation stores with hundreds of
		// duplicate boilerplate turns (each fire has a distinct runId, so no
		// dedup fires) — polluting the exact surfaces these cognitive crons tend,
		// and inflating the learning-conversion metric with an artifact. The
		// ledger mirror (above) still seals the kernel-visible run lifecycle.
		if (!input.suppressMemoryEffects) {
			await this.dispatchTurnMemoryEffects({
				user: userTurn,
				assistant: assistantTurn,
				runId: input.runId,
				origin,
				sessionKey: input.sessionKey,
				...(input.workItemId ? { workItemId: input.workItemId } : {}),
				toolCallRefs,
				executionEvidence,
				learningMode:
					input.learningMode ??
					adaptiveLearningModeForTurn({
						userText: input.userText,
						assistantText: input.assistantText,
					}),
				awaitBridge: true,
				dailyLog: inserted && input.dailyLog !== false,
			});
		}
		try {
			await this.onLedgerMirror({
				sessionKey: input.sessionKey,
				user: userTurn,
				assistant: assistantTurn,
				runId: input.runId,
				traceId: input.traceId,
				origin,
				stopReason: input.stopReason,
				durableCodePause: input.durableCodePause,
				...(input.facetUsage ? { facetUsage: input.facetUsage } : {}),
			});
		} catch (e) {
			logTediRuntimeFailure("tedi.runtime.workflow_ledger_mirror_failed", e);
			if (this.runtimeAdmission()) throw e;
		}
		if (inserted) {
			// Stage 3: trigger best-effort compaction after a genuine commit.
			await this.enqueueCompaction(input.sessionKey);
		}
	},
};
