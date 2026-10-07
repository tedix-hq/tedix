import { recoverDurableObjectDeploymentReset } from "./durable-object-recovery";
import { classifyTediContextOverflow } from "./context-overflow";
import { resolveModelInputBudgetTokens } from "./model-input-budget";
import type { ModelGenerationSettings } from "@tedix/api-contract/schemas/model-generation";
import type { AdaptiveRoutingContext } from "@tedix/api-contract/schemas/model-catalog";
import type { TurnImagePart } from "@tedix/voice/stt";
import {
	createModels,
	type Api,
	type Model,
	type TSchema,
	type Message,
} from "@earendil-works/pi-ai";
import {
	defineTask,
	hook,
	GenerationTask,
	ToolTask,
	CompactionTask,
	type Extension,
	type AgentChange,
	type ToolRegistration,
	type ToolExecutionResult,
	type HookApi,
	type TaskId,
	type EntryRecord,
	LiveDoc,
} from "@earendil-works/pi-durable";
import type { SessionMessage } from "agents/sessions";
import {
	conversationCompactionSettings,
	summarizeContextEntries,
} from "./pi-compaction";
import { admitTediNativeRecovery } from "./pi-recovery";
import { invalidateReadEvidence } from "./read-evidence";
import { PiAgent, PiImageBridge } from "./pi-agent";
import type { PiApplicationProjection, PiContext } from "./pi-types";
import {
	createTedixPiProvider,
	piToSdkPrompt,
	type TedixSdkModel,
	governedPiCompactionCompletion,
	estimateSdkPromptTokens,
} from "./pi-model";
import {
	sessionUserInput,
	legacySessionMessages,
	createPiEventProjection,
} from "./pi-agent";
import { PiTurnAccounting } from "./pi-turn-accounting";
import {
	configureFacetGeneration,
	resolveFacetGeneration,
} from "./facet-generation-settings";
import { type FacetToolDescriptor } from "./facet-tool-descriptors";
import {
	workflowImageUri,
	type WorkflowImageRef,
} from "./workflow-image-handoff";
import { selectChatModelForTurn } from "./turn-model-selection";
import {
	attributableConversationModel,
	type SelectedConversationModelIdentity,
} from "./turn-model-attribution";
import { FacetTurnGate } from "./facet-turn-gate";
import { assertFacetToolRegistryAvailable } from "./facet-turn-guard";
import { type AigMetadata, type AzureChatEnv } from "./llm";
import { type FacetTurnUsage, shapeStepTelemetry } from "./step-telemetry";
import {
	resolveFacetStepCeiling,
	accountingStepPolicy,
	stoppedTurnNotice,
	reservedFinalStepConfig,
	finalReportInstruction,
} from "./facet-turn-stop";
import { promptCacheKey, explicitPromptCacheConfig } from "./prompt-cache";
import { codeModeToolModelOutput } from "./codemode-model-output";
import { computerReadToolModelOutput } from "./computer-read-model-output";
import { computerExecutionModelOutput } from "./computer-execution-model-output";

export interface ConversationFacetState {
	/** Authenticated parent-stamped transport identity; never a model/tool authority grant. */
	turnMetadata?: Record<string, unknown> | null;
	/** Parent-stamped full system prompt (persona + addenda + MCP notes). */
	system: string | null;
	/** Stable parent-owned persona prefix eligible for provider prompt caching. */
	stableSystemPrefix?: string | null;
	/** Opaque tenant+tedi+surface+prefix cache namespace. */
	promptCacheKey?: string | null;
	/** Parent-stamped per-role model ref (modelPolicy.chatModelRef). */
	modelRef: string | null;
	observerModelRef?: string | null;
	observerDeployment?: string | null;
	/**
	 * Server-derived facts authorizing adaptive routing for this exact turn.
	 * Null is a denial and is deliberately persisted so a later ineligible turn
	 * cannot inherit a prior maintenance cycle's authority after hibernation.
	 */
	adaptiveRouting: AdaptiveRoutingContext | null;
	/** Parent-stamped AI Gateway attribution, persisted across facet eviction. */
	aigMetadata: AigMetadata | null;
	/** Session key this facet serves (facet name is its sanitized form). */
	sessionKey: string | null;
	/**
	 * Active turn's runId — the key into the parent's per-turn tool registry.
	 * Stamped per turn; a tool proxy call outside a live parent registry entry
	 * (e.g. after a parent eviction) interrupts until the parent rebuilds it.
	 */
	runId: string | null;
	/** Persisted stop fence: a restart must not erase a budget/step stop. */
	recoveryBlockedRunId?: string | null;
	/** Cleared only when the parent deliberately rebuilds the tool registry. */
	toolRegistryUnavailableRunId?: string | null;
	/** Parent loop-policy step ceiling for this turn (null → no step-count stop;
	 * the turn is bounded by wall clock and the daily budget only). */
	maxSteps: number | null;
	/** Optional surface-specific response ceiling (null → full facet allowance). */
	maxOutputTokens?: number | null;
	/** Optional surface-specific reasoning effort. */
	reasoning?: ModelGenerationSettings["reasoningEffort"] | null;
	generation?: ModelGenerationSettings;
	/** The turn's tool surface, persisted so getTools() survives eviction. */
	toolDescriptors: FacetToolDescriptor[];
	/** Completed turns on this facet (identity across hibernation). */
	turnCount: number;
	selectedTurnModels?: SelectedConversationModelIdentity[];
	finalReportStop?: { reason: string } | null;
	budgetStop?: { kind: FacetBudgetStopReason; reason: string } | null;
	imageRefs?: WorkflowImageRef[];
}

/** Why a facet turn's loop was stopped early by the mid-turn budget gate. */
export type FacetBudgetStopReason = "budget_exhausted" | "step_ceiling";

export interface ConversationFacetTurnResult {
	assistantText: string;
	/** Present only when all model rounds producing fresh text agree. */
	modelIdentity?: SelectedConversationModelIdentity;
	requestId: string | null;
	turnCount: number;
	/** Total wall-clock inside the facet for this turn. */
	turnMs: number;
	/** Present when the mid-turn budget gate stopped the loop early (the daily
	 * token budget was exhausted mid-turn, or the absolute per-turn
	 * provider-call ceiling fired). The turn still settles normally with a
	 * clear notice appended to the assistant text. */
	stopReason?: FacetBudgetStopReason;
	/**
	 * Aggregate model-reported token usage for the turn, summed across the
	 * facet's native Pi provider calls (persisted in the run accounting journal).
	 * Absent when any attempt lacks measured usage (null-absent) so the parent's ledger
	 * mirror falls back to its own step buffer rather than fabricating a zero.
	 */
	usage?: FacetTurnUsage;
}

export interface ConversationTurnConfiguration {
	turnMetadata?: Record<string, unknown> | null;
	system: string;
	stableSystemPrefix?: string | null;
	promptCacheSurface?: string | null;
	modelRef: string | null;
	observerModelRef?: string | null;
	observerDeployment?: string | null;
	adaptiveRouting?: AdaptiveRoutingContext | null;
	aigMetadata: AigMetadata;
	sessionKey: string;
	runId: string;
	maxSteps: number | null;
	maxOutputTokens?: number | null;
	reasoning?: ModelGenerationSettings["reasoningEffort"] | null;
	generation?: ModelGenerationSettings;
	toolDescriptors: FacetToolDescriptor[];
}

export interface ConfiguredConversationTurn {
	originalUiMessage?: SessionMessage;
	regenerationOf?: string;
	configuration: ConversationTurnConfiguration;
	text: string;
	firstTurnText?: string;
	images?: TurnImagePart[];
	imageRefs?: WorkflowImageRef[];
	freshHistory?: boolean;
	durableSubmissionId?: string;
}

interface PendingFacetSubmission {
	originalUiMessage?: SessionMessage;
	configuration: ConversationTurnConfiguration;
	submissionId: string;
	priorTurnCount: number;
	turnInput: {
		text: string;
		imageRefs?: WorkflowImageRef[];
		images?: TurnImagePart[];
	};
}

const FALLBACK_SYSTEM =
	"You are a Tedix digital worker. Answer the message directly and concisely.";
const EMPTY_STATE: ConversationFacetState = {
	system: null,
	modelRef: null,
	adaptiveRouting: null,
	aigMetadata: null,
	sessionKey: null,
	runId: null,
	maxSteps: null,
	toolDescriptors: [],
	turnCount: 0,
};
const PI_MODEL: Model<Api> = {
	id: "selected",
	name: "Tedix governed selection",
	provider: "tedix",
	api: "tedix-ai-sdk",
	baseUrl: "",
	input: ["text", "image"],
	reasoning: true,
	contextWindow: 128000,
	maxTokens: 16000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export type ConversationParentPort = Pick<
	import("./do").AgentTediDO,
	| "reconcileFacetToolEffect"
	| "assertChatTurnActive"
	| "reservePiStep"
	| "recordPiStep"
	| "enrollFacetDispatchRun"
	| "recordFacetModelStep"
	| "executeFacetTool"
	| "checkFacetTurnBudget"
>;

export class ConversationFacet extends PiAgent<
	Cloudflare.Env,
	ConversationFacetState
> {
	initialState = EMPTY_STATE;
	protected override facetAdmissionClassName(): string | null {
		return "ConversationFacet";
	}
	private readonly configuredTurnGate = new FacetTurnGate();
	private selected?: ReturnType<ConversationFacet["selectModelForTurn"]>;
	private readonly accounting = new PiTurnAccounting(this.ctx.storage, {
		reconcileEffect: async (runId, toolCallId) =>
			(await this.parent()).reconcileFacetToolEffect(runId, toolCallId),
		assertActive: async (runId) =>
			(await this.parent()).assertChatTurnActive(runId),
		reserveStep: async (input) => (await this.parent()).reservePiStep(input),
		recordStep: async (input) => (await this.parent()).recordPiStep(input),
	});
	private readonly nativeInstanceId = crypto.randomUUID();
	private readonly admittedResumptions = new Set<number>();
	private async admitResumedNativeTask(
		api: HookApi,
		context: PiContext,
	): Promise<void> {
		const original = await api.memo<string>(
			"tedix-task-origin-instance",
			context,
		);
		if (original === undefined) {
			await api.memo<string>(
				"tedix-task-origin-instance",
				this.nativeInstanceId,
				context,
			);
			return;
		}
		if (
			original === this.nativeInstanceId ||
			this.admittedResumptions.has(api.taskId)
		)
			return;
		const runId = this.requireRunId();
		const createdAt = await this.ctx.storage.transaction(async (tx) => {
			const key = `pi-recovery-incident-created:v1:${runId}`;
			const known = await tx.get<number>(key);
			if (known !== undefined) return known;
			const value = Date.now();
			await tx.put(key, value);
			return value;
		});
		const conversation = await this.nativeConversation();
		const view = await conversation.context(context);
		const live = await (
			await this.piHarness.pi()
		).snapshot(LiveDoc, conversation.id, context);
		const progress = JSON.stringify({
			entries: view.entries
				.filter((entry) =>
					entry.model?.some((message) => message.role !== "system"),
				)
				.map((entry) => entry.id),
			partial: live?.generation?.message?.content ?? [],
			tools:
				live?.tools?.map((tool) => ({
					id: tool.callId,
					entry: tool.entry ?? null,
					output: tool.output ?? null,
				})) ?? [],
		});
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(progress),
		);
		const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const cold = await this.ctx.storage.transaction(async (tx) => {
			const key = `pi-cold-resume-budget:v1:${runId}:${api.taskId}`;
			const prior = await tx.get<{ progress: string; count: number }>(key);
			const count = prior?.progress === fingerprint ? prior.count + 1 : 1;
			if (count > 3) return false;
			await tx.put(key, { progress: fingerprint, count });
			return true;
		});
		if (!cold) {
			this.setState({ ...this.state, recoveryBlockedRunId: runId });
			throw new Error(
				"Native recovery stopped: fourth cold resume without real progress; partial state retained",
			);
		}
		const admission = await admitTediNativeRecovery(
			this.ctx.storage,
			runId,
			{ createdAt, progress: fingerprint },
			async () => {
				try {
					this.assertToolRegistryAvailable();
					await (await this.parent()).assertChatTurnActive(runId);
					return true;
				} catch {
					return false;
				}
			},
		);
		if (!admission.allowed) {
			this.setState({ ...this.state, recoveryBlockedRunId: runId });
			throw new Error(
				`Native recovery stopped: ${admission.reason}; partial state retained`,
			);
		}
		this.admittedResumptions.add(api.taskId);
	}
	protected async parent(): Promise<ConversationParentPort> {
		const { AgentTediDO } = await import("./do");
		return this.parentAgent(AgentTediDO);
	}
	protected override normalizedFacetWireConfiguration(
		configuration: Record<string, unknown>,
	): Record<string, unknown> {
		const input = configuration as unknown as ConversationTurnConfiguration;
		return {
			...configuration,
			stableSystemPrefix:
				input.stableSystemPrefix &&
				input.system.startsWith(input.stableSystemPrefix)
					? input.stableSystemPrefix
					: null,
			adaptiveRouting: input.adaptiveRouting ?? null,
			observerModelRef: input.observerModelRef ?? null,
			observerDeployment: input.observerDeployment ?? null,
			turnMetadata: input.turnMetadata ?? null,
			generation: configureFacetGeneration({ runId: null }, input),
		};
	}
	protected selectModelForTurn(): {
		model: TedixSdkModel;
		identity: SelectedConversationModelIdentity;
	} {
		const selected = selectChatModelForTurn(
			this.env as unknown as AzureChatEnv,
			this.state.modelRef ? { modelRef: this.state.modelRef } : null,
			this.state.aigMetadata ?? undefined,
			undefined,
			this.state.adaptiveRouting,
			this.facetBeforeDispatch(),
			this.state.promptCacheKey,
		);
		return {
			model: selected.model as TedixSdkModel,
			identity: selected.identity,
		};
	}
	protected summarizeCompaction(
		messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
		context: PiContext,
	): Promise<string | null> {
		const completion = governedPiCompactionCompletion({
			model: PI_MODEL,
			accounting: this.accounting,
			runId: () => this.requireRunId(),
			assertReady: async () => {
				await this.assertFacetRuntimeDispatch();
				this.assertToolRegistryAvailable();
				context.abortSignal?.throwIfAborted();
				await (await this.parent()).assertChatTurnActive(this.requireRunId());
			},
			resolveSdkModel: (options) =>
				selectChatModelForTurn(
					{
						...this.env,
						AZURE_CHAT_DEPLOYMENT:
							options.deployment ?? this.env.AZURE_OBSERVER_DEPLOYMENT,
					},
					options.modelRef ? { modelRef: options.modelRef } : null,
					options.metadata,
					undefined,
					undefined,
					this.facetBeforeDispatch(),
				).model as TedixSdkModel,
		});
		return summarizeContextEntries(
			this.env,
			messages,
			undefined,
			{ ...this.state.aigMetadata, source: "observer:session-compaction" },
			{
				modelRef: this.state.observerModelRef ?? undefined,
				deployment: this.state.observerDeployment ?? undefined,
			},
			(options) => completion({ ...options, signal: context.abortSignal }),
		);
	}
	protected projection(): PiApplicationProjection {
		const models = createModels();
		models.setProvider(
			createTedixPiProvider({
				catalog: () => [this.selectedPiModel()],
				resolveModel: () => {
					this.selected = this.selectModelForTurn();
					this.setState({
						...this.state,
						selectedTurnModels: [
							...(this.state.selectedTurnModels ?? []),
							this.selected.identity,
						],
					});
					return this.selected.model as TedixSdkModel;
				},
				prepare: async (_model, context) => {
					const runId = this.requireRunId();
					await this.assertFacetRuntimeDispatch();
					this.assertToolRegistryAvailable();
					if (
						this.state.recoveryBlockedRunId === runId &&
						!this.state.finalReportStop
					)
						throw new Error("Stopped Pi run cannot infer");
					await this.accounting.begin(runId);
					await this.accounting.reconcileEffects(runId);
					const augmentedMessages = await this.compactedModelMessages(
						context.messages,
					);
					const selected = this.selected;
					if (!selected) throw new Error("Pi dispatch has no selected model");
					const generation = resolveFacetGeneration(
						selected.identity,
						this.state.generation ?? {},
						{
							...(this.state.maxOutputTokens == null
								? {}
								: { maxOutputTokens: this.state.maxOutputTokens }),
							...(this.state.reasoning == null
								? {}
								: { reasoningEffort: this.state.reasoning }),
						},
					);
					const translated = piToSdkPrompt(augmentedMessages);
					await this.imageBridge().expand(
						translated.prompt,
						(this.state.imageRefs ?? []).map(workflowImageUri),
					);
					const prompt = [...translated.prompt];
					const ordinal = await this.accounting.prepareStep(
						{
							messages: prompt,
							estimatedTokens: estimateSdkPromptTokens(prompt),
						},
						this.state.finalReportStop
							? {}
							: accountingStepPolicy(
									resolveFacetStepCeiling(this.state.maxSteps),
								),
					);
					const providerAttempt =
						await this.accounting.captureProviderAttempt();
					const cache = explicitPromptCacheConfig({
						provider: selected.identity.provider,
						model: selected.identity.model,
						system: this.state.system ?? FALLBACK_SYSTEM,
						stableSystemPrefix: this.state.stableSystemPrefix ?? null,
						cacheKey: this.state.promptCacheKey ?? null,
					});
					// The provider bridge owns lower-level wire options. Exact cache instruction
					// blocks need its instructions->provider prompt adapter before enabling cache.
					if (cache) {
						const systemIndex = prompt.findIndex(
							(message) => message.role === "system",
						);
						if (systemIndex < 0)
							throw new Error(
								"Pi cache prompt lacks native system instructions",
							);
						const nativeSystem = prompt[systemIndex];
						if (
							!nativeSystem ||
							nativeSystem.role !== "system" ||
							typeof nativeSystem.content !== "string"
						)
							throw new Error("Invalid native Pi system prompt");
						const source = this.state.system ?? FALLBACK_SYSTEM;
						const offset = nativeSystem.content.indexOf(source);
						if (
							offset < 0 ||
							nativeSystem.content.indexOf(source, offset + source.length) >= 0
						)
							throw new Error("Pi cache prefix is not uniquely parent-owned");
						const before = nativeSystem.content.slice(0, offset),
							after = nativeSystem.content.slice(offset + source.length);
						prompt.splice(
							systemIndex,
							1,
							...(before ? [{ role: "system" as const, content: before }] : []),
							...cache.instructions.map((message) => ({
								role: "system" as const,
								content: message.content,
								...(message.providerOptions
									? {
											providerOptions: {
												azure: { promptCacheBreakpoint: { mode: "explicit" } },
											},
										}
									: {}),
							})),
							...(after ? [{ role: "system" as const, content: after }] : []),
						);
					}

					const final = this.state.finalReportStop
						? { toolChoice: "none" as const }
						: reservedFinalStepConfig(
								ordinal,
								resolveFacetStepCeiling(this.state.maxSteps),
							);
					const providerOptions = cache
						? {
								...generation.turnConfig.providerOptions,
								azure: {
									...generation.turnConfig.providerOptions?.azure,
									...cache.providerOptions.azure,
								},
							}
						: generation.turnConfig.providerOptions;
					return {
						model: selected.model as TedixSdkModel,
						prompt,
						callOptions: {
							maxOutputTokens: generation.turnConfig.maxOutputTokens,
							...(providerOptions ? { providerOptions } : {}),
							...(final
								? { toolChoice: { type: "none" as const }, tools: [] }
								: {}),
						},
						receipt: {
							runId,
							ordinal,
							operationId: this.facetReceiptOperation(),
							providerAttempt,
							sessionKey: this.state.sessionKey,
						},
					};
				},
				settled: async (receipt, message, measurement) => {
					// Pi consumes this same settled AssistantMessage after the canonical receipt.
					// Preserve provider detail while normalizing Tedix's broader Azure overflow
					// classifier to Pi's recognized native overflow marker, never retrying it as transient.
					if (
						message.stopReason === "error" &&
						classifyTediContextOverflow(message.errorMessage) ===
							"context_overflow"
					)
						message.errorMessage = `context_length_exceeded: ${message.errorMessage ?? "Provider context overflow"}`;
					if (!receipt) return;
					await this.assertFacetOriginalReceipt(
						receipt.runId,
						receipt.operationId,
					);
					if (receipt.runId !== receipt.providerAttempt.runId)
						throw new Error(
							"Pi accounting receipt changed original run ownership",
						);
					const usage: FacetTurnUsage = measurement.hasUsage
						? {
								inputTokens:
									message.usage.input +
									message.usage.cacheRead +
									message.usage.cacheWrite,
								outputTokens: message.usage.output,
								totalTokens: message.usage.totalTokens,
							}
						: { inputTokens: null, outputTokens: null, totalTokens: null };
					await this.accounting.recordProviderUsage(
						usage,
						message.content
							.filter((part) => part.type === "toolCall")
							.map((call) => call.id),
						receipt.providerAttempt,
					);
					try {
						await (
							await this.parent()
						).recordFacetModelStep({
							runId: receipt.runId,
							sessionKey: receipt.sessionKey ?? "",
							payload: shapeStepTelemetry({
								// Pi only sees the stable `tedix/selected` catalog entry; the
								// turn's actual choice is the resolved selection.
								model: this.selected
									? {
											provider: this.selected.identity.provider,
											modelId:
												message.responseModel ?? this.selected.identity.model,
										}
									: {
											provider: message.provider,
											modelId: message.responseModel ?? message.model,
										},
								providerMetadata: measurement.providerMetadata,
								stepNumber: receipt.ordinal,
								finishReason: message.stopReason,
								text: message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join(""),
								usage: measurement.hasUsage
									? {
											inputTokens: usage.inputTokens,
											outputTokens: usage.outputTokens,
											totalTokens: usage.totalTokens,
											inputTokenDetails: {
												cacheReadTokens: message.usage.cacheRead,
												cacheWriteTokens: message.usage.cacheWrite,
											},
											...(typeof message.usage.reasoning === "number"
												? {
														outputTokenDetails: {
															reasoningTokens: message.usage.reasoning,
														},
													}
												: {}),
										}
									: undefined,
								toolCalls: message.content
									.filter((part) => part.type === "toolCall")
									.map((part) => ({ toolName: part.name })),
								toolResults: [],
							}),
						});
					} catch (error) {
						console.error("[tedi.pi.model-telemetry]", error);
					}
				},
			}),
		);
		return {
			models: () => models,
			input: async (message) =>
				sessionUserInput(await this.imageBridge().project(message)),
			legacy: async (message) =>
				legacySessionMessages(
					(await this.imageBridge().project(message, {
						legacy: true,
					})) as SessionMessage,
				),
			message: (entry) => this.projectDisplayMessage(entry),
			event: createPiEventProjection((entry) =>
				this.projectDisplayMessage(entry),
			),
		};
	}
	protected async piExtension(): Promise<Extension> {
		const tools: ToolRegistration[] = this.state.toolDescriptors.map(
			(descriptor) => {
				return {
					name: descriptor.name,
					description: descriptor.description,
					parameters: descriptor.inputSchema as TSchema,
					replay: "unsafe" as const,
					execute: async (args, api) => {
						this.assertToolRegistryAvailable();
						const result = await (
							await this.parent()
						).executeFacetTool({
							args,
							runId: this.requireRunId(),
							tool: descriptor.name,
							toolCallId: api.callId,
						});
						try {
							assertFacetToolRegistryAvailable(result);
						} catch (error) {
							this.setState({
								...this.state,
								toolRegistryUnavailableRunId: this.state.runId,
							});
							throw error;
						}
						let projected: unknown = result;
						if (descriptor.codeModeOutput)
							projected = codeModeToolModelOutput({ output: result });
						else if (descriptor.computerExecutionOutput)
							projected = computerExecutionModelOutput({ output: result });
						else if (descriptor.computerReadOutput)
							projected = await computerReadToolModelOutput({
								toolCallId: api.callId,
								input: args,
								output: result,
							});
						const output = nativeToolOutput(projected);
						if (await this.checkNativeToolBudget())
							return { ...output, control: { terminate: true } };
						return output;
					},
				};
			},
		);
		const ApprovalWaitTask = defineTask<
			{ approvalId: string; expiresAt: number },
			{ phase: "wait"; revision: number },
			boolean
		>({
			name: "tedix.tool-approval",
			version: 1,
			initial: () => ({ phase: "wait", revision: 0 }),
			phases: {
				wait: async (task, runtime, context) => {
					const approval = await this.ctx.storage.get<ToolApproval>(
						`pi-tool-approval:${task.input.approvalId}`,
					);
					if (!approval) throw new Error("Pi tool approval record missing");
					if (
						approval.status === "approved" ||
						approval.status === "rejected" ||
						Date.now() >= task.input.expiresAt
					) {
						await runtime.commit(
							() => ({
								status: "terminal",
								outcome: {
									status: "completed",
									result:
										approval.status === "approved" &&
										Date.now() < task.input.expiresAt,
								},
							}),
							context,
						);
						return;
					}
					await runtime.sleep(Date.now() + 1000, context);
					await runtime.commit(
						() => ({
							status: "running",
							checkpoint: {
								phase: "wait",
								revision: task.state.checkpoint.revision + 1,
							},
						}),
						context,
					);
				},
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: {
							status: "aborted",
							reason: "approval cancelled",
							result: false,
						},
					}),
					context,
				);
			},
		});
		return {
			name: "tedix-conversation",
			tools,
			tasks: [ApprovalWaitTask],
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async (_request, api, context) => {
						await this.admitResumedNativeTask(api, context);
						this.assertToolRegistryAvailable();
						await (
							await this.parent()
						).assertChatTurnActive(this.requireRunId());
					},
					afterTools: async () => {
						await this.accounting.reconcileEffects(this.requireRunId());
					},
				}),
				hook(ToolTask, {
					beforeTool: async (call, api, context) => {
						await this.assertFacetRuntimeDispatch();
						await this.admitResumedNativeTask(api, context);
						if (this.state.finalReportStop)
							return { block: "Forced final report is tool-free" };
						await this.accounting.begin(this.requireRunId());
						await this.accounting.restoreAttemptForTool(call.id);
						const descriptor = this.state.toolDescriptors.find(
							(descriptor) => descriptor.name === call.name,
						);
						if (!descriptor)
							return { block: "Tool is outside the admitted parent surface" };
						if (descriptor.needsApproval) {
							const approvalId = `${this.requireRunId()}:${call.id}`;
							let approval = await this.ctx.storage.get<ToolApproval>(
								`pi-tool-approval:${approvalId}`,
							);
							if (!approval) {
								approval = {
									approvalId,
									runId: this.requireRunId(),
									toolCallId: call.id,
									toolName: call.name,
									status: "pending",
									expiresAt: Date.now() + 30 * 60 * 1000,
								};
								await this.ctx.storage.put(
									`pi-tool-approval:${approvalId}`,
									approval,
								);
								this.publishApproval({
									type: "tool-approval-request",
									approvalId,
									toolCallId: call.id,
								});
							}
							const pi = await this.piHarness.pi();
							const known = await api.memo<number>(
								"tedix-approval-wait-task",
								context,
							);
							const taskId =
								known ??
								(await pi.commit(
									(tx) =>
										tx.createTask(
											ApprovalWaitTask,
											{ approvalId, expiresAt: approval!.expiresAt },
											{
												conversationId: api.conversationId,
												ownership: { kind: "task", taskId: api.taskId },
											},
										),
									context,
								));
							const durableTask = await api.memo<number>(
								"tedix-approval-wait-task",
								taskId,
								context,
							);
							const settled = await pi.waitForTask<boolean>(
								durableTask as TaskId<boolean>,
								context,
							);
							if (
								settled.state.outcome.status !== "completed" ||
								!settled.state.outcome.result
							)
								return {
									block: "Tool approval rejected, expired, or cancelled",
								};
						}
						await this.accounting.beforeToolCall(call.id, call.name);
					},
				}),
				hook(CompactionTask, {
					beforeCompact: async (compaction, api, context) => {
						try {
							await (
								await this.parent()
							).assertChatTurnActive(this.requireRunId());
							const allowed = await this.ctx.storage.transaction(async (tx) => {
								const key = `pi-compaction-budget:v1:${this.requireRunId()}`;
								const budget = (await tx.get<{
									threshold: number[];
									overflow: number[];
								}>(key)) ?? { threshold: [], overflow: [] };
								const lane =
									compaction.reason === "overflow" ? "overflow" : "threshold";
								if (budget[lane].includes(api.taskId)) return true;
								if (budget[lane].length >= (lane === "overflow" ? 2 : 8))
									return false;
								budget[lane].push(api.taskId);
								await tx.put(key, budget);
								return true;
							});
							if (!allowed) return { decline: true as const };
							const view = await (
								await this.nativeConversation()
							).context(context);
							// Preserve model contributions by entry, including assistant/tool-result groups.
							// Pi's token-based tail can contain fewer than 20 rows, so carry any of the
							// protected last 20 rows its chosen prefix would otherwise remove.
							const contributingEntries = compaction.entries.filter((entry) =>
								entry.model?.some((message) => message.role !== "system"),
							);
							const headKey = "pi-protected-head:v1";
							let head = await this.ctx.storage.get<Message[]>(headKey);
							if (!head) {
								const calls = new Set(
									contributingEntries
										.slice(0, 2)
										.flatMap((entry) => entry.model ?? [])
										.flatMap((message) =>
											message.role === "assistant"
												? message.content
														.filter((block) => block.type === "toolCall")
														.map((block) => block.id)
												: [],
										),
								);
								const protectedEntries = contributingEntries.filter(
									(entry, index) =>
										index < 2 ||
										(entry.model ?? []).some(
											(message) =>
												message.role === "toolResult" &&
												calls.has(message.toolCallId),
										),
								);
								head = protectedEntries.flatMap((entry) => entry.model ?? []);
								await this.ctx.storage.put(headKey, head);
								await this.ctx.storage.put(
									"pi-protected-head-ids:v1",
									protectedEntries.map((entry) => entry.id),
								);
							}
							const nativeHead = view.head;
							const priorMarker =
								nativeHead?.kind === "pi.compaction"
									? JSON.stringify(nativeHead.model).match(
											/\[(tedix-compaction:\d+)\]/,
										)?.[1]
									: undefined;
							const priorBridge = priorMarker
								? await this.ctx.storage.get<{ tailEntries?: EntryRecord[] }>(
										`pi-compaction-bridge:${priorMarker}`,
									)
								: undefined;
							const priorTail = priorBridge?.tailEntries ?? [];
							const virtualEntries = [
								...priorTail,
								...view.entries.filter(
									(entry) =>
										entry.id !== nativeHead?.id &&
										entry.model?.some((message) => message.role !== "system"),
								),
							];
							const tailIds = new Set(
								virtualEntries.slice(-20).map((entry) => entry.id),
							);
							const headIds = new Set(
								(await this.ctx.storage.get<number[]>(
									"pi-protected-head-ids:v1",
								)) ?? [],
							);
							const selected = [
								...contributingEntries.filter(
									(entry) => entry.id === nativeHead?.id,
								),
								...priorTail,
								...contributingEntries.filter(
									(entry) => entry.id !== nativeHead?.id,
								),
							];
							const tailEntries = selected.filter(
								(entry) => tailIds.has(entry.id) && !headIds.has(entry.id),
							);
							const tail = tailEntries.flatMap((entry) => entry.model ?? []);
							const middle = selected
								.filter(
									(entry) => !headIds.has(entry.id) && !tailIds.has(entry.id),
								)
								.flatMap((entry) => entry.model ?? []);
							if (!middle.length) return { decline: true as const };
							const summary = await this.summarizeCompaction(
								middle.map((message) => ({
									role:
										message.role === "user"
											? ("user" as const)
											: ("assistant" as const),
									content: JSON.stringify(message),
								})),
								context,
							);
							if (!summary) return { decline: true as const };
							const marker = `tedix-compaction:${api.taskId}`;
							await this.ctx.storage.put(`pi-compaction-bridge:${marker}`, {
								head,
								tail,
								tailEntries,
							});
							invalidateReadEvidence();
							// The marker is accepted only from the current native pi.compaction entry.
							return { summary: `[${marker}]\n${summary}` };
						} catch (error) {
							console.error("[tedi.pi.compaction]", error);
							return { decline: true as const };
						}
					},
				}),
			],
		};
	}
	/** Retry only the idempotent parent probe across one deployment reset.
	 * The effect and local journal reads are outside that retry boundary. */
	private async checkNativeToolBudget(): Promise<boolean> {
		if (this.state.budgetStop) return true;
		try {
			const runId = this.requireRunId();
			const checkpoint = await this.accounting.inspect(runId);
			const stepCount = checkpoint.attempts.filter(
				(attempt) => attempt.phase !== "prepared",
			).length;
			const ceiling = resolveFacetStepCeiling(this.state.maxSteps);
			if (ceiling !== null && stepCount >= ceiling) {
				this.setState({
					...this.state,
					budgetStop: {
						kind: "step_ceiling",
						reason: `per-turn provider-call ceiling reached (${stepCount}/${ceiling} steps)`,
					},
					recoveryBlockedRunId: runId,
				});
				return true;
			}
			const cumulativeTokens = (await this.accounting.usage()).totalTokens ?? 0;
			const verdict = await recoverDurableObjectDeploymentReset(async () =>
				(await this.parent()).checkFacetTurnBudget({
					runId,
					cumulativeTokens,
					stepCount,
				}),
			);
			if (!verdict.abort) return false;
			this.setState({
				...this.state,
				budgetStop: {
					kind: "budget_exhausted",
					reason: verdict.reason ?? "daily inference budget exhausted",
				},
				recoveryBlockedRunId: runId,
			});
			return true;
		} catch (error) {
			console.error("[tedi.pi.budget] native tool budget check failed", error);
			return this.accounting.block(error);
		}
	}
	private selectedPiModel(): typeof PI_MODEL {
		const selected = this.selectModelForTurn();
		const budget = resolveModelInputBudgetTokens(
			`${selected.identity.provider}/${selected.identity.model}`,
		);
		return { ...PI_MODEL, contextWindow: budget };
	}
	protected piConfiguration(): AgentChange {
		return {
			model: { provider: "tedix", modelId: "selected" },
			instructions: this.state.system ?? FALLBACK_SYSTEM,
			tools:
				this.piRegistry.snapshot().extension("tedix-conversation")?.tools ?? [],
		};
	}
	protected piSettings() {
		return {
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 },
			compaction: conversationCompactionSettings(
				this.selectedPiModel().contextWindow,
			),
		};
	}
	private readonly approvalSinks = new Set<
		(frame: Record<string, unknown>) => void
	>();
	private publishApproval(frame: Record<string, unknown>): void {
		for (const sink of this.approvalSinks) sink(frame);
	}
	async pendingToolApprovals(): Promise<ToolApproval[]> {
		const values = await this.ctx.storage.list<ToolApproval>({
			prefix: "pi-tool-approval:",
		});
		return [...values.values()].filter(
			(approval) =>
				approval.runId === this.state.runId &&
				approval.status === "pending" &&
				approval.expiresAt > Date.now(),
		);
	}
	/** Parent invokes only after authenticating the same conversation's approval response. */
	async resolveToolApproval(input: {
		approvalId: string;
		approved: boolean;
	}): Promise<void> {
		const key = `pi-tool-approval:${input.approvalId}`;
		const approval = await this.ctx.storage.get<ToolApproval>(key);
		if (
			!approval ||
			approval.runId !== this.state.runId ||
			approval.status !== "pending" ||
			approval.expiresAt <= Date.now()
		)
			throw new Error("Tool approval is no longer pending for this run");
		await this.ctx.storage.put(key, {
			...approval,
			status: input.approved ? "approved" : "rejected",
		});
	}
	private requireRunId(): string {
		if (!this.state.runId) throw new Error("Pi turn has no parent run");
		return this.state.runId;
	}
	private assertToolRegistryAvailable(): void {
		if (
			this.state.toolRegistryUnavailableRunId === this.state.runId &&
			this.state.runId
		)
			assertFacetToolRegistryAvailable({ code: "facet_tool_unavailable" });
	}
	async onPiMessagesCleared(): Promise<void> {
		await this.ctx.storage.delete([
			"pi-protected-head:v1",
			"pi-protected-head-ids:v1",
		]);
	}
	completedTurnCount(): number {
		return this.state.turnCount;
	}
	private async configureConversationTurn(
		input: ConversationTurnConfiguration,
	): Promise<number> {
		const prior = this.state.turnCount;
		if (
			this.state.runId === input.runId &&
			JSON.stringify(this.state.turnMetadata ?? null) !==
				JSON.stringify(input.turnMetadata ?? null)
		)
			throw new Error(
				"Authenticated Pi turn metadata changed for an existing run",
			);
		await this.accounting.enrollDispatch(input.runId, async () => {
			await (await this.parent()).enrollFacetDispatchRun(input.runId);
		});
		const stableSystemPrefix =
			input.stableSystemPrefix &&
			input.system.startsWith(input.stableSystemPrefix)
				? input.stableSystemPrefix
				: null;
		const cacheIdentity =
			stableSystemPrefix &&
			input.promptCacheSurface &&
			input.aigMetadata.orgId &&
			input.aigMetadata.tediId
				? {
						orgId: input.aigMetadata.orgId,
						tediId: input.aigMetadata.tediId,
						surface: input.promptCacheSurface,
						stableSystemPrefix,
					}
				: null;
		this.setState({
			...this.state,
			...input,
			stableSystemPrefix,
			promptCacheKey: cacheIdentity
				? await promptCacheKey(cacheIdentity)
				: null,
			adaptiveRouting: input.adaptiveRouting ?? null,
			observerModelRef: input.observerModelRef ?? null,
			observerDeployment: input.observerDeployment ?? null,
			turnMetadata: input.turnMetadata ?? null,
			generation: configureFacetGeneration(this.state, input),
			toolRegistryUnavailableRunId: null,
			budgetStop: null,
			finalReportStop: null,
			selectedTurnModels: [],
			imageRefs: [],
		});
		await this.accounting.begin(input.runId);
		await this.configurePiTurn();
		return prior;
	}
	async runConfiguredConversationTurn(
		input: ConfiguredConversationTurn,
	): Promise<{ priorTurnCount: number; result: ConversationFacetTurnResult }> {
		return this.configuredTurnGate.run(() => this.executeConfiguredTurn(input));
	}
	private async executeConfiguredTurn(
		input: ConfiguredConversationTurn,
		onReady?: (submissionId: string) => Promise<void>,
	): Promise<{ priorTurnCount: number; result: ConversationFacetTurnResult }> {
		const id = input.durableSubmissionId ?? crypto.randomUUID();
		await this.acceptFacetRuntimeTurn({
			runId: input.configuration.runId,
			sessionKey: input.configuration.sessionKey,
			configuration: input.configuration,
			input,
			operationId: id,
		});
		await this.recoverPendingSubmission();
		const previous = await this.ctx.storage.get<{
			priorTurnCount: number;
			result: ConversationFacetTurnResult;
		}>(`facet-submission-result:${id}`);
		if (previous) return previous;
		if (!(await this.waitUntilStable({ timeout: 30000 })))
			throw new Error("Pi turn configuration is waiting on unfinished work");
		if (input.regenerationOf)
			await this.forkForRegeneration(input.regenerationOf);
		else if (input.freshHistory) await this.session.clearMessages();
		const prior = await this.configureConversationTurn(input.configuration);
		const text =
			prior === 0 && !input.freshHistory
				? (input.firstTurnText ?? input.text)
				: input.text;
		if (input.images?.length && input.durableSubmissionId)
			throw new Error("Durable image turns require private imageRefs");
		this.setState({ ...this.state, imageRefs: input.imageRefs ?? [] });
		const pending: PendingFacetSubmission = {
			originalUiMessage: input.originalUiMessage,
			configuration: input.configuration,
			submissionId: id,
			priorTurnCount: prior,
			turnInput: { text, imageRefs: input.imageRefs, images: input.images },
		};
		await this.ctx.storage.put("pi-facet-pending-submission", pending);
		await onReady?.(id);
		const result = await this.runSubmittedConversationTurn(pending);
		return { priorTurnCount: prior, result };
	}
	private async recoverPendingSubmission(): Promise<void> {
		const pending = await this.ctx.storage.get<PendingFacetSubmission>(
			"pi-facet-pending-submission",
		);
		if (!pending) return;
		await this.assertFacetRuntimeDispatch();
		if (this.state.runId !== pending.configuration.runId)
			throw new Error(
				"Pending Pi submission lost its original run configuration",
			);
		await this.runSubmittedConversationTurn(pending);
	}
	private async runSubmittedConversationTurn(
		pending: PendingFacetSubmission,
	): Promise<ConversationFacetTurnResult> {
		const at = Date.now();
		const id = pending.submissionId;
		const message: SessionMessage = {
			id: `${id}:user`,
			role: "user",
			parts: [
				{ type: "text", text: pending.turnInput.text },
				...(pending.turnInput.images ?? []).map((image) => ({
					type: "file",
					mediaType: image.mediaType,
					filename: image.fileName,
					url:
						image.kind === "url"
							? image.data
							: `data:${image.mediaType};base64,${image.data}`,
				})),
				...(pending.turnInput.imageRefs ?? []).map((ref) => ({
					type: "file",
					mediaType: ref.mediaType,
					filename: ref.fileName,
					url: workflowImageUri(ref),
				})),
			],
		};
		if (pending.originalUiMessage)
			await this.registerOriginalUiMessage(id, pending.originalUiMessage);
		await this.submitMessages([message], { submissionId: id });
		const terminal = await this.waitForSubmission(id);
		if (terminal.status !== "completed" || !terminal.messageId)
			throw new Error(
				terminal.error ?? "Native Pi submission has no owned answer",
			);
		const owned = await this.session.getMessage(terminal.messageId);
		if (!owned || owned.role !== "assistant")
			throw new Error("Native Pi answer ownership mismatch");
		await this.accounting.begin(pending.configuration.runId);
		await this.accounting.assertComplete();
		const text = owned.parts
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("")
			.trim();
		const ceiling = resolveFacetStepCeiling(this.state.maxSteps);
		const checkpoint = await this.accounting.inspect(
			pending.configuration.runId,
		);
		const rounds = checkpoint.attempts.filter(
			(attempt) => attempt.phase !== "prepared",
		).length;
		if (!this.state.budgetStop && ceiling !== null && rounds >= ceiling)
			this.setState({
				...this.state,
				budgetStop: {
					kind: "step_ceiling",
					reason: `per-turn provider-call ceiling reached (${rounds}/${ceiling} steps)`,
				},
				recoveryBlockedRunId: this.state.runId,
			});
		const stop = this.state.budgetStop;
		let report = "";
		if (stop) {
			this.setState({
				...this.state,
				finalReportStop: { reason: stop.reason },
			});
			const reportId = `${id}:final-report`;
			await this.submitMessages(
				[
					{
						id: `${reportId}:user`,
						role: "user",
						parts: [
							{ type: "text", text: finalReportInstruction(stop.reason) },
						],
					},
				],
				{ submissionId: reportId },
			);
			const settledReport = await this.waitForSubmission(reportId);
			if (settledReport.status === "completed" && settledReport.messageId) {
				const answer = await this.session.getMessage(settledReport.messageId);
				report =
					answer?.parts
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join("") ?? "";
			} else console.error("[tedi.pi.final-report]", settledReport.error);
			await this.accounting.assertComplete();
			this.setState({ ...this.state, finalReportStop: null });
		}
		const assistantText = stop
			? [text, report, stoppedTurnNotice(stop.reason)]
					.filter(Boolean)
					.join("\n\n")
			: text;
		const usage = await this.accounting.usage();
		const modelIdentity = attributableConversationModel({
			selectedModels: this.state.selectedTurnModels ?? [],
			hasFreshText: !!text,
			stopped: !!stop,
		});
		const result: ConversationFacetTurnResult = {
			assistantText,
			...(modelIdentity ? { modelIdentity } : {}),
			requestId: id,
			turnCount: pending.priorTurnCount + 1,
			turnMs: Date.now() - at,
			...(usage.totalTokens == null ? {} : { usage }),
			...(stop ? { stopReason: stop.kind } : {}),
		};
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.kv.put(`facet-submission-result:${id}`, {
				priorTurnCount: pending.priorTurnCount,
				result,
			});
			this.setState({
				...this.state,
				turnCount: Math.max(this.state.turnCount, result.turnCount),
			});
			this.ctx.storage.kv.delete("pi-facet-pending-submission");
		});
		await this.completeFacetRuntimeTurn(pending.configuration.runId, id, {
			result,
			parentRunId: pending.configuration.runId,
			accounting: await this.accounting.inspect(pending.configuration.runId),
		});
		return result;
	}
	async streamConfiguredConversationTurn(
		input: ConfiguredConversationTurn,
	): Promise<ReadableStream<Uint8Array>> {
		const encoder = new TextEncoder();
		let cancelled = false;
		let executing = false;
		return new ReadableStream({
			start: (controller) => {
				const task = (async () => {
					await this.configuredTurnGate.run(async () => {
						let stopEvents: (() => Promise<unknown>) | undefined;
						const approvalSink = (frame: Record<string, unknown>) =>
							send({ kind: "chunk", body: JSON.stringify(frame) });
						let drained: Promise<void> | undefined;
						let reportDrained: (() => Promise<void>) | undefined;
						const send = (frame: unknown) => {
							if (!cancelled)
								controller.enqueue(
									encoder.encode(JSON.stringify(frame) + "\n"),
								);
						};
						try {
							if (cancelled) return;
							const { result } = await this.executeConfiguredTurn(
								input,
								async (submissionId) => {
									if (cancelled)
										throw new Error("Pi stream cancelled before submission");
									executing = true;
									this.approvalSinks.add(approvalSink);
									const terminals = new Set<string>();
									const waiters = new Map<string, () => void>();
									reportDrained = () =>
										terminals.has(`${submissionId}:final-report`)
											? Promise.resolve()
											: new Promise<void>((resolve) =>
													waiters.set(`${submissionId}:final-report`, resolve),
												);
									let delivered!: () => void;
									let failed!: (reason: unknown) => void;
									drained = new Promise<void>((resolve, reject) => {
										delivered = resolve;
										failed = reject;
									});
									// Observe every frame through the exact durable terminal submission.
									// CommittedWatch.stop discards queued frames, so stopping alone is not a drain.
									const projection = createPiEventProjection((entry) =>
										this.projectDisplayMessage(entry),
									);
									const events = await this.nativeEvents();
									stopEvents = () => events.stop();
									for (const frame of projection(events.snapshot))
										send({ kind: "chunk", body: JSON.stringify(frame) });
									events.start(async (batch) => {
										try {
											let terminal = false;
											for (const event of batch)
												if (
													event.type === "submission" &&
													event.record.requestId
												)
													await this.retainSubmissionDisplay(
														event.record.requestId,
													);
											for (const event of batch) {
												for (const frame of projection(event))
													send({ kind: "chunk", body: JSON.stringify(frame) });
												if (event.type === "message_update")
													for (const change of event.changes)
														if (change.type === "text_delta")
															send({ kind: "delta", text: change.delta });
												if (
													event.type === "submission" &&
													event.record.requestId &&
													event.record.status !== "queued" &&
													event.record.status !== "placed"
												) {
													terminals.add(event.record.requestId);
													waiters.get(event.record.requestId)?.();
													if (event.record.requestId === submissionId)
														terminal = true;
												}
											}
											if (terminal) delivered();
										} catch (error) {
											failed(error);
										}
									});
									for (const approval of await this.pendingToolApprovals())
										approvalSink({
											type: "tool-approval-request",
											approvalId: approval.approvalId,
											toolCallId: approval.toolCallId,
										});
								},
							);
							await drained;
							if (result.stopReason) await reportDrained?.();
							await stopEvents?.();
							stopEvents = undefined;
							send({
								kind: "done",
								requestId: result.requestId,
								text: result.assistantText,
								turnCount: result.turnCount,
								turnMs: result.turnMs,
								...(result.usage ? { usage: result.usage } : {}),
								...(result.stopReason ? { stopReason: result.stopReason } : {}),
							});
						} catch (error) {
							send({
								kind: "error",
								message: error instanceof Error ? error.message : String(error),
							});
						} finally {
							await stopEvents?.();
							this.approvalSinks.delete(approvalSink);
							executing = false;
							if (!cancelled) controller.close();
						}
					});
				})();
				this.ctx.waitUntil(task);
			},
			cancel: async () => {
				cancelled = true;
				if (executing) await this.cancelPiTurn();
			},
		});
	}
	/** Reattach to an existing owned operation; never submits/reconfigures a new turn. */
	async resumeConfiguredConversationTurn(
		submissionId?: string,
	): Promise<ReadableStream<Uint8Array> | null> {
		const pending = await this.ctx.storage.get<PendingFacetSubmission>(
			"pi-facet-pending-submission",
		);
		if (!pending || (submissionId && pending.submissionId !== submissionId))
			return null;
		if (pending.configuration.runId !== this.state.runId)
			throw new Error("Pi resume lost its authenticated run configuration");
		const encoder = new TextEncoder();
		let cancelled = false;
		const context: PiContext = {
			abortSignal: undefined,
			value: () => undefined,
			toString: () => "tedix-pi-resume",
		};
		return new ReadableStream({
			start: (controller) => {
				const task = (async () => {
					const send = (frame: unknown) => {
						if (!cancelled)
							controller.enqueue(encoder.encode(JSON.stringify(frame) + "\n"));
					};
					const projection = createPiEventProjection((entry) =>
						this.projectDisplayMessage(entry),
					);
					const approvalSink = (frame: Record<string, unknown>) =>
						send({ kind: "chunk", body: JSON.stringify(frame) });
					this.approvalSinks.add(approvalSink);
					let snapshotInputs: ReadonlySet<number> = new Set();
					const seen = new Set<string>();
					const waiters = new Map<string, () => void>();
					let snapshotDelivered!: () => void;
					const firstFrame = new Promise<void>((resolve) => {
						snapshotDelivered = resolve;
					});
					const events = await this.nativeEvents();
					snapshotInputs = new Set(events.snapshot.run?.inputs ?? []);
					for (const frame of projection(events.snapshot))
						send({ kind: "chunk", body: JSON.stringify(frame) });
					snapshotDelivered();
					events.start(async (batch) => {
						for (const event of batch)
							if (event.type === "submission" && event.record.requestId)
								await this.retainSubmissionDisplay(event.record.requestId);
						for (const event of batch) {
							if (event.type === "snapshot")
								snapshotInputs = new Set(event.run?.inputs ?? []);
							for (const frame of projection(event))
								send({ kind: "chunk", body: JSON.stringify(frame) });
							if (event.type === "message_update")
								for (const change of event.changes)
									if (change.type === "text_delta")
										send({ kind: "delta", text: change.delta });
							if (
								event.type === "submission" &&
								event.record.requestId &&
								event.record.status !== "queued" &&
								event.record.status !== "placed"
							) {
								seen.add(event.record.requestId);
								waiters.get(event.record.requestId)?.();
							}
						}
						snapshotDelivered();
					});
					const drain = async (id: string) => {
						await firstFrame;
						const stored = await (
							await this.piHarness.storage()
						).submissionByRequest(
							(await this.nativeConversation()).id,
							id,
							context,
						);
						if (
							stored &&
							stored.status !== "queued" &&
							stored.status !== "placed" &&
							!snapshotInputs.has(stored.id)
						)
							return;
						if (seen.has(id)) return;
						await new Promise<void>((resolve) => waiters.set(id, resolve));
					};
					try {
						for (const approval of await this.pendingToolApprovals())
							send({
								kind: "chunk",
								body: JSON.stringify({
									type: "tool-approval-request",
									approvalId: approval.approvalId,
									toolCallId: approval.toolCallId,
								}),
							});
						const completed = await this.configuredTurnGate.run(async () => {
							const cached = await this.ctx.storage.get<{
								priorTurnCount: number;
								result: ConversationFacetTurnResult;
							}>(`facet-submission-result:${pending.submissionId}`);
							if (cached) return cached;
							const active = await this.ctx.storage.get<PendingFacetSubmission>(
								"pi-facet-pending-submission",
							);
							if (active?.submissionId !== pending.submissionId)
								throw new Error("Resumed Pi submission receipt is missing");
							return {
								priorTurnCount: pending.priorTurnCount,
								result: await this.runSubmittedConversationTurn(active),
							};
						});
						await drain(pending.submissionId);
						if (completed.result.stopReason)
							await drain(`${pending.submissionId}:final-report`);
						await events.stop();
						const result = completed.result;
						send({
							kind: "done",
							requestId: result.requestId,
							text: result.assistantText,
							turnCount: result.turnCount,
							turnMs: result.turnMs,
							...(result.usage ? { usage: result.usage } : {}),
							...(result.stopReason ? { stopReason: result.stopReason } : {}),
						});
					} catch (error) {
						send({
							kind: "error",
							message: error instanceof Error ? error.message : String(error),
						});
					} finally {
						await events.stop();
						this.approvalSinks.delete(approvalSink);
						if (!cancelled) controller.close();
					}
				})();
				this.ctx.waitUntil(task);
			},
			cancel: async () => {
				cancelled = true;
				const active = await this.ctx.storage.get<PendingFacetSubmission>(
					"pi-facet-pending-submission",
				);
				if (active?.submissionId === pending.submissionId)
					await this.cancelPiTurn();
			},
		});
	}
	private async compactedModelMessages(
		messages: readonly Message[],
	): Promise<readonly Message[]> {
		const context: PiContext = {
			abortSignal: undefined,
			value: () => undefined,
			toString: () => "tedix-compaction-projection",
		};
		const view = await (await this.nativeConversation()).context(context);
		const nativeHead = view.head;
		if (!nativeHead || nativeHead.kind !== "pi.compaction") return messages;
		const summaryMessage = nativeHead.model?.[0];
		if (!summaryMessage || summaryMessage.role !== "user")
			throw new Error("Native compaction has no summary contribution");
		const content =
			typeof summaryMessage.content === "string"
				? summaryMessage.content
				: summaryMessage.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("");
		const marker = content.match(/\[(tedix-compaction:\d+)\]/)?.[1];
		if (!marker)
			throw new Error("Native compaction lacks protected-role bridge");
		const bridge = await this.ctx.storage.get<{
			head: Message[];
			tail: Message[];
		}>(`pi-compaction-bridge:${marker}`);
		if (!bridge)
			throw new Error("Native compaction protected-role bridge missing");
		const index = messages.findIndex(
			(message) => JSON.stringify(message) === JSON.stringify(summaryMessage),
		);
		if (index < 0)
			throw new Error("Native summary is absent from dispatch context");
		return [
			...messages.slice(0, index),
			...bridge.head,
			messages[index]!,
			...bridge.tail,
			...messages.slice(index + 1),
		];
	}
	private imageBridge(): PiImageBridge {
		return new PiImageBridge(this.ctx.storage, this.env.TEDI_STORAGE, () => {
			const tediId = this.state.aigMetadata?.tediId,
				orgId = this.state.aigMetadata?.orgId;
			if (!tediId || !orgId)
				throw new Error(
					"Native image context has no authenticated tenant/tedi",
				);
			return { tediId, orgId };
		});
	}
}

/** Preserve projected JSON/text/media rather than passing raw receipts to Pi. */
function nativeToolOutput(output: unknown): ToolExecutionResult {
	if (output && typeof output === "object" && "type" in output) {
		if (output.type === "json" && "value" in output)
			return {
				content: [{ type: "text", text: JSON.stringify(output.value) }],
			};
		if (
			output.type === "text" &&
			"value" in output &&
			typeof output.value === "string"
		)
			return { content: [{ type: "text", text: output.value }] };
		if (
			output.type === "content" &&
			"value" in output &&
			Array.isArray(output.value)
		)
			return {
				content: output.value.map((part: unknown) => {
					if (part && typeof part === "object" && "type" in part) {
						if (
							part.type === "text" &&
							"text" in part &&
							typeof part.text === "string"
						)
							return { type: "text" as const, text: part.text };
						if (
							part.type === "image-data" &&
							"data" in part &&
							typeof part.data === "string" &&
							"mediaType" in part &&
							typeof part.mediaType === "string"
						)
							return {
								type: "image" as const,
								data: part.data,
								mimeType: part.mediaType,
							};
					}
					throw new Error(
						"Native Pi tool model projection contains unsupported content",
					);
				}),
			};
	}
	const serialized = JSON.stringify(output);
	if (serialized === undefined)
		throw new Error("Tool result has no durable JSON representation");
	return { content: [{ type: "text", text: serialized }] };
}

interface ToolApproval {
	approvalId: string;
	runId: string;
	toolCallId: string;
	toolName: string;
	status: "pending" | "approved" | "rejected";
	expiresAt: number;
}
