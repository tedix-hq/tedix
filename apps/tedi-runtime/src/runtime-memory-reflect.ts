import {
	buildTediConversationId,
	isBlindVerificationSession,
} from "@tedix/api-contract/utils/runtime-identity";
import { parseObserverResult } from "@tedix/context-core/observer";
import { OBSERVER_SYSTEM_PROMPT } from "@tedix/context-core/prompts";
import { tokensForSerialized } from "@tedix/context-core/reflector";
import type { Observation, ObserverResult } from "@tedix/context-core/types";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import { errorMessage } from "@tedix/worker-kit/error-message";
import { adaptiveLearningModeForTurn } from "./adaptive-learning";
import { recordTurnSummaryArtifact } from "./artifact-recorder";
import { bridgeObservations } from "./brain/bridge";
import { runCrystallization } from "./brain/crystallizer";
import { runRationaleBridge } from "./brain/rationale-bridge";
import { reflect } from "./brain/reflector";
import { promoteWorkItems } from "./brain/task-bridge";
import type { BridgeTurnInput } from "./bridge-turn-input";
import {
	LEARNING_BRIDGE_TIMEOUT_MS,
	learningPassStatus,
	learningStageDeadline,
	runLearningStage,
} from "./learning-stages";
import {
	createTurnLearningTelemetry,
	type LearningTelemetry,
} from "./learning-telemetry";
import { isEphemeralSession, sanitizeTurnKey } from "./ledger-mirror";
import { resolveSurfaceModelRef } from "./model-policy";
import {
	buildMemorySourceEvidence,
	buildObserverInput,
	ensureTerminalEpisodeObservation,
} from "./observer-execution-evidence";
import { observerCompletion } from "./observer-llm";
import type { RuntimeMemoryHost } from "./runtime-memory";

/**
 * Llama 3.3 sometimes wraps JSON in ```json … ``` fences. Strip them so the
 * downstream `parseObserverResult` (which calls JSON.parse directly) doesn't
 * fail on otherwise-valid payloads.
 */
function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) return trimmed;
	const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/i, "");
	const withoutClose = withoutOpen.replace(/\n?```\s*$/, "");
	return withoutClose.trim();
}

/**
 * Serialize an observation set for Reflector token accounting + LLM input.
 *
 * The container plugin reaches into its tedix-context store layer for this; the
 * isolate has no such store, so we use a stable JSON form. The exact shape only
 * needs to be self-consistent — the Reflector compares before/after token
 * counts of the SAME serializer to decide whether condensation actually shrank
 * the set (the "reflection expanded → keep original" safety check).
 */
function serializeObservationsForReflector(
	observations: Observation[],
): string {
	return JSON.stringify(observations);
}

/**
 * Reflector token threshold. Below this the per-turn Observer output is bridged
 * raw — short turns skip the extra condensation LLM call entirely (no cost).
 * Above it, the shared `reflect()` consolidates the observation set before the
 * brain bridge. Matches tedix-context's ~35k `reflectThresholdTokens` default.
 */
const REFLECT_THRESHOLD_TOKENS = 35_000;

/** Canonical observer write followed by fail-soft durable projections. */
export async function runBridgeTurnInner(
	this: RuntimeMemoryHost,
	payload: BridgeTurnInput,
	signal: AbortSignal,
	telemetry: LearningTelemetry,
	deadlineAt: number,
): Promise<void> {
	try {
		signal.throwIfAborted();
		await this.ensureIdentity();
		const platformClient = await this.getPlatformClient();
		const platform =
			platformClient &&
			this.admittedEffectPort(
				platformClient.forRequest({
					signal,
					traceId: payload.traceId ?? payload.runId,
				}),
				`${payload.runId}:memory`,
			);
		if (!platformClient || !platform) {
			if (this.runtimeAdmission())
				throw new Error("Original memory platform is unavailable");
			telemetry.finish("skipped", "no_platform_client");
			console.warn(
				"[isolate-brain-bridge] no platform client (missing tediId or DESCOPE_ACCESS_KEY); skipping turn",
			);
			return;
		}
		// Each optional stage gets a client bound to its own abort signal.
		const platformFor = (stageSignal: AbortSignal) =>
			this.admittedEffectPort(
				platformClient.forRequest({
					signal: stageSignal,
					traceId: payload.traceId ?? payload.runId,
				}),
				`${payload.runId}:memory`,
			);
		signal.throwIfAborted();

		// Observer surface: `observerModelRef` when the profile sets one, else
		// exactly `env.AZURE_OBSERVER_DEPLOYMENT`. Resolve the policy first so
		// this background bridge does not depend on a prior turn having cached
		// it; `ensureModelPolicy` is itself fail-soft and a no-op once cached.
		await this.ensureModelPolicy().catch(() => {});
		signal.throwIfAborted();
		const observerDeployment = this.modelOverrideForSurface(
			"observer",
		)?.modelRef.startsWith("azure-openai/")
			? this.observerDeploymentForTurn()
			: undefined;
		const observerModelRef = resolveSurfaceModelRef(
			this.runtimeConfigCache.modelPolicy,
			"observer",
		);

		const observerUser = {
			...payload.user,
			sessionKey: payload.sessionKey ?? payload.user.sessionKey,
		};
		const observerInput = buildObserverInput(
			observerUser,
			payload.assistant,
			payload.executionEvidence,
		);

		telemetry.observer.configuredModel =
			observerModelRef ??
			observerDeployment ??
			this.env.AZURE_OBSERVER_DEPLOYMENT;
		telemetry.observer.inputChars = observerInput.length;
		const observerStarted = performance.now();
		let raw: string | undefined;
		let parsed: ObserverResult;
		try {
			const beforeDispatch = this.observerBeforeDispatch(
				`${payload.runId}:memory`,
				payload.runId,
			);
			beforeDispatch();
			raw = await observerCompletion({
				beforeDispatch,
				env: this.env,
				signal,
				deployment: observerDeployment,
				modelRef: observerModelRef,
				metadata: {
					...this.tediAigMetadata("observer:post-turn", {
						runId: payload.runId,
						sessionKey: payload.sessionKey ?? payload.user.sessionKey,
					}),
				},
				messages: [
					{ role: "system", content: OBSERVER_SYSTEM_PROMPT },
					{ role: "user", content: observerInput },
				],
			});
			const cleaned = stripCodeFences(raw);
			parsed = parseObserverResult(cleaned);
			telemetry.observer.status = "completed";
		} catch (err) {
			if (this.runtimeAdmission()) throw err;
			telemetry.observer.status = "failed";
			signal.throwIfAborted();
			console.warn("[isolate-brain-bridge] Observer LLM call failed:", {
				error: errorMessage(err),
			});
			parsed = { observations: [] };
		} finally {
			telemetry.observer.durationMs = Math.round(
				performance.now() - observerStarted,
			);
		}
		signal.throwIfAborted();
		telemetry.observer.observations = parsed.observations.length;
		if (parsed.observations.length === 0) {
			console.log(
				`[isolate-brain-bridge] Observer produced 0 observations (raw_len=${raw?.length ?? 0}); using terminal episode fallback`,
			);
		}
		const rationaleObservations = ensureTerminalEpisodeObservation(
			parsed.observations,
			observerUser,
			payload.assistant,
			payload.executionEvidence,
		);

		// Condense large observation sets before canonical learning; rationale
		// and crystallization still inspect the unmerged observer output below.
		let bridgeObservationsSet = parsed.observations;
		const observationTokens = tokensForSerialized(
			serializeObservationsForReflector(parsed.observations),
		);
		telemetry.reflector.inputTokens = observationTokens;
		telemetry.reflector.status = "below_threshold";
		if (observationTokens >= REFLECT_THRESHOLD_TOKENS) {
			const reflectorStarted = performance.now();
			telemetry.reflector.status = "no_client";
			try {
				const llm = this.getObserverLlmClient(
					`${payload.runId}:memory`,
					payload.runId,
				);
				if (llm) {
					telemetry.reflector.status = "invoked";
					const reflection = await reflect({
						observations: parsed.observations,
						llm,
						model: observerModelRef ?? observerDeployment ?? "cloudflare/auto",
						serialize: serializeObservationsForReflector,
						signal,
					});
					bridgeObservationsSet = reflection.observations;
					console.log(
						`[isolate-reflector] tokens=${observationTokens} merged=${reflection.mergedCount} ` +
							`kept=${reflection.keptCount} before=${reflection.tokensBefore} after=${reflection.tokensAfter} tedi=${this.state.slug}`,
					);
				}
			} catch (reflectErr) {
				if (this.runtimeAdmission()) throw reflectErr;
				telemetry.reflector.status = "failed";
				signal.throwIfAborted();
				console.warn(
					"[isolate-reflector] condensation failed; using raw observations:",
					reflectErr,
				);
				bridgeObservationsSet = parsed.observations;
			} finally {
				telemetry.reflector.durationMs = Math.round(
					performance.now() - reflectorStarted,
				);
			}
		}
		telemetry.reflector.outputObservations = bridgeObservationsSet.length;

		signal.throwIfAborted();
		// Essential path: the canonical fact write runs first, under the
		// pass's own signal, before any optional projection starts.
		const bridgeStarted = performance.now();
		let bridgeStatus: "completed" | "failed" = "failed";
		let bridged: number;
		try {
			bridged = await bridgeObservations({
				observations: bridgeObservationsSet,
				minPriority: "medium",
				platform,
				dedup: this.getDedupStore(),
				currentTask: parsed.currentTasks?.[0],
				sourceEvidence: buildMemorySourceEvidence(
					observerUser,
					payload.assistant,
					payload.executionEvidence,
				),
				onMetrics: (metrics) => {
					telemetry.bridge = metrics;
				},
			});
			bridgeStatus = "completed";
		} finally {
			telemetry.stages.bridge = {
				status: bridgeStatus,
				durationMs: Math.round(performance.now() - bridgeStarted),
				budgetMs: Math.max(0, Math.round(deadlineAt - bridgeStarted)),
			};
		}
		console.log(
			`[isolate-brain-bridge] observerModel=${observerDeployment} observed=${parsed.observations.length} bridgeInput=${bridgeObservationsSet.length} bridged=${bridged} tedi=${this.state.slug}`,
		);

		// Optional projections run after the essential fact write, each under
		// its own budget and signal (`runLearningStage`), so one slow stage
		// records `timed_out` in `telemetry.stages` instead of burning the
		// pass's 25s cap. Rationale, crystallizer, task promotion and the
		// turn-summary artifact are independent and run in parallel; the trace
		// bundle needs their ids and runs after them.
		const stageContext = {
			signal,
			deadlineAt,
			strict: Boolean(this.runtimeAdmission()),
			telemetry,
		};
		const [rationaleResult, , , artifactId] = await Promise.all([
			// Rationale bridging uses the full observer set even when fact writes
			// dedupe, and invalidates counter-evidenced compiled directives.
			runLearningStage(stageContext, "rationale", (stageSignal) =>
				runRationaleBridge({
					newObservations: rationaleObservations,
					platform: platformFor(stageSignal),
					stateStore: this.getRationaleStore(),
					// Enables directive invalidation: a failure observation drops
					// ALWAYS directives in the same category (their counter-evidence).
					directives: this.getDirectiveStore(),
					correlation: {
						traceId: payload.runId,
						// WS1 execution links: the bridge attaches the turn's runId +
						// tool-call refs to every record it creates, and uses the runId
						// as the span-checkable proof for success completions. Without
						// these the platform hard-rejects the write.
						runId: payload.runId,
						...(payload.toolCallRefs?.length
							? { toolCallRefs: payload.toolCallRefs }
							: {}),
						...(payload.workItemId ? { workItemId: payload.workItemId } : {}),
						sourceSessionId: payload.user.sessionKey || DEFAULT_SESSION_KEY,
					},
				}),
			),
			// Crystallizer: buffer this turn's procedural observations, then
			// detect patterns recurring ACROSS turns against the rolling buffer
			// and promote them to draft/improved muscle-memory skills. DO SQLite
			// backs the per-pattern dedup, so it is idempotent.
			runLearningStage(stageContext, "crystallizer", async (stageSignal) => {
				const crystalStore = this.getCrystallizationStore();
				crystalStore.bufferObservations(
					parsed.observations,
					payload.assistant.ts,
				);
				const crystallized = await runCrystallization({
					observations: crystalStore.loadBufferedObservations(),
					platform: platformFor(stageSignal),
					stateStore: crystalStore,
				});
				if (crystallized > 0) {
					console.log(
						`[isolate-crystallizer] crystallized=${crystallized} tedi=${this.state.slug}`,
					);
				}
			}),
			// Promote confirmed task intents through the canonical Work Items API.
			// The local store keeps promotion idempotent; provider sync is separate.
			parsed.taskIntents && parsed.taskIntents.length > 0
				? runLearningStage(
						stageContext,
						"task_promotion",
						async (stageSignal) => {
							const promotion = await promoteWorkItems({
								taskIntents: parsed.taskIntents ?? [],
								platform: platformFor(stageSignal),
								store: this.getWorkItemPromotionStore(),
								sessionKey: payload.user.sessionKey || DEFAULT_SESSION_KEY,
								runId: payload.runId,
							});
							if (promotion.detected > 0) {
								console.log(
									`[isolate-task-bridge] detected=${promotion.detected} ` +
										`candidates=${promotion.externalCandidates} ` +
										`promoted=${promotion.promoted} tedi=${this.state.slug}`,
								);
							}
						},
					)
				: undefined,
			// Turn-summary artifact: persist the Observer's structured output as
			// a durable TediArtifact bound to the turn's STABLE runId, under the
			// slug-prefixed conversation id every other isolate emitter uses.
			runLearningStage(stageContext, "artifact", (stageSignal) =>
				recordTurnSummaryArtifact({
					signal: stageSignal,
					platform: platformFor(stageSignal),
					bucket:
						this.env.TEDI_STORAGE &&
						this.admittedEffectPort(
							this.env.TEDI_STORAGE,
							`${payload.runId}:memory`,
						),
					tediId: this.state.tediId,
					conversationId: buildTediConversationId({
						tediRef: this.state.slug || this.state.tediId,
						sessionKey: payload.user.sessionKey,
					}),
					runId: payload.runId,
					turnId: sanitizeTurnKey(payload.runId),
					observerSummary: {
						observations: parsed.observations,
						currentTasks: parsed.currentTasks,
						suggestedResponse: parsed.suggestedResponse,
					},
					userText: payload.user.content,
					assistantText: payload.assistant.content,
				}),
			),
		]);
		// The rationale bridge may have invalidated directives in the store.
		// Drop the in-memory cache so `beforeTurn` reloads the reduced set.
		this.directivesLoaded = false;

		// Persist this run's rationale + artifact ids, then (re-)emit the
		// per-run TraceBundle so it references them. `onLedgerMirror` may emit
		// first with empty arrays; `recordTraceBundle` merges, so this emission
		// completes the bundle regardless of order.
		const traceRunId = payload.runId;
		const rationaleRecordIds = rationaleResult?.recordIds ?? [];
		const collectedArtifactIds = artifactId ? [artifactId] : [];
		this.recordPendingTraceIds(
			traceRunId,
			rationaleRecordIds,
			collectedArtifactIds,
		);
		await runLearningStage(
			stageContext,
			"trace_bundle",
			async (stageSignal) => {
				const stagePlatform = platformFor(stageSignal);
				// Score the just-closed turn against the active harness version
				// FIRST (Slice B), so every production episode feeds meanScore;
				// the returned id links this run's trace bundle to its score.
				const evalResultId =
					(await this.scoreTurn({
						platform: stagePlatform,
						tediId: this.state.tediId,
						orgId: this.state.orgId || undefined,
						runId: traceRunId,
						assistantText: payload.assistant.content,
						outcome: "success",
						unrecoveredError: false,
					})) ?? undefined;
				stageSignal.throwIfAborted();
				if (
					rationaleRecordIds.length === 0 &&
					collectedArtifactIds.length === 0
				)
					return;
				const conversationId = buildTediConversationId({
					tediRef: this.state.slug || this.state.tediId,
					sessionKey: payload.sessionKey || payload.user.sessionKey,
				});
				// Read-only: match the ledger mirror's conversation.created
				// without mutating the seen-set (the mirror owns that).
				const emitConversationCreated = !(
					this.state.ledgerConversationsSeen ?? []
				).includes(conversationId);
				await this.emitTraceBundleForRun({
					platform: stagePlatform,
					tediId: this.state.tediId,
					orgId: this.state.orgId || undefined,
					conversationId,
					sessionKey:
						payload.sessionKey ||
						payload.user.sessionKey ||
						DEFAULT_SESSION_KEY,
					runId: traceRunId,
					startedAt: new Date(payload.user.ts).toISOString(),
					endedAt: new Date(payload.assistant.ts).toISOString(),
					emitConversationCreated,
					evidence: {
						userText: payload.user.content,
						assistantText: payload.assistant.content,
					},
					evalResultId,
				});
			},
		);
		signal.throwIfAborted();
	} catch (err) {
		if (this.runtimeAdmission()) throw err;
		telemetry.finish("failed");
		console.error("[isolate-brain-bridge] turn bridge failed:", {
			error: errorMessage(err),
		});
		// Fail-soft — never break chat.
	}
}

/**
 * Brain-bridge entry point (queued via `this.queue`). Hard 25s ceiling on the
 * reflection pipeline (observer / reflector / brain / rationale / crystallizer
 * / directive / artifact).
 *
 * Root cause: the failure mode that wedges a tedi is **queued reflection-job
 * starvation**, NOT a "hung platform HTTP call" — the platform RPC client (`HttpPlatformClient.rpc`) already has a 15s
 * `AbortController` timeout. The unguarded paths were the isolate's own Azure
 * LLM `fetch()`es (observer + reflector), which had no signal. Because the DO
 * queue is serialized (`messageConcurrency="queue"`), one job that outlives
 * its handler starves every later job + request, and the poison persists in DO
 * SQLite across restarts.
 *
 * So the timeout is now REAL, not just a `Promise.race`: an `AbortController`
 * is threaded into the observer + reflector LLM calls, and on timeout we abort
 * it so the underlying `fetch` actually cancels (rather than leaking). We catch
 * (no rethrow) so the queue advances without a retry storm. 25s is well above
 * legit reflection cost and safely under the 30s MCP edge timeout.
 */
export async function onBridgeTurn(
	this: RuntimeMemoryHost,
	payload: BridgeTurnInput,
): Promise<void> {
	const telemetry = createTurnLearningTelemetry(payload);
	// Ephemeral (test/validation) sessions skip the brain bridge too — there's
	// no durable run to attach learned observations/rationale to (the ledger
	// mirror is skipped), so bridging would orphan them. The turn still ran +
	// replied; only the durable side-effects are skipped. See
	// `isEphemeralSession`.
	//
	// BLIND VERIFICATION (`evidence:judge:*`) sessions skip it for the opposite
	// reason: the turn is durable and audited, but the tedi must not LEARN from
	// judging its own citations. Observing a judge turn would fold the claim
	// text ("demand rose BECAUSE of the heatwave") back into the brain as a
	// memory — the exact belief the next verification is supposed to test
	// independently. Read-blindness without write-blindness is a one-turn delay,
	// not a fix.
	const bridgeSessionKey = payload.sessionKey ?? payload.user.sessionKey;
	if (
		isEphemeralSession(bridgeSessionKey) ||
		isBlindVerificationSession(bridgeSessionKey)
	) {
		telemetry.finish(
			"skipped",
			isEphemeralSession(bridgeSessionKey)
				? "ephemeral_session"
				: "blind_verification",
		);
		return;
	}
	const learningMode =
		payload.learningMode ??
		adaptiveLearningModeForTurn({
			userText: payload.user.content,
			assistantText: payload.assistant.content,
		});
	if (learningMode === "disabled") {
		telemetry.finish("skipped", "learning_disabled");
		console.log(
			`[isolate-brain-bridge] adaptive learning disabled before observer tedi=${this.state.slug}`,
		);
		return;
	}
	const admission = this.runtimeAdmission();
	const memoryRunId = `${payload.runId}:memory`;
	const memoryKey = `runtime-admission-memory:${payload.runId}`;
	if (admission) {
		await admission.assertOriginalClaim({
			runId: memoryRunId,
			sessionKey: bridgeSessionKey,
			input: { kind: "memory_effects", payload },
		});
		const journal = await this.ctx.storage.get<{
			stage: string;
			payload: BridgeTurnInput;
		}>(memoryKey);
		if (!journal || JSON.stringify(journal.payload) !== JSON.stringify(payload))
			throw new Error("Original memory dispatch changed");
		if (journal.stage === "completed") {
			await this.completeRuntimeTurn(
				memoryRunId,
				`${memoryRunId}:effects`,
				journal,
			);
			return;
		}
		if (journal.stage !== "accepted")
			throw new Error("Original memory effects remain uncertain");
		await admission.assertAcceptedTurn({ runId: memoryRunId });
		await this.ctx.storage.put(memoryKey, { ...journal, stage: "running" });
		await admission.assertAcceptedTurn({ runId: memoryRunId });
	}
	const controller = new AbortController();
	const deadlineAt = learningStageDeadline(performance.now());
	const timer = setTimeout(() => {
		controller.abort(new Error("onBridgeTurn timed out (25s)"));
	}, LEARNING_BRIDGE_TIMEOUT_MS);
	try {
		await this.runBridgeTurnInner(
			payload,
			controller.signal,
			telemetry,
			deadlineAt,
		);
		if (admission) {
			controller.signal.throwIfAborted();
			await admission.assertAcceptedTurn({ runId: memoryRunId });
			const receipt = { stage: "completed", payload };
			await this.ctx.storage.put(memoryKey, receipt);
			await this.completeRuntimeTurn(
				memoryRunId,
				`${memoryRunId}:effects`,
				receipt,
			);
		}
	} catch (err) {
		telemetry.finish("failed");
		console.error("[isolate-brain-bridge] onBridgeTurn aborted/failed:", {
			error: errorMessage(err),
		});
		if (admission) throw err;
	} finally {
		clearTimeout(timer);
		telemetry.finish(
			learningPassStatus({
				aborted: controller.signal.aborted,
				observerStatus: telemetry.observer.status,
			}),
		);
	}
}
