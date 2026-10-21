import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { encodeAiGatewayAttribution } from "@tedix/api-contract/schemas/ai-gateway-attribution";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { hashAnalyticsLabel } from "@tedix/api-contract/schemas/mcp-analytics";
import type { TediModelPolicyResponse } from "@tedix/api-contract/schemas/tedi";
import {
	type BrowserHostnamePolicy,
	BrowserHostnamePolicySchema,
	type TediBudgets,
	TediBudgetsSchema,
	type ToolPolicy,
	ToolPolicySchema,
} from "@tedix/api-contract/schemas/tedi";
import {
	type WebSearchPolicy,
	WebSearchPolicySchema,
} from "@tedix/api-contract/schemas/web-search";
import { buildTediConversationId } from "@tedix/api-contract/utils/runtime-identity";
import {
	buildHarnessComponents,
	type HarnessLoopPolicy,
} from "@tedix/context-core/harness-version";
import {
	getTediRuntimeChannels,
	getTediRuntimeGovernance,
} from "@tedix/db/queries/tedi-runtime-bootstrap";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import { selectAzureDeployment } from "./ai-sdk-adapter";
import { TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION } from "./artifacts-contract";
import type { ArtifactsPushReceipt } from "./artifacts-git";
import type { HttpPlatformClient } from "./brain/platform-client";
import type { RecentTurn } from "./bridge-turn-input";
import type { ChatTurnParams } from "./chat-turn-input";
import {
	buildCronBudgetSuppression,
	CRON_BUDGET_SUPPRESSION_STORAGE_KEY,
	type CronBudgetSuppression,
	isBackgroundBudgetHardExhausted,
	shouldSuppressCronForBudget,
} from "./cron-budget-control";
import { type FacetWorkflowTurnInput } from "./delegated-work-lease";
import type { AgentTediDO } from "./do";
import { type DurableCodePause } from "./durable-codemode-lifecycle";
import {
	estimateInferenceTokens,
	inferenceSource,
} from "./inference-guardrails";
import {
	buildRunId,
	isEphemeralSession,
	type MirrorFailedTurnOpts,
	mirrorFailedTurnToLedger,
	mirrorTurnToLedger,
	readLedgerConversation,
} from "./ledger-mirror";
import { type AigMetadata } from "./llm";
import {
	DEFAULT_TEDI_MODEL_POLICY,
	modelOverrideForSurface,
	type ModelPolicySurface,
	normalizeModelPolicy,
} from "./model-policy";
import {
	consumeTelegramTurnStream,
	maintenanceCompletionReceiptHash,
	type MaintenanceEffectReceipt,
	type MaintenanceEffectResult,
	type ParentMaintenanceTask,
	type ParentServiceAdmissionHost,
	type ParentServiceClaim,
	type ParentServiceOperation,
	PiTelegram,
} from "./pi-parent-services";
import { assertTediChatNotCanceled } from "./pi-recovery";
import {
	type PiStepReceipt,
	type PiStepReservation,
} from "./pi-turn-accounting";
import {
	resolveBrainBridgePlatformClient,
	tediRuntimeServiceBindingHeaders,
} from "./platform-client-factory";
import {
	readStoredRuntimeAdmission,
	RuntimeAdmissionDO,
} from "./runtime-admission-do";
import { LEDGER_OUTBOX_REDRIVE_SECONDS } from "./runtime-event-outbox";
import { identityValue } from "./runtime-facet-turns";
import {
	logTediRuntimeDiagnostic,
	logTediRuntimeFailure,
} from "./runtime-failure-log";
import { type NativeRootProof } from "./runtime-inference-origin";
import { markStepCompleted } from "./runtime-latency-markers";
import {
	captureRuntimeParentIdentity,
	resolveRuntimeParentIdentity,
} from "./runtime-parent-identity";
import {
	AGENT_PROMPT_VERSION,
	AGENT_RUNTIME_PROMPT,
} from "./runtime-tool-guidance";
import {
	bodyExecutionUsageFromSteps,
	type FacetTurnUsage,
	type StepTelemetryPayload,
} from "./step-telemetry";
import {
	resolveGovernedStepCeiling,
	resolveTediBudgets,
} from "./tedi-governance";
import {
	selectTelegramMessengerConfig,
	type TelegramChannelLike,
} from "./telegram-config";
import { FINAL_STEP_STOP_RULE } from "./turn-model-selection";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import { type WorkflowDispatchContext } from "./workflow-start-watchdog";
import {
	composeSystemPrompt,
	readIdentityFilesWithDiagnostics,
} from "./workspace";
type ActiveTurnBinding = NonNullable<AgentTediDO["activeTurnBinding"]>;
/**
 * Backstop on a GOVERNED step ceiling — not a default turn budget. A chat turn
 * has no step-count stop unless D1 governance stamps a positive
 * `maxIterationsPerTask` (an explicit per-tedi budget); when it does,
 * this bounds it (`resolveGovernedStepCeiling`). An ungoverned or unlimited
 * turn is bounded by wall clock, the daily budget, and per-call compaction
 * (`context-overflow.ts`), and every early stop still ends with the forced
 * tools-off final report (`facet-turn-stop.ts`).
 */
const MAX_CHAT_STEPS = 40;

const GOVERNANCE_CACHE_TTL_MS = 30_000;

/**
 * Bound on {@link ensureModelPolicy}'s cold-DO `API_SERVICE.fetch` for the
 * per-role model policy — a single, should-be-fast internal RPC (not a
 * stream), so a fixed ceiling rather than an idle-reset timer. See the guard
 * comment at its call site for why this fetch needed its own timeout.
 */
const MODEL_POLICY_FETCH_TIMEOUT_MS = 20_000;

/**
 * The agent-loop control policy stamped onto the active `HarnessVersion`
 * (`loop_policy` component, via {@link buildHarnessComponents}). Versioning the
 * loop's max-step ceiling + final-step stop rule makes loop behaviour auditable
 * and bump-on-change instead of a buried constant: edit either field and the
 * next `ensureActiveHarnessVersion` bumps the version.
 */
const HARNESS_LOOP_POLICY: HarnessLoopPolicy = {
	maxSteps: MAX_CHAT_STEPS,
	finalStepStop: FINAL_STEP_STOP_RULE,
};

export interface RuntimeParentTurnsHost {
	parentPath: AgentTediDO["parentPath"];
	state: AgentTediDO["state"];
	env: AgentTediDO["env"];
	nativeTelegramConfigKey: AgentTediDO["nativeTelegramConfigKey"];
	nativeTelegramInstance: AgentTediDO["nativeTelegramInstance"];
	parentServiceAdmission: AgentTediDO["parentServiceAdmission"];
	ctx: AgentTediDO["ctx"];
	subAgent: AgentTediDO["subAgent"];
	startFiber: AgentTediDO["startFiber"];
	resolveFiber: AgentTediDO["resolveFiber"];
	streamChatTurn: AgentTediDO["streamChatTurn"];
	activeTurnAborts: AgentTediDO["activeTurnAborts"];
	liveWorkItemSlots: AgentTediDO["liveWorkItemSlots"];
	clearFanoutSlot: AgentTediDO["clearFanoutSlot"];
	runtimeConfigCache: AgentTediDO["runtimeConfigCache"];
	activeTurnBinding: AgentTediDO["activeTurnBinding"];
	assertChatTurnActive: AgentTediDO["assertChatTurnActive"];
	getInferenceBudgetStore: AgentTediDO["getInferenceBudgetStore"];
	inferenceBudgetLimits: AgentTediDO["inferenceBudgetLimits"];
	runtimeAdmission: AgentTediDO["runtimeAdmission"];
	platformClient: AgentTediDO["platformClient"];
	setState: AgentTediDO["setState"];
	loadTediGovernance: AgentTediDO["loadTediGovernance"];
	ensureIdentity: AgentTediDO["ensureIdentity"];
	maybeReconcileCrons: AgentTediDO["maybeReconcileCrons"];
	name: AgentTediDO["name"];
	resolveIdentityFromD1: AgentTediDO["resolveIdentityFromD1"];
	mcpRuntime: AgentTediDO["mcpRuntime"];
	loadTelegramChannel: AgentTediDO["loadTelegramChannel"];
	backgroundInferenceBudgetUsage: AgentTediDO["backgroundInferenceBudgetUsage"];
	modelOverrideForSurface: AgentTediDO["modelOverrideForSurface"];
	ensureModelPolicy: AgentTediDO["ensureModelPolicy"];
	parentServiceRunId: AgentTediDO["parentServiceRunId"];
	imageCleanupJournal: AgentTediDO["imageCleanupJournal"];
	onDailyLogFlush: AgentTediDO["onDailyLogFlush"];
	onCompileDirectives: AgentTediDO["onCompileDirectives"];
	onCompileBrainDigest: AgentTediDO["onCompileBrainDigest"];
	onAuditCorpus: AgentTediDO["onAuditCorpus"];
	onRefreshSkillGuidance: AgentTediDO["onRefreshSkillGuidance"];
	runtimeReceiptHash: AgentTediDO["runtimeReceiptHash"];
	completeRuntimeTurn: AgentTediDO["completeRuntimeTurn"];
	runWorkflow: AgentTediDO["runWorkflow"];
	selfPath: AgentTediDO["selfPath"];
	getPlatformClient: AgentTediDO["getPlatformClient"];
	effectiveStepCeiling: AgentTediDO["effectiveStepCeiling"];
	isEphemeralConversation: AgentTediDO["isEphemeralConversation"];
	resolveTurnTelemetry: AgentTediDO["resolveTurnTelemetry"];
	stepEventSequence: AgentTediDO["stepEventSequence"];
	bufferToolStep: AgentTediDO["bufferToolStep"];
	eventOutbox: AgentTediDO["eventOutbox"];
	recordStepEvent: AgentTediDO["recordStepEvent"];
	peekTotalTokens: AgentTediDO["peekTotalTokens"];
	peekPendingToolSteps: AgentTediDO["peekPendingToolSteps"];
	enqueueLedgerOutbox: AgentTediDO["enqueueLedgerOutbox"];
	emitTraceBundleForRun: AgentTediDO["emitTraceBundleForRun"];
	schedule: AgentTediDO["schedule"];
	sessionRepo: AgentTediDO["sessionRepo"];
	messagesForSession: AgentTediDO["messagesForSession"];
	readMessagesForSession: AgentTediDO["readMessagesForSession"];
	readConversationForSession: AgentTediDO["readConversationForSession"];
}
export const runtimeParentTurns = {
	async nativeTelegram(
		this: RuntimeParentTurnsHost,
	): Promise<PiTelegram | null> {
		const selected = selectTelegramMessengerConfig(
			this.state.telegramChannel ?? undefined,
			this.env as {
				TELEGRAM_BOT_TOKEN?: string;
				TELEGRAM_WEBHOOK_SECRET?: string;
			},
			this.state.slug || this.state.tediId || "tedi",
		);
		if (!selected) return null;
		const key = `${selected.token}|${selected.userName}|${selected.secretToken}`;
		if (this.nativeTelegramConfigKey === key)
			return this.nativeTelegramInstance;
		this.nativeTelegramInstance = new PiTelegram(
			{
				...this.parentServiceAdmission(),
				storage: this.ctx.storage,
				subAgent: this.subAgent.bind(this),
				startFiber: this.startFiber.bind(this),
				resolveFiber: this.resolveFiber.bind(this),
				turnPolicy: () => this.state.telegramChannel ?? null,
				runTurn: async (turn, onDelta) =>
					consumeTelegramTurnStream(
						await this.streamChatTurn(
							{
								sessionKey: turn.sessionKey,
								text: wrapUntrustedInput(turn.text, "telegram"),
								clientRequestId: turn.operationId,
								durableSubmissionId: turn.operationId,
								messengerMetadata: turn.metadata,
								// A record accepted before trust was decided carries none.
								trust: turn.trust ?? "untrusted",
								trustChannel: "telegram",
								originalUiMessage: {
									id: turn.operationId,
									role: "user",
									parts: [{ type: "text", text: turn.text }],
								},
							},
							turn.operationId,
						),
						onDelta,
					),
			},
			{
				token: selected.token,
				userName: selected.userName,
				secretToken: selected.secretToken ?? "",
			},
		);
		this.nativeTelegramConfigKey = key;
		return this.nativeTelegramInstance;
	},
	/**
	 * Cascade a cancel from a parent run to its fan-out subtree (#6). BFS over the
	 * durable `fanoutslot:` storage records (slot id = `${parentRunId}:fanout:
	 * ${childRunId}`); each child's live workflow instance id is recovered from
	 * the in-memory {@link liveWorkItemSlots} map, `terminate()`d, and its slot
	 * cleared, then its `childRunId` becomes the next frontier — reaching
	 * grandchildren. Bounded by depth + total-termination caps and a `visited`
	 * set. Idempotent + fail-soft: already-terminal/absent workflows are swallowed
	 * (same tolerance as the single-hop terminate), so a re-delivered cancel just
	 * re-walks an empty slot set. Strictly reduces orphans vs. the prior one-hop
	 * behavior; never throws into the cancel response.
	 */
	async cascadeCancelFanout(
		this: RuntimeParentTurnsHost,
		rootRunId: string,
		opts: { maxDepth?: number; maxTerminations?: number } = {},
	): Promise<{ terminated: string[] }> {
		const maxDepth = opts.maxDepth ?? 4;
		const maxTerminations = opts.maxTerminations ?? 50;
		const terminated: string[] = [];
		const visited = new Set<string>([rootRunId]);
		let frontier = [rootRunId];
		const workflowBinding = (
			this.env as unknown as {
				CHAT_TURN_WORKFLOW?: {
					get(id: string): Promise<{ terminate(): Promise<void> }>;
				};
			}
		).CHAT_TURN_WORKFLOW;
		try {
			// Single durable read of all slots — filter per frontier in memory.
			const stored = await this.ctx.storage.list<Record<string, unknown>>({
				prefix: "fanoutslot:",
				limit: 200,
			});
			for (
				let depth = 0;
				depth < maxDepth &&
				frontier.length > 0 &&
				terminated.length < maxTerminations;
				depth += 1
			) {
				const next: string[] = [];
				for (const parentRunId of frontier) {
					const slotPrefix = `${parentRunId}:fanout:`;
					for (const [, record] of stored) {
						if (typeof record !== "object" || record === null) continue;
						const slotId = typeof record.id === "string" ? record.id : "";
						if (!slotId.startsWith(slotPrefix)) continue;
						const childRunId =
							typeof record.childRunId === "string" ? record.childRunId : "";
						if (!childRunId || visited.has(childRunId)) continue;
						visited.add(childRunId);
						next.push(childRunId);
						if (terminated.length >= maxTerminations) break;
						// Trip the child's in-flight tool calls too (ties #6→#4).
						this.activeTurnAborts
							.get(childRunId)
							?.abort(new DOMException("parent run cancelled", "AbortError"));
						const childInstanceId = this.liveWorkItemSlots.get(childRunId);
						if (childInstanceId && workflowBinding) {
							try {
								const childInstance =
									await workflowBinding.get(childInstanceId);
								await childInstance.terminate();
								terminated.push(childRunId);
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								// Already-terminal/absent → treat as settled (same tolerance
								// as the single-hop terminate). Anything else is logged only.
								if (
									!/already|terminated|complete|errored|not found|invalid/i.test(
										msg,
									)
								) {
									console.warn(
										"[isolate.do] cascadeCancelFanout child terminate failed:",
										msg,
									);
								}
							}
							await this.clearFanoutSlot(childInstanceId);
						}
					}
					if (terminated.length >= maxTerminations) break;
				}
				frontier = next;
			}
		} catch (e) {
			console.warn(
				"[isolate.do] cascadeCancelFanout failed:",
				e instanceof Error ? e.message : e,
			);
		}
		return { terminated };
	},
	getMaxConcurrentWorkItems(this: RuntimeParentTurnsHost): Promise<number> {
		return this.runtimeConfigCache.getMaxConcurrentWorkItems(
			this.env.DB,
			identityValue(this.state.tediId),
		);
	},
	/**
	 * Clear the active turn binding AND unbind the episode trace on its platform
	 * client (P0.2), so out-of-turn brain calls fall back to a per-call id rather
	 * than leaking the finished turn's episode id.
	 *
	 * Pass `expected` (the caller-turn's own binding) to make the clear
	 * identity-guarded: when a concurrent bespoke-loop turn has since rebound
	 * `activeTurnBinding`, the finishing turn must not clobber it — its episode
	 * trace and ledger rows would silently land under the wrong run. `undefined`
	 * keeps the unconditional clear for callers that own the field by
	 * construction (e.g. beforeTurn's no-runtime reset).
	 */
	clearActiveTurn(
		this: RuntimeParentTurnsHost,
		expected?: ActiveTurnBinding | null,
	): void {
		if (expected !== undefined && this.activeTurnBinding !== expected) return;
		this.activeTurnBinding?.platform.setEpisodeTrace(null);
		this.activeTurnBinding = null;
	},
	/** Facets reserve each provider attempt through the parent's shared budget. */
	async reservePiStep(this: RuntimeParentTurnsHost, input: PiStepReservation) {
		await this.assertChatTurnActive(input.runId);
		return this.getInferenceBudgetStore().reserveStep(
			input.runId,
			input.stepId,
			input.estimatedTokens,
			this.inferenceBudgetLimits(),
		);
	},
	/** Already-incurred usage remains accountable after cancellation or midnight. */
	async recordPiStep(this: RuntimeParentTurnsHost, input: PiStepReceipt) {
		const admission = this.runtimeAdmission();
		if (admission) await admission.assertOriginalClaim({ runId: input.runId });
		return this.getInferenceBudgetStore().recordStep(
			input.runId,
			input.stepId,
			input.actualTokens,
			this.inferenceBudgetLimits(),
		);
	},
	resolveIdentityFromD1(this: RuntimeParentTurnsHost): Promise<{
		tediId: string;
		orgId: string;
		slug: string;
	} | null> {
		return resolveRuntimeParentIdentity({
			db: this.env.DB,
			physicalIdForName: (name) =>
				this.env.TEDI_AGENT.idFromName(name).toString(),
			capture: () =>
				captureRuntimeParentIdentity({
					ctx: this.ctx,
					agent: this,
					state: this.state,
					configGeneration: this.runtimeConfigCache.generation,
				}),
		});
	},
	/**
	 * Read this tedi's per-tedi Telegram channel config from the body-neutral
	 * `tedis.channels` JSON column. Returns the `telegram` sub-config, or `null`
	 * when there is none (so the caller persists "loaded, none" and falls back to
	 * the Worker-wide env token). Fail-soft: a read/parse error returns null.
	 */
	async loadTelegramChannel(
		this: RuntimeParentTurnsHost,
		tediId: string,
	): Promise<TelegramChannelLike | null> {
		const key = identityValue(tediId);
		if (!key) return null;
		try {
			const channels = await getTediRuntimeChannels(this.env.DB, key);
			if (!channels) return null;
			const parsed =
				typeof channels === "string" ? JSON.parse(channels) : channels;
			const telegram = (parsed as { telegram?: TelegramChannelLike } | null)
				?.telegram;
			return telegram ?? null;
		} catch (err) {
			console.warn(
				`[isolate.telegram] failed to load channels for ${tediId}:`,
				err,
			);
			return null;
		}
	},
	async loadTediGovernance(
		this: RuntimeParentTurnsHost,
		tediId: string,
	): Promise<{
		budgets: TediBudgets;
		organizationBrowserEgress?: BrowserHostnamePolicy;
		organizationWebSearch?: WebSearchPolicy;
		toolPolicy: ToolPolicy;
	}> {
		const defaults = {
			budgets: TediBudgetsSchema.parse({}),
			toolPolicy: ToolPolicySchema.parse({}),
		};
		const failClosed = {
			budgets: { ...defaults.budgets, browserBudgetDaily: 0 },
			toolPolicy: {
				...defaults.toolPolicy,
				browser: "always-approve" as const,
			},
		};
		const key = identityValue(tediId);
		if (!key) return failClosed;
		try {
			const row = await getTediRuntimeGovernance(this.env.DB, key);
			const decode = (value: unknown): unknown =>
				typeof value === "string" ? JSON.parse(value) : value;
			const organizationMetadata = decode(row?.organizationMetadata) as {
				browserEgress?: unknown;
				webSearch?: unknown;
			} | null;
			// Opt-in switch: an invalid value reads as off instead of failing
			// the rest of the governance load closed.
			const webSearch = WebSearchPolicySchema.safeParse(
				organizationMetadata?.webSearch,
			);
			return {
				budgets: resolveTediBudgets(decode(row?.budgets)),
				organizationBrowserEgress: BrowserHostnamePolicySchema.optional().parse(
					organizationMetadata?.browserEgress,
				),
				organizationWebSearch: webSearch.success ? webSearch.data : undefined,
				toolPolicy: ToolPolicySchema.parse(decode(row?.toolPolicy) ?? {}),
			};
		} catch (error) {
			console.error(
				`[isolate.governance] failed to load policy/budgets for ${tediId}; using fail-safe defaults`,
				error,
			);
			return failClosed;
		}
	},
	async getPlatformClient(
		this: RuntimeParentTurnsHost,
	): Promise<HttpPlatformClient | null> {
		if (this.platformClient) return this.platformClient;
		const { tediId, orgId } = this.state;
		if (!tediId) return null;
		this.platformClient = await resolveBrainBridgePlatformClient({
			env: this.env,
			tediId,
			orgId,
		});
		return this.platformClient;
	},
	/**
	 * Resolves identity once per cold start. Parent Worker injects
	 * `X-Tedi-Id` / `X-Tedi-Org-Id` / `X-Tedi-Slug` on every forwarded request,
	 * so we can hydrate without a D1 round-trip. WebSocket upgrades carry the
	 * same headers via `ConnectionContext.request`.
	 */
	async ensureIdentity(
		this: RuntimeParentTurnsHost,
		hints?: {
			slug?: string;
			tediId?: string;
			orgId?: string;
			authSubject?: string;
		},
	): Promise<void> {
		const configGeneration = this.runtimeConfigCache.generation;
		const hintSlug = identityValue(hints?.slug);
		const hintTediId = identityValue(hints?.tediId);
		const hintOrgId = identityValue(hints?.orgId);
		const cachedSlug = identityValue(this.state.slug);
		const cachedTediId = identityValue(this.state.tediId);
		const cachedOrgId = identityValue(this.state.orgId);
		// Auth subject can change connection-to-connection (different Descope
		// users may share access to a tedi). Track separately from the
		// `identityLoaded` cache so it refreshes even on a warm DO.
		if (hints?.authSubject && this.state.authSubject !== hints.authSubject) {
			this.setState({ ...this.state, authSubject: hints.authSubject });
		}
		// Recompose when the cached prompt predates a code-level prompt change:
		// the `identityLoaded` cache otherwise pins a stale systemPrompt across
		// deploys (DO state survives code rollout). The version tag makes warm
		// DOs self-heal on their next turn — no manual reset.
		if (
			this.state.identityLoaded &&
			cachedSlug &&
			cachedTediId &&
			this.state.systemPromptVersion === AGENT_PROMPT_VERSION &&
			this.state.identityDiagnostics &&
			this.state.identityDiagnostics.missingFiles.length === 0 &&
			this.state.telegramChannel !== undefined
		) {
			if (
				!this.state.toolPolicy ||
				!this.state.budgets ||
				!this.state.governanceLoadedAt ||
				Date.now() - this.state.governanceLoadedAt > GOVERNANCE_CACHE_TTL_MS
			) {
				const governance = await this.loadTediGovernance(cachedTediId);
				if (configGeneration !== this.runtimeConfigCache.generation)
					return this.ensureIdentity(hints);
				this.setState({
					...this.state,
					organizationBrowserEgress: governance.organizationBrowserEgress,
					organizationWebSearch: governance.organizationWebSearch,
					toolPolicy: governance.toolPolicy,
					budgets: governance.budgets,
					governanceLoadedAt: Date.now(),
				});
			}
			// Warm path: identity already cached — reconcile policy-pack crons once.
			this.maybeReconcileCrons();
			return;
		}
		let resolvedSlug =
			hintSlug ?? cachedSlug ?? identityValue(this.name) ?? "tedi";
		let tediId = hintTediId ?? cachedTediId;
		let orgId = hintOrgId ?? cachedOrgId ?? "";

		if (!tediId) {
			const resolved = await this.resolveIdentityFromD1();
			if (resolved) {
				tediId = resolved.tediId;
				orgId = orgId || resolved.orgId;
				resolvedSlug = resolved.slug;
			}
		}

		if (!tediId) {
			this.setState({
				...this.state,
				slug: resolvedSlug,
				orgId,
				identityLoaded: false,
				authSubject: hints?.authSubject ?? this.state.authSubject,
			});
			throw new Error(
				`Unable to resolve isolate tedi identity for ${resolvedSlug}`,
			);
		}
		const identity = await readIdentityFilesWithDiagnostics({
			bucket: this.env.TEDI_STORAGE,
			tediId,
			artifacts: this.env.ARTIFACTS,
			artifactsAccountId: this.env.CF_ACCOUNT_ID,
			artifactsNamespace: TEDIX_ARTIFACTS_NAMESPACE_PRODUCTION,
		});

		const files = identity.files;
		if (tediId !== cachedTediId || orgId !== cachedOrgId) {
			this.platformClient = null;
			this.mcpRuntime = null;
		}
		const telegramChannel = await this.loadTelegramChannel(tediId);
		const governance = await this.loadTediGovernance(tediId);
		if (configGeneration !== this.runtimeConfigCache.generation)
			return this.ensureIdentity(hints);
		this.setState({
			...this.state,
			slug: resolvedSlug,
			tediId,
			orgId,
			identityLoaded: true,
			systemPrompt:
				composeSystemPrompt(resolvedSlug, files) + AGENT_RUNTIME_PROMPT,
			systemPromptVersion: AGENT_PROMPT_VERSION,
			identityDiagnostics: identity.diagnostics,
			authSubject: hints?.authSubject ?? this.state.authSubject,
			telegramChannel,
			organizationBrowserEgress: governance.organizationBrowserEgress,
			organizationWebSearch: governance.organizationWebSearch,
			toolPolicy: governance.toolPolicy,
			budgets: governance.budgets,
			governanceLoadedAt: Date.now(),
		});
		// Cold path: identity just resolved — reconcile policy-pack crons (once,
		// off the hot path).
		this.maybeReconcileCrons();
	},
	hintsFromHeaders(
		this: RuntimeParentTurnsHost,
		headers: Headers,
	): {
		slug?: string;
		tediId?: string;
		orgId?: string;
		authSubject?: string;
	} {
		return {
			slug: headers.get("X-Tedi-Slug") ?? undefined,
			tediId: headers.get("X-Tedi-Id") ?? undefined,
			orgId: headers.get("X-Tedi-Org-Id") ?? undefined,
			// Set by `authenticateAcpUpgrade` in apps/tedi-runtime/src/index.ts
			// for authenticated WS upgrades. Plumbed onto `state.authSubject`
			// so rationale / audit records can attribute the verified owner.
			authSubject: headers.get("X-Tedi-Auth-Subject") ?? undefined,
		};
	},
	/**
	 * Parent governance: model + system prompt + base tools.
	 * MCP tools are per-turn (they need a freshly-bound runtime) so they're
	 * added in `beforeTurn`.
	 */
	/**
	 * Per-tedi AI Gateway attribution tags (`cf-aig-metadata`) for this DO's LLM
	 * calls. Every paid call carries an explicit run, work-item/system purpose,
	 * hashed session, and filterable source. System maintenance never degrades
	 * to silent null attribution.
	 */
	tediAigMetadata(
		this: RuntimeParentTurnsHost,
		source?: string,
		correlation?: {
			runId?: string;
			sessionKey?: string;
			workItemId?: string;
		},
	): AigMetadata {
		const purpose = source ?? inferenceSource(correlation?.sessionKey, "chat");
		const candidateBinding = this.activeTurnBinding;
		// Facets pass an immutable run id. Never borrow a mutable parent binding
		// from another concurrent turn merely to fill its work-item field.
		const binding =
			correlation?.runId && candidateBinding?.runId === correlation.runId
				? candidateBinding
				: null;
		const runId =
			correlation?.runId ??
			binding?.runId ??
			`system:${this.state.tediId ?? "unknown"}:${purpose}`;
		const sessionKey =
			correlation?.sessionKey ?? binding?.sessionKey ?? `system:${purpose}`;
		const workItemId =
			correlation?.workItemId ?? binding?.workItemId ?? `system:${purpose}`;
		return {
			tediId: this.state.tediId,
			orgId: this.state.orgId,
			sessionKeyHash: hashAnalyticsLabel(sessionKey),
			source: purpose,
			attribution: encodeAiGatewayAttribution({
				runId,
				workItemId,
			}),
		};
	},
	inferenceBudgetLimits(this: RuntimeParentTurnsHost): {
		dailyMessageLimit: number;
		dailyTokenLimit: number;
		operatorMessageReserve: number;
		operatorTokenReserve: number;
		governedLearningMessageReserve: number;
		governedLearningTokenReserve: number;
	} {
		const defaults = TediBudgetsSchema.parse({});
		return {
			dailyMessageLimit:
				this.state.budgets?.dailyMessageLimit ?? defaults.dailyMessageLimit,
			dailyTokenLimit:
				this.state.budgets?.dailyTokenLimit ?? defaults.dailyTokenLimit,
			operatorMessageReserve:
				this.state.budgets?.operatorMessageReserve ??
				defaults.operatorMessageReserve,
			operatorTokenReserve:
				this.state.budgets?.operatorTokenReserve ??
				defaults.operatorTokenReserve,
			governedLearningMessageReserve:
				this.state.budgets?.governedLearningMessageReserve ??
				defaults.governedLearningMessageReserve,
			governedLearningTokenReserve:
				this.state.budgets?.governedLearningTokenReserve ??
				defaults.governedLearningTokenReserve,
		};
	},
	/** Atomic admission before provider work. The existing tedi budgets are now
	 * an enforcement contract instead of dashboard-only configuration. */
	admitInferenceTurn(
		this: RuntimeParentTurnsHost,
		turnId: string,
		modelVisible: readonly unknown[],
		admissionClass:
			| "background"
			| "governed_learning"
			| "operator" = "operator",
	): void {
		this.getInferenceBudgetStore().admit(
			turnId,
			this.inferenceBudgetLimits(),
			estimateInferenceTokens(...modelVisible),
			new Date(),
			admissionClass,
		);
	},
	recordInferenceTokens(
		this: RuntimeParentTurnsHost,
		turnId: string,
		tokens: number | null | undefined,
	): void {
		if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0)
			return;
		this.getInferenceBudgetStore().recordTokens(turnId, tokens);
	},
	/**
	 * Settle a facet turn's CUMULATIVE token total into the budget ledger.
	 * Facet turns feed the same cumulative figure through the mid-turn checks
	 * (`checkFacetTurnBudget`), so settlement must be idempotent-on-cumulative
	 * (`checkMidTurn`'s max-ratchet) — the additive `recordTokens` would double
	 * count every token the mid-turn gate already recorded.
	 */
	settleCumulativeInferenceTokens(
		this: RuntimeParentTurnsHost,
		turnId: string,
		tokens: number | null | undefined,
	): void {
		if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0)
			return;
		this.getInferenceBudgetStore().checkMidTurn(
			turnId,
			this.inferenceBudgetLimits(),
			tokens,
		);
	},
	/** Mid-turn budget probe; storage failures propagate to the accounting fence. */
	async checkFacetTurnBudget(
		this: RuntimeParentTurnsHost,
		input: {
			runId: string;
			cumulativeTokens: number;
			stepCount: number;
		},
	): Promise<{ abort: boolean; reason: string | null }> {
		const tokens =
			typeof input.cumulativeTokens === "number" &&
			Number.isFinite(input.cumulativeTokens)
				? Math.max(0, input.cumulativeTokens)
				: 0;
		const verdict = this.getInferenceBudgetStore().checkMidTurn(
			input.runId,
			this.inferenceBudgetLimits(),
			tokens,
		);
		if (!verdict.exhausted) return { abort: false, reason: null };
		const { usage } = verdict;
		console.error(
			JSON.stringify({
				_tr: "budget.mid_turn_abort",
				tediId: this.state.tediId || null,
				runId: input.runId,
				stepCount: input.stepCount,
				cumulativeTokens: tokens,
				usedTokens: usage.usedTokens,
				dailyTokenLimit: usage.dailyTokenLimit,
				admissionClass: usage.admissionClass,
				day: usage.day,
			}),
		);
		return {
			abort: true,
			reason:
				`daily inference token budget exhausted mid-turn ` +
				`(${usage.usedTokens}/${usage.dailyTokenLimit} tokens for ${usage.day}, ` +
				`${usage.admissionClass} class)`,
		};
	},
	backgroundInferenceBudgetUsage(this: RuntimeParentTurnsHost) {
		return this.getInferenceBudgetStore().status(
			this.inferenceBudgetLimits(),
			new Date(),
			"background",
		);
	},
	/**
	 * Decide whether a cron fire is in the daily budget cooling window. The
	 * marker is durable across hibernation, expires at the next UTC accounting
	 * day, and is invalidated immediately when an operator raises a background
	 * ceiling or a usage correction releases capacity.
	 */
	async cronBudgetSuppression(
		this: RuntimeParentTurnsHost,
	): Promise<CronBudgetSuppression | null> {
		const nowMs = Date.now();
		const usage = this.backgroundInferenceBudgetUsage();
		const stored = await this.ctx.storage
			.get<CronBudgetSuppression>(CRON_BUDGET_SUPPRESSION_STORAGE_KEY)
			.catch(() => undefined);
		if (stored && shouldSuppressCronForBudget(stored, usage, nowMs)) {
			return stored;
		}
		if (stored) {
			await this.ctx.storage
				.delete(CRON_BUDGET_SUPPRESSION_STORAGE_KEY)
				.catch(() => {});
		}
		if (!isBackgroundBudgetHardExhausted(usage)) return null;
		const suppression = buildCronBudgetSuppression(
			usage,
			"background inference budget has no remaining capacity",
			nowMs,
		);
		await this.ctx.storage.put(
			CRON_BUDGET_SUPPRESSION_STORAGE_KEY,
			suppression,
		);
		return suppression;
	},
	async suppressCronAfterBudgetFailure(
		this: RuntimeParentTurnsHost,
		workflowId: string,
		reason: string,
	): Promise<void> {
		const dispatch = await this.ctx.storage
			.get<WorkflowDispatchContext>(`wfctx:${workflowId}`)
			.catch(() => undefined);
		if (!dispatch?.cron) return;
		const suppression = buildCronBudgetSuppression(
			this.backgroundInferenceBudgetUsage(),
			reason,
			Date.now(),
		);
		await this.ctx.storage.put(
			CRON_BUDGET_SUPPRESSION_STORAGE_KEY,
			suppression,
		);
		console.warn(
			`[isolate.cron] ${reason}; suppressing scheduled turns until ${new Date(suppression.resetAtMs).toISOString()}`,
		);
	},
	/**
	 * The per-turn model override for a runtime SURFACE. A `{ modelRef }` shape
	 * the shared cognition catalog validates; `undefined` when that surface has no
	 * policy (→ env default). The catalog rejects a provider this body can't
	 * serve, so an Azure ref only steers the Azure deployment and a workers-ai ref
	 * only steers the Workers AI model id.
	 *
	 * Chains (see `model-policy.ts`): chat → `chatModelRef`; cron →
	 * `cronModelRef` → `chatModelRef`; observer → `observerModelRef` only. A
	 * policy carrying just `chatModelRef` therefore selects exactly what it did
	 * before the per-surface fields existed.
	 */
	modelOverrideForSurface(
		this: RuntimeParentTurnsHost,
		surface: ModelPolicySurface,
	): { modelRef: string } | undefined {
		return modelOverrideForSurface(
			this.runtimeConfigCache?.modelPolicy,
			surface,
		);
	},
	/** Interactive/default-surface override. Unchanged pre-existing behaviour. */
	modelOverrideForTurn(
		this: RuntimeParentTurnsHost,
	): { modelRef: string } | undefined {
		return this.modelOverrideForSurface("chat");
	},
	/**
	 * Azure deployment for the post-turn observer/reflector. Only an explicit
	 * `observerModelRef` moves it; with none set this is exactly
	 * `env.AZURE_OBSERVER_DEPLOYMENT`, byte-for-byte the previous behaviour.
	 * `chatModelRef` intentionally does NOT steer the observer.
	 */
	observerDeploymentForTurn(this: RuntimeParentTurnsHost): string {
		const override = this.modelOverrideForSurface("observer");
		if (!override) return this.env.AZURE_OBSERVER_DEPLOYMENT;
		return selectAzureDeployment(
			{ AZURE_CHAT_DEPLOYMENT: this.env.AZURE_OBSERVER_DEPLOYMENT },
			override,
		);
	},
	/**
	 * Resolve this tedi's per-role model policy from the control plane
	 * (`runtime_profile_id → runtime_profiles.config.modelPolicy`)
	 * via the API service binding, ONCE per DO lifetime. Fail-soft: any error →
	 * the last-known stored value, else all-null (env default). Cached in DO
	 * storage so a transient API failure still yields the last-known refs.
	 */
	async ensureModelPolicy(this: RuntimeParentTurnsHost): Promise<void> {
		if (this.runtimeConfigCache.modelPolicy !== undefined) return;
		const configGeneration = this.runtimeConfigCache.generation;
		const tediId = identityValue(this.state.tediId);
		const orgId = identityValue(this.state.orgId);
		// Identity not loaded yet — leave unresolved so a later call (after
		// ensureIdentity) can still fetch the per-role policy.
		if (!tediId || !orgId) return;
		if (this.env.API_SERVICE) {
			// Real-cancel guard: this fetch runs on the cold-start path before any
			// turn-level keepAlive/idle-timeout coverage (only on a cold DO — the result
			// is cached for the DO's lifetime), so an unguarded hang here left
			// step.do("llm-round-N") stalled with zero ledger progress until the
			// ~12min orphan sweep sealed it `runtime_dropped`. Mirrors the AbortController pattern already used for
			// the Azure round's idle-timeout.
			try {
				const body = await callRpc<TediModelPolicyResponse>(
					"tedis/getModelPolicy",
					{ tediId },
					{
						apiUrl: "https://api",
						fetch: serviceBindingFetch(this.env.API_SERVICE),
						headers: tediRuntimeServiceBindingHeaders(
							tediId,
							"apps:read",
							orgId,
						),
						timeoutMs: MODEL_POLICY_FETCH_TIMEOUT_MS,
					},
				);
				if (configGeneration !== this.runtimeConfigCache.generation)
					return this.ensureModelPolicy();
				const policy = normalizeModelPolicy(body);
				this.runtimeConfigCache.modelPolicy = policy;
				await this.ctx.storage.put("model-policy", policy).catch(() => {});
				return;
			} catch (err) {
				console.warn(
					"[isolate.model-policy] getModelPolicy failed; using last-known/default:",
					err instanceof Error ? err.message : String(err),
				);
			}
		}
		// Fall back to the last-known canonical value, else the adaptive default.
		try {
			const cached =
				await this.ctx.storage.get<TediModelPolicyResponse>("model-policy");
			if (configGeneration !== this.runtimeConfigCache.generation)
				return this.ensureModelPolicy();
			this.runtimeConfigCache.modelPolicy = normalizeModelPolicy(cached);
		} catch {
			if (configGeneration !== this.runtimeConfigCache.generation)
				return this.ensureModelPolicy();
			this.runtimeConfigCache.modelPolicy = DEFAULT_TEDI_MODEL_POLICY;
		}
	},
	getSystemPrompt(this: RuntimeParentTurnsHost): string {
		return this.state.systemPrompt || "You are a Tedix digital worker.";
	},
	/** Public facet gate; cancellation reads must fail closed before inference. */
	async assertChatTurnActive(
		this: RuntimeParentTurnsHost,
		runId: string | null | undefined,
	): Promise<void> {
		await assertTediChatNotCanceled(runId, async (id) =>
			Boolean(await this.ctx.storage.get(`wfcancel:${id}`)),
		);
		const admission = this.runtimeAdmission();
		if (admission) await admission.assertAcceptedTurn({ runId: runId! });
	},
	/** The finite rollout installs durable custody explicitly; absence never initializes it. */
	async runMaintenanceEffects(
		this: RuntimeParentTurnsHost,
		task: ParentMaintenanceTask,
		operation: ParentServiceOperation,
	): Promise<MaintenanceEffectResult> {
		const identity = {
			operationId: operation.operationId,
			requestHash: operation.requestHash,
			taskId: task,
		};
		const runId = this.parentServiceRunId(operation);
		const key = `tedix:pi:maintenance:effect:${operation.operationId}`;
		const prior = await this.ctx.storage.get<{
			operation: ParentServiceOperation;
			stage: string;
			receipt?: MaintenanceEffectReceipt;
		}>(key);
		if (prior) {
			await this.runtimeAdmission()?.assertOriginalClaim({
				runId,
				input: prior.operation,
			});
			if (prior.stage === "acknowledged" && prior.receipt) return prior.receipt;
			return { ...identity, status: "uncertain", reason: "unconfirmed" };
		}
		await this.runtimeAdmission()?.assertAcceptedTurn({
			runId,
			input: operation,
		});
		await this.ctx.storage.put(key, { operation, stage: "running" });
		try {
			let artifactsReceipt: ArtifactsPushReceipt | null = null;
			switch (task) {
				case "isolate-daily-log-flush": {
					const cleanup = await this.imageCleanupJournal().redrive();
					if (cleanup.failed)
						throw new Error("Maintenance image cleanup is unresolved");
					artifactsReceipt = await this.onDailyLogFlush(runId);
					break;
				}
				case "isolate-directive-compile":
					await this.onCompileDirectives(runId);
					break;
				case "isolate-brain-digest":
					await this.onCompileBrainDigest(runId);
					break;
				case "isolate-corpus-audit":
					await this.onAuditCorpus(runId);
					break;
				case "isolate-skill-guidance-refresh":
					await this.onRefreshSkillGuidance(runId);
					break;
			}
			await this.runtimeAdmission()?.assertOriginalClaim({
				runId,
				input: operation,
			});
			const acknowledgmentId = `${operation.operationId}:effects`;
			const evidence = {
				operation,
				task,
				acknowledgmentId,
				status: "acknowledged",
				artifactsReceipt,
			};
			const receipt: MaintenanceEffectReceipt = {
				...identity,
				status: "acknowledged",
				acknowledgmentId,
				receiptHash: await this.runtimeReceiptHash(evidence),
			};
			await this.ctx.storage.put(key, {
				operation,
				stage: "acknowledged",
				evidence,
				receipt,
			});
			return receipt;
		} catch (error) {
			await this.ctx.storage.put(key, { operation, stage: "uncertain" });
			logTediRuntimeFailure("tedi.runtime.alarm_telemetry_failed", error);
			return { ...identity, status: "uncertain", reason: "failed" };
		}
	},
	parentServiceRunId(
		this: RuntimeParentTurnsHost,
		operation: ParentServiceOperation,
	): string {
		return operation.kind === "telegram"
			? buildRunId(this.state.tediId, operation.operationId, "chat")
			: operation.operationId;
	},
	parentServiceAdmission(
		this: RuntimeParentTurnsHost,
	): ParentServiceAdmissionHost {
		const selected = (claim?: ParentServiceClaim) => {
			const admission = this.runtimeAdmission();
			if (claim !== undefined && Boolean(admission) !== Boolean(claim))
				throw new Error("Parent service admission selection changed");
			return admission;
		};
		return {
			assertRuntimeActive: async () => {
				const admission = selected();
				if (admission && admission.read()?.state !== "active")
					throw new Error("Parent service runtime is inactive");
			},
			admitAccepted: async (operation) => {
				const admission = selected();
				if (!admission) return null;
				const current = admission.read();
				if (!current || current.state !== "active")
					throw new Error("Parent service runtime is inactive");
				const runId = this.parentServiceRunId(operation);
				const prior = admission.gate.claim(runId);
				const result = await admission.beginAcceptedTurn({
					runId,
					sessionKey: operation.sessionKey ?? operation.operationId,
					principalId: this.state.tediId,
					input: operation,
					expectedGeneration: prior?.generation ?? current.generation,
				});
				return { generation: result.accepted.generation };
			},
			assertOriginal: async (operation, claim) => {
				const admission = selected(claim);
				if (!admission) return;
				const accepted = await admission.assertOriginalClaim({
					runId: this.parentServiceRunId(operation),
					input: operation,
				});
				if (accepted.generation !== claim!.generation)
					throw new Error("Parent service original generation changed");
			},
			assertActive: async (operation, claim) => {
				const admission = selected(claim);
				if (!admission) return;
				const accepted = await admission.assertAcceptedTurn({
					runId: this.parentServiceRunId(operation),
					sessionKey: operation.sessionKey ?? operation.operationId,
					input: operation,
				});
				if (accepted.generation !== claim!.generation)
					throw new Error("Parent service generation changed");
			},
			completeOriginal: async (operation, claim, receipt) => {
				const admission = selected(claim);
				if (!admission) return;
				const runId = this.parentServiceRunId(operation);
				const accepted = await admission.assertOriginalClaim({
					runId,
					input: operation,
				});
				if (accepted.generation !== claim!.generation)
					throw new Error("Parent service original generation changed");
				if (
					operation.kind === "telegram" &&
					!(await this.ctx.storage.get(`runtime-admission-settlement:${runId}`))
				)
					throw new Error("Telegram original ledger is unsettled");
				if (receipt.terminal !== "completed")
					throw new Error("Service terminal receipt is invalid");
				if (operation.kind === "telegram") {
					const journal = await this.ctx.storage.get<{
						operation: ParentServiceOperation;
						claim: ParentServiceClaim;
						stage: string;
						chunks?: string[];
						nextChunk: number;
						messageIds: string[];
					}>(`tedix:pi:telegram:reply:${operation.operationId}`);
					if (
						!journal ||
						!["answered", "completed"].includes(journal.stage) ||
						!Array.isArray(journal.chunks) ||
						!Array.isArray(journal.messageIds) ||
						journal.nextChunk !== journal.chunks.length ||
						journal.messageIds.length !== journal.chunks.length ||
						journal.messageIds.some(
							(id) => typeof id !== "string" || !id.trim(),
						) ||
						journal.claim?.generation !== accepted.generation
					)
						throw new Error(
							"Original Telegram send acknowledgments are unsettled",
						);
					await admission.assertOriginalClaim({
						runId,
						input: journal.operation,
					});
					const expectedHash = await this.runtimeReceiptHash({
						operationId: operation.operationId,
						messageIds: journal.messageIds,
						nextChunk: journal.nextChunk,
					});
					if (receipt.receiptHash !== expectedHash)
						throw new Error("Original Telegram acknowledgment hash changed");
				}
				if (operation.kind === "maintenance") {
					const fire = await this.ctx.storage.get<{
						operation: ParentServiceOperation;
						claim: ParentServiceClaim;
						stage: string;
						effectReceipt?: MaintenanceEffectReceipt;
					}>(`tedix:pi:maintenance:fire:${operation.operationId}`);
					const actual = await this.ctx.storage.get<{
						operation: ParentServiceOperation;
						stage: string;
						receipt?: MaintenanceEffectReceipt;
						evidence?: unknown;
					}>(`tedix:pi:maintenance:effect:${operation.operationId}`);
					if (
						!fire ||
						!["acknowledged", "completed"].includes(fire.stage) ||
						!fire.effectReceipt ||
						fire.claim?.generation !== accepted.generation ||
						!actual ||
						actual.stage !== "acknowledged" ||
						!actual.receipt ||
						!actual.evidence ||
						JSON.stringify(actual.receipt) !==
							JSON.stringify(fire.effectReceipt)
					)
						throw new Error("Original maintenance effect journal is unsettled");
					await admission.assertOriginalClaim({ runId, input: fire.operation });
					await admission.assertOriginalClaim({
						runId,
						input: actual.operation,
					});
					if (
						actual.receipt.receiptHash !==
							(await this.runtimeReceiptHash(actual.evidence)) ||
						receipt.receiptHash !==
							(await maintenanceCompletionReceiptHash(
								operation,
								actual.receipt,
							))
					)
						throw new Error("Original maintenance effect receipt changed");
				}
				await this.completeRuntimeTurn(runId, operation.operationId, receipt);
			},
		};
	},
	async runtimeReceiptHash(
		this: RuntimeParentTurnsHost,
		value: unknown,
	): Promise<string> {
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(value)),
		);
		return Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
	},
	async completeRuntimeTurn(
		this: RuntimeParentTurnsHost,
		runId: string,
		sourceId: string,
		receipt: unknown,
	): Promise<void> {
		const admission = this.runtimeAdmission();
		if (!admission) return;
		const accepted = await admission.recordTerminalReceipt(runId, {
			sourceId,
			receipt,
		});
		const claim = {
			turnId: runId,
			requestHash: accepted.requestHash,
			generation: accepted.generation,
			submissionId: sourceId,
		};
		const evidence = await admission.prepareEvidence("complete", claim);
		admission.gate.completeTurn({ ...claim, evidence });
	},
	runtimeAdmission(this: RuntimeParentTurnsHost): RuntimeAdmissionDO | null {
		if (!readStoredRuntimeAdmission(this.ctx.storage, this.ctx.id.toString()))
			return null;
		if (!this.state.tediId || !this.state.orgId)
			throw new Error("Runtime admission requires stored tenant identity");
		return new RuntimeAdmissionDO(this.ctx.storage, {
			tediId: this.state.tediId,
			orgId: this.state.orgId,
			objectId: this.ctx.id.toString(),
		});
	},
	async dispatchAdmittedChatWorkflow(
		this: RuntimeParentTurnsHost,
		binding: "CHAT_TURN_WORKFLOW",
		params: ChatTurnParams & Pick<FacetWorkflowTurnInput, "operatorConsent">,
		options: { id: string; agentBinding: "TEDI_AGENT" },
	): Promise<void> {
		const admission = this.runtimeAdmission();
		const key = `runtime-admission-workflow:${params.runId}`;
		if (admission) {
			await admission.assertAcceptedTurn({
				runId: params.runId,
				sessionKey: params.sessionKey,
			});
			const prior = await this.ctx.storage.get<{
				params: typeof params;
				id: string;
				stage: string;
			}>(key);
			if (
				prior &&
				(JSON.stringify(prior.params) !== JSON.stringify(params) ||
					prior.id !== options.id)
			)
				throw new Error("Original admitted workflow dispatch changed");
			if (prior?.stage === "dispatched") return;
			if (prior)
				throw new Error("Original native workflow dispatch remains uncertain");
			await this.ctx.storage.put(key, {
				params,
				id: options.id,
				stage: "dispatching",
			});
			await admission.assertAcceptedTurn({
				runId: params.runId,
				sessionKey: params.sessionKey,
			});
		}
		try {
			await this.runWorkflow(binding, params, options);
			if (admission)
				await this.ctx.storage.put(key, {
					params,
					id: options.id,
					stage: "dispatched",
				});
		} catch (error) {
			if (admission)
				await this.ctx.storage.put(key, {
					params,
					id: options.id,
					stage: "uncertain",
				});
			throw error;
		}
	},
	async acceptRuntimeTurn(
		this: RuntimeParentTurnsHost,
		runId: string,
		sessionKey: string,
		input: unknown,
		reuseAccepted = false,
	): Promise<void> {
		const admission = this.runtimeAdmission();
		if (!admission) return;
		const original = admission.gate.claim(runId);
		if (reuseAccepted && original) {
			await admission.assertAcceptedTurn({ runId, sessionKey });
			return;
		}
		const current = admission.read();
		if (!current || current.state !== "active")
			throw new Error("Runtime admission denies new work");
		await admission.beginAcceptedTurn({
			runId,
			sessionKey,
			principalId: this.state.tediId,
			input: JSON.parse(JSON.stringify(input)),
			expectedGeneration: original?.generation ?? current.generation,
		});
		await admission.assertAcceptedTurn({ runId, sessionKey });
	},
	/** Child custody comes from this actual registered facet and accepted parent turn. */
	async getFacetAdmissionCustody(
		this: RuntimeParentTurnsHost,
		input: {
			className: string;
			name: string;
			objectId: string;
			runId: string;
			sessionKey: string;
		},
	) {
		const admission = this.runtimeAdmission();
		const accepted = await admission?.assertAcceptedTurn({
			runId: input.runId,
			sessionKey: input.sessionKey,
		});
		if (
			![
				"ConversationFacet",
				"JudgeSessionFacet",
				"SynthesisSessionFacet",
			].includes(input.className)
		)
			throw new Error("Unrecognized cognitive facet custody");
		const row = this.ctx.storage.sql
			.exec<{ identity_version: string | null; identity_name: string | null }>(
				"SELECT identity_version,identity_name FROM cf_agents_sub_agents WHERE class=? AND name=?",
				input.className,
				input.name,
			)
			.toArray()[0];
		if (!row) throw new Error("Facet custody is not registered");
		const identityName =
			row.identity_version === "path-v2"
				? row.identity_name
				: row.identity_version === null || row.identity_version === "legacy"
					? input.name
					: null;
		if (
			!identityName ||
			this.env.TEDI_AGENT.idFromName(identityName).toString() !== input.objectId
		)
			throw new Error("Facet physical custody mismatch");
		const root: NativeRootProof = {
			owner: {
				orgId: this.state.orgId,
				tediId: this.state.tediId,
				objectId: this.ctx.id.toString(),
			},
			objectName: this.name,
			className: "AgentTediDO",
			path: [],
			generation: accepted?.generation ?? 0,
			...(accepted ? { accepted } : {}),
		};
		// The awaited original claim check is followed by one final local check.
		if (accepted)
			admission!.assertAcceptedTurnSync({
				runId: accepted.runId,
				expected: accepted,
			});
		if (!admission)
			return {
				enabled: false as const,
				root,
				custody: {
					parentPath: [...this.selfPath],
					facetName: input.name,
					identityName,
					objectId: input.objectId,
				},
			};
		return {
			root,
			enabled: true as const,
			owner: { ...admission!.owner, objectId: input.objectId },
			parentGeneration: accepted!.generation,
			principalId: accepted!.principalId,
			custody: {
				parentPath: [...this.selfPath],
				facetName: input.name,
				identityName,
				objectId: input.objectId,
			},
		};
	},
	/** Recovery is additional inference: require durable admission and no cancel. */
	async canRecoverChatTurn(
		this: RuntimeParentTurnsHost,
		runId: string,
	): Promise<boolean> {
		if (!runId || (await this.ctx.storage.get(`wfcancel:${runId}`)))
			return false;
		await this.assertChatTurnActive(runId);
		return this.getInferenceBudgetStore().canRecoverTurn(
			runId,
			this.inferenceBudgetLimits(),
		);
	},
	async recordAlarmMemoryLimitResetTelemetry(
		this: RuntimeParentTurnsHost,
		payload: Record<string, unknown>,
	): Promise<void> {
		try {
			await this.ensureIdentity();
			const { tediId, slug } = this.state;
			if (!tediId) return;
			const platform = await this.getPlatformClient();
			if (!platform) return;
			const now = Date.now();
			const runId = buildRunId(
				tediId,
				`alarm_memory_limit_reset_${now}`,
				"diagnostic",
			);
			const strikes =
				typeof payload.strikes === "number" && Number.isFinite(payload.strikes)
					? payload.strikes
					: undefined;
			const limit =
				typeof payload.limit === "number" && Number.isFinite(payload.limit)
					? payload.limit
					: undefined;
			await platform.recordRuntimeEvent({
				id: `${runId}:alarm-memory-limit-reset`,
				tediId,
				kind: "runtime.health_changed",
				conversationId: buildTediConversationId({
					tediRef: slug || tediId,
					sessionKey: DEFAULT_SESSION_KEY,
				}),
				runId,
				sequence: 790,
				payload: {
					source: "cloudflare-agents-alarm",
					phase: "memory_limit_reset",
					...(strikes !== undefined ? { strikes } : {}),
					...(limit !== undefined ? { limit } : {}),
					...(typeof payload.sealed === "boolean"
						? { sealed: payload.sealed }
						: {}),
					...(typeof payload.error === "string"
						? { error: payload.error }
						: {}),
				},
				runtime: { backend: "cloudflare-agents" },
				createdAt: new Date(now).toISOString(),
			});
		} catch (err) {
			logTediRuntimeFailure("tedi.runtime.alarm_telemetry_failed", err);
		}
	},
	/**
	 * The turn's step ceiling, or `null` when no step count ends the turn. D1
	 * governance owns it: an explicit per-tedi budget wins, otherwise the plan
	 * entitlement does, bounded by {@link MAX_CHAT_STEPS}; an unlimited or
	 * absent entitlement means no step stop. The active HarnessVersion keeps
	 * only the auditable stop-rule descriptor, so a legacy harness stamped with
	 * the old 10-step default can never become a second configuration store.
	 */
	effectiveStepCeiling(this: RuntimeParentTurnsHost): number | null {
		return resolveGovernedStepCeiling({
			maxIterationsPerTask: this.state.budgets?.maxIterationsPerTask,
			hardMaxSteps: MAX_CHAT_STEPS,
		});
	},
	/**
	 * The loop-policy descriptor stamped onto the HarnessVersion for audit: the
	 * stop rule plus the governed ceiling (or the backstop when ungoverned), so
	 * a change in live entitlement still bumps the version.
	 */
	auditLoopPolicy(this: RuntimeParentTurnsHost): HarnessLoopPolicy {
		return {
			...(this.state.harnessLoopPolicy ?? HARNESS_LOOP_POLICY),
			maxSteps: this.effectiveStepCeiling() ?? MAX_CHAT_STEPS,
		};
	},
	/**
	 * True when the active turn's conversation belongs to an ephemeral
	 * (`__throwaway:` / `__test:`) session. ALL per-turn ledger writes that bind
	 * to `activeTurnBinding` (step.completed telemetry + context.injected
	 * directive/subagent rows) gate on this — parity with the `onLedgerMirror` /
	 * `onBridgeTurn` / `mirrorFailedTurn` gates — so test-harness traffic leaves
	 * no durable ledger trace. conversationId is `${slug}:${sessionKey}`.
	 */
	isEphemeralConversation(
		this: RuntimeParentTurnsHost,
		conversationId: string | null | undefined,
	): boolean {
		if (!conversationId) return false;
		const slug = identityValue(this.state.slug);
		const sessionKey =
			slug && conversationId.startsWith(`${slug}:`)
				? conversationId.slice(slug.length + 1)
				: conversationId;
		return isEphemeralSession(sessionKey);
	},
	/**
	 * Shared guard preamble for every per-turn ledger/telemetry write
	 * (`step.completed`, `message.progress`, `step.retry`, `context.injected`).
	 * Resolves the (tediId, runId, conversationId, platform) tuple the write
	 * binds to, or `null` when the write must be skipped:
	 *  - no tedi identity in DO state;
	 *  - no turn runId — never fabricate a Date.now()-derived one (an orphan
	 *    event under a runId no ledger turn shares is the corruption the
	 *    turn-binding refactor removed). `fallbackRunId` may stand in when the
	 *    caller carries its own (the retry path's workflow rounds);
	 *  - ephemeral (`__throwaway:`/`__test:`) conversations, which leave no
	 *    durable trace — checked on the RESOLVED conversationId, fallbacks
	 *    included;
	 *  - no platform client.
	 * `binding` overrides `this.activeTurnBinding` for turn families that
	 * thread an explicit {@link ActiveTurnBinding} instead of maintaining the
	 * instance field. `warnLabel` opts into one console.warn per skip reason
	 * (the step.completed path's observability; quieter paths omit it).
	 */
	async resolveTurnTelemetry(
		this: RuntimeParentTurnsHost,
		opts?: {
			binding?: ActiveTurnBinding | null;
			fallbackRunId?: string;
			fallbackConversationId?: string;
			warnLabel?: string;
		},
	): Promise<{
		tediId: string;
		runId: string;
		conversationId: string;
		platform: HttpPlatformClient;
	} | null> {
		const { tediId, slug } = this.state;
		const warn = (reason: string) => {
			if (opts?.warnLabel) {
				console.warn(`[${opts.warnLabel}] skipped: ${reason}`);
			}
		};
		if (!tediId) {
			warn("no tediId in state (state.tediId empty at telemetry record)");
			return null;
		}
		const active =
			opts && Object.hasOwn(opts, "binding")
				? opts.binding
				: this.activeTurnBinding;
		const runId = active?.runId ?? opts?.fallbackRunId;
		if (!runId) {
			warn(`no turn runId (tedi=${tediId})`);
			return null;
		}
		const conversationId =
			active?.conversationId ??
			opts?.fallbackConversationId ??
			`${slug || tediId}:agent:main:main`;
		if (this.isEphemeralConversation(conversationId)) return null;
		const platform = active?.platform ?? (await this.getPlatformClient());
		if (!platform) {
			warn(`no platform client (tedi=${tediId})`);
			return null;
		}
		return { tediId, runId, conversationId, platform };
	},
	/**
	 * Write one `step.completed` ledger event from an already-shaped payload.
	 * Called by native facet provider settlement on all turn paths (Tedix
	 * OS SSE `streamChatTurn` + WS chat). Best-effort: guards on identity +
	 * platform, never throws into a turn.
	 */
	async recordStepEvent(
		this: RuntimeParentTurnsHost,
		payload: StepTelemetryPayload,
		options?: {
			alreadyBuffered?: boolean;
			binding?: ActiveTurnBinding | null;
			fallbackRunId?: string;
			fallbackConversationId?: string;
		},
	): Promise<void> {
		try {
			const ctx = await this.resolveTurnTelemetry({
				...(options && Object.hasOwn(options, "binding")
					? { binding: options.binding }
					: {}),
				fallbackRunId: options?.fallbackRunId,
				fallbackConversationId: options?.fallbackConversationId,
				warnLabel: "isolate.step",
			});
			if (!ctx) return;
			const { tediId, runId, conversationId } = ctx;
			const sequence = this.stepEventSequence.next();
			// Buffer the step's tool/usage telemetry for this run so the post-turn
			// trace-bundle writer can emit tool-calls.jsonl (no diagnostics_channel).
			if (!options?.alreadyBuffered) {
				this.bufferToolStep(runId, {
					stepNumber: payload.stepNumber,
					finishReason: payload.finishReason,
					provider: payload.provider,
					model: payload.model,
					toolNames: payload.toolNames,
					toolCallCount: payload.toolCallCount,
					toolResultCount: payload.toolResultCount,
					usage: payload.usage as Record<string, number | null>,
				});
			}
			// Observational: durable locally, published to the ledger in the
			// background. `resolveTurnTelemetry` above still gates on a live
			// platform client, so a no-platform DO records nothing (unchanged).
			// `onLedgerMirror` drains the run before the terminal chain, so
			// run-completion visibility still implies step visibility.
			await this.eventOutbox.publish({
				id: `${runId}:step:${payload.stepNumber}:${sequence}`,
				tediId,
				kind: "step.completed",
				conversationId,
				runId,
				sequence,
				payload,
				runtime: { backend: "cloudflare-agents" },
				createdAt: new Date().toISOString(),
			});
			markStepCompleted({
				tediId,
				runId,
				stepNumber: payload.stepNumber,
				finishReason: payload.finishReason,
				durationMs: payload.durationMs,
				inputTokens: payload.usage?.inputTokens ?? null,
				outputTokens: payload.usage?.outputTokens ?? null,
			});
			// Per-step signal lives entirely in the D1 ledger (`step.completed`
			// above) + the `_tr:"step"` console marker. The prior RUNTIME_ANALYTICS
			// `runtime_step` datapoint was write-only (zero readers) and fired on
			// every model step — the hottest write on the runtime hot path — so it
			// was removed. facet_turn + dangling_turn AE writes stay.
			if (this.env.ENVIRONMENT === "development") {
				console.log(
					`[isolate.step] recorded step.completed step=${payload.stepNumber} run=${runId} tools=${payload.toolCallCount}`,
				);
			}
		} catch (err) {
			// Telemetry is best-effort — never let a ledger write break a turn.
			logTediRuntimeFailure("tedi.runtime.step_telemetry_failed", err);
		}
	},
	/**
	 * Canonical per-model-round telemetry for a ConversationFacet. The facet
	 * owns Pi's task graph, so its real StepContext never reaches this parent's
	 * onStepFinish hook. Bind explicitly to the facet run instead of consulting
	 * activeTurnBinding, which may belong to another concurrent facet.
	 */
	async recordFacetModelStep(
		this: RuntimeParentTurnsHost,
		input: {
			payload: StepTelemetryPayload;
			runId: string;
			sessionKey: string;
		},
	): Promise<void> {
		if (!input.runId || !input.sessionKey) return;
		const { tediId, slug } = this.state;
		if (!tediId) return;
		await this.recordStepEvent(input.payload, {
			binding: null,
			fallbackRunId: input.runId,
			fallbackConversationId: buildTediConversationId({
				tediRef: slug || tediId,
				sessionKey: input.sessionKey,
			}),
		});
	},
	/**
	 * Ledger mirror callback.
	 *
	 * Emits the canonical 4-event sequence (message.received, run.started,
	 * message.completed, run.completed) to the cognitive-runtime ledger so
	 * Tedix OS, events_poll, and audit surfaces have a durable trail
	 * matching what container tedis produce. Single emitter (DO only); no
	 * edge mirror. Fail-soft — chat must never break on ledger write failures.
	 */
	async onLedgerMirror(
		this: RuntimeParentTurnsHost,
		payload: {
			sessionKey: string;
			user: RecentTurn;
			assistant: RecentTurn;
			/**
			 * Pre-built STABLE runId for this turn (`{tediId}:{surface}:{turnKey}`),
			 * derived by the entry point from the inbound client id. The 4-event chain
			 * and the trace bundle key off this exact id.
			 */
			runId: string;
			/** Cross-layer request trace propagated from the MCP gateway, when present. */
			traceId?: string;
			/** Surface tag — informational; the runId already encodes the surface. */
			origin?: string;
			/** Structured early-stop reason for partial facet turns. */
			stopReason?: string;
			/** Durable Code Mode paused this turn before applying its pending action. */
			durableCodePause?: DurableCodePause;
			/**
			 * Aggregate model-reported token usage for a FACET turn (MCP/mesh, durable
			 * workflow, Tedix OS SSE, email). Pi facets own provider settlement, so
			 * the parent cannot infer their usage — this carries the
			 * facet's own accumulation so `run.completed.tokensUsed` (the flywheel's
			 * `averageTokenCost` read) is not dark. Absent for parent-loop turns, whose
			 * usage still comes from the step buffer (`peekTotalTokens`).
			 */
			facetUsage?: FacetTurnUsage;
		},
	): Promise<void> {
		try {
			// Ephemeral (test/validation) sessions opt out of durable ledger
			// mirroring — see `isEphemeralSession`. The turn already ran + replied;
			// we just never record it, so harnesses don't pollute the ledger.
			if (isEphemeralSession(payload.sessionKey)) {
				if (this.runtimeAdmission())
					await this.completeRuntimeTurn(
						payload.runId,
						`${payload.runId}:ephemeral-answer`,
						{
							kind: "ephemeral_owned_answer",
							sessionKey: payload.sessionKey,
							assistant: payload.assistant,
						},
					);
				return;
			}
			await this.ensureIdentity();
			const { tediId, orgId, slug } = this.state;
			if (!tediId) {
				console.warn("[isolate-ledger-mirror] no tediId; skipping turn");
				return;
			}
			const platform = await this.getPlatformClient();
			if (!platform) {
				// T1.5: platform is null here, so NO durable `recordRuntimeEvent` is
				// possible (no transport). Emit a content-free console marker so
				// the dropped mirror is observable without session identifiers.
				// Mirror fail-soft is UNCHANGED — a dropped ledger write must never
				// fail the user turn. (The `runtime.mirror_skipped` ledger kind is
				// reserved for any future path that DOES have a platform client.)
				logTediRuntimeDiagnostic("tedi.runtime.turn_mirror_unavailable");
				return;
			}
			const conversationId = buildTediConversationId({
				tediRef: slug || tediId,
				sessionKey: payload.sessionKey,
			});
			const seen = this.state.ledgerConversationsSeen ?? [];
			const emitConversationCreated = !seen.includes(conversationId);

			// Peek at step telemetry BEFORE emitTraceBundleForRun drains it via
			// takePendingToolSteps — same totalTokens sum the scores.json accumulator
			// computes, lifted into run.completed so the durable ledger carries
			// turn-level token counts for the isolate body (parity with the kernel).
			const stepTotalTokens = this.peekTotalTokens(payload.runId);
			// Both terminal envelopes use the same real step usage and observed
			// identity. Mixed or missing model identities remain unknown.
			const usageSteps = this.peekPendingToolSteps(payload.runId);
			const usage =
				stepTotalTokens != null
					? bodyExecutionUsageFromSteps(usageSteps)
					: undefined;
			// Scalar tokensUsed for run.completed (the flywheel's `averageTokenCost`
			// read): prefer the FACET-reported turn total when present, else the
			// parent step-buffer total. Strict superset — a facet turn goes null →
			// its real total; a parent-loop turn (facetUsage absent) is byte-identical
			// to before. NULL-ABSENT preserved end to end: `facetUsage.totalTokens` is
			// itself null unless a facet step reported a finite total, so `?? step`
			// still yields null when neither source has data and `mirrorTurnToLedger`
			// omits the field (never a fabricated zero).
			const tokensUsed = payload.facetUsage?.totalTokens ?? stepTotalTokens;
			// Visibility barrier. Step/tool rows for this run publish in the
			// background (see `runtime-event-outbox.ts`); the kernel reconstructs a
			// delegated child's answer from its `tool.completed` rows as soon as it
			// sees `run.completed`, so drain the run before writing the lifecycle
			// chain. Off the answer's hot path — this mirror is queued (chat/MCP)
			// or runs inside the workflow commit, never between model rounds.
			await this.eventOutbox.flush(payload.runId);
			let terminalDropped = false;
			await mirrorTurnToLedger({
				platform: this.eventOutbox.orderedSink(platform),
				tediId,
				organizationId: orgId || undefined,
				conversationId,
				runId: payload.runId,
				traceId: payload.traceId,
				userTurn: {
					content: payload.user.content,
					...(payload.user.attachments?.length
						? { attachments: payload.user.attachments }
						: {}),
					ts: payload.user.ts,
				},
				assistantTurn: {
					content: payload.assistant.content,
					ts: payload.assistant.ts,
				},
				emitConversationCreated,
				tokensUsed,
				usage,
				stopReason: payload.stopReason,
				durableCodePause: payload.durableCodePause,
				onTerminalDrop: async (event) => {
					terminalDropped = true;
					await this.enqueueLedgerOutbox(event);
				},
			});

			const admission = this.runtimeAdmission();
			if (admission) {
				await admission.assertOriginalClaim({
					runId: payload.runId,
					sessionKey: payload.sessionKey,
				});
				const outbox = await this.eventOutbox.inspectRun(payload.runId);
				if (
					terminalDropped ||
					outbox.observational ||
					outbox.terminal ||
					outbox.blockedPending ||
					outbox.blockedInMemory ||
					outbox.inFlight
				)
					throw new Error("Original run ledger delivery is unsettled");
				const receipt = {
					sessionKey: payload.sessionKey,
					assistant: payload.assistant,
					stopReason: payload.stopReason ?? null,
				};
				await this.ctx.storage.put(
					`runtime-admission-settlement:${payload.runId}`,
					receipt,
				);
				const row = this.ctx.storage.sql
					.exec<{ input: string }>(
						"SELECT input FROM runtime_admission_identities WHERE run_id=?",
						payload.runId,
					)
					.toArray()[0];
				if (!row) throw new Error("Missing original run admission input");
				if (JSON.parse(row.input).kind !== "telegram")
					await this.completeRuntimeTurn(
						payload.runId,
						`${payload.runId}:ledger`,
						receipt,
					);
			}

			if (emitConversationCreated) {
				this.setState({
					...this.state,
					ledgerConversationsSeen: [...seen, conversationId].slice(-200),
				});
			}

			// Harness-version + trace-bundle emission (body version, harness
			// version, certification status, and trace bundle IDs per run). Runs in this queued, retried, off-hot-path context after the
			// 4-event chain is written. Best-effort: a harness write must never
			// invalidate the ledger mirror it follows.
			await this.emitTraceBundleForRun({
				platform,
				tediId,
				orgId: orgId || undefined,
				conversationId,
				sessionKey: payload.sessionKey || DEFAULT_SESSION_KEY,
				runId: payload.runId,
				startedAt: new Date(payload.user.ts).toISOString(),
				endedAt: new Date(payload.assistant.ts).toISOString(),
				emitConversationCreated,
			});
		} catch (err) {
			logTediRuntimeFailure("tedi.runtime.turn_mirror_failed", err, "error");
			if (this.runtimeAdmission()) throw err;
			// Fail-soft — never break chat.
		}
	},
	/**
	 * Mirror a FAILED turn into the ledger (message.received + run.started +
	 * run.failed) so a turn that aborted (LLM error, empty assistant message)
	 * is visible in `tedi_runtime_events` instead of emitting nothing. Shares
	 * the success path's conversationId + (tediId, origin, userTs) runId shape
	 * so the failed run correlates with any tool.* events emitted before the
	 * abort. Fail-soft — the ledger emission must never throw and break the
	 * response.
	 */
	async mirrorFailedTurn(
		this: RuntimeParentTurnsHost,
		input: {
			sessionKey: string;
			/** Pre-built stable runId (`{tediId}:{surface}:{turnKey}`) for this turn. */
			runId: string;
			/** Cross-layer request trace propagated from the MCP gateway, when present. */
			traceId?: string;
			user: RecentTurn;
			assistant?: RecentTurn;
			error: string;
			/** Recovery-exhaustion context, attached to the `run.failed` payload. */
			recovery?: MirrorFailedTurnOpts["recovery"];
		},
	): Promise<void> {
		try {
			// Ephemeral (test/validation) sessions are never durably recorded —
			// not even their failures (see `isEphemeralSession`).
			if (isEphemeralSession(input.sessionKey)) return;
			await this.ensureIdentity();
			const { tediId, orgId, slug } = this.state;
			if (!tediId) return;
			const platform = await this.getPlatformClient();
			if (!platform) {
				logTediRuntimeDiagnostic(
					"tedi.runtime.failed_turn_mirror_unavailable",
					"error",
				);
				return;
			}
			const conversationId = buildTediConversationId({
				tediRef: slug || tediId,
				sessionKey: input.sessionKey,
			});
			const seen = this.state.ledgerConversationsSeen ?? [];
			const emitConversationCreated = !seen.includes(conversationId);

			// Visibility barrier. Step/tool rows for this run publish in the
			// background (see `runtime-event-outbox.ts`); the kernel reconstructs a
			// delegated child's answer from its `tool.completed` rows as soon as it
			// sees `run.completed`, so drain the run before writing the lifecycle
			// chain. Off the answer's hot path — this mirror is queued (chat/MCP)
			// or runs inside the workflow commit, never between model rounds.
			await this.eventOutbox.flush(input.runId);
			await mirrorFailedTurnToLedger({
				platform: this.eventOutbox.orderedSink(platform),
				tediId,
				organizationId: orgId || undefined,
				conversationId,
				runId: input.runId,
				traceId: input.traceId,
				userTurn: {
					content: input.user.content,
					...(input.user.attachments?.length
						? { attachments: input.user.attachments }
						: {}),
					ts: input.user.ts,
				},
				assistantTurn: input.assistant
					? { content: input.assistant.content, ts: input.assistant.ts }
					: undefined,
				error: input.error,
				recovery: input.recovery,
				emitConversationCreated,
				onTerminalDrop: (event) => this.enqueueLedgerOutbox(event),
			});

			if (emitConversationCreated) {
				this.setState({
					...this.state,
					ledgerConversationsSeen: [...seen, conversationId].slice(-200),
				});
			}
		} catch (err) {
			logTediRuntimeFailure(
				"tedi.runtime.failed_turn_ledger_write_failed",
				err,
				"error",
			);
			// Fail-soft — never break the response.
		}
	},
	/**
	 * Last-resort durable lane for TERMINAL ledger events
	 * (run.completed/failed/canceled) that exhausted the mirror's in-process
	 * retries. Settlement reads the ledger, so a dropped terminal event silently
	 * orphans the run. Mechanism lives in `runtime-event-outbox.ts`.
	 */
	async enqueueLedgerOutbox(
		this: RuntimeParentTurnsHost,
		event: TediRuntimeEvent,
	): Promise<void> {
		await this.eventOutbox.enqueueTerminal(event);
	},
	/** Scheduled redrive of the ledger outbox; reschedules while non-empty. */
	async redriveLedgerOutbox(this: RuntimeParentTurnsHost): Promise<void> {
		if (await this.eventOutbox.redrive()) {
			await this.schedule(
				LEDGER_OUTBOX_REDRIVE_SECONDS,
				"redriveLedgerOutbox",
				{},
				{ idempotent: true, retry: { maxAttempts: 3 } },
			);
		}
	},
	messagesForSession(this: RuntimeParentTurnsHost, sessionKey: string) {
		return this.sessionRepo
			.listTurns()
			.filter((turn) => (turn.sessionKey || DEFAULT_SESSION_KEY) === sessionKey)
			.map((turn) => ({
				role: turn.role,
				content: turn.content,
				text: turn.content,
				ts: turn.ts,
				timestamp: turn.ts,
			}));
	},
	/**
	 * Tedix-owned per-conversation model-context builder — the read half of the
	 * isolate session-harness contract;
	 * see docs/engineering/tedi/agent-runtime.md). Returns the `{role,content}`
	 * history for ONE conversation, **filtered by `sessionKey`** so the model
	 * never sees turns from a different conversation.
	 *
	 * LEDGER-FIRST: the harness reconstructs prior history from the canonical D1
	 * ledger (`tedi_runtime_events`) and merges the in-flight tail from the
	 * append-only session repo's bounded hot projection — so a fresh/rebound DO
	 * (body swap, eviction, cold start) still gets full per-conversation context,
	 * not just the cache.
	 * Every turn path MUST build context through `this.sessionHarness` — a raw
	 * session-repo read leaks cross-session context into the prompt and loses
	 * durable history on a cold body. (The `buildSessionContext` thin alias was
	 * deleted with its last caller.)
	 */
	/**
	 * Shared message-read logic for both the `messages_read` MCP tool and the
	 * `/__internal/messages/read` service-binding route used by the Tedix OS's SSR
	 * transcript loader. Ledger first (durable, cross-runtime visible); DO state
	 * fallback covers in-session continuity before the +1s mirror lands AND
	 * environments where the ledger read fails.
	 */
	async readMessagesForSession(
		this: RuntimeParentTurnsHost,
		sessionKey: string,
		limit?: number,
	) {
		const conversationId = buildTediConversationId({
			tediRef: this.state.slug || this.state.tediId,
			sessionKey,
		});
		const tediId = this.state.tediId;
		const localMessages = this.messagesForSession(sessionKey).slice(
			-(limit ?? 50),
		);
		const ledgerRead = tediId
			? await readLedgerConversation({
					env: this.env,
					tediId,
					conversationId,
					limit: limit ?? 50,
				})
			: null;
		const ledger = ledgerRead?.messages ?? null;
		if (ledger && ledger.length > 0 && ledger.length >= localMessages.length) {
			return {
				session_key: sessionKey,
				messages: ledger.map((m) => {
					const ts = Date.parse(m.createdAt) || Date.now();
					return {
						role: m.role,
						content: m.content,
						text: m.content,
						ts,
						timestamp: ts,
					};
				}),
			};
		}
		return {
			session_key: sessionKey,
			messages: localMessages,
		};
	},
	async readConversationForSession(
		this: RuntimeParentTurnsHost,
		sessionKey: string,
	) {
		const result = await this.readMessagesForSession(sessionKey);
		return {
			session_key: sessionKey,
			title: this.state.slug || this.name || "main",
			messageCount: result.messages.length,
			messages: result.messages,
		};
	},
	async readConversationSummaryForSession(
		this: RuntimeParentTurnsHost,
		sessionKey: string,
	) {
		const conversation = await this.readConversationForSession(sessionKey);
		const last = conversation.messages[conversation.messages.length - 1];
		return {
			session_key: conversation.session_key,
			title: conversation.title,
			messageCount: conversation.messageCount,
			updatedAt: last?.ts ?? null,
		};
	},
};
