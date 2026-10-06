/**
 * oRPC Rationale Records Router
 * Tedi decision journal — the "why" behind every action
 *
 * REST Endpoints:
 * POST   /rationale-records                       - Create record (auth + tedis:update)
 * GET    /rationale-records                       - List records (user auth)
 * GET    /rationale-records/{id}                  - Get record (user auth)
 * GET    /rationale-records/chain/{tediId}        - Get rationale chain (user/tedi auth)
 * POST   /rationale-records/{id}/complete         - Complete with outcome (auth + tedis:update)
 * DELETE /rationale-records/{id}                  - Delete record (user auth)
 */

import {
	extractFactIdsFromEvidence,
	hasFactEvidence,
} from "@tedix/api-contract/utils/fact-evidence";
import { implement } from "@orpc/server";
import { rationaleRecordsContract } from "@tedix/api-contract/contracts/rationale-records";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { recordFactAccess } from "@tedix/db/queries/memory-graph/facts";
import { searchFactsWithVisibility } from "@tedix/db/queries/memory-graph/fact-search";
import {
	createOptimizationSignal,
	findOpenOptimizationSignal,
} from "@tedix/db/queries/memory-graph/optimization-signals";
import {
	completeRationaleRecord,
	createRationaleRecord,
	createRationaleRecordIdempotent,
	deleteRationaleRecord,
	detectApprovalFatigue,
	getLastAttemptByAction,
	getRationaleChain,
	getRationaleRecordById,
	getRecentCompletedByCategory,
	getRecentFailedByCategory,
	listRationaleRecords,
	updateRationaleEvidence,
} from "@tedix/db/queries/rationale-records";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	type EvidencePayload,
	emitFactFeedbackForOutcome,
	parseEvidencePayload,
} from "../../services/brain-feedback";
import {
	processGateGraduation,
	resolveEpisodeComplexity,
} from "../../services/mission-os";
import {
	buildRationaleEvidenceQuery,
	mergeAutoCitedFactEvidence,
} from "../../services/rationale-evidence";
import { episodeTraceId } from "../episode-trace";
import {
	AUTHZ,
	withAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
} from "../orpc";
import {
	insertRuntimeEvent,
	resolveTediRuntimeBackend,
} from "./cognitive-runtime/events-policy";

const rationaleOs = implement(rationaleRecordsContract).$context<BaseContext>();
const authOs = rationaleOs.use(withAuth);

async function rationaleIdempotencyUuid(input: {
	organizationId: string;
	tediId: string;
	key: string;
}): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`${input.organizationId}\u0000${input.tediId}\u0000${input.key}`,
			),
		),
	);
	// UUIDv8 marks this as an application-defined deterministic UUID while the
	// RFC 4122 variant keeps it compatible with existing UUID contracts.
	digest[6] = (digest[6]! & 0x0f) | 0x80;
	digest[8] = (digest[8]! & 0x3f) | 0x80;
	const hex = Array.from(digest.slice(0, 16), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getOrganizationId(context: BaseContext): string | null {
	return context.organizationId ?? null;
}

/**
 * Resolve the org a write should be attributed to, enforcing the
 * org-from-context invariant: a non-platform caller may only write records for
 * their own org and may not pass a foreign `orgId`. Platform principals may
 * write cross-org.
 */
function resolveWriteOrgId(
	context: BaseContext,
	requestedOrgId: string,
): string {
	if (isPlatformPrincipal(context)) return requestedOrgId;
	const orgId = context.organizationId;
	if (!orgId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Organization context required. Use an org-scoped token.",
		);
	}
	if (requestedOrgId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Cannot write a rationale record for another organization",
		);
	}
	return orgId;
}

/**
 * The org to scope a read to: undefined for platform principals (full
 * cross-org access), the caller's org otherwise. Fails closed when a
 * non-platform caller has no org context (never returns unscoped).
 */
function orgScopeForRead(context: BaseContext): string | undefined {
	if (isPlatformPrincipal(context)) return undefined;
	const orgId = context.organizationId;
	if (!orgId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Organization context required. Use an org-scoped token.",
		);
	}
	return orgId;
}

export function isIdempotentRationaleCompletion(
	currentStatus: string,
	requestedStatus: string,
	options?: { proofRefProvided?: boolean },
): boolean {
	if (currentStatus !== "pending" && currentStatus === requestedStatus) {
		return true;
	}
	// A proof-less `success` claim is stored as `unverified` (proof gate),
	// so a replay of the same proof-less claim is idempotent, not an error.
	return (
		currentStatus === "unverified" &&
		requestedStatus === "success" &&
		!options?.proofRefProvided
	);
}

/**
 * Every rationale record is an evidence-linked decision episode.
 * True when the input carries at least one execution link.
 */
export function hasRationaleExecutionLink(input: {
	runId?: string;
	workItemId?: string;
	toolCallRefs?: string[];
}): boolean {
	return Boolean(
		input.runId?.trim() ||
		input.workItemId?.trim() ||
		(input.toolCallRefs && input.toolCallRefs.length > 0),
	);
}

/**
 * Proof for a write+close `success`: an explicit proofRef wins; otherwise the
 * record's own execution link is the proof span (the outcome was observed in
 * the same span the decision executed in). Two-step `complete` calls get NO
 * such fallback — the outcome may occur outside the original span.
 *
 * NOTE: a proofRef derived here is SELF-ATTESTED — the caller supplied the
 * runId/toolCallRef it is "proved" by. That is acceptable for the rationale
 * record itself (it stays span-checkable and auditable), but consumers that
 * treat success episodes as training evidence must corroborate independently:
 * the trajectory miner (`listLinkedSuccessfulEpisodes`) fail-closes any runId
 * that is neither a completed `skill_runs` row nor present in the
 * `tedi_runtime_events` run ledger.
 */
export function deriveWriteAndCloseProofRef(input: {
	proofRef?: {
		kind: "run" | "tool_call" | "artifact" | "work_item";
		ref: string;
	};
	runId?: string;
	workItemId?: string;
	toolCallRefs?: string[];
}):
	| { kind: "run" | "tool_call" | "artifact" | "work_item"; ref: string }
	| undefined {
	if (input.proofRef) return input.proofRef;
	if (input.runId?.trim()) return { kind: "run", ref: input.runId };
	const toolCallRef = input.toolCallRefs?.[0];
	if (toolCallRef) return { kind: "tool_call", ref: toolCallRef };
	if (input.workItemId?.trim())
		return { kind: "work_item", ref: input.workItemId };
	return undefined;
}

async function enrichRationaleEvidenceWithMemory(
	context: BaseContext,
	input: {
		tediId: string;
		orgId: string;
		action: string;
		rationale: string;
		category: string;
		evidence: unknown;
	},
): Promise<Record<string, unknown>> {
	const parsed = parseEvidencePayload(input.evidence);
	if (hasFactEvidence(parsed)) return parsed;

	const query = buildRationaleEvidenceQuery(input);
	if (query.length < 24) return parsed;

	try {
		const results = await searchFactsWithVisibility(context.db, {
			orgId: input.orgId,
			visibilityTediId: input.tediId,
			limit: 5,
			minConfidence: 0.35,
		});
		const citations = results
			.filter((result) => result.confidence >= 0.58)
			.slice(0, 3)
			.map((result) => ({
				factId: result.id,
				score: Math.round(result.confidence * 1000) / 1000,
				source: result.source ?? null,
				domainName: null,
			}));
		if (citations.length === 0) return parsed;

		const accessUpdates = Promise.all(
			citations.map((citation) =>
				recordFactAccess(context.db, citation.factId).catch(() => {}),
			),
		);
		context.waitUntil?.(accessUpdates);
		return mergeAutoCitedFactEvidence(parsed, citations, query);
	} catch (err) {
		if (context.env.ENVIRONMENT === "development") {
			console.warn("[RationaleCreate] Memory evidence enrichment failed:", err);
		}
		return parsed;
	}
}

async function ensureRationaleEvidenceForOutcome(
	context: BaseContext,
	record: {
		id: string;
		tediId: string;
		orgId: string;
		action: string;
		rationale: string;
		category: string;
		evidence: unknown;
	},
): Promise<EvidencePayload> {
	const parsed = parseEvidencePayload(record.evidence);
	if (hasFactEvidence(parsed)) return parsed;

	const enriched = await enrichRationaleEvidenceWithMemory(context, record);
	if (!hasFactEvidence(enriched)) return parsed;

	const updated = await updateRationaleEvidence(
		context.db,
		record.id,
		toJsonRecord(enriched),
	);
	return parseEvidencePayload(updated?.evidence ?? enriched);
}

function emitDecisionCompletedRuntimeEvent(
	context: BaseContext,
	completed: {
		id: string;
		orgId: string;
		tediId: string | null;
		outcomeStatus: string | null;
		category: string;
		confidence: number;
		completedAt: string | null;
	},
	episodeTrace: string | null | undefined,
): void {
	const tediId = completed.tediId;
	if (!tediId) return;

	context.waitUntil?.(
		resolveTediRuntimeBackend(context, tediId)
			.then((runtimeBackend) =>
				insertRuntimeEvent(context, {
					organizationId: completed.orgId,
					tediId,
					kind: "decision.completed",
					runtimeBackend,
					...(episodeTrace
						? { runtimeMetadata: { traceId: episodeTrace } }
						: {}),
					payload: {
						rationaleRecordId: completed.id,
						outcomeStatus: completed.outcomeStatus,
						category: completed.category,
						confidence: completed.confidence,
					},
					createdAt: completed.completedAt ?? new Date().toISOString(),
				}),
			)
			.catch((err) =>
				console.warn("[CognitiveBridge] decision.completed emit failed:", err),
			),
	);
}

const createProcedure = authOs.create
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const episodeTrace = episodeTraceId(context.headers);

		// Hard invariant: a rationale record is an evidence-linked decision
		// episode or it is rejected. No compat path for unlinked writes.
		if (!hasRationaleExecutionLink(input)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"UNLINKED_RATIONALE: write_rationale requires at least one execution link — runId, workItemId, or toolCallRefs[] (tool-call spans from the runtime event ledger)",
			);
		}

		// Enforce org-from-context: a non-platform caller may only write for
		// their own org; reject a client-supplied foreign orgId.
		const orgId = resolveWriteOrgId(context, input.orgId);
		const id = input.idempotencyKey
			? await rationaleIdempotencyUuid({
					organizationId: orgId,
					tediId: input.tediId,
					key: input.idempotencyKey,
				})
			: crypto.randomUUID();
		const enrichedEvidence = await enrichRationaleEvidenceWithMemory(
			context,
			input,
		);
		const evidence = input.idempotencyKey
			? {
					...enrichedEvidence,
					rationaleIdempotencyKey: input.idempotencyKey,
				}
			: enrichedEvidence;
		const createInput = {
			id,
			tediId: input.tediId,
			orgId,
			action: input.action,
			rationale: input.rationale,
			category: input.category,
			confidence: input.confidence,
			evidence: toJsonRecord(evidence),
			approvalRequestId: input.approvalRequestId,
			objectiveId: input.objectiveId,
			runId: input.runId,
			workItemId: input.workItemId,
			toolCallRefs: input.toolCallRefs,
			createdAt: new Date().toISOString(),
		};
		const creation = input.idempotencyKey
			? await createRationaleRecordIdempotent(context.db, createInput)
			: {
					record: await createRationaleRecord(context.db, createInput),
					created: true,
				};
		const { record, created } = creation;
		if (
			!created &&
			(record.orgId !== orgId ||
				record.tediId !== input.tediId ||
				record.action !== input.action ||
				record.rationale !== input.rationale ||
				record.category !== input.category ||
				record.confidence !== input.confidence ||
				record.evidence.rationaleIdempotencyKey !== input.idempotencyKey)
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Rationale idempotency key is already bound to different input",
			);
		}
		// Cognitive-event bridge — surface the decision on the runtime spine
		// (`tedi_runtime_events`) so Tedix OS Activity can replay "what was decided"
		// alongside "what was done". Best-effort: a bridge failure must never break
		// the rationale write.
		if (created)
			context.waitUntil?.(
				resolveTediRuntimeBackend(context, input.tediId)
					.then((runtimeBackend) =>
						insertRuntimeEvent(context, {
							organizationId: orgId,
							tediId: input.tediId,
							kind: "decision.recorded",
							runtimeBackend,
							approvalRequestId: input.approvalRequestId,
							...(episodeTrace
								? { runtimeMetadata: { traceId: episodeTrace } }
								: {}),
							payload: {
								rationaleRecordId: id,
								action: input.action,
								category: input.category,
								confidence: input.confidence,
								objectiveId: input.objectiveId ?? null,
								// Cited/ignored join: facts this decision USED as evidence.
								// Cross with the episode's memory.retrieved.factIds (returned) →
								// cited = ∩, ignored = returned − cited. Enables "which retrieved
								// facts actually shaped the decision" in Tedix OS Activity replay.
								citedFactIds: extractFactIdsFromEvidence(evidence),
							},
							createdAt: record.createdAt,
						}),
					)
					.catch((err) =>
						console.warn(
							"[CognitiveBridge] decision.recorded emit failed:",
							err,
						),
					),
			);

		let responseRecord = record;

		// Auto-complete if outcomeStatus was provided (write + close in one call).
		// Proof gate: a `success` close needs a span-checkable proof ref;
		// for write+close the record's own execution link is the proof span.
		if (input.outcomeStatus && responseRecord.outcomeStatus === "pending") {
			const completedRecord = await completeRationaleRecord(context.db, id, {
				outcome: input.outcome ?? input.rationale,
				outcomeStatus: input.outcomeStatus,
				proofRef:
					input.outcomeStatus === "success"
						? deriveWriteAndCloseProofRef(input)
						: input.proofRef,
				completedAt: new Date().toISOString(),
			});
			if (completedRecord) {
				responseRecord = completedRecord;
				// decision.completed for the write-and-close path (see complete proc).
				emitDecisionCompletedRuntimeEvent(
					context,
					completedRecord,
					episodeTrace,
				);
			}
			// Also emit memory_feedback for referenced facts — keyed on the
			// RESOLVED status so an `unverified` claim never credits facts as
			// a success would.
			try {
				emitFactFeedbackForOutcome(
					context.db,
					evidence,
					responseRecord.outcomeStatus,
				).catch(() => {});
			} catch {}
		}

		// Retrieve recent completed rationale records in the same category
		// for contrastive examples (what worked, what failed)
		let priorDecisions: Array<{
			action: string;
			outcomeStatus: string;
			outcome: string;
			confidence: number;
		}> = [];
		try {
			const recent = await getRecentCompletedByCategory(
				context.db,
				input.tediId,
				input.category,
				5,
			);
			priorDecisions = recent.map((r) => ({
				action: r.action,
				outcomeStatus: r.outcomeStatus,
				outcome: (r.outcome ?? "").slice(0, 200),
				confidence: r.confidence,
			}));
		} catch (err) {
			if (context.env.ENVIRONMENT === "development") {
				console.warn(
					"[RationaleCreate] Failed to retrieve prior decisions:",
					err,
				);
			}
		}

		// Hard-wired failure retrieval — the tedi must see its failure
		// history before making decisions. This is structural, not optional retrieval.
		let recentFailures: Array<{
			action: string;
			outcome: string;
			confidence: number;
			createdAt: string;
		}> = [];
		let lastAttempt: {
			action: string;
			outcomeStatus: string;
			outcome: string;
			confidence: number;
			createdAt: string;
		} | null = null;

		try {
			const [failures, prior] = await Promise.all([
				getRecentFailedByCategory(context.db, input.tediId, input.category, 3),
				getLastAttemptByAction(context.db, input.tediId, input.action),
			]);
			recentFailures = failures.map((r) => ({
				action: r.action,
				outcome: (r.outcome ?? "").slice(0, 300),
				confidence: r.confidence,
				createdAt: r.createdAt,
			}));
			if (prior) {
				lastAttempt = {
					action: prior.action,
					outcomeStatus: prior.outcomeStatus,
					outcome: (prior.outcome ?? "").slice(0, 300),
					confidence: prior.confidence,
					createdAt: prior.createdAt,
				};
			}
		} catch (err) {
			if (context.env.ENVIRONMENT === "development") {
				console.warn(
					"[RationaleCreate] Failed to retrieve failure context:",
					err,
				);
			}
		}

		return { ...responseRecord, priorDecisions, recentFailures, lastAttempt };
	});

const listProcedure = authOs.list
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const orgId = getOrganizationId(context);

		if (!orgId && !input?.tediId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"tediId is required for service binding calls",
			);
		}

		const limit = input?.limit ?? 50;
		const offset = input?.offset ?? 0;

		const { data, total } = await listRationaleRecords(context.db, {
			orgId: orgId ?? undefined,
			tediId: input?.tediId,
			category: input?.category,
			outcomeStatus: input?.outcomeStatus,
			limit,
			offset,
		});

		return {
			data,
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

const getByIdProcedure = authOs.getById
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const orgId = getOrganizationId(context);
		const record = await getRationaleRecordById(context.db, input.id);
		if (!record) {
			throw createError(ErrorCodes.NOT_FOUND, "Rationale record not found");
		}
		if (orgId && record.orgId !== orgId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Access denied to this rationale record",
			);
		}
		return record;
	});

const chainProcedure = authOs.chain
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		// Enforce org-from-context: scope the chain to the caller's org so a
		// foreign tediId resolves to nothing (platform principals see all).
		const orgId = orgScopeForRead(context);
		const data = await getRationaleChain(
			context.db,
			input.tediId,
			input.limit,
			orgId,
		);
		return { data };
	});

const completeProcedure = authOs.complete
	.use(AUTHZ.tedisWrite)
	.handler(async ({ input, context }) => {
		const existing = await getRationaleRecordById(context.db, input.id);
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Rationale record not found");
		}
		// Cross-tenant guard (same shape as delete/getById): an org-scoped
		// caller may only complete its own org's records. Placed BEFORE the
		// idempotency short-circuit so a foreign-org replay can't read the
		// record either. Platform principals (no org context) are exempt.
		const orgId = getOrganizationId(context);
		if (orgId && existing.orgId !== orgId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Access denied to this rationale record",
			);
		}
		if (existing.outcomeStatus !== "pending") {
			if (
				isIdempotentRationaleCompletion(
					existing.outcomeStatus,
					input.outcomeStatus,
					{
						proofRefProvided: Boolean(input.proofRef),
					},
				)
			) {
				return existing;
			}
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Cannot complete record with status "${existing.outcomeStatus}"`,
			);
		}
		const evidence = await ensureRationaleEvidenceForOutcome(context, existing);
		// Proof gate: completeRationaleRecord resolves a proof-less
		// `success` claim to `unverified`. All downstream success-gated effects
		// key on the RESOLVED status (`completed.outcomeStatus`), never the claim.
		const completed = await completeRationaleRecord(context.db, input.id, {
			outcome: input.outcome,
			outcomeStatus: input.outcomeStatus,
			proofRef: input.proofRef,
			completedAt: new Date().toISOString(),
		});
		if (!completed) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Failed to complete rationale record",
			);
		}

		// Cognitive-event bridge — the OUTCOME of a decision (not just its
		// recording) on the runtime spine. Pairs with decision.recorded so a
		// replay shows decision → resolution. Best-effort, tedi-scoped.
		emitDecisionCompletedRuntimeEvent(
			context,
			completed,
			episodeTraceId(context.headers),
		);

		// Fire-and-forget: emit memory_feedback signals for referenced facts
		try {
			emitFactFeedbackForOutcome(
				context.db,
				evidence,
				completed.outcomeStatus,
			).catch((err) => {
				if (context.env.ENVIRONMENT === "development") {
					console.warn(
						"[RationaleComplete] memory_feedback emission failed:",
						err,
					);
				}
			});
		} catch (err) {
			if (context.env.ENVIRONMENT === "development") {
				console.warn(
					"[RationaleComplete] Failed to extract facts from evidence:",
					err,
				);
			}
		}

		// Fire-and-forget: process gate graduation for linked objective.
		try {
			// P5 complexity-weighted graduation (Goodhart guard): derive the
			// episode's mechanical complexity so trivial successes cannot advance
			// the autonomy streak. Derivation failure falls back to streak-only
			// behavior (undefined), never blocks completion.
			let complexityScore: number | undefined;
			if (existing.objectiveId) {
				try {
					complexityScore = await resolveEpisodeComplexity(
						context.db,
						{ tediId: existing.tediId, orgId: existing.orgId },
						completed,
					);
				} catch {
					complexityScore = undefined;
				}
			}
			const graduationResult = await processGateGraduation(
				context.db,
				existing.objectiveId,
				completed.outcomeStatus,
				complexityScore,
			);
			if (
				graduationResult?.graduated &&
				context.env.ENVIRONMENT === "development"
			) {
				console.log(
					`[GateGraduation] Objective ${existing.objectiveId} graduated: ${graduationResult.previousLevel} → ${graduationResult.newLevel}`,
				);
			}
		} catch (err) {
			if (context.env.ENVIRONMENT === "development") {
				console.warn("[RationaleComplete] Gate graduation failed:", err);
			}
		}

		// Approval fatigue detection — if 20+ consecutive successes
		// with no failures, suggest promoting to autonomous
		try {
			const fatigue = await detectApprovalFatigue(context.db, existing.tediId);
			if (fatigue.fatigueDetected) {
				const existingSignal = await findOpenOptimizationSignal(context.db, {
					organizationId: existing.orgId,
					tediId: existing.tediId,
					type: "approval_fatigue",
					domain: "autonomy",
				});
				if (!existingSignal) {
					await createOptimizationSignal(context.db, {
						id: crypto.randomUUID(),
						tediId: existing.tediId,
						organizationId: existing.orgId,
						type: "approval_fatigue",
						source: "self_detected",
						domain: "autonomy",
						evidence: [
							`consecutiveSuccesses:${fatigue.consecutiveSuccesses}`,
							`windowSize:${fatigue.totalInWindow}`,
						],
						suggestedAction: `This tedi has ${fatigue.consecutiveSuccesses} consecutive successful decisions with no failures. Consider promoting supervised gates to autonomous.`,
						estimatedImpact: 0.9,
						estimatedEffort: 0.1,
						roi: 9.0,
					});
				}
			}
		} catch {
			// Non-critical — fatigue detection is advisory
		}

		// Fire-and-forget: Atlas-style compiled memory — extract patterns from
		// repeated successes. Keyed on the RESOLVED status: `unverified` claims
		// never compile patterns.
		if (completed.outcomeStatus === "success") {
			try {
				const domain = `rationale:${existing.category}`;

				// Check for existing open compiled_pattern signal to avoid duplicates
				const existingSignal = await findOpenOptimizationSignal(context.db, {
					organizationId: existing.orgId,
					tediId: existing.tediId,
					type: "compiled_pattern",
					domain,
					evidenceIncludes: [`category:${existing.category}`],
				});

				if (!existingSignal) {
					const { data: successRecords, total } = await listRationaleRecords(
						context.db,
						{
							tediId: existing.tediId,
							category: existing.category,
							outcomeStatus: "success",
							limit: 5,
						},
					);

					if (total >= 3) {
						// Build compiled directive from successful action summaries
						const actionSummaries = successRecords
							.map((r) => r.action.slice(0, 100))
							.filter((a) => a.length > 0);

						const pattern = actionSummaries.join("; ");
						const directive =
							`[compiled from ${total} successful ${existing.category} decisions] When handling ${existing.category}: ${pattern}`.slice(
								0,
								500,
							);

						await createOptimizationSignal(context.db, {
							id: crypto.randomUUID(),
							tediId: existing.tediId,
							organizationId: existing.orgId,
							type: "compiled_pattern",
							source: "atlas_compilation",
							domain,
							evidence: [
								`category:${existing.category}`,
								`successCount:${total}`,
								`triggerRecordId:${completed.id}`,
							],
							suggestedAction: directive,
							estimatedImpact: 0.9,
							estimatedEffort: 0.1,
							roi: 9.0,
						});

						if (context.env.ENVIRONMENT === "development") {
							console.log(
								`[AtlasCompile] Compiled pattern for "${existing.category}" from ${total} successful decisions`,
							);
						}
					}
				}
			} catch (err) {
				if (context.env.ENVIRONMENT === "development") {
					console.warn("[AtlasCompile] Pattern compilation failed:", err);
				}
			}
		}

		return completed;
	});

const deleteProcedure = authOs.delete
	.use(withAuthorization("tedis:update", "mcp:memory.admin"))
	.handler(async ({ input, context }) => {
		const orgId = getOrganizationId(context);
		const record = await getRationaleRecordById(context.db, input.id);
		if (!record) {
			throw createError(ErrorCodes.NOT_FOUND, "Rationale record not found");
		}
		if (orgId && record.orgId !== orgId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Access denied to this rationale record",
			);
		}
		const deleted = await deleteRationaleRecord(context.db, input.id);
		if (!deleted) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Failed to delete rationale record",
			);
		}
		return { success: true, deletedId: input.id };
	});

export const rationaleRecordsContractRouter = rationaleOs.router({
	create: createProcedure,
	list: skipOutputValidation(listProcedure),
	getById: skipOutputValidation(getByIdProcedure),
	chain: skipOutputValidation(chainProcedure),
	complete: completeProcedure,
	delete: deleteProcedure,
});
