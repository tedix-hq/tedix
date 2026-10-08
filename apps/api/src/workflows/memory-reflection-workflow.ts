/**
 * Memory Reflection Workflow
 *
 * Cloudflare Workflow that periodically reviews tedi memory:
 * 1. Preserve exact source/topic identity as the canonical D1 dedup boundary
 * 2. Usage-reinforced confidence decay (frequently-used facts decay slower)
 * 3. Archive low-confidence facts to cold storage
 * 4. Auto-connect related facts via edge creation
 * 5. Promote validated probation facts to active status
 * 6. Expire stale probation facts never accessed within 7 days
 * 7. Let D1 triggers enqueue projection outbox changes for the durable drain
 * 8. Generate a reflection summary
 *
 * Triggered by:
 * - Periodic cron (every 8 hours per org)
 * - Manual via memory_reflect MCP tool
 * - Event-driven after N new facts
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
	type WorkflowStepConfig,
} from "cloudflare:workers";
import { createDbClient, type DbClient } from "@tedix/db/client";
import {
	getTediLearnedCapabilities,
	upsertTediLearnedCapability,
} from "@tedix/db/queries/cognitive/learned-capabilities";
import { listTediSelectionCapabilityEvidence } from "@tedix/db/queries/harness-version/subjects";
import { listKernelRuntimeRunObjectiveSourcesByIds } from "@tedix/db/queries/kernel-runtime-runs";
import { autoLinkFactsWithJev } from "../services/jev-graph-auto-linking";
import {
	createEdge,
	getEdgesForFact,
} from "@tedix/db/queries/memory-graph/edges";
import {
	archiveLowConfidence,
	decayConfidence,
	expireProbation,
	promoteFromProbation,
} from "@tedix/db/queries/memory-graph/fact-lifecycle";
import { searchFacts } from "@tedix/db/queries/memory-graph/fact-search";
import { getFactById } from "@tedix/db/queries/memory-graph/facts";
import { listTediDisplayNamesByIds } from "@tedix/db/queries/tedis";
import { type KernelEnv, kernelModel } from "../rpc/routers/kernel/llm";
import { mineHomeOperatorDecisions } from "../services/home-reflection-producer";
import {
	clefLessonRouter,
	mineLearningFeed,
} from "../services/learning-feed-miner";
import { gradeRecentKernelRoutes } from "../services/kernel-route-eval";
import { modelLessonDistiller } from "../services/lesson-distiller";
import {
	distillOwnerIncrementally,
	distillPersonalLessons,
} from "../services/lesson-map-reduce";
import { assessDelegatedAnswerCriteriaWithJev } from "../rpc/routers/kernel/jev-goal-assessment";
import { reconcileCanonicalMemoryProjection } from "../integrations/cloudflare/agent-memory";
import { asRecord } from "@tedix/api-contract/utils/is-record";

interface ReflectionParams {
	organizationId: string;
	tediId?: string;
	/**
	 * `lessons`: only distil each person's decision history into lessons.
	 * `lessons-incremental`: only `ownerUserId`'s lessons, from their current
	 * lessons and the decisions since (a new decision, within a minute or two).
	 */
	scope: "full" | "recent" | "domain" | "lessons" | "lessons-incremental";
	ownerUserId?: string;
	domain?: string;
}

/** The lesson distillation runs as its own instance (fresh invocation budget). */
export function lessonDistillationInstanceId(parentInstanceId: string): string {
	return `${parentInstanceId}-lessons`.slice(0, 100);
}

interface ReflectionResult {
	factsReviewed: number;
	duplicatesFound: number;
	duplicatesMerged: number;
	edgesCreated: number;
	autoLinkEdgesCreated: number;
	autoLinkDomainsScanned: number;
	factsArchived: number;
	confidenceUpdated: number;
	probationPromoted: number;
	probationExpired: number;
	graphAlgorithmsRun: number;
	homeDecisionFactsWritten: number;
	learningFeedFactsWritten: number;
	learningFeedProposalsCreated: number;
	kernelRouteEvalGraded: number;
	tediCapabilitiesDistilled: number;
	transitions: ConsolidationTransitions;
	summary: string;
}

/**
 * Consolidation state-transition quota: every brain-reflection run must
 * report the fact state transitions it performed. A run that only appends
 * facts is a failed consolidation — zero transitions logs a visible warning
 * (never fatal) so `producer_quality`/operators can see a consolidation tier
 * that churns without disposing.
 */
export interface ConsolidationTransitions {
	/** Probation facts promoted to active. */
	promoted: number;
	/**
	 * Facts demoted a tier. No discrete demotion operator exists yet —
	 * `decayConfidence` is continuous, not a state transition — so this is 0
	 * until one ships; kept in the contract so the quota shape is stable.
	 */
	demoted: number;
	/** Near-duplicates merged (loser invalidated with a supersedes edge). */
	merged: number;
	/** Low-confidence archives + expired probation facts. */
	archived: number;
	total: number;
}

/** Pure transitions rollup — exported for unit tests. */
export function summarizeConsolidationTransitions(input: {
	probationPromoted: number;
	duplicatesMerged: number;
	factsArchived: number;
	probationExpired: number;
	demoted?: number;
}): ConsolidationTransitions {
	const promoted = Math.max(input.probationPromoted, 0);
	const demoted = Math.max(input.demoted ?? 0, 0);
	const merged = Math.max(input.duplicatesMerged, 0);
	const archived =
		Math.max(input.factsArchived, 0) + Math.max(input.probationExpired, 0);
	return {
		promoted,
		demoted,
		merged,
		archived,
		total: promoted + demoted + merged + archived,
	};
}

/** Canonical edge cap; paid pair judgments have their own smaller service budget. */
const AUTO_LINK_MAX_EDGES_PER_RUN = 50;

/** Keep semantic linking inside the same finite reflection selection. */
export function reflectionAutoLinkScope(
	organizationId: string,
	tediId: string | undefined,
	facts: readonly { id: string }[],
) {
	return {
		organizationId,
		tediId,
		factIds: facts.slice(0, 80).map((fact) => fact.id),
	};
}

/** Optional graph enrichment must not abort lifecycle maintenance or replay paid judgments. */
export async function runOptionalGraphLinking(
	run: () => ReturnType<typeof autoLinkFactsWithJev>,
) {
	try {
		return { ...(await run()), failed: false };
	} catch {
		// Prior pairs may already have persisted. Zero counters below are not a claim
		// that nothing happened; the failure flag makes partial counts unavailable.
		console.warn(
			"[Reflection] graph linking interrupted; continuing lifecycle maintenance; partial counts unavailable",
		);
		return {
			proposals: [],
			edgesCreated: 0,
			judgments: 0,
			domainsScanned: 0,
			failed: true,
		};
	}
}

/**
 * Per-domain sample size for the duplicate-detection step. The previous value
 * (20) was effectively a no-op for orgs with thousands of facts. `searchFacts`
 * already orders by `confidence DESC, lastAccessedAt DESC, createdAt DESC`,
 * so doubling the cap surfaces the most relevant facts first while keeping the
 * reflection work bounded and retry-safe.
 */

/**
 * Wall-clock budget for the sequential duplicate scan, held well under the
 * step's 3-minute timeout so the step always RETURNS (with partial results)
 * instead of erroring and discarding every successful step above it.
 */

// ============================================================================
// Capability flywheel (Step 10b) — bounds
//
// FlyRoute-style loop (arXiv:2605.22057): the graded delegation outcomes that
// Step 10 persists (`tsel:` rows in harness_subject_eval_results) are distilled
// per tedi into a short evidence-learned capability description, stored via
// `upsertTediLearnedCapability` (a `knowledge_entries` row `tcap:{tediId}`)
// and read back into the kernel's capability cards so past outcomes bias
// future routing. Every bound below exists to keep the step's D1 subrequests
// and LLM tokens small on the 8-hourly reflection cadence.
// ============================================================================

/** Evidence window: graded outcomes older than this don't inform the profile. */
const CAPABILITY_DISTILL_LOOKBACK_DAYS = 30;

/** Minimum graded outcomes before a tedi gets a distilled profile (noise floor). */
export const CAPABILITY_DISTILL_MIN_EVIDENCE = 3;

/** Max evidence rows fed to the model per tedi (newest-first sample). */
export const CAPABILITY_DISTILL_EVIDENCE_ROW_CAP = 20;

/** Objective excerpt length in the prompt — keeps per-row token cost tiny. */
export const CAPABILITY_DISTILL_OBJECTIVE_CHARS = 120;

/**
 * Refresh gate: a profile updated within this window is skipped, so the
 * 8-hourly reflection cron distills each tedi at most once per night
 * (idempotent per night) and a retried step re-runs cheaply.
 */
export const CAPABILITY_DISTILL_REFRESH_HOURS = 20;

/** Max tedis distilled per workflow run — bounds LLM calls per cycle. */
const CAPABILITY_DISTILL_MAX_TEDIS_PER_RUN = 8;

/** Cap on tedi-selection eval rows read per cycle (matches the priors read cap). */
const CAPABILITY_DISTILL_READ_CAP = 400;

/** D1 caps bound params per query (~100) — chunk run-id reads below it. */
const CAPABILITY_DISTILL_QUERY_CHUNK = 80;

/** Bounded wall-clock budget for each distillation LLM round trip. */
const CAPABILITY_DISTILL_TIMEOUT_MS = 20_000;

/** Stored description length cap — the router prompt renders this verbatim. */
export const CAPABILITY_DESCRIPTION_MAX_CHARS = 600;

const CAPABILITY_DISTILL_SYSTEM_PROMPT =
	"You summarize an autonomous digital worker's delegation track record. From the graded PASS/FAIL outcomes and their objectives, write a 2-3 sentence capability description grounded ONLY in this evidence: what kinds of objectives this worker reliably succeeds at, and where it fails or is unproven. Plain text only — no preamble, no bullets, no markdown.";

/** Each durable retry uses current canonical state, never the collected snapshot. */
export async function reconcileReflectedMemory(input: {
	step: WorkflowStep;
	db: DbClient;
	binding: CloudflareEnv["AGENT_MEMORY"];
	organizationId: string;
	factIds: readonly string[];
}): Promise<void> {
	for (const factId of input.factIds) {
		await input.step.do(
			`reconcile-agent-memory:${factId}`,
			{ retries: { limit: 3, delay: "5 seconds" }, timeout: "2 minutes" },
			async () => {
				const fact = await getFactById(input.db, factId);
				if (!fact || fact.organizationId !== input.organizationId) {
					return { skipped: true };
				}
				await reconcileCanonicalMemoryProjection(input.binding, {
					factId: fact.id,
					orgId: fact.organizationId,
					tediId: fact.tediId,
					memoryScope: fact.memoryScope,
					usePolicy: fact.usePolicy,
					reviewStatus: fact.reviewStatus,
					archivedAt: fact.archivedAt,
					validTo: fact.validTo,
					content: fact.content,
					summary: fact.summary,
					factType: fact.factType,
					confidence: fact.confidence,
				});
				return { skipped: false };
			},
		);
	}
}

export class MemoryReflectionWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	ReflectionParams
> {
	async run(event: WorkflowEvent<ReflectionParams>, step: WorkflowStep) {
		const { organizationId, tediId, scope, ownerUserId } = event.payload;
		const db = createDbClient(this.env.DB);
		const steps = <T>(
			name: string,
			config: WorkflowStepConfig,
			body: () => Promise<T>,
		) =>
			// Every step result is plain JSON by construction.
			step.do(name, config, body as () => Promise<never>) as Promise<T>;

		// One person's new decisions -> their lessons, built on the current
		// ones; the whole history when there is nothing to build on.
		if (scope === "lessons-incremental" && ownerUserId) {
			const result = await distillOwnerIncrementally(
				steps,
				db,
				this.env,
				organizationId,
				ownerUserId,
			);
			if (result.status !== "full") return result;
			return distillPersonalLessons(steps, db, this.env, organizationId);
		}

		// Each person's whole decision history -> lessons, one step per chunk
		// (see lesson-map-reduce.ts). Its own instance, dispatched below and by
		// `mine_agent_session_lessons`.
		if (scope === "lessons")
			return distillPersonalLessons(steps, db, this.env, organizationId);

		// Step 1: Collect recent facts to review
		const facts = await step.do(
			"collect-facts",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				const params: Parameters<typeof searchFacts>[1] = {
					orgId: organizationId,
					limit: scope === "full" ? 500 : 100,
				};
				if (tediId) params.tediId = tediId;
				const results = await searchFacts(db, params);
				// Serialize for workflow step storage
				return JSON.parse(JSON.stringify(results)) as Array<{
					id: string;
					content: string;
					summary: string | null;
					factType: string;
					confidence: number;
					organizationId: string;
					tediId: string | null;
					memoryScope: string | null;
					usePolicy: string | null;
					reviewStatus: string | null;
				}>;
			},
		);

		// Step 1b: Distill per-tedi evidence-learned capability descriptions
		// (capability flywheel). Runs EARLY deliberately: the Workflows engine
		// executes consecutive fast steps in ONE Worker invocation, and the heavy
		// steps below (vector dedup, graph sync, route grading) exhaust that
		// invocation's subrequest budget — placed after them, this step's LLM
		// fetches die instantly with "Too many subrequests" (a durable 1-minute
		// sleep does not force a fresh invocation).
		// Consequence: distillation reads the `tsel:` rows graded on PREVIOUS
		// runs, so profiles trail grading by at most one reflection cycle —
		// acceptable for a learning signal. Fail-soft: any error degrades to
		// {written: 0} and never fails the reflection; the trace string lands in
		// the durable step output so a 0-written night is diagnosable from
		// `wrangler workflows instances describe` alone.
		const tediCapabilityDistillResult = await step.do(
			"distill-tedi-capabilities",
			{ retries: { limit: 1, delay: "5 seconds" }, timeout: "3 minutes" },
			async () => {
				try {
					return await this.distillTediCapabilities(db, organizationId);
				} catch (e) {
					console.error(
						"[CapabilityFlywheel] distill-tedi-capabilities failed:",
						e,
					);
					return { written: 0, trace: `error: ${String(e).slice(0, 300)}` };
				}
			},
		);
		const tediCapabilitiesDistilled = tediCapabilityDistillResult.written;
		// Exact source/topic identity is the canonical D1 deduplication boundary.
		// Cloudflare Agent Memory is a semantic recall projection; its generated
		// answers never mutate or merge canonical facts.
		const duplicates: Array<{
			factId: string;
			similarTo: string;
			score: number;
		}> = [];
		const duplicatesMerged = 0;
		// Step 3: Create edges for discovered relationships
		// Idempotent: skips edges that already exist via getEdgesForFact check.
		const edgesCreated = await step.do(
			"create-edges",
			{ retries: { limit: 2, delay: "3 seconds" }, timeout: "1 minute" },
			async () => {
				let created = 0;
				for (const dup of duplicates) {
					try {
						// Check if edge already exists
						const existing = await getEdgesForFact(db, dup.factId);
						const alreadyLinked = existing.some(
							(e: { sourceFactId: string; targetFactId: string }) =>
								(e.sourceFactId === dup.factId &&
									e.targetFactId === dup.similarTo) ||
								(e.targetFactId === dup.factId &&
									e.sourceFactId === dup.similarTo),
						);

						if (!alreadyLinked) {
							await createEdge(db, {
								id: crypto.randomUUID(),
								sourceFactId: dup.factId,
								targetFactId: dup.similarTo,
								relationType: "related_to",
								strength: dup.score,
								context:
									"Auto-discovered via vector similarity during reflection",
							});
							created++;
						}
					} catch {
						// Edge creation can fail on unique constraint, continue
					}
				}
				return created;
			},
		);

		// Step3b: bounded API-owned semantic proposals; lifecycle state is never changed here.
		const autoLinkResult = await step.do(
			"auto-link-domains",
			{ retries: { limit: 0, delay: "5 seconds" }, timeout: "2 minutes" },
			async () =>
				runOptionalGraphLinking(() =>
					autoLinkFactsWithJev({
						db,
						env: this.env,
						context: {
							organizationId,
							tediId,
							runId: event.instanceId,
							sessionKey: `reflection:${event.instanceId}`,
						},
						scope: reflectionAutoLinkScope(organizationId, tediId, facts),
						maxEdges: AUTO_LINK_MAX_EDGES_PER_RUN,
					}),
				),
		);

		// Step 4: Decay confidence (single SQL UPDATE — idempotent over short windows)
		const confidenceUpdated = await step.do(
			"decay-confidence",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				await decayConfidence(db, organizationId, 0.995, 0.1);
				return facts.length;
			},
		);

		// Step 5: Archive low-confidence canonical facts
		// Idempotent: re-archiving already-archived facts is a no-op.
		const archiveResult = await step.do(
			"archive-stale",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				return archiveLowConfidence(db, organizationId, 0.15);
			},
		);

		// Step 6: Promote validated probation facts to active
		const probationPromoted = await step.do(
			"promote-probation",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				return promoteFromProbation(db, organizationId, 1);
			},
		);

		// Step 6b: Expire stale probation facts (never accessed within 7 days)
		const probationExpireResult = await step.do(
			"expire-probation",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "30 seconds" },
			async () => {
				return expireProbation(db, organizationId, 7);
			},
		);

		// Step 6c: checkpoint each fact independently so one failed projection
		// does not replay successful writes. Each retry reads current D1 lifecycle.
		await reconcileReflectedMemory({
			step,
			db,
			binding: this.env.AGENT_MEMORY,
			organizationId,
			factIds: facts.map((fact) => fact.id),
		});

		// Graph projection and GDS refresh moved to GraphProjectionDrainWorkflow.
		// Reflection mutates canonical D1 only; the transactional outbox captures
		// those changes. Keeping the old offset replay or independent GDS run here
		// would bypass the readiness watermark and reintroduce stale writes.
		const graphSynced = 0;
		const graphAlgorithmsRun = 0;

		// Step 9: Mine explicit operator decisions from Home conversation
		const homeDecisionFactsWritten = await step.do(
			"mine-home-decisions",
			{ retries: { limit: 1, delay: "5 seconds" }, timeout: "1 minute" },
			async () => {
				try {
					const result = await mineHomeOperatorDecisions(db, {
						orgId: organizationId,
					});
					if (result.budgetHit) {
						console.warn(
							`[HomeReflection] Budget cap hit for org ${organizationId}: ${result.factsWritten} written, ${result.factsSkipped} skipped`,
						);
					}
					return result.factsWritten;
				} catch (e) {
					console.error("[HomeReflection] mine-home-decisions failed:", e);
					return 0;
				}
			},
		);

		// Step 9b: Learning feed — user decisions from agent sessions become
		// review-pending lessons; repeated agent fixes become improvement
		// proposals. Fail-soft: never fails the reflection.
		const learningFeed = await step.do(
			"mine-learning-feed",
			{ retries: { limit: 1, delay: "5 seconds" }, timeout: "1 minute" },
			async () => {
				try {
					return await mineLearningFeed(db, {
						orgId: organizationId,
						route: clefLessonRouter(this.env),
						distill: modelLessonDistiller(this.env),
					});
				} catch (e) {
					console.error("[LearningFeed] mine-learning-feed failed:", e);
					return null;
				}
			},
		);
		const learningFeedFactsWritten = learningFeed?.factsWritten ?? 0;

		// Step 9c: distil each person's whole decision history into lessons,
		// as its own instance so its many model calls get a fresh budget.
		await step.do(
			"dispatch-lesson-distillation",
			{ retries: { limit: 1, delay: "5 seconds" }, timeout: "30 seconds" },
			async () => {
				try {
					await this.env.MEMORY_REFLECTION_WORKFLOW.create({
						id: lessonDistillationInstanceId(event.instanceId),
						params: { organizationId, scope: "lessons" as const },
					});
					return true;
				} catch (e) {
					console.error(
						"[LearningFeed] lesson distillation dispatch failed:",
						e,
					);
					return false;
				}
			},
		);
		const learningFeedProposalsCreated = learningFeed?.proposalsCreated ?? 0;

		// Step 10: Grade recent kernel route decisions and persist eval results
		const kernelRouteEvalGraded = await step.do(
			"grade-kernel-routes",
			{ retries: { limit: 1, delay: "5 seconds" }, timeout: "1 minute" },
			async () => {
				try {
					const result = await gradeRecentKernelRoutes(db, {
						orgId: organizationId,
						assessAnswerCriteria: ({ runId, criteria, childEvidence }) =>
							assessDelegatedAnswerCriteriaWithJev({
								db,
								env: this.env,
								context: { organizationId },
								runId,
								criteria,
								childEvidence,
							}),
					});
					return result.runsGraded;
				} catch (e) {
					console.error("[KernelRouteEval] grade-kernel-routes failed:", e);
					return 0;
				}
			},
		);

		// Step 11: Generate summary
		const factsCount = facts?.length ?? 0;
		const dupsCount = duplicates?.length ?? 0;
		const factsArchived = archiveResult.count;
		const graphNote =
			graphSynced > 0 ? ` Synced ${graphSynced} facts to graph DB.` : "";
		const algoNote =
			graphAlgorithmsRun > 0
				? ` Ran ${graphAlgorithmsRun} graph algorithm steps.`
				: "";
		const probationNote =
			probationPromoted > 0 || probationExpireResult.count > 0
				? ` Probation: promoted ${probationPromoted}, expired ${probationExpireResult.count}.`
				: "";
		const mergeNote =
			duplicatesMerged > 0
				? ` Merged ${duplicatesMerged} near-duplicate facts.`
				: "";
		const autoLinkNote = autoLinkResult.failed
			? " Automatic graph linking interrupted; partial edge counts unavailable."
			: autoLinkResult.edgesCreated > 0
				? ` Auto-linked ${autoLinkResult.edgesCreated} edges across ${autoLinkResult.domainsScanned} domains.`
				: autoLinkResult.proposals.length > 0
					? ` Graph linking in shadow: ${autoLinkResult.proposals.length} proposed edges recorded, not applied.`
					: "";
		const homeNote =
			homeDecisionFactsWritten > 0
				? ` Mined ${homeDecisionFactsWritten} Home operator decision fact${homeDecisionFactsWritten === 1 ? "" : "s"}.`
				: "";
		const learningFeedNote =
			learningFeedFactsWritten + learningFeedProposalsCreated > 0
				? ` Learning feed: ${learningFeedFactsWritten} pending lesson${learningFeedFactsWritten === 1 ? "" : "s"}, ${learningFeedProposalsCreated} mistake proposal${learningFeedProposalsCreated === 1 ? "" : "s"}.`
				: "";
		const kernelRouteEvalNote =
			kernelRouteEvalGraded > 0
				? ` Graded ${kernelRouteEvalGraded} kernel route decision${kernelRouteEvalGraded === 1 ? "" : "s"}.`
				: "";
		const capabilityNote =
			tediCapabilitiesDistilled > 0
				? ` Distilled ${tediCapabilitiesDistilled} tedi capability profile${tediCapabilitiesDistilled === 1 ? "" : "s"}.`
				: "";

		// Consolidation state-transition quota: a reflection run that only
		// appends facts is a failed consolidation. Visible warning, never fatal.
		const transitions = summarizeConsolidationTransitions({
			probationPromoted,
			duplicatesMerged,
			factsArchived,
			probationExpired: probationExpireResult.count,
		});
		if (transitions.total === 0) {
			console.warn(
				`[Reflection] consolidation produced no state transitions (org ${organizationId}): ${factsCount} facts reviewed, 0 promoted/demoted/merged/archived — a run that only appends facts fails the WS4 quota`,
			);
		}
		const transitionsNote = ` Transitions: promoted ${transitions.promoted}, demoted ${transitions.demoted}, merged ${transitions.merged}, archived ${transitions.archived}${transitions.total === 0 ? " — NO STATE TRANSITIONS (WS4 quota warning)" : ""}.`;

		const result: ReflectionResult = {
			factsReviewed: factsCount,
			duplicatesFound: dupsCount,
			duplicatesMerged,
			edgesCreated,
			autoLinkEdgesCreated: autoLinkResult.edgesCreated,
			autoLinkDomainsScanned: autoLinkResult.domainsScanned,
			factsArchived,
			confidenceUpdated,
			probationPromoted,
			probationExpired: probationExpireResult.count,
			graphAlgorithmsRun,
			homeDecisionFactsWritten,
			learningFeedFactsWritten,
			learningFeedProposalsCreated,
			kernelRouteEvalGraded,
			tediCapabilitiesDistilled,
			transitions,
			summary: `Reflection complete. Reviewed ${factsCount} facts. Found ${dupsCount} similar pairs, created ${edgesCreated} new edges.${mergeNote}${autoLinkNote} Decayed confidence on ${confidenceUpdated} facts. Archived ${factsArchived} low-confidence facts.${probationNote}${transitionsNote}${graphNote}${algoNote}${homeNote}${learningFeedNote}${kernelRouteEvalNote}${capabilityNote}`,
		};

		return result;
	}

	/**
	 * Distill one evidence-learned capability description per qualifying tedi
	 * (capability flywheel — Step 10b). Bounded pipeline:
	 *
	 *   1. ONE indexed read of the last 30 days of tedi-selection eval rows
	 *      (`tsel:` ids, subjectId `tedi-selection:{orgId}`), newest-first,
	 *      capped at CAPABILITY_DISTILL_READ_CAP.
	 *   2. Pure per-tedi grouping (`groupCapabilityEvidence`); only tedis with
	 *      >= CAPABILITY_DISTILL_MIN_EVIDENCE graded outcomes qualify — under
	 *      the threshold nothing is written.
	 *   3. Refresh gate (`shouldDistillTediCapability`): a profile updated in
	 *      the last CAPABILITY_DISTILL_REFRESH_HOURS is skipped, making the
	 *      step idempotent per night on the 8-hourly cron.
	 *   4. Objectives for the sampled runs read back from kernel_runtime_runs
	 *      (chunked at CAPABILITY_DISTILL_QUERY_CHUNK bound params).
	 *   5. One small LLM call per tedi (<= CAPABILITY_DISTILL_MAX_TEDIS_PER_RUN
	 *      per cycle; input capped at CAPABILITY_DISTILL_EVIDENCE_ROW_CAP rows,
	 *      objectives truncated to CAPABILITY_DISTILL_OBJECTIVE_CHARS chars)
	 *      via the same provider-aware `kernelModel` path every secondary
	 *      kernel LLM surface rides, then an idempotent upsert of the
	 *      `tcap:{tediId}` knowledge_entries row.
	 *
	 * Per-tedi failures are logged and skipped; the caller wraps the whole
	 * method fail-soft, so this can never fail the reflection workflow.
	 */
	private async distillTediCapabilities(
		db: DbClient,
		organizationId: string,
	): Promise<{ written: number; trace: string }> {
		const cutoff = new Date(
			Date.now() - CAPABILITY_DISTILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
		).toISOString();

		const evalRows = await listTediSelectionCapabilityEvidence(db, {
			organizationId,
			createdSince: cutoff,
			limit: CAPABILITY_DISTILL_READ_CAP,
		});

		const grouped = groupCapabilityEvidence(
			evalRows.map((row) => ({
				tediId: row.tediId,
				passed: row.passed,
				metadata: (row.metadata as Record<string, unknown> | null) ?? null,
			})),
		);
		const qualifying = [...grouped.values()].filter(
			(evidence) => evidence.total >= CAPABILITY_DISTILL_MIN_EVIDENCE,
		);
		const traceBase = `rows=${evalRows.length} grouped=${grouped.size} qualifying=${qualifying.length}`;
		if (qualifying.length === 0) return { written: 0, trace: traceBase };

		// Refresh gate: read the existing profiles ONCE (chunked PK read) and
		// keep only the stale ones, capped per cycle.
		const existing = await getTediLearnedCapabilities(
			db,
			organizationId,
			qualifying.map((evidence) => evidence.tediId),
		);
		const nowMs = Date.now();
		const due = qualifying
			.filter((evidence) =>
				shouldDistillTediCapability({
					total: evidence.total,
					existingUpdatedAt: existing.get(evidence.tediId)?.updatedAt ?? null,
					nowMs,
				}),
			)
			.slice(0, CAPABILITY_DISTILL_MAX_TEDIS_PER_RUN);
		if (due.length === 0) {
			return { written: 0, trace: `${traceBase} due=0 (profiles fresh)` };
		}

		// Provider-aware model (Azure via AI Gateway / Workers AI under the force
		// flag) — same resolution every secondary kernel LLM surface uses. No
		// model configured → skip silently (the card simply keeps its prior text).
		const model = kernelModel(
			this.env as unknown as KernelEnv,
			undefined,
			organizationId,
		);
		if (!model) {
			console.log(
				"[CapabilityFlywheel] skip (no kernel model configured)",
				organizationId,
			);
			return { written: 0, trace: `${traceBase} due=${due.length} model=none` };
		}

		// Display names for the prompt (<= MAX_TEDIS ids — one bounded read).
		const tediRows = await listTediDisplayNamesByIds(db, {
			organizationId,
			ids: due.map((evidence) => evidence.tediId),
		});
		const nameById = new Map(
			tediRows.map((t) => [t.id, t.displayName || t.name || t.slug]),
		);

		// Objectives for the sampled runs, chunked (<= 8 tedis × 20 runs).
		const runIds = [
			...new Set(
				due.flatMap((evidence) =>
					evidence.samples
						.map((sample) => sample.runId)
						.filter((id): id is string => Boolean(id)),
				),
			),
		];
		const objectiveByRunId = new Map<string, string>();
		for (let i = 0; i < runIds.length; i += CAPABILITY_DISTILL_QUERY_CHUNK) {
			const batch = runIds.slice(i, i + CAPABILITY_DISTILL_QUERY_CHUNK);
			const runs = await listKernelRuntimeRunObjectiveSourcesByIds(db, {
				organizationId,
				ids: batch,
			});
			for (const run of runs) {
				const objective =
					extractDelegationObjective(
						run.metadata as Record<string, unknown> | null,
					) ??
					(typeof run.preview === "string" && run.preview.trim()
						? run.preview.trim()
						: null);
				if (objective) objectiveByRunId.set(run.id, objective);
			}
		}

		const { tracedAi } = await import("../lib/traced-ai");
		let written = 0;
		const perTediErrors: string[] = [];
		for (const evidence of due) {
			try {
				const lines = buildCapabilityEvidenceLines(
					evidence.samples.map((sample) => ({
						objective: sample.runId
							? (objectiveByRunId.get(sample.runId) ?? null)
							: null,
						passed: sample.passed,
					})),
				);
				// No resolvable objectives → nothing meaningful to summarize.
				if (lines.length === 0) continue;

				const abortController = new AbortController();
				const timeoutId = setTimeout(
					() => abortController.abort(),
					CAPABILITY_DISTILL_TIMEOUT_MS,
				);
				let raw: string | undefined;
				try {
					const result = await tracedAi.generateText({
						model: model.model,
						system: CAPABILITY_DISTILL_SYSTEM_PROMPT,
						runtimeContext: {
							agentId: "memory-reflection",
							conversationId: evidence.tediId,
							orgId: organizationId,
							source: "capability_distill",
						},
						telemetry: { functionId: "memory.capability_distill" },
						messages: [
							{
								role: "user",
								content: buildCapabilityDistillationPrompt({
									tediName: nameById.get(evidence.tediId) ?? evidence.tediId,
									passed: evidence.passed,
									total: evidence.total,
									lines,
								}),
							},
						],
						// Generous for 2-3 sentences, but reasoning-capable Workers AI
						// models spend output budget before the visible text — a tight
						// cap truncates to empty (conversation-title lesson).
						maxOutputTokens: 512,
						abortSignal: abortController.signal,
					});
					raw = result.text;
				} finally {
					clearTimeout(timeoutId);
				}

				const description = sanitizeLearnedDescription(raw);
				if (!description) continue;

				await upsertTediLearnedCapability(db, {
					organizationId,
					tediId: evidence.tediId,
					learnedDescription: description,
					evidenceCount: evidence.total,
					successRate:
						evidence.total > 0 ? evidence.passed / evidence.total : 0,
				});
				written++;
			} catch (e) {
				console.warn(
					`[CapabilityFlywheel] distill failed for tedi ${evidence.tediId}:`,
					e instanceof Error ? e.message : String(e),
				);
				const message = e instanceof Error ? e.message : String(e);
				perTediErrors.push(
					`${evidence.tediId.slice(0, 8)}:${message.slice(0, 120)}`,
				);
				// Subrequest budget exhausted: every remaining LLM call in this
				// invocation will fail identically — stop burning attempts.
				if (message.includes("Too many subrequests")) break;
			}
		}
		return {
			written,
			trace: `${traceBase} due=${due.length} written=${written}${perTediErrors.length > 0 ? ` errors=[${perTediErrors.join("; ")}]` : ""}`,
		};
	}
}

// ============================================================================
// Capability flywheel — pure input-shaping helpers (exported for unit tests)
// ============================================================================

export interface CapabilityEvidenceEvalRow {
	/** harness_subject_eval_results.tedi_id (fallback identity). */
	tediId: string | null;
	passed: boolean;
	/** Eval-row metadata — carries `delegatedTediId` + `runId` stamps. */
	metadata: Record<string, unknown> | null;
}

export interface TediCapabilityEvidence {
	tediId: string;
	/** Passed outcomes over the whole window (not just the sampled rows). */
	passed: number;
	/** Total graded outcomes over the whole window. */
	total: number;
	/** Newest-first sample, capped at CAPABILITY_DISTILL_EVIDENCE_ROW_CAP. */
	samples: Array<{ runId: string | null; passed: boolean }>;
}

/**
 * Group newest-first tedi-selection eval rows per tedi: full pass/total counts
 * plus a capped newest-first sample of (runId, passed) pairs for the prompt.
 * Rows with no resolvable tedi (neither `metadata.delegatedTediId` nor the
 * row's own `tediId`) are dropped — mirrors `summarizeTediSelectionPriors`.
 */
export function groupCapabilityEvidence(
	rowsNewestFirst: CapabilityEvidenceEvalRow[],
): Map<string, TediCapabilityEvidence> {
	const out = new Map<string, TediCapabilityEvidence>();
	for (const row of rowsNewestFirst) {
		const fromMeta =
			typeof row.metadata?.delegatedTediId === "string"
				? (row.metadata.delegatedTediId as string)
				: null;
		const tediId = fromMeta ?? row.tediId;
		if (!tediId) continue;
		let entry = out.get(tediId);
		if (!entry) {
			entry = { tediId, passed: 0, total: 0, samples: [] };
			out.set(tediId, entry);
		}
		entry.total += 1;
		if (row.passed) entry.passed += 1;
		if (entry.samples.length < CAPABILITY_DISTILL_EVIDENCE_ROW_CAP) {
			const runId =
				typeof row.metadata?.runId === "string"
					? (row.metadata.runId as string)
					: null;
			entry.samples.push({ runId, passed: row.passed });
		}
	}
	return out;
}

/**
 * Pure distill/skip decision: enough evidence AND no fresh profile. `null`
 * or unparsable `existingUpdatedAt` counts as "never distilled" → distill.
 */
export function shouldDistillTediCapability(input: {
	total: number;
	existingUpdatedAt: string | null;
	nowMs: number;
}): boolean {
	if (input.total < CAPABILITY_DISTILL_MIN_EVIDENCE) return false;
	if (!input.existingUpdatedAt) return true;
	const updatedMs = Date.parse(input.existingUpdatedAt);
	if (!Number.isFinite(updatedMs)) return true;
	return (
		input.nowMs - updatedMs >= CAPABILITY_DISTILL_REFRESH_HOURS * 60 * 60 * 1000
	);
}

/**
 * Extract the delegation objective from a kernel run's metadata — the work
 * order stamp `homeDelegation.workOrder.objective` (same nesting
 * `resolveDelegatedTediId` reads for the target tedi).
 */
export function extractDelegationObjective(
	metadata: Record<string, unknown> | null | undefined,
): string | null {
	const workOrder = asRecord(asRecord(metadata?.homeDelegation)?.workOrder);
	const objective = workOrder?.objective;
	return typeof objective === "string" && objective.trim()
		? objective.trim()
		: null;
}

/** Collapse whitespace + cap an objective excerpt for the prompt. */
export function truncateObjective(objective: string): string {
	const collapsed = objective.replace(/\s+/g, " ").trim();
	return collapsed.length > CAPABILITY_DISTILL_OBJECTIVE_CHARS
		? `${collapsed.slice(0, CAPABILITY_DISTILL_OBJECTIVE_CHARS - 1).trimEnd()}…`
		: collapsed;
}

/**
 * Render the graded-outcome lines for the prompt. Entries whose objective
 * could not be resolved are skipped — a bare PASS/FAIL with no objective
 * teaches the model nothing about WHAT kind of work it was.
 */
export function buildCapabilityEvidenceLines(
	entries: Array<{ objective: string | null; passed: boolean }>,
): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		if (!entry.objective?.trim()) continue;
		lines.push(
			`- ${entry.passed ? "PASS" : "FAIL"}: ${truncateObjective(entry.objective)}`,
		);
	}
	return lines;
}

/** Pure prompt builder — tiny, bounded by the line/objective caps above. */
export function buildCapabilityDistillationPrompt(input: {
	tediName: string;
	passed: number;
	total: number;
	lines: string[];
}): string {
	return [
		`Worker: ${input.tediName}`,
		`Track record: ${input.passed}/${input.total} delegated objectives passed in the last ${CAPABILITY_DISTILL_LOOKBACK_DAYS} days.`,
		"Graded delegations (newest first):",
		...input.lines,
	].join("\n");
}

/**
 * Pure model-output sanitizer: strip code fences / symmetric quote wrappers,
 * collapse to single-line prose, cap at CAPABILITY_DESCRIPTION_MAX_CHARS.
 * Returns `null` for empty output so the caller stores nothing rather than
 * junk (the router prompt renders this verbatim).
 */
export function sanitizeLearnedDescription(
	raw: string | null | undefined,
): string | null {
	if (typeof raw !== "string") return null;
	let text = raw.trim();
	// Strip a markdown code fence wrapper (```...```), if any.
	text = text.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "");
	text = text.replace(/\s+/g, " ").trim();
	// Unwrap a symmetric quote wrapper.
	const wrapped = text.match(/^["'“”](.*)["'“”]$/);
	const inner = wrapped?.[1]?.trim();
	if (inner) text = inner;
	if (!text) return null;
	if (text.length > CAPABILITY_DESCRIPTION_MAX_CHARS) {
		text = `${text.slice(0, CAPABILITY_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
	}
	return text;
}
