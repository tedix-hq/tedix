import type { TraceBundleOutcome } from "@tedix/api-contract/schemas/harness-version";
import { buildBodyExecutionResult } from "@tedix/api-contract/utils/body-execution-result";
import { buildTraceBundle } from "@tedix/api-contract/utils/trace-bundle";
import { type CompiledDirective } from "@tedix/context-core/compiler";
import {
	buildHarnessComponents,
	gradeTurn,
	type HarnessLoopPolicy,
	harnessVersionCacheEntry,
	LIVE_TURN_EVAL_LANE,
	LIVE_TURN_TASK_SET_ID,
	liveTurnEvalIds,
	matchingHarnessVersionId,
	parseLoopPolicyComponent,
	runEventIds,
	traceBundleId,
} from "@tedix/context-core/harness-version";
import {
	DEFAULT_TRACE_SAFETY_POLICY,
	traceSafetyPolicyId,
} from "@tedix/context-core/trace-safety";
import { errorMessage } from "@tedix/worker-kit/error-message";
import { type BrainDigest } from "./brain/brain-digest";
import type { HttpPlatformClient } from "./brain/platform-client";
import type { AgentTediDO, State } from "./do";
import type { AgentMcpRuntime } from "./mcp-client-runtime";
import {
	observerToolEvidenceFromSteps,
	type ObserverToolExecutionEvidence,
} from "./observer-execution-evidence";
import {
	bodyExecutionUsageFromSteps,
	summarizeToolSteps,
} from "./step-telemetry";
import {
	type TraceMemoryHit,
	type TraceRecoveryEvidence,
	type TraceSkillHit,
	type TraceToolStep,
	writeTraceBundle,
} from "./trace-bundle-writer";

export interface RuntimeTraceHost {
	state: State;
	setState: AgentTediDO["setState"];
	peekPendingToolSteps(runId: string): TraceToolStep[];
	bufferToolStep(runId: string, step: TraceToolStep): void;
	ensureBrainDigestLoaded(): Promise<void>;
	brainDigest: BrainDigest | null;
	getMcpRuntime(skipInitialSync?: boolean): Promise<AgentMcpRuntime | null>;
	compiledDirectives: CompiledDirective[];
	env: Cloudflare.Env;
	auditLoopPolicy(): HarnessLoopPolicy;
	ensureActiveHarnessVersion(
		platform: HttpPlatformClient,
		tediId: string,
		orgId: string | undefined,
	): Promise<string | null>;
	getPendingTraceIds(runId: string): {
		rationaleRecordIds: string[];
		artifactIds: string[];
	};
	buildMemoryHitsForBundle(): Promise<TraceMemoryHit[]>;
	buildSkillHitsForBundle(): Promise<TraceSkillHit[]>;
	takePendingToolSteps(runId: string): TraceToolStep[];
	peekToolResultCount(runId: string): number;
	ensureIdentity(hints?: {
		slug?: string;
		tediId?: string;
		orgId?: string;
		authSubject?: string;
	}): Promise<void>;
	getPlatformClient(): Promise<HttpPlatformClient | null>;
	MAX_PENDING_TRACE_IDS: 50;
}

export const runtimeTrace = {
	/**
	 * Record (merge) a run's rationale-record + artifact ids into the bounded
	 * {@link State.pendingTraceIds} ring so {@link emitTraceBundleForRun} can
	 * reference them. Idempotent: ids are unioned into any existing entry for the
	 * same runId (queue retries re-run the bridge with the same deterministic
	 * ids). The ring is pruned to {@link MAX_PENDING_TRACE_IDS} (newest kept).
	 */

	recordPendingTraceIds(
		this: RuntimeTraceHost,
		runId: string,
		rationaleRecordIds: string[],
		artifactIds: string[],
	): void {
		const dedupe = (ids: string[]): string[] => {
			const seen = new Set<string>();
			const out: string[] = [];
			for (const id of ids) {
				if (!id || seen.has(id)) continue;
				seen.add(id);
				out.push(id);
			}
			return out;
		};
		const pending = [...(this.state.pendingTraceIds ?? [])];
		const idx = pending.findIndex((p) => p.runId === runId);
		if (idx >= 0) {
			const existing = pending[idx]!;
			pending[idx] = {
				runId,
				rationaleRecordIds: dedupe([
					...existing.rationaleRecordIds,
					...rationaleRecordIds,
				]),
				artifactIds: dedupe([...existing.artifactIds, ...artifactIds]),
			};
		} else {
			pending.push({
				runId,
				rationaleRecordIds: dedupe(rationaleRecordIds),
				artifactIds: dedupe(artifactIds),
			});
		}
		this.setState({
			...this.state,
			pendingTraceIds: pending.slice(-this.MAX_PENDING_TRACE_IDS),
		});
	},

	// ===========================================================================
	// Ledger / telemetry
	// ===========================================================================

	/** Read collected rationale + artifact ids for a run (empty if none yet). */

	getPendingTraceIds(
		this: RuntimeTraceHost,
		runId: string,
	): {
		rationaleRecordIds: string[];
		artifactIds: string[];
	} {
		const entry = (this.state.pendingTraceIds ?? []).find(
			(p) => p.runId === runId,
		);
		return {
			rationaleRecordIds: entry?.rationaleRecordIds ?? [],
			artifactIds: entry?.artifactIds ?? [],
		};
	},

	/** Append one step's tool/usage telemetry to the per-run buffer (bounded ring). */

	bufferToolStep(
		this: RuntimeTraceHost,
		runId: string,
		step: TraceToolStep,
	): void {
		const pending = [...(this.state.pendingToolSteps ?? [])];
		const idx = pending.findIndex((p) => p.runId === runId);
		if (idx >= 0) {
			pending[idx] = { runId, steps: [...pending[idx]!.steps, step] };
		} else {
			pending.push({ runId, steps: [step] });
		}
		this.setState({
			...this.state,
			pendingToolSteps: pending.slice(-this.MAX_PENDING_TRACE_IDS),
		});
	},

	/**
	 * Capture one ConversationFacet proxy invocation in the same durable per-run
	 * buffer used by parent-loop step telemetry. Facets do not invoke the
	 * parent's `onStepFinish`, so without this seam every post-cutover episode
	 * had a run link but zero tool-call refs. One synthetic step per proxy call
	 * preserves invocation order and keeps the existing ref grammar
	 * (`{runId}:step:{n}:0:{toolName}`). The miner later resolves the runtime
	 * name to a unique canonical `app_tools.id` or refuses the pattern.
	 */

	bufferFacetToolCall(
		this: RuntimeTraceHost,
		runId: string,
		toolName: string,
	): number {
		const nextStep =
			this.peekPendingToolSteps(runId).reduce(
				(max, step) => Math.max(max, step.stepNumber),
				-1,
			) + 1;
		this.bufferToolStep(runId, {
			stepNumber: nextStep,
			finishReason: "facet-tool-proxy",
			toolNames: [toolName],
			toolCallCount: 1,
			// The start boundary is captured before execution so thrown/evicted calls
			// remain visible. Outcome-specific evidence lives in the tool ledger.
			toolResultCount: 0,
		});
		return nextStep;
	},

	/**
	 * Mark the proxy result in the trace buffer. The facet's native provider
	 * settlement mirrors the canonical model round (including usage and every
	 * tool call); emitting another synthetic step.completed here would double
	 * count both rounds and tools.
	 */

	async completeFacetToolCall(
		this: RuntimeTraceHost,
		input: {
			runId: string;
			stepNumber: number;
			toolName: string;
			finishReason: string;
			resultDigest?: string;
		},
	): Promise<void> {
		const pending = [...(this.state.pendingToolSteps ?? [])];
		const runIndex = pending.findIndex((entry) => entry.runId === input.runId);
		if (runIndex >= 0) {
			const entry = pending[runIndex]!;
			pending[runIndex] = {
				runId: entry.runId,
				steps: entry.steps.map((step) =>
					step.stepNumber === input.stepNumber
						? {
								...step,
								finishReason: input.finishReason,
								toolResultCount: 1,
								...(input.resultDigest
									? { resultDigest: input.resultDigest }
									: {}),
							}
						: step,
				),
			};
			this.setState({ ...this.state, pendingToolSteps: pending });
		}
	},

	/**
	 * Non-destructively sum the tool RESULTS the run received across all buffered
	 * steps. Read-only (unlike {@link takePendingToolSteps}, which the bundle
	 * writer consumes), so {@link scoreTurn} can use it as the live-turn grounding
	 * signal without racing the bundle writer that runs in the same callback.
	 */

	peekToolResultCount(this: RuntimeTraceHost, runId: string): number {
		const entry = (this.state.pendingToolSteps ?? []).find(
			(p) => p.runId === runId,
		);
		if (!entry) return 0;
		return entry.steps.reduce(
			(sum, step) => sum + (step.toolResultCount ?? 0),
			0,
		);
	},

	/**
	 * Non-destructively sum `usage.totalTokens` across all buffered steps for
	 * a run. Mirrors the `scores.json` accumulator in `assembleTraceBundleFiles`
	 * without consuming the step buffer (read-only, safe to call before
	 * `takePendingToolSteps`). Returns `null` when no step telemetry exists so
	 * callers can apply the null-absent invariant (0 tokens ≠ "no data").
	 */

	peekTotalTokens(this: RuntimeTraceHost, runId: string): number | null {
		const entry = (this.state.pendingToolSteps ?? []).find(
			(p) => p.runId === runId,
		);
		if (!entry || entry.steps.length === 0) return null;
		const total = summarizeToolSteps(entry.steps).totalTokens;
		return total != null && total > 0 ? total : null;
	},

	/**
	 * Non-destructively read the per-run buffered tool steps. Read-only (unlike
	 * {@link takePendingToolSteps}, which the bundle writer consumes), so the
	 * canonical BodyExecutionResult.usage can be summed from the SAME step
	 * telemetry without racing or pre-consuming the buffer the trace-bundle writer
	 * still needs.
	 */

	peekPendingToolSteps(this: RuntimeTraceHost, runId: string): TraceToolStep[] {
		return (
			(this.state.pendingToolSteps ?? []).find((p) => p.runId === runId)
				?.steps ?? []
		);
	},

	/**
	 * Did any facet tool proxy call in this run end in a FAILURE finish reason?
	 * `executeFacetTool` is the authoritative boundary every facet tool call
	 * crosses; it stamps `facet-tool-error` (the tool's `execute()` threw / the
	 * proxy transport failed) or `facet-tool-unavailable` (no live registry) onto
	 * the buffered step. Tool errors are otherwise fail-soft — returned to the
	 * model as a `{ error }` object, never thrown — so this durable step buffer is
	 * the ONLY surviving failure signal a silent (no-prose) cron turn leaves
	 * behind. Read-only; called before {@link commitAssistantTurn} consumes the
	 * buffer, so the steps are still intact. See the tool-failure guard in
	 * `runFacetWorkflowTurnImpl`.
	 */

	runHadFacetToolError(this: RuntimeTraceHost, runId: string): boolean {
		return this.peekPendingToolSteps(runId).some(
			(step) =>
				step.finishReason === "facet-tool-error" ||
				step.finishReason === "facet-tool-unavailable" ||
				step.finishReason === "facet-tool-authority-denied",
		);
	},

	/**
	 * WS1 (decision↔execution coupling): span-checkable tool-call refs for a
	 * run, derived non-destructively from the per-run step buffer. Shape:
	 * `{runId}:step:{stepNumber}:{index}:{toolName}` — checkable against the
	 * run's `step.completed` ledger events. Bounded to 64 refs. MUST be read
	 * BEFORE the trace-bundle writer consumes the buffer
	 * (`takePendingToolSteps`); the workflow-commit path therefore captures the
	 * refs before `onLedgerMirror` runs.
	 */

	toolCallRefsForRun(this: RuntimeTraceHost, runId: string): string[] {
		const refs: string[] = [];
		for (const step of this.peekPendingToolSteps(runId)) {
			step.toolNames.forEach((toolName, index) => {
				if (refs.length >= 64) return;
				refs.push(`${runId}:step:${step.stepNumber}:${index}:${toolName}`);
			});
			if (refs.length >= 64) break;
		}
		return refs;
	},

	/** Content-free tool outcomes for the after-turn Observer. */

	toolExecutionEvidenceForRun(
		this: RuntimeTraceHost,
		runId: string,
	): ObserverToolExecutionEvidence[] {
		return observerToolEvidenceFromSteps(
			runId,
			this.peekPendingToolSteps(runId),
		);
	},

	/** Read + clear the per-run tool-step buffer (consumed once by the bundle writer). */

	takePendingToolSteps(this: RuntimeTraceHost, runId: string): TraceToolStep[] {
		const all = this.state.pendingToolSteps ?? [];
		const entry = all.find((p) => p.runId === runId);
		if (!entry) return [];
		this.setState({
			...this.state,
			pendingToolSteps: all.filter((p) => p.runId !== runId),
		});
		return entry.steps;
	},

	/**
	 * Memory-hit evidence (→ memory-hits.jsonl) for the trace bundle, derived from
	 * the prompt-injected brain digest already in hand — the SAME retrieval the
	 * model saw this turn (no second memory query). One row per indexed domain
	 * (the in-prompt knowledge surface) plus one row per budget-DROPPED fact id so
	 * the channel is honest about what the digest omitted. Summaries are truncated
	 * to 200 chars, matching the bridge's own `memoryLearn` summary cap; the shared
	 * FAIL-CLOSED redactor scrubs every row before it is written. Returns `[]` when
	 * no digest is loaded so the bundle writer omits the file (back-compatible).
	 */

	async buildMemoryHitsForBundle(
		this: RuntimeTraceHost,
	): Promise<TraceMemoryHit[]> {
		try {
			await this.ensureBrainDigestLoaded();
			const digest = this.brainDigest;
			if (!digest) return [];
			const hits: TraceMemoryHit[] = [];
			const domainNames = digest.domainNames ?? [];
			for (const domain of domainNames) {
				const name = (domain ?? "").trim();
				if (!name) continue;
				hits.push({
					summary: name.slice(0, 200),
					domain: name,
					source: "brain-digest",
				});
			}
			for (const factId of digest.droppedFactIds ?? []) {
				const id = (factId ?? "").trim();
				if (!id) continue;
				hits.push({ factId: id, dropped: true, source: "brain-digest" });
			}
			return hits.slice(0, 50);
		} catch (err) {
			console.warn("[isolate.trace] memory-hit assembly failed:", {
				error: errorMessage(err),
			});
			return [];
		}
	},

	/**
	 * Skill/guidance evidence (→ skills.jsonl) for the trace bundle, derived from
	 * the MCP runtime's `listGuidanceResources()` — the SAME `- skill {name}:
	 * {summary}` block disclosed to the model in the per-turn system prompt. Each
	 * summary is truncated to 200 chars; the shared FAIL-CLOSED redactor scrubs
	 * every row before it is written. Returns `[]` when no guidance is present so
	 * the bundle writer omits the file (back-compatible).
	 */

	async buildSkillHitsForBundle(
		this: RuntimeTraceHost,
	): Promise<TraceSkillHit[]> {
		try {
			const mcpRuntime = await this.getMcpRuntime();
			if (!mcpRuntime) return [];
			const guidance = mcpRuntime.listGuidanceResources();
			const hits: TraceSkillHit[] = [];
			for (const g of guidance) {
				const summary = (g.summary ?? "").trim();
				if (!summary) continue;
				hits.push({
					kind: g.kind,
					name: g.name,
					summary: summary.slice(0, 200),
					uri: g.uri,
					serverName: g.serverName,
				});
			}
			return hits.slice(0, 50);
		} catch (err) {
			console.warn("[isolate.trace] skill-hit assembly failed:", {
				error: errorMessage(err),
			});
			return [];
		}
	},

	/**
	 * Ensure an `active` HarnessVersion exists for this tedi and return its id.
	 *
	 * Builds the live component-hash set (system prompt + model + active
	 * directive provenance + MCP routing + runtime kind) and asks the API to
	 * ensure-active. The API decides bump-vs-no-op by diffing against the
	 * current active version. We cache the resulting id + components in DO state
	 * so a warm DO skips the RPC entirely while the component set is unchanged.
	 *
	 * Returns the active version id, or `null` if it could not be resolved
	 * (caller emits the bundle without a version stamp rather than dropping it).
	 */

	async ensureActiveHarnessVersion(
		this: RuntimeTraceHost,
		platform: HttpPlatformClient,
		tediId: string,
		orgId: string | undefined,
	): Promise<string | null> {
		try {
			const directiveProvenanceHashes = this.compiledDirectives
				.map((d) => d.provenanceHash)
				.filter((h): h is string => typeof h === "string" && h.length > 0);
			const components = await buildHarnessComponents({
				systemPrompt: this.state.systemPrompt,
				model: this.env.AZURE_CHAT_DEPLOYMENT,
				directiveProvenanceHashes,
				mcpAppSlug: this.state.slug || undefined,
				runtimeKind: "agent",
				// Stamp the EFFECTIVE governed loop policy. This both records the live
				// entitlement and makes a legacy 10-step active version bump after its
				// plan/per-tedi governance is loaded.
				loopPolicy: this.auditLoopPolicy(),
			});

			const cachedVersionId = matchingHarnessVersionId(
				this.state.harnessVersionId && this.state.harnessComponents
					? harnessVersionCacheEntry(
							this.state.harnessVersionId,
							this.state.harnessComponents,
						)
					: null,
				components,
			);
			if (cachedVersionId) return cachedVersionId;

			const result = await platform.ensureActiveHarnessVersion({
				components,
				runtimeKind: "agent",
				orgId,
				// Stamp the trace-safety policy id onto the version row so the
				// redaction policy that governed a run's raw evidence is auditable
				// from the version itself, not only the bundle manifest / R2
				// customMetadata. Same id the trace-bundle writer records.
				traceSafetyPolicyId: traceSafetyPolicyId(DEFAULT_TRACE_SAFETY_POLICY),
			});
			this.setState({
				...this.state,
				harnessVersionId: result.version.id,
				harnessComponents: components,
				// Read back the auditable policy descriptor. D1 governance remains
				// authoritative for the ceiling when effectiveStepCeiling runs next turn;
				// fail soft to the current effective policy if absent/unparseable.
				harnessLoopPolicy:
					parseLoopPolicyComponent(result.version.components.loop_policy) ??
					this.auditLoopPolicy(),
			});
			if (result.bumped) {
				console.log(
					`[isolate.harness] version bumped to ${result.version.version} (${result.version.id}) tedi=${tediId}`,
				);
			}
			return result.version.id;
		} catch (err) {
			console.warn(
				"[isolate.harness] ensureActiveHarnessVersion failed:",
				err instanceof Error ? err.message : err,
			);
			// Fall back to any cached id so the bundle still gets a stamp.
			return this.state.harnessVersionId ?? null;
		}
	},

	/**
	 * Emit ONE TraceBundle per run. References (does not duplicate) the run's
	 * ledger event ids — derived deterministically from the `{runId}:{seq}`
	 * scheme `mirrorTurnToLedger` writes — stamps the active `harnessVersionId`,
	 * and references the run's rationale records + artifacts collected during the
	 * bridge fan-out ({@link State.pendingTraceIds}, keyed by the same
	 * deterministic runId).
	 *
	 * Idempotent on the deterministic bundle id `${runId}:bundle`. This emits
	 * from BOTH the ledger-mirror step (which has the event ids) and the
	 * bridge step (which has the rationale/artifact ids) — `recordTraceBundle`
	 * MERGES the id arrays on conflict, so whichever step lands second completes
	 * the bundle rather than being dropped. The rationale/artifact arrays read
	 * here are best-effort: if the bridge step has not finished when the mirror
	 * emits, they are empty and the bridge's own emission fills them in.
	 * Best-effort + fail-soft.
	 */

	async emitTraceBundleForRun(
		this: RuntimeTraceHost,
		opts: {
			platform: HttpPlatformClient;
			tediId: string;
			orgId: string | undefined;
			conversationId: string;
			sessionKey?: string;
			/** Pre-built STABLE runId — same id the ledger 4-event chain keys on. */
			runId: string;
			startedAt?: string;
			endedAt?: string;
			emitConversationCreated: boolean;
			/**
			 * Raw-evidence inputs (bridge path only). When present, the redacted
			 * `harness/runs/<runId>/...` folder is written to R2 and `bundleUri` is set.
			 * Absent on the ledger-mirror path (ids only); `recordTraceBundle` coalesces
			 * the non-null `bundleUri` so whichever path supplies evidence wins.
			 */
			evidence?: { userText: string; assistantText: string };
			/**
			 * Live-turn score id for THIS run (Slice B). When supplied (the bridge path
			 * scores the turn first), it is stamped onto the bundle so
			 * `trace_bundles.evalResultId` links the bundle to the score it earned.
			 * `recordTraceBundle` coalesces the non-null id so whichever path supplies
			 * it wins; the ledger-mirror path leaves it unset.
			 */
			evalResultId?: string;
		},
	): Promise<void> {
		try {
			const runId = opts.runId;
			const bundleId = traceBundleId(runId);
			const createdAt = new Date().toISOString();
			const startedAt = opts.startedAt ?? createdAt;
			const endedAt = opts.endedAt ?? createdAt;
			const parsedStartedAt = Date.parse(startedAt);
			const parsedEndedAt = Date.parse(endedAt);
			const durationMs =
				Number.isFinite(parsedStartedAt) && Number.isFinite(parsedEndedAt)
					? Math.max(0, parsedEndedAt - parsedStartedAt)
					: null;
			const harnessVersionId = await this.ensureActiveHarnessVersion(
				opts.platform,
				opts.tediId,
				opts.orgId,
			);
			if (!harnessVersionId) {
				console.warn(
					"[isolate.harness] no harness version; skipping trace bundle",
				);
				return;
			}
			const { rationaleRecordIds, artifactIds } =
				this.getPendingTraceIds(runId);

			// Read (non-destructively) the per-run step telemetry for the canonical
			// usage sum BEFORE the evidence block consumes the buffer via
			// `takePendingToolSteps`. Peeking here keeps the buffer-consumption
			// behaviour identical to before (only the evidence path clears it).
			const usageSteps = this.peekPendingToolSteps(runId);

			// Raw-evidence layer (FAIL-CLOSED redaction inside writeTraceBundle):
			// only the bridge path supplies evidence; the ledger path leaves
			// bundleUri unset. Never blocks the bundle row on an R2 hiccup.
			let bundleUri: string | undefined;
			if (opts.evidence) {
				// Learning-substrate evidence already in hand at bridge time: the
				// prompt-injected brain digest (memory-hits.jsonl) and the per-turn
				// MCP guidance block (skills.jsonl). Both fail-soft to [] and are
				// omitted from the bundle when empty (back-compatible).
				const [memoryHits, skills] = await Promise.all([
					this.buildMemoryHitsForBundle(),
					this.buildSkillHitsForBundle(),
				]);
				const uri = await writeTraceBundle({
					bucket: this.env.TEDI_STORAGE,
					evidence: {
						tediId: opts.tediId,
						orgId: opts.orgId,
						conversationId: opts.conversationId,
						runId,
						harnessVersionId,
						runtimeKind: "agent",
						systemPrompt: this.state.systemPrompt,
						userText: opts.evidence.userText,
						assistantText: opts.evidence.assistantText,
						memoryHits,
						skills,
						toolSteps: this.takePendingToolSteps(runId),
						outcome: "success",
						createdAt,
					},
					knownSecrets: [],
				});
				bundleUri = uri ?? undefined;
			}

			const resultArtifactIds = [...artifactIds];
			// USAGE INVARIANT (body-parity with the kernel's routeUsage threading):
			// sum the model-reported per-step token counts into the canonical
			// BodyExecutionResult.usage. Identity is known only for consistently
			// identified usage-bearing steps; unreported token fields stay null.
			const usage = bodyExecutionUsageFromSteps(usageSteps);
			const bodyExecutionResult = buildBodyExecutionResult({
				id: `${bundleId}:body-execution-result`,
				bodyKind: "agent",
				status: "completed",
				runId,
				tediId: opts.tediId,
				orgId: opts.orgId ?? null,
				conversationId: opts.conversationId,
				sessionKey: opts.sessionKey ?? null,
				harnessVersionId,
				traceBundleId: bundleId,
				startedAt,
				endedAt,
				durationMs,
				summary: opts.evidence?.assistantText
					? opts.evidence.assistantText.slice(0, 500)
					: null,
				structuredResult: { outcome: "success" },
				error: null,
				usage,
				session: {
					beforeRef: null,
					afterRef: null,
					adapterSessionRef: opts.sessionKey ?? null,
					clearSession: false,
				},
				artifactIds: resultArtifactIds,
				runtimeServices: ["cloudflare-agents", "pi", "mcp"],
			});

			await opts.platform.recordTraceBundle(
				buildTraceBundle({
					id: bundleId,
					tediId: opts.tediId,
					orgId: opts.orgId,
					conversationId: opts.conversationId,
					runId,
					harnessVersionId,
					eventIds: runEventIds(runId, {
						emitConversationCreated: opts.emitConversationCreated,
					}),
					rationaleRecordIds,
					artifactIds: resultArtifactIds,
					// Link the bundle to the live-turn score this run earned (Slice B).
					// Coalesced on merge so the ledger-mirror path's null never erases it.
					evalResultId: opts.evalResultId ?? null,
					// bundleUri points at the redacted harness/runs/<runId>/ folder. The
					// trace-safety policy id that produced it is recorded inside the
					// bundle's manifest.json + each R2 object's customMetadata, and is
					// now ALSO stamped onto the bundle's HarnessVersion row
					// (`traceSafetyPolicyId`, via ensureActiveHarnessVersion) so the
					// governing redaction policy is auditable from the version.
					bundleUri,
					outcome: "success",
					bodyExecutionResult,
					createdAt,
				}),
			);
		} catch (err) {
			console.warn(
				"[isolate.harness] emitTraceBundleForRun failed:",
				err instanceof Error ? err.message : err,
			);
			// Fail-soft — never break the ledger mirror or chat.
		}
	},

	/**
	 * Score the just-closed turn into a HarnessEvalResult against the tedi's
	 * ACTIVE harness version, so that version accumulates a real `meanScore` from
	 * production episodes (Slice B of closing the harness learning loop). NOT a
	 * synthetic CI run — this is the running isolate grading its own turns.
	 *
	 * Deterministic grading (NO model): {@link gradeTurn} reduces the run outcome
	 * + assistant answer + tool-result count into a [0,1] score + a gate map +
	 * a `passed` boolean, mirroring the substring/threshold rubric of
	 * `scripts/harness/eval-tasks.ts`. Writes ONE result + a 1-row run on the
	 * `validation` lane / `live-turn-v1` task set via the platform RPCs, then
	 * returns the deterministic `evalResultId` so the SAME run's trace bundle can
	 * link to it (`trace_bundles.evalResultId`).
	 *
	 * STRICT fail-soft: every path is wrapped in try/catch that logs + swallows.
	 * It runs in the queued, off-hot-path bridge step AFTER the reply is sent, so
	 * a scoring throw/timeout can never fail or delay a chat turn. It also NEVER
	 * writes `promotion_status` — the candidate MARK is done server-side on the
	 * version's metadata; the live `active` pointer is untouched here.
	 *
	 * Returns the `evalResultId` on success, or `null` when scoring was skipped or
	 * failed (the caller then emits the bundle without an eval link).
	 */

	async scoreTurn(
		this: RuntimeTraceHost,
		opts: {
			platform: HttpPlatformClient;
			tediId: string;
			orgId: string | undefined;
			runId: string;
			assistantText: string;
			outcome: TraceBundleOutcome;
			unrecoveredError?: boolean;
		},
	): Promise<string | null> {
		try {
			const harnessVersionId = await this.ensureActiveHarnessVersion(
				opts.platform,
				opts.tediId,
				opts.orgId,
			);
			if (!harnessVersionId) {
				console.warn(
					"[isolate.harness] no harness version; skipping turn score",
				);
				return null;
			}

			const { score, gates, passed } = gradeTurn({
				outcome: opts.outcome,
				assistantText: opts.assistantText,
				toolResultCount: this.peekToolResultCount(opts.runId),
				unrecoveredError: opts.unrecoveredError,
			});

			const ids = liveTurnEvalIds(harnessVersionId, opts.runId);
			const createdAt = new Date().toISOString();

			// ONE leaf result + a 1-row run rolled up on the validation lane. Both
			// writes are conflict-do-nothing on their deterministic ids, so a queue
			// retry of this step re-emits the same rows without double-counting.
			await opts.platform.recordEvalResult({
				id: ids.resultId,
				harnessVersionId,
				tediId: opts.tediId,
				orgId: opts.orgId,
				score,
				gates,
				passed,
				lane: LIVE_TURN_EVAL_LANE,
				taskSetId: LIVE_TURN_TASK_SET_ID,
				createdAt,
				metadata: {
					runId: opts.runId,
					outcome: opts.outcome,
					source: "live-turn",
				},
			});
			await opts.platform.recordEvalRun({
				id: ids.runId,
				harnessVersionId,
				tediId: opts.tediId,
				orgId: opts.orgId,
				lane: LIVE_TURN_EVAL_LANE,
				taskSetId: LIVE_TURN_TASK_SET_ID,
				total: 1,
				passed: passed ? 1 : 0,
				failed: passed ? 0 : 1,
				meanScore: score,
				eligible: passed,
				createdAt,
				metadata: { runId: opts.runId, source: "live-turn" },
			});

			return ids.resultId;
		} catch (err) {
			console.warn(
				"[isolate.harness] scoreTurn failed:",
				err instanceof Error ? err.message : err,
			);
			// STRICT fail-soft — scoring must never break or delay a chat turn.
			return null;
		}
	},

	/** Write failure evidence before the canonical run.failed mirror. Partial content stays out of the bundle. */

	async emitFailureTraceBundle(
		this: RuntimeTraceHost,
		opts: {
			runId: string;
			conversationId: string;
			sessionKey: string;
			startedAt: string;
			userText: string;
			partialTextLength: number;
			reason: string;
			recovery?: TraceRecoveryEvidence;
		},
	): Promise<string | undefined> {
		try {
			await this.ensureIdentity();
			const { tediId, orgId } = this.state;
			if (!tediId) return undefined;
			const platform = await this.getPlatformClient();
			if (!platform) return undefined;
			const bundleId = traceBundleId(opts.runId);
			const createdAt = new Date().toISOString();
			const parsedStartedAt = Date.parse(opts.startedAt);
			const parsedEndedAt = Date.parse(createdAt);
			const durationMs =
				Number.isFinite(parsedStartedAt) && Number.isFinite(parsedEndedAt)
					? Math.max(0, parsedEndedAt - parsedStartedAt)
					: null;

			const harnessVersionId = await this.ensureActiveHarnessVersion(
				platform,
				tediId,
				orgId || undefined,
			);
			if (!harnessVersionId) {
				console.warn(
					"[isolate.harness] no harness version; skipping recovery trace bundle",
				);
				return undefined;
			}

			const bundleUri =
				(await writeTraceBundle({
					bucket: this.env.TEDI_STORAGE,
					evidence: {
						tediId,
						orgId: orgId || undefined,
						conversationId: opts.conversationId,
						runId: opts.runId,
						harnessVersionId,
						runtimeKind: "agent",
						systemPrompt: this.state.systemPrompt,
						userText: opts.userText,
						// No completed assistant output on the recovery path.
						assistantText: "",
						recovery: opts.recovery,
						outcome: "failure",
						createdAt,
					},
					knownSecrets: [],
				})) ?? undefined;

			// run.failed lands at seq 2 (no assistant fallback on this path), so the
			// bundle references message.received + run.started + run.failed.
			const eventIds = runEventIds(opts.runId, { terminalSequence: 2 });
			const bodyExecutionResult = buildBodyExecutionResult({
				id: `${bundleId}:body-execution-result`,
				bodyKind: "agent",
				status: "failed",
				runId: opts.runId,
				tediId,
				orgId: orgId || null,
				conversationId: opts.conversationId,
				sessionKey: opts.sessionKey,
				harnessVersionId,
				traceBundleId: bundleId,
				startedAt: opts.startedAt,
				endedAt: createdAt,
				durationMs,
				summary: `native Pi turn failed: ${opts.reason}`,
				structuredResult: {
					outcome: "failure",
					recoveryKind: opts.recovery?.recoveryKind,
					attempts: opts.recovery?.attempts,
					maxAttempts: opts.recovery?.maxAttempts,
					partialTextLength: opts.partialTextLength,
				},
				error: {
					kind: "runtime",
					message: `native Pi turn failed: ${opts.reason}`,
					retryable: false,
				},
				session: {
					beforeRef: null,
					afterRef: null,
					adapterSessionRef: opts.sessionKey,
					clearSession: false,
				},
				runtimeServices: ["cloudflare-agents", "pi", "mcp"],
			});

			await platform.recordTraceBundle(
				buildTraceBundle({
					id: bundleId,
					tediId,
					orgId: orgId || undefined,
					conversationId: opts.conversationId,
					runId: opts.runId,
					harnessVersionId,
					eventIds,
					rationaleRecordIds: [],
					artifactIds: [],
					bundleUri,
					outcome: "failure",
					summary: `native Pi turn failed: ${opts.reason}`,
					bodyExecutionResult,
					createdAt,
				}),
			);

			return bundleUri;
		} catch (err) {
			console.warn(
				"[isolate.harness] emitFailureTraceBundle failed:",
				err instanceof Error ? err.message : err,
			);
			// Fail-soft — never break the recovery ledger mirror or chat.
			return undefined;
		}
	},
};
