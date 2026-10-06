/**
 * Kernel Route Evaluation — Deterministic grader + batch persistence pass.
 *
 * `gradeKernelRoute` grades ONE settled kernel run purely from its run row
 * metadata + terminal events. No model, no I/O — entirely unit-testable.
 *
 * `gradeRecentKernelRoutes` reads settled kernel_runtime_runs for an org in a
 * lookback window, grades each via `gradeKernelRoute`, and persists ONE
 * `harness_subject_eval_result` per run via `recordSubjectEvalResult`, then
 * writes a single `harness_subject_eval_run` summary row. Idempotent: the
 * deterministic id `kser:{harnessVersionId}:{runId}` prevents double-inserts.
 *
 * Forbidden:
 * - No online route mutation — output only goes to the eval ledger.
 * - No per-turn self-modification — this runs post-hoc, off the hot path.
 */

import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import type { DbClient } from "@tedix/db/client";
import {
	recordSubjectEvalResult,
	recordSubjectEvalRun,
} from "@tedix/db/queries/harness-version/evaluations";
import { invalidateTediLearnedCapabilityBefore } from "@tedix/db/queries/cognitive/learned-capabilities";
import {
	kernelHarnessSubjectId,
	tediSelectionSubjectId,
} from "@tedix/db/queries/harness-version/subjects";
import {
	getKernelCorrectionEvalRevision,
	listChildTurnEvidenceEvents,
	listCorrectedKernelRunIds,
	listExistingKernelEvalResultIds,
	listKernelEvaluationEvents,
	listKernelEvalResultsForPriorRun,
	listKernelRouteCorrectionEvents,
	listKernelRunsForCorrection,
	listSettledKernelRunsForEvaluation,
} from "@tedix/db/queries/kernel-route-eval";
import { classifyToolCall } from "@tedix/mcp-client-core/tool-liveness";
import {
	classifyDelegationFailure,
	type DelegationFailureClassification,
} from "../rpc/routers/kernel/delegation-dispatch";
import {
	assessClaimVsEvidence,
	type ChildToolCall,
	type ChildTurnEvidence,
	type ClaimVsEvidenceVerdict,
} from "./claim-vs-evidence";
import { ensureActiveKernelHarnessVersion } from "./harness-persistence";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default lookback window when not specified (matches reflection cron cadence). */
const DEFAULT_LOOKBACK_HOURS = 9;

/** Lane label for production live-turn kernel evals. */
export const KERNEL_EVAL_LANE = "production";

/** Task set id for live kernel route evals. */
export const KERNEL_EVAL_TASK_SET_ID = "kernel-route-v1";

/** Task set id for the per-tedi delegation-selection eval lane. */
export const TEDI_SELECTION_TASK_SET_ID = "tedi-selection-v1";

/** Cap on runs graded per cycle to bound D1 reads. */
const MAX_RUNS_PER_CYCLE = 200;

/** A bounded all-history scan is safe while correction traffic is sparse.
 * Exceeding the cap fails visibly instead of silently missing a correction. */
const CORRECTION_PAGE_SIZE = 100;
const MAX_CORRECTION_PAGES = 20;

function parseEvalMetadata(
	value: unknown,
	label: string,
): Record<string, JsonValue> {
	const parsed = JsonValueSchema.safeParse(value);
	if (
		!parsed.success ||
		parsed.data === null ||
		typeof parsed.data !== "object" ||
		Array.isArray(parsed.data)
	) {
		throw new Error(`${label} must be a JSON object`);
	}
	return parsed.data;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KernelRunGradeInput {
	runId: string;
	/** kernelRuntimeRuns.status at terminal time */
	status: string;
	/** kernelRuntimeRuns.metadata (JSON) */
	metadata: Record<string, unknown> | null;
	/** All kernel_runtime_events for this run */
	events: Array<{
		kind: string;
		payload: Record<string, unknown> | null;
		runId: string | null;
	}>;
	/**
	 * Delegated child turn evidence (final assistant message + observed tool
	 * calls from the child's tedi_runtime_events) for delegate_tedi runs. When
	 * present, the grader adds a `claimVsEvidence` gate: a side-effect CLAIM in
	 * the child's final message with zero potentially-mutating tool calls fails
	 * the gate (e.g. "Setting it up now" after one discovery call). Absent (non-delegated run, evidence read
	 * failed, or no final message) → the gate is not added, so existing grades
	 * are unchanged.
	 */
	childEvidence?: ChildTurnEvidence | null;
}

export interface KernelRouteGrade {
	score: number;
	gates: Record<string, boolean>;
	passed: boolean;
	/**
	 * Audit detail for the claimVsEvidence gate (claim excerpt + tool names),
	 * persisted into the eval-row metadata. Present only when the gate ran.
	 */
	claimVsEvidence?: ClaimVsEvidenceVerdict;
	/**
	 * Soft contract signal (delegate_tedi only): whether the child's evidence
	 * met the dispatch-side work-order success criteria. NEVER a gate — a
	 * pre-contract run or an evidence gap must not change any existing grade.
	 * Present only when the work order carried a contract; `criteriaMet` is
	 * null when the evidence cannot settle it either way.
	 */
	contract?: {
		criteriaMet: boolean | null;
		/** Soft Jev assessment of answer coverage, not external result proof. */
		answerCriteriaMet?: boolean | null;
	};
	/**
	 * Typed failure classification (delegate_tedi only), from the run's
	 * canonical failure envelope and/or an overclaim verdict. Present only when
	 * there is a failure signal to classify.
	 */
	delegationFailure?: DelegationFailureClassification;
}

/**
 * Execution-evidence check for a delegated child turn, using the SAME classifier
 * as the kernel proof gate (`@tedix/mcp-client-core/tool-liveness`). True when at
 * least one observed tool call is an EXECUTION call (a real `namespace.tool(...)`
 * via Code Mode, a `tedix_mcp_call_tool`, or a direct bespoke tool) — as opposed
 * to discovery-only (`search_tools` / `list_namespaces` / a `tedix_mcp_code`
 * snippet that only ran `discover.*`).
 */
function childTurnHasExecutionEvidence(evidence: ChildTurnEvidence): boolean {
	return evidence.toolCalls.some((call) => {
		const argsJson =
			typeof call.codeArgument === "string"
				? JSON.stringify({ code: call.codeArgument })
				: "{}";
		return classifyToolCall(call.name, argsJson) === "execution";
	});
}

// ─── Pure Grader ─────────────────────────────────────────────────────────────

/**
 * Deterministic, pure grade of one settled kernel run. No model, no I/O.
 *
 * Gates:
 * - `routeProduced`: metadata.kernelRoute is non-null AND has a routeKind.
 * - `notCorrected`: no `decision.recorded` event with `action=kernel.route_corrected`
 *   referencing THIS run as priorRunId.
 * - `outcomeSucceeded`: the route-specific outcome evidence is positive
 *   (see per-routeKind logic below).
 *
 * `passed` = AND over all gates. `score` = deterministic [0,1] blend.
 *
 * Route-specific outcome logic. Canonical route kinds are the
 * `HOME_ROUTE_KINDS` enum in `apps/api/src/rpc/routers/kernel/route-schema.ts`:
 * answer_in_home, propose_tool_write, delegate_tedi,
 * suggest_handoff, run_workflow, ask_human.
 * - In-home settling routes (`answer_in_home` | `suggest_handoff` |
 *   `run_workflow` | `ask_human`): the kernel terminates the
 *   turn in Home — `run.completed` present → pass.
 * - `delegate_tedi`: `subagent.completed` OR a `decision.recorded`
 *   `home.plan.approved` → pass; `subagent.failed` OR `home.plan.rejected` →
 *   fail; neither (incomplete) → fail. The plan-decision arm covers multi-tedi
 *   plan delegations whose outcome rides `decision.recorded`, not `subagent.*`.
 * - `propose_tool_write`: `approval.resolved` with `payload.approved === true` →
 *   pass; rejected / no resolution → fail.
 * - null routeKind or run.failed (runtime_dropped) → fail.
 * - any genuinely unknown future routeKind → fail (unscored).
 */
export function gradeKernelRoute(input: KernelRunGradeInput): KernelRouteGrade {
	const metadata = input.metadata ?? {};
	const route = recordOrNull(metadata.kernelRoute);
	const routeKind =
		typeof route?.routeKind === "string" ? route.routeKind : null;

	// Gate 1: routeProduced
	const routeProduced = routeKind !== null;

	// Gate 2: notCorrected — no decision.recorded event with action=kernel.route_corrected
	// that references THIS run as priorRunId
	const correctionEvent = input.events.find(
		(e) =>
			e.kind === "decision.recorded" &&
			e.payload?.action === "kernel.route_corrected" &&
			e.payload?.priorRunId === input.runId,
	);
	const notCorrected = correctionEvent === undefined;

	// Gate 3: outcomeSucceeded — route-specific
	let outcomeSucceeded = false;

	if (input.status === "failed" || !routeProduced) {
		// Hard fail: runtime dropped or no route
		outcomeSucceeded = false;
	} else if (
		routeKind === "answer_in_home" ||
		routeKind === "suggest_handoff" ||
		routeKind === "run_workflow" ||
		routeKind === "ask_human"
	) {
		// Kernel settled the turn in Home (answered, suggested a handoff,
		// dispatched a workflow, or prompted the human): run.completed = success.
		outcomeSucceeded = input.events.some((e) => e.kind === "run.completed");
	} else if (routeKind === "delegate_tedi") {
		// Delegation: success rides EITHER the child run terminal
		// (subagent.completed/failed) OR a multi-tedi plan decision
		// (decision.recorded home.plan.approved/rejected).
		// A positive terminal (child completed or plan approved) is success.
		// Otherwise — explicit failure, OR neither signal (incomplete) — fail.
		outcomeSucceeded = input.events.some(
			(e) =>
				e.kind === "subagent.completed" ||
				(e.kind === "decision.recorded" &&
					e.payload?.action === "home.plan.approved"),
		);
	} else if (routeKind === "propose_tool_write") {
		// Write proposal: approval.resolved with approved=true
		const approvalEvent = input.events.find(
			(e) => e.kind === "approval.resolved",
		);
		if (approvalEvent) {
			const approved = approvalEvent.payload?.approved;
			outcomeSucceeded = approved === true;
		} else {
			// No approval yet (still parked) or failed without one
			outcomeSucceeded = false;
		}
	} else {
		// Unknown / future route kind — treated as unscored failure
		outcomeSucceeded = false;
	}

	const gates: Record<string, boolean> = {
		routeProduced,
		notCorrected,
		outcomeSucceeded,
	};

	// Gate 4 (delegate_tedi only, when child evidence is available):
	// claimVsEvidence — the child's final message must not claim a side effect
	// its tool calls could not have performed. Only added when evidence exists,
	// so non-delegated runs and evidence-read failures grade exactly as before.
	let claimVerdict: ClaimVsEvidenceVerdict | undefined;
	if (
		routeKind === "delegate_tedi" &&
		input.childEvidence &&
		typeof input.childEvidence.finalAssistantMessage === "string" &&
		input.childEvidence.finalAssistantMessage.trim().length > 0
	) {
		claimVerdict = assessClaimVsEvidence(input.childEvidence);
		gates.claimVsEvidence = !claimVerdict.overclaim;

		// Gate 5: executionEvidence — a run that CALLED tools but produced NO
		// execution evidence (only discovery), yet returned a substantive answer,
		// is a READ-FABRICATION: the web-scrape class (discovered tavily/firecrawl,
		// never called them, then presented invented content). claimVsEvidence only
		// catches SIDE-EFFECT overclaims ("I created…"); a fabricated READ carries no
		// such verb and would otherwise grade as success. Mirrors the kernel proof
		// gate's discovery-stall so a fabrication the kernel BLOCKED also grades
		// FAILED — dragging the tedi's selection prior down (the flywheel punishment
		// that teaches it to execute, not hallucinate). Only when tools were actually
		// called: answer-only runs (zero tool calls) and executed runs are untouched.
		if (input.childEvidence.toolCalls.length > 0) {
			gates.executionEvidence = childTurnHasExecutionEvidence(
				input.childEvidence,
			);
		}
	}

	const passed = Object.values(gates).every(Boolean);

	// Deterministic [0,1] blend: each gate contributes equally
	const score =
		Object.values(gates).filter(Boolean).length / Object.keys(gates).length;

	// Contract soft signal (delegate_tedi only): when the dispatch-side work
	// order carried a contract (metadata.homeDelegation.workOrder.contract, set
	// by buildDelegationWorkOrder), report whether the child evidence met its
	// success criteria. Metadata only — never folded into gates/score, so
	// pre-contract runs grade byte-identically.
	let contract: { criteriaMet: boolean | null } | undefined;
	if (routeKind === "delegate_tedi") {
		const criteria = recoverContractSuccessCriteria(metadata);
		if (criteria.length > 0) {
			contract = {
				criteriaMet: assessContractCriteriaMet({
					outcomeSucceeded,
					childEvidence: input.childEvidence ?? null,
					overclaim: claimVerdict?.overclaim === true,
				}),
			};
		}
	}

	// Typed failure taxonomy (delegate_tedi only): classify the canonical
	// delegation failure envelope — and/or the overclaim verdict, which is a quality
	// failure even on a "completed" run — so eval rows carry a category +
	// retryability instead of a bare string.
	let delegationFailure: DelegationFailureClassification | undefined;
	if (routeKind === "delegate_tedi") {
		const failureEnvelope = recordOrNull(metadata.delegationFailure);
		const errorText =
			typeof failureEnvelope?.error === "string"
				? failureEnvelope.error.trim()
				: "";
		const overclaim = claimVerdict?.overclaim === true;
		if (errorText.length > 0 || overclaim) {
			delegationFailure = classifyDelegationFailure(
				errorText,
				overclaim ? { overclaim: true } : undefined,
			);
		}
	}

	return {
		score,
		gates,
		passed,
		...(claimVerdict ? { claimVsEvidence: claimVerdict } : {}),
		...(contract ? { contract } : {}),
		...(delegationFailure ? { delegationFailure } : {}),
	};
}

/**
 * Recover the work-order contract's success criteria from run metadata. The
 * contract rides as an extra JSON key on `homeDelegation.workOrder` (no
 * api-contract schema field), so read it defensively: anything malformed →
 * empty list → the contract signal is simply not reported.
 */
function recoverContractSuccessCriteria(
	metadata: Record<string, unknown>,
): string[] {
	const homeDelegation = recordOrNull(metadata.homeDelegation);
	const workOrder = recordOrNull(homeDelegation?.workOrder);
	const contract = recordOrNull(workOrder?.contract);
	const criteria = contract?.successCriteria;
	if (!Array.isArray(criteria)) return [];
	return criteria.filter(
		(item): item is string =>
			typeof item === "string" && item.trim().length > 0,
	);
}

/**
 * Every derived criteria set demands the result cite the tool calls that
 * produced it (read: the facts; write: the mutation), so the deterministic
 * check is evidence-shaped, not text-shaped:
 * - no evidence / no final message → null (indeterminable, fail-soft);
 * - route outcome failed, overclaimed, or zero observed tool calls → false;
 * - otherwise → true.
 */
function assessContractCriteriaMet(input: {
	outcomeSucceeded: boolean;
	childEvidence: ChildTurnEvidence | null;
	overclaim: boolean;
}): boolean | null {
	const evidence = input.childEvidence;
	const finalMessage =
		typeof evidence?.finalAssistantMessage === "string"
			? evidence.finalAssistantMessage.trim()
			: "";
	if (!evidence || finalMessage.length === 0) return null;
	if (!input.outcomeSucceeded) return false;
	if (input.overclaim) return false;
	if (evidence.toolCalls.length === 0) return false;
	return true;
}

// ─── Batch Grader + Persistence ──────────────────────────────────────────────

export interface GradeRecentKernelRoutesOptions {
	orgId: string;
	/** Hours to look back for settled runs (default: 9). */
	lookbackHours?: number;
	/** Post-hoc typed judgment over immutable child answer and work-order criteria. */
	assessAnswerCriteria?: (input: {
		runId: string;
		criteria: string[];
		childEvidence: ChildTurnEvidence;
	}) => Promise<boolean | null>;
}

export interface GradeRecentKernelRoutesResult {
	runsGraded: number;
	runsPassed: number;
	runsFailed: number;
	runsSkipped: number;
	meanScore: number;
	harnessVersionId: string | null;
}

/** The correction itself is immutable on a newer Home run. Preserve the first
 * grade and append an idempotent, correction-linked negative for the prior run.
 * This scans correction EVENT time, so a corrected run may be arbitrarily old.
 */
async function persistKernelRouteCorrections(
	db: DbClient,
	orgId: string,
): Promise<void> {
	let after: { createdAt: string; id: string } | undefined;
	for (let page = 0; page < MAX_CORRECTION_PAGES; page++) {
		const corrections = await listKernelRouteCorrectionEvents(db, {
			organizationId: orgId,
			cutoff: "1970-01-01T00:00:00.000Z",
			limit: CORRECTION_PAGE_SIZE,
			after,
		});
		if (corrections.length === 0) return;
		const priorIds = corrections
			.map((event) => event.payload?.priorRunId)
			.filter((id): id is string => typeof id === "string" && id.length > 0);
		const priorRuns = new Map(
			(
				await listKernelRunsForCorrection(db, {
					organizationId: orgId,
					runIds: priorIds,
				})
			).map((run) => [run.id, run]),
		);
		for (const correction of corrections) {
			const payload = recordOrNull(correction.payload);
			const priorRunId =
				typeof payload?.priorRunId === "string" ? payload.priorRunId : null;
			const prior = priorRunId ? priorRuns.get(priorRunId) : null;
			// Never create an eval for a nonexistent or cross-tenant prior run.
			if (
				!prior ||
				!priorRunId ||
				!["completed", "failed", "canceled"].includes(prior.status)
			)
				continue;
			const existing = await listKernelEvalResultsForPriorRun(db, {
				organizationId: orgId,
				runId: priorRunId,
			});
			const resultId = `kser-correction:${correction.id}`;
			const selectionResultId = `tsel-correction:${correction.id}`;
			const existingRouteRevision = await getKernelCorrectionEvalRevision(db, {
				organizationId: orgId,
				id: resultId,
			});
			const existingSelectionRevision = await getKernelCorrectionEvalRevision(
				db,
				{ organizationId: orgId, id: selectionResultId },
			);
			const routeBase = existing.find(
				(row) =>
					row.id.startsWith("kser:") && !row.id.startsWith("kser-correction:"),
			);
			const selectionBase = existing.find(
				(row) =>
					row.id.startsWith("tsel:") && !row.id.startsWith("tsel-correction:"),
			);
			const runMetadata = prior.metadata as Record<string, unknown> | null;
			const body = recordOrNull(runMetadata?.bodyExecutionResult);
			const harnessVersionId =
				routeBase?.harnessVersionId ??
				(typeof body?.harnessVersionId === "string"
					? body.harnessVersionId
					: null);
			if (!harnessVersionId) {
				console.warn(
					"[KernelRouteEval] correction lacks original harness version",
					{ priorRunId, correctionEventId: correction.id },
				);
				continue;
			}
			const priorEvents = await listKernelEvaluationEvents(db, {
				organizationId: orgId,
				runIds: [priorRunId],
				limitPerChunk: 500,
			});
			const grade = gradeKernelRoute({
				runId: priorRunId,
				status: prior.status,
				metadata: runMetadata,
				events: [
					...priorEvents.map((event) => ({
						kind: event.kind,
						payload: recordOrNull(event.payload),
						runId: event.runId,
					})),
					{
						kind: "decision.recorded",
						payload: { action: "kernel.route_corrected", priorRunId },
						runId: correction.runId,
					},
				],
			});
			// Preserve every earlier failure gate (including child overclaims); only
			// the correction gate changes. The revision can never turn a fail to pass.
			const gates = {
				...(routeBase?.gates ?? grade.gates),
				notCorrected: false,
			};
			const score =
				Object.values(gates).filter(Boolean).length / Object.keys(gates).length;
			const route = recordOrNull(runMetadata?.kernelRoute);
			const routeKind =
				typeof route?.routeKind === "string" ? route.routeKind : null;
			const delegatedTediId =
				selectionBase?.tediId ?? resolveDelegatedTediId(runMetadata ?? {});
			const revisionMetadata = {
				runId: priorRunId,
				routeKind,
				source: "kernel-route-correction",
				correctionEventId: correction.id,
				correctionAt: correction.createdAt,
				supersedesId: routeBase?.id ?? null,
			};
			// The base may have been graded earlier in this same reflection cycle.
			// Keep the revision visibly newer while retaining the immutable event time.
			const revisionAt =
				existingRouteRevision?.createdAt ??
				existingSelectionRevision?.createdAt ??
				new Date(
					Math.max(
						Date.now(),
						Date.parse(routeBase?.createdAt ?? "1970-01-01T00:00:00.000Z") + 1,
					),
				).toISOString();
			await recordSubjectEvalResult(db, {
				id: resultId,
				subjectKind: "kernel",
				subjectId: kernelHarnessSubjectId(orgId),
				tediId: null,
				orgId,
				harnessVersionId,
				score,
				gates,
				passed: false,
				lane: KERNEL_EVAL_LANE,
				taskSetId: KERNEL_EVAL_TASK_SET_ID,
				createdAt: revisionAt,
				metadata: parseEvalMetadata(
					revisionMetadata,
					"Kernel correction eval metadata",
				),
			});
			if (routeKind === "delegate_tedi" && delegatedTediId) {
				await recordSubjectEvalResult(db, {
					id: selectionResultId,
					subjectKind: "kernel",
					subjectId: tediSelectionSubjectId(orgId),
					tediId: delegatedTediId,
					orgId,
					harnessVersionId: selectionBase?.harnessVersionId ?? harnessVersionId,
					score,
					gates,
					passed: false,
					lane: KERNEL_EVAL_LANE,
					taskSetId: TEDI_SELECTION_TASK_SET_ID,
					createdAt: revisionAt,
					metadata: parseEvalMetadata(
						{
							...revisionMetadata,
							delegatedTediId,
							supersedesId: selectionBase?.id ?? null,
						},
						"Tedi selection correction metadata",
					),
				});
				await invalidateTediLearnedCapabilityBefore(db, {
					organizationId: orgId,
					tediId: delegatedTediId,
					correctionAt: revisionAt,
				});
			}
		}
		const last = corrections[corrections.length - 1];
		if (!last) return;
		after = { createdAt: last.createdAt, id: last.id };
		if (corrections.length < CORRECTION_PAGE_SIZE) return;
	}
	// A full last page may be exactly the cap. Probe one further row before
	// declaring the bounded scan incomplete.
	const overflow = await listKernelRouteCorrectionEvents(db, {
		organizationId: orgId,
		cutoff: "1970-01-01T00:00:00.000Z",
		limit: 1,
		after,
	});
	if (overflow.length > 0) {
		throw new Error(
			"Kernel correction scan exceeded 2,000 events; increase the scan budget before grading again",
		);
	}
}

/**
 * Read settled kernel_runtime_runs in the lookback window for the org, grade
 * each via `gradeKernelRoute`, persist one `harness_subject_eval_result` per
 * run, and write one `harness_subject_eval_run` summary row.
 *
 * Idempotent: the stable id `kser:{harnessVersionId}:{runId}` prevents
 * double-insertion (conflict-do-nothing on the PK). Re-runs skip runs that
 * already have an eval result by checking for existing result ids.
 *
 * DOES NOT mutate routing logic. DOES NOT modify kernel_runtime_runs or events.
 * Post-hoc persistence only.
 */
export async function gradeRecentKernelRoutes(
	db: DbClient,
	options: GradeRecentKernelRoutesOptions,
): Promise<GradeRecentKernelRoutesResult> {
	const { orgId, lookbackHours = DEFAULT_LOOKBACK_HOURS } = options;
	const cutoff = new Date(
		Date.now() - lookbackHours * 60 * 60 * 1000,
	).toISOString();
	const subjectId = kernelHarnessSubjectId(orgId);

	// 1. Fetch settled kernel runs in the window — terminal statuses only.
	const settledRuns = await listSettledKernelRunsForEvaluation(db, {
		organizationId: orgId,
		cutoff,
		limit: MAX_RUNS_PER_CYCLE,
	});

	if (settledRuns.length === 0) {
		await persistKernelRouteCorrections(db, orgId);
		return {
			runsGraded: 0,
			runsPassed: 0,
			runsFailed: 0,
			runsSkipped: 0,
			meanScore: 0,
			harnessVersionId: null,
		};
	}

	// 2. Resolve (or create) the active kernel harness version for this org.
	//    We use the most common routerVersion in the run batch for the components stamp.
	const routerVersionCounts = new Map<string, number>();
	for (const run of settledRuns) {
		const rv = routerVersionFromMetadata(
			run.metadata as Record<string, unknown> | null,
		);
		if (rv) routerVersionCounts.set(rv, (routerVersionCounts.get(rv) ?? 0) + 1);
	}
	const dominantRouterVersion = [...routerVersionCounts.entries()].sort(
		(a, b) => b[1] - a[1],
	)[0]?.[0];

	const { version: harnessVersion } = await ensureActiveKernelHarnessVersion(
		db,
		{
			orgId,
			components: dominantRouterVersion
				? { attention_router: dominantRouterVersion }
				: {},
			reason: "kernel route eval cycle",
			metadata: { source: "kernel-route-eval", surface: "memory-reflection" },
		},
	);
	const harnessVersionId = harnessVersion.id;

	// 3. Collect run ids that already have eval results (idempotency skip).
	const runIds = settledRuns.map((r) => r.id);
	const correctedRunIds = new Set(
		await listCorrectedKernelRunIds(db, {
			organizationId: orgId,
			runIds,
		}),
	);

	const existingRows = await listExistingKernelEvalResultIds(db, {
		organizationId: orgId,
		subjectId,
		harnessVersionId,
		limit: MAX_RUNS_PER_CYCLE + 10,
	});

	const existingResultIds = new Set(existingRows.map((r) => r.id));

	// 4. Fetch events for the settled runs, CHUNKED. D1 caps bound parameters per
	//    query (~100); runIds can be up to MAX_RUNS_PER_CYCLE (200), so a single
	//    inArray would throw "too many SQL variables" and abort the whole pass.
	const EVENT_QUERY_CHUNK = 80;
	const allEvents: Array<{
		runId: string | null;
		kind: string;
		payload: unknown;
	}> = [];
	for (let i = 0; i < runIds.length; i += EVENT_QUERY_CHUNK) {
		const batch = runIds.slice(i, i + EVENT_QUERY_CHUNK);
		const evs = await listKernelEvaluationEvents(db, {
			organizationId: orgId,
			runIds: batch,
		});
		for (const e of evs) allEvents.push(e);
	}

	// Group events by runId for O(1) lookup.
	const eventsByRunId = new Map<
		string,
		Array<{
			kind: string;
			payload: Record<string, unknown> | null;
			runId: string | null;
		}>
	>();
	for (const ev of allEvents) {
		if (!ev.runId) continue;
		const list = eventsByRunId.get(ev.runId) ?? [];
		list.push({
			kind: ev.kind,
			payload: (ev.payload as Record<string, unknown> | null) ?? null,
			runId: ev.runId,
		});
		eventsByRunId.set(ev.runId, list);
	}

	// 4b. Fetch delegated-child evidence (final assistant message + tool calls
	//     from the child's tedi_runtime_events) for the claimVsEvidence gate.
	//     Same chunking discipline as the kernel-event fetch. FAIL-SOFT: any
	//     read error yields an empty map, so grading proceeds exactly as before
	//     (the gate is only added when evidence is present).
	const childRunIds = [
		...new Set(
			settledRuns
				.filter((run) => run.delegatedTediId && run.childRunId)
				.map((run) => run.childRunId as string),
		),
	];
	const childEvidenceByRunId = await fetchChildTurnEvidence(
		db,
		orgId,
		childRunIds,
	);

	// 5. Grade each run and persist.
	let runsGraded = 0;
	let runsPassed = 0;
	let runsFailed = 0;
	let runsSkipped = 0;
	let scoreSum = 0;
	const createdAt = new Date().toISOString();

	for (const run of settledRuns) {
		const resultId = `kser:${harnessVersionId}:${run.id}`;
		if (correctedRunIds.has(run.id)) {
			// A prior correction is already authoritative. Avoid a newer positive
			// base row that could outlive the correction in bounded readers.
			runsSkipped++;
			continue;
		}

		// Skip already-graded runs.
		if (existingResultIds.has(resultId)) {
			runsSkipped++;
			continue;
		}

		// A settled run without a route is a failed routing outcome, not missing
		// evaluation data. gradeKernelRoute records routeProduced=false for it.
		const runMetadata = run.metadata as Record<string, unknown> | null;
		const route = recordOrNull(runMetadata?.kernelRoute);

		try {
			const events = eventsByRunId.get(run.id) ?? [];
			const childEvidence = run.childRunId
				? (childEvidenceByRunId.get(run.childRunId) ?? null)
				: null;
			const grade = gradeKernelRoute({
				runId: run.id,
				status: run.status,
				metadata: runMetadata,
				events,
				childEvidence,
			});
			// The pure route score and historical criteriaMet signal remain stable.
			// A separate semantic answer-coverage signal is evaluated only when the
			// child completed, a contract exists, and immutable answer/tool events
			// were recovered. The checker cannot grant authority or prove tool output.
			if (
				options.assessAnswerCriteria &&
				grade.contract?.criteriaMet === true &&
				childEvidence
			) {
				let answerCriteriaMet: boolean | null = null;
				try {
					answerCriteriaMet = await options.assessAnswerCriteria({
						runId: run.id,
						criteria: recoverContractSuccessCriteria(runMetadata ?? {}),
						childEvidence,
					});
				} catch {
					// Paid-admission/provider failure is uncertainty, not success.
				}
				grade.contract.answerCriteriaMet = answerCriteriaMet;
			}

			const routeKind =
				typeof route?.routeKind === "string" ? route.routeKind : null;
			const routerVersion = routerVersionFromMetadata(runMetadata);

			await recordSubjectEvalResult(db, {
				id: resultId,
				subjectKind: "kernel",
				subjectId,
				tediId: null,
				orgId,
				harnessVersionId,
				score: grade.score,
				gates: grade.gates,
				passed: grade.passed,
				lane: KERNEL_EVAL_LANE,
				taskSetId: KERNEL_EVAL_TASK_SET_ID,
				createdAt,
				metadata: parseEvalMetadata(
					{
						runId: run.id,
						routeKind,
						routerVersion: routerVersion ?? null,
						source: "kernel-route-eval",
						...(grade.claimVsEvidence
							? { claimVsEvidence: grade.claimVsEvidence }
							: {}),
						...(grade.contract ? { contract: grade.contract } : {}),
						...(grade.delegationFailure
							? { delegationFailure: grade.delegationFailure }
							: {}),
					},
					"Kernel route eval metadata",
				),
			});

			runsGraded++;
			if (grade.passed) {
				runsPassed++;
			} else {
				runsFailed++;
			}
			scoreSum += grade.score;

			// ── SECOND write: per-TEDI delegation-selection eval (delegate_tedi
			// only). Closes the "was THIS tedi the right pick?" loop. Reuses the
			// SAME route grade (no second model/grader call) and keys the result
			// under a distinct subjectId prefix + the delegated tedi's id, so
			// `summarizeTediSelectionPriors` can later bias the roster the planner
			// reads. Idempotent via the stable `tsel:` id (conflict-do-nothing on
			// PK). Skipped for non-delegation runs and runs with no resolvable
			// single target (e.g. plan-only multi-tedi delegations).
			if (routeKind === "delegate_tedi") {
				const delegatedTediId = resolveDelegatedTediId(runMetadata);
				if (delegatedTediId) {
					await recordSubjectEvalResult(db, {
						id: `tsel:${harnessVersionId}:${run.id}`,
						subjectKind: "kernel",
						subjectId: tediSelectionSubjectId(orgId),
						tediId: delegatedTediId,
						orgId,
						harnessVersionId,
						score: grade.score,
						gates: grade.gates,
						passed: grade.passed,
						lane: KERNEL_EVAL_LANE,
						taskSetId: TEDI_SELECTION_TASK_SET_ID,
						createdAt,
						metadata: parseEvalMetadata(
							{
								runId: run.id,
								delegatedTediId,
								routeKind: "delegate_tedi",
								source: "kernel-tedi-selection",
								...(grade.claimVsEvidence
									? { claimVsEvidence: grade.claimVsEvidence }
									: {}),
								...(grade.contract ? { contract: grade.contract } : {}),
								...(grade.delegationFailure
									? { delegationFailure: grade.delegationFailure }
									: {}),
							},
							"Tedi selection eval metadata",
						),
					});
				}
			}
		} catch (err) {
			console.error(
				`[KernelRouteEval] failed to grade/persist run ${run.id}:`,
				err,
			);
			runsSkipped++;
		}
	}

	// 6. Write one summary eval run row for this cycle.
	const total = runsGraded;
	const meanScore = total > 0 ? scoreSum / total : 0;
	const runSummaryId = `kser-run:${harnessVersionId}:${createdAt}`;

	if (total > 0) {
		const recorded = await recordSubjectEvalRun(db, {
			id: runSummaryId,
			subjectKind: "kernel",
			subjectId,
			tediId: null,
			orgId,
			harnessVersionId,
			lane: KERNEL_EVAL_LANE,
			taskSetId: KERNEL_EVAL_TASK_SET_ID,
			total,
			passed: runsPassed,
			failed: runsFailed,
			meanScore,
			eligible: runsFailed === 0 && total > 0,
			createdAt,
			metadata: {
				source: "kernel-route-eval",
				skipped: runsSkipped,
			},
		});
		if (!recorded)
			throw new Error(
				`Kernel route eval run ${runSummaryId} conflicts with its persisted immutable payload`,
			);
	}
	await persistKernelRouteCorrections(db, orgId);

	return {
		runsGraded,
		runsPassed,
		runsFailed,
		runsSkipped,
		meanScore,
		harnessVersionId,
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fetch the delegated-child evidence for the claimVsEvidence gate: per child
 * run id, the newest assistant `message.completed` content plus every
 * `tool.started` call (name + Code Mode snippet argument when present) from
 * `tedi_runtime_events`. Chunked like the kernel-event fetch (D1 ~100-param
 * cap). FAIL-SOFT: any error returns the partial/empty map — the gate simply
 * doesn't run for the affected runs.
 */
async function fetchChildTurnEvidence(
	db: DbClient,
	orgId: string,
	childRunIds: string[],
): Promise<Map<string, ChildTurnEvidence>> {
	const evidence = new Map<string, ChildTurnEvidence>();
	if (childRunIds.length === 0) return evidence;
	const CHUNK = 80;
	try {
		for (let i = 0; i < childRunIds.length; i += CHUNK) {
			const batch = childRunIds.slice(i, i + CHUNK);
			const rows = await listChildTurnEvidenceEvents(db, {
				organizationId: orgId,
				runIds: batch,
			});
			// Newest-first per run so the FIRST assistant message.completed we see
			// is the final one.
			rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
			for (const row of rows) {
				if (!row.runId) continue;
				const entry = evidence.get(row.runId) ?? {
					finalAssistantMessage: null,
					toolCalls: [] as ChildToolCall[],
				};
				const payload = (row.payload ?? null) as Record<string, unknown> | null;
				if (row.kind === "message.completed") {
					const role = payload?.role;
					const content =
						typeof payload?.content === "string" ? payload.content.trim() : "";
					if (
						entry.finalAssistantMessage === null &&
						(role === undefined || role === "assistant") &&
						content
					) {
						entry.finalAssistantMessage = content;
					}
				} else if (row.kind === "tool.started") {
					const name = typeof payload?.name === "string" ? payload.name : "";
					if (name) {
						const args = payload?.arguments;
						const code =
							args && typeof args === "object" && !Array.isArray(args)
								? (args as Record<string, unknown>).code
								: undefined;
						entry.toolCalls.push({
							name,
							...(typeof code === "string" ? { codeArgument: code } : {}),
						});
					}
				}
				evidence.set(row.runId, entry);
			}
		}
	} catch (err) {
		console.warn(
			"[KernelRouteEval] child-evidence fetch failed (claimVsEvidence gate skipped):",
			err instanceof Error ? err.message : String(err),
		);
	}
	return evidence;
}

function recordOrNull(val: unknown): Record<string, unknown> | null {
	if (val && typeof val === "object" && !Array.isArray(val)) {
		return val as Record<string, unknown>;
	}
	return null;
}

/**
 * Resolve the delegated target tedi id for a delegate_tedi run from the run
 * metadata, in precedence order: the top-level `delegatedTediId` stamp (set on
 * auto-dispatch turns), then the constructed work order's `targetTediId`
 * (nested under `homeDelegation`), then the route's own `targetTediId`. Returns
 * null when none resolve (e.g. a plan-only delegation with no single target) —
 * such runs are skipped by the tedi-selection write.
 */
export function resolveDelegatedTediId(
	metadata: Record<string, unknown> | null | undefined,
): string | null {
	if (!metadata) return null;
	const top = metadata.delegatedTediId;
	if (typeof top === "string" && top.trim()) return top.trim();

	const homeDelegation = recordOrNull(metadata.homeDelegation);
	const workOrder = recordOrNull(homeDelegation?.workOrder);
	const woTarget = workOrder?.targetTediId;
	if (typeof woTarget === "string" && woTarget.trim()) return woTarget.trim();

	const route = recordOrNull(metadata.kernelRoute);
	const routeTarget = route?.targetTediId;
	if (typeof routeTarget === "string" && routeTarget.trim()) {
		return routeTarget.trim();
	}
	return null;
}

function routerVersionFromMetadata(
	metadata: Record<string, unknown> | null | undefined,
): string | null {
	if (!metadata) return null;
	const top = metadata.routerVersion;
	if (typeof top === "string" && top) return top;
	const route = recordOrNull(metadata.kernelRoute);
	const nested = route?.routerVersion;
	return typeof nested === "string" && nested ? nested : null;
}
